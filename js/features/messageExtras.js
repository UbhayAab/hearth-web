// The small finishing touches on a message list: acknowledgements on urgent
// messages, "seen by" on my last message, scheduled sends, three extra hover
// actions, link cards and the unread divider.
//
// Nothing here owns a message. Every piece decorates a row core already built
// (bus 'message:render') or hangs off a registry, so this module can be deleted
// and the list still renders exactly as before.
import { table, tryRpc } from '../api.js';
import { store, bus, nameOf, hasPerm } from '../store.js';
import { PERM } from '../config.js';
import { el, esc, plain, relTime, toLocalInput, fromLocalInput, debounce } from '../util.js';
import { icon } from '../icons.js';

// Set in register(); everything below is module scope so the helpers stay flat.
let ui = null;
let api = null;

const PIN_TITLE = 'Pin to channel';
const UNPIN_TITLE = 'Unpin from channel';

export function register(app) {
  ({ ui, api } = app);
  injectStyle();
  registerAcks();
  registerReceipts();
  registerScheduled();
  registerHoverActions();
  registerLinkCards();
  registerUnreadDivider();
}

// ------------------------------------------------------------------ styling
// Appended from here rather than styles.css: that file is shared, this is not.
const STYLE = `
.mx-ack{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin:6px 0 2px;padding:6px 10px;
  border:1px solid var(--line);border-left:3px solid var(--amber);border-radius:8px;
  background:var(--panel2);font-size:12.5px}
.mx-ack button{padding:4px 10px;font-size:12px;border-radius:7px}
.mx-ack-count{color:var(--dim);cursor:pointer;border-bottom:1px dotted var(--faint)}
.mx-ack-count:hover{color:var(--text)}
.mx-done{color:var(--green);font-weight:600}
.mx-list{min-width:190px;max-height:260px;overflow:auto}
.mx-list-row{display:flex;justify-content:space-between;gap:14px;padding:5px 8px;font-size:13px}
.mx-list-row span{color:var(--dim);font-size:11.5px}
.mx-seen{font-size:11px;color:var(--faint);margin-top:3px;cursor:default}
.mx-link{display:flex;align-items:center;gap:10px;margin:6px 0 2px;padding:8px 11px;
  border:1px solid var(--line);border-radius:10px;background:var(--panel2);text-decoration:none;
  color:var(--text);max-width:min(430px,80vw)}
.mx-link:hover{border-color:var(--accent);background:var(--panel3)}
.mx-fav{width:22px;height:22px;flex:none;border-radius:6px;background:var(--panel3) center/17px no-repeat}
.mx-link-txt{min-width:0;display:flex;flex-direction:column}
.mx-link-host{font-weight:600;font-size:13px}
.mx-link-url{color:var(--dim);font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mx-link-out{margin-left:auto;color:var(--faint);flex:none}
.mx-pinned{box-shadow:inset 2px 0 0 var(--amber)}
.mx-newdiv{display:flex;align-items:center;gap:10px;margin:14px 4px}
.mx-newdiv-line{flex:1;height:1px;background:var(--red);opacity:.5}
.mx-newdiv-label{flex:none;color:var(--red);font-size:10.5px;font-weight:800;letter-spacing:.9px;
  text-transform:uppercase}
.mx-newdiv button{flex:none;padding:3px 9px;font-size:11.5px}
.mx-sched-when{color:var(--amber)}
`;

function injectStyle() {
  if (document.getElementById('mx-style')) return;
  const s = document.createElement('style');
  s.id = 'mx-style';
  s.textContent = STYLE;
  document.head.appendChild(s);
}

// ------------------------------------------------------------------ 1. acks
// The schema has no "ack required" flag - `messages.priority` is the only signal,
// so urgent is what asks for an acknowledgement.
const ackRows = new Map();       // message_id -> [{user_id, acked_at}]
let ackQueue = new Set();
let ackFlush = null;

function registerAcks() {
  bus.on('message:render', ({ msg, el: row }) => {
    if (!msg?.id || msg.priority !== 'urgent') return;
    const host = row.querySelector('.mbody');
    if (!host || host.querySelector('.mx-ack')) return;
    const bar = el('div', 'mx-ack', '<span class="muted">checking acknowledgements…</span>');
    bar.dataset.ack = msg.id;
    host.insertBefore(bar, host.querySelector('.rxns'));
    if (ackRows.has(msg.id)) paintAck(msg.id);
    else queueAck(msg.id);
  });
}

// One read for the whole page of urgent messages. A round trip per row would be
// silly for a decoration, and RLS on message_acks already scopes it to channels
// I can see.
function queueAck(id) {
  ackQueue.add(id);
  if (ackFlush) return;
  ackFlush = setTimeout(async () => {
    const ids = [...ackQueue];
    ackQueue = new Set();
    ackFlush = null;
    const rows = await table('message_acks', (q) => q.in('message_id', ids));
    for (const id2 of ids) ackRows.set(id2, []);
    for (const r of rows) ackRows.get(r.message_id)?.push(r);
    for (const id2 of ids) paintAck(id2);
  }, 30);
}

function paintAck(id) {
  const rows = ackRows.get(id) || [];
  const acked = rows.some((r) => r.user_id === store.me);
  for (const bar of document.querySelectorAll(`.mx-ack[data-ack="${CSS.escape(id)}"]`)) {
    bar.innerHTML = acked
      ? '<span class="mx-done">✓ You acknowledged</span>'
      : '<button class="sm">Acknowledge</button>';
    const count = el('span', 'mx-ack-count',
      rows.length ? `${rows.length} acknowledged` : 'nobody has acknowledged yet');
    count.title = 'See who';
    count.onclick = (ev) => showAckList(id, ev.currentTarget);
    bar.appendChild(count);
    bar.querySelector('button')?.addEventListener('click', () => doAck(id));
  }
}

async function doAck(id) {
  try {
    await api.ack(id);
    const rows = ackRows.get(id) || [];
    if (!rows.some((r) => r.user_id === store.me)) {
      rows.push({ message_id: id, user_id: store.me, acked_at: new Date().toISOString() });
    }
    ackRows.set(id, rows);
    paintAck(id);
  } catch (e) {
    ui.toast(e.message || 'Could not acknowledge', 'error');
  }
}

async function showAckList(id, anchor) {
  const box = el('div', 'mx-list', '<div class="muted pad">loading…</div>');
  ui.popover(anchor, box, { below: true });
  const [rows, err] = await tryRpc('get_acks', { p_message: id });
  if (err) { box.innerHTML = `<div class="empty">${esc(err.message)}</div>`; return; }
  ackRows.set(id, rows || []);
  if (!rows?.length) {
    box.innerHTML = '<div class="empty">Nobody yet. Anyone who can read this channel can acknowledge it.</div>';
    return;
  }
  box.innerHTML = rows.map((r) =>
    `<div class="mx-list-row"><b>${esc(nameOf(r.user_id))}</b><span>${esc(relTime(r.acked_at))}</span></div>`).join('');
}

// ------------------------------------------------------------------ 2. seen by
// Only on my newest message in the open channel. A receipt under every row is
// noise, and it is the last one you actually wonder about.
let seenTimer = null;
let seenChannel = null;

function registerReceipts() {
  bus.on('channel:open', ({ channel }) => startSeen(channel));
  bus.on('dm:open', stopSeen);
  bus.on('message:new', debounce(() => { if (seenChannel) paintSeen(); }, 1500));
}

function startSeen(channel) {
  stopSeen();
  if (!channel) return;
  seenChannel = channel.id;
  // Polled, not subscribed: read cursors move constantly and are not worth a
  // broadcast each. One row every ten seconds is cheap and always fresh enough.
  paintSeen();
  seenTimer = setInterval(paintSeen, 10000);
}

function stopSeen() {
  clearInterval(seenTimer);
  seenTimer = null;
  seenChannel = null;
  document.querySelectorAll('.mx-seen').forEach((n) => n.remove());
}

async function paintSeen() {
  if (!seenChannel) return;
  if (store.current?.id !== seenChannel) { stopSeen(); return; }
  const list = document.getElementById('messages');
  if (!list) return;

  const mineRows = [...list.querySelectorAll('.msg[data-author]')]
    .filter((r) => r.dataset.author === store.me && r.dataset.seq);
  const last = mineRows[mineRows.length - 1];
  for (const n of list.querySelectorAll('.mx-seen')) if (!last || !last.contains(n)) n.remove();
  if (!last) return;

  const seq = Number(last.dataset.seq);
  if (!Number.isFinite(seq) || !seq) return;
  const [rows, err] = await tryRpc('get_read_receipts', { p_channel: seenChannel });
  if (err || !rows) return;                       // a decoration is never worth a toast
  if (store.current?.id !== seenChannel) return;  // channel changed mid-flight

  const readers = rows.filter((r) => r.user_id !== store.me && Number(r.last_read_seq || 0) >= seq);
  let tag = last.querySelector('.mx-seen');
  if (!readers.length) { tag?.remove(); return; }
  if (!tag) {
    tag = el('div', 'mx-seen');
    last.querySelector('.mbody')?.appendChild(tag);
  }
  tag.textContent = `Seen by ${readers.length}`;
  tag.title = readers.map((r) => nameOf(r.user_id)).join(', ');
}

// ------------------------------------------------------------------ 3. scheduled
let scheduledCount = 0;

function registerScheduled() {
  ui.registerPanel({ id: 'scheduled', title: 'Scheduled', render: renderScheduled });

  // Hidden until there is something to see: an always-on clock in the header
  // that opens an empty list is just clutter.
  ui.addHeaderButton({
    id: 'scheduled', label: icon('clock'), title: 'Scheduled messages', order: 35,
    onClick: () => ui.openPanel('scheduled'),
    show: () => scheduledCount > 0,
  });

  ui.addComposerButton({
    id: 'mx-send-later', label: icon('clock'), title: 'Send later',
    onClick: sendLaterDialog, show: () => !!store.current,
  });
  // The tool row is painted once during initComposer(), which runs before
  // features register, so ask for a repaint now and whenever the channel (and
  // therefore show()) changes.
  ui.renderComposerButtons();

  ui.addSlashCommand({
    name: 'schedule', description: 'Write a message now and post it later',
    run: (argText) => sendLaterDialog(argText),
  });

  bus.on('workspace', () => refreshScheduledCount());
  bus.on('channel:open', () => ui.renderComposerButtons());
  refreshScheduledCount();
}

async function refreshScheduledCount() {
  if (!store.ws) return;
  const [rows] = await tryRpc('list_scheduled', { p_workspace: store.ws.id });
  const n = rows?.length || 0;
  if (n === scheduledCount) return;
  scheduledCount = n;
  ui.renderHeaderButtons();
}

function untilLabel(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'sending now';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `in ${mins} min`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `in ${hrs}h`;
  return `in ${Math.round(hrs / 24)}d`;
}

const stampLabel = (iso) => new Date(iso).toLocaleString([], {
  weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
});

// Also the composer button handler, which is handed a click event: only take a
// prefill when it really is text.
async function sendLaterDialog(prefill) {
  const ch = store.current;
  if (!ch) { ui.toast('Open a channel first', 'error'); return; }
  const composer = document.getElementById('composer');
  const text = (typeof prefill === 'string' && prefill.trim()) || composer?.value || '';

  const out = await ui.formModal({
    title: 'Send later to #' + ch.name,
    fields: [
      { name: 'text', label: 'Message', type: 'textarea', rows: 4, value: text, required: true },
      { name: 'when', label: 'Deliver at', type: 'datetime-local', required: true,
        value: toLocalInput(Date.now() + 3600000) },
    ],
    submitLabel: 'Schedule it',
    note: 'Hearth posts it from your account at that time, whether or not you are online.',
  });
  if (!out) return;

  const iso = fromLocalInput(out.when);
  if (!iso || new Date(iso).getTime() <= Date.now()) {
    ui.toast('Pick a time in the future', 'error');
    return;
  }
  try {
    await api.schedule(ch.id, out.text, iso, mentionIdsIn(out.text));
    if (composer && composer.value.trim() === out.text.trim()) {
      composer.value = '';
      composer.dispatchEvent(new Event('input'));
    }
    ui.toast('Scheduled ' + untilLabel(iso), 'success');
    refreshScheduledCount();
    if (ui.currentPanel() === 'scheduled') ui.refreshPanel();
  } catch (e) {
    ui.toast(e.message || 'Could not schedule that', 'error');
  }
}

// Resolve @handles against the profiles already in memory. The composer's own
// resolver is core's business and a scheduled message only ever needs the ids
// its author could already see.
function mentionIdsIn(text) {
  const out = new Set();
  for (const m of (text || '').matchAll(/(?:^|\s)@([\w.-]+)/g)) {
    const h = m[1].toLowerCase();
    for (const p of store.profiles.values()) {
      if ((p.username || '').toLowerCase() === h || (p.display_name || '').toLowerCase() === h) out.add(p.id);
    }
  }
  return [...out];
}

async function renderScheduled(body) {
  body.innerHTML = '<div class="muted pad">loading…</div>';
  if (!store.ws) {
    body.innerHTML = '<div class="empty">Open a Space to see what you have queued up.</div>';
    return;
  }
  const [rows, err] = await tryRpc('list_scheduled', { p_workspace: store.ws.id });
  if (err) { body.innerHTML = `<div class="empty">${esc(err.message)}</div>`; return; }

  scheduledCount = rows?.length || 0;
  ui.renderHeaderButtons();

  if (!scheduledCount) {
    body.innerHTML = '<div class="empty">Nothing scheduled. Type a message, then press the 🕐 button '
      + 'beside the composer and pick a time - Hearth will post it for you then.</div>';
    return;
  }

  body.innerHTML = '';
  for (const r of rows) {
    const card = el('div', 'result');
    card.innerHTML = `<div class="muted">#${esc(r.channel_name || 'channel')} ·
      <span class="mx-sched-when">${esc(stampLabel(r.deliver_at))}</span> · ${esc(untilLabel(r.deliver_at))}</div>
      <div class="body">${esc(plain(r.body_text, 220))}</div>`;
    const cancel = el('button', 'sm ghost', 'Cancel');
    cancel.onclick = async () => {
      cancel.disabled = true;
      try {
        await api.cancelScheduled(r.id);
        card.remove();
        scheduledCount = Math.max(scheduledCount - 1, 0);
        ui.renderHeaderButtons();
        if (!scheduledCount) ui.refreshPanel();
        ui.toast('Cancelled', 'success');
      } catch (e) {
        cancel.disabled = false;
        ui.toast(e.message || 'Could not cancel that', 'error');
      }
    };
    card.appendChild(cancel);
    body.appendChild(card);
  }
}

// ------------------------------------------------------------------ 4. hover extras
const pinnedByChannel = new Map();   // channel_id -> Set(message_id)

const canPin = (m) => hasPerm(PERM.MANAGE_MESSAGES) || m.author_id === store.me;

function isPinned(id) {
  const set = store.current ? pinnedByChannel.get(store.current.id) : null;
  return !!set && set.has(id);
}

function registerHoverActions() {
  ui.addMessageAction({
    id: 'mx-copy', label: icon('doc'), title: 'Copy text', order: 200,
    show: (m) => !!m.body_text,
    onClick: (m) => copyText(m),
  });
  ui.addMessageAction({
    id: 'mx-unread', label: icon('bell'), title: 'Mark unread from here', order: 210,
    contexts: ['channel'], show: (m) => !!m.seq,
    onClick: (m) => markUnreadFrom(m),
  });
  // Two registrations rather than one toggle: `show(msg)` is per message, so this
  // is the only way the hover bar can say what clicking will actually do.
  ui.addMessageAction({
    id: 'mx-pin', label: icon('pin'), title: PIN_TITLE, order: 220,
    contexts: ['channel'], show: (m) => canPin(m) && !isPinned(m.id),
    onClick: (m) => togglePin(m),
  });
  ui.addMessageAction({
    id: 'mx-unpin', label: icon('pin'), title: UNPIN_TITLE, order: 220,
    contexts: ['channel'], show: (m) => canPin(m) && isPinned(m.id),
    onClick: (m) => togglePin(m),
  });

  // Tag whichever of the two got rendered so a late-arriving pin list can still
  // correct it in place, and mark the row itself.
  bus.on('message:render', ({ msg, el: row, context }) => {
    if (context !== 'channel' || !msg?.id) return;
    for (const b of row.querySelectorAll('.actions button')) {
      if (b.title === PIN_TITLE || b.title === UNPIN_TITLE) b.dataset.mxPin = msg.id;
    }
    applyPinButton(row, msg.id);
  });

  bus.on('channel:open', ({ channel }) => { if (channel) loadPins(channel.id); });
}

// Kicked off the instant the channel opens, which is two round trips ahead of
// the first message render, so the button is usually right the first time.
async function loadPins(chId) {
  const rows = await table('pins', (q) => q.eq('channel_id', chId));
  pinnedByChannel.set(chId, new Set(rows.map((r) => r.message_id)));
  if (store.current?.id === chId) syncPinButtons();
}

function applyPinButton(row, id) {
  const b = row.querySelector('[data-mx-pin]');
  const on = isPinned(id);
  row.classList.toggle('mx-pinned', on);
  if (!b) return;
  b.textContent = on ? '📍' : '📌';
  b.title = on ? UNPIN_TITLE : PIN_TITLE;
  b.classList.toggle('on', on);
}

function syncPinButtons() {
  for (const row of document.querySelectorAll('#messages .msg[data-id]')) {
    if (row.dataset.id) applyPinButton(row, row.dataset.id);
  }
}

async function togglePin(m) {
  const ch = store.current;
  if (!ch) return;
  const set = pinnedByChannel.get(ch.id) || new Set();
  const on = set.has(m.id);
  try {
    if (on) { await api.unpin(m.id); set.delete(m.id); }
    else { await api.pin(m.id); set.add(m.id); }
    pinnedByChannel.set(ch.id, set);
    syncPinButtons();
    ui.toast(on ? 'Unpinned' : 'Pinned to #' + ch.name, 'success');
  } catch (e) {
    ui.toast(e.message || 'Could not change the pin', 'error');
  }
}

async function copyText(m) {
  if (!navigator.clipboard) { ui.toast('This browser will not give Hearth the clipboard', 'error'); return; }
  try {
    await navigator.clipboard.writeText(m.body_text || '');
    ui.toast('Message text copied', 'success');
  } catch {
    ui.toast('The clipboard is blocked here', 'error');
  }
}

async function markUnreadFrom(m) {
  if (!store.current) return;
  try {
    await api.markUnread('channel', store.current.id, m.seq);
    // Re-arm the divider so the line appears exactly where they just cut it,
    // instead of only on the next visit.
    dividerFor = store.current.id;
    dividerSeq = Math.max(Number(m.seq) - 1, 0);
    placeDivider();
    bus.emit('unread:reload');
    ui.toast('Marked unread from here', 'success');
  } catch (e) {
    ui.toast(e.message || 'Could not mark it unread', 'error');
  }
}

// ------------------------------------------------------------------ 5. link cards
const URL_RE = /https?:\/\/[^\s<>"'`]+/g;

// Only a message that IS a link, not one that merely contains one.
function loneUrl(text) {
  const t = (text || '').trim();
  if (!t || t.length > 400) return null;
  const found = t.match(URL_RE);
  if (!found || found.length !== 1) return null;
  if (t.replace(found[0], '').replace(/[\s.,!?:;"'()[\]<>-]/g, '').length) return null;
  let u;
  try { u = new URL(found[0].replace(/[.,)\]]+$/, '')); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.host === location.host) return null;    // an in-app permalink is not an external link
  return u;
}

function registerLinkCards() {
  bus.on('message:render', ({ msg, el: row }) => {
    const u = loneUrl(msg?.body_text);
    if (!u) return;
    const host = row.querySelector('.mbody');
    if (!host || host.querySelector('.mx-link')) return;

    const card = el('a', 'mx-link');
    card.href = u.href;
    card.target = '_blank';
    card.rel = 'noopener noreferrer';
    const path = (u.pathname === '/' ? '' : u.pathname) + u.search;
    card.innerHTML = `<span class="mx-fav"></span>
      <span class="mx-link-txt">
        <span class="mx-link-host">${esc(u.hostname.replace(/^www\./, ''))}</span>
        <span class="mx-link-url">${esc(path || u.href)}</span>
      </span>
      <span class="mx-link-out" title="Opens in a new tab">↗</span>`;

    // The remote page is deliberately never fetched: CORS would block it anyway,
    // and a client-side fetch would tell every linked site who is reading. The
    // favicon goes in as a background image so an unreachable icon service fails
    // silently instead of logging a broken <img>.
    card.querySelector('.mx-fav').style.backgroundImage =
      `url("https://www.google.com/s2/favicons?domain=${encodeURIComponent(u.hostname)}&sz=64")`;
    host.insertBefore(card, host.querySelector('.rxns'));
  });
}

// ------------------------------------------------------------------ 6. unread divider
let dividerFor = null;
let dividerSeq = null;

const schedulePlace = debounce(() => placeDivider(), 120);

function registerUnreadDivider() {
  bus.on('channel:open', ({ channel }) => armDivider(channel));
  bus.on('dm:open', () => { dividerFor = null; dividerSeq = null; placeDivider(); });
  bus.on('message:render', schedulePlace);
}

async function armDivider(channel) {
  dividerFor = channel?.id || null;
  dividerSeq = null;
  placeDivider();
  if (!channel) return;
  if (!store.unread.get(channel.id)?.unread) return;   // nothing waiting, no line to draw

  // Read my own cursor before core's mark_read moves it. 'channel:open' fires two
  // round trips ahead of that call, so this one lands first.
  const rows = await table('read_state', (q) =>
    q.eq('scope_type', 'channel').eq('scope_id', channel.id).eq('user_id', store.me));
  if (dividerFor !== channel.id) return;
  const seq = Number(rows[0]?.last_read_seq || 0);
  // Never opened before means everything is new, and a line above the whole
  // channel tells you nothing.
  if (!seq) return;
  dividerSeq = seq;
  placeDivider();
}

function placeDivider() {
  const list = document.getElementById('messages');
  if (!list) return;
  const existing = list.querySelector('.mx-newdiv');
  if (dividerSeq == null || store.current?.id !== dividerFor) { existing?.remove(); return; }

  const first = [...list.querySelectorAll('.msg[data-seq]')]
    .find((r) => Number(r.dataset.seq) > dividerSeq);
  if (!first) { existing?.remove(); return; }
  if (existing && existing.nextElementSibling === first) return;   // already in the right place
  existing?.remove();

  const div = el('div', 'mx-newdiv',
    '<span class="mx-newdiv-line"></span><span class="mx-newdiv-label">New messages</span>'
    + '<span class="mx-newdiv-line"></span>');
  const jump = el('button', 'sm ghost', 'Jump to newest ↓');
  jump.onclick = () => {
    list.scrollTop = list.scrollHeight;
    document.getElementById('newBelow')?.remove();
  };
  div.appendChild(jump);
  list.insertBefore(div, first);
}
