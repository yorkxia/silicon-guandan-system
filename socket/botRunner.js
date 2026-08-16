/* ═══════════════════════════════════════════════════════════════════════════
 * 机器人测试系统 · botRunner
 * 目的：用 socket.io-client 起若干"虚拟客户端"，走和真人完全一样的
 *       queue:join → 发牌 → 出牌(复用 utils/bot.js 的协作AI) → 局间续局 全链路，
 *       让 4人/6人赛事大厅 24 小时有对局在跑（真人可无感接手托管座直接进大屏），
 *       同时作为持续端到端测试，出问题写入客服(gd_support_messages)通知管理员。
 *
 * 关键点：
 *   - 默认关闭(gd_settings.bot_sim_enabled=0)，管理员在监控台「机器人」面板一键启停；
 *   - 两组各 10 人(4人桌×1 + 6人桌×1)，第二组比第一组晚 staggerH 启动，各活 groupLifeH 后
 *     整组撤离(断线→房间自动关闭)并立即重启，从而 24h 不间断；
 *   - 机器人不会拖垮真人：全程 try/catch，绝不 crash 进程；一切定时器 unref；
 *   - 机器人身份：token 前缀 botsim:、名字前缀 🤖、握手带 botsecret(绕过反机器人限流)+channel=botsim；
 *   - 保 Render 唤醒需靠"外部 ping"(见 .github/workflows/keepalive.yml)，机器人本身唤不醒睡着的实例。
 * ═══════════════════════════════════════════════════════════════════════════ */
'use strict';
const { io: ioClient } = require('socket.io-client');
const { query } = require('../db/init');
const { pickBotPlay } = require('../utils/bot');
const { detectType, detectType6p } = require('../utils/cardTypes');

const PORT    = process.env.PORT || 3000;
const SELF    = process.env.BOT_SELF_URL || ('http://127.0.0.1:' + PORT);
const SECRET  = process.env.BOT_SECRET || 'guandan-botsim-2026';

/* 默认配置（可被 gd_settings.bot_sim_config JSON 覆盖）*/
const DEFAULTS = {
  groupLifeH: 12,       // 每组存活小时
  staggerH:   11.8333,  // 第二组晚多少小时启动(=11h50m)
  actMinMs:   500,      // 出牌思考最短延时
  actMaxMs:   1600,     // 出牌思考最长延时
  fourPerTable: 4,
  sixPerTable:  6
};

/* 机器人名字池（随机取）*/
const NAME_POOL = ['小明','阿强','老王','丽丽','大鹏','阿珍','逗逗','闪电','旺财','花花',
  '黑桃K','红桃Q','老李','小芳','阿福','贝贝','磊哥','阿May','球球','大壮',
  '飞飞','娜娜','阿豪','小北','糖糖','阿信','点点','乐乐','阿泰','喵喵'];
function randName() {
  return '🤖' + NAME_POOL[Math.floor(Math.random() * NAME_POOL.length)] +
    Math.floor(Math.random() * 90 + 10);
}

/* ── 运行态 ── */
const RUN = {
  enabled:   false,
  startedAt: 0,
  lastError: '',
  groups:    {},          // gid('A'|'B') -> { bots:[], startedAt, startNextTimer, stopTimer }
  pollTimer: null
};
const OTHER = { A: 'B', B: 'A' };
let _io  = null;          // 四人默认命名空间
let _io6 = null;          // 六人 /g6 命名空间
const _errReported = {};  // 错误上报节流

/* ── gd_settings 读写 ── */
async function getSetting(k, dflt) {
  try {
    const r = await query('SELECT sval FROM gd_settings WHERE skey=$1', [k]);
    return (r && r.length && r[0].sval != null) ? r[0].sval : dflt;
  } catch (e) { return dflt; }
}
async function setSetting(k, v) {
  try {
    await query(
      `INSERT INTO gd_settings(skey,sval,updated_at) VALUES($1,$2,NOW())
       ON CONFLICT (skey) DO UPDATE SET sval=$2, updated_at=NOW()`,
      [k, String(v)]
    );
  } catch (e) {}
}
async function getConfig() {
  const raw = await getSetting('bot_sim_config', '');
  let cfg = Object.assign({}, DEFAULTS);
  if (raw) { try { Object.assign(cfg, JSON.parse(raw)); } catch (e) {} }
  return cfg;
}

/* ── 出问题时写客服(节流：同类错误每 30 分钟最多一条) ── */
async function reportProblem(kind, msg) {
  try {
    const now = Date.now();
    if (_errReported[kind] && now - _errReported[kind] < 30 * 60 * 1000) return;
    _errReported[kind] = now;
    RUN.lastError = '[' + new Date().toISOString().slice(11, 19) + '] ' + kind + '：' + msg;
    await query(
      `INSERT INTO gd_support_messages(device_id,user_name,sender,body,source,created_at)
       VALUES($1,$2,'user',$3,'botsim',NOW())`,
      ['botsim-monitor', '🤖机器人测试', '【机器人测试报警】' + kind + '：' + String(msg).slice(0, 300)]
    );
  } catch (e) {}
}

/* ═══════════════ 单个虚拟客户端 ═══════════════ */
function makeBot(gid, mode) {
  const name  = randName();
  const token = 'botsim:' + gid + ':' + mode + ':' + Math.random().toString(36).slice(2, 9);
  const url   = mode === '6p' ? (SELF + '/g6') : SELF;
  const cfgP  = getConfig();   // Promise，仅用于延时区间

  const st = {
    token, name, mode, alive: true,
    roomCode: null, myPlayerId: null, mySeat: null, myTeam: null,
    gameMode: mode, levelCard: 0, hand: [], seats: [],
    turnSeat: null, lastPlay: null, finishOrder: [], handCounts: {}, finished: false,
    actTimer: null
  };

  const sock = ioClient(url, {
    transports: ['websocket', 'polling'],
    query: { botsecret: SECRET, channel: 'botsim', name },
    /* 关闭自动重连：停止/掉线的机器人保持"死"，杜绝重连幽灵把已关房间又拉活；
       分组换届会周期性刷新机器人，无需靠重连续命 */
    reconnection: false, timeout: 15000
  });

  const emit = (ev, data) => { try { if (st.alive && sock.connected) sock.emit(ev, data); } catch (e) {} };
  const requeue = (ms) => {
    st.roomCode = null;
    setTimeout(() => { if (st.alive) emit('queue:join', { token, name, mode }); }, ms || 1500);
  };

  sock.on('connect', () => {
    emit('player:join', { token, name });
    emit('queue:join', { token, name, mode });
  });
  sock.on('connect_error', (e) => reportProblem(mode + '连接失败', (e && e.message) || 'connect_error'));
  sock.on('security:kick', (d) => reportProblem(mode + '被限流踢出', (d && d.message) || 'kick'));

  sock.on('queue:joined', (d) => { st.roomCode = d && d.roomCode; if (st.roomCode) emit('game:request_hand', { token, roomCode: st.roomCode }); });
  sock.on('queue:error',  () => requeue(4000));

  sock.on('game:starting', (d) => {
    st.finished = false;
    const rc = (d && d.roomCode) || st.roomCode;
    if (rc) { st.roomCode = rc; emit('game:request_hand', { token, roomCode: rc }); }
  });

  sock.on('game:waiting', (d) => { if (d && d.roomCode) st.roomCode = d.roomCode; });

  sock.on('game:hand', (d) => {
    st.hand       = d.hand || [];
    st.myPlayerId = d.myPlayerId;
    st.mySeat     = d.mySeat;
    st.myTeam     = d.myTeam;
    st.gameMode   = d.gameMode || mode;
    st.levelCard  = d.levelCard || 0;
    st.roomCode   = d.roomCode || st.roomCode;
    st.seats      = (d.players || []).map(p => ({ seat: p.seat, team: p.team, playerId: p.playerId }));
    st.finished   = false;
    /* 不在此处出牌：等权威的 game:turn_timer 指明轮到本座位再出，避免误抢回合触发 play:invalid */
  });
  sock.on('game:hand_update', (d) => { if (d && d.hand) st.hand = d.hand; });

  sock.on('game:state', (d) => {
    st.turnSeat    = d.turnSeat;
    st.lastPlay    = d.lastPlay || null;
    st.finishOrder = d.finishOrder || [];
    st.handCounts  = d.handCounts || {};
    st.finished    = st.finishOrder.some(f => f.seat === st.mySeat);
    /* 仅更新状态，出牌统一由 game:turn_timer 触发 */
  });
  /* 唯一权威出牌触发点：服务器为某座位起回合计时(每回合都发) */
  sock.on('game:turn_timer', (d) => { if (d && d.turnSeat === st.mySeat && !st.finished) scheduleAct(); });

  sock.on('play:invalid', (d) => {
    /* 兜底：若出牌被判无效，改为过牌，避免卡在自己回合等超时 */
    if (st.lastPlay) emit('play:pass', { token, roomCode: st.roomCode });
    reportProblem(mode + '出牌被拒', (d && d.message) || 'invalid');
  });

  sock.on('round:result', () => {
    setTimeout(() => { if (st.alive) emit('round:autostart', { roomCode: st.roomCode }); }, 1800 + Math.random() * 1200);
  });
  sock.on('game:seat_taken', () => requeue(2000));   // 座位被真人接手 → 换桌重新参赛
  sock.on('room:closed',     () => requeue(2500));

  /* 出牌调度：随机思考延时，避免同一时刻齐刷刷出牌 + 防抖 */
  function scheduleAct() {
    if (!st.alive || st.finished) return;
    if (st.actTimer) return;
    cfgP.then(cfg => {
      const delay = (cfg.actMinMs || 500) + Math.random() * ((cfg.actMaxMs || 1600) - (cfg.actMinMs || 500));
      st.actTimer = setTimeout(() => { st.actTimer = null; try { act(); } catch (e) {} }, delay);
      if (st.actTimer && st.actTimer.unref) st.actTimer.unref();
    });
  }

  function act() {
    if (!st.alive || st.finished || !st.roomCode) return;
    if (st.turnSeat !== st.mySeat) return;             // 不是我的回合
    if (!st.hand || !st.hand.length) return;
    const detectFn = st.gameMode === '6p' ? detectType6p : detectType;

    /* 用公开信息拼一个"合成 state" 复用 pickBotPlay：我的真实手牌 + 对手仅需张数 */
    const synthHands = {};
    synthHands[String(st.myPlayerId)] = st.hand;
    for (const [pid, c] of Object.entries(st.handCounts)) {
      if (pid !== String(st.myPlayerId)) synthHands[pid] = new Array(c).fill('X');
    }
    let lastPlay = null;
    if (st.lastPlay && st.lastPlay.cards && st.lastPlay.cards.length) {
      const pt = detectFn(st.lastPlay.cards, st.levelCard);
      if (pt) lastPlay = { seat: st.lastPlay.seat, cards: st.lastPlay.cards, playType: pt };
    }
    const synth = {
      gameMode: st.gameMode, levelCard: st.levelCard,
      hands: synthHands, seats: st.seats,
      finishOrder: st.finishOrder, lastPlay
    };
    const seatObj = st.seats.find(s => s.seat === st.mySeat);
    if (!seatObj) return;

    let cards = null;
    try { cards = pickBotPlay(synth, seatObj); } catch (e) { cards = null; }

    if (cards && cards.length) {
      emit('play:cards', { token: st.token, roomCode: st.roomCode, cards });
    } else if (lastPlay) {
      emit('play:pass', { token: st.token, roomCode: st.roomCode });
    } else {
      /* 领出但 pickBotPlay 罕见地返回空 → 兜底甩最小一张，绝不卡回合 */
      emit('play:cards', { token: st.token, roomCode: st.roomCode, cards: [st.hand[st.hand.length - 1]] });
    }
  }

  return {
    st,
    stop() {
      st.alive = false;
      if (st.actTimer) { clearTimeout(st.actTimer); st.actTimer = null; }
      try { sock.removeAllListeners(); } catch (e) {}
      try { sock.disconnect(); } catch (e) {}
    }
  };
}

/* ═══════════════ 分组调度（接力：任何时刻通常只有一组在跑）═══════════════
   一组 = 一桌4人 + 一桌6人(共10人)。本组开跑后 staggerH(默认11h50m) 启动"另一组"，
   两组仅共存 (groupLifeH - staggerH)=10 分钟；本组满 groupLifeH(默认12h) 撤离。
   ⇒ A→(11h50m)→A&B 共存10min→(12h)A撤→只剩B→(B的11h50m)→B&A共存…周而复始，绝不长期双桌。*/
async function launchGroup(gid) {
  if (RUN.groups[gid]) return;                 // 该组已在跑 → 不重复开桌（修复"两组长期共存导致双倍人数"）
  const cfg = await getConfig();
  const four = cfg.fourPerTable || 4, six = cfg.sixPerTable || 6;
  const g = { bots: [], startedAt: Date.now(), startNextTimer: null, stopTimer: null };
  RUN.groups[gid] = g;

  /* 同组机器人错峰 300ms 依次加入 → 让第一个先建好房，其余依次填入同一桌，
     避免并发 findOrCreateOpenRoom 竞态各自开出多张半空桌 */
  const specs = [];
  for (let i = 0; i < four; i++) specs.push('4p');
  for (let i = 0; i < six;  i++) specs.push('6p');
  specs.forEach((mode, idx) => {
    const t = setTimeout(() => { if (RUN.groups[gid] === g) g.bots.push(makeBot(gid, mode)); }, idx * 300);
    if (t && t.unref) t.unref();
  });

  const startNextMs = Math.max(0.02, cfg.staggerH   || 11.8333) * 3600 * 1000;
  const stopMs      = Math.max(0.03, cfg.groupLifeH || 12)      * 3600 * 1000;
  g.startNextTimer = setTimeout(() => { if (RUN.enabled) launchGroup(OTHER[gid]).catch(() => {}); }, startNextMs);
  g.stopTimer      = setTimeout(() => { if (RUN.enabled) teardownGroup(gid); }, stopMs);
  if (g.startNextTimer && g.startNextTimer.unref) g.startNextTimer.unref();
  if (g.stopTimer && g.stopTimer.unref) g.stopTimer.unref();

  console.log(`[botsim] ▶ 组 ${gid} 启动：4人×${four} + 6人×${six}`);
  markBotPlayers().catch(() => {});
}
function teardownGroup(gid) {
  const g = RUN.groups[gid];
  if (!g) return;
  clearTimeout(g.startNextTimer); clearTimeout(g.stopTimer);
  const rooms4 = new Set(), rooms6 = new Set();
  g.bots.forEach(b => {
    if (b.st && b.st.roomCode) (b.st.mode === '6p' ? rooms6 : rooms4).add(b.st.roomCode);
    try { b.stop(); } catch (e) {}
  });
  delete RUN.groups[gid];
  /* 机器人断开后即时清场：仅关"无真人在线"的机器人房，绝不踢真人（closeRoomByCode 内有守卫）*/
  setTimeout(() => {
    try {
      const game  = require('./game');
      const game6 = require('./game6');
      rooms4.forEach(rc => { if (_io  && game.closeRoomByCode)  game.closeRoomByCode(_io,  rc).catch(() => {}); });
      rooms6.forEach(rc => { if (_io6 && game6.closeRoomByCode) game6.closeRoomByCode(_io6, rc).catch(() => {}); });
    } catch (e) {}
  }, 900);
  console.log(`[botsim] ⏹ 组 ${gid} 撤离（清 ${rooms4.size} 张4人桌 + ${rooms6.size} 张6人桌）`);
}

/* 给机器人玩家打 is_bot 标记，便于统计时排除 */
async function markBotPlayers() {
  try { await query(`UPDATE gdo_players SET is_bot=TRUE WHERE player_token LIKE 'botsim:%' AND is_bot IS NOT TRUE`); } catch (e) {}
}

/* 兜底清场：DB 级扫描【所有】含机器人(token botsim: 或 is_bot)且【无真人在线】的活跃随机房并强制关闭。
   用于"停止"时彻底终结机器人赛事——即便有内存未跟踪的残留房/旧实例/重连幽灵也一并清掉。绝不动真人房。*/
async function closeAllBotRooms() {
  try {
    const game  = require('./game');
    const game6 = require('./game6');
    const r4 = await query(`
      SELECT DISTINCT r.room_code FROM gdo_rooms r
      JOIN gdo_seats s ON s.room_id=r.id JOIN gdo_players p ON p.id=s.player_id
      WHERE r.status IN ('waiting','playing')
        AND (p.player_token LIKE 'botsim:%' OR p.is_bot=TRUE)
        AND NOT EXISTS (SELECT 1 FROM gdo_seats s2 JOIN gdo_players p2 ON p2.id=s2.player_id
                        WHERE s2.room_id=r.id AND s2.is_connected=TRUE
                          AND p2.is_bot IS NOT TRUE AND p2.player_token NOT LIKE 'botsim:%')`);
    for (const row of r4) { if (_io  && game.closeRoomByCode)  await game.closeRoomByCode(_io,  row.room_code); }
    const r6 = await query(`
      SELECT DISTINCT r.room_code FROM gdo6_rooms r
      JOIN gdo6_seats s ON s.room_id=r.id JOIN gdo_players p ON p.id=s.player_id
      WHERE r.status IN ('waiting','playing')
        AND (p.player_token LIKE 'botsim:%' OR p.is_bot=TRUE)
        AND NOT EXISTS (SELECT 1 FROM gdo6_seats s2 JOIN gdo_players p2 ON p2.id=s2.player_id
                        WHERE s2.room_id=r.id AND s2.is_connected=TRUE
                          AND p2.is_bot IS NOT TRUE AND p2.player_token NOT LIKE 'botsim:%')`);
    for (const row of r6) { if (_io6 && game6.closeRoomByCode) await game6.closeRoomByCode(_io6, row.room_code); }
    if (r4.length || r6.length) console.log(`[botsim] 🧹 兜底清场：关闭机器人房 4人 ${r4.length} + 6人 ${r6.length}`);
  } catch (e) {}
}

/* ── 启停 ── */
async function start() {
  if (RUN.enabled) return;
  RUN.enabled = true; RUN.startedAt = Date.now(); RUN.lastError = '';
  await launchGroup('A');    // 接力自持：A 到点(11h50m)拉起 B、A 到点(12h)撤离，B 同理，周而复始
  console.log('[botsim] ✅ 机器人测试系统已启动（接力模式，任何时刻通常只一桌4人+一桌6人）');
}
function stop() {
  RUN.enabled = false;
  Object.keys(RUN.groups).forEach(teardownGroup);
  closeAllBotRooms().catch(() => {});     // 立即兜底清场，彻底终结机器人赛事
  console.log('[botsim] ⏹ 机器人测试系统已停止');
}

/* ── 状态写入 gd_settings.bot_sim_status（监控台面板读取展示）── */
async function writeStatus() {
  try {
    const groups = {};
    let botsTotal = 0; const rooms = new Set();
    for (const [gid, g] of Object.entries(RUN.groups)) {
      let alive = 0, playing = 0;
      g.bots.forEach(b => {
        botsTotal++;
        if (b.st.roomCode) { rooms.add(b.st.roomCode); if (!b.st.finished) playing++; }
        if (b.st.alive) alive++;
      });
      groups[gid] = { bots: g.bots.length, playing, startedAt: g.startedAt,
        ageMin: Math.round((Date.now() - g.startedAt) / 60000) };
    }
    const status = {
      enabled: RUN.enabled, startedAt: RUN.startedAt,
      botsTotal, roomsActive: rooms.size, groups,
      lastError: RUN.lastError, ts: Date.now()
    };
    await setSetting('bot_sim_status', JSON.stringify(status));
  } catch (e) {}
}

/* ── 每日自动清理(绿灯表)，受 bot_sim_cleanup_enabled 控制 ── */
let _lastCleanupDay = '';
async function maybeCleanup() {
  try {
    const on = (await getSetting('bot_sim_cleanup_enabled', '0')) === '1';
    if (!on) return;
    const day = new Date().toISOString().slice(0, 10);
    const last = await getSetting('bot_sim_cleanup_last_day', '');
    if (last === day || _lastCleanupDay === day) return;   // 一天只清一次
    _lastCleanupDay = day;
    const months = parseInt(await getSetting('bot_sim_cleanup_months', '2'), 10) || 2;
    const { autoCleanup } = require('../scripts/db-maintain');
    console.log('[botsim] 🧹 每日自动清理开始（保留最近 ' + months + ' 个月）');
    await autoCleanup(months);
    await setSetting('bot_sim_cleanup_last_day', day);
    await setSetting('bot_sim_cleanup_last_ts', String(Date.now()));
    console.log('[botsim] ✅ 每日自动清理完成');
  } catch (e) {
    reportProblem('每日清理失败', e.message);
  }
}

/* ── 主轮询：跟随管理员开关启停 + 写状态 + 每日清理（每 12s）── */
async function poll() {
  try {
    const want = (await getSetting('bot_sim_enabled', '0')) === '1';
    if (want && !RUN.enabled) await start();
    else if (!want && RUN.enabled) stop();
    await markBotPlayers();                    // 给机器人玩家打标记(玩家行在 queue:join 后才创建)
    if (!want) await closeAllBotRooms();        // 停止态：持续兜底清掉任何残留机器人房(旧实例/重连幽灵也清)
    await writeStatus();
    await maybeCleanup();
  } catch (e) { /* 轮询绝不抛 */ }
}

/* ── 对外接口 ── */
function init(io) {
  _io  = io;
  _io6 = io && io.of ? io.of('/g6') : null;   // 六人命名空间(强制清场/关房时用)
  RUN.pollTimer = setInterval(() => { poll().catch(() => {}); }, 12 * 1000);
  if (RUN.pollTimer && RUN.pollTimer.unref) RUN.pollTimer.unref();
  poll().catch(() => {});   // 启动即对齐一次（开机 flag=1 自动拉起；flag=0 则顺带清残留机器人房，Render 重启后自愈）
  console.log('[botsim] botRunner 就绪（默认关闭，等待监控台「机器人」开关）');
}
function snapshot() {
  return {
    enabled: RUN.enabled, startedAt: RUN.startedAt, lastError: RUN.lastError,
    groups: Object.keys(RUN.groups).map(gid => ({ gid, bots: RUN.groups[gid].bots.length, startedAt: RUN.groups[gid].startedAt }))
  };
}

module.exports = { init, start, stop, snapshot, poll };
