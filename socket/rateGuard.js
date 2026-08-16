/* 硅谷掼蛋协会 · 反机器人限流守卫
 * 按【客户端 IP】统计"建房 / 随机参赛"频率，超阈值即判定为机器人：
 *   ① 立即踢出该 IP 在本命名空间下的所有连接；
 *   ② 临时封禁该 IP 一段时间，封禁期内再次连接/操作直接断开。
 * token 由客户端生成、可随意更换，故不作为主键；IP 更难伪造，作为主要识别依据。
 */

const WINDOW_MS = 60 * 1000;          // 统计窗口：最近 1 分钟
const LIMITS = {
  'room:create': 10,                  // 每分钟建房 ≥10 次 → 机器人
  'queue:join':  20                   // 每分钟随机参赛 ≥20 次 → 机器人
};
const BLOCK_MS = 10 * 60 * 1000;      // 命中后封禁该 IP 10 分钟

const hits         = new Map();       // ip -> { action -> [timestamps] }
const blockedUntil = new Map();       // ip -> 解封时间戳(ms)

/* 取 socket 的真实来源 IP（Render 等反代下取 x-forwarded-for 首个）*/
function ipOf(socket) {
  const h   = (socket && socket.handshake) || {};
  const xff = (h.headers && h.headers['x-forwarded-for']) || '';
  return xff.split(',')[0].trim() || h.address || (socket && socket.id) || '';
}

/* 内部机器人测试系统的虚拟客户端：握手带正确 botsecret → 豁免反机器人限流
   (10 个机器人共用 localhost 同一 IP，会误触发 queue:join 限流)。*/
function isBot(socket) {
  try {
    const q = socket && socket.handshake && socket.handshake.query;
    const secret = process.env.BOT_SECRET || 'guandan-botsim-2026';
    return !!(q && q.botsecret && q.botsecret === secret);
  } catch (e) { return false; }
}

function isBlocked(ip) {
  const until = blockedUntil.get(ip);
  if (!until) return false;
  if (Date.now() > until) { blockedUntil.delete(ip); return false; }
  return true;
}

function blockIp(ip) { if (ip) blockedUntil.set(ip, Date.now() + BLOCK_MS); }

/* 记录一次动作；返回 true=放行，false=应踢出(已封禁或本次刚触顶) */
function allow(ip, action) {
  if (isBlocked(ip)) return false;
  const limit = LIMITS[action];
  if (!limit) return true;
  const now = Date.now();
  let m = hits.get(ip);
  if (!m) { m = {}; hits.set(ip, m); }
  let arr = (m[action] || []).filter(function (t) { return now - t < WINDOW_MS; });
  arr.push(now);
  m[action] = arr;
  if (arr.length >= limit) { blockIp(ip); return false; }
  return true;
}

/* 踢掉某 IP 在该命名空间(ioNs 可为 Server 或 Namespace)下的所有连接 */
function kickIp(ioNs, ip, msg) {
  try {
    // Server: ioNs.sockets 是默认 Namespace，其 .sockets 才是 Map；Namespace: ioNs.sockets 即 Map
    const bag = ioNs && ioNs.sockets;
    const sockets = bag && bag.sockets ? bag.sockets : bag;
    if (!sockets || typeof sockets.forEach !== 'function') return;
    sockets.forEach(function (s) {
      if (ipOf(s) === ip) {
        try { s.emit('security:kick', { message: msg || '检测到异常操作，已被系统限制，请稍后再试' }); } catch (e) {}
        try { s.disconnect(true); } catch (e) {}
      }
    });
  } catch (e) { /* 静默：安全措施不得影响主流程 */ }
}

/* 周期清理过期数据，防止内存无限增长 */
const _sweep = setInterval(function () {
  const now = Date.now();
  for (const [ip, until] of blockedUntil) if (now > until) blockedUntil.delete(ip);
  for (const [ip, m] of hits) {
    let empty = true;
    for (const a in m) {
      m[a] = (m[a] || []).filter(function (t) { return now - t < WINDOW_MS; });
      if (m[a].length) empty = false;
    }
    if (empty) hits.delete(ip);
  }
}, WINDOW_MS);
if (_sweep && typeof _sweep.unref === 'function') _sweep.unref();

module.exports = { ipOf, isBot, isBlocked, allow, kickIp, blockIp, LIMITS };
