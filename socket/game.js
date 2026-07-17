/* 掼蛋网上赛事 · 游戏核心逻辑（四人 + 六人） */
const { query, queryOne } = require('../db/init');
const { sortHand }        = require('../utils/cards');
const {
  detectType, canBeat, settle, removeCards, computeTribute4p,
  detectType6p, canBeat6p, settle6p, computeTribute6p
} = require('../utils/cardTypes');
const gameStates = require('./gameState');

/* ─── 回合计时配置（阶段九：断线重连稳定性）──────────
   在线玩家 30 秒 / 掉线玩家 12 秒；超时自动托管
*/
const TURN_SECONDS       = 40;   // 常规回合（测试期临时40秒，之后改回20）
const FIRST_TURN_SECONDS = 40;   // 开局第一手（留时间看牌）
const DC_TURN_SECONDS    = 12;   // 掉线托管

/* ─── 初始化游戏状态 ─────────────────────────────── */
function initGameState(roomCode, roundId, roomId, seats, hands, levelTeam1, levelTeam2, gameMode, bankerTeam) {
  bankerTeam = bankerTeam || 1;
  const levelCard = bankerTeam === 2 ? levelTeam2 : levelTeam1;   // 级牌=坐庄方级数
  const state = {
    roomCode, roundId, roomId, gameMode,
    levelTeam1, levelTeam2, bankerTeam, levelCard,
    seats,           // [{ seat, team, playerId, name, socketId? }]
    hands: Object.assign({}, hands),
    turnSeat:     seats[0].seat,
    leadSeat:     seats[0].seat,
    lastPlay:     null,
    passCount:    0,
    finishOrder:  [],
    totalPlayers: seats.length,
    tributePhase: null,   // 仅六人赛事使用
    disconnected: new Set(), // 掉线的座位号集合（阶段九）
    turnTimer:    null,   // setTimeout 句柄
    turnDeadline: 0,      // 当前回合截止时间戳（毫秒）
    firstMove:    true,   // 开局第一手（用于40秒看牌时间）
    seatPlays:    {}      // 各座位最近一手 { seat: {cards,label} | {pass:true} }
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

/* ══════════════════════════════════════════════════════
 * 回合计时器（阶段九核心：避免掉线/挂机永久卡死）
 * ══════════════════════════════════════════════════════ */
function clearTurnTimer(state) {
  if (state && state.turnTimer) {
    clearTimeout(state.turnTimer);
    state.turnTimer = null;
  }
}

function isSeatDisconnected(state, seat) {
  return state.disconnected && state.disconnected.has(seat);
}

/* 启动/重置当前回合计时器 */
function startTurnTimer(io, state) {
  clearTurnTimer(state);
  if (!state) return;
  /* 进贡阶段、已结束（只剩末游）不计时 */
  if (state.tributePhase) return;
  if (state.finishOrder.length >= state.totalPlayers - 1) return;

  const dc   = isSeatDisconnected(state, state.turnSeat);
  const secs = dc ? DC_TURN_SECONDS : (state.firstMove ? FIRST_TURN_SECONDS : TURN_SECONDS);
  state.turnDeadline = Date.now() + secs * 1000;

  io.to(state.roomCode).emit('game:turn_timer', {
    turnSeat: state.turnSeat,
    deadline: state.turnDeadline,
    seconds:  secs
  });

  state.turnTimer = setTimeout(() => {
    onTurnTimeout(io, state).catch(e => console.error('[turn_timeout]', e.message));
  }, secs * 1000);
}

/* 超时自动托管 */
async function onTurnTimeout(io, state) {
  /* 防止对已被替换/结束的旧 state 触发 */
  if (gameStates.get(state.roomCode) !== state) return;
  const seatObj = state.seats.find(s => s.seat === state.turnSeat);
  if (!seatObj) return;

  if (state.lastPlay) {
    /* 有上家牌 → 自动不出 */
    await applyPass(io, state, seatObj.playerId, true);
  } else {
    /* 先出方 → 自动出最小单张 */
    const hand     = sortHand(state.hands[String(seatObj.playerId)] || []);
    const smallest = hand[hand.length - 1];
    if (smallest) {
      const r = await applyPlay(io, state, seatObj.playerId, [smallest], true);
      /* 万一最小单张被判无效（理论上不会），退化为跳过一手 */
      if (r && r.error) {
        state.turnSeat = nextSeat(seatObj.seat, state.seats, state.finishOrder);
        await persistState(state);
        broadcastState(io, state);
        startTurnTimer(io, state);
      }
    }
  }
}

/* ─── 广播游戏状态 ────────────────────────────────── */
function broadcastState(io, state) {
  const handCounts = {};
  for (const [pid, h] of Object.entries(state.hands)) handCounts[pid] = h.length;
  /* 每个座位在线状态（阶段九）*/
  const connected = {};
  for (const s of state.seats) connected[s.seat] = !isSeatDisconnected(state, s.seat);
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
    finishOrder:  state.finishOrder,
    connected,
    turnDeadline: state.turnDeadline || 0,
    seatPlays:    state.seatPlays || {}      // 各座位最近一手（贴座位显示）
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
    seat.level_team1, seat.level_team2, seat.game_mode, seat.banker_team
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
/* ─── 过A / A级不过 规则（四人六人统一）────────────
   · 胜方本局开始时已在A(级14)且获胜 = 过A → 整盘完成，两队从2重开
   · 输方本局开始时在A且没赢 → A级失败+1；连续3次退回2
   返回 { newLv1, newLv2, aFail1, aFail2, guoA }
*/
function applyAWinRule(state, result, a1, a2) {
  const preLv = { 1: state.levelTeam1, 2: state.levelTeam2 };
  const winner = result.winnerTeam;
  const loser  = winner === 1 ? 2 : 1;
  const newLv  = { 1: result.newLv1, 2: result.newLv2 };
  const aFail  = { 1: 0, 2: 0 };
  let guoA = false;

  if (preLv[winner] === 14) {
    /* 过A → 整盘完成，两队从2重开 */
    guoA = true; newLv[1] = 2; newLv[2] = 2;
  } else if (preLv[loser] === 14) {
    /* 输方在A：A级失败累积，满3退回2 */
    let f = (loser === 1 ? a1 : a2) + 1;
    if (f >= 3) { newLv[loser] = 2; f = 0; }
    aFail[loser] = f;
  }
  return { newLv1: newLv[1], newLv2: newLv[2], aFail1: aFail[1], aFail2: aFail[2], guoA };
}

/* ─── 四人赛事结算 ──────────────────────────────── */
async function finishRound(io, state) {
  const result = settle(state.finishOrder, state.levelTeam1, state.levelTeam2);
  const room = await queryOne('SELECT a_fails_team1, a_fails_team2 FROM gdo_rooms WHERE room_code=$1', [state.roomCode]);
  const adj = applyAWinRule(state, result, parseInt(room.a_fails_team1 || 0), parseInt(room.a_fails_team2 || 0));
  result.newLv1 = adj.newLv1; result.newLv2 = adj.newLv2; result.guoA = adj.guoA;

  /* 四人进贡（写入下局使用；过A重开则不进贡）*/
  const tributeInfo = adj.guoA ? { exchanges: [] } : computeTribute4p(state.finishOrder, result.winnerTeam);
  const tributeJson = tributeInfo.exchanges.length > 0
    ? JSON.stringify({ ...tributeInfo, delta: result.delta })
    : null;

  await _writeRoundResult(io, state, result, false, adj.aFail1, adj.aFail2, tributeJson);
}

/* ─── 六人赛事结算 ──────────────────────────────── */
async function finishRound6p(io, state) {
  const result = settle6p(state.finishOrder, state.levelTeam1, state.levelTeam2);
  const room = await queryOne('SELECT a_fails_team1, a_fails_team2 FROM gdo_rooms WHERE room_code=$1', [state.roomCode]);
  const adj = applyAWinRule(state, result, parseInt(room.a_fails_team1 || 0), parseInt(room.a_fails_team2 || 0));
  result.newLv1 = adj.newLv1; result.newLv2 = adj.newLv2; result.guoA = adj.guoA;

  /* 进贡信息（写入下局使用；过A重开则不进贡）*/
  const tributeInfo = adj.guoA ? { exchanges: [] } : computeTribute6p(state.finishOrder, result.winnerTeam);
  const tributeJson = tributeInfo.exchanges.length > 0
    ? JSON.stringify({ ...tributeInfo, delta: result.delta })
    : null;

  await _writeRoundResult(io, state, result, true, adj.aFail1, adj.aFail2, tributeJson);
}

/* ─── 公共写库逻辑 ──────────────────────────────── */
async function _writeRoundResult(io, state, result, is6p, new1 = 0, new2 = 0, tributeJson = null) {
  clearTurnTimer(state);
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

  const guoAWin1 = (result.guoA && result.winnerTeam === 1) ? 1 : 0;
  const guoAWin2 = (result.guoA && result.winnerTeam === 2) ? 1 : 0;
  await query(`
    UPDATE gdo_rooms
    SET level_team1=$1, level_team2=$2, status='waiting',
        a_fails_team1=$3, a_fails_team2=$4, tribute_json=$5, banker_team=$6,
        wins_team1=wins_team1+$7, wins_team2=wins_team2+$8
    WHERE room_code=$9
  `, [result.newLv1, result.newLv2, new1, new2, tributeJson, result.winnerTeam, guoAWin1, guoAWin2, state.roomCode]);

  await query(`UPDATE gdo_seats SET is_ready=FALSE WHERE room_id=$1`, [state.roomId]);

  for (const f of state.finishOrder)
    await query(`UPDATE gdo_players SET games_played=games_played+1 WHERE id=$1`, [f.playerId]);
  const winners = state.finishOrder.filter(f => f.team === result.winnerTeam);
  for (const f of winners)
    await query(`UPDATE gdo_players SET games_won=games_won+1 WHERE id=$1`, [f.playerId]);

  const wrow = await queryOne('SELECT wins_team1, wins_team2 FROM gdo_rooms WHERE room_code=$1', [state.roomCode]);
  io.to(state.roomCode).emit('round:result', {
    finishOrder:  state.finishOrder,
    resultType:   result.resultType,
    winnerTeam:   result.winnerTeam,
    delta:        result.delta,
    newLv1:       result.newLv1,
    newLv2:       result.newLv2,
    guoA:         !!result.guoA,
    winsTeam1:    parseInt(wrow ? wrow.wins_team1 || 0 : 0),
    winsTeam2:    parseInt(wrow ? wrow.wins_team2 || 0 : 0),
    tributePending: !!tributeJson
  });

  gameStates.delete(state.roomCode);
}

/* ─── 四人进贡阶段初始化（由 matchmaking 调用）────
   交互式：贡者手动点最大牌 → 飞向受供 → 受供还贡(≤10、非逢人配)。
   抗贡：进贡方合计大王 ≥ 队伍人数(4人=2) → 整方抗贡，头游先出。 */
async function startTributePhase(io, roomCode, tributeInfo) {
  const state = gameStates.get(roomCode);
  if (!state) return false;

  const headSeatObj = state.seats.find(s => s.playerId === tributeInfo.headPlayerId);
  const teamSize    = Math.floor(state.totalPlayers / 2);   // 4人=2

  /* 抗贡：进贡者手中「合计」大王 ≥ teamSize 即整方抗贡 */
  let totalBJ = 0;
  for (const ex of tributeInfo.exchanges) {
    const hand = state.hands[String(ex.giverId)] || [];
    totalBJ += hand.filter(c => c === 'BJ').length;
  }
  if (totalBJ >= teamSize) {
    /* 整方抗贡：无需进贡，直接由头游先出 */
    if (headSeatObj) { state.turnSeat = headSeatObj.seat; state.leadSeat = headSeatObj.seat; }
    state.tributePhase = null;
    await persistState(state);
    await query(`UPDATE gdo_rooms SET tribute_json=NULL WHERE room_code=$1`, [roomCode]);
    io.to(roomCode).emit('tribute:resisted', {
      headPlayerId: tributeInfo.headPlayerId, threshold: teamSize
    });
    io.to(roomCode).emit('game:starting', { roomCode, roundId: state.roundId });
    startTurnTimer(io, state);
    return true;
  }

  /* 按各自最大牌(排除逢人配)排序贡者 → 最大者对应头游 */
  const wild = _wildCard(state.levelCard);
  const giversByTop = tributeInfo.exchanges.map(ex => {
    const hand     = state.hands[String(ex.giverId)] || [];
    const mustGive = _maxGiveCard(hand, wild);
    return { ...ex, mustGiveCard: mustGive, topVal: mustGive ? _rankVal(mustGive) : 0 };
  }).sort((a, b) => b.topVal - a.topVal);

  const exchanges = [];
  let pendingCount = 0;
  let tributeLeadId = null;
  for (let i = 0; i < giversByTop.length; i++) {
    const g          = giversByTop[i];
    const receiverId = tributeInfo.exchanges[i] ? tributeInfo.exchanges[i].receiverId : null;
    if (!g.giverId || !receiverId || !g.mustGiveCard) continue;
    exchanges.push({
      giverId: g.giverId, receiverId, mustGiveCard: g.mustGiveCard,
      tributeCard: null, returnCard: null, resisted: false, stage: 'give'
    });
    pendingCount++;
    if (!tributeLeadId && receiverId === tributeInfo.headPlayerId) tributeLeadId = g.giverId;
  }

  if (pendingCount === 0) {
    if (headSeatObj) { state.turnSeat = headSeatObj.seat; state.leadSeat = headSeatObj.seat; }
    await persistState(state);
    await query(`UPDATE gdo_rooms SET tribute_json=NULL WHERE room_code=$1`, [roomCode]);
    io.to(roomCode).emit('game:starting', { roomCode, roundId: state.roundId });
    startTurnTimer(io, state);
    return true;
  }

  /* 首出座位（PDF 2.1）：双下→头游的下家首抓；单下→下游(唯一贡者)首抓 */
  const isFullDown = pendingCount >= teamSize;
  let leadSeat;
  if (isFullDown && headSeatObj) {
    leadSeat = nextSeat(headSeatObj.seat, state.seats, []);
  } else {
    const soleGiver = state.seats.find(s => s.playerId === exchanges[0].giverId);
    leadSeat = soleGiver ? soleGiver.seat : (headSeatObj ? headSeatObj.seat : state.turnSeat);
  }

  state.tributePhase = { exchanges, pendingCount, tributeLeadId, leadSeat,
                         headPlayerId: tributeInfo.headPlayerId };
  await persistState(state);

  io.to(roomCode).emit('tribute:phase', {
    exchanges: exchanges.map(e => ({
      giverId: e.giverId, receiverId: e.receiverId,
      mustGiveCard: e.mustGiveCard, resisted: false, stage: e.stage
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

/* 级数(2-14) → 牌面字符 */
function _rankChar(level) {
  return ({ 10:'T', 11:'J', 12:'Q', 13:'K', 14:'A' })[level] || String(level);
}
/* 逢人配(红桃级牌) 代码，如级牌为2 → 'H2' */
function _wildCard(levelCard) {
  return levelCard ? ('H' + _rankChar(levelCard)) : null;
}
/* 进贡应交的牌：手中最大的一张，但排除逢人配(红桃级牌) */
function _maxGiveCard(hand, wild) {
  const pool = hand.filter(c => c !== wild);
  const src  = pool.length ? pool : hand;   // 极端：全是逢人配才回退
  return sortHand(src)[0] || null;
}

/* ══════════════════════════════════════════════════════
 * 出牌 / 过牌 核心逻辑（socket 处理器与超时托管共用）
 * 返回 { ok:true } 或 { error:'...' }
 * ══════════════════════════════════════════════════════ */
async function applyPlay(io, state, playerId, cards, isAuto = false) {
  const mySeat = state.seats.find(s => s.playerId === playerId);
  if (!mySeat) return { error: '您不在此房间中' };
  if (mySeat.seat !== state.turnSeat) return { error: '还没有轮到您出牌' };

  const hand    = state.hands[String(playerId)];
  const newHand = removeCards(hand, cards);
  if (!newHand) return { error: '您没有选中的这些牌' };

  const detect6p  = state.gameMode === '6p';
  const playType  = detect6p ? detectType6p(cards, state.levelCard) : detectType(cards, state.levelCard);
  if (!playType) return { error: '无效牌型，请重新选择' };

  const beatFn = detect6p ? canBeat6p : canBeat;
  if (state.lastPlay && !beatFn(playType, state.lastPlay.playType))
    return { error: `出牌需要压过：${state.lastPlay.playType.label}` };

  state.hands[String(playerId)] = newHand;
  state.lastPlay  = { seat: mySeat.seat, name: mySeat.name, cards, playType };
  state.leadSeat  = mySeat.seat;
  state.passCount = 0;
  state.firstMove = false;
  state.seatPlays[mySeat.seat] = { cards: cards.slice(), label: playType.label };  // 该家出牌贴座位

  /* 出牌方位置提示"出"（跟随出牌方）*/
  io.to(state.roomCode).emit('player:played', { seat: mySeat.seat, name: mySeat.name });

  /* 把新手牌发回该玩家（若其 socket 在线）*/
  if (mySeat.socketId) io.to(mySeat.socketId).emit('game:hand_update', { hand: sortHand(newHand) });

  /* 报牌（PDF 2.4）：手中牌首次降到 ≤10 张时全场提示报牌（张数持续公示=如实回答）*/
  if (hand.length > 10 && newHand.length <= 10 && newHand.length > 0) {
    io.to(state.roomCode).emit('game:baopai', {
      seat: mySeat.seat, name: mySeat.name, count: newHand.length
    });
  }

  if (isAuto) {
    io.to(state.roomCode).emit('game:auto_played', {
      seat: mySeat.seat, name: mySeat.name, cards
    });
  }

  if (newHand.length === 0) {
    const pos = state.finishOrder.length + 1;
    state.finishOrder.push({
      position: pos, seat: mySeat.seat,
      playerId, name: mySeat.name, team: mySeat.team
    });
    io.to(state.roomCode).emit('player:finished', {
      seat: mySeat.seat, name: mySeat.name, position: pos
    });
  }

  /* 终局判断：只剩1人，或头游整队已全部出完(双下/三下，胜负已定即时结束) */
  const headTeam  = state.finishOrder.length ? state.finishOrder[0].team : 0;
  const headDone  = headTeam ? state.finishOrder.filter(f => f.team === headTeam).length : 0;
  const teamSize  = Math.floor(state.totalPlayers / 2);
  if (headDone >= teamSize || state.finishOrder.length >= state.totalPlayers - 1) {
    /* 剩余玩家(负方)按当前顺序补入名次 */
    const doneSet   = new Set(state.finishOrder.map(f => f.seat));
    const remaining = state.seats.filter(s => !doneSet.has(s.seat));
    for (const s of remaining) {
      state.finishOrder.push({
        position: state.finishOrder.length + 1,
        seat: s.seat, playerId: s.playerId, name: s.name, team: s.team
      });
    }
    if (state.gameMode === '6p') await finishRound6p(io, state);
    else                         await finishRound(io, state);
    return { ok: true };
  }

  state.turnSeat = nextSeat(mySeat.seat, state.seats, state.finishOrder);
  delete state.seatPlays[state.turnSeat];   // 轮到下一家，清掉其上一手
  await persistState(state);
  broadcastState(io, state);
  startTurnTimer(io, state);
  return { ok: true };
}

async function applyPass(io, state, playerId, isAuto = false) {
  const mySeat = state.seats.find(s => s.playerId === playerId);
  if (!mySeat || mySeat.seat !== state.turnSeat) return { error: '还没有轮到您' };

  if (!state.lastPlay) return { error: '先出方必须出牌，不能不出' };

  state.passCount++;
  state.firstMove = false;
  state.seatPlays[mySeat.seat] = { pass: true };   // 该家"不出"贴座位

  /* 不出方位置提示"不出"（跟随出牌方）*/
  io.to(state.roomCode).emit('player:passed', { seat: mySeat.seat, name: mySeat.name });

  if (isAuto) {
    io.to(state.roomCode).emit('game:auto_passed', { seat: mySeat.seat, name: mySeat.name });
  }

  const doneSeats   = new Set(state.finishOrder.map(f => f.seat));
  const activeSeats = state.seats.filter(s => !doneSeats.has(s.seat));
  const leaderAlive = activeSeats.some(s => s.seat === state.leadSeat);
  const needed      = leaderAlive ? activeSeats.length - 1 : activeSeats.length;

  if (state.passCount >= needed) {
    state.lastPlay  = null;
    state.passCount = 0;
    state.seatPlays = {};                 // 本墩结束，清空桌面，赢家另起一墩
    if (leaderAlive) {
      state.turnSeat = state.leadSeat;
    } else {
      state.turnSeat = nextSeat(state.leadSeat, state.seats, state.finishOrder);
      state.leadSeat = state.turnSeat;
    }
    io.to(state.roomCode).emit('game:trick_won', { seat: state.turnSeat });
  } else {
    state.turnSeat = nextSeat(mySeat.seat, state.seats, state.finishOrder);
    delete state.seatPlays[state.turnSeat];   // 轮到下一家，清掉其上一手
  }

  await persistState(state);
  broadcastState(io, state);
  startTurnTimer(io, state);
  return { ok: true };
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
               r.level_team1, r.level_team2, r.round_count, r.banker_team,
               r.wins_team1, r.wins_team2
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

      /* 重连：清除掉线标记并广播（阶段九）*/
      const wasDisconnected = isSeatDisconnected(state, seat.seat);
      if (wasDisconnected) {
        state.disconnected.delete(seat.seat);
        io.to(roomCode).emit('game:player_connection', {
          seat: seat.seat, name: seat.display_name, connected: true
        });
        /* 若正轮到该玩家，用正常时长重启计时 */
        if (state.turnSeat === seat.seat) startTurnTimer(io, state);
      }

      const myHand  = sortHand(state.hands[String(player.id)] || []);
      const players = state.seats.map(s => ({
        seat:      s.seat,
        team:      s.team,
        name:      s.name,
        cardCount: (state.hands[String(s.playerId)] || []).length,
        isMe:      s.playerId === player.id,
        playerId:  s.playerId
      }));

      /* 胜局(盘胜)=过A次数，存于房间 */
      const winsTeam1 = parseInt(seat.wins_team1 || 0);
      const winsTeam2 = parseInt(seat.wins_team2 || 0);

      socket.emit('game:hand', {
        hand: myHand, myPlayerId: player.id,
        mySeat: seat.seat, myTeam: seat.team,
        gameMode: seat.game_mode, roomCode,
        roundNumber: round.round_number,
        levelTeam1: state.levelTeam1,
        levelTeam2: state.levelTeam2,
        levelCard:  state.levelCard,
        winsTeam1, winsTeam2,
        players
      });

      broadcastState(io, state);

      /* 若游戏进行中但计时器丢失（服务器重启后重建），重新启动 */
      if (!state.turnTimer && !state.tributePhase &&
          state.finishOrder.length < state.totalPlayers - 1) {
        startTurnTimer(io, state);
      }

      /* 若进贡阶段仍在进行（断线重连）*/
      if (state.tributePhase) {
        socket.emit('tribute:phase', {
          exchanges: state.tributePhase.exchanges.map(e => ({
            giverId: e.giverId, receiverId: e.receiverId,
            mustGiveCard: e.mustGiveCard, tributeCard: e.tributeCard,
            resisted: e.resisted, stage: e.stage
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

      const result = await applyPlay(io, state, player.id, cards, false);
      if (result.error) socket.emit('play:invalid', { message: result.error });

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

      const result = await applyPass(io, state, player.id, false);
      if (result.error) socket.emit('play:invalid', { message: result.error });

    } catch (e) {
      console.error('[play:pass]', e.message);
    }
  });

  /* ── 进贡：贡者手动点最大牌交出 ── */
  socket.on('tribute:give', async function(data) {
    try {
      const { token, roomCode, card } = data;
      const state = gameStates.get(roomCode);
      if (!state || !state.tributePhase) return;

      const player = await queryOne('SELECT id FROM gdo_players WHERE player_token=$1', [token]);
      if (!player) return;

      const ex = state.tributePhase.exchanges.find(
        e => e.stage === 'give' && e.giverId === player.id
      );
      if (!ex) return socket.emit('tribute:invalid', { message: '您无需进贡或已完成' });

      /* 只能进贡手中最大的牌（排除逢人配）*/
      if (card !== ex.mustGiveCard)
        return socket.emit('tribute:invalid', { message: '必须进贡您手中最大的牌' });
      const hand = state.hands[String(player.id)] || [];
      if (!hand.includes(card))
        return socket.emit('tribute:invalid', { message: '牌不在手中' });

      const newHand = [...hand];
      newHand.splice(newHand.indexOf(card), 1);
      state.hands[String(player.id)] = newHand;
      ex.tributeCard = card;
      ex.stage       = 'return';
      await persistState(state);

      socket.emit('game:hand_update', { hand: sortHand(newHand) });
      io.to(roomCode).emit('tribute:card_flew', {
        giverId: ex.giverId, receiverId: ex.receiverId, tributeCard: card
      });
    } catch (e) {
      console.error('[tribute:give]', e.message);
    }
  });

  /* ── 还贡：接收方选择归还的牌（点数≤10、非逢人配）── */
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
        e => e.stage === 'return' && e.receiverId === player.id
      );
      if (!ex) return socket.emit('tribute:invalid', { message: '还没轮到您还贡或已完成' });

      /* 验证：还贡的牌必须在接收方当前手中 */
      const receiverHand = state.hands[String(player.id)] || [];
      if (!receiverHand.includes(returnCard))
        return socket.emit('tribute:invalid', { message: '请选择手中的牌还贡' });

      /* 还牌限制：不可为逢人配(红桃级牌)，且点数不得大于10 */
      const wild = _wildCard(state.levelCard);
      if (returnCard === wild)
        return socket.emit('tribute:invalid', { message: '红桃级牌(逢人配)不可用于还贡' });
      if (_rankVal(returnCard) > 10)
        return socket.emit('tribute:invalid', { message: '还贡的牌点数不得大于10' });

      /* 执行交换：接收方 +tributeCard -returnCard；进贡方 +returnCard */
      const newRHand = [...receiverHand, ex.tributeCard];
      newRHand.splice(newRHand.indexOf(returnCard), 1);
      state.hands[String(player.id)]    = newRHand;
      state.hands[String(ex.giverId)]   = [...(state.hands[String(ex.giverId)] || []), returnCard];

      ex.returnCard = returnCard;
      ex.stage      = 'done';
      state.tributePhase.pendingCount--;

      socket.emit('game:hand_update', { hand: sortHand(newRHand) });
      io.to(roomCode).emit('tribute:exchange_done', {
        giverId: ex.giverId, receiverId: ex.receiverId,
        tributeCard: ex.tributeCard, returnCard
      });

      /* 所有还贡完毕 → 按首抓规则开局 */
      if (state.tributePhase.pendingCount === 0) {
        const ls = state.tributePhase.leadSeat;
        if (ls != null) { state.turnSeat = ls; state.leadSeat = ls; }
        state.tributePhase = null;

        await query(
          `UPDATE gdo_rounds SET hands_json=$1, current_hands_json=$1 WHERE id=$2`,
          [JSON.stringify(state.hands), state.roundId]
        );
        await persistState(state);
        await query(`UPDATE gdo_rooms SET tribute_json=NULL WHERE room_code=$1`, [roomCode]);

        io.to(roomCode).emit('tribute:done', {});
        io.to(roomCode).emit('game:starting', { roomCode, roundId: state.roundId });
        startTurnTimer(io, state);
      }
    } catch (e) {
      console.error('[tribute:return]', e.message);
    }
  });

  /* ── 断线处理（阶段九：标记掉线 + 广播 + 缩短其回合计时）── */
  socket.on('disconnect', function() {
    try {
      for (const state of gameStates.values()) {
        const seatObj = state.seats.find(s => s.socketId === socket.id);
        if (!seatObj) continue;
        seatObj.socketId = null;
        state.disconnected.add(seatObj.seat);
        io.to(state.roomCode).emit('game:player_connection', {
          seat: seatObj.seat, name: seatObj.name, connected: false
        });
        /* 若正轮到掉线者，缩短计时尽快托管 */
        if (state.turnSeat === seatObj.seat && state.turnTimer) {
          startTurnTimer(io, state);
        }
      }
    } catch (e) { console.error('[game.disconnect]', e.message); }
  });

};

module.exports.initGameState     = initGameState;
module.exports.startTributePhase = startTributePhase;

/* 供离线集成测试使用（阶段十）*/
module.exports._test = {
  applyPlay, applyPass, onTurnTimeout, startTurnTimer, clearTurnTimer,
  nextSeat, broadcastState, isSeatDisconnected,
  TURN_SECONDS, DC_TURN_SECONDS, gameStates
};
