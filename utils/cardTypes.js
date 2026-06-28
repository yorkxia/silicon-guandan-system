/* 掼蛋 · 牌型识别 / 压牌判断 / 结算逻辑 */
const { rankVal } = require('./cards');

/* ── 牌型识别 ──────────────────────────────────────── */
function detectType(cards) {
  if (!cards || cards.length === 0) return null;
  const n   = cards.length;
  const rv  = cards.map(rankVal).sort((a, b) => b - a);
  const suits = cards.map(c => (c === 'LJ' || c === 'BJ') ? 'J' : c[0]);

  // 天王炸：2大王 + 2小王
  const bj = cards.filter(c => c === 'BJ').length;
  const lj = cards.filter(c => c === 'LJ').length;
  if (n === 4 && bj === 2 && lj === 2)
    return { type: 'joker_bomb', value: 99999, label: '天王炸' };

  // Joker 不能进其他牌型
  if (cards.some(c => c === 'LJ' || c === 'BJ')) return null;

  // 炸弹：4张及以上相同点数
  if (n >= 4 && rv.every(r => r === rv[0])) {
    const uniqSuits = [...new Set(suits)];
    if (uniqSuits.length === 1)
      return { type: 'flush_bomb', size: n, value: rv[0], label: `${n}张同花炸` };
    return { type: 'bomb', size: n, value: rv[0], label: `${n}张炸弹` };
  }

  if (n === 1) return { type: 'single', value: rv[0], label: '单张' };

  if (n === 2 && rv[0] === rv[1])
    return { type: 'pair', value: rv[0], label: '对子' };

  if (n === 3 && rv.every(r => r === rv[0]))
    return { type: 'triple', value: rv[0], label: '三张' };

  // 三带二（葫芦）
  if (n === 5) {
    const fh = findFullHouse(rv);
    if (fh) return { type: 'fullhouse', value: fh, label: '三带二' };
  }

  // 双顺（钢板）：≥3对连续对子（6张+偶数张）
  if (n >= 6 && n % 2 === 0) {
    const ds = findDoubleStraight(rv);
    if (ds !== null)
      return { type: 'dbl_straight', size: n / 2, value: ds, label: `${n/2}连对` };
  }

  // 顺子（含同花顺）：≥5张不同点数连续
  if (n >= 5) {
    const uniqRv = [...new Set(rv)].sort((a, b) => b - a);
    if (uniqRv.length === n && isConsec(uniqRv)) {
      const uniqSuits = [...new Set(suits)];
      if (uniqSuits.length === 1)
        return { type: 'flush_straight', size: n, value: uniqRv[0], label: `${n}张同花顺` };
      return { type: 'straight', size: n, value: uniqRv[0], label: `${n}张顺子` };
    }
  }

  return null;
}

function isConsec(desc) {
  for (let i = 0; i < desc.length - 1; i++)
    if (desc[i] - desc[i + 1] !== 1) return false;
  return true;
}

function findFullHouse(rv) {
  const cnt = counts(rv);
  const e = Object.entries(cnt);
  if (e.length !== 2) return null;
  const [[r1, c1], [r2, c2]] = e;
  if (c1 === 3 && c2 === 2) return +r1;
  if (c1 === 2 && c2 === 3) return +r2;
  return null;
}

function findDoubleStraight(rv) {
  const cnt = counts(rv);
  if (Object.values(cnt).some(c => c !== 2)) return null;
  const rs = Object.keys(cnt).map(Number).sort((a, b) => b - a);
  if (!isConsec(rs)) return null;
  return rs[0];
}

function counts(arr) {
  const m = {};
  for (const v of arr) m[v] = (m[v] || 0) + 1;
  return m;
}

/* ── 炸弹判断 ─────────────────────────────────────── */
function isBomb(pt) {
  return pt && ['bomb','flush_bomb','flush_straight','joker_bomb'].includes(pt.type);
}

/* ── 压牌判断：newPt 能否压过 curPt ─────────────── */
function canBeat(newPt, curPt) {
  if (!curPt) return !!newPt;
  if (!newPt)  return false;

  if (newPt.type === 'joker_bomb') return true;
  if (curPt.type === 'joker_bomb') return false;

  // 炸弹体系（强度：同花顺 > 同花炸 > 普通炸，张数多>少，点数高>低）
  if (isBomb(newPt) && !isBomb(curPt)) return true;
  if (!isBomb(newPt) && isBomb(curPt)) return false;

  if (isBomb(newPt) && isBomb(curPt)) {
    const rank = { flush_straight: 3, flush_bomb: 2, bomb: 1 };
    const nr = rank[newPt.type] || 0, cr = rank[curPt.type] || 0;
    if (nr !== cr) return nr > cr;
    if (newPt.size !== curPt.size) return newPt.size > curPt.size;
    return newPt.value > curPt.value;
  }

  // 普通牌型：类型必须相同，张数必须相同（顺子/双顺），点数更高才能压
  if (newPt.type !== curPt.type) return false;
  if (newPt.size !== undefined && newPt.size !== curPt.size) return false;
  return newPt.value > curPt.value;
}

/* ── 结算 ──────────────────────────────────────────── */
const LEVEL_NAME = ['','','2','3','4','5','6','7','8','9','10','J','Q','K','A'];
function levelName(n) { return LEVEL_NAME[n] || String(n); }

function settle(finishOrder, lv1, lv2) {
  // finishOrder[0]=头游 [1]=二游 [2]=三游 [3]=末游
  const headTeam = finishOrder[0].team;
  let resultType, delta, winnerTeam;

  if (finishOrder[1].team === headTeam) {
    resultType = '大胜'; delta = 3;
  } else if (finishOrder[2] && finishOrder[2].team === headTeam) {
    resultType = '小胜'; delta = 2;
  } else {
    resultType = '末胜'; delta = 1;
  }
  winnerTeam = headTeam;

  const newLv1 = winnerTeam === 1 ? Math.min(lv1 + delta, 14) : lv1;
  const newLv2 = winnerTeam === 2 ? Math.min(lv2 + delta, 14) : lv2;
  return { resultType, winnerTeam, delta, newLv1, newLv2 };
}

/* 从手牌数组里移除指定牌（允许重复牌），返回新手牌或 null（牌不存在） */
function removeCards(hand, played) {
  const h = [...hand];
  for (const c of played) {
    const i = h.indexOf(c);
    if (i === -1) return null;
    h.splice(i, 1);
  }
  return h;
}

module.exports = { detectType, canBeat, isBomb, settle, levelName, removeCards };
