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

/* ══════════════════════════════════════════════════════
 * 六人掼蛋 · 扩展牌型体系
 * ══════════════════════════════════════════════════════ */

/* ── 6P 牌型识别 ── */
function detectType6p(cards) {
  if (!cards || cards.length === 0) return null;
  const n  = cards.length;
  const bj = cards.filter(c => c === 'BJ').length;
  const lj = cards.filter(c => c === 'LJ').length;

  /* 天王炸：3大王 + 3小王 */
  if (n === 6 && bj === 3 && lj === 3)
    return { type: 'joker_bomb', value: 99999, label: '天王炸' };

  /* 大王三张炸 */
  if (n === 3 && bj === 3)
    return { type: 'triple_bj', value: 160, label: '大王三炸' };

  /* 小王三张炸 */
  if (n === 3 && lj === 3)
    return { type: 'triple_lj', value: 150, label: '小王三炸' };

  /* Joker 不能进其他牌型 */
  if (cards.some(c => c === 'LJ' || c === 'BJ')) return null;

  /* 以下与四人版相同 */
  const rv    = cards.map(rankVal).sort((a, b) => b - a);
  const suits = cards.map(c => c[0]);

  if (n >= 4 && rv.every(r => r === rv[0])) {
    const uniqSuits = [...new Set(suits)];
    if (uniqSuits.length === 1)
      return { type: 'flush_bomb', size: n, value: rv[0], label: `${n}张同花炸` };
    return { type: 'bomb', size: n, value: rv[0], label: `${n}张炸弹` };
  }

  if (n === 1) return { type: 'single', value: rv[0], label: '单张' };
  if (n === 2 && rv[0] === rv[1]) return { type: 'pair', value: rv[0], label: '对子' };
  if (n === 3 && rv.every(r => r === rv[0])) return { type: 'triple', value: rv[0], label: '三张' };

  if (n === 5) {
    const fh = findFullHouse(rv);
    if (fh) return { type: 'fullhouse', value: fh, label: '三带二' };
  }

  if (n >= 6 && n % 2 === 0) {
    const ds = findDoubleStraight(rv);
    if (ds !== null) return { type: 'dbl_straight', size: n / 2, value: ds, label: `${n / 2}连对` };
  }

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

/* ── 6P 炸弹强度评分 ──
   层级（低→高）：
   普通4头炸(V=2..14) < 同花4头炸(102..114) < 3小王(150) < 3大王(160)
   < 普通5头炸(200+V) < 同花5头炸(300+V) < 普通6头炸(400+V) < ...
   < 同花顺(1e6+) < 天王炸(1e8)
*/
function bombScore6p(pt) {
  if (pt.type === 'joker_bomb')     return 1e8;
  if (pt.type === 'flush_straight') return 1e6 + pt.size * 100 + pt.value;
  if (pt.type === 'triple_bj')      return 160;
  if (pt.type === 'triple_lj')      return 150;
  if (pt.type === 'flush_bomb')     return (pt.size - 4) * 200 + 100 + pt.value;
  if (pt.type === 'bomb')           return (pt.size - 4) * 200 + pt.value;
  return 0;
}

/* ── 6P 炸弹判断 ── */
function isBomb6p(pt) {
  return pt && ['bomb','flush_bomb','flush_straight','joker_bomb','triple_bj','triple_lj'].includes(pt.type);
}

/* ── 6P 压牌判断 ── */
function canBeat6p(newPt, curPt) {
  if (!curPt) return !!newPt;
  if (!newPt)  return false;
  if (newPt.type === 'joker_bomb') return true;
  if (curPt.type === 'joker_bomb') return false;
  if (isBomb6p(newPt) && !isBomb6p(curPt)) return true;
  if (!isBomb6p(newPt) && isBomb6p(curPt)) return false;
  if (!isBomb6p(newPt)) {
    if (newPt.type !== curPt.type) return false;
    if (newPt.size !== undefined && newPt.size !== curPt.size) return false;
    return newPt.value > curPt.value;
  }
  return bombScore6p(newPt) > bombScore6p(curPt);
}

/* ── 6P 结算 ──────────────────────────────────────────
   finishOrder[0]=头游 .. finishOrder[5]=末游
   从末游往上数被抓的对方人数：
     6th=己方队友 → +1
     5th=己方队友，6th=对方 → +2
     4th=己方队友，5th+6th=对方 → +3
     4th+5th+6th=全对方 → +4
*/
function settle6p(finishOrder, lv1, lv2) {
  const headTeam = finishOrder[0].team;
  let delta, resultType;

  if (finishOrder[5].team === headTeam) {
    delta = 1; resultType = '末胜';
  } else if (finishOrder[4].team === headTeam) {
    delta = 2; resultType = '小胜';
  } else if (finishOrder[3].team === headTeam) {
    delta = 3; resultType = '大胜';
  } else {
    delta = 4; resultType = '全胜';
  }

  const winnerTeam = headTeam;
  const newLv1 = winnerTeam === 1 ? Math.min(lv1 + delta, 14) : lv1;
  const newLv2 = winnerTeam === 2 ? Math.min(lv2 + delta, 14) : lv2;
  return { resultType, winnerTeam, delta, newLv1, newLv2 };
}

/* ── 6P 进贡计算 ──────────────────────────────────────
   对方在4th/5th/6th的玩家需进贡。
   进贡对象：头游方按完成顺序依次接收（头游拿最大）。
   返回 { giverIds, receiverIds, headPlayerId, tributeLeaderId }
     tributeLeaderId：给头游进贡的人（还贡后由其先出牌）
*/
function computeTribute6p(finishOrder, headTeam) {
  const givers    = [];
  const receivers = [];

  /* 找对方在4th/5th/6th的玩家（indices 3,4,5） */
  for (let i = 3; i <= 5; i++) {
    if (finishOrder[i].team !== headTeam) givers.push(finishOrder[i]);
  }

  /* 头游方按完成顺序 */
  const headTeamOrder = finishOrder.filter(f => f.team === headTeam);

  /* 按接收方数量配对（givers已按完成顺序排列，接收方也按顺序） */
  for (let i = 0; i < givers.length; i++) {
    if (headTeamOrder[i]) receivers.push(headTeamOrder[i]);
  }

  return {
    headPlayerId:    headTeamOrder[0] ? headTeamOrder[0].playerId : null,
    tributeLeaderId: givers.length > 0 && receivers[0]?.playerId === headTeamOrder[0]?.playerId
                       ? givers[0].playerId : (givers[0]?.playerId || null),
    exchanges: givers.map((g, i) => ({
      giverId:    g.playerId,
      receiverId: receivers[i] ? receivers[i].playerId : null,
      giverSeat:  g.seat,
      receiverSeat: receivers[i] ? receivers[i].seat : null
    })).filter(e => e.receiverId)
  };
}

module.exports = {
  detectType, canBeat, isBomb, settle, levelName, removeCards,
  detectType6p, canBeat6p, isBomb6p, bombScore6p, settle6p, computeTribute6p
};
