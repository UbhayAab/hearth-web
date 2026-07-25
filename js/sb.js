// The one Supabase client for the app, plus realtime subscription bookkeeping.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.58.0';
import { SUPABASE_URL, PUBLISHABLE } from './config.js';
import { bus } from './store.js';

export const sb = createClient(SUPABASE_URL, PUBLISHABLE, {
  auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: true },
  realtime: { params: { eventsPerSecond: 30 } },
});

export async function session() {
  const { data } = await sb.auth.getSession();
  return data.session || null;
}

export async function accessToken() {
  const s = await session();
  return s?.access_token || null;
}

// ------------------------------------------------------------------ token
// Realtime authorization is evaluated when a topic is joined and re-evaluated
// only when a new token is pushed at the socket. An expired token therefore does
// not fail loudly: the socket stays open, the rejoin is refused, and delivery
// stops with nothing on screen. Two defences:
//   - refresh BEFORE expiry rather than on the first 401 after it, and
//   - never re-open a topic without a token known to be valid.
const TOKEN_MARGIN_MS = 120000;   // refresh with this much life left
let refreshing = null;

function ttlOf(s) {
  if (!s?.expires_at) return 0;
  return s.expires_at * 1000 - Date.now();
}

// Resolves to a token with at least `minTtlMs` of life, refreshing if needed,
// and pushes it at the realtime socket. Concurrent callers share one refresh -
// gotrue rotates the refresh token, so two in flight is how a session gets
// destroyed rather than renewed.
export async function ensureFreshAuth({ minTtlMs = TOKEN_MARGIN_MS, force = false } = {}) {
  const s = await session();
  if (!s) return null;
  if (!force && ttlOf(s) > minTtlMs) {
    try { sb.realtime.setAuth(s.access_token); } catch { /* socket not up yet */ }
    return s.access_token;
  }
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const { data, error } = await sb.auth.refreshSession();
        if (error || !data?.session) return s.access_token;       // keep the old one; it may still work
        try { sb.realtime.setAuth(data.session.access_token); } catch { /* socket not up yet */ }
        bus.emit('auth:refreshed', { expiresAt: data.session.expires_at });
        return data.session.access_token;
      } finally { refreshing = null; }
    })();
  }
  return refreshing;
}

// ------------------------------------------------------------------ subscriptions
// Realtime channels are capped at 100 per connection by the platform, so every
// subscription goes through here and is torn down by key when it is replaced.
//
// The reason this file owns a state machine rather than one line of phoenix:
// when a topic errors (a flap long enough to time out the rejoin), realtime-js
// removes it from socket.channels and nothing puts it back. The socket keeps
// reconnecting to nothing. Measured: after two flaps a client is subscribed to
// ZERO topics, forever, and the only cure is a page reload. The status callback
// that would have exposed it existed and was thrown away. It is now the whole
// mechanism.
const subs = new Map();           // key -> descriptor
const BACKOFF = [500, 1000, 2000, 4000, 8000, 15000, 30000];
let genSeq = 0;

const jitter = (ms) => Math.round(ms * (0.75 + Math.random() * 0.5));
const isDown = (s) => s === 'CHANNEL_ERROR' || s === 'TIMED_OUT' || s === 'CLOSED';

export function subscribe(key, topic, handlers, opts = {}) {
  unsubscribe(key);
  const d = {
    key, topic, handlers, opts,
    gen: ++genSeq, attempts: 0, timer: null, ch: null,
    joined: false, everJoined: false, dead: false, lastStatus: 'JOINING',
  };
  subs.set(key, d);
  open(d);
  return d.ch;
}

function current(d) { return !d.dead && subs.get(d.key) === d; }

function open(d) {
  if (!current(d)) return;
  const ch = sb.channel(d.topic, {
    config: { private: true, broadcast: { self: d.opts.self !== false } },
  });
  d.ch = ch;
  for (const [event, fn] of Object.entries(d.handlers)) {
    ch.on('broadcast', { event }, ({ payload }) => {
      try { fn(payload); } catch (e) { console.error('realtime handler', event, e); }
    });
  }
  ch.subscribe((status, err) => onStatus(d, status, err));
}

function onStatus(d, status, err) {
  if (!current(d)) return;               // a superseded descriptor closing down
  d.lastStatus = status;
  try { d.opts.onStatus?.(status, err); } catch (e) { console.error('onStatus', e); }
  bus.emit('realtime:status', { key: d.key, topic: d.topic, status, error: err?.message || null });

  if (status === 'SUBSCRIBED') {
    clearTimeout(d.timer); d.timer = null;
    d.attempts = 0;
    const rejoined = d.everJoined;       // a re-join after a drop, not a first join
    d.joined = true;
    d.everJoined = true;
    bus.emit('realtime:subscribed', { key: d.key, topic: d.topic, rejoined });
    return;
  }
  if (!isDown(status)) return;

  const wasJoined = d.joined;
  d.joined = false;
  if (wasJoined) bus.emit('realtime:down', { key: d.key, topic: d.topic, status });
  scheduleReopen(d);
}

function scheduleReopen(d) {
  if (!current(d) || d.timer) return;
  const wait = jitter(BACKOFF[Math.min(d.attempts, BACKOFF.length - 1)]);
  d.attempts++;
  d.timer = setTimeout(async () => {
    d.timer = null;
    if (!current(d)) return;
    // A stale JWT is one of the ways a topic dies. Re-opening with the same
    // dead token just loops, so prove the token first.
    try { await ensureFreshAuth(); } catch { /* offline; try anyway */ }
    if (!current(d)) return;
    try { sb.removeChannel(d.ch); } catch { /* already gone */ }
    open(d);
  }, wait);
}

// Retry every down topic now, resetting backoff. Called when the environment
// tells us the network came back, which is better information than a timer.
export function retryAllNow() {
  for (const d of subs.values()) {
    if (d.joined || d.dead) continue;
    clearTimeout(d.timer); d.timer = null;
    d.attempts = 0;
    scheduleReopen(d);
  }
}

export function unsubscribe(key) {
  const d = subs.get(key);
  if (!d) return;
  d.dead = true;
  clearTimeout(d.timer);
  subs.delete(key);
  if (d.ch) { try { sb.removeChannel(d.ch); } catch { /* already gone */ } }
}

export function unsubscribeAll(prefix) {
  for (const key of [...subs.keys()]) if (!prefix || key.startsWith(prefix)) unsubscribe(key);
}

export const getSub = (key) => subs.get(key)?.ch || null;

// Health, for the UI, the tests and the stress harness. `down` is the honest
// answer to "is delivery working right now", which the app previously had no
// way to ask.
export function realtimeHealth() {
  let socket = 'unknown';
  try { socket = sb.realtime.connectionState ? sb.realtime.connectionState() : 'unknown'; } catch { /* ignore */ }
  const topics = [...subs.values()].map((d) => ({
    key: d.key, topic: d.topic, state: d.ch?.state || null,
    joined: d.joined, status: d.lastStatus, attempts: d.attempts,
  }));
  return {
    socket,
    topics,
    joined: topics.filter((t) => t.joined).length,
    down: topics.filter((t) => !t.joined).length,
  };
}

// ------------------------------------------------------------------ lifecycle
// Keep the socket's JWT fresh. Realtime authorization is evaluated at connect
// time and only re-evaluated on a new token, so pushing every refresh is what
// makes a newly-joined channel actually reachable without a reload.
sb.auth.onAuthStateChange((_evt, s) => {
  if (s?.access_token) {
    try { sb.realtime.setAuth(s.access_token); } catch { /* socket not up yet */ }
  }
});

if (typeof window !== 'undefined') {
  // Proactive, not reactive: a phone that has been asleep wakes with a token
  // that is already dead, and the first thing it does must be to replace it.
  setInterval(() => { ensureFreshAuth().catch(() => {}); }, 30000);

  window.addEventListener('online', () => {
    ensureFreshAuth().catch(() => {});
    retryAllNow();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    ensureFreshAuth().catch(() => {});
    retryAllNow();
  });
}
