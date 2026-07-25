// The last page of each channel, kept on this phone, so reopening a channel
// paints before the network is touched.
//
// WHY. Measured on the real app: clicking a channel in the sidebar puts the
// first message on screen after 1063ms on a mid-range Android, and the whole
// list settles at 1609ms - every time, including the channel you were in ninety
// seconds ago. Nothing about that wait is information: the same fifty rows come
// back over the same connection to be drawn again. Meanwhile the returning-user
// cold start on Slow 3G waits 21.4 seconds for a message that was in this
// browser's own storage the whole time.
//
// So: remember the last page, paint it instantly, and reconcile against the
// server's answer when it arrives. The cached page is never trusted as truth -
// it is a placeholder that the real fetch corrects a few hundred milliseconds
// later, and the existing seq cursor plus sync() heal anything either of them
// missed. That ordering matters: a cache that can be WRONG for 300ms but is
// always repaired is honest; a cache that has to be right is a second source of
// truth and eventually contradicts the first.
//
// Two layers, deliberately:
//   memory  - a Map, hit synchronously, so switching back to a channel in the
//             same session paints in the same frame as the click.
//   IndexedDB - survives the tab being killed, which on Android is most of the
//             time. Read once per channel open, written debounced.
//
// The key carries the signed-in user id. A shared phone must never paint one
// person's channel to the next person who signs in.

const DB_NAME = 'soop-pages';
const STORE = 'pages';
const VERSION = 2;              // bump to invalidate every stored snapshot
const MAX_MSGS = 50;            // one page, which is what the app asks for
const MAX_CHANNELS = 16;
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

const mem = new Map();          // key -> snapshot
let dbPromise = null;
let dead = false;

const keyFor = (uid, channelId) => `${uid || 'anon'}|${channelId}`;

// ------------------------------------------------------------------ storage
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    let req;
    try { req = indexedDB.open(DB_NAME, 1); } catch { resolve(null); return; }
    // Some Android WebViews leave open() pending forever instead of erroring. A
    // cache we cannot reach is the same as no cache, and this one sits on the
    // path to a paint - give up fast rather than hold the channel open.
    const bail = setTimeout(() => resolve(null), 1200);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
    };
    req.onsuccess = () => { clearTimeout(bail); resolve(req.result); };
    req.onerror = () => { clearTimeout(bail); resolve(null); };
    req.onblocked = () => { clearTimeout(bail); resolve(null); };
  }).then((db) => { if (!db) dead = true; return db; });
  return dbPromise;
}

function tx(mode, fn) {
  return openDb().then((db) => {
    if (!db) return null;
    return new Promise((resolve, reject) => {
      let t;
      try { t = db.transaction(STORE, mode); } catch (e) { reject(e); return; }
      let out;
      try { out = fn(t.objectStore(STORE)); } catch (e) { reject(e); return; }
      t.oncomplete = () => resolve(out && 'result' in out ? out.result : out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  });
}

// ------------------------------------------------------------------ read
// Synchronous. Returns a snapshot only if it is already in memory, which is the
// case that matters most: switching back to a channel inside one session must
// paint in the same frame as the click, and an await - even one that resolves
// immediately - costs a frame.
export function peek(uid, channelId) {
  const s = mem.get(keyFor(uid, channelId));
  return s && Date.now() - s.at < MAX_AGE_MS ? s : null;
}

// Memory, then disk. Used on the first open of a channel in a session.
export async function recall(uid, channelId) {
  const hit = peek(uid, channelId);
  if (hit) return hit;
  if (dead) return null;
  const key = keyFor(uid, channelId);
  let rec = null;
  try { rec = await tx('readonly', (s) => s.get(key)); } catch { return null; }
  if (!rec || rec.v !== VERSION) return null;
  if (Date.now() - rec.at > MAX_AGE_MS) return null;
  if (!Array.isArray(rec.msgs) || !rec.msgs.length) return null;
  mem.set(key, rec);
  return rec;
}

// ------------------------------------------------------------------ write
const dirty = new Set();
let flushTimer = null;

export function remember(uid, channelId, { msgs, threads, cursor, oldestSeq }) {
  if (!channelId || !Array.isArray(msgs) || !msgs.length) return;
  const key = keyFor(uid, channelId);
  const snap = {
    key, v: VERSION, at: Date.now(), channelId,
    msgs: msgs.slice(-MAX_MSGS),
    threads: Array.isArray(threads) ? threads.slice(0, 400) : [],
    cursor: cursor || 0,
    oldestSeq: oldestSeq ?? null,
  };
  mem.set(key, snap);
  dirty.add(key);
  schedule();
}

// Fold a message that arrived after the page was cached into the stored page,
// so a phone that is killed and reopened shows the conversation as it was, not
// as it was when the channel was first opened.
export function note(uid, channelId, msg) {
  if (!msg?.id) return;
  const key = keyFor(uid, channelId);
  const snap = mem.get(key);
  if (!snap) return;
  if (snap.msgs.some((m) => m.id === msg.id)) return;
  snap.msgs.push(msg);
  if (snap.msgs.length > MAX_MSGS) snap.msgs = snap.msgs.slice(-MAX_MSGS);
  if (msg.seq) snap.cursor = Math.max(snap.cursor || 0, msg.seq);
  snap.at = Date.now();
  dirty.add(key);
  schedule();
}

// A message that was edited or deleted while the page is cached must not come
// back in its old form on the next cold start.
export function amend(uid, channelId, id, patch) {
  const snap = mem.get(keyFor(uid, channelId));
  if (!snap) return;
  const i = snap.msgs.findIndex((m) => m.id === id);
  if (i < 0) return;
  snap.msgs[i] = { ...snap.msgs[i], ...patch };
  dirty.add(snap.key);
  schedule();
}

// Writes are never on the path of a paint. 900ms of coalescing turns a burst of
// arriving messages into one transaction.
function schedule() {
  if (dead || flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = null; flush(); }, 900);
}

async function flush() {
  const keys = [...dirty];
  dirty.clear();
  if (!keys.length) return;
  try {
    await tx('readwrite', (s) => { for (const k of keys) { const v = mem.get(k); if (v) s.put(v); } });
    await evict();
  } catch { /* a cache that cannot be written is only a slower app */ }
}

async function evict() {
  try {
    const rows = await tx('readonly', (s) => s.getAll());
    if (!rows || rows.length <= MAX_CHANNELS) return;
    const doomed = rows.sort((a, z) => (a.at || 0) - (z.at || 0))
      .slice(0, rows.length - MAX_CHANNELS).map((r) => r.key);
    await tx('readwrite', (s) => { for (const k of doomed) s.delete(k); });
    for (const k of doomed) mem.delete(k);
  } catch { /* ignore */ }
}

// Signing out must take the cached conversations with it.
export async function wipe() {
  mem.clear();
  dirty.clear();
  try { await tx('readwrite', (s) => s.clear()); } catch { /* ignore */ }
}
