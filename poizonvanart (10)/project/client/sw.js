/**
 * PoizonVanart · Service Worker
 * Принудительная очистка старых кэшей и прямой проброс в сеть.
 */
self.addEventListener('install', (evt) => {
  self.skipWaiting();
});

self.addEventListener('activate', (evt) => {
  evt.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (evt) => {
  // Прямой запрос к сети, без промежуточного кэширования JS/CSS
  evt.respondWith(fetch(evt.request));
});
