/* 网上掼蛋 · 匹配系统 Socket 事件 */
const { query } = require('../db/init');
const {
  getOrCreatePlayer, createRoom, findOrCreateOpenRoom,
  joinRoomByCode, getRoomState
} = require('../db/gdo');
const { createDoubleDeck, createTripleDeck, shuffle, deal4, deal6 } = require('../utils/cards');
const { initGameState, startTributePhase } = require('./game');

/* ══════════════════════════════════════════════════════
 * 房间生命周期：赛事大屏不满员 → 等待 5 分钟 → 警告 40 秒 → 永久关闭
 * ══════════════════════════════════════════════════════ */
const WAIT_MS  = 5 * 60 * 1000;   // 不满员等待上限
const CLOSE_MS = 40 * 1000;       // 关闭前倒计时
const roomTimers = new Map();     // roomCode -> { warn?, close? }

function cancelRoomTimer(roomCode) {
  const t = roomTimers.get(roomCode);
  if (t) { clearTimeout(t.warn); clearTimeout(t.close); roomTimers.delete(roomCode); }
}

async function closeRoomPermanently(io, roomCode) {
  cancelRoomTimer(roomCode);
  const st = await getRoomState(roomCode);
  if (!st) return;
  if (st.room.room_type !== 'random') return;  // 仅赛事大屏(随机)房超时关闭，私人亲友房不关
  const need = st.room.game_mode === '6p' ? 6 : 4;
  if (st.room.status === 'playing' || st.seats.length >= need) return;  // 已开赛/已满则不关
  await query(`UPDATE gdo_rooms SET status='abandoned', is_full=FALSE WHERE room_code=$1`, [roomCode]);
  await query(`DELETE FROM gdo_seats WHERE room_id=$1`, [st.room.id]);
  io.to(roomCode).emit('room:closed', {});
  console.log(`[掼蛋] 🚪 房间永久关闭（不满员超时）· ${roomCode}`);
}

/* 房间处于"等候且不满员"时开始计时；满员/开赛/关闭时取消 */
async function armRoomTimer(io, roomCode) {
  cancelRoomTimer(roomCode);
  const st = await getRoomState(roomCode);
  if (!st) return;
  if (st.room.room_type !== 'random') return;  // 仅赛事大屏(随机)房超时关闭，私人亲友房不关
  const need = st.room.game_mode === '6p' ? 6 : 4;
  if (st.room.status === 'playing' || st.seats.length >= need) return;
  const warn = setTimeout(async function() {
    const s2 = await getRoomState(roomCode);
    if (!s2) return;
    const need2 = s2.room.game_mode === '6p' ? 6 : 4;
    if (s2.room.status === 'playing' || s2.seats.length >= need2) return;
    io.to(roomCode).emit('room:closing', { seconds: CLOSE_MS / 1000 });
    const close = setTimeout(function() { closeRoomPermanently(io, roomCode); }, CLOSE_MS);
    roomTimers.set(roomCode, { close });
  }, WAIT_MS);
  roomTimers.set(roomCode, { warn });
}

/* ─── 发牌并启动游戏（满员后调用）──────────────── */
async function dealAndStart(io, roomCode, state) {
  cancelRoomTimer(roomCode);   // 满员开赛，停止关闭计时
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

  /* 坐庄：首局随机产生，之后 = 上局胜方(settle 时已写入 banker_team) */
  let bankerTeam = state.room.banker_team;
  if (!bankerTeam) {
    bankerTeam = Math.random() < 0.5 ? 1 : 2;
    await query(`UPDATE gdo_rooms SET banker_team=$1 WHERE room_code=$2`, [bankerTeam, roomCode]);
  }

  await query(
    `UPDATE gdo_rooms SET status='playing',started_at=NOW(),round_count=$1,is_full=TRUE WHERE room_code=$2`,
    [newRound, roomCode]
  );

  const gs = initGameState(
    roomCode, roundId, state.room.id,
    sortedSeats.map(s => ({
      seat: s.seat, team: s.team,
      playerId: s.player_id, name: s.display_name
    })),
    hands,
    state.room.level_team1, state.room.level_team2, state.room.game_mode, bankerTeam
  );

  /* 首局翻牌定首抓（PDF 2.1）：用 CSPRNG 随机抽一名玩家先出 */
  if (newRound === 1 && gs) {
    const startSeat = sortedSeats[require('crypto').randomInt(sortedSeats.length)].seat;
    gs.turnSeat = startSeat; gs.leadSeat = startSeat;
  }

  console.log(`[掼蛋] 🃏 发牌 · ${roomCode} · 第${newRound}局 · 每人27张`);

  /* 四人赛事：检查是否有上一局的进贡待处理（第2局起） */
  const tributeRaw = state.room.tribute_json;
  if (tributeRaw) {
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

      /* 随机参赛的"回原房"只认【同赛制的随机房】，避免残留私人房劫持随机参赛 */
      const activeRow = await query(`
        SELECT r.room_code FROM gdo_rooms r
        JOIN gdo_seats s ON s.room_id=r.id
        WHERE s.player_id=$1 AND r.game_mode=$2 AND r.room_type='random' AND r.status IN ('waiting','playing')
        LIMIT 1
      `, [player.id, mode]);
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
      } else {
        await armRoomTimer(io, roomCode);   // 不满员：启动"等待5分钟→警告40秒→永久关闭"计时
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
