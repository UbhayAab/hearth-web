// The durable outbox: unsent messages, on this phone, surviving the tab.
//
// WHY this is not a JS array. A send today lives in a closure and a DOM node.
// Android kills backgrounded PWAs hard - Xiaomi and Samsung are the two worst
// offenders and they are most of this user base's phones - so switching to the
// camera and coming back loses a field report that the person believes they
// sent. Nothing about that is recoverable, and it is the single failure that
// makes people stop trusting an app. So the record hits disk BEFORE the network
// is touched and is only deleted once Postgres has answered.
//
// IndexedDB is the store because it is the only one with room for attachment
// metadata and no synchronous main-thread cost. localStorage is the fallback for
// private-mode WebViews where indexedDB.open throws or hangs; it is small and
// synchronous but a handful of queued messages fits, and losing the queue is
// worse than blocking for a millisecond.

const DB_NAME = 'soop-outbox';
const STORE = 'sends';
const LS_KEY = 'soop.outbox.v1';

// ------------------------------------------------------------------ backend
let dbPromise = null;
let useLocal = false;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, 1);
    } catch {
      resolve(null);                    // private mode / disabled storage
      return;
    }
    // Some Android WebViews leave open() pending forever rather than erroring.
    // A queue we cannot reach is the same as no queue, so give up and fall back.
    const bail = setTimeout(() => resolve(null), 3000);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'nonce' });
    };
    req.onsuccess = () => { clearTimeout(bail); resolve(req.result); };
    req.onerror = () => { clearTimeout(bail); resolve(null); };
    req.onblocked = () => { clearTimeout(bail); resolve(null); };
  }).then((db) => {
    if (!db) useLocal = true;
    return db;
  });
  return dbPromise;
}

function tx(mode, fn) {
  return openDb().then((db) => {
    if (!db) return null;
    return new Promise((resolve, reject) => {
      let t;
      try { t = db.transaction(STORE, mode); } catch (e) { reject(e); return; }
      const store = t.objectStore(STORE);
      let out;
      try { out = fn(store); } catch (e) { reject(e); return; }
      t.oncomplete = () => resolve(out && 'result' in out ? out.result : out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  });
}

// ------------------------------------------------------------------ localStorage fallback
function lsAll() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch { return []; }
}
function lsWrite(rows) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(rows)); } catch { /* full: keep RAM copy */ }
}

// A last-resort mirror so the queue still works for the current session even if
// BOTH stores are refused. Never the primary path.
const mem = new Map();

// ------------------------------------------------------------------ api
export async function put(rec) {
  mem.set(rec.nonce, rec);
  try {
    if (!useLocal) {
      const done = await tx('readwrite', (s) => s.put(rec));
      if (done !== null) return rec;
    }
  } catch { useLocal = true; }
  const rows = lsAll().filter((r) => r.nonce !== rec.nonce);
  rows.push(rec);
  lsWrite(rows);
  return rec;
}

export async function del(nonce) {
  mem.delete(nonce);
  try {
    if (!useLocal) {
      const done = await tx('readwrite', (s) => s.delete(nonce));
      if (done !== null) return;
    }
  } catch { useLocal = true; }
  lsWrite(lsAll().filter((r) => r.nonce !== nonce));
}

export async function all() {
  try {
    if (!useLocal) {
      const rows = await tx('readonly', (s) => s.getAll());
      if (rows !== null) return (rows || []).slice().sort(byAge);
    }
  } catch { useLocal = true; }
  const rows = lsAll();
  if (rows.length) return rows.slice().sort(byAge);
  return [...mem.values()].sort(byAge);
}

export async function get(nonce) {
  return (await all()).find((r) => r.nonce === nonce) || null;
}

export async function clear() {
  mem.clear();
  try { if (!useLocal) await tx('readwrite', (s) => s.clear()); } catch { /* fall through */ }
  lsWrite([]);
}

// Oldest first. A conversation replayed out of order reads as nonsense, and the
// server assigns seq at insert time, so the flush order IS the message order.
const byAge = (a, z) => (a.created_at || 0) - (z.created_at || 0);

export const usingFallback = () => useLocal;
