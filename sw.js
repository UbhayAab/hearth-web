// Soop service worker.
//
// Rules that matter:
//  - Never cache Supabase (auth, realtime, RPC, storage). A stale message list or
//    a stale token is worse than no app at all.
//  - Never auto-activate a new bundle mid-conversation: the page asks first, then
//    posts SKIP_WAITING.
//  - The esm.sh dependencies are cached so the app opens offline instead of
//    hanging on a module import.
const VERSION = 'soop-v7';
const SHELL = VERSION + '-shell';
const VENDOR = VERSION + '-vendor';

const SHELL_FILES = [
  './',
  './index.html',
  './css/tokens.css',
  './css/base.css',
  './css/components.css',
  './css/layout.css',
  './css/messages.css',
  './css/panels.css',
  './css/features.css',
  './css/reading.css',
  './css/shell.css',
  // Injected by features/uxfix.js rather than linked from index.html, so it is
  // not discoverable by crawling the document - but it carries the touch-target
  // floor, the long-press menu layout and the contrast corrections. Without it
  // in the shell an offline cold start renders those wrong.
  './css/polish.css',
  './js/shell.js',
  './js/theme.js',
  './js/icons.js',
  './manifest.webmanifest',
  './js/main.js',
  './js/config.js',
  './js/util.js',
  './js/sb.js',
  './js/store.js',
  './js/api.js',
  './js/ui.js',
  './js/pwa.js',
  './js/features/index.js',
  // The outbox has to be reachable with no network - it is the module that
  // replays what the person wrote while they had none.
  './js/features/offline.js',
  // uxfix owns the long-press menu repair, the failed-load card, the members and
  // search panels and the keyboard wiring. Offline it is the difference between
  // a phone that says "could not load, try again" and one that shows a raw
  // exception where the conversation was, so it belongs in the shell too.
  './js/features/uxfix.js',
  './js/lib/outbox.js',
  './js/lib/readcache.js',
  // The last page of each channel is painted from here BEFORE the network is
  // touched, so it has to be in the shell or an offline cold start has nothing
  // to draw.
  './js/lib/pagecache.js',
  './js/core/auth.js',
  './js/core/workspace.js',
  './js/core/channels.js',
  './js/core/messages.js',
  './js/core/threads.js',
  './js/core/composer.js',
  './js/core/media.js',
  './js/core/emoji.js',
  './js/core/dms.js',
  './js/core/voice.js',
  './js/core/presence.js',
  './js/core/actions.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  // Do not sit in "waiting" behind the previous worker. Combined with
  // clients.claim() below, a deploy takes effect on the next load instead of the
  // load after that.
  self.skipWaiting();
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    // addAll fails the whole install if any single file 404s; add individually.
    await Promise.all(SHELL_FILES.map((f) => c.add(f).catch(() => {})));
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

const isSupabase = (url) =>
  url.hostname.endsWith('.supabase.co') || url.hostname.endsWith('.supabase.in');
const isVendor = (url) =>
  url.hostname === 'esm.sh' || url.hostname.endsWith('.esm.sh') || url.hostname === 'cdn.jsdelivr.net';

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Live data always goes to the network. No exceptions.
  if (isSupabase(url)) return;

  // Navigations: network first so a deploy is picked up, cache as the fallback.
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const c = await caches.open(SHELL);
        c.put('./index.html', fresh.clone());
        return fresh;
      } catch {
        return (await caches.match('./index.html')) || Response.error();
      }
    })());
    return;
  }

  // Vendored ES modules: cache first, they are versioned by URL.
  if (isVendor(url)) {
    e.respondWith((async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) (await caches.open(VENDOR)).put(req, res.clone());
      return res;
    })());
    return;
  }

  // Own assets.
  //
  // This used to be stale-while-revalidate, which serves the CACHED copy and
  // only refreshes it in the background. That meant every deploy took two loads
  // to reach anyone: the first showed yesterday's code, the second showed
  // today's. From the outside that is indistinguishable from the app being
  // broken and then "fixed by refreshing", and it is exactly what people
  // reported. Code and styles are small and this app is useless offline anyway,
  // so correctness beats the few milliseconds: go to the network first and fall
  // back to the cache only when there is no network.
  if (url.origin === self.location.origin) {
    const isCode = /\.(js|mjs|css|webmanifest)$/i.test(url.pathname);

    if (isCode) {
      e.respondWith((async () => {
        const cache = await caches.open(SHELL);
        try {
          // A short timeout keeps a dead-slow connection from hanging the app on
          // its own cached assets; whichever answers first wins.
          const net = await Promise.race([
            fetch(req, { cache: 'no-cache' }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 3500)),
          ]);
          if (net && net.ok) { cache.put(req, net.clone()); return net; }
          throw new Error('bad response');
        } catch {
          return (await cache.match(req)) || fetch(req).catch(() => Response.error());
        }
      })());
      return;
    }

    // Images, fonts and icons are content-addressed enough to serve from cache.
    e.respondWith((async () => {
      const cache = await caches.open(SHELL);
      const hit = await cache.match(req);
      const net = fetch(req).then((res) => {
        if (res.ok) cache.put(req, res.clone());
        return res;
      }).catch(() => null);
      return hit || (await net) || Response.error();
    })());
  }
});

// Web Push: the payload is minted by the web-push edge function.
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data?.json() || {}; } catch { d = { body: e.data?.text() || '' }; }
  const title = d.title || 'Soop';
  e.waitUntil(self.registration.showNotification(title, {
    body: d.body || '',
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    tag: d.tag || 'soop',
    data: d,
    renotify: true,
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = e.notification.data?.url || './';
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.includes(self.location.origin)) { await c.focus(); c.navigate?.(target); return; }
    }
    await self.clients.openWindow(target);
  })());
});
