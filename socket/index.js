/* 硅谷掼蛋协会 · Socket.io 事件处理中心 */
const matchmaking = require('./matchmaking');

/* 在线玩家表：socketId -> { token, name } */
const onlinePlayers = new Map();

module.exports = function(io) {

  io.on('connection', function(socket) {

    /* ── 玩家上线 ── */
    socket.on('player:join', function(data) {
      onlinePlayers.set(socket.id, {
        token: data.token || socket.id,
        name: data.name || '匿名玩家'
      });
      io.emit('lobby:online_count', onlinePlayers.size);
      console.log(`[掼蛋] ⚡ ${data.name || '?'} 上线 | 在线: ${onlinePlayers.size}`);
    });

    /* ── 心跳 ── */
    socket.on('ping:gd', function() {
      socket.emit('pong:gd', { ts: Date.now() });
    });

    /* ── 挂载匹配系统 ── */
    matchmaking(io, socket);

    /* ── 断线（matchmaking 内也有 disconnect，此处更新在线人数） ── */
    socket.on('disconnect', function() {
      const p = onlinePlayers.get(socket.id);
      onlinePlayers.delete(socket.id);
      io.emit('lobby:online_count', onlinePlayers.size);
      if (p) console.log(`[掼蛋] 💤 ${p.name} 下线 | 在线: ${onlinePlayers.size}`);
    });

    /* 新连接立即推送当前在线人数 */
    socket.emit('lobby:online_count', onlinePlayers.size);
  });

};
