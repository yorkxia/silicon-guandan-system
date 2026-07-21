/* 网上掼蛋对战 · 数据库辅助层 */
const { query, queryOne } = require('./init');
const { geoLocate } = require('../utils/geo');

const LEVEL_NAME = { 2:'2',3:'3',4:'4',5:'5',6:'6',7:'7',8:'8',9:'9',10:'10',11:'J',12:'Q',13:'K',14:'A' };
function levelName(n) { return LEVEL_NAME[n] || String(n); }

/* ── 生成房间短码 ── */
function genCode() {
  const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const r = () => L[Math.floor(Math.random() * L.length)];
  const n = () => Math.floor(Math.random() * 10);
  return `${r()}${r()}${n()}${n()}${n()}${n()}`;
}

/* ── 玩家地理位置：异步补齐，不阻塞加入流程（geoLocate 走 ipapi.co，可能耗时数秒） ── */
function updatePlayerGeo(playerId, ip) {
  Promise.resolve(geoLocate(ip)).then(function (geo) {
    if (!geo) return null;
    return query(
      'UPDATE gdo_players SET country=$1, region_code=$2, city=$3 WHERE id=$4',
      [geo.country, geo.region_code, geo.city, playerId]
    );
  }).catch(function () { /* 静默：定位失败不影响对战 */ });
}

/* ── 玩家：首次访问自动建档，之后更新名称 ──
   meta（可选）：{ ip, channel } —— 来源(访问渠道) 每次加入即刷新；
   地理位置仅在尚未采集时用 IP 异步补齐一次。 */
async function getOrCreatePlayer(token, name, meta) {
  meta = meta || {};
  const channel = meta.channel || null;
  let p = await queryOne('SELECT * FROM gdo_players WHERE player_token=$1', [token]);
  if (!p) {
    const rows = await query(
      'INSERT INTO gdo_players(player_token,display_name,source) VALUES($1,$2,$3) RETURNING *',
      [token, name || '匿名玩家', channel]
    );
    p = rows[0];
  } else {
    const newName = name || p.display_name;
    await query(
      'UPDATE gdo_players SET last_active_at=NOW(), display_name=$1, source=COALESCE($2,source) WHERE id=$3',
      [newName, channel, p.id]
    );
    p.display_name = newName;
  }
  /* 尚未采集地理位置时，用本次加入的 IP 异步补齐一次 */
  if (meta.ip && !p.country) updatePlayerGeo(p.id, meta.ip);
  return p;
}

/* ── 房间：建新房 ── */
async function createRoom(mode, type) {
  let code, tries = 0;
  while (tries++ < 20) {
    code = genCode();
    const dup = await queryOne('SELECT id FROM gdo_rooms WHERE room_code=$1', [code]);
    if (!dup) break;
  }
  const rows = await query(
    'INSERT INTO gdo_rooms(room_code,game_mode,room_type) VALUES($1,$2,$3) RETURNING *',
    [code, mode, type || 'random']
  );
  return rows[0];
}

/* ── 队列：取消旧条目，加入新条目 ── */
async function joinQueue(playerId, token, mode, socketId) {
  await query(
    `UPDATE gdo_queue SET status='cancelled' WHERE player_id=$1 AND status='waiting'`,
    [playerId]
  );
  const rows = await query(
    `INSERT INTO gdo_queue(player_id,player_token,game_mode,socket_id)
     VALUES($1,$2,$3,$4) RETURNING *`,
    [playerId, token, mode, socketId]
  );
  return rows[0];
}

/* ── 队列：查找可配对的玩家，满足条件后返回数组 ── */
async function tryMatch(mode) {
  const need = mode === '6p' ? 6 : 4;
  const rows = await query(
    `SELECT * FROM gdo_queue WHERE game_mode=$1 AND status='waiting'
     ORDER BY queued_at LIMIT $2`,
    [mode, need]
  );
  return rows.length >= need ? rows : null;
}

/* ── 匹配成功：建房 + 分配座位 + 更新队列状态 ── */
async function createMatch(entries, mode) {
  const room = await createRoom(mode, 'random');
  for (let i = 0; i < entries.length; i++) {
    const seat = i + 1;
    const team = seat % 2 === 1 ? 1 : 2;
    await query(
      `INSERT INTO gdo_seats(room_id,player_id,seat,team,socket_id)
       VALUES($1,$2,$3,$4,$5)`,
      [room.id, entries[i].player_id, seat, team, entries[i].socket_id]
    );
    await query(
      `UPDATE gdo_queue SET status='matched',matched_at=NOW(),room_id=$1 WHERE id=$2`,
      [room.id, entries[i].id]
    );
  }
  return room;
}

/* ── 私人房间：按房间码加座 ── */
async function joinRoomByCode(roomCode, playerId, socketId) {
  const room = await queryOne('SELECT * FROM gdo_rooms WHERE room_code=$1', [roomCode]);
  if (!room) return { error: '房间不存在' };
  if (room.status === 'playing') return { error: '对局已开始' };
  if (room.status === 'finished') return { error: '房间已结束' };
  if (room.status === 'abandoned') return { error: '房间已关闭' };

  const maxSeat = room.game_mode === '6p' ? 6 : 4;
  const seats = await query('SELECT * FROM gdo_seats WHERE room_id=$1 ORDER BY seat', [room.id]);

  /* 已在房间 → 断线重连：更新 socket_id */
  const mine = seats.find(s => s.player_id === playerId);
  if (mine) {
    await query('UPDATE gdo_seats SET socket_id=$1,is_connected=TRUE WHERE id=$2', [socketId, mine.id]);
    return { room, seat: mine.seat, reconnect: true };
  }

  if (seats.length >= maxSeat) {
    /* 房间已满：只要存在「掉线(机器人托管)空座」，就允许新玩家局间接手（开放纳新）。
       接手座号+队伍不变，本局局分由新玩家继承、下一局照常发新牌；
       清掉本局进贡以免按旧玩家ID查手牌错乱。*/
    const offline = seats.filter(s => !s.is_connected);
    if (room.status === 'waiting' && offline.length > 0) {
      const takeover = offline.sort((a, b) => a.seat - b.seat)[0];
      await query(
        'UPDATE gdo_seats SET player_id=$1, socket_id=$2, is_connected=TRUE, is_ready=FALSE WHERE id=$3',
        [playerId, socketId, takeover.id]
      );
      await query('UPDATE gdo_rooms SET tribute_json=NULL WHERE id=$1', [room.id]);
      return { room, seat: takeover.seat, takeover: true };
    }
    return { error: '房间已满（' + maxSeat + '人）' };
  }

  /* 取最小空缺座位号（有人退出后座位可能不连续，需补空位而非追加）*/
  const used = new Set(seats.map(s => s.seat));
  let nextSeat = 1; while (used.has(nextSeat)) nextSeat++;
  const team = nextSeat % 2 === 1 ? 1 : 2;
  const rows = await query(
    `INSERT INTO gdo_seats(room_id,player_id,seat,team,socket_id)
     VALUES($1,$2,$3,$4,$5) RETURNING *`,
    [room.id, playerId, nextSeat, team, socketId]
  );
  return { room, seat: rows[0].seat };
}

/* ── 查询房间完整状态（含座位 + 玩家名字） ── */
async function getRoomState(roomCode) {
  const room = await queryOne('SELECT * FROM gdo_rooms WHERE room_code=$1', [roomCode]);
  if (!room) return null;
  const seats = await query(
    `SELECT s.*, p.display_name, p.player_token
     FROM gdo_seats s
     JOIN gdo_players p ON p.id = s.player_id
     WHERE s.room_id = $1 ORDER BY s.seat`,
    [room.id]
  );
  return { room, seats };
}

/* ── 找或建"永远有房间等候"的公开房间 ── */
async function findOrCreateOpenRoom(mode) {
  const maxSeats = mode === '6p' ? 6 : 4;
  const existing = await queryOne(`
    SELECT r.room_code FROM gdo_rooms r
    WHERE r.game_mode=$1 AND r.status='waiting' AND r.room_type='random'
      AND r.is_full=FALSE
      AND (SELECT COUNT(*) FROM gdo_seats s WHERE s.room_id=r.id) < $2
    ORDER BY r.created_at ASC
    LIMIT 1
  `, [mode, maxSeats]);
  if (existing) return existing.room_code;
  const room = await createRoom(mode, 'random');   // 无空位则立即新建
  return room.room_code;
}

/* ── 找一个"待救援"的随机赛事：满员、局间(waiting)、且至少 1 个座位掉线(机器人托管) ──
   随机参赛优先塞进这类房间接手托管空座，让快抛弃的赛事被救活。*/
async function findRevivalRoom(mode) {
  const maxSeats = mode === '6p' ? 6 : 4;
  const row = await queryOne(`
    SELECT r.room_code FROM gdo_rooms r
    WHERE r.game_mode=$1 AND r.status='waiting' AND r.room_type='random'
      AND (SELECT COUNT(*) FROM gdo_seats s WHERE s.room_id=r.id) = $2
      AND (SELECT COUNT(*) FROM gdo_seats s WHERE s.room_id=r.id AND s.is_connected=FALSE) > 0
    ORDER BY r.created_at ASC LIMIT 1
  `, [mode, maxSeats]);
  return row ? row.room_code : null;
}

module.exports = {
  getOrCreatePlayer,
  createRoom,
  findOrCreateOpenRoom,
  findRevivalRoom,
  joinQueue,
  tryMatch,
  createMatch,
  joinRoomByCode,
  getRoomState,
  levelName
};
