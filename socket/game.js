/* 掼蛋网上赛事 · 游戏核心逻辑 */
const { query, queryOne } = require('../db/init');
const { sortHand }         = require('../utils/cards');
const { detectType, canBeat, settle, removeCards } = require('../utils/cardTypes');
const gameStates           = require('./gameState');

/* ─── 初始化游戏状态（由 matchmaking.js 在发牌后调用）── */
function initGameState(roomCode, roundId, roomId, seats, hands, levelTeam1, levelTeam2, gameMode) {
  const state = {
    roomCode,
    roundId,
    roomId,
    gameMode,
    levelTeam1,
    levelTeam2,
    seats,           // [{ seat, team, playerId, name, socketId? }] 按 seat 升序
    hands: Object.assign({}, hands),
    turnSeat:    seats[0].seat,
    leadSeat:    seats[0].seat,
    lastPlay:    null,  // { seat, name, cards, playType }
    passCount:   0,
    finishOrder: [],    // [{ position, seat, playerId, name, team }]
    totalPlayers: seats.length
  };
  gameStates.set(roomCode, state);
  return state;
}

/* ─── 辅助：下一个未出完的座位 ─────────────────────── */
function nextSeat(currentSeat, seats, finishOrder) {
  const doneSeats = new Set(finishOrder.map(f => f.seat));
  const nums = seats.map(s => s.seat).sort((a, b) => a - b);
  const cur  = nums.indexOf(currentSeat);
  for (let i = 1; i <= nums.length; i++) {
    const s = nums[(cur + i) % nums.length];
    if (!doneSeats.has(s)) return s;
  }
  return currentSeat;
}

/* ─── 广播游戏状态到房间所有玩家 ─────────────────── */
function broadcastState(io, state) {
  const handCounts = {};
  for (const [pid, h] of Object.entries(state.hands)) handCounts[pid] = h.length;
  io.to(state.roomCode).emit('game:state', {
    turnSeat:    state.turnSeat,
    leadSeat:    state.leadSeat,
    lastPlay:    state.lastPlay ? {
      seat:  state.lastPlay.seat,
      name:  state.lastPlay.name,
      cards: state.lastPlay.cards,
      label: state.lastPlay.playType.label
    } : null,
    handCounts,
    finishOrder: state.finishOrder
  });
}

/* ─── 持久化游戏状态到 DB ─────────────────────────── */
async function persistState(state) {
  await query(
    `UPDATE gdo_rounds SET current_hands_json=$1, turn_state_json=$2 WHERE id=$3`,
    [
      JSON.stringify(state.hands),
      JSON.stringify({
        turnSeat:    state.turnSeat,
        leadSeat:    state.leadSeat,
        lastPlay:    state.lastPlay,
        passCount:   state.passCount,
        finishOrder: state.finishOrder
      }),
      state.roundId
    ]
  );
}

/* ─── 从 DB 重建状态（服务器重启后） ─────────────── */
async function rebuildState(roomCode, seat, round) {
  const allSeats = await query(`
    SELECT s.seat, s.team, s.player_id AS "playerId", p.display_name AS name
    FROM gdo_seats s JOIN gdo_players p ON p.id = s.player_id
    WHERE s.room_id=$1 ORDER BY s.seat
  `, [seat.room_id]);

  const rawHands = round.current_hands_json || round.hands_json;
  const hands    = typeof rawHands === 'string' ? JSON.parse(rawHands) : rawHands;
  const ts       = round.turn_state_json || {};

  const state = initGameState(
    roomCode, round.id, seat.room_id,
    allSeats,
    hands,
    seat.level_team1, seat.level_team2,
    seat.game_mode
  );
  if (ts.turnSeat)    state.turnSeat    = ts.turnSeat;
  if (ts.leadSeat)    state.leadSeat    = ts.leadSeat;
  if (ts.lastPlay)    state.lastPlay    = ts.lastPlay;
  if (ts.passCount)   state.passCount   = ts.passCount;
  if (ts.finishOrder) state.finishOrder = ts.finishOrder;
  return state;
}

/* ─── 局结算写库 ─────────────────────────────────── */
async function finishRound(io, state) {
  const result = settle(state.finishOrder, state.levelTeam1, state.levelTeam2);

  await query(`
    UPDATE gdo_rounds
    SET finish_order=$1, winner_team=$2, result_type=$3,
        level_delta=$4, level_team1_after=$5, level_team2_after=$6,
        finished_at=NOW(), current_hands_json=NULL, turn_state_json=NULL
    WHERE id=$7
  `, [
    state.finishOrder.map(f => f.playerId),
    result.winnerTeam, result.resultType, result.delta,
    result.newLv1, result.newLv2,
    state.roundId
  ]);

  await query(
    `UPDATE gdo_rooms SET level_team1=$1, level_team2=$2, status='waiting' WHERE room_code=$3`,
    [result.newLv1, result.newLv2, state.roomCode]
  );
  /* 重置座位就绪状态，玩家下局需重新准备 */
  await query(`UPDATE gdo_seats SET is_ready=FALSE WHERE room_id=$1`, [state.roomId]);

  for (const f of state.finishOrder) {
    await query(`UPDATE gdo_players SET games_played=games_played+1 WHERE id=$1`, [f.playerId]);
  }
  const winners = state.finishOrder.filter(f => f.team === result.winnerTeam);
  for (const f of winners) {
    await query(`UPDATE gdo_players SET games_won=games_won+1 WHERE id=$1`, [f.playerId]);
  }

  io.to(state.roomCode).emit('round:result', {
    finishOrder: state.finishOrder,
    resultType:  result.resultType,
    winnerTeam:  result.winnerTeam,
    delta:       result.delta,
    newLv1:      result.newLv1,
    newLv2:      result.newLv2
  });

  gameStates.delete(state.roomCode);
}

/* ══════════════════════════════════════════════════════
 * Socket 事件处理器
 * ══════════════════════════════════════════════════════ */
module.exports = function(io, socket) {

  /* ── 进入游戏页面，请求手牌 ── */
  socket.on('game:request_hand', async function(data) {
    try {
      const { token, roomCode } = data;

      const player = await queryOne(
        'SELECT id FROM gdo_players WHERE player_token=$1', [token]
      );
      if (!player) return socket.emit('game:error', { message: '玩家身份未找到，请返回重试' });

      const seat = await queryOne(`
        SELECT s.*, r.game_mode, r.status, r.id AS room_id,
               r.level_team1, r.level_team2, r.round_count
        FROM gdo_seats s JOIN gdo_rooms r ON r.id = s.room_id
        WHERE r.room_code=$1 AND s.player_id=$2
      `, [roomCode, player.id]);
      if (!seat) return socket.emit('game:error', { message: '您不在此房间中' });

      await query('UPDATE gdo_seats SET socket_id=$1, is_connected=TRUE WHERE id=$2',
        [socket.id, seat.id]);
      socket.join(roomCode);

      const round = await queryOne(`
        SELECT * FROM gdo_rounds WHERE room_id=$1 ORDER BY round_number DESC LIMIT 1
      `, [seat.room_id]);
      if (!round || !round.hands_json) {
        return socket.emit('game:error', { message: '手牌尚未发放，请稍候' });
      }

      // 内存状态不存在时从 DB 重建
      let state = gameStates.get(roomCode);
      if (!state) state = await rebuildState(roomCode, seat, round);

      // 更新 socket 连接信息
      const mySeatObj = state.seats.find(s => s.playerId === player.id);
      if (mySeatObj) mySeatObj.socketId = socket.id;

      const myHand = sortHand(state.hands[String(player.id)] || []);
      const players = state.seats.map(s => ({
        seat:      s.seat,
        team:      s.team,
        name:      s.name,
        cardCount: (state.hands[String(s.playerId)] || []).length,
        isMe:      s.playerId === player.id,
        playerId:  s.playerId
      }));

      socket.emit('game:hand', {
        hand:        myHand,
        myPlayerId:  player.id,
        mySeat:      seat.seat,
        myTeam:      seat.team,
        gameMode:    seat.game_mode,
        roomCode,
        roundNumber: round.round_number,
        levelTeam1:  state.levelTeam1,
        levelTeam2:  state.levelTeam2,
        players
      });

      // 推送当前游戏状态（方便重连玩家同步）
      broadcastState(io, state);

    } catch (e) {
      console.error('[game:request_hand]', e.message);
      socket.emit('game:error', { message: '获取手牌失败，请刷新重试' });
    }
  });

  /* ── 出牌 ── */
  socket.on('play:cards', async function(data) {
    try {
      const { token, roomCode, cards } = data;
      const state = gameStates.get(roomCode);
      if (!state) return socket.emit('game:error', { message: '游戏状态不存在，请刷新' });

      const player = await queryOne(
        'SELECT id FROM gdo_players WHERE player_token=$1', [token]
      );
      if (!player) return socket.emit('play:invalid', { message: '身份未找到' });

      const mySeat = state.seats.find(s => s.playerId === player.id);
      if (!mySeat) return socket.emit('play:invalid', { message: '您不在此房间中' });
      if (mySeat.seat !== state.turnSeat)
        return socket.emit('play:invalid', { message: '还没有轮到您出牌' });

      const hand    = state.hands[String(player.id)];
      const newHand = removeCards(hand, cards);
      if (!newHand) return socket.emit('play:invalid', { message: '您没有选中的这些牌' });

      const playType = detectType(cards);
      if (!playType) return socket.emit('play:invalid', { message: '无效牌型，请重新选择' });

      if (state.lastPlay && !canBeat(playType, state.lastPlay.playType))
        return socket.emit('play:invalid', { message: `出牌需要压过：${state.lastPlay.playType.label}` });

      // 合法，执行出牌
      state.hands[String(player.id)] = newHand;
      state.lastPlay  = { seat: mySeat.seat, name: mySeat.name, cards, playType };
      state.leadSeat  = mySeat.seat;
      state.passCount = 0;

      socket.emit('game:hand_update', { hand: sortHand(newHand) });

      // 检查是否出完
      if (newHand.length === 0) {
        const pos = state.finishOrder.length + 1;
        state.finishOrder.push({
          position: pos, seat: mySeat.seat,
          playerId: player.id, name: mySeat.name, team: mySeat.team
        });
        io.to(roomCode).emit('player:finished', {
          seat: mySeat.seat, name: mySeat.name, position: pos
        });
      }

      // 局终判断（4人赛3人出完即结束）
      if (state.finishOrder.length >= state.totalPlayers - 1) {
        const doneSet  = new Set(state.finishOrder.map(f => f.seat));
        const lastSeat = state.seats.find(s => !doneSet.has(s.seat));
        if (lastSeat) {
          state.finishOrder.push({
            position: state.totalPlayers, seat: lastSeat.seat,
            playerId: lastSeat.playerId, name: lastSeat.name, team: lastSeat.team
          });
        }
        await finishRound(io, state);
        return;
      }

      state.turnSeat = nextSeat(mySeat.seat, state.seats, state.finishOrder);
      await persistState(state);
      broadcastState(io, state);

    } catch (e) {
      console.error('[play:cards]', e.message);
      socket.emit('play:invalid', { message: '出牌失败，请重试' });
    }
  });

  /* ── 不出（过牌）── */
  socket.on('play:pass', async function(data) {
    try {
      const { token, roomCode } = data;
      const state = gameStates.get(roomCode);
      if (!state) return;

      const player = await queryOne(
        'SELECT id FROM gdo_players WHERE player_token=$1', [token]
      );
      if (!player) return;

      const mySeat = state.seats.find(s => s.playerId === player.id);
      if (!mySeat || mySeat.seat !== state.turnSeat) return;

      if (!state.lastPlay)
        return socket.emit('play:invalid', { message: '先出方必须出牌，不能不出' });

      state.passCount++;

      const doneSeats   = new Set(state.finishOrder.map(f => f.seat));
      const activeSeats = state.seats.filter(s => !doneSeats.has(s.seat));
      const leaderAlive = activeSeats.some(s => s.seat === state.leadSeat);
      const needed      = leaderAlive ? activeSeats.length - 1 : activeSeats.length;

      if (state.passCount >= needed) {
        // 所有其他玩家均不出，先出方赢得本轮出牌权
        state.lastPlay  = null;
        state.passCount = 0;
        if (leaderAlive) {
          state.turnSeat = state.leadSeat;
        } else {
          // 先出方已出完，下家接管出牌权
          state.turnSeat = nextSeat(state.leadSeat, state.seats, state.finishOrder);
          state.leadSeat = state.turnSeat;
        }
        io.to(roomCode).emit('game:trick_won', { seat: state.turnSeat });
      } else {
        state.turnSeat = nextSeat(mySeat.seat, state.seats, state.finishOrder);
      }

      await persistState(state);
      broadcastState(io, state);

    } catch (e) {
      console.error('[play:pass]', e.message);
    }
  });

};

module.exports.initGameState = initGameState;
