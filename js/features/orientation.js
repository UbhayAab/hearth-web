// Orienting someone who joins three months in.
//
// A volunteer opens #field-updates for the first time and lands in the middle of a
// conversation that started before they existed. Retry already had every
// ingredient - canvases, topics, pins, onboarding gates - and connected none of
// them to the moment someone opens a channel for the first time.
//
// This is that wiring: a "Start here" card shown ONCE on first open, built from
// the channel's purpose, a short markdown guide, the pins, and anything the reader
// still owes a confirmation on. Deterministic on purpose - an LLM summary costs
// money per channel per user and would mangle Hinglish names, and the pinned
// version is what people actually read.
import { rpc, tryRpc } from '../api.js';
import { store, bus, nameOf } from '../store.js';
import { el, esc, fmt, relTime } from '../util.js';
import { icon } from '../icons.js';
import { getSub } from '../sb.js';

const CLS = 'ori';
const PANEL = 'channel-guide';
let uiRef = null;

// channel_id -> get_channel_guide payload. Channel switches are frequent and this
// fires on every one; on 3G a cached answer is the difference between instant and
// a second of blank.
const cache = new Map();
// Never show the first-visit card twice in one session even if the server round
// trip is slow enough that two channel:open events overlap.
const shownThisSession = new Set();

function humanError(e) {
  const m = String(e?.message || '');
  if (/failed to fetch|networkerror|load failed/i.test(m)) return 'No connection. Try again when you are back online.';
  if (/forbidden/i.test(m)) return 'Only someone who can manage this channel can change that.';
  if (/purpose_too_long/i.test(m)) return 'Keep the purpose to a line or two.';
  if (/body_too_long/i.test(m)) return 'That guide is too long. Keep it to the first few things someone needs.';
  return 'That did not work. Try again in a moment.';
}

async function load(channelId, force = false) {
  if (!force && cache.has(channelId)) return cache.get(channelId);
  const data = await rpc('get_channel_guide', { p_channel: channelId });
  cache.set(channelId, data);
  return data;
}

// ------------------------------------------------------------------ the card
// `dismissable` is false inside the side panel: a "Close" that deletes the card
// and leaves an empty panel behind is a dead end, and the panel already has its
// own close button in the header.
function buildCard(g, { firstVisit, dismissable = true }) {
  const card = el('div', CLS + '-card' + (firstVisit ? ' ' + CLS + '-first' : ''));
  const hasGuide = !!(g.purpose || g.body);

  let h = `<div class="${CLS}-head">
      <span class="${CLS}-tag">${firstVisit ? 'WELCOME' : 'ABOUT THIS CHANNEL'}</span>
      <span class="${CLS}-name">#${esc(g.channel_name || '')}</span>
    </div>`;

  if (g.purpose) h += `<div class="${CLS}-purpose">${esc(g.purpose)}</div>`;
  else if (g.topic) h += `<div class="${CLS}-purpose">${esc(g.topic)}</div>`;

  if (g.body) h += `<div class="${CLS}-body">${fmt(g.body)}</div>`;

  if (!hasGuide) {
    h += `<div class="${CLS}-empty">Nobody has written a "start here" for this channel yet.`
      + (g.can_edit ? ' You can - it is the fastest way to stop answering the same question.' : '')
      + '</div>';
  }

  if ((g.pins || []).length) {
    h += `<div class="${CLS}-sec">Pinned - read these first</div><div class="${CLS}-pins">`;
    for (const p of g.pins.slice(0, 5)) {
      h += `<button type="button" class="${CLS}-pin" data-jump="${esc(p.message_id)}">
        ${icon('pin')}<span>${esc(p.body_text || '(attachment)')}</span></button>`;
    }
    h += '</div>';
  }

  if ((g.open_asks || []).length) {
    h += `<div class="${CLS}-sec ${CLS}-owed">You still need to confirm</div><div class="${CLS}-pins">`;
    for (const a of g.open_asks.slice(0, 5)) {
      h += `<button type="button" class="${CLS}-pin ${CLS}-ask" data-jump="${esc(a.message_id)}">
        ${icon('megaphone')}<span>${esc(a.body_text || '')}</span></button>`;
    }
    h += '</div>';
  }

  h += `<div class="${CLS}-foot row gap"></div>`;
  card.innerHTML = h;

  card.querySelectorAll('[data-jump]').forEach((n) => {
    n.onclick = (e) => { e.stopPropagation(); bus.emit('message:jump', { messageId: n.dataset.jump }); };
  });

  const foot = card.querySelector('.' + CLS + '-foot');

  if (firstVisit) {
    const ok = el('button', CLS + '-got', 'Got it, take me to the messages');
    ok.type = 'button';
    ok.onclick = async () => {
      card.remove();
      try { await rpc('mark_guide_seen', { p_channel: g.channel_id }); cache.delete(g.channel_id); }
      catch { /* the flag is a nicety; never block the user on it */ }
    };
    foot.appendChild(ok);
  }

  if (g.can_edit) {
    const ed = el('button', 'sm ghost', hasGuide ? 'Edit this' : 'Write a "start here"');
    ed.type = 'button';
    ed.onclick = (e) => { e.stopPropagation(); editDialog(g.channel_id); };
    foot.appendChild(ed);
  }

  if (!firstVisit && dismissable) {
    const cl = el('button', 'sm ghost', 'Close');
    cl.type = 'button';
    cl.onclick = () => card.remove();
    foot.appendChild(cl);
  }

  return card;
}

// ------------------------------------------------------------------ first visit
// The card goes at the TOP of the message list, above the oldest loaded message,
// so it reads as "before all this" rather than as a message someone sent.
function showCard(g, firstVisit) {
  const host = document.getElementById('messages');
  if (!host) return;
  host.querySelector('.' + CLS + '-card')?.remove();
  const card = buildCard(g, { firstVisit });
  host.prepend(card);
  if (firstVisit) card.scrollIntoView({ block: 'start' });
}

// The once-only welcome, as a banner pinned under the channel bar rather than a
// dialog.
//
// A modal on channel entry steals focus, blocks the composer and has to be
// dismissed before you can do the thing you came to do - and it fires on the
// FIRST visit to every channel, so someone joining a Space with six channels is
// interrupted six times. Nobody reads the sixth. It also swallowed clicks for
// anything underneath, which is a real trap on a phone.
//
// A banner is visible without being in the way: it sits above the conversation,
// scrolls nothing, and one tap retires it for good.
function showWelcome(g) {
  const host = document.querySelector('section.msgs');
  if (!host) return;
  host.querySelector('.' + CLS + '-banner')?.remove();

  const card = buildCard(g, { firstVisit: false });
  card.querySelector('.' + CLS + '-foot')?.remove();

  const banner = el('div', CLS + '-banner');
  const head = el('div', CLS + '-bannerhead');
  head.innerHTML = `<strong>Welcome to #${esc(g.channel_name || 'this channel')}</strong>`;
  const close = el('button', 'icon', icon('close'));
  close.setAttribute('aria-label', 'Dismiss');
  close.onclick = () => {
    banner.remove();
    tryRpc('mark_guide_seen', { p_channel: g.channel_id });
    cache.delete(g.channel_id);
  };
  head.appendChild(close);
  banner.append(head, card);

  if (g.can_edit) {
    const ed = el('button', 'ghost sm', 'Edit this');
    ed.onclick = () => editDialog(g.channel_id);
    banner.appendChild(ed);
  }
  // Above the message list, below the channel bar.
  host.insertBefore(banner, host.firstChild);
}

// openChannel() emits channel:open FIRST and only then paints the list - it sets
// `loading…`, awaits two round trips and finally does `innerHTML = ''`. Anything
// prepended before that lands is silently wiped. So wait for the list to settle
// before mounting, and bail if the user has already moved on (which on 3G they
// well might have).
async function whenListReady(channelId, timeoutMs = 9000) {
  const t0 = Date.now();
  for (;;) {
    if (store.current?.id !== channelId) return false;
    const host = document.getElementById('messages');
    const painting = !host || host.querySelector(':scope > .muted.pad') || !host.children.length;
    if (!painting) {
      // one extra beat, because core appends rows in a loop after clearing
      await new Promise((r) => setTimeout(r, 150));
      return store.current?.id === channelId;
    }
    if (Date.now() - t0 > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 120));
  }
}

async function onChannelOpen(channel) {
  const id = channel?.id;
  if (!id) return;
  const [g] = await tryRpc('get_channel_guide', { p_channel: id });
  if (!g) return;                                    // offline or gone; say nothing
  cache.set(id, g);

  const firstVisit = !g.seen && !shownThisSession.has(id);
  // Show the welcome only when there is actually something to orient someone with.
  // A blank "welcome" card is worse than no card.
  const worthShowing = !!(g.purpose || g.body || (g.pins || []).length);

  if (firstVisit && worthShowing) {
    shownThisSession.add(id);
    // A card prepended to the message list is invisible: openChannel() scrolls to
    // the newest message, so "welcome" ends up a screen and a half above where the
    // user is looking. On the one visit that matters, put it in front of them.
    showWelcome(g);
    return;
  }
  // Not their first visit, but they owe somebody a confirmation in here - that is
  // worth surfacing every time until they answer it.
  if ((g.open_asks || []).length) {
    if (await whenListReady(id)) showCard(g, false);
  }
  if (firstVisit) {
    shownThisSession.add(id);
    tryRpc('mark_guide_seen', { p_channel: id });
  }
}

// ------------------------------------------------------------------ editing
async function editDialog(channelId) {
  let g;
  try { g = await load(channelId, true); } catch (e) { uiRef.toast(humanError(e), 'error'); return; }

  const out = await uiRef.formModal({
    title: 'Start here for #' + (g.channel_name || ''),
    wide: true,
    fields: [
      { name: 'purpose', label: 'What is this channel for?', value: g.purpose || '',
        placeholder: 'Day to day coordination for field staff in Dharavi',
        hint: 'One line. It is the first thing a new volunteer reads.' },
      { name: 'body', label: 'What should someone do first?', type: 'textarea', rows: 8,
        value: g.body || '',
        placeholder: '1. Say hello and tell us which area you cover\n'
          + '2. Read the pinned safety note\n3. Post your update by 6pm every day',
        hint: 'Markdown works. Keep it to the first three things - nobody reads more.' },
    ],
    submitLabel: 'Save',
  });
  if (!out) return;

  try {
    await rpc('set_channel_guide', {
      p_channel: channelId,
      p_purpose: out.purpose ?? '',
      p_body: out.body ?? '',
    });
    cache.delete(channelId);
    uiRef.toast('Saved', 'success');
    const fresh = await load(channelId, true);
    if (store.current?.id === channelId) showCard(fresh, false);
    if (uiRef.currentPanel?.() === PANEL) uiRef.openPanel(PANEL, { channelId });
  } catch (e) { uiRef.toast(humanError(e), 'error'); }
}

// ------------------------------------------------------------------ panel
async function renderPanel(body, ctx = {}) {
  const id = ctx.channelId || store.current?.id;
  if (!id) {
    body.innerHTML = '<div class="empty">Open a channel to see what it is for.</div>';
    return;
  }
  body.innerHTML = '<div class="muted pad">loading…</div>';

  let g;
  try { g = await load(id, true); }
  catch (e) { body.innerHTML = `<div class="empty">${esc(humanError(e))}</div>`; return; }

  body.innerHTML = '';
  body.appendChild(buildCard(g, { firstVisit: false, dismissable: false }));

  const meta = el('div', 'muted ' + CLS + '-meta');
  meta.innerHTML = g.updated_at
    ? `Last updated ${esc(relTime(g.updated_at))} by ${esc(nameOf(g.updated_by))} ·
       ${Number(g.member_count) || 0} people in this Space`
    : `${Number(g.member_count) || 0} people in this Space`;
  body.appendChild(meta);
}

// ------------------------------------------------------------------ realtime
const bound = new WeakSet();
let rebind = null;
function bindChannel() {
  const ch = getSub('chan');
  if (!ch) return false;
  if (bound.has(ch)) return true;
  bound.add(ch);
  ch.on('broadcast', { event: 'guide_update' }, ({ payload }) => {
    if (payload?.channel_id) cache.delete(payload.channel_id);
  });
  return true;
}
function scheduleBind() {
  clearInterval(rebind);
  let tries = 0;
  rebind = setInterval(() => { if (bindChannel() || ++tries > 20) clearInterval(rebind); }, 400);
}

// ------------------------------------------------------------------ styles
function style() {
  if (document.getElementById(CLS + '-css')) return;
  const s = el('style');
  s.id = CLS + '-css';
  s.textContent = `
.${CLS}-card{margin:var(--s-5) auto;padding:var(--s-5) var(--s-6);max-width:var(--reading-max,720px);
  border:1px solid var(--c-border);border-radius:var(--r-lg);background:var(--c-surface-2)}
.${CLS}-card.${CLS}-first{border-color:var(--c-accent);box-shadow:var(--e-2)}
.${CLS}-head{display:flex;align-items:center;gap:var(--s-4);flex-wrap:wrap}
/* Tint for the signal, --c-text for the label: --c-accent on --c-accent-quiet
   fails AA at 10.5px in two of the three themes. */
.${CLS}-tag{font-size:var(--t-2xs);font-weight:var(--t-black);letter-spacing:.5px;
  padding:var(--s-1) var(--s-3);border-radius:var(--r-xs);
  background:var(--c-accent-quiet);color:var(--c-text)}
.${CLS}-name{font-weight:var(--t-bold);color:var(--c-text)}
.${CLS}-purpose{margin-top:var(--s-4);font-size:var(--t-md);color:var(--c-text);line-height:var(--t-snug)}
.${CLS}-body{margin-top:var(--s-4);color:var(--c-text-2);font-size:var(--t-base);line-height:var(--t-body)}
.${CLS}-body ul,.${CLS}-body ol{padding-left:var(--s-7);margin:var(--s-3) 0}
.${CLS}-empty{margin-top:var(--s-4);color:var(--c-text-2);font-size:var(--t-sm)}
.${CLS}-sec{margin-top:var(--s-5);font-size:var(--t-2xs);font-weight:var(--t-black);
  letter-spacing:.5px;color:var(--c-text-2);text-transform:uppercase}
.${CLS}-owed{color:var(--c-text)}
.${CLS}-pins{display:flex;flex-direction:column;gap:var(--s-2);margin-top:var(--s-3)}
.${CLS}-pin{display:flex;align-items:center;gap:var(--s-3);width:100%;min-height:44px;
  text-align:left;padding:var(--s-3) var(--s-4);border:1px solid var(--c-border-subtle);
  border-radius:var(--r-md);background:var(--c-surface);color:var(--c-text-2);font-size:var(--t-sm)}
.${CLS}-pin:hover{border-color:var(--c-accent);color:var(--c-text)}
.${CLS}-pin svg{width:15px;height:15px;flex:none;color:var(--c-text-3)}
.${CLS}-pin span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.${CLS}-ask svg{color:var(--c-warn)}
.${CLS}-foot{margin-top:var(--s-5);flex-wrap:wrap;gap:var(--s-3);align-items:center}
.${CLS}-foot button{min-height:40px}
.${CLS}-got{padding:var(--s-3) var(--s-6);border:0;border-radius:var(--r-md);
  font-weight:var(--t-semibold);background:var(--c-accent);color:var(--c-text-inverse)}
.${CLS}-meta{margin-top:var(--s-4);font-size:var(--t-xs);padding:0 var(--s-2)}
/* inside the welcome dialog the modal already supplies the frame */
.${CLS}-inmodal{margin:0;border:0;padding:0;background:none;max-width:none}
.${CLS}-inmodal .${CLS}-purpose{margin-top:0}

/* THE FIRST-VISIT BANNER had no styles at all - showWelcome() built .ori-banner
   and .ori-bannerhead and nothing in this file or in css/ ever matched them. On a
   phone that meant the title sat flush against the screen edge with a stray x
   floating beside it, on the one screen a new volunteer sees first. It is a band
   across the top of the conversation, so it gets a band's frame: its own surface,
   a rule underneath, and the same horizontal padding as the card it wraps. */
.${CLS}-banner{flex:none;padding:var(--s-4) var(--s-5) var(--s-5);
  background:var(--c-surface-2);border-bottom:1px solid var(--c-border);
  max-height:52vh;overflow-y:auto}
.${CLS}-bannerhead{display:flex;align-items:center;gap:var(--s-4);
  font-size:var(--t-md);color:var(--c-text)}
.${CLS}-bannerhead button{margin-left:auto;flex:none;
  min-width:40px;min-height:40px;border-radius:var(--r-md)}
.${CLS}-bannerhead svg{width:16px;height:16px}
/* no box inside a box: the banner is already the frame */
.${CLS}-banner .${CLS}-card{margin:var(--s-3) 0 0;padding:0;border:0;
  background:none;box-shadow:none;max-width:none}
.${CLS}-banner>button{margin-top:var(--s-4);min-height:40px}`;
  document.head.appendChild(s);
}

// ------------------------------------------------------------------ register
export function register({ ui }) {
  uiRef = ui;
  style();

  bus.on('channel:open', ({ channel }) => { scheduleBind(); onChannelOpen(channel); });
  bus.on('channel:subscribed', scheduleBind);
  scheduleBind();

  ui.registerPanel({
    id: PANEL,
    title: (ctx) => 'About #' + (store.channels.find((c) => c.id === ctx?.channelId)?.name
      || store.current?.name || 'channel'),
    render: renderPanel,
  });

  ui.addHeaderButton({
    id: 'guide', label: icon('hash'), title: 'About this channel', order: 30,
    show: () => !!store.current,
    onClick: () => ui.openPanel(PANEL, { channelId: store.current?.id }),
  });

  ui.addSlashCommand({
    name: 'starthere',
    description: 'Show or edit what this channel is for',
    run: () => ui.openPanel(PANEL, { channelId: store.current?.id }),
  });
}
