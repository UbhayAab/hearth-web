// The last answer the server gave, kept on this phone so the app can OPEN with
// no network.
//
// WHY this exists. Without it, a cold start with no signal is worse than a blank
// screen: `api.table()` returns [] on error and `tryRpc` never throws, so
// `loadSpaces()` comes back empty, no active workspace is found, and the shell
// renders "You are not in a Space yet. Create one with + on the left, or open an
// invite link." To a volunteer standing in a village with no bars that reads as
// "I have been removed from my organisation" - not as "you are offline". The
// service worker caches the shell correctly, so the app opens and then lies
// about the account.
//
// So: remember the body of a handful of read-only calls - the bootstrap blob,
// the space list, the last page of a channel - and hand the same bytes back when
// the network is gone. Reads only. A write is never replayed from here; that is
// the outbox's job and it is deliberately a different mechanism.
//
// The key carries the signed-in user id, so a second person signing in on a
// shared phone can never be served the first person's Space list.

const DB_NAME = 'soop-reads';
const STORE = 'reads';
// A bootstrap blob for a 600-member Space is a few hundred KB. Two megabytes per
// record is generous and still bounded; anything larger is not worth the write.
const MAX_BYTES = 2_000_000;
// Enough for the boot blob, the space list and the last page of a dozen or so
// channels. Each channel costs four records (messages, threads, topics,
// bookmarks), so a ceiling of 24 would let a browse through six channels evict
// the bootstrap - and the bootstrap is the one record the cold start cannot do
// without. Hence both the higher ceiling AND `keep` below.
const MAX_RECORDS = 60;

let dbPromise = null;
let dead = false;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    let req;
    try { req = indexedDB.open(DB_NAME, 1); } catch { resolve(null); return; }
    // Some Android WebViews leave open() pending forever instead of erroring.
    // A cache we cannot reach is the same as no cache - give up quickly rather
    // than hold up the boot path we are here to speed along.
    const bail = setTimeout(() => resolve(null), 2500);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const s = db.createObjectStore(STORE, { keyPath: 'key' });
        s.createIndex('at', 'at');
      }
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

// A cheap stable hash. This keys a private on-device cache, so collision
// resistance matters far less than being fast and dependency-free.
function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export function keyFor(uid, method, url, body) {
  const u = new URL(url, 'http://x');
  return `${uid || 'anon'}|${method}|${u.pathname}${u.search}|${hash(String(body || ''))}`;
}

export async function read(key) {
  if (dead) return null;
  try { return (await tx('readonly', (s) => s.get(key))) || null; } catch { return null; }
}

export async function write(key, rec) {
  if (dead || !rec || typeof rec.body !== 'string') return;
  if (rec.body.length > MAX_BYTES) return;
  try {
    await tx('readwrite', (s) => s.put({ key, at: Date.now(), ...rec }));
    await evict();
  } catch { /* a cache that cannot be written is only a slower app */ }
}

// Oldest-out once the store grows past the ceiling, but records marked `keep`
// are evicted last. Bounded storage matters on a phone that is already short of
// it; losing the bootstrap to make room for a channel nobody reopens does not.
async function evict() {
  try {
    const keys = await tx('readonly', (s) => s.getAllKeys());
    if (!keys || keys.length <= MAX_RECORDS) return;
    const rows = await tx('readonly', (s) => s.getAll());
    const doomed = (rows || [])
      .sort((a, z) => (a.keep === z.keep ? (a.at || 0) - (z.at || 0) : (a.keep ? 1 : -1)))
      .slice(0, rows.length - MAX_RECORDS).map((r) => r.key);
    await tx('readwrite', (s) => { for (const k of doomed) s.delete(k); });
  } catch { /* ignore */ }
}

export async function wipe() {
  try { await tx('readwrite', (s) => s.clear()); } catch { /* ignore */ }
}
