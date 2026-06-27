/* 硅谷掼蛋协会 · Service Worker v2 · 网上赛事版 */
var CACHE = 'gd-pwa-v2';

var PRECACHE = [
  '/manifest.json',
  '/css/style.css',
  '/img/assoc-logo.png',
  '/img/guandan-icon.png',
  '/ot-staff/tournaments-online',
  '/ot-staff/tournaments-4p',
  '/ot-staff/tournaments-6p',
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
  /* Socket.io 和 API 请求不缓存 */
  if (e.request.url.indexOf('/socket.io') !== -1) return;
  if (e.request.url.indexOf('/api/') !== -1) return;
  if (e.request.method !== 'GET') return;

  e.respondWith(
    fetch(e.request).then(function(r) {
      /* 只缓存成功的同源响应 */
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
