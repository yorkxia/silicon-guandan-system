/* 掼蛋网上赛事 · 游戏核心逻辑（四人 + 六人） */
const { query, queryOne } = require('../db/init');
const { sortHand }        = require('../utils/cards');
const {
  detectType, canBeat, settle, removeCards,
  detectType6p, canBeat6p, settle6p, computeTribute6p
} = require('../utils/cardTypes');
const gameStates = require('./gameState');

/* ─── 初始化游戏状态 ─────────────────────────────── */
function initGameState(roomCode, roundId, roomId, seats, hands, levelTeam1, levelTeam2, gameMode) {
  const state = {
    roomCode, roundId, roomId, gameMode,
    levelTeam1, levelTeam2,
    seats,           // [{ seat, team, playerId, name, socketId? }]
    hands: Object.assign({}, hands),
    turnSeat:     seats[0].seat,
    leadSeat:     seats[0].seat,
    lastPlay:     null,
    passCount:    0,
    finishOrder:  [],
    totalPlayers: seats.length,
    tributePhase: null   // 仅六人赛事使用
  };
  gameStates.set(roomCode, state);
  return state;
}

/* ─── 辅助：下一个未出完的座位 ───────────────────── */
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

/* ─── 广播游戏状态 ────────────────────────────────── */
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

/* ─── 持久化到 DB ─────────────────────────────────── */
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

/* ─── 从 DB 重建状态 ─────────────────────────────── */
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
    roomCode, round.id, seat.room_id, allSeats, hands,
    seat.level_team1, seat.level_team2, seat.game_mode
  );
  if (ts.turnSeat)    state.turnSeat    = ts.turnSeat;
  if (ts.leadSeat)    state.leadSeat    = ts.leadSeat;
  if (ts.lastPlay)    state.lastPlay    = ts.lastPlay;
  if (ts.passCount)   state.passCount   = ts.passCount;
  if (ts.finishOrder) state.finishOrder = ts.finishOrder;
  return state;
}

/* ─── A级回退计算（六人赛事）────────────────────────
   若队友（非头游）是末游，则该队累计"A级不过"次数+1
   连续3次后：对方头游→退2级；己方头游+1→退3级
*/
function calcAFail(currentFails, headTeam, delta, thisTeam, endLevel) {
  if (endLevel < 14) return 0; // 不在A级，清零
  const teamHasTerminalMate = (delta === 1 && headTeam === thisTeam)  // 己方头游+1（队友末游）
                           || (delta !== 4 && headTeam !== thisTeam); // 对方头游（己方输）
  if (teamHasTerminalMate) return currentFails + 1;
  return 0; // 这局赢得好或满足其他条件，清零
}

/* ─── 四人赛事结算 ──────────────────────────────── */
async function finishRound(io, state) {
  const result = settle(state.finishOrder, state.levelTeam1, state.levelTeam2);
  await _writeRoundResult(io, state, result, false);
}

/* ─── 六人赛事结算 ──────────────────────────────── */
async function finishRound6p(io, state) {
  const result = settle6p(state.finishOrder, state.levelTeam1, state.levelTeam2);

  /* A级回退检测 */
  const room = await queryOne('SELECT a_fails_team1, a_fails_team2 FROM gdo_rooms WHERE room_code=$1', [state.roomCode]);
  const a1 = parseInt(room.a_fails_team1 || 0);
  const a2 = parseInt(room.a_fails_team2 || 0);

  /* 计算本局后的A失败计数 */
  let new1 = calcAFail(a1, result.winnerTeam, result.delta, 1, result.newLv1);
  let new2 = calcAFail(a2, result.winnerTeam, result.delta, 2, result.newLv2);

  /* 末游的队 */
  const末游Team = state.finishOrder[5].team;

  /* 回退触发：连续3局且每局都有本方队友末游 */
  if (new1 >= 3 && result.newLv1 === 14) {
    result.newLv1 = (result.winnerTeam === 2) ? 2 : 3; // 对方头游→2；己方头游+1→3
    new1 = 0;
  }
  if (new2 >= 3 && result.newLv2 === 14) {
    result.newLv2 = (result.winnerTeam === 1) ? 2 : 3;
    new2 = 0;
  }

  /* 进贡信息（写入下局使用） */
  const tributeInfo = computeTribute6p(state.finishOrder, result.winnerTeam);
  const tributeJson = tributeInfo.exchanges.length > 0
    ? JSON.stringify({ ...tributeInfo, delta: result.delta })
    : null;

  await _writeRoundResult(io, state, result, true, new1, new2, tributeJson);
}

/* ─── 公共写库逻辑 ──────────────────────────────── */
async function _writeRoundResult(io, state, result, is6p, new1 = 0, new2 = 0, tributeJson = null) {
  await query(`
    UPDATE gdo_rounds
    SET finish_order=$1, winner_team=$2, result_type=$3,
        level_delta=$4, level_team1_after=$5, level_team2_after=$6,
        finished_at=NOW(), current_hands_json=NULL, turn_state_json=NULL
    WHERE id=$7
  `, [
    state.finishOrder.map(f => f.playerId),
    result.winnerTeam, result.resultType, result.delta,
    result.newLv1, result.newLv2, state.roundId
  ]);

  await query(`
    UPDATE gdo_rooms
    SET level_team1=$1, level_team2=$2, status='waiting',
        a_fails_team1=$3, a_fails_team2=$4, tribute_json=$5
    WHERE room_code=$6
  `, [result.newLv1, result.newLv2, new1, new2, tributeJson, state.roomCode]);

  await query(`UPDATE gdo_seats SET is_ready=FALSE WHERE room_id=$1`, [state.roomId]);

  for (const f of state.finishOrder)
    await query(`UPDATE gdo_players SET games_played=games_played+1 WHERE id=$1`, [f.playerId]);
  const winners = state.finishOrder.filter(f => f.team === result.winnerTeam);
  for (const f of winners)
    await query(`UPDATE gdo_players SET games_won=games_won+1 WHERE id=$1`, [f.playerId]);

  io.to(state.roomCode).emit('round:result', {
    finishOrder:  state.finishOrder,
    resultType:   result.resultType,
    winnerTeam:   result.winnerTeam,
    delta:        result.delta,
    newLv1:       result.newLv1,
    newLv2:       result.newLv2,
    tributePending: !!tributeJson
  });

  gameStates.delete(state.roomCode);
}

/* ─── 六人进贡阶段初始化（由 matchmaking 调用）──── */
async function startTributePhase(io, roomCode, tributeInfo) {
  const state = gameStates.get(roomCode);
  if (!state) return false;

  const exchanges   = [];
  let pendingCount  = 0;
  let tributeLeadId = null; // 给头游进贡的人（还贡后先出牌）

  /* 按各自手牌里最大的牌排序贡者→决定谁给头游（最大的牌给头游）*/
  const giversByTop = tributeInfo.exchanges.map(ex => {
    const hand   = state.hands[String(ex.giverId)] || [];
    const sorted = sortHand(hand);
    return { ...ex, topCard: sorted[0] || null, topVal: sorted[0] ? _rankVal(sorted[0]) : 0 };
  }).sort((a, b) => b.topVal - a.topVal); // 贡最大的先对应头游（接收方排序已正确）

  for (let i = 0; i < giversByTop.length; i++) {
    const ex = { ...giversByTop[i], receiverId: tributeInfo.exchanges[i]?.receiverId };
    if (!ex.giverId || !ex.receiverId) continue;

    const hand    = state.hands[String(ex.giverId)] || [];
    const bjCount = hand.filter(c => c === 'BJ').length;

    /* 抗贡：持有全部3张大王 */
    if (bjCount >= 3) {
      exchanges.push({ giverId: ex.giverId, receiverId: ex.receiverId,
                       tributeCard: null, returnCard: null, resisted: true, done: true });
      continue;
    }

    /* 自动取最大牌 */
    const sorted = sortHand(hand);
    const tributeCard = sorted[0];
    if (!tributeCard) continue;

    const newHand = [...hand];
    newHand.splice(newHand.indexOf(tributeCard), 1);
    state.hands[String(ex.giverId)] = newHand;

    exchanges.push({
      giverId: ex.giverId, receiverId: ex.receiverId,
      tributeCard, returnCard: null, resisted: false, done: false
    });
    pendingCount++;

    /* 给头游进贡的第一个人 = tributeLeader */
    if (!tributeLeadId && ex.receiverId === tributeInfo.headPlayerId) {
      tributeLeadId = ex.giverId;
    }
  }

  if (pendingCount === 0) {
    /* 全部抗贡或没有贡 → 直接开始 */
    await query(`UPDATE gdo_rooms SET tribute_json=NULL WHERE room_code=$1`, [roomCode]);
    io.to(roomCode).emit('game:starting', { roomCode, roundId: state.roundId });
    return true;
  }

  state.tributePhase = { exchanges, pendingCount, tributeLeadId };

  /* 把进贡牌从手牌里移除后持久化一次 */
  await persistState(state);

  io.to(roomCode).emit('tribute:phase', {
    exchanges: exchanges.map(e => ({
      giverId:     e.giverId,
      receiverId:  e.receiverId,
      tributeCard: e.tributeCard,
      resisted:    e.resisted
    }))
  });
  return true;
}

/* 辅助：快速排名值 */
function _rankVal(card) {
  if (card === 'BJ') return 16;
  if (card === 'LJ') return 15;
  const m = { '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'T':10,'J':11,'Q':12,'K':13,'A':14 };
  return m[card.slice(1)] || 0;
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

      /* ── 游戏尚未开始：等候状态 ── */
      if (!round || !round.hands_json) {
        const allSeats = await query(`
          SELECT s.seat, s.team, s.player_id, p.display_name AS name, p.player_token
          FROM gdo_seats s JOIN gdo_players p ON p.id=s.player_id
          WHERE s.room_id=$1 ORDER BY s.seat
        `, [seat.room_id]);
        const roomInfo = await queryOne(
          'SELECT room_code, game_mode, room_type, level_team1, level_team2 FROM gdo_rooms WHERE id=$1',
          [seat.room_id]
        );
        socket.emit('game:waiting', {
          roomCode, mode: roomInfo.game_mode, roomType: roomInfo.room_type,
          myPlayerId: player.id, mySeat: seat.seat, myTeam: seat.team,
          levelTeam1: roomInfo.level_team1, levelTeam2: roomInfo.level_team2,
          seats: allSeats
        });
        io.to(roomCode).emit('game:seat_update', {
          seats: allSeats, roomCode, mode: roomInfo.game_mode, roomType: roomInfo.room_type
        });
        return;
      }

      let state = gameStates.get(roomCode);
      if (!state) state = await rebuildState(roomCode, seat, round);

      const mySeatObj = state.seats.find(s => s.playerId === player.id);
      if (mySeatObj) mySeatObj.socketId = socket.id;

      const myHand  = sortHand(state.hands[String(player.id)] || []);
      const players = state.seats.map(s => ({
        seat:      s.seat,
        team:      s.team,
        name:      s.name,
        cardCount: (state.hands[String(s.playerId)] || []).length,
        isMe:      s.playerId === player.id,
        playerId:  s.playerId
      }));

      socket.emit('game:hand', {
        hand: myHand, myPlayerId: player.id,
        mySeat: seat.seat, myTeam: seat.team,
        gameMode: seat.game_mode, roomCode,
        roundNumber: round.round_number,
        levelTeam1: state.levelTeam1,
        levelTeam2: state.levelTeam2,
        players
      });

      broadcastState(io, state);

      /* 若进贡阶段仍在进行（断线重连）*/
      if (state.tributePhase) {
        const ex = state.tributePhase.exchanges.find(
          e => !e.done && !e.resisted && e.receiverId === player.id
        );
        socket.emit('tribute:phase', {
          exchanges: state.tributePhase.exchanges.map(e => ({
            giverId: e.giverId, receiverId: e.receiverId,
            tributeCard: e.tributeCard, resisted: e.resisted
          }))
        });
      }

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

      /* 六人/四人分别使用对应牌型识别器 */
      const detect6p = state.gameMode === '6p';
      const playType = detect6p ? detectType6p(cards) : detectType(cards);
      if (!playType) return socket.emit('play:invalid', { message: '无效牌型，请重新选择' });

      const beatFn = detect6p ? canBeat6p : canBeat;
      if (state.lastPlay && !beatFn(playType, state.lastPlay.playType))
        return socket.emit('play:invalid', { message: `出牌需要压过：${state.lastPlay.playType.label}` });

      state.hands[String(player.id)] = newHand;
      state.lastPlay  = { seat: mySeat.seat, name: mySeat.name, cards, playType };
      state.leadSeat  = mySeat.seat;
      state.passCount = 0;

      socket.emit('game:hand_update', { hand: sortHand(newHand) });

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

      if (state.finishOrder.length >= state.totalPlayers - 1) {
        const doneSet  = new Set(state.finishOrder.map(f => f.seat));
        const lastSeat = state.seats.find(s => !doneSet.has(s.seat));
        if (lastSeat) {
          state.finishOrder.push({
            position: state.totalPlayers, seat: lastSeat.seat,
            playerId: lastSeat.playerId, name: lastSeat.name, team: lastSeat.team
          });
        }
        if (state.gameMode === '6p') await finishRound6p(io, state);
        else                         await finishRound(io, state);
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
        state.lastPlay  = null;
        state.passCount = 0;
        if (leaderAlive) {
          state.turnSeat = state.leadSeat;
        } else {
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

  /* ── 六人赛事：还贡（接收方选择归还的牌）── */
  socket.on('tribute:return', async function(data) {
    try {
      const { token, roomCode, returnCard } = data;
      const state = gameStates.get(roomCode);
      if (!state || !state.tributePhase) return;

      const player = await queryOne(
        'SELECT id FROM gdo_players WHERE player_token=$1', [token]
      );
      if (!player) return;

      const ex = state.tributePhase.exchanges.find(
        e => !e.done && !e.resisted && e.receiverId === player.id
      );
      if (!ex) return socket.emit('tribute:invalid', { message: '您不是进贡接收方或已完成' });

      /* 验证：还贡的牌必须在接收方当前手中 */
      const receiverHand = state.hands[String(player.id)] || [];
      if (!receiverHand.includes(returnCard))
        return socket.emit('tribute:invalid', { message: '请选择手中的牌还贡' });

      /* 执行交换：接收方 +tributeCard -returnCard；进贡方 +returnCard */
      const newRHand = [...receiverHand, ex.tributeCard];
      newRHand.splice(newRHand.indexOf(returnCard), 1);
      state.hands[String(player.id)]    = newRHand;
      state.hands[String(ex.giverId)]   = [...(state.hands[String(ex.giverId)] || []), returnCard];

      ex.returnCard = returnCard;
      ex.done       = true;
      state.tributePhase.pendingCount--;

      socket.emit('game:hand_update', { hand: sortHand(newRHand) });
      io.to(roomCode).emit('tribute:exchange_done', {
        giverId: ex.giverId, receiverId: ex.receiverId,
        tributeCard: ex.tributeCard, returnCard
      });

      /* 所有还贡完毕 */
      if (state.tributePhase.pendingCount === 0) {
        /* 还贡后由进贡给头游的人先出牌 */
        const leadId = state.tributePhase.tributeLeadId;
        if (leadId) {
          const leadSeatObj = state.seats.find(s => s.playerId === leadId);
          if (leadSeatObj) {
            state.turnSeat = leadSeatObj.seat;
            state.leadSeat = leadSeatObj.seat;
          }
        }
        state.tributePhase = null;

        await query(
          `UPDATE gdo_rounds SET hands_json=$1, current_hands_json=$1 WHERE id=$2`,
          [JSON.stringify(state.hands), state.roundId]
        );
        await persistState(state);
        await query(`UPDATE gdo_rooms SET tribute_json=NULL WHERE room_code=$1`, [roomCode]);

        io.to(roomCode).emit('tribute:done', {});
        io.to(roomCode).emit('game:starting', { roomCode, roundId: state.roundId });
      }
    } catch (e) {
      console.error('[tribute:return]', e.message);
    }
  });

};

module.exports.initGameState     = initGameState;
module.exports.startTributePhase = startTributePhase;
