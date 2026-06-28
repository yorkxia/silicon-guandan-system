/* 网上掼蛋 · 匹配系统 Socket 事件 */
const { query } = require('../db/init');
const {
  getOrCreatePlayer, createRoom, findOrCreateOpenRoom,
  joinRoomByCode, getRoomState
} = require('../db/gdo');
const { createDoubleDeck, createTripleDeck, shuffle, deal4, deal6 } = require('../utils/cards');
const { initGameState, startTributePhase } = require('./game');

/* ─── 发牌并启动游戏（满员后调用）──────────────── */
async function dealAndStart(io, roomCode, state) {
  const is6p = state.room.game_mode === '6p';
  const deck  = shuffle(is6p ? createTripleDeck() : createDoubleDeck());
  const halves = is6p ? deal6(deck) : deal4(deck);
  const newRound = parseInt(state.room.round_count || 0) + 1;

  const sortedSeats = [...state.seats].sort((a, b) => a.seat - b.seat);
  const hands = {};
  sortedSeats.forEach((s, i) => { hands[String(s.player_id)] = halves[i]; });

  const rows = await query(
    `INSERT INTO gdo_rounds(room_id,round_number,hands_json) VALUES($1,$2,$3) RETURNING id`,
    [state.room.id, newRound, JSON.stringify(hands)]
  );
  const roundId = rows[0].id;

  await query(
    `UPDATE gdo_rooms SET status='playing',started_at=NOW(),round_count=$1 WHERE room_code=$2`,
    [newRound, roomCode]
  );

  initGameState(
    roomCode, roundId, state.room.id,
    sortedSeats.map(s => ({
      seat: s.seat, team: s.team,
      playerId: s.player_id, name: s.display_name
    })),
    hands,
    state.room.level_team1, state.room.level_team2, state.room.game_mode
  );

  console.log(`[掼蛋] 🃏 发牌 · ${roomCode} · 第${newRound}局 · 每人27张`);

  /* 六人赛事：检查是否有上一局的进贡待处理 */
  const tributeRaw = state.room.tribute_json;
  if (is6p && tributeRaw) {
    const tributeInfo = typeof tributeRaw === 'string' ? JSON.parse(tributeRaw) : tributeRaw;
    const started = await startTributePhase(io, roomCode, tributeInfo);
    if (started) return; // startTributePhase 内部会在合适时机 emit game:starting
  }

  io.to(roomCode).emit('game:starting', { roomCode, roundId });
}

/* ─── 广播等候状态 ──────────────────────────────── */
async function broadcastWaiting(io, roomCode, state) {
  io.to(roomCode).emit('game:seat_update', {
    seats:   state.seats,
    roomCode,
    mode:    state.room.game_mode,
    roomType: state.room.room_type
  });
}

/* ══════════════════════════════════════════════════
 * Socket 事件处理器
 * ══════════════════════════════════════════════════ */
module.exports = function(io, socket) {

  /* ── 随机参赛：立即分配进开放房间 ── */
  socket.on('queue:join', async function(data) {
    try {
      const { token, name, mode } = data;
      const player = await getOrCreatePlayer(token, name);

      /* 若玩家已在进行中的房间，直接回原房间 */
      const activeRow = await query(`
        SELECT r.room_code FROM gdo_rooms r
        JOIN gdo_seats s ON s.room_id=r.id
        WHERE s.player_id=$1 AND r.status IN ('waiting','playing')
        LIMIT 1
      `, [player.id]);
      if (activeRow.length) {
        socket.join(activeRow[0].room_code);
        socket.emit('queue:joined', { roomCode: activeRow[0].room_code });
        return;
      }

      const roomCode = await findOrCreateOpenRoom(mode);
      const result   = await joinRoomByCode(roomCode, player.id, socket.id);
      if (result.error) return socket.emit('queue:error', { message: result.error });

      socket.join(roomCode);
      socket.emit('queue:joined', { roomCode });

      const state = await getRoomState(roomCode);
      await broadcastWaiting(io, roomCode, state);

      const need = mode === '6p' ? 6 : 4;
      if (state.seats.length >= need) {
        await dealAndStart(io, roomCode, state);
        /* 为下一批玩家自动建新房间 */
        findOrCreateOpenRoom(mode).catch(e => console.error('[auto-room]', e.message));
      }
    } catch (e) {
      console.error('[queue:join]', e.message);
      socket.emit('queue:error', { message: '加入失败，请重试' });
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
    } catch (e) { console.error('[queue:cancel]', e.message); }
  });

  /* ── 亲友开房：建私人房间后立即进游戏页 ── */
  socket.on('room:create', async function(data) {
    try {
      const { token, name, mode } = data;
      const player = await getOrCreatePlayer(token, name);
      const room   = await createRoom(mode, 'private');
      const result = await joinRoomByCode(room.room_code, player.id, socket.id);
      if (result.error) return socket.emit('room:error', { message: result.error });

      socket.join(room.room_code);
      socket.emit('room:joined', { roomCode: room.room_code });

      const state = await getRoomState(room.room_code);
      await broadcastWaiting(io, room.room_code, state);
    } catch (e) {
      console.error('[room:create]', e.message);
      socket.emit('room:error', { message: '创建房间失败' });
    }
  });

  /* ── 加入亲友房间 ── */
  socket.on('room:join', async function(data) {
    try {
      const { token, name, roomCode } = data;
      if (!roomCode) return socket.emit('room:error', { message: '请输入房间号' });
      const player = await getOrCreatePlayer(token, name);
      const code   = roomCode.trim().toUpperCase();
      const result = await joinRoomByCode(code, player.id, socket.id);
      if (result.error) return socket.emit('room:error', { message: result.error });

      socket.join(code);
      socket.emit('room:joined', { roomCode: code });

      const state = await getRoomState(code);
      await broadcastWaiting(io, code, state);

      const need = state.room.game_mode === '6p' ? 6 : 4;
      if (state.seats.length >= need) {
        await dealAndStart(io, code, state);
      }
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
    } catch (e) { console.error('[room:leave]', e.message); }
  });

  /* ── 保留 room:ready（下一局复用） ── */
  socket.on('room:ready', async function(data) {
    try {
      const { roomCode } = data;
      await query(`UPDATE gdo_seats SET is_ready=TRUE WHERE socket_id=$1`, [socket.id]);
      const state = await getRoomState(roomCode);
      if (!state) return;
      io.to(roomCode).emit('room:update', { state });

      const need = state.room.game_mode === '6p' ? 6 : 4;
      if (state.seats.length === need && state.seats.every(s => s.is_ready)) {
        await dealAndStart(io, roomCode, state);
      }
    } catch (e) { console.error('[room:ready]', e.message); }
  });

  /* ── 断线处理 ── */
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
