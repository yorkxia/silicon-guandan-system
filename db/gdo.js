/* 网上掼蛋对战 · 数据库辅助层 */
const { query, queryOne } = require('./init');

const LEVEL_NAME = { 2:'2',3:'3',4:'4',5:'5',6:'6',7:'7',8:'8',9:'9',10:'10',11:'J',12:'Q',13:'K',14:'A' };
function levelName(n) { return LEVEL_NAME[n] || String(n); }

/* ── 生成房间短码 ── */
function genCode() {
  const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const r = () => L[Math.floor(Math.random() * L.length)];
  const n = () => Math.floor(Math.random() * 10);
  return `${r()}${r()}${n()}${n()}${n()}${n()}`;
}

/* ── 玩家：首次访问自动建档，之后更新名称 ── */
async function getOrCreatePlayer(token, name) {
  let p = await queryOne('SELECT * FROM gdo_players WHERE player_token=$1', [token]);
  if (!p) {
    const rows = await query(
      'INSERT INTO gdo_players(player_token,display_name) VALUES($1,$2) RETURNING *',
      [token, name || '匿名玩家']
    );
    p = rows[0];
  } else {
    const newName = name || p.display_name;
    await query(
      'UPDATE gdo_players SET last_active_at=NOW(), display_name=$1 WHERE id=$2',
      [newName, p.id]
    );
    p.display_name = newName;
  }
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

  const maxSeat = room.game_mode === '6p' ? 6 : 4;
  const seats = await query('SELECT * FROM gdo_seats WHERE room_id=$1 ORDER BY seat', [room.id]);

  /* 已在房间 → 断线重连：更新 socket_id */
  const mine = seats.find(s => s.player_id === playerId);
  if (mine) {
    await query('UPDATE gdo_seats SET socket_id=$1,is_connected=TRUE WHERE id=$2', [socketId, mine.id]);
    return { room, seat: mine.seat, reconnect: true };
  }

  if (seats.length >= maxSeat) return { error: '房间已满（' + maxSeat + '人）' };

  const nextSeat = seats.length + 1;
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
      AND (SELECT COUNT(*) FROM gdo_seats s WHERE s.room_id=r.id) < $2
    ORDER BY r.created_at ASC
    LIMIT 1
  `, [mode, maxSeats]);
  if (existing) return existing.room_code;
  const room = await createRoom(mode, 'random');
  return room.room_code;
}

module.exports = {
  getOrCreatePlayer,
  createRoom,
  findOrCreateOpenRoom,
  joinQueue,
  tryMatch,
  createMatch,
  joinRoomByCode,
  getRoomState,
  levelName
};
