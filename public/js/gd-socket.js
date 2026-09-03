/* 硅谷掼蛋协会 · Socket.io 客户端公共模块 */
(function() {

  /* ── 永不抛异常的存储（华为/鸿蒙/无痕/微信内置浏览器禁存储时降级到内存）── */
  var _mem = {};
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return (k in _mem) ? _mem[k] : null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { _mem[k] = String(v); } }

  /* ── 玩家身份（跨页面保持） ── */
  function getToken() {
    var t = lsGet('gd-token');
    if (!t) {
      t = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      lsSet('gd-token', t);
    }
    return t;
  }

  function getName() {
    var n = lsGet('gd-name');
    if (!n) {
      n = '玩家' + Math.floor(Math.random() * 9000 + 1000);
      lsSet('gd-name', n);
    }
    return n;
  }

  /* ── 访问渠道（来源）：微信内置浏览器 / 扫码进入 / 普通网页 ── */
  function getChannel() {
    try {
      var ua = navigator.userAgent || '';
      if (/MicroMessenger/i.test(ua)) return 'wechat';
      var q = location.search || '';
      if (/[?&](join|code)=/.test(q) || /\/play\/join/.test(document.referrer || '')) return 'qr';
      return 'web';
    } catch (e) { return 'web'; }
  }

  /* ── 连接（channel 随握手 query 上报，服务端据此写 gdo_players.source）
     先轮询后升级：受限移动网 / 华为浏览器直连 WebSocket 易挂起，轮询优先更稳 ── */
  var socket = io({ transports: ['polling', 'websocket'], query: { channel: getChannel() } });

  socket.on('connect', function() {
    socket.emit('player:join', { token: getToken(), name: getName() });
  });

  /* 连接持续失败 → 屏幕可见提示（gd-safe.js 提供），绝不无声卡住 */
  var _connErr = 0;
  socket.on('connect_error', function(err) {
    _connErr++;
    if (_connErr === 3 && !socket.connected && window.gdReportError) {
      window.gdReportError('无法连接服务器（' + ((err && err.message) || 'connect_error') +
        '）。请检查网络，或换用系统自带浏览器打开（避免微信/QQ内置浏览器）。');
    }
  });

  /* ── 更新在线人数显示 ── */
  socket.on('lobby:online_count', function(count) {
    var el = document.getElementById('gd-online-count');
    if (el) el.textContent = count;
  });

  /* 是否已由玩家主动设置过名字（首次强制起名的判据）*/
  function hasName() { return lsGet('gd-name-set') === '1'; }

  /* ── 首次进入赛事：强制弹窗让玩家给自己起名字（4人/6人一致）──
     · 强制：名字为空不放行，必须输入才能进入赛事；
     · 记忆：设置后写 gd-name + gd-name-set='1'，第二次起直接沿用，不再弹窗；
     · 多处触发共用同一弹窗：回调排队，确定后统一回调（避免自动匹配等场景丢回调）。*/
  var _nameCbs = [];
  function showNameModal(cb) {
    if (cb) _nameCbs.push(cb);
    if (document.getElementById('gd-name-modal')) return;   // 已在显示：cb 已入队，等确定后一起回调
    var wrap = document.createElement('div');
    wrap.id = 'gd-name-modal';
    wrap.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.72);' +
      'backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);display:flex;' +
      'align-items:center;justify-content:center;padding:20px;';
    wrap.innerHTML =
      '<div style="background:linear-gradient(145deg,#12324a,#0a2033);border:1px solid rgba(212,172,13,.35);' +
        'border-radius:20px;padding:26px 24px;max-width:340px;width:100%;text-align:center;' +
        'box-shadow:0 12px 40px rgba(0,0,0,.5);">' +
        '<div style="font-size:1.15rem;font-weight:900;color:#FFE066;letter-spacing:2px;margin-bottom:6px;">请输入您的昵称</div>' +
        '<div style="font-size:.78rem;color:rgba(255,255,255,.55);margin-bottom:18px;">必须填写才能加入赛事，队友和对手在牌桌上会看到它</div>' +
        '<input id="gd-name-input" type="text" maxlength="12" placeholder="输入昵称，如：老王 / Karen" ' +
          'style="width:100%;padding:12px 14px;border-radius:10px;border:1px solid rgba(255,255,255,.25);' +
          'background:rgba(255,255,255,.08);color:#fff;font-size:1rem;text-align:center;outline:none;' +
          'box-sizing:border-box;margin-bottom:8px;">' +
        '<div id="gd-name-err" style="min-height:16px;font-size:.74rem;color:#ff8080;margin-bottom:8px;"></div>' +
        '<button id="gd-name-ok" style="width:100%;padding:13px;border-radius:12px;border:none;cursor:pointer;' +
          'background:linear-gradient(135deg,#E8A020,#A86800);color:#fff;font-size:1rem;font-weight:800;' +
          'letter-spacing:2px;">确定，进入赛事</button>' +
      '</div>';
    document.body.appendChild(wrap);
    var input = document.getElementById('gd-name-input');
    var ok = document.getElementById('gd-name-ok');
    var err = document.getElementById('gd-name-err');
    setTimeout(function(){ try { input.focus(); } catch (e) {} }, 100);
    function done() {
      var v = (input.value || '').trim().replace(/\s+/g, ' ').slice(0, 12);
      if (!v) {                       // 强制：留空不放行
        err.textContent = '⚠️ 请输入你的名字后再进入赛事';
        try { input.focus(); } catch (e) {}
        return;
      }
      lsSet('gd-name', v);
      lsSet('gd-name-set', '1');
      try { if (socket && socket.connected) socket.emit('player:join', { token: getToken(), name: v }); } catch (e) {}
      wrap.remove();
      var cbs = _nameCbs.slice(); _nameCbs = [];
      cbs.forEach(function(f){ try { f(v); } catch (e) {} });
    }
    ok.onclick = done;
    input.addEventListener('input', function(){ err.textContent = ''; });
    input.addEventListener('keydown', function(e){ if (e.key === 'Enter') done(); });
  }

  /* 已设置过名字 → 直接回调（第二次起沿用记忆名）；否则强制弹窗，输入有效名字后再回调 */
  function ensureName(cb) {
    cb = cb || function(){};
    if (hasName()) { cb(getName()); return; }
    if (document.body) showNameModal(cb);
    else document.addEventListener('DOMContentLoaded', function(){ showNameModal(cb); });
  }

  /* 挂到全局供页面扩展使用 */
  window.gdSocket = socket;
  window.gdGetName = getName;
  window.gdGetToken = getToken;
  window.gdChannel = getChannel;
  window.gdEnsureName = ensureName;
  window.gdShowNameModal = showNameModal;
  window.gdHasName = hasName;

})();
