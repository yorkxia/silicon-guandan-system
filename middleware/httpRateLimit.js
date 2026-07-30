/* 轻量级 HTTP 限流（内存版，无需额外依赖）
 * 按【客户端 IP】在滑动窗口内限制某类请求次数，防止：
 *   · 报名接口被灌垃圾数据；
 *   · /api/gd/register 每次调用都会发确认邮件 → 被用来做邮件轰炸。
 * 用法：app.post(path, rateLimit({ windowMs, max }), handler)
 */
function rateLimit(opts) {
  opts = opts || {};
  const windowMs = opts.windowMs || 10 * 60 * 1000;  // 默认 10 分钟窗口
  const max      = opts.max      || 20;              // 默认每窗口 20 次
  const message  = opts.message  || '操作过于频繁，请稍后再试 | Too many requests, please try again later';
  const hits = new Map();   // ip -> [timestamps]

  // 周期清理，避免内存增长
  const sweep = setInterval(function () {
    const now = Date.now();
    for (const [ip, arr] of hits) {
      const kept = arr.filter(function (t) { return now - t < windowMs; });
      if (kept.length) hits.set(ip, kept); else hits.delete(ip);
    }
  }, windowMs);
  if (sweep && typeof sweep.unref === 'function') sweep.unref();

  return function (req, res, next) {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'unknown';
    const now = Date.now();
    const arr = (hits.get(ip) || []).filter(function (t) { return now - t < windowMs; });
    if (arr.length >= max) {
      res.status(429);
      // 表单提交回退到 flash+重定向；API 返回 JSON
      if (req.path && req.path.indexOf('/api/') === 0) return res.json({ ok: false, error: message });
      if (req.flash) req.flash('error', message);
      return res.redirect(req.get('referer') || '/');
    }
    arr.push(now);
    hits.set(ip, arr);
    next();
  };
}

module.exports = { rateLimit };
