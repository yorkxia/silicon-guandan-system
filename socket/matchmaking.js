/* 网上掼蛋 · 匹配系统 Socket 事件 */
const { query } = require('../db/init');
const {
  getOrCreatePlayer,
  joinQueue, tryMatch, createMatch,
  joinRoomByCode, getRoomState, createRoom
} = require('../db/gdo');
const { createDoubleDeck, shuffle, deal4, sortHand } = require('../utils/cards');
const { initGameState } = require('./game');

module.exports = function(io, socket) {

  /* ═══════════════════════════════════════════════
   * 随机匹配
   * ═══════════════════════════════════════════════ */

  socket.on('queue:join', async function(data) {
    try {
      const { token, name, mode } = data;
      const player = await getOrCreatePlayer(token, name);

      /* 如果玩家已在某个进行中的房间，拒绝排队 */
      const activeRoom = await query(
        `SELECT r.room_code FROM gdo_rooms r
         JOIN gdo_seats s ON s.room_id = r.id
         WHERE s.player_id=$1 AND r.status IN ('waiting','playing')
         LIMIT 1`,
        [player.id]
      );
      if (activeRoom.length) {
        return socket.emit('room:already', { roomCode: activeRoom[0].room_code });
      }

      await joinQueue(player.id, token, mode, socket.id);
      socket.emit('queue:joined', { name: player.display_name });

      const entries = await tryMatch(mode);
      if (entries) {
        const room = await createMatch(entries, mode);
        for (const e of entries) {
          io.to(e.socket_id).emit('match:found', { roomCode: room.room_code });
        }
      }
    } catch (e) {
      console.error('[queue:join]', e.message);
      socket.emit('queue:error', { message: '匹配时发生错误，请重试' });
    }
  });

  socket.on('queue:cancel', async function(data) {
    try {
      const player = await getOrCreatePlayer(data.token, '');
      await query(
        `UPDATE gdo_queue SET status='cancelled' WHERE player_id=$1 AND status='waiting'`,
        [player.id]
      );
      socket.emit('queue:cancelled');
    } catch (e) {
      console.error('[queue:cancel]', e.message);
    }
  });

  /* ═══════════════════════════════════════════════
   * 私人房间
   * ═══════════════════════════════════════════════ */

  socket.on('room:create', async function(data) {
    try {
      const { token, name, mode } = data;
      const player = await getOrCreatePlayer(token, name);
      const room = await createRoom(mode, 'private');
      const result = await joinRoomByCode(room.room_code, player.id, socket.id);
      if (result.error) return socket.emit('room:error', { message: result.error });

      socket.join(room.room_code);
      const state = await getRoomState(room.room_code);
      socket.emit('room:joined', { roomCode: room.room_code, state });
    } catch (e) {
      console.error('[room:create]', e.message);
      socket.emit('room:error', { message: '创建房间失败' });
    }
  });

  socket.on('room:join', async function(data) {
    try {
      const { token, name, roomCode } = data;
      if (!roomCode) return socket.emit('room:error', { message: '请输入房间号' });
      const player = await getOrCreatePlayer(token, name);
      const code = roomCode.trim().toUpperCase();
      const result = await joinRoomByCode(code, player.id, socket.id);
      if (result.error) return socket.emit('room:error', { message: result.error });

      socket.join(code);
      const state = await getRoomState(code);
      io.to(code).emit('room:update', { state });
      socket.emit('room:joined', { roomCode: code, state });
    } catch (e) {
      console.error('[room:join]', e.message);
      socket.emit('room:error', { message: '加入房间失败' });
    }
  });

  socket.on('room:leave', async function(data) {
    try {
      const { roomCode } = data;
      await query(`UPDATE gdo_seats SET is_connected=FALSE WHERE socket_id=$1`, [socket.id]);
      socket.leave(roomCode);
      const state = await getRoomState(roomCode);
      if (state) io.to(roomCode).emit('room:update', { state });
    } catch (e) {
      console.error('[room:leave]', e.message);
    }
  });

  socket.on('room:ready', async function(data) {
    try {
      const { roomCode } = data;
      await query(`UPDATE gdo_seats SET is_ready=TRUE WHERE socket_id=$1`, [socket.id]);
      const state = await getRoomState(roomCode);
      if (!state) return;
      io.to(roomCode).emit('room:update', { state });

      const need = state.room.game_mode === '6p' ? 6 : 4;
      if (state.seats.length === need && state.seats.every(s => s.is_ready)) {
        /* ── 发牌 ── */
        const deck   = shuffle(createDoubleDeck());
        const halves = deal4(deck); // 4份各27张（6p暂与4p相同处理）
        const newRound = parseInt(state.room.round_count || 0) + 1;

        /* 建局记录，hands_json 按 player_id 存储 */
        const hands = {};
        state.seats.forEach((s, i) => { hands[String(s.player_id)] = halves[i]; });

        const rows = await query(
          `INSERT INTO gdo_rounds(room_id, round_number, hands_json)
           VALUES($1,$2,$3) RETURNING id`,
          [state.room.id, newRound, JSON.stringify(hands)]
        );
        const roundId = rows[0].id;
        await query(
          `UPDATE gdo_rooms SET status='playing', started_at=NOW(), round_count=$1 WHERE room_code=$2`,
          [newRound, roomCode]
        );

        /* 初始化内存游戏状态 */
        const sortedSeats = [...state.seats].sort((a, b) => a.seat - b.seat);
        const seatObjs = sortedSeats.map(s => ({
          seat: s.seat, team: s.team,
          playerId: s.player_id, name: s.display_name
        }));
        initGameState(
          roomCode, roundId, state.room.id,
          seatObjs, hands,
          state.room.level_team1, state.room.level_team2,
          state.room.game_mode
        );

        /* 通知每位玩家游戏开始 */
        io.to(roomCode).emit('game:starting', { roomCode, roundId });
        console.log(`[掼蛋] 🃏 发牌完成 · 房间 ${roomCode} · 第${newRound}局 · 每人27张`);
      }
    } catch (e) {
      console.error('[room:ready]', e.message);
    }
  });

  /* ─── 断线处理（同时清理队列和座位在线状态） ─── */
  socket.on('disconnect', async function() {
    try {
      await query(`UPDATE gdo_seats SET is_connected=FALSE WHERE socket_id=$1`, [socket.id]);
      await query(
        `UPDATE gdo_queue SET status='cancelled' WHERE socket_id=$1 AND status='waiting'`,
        [socket.id]
      );
    } catch (e) {}
  });
};
