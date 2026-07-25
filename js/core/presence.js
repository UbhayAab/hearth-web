// Presence, typing indicators, and the periodic reconciliation loops that keep
// the UI correct even when a realtime broadcast is dropped (the transport is
// at-most-once by design).
import { table, api } from '../api.js';
import { store, bus, nameOf } from '../store.js';
import { $, esc } from '../util.js';
import { reconcile, refreshUnread, renderChannels } from './channels.js';
import { loadReactions } from './messages.js';
import { refreshVoice } from './voice.js';

const typers = new Map(); // user_id -> timeout

export function initPresence() {
  // my liveness
  const beat = () => api.heartbeat('online').catch(() => {});
  beat();
  setInterval(beat, 45000);

  // Who else is around. This also has to pick up people who joined AFTER my
  // bootstrap snapshot: without it a new member is invisible in the member list,
  // in mention autocomplete and in the DM picker until a reload.
  const tick = async () => {
    if (store.ws) {
      const mem = await table('workspace_members', (q) => q.eq('workspace_id', store.ws.id));
      const unknown = mem.map((m) => m.user_id).filter((u) => !store.profiles.has(u));
      if (unknown.length) {
        const profs = await table('profiles', (q) => q.in('id', unknown));
        for (const p of profs) store.profiles.set(p.id, p);
        bus.emit('profiles');
      }
    }
    const ids = [...store.profiles.keys()];
    if (!ids.length) return;
    const rows = await table('user_presence', (q) => q.in('user_id', ids));
    store.online = new Set(
      rows.filter((p) => p.status !== 'offline' && Date.now() - new Date(p.last_seen_at).getTime() < 90000)
        .map((p) => p.user_id));
    store.online.add(store.me);
    const c = $('onlineCount');
    if (c) c.textContent = store.online.size;
    bus.emit('presence');
  };
  tick();
  setInterval(tick, 20000);

  // gap healing
  setInterval(() => { if (store.current) reconcile(); }, 6000);
  setInterval(() => {
    const ids = [...store.seen].filter((x) => typeof x === 'string' && !x.startsWith('n:')).slice(-60);
    if (ids.length) loadReactions(ids);
  }, 9000);
  setInterval(() => { if (store.ws) refreshUnread(); }, 15000);
  setInterval(() => { if (store.ws) refreshVoice(); }, 20000);

  bus.on('typing', ({ user_id, name }) => showTyping(user_id, name));
  bus.on('unread:reload', refreshUnread);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      beat();
      if (store.current) reconcile();
      refreshUnread();
    }
  });
}

function showTyping(userId, name) {
  clearTimeout(typers.get(userId));
  typers.set(userId, setTimeout(() => { typers.delete(userId); paintTyping(); }, 3200));
  paintTyping();
}

function paintTyping() {
  const host = $('typing');
  if (!host) return;
  const names = [...typers.keys()].map(nameOf);
  host.textContent = !names.length ? ''
    : names.length === 1 ? `${names[0]} is typing…`
    : names.length === 2 ? `${names[0]} and ${names[1]} are typing…`
    : 'Several people are typing…';
}
