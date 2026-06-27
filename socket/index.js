/* 硅谷掼蛋协会 · Socket.io 事件处理中心 */
const matchmaking = require('./matchmaking');
const game        = require('./game');

const onlinePlayers = new Map();

module.exports = function(io) {

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
