/* 掼蛋 · 规则型托管机器人（协作智能版）
   为掉线(托管)座位挑一手合法出牌，核心是「与队友配合、只压对手」：
   - 领出(无上家牌)：先按 determineRole 判定自己是主攻手(carry)还是辅助手(support)——
       · 主攻手：优先出「张数最多的一组」尽快清空手牌(对子/三张优先于单张)。
       · 辅助手(或角色不明，默认)：打「最小的普通牌」——绝不率先甩出级牌 / 红桃级牌(逢人配) /
         大小王，这些是掼蛋里最值钱的牌，浪费在领出上等于自杀；若队友最近一手出的是对子，
         优先领出对子而非单张，喂队友想要的牌型。
   - 跟牌：先看「当前这墩是谁领先」——
       · 若领先的是【自己队友】(且队友尚未出完)：默认「不压」，把这一墩让给队友，
         只有当自己能「一手出完(走牌)」时才越过队友出牌抢跑。
       · 若领先的是【活着的对手】、且我这一 pass 不会让本墩直接收官、且 pass 后下一个
         出牌人正是活着的队友(接风位)：同样默认「不压」，让队友接风，唯一例外仍是能一手走完。
       · 其余情况(领先的是对手/已出完的队友，且不满足接风位)：枚举 单/对/三张/三带二/炸弹
         中能压过的组合，优先用「普通牌」压，能不动级牌/逢人配/王就绝不动；
         且不为对手一手小的单/对白扔炸弹——除非能顺势走完、对手本身出的是大牌/炸弹、
         对手快跑了(剩牌≤6)、或队友快跑了(剩牌≤3)且需要抢回牌权。
   正确性由 detectType/canBeat 保证——只返回通过压牌校验的组合，applyPlay 还会二次校验。
   四人六人共用同一策略(队伍归属用 state.seats[].team 判定，与人数无关)。

   安全约定(绝不允许出牌卡死)：本函数外层包一层 try/catch，任何未预期异常一律按「压不过/
   无牌可出」处理返回 null——调用方(socket/game.js、game6.js 的超时托管、socket/botRunner.js)
   本身就已经把 null 当作合法结果处理(有上家牌→自动不出；无上家牌→兜底出最小单张)，
   所以这里即使出 bug 也只会退化成「保守出牌」，不会冻结回合。*/
const { sortHand, rankVal } = require('./cards');
const {
  detectType, canBeat, isBomb,
  detectType6p, canBeat6p, isBomb6p
} = require('./cardTypes');

const RANK_CHAR = { 10:'T', 11:'J', 12:'Q', 13:'K', 14:'A' };

/* 生成一组「牌值 / 是否级牌 / 是否逢人配 / 是否王」的判定工具（依当前级牌） */
function makeCardTools(level) {
  const wild    = level ? ('H' + (RANK_CHAR[level] || String(level))) : null;  // 红桃级牌=逢人配
  const isJoker = (c) => c === 'BJ' || c === 'LJ';
  const isWild  = (c) => wild != null && c === wild;
  const isLevel = (c) => !isJoker(c) && level != null && c.slice(1) === (RANK_CHAR[level] || String(level));
  /* 甩牌代价：数值越大越舍不得出。逢人配 > 王 > 级牌 > 普通(按点数) */
  const wasteCost = (c) => {
    if (isWild(c))  return 100000;                 // 逢人配：几乎永不主动浪费
    if (c === 'BJ') return 9000;
    if (c === 'LJ') return 8000;
    if (isLevel(c)) return 5000;                   // 级牌大于A，别当垃圾甩出
    return rankVal(c);                             // 普通牌：点数即代价(2最便宜)
  };
  return { wild, isJoker, isWild, isLevel, wasteCost };
}

/* 角色动态判定：每次调用都重新评估，不缓存。参照 PDF 阈值：
   主攻手 carry / 辅助手 support，满足两条门槛项即判定为该角色；
   同花顺子集探测成本高、暂不做，"持有强控场牌"简化为"手里有≥1个四张以上炸弹"。
   平局或都不满足 → 默认 support(与现有"领出打最小单张"的行为保持一致，不引入新行为)。 */
function determineRole(state, seatObj, is6) {
  const level   = state.levelCard;
  const T       = makeCardTools(level);
  const hand    = state.hands[String(seatObj.playerId)] || [];
  const handLen = hand.length;
  if (!handLen) return 'support';

  const byRank = {};
  hand.forEach(c => { const r = (c === 'BJ' || c === 'LJ') ? c : c.slice(1); (byRank[r] = byRank[r] || []).push(c); });
  const groups = Object.values(byRank);
  const hasBomb     = groups.some(g => g.length >= 4);
  const hasControl  = hand.some(c => c === 'BJ' || T.isLevel(c) || T.isWild(c));
  const pairPlusCnt = groups.filter(g => g.length >= 2).length;

  const teammates = (state.seats || []).filter(s =>
    s.team === seatObj.team && s.seat !== seatObj.seat &&
    !(state.finishOrder || []).some(f => f.seat === s.seat));
  const tmLens = teammates.map(s => (state.hands[String(s.playerId)] || []).length);

  const carryThresh   = is6 ? 9  : 7;
  const supportThresh = is6 ? 11 : 9;

  let carryScore = 0;
  if (handLen <= carryThresh) carryScore++;
  if (hasBomb) carryScore++;
  if (hasControl) carryScore++;
  if (tmLens.some(n => n > handLen)) carryScore++;

  let supportScore = 0;
  if (handLen >= supportThresh) supportScore++;
  if (pairPlusCnt <= 1) supportScore++;
  if (!hasBomb) supportScore++;
  if (tmLens.some(n => n > 0 && n < handLen)) supportScore++;

  let role = (carryScore >= 2 && carryScore > supportScore) ? 'carry' : 'support';

  /* 强制切换：队友剩牌很少 → 优先保护(support)；自己剩牌很少 → 优先冲刺(carry)，
     两者都满足时以"冲刺自己"为最终结果(直接可执行、收益确定)。 */
  if (tmLens.some(n => n > 0 && n <= 5)) role = 'support';
  if (handLen <= 3) role = 'carry';

  return role;
}

/* 座位序号工具：跳过已出完的座位找下一个。与 socket/game.js、game6.js 里的 nextSeat 逻辑一致，
   这里独立实现一份是为了不反向依赖 game.js(它本身 require 了本文件，避免循环依赖)。*/
function nextActiveSeat(fromSeat, seats, finishOrder) {
  const done = new Set((finishOrder || []).map(f => f.seat));
  const nums = seats.map(s => s.seat).sort((a, b) => a - b);
  const idx  = nums.indexOf(fromSeat);
  for (let i = 1; i <= nums.length; i++) {
    const s = nums[(idx + i) % nums.length];
    if (!done.has(s)) return s;
  }
  return fromSeat;
}

/* 记牌器(基础版)：只统计"整局已出牌张数 / 总牌数"是否达到残局线(PDF 8.1 第5步 ≥70%已出)。
   不做逐点数未见牌分布推断(成本高、暂不做)。 */
function isEndgamePhase(state) {
  const totalDeck = state.gameMode === '6p' ? 162 : 108;
  const played = (state.playLog || []).reduce((s, p) => s + (p && p.cards ? p.cards.length : 0), 0);
  return played / totalDeck >= 0.7;
}

function pickBotPlayInner(state, seatObj) {
  const is6      = state.gameMode === '6p';
  const detectFn = is6 ? detectType6p : detectType;
  const beatFn   = is6 ? canBeat6p   : canBeat;
  const bombFn   = is6 ? isBomb6p    : isBomb;
  const level    = state.levelCard;
  const hand     = sortHand(state.hands[String(seatObj.playerId)] || []);   // 降序，末位点数最小
  if (!hand.length) return null;
  const T = makeCardTools(level);

  /* 按点数分组(大小王各自成组) */
  const byRank = {};
  for (const c of hand) {
    const r = (c === 'BJ' || c === 'LJ') ? c : c.slice(1);
    (byRank[r] = byRank[r] || []).push(c);
  }
  const groups = Object.values(byRank);

  /* ── 领出：打最小的「普通散牌」，绝不率先甩级牌/逢人配/王 ── */
  if (!state.lastPlay) {
    /* 普通牌组(非级牌、非王、不含逢人配)，按点数升序、同点优先甩单张(size小)以保住对子 */
    const plainGroups = groups
      .filter(g => !g.some(c => T.isJoker(c) || T.isLevel(c) || T.isWild(c)))
      .sort((a, b) => rankVal(a[0]) - rankVal(b[0]) || a.length - b.length);
    if (plainGroups.length) {
      /* 主攻手：优先出「张数最多的一组」尽快清空手牌(对子/三张优先于单张)，
         同长度取点数小的、把大牌留到后面；不做同花顺/顺子探测(见文档说明)。
         注意排除 4 张及以上的组(那已经是炸弹)——领出时绝不主动把炸弹当普通牌甩出去，
         炸弹的价值在压制/夺权，不在于"清空手牌快一张"；这种情况下退回默认逻辑。
         辅助手(或角色不明)走下面已有的"喂队友"逻辑，行为不变。 */
      const role = determineRole(state, seatObj, is6);
      if (role === 'carry') {
        const nonBombGroups = plainGroups.filter(g => g.length <= 3);
        if (nonBombGroups.length) {
          const big = nonBombGroups.slice().sort((a, b) => b.length - a.length || rankVal(a[0]) - rankVal(b[0]))[0];
          return big.slice();
        }
      }
      /* 队友最近一手若是对子 → 优先领出对子(有则用)，喂其想要的牌型 */
      const teammateSeats = (state.seats || [])
        .filter(s => s.team === seatObj.team && s.seat !== seatObj.seat &&
                     !(state.finishOrder || []).some(f => f.seat === s.seat))
        .map(s => s.seat);
      const seatLastType   = state.seatLastType || {};
      const teammateWantsPair = teammateSeats.some(s => seatLastType[s] === 'pair');
      if (teammateWantsPair) {
        const pairGroup = plainGroups.find(g => g.length >= 2);
        if (pairGroup) return pairGroup.slice(0, 2);
      }
      const g = plainGroups[0];
      return [ g[g.length - 1] ];                  // 该组最小的一张
    }
    /* 手里只剩级牌/逢人配/王(残局)：被迫甩，挑代价最小者 */
    let lead = hand[0];
    for (const c of hand) if (T.wasteCost(c) < T.wasteCost(lead)) lead = c;
    return [lead];
  }

  /* ── 跟牌：先判断「当前这墩」是谁在领先 ── */
  const curPt = state.lastPlay.playType;
  const lastSeatObj  = state.seats.find(s => s.seat === state.lastPlay.seat);
  const lastTeam     = lastSeatObj ? lastSeatObj.team : null;
  const lastFinished = (state.finishOrder || []).some(f => f.seat === state.lastPlay.seat);
  /* 队友领先 = 领先者与我同队且尚未出完；已出完的队友不再从"赢墩"获益，按对手处理以免把主动权白送对家 */
  const teammateLeads = (lastTeam != null && lastTeam === seatObj.team && !lastFinished);

  /* 枚举能压过上家的候选组合 */
  const cands = [];
  const push  = (cards) => {
    const pt = detectFn(cards, level);
    if (pt && beatFn(pt, curPt)) {
      const waste = cards.reduce((s, c) => s + T.wasteCost(c), 0);   // 这组用掉多少「贵牌」
      cands.push({ cards, waste, bomb: bombFn(pt) ? 1 : 0 });
    }
  };

  hand.forEach(c => push([c]));                                       // 单张
  groups.forEach(g => { if (g.length >= 2) push(g.slice(0, 2)); });   // 对子
  groups.forEach(g => { if (g.length >= 3) push(g.slice(0, 3)); });   // 三张
  groups.forEach(g3 => { if (g3.length >= 3)                          // 三带二
    groups.forEach(g2 => { if (g2 !== g3 && g2.length >= 2) push([...g3.slice(0, 3), ...g2.slice(0, 2)]); });
  });
  groups.forEach(g => { for (let k = 4; k <= g.length; k++) push(g.slice(0, k)); }); // 炸弹(4+同点)

  if (!cands.length) return null;   // 压不过 → 不出

  const emptiesHand = (c) => c.cards.length === hand.length;         // 一手打光=走牌

  /* ① 队友正领先：默认让墩(不压)，唯一例外——能一手走完就抢跑，锁定本队一个名次 */
  if (teammateLeads) {
    const goOut = cands.filter(emptiesHand)
                       .sort((a, b) => a.bomb - b.bomb || a.waste - b.waste)[0];
    return goOut ? goOut.cards : null;                              // 否则 pass，把这墩留给队友
  }

  /* ①-a 队友接风位：领先的是活着的对手，且我这一 pass 不会让本墩直接收官(收官会转回对手手上，
     让不让都一样，不特殊处理)，且 pass 后下一个出牌人正是活着的队友 → 优先让墩，
     唯一例外仍是能一手走完。范围只限"领先者是活着的对手"，已出完的队友领先维持原有处理方式不变。*/
  const opponentLeading = (lastTeam != null && lastTeam !== seatObj.team && !lastFinished);
  if (opponentLeading) {
    const doneSeats   = new Set((state.finishOrder || []).map(f => f.seat));
    const activeSeats = (state.seats || []).filter(s => !doneSeats.has(s.seat));
    const passCount   = state.passCount || 0;
    const needed      = activeSeats.length - 1;   // 领先者(对手)活着，人数已在 opponentLeading 里保证
    const wouldClose  = (passCount + 1) >= needed;
    if (!wouldClose) {
      const nextSeatNum = nextActiveSeat(seatObj.seat, state.seats, state.finishOrder);
      const nextObj = (state.seats || []).find(s => s.seat === nextSeatNum);
      if (nextObj && nextObj.team === seatObj.team) {
        const goOut = cands.filter(emptiesHand)
                           .sort((a, b) => a.bomb - b.bomb || a.waste - b.waste)[0];
        return goOut ? goOut.cards : null;                          // pass，让队友接风
      }
    }
  }

  /* ② 对手(或已出完的队友)领先、且不在队友接风位：要压，但用最省的方式 */
  const nonBomb = cands.filter(c => c.bomb === 0);
  if (nonBomb.length) {
    /* 有普通牌型能压 → 张数少、用掉的贵牌最少者优先(尽量保住级牌/逢人配/王) */
    nonBomb.sort((a, b) => a.cards.length - b.cards.length || a.waste - b.waste);
    return nonBomb[0].cards;
  }

  /* 只能靠炸弹才压得过：别为对手一手「便宜的小单/小对」白扔炸弹 */
  const lastLen    = state.lastPlay.cards.length;
  const lastIsBomb = bombFn(curPt) ? 1 : 0;
  const oppRemain  = lastSeatObj ? (state.hands[String(lastSeatObj.playerId)] || []).length : 99;
  const canGoOut   = cands.some(emptiesHand);
  const cheapPlay  = lastLen <= 2 && !lastIsBomb;                   // 对手出的是小单/小对
  /* 队友是否正在冲刺(活着、剩牌≤3)且需要牌权：值得为其主动炸开对手的把持 */
  const teammateCritical = (state.seats || []).some(s => {
    if (s.team !== seatObj.team || s.seat === seatObj.seat) return false;
    if ((state.finishOrder || []).some(f => f.seat === s.seat)) return false;
    const n = (state.hands[String(s.playerId)] || []).length;
    return n > 0 && n <= 3;
  });
  /* 残局(整局已出≥70%)且手里有可用的中小炸弹(≤5张，天王炸/大炸弹依然只按上面几条判断)：
     适度放行控场，不必等到"不是便宜小牌"才动。cands 此处已全是炸弹(nonBomb 为空)，
     排序仍会优先选最小的那个，不会因为放行就跳去用大炸弹。 */
  const isEndgame = isEndgamePhase(state);
  const smallBombAvailable = cands.some(c => c.bomb === 1 && c.cards.length <= 5);
  /* 值得炸：能顺势走完 / 对手本身就是炸弹或大牌组 / 对手快跑了(剩牌≤6) / 队友快跑了需要夺权 /
     不是便宜小牌 / 残局且有中小炸弹可用 */
  const worthBomb  = canGoOut || lastIsBomb || oppRemain <= 6 || teammateCritical || !cheapPlay
                      || (isEndgame && smallBombAvailable);
  if (!worthBomb) return null;                                      // 省下炸弹，这一小墩不接

  cands.sort((a, b) => a.bomb - b.bomb || a.cards.length - b.cards.length || a.waste - b.waste);
  return cands[0].cards;
}

function pickBotPlay(state, seatObj) {
  try {
    return pickBotPlayInner(state, seatObj);
  } catch (e) {
    return null;   // 任何未预期异常一律退化为"压不过/无牌可出"，调用方已保证不会因此卡死回合
  }
}

/* 机器人还贡：合法牌(≤10、非逢人配、非级牌)里优先选「孤立单张」(该点数在整手牌里只有1张，
   不拆散已成型的对子/三张)，其次按点数从小到大；无合法牌则回退最小非逢人配、再回退最小任意牌。
   四人(socket/game.js)、六人(socket/game6.js)的机器人还贡共用这一份实现。*/
function pickReturnCard(hand, level) {
  hand = hand || [];
  if (!hand.length) return null;
  const wild = level ? ('H' + (RANK_CHAR[level] || String(level))) : null;
  const byRank = {};
  hand.forEach(c => {
    const r = (c === 'BJ' || c === 'LJ') ? c : c.slice(1);
    (byRank[r] = byRank[r] || []).push(c);
  });
  const rankOf = (c) => (c === 'BJ' || c === 'LJ') ? c : c.slice(1);
  const pick = (pool) => {
    if (!pool.length) return null;
    return pool.slice().sort((a, b) => {
      const isoA = (byRank[rankOf(a)] || []).length === 1 ? 0 : 1;
      const isoB = (byRank[rankOf(b)] || []).length === 1 ? 0 : 1;
      return isoA - isoB || rankVal(a) - rankVal(b);
    })[0];
  };
  const legal = hand.filter(c => c !== wild && !(level && rankVal(c) === level) && rankVal(c) <= 10);
  if (legal.length) return pick(legal);
  const fallback = hand.filter(c => c !== wild);
  return pick(fallback.length ? fallback : hand.slice());
}

module.exports = { pickBotPlay, pickReturnCard };
