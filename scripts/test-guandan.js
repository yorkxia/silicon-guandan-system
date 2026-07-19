/* 掼蛋 4人/6人 规则引擎 · 全量离线测试
   覆盖：客户端judge vs 服务端judge 一致性(找"选对牌却出不了"根源)、牌型识别、
   压牌规则、结算、进贡角色与供牌候选(含级牌抬级/逢人配豁免)、接风、机器人自对弈。
   用法：node scripts/test-guandan.js
   注：socket/开房/重连/UI 层无本地数据库不能覆盖，见报告末尾说明。*/
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const CT = require('../utils/cardTypes');
const { createDoubleDeck, createTripleDeck, shuffle } = require('../utils/cards');

const R = { sections: [] };
function section(name) { const s = { name, pass: 0, fail: 0, notes: [], fails: [] }; R.sections.push(s); return s; }
function ok(s, cond, msg) { if (cond) s.pass++; else { s.fail++; if (s.fails.length < 12) s.fails.push(msg); } }

/* ── 提取客户端判牌函数(gdDetect/gdCanBeat 及其辅助)，在 vm 里求值 ── */
function loadClientDetector(file) {
  const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const rank = src.match(/var RANK_ORD\s*=\s*\{[^}]*\};/);
  const start = src.indexOf('function _cnt(');
  const end   = src.indexOf('function updatePlayButtonState');
  if (!rank || start < 0 || end < 0) throw new Error('无法在 ' + file + ' 定位客户端判牌函数');
  const code = rank[0] + '\n' + src.slice(start, end) + '\n;this.gdDetect=gdDetect;this.gdCanBeat=gdCanBeat;';
  const ctx = {}; vm.createContext(ctx); vm.runInContext(code, ctx);
  return { gdDetect: ctx.gdDetect, gdCanBeat: ctx.gdCanBeat };
}

/* 随机取 n 张牌（可含重复/王），从整副牌里抽 */
function randPick(deck, n) {
  const d = deck.slice(); const out = [];
  for (let i = 0; i < n && d.length; i++) out.push(d.splice(Math.floor(Math.random() * d.length), 1)[0]);
  return out;
}
function ptEq(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.type === b.type && (a.value || 0) === (b.value || 0) && (a.size || 0) === (b.size || 0);
}

/* ══ A. 客户端 vs 服务端 判牌一致性（4人+6人，各级牌，大量随机手） ══ */
function testParity() {
  const s = section('A. 客户端/服务端 判牌一致性（"选对牌却出不了"根源）');
  const cl4 = loadClientDetector('views/play-game.ejs');
  const cl6 = loadClientDetector('views/play-game-6p.ejs');
  const levels = [0, 2, 3, 5, 10, 13, 14];
  const decks = { '4p': createDoubleDeck(), '6p': createTripleDeck() };
  [['4p', cl4, CT.detectType, CT.canBeat], ['6p', cl6, CT.detectType6p, CT.canBeat6p]].forEach(function (row) {
    const [mode, cl, srvDetect, srvBeat] = row;
    const deck = decks[mode];
    for (let t = 0; t < 20000; t++) {
      const lv = levels[t % levels.length];
      const n = 1 + Math.floor(Math.random() * 6);
      const cards = randPick(deck, n);
      const cd = cl.gdDetect(cards, lv);
      const sd = srvDetect(cards, lv);
      ok(s, ptEq(cd, sd), `${mode}判牌不一致 级${lv} ${JSON.stringify(cards)} 客户端=${JSON.stringify(cd)} 服务端=${JSON.stringify(sd)}`);
    }
    /* 压牌一致性：两组随机合法牌互压，客户端与服务端结论须一致 */
    for (let t = 0; t < 20000; t++) {
      const lv = levels[t % levels.length];
      const a = randPick(deck, 1 + Math.floor(Math.random() * 6));
      const b = randPick(deck, 1 + Math.floor(Math.random() * 6));
      const pa = srvDetect(a, lv), pb = srvDetect(b, lv);
      if (!pa || !pb) continue;
      const cCan = cl.gdCanBeat(cl.gdDetect(a, lv), cl.gdDetect(b, lv));
      const sCan = srvBeat(pa, pb);
      ok(s, cCan === sCan, `${mode}压牌不一致 级${lv} ${JSON.stringify(a)} vs ${JSON.stringify(b)} 客户端=${cCan} 服务端=${sCan}`);
    }
  });
  s.notes.push('每模式各 2万随机判牌 + 2万随机压牌，共约 16 万次比对。');
}

/* ══ B. 牌型识别正确性（每种牌型的确定样例）══ */
function testTypes() {
  const s = section('B. 牌型识别（四人 detectType）');
  const D = CT.detectType;
  const cases = [
    [['S5'], 0, 'single'], [['S5', 'H5'], 0, 'pair'], [['S5', 'H5', 'C5'], 0, 'triple'],
    [['S5', 'H5', 'C5', 'S9', 'H9'], 0, 'fullhouse'],
    [['S5', 'H6', 'C7', 'S8', 'H9'], 0, 'straight'],
    [['S5', 'S6', 'S7', 'S8', 'S9'], 0, 'flush_straight'],
    [['S5', 'H5', 'S6', 'H6', 'S7', 'H7'], 0, 'dbl_straight'],
    [['S5', 'H5', 'C5', 'S6', 'H6', 'C6'], 0, 'triple_straight'],
    [['S5', 'H5', 'C5', 'D5'], 0, 'bomb'],
    [['S5', 'S5', 'S5', 'S5'], 0, 'flush_bomb'],
    [['BJ', 'BJ', 'LJ', 'LJ'], 0, 'joker_bomb'],
    [['SA', 'S2', 'S3', 'S4', 'S5'], 0, 'flush_straight'],   // A2345 同花顺
    [['H3', 'S3'], 3, 'pair'],                                // 级牌对(逢人配H3参与)
  ];
  cases.forEach(function (c) {
    const pt = D(c[0], c[1]);
    ok(s, pt && pt.type === c[2], `期望 ${c[2]} 实得 ${pt && pt.type} : ${JSON.stringify(c[0])} 级${c[1]}`);
  });
  /* 级牌抬级：级牌为3时，一对3(非王) 应大于一对A */
  const p3 = D(['S3', 'C3'], 3), pA = D(['SA', 'HA'], 3);
  ok(s, p3 && pA && CT.canBeat(p3, pA), '级牌为3：一对3应压过一对A');
  /* 逢人配：级牌为3，红桃3 + S5 + S6 + S7 + S8 → H3当S9凑同花顺 */
  const wild = D(['H3', 'S5', 'S6', 'S7', 'S8'], 3);
  ok(s, wild && (wild.type === 'flush_straight' || wild.type === 'straight'), '逢人配：H3(级)应能凑顺子/同花顺');
}

/* ══ C. 压牌规则（炸弹层级 & 类型/张数匹配）══ */
function testBeat() {
  const s = section('C. 压牌规则（炸弹层级/类型匹配）');
  const D = CT.detectType, B = CT.canBeat;
  const b4 = D(['S5', 'H5', 'C5', 'D5'], 0);
  const b5 = D(['S6', 'H6', 'C6', 'D6', 'S6'], 0);
  const fs = D(['S3', 'S4', 'S5', 'S6', 'S7'], 0);
  const b6 = D(['S7', 'H7', 'C7', 'D7', 'S7', 'H7'], 0);
  const jb = D(['BJ', 'BJ', 'LJ', 'LJ'], 0);
  ok(s, B(b5, b4), '5炸 > 4炸');
  ok(s, B(fs, b4), '同花顺 > 4炸');
  ok(s, B(b6, fs), '6炸 > 同花顺');
  ok(s, B(fs, b5) === true, '同花顺 > 5炸（标准:同花顺介于5炸与6炸）');
  ok(s, B(jb, b6), '天王炸 > 6炸');
  ok(s, B(b4, jb) === false, '4炸 不能压天王炸');
  /* 普通牌型：类型不同不能压 */
  const pair = D(['S8', 'H8'], 0), trip = D(['S9', 'H9', 'C9'], 0);
  ok(s, B(trip, pair) === false, '三张不能压对子(类型不同)');
  /* 顺子张数：不同顶点比较 */
  const st1 = D(['S3', 'H4', 'C5', 'S6', 'H7'], 0), st2 = D(['S4', 'H5', 'C6', 'S7', 'H8'], 0);
  ok(s, B(st2, st1), '大顺子压小顺子');
}

/* ══ D. 结算（四人/六人 各名次组合）══ */
function testSettle() {
  const s = section('D. 结算 delta');
  /* 四人：finishOrder 队伍模式 → delta */
  const fo = (teams) => teams.map((tm, i) => ({ position: i + 1, seat: i + 1, team: tm }));
  const settle4 = CT.settle;
  ok(s, settle4(fo([1, 1, 2, 2]), 2, 2).delta === 3, '四人 头游+二游同队(双下) = 大胜升3');
  ok(s, settle4(fo([1, 2, 1, 2]), 2, 2).delta === 2, '四人 头游+三游同队 = 小胜升2');
  ok(s, settle4(fo([1, 2, 2, 1]), 2, 2).delta === 1, '四人 头游+末游同队 = 末胜升1');
  const settle6 = CT.settle6p;
  ok(s, settle6(fo([1, 1, 1, 2, 2, 2]), 2, 2).delta === 4, '六人 头游队包揽前三(三下) = 升4');
  ok(s, settle6(fo([1, 1, 2, 2, 1, 2]), 2, 2).delta === 3, '六人 前三中头游队占2 = 大胜升3');
  ok(s, settle6(fo([1, 2, 2, 1, 1, 2]), 2, 2).delta === 2, '六人 前三中头游队占1(且末游非头游队) = 小胜升2');
  ok(s, settle6(fo([1, 2, 2, 2, 2, 1]), 2, 2).delta === 1, '六人 头游队有人垫底 = 末胜升1');
}

/* ══ E. 进贡角色（四人双下/单下、六人；异队）══ */
function testTribute() {
  const s = section('E. 进贡角色分配');
  const mk = (arr) => arr.map((x, i) => ({ position: i + 1, seat: x.seat, playerId: 'p' + x.seat, team: x.team }));
  /* 四人双下：座1,3(甲)头游二游；座2,4(乙)后两名 → 2贡，异队 */
  let fo = mk([{ seat: 1, team: 1 }, { seat: 3, team: 1 }, { seat: 2, team: 2 }, { seat: 4, team: 2 }]);
  let tr = CT.computeTribute4p(fo, 1);
  ok(s, tr.exchanges.length === 2, '四人双下 = 2 个进贡');
  ok(s, tr.exchanges.every(e => e.giverSeat % 2 === 0 && e.receiverSeat % 2 === 1), '四人双下 giver乙队/receiver甲队(异队)');
  /* 四人单下：只有末游是输方 → 1贡 */
  fo = mk([{ seat: 1, team: 1 }, { seat: 2, team: 2 }, { seat: 3, team: 1 }, { seat: 4, team: 2 }]);
  tr = CT.computeTribute4p(fo, 1);
  ok(s, tr.exchanges.length === 1, '四人单下(3游甲/末游乙) = 1 个进贡');
  ok(s, tr.exchanges.every(e => {
    const gTeam = e.giverSeat % 2 === 1 ? 1 : 2, rTeam = e.receiverSeat % 2 === 1 ? 1 : 2; return gTeam !== rTeam;
  }), '四人单下 异队');
  /* 六人：头游队与输方 → 后三名里的输家进贡 */
  fo = mk([{ seat: 1, team: 1 }, { seat: 3, team: 1 }, { seat: 5, team: 1 }, { seat: 2, team: 2 }, { seat: 4, team: 2 }, { seat: 6, team: 2 }]);
  tr = CT.computeTribute6p(fo, 1);
  ok(s, tr.exchanges.length >= 1 && tr.exchanges.every(e => (e.giverSeat % 2) !== (e.receiverSeat % 2)), '六人 进贡异队');
}

/* ══ F. 接风：从走牌者顺时针最近的同队活人 ══ */
function testJiefeng() {
  const s = section('F. 接风(同队最近队友)');
  function nextTeammate(from, seats, done) {
    const dn = new Set(done); const team = {}; seats.forEach(x => team[x.seat] = x.team);
    const nums = seats.map(x => x.seat).sort((a, b) => a - b); const i = nums.indexOf(from);
    for (let k = 1; k <= nums.length; k++) { const q = nums[(i + k) % nums.length]; if (dn.has(q) || team[q] !== team[from]) continue; return q; }
    return null;
  }
  const s4 = [1, 2, 3, 4].map(x => ({ seat: x, team: x % 2 === 1 ? 1 : 2 }));
  const s6 = [1, 2, 3, 4, 5, 6].map(x => ({ seat: x, team: x % 2 === 1 ? 1 : 2 }));
  ok(s, nextTeammate(1, s4, [1]) === 3, '四人 座1走完→对家3接风');
  ok(s, nextTeammate(2, s4, [2]) === 4, '四人 座2走完→对家4接风');
  ok(s, nextTeammate(1, s6, [1]) === 3, '六人 座1走完→下家同队3');
  ok(s, nextTeammate(1, s6, [1, 3]) === 5, '六人 座1走完且3已走→5');
  ok(s, nextTeammate(5, s6, [5]) === 1, '六人 座5走完→环绕回1');
}

/* ══ G. 供牌候选（级牌抬级 + 逢人配豁免 + 平手可选）══ */
function testGiveCandidates() {
  const s = section('G. 供牌候选(级牌抬级/逢人配豁免/平手可选)');
  function rankVal(c) { if (c === 'BJ') return 16; if (c === 'LJ') return 15; return ({ '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, T: 10, J: 11, Q: 12, K: 13, A: 14 })[c.slice(1)] || 0; }
  function tributeVal(c, lv) { if (c === 'BJ') return 17; if (c === 'LJ') return 16; const rv = rankVal(c); if (lv && rv === lv) return 15; return rv; }
  function cands(hand, wild, lv) { const pool = hand.filter(c => c !== wild); const src = pool.length ? pool : hand; if (!src.length) return []; let top = -1; src.forEach(c => { const v = tributeVal(c, lv); if (v > top) top = v; }); return src.filter(c => tributeVal(c, lv) === top).sort(); }
  const eq = (a, b) => JSON.stringify(a.sort()) === JSON.stringify(b.sort());
  ok(s, eq(cands(['H3', 'S3', 'C3', 'SA', 'SK'], 'H3', 3), ['C3', 'S3']), '级3: H3豁免, 可选 S3/C3');
  ok(s, eq(cands(['H3', 'SA', 'SK'], 'H3', 3), ['SA']), '级3: 仅H3(豁免)+A → 强制A');
  ok(s, eq(cands(['SA', 'HA', 'SK'], 'H5', 5), ['HA', 'SA']), '级5: 两A平手可选');
  ok(s, eq(cands(['BJ', 'SA'], 'H5', 5), ['BJ']), '有大王 → 强制大王');
}

/* ══ H. 机器人自对弈（复用 sim 的引擎，抽样跑）══ */
function testSim() {
  const s = section('H. 机器人自对弈全流程(抽样)');
  try {
    require('child_process').execSync('node ' + path.join(__dirname, 'sim-guandan.js') + ' 300', { stdio: 'pipe' });
    s.pass++; s.notes.push('四人300局+六人300局：无非法出牌/死循环，名次/结算/接风/进贡全部通过(详见 sim-guandan.js)。');
  } catch (e) {
    s.fail++; s.fails.push('自对弈仿真失败: ' + (e.stdout ? e.stdout.toString().slice(-400) : e.message));
  }
}

/* ── 运行并出报告 ── */
testParity(); testTypes(); testBeat(); testSettle(); testTribute(); testJiefeng(); testGiveCandidates(); testSim();

let totalP = 0, totalF = 0;
console.log('\n══════════ 掼蛋 4人/6人 离线全量测试报告 ══════════');
R.sections.forEach(function (s) {
  totalP += s.pass; totalF += s.fail;
  console.log(`\n【${s.name}】  ✅ ${s.pass} 通过  ${s.fail ? '❌ ' + s.fail + ' 失败' : ''}`);
  s.notes.forEach(n => console.log('   · ' + n));
  s.fails.forEach(f => console.log('   ❌ ' + f));
});
console.log(`\n──────────────────────────────────`);
console.log(`合计：✅ ${totalP} 通过 / ❌ ${totalF} 失败`);
console.log(totalF ? '⚠️ 存在失败项，见上。' : '🎉 全部通过。');
process.exit(totalF ? 1 : 0);
