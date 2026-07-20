/* 六人掼蛋 · 独立数据库辅助层（gdo6_* 表；玩家表 gdo_players 与四人共用）
   fork 自 db/gdo.js，去掉 game_mode（本模块只服务六人，固定6座）*/
const { query, queryOne } = require('./init');
const { getOrCreatePlayer, levelName } = require('./gdo');   // 玩家/工具共用

const MAX_SEAT = 6;

/* ── 生成房间短码（在 gdo6_rooms 内唯一）── */
function genCode() {
  const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const r = () => L[Math.floor(Math.random() * L.length)];
  const n = () => Math.floor(Math.random() * 10);
  return `${r()}${r()}${n()}${n()}${n()}${n()}`;
}

/* ── 房间：建新房 ── */
async function createRoom(type) {
  let code, tries = 0;
  while (tries++ < 20) {
    code = genCode();
    const dup = await queryOne('SELECT id FROM gdo6_rooms WHERE room_code=$1', [code]);
    if (!dup) break;
  }
  const rows = await query(
    'INSERT INTO gdo6_rooms(room_code,room_type) VALUES($1,$2) RETURNING *',
    [code, type || 'random']
  );
  return rows[0];
}

/* ── 按房间码加座（含断线重连）── */
async function joinRoomByCode(roomCode, playerId, socketId) {
  const room = await queryOne('SELECT * FROM gdo6_rooms WHERE room_code=$1', [roomCode]);
  if (!room) return { error: '房间不存在' };
  if (room.status === 'playing') return { error: '对局已开始' };
  if (room.status === 'finished') return { error: '房间已结束' };
  if (room.status === 'abandoned') return { error: '房间已关闭' };

  const seats = await query('SELECT * FROM gdo6_seats WHERE room_id=$1 ORDER BY seat', [room.id]);

  const mine = seats.find(s => s.player_id === playerId);
  if (mine) {
    await query('UPDATE gdo6_seats SET socket_id=$1,is_connected=TRUE WHERE id=$2', [socketId, mine.id]);
    return { room, seat: mine.seat, reconnect: true };
  }

  if (seats.length >= MAX_SEAT) {
    /* 房间已满：只要存在「掉线(机器人托管)空座」，就允许新玩家局间接手（开放纳新）。
       接手座号+队伍不变，本局局分由新玩家继承、下一局照常发新牌；
       清掉本局进贡以免按旧玩家ID查手牌错乱。*/
    const offline = seats.filter(s => !s.is_connected);
    if (room.status === 'waiting' && offline.length > 0) {
      const takeover = offline.sort((a, b) => a.seat - b.seat)[0];
      await query(
        'UPDATE gdo6_seats SET player_id=$1, socket_id=$2, is_connected=TRUE, is_ready=FALSE WHERE id=$3',
        [playerId, socketId, takeover.id]
      );
      await query('UPDATE gdo6_rooms SET tribute_json=NULL WHERE id=$1', [room.id]);
      return { room, seat: takeover.seat, takeover: true };
    }
    return { error: '房间已满（6人）' };
  }

  /* 取最小空缺座位号（有人退出后座位可能不连续，需补空位而非追加）*/
  const used = new Set(seats.map(s => s.seat));
  let nextSeat = 1; while (used.has(nextSeat)) nextSeat++;
  const team = nextSeat % 2 === 1 ? 1 : 2;
  const rows = await query(
    `INSERT INTO gdo6_seats(room_id,player_id,seat,team,socket_id)
     VALUES($1,$2,$3,$4,$5) RETURNING *`,
    [room.id, playerId, nextSeat, team, socketId]
  );
  return { room, seat: rows[0].seat };
}

/* ── 查询房间完整状态（含座位 + 玩家名字）── */
async function getRoomState(roomCode) {
  const room = await queryOne('SELECT * FROM gdo6_rooms WHERE room_code=$1', [roomCode]);
  if (!room) return null;
  const seats = await query(
    `SELECT s.*, p.display_name, p.player_token
     FROM gdo6_seats s
     JOIN gdo_players p ON p.id = s.player_id
     WHERE s.room_id = $1 ORDER BY s.seat`,
    [room.id]
  );
  return { room, seats };
}

/* ── 找或建"永远有房间等候"的公开房间（六人）── */
async function findOrCreateOpenRoom() {
  const existing = await queryOne(`
    SELECT r.room_code FROM gdo6_rooms r
    WHERE r.status='waiting' AND r.room_type='random'
      AND r.is_full=FALSE
      AND (SELECT COUNT(*) FROM gdo6_seats s WHERE s.room_id=r.id) < ${MAX_SEAT}
    ORDER BY r.created_at ASC
    LIMIT 1
  `);
  if (existing) return existing.room_code;
  const room = await createRoom('random');
  return room.room_code;
}

/* ── 找一个"待救援"的随机赛事：满员(6)、局间(waiting)、且至少 1 个座位掉线(机器人托管) ── */
async function findRevivalRoom() {
  const row = await queryOne(`
    SELECT r.room_code FROM gdo6_rooms r
    WHERE r.status='waiting' AND r.room_type='random'
      AND (SELECT COUNT(*) FROM gdo6_seats s WHERE s.room_id=r.id) = ${MAX_SEAT}
      AND (SELECT COUNT(*) FROM gdo6_seats s WHERE s.room_id=r.id AND s.is_connected=FALSE) > 0
    ORDER BY r.created_at ASC LIMIT 1
  `);
  return row ? row.room_code : null;
}

module.exports = {
  getOrCreatePlayer,     // 复用四人的玩家层（共用 gdo_players）
  levelName,
  createRoom,
  joinRoomByCode,
  getRoomState,
  findOrCreateOpenRoom,
  findRevivalRoom,
  MAX_SEAT
};
