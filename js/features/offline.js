// Offline resilience: a durable outbox, readable delivery state, and a
// connection strip that speaks plain language.
//
// The deployment this is written for is Android phones on Indian mobile data in
// places where the signal comes and goes. Three things were broken for that:
//
//   1. A send with no signal lost the text. The composer clears the textarea and
//      the draft BEFORE the network is touched, mints a fresh nonce on retry,
//      and drops attachments on retry. The text existed only in a closure and a
//      DOM node, so a backgrounded PWA being killed - the normal state of
//      affairs on Xiaomi and Samsung - lost a field report the person believed
//      they had sent.
//   2. There was no delivery state a non-technical person could read. A message
//      in flight was rendered at 0.6 opacity forever, with no timeout, which is
//      indistinguishable from success at a glance.
//   3. There was no offline state at all. Every failure surfaced the browser's
//      own words - "TypeError: Failed to fetch" - in the message bubble and in a
//      red toast.
//
// WHY THE INTERCEPT IS AT `fetch` AND NOT AT THE COMPOSER. The send path is not
// one function: the channel composer, the thread composer, DMs and forwards all
// reach the same two RPCs by different routes, and the attachment list is
// private to the composer module. Wrapping fetch catches every one of them,
// captures the request body verbatim - attachments, mentions, reply target and
// all - and replays it byte-for-byte with the ORIGINAL nonce. That last part is
// the whole trick: `send_message` and `send_dm` are already idempotent on
// (channel, author, client_msg_id), so replaying the same body can never
// double-post no matter how many times the response was lost. See
// tests/offline-outbox.test.js, which proves it against the live database.
import { store, bus } from '../store.js';
import { $, el, esc, debounce } from '../util.js';
import { icon } from '../icons.js';
import { SUPABASE_URL, PUBLISHABLE } from '../config.js';
import { sb, accessToken } from '../sb.js';
import { appendMessage, upgradeMessageRow, scrollDown } from '../core/messages.js';
import { threadState } from '../core/threads.js';
import * as outbox from '../lib/outbox.js';
import * as readcache from '../lib/readcache.js';

// A radio that is attached but not moving data is the common 3G failure, and a
// fetch against it never settles. Fifteen seconds is long enough for a slow but
// real round trip and short enough that the person gets an answer.
const SEND_TIMEOUT_MS = 15000;
// Doubling with a ceiling. The ceiling is deliberately low - two minutes - so a
// phone that regains signal in a village is never more than that from flushing.
const BACKOFF_MS = [2000, 5000, 12000, 30000, 60000, 120000];
// Do not decorate a send that is going to land in 300 ms. A clock followed by a
// tick on every single message is two layout shifts per message and a column of
// green ticks down a phone screen, which is noise, not reassurance - the message
// appearing in the conversation already says it arrived. The state only shows up
// once the send is actually slow, queued, or refused, which is exactly when a
// person starts wondering whether it went.
const SLOW_PAINT_MS = 900;
// 401 is in here on purpose. It usually means the access token expired while the
// phone was in a pocket, and the refresh has not landed yet. Retrying is right;
// discarding somebody's message because a JWT aged out is not.
const RETRY_STATUS = new Set([401, 408, 425, 429, 500, 502, 503, 504, 522, 524]);
const SEND_RPC = /\/rest\/v1\/rpc\/(send_message|send_dm)(\?|$)/;
const DRAFT_KEY = 'soop.drafts.v1';

// The reads that decide whether the app can open at all. get_bootstrap is the
// whole workspace in one blob, the workspaces table is the Space rail, and
// get_channel_messages is the conversation itself. Remember the last answer to
// each and a cold start with no signal shows the Space you are in instead of
// telling you that you are in none. Deliberately short: nothing here is a write,
// nothing here is search, and nothing here is a live counter that would be
// misleading when stale.
const CACHEABLE = [
  /\/rest\/v1\/rpc\/get_bootstrap(\?|$)/,
  /\/rest\/v1\/rpc\/get_channel_messages(\?|$)/,
  /\/rest\/v1\/rpc\/get_space_summary(\?|$)/,
  /\/rest\/v1\/workspaces(\?|$)/,
  /\/rest\/v1\/threads(\?|$)/,
  /\/rest\/v1\/profiles(\?|$)/,
  // Not boot-critical, but both of these paint an error string into the
  // conversation view and into the channel nav when they fail. Serving the last
  // answer keeps a screen that is otherwise fully readable from being littered
  // with apologies.
  /\/rest\/v1\/rpc\/list_topics(\?|$)/,
  /\/rest\/v1\/rpc\/list_bookmarks(\?|$)/,
];
const isCacheable = (url) => CACHEABLE.some((re) => re.test(url));
// The three reads that decide whether there is an app at all: the Space list,
// the workspace blob, and my own profile.
const BOOT_CRITICAL = /\/rest\/v1\/(workspaces|profiles)(\?|$)|\/rpc\/get_bootstrap(\?|$)/;

let ui = null;
let rawFetch = null;

// In-memory mirror of the on-disk queue. Disk is the truth across a reload; this
// is what the UI reads so painting never waits on IndexedDB.
const live = new Map();

let flushing = false;
let netFails = 0;              // consecutive network failures on any request
let recovered = 0;             // timestamp of the last offline -> online flip
let tickTimer = null;
let servedAt = 0;              // when the stale data now on screen was recorded

// ------------------------------------------------------------------ register
export function register(app) {
  ui = app.ui;
  injectStyle();
  installFetchGuard();
  installToastHumanizer();
  buildBar();
  restoreLocalDrafts();
  watchComposerDrafts();

  outbox.all().then((rows) => {
    for (const r of rows) live.set(r.nonce, r);
    if (rows.length) {
      ensureQueuedRows();
      paintBar();
      flush('boot');
    }
  }).catch(() => {});

  window.addEventListener('online', () => {
    netFails = 0;
    recovered = Date.now();
    // Whatever is on screen is about to be refreshed from the server, so stop
    // claiming it is from 14:30.
    servedAt = 0;
    paintBar();
    flush('online');
  });
  window.addEventListener('offline', () => { paintBar(); repaintAllRows(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { ensureQueuedRows(); flush('visible'); }
  });

  bus.on('channel:open', () => ensureQueuedRows());
  bus.on('dm:open', () => ensureQueuedRows());
  bus.on('message:new', (p) => { ensureQueuedRows(); patchCachedPage(p?.msg); });
  bus.on('thread:open', () => ensureQueuedRows());
  watchMessageList();
  guardCoreRetry();

  // One slow loop rather than a per-record timer: a queued message must move the
  // moment the radio comes back, but an empty queue must cost nothing.
  //
  // Skipped entirely while the tab is hidden. A phone in a pocket has no reason
  // to wake its radio every five seconds, and `visibilitychange` above already
  // flushes the moment the person looks at it again.
  tickTimer = setInterval(() => {
    if (!live.size || document.hidden) return;
    paintBar();
    ensureQueuedRows();
    flush('tick');
  }, 5000);

  // A manual escape hatch for support: "what is stuck on your phone?"
  ui.addSlashCommand({
    name: 'outbox',
    description: 'Show messages still waiting to send from this phone',
    run: () => showOutbox(),
  });
}

// ------------------------------------------------------------------ styling
const STYLE = `
.ob-state{display:inline-flex;align-items:center;gap:var(--s-2);margin-top:var(--s-1);
  font-size:var(--t-xs);color:var(--c-text-3);line-height:1.3;flex-wrap:wrap}
.ob-state .ico{width:13px;height:13px;flex:none}
.ob-state button{padding:var(--s-1) var(--s-3);font-size:var(--t-xs);border-radius:var(--r-sm);
  min-height:0;line-height:1.5}
.ob-sent{color:var(--c-success)}
.ob-waiting{color:var(--c-warn)}
.ob-broke{color:var(--c-danger);font-weight:var(--t-semibold)}
.msg.ob-queued{opacity:1}
.msg.ob-queued .mbody{opacity:.82}
.msg.ob-broke{background:var(--c-danger-quiet);box-shadow:inset 3px 0 0 var(--c-danger)}
.ob-spin{display:inline-block;animation:ob-turn 1.6s linear infinite}
@keyframes ob-turn{to{transform:rotate(360deg)}}

/* A BAND above the message list, not a floating pill.
   It used to be a fixed, centred pill, and two things were wrong with that. A
   fixed box positioned with left:50% only gets HALF the viewport as its
   available width, so on a 390px phone it was squeezed to 195px and wrapped onto
   three lines while its own max-width said 94vw. And being offline is not a
   passing toast - it lasts as long as the walk out of the valley does - so an
   overlay parked over the conversation permanently hides whatever is behind it,
   at every scroll position. As a flow child of section.msgs it pushes the list
   down instead: it covers nothing, needs no measuring, and reads as a state the
   app is in rather than as a notification that will go away. */
#obBar{display:none;align-items:center;gap:var(--s-3);
  padding:var(--s-3) var(--s-5);
  border-block-end:1px solid var(--c-border-subtle);
  background:var(--c-bg-2);color:var(--c-text);
  font-size:var(--t-sm);font-weight:var(--t-medium);line-height:1.35}
#obBar.on{display:flex}
#obBar .ico{width:15px;height:15px;flex:none}
#obBar .ob-txt{min-width:0}
#obBar.ob-down{background:var(--c-danger-quiet);color:var(--c-danger);
  border-block-end-color:var(--c-danger)}
#obBar.ob-wait{background:var(--c-warn-quiet);color:var(--c-warn);
  border-block-end-color:var(--c-warn)}
#obBar.ob-up{background:var(--c-success-quiet);color:var(--c-success);
  border-block-end-color:var(--c-success)}
/* Only if section.msgs was not there to host it. */
body > #obBar.on{position:fixed;left:0;right:0;
  top:calc(var(--header-h,44px) + var(--channelbar-h,49px) + env(safe-area-inset-top));
  z-index:var(--z-toast)}
@media (max-width:860px){
  #obBar{font-size:var(--t-xs);padding:var(--s-3) var(--s-4);align-items:flex-start}
  #obBar .ico{margin-top:2px}
}
.ob-row{display:flex;gap:var(--s-4);align-items:flex-start;padding:var(--s-4) 0;
  border-bottom:1px solid var(--c-border-subtle)}
.ob-row .ob-body{min-width:0;flex:1}
.ob-row .ob-meta{color:var(--c-text-3);font-size:var(--t-xs);margin-top:var(--s-1)}
`;

function injectStyle() {
  if (document.getElementById('ob-style')) return;
  const s = el('style');
  s.id = 'ob-style';
  s.textContent = STYLE;
  document.head.appendChild(s);
}

// ------------------------------------------------------------------ fetch guard
function headersToObject(h) {
  const out = {};
  if (!h) return out;
  if (typeof h.forEach === 'function' && typeof h.get === 'function') {
    h.forEach((v, k) => { out[k] = v; });
  } else if (Array.isArray(h)) {
    for (const [k, v] of h) out[k] = v;
  } else {
    Object.assign(out, h);
  }
  // The JWT is short-lived and is a credential. A queued message must not carry
  // one to disk; the flusher mints a fresh token at replay time.
  delete out.Authorization;
  delete out.authorization;
  return out;
}

function offlineError() {
  const e = new TypeError('your message is saved and will send when the connection is back.');
  e.name = 'Offline';
  e.obHandled = true;
  return e;
}

const urlOf = (input) => (typeof input === 'string' ? input
  : (input && typeof input.url === 'string' ? input.url : String(input)));

let restPatched = false;

// TWO hooks, because one is not enough.
//
// supabase-js resolves its fetch ONCE, when the client is constructed - which
// happens the moment sb.js is imported, long before any feature registers. So
// replacing window.fetch afterwards is invisible to `sb.rpc()` and `sb.from()`,
// which is the entire send path. The client's own `rest.fetch` is read fresh on
// every query, so that is where the send guard has to sit. window.fetch still
// gets wrapped for everything that genuinely uses the global: media uploads and
// the edge functions.
function installFetchGuard() {
  if (window.__obFetch) return;
  rawFetch = window.fetch.bind(window);
  window.__obFetch = rawFetch;

  const rest = sb?.rest;
  if (rest && typeof rest.fetch === 'function') {
    const next = rest.fetch;
    rest.fetch = (input, init) => restGuard(input, init, next);
    restPatched = true;
  }

  window.fetch = async function obFetch(input, init) {
    const url = urlOf(input);
    if (!url.startsWith(SUPABASE_URL)) return rawFetch(input, init);
    const method = String(init?.method || input?.method || 'GET').toUpperCase();

    // Only reachable when the rest hook could not be installed.
    if (!restPatched && method === 'POST' && SEND_RPC.test(url) && typeof init?.body === 'string') {
      return guardedSend(url, init, rawFetch);
    }
    return passThrough(input, init, rawFetch, url);
  };
}

async function restGuard(input, init, next) {
  const url = urlOf(input);
  const method = String(init?.method || input?.method || 'GET').toUpperCase();
  if (method === 'POST' && SEND_RPC.test(url) && typeof init?.body === 'string') {
    return guardedSend(url, init, next);
  }
  return passThrough(input, init, next, url);
}

// Offline: answer instantly rather than let a doomed request sit on the radio
// for thirty seconds. Everything downstream already handles a throw, and this
// way the words it shows a volunteer are ours, not the browser's.
//
// Before throwing, though, look on disk. For the handful of reads that decide
// what the app can show, last night's answer is enormously better than none: it
// is the difference between "here is your Space, from 14:30" and "you are not in
// a Space yet".
async function passThrough(input, init, next, url) {
  const method = String(init?.method || input?.method || 'GET').toUpperCase();
  const body = typeof init?.body === 'string' ? init.body : '';

  if (!navigator.onLine) {
    const hit = await cachedAnswer(method, url, body);
    if (hit) return hit;
    throw noConnectionError();
  }
  try {
    const res = await next(input, init);
    noteHealthy();
    if (res.ok) { noteDraftSaved(url); rememberAnswer(method, url, body, res); }
    return res;
  } catch (e) {
    if (e?.obHandled) throw e;
    noteFailure();
    const hit = await cachedAnswer(method, url, body);
    if (hit) return hit;
    throw noConnectionError();
  }
}

// Fire and forget: a cache write must never be on the critical path of a read
// that already succeeded.
function rememberAnswer(method, url, body, res) {
  if (!isCacheable(url)) return;
  const key = readcache.keyFor(store.me, method, url, body);
  // Remember which key holds the FIRST page of each channel, so messages that
  // arrive afterwards can be folded into it. Without this the cached copy is
  // frozen at the moment the channel was opened, and everything said since -
  // usually the part that mattered - is missing when the app reopens offline.
  if (/get_channel_messages/.test(url)) {
    try {
      const b = JSON.parse(body || '{}');
      if (b.p_channel && !b.p_before_seq) pageKeys.set(b.p_channel, key);
    } catch { /* not a shape we can index */ }
  }
  res.clone().text().then((text) => readcache.write(key, {
    body: text,
    ct: res.headers.get('content-type') || 'application/json',
    // Without these three the app cannot open at all, so they outlive any
    // number of channel pages when the cache has to make room.
    keep: BOOT_CRITICAL.test(url),
  })).catch(() => { /* the live response is unaffected */ });
}

// ---- keeping the cached page current
const pageKeys = new Map();          // channel_id -> readcache key of page 1
const pendingPatch = new Map();      // channel_id -> [msg]

function patchCachedPage(msg) {
  if (!msg?.id || !msg.channel_id || !pageKeys.has(msg.channel_id)) return;
  if (!pendingPatch.has(msg.channel_id)) pendingPatch.set(msg.channel_id, []);
  pendingPatch.get(msg.channel_id).push(msg);
  flushPatches();
}

// Coalesced: a busy channel must not turn every arriving message into an
// IndexedDB round trip.
const flushPatches = debounce(async () => {
  const work = [...pendingPatch.entries()];
  pendingPatch.clear();
  for (const [channelId, msgs] of work) {
    const key = pageKeys.get(channelId);
    if (!key) continue;
    try {
      const rec = await readcache.read(key);
      if (!rec) continue;
      const rows = JSON.parse(rec.body);
      if (!Array.isArray(rows)) continue;
      const have = new Set(rows.map((r) => r.id));
      // The RPC returns newest first; that is the order the reader reverses.
      for (const m of msgs) if (!have.has(m.id)) { rows.unshift(m); have.add(m.id); }
      await readcache.write(key, { body: JSON.stringify(rows.slice(0, 60)), ct: rec.ct });
    } catch { /* a cache we cannot patch is still a cache */ }
  }
}, 1500);

async function cachedAnswer(method, url, body) {
  if (!isCacheable(url)) return null;
  const rec = await readcache.read(readcache.keyFor(store.me, method, url, body));
  if (!rec) return null;
  // Remember the oldest thing on screen, not the newest: the bar must not claim
  // the view is fresher than its stalest part.
  servedAt = servedAt ? Math.min(servedAt, rec.at) : rec.at;
  paintBar();
  return new Response(rec.body, {
    status: 200,
    headers: { 'Content-Type': rec.ct || 'application/json' },
  });
}

// postgrest renders a failed fetch as `${err.name}: ${err.message}`, which is
// exactly how "TypeError: Failed to fetch" ended up inside message bubbles and
// channel lists. Both halves are ours, so the sentence it composes is readable
// wherever core prints e.message raw.
function noConnectionError() {
  // Both halves are deliberately written to read as ONE sentence once postgrest
  // has joined them, because several features print the joined string straight
  // into the page: "No connection: this will load when you are back online."
  const e = new TypeError('this will load when you are back online.');
  e.name = 'No connection';
  e.obHandled = true;
  return e;
}

async function guardedSend(url, init, next) {
  let body = null;
  try { body = JSON.parse(init.body); } catch { /* not ours to touch */ }
  const nonce = body?.p_client_msg_id;
  if (!nonce) return next(url, init);

  const prior = live.get(nonce);
  const rec = {
    nonce,
    url,
    body: init.body,
    headers: headersToObject(init.headers),
    kind: url.includes('send_dm') ? 'dm' : 'channel',
    scope_id: body.p_conversation || body.p_channel || null,
    thread_id: body.p_thread || null,
    text: body.p_body_text || '',
    attachments: Array.isArray(body.p_attachments) ? body.p_attachments : [],
    reply_to: body.p_reply_to || null,
    also_send: !!body.p_also_send,
    created_at: prior?.created_at || Date.now(),
    attempts: prior?.attempts || 0,
    next_at: 0,
    state: 'sending',
    error: null,
  };
  // On disk BEFORE the request goes out. If the tab dies mid-flight the message
  // is still here on the next launch, and replaying it is safe.
  await save(rec);
  snapshotDrafts();
  // A thread reply is the one send path with no optimistic row of its own: the
  // thread composer waits for the server and, on failure, puts the text BACK in
  // the textarea. Queued, that is a trap - the reply is on disk and will send,
  // but the person sees only their own text sitting there unsent, so they press
  // Reply again and the server gets two of them under two different nonces.
  // Clear the box and paint the reply into the thread like any other message.
  if (rec.thread_id) clearThreadComposerSoon(rec.text);
  ensureQueuedRows();

  if (!navigator.onLine) {
    await queueFor(rec, 0);
    throw offlineError();
  }

  // Only decorate the row if the send is still in flight after SLOW_PAINT_MS.
  const slowPaint = setTimeout(() => markRow(nonce), SLOW_PAINT_MS);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SEND_TIMEOUT_MS);
  let res;
  try {
    res = await next(url, { ...init, signal: init.signal || ctrl.signal });
  } catch (e) {
    clearTimeout(timer);
    clearTimeout(slowPaint);
    noteFailure();
    await queueFor(rec, 1);
    throw offlineError();
  }
  clearTimeout(timer);
  clearTimeout(slowPaint);

  if (res.ok) {
    noteHealthy();
    await drop(nonce);
    let landedId = null;
    try {
      const j = await res.clone().json();
      const row = Array.isArray(j) ? j[0] : j;
      landedId = row?.id || null;
      // My own message never comes back as a broadcast - the client dedupes its
      // own echo - so it has to be folded into the cached page from here or the
      // last thing I said is missing when the app reopens with no signal.
      patchCachedPage(row);
    } catch { /* the caller still gets the real response */ }
    // The composer re-points its optimistic row on the same turn; wait one
    // macrotask so the tick lands on the finished row rather than a stale id.
    // Reading the response body is real I/O, so the exact ordering is not
    // guaranteed - run it twice rather than guess.
    setTimeout(() => stampSent(nonce, landedId), 0);
    setTimeout(() => stampSent(nonce, landedId), 250);
    paintBar();
    return res;
  }

  if (RETRY_STATUS.has(res.status)) {
    await queueFor(rec, 1, `server busy (${res.status})`);
    throw offlineError();
  }

  // A 400 or a 403 is a real answer, not a network problem. Keep the text so it
  // is never silently lost, but stop retrying and ask the person what to do.
  const detail = await res.clone().text().catch(() => '');
  rec.state = 'failed';
  rec.error = humanReason(detail, res.status);
  await save(rec);
  markRowSoon(nonce);
  paintBar();
  return res;
}

async function queueFor(rec, bumped, why) {
  rec.attempts = (rec.attempts || 0) + (bumped ? 1 : 0);
  rec.state = 'queued';
  rec.error = why || null;
  const step = BACKOFF_MS[Math.min(Math.max(rec.attempts - 1, 0), BACKOFF_MS.length - 1)];
  rec.next_at = Date.now() + (rec.attempts ? step + Math.floor(Math.random() * 800) : 0);
  await save(rec);
  markRowSoon(rec.nonce);
  paintBar();
}

// ------------------------------------------------------------------ queue store
async function save(rec) {
  live.set(rec.nonce, rec);
  try { await outbox.put(rec); } catch { /* memory copy still serves this session */ }
}

async function drop(nonce) {
  live.delete(nonce);
  try { await outbox.del(nonce); } catch { /* nothing left to do */ }
}

// ------------------------------------------------------------------ flusher
// Serialised on purpose. Two messages replayed in parallel get their seq from
// whichever transaction commits first, so a conversation can come back in the
// wrong order. One at a time, oldest first, is the only correct replay.
async function flush(reason) {
  if (flushing || !navigator.onLine || !live.size) return;
  flushing = true;
  try {
    const rows = [...live.values()].sort((a, z) => a.created_at - z.created_at);
    for (const r of rows) {
      if (!navigator.onLine) break;
      if (r.state === 'failed') continue;          // waiting on a human
      if ((r.next_at || 0) > Date.now()) continue;
      await attempt(r);
    }
  } finally {
    flushing = false;
    paintBar();
  }
}

async function attempt(rec) {
  rec.state = 'sending';
  await save(rec);
  markRow(rec.nonce);

  const headers = { ...rec.headers, apikey: PUBLISHABLE };
  const tok = await accessToken().catch(() => null);
  // No session yet (boot, or a refresh in flight). Wait rather than fire a
  // request that is certain to come back 401.
  if (!tok) { await queueFor(rec, 1); return; }
  headers.Authorization = 'Bearer ' + tok;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SEND_TIMEOUT_MS);
  let res;
  try {
    res = await rawFetch(rec.url, {
      method: 'POST', headers, body: rec.body, signal: ctrl.signal,
    });
  } catch {
    clearTimeout(timer);
    noteFailure();
    await queueFor(rec, 1);
    return;
  }
  clearTimeout(timer);

  if (res.ok) {
    noteHealthy();
    let row = null;
    try {
      const j = await res.json();
      row = Array.isArray(j) ? j[0] : j;
    } catch { /* it landed; we just cannot decorate it */ }
    await drop(rec.nonce);
    landed(rec, row);
    patchCachedPage(row);
    return;
  }

  if (RETRY_STATUS.has(res.status)) { await queueFor(rec, 1, `server busy (${res.status})`); return; }

  const detail = await res.text().catch(() => '');
  rec.state = 'failed';
  rec.error = humanReason(detail, res.status);
  await save(rec);
  markRow(rec.nonce);
}

// The message is now in Postgres. Point the row that is already on screen at the
// real id so reactions, threads and every action work on it, exactly as a
// first-try send would have.
function landed(rec, row) {
  // An also-send thread reply is on screen TWICE, in the panel and in the
  // channel. Both copies have to become the real message or one of them is left
  // as a husk with no id, where reactions and replies quietly do nothing.
  const nodes = rowsFor(rec.nonce);
  if (row?.id) {
    store.seen.add(row.id);
    store.seen.add('n:' + rec.nonce);
    if (row.seq && rec.kind === 'channel' && store.current?.id === rec.scope_id) {
      store.cursor = Math.max(store.cursor, row.seq);
    }
    for (const node of nodes) {
      // The realtime echo can beat this response back. A thread reply reaches the
      // panel through `message:new`, which gates on the REAL id - an id our row
      // does not carry until the line below - so if the broadcast already painted
      // it, upgrading ours would leave the reply on screen twice. Drop the echo
      // and keep ours: ours is the row the person has been watching, it holds the
      // delivery state, and it is in the position they last saw it in.
      const host = node.parentElement;
      const twin = host?.querySelector(`[data-id="${CSS.escape(row.id)}"]`);
      if (twin && twin !== node) twin.remove();
      node.classList.remove('ob-queued', 'ob-broke', 'failed', 'pending');
      const ctx = rec.kind === 'dm' ? 'dm' : (node.closest('#threadMsgs') ? 'thread' : 'channel');
      upgradeMessageRow(node, row, ctx);
      node.dataset.obNonce = rec.nonce;
    }
  }
  for (const node of rowsFor(rec.nonce)) setState(node, 'sent');
  paintBar();
}

// Only rows that were ALREADY carrying a state get a tick. A message that landed
// on the first try in under a second was never in doubt, so it gets nothing -
// see SLOW_PAINT_MS. The flusher calls setState('sent') directly instead,
// because a message that spent time in the queue has definitely earned it.
function stampSent(nonce, landedId) {
  let nodes = rowsFor(nonce);
  if (!nodes.length && landedId) {
    const byId = document.getElementById('m' + landedId);
    nodes = byId ? [byId] : [];
  }
  for (const node of nodes) {
    if (!node.querySelector('.ob-state')) continue;
    node.dataset.obNonce = nonce;
    node.classList.remove('ob-queued', 'ob-broke');
    setState(node, 'sent');
  }
}

// ------------------------------------------------------------------ row state
function rowsFor(nonce) {
  const tagged = [...document.querySelectorAll(`[data-ob-nonce="${CSS.escape(nonce)}"]`)];
  if (tagged.length) return tagged;
  // Before we have tagged it, the composer's optimistic row is keyed by the
  // nonce it minted.
  const byId = document.getElementById('m' + nonce);
  return byId ? [byId] : [];
}

function rowFor(nonce) {
  return rowsFor(nonce)[0] || null;
}

const LABEL = {
  sending: 'Sending',
  queued: 'Waiting for internet',
  retrying: 'Trying again',
  sent: 'Sent',
  failed: 'Not sent',
};

function setState(node, state, rec) {
  if (!node) return;
  const mbody = node.querySelector('.mbody') || node;
  let strip = node.querySelector('.ob-state');
  if (!strip) {
    strip = el('div', 'ob-state');
    const anchor = mbody.querySelector('.rxns');
    if (anchor) mbody.insertBefore(strip, anchor);
    else mbody.appendChild(strip);
  }
  node.classList.toggle('ob-queued', state === 'queued' || state === 'retrying' || state === 'sending');
  node.classList.toggle('ob-broke', state === 'failed');
  if (state !== 'failed') node.classList.remove('failed');

  // The composer paints its own failure furniture into .body before we get here.
  // Two conflicting stories about one message is worse than either, so ours
  // replaces it.
  node.querySelector('.send-error')?.remove();
  for (const b of node.querySelectorAll('.body > button')) b.remove();

  const glyph = state === 'sent' ? icon('check')
    : state === 'failed' ? icon('close')
      : icon('clock');
  const tone = state === 'sent' ? 'ob-sent' : state === 'failed' ? 'ob-broke' : 'ob-waiting';
  const spin = state === 'sending' ? ' ob-spin' : '';
  const why = state === 'failed' && rec?.error ? ` - ${esc(rec.error)}` : '';

  strip.className = 'ob-state ' + tone;
  strip.innerHTML = `<span class="${spin.trim()}">${glyph}</span><span>${esc(LABEL[state] || state)}${why}</span>`;

  if (state === 'failed') {
    rowExplainedAt = Date.now();
    const again = el('button', 'sm', 'Try again');
    again.onclick = () => retryOne(rec?.nonce || node.dataset.obNonce);
    const bin = el('button', 'sm ghost', 'Delete');
    bin.onclick = () => discardOne(rec?.nonce || node.dataset.obNonce, node);
    strip.append(again, bin);
  }
  if (state === 'sent') {
    // A permanent tick on every message is noise. It has done its job once the
    // person has seen it, so retire it quietly.
    setTimeout(() => { if (strip.classList.contains('ob-sent')) strip.remove(); }, 6000);
  }
  // The strip and its two buttons make the row taller AFTER the send scrolled to
  // the bottom, so "Not sent - Try again / Delete" ends up under the composer,
  // which is the one state nobody can afford to miss. Follow it down - but only
  // if they were already at the bottom, never yanking someone out of history.
  if (state === 'failed' && node.closest('#messages')) {
    const list = $('messages');
    if (list && list.scrollHeight - list.scrollTop - list.clientHeight < 220) scrollDown();
  }
}

function markRow(nonce) {
  const rec = live.get(nonce);
  if (!rec) return;
  const state = rec.state === 'queued' && rec.attempts > 0 && navigator.onLine ? 'retrying' : rec.state;
  for (const node of rowsFor(nonce)) {
    node.dataset.obNonce = nonce;
    setState(node, state, rec);
  }
}

// The composer paints its own "failed + Retry" furniture in the catch block that
// runs AFTER we resolve, so painting once is not enough - the last writer wins
// and it must be us. Two cheap re-runs cover both orderings.
function markRowSoon(nonce) {
  markRow(nonce);
  setTimeout(() => markRow(nonce), 0);
  setTimeout(() => markRow(nonce), 140);
}

function repaintAllRows() {
  for (const nonce of live.keys()) markRow(nonce);
}

async function retryOne(nonce) {
  const rec = live.get(nonce);
  if (!rec) return;
  rec.state = 'queued';
  rec.attempts = 0;
  rec.next_at = 0;
  rec.error = null;
  await save(rec);
  markRow(nonce);
  flush('manual');
}

async function discardOne(nonce, node) {
  const rec = live.get(nonce);
  const okGone = await ui.confirmModal({
    title: 'Delete this message?',
    body: 'It was never sent, and deleting it here means nobody will ever see it. '
      + (rec?.text ? `"${rec.text.slice(0, 120)}"` : ''),
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!okGone) return;
  const nodes = rowsFor(nonce);
  await drop(nonce);
  for (const n of (nodes.length ? nodes : [node].filter(Boolean))) n.remove();
  paintBar();
}

// ------------------------------------------------------------------ restoring rows
// A queued message must still be on screen after a reload, in the channel it was
// written in. Core rebuilds the list from the server and knows nothing about the
// queue, so re-append ours at the end whenever the list changes.
function currentScope() {
  if (store.currentDM) return { kind: 'dm', id: store.currentDM };
  if (store.current) return { kind: 'channel', id: store.current.id };
  return null;
}

// A thread reply is the only send with no optimistic row of core's own: core
// appends it AFTER the server answers. So while such a send is still in flight
// and the network is up, painting our own row would leave two of them the moment
// it succeeds. Wait until it is genuinely waiting - offline, queued, retrying or
// refused - which is the only case core leaves nothing on screen.
function needsOurRow(rec) {
  if (!rec.thread_id) return true;
  return !(rec.state === 'sending' && navigator.onLine);
}

function optimisticRow(rec) {
  return {
    id: rec.nonce,
    client_msg_id: rec.nonce,
    author_id: store.me,
    body_text: rec.text,
    attachments: rec.attachments,
    created_at: new Date(rec.created_at).toISOString(),
    reply_to_id: rec.reply_to,
  };
}

function ensureQueuedRowsNow() {
  if (!live.size) return;
  const rows = [...live.values()].sort((a, z) => a.created_at - z.created_at);
  const scope = currentScope();
  const host = $('messages');
  let added = false;

  if (scope && host) {
    for (const rec of rows) {
      if (rec.kind !== scope.kind || rec.scope_id !== scope.id) continue;
      // A thread reply belongs in the panel, not the channel - unless its author
      // ticked "Also send to #channel", which is the whole point of that tick.
      if (rec.thread_id && !rec.also_send) continue;
      if (!needsOurRow(rec)) continue;
      if (rowFor(rec.nonce)) continue;
      host.querySelector('.empty')?.remove();
      store.seen.add('n:' + rec.nonce);
      const node = appendMessage(host, optimisticRow(rec), scope.kind);
      node.dataset.obNonce = rec.nonce;
      markRow(rec.nonce);
      added = true;
    }
    if (added) scrollDown();
  }

  ensureThreadRows(rows);
}

// The open thread panel is a second list with its own host, rebuilt from the
// server whenever it opens. Queued replies have to be put back into it for the
// same reason they are put back into a channel: a message you cannot see is a
// message you will write again.
function ensureThreadRows(rows) {
  const host = $('threadMsgs');
  if (!host || !threadState.id) return;
  let added = false;
  for (const rec of rows) {
    if (rec.thread_id !== threadState.id) continue;
    if (!needsOurRow(rec)) continue;
    if (host.querySelector(`[data-ob-nonce="${CSS.escape(rec.nonce)}"]`)) continue;
    // The channel copy of an also-send reply carries the same nonce, so look
    // inside THIS host rather than the whole document.
    const node = appendMessage(host, optimisticRow(rec), 'thread');
    node.dataset.obNonce = rec.nonce;
    setState(node, rec.state === 'failed' ? 'failed'
      : (rec.attempts > 0 && navigator.onLine ? 'retrying' : rec.state), rec);
    added = true;
  }
  if (added) host.scrollTop = host.scrollHeight;
}

// Core restores the text into the thread textarea in its own catch block, which
// runs after we resolve. Clearing once is not enough: the last writer wins and
// it has to be us.
function clearThreadComposerSoon(text) {
  const wipe = () => {
    const ta = document.getElementById('threadComposer');
    if (ta && ta.value.trim() === String(text || '').trim()) {
      ta.value = '';
      ta.style.height = 'auto';
    }
  };
  wipe();
  setTimeout(wipe, 0);
  setTimeout(wipe, 160);
}

const ensureQueuedRows = debounce(ensureQueuedRowsNow, 180);

// openChannel emits `channel:open` before it has fetched anything and then wipes
// the list, so a one-shot hook on that event paints into a node that is about to
// be thrown away. Watching the list itself is the only trigger that survives a
// slow load, a reconcile and a jump-to-message alike.
// The composer paints its own "failed + Retry" button into .body and we remove
// it on the next macrotask - a window of well under a frame, but a real one. A
// click inside it re-sends with a FRESH nonce, which is the one thing the whole
// design exists to prevent: the message is already on disk under the old nonce,
// so the person would get two. Swallow the click at the capture phase instead of
// racing the DOM, and do our retry rather than core's.
function guardCoreRetry() {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest?.('.msg .body > button');
    if (!btn) return;
    const row = btn.closest('.msg');
    const nonce = row?.dataset.obNonce
      || (row?.id?.startsWith('m') && live.has(row.id.slice(1)) ? row.id.slice(1) : null);
    if (!nonce || !live.has(nonce)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    btn.remove();
    retryOne(nonce);
  }, true);
}

function watchMessageList() {
  const host = $('messages');
  if (!host || !window.MutationObserver) return;
  new MutationObserver(() => { if (live.size) ensureQueuedRows(); })
    .observe(host, { childList: true });
}

// ------------------------------------------------------------------ connection bar
let bar = null;

function buildBar() {
  if (document.getElementById('obBar')) return;
  bar = el('div');
  bar.id = 'obBar';
  // Announced to a screen reader, which nothing else in the shell currently is.
  bar.setAttribute('role', 'status');
  bar.setAttribute('aria-live', 'polite');
  // Above the scroller, inside the conversation column: it belongs to the
  // conversation, and putting it in the flow is what stops it covering messages.
  const list = $('messages');
  if (list?.parentNode) list.parentNode.insertBefore(bar, list);
  else document.body.appendChild(bar);
  paintBar();
}

// Local wall-clock, because "saved at 14:30" is something a person can judge
// against their own day. A relative "3 hours ago" needs arithmetic to act on.
function clockOf(ms) {
  try {
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch { return 'earlier'; }
}

function queueCounts() {
  let waiting = 0;
  let broken = 0;
  for (const r of live.values()) (r.state === 'failed' ? broken++ : waiting++);
  return { waiting, broken };
}

function paintBar() {
  if (!bar) bar = document.getElementById('obBar');
  if (!bar) return;
  const { waiting, broken } = queueCounts();
  const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;

  let cls = '';
  let glyph = '';
  let text = '';

  if (!navigator.onLine) {
    cls = 'ob-down';
    glyph = icon('plug');
    const since = servedAt ? ` Showing what was saved at ${clockOf(servedAt)}.` : '';
    text = waiting
      ? `No internet. ${n(waiting, 'message', 'messages')} will send when you are back.${since}`
      : `No internet.${since || ' You can keep reading and writing.'}`;
  } else if (netFails >= 2) {
    cls = 'ob-wait';
    glyph = icon('clock');
    text = 'Reconnecting…';
  } else if (broken) {
    cls = 'ob-down';
    glyph = icon('close');
    text = `${n(broken, 'message was', 'messages were')} not sent. Open it to try again.`;
  } else if (waiting) {
    cls = 'ob-wait';
    glyph = icon('clock');
    text = `Sending ${n(waiting, 'message', 'messages')}…`;
  } else if (recovered && Date.now() - recovered < 2600) {
    cls = 'ob-up';
    glyph = icon('check');
    text = 'Back online.';
    setTimeout(paintBar, 2700);
  }

  if (!text) { bar.classList.remove('on'); bar.innerHTML = ''; return; }
  bar.className = 'on ' + cls;
  bar.innerHTML = `${glyph}<span class="ob-txt">${esc(text)}</span>`;
}

function noteHealthy() {
  if (netFails) { netFails = 0; recovered = Date.now(); paintBar(); }
}

function noteFailure() {
  netFails++;
  if (netFails === 2) paintBar();
}

// ------------------------------------------------------------------ the queue panel
function showOutbox() {
  const rows = [...live.values()].sort((a, z) => a.created_at - z.created_at);
  const box = el('div');
  if (!rows.length) {
    box.innerHTML = '<div class="empty">Nothing waiting. Everything you have written has reached the server.</div>';
  } else {
    for (const r of rows) {
      const line = el('div', 'ob-row');
      const label = r.state === 'failed' ? `Not sent - ${r.error || 'rejected'}`
        : navigator.onLine ? 'Waiting to send' : 'Waiting for internet';
      line.innerHTML = `<div class="ob-body"><div>${esc(r.text || '(attachment only)')}</div>
        <div class="ob-meta">${esc(label)} · ${r.attempts || 0} ${r.attempts === 1 ? 'try' : 'tries'}</div></div>`;
      const again = el('button', 'sm', 'Try now');
      again.onclick = () => { retryOne(r.nonce); };
      line.appendChild(again);
      box.appendChild(line);
    }
  }
  ui.modal({ title: 'Waiting to send', body: box, actions: [{ label: 'Close', kind: 'ghost', onClick: (c) => c() }] });
}

// ------------------------------------------------------------------ human copy
// Never show a person a Postgres condition name or a browser exception class.
const REASONS = [
  [/forbidden_hierarchy|forbidden/i, 'you cannot post in this channel'],
  [/timed_out/i, 'you are timed out in this Space'],
  [/body_too_long/i, 'the message is too long'],
  [/attachments_too_large/i, 'the attachments are too large'],
  [/too_many_mentions/i, 'too many people mentioned'],
  [/rate_limit/i, 'you are sending too fast'],
  [/unauthenticated|JWT|token/i, 'you were signed out'],
  [/blocked/i, 'this person is not accepting messages'],
  [/invalid_reply|invalid_thread/i, 'the message it replies to is gone'],
];

function humanReason(detail, status) {
  for (const [re, copy] of REASONS) if (re.test(detail || '')) return copy;
  return `the server refused it (${status})`;
}

// Core toasts `e.message` verbatim, which is how "TypeError: Failed to fetch"
// reached people's phones. This rewrites the handful of raw strings that
// actually occur into something a volunteer can act on, and drops the ones the
// connection bar already says better.
const TOAST_MAP = [
  [/will send when the connection is back|Offline:/i, null],
  [/Failed to fetch|Load failed|NetworkError|No connection:|network ?error/i,
    'No connection. Nothing you have written is lost - try again when you are back online.'],
  [/\btimed_out\b/i, 'You are timed out in this Space and cannot post right now.'],
  [/\bforbidden\b/i, 'You do not have permission to do that here.'],
  [/\bbody_too_long\b/i, 'That message is too long. Shorten it and try again.'],
  [/\brate_limit/i, 'Slow down a moment - too many messages at once.'],
  [/\bunauthenticated\b/i, 'You were signed out. Open the app again to sign in.'],
];

// Set whenever a message row has just been given a readable failure of its own.
let rowExplainedAt = 0;

function humanizeToast(node) {
  if (!(node instanceof HTMLElement) || !node.classList.contains('toast')) return;
  const txt = node.textContent || '';
  for (const [re, replacement] of TOAST_MAP) {
    if (!re.test(txt)) continue;
    // If the message row itself is already saying this, the toast is a second
    // copy of the same sentence - and it lands on top of the Try again and
    // Delete buttons that are the only way to act on it.
    if (replacement === null || Date.now() - rowExplainedAt < 4000) node.remove();
    else node.textContent = replacement;
    return;
  }
}

function installToastHumanizer() {
  if (!window.MutationObserver) return;
  const wire = (host) => {
    // The host is created and its first toast appended inside one task, and a
    // MutationObserver callback only runs at the end of it - so by the time we
    // get here the first toast is already a child. Sweep before observing or the
    // very first failure of the session slips through, which is the one that
    // matters most.
    for (const n of [...host.children]) humanizeToast(n);
    new MutationObserver((muts) => {
      for (const m of muts) for (const n of m.addedNodes) humanizeToast(n);
    }).observe(host, { childList: true });
  };
  const existing = document.querySelector('.toasts');
  if (existing) { wire(existing); return; }
  const bodyWatch = new MutationObserver(() => {
    const host = document.querySelector('.toasts');
    if (host) { wire(host); bodyWatch.disconnect(); }
  });
  bodyWatch.observe(document.body, { childList: true });
}

// ------------------------------------------------------------------ local drafts
// Drafts are synced to the server, which is exactly the thing that does not work
// with no signal: `save_draft` fails and half a typed field report exists only
// in a textarea that Android is free to destroy. Mirror it locally, and prefer
// the local copy over the server's whenever the server never got this version.
function readLocalDrafts() {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}'); } catch { return {}; }
}

function snapshotDrafts() {
  const prev = readLocalDrafts();
  const out = {};
  for (const [k, text] of store.drafts) {
    out[k] = { text, synced: prev[k]?.text === text ? !!prev[k]?.synced : false };
  }
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(out)); } catch { /* quota: nothing to do */ }
}

function markDraftSynced(key) {
  const all = readLocalDrafts();
  if (!all[key]) return;
  all[key].synced = true;
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(all)); } catch { /* ignore */ }
}

function mergeLocalDrafts() {
  const local = readLocalDrafts();
  for (const [k, v] of Object.entries(local)) {
    if (!v || typeof v.text !== 'string' || !v.text) continue;
    // The server copy wins only when it has actually seen this text.
    if (v.synced && store.drafts.has(k)) continue;
    store.drafts.set(k, v.text);
  }
}

function restoreLocalDrafts() {
  mergeLocalDrafts();
  // workspace.js replaces store.drafts wholesale from the bootstrap blob, so the
  // merge has to run again after that lands.
  bus.on('workspace', () => {
    mergeLocalDrafts();
    const c = $('composer');
    const scope = store.currentDM ? 'dm:' + store.currentDM
      : store.current ? 'channel:' + store.current.id : null;
    if (c && scope && !c.value) c.value = store.drafts.get(scope) || '';
  });
}

function watchComposerDrafts() {
  const c = $('composer');
  if (!c) return;
  // Slower than core's 900ms server save on purpose: this is a local backstop,
  // not another round trip, and it must not compete for the main thread while
  // someone is typing Devanagari on a phone keyboard.
  c.addEventListener('input', debounce(() => snapshotDrafts(), 1200));
}

// A save_draft that came back 2xx proves the server holds this exact text, which
// is what lets the merge on next launch trust the server copy over the local one.
function noteDraftSaved(url) {
  if (!/\/rest\/v1\/rpc\/save_draft/.test(url)) return;
  const scope = store.currentDM ? 'dm:' + store.currentDM
    : store.current ? 'channel:' + store.current.id : null;
  if (scope) markDraftSynced(scope);
}
