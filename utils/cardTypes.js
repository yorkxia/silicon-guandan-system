/* 掼蛋 · 牌型识别 / 压牌判断 / 结算逻辑
   标准牌型：单张 对子 三张 三带二 顺子(5) 三连对(6) 钢板(6) 炸弹(4+) 同花顺(5) 天王炸
   A 可作最大(10JQKA)也可作最小(A2345) */
const { rankVal } = require('./cards');

/* ── 基础工具 ── */
function counts(arr) {
  const m = {};
  for (const v of arr) m[v] = (m[v] || 0) + 1;
  return m;
}
function isConsec(desc) {
  for (let i = 0; i < desc.length - 1; i++)
    if (desc[i] - desc[i + 1] !== 1) return false;
  return true;
}
/* 一组去重点数(降序)是否构成连续序列，返回顶点值；A 可作 1 参与低序 */
function runTop(desc) {
  if (isConsec(desc)) return desc[0];
  // A(14) 作 1 的低序：如 A2345 → [14,5,4,3,2]；AA2233 → [14,3,2]
  if (desc[0] === 14 && desc[desc.length - 1] === 2) {
    const low = [...desc.slice(1), 1];
    if (isConsec(low)) return desc[1];   // 顶点为次大值（A 变最小）
  }
  return null;
}
/* 三带二（葫芦）：3+2，返回三张部分的点数 */
function findFullHouse(rv) {
  const cnt = counts(rv);
  const e = Object.entries(cnt);
  if (e.length !== 2) return null;
  const [[r1, c1], [r2, c2]] = e;
  if (+c1 === 3 && +c2 === 2) return +r1;
  if (+c1 === 2 && +c2 === 3) return +r2;
  return null;
}
/* 三连对（木板）：恰好 3 组相连对子(6张)，返回顶点 */
function findDoubleStraight(rv) {
  const cnt = counts(rv);
  const rs = Object.keys(cnt).map(Number).sort((a, b) => b - a);
  if (rs.length !== 3) return null;
  if (Object.values(cnt).some(c => c !== 2)) return null;
  return runTop(rs);
}
/* 钢板（三同连张）：恰好 2 组相连三张(6张)，返回顶点 */
function findTripleStraight(rv) {
  const cnt = counts(rv);
  const rs = Object.keys(cnt).map(Number).sort((a, b) => b - a);
  if (rs.length !== 2) return null;
  if (Object.values(cnt).some(c => c !== 3)) return null;
  return runTop(rs);
}

/* 级牌点值：打某级时该级牌点提升到 A(14) 之上、小王(15)之下 = 14.5
   仅用于按点比大小的牌型(单张/对子/三张/三带/炸弹)，顺子/连对/钢板仍用自然点 */
function lvVal(r, level) { return (level && r === level) ? 14.5 : r; }

/* 级数 → 牌点字符 */
function rankChar(level) {
  const m = { 10: 'T', 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
  return m[level] || String(level);
}
/* 两个牌型谁"更强"（炸弹优先，其次点数）——逢人配取最强组合 */
function betterPt(a, b) {
  if (!b) return true;
  if (!a) return false;
  const sa = isBomb(a) ? 1e9 + bombScore(a) : (a.value || 0);
  const sb = isBomb(b) ? 1e9 + bombScore(b) : (b.value || 0);
  return sa > sb;
}
/* 红桃级牌"逢人配/百搭"：把红桃(级)替换成任意非王牌，返回能组成的最强牌型 */
function withWild(cards, level, core) {
  if (!level) return core(cards, 0);
  const wild = 'H' + rankChar(level);
  const idx = [];
  cards.forEach((c, i) => { if (c === wild) idx.push(i); });
  const w = idx.length;
  if (w === 0) return core(cards, level);
  const suits = Array.from(new Set(cards.filter(c => c !== wild && c !== 'BJ' && c !== 'LJ').map(c => c[0])));
  if (suits.indexOf('S') < 0) suits.push('S');
  const ranks = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
  const cands = [wild];              // 红桃级牌也可当级牌本身用
  for (const r of ranks) for (const s of suits) cands.push(s + r);
  let best = null;
  const combo = new Array(w);
  (function rec(k) {
    if (k === w) {
      const sub = cards.slice();
      for (let i = 0; i < w; i++) sub[idx[i]] = combo[i];
      const pt = core(sub, level);
      if (pt && betterPt(pt, best)) best = pt;
      return;
    }
    for (const c of cands) { combo[k] = c; rec(k + 1); }
  })(0);
  return best;
}

/* 识别组合牌型（三带二 / 顺子 / 三连对 / 钢板），四人六人共用 */
function detectRun(n, rv, suits, level) {
  if (n === 5) {
    // 三带二（三张点数比大小，级牌提升）
    const fh = findFullHouse(rv);
    if (fh) return { type: 'fullhouse', value: lvVal(fh, level), label: '三带二' };
    // 顺子（5 张不同点数连续，A 可高可低）
    const u = [...new Set(rv)].sort((a, b) => b - a);
    if (u.length === 5) {
      const top = runTop(u);
      if (top !== null) {
        const oneSuit = new Set(suits).size === 1;
        return oneSuit
          ? { type: 'flush_straight', size: 5, value: top, label: '同花顺' }
          : { type: 'straight',       size: 5, value: top, label: '顺子' };
      }
    }
    return null;
  }
  if (n === 6) {
    // 钢板（2 组连三张）
    const ts = findTripleStraight(rv);
    if (ts !== null) return { type: 'triple_straight', size: 2, value: ts, label: '钢板' };
    // 三连对（3 组连对子）
    const ds = findDoubleStraight(rv);
    if (ds !== null) return { type: 'dbl_straight', size: 3, value: ds, label: '三连对' };
    return null;
  }
  return null;
}

/* ── 四人牌型识别（含红桃级牌逢人配）── */
function detectType(cards, level = 0) { return withWild(cards, level, detectCore4); }

/* 四人核心识别（level=当前级数，用于级牌>A 提升）*/
function detectCore4(cards, level = 0) {
  if (!cards || cards.length === 0) return null;
  const n     = cards.length;
  const rv    = cards.map(rankVal).sort((a, b) => b - a);
  const suits = cards.map(c => (c === 'LJ' || c === 'BJ') ? 'J' : c[0]);
  const bj = cards.filter(c => c === 'BJ').length;
  const lj = cards.filter(c => c === 'LJ').length;

  // 天王炸：2大王 + 2小王
  if (n === 4 && bj === 2 && lj === 2)
    return { type: 'joker_bomb', value: 99999, label: '天王炸' };
  // 单张大/小王：大王(16) > 小王(15) > 级牌 > A …
  if (n === 1 && (cards[0] === 'BJ' || cards[0] === 'LJ'))
    return { type: 'single', value: cards[0] === 'BJ' ? 16 : 15, label: '单张' };
  // 其余含王(与普通牌混合)→ 不能组成牌型
  if (cards.some(c => c === 'LJ' || c === 'BJ')) return null;

  // 炸弹：4 张及以上相同点数（级牌提升）
  if (n >= 4 && rv.every(r => r === rv[0])) {
    const oneSuit = new Set(suits).size === 1;
    const v = lvVal(rv[0], level);
    return oneSuit
      ? { type: 'flush_bomb', size: n, value: v, label: `${n}张同花炸` }
      : { type: 'bomb',       size: n, value: v, label: `${n}张炸弹` };
  }
  if (n === 1) return { type: 'single', value: lvVal(rv[0], level), label: '单张' };
  if (n === 2 && rv[0] === rv[1]) return { type: 'pair', value: lvVal(rv[0], level), label: '对子' };
  if (n === 3 && rv.every(r => r === rv[0])) return { type: 'triple', value: lvVal(rv[0], level), label: '三张' };

  return detectRun(n, rv, suits, level);
}

/* ── 炸弹判断（四人/六人统一）── */
function isBomb(pt) {
  return pt && ['bomb', 'flush_bomb', 'flush_straight', 'joker_bomb', 'triple_bj', 'triple_lj'].includes(pt.type);
}
/* 炸弹强度（标准层级，四人六人相同）：
   4炸 < 5炸 < 同花顺 < 6炸 < 7炸 < … < 天王炸
   （六人特例三大/小王三炸：介于4炸与5炸之间）*/
function bombScore(pt) {
  if (pt.type === 'joker_bomb')     return 1e6;                 // 四大天王 / 六王
  if (pt.type === 'flush_straight') return 550 + pt.value;      // 同花顺：介于5炸与6炸
  if (pt.type === 'triple_bj')      return 460;                 // 六人 三大王三炸
  if (pt.type === 'triple_lj')      return 450;                 // 六人 三小王三炸
  if (pt.type === 'bomb' || pt.type === 'flush_bomb')
    return pt.size * 100 + pt.value;                            // 4炸≈4xx,5炸≈5xx,6炸≈6xx
  return 0;
}

/* ── 压牌判断（四人）── */
function canBeat(newPt, curPt) {
  if (!curPt) return !!newPt;
  if (!newPt)  return false;

  // 炸弹体系 vs 普通牌型
  if (isBomb(newPt) && !isBomb(curPt)) return true;
  if (!isBomb(newPt) && isBomb(curPt)) return false;
  if (isBomb(newPt) && isBomb(curPt))  return bombScore(newPt) > bombScore(curPt);

  // 普通牌型：类型相同、张数相同(顺子/连对)、点数更高才能压
  if (newPt.type !== curPt.type) return false;
  if (newPt.size !== undefined && newPt.size !== curPt.size) return false;
  return newPt.value > curPt.value;
}

/* ── 结算（四人）── */
const LEVEL_NAME = ['', '', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
function levelName(n) { return LEVEL_NAME[n] || String(n); }

function settle(finishOrder, lv1, lv2) {
  const headTeam = finishOrder[0].team;
  let resultType, delta;

  if (finishOrder[1].team === headTeam) {
    resultType = '大胜'; delta = 3;
  } else if (finishOrder[2] && finishOrder[2].team === headTeam) {
    resultType = '小胜'; delta = 2;
  } else {
    resultType = '末胜'; delta = 1;
  }
  const winnerTeam = headTeam;
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
 * 六人掼蛋 · 扩展牌型体系（三副牌）
 * ══════════════════════════════════════════════════════ */
function detectType6p(cards, level = 0) { return withWild(cards, level, detectCore6); }

function detectCore6(cards, level = 0) {
  if (!cards || cards.length === 0) return null;
  const n  = cards.length;
  const bj = cards.filter(c => c === 'BJ').length;
  const lj = cards.filter(c => c === 'LJ').length;

  /* 天王炸：3大王 + 3小王 */
  if (n === 6 && bj === 3 && lj === 3)
    return { type: 'joker_bomb', value: 99999, label: '天王炸' };
  /* 大/小王三炸 */
  if (n === 3 && bj === 3) return { type: 'triple_bj', value: 160, label: '大王三炸' };
  if (n === 3 && lj === 3) return { type: 'triple_lj', value: 150, label: '小王三炸' };
  /* 单张大/小王 */
  if (n === 1 && (cards[0] === 'BJ' || cards[0] === 'LJ'))
    return { type: 'single', value: cards[0] === 'BJ' ? 16 : 15, label: '单张' };
  /* 其余含王 → 不能组成牌型 */
  if (cards.some(c => c === 'LJ' || c === 'BJ')) return null;

  const rv    = cards.map(rankVal).sort((a, b) => b - a);
  const suits = cards.map(c => c[0]);

  if (n >= 4 && rv.every(r => r === rv[0])) {
    const oneSuit = new Set(suits).size === 1;
    const v = lvVal(rv[0], level);
    return oneSuit
      ? { type: 'flush_bomb', size: n, value: v, label: `${n}张同花炸` }
      : { type: 'bomb',       size: n, value: v, label: `${n}张炸弹` };
  }
  if (n === 1) return { type: 'single', value: lvVal(rv[0], level), label: '单张' };
  if (n === 2 && rv[0] === rv[1]) return { type: 'pair', value: lvVal(rv[0], level), label: '对子' };
  if (n === 3 && rv.every(r => r === rv[0])) return { type: 'triple', value: lvVal(rv[0], level), label: '三张' };

  return detectRun(n, rv, suits, level);
}

/* ── 六人压牌：与四人完全一致（牌型大小顺序四人六人相同）── */
const isBomb6p    = isBomb;
const bombScore6p = bombScore;
const canBeat6p   = canBeat;

/* ── 6P 结算 ── */
function settle6p(finishOrder, lv1, lv2) {
  const headTeam = finishOrder[0].team;
  let delta, resultType;

  if (finishOrder[5].team === headTeam) {
    /* 头游队有人垫底(末游/第6) → 升1级 */
    delta = 1; resultType = '末胜';
  } else {
    /* 头游队进入前三名(index 0,1,2)的人数 */
    let inTop3 = 0;
    for (let i = 0; i < 3; i++) if (finishOrder[i].team === headTeam) inTop3++;
    if (inTop3 === 3)      { delta = 4; resultType = '三下'; }  // 三下
    else if (inTop3 === 2) { delta = 3; resultType = '大胜'; }  // 头游+二游+X
    else                   { delta = 2; resultType = '小胜'; }  // 头游+四游+五游
  }
  const winnerTeam = headTeam;
  const newLv1 = winnerTeam === 1 ? Math.min(lv1 + delta, 14) : lv1;
  const newLv2 = winnerTeam === 2 ? Math.min(lv2 + delta, 14) : lv2;
  return { resultType, winnerTeam, delta, newLv1, newLv2 };
}

/* ── 6P 进贡计算 ── */
function computeTribute6p(finishOrder, headTeam) {
  const givers    = [];
  const receivers = [];
  for (let i = 3; i <= 5; i++) {
    if (finishOrder[i].team !== headTeam) givers.push(finishOrder[i]);
  }
  const headTeamOrder = finishOrder.filter(f => f.team === headTeam);
  for (let i = 0; i < givers.length; i++) {
    if (headTeamOrder[i]) receivers.push(headTeamOrder[i]);
  }
  return {
    headPlayerId:    headTeamOrder[0] ? headTeamOrder[0].playerId : null,
    tributeLeaderId: givers.length > 0 && receivers[0]?.playerId === headTeamOrder[0]?.playerId
                       ? givers[0].playerId : (givers[0]?.playerId || null),
    exchanges: givers.map((g, i) => ({
      giverId:      g.playerId,
      receiverId:   receivers[i] ? receivers[i].playerId : null,
      giverSeat:    g.seat,
      receiverSeat: receivers[i] ? receivers[i].seat : null
    })).filter(e => e.receiverId)
  };
}

module.exports = {
  detectType, canBeat, isBomb, bombScore, settle, levelName, removeCards,
  detectType6p, canBeat6p, isBomb6p, bombScore6p, settle6p, computeTribute6p,
  // 供测试
  detectRun, runTop
};
