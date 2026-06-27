/* 硅谷掼蛋协会 · Service Worker v3 · 网上赛事版 */
var CACHE = 'gd-pwa-v3';

var PRECACHE = [
  '/manifest.json',
  '/css/style.css',
  '/img/assoc-logo.png',
  '/img/guandan-icon.png',
  '/play',
  '/play/4p',
  '/play/6p',
  '/install',
  '/guandan'
];

/* 安装：预缓存核心资源 */
self.addEventListener('install', function(e) {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(function(c) {
      return c.addAll(PRECACHE).catch(function(){});
    })
  );
});

/* 激活：清除旧版缓存 */
self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE; })
            .map(function(k) { return caches.delete(k); })
      );
    }).then(function() { return self.clients.claim(); })
  );
});

/* 拦截请求：网络优先，离线降级到缓存 */
self.addEventListener('fetch', function(e) {
  if (e.request.url.indexOf('/socket.io') !== -1) return;
  if (e.request.url.indexOf('/api/') !== -1) return;
  if (e.request.method !== 'GET') return;

  e.respondWith(
    fetch(e.request).then(function(r) {
      if (r && r.status === 200 && r.type === 'basic') {
        var rc = r.clone();
        caches.open(CACHE).then(function(c) { c.put(e.request, rc); });
      }
      return r;
    }).catch(function() {
      return caches.match(e.request);
    })
  );
});
