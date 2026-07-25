// Custom status, presence and notification pauses.
//
// The affordance people reach for is their own name in the top bar, so that is
// where this hangs. On narrow screens the shell hides .meName, which would leave
// no way in at all, hence the header button as a second door to the same sheet.
//
// Every preset carries its own expiry. A status that outlives the thing it
// describes is the single reason people stop trusting statuses, so "In a
// meeting" is always 1 hour, never forever.
import { table } from '../api.js';
import { store, bus } from '../store.js';
import { $, el, esc, plain } from '../util.js';
import { icon } from '../icons.js';

const MIN = 60000;
const HOUR = 3600000;

const PRESETS = [
  { emoji: '🗓️', text: 'In a meeting', ms: HOUR, label: '1 hour' },
  { emoji: '🚌', text: 'Commuting', ms: 30 * MIN, label: '30 minutes' },
  { emoji: '🤒', text: 'Out sick', endOfDay: true, label: 'today' },
  { emoji: '🎯', text: 'Focusing', ms: 2 * HOUR, label: '2 hours' },
];

const PRESENCE = [
  { value: 'online', label: '🟢 Active' },
  { value: 'away', label: '🌙 Away' },
  { value: 'dnd', label: '⛔ Do not disturb' },
];

const PAUSES = [
  { label: '30 minutes', ms: 30 * MIN },
  { label: '1 hour', ms: HOUR },
  { label: 'Until tomorrow', tomorrow: true },
];

const endOfToday = () => { const d = new Date(); d.setHours(23, 59, 59, 999); return d; };
const tomorrowMorning = () => {
  const d = new Date(Date.now() + 86400000);
  d.setHours(9, 0, 0, 0);
  return d;
};

// ------------------------------------------------------------------ local mirror
let myPresence = 'online';
let dndUntil = null;
let expiryTimer = null;
let headerDef = null;

function mergeMyProfile(row) {
  if (!row) return;
  store.myProfile = { ...(store.myProfile || {}), ...row, id: store.me };
  store.profiles.set(store.me, store.myProfile);
}

function paintChip() {
  const chip = $('hstatusChip');
  const p = store.myProfile || {};
  const emoji = p.status_emoji || '';
  const text = p.status_text || '';
  if (chip) {
    if (!emoji && !text) {
      chip.classList.add('hidden');
      chip.innerHTML = '';
      chip.removeAttribute('title');
    } else {
      chip.classList.remove('hidden');
      chip.innerHTML = `${esc(emoji)}${text ? `<span class="hstatus-chip-t">${esc(plain(text, 28))}</span>` : ''}`;
      chip.title = `${emoji} ${text}`.trim();
    }
  }
  // The header button doubles as the status indicator. A status emoji someone
  // chose is CONTENT and shows as-is; with no status set it falls back to the
  // drawn icon so the chrome stays one visual family.
  if (headerDef) {
    headerDef.label = emoji || icon('smile');
    const btn = document.getElementById('hb-status');
    if (btn) btn.innerHTML = headerDef.label;
  }
}

// The server clears expired statuses on its own schedule; this only keeps the
// top bar from showing a stale one until the next reload.
function scheduleExpiry() {
  clearTimeout(expiryTimer);
  const at = store.myProfile?.status_expires_at;
  if (!at) return;
  const ms = new Date(at).getTime() - Date.now();
  if (ms <= 0) {
    mergeMyProfile({ status_text: null, status_emoji: null, status_expires_at: null });
    paintChip();
    return;
  }
  if (ms < 2147483000) {
    expiryTimer = setTimeout(() => {
      mergeMyProfile({ status_text: null, status_emoji: null, status_expires_at: null });
      paintChip();
    }, ms + 500);
  }
}

// ------------------------------------------------------------------ decoration
const presenceStatus = new Map(); // user_id -> 'online'|'away'|'dnd'|'offline'
let presenceFetchedAt = 0;
let presenceInFlight = false;

function decorateMembers() {
  for (const row of document.querySelectorAll('.member')) {
    if (row.dataset.hstatus) continue;
    const uid = row.querySelector('[data-user]')?.dataset.user;
    if (!uid) continue;
    row.dataset.hstatus = '1';
    const p = store.profiles.get(uid);
    if (p?.status_text) row.title = String(p.status_text);
    const st = presenceStatus.get(uid);
    if (st !== 'dnd' && st !== 'away') continue;
    const badge = el('span', 'hstatus-badge', st === 'dnd' ? '⛔' : '🌙');
    badge.title = st === 'dnd' ? 'Do not disturb' : 'Away';
    row.querySelector('.m-name')?.appendChild(badge);
  }
}

// Core only tracks online/offline, so away and do-not-disturb need their own
// read. It is throttled and only runs while member rows are actually on screen.
async function refreshPresenceDetail() {
  if (presenceInFlight) return;
  if (!document.querySelector('.member')) return;
  if (Date.now() - presenceFetchedAt < 8000) return;
  presenceInFlight = true;
  presenceFetchedAt = Date.now();
  try {
    const ids = [...store.profiles.keys()];
    if (!ids.length) return;
    const rows = await table('user_presence', (q) => q.in('user_id', ids));
    presenceStatus.clear();
    for (const r of rows) presenceStatus.set(r.user_id, r.status);
    document.querySelectorAll('.hstatus-badge').forEach((n) => n.remove());
    document.querySelectorAll('.member[data-hstatus]').forEach((n) => { delete n.dataset.hstatus; });
    decorateMembers();
  } finally { presenceInFlight = false; }
}

// ------------------------------------------------------------------ popover
function seg(items, current, onPick) {
  const host = el('div', 'hstatus-seg');
  for (const it of items) {
    const b = el('button', 'sm ghost' + (it.value === current ? ' on' : ''), esc(it.label));
    b.onclick = () => onPick(it.value, b);
    host.appendChild(b);
  }
  return host;
}

function openStatusPopover(anchor, ui, api) {
  const p = store.myProfile || {};
  const box = el('div', 'hstatus-pop');
  box.innerHTML = `
    <div class="hstatus-inputs">
      <input class="hstatus-emoji" maxlength="8" placeholder="🙂" value="${esc(p.status_emoji || '')}" />
      <input class="hstatus-text" maxlength="100" placeholder="What is your status?" value="${esc(p.status_text || '')}" />
    </div>
    <div class="hstatus-presets"></div>
    <div class="row gap hstatus-actions">
      <button class="sm" data-a="save">Save</button>
      <button class="sm ghost" data-a="clear">Clear</button>
      <span class="muted hstatus-exp"></span>
    </div>
    <h4 class="sec">Availability</h4>
    <div data-slot="presence"></div>
    <h4 class="sec">Pause notifications</h4>
    <div data-slot="dnd"></div>
    <div class="muted hstatus-note"></div>`;

  const emojiIn = box.querySelector('.hstatus-emoji');
  const textIn = box.querySelector('.hstatus-text');
  const expLine = box.querySelector('.hstatus-exp');
  const note = box.querySelector('.hstatus-note');

  const pop = ui.popover(anchor, box, { below: true });

  const showExpiry = () => {
    const at = store.myProfile?.status_expires_at;
    expLine.textContent = at && new Date(at) > new Date()
      ? 'Clears at ' + new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : '';
  };
  showExpiry();

  const save = async (text, emoji, expiresAt) => {
    try {
      if (!text && !emoji) {
        const row = await api.clearStatus();
        mergeMyProfile(row || { status_text: null, status_emoji: null, status_expires_at: null });
        ui.toast('Status cleared');
      } else {
        const row = await api.setStatus(text || null, emoji || null, expiresAt || null);
        mergeMyProfile(row || { status_text: text, status_emoji: emoji, status_expires_at: expiresAt });
        ui.toast('Status set');
      }
      paintChip();
      scheduleExpiry();
      pop.close();
    } catch (e) { ui.toast(e.message || 'Could not save the status', 'error'); }
  };

  // ---- presets ----
  const presetHost = box.querySelector('.hstatus-presets');
  for (const pr of PRESETS) {
    const b = el('button', 'sm ghost hstatus-preset',
      `${esc(pr.emoji)} ${esc(pr.text)} <span class="muted">${esc(pr.label)}</span>`);
    b.title = `${pr.text} - clears after ${pr.label}`;
    b.onclick = () => {
      emojiIn.value = pr.emoji;
      textIn.value = pr.text;
      const at = pr.endOfDay ? endOfToday() : new Date(Date.now() + pr.ms);
      save(pr.text, pr.emoji, at.toISOString());
    };
    presetHost.appendChild(b);
  }

  box.querySelector('[data-a="save"]').onclick = () =>
    save(textIn.value.trim(), emojiIn.value.trim(), null);
  box.querySelector('[data-a="clear"]').onclick = () => save('', '', null);
  textIn.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); save(textIn.value.trim(), emojiIn.value.trim(), null); }
  };

  // ---- presence ----
  box.querySelector('[data-slot="presence"]').appendChild(
    seg(PRESENCE, myPresence, async (value, btn) => {
      try {
        await api.setPresenceStatus(value);
        myPresence = value;
        btn.parentElement.querySelectorAll('button').forEach((n) => n.classList.remove('on'));
        btn.classList.add('on');
        ui.toast('Availability set to ' + value);
      } catch (e) { ui.toast(e.message || 'Could not change availability', 'error'); }
    }));

  // ---- pause notifications ----
  const dndHost = box.querySelector('[data-slot="dnd"]');
  const paintDnd = () => {
    const active = dndUntil && new Date(dndUntil).getTime() > Date.now();
    note.textContent = active
      ? 'Paused until ' + new Date(dndUntil).toLocaleString([], { hour: '2-digit', minute: '2-digit' })
      : 'Notifications are not paused.';
    dndHost.innerHTML = '';
    for (const opt of PAUSES) {
      const b = el('button', 'sm ghost', esc(opt.label));
      b.onclick = async () => {
        const at = opt.tomorrow ? tomorrowMorning() : new Date(Date.now() + opt.ms);
        try {
          await api.setDnd(at.toISOString());
          dndUntil = at.toISOString();
          paintDnd();
          ui.toast('Notifications paused');
        } catch (e) { ui.toast(e.message || 'Could not pause notifications', 'error'); }
      };
      dndHost.appendChild(b);
    }
    if (active) {
      const off = el('button', 'sm ghost', 'Resume');
      off.onclick = async () => {
        try {
          await api.setDnd(null);
          dndUntil = null;
          paintDnd();
          ui.toast('Notifications resumed');
        } catch (e) { ui.toast(e.message || 'Could not resume notifications', 'error'); }
      };
      dndHost.appendChild(off);
    }
  };
  paintDnd();

  setTimeout(() => textIn.focus(), 30);
  return pop;
}

// ------------------------------------------------------------------ register
export function register({ ui, api }) {
  injectStyle();

  // #meName is static shell markup, so the listener can be attached immediately;
  // main.js only ever writes its textContent.
  const nameEl = $('meName');
  const chip = el('span', 'hstatus-chip hidden');
  chip.id = 'hstatusChip';
  if (nameEl && nameEl.parentElement) {
    nameEl.parentElement.insertBefore(chip, nameEl.nextSibling);
    nameEl.style.cursor = 'pointer';
    nameEl.title = 'Set a status';
    nameEl.addEventListener('click', () => openStatusPopover(nameEl, ui, api));
  }
  chip.addEventListener('click', () => openStatusPopover(chip, ui, api));

  headerDef = {
    id: 'status',
    label: icon('smile'),
    title: 'Your status and availability',
    order: 95,
    onClick: (e) => openStatusPopover(e.currentTarget || document.getElementById('hb-status'), ui, api),
  };
  ui.addHeaderButton(headerDef);

  ui.addSlashCommand({
    name: 'status',
    description: 'Set your status. /status clear removes it.',
    run: async (arg) => {
      const raw = (arg || '').trim();
      if (!raw || /^(clear|off|none)$/i.test(raw)) {
        const row = await api.clearStatus();
        mergeMyProfile(row || { status_text: null, status_emoji: null, status_expires_at: null });
        paintChip();
        ui.toast('Status cleared');
        return;
      }
      // A leading emoji (anything before the first space that is not a word) is
      // treated as the emoji, the way people actually type it.
      const m = raw.match(/^(\S+)\s+([\s\S]+)$/);
      const looksEmoji = m && !/^[\w#@/]/.test(m[1]);
      const emoji = looksEmoji ? m[1] : null;
      const text = looksEmoji ? m[2] : raw;
      const row = await api.setStatus(text.slice(0, 100), emoji, null);
      mergeMyProfile(row || { status_text: text, status_emoji: emoji });
      paintChip();
      scheduleExpiry();
      ui.toast('Status set');
    },
  });

  // ---- decorate message authors ----
  bus.on('message:render', ({ msg, el: row }) => {
    if (!row || !msg) return;
    const who = row.querySelector('.mhead .who');
    if (!who) return; // grouped rows have no header to hang it off
    const p = store.profiles.get(msg.author_id);
    const emoji = p?.status_emoji;
    if (!emoji) return;
    const s = el('span', 'hstatus-msg', esc(emoji));
    s.title = p.status_text ? String(p.status_text) : 'status';
    who.insertAdjacentElement('afterend', s);
  });

  // ---- decorate member rows ----
  const panelHost = $('panelContent');
  if (panelHost && typeof MutationObserver !== 'undefined') {
    // decorateMembers is idempotent, so the observer settles after one extra pass.
    new MutationObserver(() => { decorateMembers(); refreshPresenceDetail(); })
      .observe(panelHost, { childList: true, subtree: true });
  }
  bus.on('presence', () => { refreshPresenceDetail(); });
  bus.on('profiles', () => { decorateMembers(); });

  // ---- keep the top bar honest ----
  const sync = async () => {
    paintChip();
    scheduleExpiry();
    if (!store.me) return;
    const rows = await table('user_presence', (q) => q.eq('user_id', store.me));
    if (rows[0]?.status) myPresence = rows[0].status;
    if (!store.ws) return;
    try {
      const s = await api.notifySettings(store.ws.id);
      dndUntil = s?.prefs?.dnd_until || null;
    } catch { /* the popover falls back to "not paused" */ }
  };
  bus.on('auth', sync);
  bus.on('workspace', sync);
  paintChip();
}

// ------------------------------------------------------------------ style
function injectStyle() {
  if (document.getElementById('hstatus-style')) return;
  const s = document.createElement('style');
  s.id = 'hstatus-style';
  s.textContent = `
    .hstatus-chip{display:inline-flex;align-items:center;gap:5px;max-width:190px;font-size:12.5px;
      color:var(--dim);background:var(--panel2);border:1px solid var(--line);border-radius:12px;
      padding:1px 8px;cursor:pointer;white-space:nowrap}
    .hstatus-chip:hover{color:var(--text);border-color:var(--accent)}
    .hstatus-chip-t{overflow:hidden;text-overflow:ellipsis;max-width:130px}
    .hstatus-msg{font-size:12.5px;opacity:.85;cursor:default}
    .hstatus-badge{font-size:11px;opacity:.85}
    .hstatus-pop{width:300px;padding:6px 8px 10px;display:flex;flex-direction:column;gap:8px}
    .hstatus-inputs{display:flex;gap:6px}
    .hstatus-inputs .hstatus-emoji{width:56px;text-align:center;flex:none;padding:8px 4px}
    .hstatus-presets{display:flex;flex-direction:column;gap:4px}
    .hstatus-preset{text-align:left;display:flex;gap:6px;align-items:baseline}
    .hstatus-preset .muted{margin-left:auto;font-size:11.5px}
    .hstatus-actions{align-items:center}
    .hstatus-exp{font-size:11.5px;margin-left:auto}
    .hstatus-seg{display:flex;gap:4px;flex-wrap:wrap}
    .hstatus-note{font-size:11.5px}
    .hstatus-pop h4.sec{margin:4px 2px 0}
    @media (max-width:860px){ .hstatus-chip{max-width:110px} .hstatus-chip-t{display:none} }`;
  document.head.appendChild(s);
}
