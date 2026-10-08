/* 硅谷掼蛋协会 · Socket.io 事件处理中心 */
const matchmaking   = require('./matchmaking');
const game          = require('./game');
const matchmaking6  = require('./matchmaking6');
const game6         = require('./game6');
const { startRoomMonitor } = require('./roomMonitor');
const rateGuard     = require('./rateGuard');
const onlineRegistry = require('./onlineRegistry');

module.exports = function(io) {

  /* ══════════ 六人赛事：独立命名空间 /g6（gdo6_ 表 + game6/matchmaking6）══════════ */
  const io6 = io.of('/g6');

  /* 全局房间守护：满12h且过半掉线 → 120s → 关闭（四人 io + 六人 io6）*/
  startRoomMonitor(io, io6);
  io6.on('connection', async function(socket) {
    /* 被封禁 IP 直接断开，不给任何操作机会 */
    if (await rateGuard.isBlocked(rateGuard.ipOf(socket))) { socket.disconnect(true); return; }
    socket.on('player:join', async function(data) {
      await onlineRegistry.join('6p', socket.id, { token: data.token || socket.id, name: data.name || '匿名玩家' });
      io6.emit('lobby:online_count', await onlineRegistry.count('6p'));
    });
    socket.on('ping:gd', function() { socket.emit('pong:gd', { ts: Date.now() }); });
    matchmaking6(io6, socket);
    game6(io6, socket);
    socket.on('disconnect', async function() {
      await onlineRegistry.leave('6p', socket.id);
      io6.emit('lobby:online_count', await onlineRegistry.count('6p'));
    });
    socket.emit('lobby:online_count', await onlineRegistry.count('6p'));
  });

  /* ══════════ 四人赛事：默认命名空间（原样不变）══════════ */
  io.on('connection', async function(socket) {

    /* 被封禁 IP 直接断开，不给任何操作机会 */
    if (await rateGuard.isBlocked(rateGuard.ipOf(socket))) { socket.disconnect(true); return; }

    /* ── 大厅在线人数 ── */
    socket.on('player:join', async function(data) {
      const info = { token: data.token || socket.id, name: data.name || '匿名玩家' };
      await onlineRegistry.join('4p', socket.id, info);
      const n = await onlineRegistry.count('4p');
      io.emit('lobby:online_count', n);
      console.log(`[掼蛋] ⚡ ${info.name} 上线 | 在线: ${n}`);
    });

    socket.on('ping:gd', function() {
      socket.emit('pong:gd', { ts: Date.now() });
    });

    /* ── 匹配 + 游戏模块 ── */
    matchmaking(io, socket);
    game(io, socket);

    /* ── 断线 ── */
    socket.on('disconnect', async function() {
      await onlineRegistry.leave('4p', socket.id);
      const n = await onlineRegistry.count('4p');
      io.emit('lobby:online_count', n);
      console.log(`[掼蛋] 💤 下线 | 在线: ${n}`);
    });

    socket.emit('lobby:online_count', await onlineRegistry.count('4p'));
  });

};
