/* 网上掼蛋 · 匹配系统 Socket 事件 */
const { query, queryOne } = require('../db/init');
const {
  getOrCreatePlayer, createRoom, findOrCreateOpenRoom, findRevivalRoom,
  joinRoomByCode, getRoomState, swapSeats
} = require('../db/gdo6');
const { createDoubleDeck, createTripleDeck, shuffle, deal4, deal6 } = require('../utils/cards');
const { initGameState, startTributePhase, seedDisconnectedFromDb, remapSeatOwner } = require('./game6');
const rateGuard = require('./rateGuard');

/* 从 socket 握手取玩家来源信息：IP（用于地理定位）+ channel（访问渠道，客户端在连接 query 传入） */
function sockMeta(socket) {
  const h = (socket && socket.handshake) || {};
  const xff = (h.headers && h.headers['x-forwarded-for']) || '';
  const ip = xff.split(',')[0].trim() || h.address || '';
  const channel = (h.query && h.query.channel) || '';
  return { ip, channel };
}

/* ══════════════════════════════════════════════════════
 * 房间生命周期：赛事大屏不满员 → 等待 5 分钟 → 警告 40 秒 → 永久关闭
 * ══════════════════════════════════════════════════════ */
const WAIT_MS  = 5 * 60 * 1000;   // 不满员等待上限
const CLOSE_MS = 40 * 1000;       // 关闭前倒计时
const roomTimers = new Map();     // roomCode -> { warn?, close? }

function cancelRoomTimer(roomCode) {
  const t = roomTimers.get(roomCode);
  if (t) { clearTimeout(t.warn); clearTimeout(t.close); roomTimers.delete(roomCode); }
}

async function closeRoomPermanently(io, roomCode) {
  cancelRoomTimer(roomCode);
  const st = await getRoomState(roomCode);
  if (!st) return;
  if (st.room.room_type !== 'random') return;  // 仅赛事大屏(随机)房超时关闭，私人亲友房不关
  if (st.room.status === 'playing' || st.seats.length >= 6) return;  // 已开赛/已满则不关
  await query(`UPDATE gdo6_rooms SET status='abandoned', is_full=FALSE WHERE room_code=$1`, [roomCode]);
  await query(`DELETE FROM gdo6_seats WHERE room_id=$1`, [st.room.id]);
  io.to(roomCode).emit('room:closed', {});
  console.log(`[掼蛋6] 🚪 房间永久关闭（不满员超时）· ${roomCode}`);
}

/* 房间处于"等候且不满员"时开始计时；满员/开赛/关闭时取消 */
async function armRoomTimer(io, roomCode) {
  cancelRoomTimer(roomCode);
  const st = await getRoomState(roomCode);
  if (!st) return;
  if (st.room.room_type !== 'random') return;  // 仅赛事大屏(随机)房超时关闭，私人亲友房不关
  if (st.room.status === 'playing' || st.seats.length >= 6) return;
  const warn = setTimeout(async function() {
    const s2 = await getRoomState(roomCode);
    if (!s2) return;
    if (s2.room.status === 'playing' || s2.seats.length >= 6) return;
    io.to(roomCode).emit('room:closing', { seconds: CLOSE_MS / 1000 });
    const close = setTimeout(function() { closeRoomPermanently(io, roomCode); }, CLOSE_MS);
    roomTimers.set(roomCode, { close });
  }, WAIT_MS);
  roomTimers.set(roomCode, { warn });
}

/* ══════════════════════════════════════════════════════
 * 等候室座位互换：同一时刻全房间只允许一笔"正在移动中"的操作，
 * 避免两人同时各拖一个座位时互相踩踏、把座位表改乱。
 * roomCode -> { seat, playerId, socketId, timer }
 * ══════════════════════════════════════════════════════ */
const seatLocks   = new Map();
const SEAT_LOCK_MS = 20 * 1000;   // 选中座位后 20 秒内无人确认目标位/取消 → 自动解锁，绝不卡死

function releaseSeatLock(io, roomCode, expectedSeat) {
  const lock = seatLocks.get(roomCode);
  if (!lock) return;
  if (expectedSeat != null && lock.seat !== expectedSeat) return;   // 已被新一轮选座替换，不能误删
  clearTimeout(lock.timer);
  seatLocks.delete(roomCode);
  io.to(roomCode).emit('seat:lock_update', { seat: null });
}

/* 双保险：万一数据库连接卡住(连接池耗尽/网络抖动)，实际的 swapSeats() 迟迟不返回，
   也绝不能让内存里的座位锁跟着一起卡死——最多等 8 秒，超时就当失败处理并放锁。
   （这把锁只挡"等候室调整座位"这一个动作本身，从不参与、也不会拖累发牌/出牌等
   核心对局逻辑——见 dealAndStart/tryStartNextRound 均不读取 seatLocks，所以哪怕
   这里真的卡住，也只是"暂时不能调座位"，绝不会让整局游戏卡住。） */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise(function(_, reject){
      setTimeout(function(){ reject(new Error((label || 'operation') + ' timed out')); }, ms);
    })
  ]);
}

/* ─── 发牌并启动游戏（满员后调用）──────────────── */
async function dealAndStart(io, roomCode, state) {
  cancelRoomTimer(roomCode);   // 满员开赛，停止关闭计时
  releaseSeatLock(io, roomCode);   // 等候室座位互换锁也一并清掉（开局后等候层不再显示，锁已无意义）
  /* 并发锁：只有把 waiting→playing 抢到的调用才继续发牌，
     避免多端 room:ready / round:autostart 同时触发导致重复发牌 */
  const claimed = await query(
    `UPDATE gdo6_rooms SET status='playing' WHERE room_code=$1 AND status='waiting' RETURNING id`,
    [roomCode]
  );
  if (!claimed.length) return;
  const is6p = true;                 // 六人专用
  const deck  = shuffle(is6p ? createTripleDeck() : createDoubleDeck());
  const halves = is6p ? deal6(deck) : deal4(deck);
  const newRound = parseInt(state.room.round_count || 0) + 1;

  const sortedSeats = [...state.seats].sort((a, b) => a.seat - b.seat);
  const hands = {};
  sortedSeats.forEach((s, i) => { hands[String(s.player_id)] = halves[i]; });

  const rows = await query(
    `INSERT INTO gdo6_rounds(room_id,round_number,hands_json) VALUES($1,$2,$3) RETURNING id`,
    [state.room.id, newRound, JSON.stringify(hands)]
  );
  const roundId = rows[0].id;

  /* 坐庄：首局随机产生，之后 = 上局胜方(settle 时已写入 banker_team) */
  let bankerTeam = state.room.banker_team;
  if (!bankerTeam) {
    bankerTeam = Math.random() < 0.5 ? 1 : 2;
    await query(`UPDATE gdo6_rooms SET banker_team=$1 WHERE room_code=$2`, [bankerTeam, roomCode]);
  }

  await query(
    `UPDATE gdo6_rooms SET status='playing',started_at=NOW(),round_count=$1,is_full=TRUE WHERE room_code=$2`,
    [newRound, roomCode]
  );

  const gs = initGameState(
    roomCode, roundId, state.room.id,
    sortedSeats.map(s => ({
      seat: s.seat, team: s.team,
      playerId: s.player_id, name: s.display_name
    })),
    hands,
    state.room.level_team1, state.room.level_team2, '6p', bankerTeam
  );

  /* 首局翻牌定首抓（PDF 2.1）：用 CSPRNG 随机抽一名玩家先出 */
  if (newRound === 1 && gs) {
    const startSeat = sortedSeats[require('crypto').randomInt(sortedSeats.length)].seat;
    gs.turnSeat = startSeat; gs.leadSeat = startSeat;
  }

  console.log(`[掼蛋] 🃏 发牌 · ${roomCode} · 第${newRound}局 · 每人27张`);

  /* 开局即离线(上一局起就没回座)的座位 → 本局直接机器人托管，避免出牌/进贡卡死 */
  const connMap = {};
  sortedSeats.forEach(s => { connMap[s.seat] = !!s.is_connected; });

  /* 六人赛事：检查是否有上一局的进贡待处理 */
  const tributeRaw = state.room.tribute_json;
  if (is6p && tributeRaw) {
    const tributeInfo = typeof tributeRaw === 'string' ? JSON.parse(tributeRaw) : tributeRaw;
    const started = await startTributePhase(io, roomCode, tributeInfo);
    if (started) {
      if (gs) seedDisconnectedFromDb(io, gs, connMap);   // 含进贡阶段则驱动机器人自动供/还
      return; // startTributePhase 内部会在合适时机 emit game:starting
    }
  }

  if (gs) seedDisconnectedFromDb(io, gs, connMap);
  io.to(roomCode).emit('game:starting', { roomCode, roundId });
}

/* ─── 广播等候状态 ──────────────────────────────── */
async function broadcastWaiting(io, roomCode, state) {
  io.to(roomCode).emit('game:seat_update', {
    seats:   state.seats,
    roomCode,
    mode:    '6p',
    roomType: state.room.room_type
  });
}

/* ─── 尝试开下一局 ───────────────────────────────────
   仅当房间 status=waiting（防重复发牌）且座位满员时才发。
   force=false：在线座位都就绪、且未过半掉线才发（引擎正常续局）
   force=true ：无视过半掉线直接发（客户端 45 秒兜底 / 纳新窗口结束，AI 补位掉线者）*/
async function tryStartNextRound(io, roomCode, force) {
  if (!roomCode) return;
  const state = await getRoomState(roomCode);
  if (!state || state.room.status !== 'waiting') return;
  if (state.seats.length !== 6) return;
  const offline           = state.seats.filter(s => !s.is_connected).length;
  const majorityOffline   = offline * 2 > state.seats.length;
  const connectedAllReady = state.seats.every(s => s.is_ready || !s.is_connected);
  if (force || (connectedAllReady && !majorityOffline)) {
    await dealAndStart(io, roomCode, state);
  }
}

/* ══════════════════════════════════════════════════
 * Socket 事件处理器
 * ══════════════════════════════════════════════════ */
module.exports = function(io, socket) {

  /* ── 随机参赛：立即分配进开放房间 ── */
  socket.on('queue:join', async function(data) {
    try {
      /* 反机器人：同一 IP 每分钟随机参赛过频 → 判定机器人，踢出并临时封禁（内部测试机器人豁免）*/
      const ip = rateGuard.ipOf(socket);
      if (!rateGuard.isBot(socket) && !rateGuard.allow(ip, 'queue:join')) {
        rateGuard.kickIp(io, ip, '检测到疑似机器人：短时间内大量参赛请求，已被临时限制，请稍后再试');
        return;
      }
      const { token, name, mode } = data;
      const player = await getOrCreatePlayer(token, name, sockMeta(socket));

      /* 随机参赛的"回原房"只认【随机房】，避免残留的私人房把随机参赛劫持进等候室 */
      const activeRow = await query(`
        SELECT r.room_code FROM gdo6_rooms r
        JOIN gdo6_seats s ON s.room_id=r.id
        WHERE s.player_id=$1 AND r.room_type='random' AND r.status IN ('waiting','playing')
        LIMIT 1
      `, [player.id]);
      if (activeRow.length) {
        socket.join(activeRow[0].room_code);
        socket.emit('queue:joined', { roomCode: activeRow[0].room_code });
        return;
      }

      /* 接替：若有"满员、存在机器人托管空座"的随机房(局间/局中均可)，
         优先让新玩家接手一个托管座（座号/队伍不变，本局局分由新玩家继承），把被弃赛事救活。
         原玩友仍可随时重连回原座（走上面的"回原房"分支，优先级更高）。
         局中(midRound)接手：要先把正在跑的内存对局态(手牌等)同步成新玩家，
         再让客户端跳转进游戏页请求手牌，否则会看到空手牌。*/
      const reviveCode = await findRevivalRoom();
      if (reviveCode) {
        const rr = await joinRoomByCode(reviveCode, player.id, socket.id);
        if (!rr.error && rr.takeover) {
          if (rr.midRound) remapSeatOwner(reviveCode, rr.seat, rr.oldPlayerId, player.id, player.display_name);
          socket.join(reviveCode);
          socket.emit('queue:joined', { roomCode: reviveCode });
          const rst = await getRoomState(reviveCode);
          await broadcastWaiting(io, reviveCode, rst);
          io.to(reviveCode).emit('room:update', { state: rst });
          return;   // 接手托管座 → 局间等下一局照常发牌(保留续局窗口)；局中客户端会自行 request_hand 接上当前对局
        }
        /* 竞态：座位已被别人接手/原玩友已回座 → 落到开放房逻辑 */
      }

      /* 否则进"尚未开赛、还在填人"的房间(findOrCreateOpenRoom 只返回 is_full=FALSE)。*/
      const roomCode = await findOrCreateOpenRoom();
      const result   = await joinRoomByCode(roomCode, player.id, socket.id);
      if (result.error) return socket.emit('queue:error', { message: result.error });

      socket.join(roomCode);
      socket.emit('queue:joined', { roomCode });

      const state = await getRoomState(roomCode);
      await broadcastWaiting(io, roomCode, state);

      const need = 6;
      if (state.seats.length >= need) {
        await dealAndStart(io, roomCode, state);
        /* 为下一批玩家自动建新房间 */
        findOrCreateOpenRoom().catch(e => console.error('[auto-room]', e.message));
      } else {
        await armRoomTimer(io, roomCode);   // 不满员：启动"等待5分钟→警告40秒→永久关闭"计时
      }
    } catch (e) {
      console.error('[queue:join]', e.message);
      socket.emit('queue:error', { message: '加入失败，请重试' });
    }
  });

  socket.on('queue:cancel', async function(data) {
    try {
      const player = await getOrCreatePlayer(data.token, '');
      await query(
        `UPDATE gdo6_queue SET status='cancelled' WHERE player_id=$1 AND status='waiting'`,
        [player.id]
      );
      socket.emit('queue:cancelled');
    } catch (e) { console.error('[queue:cancel]', e.message); }
  });

  /* ── 亲友开房：建私人房间后立即进游戏页 ── */
  socket.on('room:create', async function(data) {
    try {
      /* 反机器人：同一 IP 每分钟建房过频(≥10) → 判定机器人，踢出并临时封禁 */
      const ip = rateGuard.ipOf(socket);
      if (!rateGuard.allow(ip, 'room:create')) {
        rateGuard.kickIp(io, ip, '检测到疑似机器人：短时间内创建过多房间，已被临时限制，请稍后再试');
        return;
      }
      const { token, name, mode } = data;
      const player = await getOrCreatePlayer(token, name, sockMeta(socket));
      const room   = await createRoom('private');
      const result = await joinRoomByCode(room.room_code, player.id, socket.id);
      if (result.error) return socket.emit('room:error', { message: result.error });

      socket.join(room.room_code);
      socket.emit('room:joined', { roomCode: room.room_code, playerId: player.id });

      const state = await getRoomState(room.room_code);
      await broadcastWaiting(io, room.room_code, state);
    } catch (e) {
      console.error('[room:create]', e.message);
      socket.emit('room:error', { message: '创建房间失败' });
    }
  });

  /* ── 加入亲友房间 ──
     若命中的是"局中接替托管座"(result.midRound)：先同步内存对局态成新玩家，
     且不再走 dealAndStart(对局已在进行中，不需要也不应该重新发牌)。 */
  socket.on('room:join', async function(data) {
    try {
      const { token, name, roomCode } = data;
      if (!roomCode) return socket.emit('room:error', { message: '请输入房间号' });
      const player = await getOrCreatePlayer(token, name, sockMeta(socket));
      const code   = roomCode.trim().toUpperCase();
      const result = await joinRoomByCode(code, player.id, socket.id);
      if (result.error) return socket.emit('room:error', { message: result.error });

      if (result.takeover && result.midRound) {
        remapSeatOwner(code, result.seat, result.oldPlayerId, player.id, player.display_name);
      }

      socket.join(code);
      socket.emit('room:joined', { roomCode: code, playerId: player.id });

      const state = await getRoomState(code);
      await broadcastWaiting(io, code, state);

      const need = 6;
      if (!result.midRound && state.seats.length >= need) {
        await dealAndStart(io, code, state);
      }
    } catch (e) {
      console.error('[room:join]', e.message);
      socket.emit('room:error', { message: '加入房间失败' });
    }
  });

  /* ── 等候室调整座位（仅私人房、开局前）──────────────────────
     用法：先点一个"有人"的座位选中 = 占用该房唯一的移动锁；再点第二个座位(有人=对调/
     空位=移过去)提交；点同一个座位第二次 = 取消选中。任何时刻全房间只允许一笔进行中的
     移动，别人这时选座会被明确拒绝并提示"其他用户正在调整该玩家位置，请稍等"——
     不是"悄悄失败"，也不会因为谁忘了确认而永远卡住(20秒无操作自动解锁 + 断线立即解锁)。 */
  socket.on('seat:select', async function(data) {
    try {
      const { token, roomCode, seat } = data || {};
      if (!roomCode || !seat) return;
      const state = await getRoomState(roomCode);
      if (!state || state.room.room_type !== 'private' || state.room.status !== 'waiting') return;
      const player = await queryOne('SELECT id FROM gdo_players WHERE player_token=$1', [token]);
      if (!player) return;
      if (!state.seats.some(s => s.seat === seat)) return;   // 空位没有玩家可选

      const lock = seatLocks.get(roomCode);
      if (lock && lock.playerId !== player.id) {
        socket.emit('seat:error', { message: '其他用户正在调整该玩家位置，请稍等' });
        return;
      }
      if (lock) clearTimeout(lock.timer);   // 同一玩家换选了别的座位：直接顶替旧锁，不用先取消

      const timer = setTimeout(function(){ releaseSeatLock(io, roomCode, seat); }, SEAT_LOCK_MS);
      seatLocks.set(roomCode, { seat, playerId: player.id, socketId: socket.id, timer });
      io.to(roomCode).emit('seat:lock_update', { seat, byPlayerId: player.id });
    } catch (e) { console.error('[seat:select]', e.message); }
  });

  socket.on('seat:cancel', async function(data) {
    try {
      const { token, roomCode } = data || {};
      if (!roomCode) return;
      const player = await queryOne('SELECT id FROM gdo_players WHERE player_token=$1', [token]);
      if (!player) return;
      const lock = seatLocks.get(roomCode);
      if (lock && lock.playerId === player.id) releaseSeatLock(io, roomCode, lock.seat);
    } catch (e) { console.error('[seat:cancel]', e.message); }
  });

  socket.on('seat:move', async function(data) {
    try {
      const { token, roomCode, toSeat } = data || {};
      if (!roomCode || !toSeat) return;
      const player = await queryOne('SELECT id FROM gdo_players WHERE player_token=$1', [token]);
      if (!player) return;
      const lock = seatLocks.get(roomCode);
      if (!lock || lock.playerId !== player.id) {
        socket.emit('seat:error', { message: '请先选中要调整的座位' });
        return;
      }
      const fromSeat = lock.seat;
      if (toSeat === fromSeat) { releaseSeatLock(io, roomCode, fromSeat); return; }   // 点回自己选中的座位=取消

      const result = await withTimeout(swapSeats(roomCode, fromSeat, toSeat), 8000, 'swapSeats');
      releaseSeatLock(io, roomCode, fromSeat);   // 无论成功失败都必须释放，绝不能让锁卡住
      if (result.error) { socket.emit('seat:error', { message: result.error }); return; }

      const state = await getRoomState(roomCode);
      if (state) await broadcastWaiting(io, roomCode, state);
    } catch (e) {
      console.error('[seat:move]', e.message);
      releaseSeatLock(io, (data && data.roomCode));   // 含超时：数据库再慢也不能让座位锁卡住
      socket.emit('seat:error', { message: '调整座位失败，请重试' });
    }
  });

  socket.on('room:leave', async function(data) {
    try {
      const { roomCode } = data;
      await query(`UPDATE gdo6_seats SET is_connected=FALSE, disconnected_at=NOW() WHERE socket_id=$1`, [socket.id]);
      socket.leave(roomCode);
      const state = await getRoomState(roomCode);
      if (state) io.to(roomCode).emit('room:update', { state });
    } catch (e) { console.error('[room:leave]', e.message); }
  });

  /* ── 续局：某玩家点"继续" ── */
  socket.on('room:ready', async function(data) {
    try {
      const { roomCode } = data;
      await query(`UPDATE gdo6_seats SET is_ready=TRUE WHERE socket_id=$1`, [socket.id]);
      const state = await getRoomState(roomCode);
      if (!state) return;
      io.to(roomCode).emit('room:update', { state });
      await tryStartNextRound(io, roomCode, false);
    } catch (e) { console.error('[room:ready]', e.message); }
  });

  /* ── 续局兜底：客户端局间 15 秒倒计时到点（也是"开放纳新"窗口结束）→ 强制发下一局 ── */
  socket.on('round:autostart', async function(data) {
    try {
      await tryStartNextRound(io, (data && data.roomCode), true);
    } catch (e) { console.error('[round:autostart]', e.message); }
  });

  /* ── 断线处理 ── */
  socket.on('disconnect', async function() {
    try {
      await query(`UPDATE gdo6_seats SET is_connected=FALSE, disconnected_at=NOW() WHERE socket_id=$1`, [socket.id]);
      await query(
        `UPDATE gdo6_queue SET status='cancelled' WHERE socket_id=$1 AND status='waiting'`,
        [socket.id]
      );
      /* 正在挑座位挪人的玩家掉线了：立即放锁，不等 20 秒超时，别人不用干等 */
      for (const [rc, lock] of seatLocks) {
        if (lock.socketId === socket.id) releaseSeatLock(io, rc, lock.seat);
      }
    } catch (e) {}
  });
};
