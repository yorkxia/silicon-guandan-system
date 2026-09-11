/* 掼蛋 · 线上并发压测脚本
   用法：node scripts/load-test.js <并发房间数> [模式] [局数] [baseURL]
     并发房间数：同时开几个私人房（每个4人房4个机器人/6人房6个机器人）
     模式：4p | 6p | mix（默认 mix，一半4人一半6人，更贴近真实混合负载）
     局数：每个房间打完几局就主动收工（默认3局，控制单次压测总时长）
     baseURL：默认打线上 Render 地址，可传本地地址自测

   示例：
     node scripts/load-test.js 20                    # 20个混合并发房间，线上，各打3局
     node scripts/load-test.js 50 4p 2                # 50个4人房，各打2局
     node scripts/load-test.js 10 mix 3 http://localhost:3000

   建议用法：选真实玩家少的时段（比如凌晨），从小到大逐档跑（10→20→30...），
   每档跑完等 Render 面板的 CPU/内存/DB连接数图表回落，再跑下一档，
   观察"建房延迟"和"每局耗时"这两项统计量是否随并发房间数明显恶化。

   安全性：只用私人房(room:create)，不走随机匹配队列，不会跟真实玩家混房；
   机器人昵称统一带 LT- 前缀便于识别。跑完后请用 gdo-clear.js 清理测试数据：
     DATABASE_URL="<你的连接串>" node scripts/gdo-clear.js --yes
   注意：gdo-clear.js 需要外部可达的 DATABASE_URL（Render 内网地址在本地跑不通，
   去 Render 后台 Database 页面拿 External Database URL）。*/
const { io } = require('socket.io-client');
const CT = require('../utils/cardTypes');
const { pickBotPlay } = require('../utils/bot');

const argv = process.argv.slice(2);
const ROOM_COUNT   = parseInt(argv[0] || '10', 10);
const MODE_ARG     = argv[1] || 'mix';           // 4p | 6p | mix
const MAX_ROUNDS   = parseInt(argv[2] || '3', 10);
const BASE         = argv[3] || 'https://silicon-guandan-system.onrender.com';
const CREATE_STAGGER_MS = 150;   // 房间创建之间错开一点，避免"测试脚本自己"而非服务端成为瓶颈
const ROOM_TIMEOUT_MS   = 90000; // 单房间从建房到达到目标局数(或失败)的总超时

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const uid   = () => 'LT-' + Math.random().toString(36).slice(2, 10);

function percentile(arr, p) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.floor(p / 100 * s.length));
  return s[idx];
}
function stats(arr) {
  if (!arr.length) return { n: 0, min: null, p50: null, p90: null, max: null };
  return {
    n: arr.length,
    min: Math.min(...arr),
    p50: percentile(arr, 50),
    p90: percentile(arr, 90),
    max: Math.max(...arr)
  };
}
function fmtMs(ms) { return ms == null ? '—' : (ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : Math.round(ms) + 'ms'); }

/* ── 单个机器人：只负责按当前局面自动出牌/供还牌，不做正确性断言(那是 test-guandan.js 的事) ──
   isReporter：round:result 是广播给房间全员的，一局结束时每人都会收到一次；只让"房主"那个
   机器人往 metrics.roundEndTimes 记一次时间戳，否则4/6个人重复记同一时刻，会把"单局耗时"
   序列搅成一堆几乎为0的假数据。 */
function makeBot(ns, name, metrics, isReporter) {
  const url = BASE + (ns || '');
  const sock = io(url, { transports: ['websocket'], forceNew: true, reconnection: false, timeout: 15000 });
  const bot = {
    name, token: uid(), sock, roomCode: null, mySeat: null, myPlayerId: null,
    gameMode: null, levelCard: 0, hand: [], turnSeat: null, lastCards: null,
    tribute: false, dealt: false, roundResults: 0, pendingAct: false, err: null,
  };
  const is6 = ns === '/g6';
  const detectFn = is6 ? CT.detectType6p : CT.detectType;

  sock.on('connect_error', e => { bot.err = 'connect_error: ' + e.message; metrics.errors.push(bot.err); });
  sock.on('game:error',   d => { metrics.errors.push('game:error: ' + (d && d.message)); });
  sock.on('room:error',   d => { bot.err = 'room:error: ' + (d && d.message); metrics.errors.push(bot.err); });

  sock.on('game:hand', d => {
    bot.hand = d.hand || []; bot.mySeat = d.mySeat; bot.myPlayerId = d.myPlayerId;
    bot.gameMode = d.gameMode; bot.levelCard = d.levelCard || 0;
    bot.dealt = true;
  });
  sock.on('game:hand_update', d => { bot.hand = d.hand || bot.hand; });

  sock.on('game:state', d => {
    bot.turnSeat = d.turnSeat;
    bot.lastCards = d.lastPlay ? d.lastPlay.cards : null;
    if (bot.turnSeat === bot.mySeat && !bot.pendingAct && !bot.tribute && bot.hand.length) {
      bot.pendingAct = true;
      setTimeout(() => actTurn(bot, detectFn), 60);
    }
  });

  sock.on('tribute:phase', d => {
    bot.tribute = true;
    const ex = (d.exchanges || []).find(e => e.giverId === bot.myPlayerId && (e.stage || 'give') === 'give');
    if (ex) {
      const card = (ex.giveCandidates && ex.giveCandidates[0]) || ex.mustGiveCard;
      setTimeout(() => sock.emit('tribute:give', { token: bot.token, roomCode: bot.roomCode, card }), 400);
    }
  });
  sock.on('tribute:card_flew', d => {
    if (d.receiverId === bot.myPlayerId) {
      (async () => {
        for (let k = 0; k < 25 && !bot.hand.length; k++) await sleep(150);
        const wild = bot.levelCard ? ('H' + ({ 10: 'T', 11: 'J', 12: 'Q', 13: 'K', 14: 'A' }[bot.levelCard] || String(bot.levelCard))) : null;
        const ret = bot.hand.find(c => c !== wild) || bot.hand[0];
        if (ret) sock.emit('tribute:return', { token: bot.token, roomCode: bot.roomCode, returnCard: ret });
      })();
    }
  });
  sock.on('tribute:done', () => { bot.tribute = false; });

  sock.on('game:starting', () => { bot.tribute = false; setTimeout(() => sock.emit('game:request_hand', { token: bot.token, roomCode: bot.roomCode }), 250); });
  sock.on('round:result', () => {
    bot.roundResults++;
    if (isReporter) metrics.roundEndTimes.push(Date.now());
    setTimeout(() => sock.emit('room:ready', { token: bot.token, roomCode: bot.roomCode }), 700);
  });

  return bot;
}

function actTurn(bot, detectFn) {
  bot.pendingAct = false;
  if (bot.turnSeat !== bot.mySeat || !bot.hand.length || bot.tribute) return;
  const lastPt = bot.lastCards ? detectFn(bot.lastCards, bot.levelCard) : null;
  const state = { gameMode: bot.gameMode, levelCard: bot.levelCard, hands: { [String(bot.myPlayerId)]: bot.hand.slice() }, lastPlay: lastPt ? { playType: lastPt } : null };
  let play = null;
  try { play = pickBotPlay(state, { playerId: bot.myPlayerId }); } catch (e) { /* 托管兜底同款：出错就当无牌可出，交给下面兜底 */ }
  if (play && play.length) bot.sock.emit('play:cards', { token: bot.token, roomCode: bot.roomCode, cards: play });
  else if (bot.lastCards) bot.sock.emit('play:pass', { token: bot.token, roomCode: bot.roomCode });
  else bot.sock.emit('play:cards', { token: bot.token, roomCode: bot.roomCode, cards: [bot.hand[bot.hand.length - 1]] });
}

async function waitFor(fn, ms, step = 300) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(step); } return false; }
function closeAll(bots) { bots.forEach(b => { try { b.sock.close(); } catch (_) { } }); }

/* ── 单个房间的完整生命周期：建房→满员发牌→打到目标局数(或超时/出错)→关闭 ── */
async function runRoom(idx, mode, out) {
  const ns = mode === '6p' ? '/g6' : '';
  const need = mode === '6p' ? 6 : 4;
  const metrics = { errors: [], roundEndTimes: [] };
  const bots = [];
  for (let i = 0; i < need; i++) bots.push(makeBot(ns, `LT${idx}-${mode}-${i + 1}`, metrics, i === 0));
  const host = bots[0];

  const tCreateStart = Date.now();
  let roomCode = null;
  host.sock.on('room:joined', d => { roomCode = d.roomCode; });
  for (let i = 1; i < need; i++) {
    const b = bots[i];
    b.sock.on('room:joined', () => { if (b.roomCode) b.sock.emit('game:request_hand', { token: b.token, roomCode: b.roomCode }); });
  }
  host.sock.emit('room:create', { token: host.token, name: host.name, mode });
  const created = await waitFor(() => roomCode, 20000);
  const tCreateMs = Date.now() - tCreateStart;
  if (!created) { out.push({ idx, mode, ok: false, stage: 'create', createMs: tCreateMs, roundMs: [], err: metrics.errors[0] || '建房超时' }); closeAll(bots); return; }
  host.roomCode = roomCode;
  host.sock.emit('game:request_hand', { token: host.token, roomCode });
  for (let i = 1; i < need; i++) {
    const b = bots[i]; b.roomCode = roomCode;
    b.sock.emit('room:join', { token: b.token, name: b.name, roomCode });
    await sleep(200);
  }

  const tDealStart = Date.now();
  const dealt = await waitFor(() => bots.every(b => b.dealt), 25000);
  const tDealMs = Date.now() - tDealStart;
  if (!dealt) { out.push({ idx, mode, ok: false, stage: 'deal', createMs: tCreateMs, dealMs: tDealMs, roundMs: [], err: metrics.errors[0] || '发牌超时(可能未满员)' }); closeAll(bots); return; }

  const roundStart = Date.now();
  await waitFor(() => Math.max(...bots.map(b => b.roundResults)) >= MAX_ROUNDS, ROOM_TIMEOUT_MS);
  const finishedRounds = Math.max(...bots.map(b => b.roundResults));

  // 把 round:result 的到达时间转成"每局耗时"序列
  const roundMs = [];
  let prev = roundStart;
  metrics.roundEndTimes.forEach(t => { roundMs.push(t - prev); prev = t; });

  out.push({
    idx, mode, ok: finishedRounds >= MAX_ROUNDS, stage: 'done',
    createMs: tCreateMs, dealMs: tDealMs, roundMs, finishedRounds,
    err: finishedRounds < MAX_ROUNDS ? (metrics.errors[0] || `只打完${finishedRounds}/${MAX_ROUNDS}局就超时`) : null
  });
  closeAll(bots);
}

(async () => {
  console.log(`连线目标: ${BASE}`);
  console.log(`并发房间数: ${ROOM_COUNT}  模式: ${MODE_ARG}  每房目标局数: ${MAX_ROUNDS}`);
  console.log('开始压测…（Ctrl+C 可随时中断；已建的房间会在下面超时后自然被服务端按掉线处理）\n');

  const out = [];
  const tasks = [];
  for (let i = 0; i < ROOM_COUNT; i++) {
    const mode = MODE_ARG === 'mix' ? (i % 2 === 0 ? '4p' : '6p') : MODE_ARG;
    tasks.push((async () => {
      await sleep(i * CREATE_STAGGER_MS);
      await runRoom(i + 1, mode, out);
      process.stdout.write('.');
    })());
  }
  const tWallStart = Date.now();
  await Promise.all(tasks);
  const wallMs = Date.now() - tWallStart;

  console.log('\n\n══════════ 压测报告 ══════════');
  const ok = out.filter(r => r.ok);
  const fail = out.filter(r => !r.ok);
  console.log(`并发房间数 ${ROOM_COUNT} → 成功 ${ok.length} / 失败 ${fail.length}　总耗时 ${fmtMs(wallMs)}`);

  const createStats = stats(out.filter(r => r.createMs != null).map(r => r.createMs));
  const dealStats   = stats(out.filter(r => r.dealMs != null).map(r => r.dealMs));
  const allRoundMs  = out.flatMap(r => r.roundMs || []);
  const roundStats  = stats(allRoundMs);

  console.log(`\n建房延迟(emit room:create → 收到 room:joined)：n=${createStats.n} 最快=${fmtMs(createStats.min)} 中位=${fmtMs(createStats.p50)} P90=${fmtMs(createStats.p90)} 最慢=${fmtMs(createStats.max)}`);
  console.log(`满员发牌延迟(最后一人入座 → 全员收到手牌)：n=${dealStats.n} 最快=${fmtMs(dealStats.min)} 中位=${fmtMs(dealStats.p50)} P90=${fmtMs(dealStats.p90)} 最慢=${fmtMs(dealStats.max)}`);
  console.log(`单局耗时(含机器人思考延迟，仅供同档横向对比，不是绝对值)：n=${roundStats.n} 最快=${fmtMs(roundStats.min)} 中位=${fmtMs(roundStats.p50)} P90=${fmtMs(roundStats.p90)} 最慢=${fmtMs(roundStats.max)}`);

  if (fail.length) {
    console.log(`\n失败房间明细(最多显示10条)：`);
    fail.slice(0, 10).forEach(r => console.log(`  房间#${r.idx}(${r.mode}) 阶段=${r.stage} ${r.err || ''}`));
  }

  console.log(`\n下一步：\n  1. 去 Render 面板看这段时间窗口内的 CPU/内存/DB连接数曲线峰值\n  2. 跟上一档并发数的结果对比"建房延迟"和"单局耗时"的中位数/P90有没有明显变差\n  3. 测完记得清理测试数据：DATABASE_URL="<连接串>" node scripts/gdo-clear.js --yes`);
  process.exit(fail.length ? 1 : 0);
})();
