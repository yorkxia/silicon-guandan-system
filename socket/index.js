/* 硅谷掼蛋协会 · Socket.io 事件处理中心 */

/* 在线玩家表：socketId -> { token, name, joinedAt } */
const onlinePlayers = new Map();

module.exports = function(io) {

  io.on('connection', function(socket) {

    /* ── 玩家上线 ── */
    socket.on('player:join', function(data) {
      const player = {
        token: data.token || socket.id,
        name: data.name || ('玩家' + socket.id.slice(0, 4)),
        joinedAt: Date.now()
      };
      onlinePlayers.set(socket.id, player);

      /* 通知所有人在线人数变化 */
      io.emit('lobby:online_count', onlinePlayers.size);

      console.log(`[掼蛋] ⚡ ${player.name} 上线 | 在线: ${onlinePlayers.size}`);
    });

    /* ── 玩家下线 ── */
    socket.on('disconnect', function() {
      const player = onlinePlayers.get(socket.id);
      onlinePlayers.delete(socket.id);
      io.emit('lobby:online_count', onlinePlayers.size);

      if (player) {
        console.log(`[掼蛋] 💤 ${player.name} 下线 | 在线: ${onlinePlayers.size}`);
      }
    });

    /* ── 心跳检测 ── */
    socket.on('ping:gd', function() {
      socket.emit('pong:gd', { ts: Date.now() });
    });

    /* 新连接立即推送当前在线人数 */
    socket.emit('lobby:online_count', onlinePlayers.size);
  });

};
