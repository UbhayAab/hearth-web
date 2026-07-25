// Central app state + a tiny event bus. Features read `store` and listen on `bus`
// rather than reaching into each other.

export const store = {
  me: null,                 // auth user id
  myProfile: null,          // profiles row for me
  perms: 0n,                // my permission bitfield in the current workspace
  isAdmin: false,           // platform admin OR ADMINISTRATOR bit here

  spaces: [],               // every workspace I am a member of
  ws: null,                 // current workspace row
  categories: [],
  channels: [],
  current: null,            // current channel row
  currentDM: null,          // current conversation id
  dms: [],

  profiles: new Map(),      // user_id -> profile
  online: new Set(),
  unread: new Map(),        // scope_id -> {unread, mention_count}
  notify: new Map(),        // scope_id -> {notify_level, muted_until}
  drafts: new Map(),        // `${scope_type}:${scope_id}` -> body_text
  voiceParts: new Map(),    // channel_id -> [user_id]
  spaceBadges: new Map(),   // workspace_id -> {unread_total, mention_total}

  // per-open-channel message bookkeeping
  seen: new Set(),          // message ids + 'n:'+nonce already rendered
  msgCache: new Map(),      // message id -> row (for quotes, edits, actions)
  rootThreads: new Map(),   // root message id -> {threadId, count}
  rxn: new Map(),           // message id -> Map(emoji -> Set(user_id))
  cursor: 0,                // highest channel seq applied
  dmCursor: 0,              // highest DM seq applied in the open conversation
  oldestSeq: null,          // lowest channel seq loaded (for paging up)
  replyTarget: null,
};

export function resetChannelState() {
  store.seen.clear();
  store.msgCache.clear();
  store.rootThreads.clear();
  store.rxn.clear();
  store.cursor = 0;
  store.dmCursor = 0;
  store.oldestSeq = null;
  store.replyTarget = null;
}

export const nameOf = (id) => {
  if (id === store.me) return store.myProfile?.display_name || 'you';
  const p = store.profiles.get(id);
  return p?.display_name || p?.username || 'someone';
};

export const profileOf = (id) => store.profiles.get(id) || null;

export function hasPerm(bit) {
  if (store.isAdmin) return true;
  try { return (store.perms & BigInt(bit)) !== 0n; } catch { return false; }
}

// ---- event bus ----
const listeners = new Map();

export const bus = {
  on(evt, fn) {
    if (!listeners.has(evt)) listeners.set(evt, new Set());
    listeners.get(evt).add(fn);
    return () => listeners.get(evt)?.delete(fn);
  },
  off(evt, fn) { listeners.get(evt)?.delete(fn); },
  emit(evt, payload) {
    for (const fn of listeners.get(evt) || []) {
      try { fn(payload); } catch (e) { console.error('bus handler', evt, e); }
    }
  },
};

// Events emitted by core (features may listen to all of these):
//   'auth'              -> after sign-in, store.me is set
//   'workspace'         -> {ws} after a workspace is loaded/switched
//   'channels'          -> after the channel list changes
//   'channel:open'      -> {channel} after a text channel is opened
//   'dm:open'           -> {conversationId}
//   'message:new'       -> {msg} a message was appended to the open channel
//   'message:render'    -> {msg, el} a message element was built (decorate it here)
//   'message:update'    -> {id, msg}
//   'message:delete'    -> {id}
//   'thread:open'       -> {threadId, root}
//   'panel:close'
//   'profiles'          -> profiles map was refreshed
//   'unread'            -> unread counts changed
//   'realtime:ch'       -> {event, payload} raw channel broadcast passthrough
