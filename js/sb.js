// The one Supabase client for the app, plus realtime subscription bookkeeping.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.58.0';
import { SUPABASE_URL, PUBLISHABLE } from './config.js';

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

// Realtime channels are capped at 100 per connection by the platform, so every
// subscription goes through here and is torn down by key when it is replaced.
const subs = new Map();

export function subscribe(key, topic, handlers, opts = {}) {
  unsubscribe(key);
  const ch = sb.channel(topic, {
    config: { private: true, broadcast: { self: opts.self !== false } },
  });
  for (const [event, fn] of Object.entries(handlers)) {
    ch.on('broadcast', { event }, ({ payload }) => {
      try { fn(payload); } catch (e) { console.error('realtime handler', event, e); }
    });
  }
  ch.subscribe((status) => { if (opts.onStatus) opts.onStatus(status); });
  subs.set(key, ch);
  return ch;
}

export function unsubscribe(key) {
  const ch = subs.get(key);
  if (ch) { sb.removeChannel(ch); subs.delete(key); }
}

export function unsubscribeAll(prefix) {
  for (const key of [...subs.keys()]) if (!prefix || key.startsWith(prefix)) unsubscribe(key);
}

export const getSub = (key) => subs.get(key) || null;

// Keep the realtime socket's JWT fresh. Realtime authorization is evaluated at
// connect time and only re-evaluated on a new token, so pushing every refresh is
// what makes a newly-joined channel actually reachable without a reload.
sb.auth.onAuthStateChange((_evt, s) => {
  if (s?.access_token) sb.realtime.setAuth(s.access_token);
});
