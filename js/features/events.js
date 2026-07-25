// Events: a workspace calendar that also lives inside the conversation.
//
// create_event posts an announcement message whose jsonb body is
// {kind:'event_announcement', event_id, title} when a channel is picked, so the
// same card that fills the panel also decorates that message row. RSVP counts
// come from list_events/get_event, which already fold in my own status.
import { api, tryRpc } from '../api.js';
import { store, bus, nameOf, hasPerm } from '../store.js';
import { PERM } from '../config.js';
import { el, esc, timeOf, dayOf, toLocalInput, fromLocalInput } from '../util.js';
import { getSub } from '../sb.js';
import { icon } from '../icons.js';

const STATUSES = [
  { key: 'going', label: 'Going' },
  { key: 'maybe', label: 'Maybe' },
  { key: 'no', label: 'Not going' },
];

// eventId -> the last row list_events/get_event returned. Cards repaint from
// here so an optimistic RSVP can be rolled back on failure.
const cache = new Map();

let toastFn = null;
const toastErr = (e) => toastFn?.(e?.message || 'that did not work', 'error');

// ------------------------------------------------------------------ helpers
const canCancel = (ev) => ev.created_by === store.me || hasPerm(PERM.MANAGE_WORKSPACE);

function whenText(ev) {
  const start = timeOf(ev.starts_at);
  if (!ev.ends_at) return start;
  const sameDay = new Date(ev.starts_at).toDateString() === new Date(ev.ends_at).toDateString();
  return sameDay ? `${start} - ${timeOf(ev.ends_at)}`
    : `${start} - ${dayOf(ev.ends_at)} ${timeOf(ev.ends_at)}`;
}

async function loadEvent(id, force = false) {
  if (!force && cache.has(id)) return cache.get(id);
  const rows = await api.getEvent(id);          // RETURNS TABLE, so this is an array
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row) throw new Error('that event is gone');
  cache.set(id, row);
  return row;
}

// ------------------------------------------------------------------ card
function paintCard(host, ev) {
  host.className = 'ev-card' + (ev.canceled ? ' ev-canceled' : '');
  host.dataset.event = ev.id;

  const ch = store.channels.find((c) => c.id === ev.channel_id);
  host.innerHTML = `
    <div class="ev-head">
      <div class="ev-when">
        <div class="ev-day">${esc(dayOf(ev.starts_at))}</div>
        <div class="ev-time">${esc(whenText(ev))}</div>
      </div>
      <div class="ev-main">
        <div class="ev-title">${esc(ev.title)}</div>
        ${ev.location ? `<div class="muted ev-loc">📍 ${esc(ev.location)}</div>` : ''}
        ${ch ? `<div class="muted ev-loc">#${esc(ch.name)}</div>` : ''}
      </div>
      ${ev.canceled ? '<span class="ev-tag">CANCELLED</span>' : ''}
    </div>
    ${ev.description ? `<div class="ev-desc">${esc(ev.description)}</div>` : ''}
    <div class="ev-counts muted"></div>
    <div class="ev-rsvp row gap"></div>`;

  host.querySelector('.ev-counts').textContent =
    `${ev.going_count || 0} going · ${ev.maybe_count || 0} maybe · ${ev.no_count || 0} not going` +
    ` · by ${nameOf(ev.created_by)}`;

  const bar = host.querySelector('.ev-rsvp');
  if (ev.canceled) {
    bar.appendChild(el('span', 'muted', 'This event was cancelled - RSVPs are closed.'));
    return;
  }
  for (const s of STATUSES) {
    const b = el('button', 'sm ghost' + (ev.my_rsvp === s.key ? ' on' : ''), esc(s.label));
    b.onclick = (e) => { e.stopPropagation(); setRsvp(ev.id, s.key); };
    bar.appendChild(b);
  }
  if (canCancel(ev)) {
    const c = el('button', 'sm ghost ev-cancel', 'Cancel event');
    c.onclick = async (e) => {
      e.stopPropagation();
      c.disabled = true;
      try { await api.cancelEvent(ev.id); await repaint(ev.id, true); refreshPanelIfOpen(); }
      catch (err) { c.disabled = false; toastErr(err); }
    };
    bar.appendChild(c);
  }
}

async function repaint(eventId, force = false) {
  const nodes = document.querySelectorAll(`.ev-card[data-event="${CSS.escape(eventId)}"]`);
  if (!nodes.length) { if (force) cache.delete(eventId); return; }
  try {
    const ev = await loadEvent(eventId, force);
    for (const n of nodes) paintCard(n, ev);
  } catch (e) {
    for (const n of nodes) n.innerHTML = `<div class="ev-err">${esc(e.message)}</div>`;
  }
}

function paintAll(ev) {
  cache.set(ev.id, ev);
  for (const n of document.querySelectorAll(`.ev-card[data-event="${CSS.escape(ev.id)}"]`)) {
    paintCard(n, ev);
  }
}

// Optimistic: move my count across immediately, reconcile from get_event after.
async function setRsvp(eventId, status) {
  const ev = cache.get(eventId);
  if (!ev || ev.canceled) return;
  const field = { going: 'going_count', maybe: 'maybe_count', no: 'no_count' };

  const before = { ...ev };
  const next = { ...ev };
  if (next.my_rsvp === status) return;
  if (next.my_rsvp && field[next.my_rsvp]) {
    next[field[next.my_rsvp]] = Math.max(0, (next[field[next.my_rsvp]] || 0) - 1);
  }
  next[field[status]] = (next[field[status]] || 0) + 1;
  next.my_rsvp = status;
  paintAll(next);

  try {
    await api.rsvp(eventId, status);
  } catch (e) {
    paintAll(before);
    toastErr(e);
    return;
  }
  await repaint(eventId, true);
}

// ------------------------------------------------------------------ mounting
function mount(msg, row) {
  const id = msg?.body?.event_id;
  if (!id || msg?.body?.kind !== 'event_announcement') return;
  if (row.dataset.eventMounted === id) return;
  row.dataset.eventMounted = id;

  const bodyEl = row.querySelector('.body');
  if (!bodyEl) return;
  const card = el('div', 'ev-card');
  card.dataset.event = id;
  card.innerHTML = '<div class="muted">loading event…</div>';
  bodyEl.innerHTML = '';
  bodyEl.appendChild(card);

  loadEvent(id)
    .then((ev) => paintCard(card, ev))
    .catch((e) => { card.innerHTML = `<div class="ev-err">${esc(e.message)}</div>`; });
}

// ------------------------------------------------------------------ compose
// create_event only requires private.is_member, so every member gets the button.
async function eventDialog(ui, prefill = {}) {
  if (!store.ws) { ui.toast('Open a Space first', 'error'); return; }
  const soon = new Date(Date.now() + 3600000);
  soon.setMinutes(0, 0, 0);

  const channelOptions = [{ value: '', label: 'Do not announce in a channel' }];
  for (const c of store.channels.filter((c) => c.kind !== 'voice')) {
    channelOptions.push({ value: c.id, label: '#' + c.name });
  }

  const out = await ui.formModal({
    title: 'New event',
    submitLabel: 'Create event',
    note: 'Times are in your local timezone. Everyone in the Space can RSVP.',
    fields: [
      { name: 'title', label: 'Title', required: true, value: prefill.title || '',
        placeholder: 'Sprint demo' },
      { name: 'desc', label: 'Description (optional)', type: 'textarea', rows: 3 },
      { name: 'starts', label: 'Starts', type: 'datetime-local', required: true,
        value: toLocalInput(soon) },
      { name: 'ends', label: 'Ends (optional)', type: 'datetime-local',
        value: toLocalInput(soon.getTime() + 3600000) },
      { name: 'location', label: 'Location (optional)', placeholder: 'Meeting room 2, or a link' },
      { name: 'channel', label: 'Announce in', type: 'select', options: channelOptions,
        value: prefill.channel || store.current?.id || '' },
    ],
  });
  if (!out) return;

  const startsAt = fromLocalInput(out.starts);
  const endsAt = out.ends ? fromLocalInput(out.ends) : null;
  if (!startsAt) { ui.toast('A start time is required', 'error'); return; }
  if (endsAt && new Date(endsAt) < new Date(startsAt)) {
    ui.toast('The end time cannot be before the start time', 'error');
    return;
  }

  try {
    await api.createEvent({
      workspace: store.ws.id,
      title: out.title.trim(),
      desc: out.desc?.trim() || null,
      startsAt,
      endsAt,
      location: out.location?.trim() || null,
      channel: out.channel || null,
    });
    ui.toast('Event created', 'success');
    refreshPanelIfOpen();
  } catch (e) {
    ui.toast(e.message, 'error');
  }
}

// ------------------------------------------------------------------ panel
let showPast = false;
let uiRef = null;
const refreshPanelIfOpen = () => { if (uiRef?.currentPanel() === 'events') uiRef.refreshPanel(); };

async function renderPanel(body) {
  body.innerHTML = '<div class="muted pad">loading…</div>';
  if (!store.ws) { body.innerHTML = '<div class="empty">Open a Space first.</div>'; return; }

  const [rows, err] = await tryRpc('list_events', {
    p_workspace: store.ws.id, p_upcoming_only: !showPast,
  });
  if (err) { body.innerHTML = `<div class="empty">${esc(err.message)}</div>`; return; }

  body.innerHTML = '';
  const toggle = el('div', 'row gap ev-toggle');
  for (const t of [{ k: false, l: 'Upcoming' }, { k: true, l: 'Everything' }]) {
    const b = el('button', 'sm ghost' + (showPast === t.k ? ' on' : ''), t.l);
    b.onclick = () => { showPast = t.k; uiRef.refreshPanel(); };
    toggle.appendChild(b);
  }
  body.appendChild(toggle);

  if (!rows?.length) {
    body.appendChild(el('div', 'empty', showPast
      ? 'No events in this Space yet. Create one and it will show up here with its RSVPs.'
      : 'Nothing coming up. Create an event, or switch to Everything to see past ones.'));
    return;
  }

  for (const ev of rows) cache.set(ev.id, ev);
  let lastDay = null;
  for (const ev of rows) {
    const day = dayOf(ev.starts_at);
    if (day !== lastDay) { body.appendChild(el('h4', 'sec', esc(day))); lastDay = day; }
    const card = el('div');
    paintCard(card, ev);
    card.classList.add('ev-in-panel');
    body.appendChild(card);
  }
}

// ------------------------------------------------------------------ realtime
// Core rebuilds the 'ws' subscription on every workspace switch, so bind onto
// whatever object is current and re-bind when it is replaced. Bounded retries,
// because the workspace event fires before subscribe() runs.
const bound = new WeakSet();
let rebind = null;
function bindWorkspace() {
  const ch = getSub('ws');
  if (!ch) return false;
  if (bound.has(ch)) return true;
  bound.add(ch);
  ch.on('broadcast', { event: 'event_rsvp' }, ({ payload }) => {
    if (payload?.event_id && payload.user_id !== store.me) repaint(payload.event_id, true);
  });
  ch.on('broadcast', { event: 'event_canceled' }, ({ payload }) => {
    if (payload?.event_id) repaint(payload.event_id, true);
    refreshPanelIfOpen();
  });
  ch.on('broadcast', { event: 'event_created' }, () => refreshPanelIfOpen());
  return true;
}
function scheduleBind() {
  clearInterval(rebind);
  let tries = 0;
  rebind = setInterval(() => {
    if (bindWorkspace() || ++tries > 20) clearInterval(rebind);
  }, 400);
}

// ------------------------------------------------------------------ styles
function injectStyles() {
  if (document.getElementById('ev-styles')) return;
  const s = el('style');
  s.id = 'ev-styles';
  s.textContent = `
.ev-card{border:1px solid var(--line);border-radius:12px;padding:10px 12px;margin:2px 0;
  background:var(--panel2);max-width:520px}
.ev-in-panel{max-width:none;margin-bottom:8px}
.ev-head{display:flex;align-items:flex-start;gap:10px}
.ev-when{flex:none;min-width:74px}
.ev-day{font-size:11px;font-weight:800;letter-spacing:.4px;text-transform:uppercase;color:var(--accent)}
.ev-time{font-size:12.5px;color:var(--dim);font-variant-numeric:tabular-nums}
.ev-main{flex:1;min-width:0}
.ev-title{font-weight:700;word-break:break-word}
.ev-loc{font-size:12.5px;word-break:break-word}
.ev-tag{flex:none;font-size:9.5px;font-weight:800;letter-spacing:.5px;padding:2px 6px;
  border-radius:4px;background:#31191a;color:#ff9a8f}
.ev-canceled .ev-title{text-decoration:line-through}
.ev-canceled{opacity:.75}
.ev-desc{margin:7px 0 0;font-size:13.5px;white-space:pre-wrap;word-break:break-word;color:var(--dim)}
.ev-counts{font-size:12px;margin:7px 0 6px}
.ev-rsvp{flex-wrap:wrap}
.ev-cancel{margin-left:auto;color:#ff9a8f}
.ev-toggle{margin-bottom:8px}
.ev-err{color:#ff9a8f;font-size:12.5px}`;
  document.head.appendChild(s);
}

// ------------------------------------------------------------------ register
export function register({ ui }) {
  uiRef = ui;
  toastFn = ui.toast;
  injectStyles();

  bus.on('message:render', ({ msg, el: row }) => mount(msg, row));

  bus.on('workspace', scheduleBind);
  // core replaces the 'ws' channel object on every recovered drop too
  bus.on('realtime:subscribed', ({ key }) => { if (key === 'ws') scheduleBind(); });
  scheduleBind();

  ui.registerPanel({
    id: 'events',
    title: 'Events',
    render: renderPanel,
    footer(foot) {
      const b = el('button', 'wide', 'Create event');
      b.onclick = () => eventDialog(ui);
      foot.appendChild(b);
    },
  });

  ui.addHeaderButton({
    id: 'events', label: icon('calendar'), title: 'Events', order: 80,
    onClick: () => ui.openPanel('events'),
  });

  ui.addSlashCommand({
    name: 'event',
    description: 'Schedule an event - /event Sprint demo',
    run: (argText) => eventDialog(ui, { title: (argText || '').trim() }),
  });
}
