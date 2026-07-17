/* 掼蛋 · 规则型托管机器人
   为掉线(托管)座位挑一手合法出牌：
   - 领出(无上家牌)：打最小单张，尽量不浪费大牌
   - 跟牌：枚举 单/对/三张/三带二/炸弹 中「能压过上家」的组合，选代价最小者；压不过则不出
   正确性由 detectType/canBeat 保证——只返回通过压牌校验的组合，applyPlay 还会二次校验。
   说明：本 MVP 暂不主动接顺子/连对/钢板(直接不出)，四人六人共用同一策略。*/
const { sortHand } = require('./cards');
const {
  detectType, canBeat, isBomb,
  detectType6p, canBeat6p, isBomb6p
} = require('./cardTypes');

function pickBotPlay(state, seatObj) {
  const is6      = state.gameMode === '6p';
  const detectFn = is6 ? detectType6p : detectType;
  const beatFn   = is6 ? canBeat6p   : canBeat;
  const bombFn   = is6 ? isBomb6p    : isBomb;
  const level    = state.levelCard;
  const hand     = sortHand(state.hands[String(seatObj.playerId)] || []);   // 降序，末位最小
  if (!hand.length) return null;

  /* 领出：打最小单张 */
  if (!state.lastPlay) return [hand[hand.length - 1]];

  /* 跟牌：枚举候选组合，保留能压过上家的 */
  const curPt = state.lastPlay.playType;
  const cands = [];
  const push  = (cards) => {
    const pt = detectFn(cards, level);
    if (pt && beatFn(pt, curPt)) cands.push({ cards, val: pt.value || 0, bomb: bombFn(pt) ? 1 : 0 });
  };

  /* 按点数分组(大小王各自成组) */
  const byRank = {};
  for (const c of hand) {
    const r = (c === 'BJ' || c === 'LJ') ? c : c.slice(1);
    (byRank[r] = byRank[r] || []).push(c);
  }
  const groups = Object.values(byRank);

  hand.forEach(c => push([c]));                                       // 单张
  groups.forEach(g => { if (g.length >= 2) push(g.slice(0, 2)); });   // 对子
  groups.forEach(g => { if (g.length >= 3) push(g.slice(0, 3)); });   // 三张
  groups.forEach(g3 => { if (g3.length >= 3)                          // 三带二
    groups.forEach(g2 => { if (g2 !== g3 && g2.length >= 2) push([...g3.slice(0, 3), ...g2.slice(0, 2)]); });
  });
  groups.forEach(g => { for (let k = 4; k <= g.length; k++) push(g.slice(0, k)); }); // 炸弹(4+同点)

  if (!cands.length) return null;   // 压不过 → 不出
  /* 优先：非炸弹 → 张数少 → 点数小（尽量不浪费炸弹和大牌）*/
  cands.sort((a, b) => a.bomb - b.bomb || a.cards.length - b.cards.length || a.val - b.val);
  return cands[0].cards;
}

module.exports = { pickBotPlay };
