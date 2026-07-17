/* 硅谷掼蛋协会 · Socket.io 事件处理中心 */
const matchmaking  = require('./matchmaking');
const game         = require('./game');
const matchmaking6 = require('./matchmaking6');
const game6        = require('./game6');
const { startRoomMonitor } = require('./roomMonitor');

const onlinePlayers  = new Map();
const onlinePlayers6 = new Map();

module.exports = function(io) {

  /* ══════════ 六人赛事：独立命名空间 /g6（gdo6_ 表 + game6/matchmaking6）══════════ */
  const io6 = io.of('/g6');

  /* 全局房间守护：满12h且过半掉线 → 120s → 关闭（四人 io + 六人 io6）*/
  startRoomMonitor(io, io6);
  io6.on('connection', function(socket) {
    socket.on('player:join', function(data) {
      onlinePlayers6.set(socket.id, { token: data.token || socket.id, name: data.name || '匿名玩家' });
      io6.emit('lobby:online_count', onlinePlayers6.size);
    });
    socket.on('ping:gd', function() { socket.emit('pong:gd', { ts: Date.now() }); });
    matchmaking6(io6, socket);
    game6(io6, socket);
    socket.on('disconnect', function() {
      onlinePlayers6.delete(socket.id);
      io6.emit('lobby:online_count', onlinePlayers6.size);
    });
    socket.emit('lobby:online_count', onlinePlayers6.size);
  });

  /* ══════════ 四人赛事：默认命名空间（原样不变）══════════ */
  io.on('connection', function(socket) {

    /* ── 大厅在线人数 ── */
    socket.on('player:join', function(data) {
      onlinePlayers.set(socket.id, {
        token: data.token || socket.id,
        name:  data.name  || '匿名玩家'
      });
      io.emit('lobby:online_count', onlinePlayers.size);
      console.log(`[掼蛋] ⚡ ${data.name || '?'} 上线 | 在线: ${onlinePlayers.size}`);
    });

    socket.on('ping:gd', function() {
      socket.emit('pong:gd', { ts: Date.now() });
    });

    /* ── 匹配 + 游戏模块 ── */
    matchmaking(io, socket);
    game(io, socket);

    /* ── 断线 ── */
    socket.on('disconnect', function() {
      const p = onlinePlayers.get(socket.id);
      onlinePlayers.delete(socket.id);
      io.emit('lobby:online_count', onlinePlayers.size);
      if (p) console.log(`[掼蛋] 💤 ${p.name} 下线 | 在线: ${onlinePlayers.size}`);
    });

    socket.emit('lobby:online_count', onlinePlayers.size);
  });

};
