/* 掼蛋 · 线上 socket 层端到端机器人测试
   用 socket.io-client 连真实服务器，驱动机器人走：随机参赛/开房参赛 → 进房 → 发牌 →
   出牌 → 供牌/还供/抗供 → 续局，检查每步是否走通。默认连线上 Render。
   用法：node scripts/bot-e2e.js  [baseURL]
   跑完请用 gdo-clear 清测试数据。*/
const { io } = require('socket.io-client');
const CT = require('../utils/cardTypes');
const { pickBotPlay } = require('../utils/bot');
const { rankVal } = require('../utils/cards');

const BASE = process.argv[2] || 'https://silicon-guandan-system.onrender.com';
const RC = (c) => ({ '10': 'T', '11': 'J', '12': 'Q', '13': 'K', '14': 'A' }[c] || String(c));
const wildOf = (lv) => (lv ? 'H' + RC(lv) : null);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const uid = () => 'e2e-' + Math.random().toString(36).slice(2, 10);
const PLAY_DELAY = 60;

const LOG = [];
function log(scn, msg) { const line = `[${scn}] ${msg}`; LOG.push(line); console.log(line); }

/* ── 单个机器人 ── */
function makeBot(scn, ns, name) {
  const url = BASE + (ns || '');
  const sock = io(url, { transports: ['websocket'], forceNew: true, reconnection: false, timeout: 15000 });
  const bot = {
    scn, name, token: uid(), sock, roomCode: null, mySeat: null, myPlayerId: null,
    gameMode: null, levelCard: 0, hand: [], turnSeat: null, lastCards: null,
    tribute: false, dealt: false, roundResults: 0, pendingAct: false, finished: false, err: null,
    gave: false, returned: false, tributeDone: false, resisted: false,   // 进贡事件标志
  };
  const is6 = ns === '/g6';
  const detectFn = is6 ? CT.detectType6p : CT.detectType;

  sock.on('connect_error', e => { bot.err = 'connect_error: ' + e.message; });
  sock.on('game:error', d => log(scn, `${name} ⚠️ game:error: ${d && d.message}`));
  sock.on('room:error', d => { bot.err = 'room:error: ' + (d && d.message); log(scn, `${name} ⚠️ room:error: ${d && d.message}`); });
  sock.on('queue:error', d => { bot.err = 'queue:error: ' + (d && d.message); });
  sock.on('room:closed', () => log(scn, `${name} 🚪 收到 room:closed`));

  sock.on('game:hand', d => {
    bot.hand = d.hand || []; bot.mySeat = d.mySeat; bot.myPlayerId = d.myPlayerId;
    bot.gameMode = d.gameMode; bot.levelCard = d.levelCard || 0;
    if (!bot.dealt) { bot.dealt = true; log(scn, `${name} 🃏 收到发牌 ${bot.hand.length} 张 (座${bot.mySeat})`); }
  });
  sock.on('game:hand_update', d => { bot.hand = d.hand || bot.hand; });

  sock.on('game:state', d => {
    bot.turnSeat = d.turnSeat;
    bot.lastCards = d.lastPlay ? d.lastPlay.cards : null;
    if (bot.turnSeat === bot.mySeat && !bot.pendingAct && !bot.tribute && bot.hand.length) {
      bot.pendingAct = true;
      setTimeout(() => actTurn(bot, detectFn), PLAY_DELAY);
    }
  });

  sock.on('tribute:phase', d => {
    bot.tribute = true;
    const ex = (d.exchanges || []).find(e => e.giverId === bot.myPlayerId && (e.stage || 'give') === 'give');
    if (ex) {
      const card = (ex.giveCandidates && ex.giveCandidates[0]) || ex.mustGiveCard;
      setTimeout(() => { sock.emit('tribute:give', { token: bot.token, roomCode: bot.roomCode, card }); bot.gave = true; log(scn, `${name} 🎁 供牌 ${card}`); }, 400);
    }
  });
  sock.on('tribute:card_flew', d => {
    if (d.receiverId === bot.myPlayerId) {
      (async () => {
        /* 等本局新手牌到位再选还供牌（避免在旧/空手牌上算出 undefined）*/
        for (let k = 0; k < 25 && !bot.hand.length; k++) await new Promise(r => setTimeout(r, 150));
        const wild = wildOf(bot.levelCard);
        const sorted = bot.hand.slice().sort((a, b) => rankVal(a) - rankVal(b));
        const ret = sorted.find(c => c !== wild && rankVal(c) <= 10) || sorted.find(c => c !== wild) || sorted[0];
        if (!ret) { log(scn, `${name} ❗ 还供时手牌为空(等待${'3.75'}s后仍无手牌)`); return; }
        sock.emit('tribute:return', { token: bot.token, roomCode: bot.roomCode, returnCard: ret });
        bot.returned = true; log(scn, `${name} 🔁 还供 ${ret}`);
      })();
    }
  });
  sock.on('tribute:resisted', () => { bot.resisted = true; });
  sock.on('tribute:exchange_done', () => { bot.tributeDone = true; });
  sock.on('tribute:done', () => { bot.tribute = false; bot.tributeDone = bot.tributeDone || bot.gave || bot.returned; });
  sock.on('tribute:invalid', d => log(scn, `${name} ⚠️ tribute:invalid: ${d && d.message}`));

  sock.on('player:finished', d => { if (d.seat === bot.mySeat) bot.finished = true; });
  sock.on('game:starting', () => { bot.tribute = false; setTimeout(() => sock.emit('game:request_hand', { token: bot.token, roomCode: bot.roomCode }), 250); });
  sock.on('round:result', () => { bot.roundResults++; setTimeout(() => sock.emit('room:ready', { token: bot.token, roomCode: bot.roomCode }), 700); });

  return bot;
}

function actTurn(bot, detectFn) {
  bot.pendingAct = false;
  if (bot.turnSeat !== bot.mySeat || !bot.hand.length || bot.tribute) return;
  const lastPt = bot.lastCards ? detectFn(bot.lastCards, bot.levelCard) : null;
  const state = { gameMode: bot.gameMode, levelCard: bot.levelCard, hands: { [String(bot.myPlayerId)]: bot.hand.slice() }, lastPlay: lastPt ? { playType: lastPt } : null };
  let play = null;
  try { play = pickBotPlay(state, { playerId: bot.myPlayerId }); } catch (e) { }
  if (play && play.length) bot.sock.emit('play:cards', { token: bot.token, roomCode: bot.roomCode, cards: play });
  else if (bot.lastCards) bot.sock.emit('play:pass', { token: bot.token, roomCode: bot.roomCode });
  else bot.sock.emit('play:cards', { token: bot.token, roomCode: bot.roomCode, cards: [bot.hand[bot.hand.length - 1]] }); // 先出方兜底出一张
}

/* ── 等到条件成立或超时 ── */
async function waitFor(fn, ms, step = 400) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(step); } return false; }
function closeAll(bots) { bots.forEach(b => { try { b.sock.close(); } catch (_) { } }); }

/* ── 场景：开房参赛（私人房，隔离，最安全）── */
async function scenarioPrivate(mode) {
  const ns = mode === '6p' ? '/g6' : '';
  const need = mode === '6p' ? 6 : 4;
  const scn = `开房${mode}`;
  const res = { scn, deal: false, rounds: 0, give: false, return: false, resisted: false, pass: false, detail: '' };
  const bots = [];
  for (let i = 0; i < need; i++) bots.push(makeBot(scn, ns, `${mode}房友${i + 1}`));
  const host = bots[0];
  let roomCode = null;

  /* 提前挂好 room:joined 处理，emit 由 socket.io 缓冲到连上后自动发送 */
  host.sock.on('room:joined', d => { roomCode = d.roomCode; });
  for (let i = 1; i < need; i++) {
    const b = bots[i];
    b.sock.on('room:joined', () => { if (b.roomCode) b.sock.emit('game:request_hand', { token: b.token, roomCode: b.roomCode }); });
  }
  host.sock.emit('room:create', { token: host.token, name: host.name, mode });   // 缓冲发送
  await waitFor(() => roomCode, 20000);
  if (!roomCode) { res.detail = '建房失败(未收到 room:joined)'; closeAll(bots); return res; }
  log(scn, `建房成功 房号 ${roomCode}`);
  host.roomCode = roomCode;
  host.sock.emit('game:request_hand', { token: host.token, roomCode });

  for (let i = 1; i < need; i++) {
    const b = bots[i]; b.roomCode = roomCode;
    b.sock.emit('room:join', { token: b.token, name: b.name, roomCode });
    await sleep(700);
  }

  res.deal = await waitFor(() => bots.every(b => b.dealt), 30000);
  log(scn, res.deal ? `✅ 满员发牌成功(${need}人各收到手牌)` : '❌ 未能全部发牌');
  if (res.deal) {
    /* 局间续局自动进行，多打几局直到出现"完整供牌+还供"，或已见过抗贡且够局数 */
    await waitFor(() => (bots.some(b => b.gave) && bots.some(b => b.returned)) || Math.max(...bots.map(b => b.roundResults)) >= 6, 260000);
    res.rounds = Math.max(...bots.map(b => b.roundResults));
    res.give = bots.some(b => b.gave);
    res.return = bots.some(b => b.returned);
    res.resisted = bots.some(b => b.resisted);
    log(scn, `本场：完成${res.rounds}局，供牌=${res.give} 还供=${res.return} 抗贡=${res.resisted}`);
  }
  res.pass = res.deal;
  const anyErr = bots.map(b => b.err).filter(Boolean);
  if (anyErr.length) res.detail = '错误: ' + anyErr.join('; ');
  closeAll(bots);
  return res;
}

/* ── 场景：随机参赛（注意：线上会和真人共享开放房池，尽量快）── */
async function scenarioRandom(mode) {
  const ns = mode === '6p' ? '/g6' : '';
  const need = mode === '6p' ? 6 : 4;
  const scn = `随机${mode}`;
  const res = { scn, deal: false, rounds: 0, give: false, return: false, resisted: false, pass: false, detail: '' };
  const bots = [];
  for (let i = 0; i < need; i++) {
    const b = makeBot(scn, ns, `${mode}随机${i + 1}`);
    b.sock.on('queue:joined', d => { b.roomCode = d.roomCode; b.sock.emit('game:request_hand', { token: b.token, roomCode: d.roomCode }); });
    b.sock.emit('queue:join', { token: b.token, name: b.name, mode });   // 缓冲发送
    bots.push(b);
    await sleep(600);   // 错开，尽量落进同一开放房
  }
  res.deal = await waitFor(() => bots.every(b => b.dealt), 30000);
  log(scn, res.deal ? `✅ 随机满员发牌成功` : '❌ 未能全部发牌(可能被真人插入或建了多房)');
  if (res.deal) {
    await waitFor(() => (bots.some(b => b.gave) && bots.some(b => b.returned)) || bots.some(b => b.resisted) || Math.max(...bots.map(b => b.roundResults)) >= 3, 120000);
    res.rounds = Math.max(...bots.map(b => b.roundResults));
    res.give = bots.some(b => b.gave);
    res.return = bots.some(b => b.returned);
    res.resisted = bots.some(b => b.resisted);
  }
  res.pass = res.deal;
  closeAll(bots);
  return res;
}

/* ── 场景：断线重连 ── */
async function scenarioReconnect() {
  const scn = '重连4p';
  const res = { scn, deal: false, rejoined: false, pass: false, detail: '' };
  const bots = [];
  for (let i = 0; i < 4; i++) {
    const b = makeBot(scn, '', `重连友${i + 1}`);
    b.sock.on('queue:joined', d => { b.roomCode = d.roomCode; b.sock.emit('game:request_hand', { token: b.token, roomCode: d.roomCode }); });
    b.sock.on('connect', () => b.sock.emit('queue:join', { token: b.token, name: b.name, mode: '4p' }));
    bots.push(b); await sleep(600);
  }
  res.deal = await waitFor(() => bots.every(b => b.dealt), 30000);
  if (res.deal) {
    const victim = bots[0]; const rc = victim.roomCode; const tk = victim.token;
    log(scn, `发牌成功，断开 ${victim.name} 后重连…`);
    victim.sock.close();
    await sleep(2500);
    const re = io(BASE, { transports: ['websocket'], forceNew: true, reconnection: false });
    let got = false;
    re.on('game:hand', () => { got = true; });
    re.on('connect', () => re.emit('game:request_hand', { token: tk, roomCode: rc }));
    res.rejoined = await waitFor(() => got, 15000);
    log(scn, res.rejoined ? '✅ 重连后恢复收到手牌' : '❌ 重连后未收到手牌');
    re.close();
  }
  res.pass = res.deal && res.rejoined;
  closeAll(bots);
  return res;
}

/* ── 主 ── */
(async () => {
  console.log('连线目标:', BASE, '\n开始端到端机器人测试…\n');
  const results = [];
  results.push(await scenarioPrivate('4p'));
  results.push(await scenarioPrivate('6p'));
  results.push(await scenarioRandom('4p'));
  results.push(await scenarioRandom('6p'));
  results.push(await scenarioReconnect());

  console.log('\n══════════ 线上 socket 层端到端测试报告 ══════════');
  results.forEach(r => {
    const bits = [];
    if ('deal' in r) bits.push('发牌' + (r.deal ? '✅' : '❌'));
    if ('rounds' in r) bits.push('完成局数=' + r.rounds);
    if ('give' in r) bits.push('供牌' + (r.give ? '✅' : '—'));
    if ('return' in r) bits.push('还供' + (r.return ? '✅' : '—'));
    if ('resisted' in r) bits.push('抗贡' + (r.resisted ? '✅' : '—'));
    if ('rejoined' in r) bits.push('重连恢复' + (r.rejoined ? '✅' : '❌'));
    console.log(`\n【${r.scn}】 ${r.pass ? '✅ 通过' : '❌ 未通过'}  ${bits.join(' · ')}${r.detail ? '\n   ' + r.detail : ''}`);
  });
  const passed = results.filter(r => r.pass).length;
  console.log(`\n──────────────────────────────\n合计 ${passed}/${results.length} 场景通过`);
  process.exit(0);
})();
