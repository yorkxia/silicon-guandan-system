/* 掼蛋 · 规则型托管机器人（智能优化版）
   为掉线(托管)座位挑一手合法出牌：
   - 领出(无上家牌)：打「最小的普通牌」——绝不率先甩出级牌 / 红桃级牌(逢人配) / 大小王，
     这些是掼蛋里最值钱的牌，浪费在领出上等于自杀。优先甩掉不成对的低散牌以保留对子。
   - 跟牌：枚举 单/对/三张/三带二/炸弹 中「能压过上家」的组合，代价最小者优先；
     代价把「用掉级牌/逢人配/王」计为高成本，能用普通牌压过就绝不动大牌；压不过则不出。
   正确性由 detectType/canBeat 保证——只返回通过压牌校验的组合，applyPlay 还会二次校验。
   四人六人共用同一策略。*/
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

  /* ── 跟牌：枚举候选组合，保留能压过上家的 ── */
  const curPt = state.lastPlay.playType;
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
  /* 优先级：不用炸弹 → 张数少 → 用掉的贵牌代价最小(尽量保住级牌/逢人配/王) */
  cands.sort((a, b) => a.bomb - b.bomb || a.cards.length - b.cards.length || a.waste - b.waste);
  return cands[0].cards;
}

module.exports = { pickBotPlay };
