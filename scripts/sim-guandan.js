/* 掼蛋规则引擎 · 机器人自对弈仿真测试（纯逻辑、不连数据库/socket）
   用真实的 cardTypes(牌型/压牌/结算/进贡) + bot(pickBotPlay) 驱动全流程，
   复刻 game.js 的回合/收墩/接风逻辑，跑大量局并检查不变式，暴露规则/机器人 bug。
   用法：node scripts/sim-guandan.js [局数] */
const { createDoubleDeck, createTripleDeck, shuffle, deal4, deal6, sortHand } = require('../utils/cards');
const CT = require('../utils/cardTypes');
const { pickBotPlay } = require('../utils/bot');

/* ── 复刻 game.js 的座位轮转 / 接风(同队最近队友) ── */
function nextSeat(cur, seats, finishOrder) {
  const done = new Set(finishOrder.map(f => f.seat));
  const nums = seats.map(s => s.seat).sort((a, b) => a - b);
  const i = nums.indexOf(cur);
  for (let k = 1; k <= nums.length; k++) { const s = nums[(i + k) % nums.length]; if (!done.has(s)) return s; }
  return cur;
}
function nextTeammateSeat(from, seats, finishOrder) {
  const done = new Set(finishOrder.map(f => f.seat));
  const teamOf = {}; seats.forEach(s => teamOf[s.seat] = s.team);
  const my = teamOf[from];
  const nums = seats.map(s => s.seat).sort((a, b) => a - b);
  const i = nums.indexOf(from);
  for (let k = 1; k <= nums.length; k++) {
    const s = nums[(i + k) % nums.length];
    if (done.has(s) || teamOf[s] !== my) continue;
    return s;
  }
  return null;
}

let FAILS = [];
function check(cond, msg) { if (!cond) FAILS.push(msg); }

/* ── 跑一整局（发牌→出完→结算/进贡），返回结果与统计 ── */
function simRound(mode, level, roundTag) {
  const is6 = mode === '6p';
  const total = is6 ? 6 : 4;
  const detectFn = is6 ? CT.detectType6p : CT.detectType;
  const beatFn   = is6 ? CT.canBeat6p    : CT.canBeat;
  const settleFn = is6 ? CT.settle6p     : CT.settle;
  const tribFn   = is6 ? CT.computeTribute6p : CT.computeTribute4p;

  const deck   = shuffle(is6 ? createTripleDeck() : createDoubleDeck());
  const halves = is6 ? deal6(deck) : deal4(deck);
  const seats = [];
  const hands = {};
  for (let i = 0; i < total; i++) {
    const seat = i + 1, team = seat % 2 === 1 ? 1 : 2, pid = 'p' + seat;
    seats.push({ seat, team, playerId: pid });
    hands[pid] = halves[i];
  }
  const pidOf = s => 'p' + s;
  const seatObj = s => seats.find(x => x.seat === s);

  const state = { gameMode: mode, levelCard: level, hands, lastPlay: null };
  const finishOrder = [];
  let turnSeat = 1 + Math.floor(Math.random() * total);
  let leadSeat = turnSeat, passCount = 0;

  let iter = 0, MAXITER = 6000;
  while (iter++ < MAXITER) {
    /* 终局判断（同 game.js）：头游整队出完 或 只剩1家 */
    const headTeam = finishOrder.length ? finishOrder[0].team : 0;
    const headDone = headTeam ? finishOrder.filter(f => f.team === headTeam).length : 0;
    const teamSize = Math.floor(total / 2);
    if (headDone >= teamSize || finishOrder.length >= total - 1) break;

    const so = seatObj(turnSeat);
    const play = pickBotPlay(state, so);

    if (play && play.length) {
      const pt = detectFn(play, level);
      check(!!pt, `${roundTag} 机器人出了非法牌型: ${JSON.stringify(play)}`);
      if (state.lastPlay) check(pt && beatFn(pt, state.lastPlay.playType), `${roundTag} 跟牌压不过却出了: ${JSON.stringify(play)} vs ${state.lastPlay.playType.label}`);
      /* 从手牌移除 */
      const h = hands[pidOf(turnSeat)];
      for (const c of play) { const idx = h.indexOf(c); check(idx >= 0, `${roundTag} 出了手里没有的牌 ${c}`); if (idx >= 0) h.splice(idx, 1); }
      state.lastPlay = { seat: turnSeat, playType: pt };
      leadSeat = turnSeat; passCount = 0;
      if (h.length === 0) finishOrder.push({ position: finishOrder.length + 1, seat: turnSeat, playerId: pidOf(turnSeat), team: so.team });
      turnSeat = nextSeat(turnSeat, seats, finishOrder);
    } else {
      /* 不出 */
      check(!!state.lastPlay, `${roundTag} 先出方却选择了不出(引擎会拒绝)`);
      passCount++;
      const done = new Set(finishOrder.map(f => f.seat));
      const active = seats.filter(s => !done.has(s.seat));
      const leaderAlive = active.some(s => s.seat === leadSeat);
      const needed = leaderAlive ? active.length - 1 : active.length;
      if (passCount >= needed) {
        state.lastPlay = null; passCount = 0;
        if (leaderAlive) { turnSeat = leadSeat; }
        else {
          const relay = nextTeammateSeat(leadSeat, seats, finishOrder);
          const winnerTeam = seatObj(leadSeat).team;
          check(relay == null || seatObj(relay).team === winnerTeam, `${roundTag} 接风给了非同队! leader座${leadSeat}(队${winnerTeam}) → 座${relay}`);
          turnSeat = relay != null ? relay : nextSeat(leadSeat, seats, finishOrder);
          leadSeat = turnSeat;
        }
      } else {
        turnSeat = nextSeat(turnSeat, seats, finishOrder);
      }
    }
  }
  check(iter < MAXITER, `${roundTag} 局未能结束(可能死循环)`);

  /* 补齐名次 */
  const done = new Set(finishOrder.map(f => f.seat));
  seats.filter(s => !done.has(s.seat)).forEach(s => finishOrder.push({ position: finishOrder.length + 1, seat: s.seat, playerId: pidOf(s.seat), team: s.team }));
  check(finishOrder.length === total, `${roundTag} 名次数不对: ${finishOrder.length}/${total}`);

  /* 结算 */
  const res = settleFn(finishOrder, level, level);
  check(res && res.delta >= 1 && res.delta <= 4, `${roundTag} 结算 delta 异常: ${res && res.delta}`);
  check(res && (res.winnerTeam === 1 || res.winnerTeam === 2), `${roundTag} 结算 winnerTeam 异常`);

  /* 进贡角色检查：giver/receiver 必须异队；四人双下=2贡、单下=1贡 */
  const trib = tribFn(finishOrder, res.winnerTeam);
  (trib.exchanges || []).forEach(ex => {
    const g = seatObj(ex.giverSeat), r = seatObj(ex.receiverSeat);
    check(g && r && g.team !== r.team, `${roundTag} 进贡 giver/receiver 同队! 座${ex.giverSeat}→座${ex.receiverSeat}`);
  });

  return { finishOrder, res, tribCount: (trib.exchanges || []).length };
}

/* ── 主：跑 N 局 4人 + N 局 6人，各种级牌 ── */
const N = parseInt(process.argv[2] || '400', 10);
const levels = [2, 3, 5, 10, 13, 14];   // 含级牌为3(你的例子)等
let ok4 = 0, ok6 = 0;
for (let i = 0; i < N; i++) { const lv = levels[i % levels.length]; simRound('4p', lv, `[4人#${i} 级${lv}]`); ok4++; }
for (let i = 0; i < N; i++) { const lv = levels[i % levels.length]; simRound('6p', lv, `[6人#${i} 级${lv}]`); ok6++; }

console.log(`\n跑完：四人 ${ok4} 局 + 六人 ${ok6} 局`);
if (FAILS.length) {
  console.log(`\n❌ 发现 ${FAILS.length} 个问题（前20条）：`);
  FAILS.slice(0, 20).forEach(m => console.log('  - ' + m));
  process.exit(1);
} else {
  console.log('✅ 全部不变式通过：无非法出牌 / 无死循环 / 名次完整 / 结算合法 / 接风同队 / 进贡异队。');
}
