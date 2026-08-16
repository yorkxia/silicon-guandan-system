/* 掼蛋 · 规则型托管机器人（协作智能版）
   为掉线(托管)座位挑一手合法出牌，核心是「与队友配合、只压对手」：
   - 领出(无上家牌)：打「最小的普通牌」——绝不率先甩出级牌 / 红桃级牌(逢人配) / 大小王，
     这些是掼蛋里最值钱的牌，浪费在领出上等于自杀。优先甩掉不成对的低散牌以保留对子。
   - 跟牌：先看「当前这墩是谁领先」——
       · 若领先的是【自己队友】(且队友尚未出完)：默认「不压」，把这一墩让给队友，
         只有当自己能「一手出完(走牌)」时才越过队友出牌抢跑。
       · 若领先的是【对手】(或已出完的队友)：枚举 单/对/三张/三带二/炸弹 中能压过的组合，
         优先用「普通牌」压，能不动级牌/逢人配/王就绝不动；且不为对手一手小的单/对
         白扔炸弹(除非能顺势走完、对手即将跑牌、或对手本身就出的大牌/炸弹)。
   正确性由 detectType/canBeat 保证——只返回通过压牌校验的组合，applyPlay 还会二次校验。
   四人六人共用同一策略(队伍归属用 state.seats[].team 判定，与人数无关)。*/
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

function pickBotPlay(state, seatObj) {
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

  /* ② 对手(或已出完的队友)领先：要压，但用最省的方式 */
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
  /* 值得炸：能顺势走完 / 对手本身就是炸弹或大牌组 / 对手快跑了(剩牌≤6) / 不是便宜小牌 */
  const worthBomb  = canGoOut || lastIsBomb || oppRemain <= 6 || !cheapPlay;
  if (!worthBomb) return null;                                      // 省下炸弹，这一小墩不接

  cands.sort((a, b) => a.bomb - b.bomb || a.cards.length - b.cards.length || a.waste - b.waste);
  return cands[0].cards;
}

module.exports = { pickBotPlay };
