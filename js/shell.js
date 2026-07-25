// The application shell: the global bar, the channel bar, the user menu and the
// overflow menu.
//
// The header used to carry thirteen identical monochrome icons in a row. That is
// not a toolbar, it is a wall - nothing tells you what any of them do, and the
// one control people reach for most (search) was the same 18px glyph as the
// twelve others. This splits the chrome the way every mature chat client does:
//
//   global bar    where you are | what you are looking for | who you are
//   channel bar   the channel, its topic, and actions ON that channel
//   sidebar foot  your own presence, always visible, always changeable
//
// Anything a feature registers beyond the first few contextual actions goes
// behind one overflow menu rather than being appended to the wall.
import { $, el, esc, hueOf, initials } from './util.js';
import { store, bus, nameOf } from './store.js';
import { icon } from './icons.js';
import ui, { openPanel, contextMenu, toast, closePopovers } from './ui.js';
import { openThemePicker, effectiveTheme, THEMES, setTheme } from './theme.js';
import { api, tryRpc } from './api.js';
import { sb } from './sb.js';

// How many registered header buttons stay visible on the channel bar before the
// rest collapse into the overflow. Four is about where a row stops being
// scannable at a glance.
const INLINE_ACTIONS = 4;

function avatarFor(userId, size) {
  const p = store.profiles.get(userId) || store.myProfile || {};
  const name = p.display_name || p.username || '?';
  return `<span class="avatar" style="width:${size}px;height:${size}px;background:hsl(${hueOf(userId || name)} 45% 32%)">${esc(initials(name))}</span>`;
}

// ------------------------------------------------------------------ identity
export function paintIdentity() {
  const name = store.myProfile?.display_name || 'you';
  const av = avatarFor(store.me, 24);
  const a2 = avatarFor(store.me, 28);
  if ($('meAvatar')) $('meAvatar').innerHTML = av;
  if ($('meName')) $('meName').textContent = name;
  if ($('sbMeAvatar')) $('sbMeAvatar').innerHTML = a2;
  if ($('sbMeName')) $('sbMeName').textContent = name;

  const st = $('sbMeStatus');
  if (st) {
    const p = store.myProfile || {};
    st.textContent = p.status_text
      ? `${p.status_emoji || ''} ${p.status_text}`.trim()
      : 'Active';
  }
}

// ------------------------------------------------------------------ user menu
function userMenu(ev) {
  const themeName = THEMES.find((t) => t.id === effectiveTheme())?.name || 'Theme';
  contextMenu(ev, [
    { label: 'Set a status', onClick: () => bus.emit('status:open') },
    { label: 'Pause notifications', onClick: () => openPanel('notifications') },
    '-',
    { label: `Appearance: ${themeName}`, onClick: () => {
      // The picker anchors to the control that opened it.
      const anchor = $('userMenu') || document.body;
      openThemePicker(anchor);
    } },
    { label: 'Keyboard shortcuts', onClick: () => bus.emit('shortcuts:open') },
    '-',
    { label: 'Invite people to this Space', onClick: () => bus.emit('invite:open') },
    { label: 'Sign out', danger: true, onClick: async () => {
      // The local-first caches keep this person's conversations on the device so
      // the app can paint before the network. On a shared phone - which is most
      // of them here - signing out has to take them with it. Imported here, not
      // at the top, so neither file joins the first-paint module graph.
      await Promise.all([
        import('./lib/pagecache.js').then((m) => m.wipe()),
        import('./lib/readcache.js').then((m) => m.wipe()),
      ]).catch(() => { /* signing out must not be blocked by storage */ });
      await sb.auth.signOut();
      location.hash = '';
      location.reload();
    } },
  ]);
}

// ------------------------------------------------------------------ overflow
// Everything a feature registered that did not fit inline. Built from the same
// registry, so a feature never has to know whether it landed on the bar or in
// the menu.
function overflowMenu(ev) {
  const all = ui.getHeaderButtons ? ui.getHeaderButtons() : [];
  const rest = all.slice(INLINE_ACTIONS);
  if (!rest.length) {
    contextMenu(ev, [{ label: 'Nothing else here yet', onClick: () => {} }]);
    return;
  }
  contextMenu(ev, rest.map((b) => ({
    label: b.title || b.id,
    onClick: () => b.onClick(ev),
  })));
}

// ------------------------------------------------------------------ channel bar
export function paintChannelBar() {
  const c = store.current;
  const name = $('hdrName');
  const topic = $('hdrTopic');
  if (!name) return;
  if (store.currentDM) {
    const conv = store.dms.find((d) => d.conversation_id === store.currentDM);
    const others = (conv?.other_user_ids || []).filter((u) => u !== store.me);
    name.textContent = others.length ? others.map(nameOf).join(', ') : 'Conversation';
    name.dataset.kind = 'dm';
    topic.textContent = '';
  } else if (c) {
    name.textContent = '# ' + c.name;
    name.dataset.kind = 'channel';
    topic.textContent = c.topic || '';
  }
}

// ------------------------------------------------------------------ init
export function initShell() {
  $('userMenu')?.addEventListener('click', userMenu);
  $('sidebarMe')?.addEventListener('click', userMenu);
  $('btnMore')?.addEventListener('click', overflowMenu);
  $('btnHelp')?.addEventListener('click', () => bus.emit('shortcuts:open'));
  $('globalSearch')?.addEventListener('click', () => openPanel('search', {}));

  bus.on('workspace', paintIdentity);
  bus.on('profiles', paintIdentity);
  bus.on('channel:open', paintChannelBar);
  bus.on('dm:open', paintChannelBar);
  bus.on('status:changed', paintIdentity);

  paintIdentity();
}
