// Tombstone for the service worker that used to run Soop at this path.
//
// A browser that installed the app here keeps this worker alive and keeps
// serving the old bundle from its cache, so the redirect in index.html would
// never be reached. This worker exists only to take itself out: it drops every
// cache it owns, unregisters, and reloads any client it controls, which then
// gets the redirect and lands on the new location.
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) await caches.delete(key);
    await self.registration.unregister();
    for (const client of await self.clients.matchAll({ type: 'window' })) {
      client.navigate(client.url);
    }
  })());
});
