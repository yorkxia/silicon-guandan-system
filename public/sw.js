/* 硅谷掼蛋协会 · Service Worker v1 */
var CACHE = 'gd-pwa-v1';

self.addEventListener('install', function(e) {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(function(c) {
      return c.addAll(['/guandan', '/img/guandan-icon.png', '/manifest.json']).catch(function(){});
    })
  );
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(keys.filter(function(k){ return k !== CACHE; }).map(function(k){ return caches.delete(k); }));
    }).then(function(){ return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function(e) {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).then(function(r) {
      var rc = r.clone();
      caches.open(CACHE).then(function(c) { c.put(e.request, rc); });
      return r;
    }).catch(function() {
      return caches.match(e.request);
    })
  );
});
