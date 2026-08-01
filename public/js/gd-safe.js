/* 硅谷掼蛋协会 · 全机型兼容底座（必须最先加载）
 * 目标：让华为浏览器 / 鸿蒙 ArkWeb / 安卓无痕 / 微信内置浏览器等
 *      "存储被禁 → 访问 localStorage 抛异常 → 整页脚本中断 → 永远转圈进不去"
 *      这一类问题彻底消失；并让任何运行时错误在屏幕上可见（华为机没法插电脑调试）。
 */
(function () {
  'use strict';

  /* ── 1) 永不抛异常的存储：localStorage 不可用时自动降级到内存 ── */
  var _mem = {};
  function _rawGet(k) {
    try { return window.localStorage.getItem(k); } catch (e) { return (k in _mem) ? _mem[k] : null; }
  }
  function _rawSet(k, v) {
    try { window.localStorage.setItem(k, v); } catch (e) { _mem[k] = String(v); }
  }
  window.gdLS = {
    get: function (k, dflt) { var v = _rawGet(k); return (v === null || v === undefined) ? (dflt === undefined ? '' : dflt) : v; },
    set: function (k, v) { _rawSet(k, v); return v; }
  };

  /* ── 2) 屏幕可见错误面板：把白屏/静默错误变成能看见、能截图的提示 ── */
  var _shown = false;
  window.gdReportError = function (msg) {
    try {
      if (_shown) return;
      _shown = true;
      var box = document.createElement('div');
      box.id = 'gd-error-panel';
      box.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;' +
        'background:#7a0010;color:#fff;padding:14px 16px;font-size:13px;line-height:1.6;' +
        'font-family:-apple-system,PingFang SC,sans-serif;box-shadow:0 -4px 18px rgba(0,0,0,.4);';
      box.innerHTML =
        '<div style="font-weight:800;margin-bottom:4px;">⚠ 页面遇到问题（请截图反馈）</div>' +
        '<div id="gd-error-msg" style="word-break:break-all;opacity:.9;"></div>' +
        '<div style="margin-top:10px;display:flex;gap:10px;">' +
          '<button id="gd-error-reload" style="flex:1;padding:9px;border:none;border-radius:8px;' +
            'background:#fff;color:#7a0010;font-weight:800;font-size:14px;">🔄 重新加载</button>' +
          '<button id="gd-error-close" style="padding:9px 14px;border:1px solid rgba(255,255,255,.5);' +
            'border-radius:8px;background:transparent;color:#fff;font-size:14px;">关闭</button>' +
        '</div>';
      var mount = function () {
        if (!document.body) { setTimeout(mount, 60); return; }
        document.body.appendChild(box);
        document.getElementById('gd-error-msg').textContent = String(msg || '未知错误');
        document.getElementById('gd-error-reload').onclick = function () { location.reload(); };
        document.getElementById('gd-error-close').onclick = function () { box.remove(); _shown = false; };
      };
      mount();
    } catch (e) { /* 报错面板本身绝不能再抛 */ }
  };

  window.addEventListener('error', function (e) {
    var m = (e && e.message) || 'script error';
    if (e && e.filename) m += ' @ ' + e.filename + ':' + (e.lineno || '?');
    window.gdReportError('脚本错误：' + m);
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    window.gdReportError('异步错误：' + ((r && (r.message || r)) || '未知'));
  });

  /* ── 3) 连接看门狗：N 秒内没连上 socket，就显示可见的"连接失败+重试"，绝不无声转圈 ── */
  window.gdConnGuard = function (socket, opts) {
    opts = opts || {};
    var ms = opts.timeout || 12000;
    var overlayId = opts.overlayId || 'loading-overlay';   // 连上后由业务逻辑负责隐藏
    var done = false;
    function ok() { done = true; }
    socket.on('connect', ok);

    var t = setTimeout(function () {
      if (done || socket.connected) return;
      window.gdReportError('连接服务器超时：请检查网络，或换用系统自带浏览器打开（避免用微信/QQ内置浏览器）。');
    }, ms);

    var errN = 0;
    socket.on('connect_error', function (err) {
      errN++;
      if (done || socket.connected) return;
      if (errN === 2) {   // 首次抖动不打扰，连续失败才提示
        window.gdReportError('无法连接服务器（' + ((err && err.message) || 'connect_error') +
          '）。请检查网络，或换用系统浏览器打开本页面。');
      }
    });
    return { cancel: function () { clearTimeout(t); done = true; } };
  };
})();
