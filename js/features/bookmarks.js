// Channel bookmarks: the pinned-links strip that lives at the top of a channel,
// not another list buried in the sidebar. The bar is mounted as the first child
// of #messages and stays there because core wipes and refills that node on every
// open - a MutationObserver puts it back rather than us guessing at timings.
import { api, tryRpc } from '../api.js';
import { store, bus, hasPerm } from '../store.js';
import { PERM } from '../config.js';
import { $, el, esc, relTime } from '../util.js';

const PANEL = 'bookmarks';

let UI = null;           // the kit, reached from DOM handlers outside register()
let bar = null;          // the live bar element for the open channel
let chId = null;         // channel the bar belongs to
let rows = [];           // last loaded bookmarks for that channel
let loadToken = 0;       // guards against a slow load landing on a new channel

function style() {
  if (document.getElementById('bookmarks-css')) return;
  const s = el('style');
  s.id = 'bookmarks-css';
  s.textContent = `
    .bmk-bar{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:6px;
      flex-wrap:wrap;padding:6px 8px;margin:0 4px 8px;background:var(--panel);
      border:1px solid var(--line);border-radius:10px}
    .bmk-pill{display:inline-flex;align-items:center;gap:5px;max-width:230px;
      background:var(--panel2);border:1px solid var(--line);border-radius:14px;
      padding:3px 10px;font-size:12.5px;color:var(--text);text-decoration:none;
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}
    .bmk-pill:hover{border-color:var(--accent);color:var(--accent)}
    .bmk-pill.bmk-dead{color:var(--faint);cursor:default}
    .bmk-pill.bmk-dead:hover{border-color:var(--line);color:var(--faint)}
    .bmk-add{color:var(--dim);border-style:dashed}
    .bmk-note{font-size:12px;color:var(--faint)}
    .bmk-note.bmk-err{color:var(--red)}
    .bmk-row{display:flex;align-items:center;gap:8px}
    .bmk-row .bmk-url{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
      font-size:12px;color:var(--faint)}`;
  document.head.appendChild(s);
}

// A bookmark URL is user input that ends up in an href. Anything that is not an
// ordinary web link or an in-app hash gets rendered as dead text instead.
function safeUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (s.startsWith('#')) return s;
  try {
    const u = new URL(s, location.href);
    return /^(https?|mailto):$/.test(u.protocol) ? u.href : null;
  } catch { return null; }
}

const canManage = () => hasPerm(PERM.MANAGE_CHANNELS);

// ------------------------------------------------------------------ mounting
function ensureMounted() {
  if (!bar || !chId || !bar.childNodes.length) return;
  const host = $('messages');
  if (!host) return;
  if (host.firstChild === bar) return;
  host.insertBefore(bar, host.firstChild);
}

function unmount() {
  bar?.remove();
  bar = null;
  chId = null;
  rows = [];
}

function watchMessages() {
  const host = $('messages');
  if (!host) return;
  // childList only: re-inserting the bar does not re-trigger us into a loop.
  new MutationObserver(() => ensureMounted()).observe(host, { childList: true });
}

// ------------------------------------------------------------------ painting
function paint(note) {
  if (!bar) return;
  bar.innerHTML = '';

  for (const b of rows) {
    const href = safeUrl(b.url);
    const pill = el(href ? 'a' : 'span', 'bmk-pill' + (href ? '' : ' bmk-dead'));
    pill.textContent = b.label || b.url || 'link';
    pill.title = (b.label ? b.label + ' — ' : '') + (b.url || '');
    if (href) {
      pill.href = href;
      if (!href.startsWith('#')) { pill.target = '_blank'; pill.rel = 'noopener noreferrer'; }
    } else {
      pill.title = 'This bookmark does not point at a safe link: ' + (b.url || '');
    }
    pill.oncontextmenu = (ev) => { ev.preventDefault(); pillMenu(ev, b); };
    bar.appendChild(pill);
  }

  if (canManage()) {
    const add = el('span', 'bmk-pill bmk-add', '＋');
    add.title = 'Add a bookmark to this channel';
    add.onclick = () => addDialog();
    bar.appendChild(add);
    if (!rows.length && !note) {
      bar.appendChild(el('span', 'bmk-note',
        'Pin the links this channel keeps reaching for - a doc, a dashboard, a runbook.'));
    }
  }

  if (note) bar.appendChild(el('span', 'bmk-note' + (note.error ? ' bmk-err' : ''), esc(note.text)));

  // Nothing to show and nothing to add: do not leave an empty strip behind.
  if (!bar.childNodes.length) { bar.remove(); }
  else ensureMounted();
}

function pillMenu(ev, b) {
  const items = [
    { label: 'Open', onClick: () => {
      const href = safeUrl(b.url);
      if (!href) return;
      if (href.startsWith('#')) location.hash = href.slice(1);
      else window.open(href, '_blank', 'noopener');
    } },
    { label: 'Copy link', onClick: () => {
      navigator.clipboard?.writeText(b.url || '').then(() => UI.toast('Link copied'), () => {});
    } },
  ];
  if (canManage()) {
    items.push('-');
    items.push({ label: 'Remove bookmark', danger: true, onClick: () => remove(b) });
  }
  UI.contextMenu(ev, items);
}

async function remove(b) {
  try {
    await api.removeBookmark(b.id);
    rows = rows.filter((r) => r.id !== b.id);
    paint();
    UI.toast('Bookmark removed');
    if (UI.currentPanel() === PANEL) UI.refreshPanel();
  } catch (e) { UI.toast(e.message, 'error'); }
}

async function addDialog() {
  if (!chId) { UI.toast('Open a channel first', 'error'); return; }
  const out = await UI.formModal({
    title: 'Add a bookmark',
    fields: [
      { name: 'label', label: 'Label', required: true, placeholder: 'Runbook' },
      { name: 'url', label: 'Link', required: true, placeholder: 'https://…' },
    ],
    submitLabel: 'Add',
    note: 'Bookmarks show at the top of the channel for everyone who can see it.',
  });
  if (!out) return;
  if (!safeUrl(out.url)) { UI.toast('That link is not an http(s) or mailto address', 'error'); return; }
  try {
    // p_position defaults to "after everything else" on the server; forcing 0
    // here would silently stack every new bookmark at the front.
    const row = await api.addBookmark(chId, out.label.trim(), out.url.trim(), null);
    if (row) rows = [...rows, row];
    paint();
    UI.toast('Bookmark added');
    if (UI.currentPanel() === PANEL) UI.refreshPanel();
  } catch (e) { UI.toast(e.message, 'error'); }
}

// ------------------------------------------------------------------ loading
async function openFor(channel) {
  if (!channel) { unmount(); return; }
  const token = ++loadToken;
  chId = channel.id;
  rows = [];
  bar?.remove();
  bar = el('div', 'bmk-bar');
  bar.id = 'bmkBar';
  ensureMounted();
  paint({ text: 'loading bookmarks…' });

  const [data, err] = await tryRpc('list_bookmarks', { p_channel: channel.id });
  if (token !== loadToken) return;          // a newer channel won the race
  if (err) { rows = []; paint({ text: err.message, error: true }); return; }
  rows = Array.isArray(data) ? data : [];
  paint();
}

// ------------------------------------------------------------------ panel
// The bar is the product; this panel is the place to see the full URLs and tidy
// them up, and it gives the feature a surface that survives a narrow window.
function registerPanel(ui) {
  ui.registerPanel({
    id: PANEL,
    title: 'Channel bookmarks',
    async render(body) {
      if (!store.current) {
        body.innerHTML = '<div class="empty">Open a channel to see its bookmarks.</div>';
        return;
      }
      body.innerHTML = '<div class="muted pad">loading…</div>';
      const [data, err] = await tryRpc('list_bookmarks', { p_channel: store.current.id });
      if (err) { body.innerHTML = `<div class="empty">${esc(err.message)}</div>`; return; }
      const list = Array.isArray(data) ? data : [];

      body.innerHTML = '';
      if (!list.length) {
        body.appendChild(el('div', 'empty',
          `No bookmarks in <b>#${esc(store.current.name)}</b> yet. `
          + (canManage()
            ? 'Add one and it appears as a pill at the top of the channel for everyone.'
            : 'Someone who can manage channels can pin links here.')));
      }
      for (const b of list) {
        const href = safeUrl(b.url);
        const card = el('div', 'result');
        card.innerHTML = `<div class="bmk-row"><b>${esc(b.label || 'link')}</b>
            <span class="muted">${esc(relTime(b.created_at))}</span></div>
          <div class="bmk-url">${esc(b.url || '')}${href ? '' : ' (not a safe link)'}</div>`;
        if (href) card.onclick = () => {
          if (href.startsWith('#')) location.hash = href.slice(1);
          else window.open(href, '_blank', 'noopener');
        };
        if (canManage()) {
          const rm = el('button', 'sm ghost', 'Remove');
          rm.onclick = async (e) => {
            e.stopPropagation();
            try {
              await api.removeBookmark(b.id);
              rows = rows.filter((r) => r.id !== b.id);
              paint();
              ui.refreshPanel();
            } catch (err2) { ui.toast(err2.message, 'error'); }
          };
          card.appendChild(rm);
        }
        body.appendChild(card);
      }
    },
    footer(foot) {
      if (!canManage() || !store.current) return;
      const b = el('button', 'wide', 'Add a bookmark');
      b.onclick = () => addDialog();
      foot.appendChild(b);
    },
  });
}

export function register({ ui }) {
  style();
  UI = ui;
  watchMessages();
  registerPanel(ui);

  bus.on('channel:open', ({ channel }) => openFor(channel));
  bus.on('dm:open', () => unmount());
  bus.on('channels', () => { if (chId && !store.channels.some((c) => c.id === chId)) unmount(); });
}
