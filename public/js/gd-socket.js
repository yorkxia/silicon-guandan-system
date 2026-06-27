/* 硅谷掼蛋协会 · Socket.io 客户端公共模块 */
(function() {

  /* ── 玩家身份（存 localStorage，跨页面保持） ── */
  function getToken() {
    var t = localStorage.getItem('gd-token');
    if (!t) {
      t = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      localStorage.setItem('gd-token', t);
    }
    return t;
  }

  function getName() {
    var n = localStorage.getItem('gd-name');
    if (!n) {
      n = '玩家' + Math.floor(Math.random() * 9000 + 1000);
      localStorage.setItem('gd-name', n);
    }
    return n;
  }

  /* ── 连接 ── */
  var socket = io({ transports: ['websocket', 'polling'] });

  socket.on('connect', function() {
    socket.emit('player:join', { token: getToken(), name: getName() });
  });

  /* ── 更新在线人数显示 ── */
  socket.on('lobby:online_count', function(count) {
    var el = document.getElementById('gd-online-count');
    if (el) el.textContent = count;
  });

  /* 挂到全局供页面扩展使用 */
  window.gdSocket = socket;
  window.gdGetName = getName;
  window.gdGetToken = getToken;

})();
