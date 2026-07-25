// Bootstrap: sign in, load the Space, wire the shell, register features.
import { DEMO_TOKEN } from './config.js';
import { sb, session } from './sb.js';
import { api, tryRpc } from './api.js';
import { store, bus, nameOf } from './store.js';
import { $, el, esc } from './util.js';
import ui, { toast, openPanel, closePanel, renderHeaderButtons, modal, closePopovers } from './ui.js';
import { initAuth, showAuth, showChat } from './core/auth.js';
import { loadSpaces, switchWorkspace, spaceChooser, inviteDialog, copyInvite, extractToken } from './core/workspace.js';
import { openChannel, renderChannels, wireScroll, refreshUnread, jumpToSeq } from './core/channels.js';
import { initComposer, setReply, resolveMentions } from './core/composer.js';
import { initPresence } from './core/presence.js';
import { initVoice } from './core/voice.js';
import { openThread, threadState } from './core/threads.js';
import { registerCoreActions, registerCoreHeader } from './core/actions.js';
import { openDM, startDM } from './core/dms.js';
import { jumpTo, buildMessage } from './core/messages.js';
import { initPWA, paintInstallButton } from './pwa.js';
import { registerFeatures } from './features/index.js';

// ------------------------------------------------------------------ routing
function route() {
  const h = location.hash || '';
  let m;
  if ((m = h.match(/#\/join\/([^/?#]+)/))) return { kind: 'join', token: decodeURIComponent(m[1]) };
  if ((m = h.match(/#\/m\/([0-9a-f-]{36})\/(\d+)/i))) return { kind: 'message', channelId: m[1], seq: +m[2] };
  if ((m = h.match(/#\/c\/([0-9a-f-]{36})/i))) return { kind: 'channel', channelId: m[1] };
  return { kind: 'none' };
}

async function applyRoute() {
  const r = route();
  if (r.kind === 'channel') {
    const c = store.channels.find((x) => x.id === r.channelId);
    if (c) await openChannel(c);
  } else if (r.kind === 'message') {
    const c = store.channels.find((x) => x.id === r.channelId);
    if (c) await openChannel(c, { jumpSeq: r.seq });
  }
  if (r.kind !== 'none') history.replaceState(null, '', location.pathname + location.search);
}

// Someone opening an invite link who is not signed in has to detour through
// email. The mail app usually opens the sign-in link in a NEW tab, and
// sessionStorage is per-tab, so the invite would be silently lost and they would
// land in the demo Space wondering where their organisation went. localStorage
// survives the round trip; the 30 minute TTL stops a stale token from hijacking
// an unrelated sign-in days later.
const INVITE_KEY = 'hearth.pendingInvite';
const INVITE_TTL_MS = 30 * 60 * 1000;

function stashPendingInvite(token) {
  try {
    localStorage.setItem(INVITE_KEY, JSON.stringify({ token, at: Date.now() }));
  } catch { /* private mode: the in-URL token still works on this tab */ }
}

function takePendingInvite() {
  try {
    const raw = localStorage.getItem(INVITE_KEY);
    if (!raw) return null;
    localStorage.removeItem(INVITE_KEY);
    const { token, at } = JSON.parse(raw);
    return Date.now() - at < INVITE_TTL_MS ? token : null;
  } catch { return null; }
}

// ------------------------------------------------------------------ enter
async function enter() {
  const s = await session();
  if (!s) { showAuth(); return; }
  store.me = s.user.id;
  sb.realtime.setAuth(s.access_token);

  // An invite in the URL is the whole multi-org story: open link, land in that Space.
  const r = route();
  const pending = r.kind === 'join' ? r.token : takePendingInvite();
  let joinedId = null;
  if (pending) {
    try {
      const wsRow = await api.redeemInvite(extractToken(pending));
      joinedId = wsRow?.id || null;
    } catch (e) {
      toast(e.message || 'That invite link is not valid', 'error');
    }
  }
  // Keep the shared demo Space reachable for anyone arriving cold.
  if (!joinedId) await tryRpc('redeem_invite', { p_token: DEMO_TOKEN });

  showChat();

  const { data: prof } = await sb.from('profiles')
    .select('*').eq('id', store.me).maybeSingle();
  store.myProfile = prof || { id: store.me, display_name: 'you' };
  store.profiles.set(store.me, store.myProfile);
  $('meName').textContent = store.myProfile.display_name || 'you';

  subscribeUser(s.user.id);
  initPresence();

  await loadSpaces();
  const active = store.spaces.find((x) => x.id === joinedId)
    || store.spaces.find((x) => x.slug === 'demo')
    || store.spaces[0];

  if (active) {
    await switchWorkspace(active);
    await applyRoute();
  } else {
    renderChannels();
    $('messages').innerHTML =
      '<div class="empty">You are not in a Space yet. Create one with <b>+</b> on the left, or open an invite link.</div>';
  }
  bus.emit('auth');
  paintInstallButton();
}

function subscribeUser(uid) {
  import('./sb.js').then(({ subscribe }) => {
    subscribe('user', 'user:' + uid, {
      mention: () => { refreshUnread(); flashTitle(); },
      unread: () => refreshUnread(),
      status: () => {},
      claims_changed: async () => {
        const { data } = await sb.auth.refreshSession();
        if (data?.session) sb.realtime.setAuth(data.session.access_token);
      },
      reminder: (p) => toast('Reminder: ' + (p?.note || 'you asked to be reminded')),
    });
  });
}

let titleTimer = null;
function flashTitle() {
  if (document.visibilityState === 'visible') return;
  clearInterval(titleTimer);
  let on = false;
  titleTimer = setInterval(() => {
    document.title = (on = !on) ? '● Hearth' : 'Hearth';
  }, 900);
  document.addEventListener('visibilitychange', function once() {
    clearInterval(titleTimer);
    document.title = 'Hearth';
    document.removeEventListener('visibilitychange', once);
  });
}

// ------------------------------------------------------------------ quick switcher
function quickSwitcher() {
  const box = el('div', 'switcher');
  box.innerHTML = '<input id="qsInput" placeholder="Jump to a channel, person or command…" /><div id="qsRows"></div>';
  const m = modal({ title: '', body: box, wide: true });
  const input = box.querySelector('#qsInput');
  const rows = box.querySelector('#qsRows');
  let items = [];
  let idx = 0;

  const draw = () => {
    rows.innerHTML = items.map((it, i) =>
      `<div class="qs-row${i === idx ? ' sel' : ''}" data-i="${i}">
        <span class="qs-ico">${it.icon || ''}</span><span>${esc(it.label)}</span>
        <span class="muted">${esc(it.hint || '')}</span></div>`).join('');
    rows.querySelectorAll('.qs-row').forEach((n) => {
      n.onclick = () => { m.close(); items[+n.dataset.i].run(); };
    });
  };
  const run = () => {
    const q = input.value.replace(/^[#@>]/, '').trim();
    items = ui.getSwitcherSources().flatMap((s) => {
      try { return s.search(q) || []; } catch { return []; }
    }).slice(0, 12);
    idx = 0;
    draw();
  };
  input.oninput = run;
  input.onkeydown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); idx = (idx + 1) % Math.max(1, items.length); draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); idx = (idx - 1 + items.length) % Math.max(1, items.length); draw(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (items[idx]) { m.close(); items[idx].run(); } }
  };
  run();
}

// ------------------------------------------------------------------ shortcuts
function initShortcuts() {
  window.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); quickSwitcher(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); openPanel('search', {}); return; }
    if (e.key === 'Escape') { closePopovers(); if (!typing) closePanel(); return; }
    if (typing) return;
    if (e.key === '/') { e.preventDefault(); $('composer')?.focus(); }
  });
}

// ------------------------------------------------------------------ events
bus.on('thread:openById', async ({ threadId, channelId, rootMessageId }) => {
  const c = store.channels.find((x) => x.id === channelId);
  if (c && store.current?.id !== c.id) await openChannel(c, { keepPanel: true });
  const { data } = await sb.from('messages').select('*').eq('id', rootMessageId).maybeSingle();
  if (data) openThread(data);
});

bus.on('message:jump', async ({ messageId }) => {
  const { data } = await sb.from('messages').select('channel_id,seq').eq('id', messageId).maybeSingle();
  if (!data) return;
  const c = store.channels.find((x) => x.id === data.channel_id);
  if (c) openChannel(c, { jumpSeq: data.seq });
});

bus.on('message:editLast', async ({ id }) => {
  const m = store.msgCache.get(id);
  if (!m) return;
  const { formModal } = ui;
  const out = await formModal({
    title: 'Edit message',
    fields: [{ name: 'text', label: '', type: 'textarea', value: m.body_text, rows: 5, required: true }],
    submitLabel: 'Save',
  });
  if (out) api.edit(id, out.text).catch((e) => toast(e.message, 'error'));
});

// A thread reply the author chose to broadcast should show up in the channel
// immediately for them too.
bus.on('thread:alsoSent', ({ message }) => {
  if (!message || message.channel_id !== store.current?.id) return;
  import('./core/channels.js').then(({ reconcile }) => reconcile());
});

// ------------------------------------------------------------------ start
async function main() {
  // stash an invite arriving before sign-in so it survives the auth round trip
  const r = route();
  if (r.kind === 'join') stashPendingInvite(r.token);

  initAuth(enter);
  initComposer();
  initVoice();
  initShortcuts();
  wireScroll();
  registerCoreActions();
  registerCoreHeader();
  // Await it: features register header buttons and panels, and a button that
  // appears a second after the app paints reads as a glitch.
  await registerFeatures({ ui, api, store, bus, sb });
  renderHeaderButtons();
  initPWA();

  $('panelClose').onclick = closePanel;
  $('btnInvite').onclick = () => inviteDialog();
  $('btnSpaces').onclick = spaceChooser;
  $('btnMembersCount').onclick = () => openPanel('members');
  $('installBtn').onclick = () => import('./pwa.js').then((m) => m.promptInstall());

  // Mobile: the sidebar is off-canvas until asked for, and any navigation
  // inside it should close it again.
  $('navToggle').onclick = () => document.body.classList.toggle('nav-open');
  $('sidebar').addEventListener('click', (e) => {
    if (e.target.closest('.chan')) document.body.classList.remove('nav-open');
  });
  $('messages').addEventListener('click', () => document.body.classList.remove('nav-open'));

  const s = await session();
  if (s) enter(); else showAuth();
}

window.addEventListener('hashchange', () => {
  if (store.me) applyRoute();
});

main().catch((e) => {
  console.error(e);
  document.body.innerHTML = `<pre style="padding:20px;color:#f88">Hearth failed to start:\n${esc(e.stack || e.message)}</pre>`;
});
