/* 房间守护巡检：房间开房满 12 小时后，若「过半玩家离线」→ 120 秒倒计时警告 → 关闭
   四人(默认命名空间 io / gdo_ 表) + 六人(/g6 命名空间 io6 / gdo6_ 表)，随机/私人房都算。
   120 秒内有人回到在线(掉线数不再过半)则取消关闭。*/
const { query } = require('../db/init');

const CHECK_MS = 60 * 1000;             // 每分钟巡检一次
const GRACE_S  = 120;                   // 关闭前倒计时秒数
const AFK_MSG  = '目前赛事房间已经超过一半用户不在线，房间就在120秒后关闭';
const closing  = new Set();             // 正在倒计时的房间（prefix:roomCode），避免重复触发

function startRoomMonitor(io, io6) {
  setInterval(function() {
    sweep(io,  'g4', 'gdo_rooms',  'gdo_seats').catch(e => console.error('[房间守护·4]', e.message));
    sweep(io6, 'g6', 'gdo6_rooms', 'gdo6_seats').catch(e => console.error('[房间守护·6]', e.message));
  }, CHECK_MS);
  console.log('[房间守护] 已启动：每分钟巡检，满12h且过半掉线→120s→关闭');
}

/* 扫一个命名空间下满 12h 的活跃房间 */
async function sweep(ioNs, prefix, roomsTbl, seatsTbl) {
  const rooms = await query(
    `SELECT r.id, r.room_code,
            (SELECT COUNT(*) FROM ${seatsTbl} s WHERE s.room_id=r.id) AS total,
            (SELECT COUNT(*) FROM ${seatsTbl} s WHERE s.room_id=r.id AND s.is_connected=FALSE) AS offline
       FROM ${roomsTbl} r
      WHERE r.status IN ('waiting','playing')
        AND r.created_at < NOW() - INTERVAL '12 hours'`
  );
  for (const r of rooms) {
    const total   = parseInt(r.total, 10);
    const offline = parseInt(r.offline, 10);
    const key     = prefix + ':' + r.room_code;
    if (total > 0 && offline * 2 > total) {          // 过半掉线
      if (!closing.has(key)) {
        closing.add(key);
        ioNs.to(r.room_code).emit('room:closing', { seconds: GRACE_S, message: AFK_MSG });
        setTimeout(function() {
          finalizeClose(ioNs, roomsTbl, seatsTbl, r.id, r.room_code, key)
            .catch(e => console.error('[房间守护·关闭]', e.message));
        }, GRACE_S * 1000);
      }
    }
  }
}

/* 120 秒后复检：仍活跃且仍过半掉线才真正关闭；否则取消 */
async function finalizeClose(ioNs, roomsTbl, seatsTbl, roomId, roomCode, key) {
  closing.delete(key);
  const rows = await query(
    `SELECT (SELECT status FROM ${roomsTbl} WHERE id=$1) AS status,
            (SELECT COUNT(*) FROM ${seatsTbl} s WHERE s.room_id=$1) AS total,
            (SELECT COUNT(*) FROM ${seatsTbl} s WHERE s.room_id=$1 AND s.is_connected=FALSE) AS offline`,
    [roomId]
  );
  const row = rows[0];
  if (!row) return;
  const total   = parseInt(row.total, 10);
  const offline = parseInt(row.offline, 10);
  const active  = row.status === 'waiting' || row.status === 'playing';
  if (active && total > 0 && offline * 2 > total) {
    await query(`UPDATE ${roomsTbl} SET status='abandoned', is_full=FALSE WHERE id=$1`, [roomId]);
    ioNs.to(roomCode).emit('room:closed', {});
    console.log(`[房间守护] 🚪 满12h且过半掉线，关闭 · ${roomCode}`);
  } else {
    ioNs.to(roomCode).emit('room:closing_cancel', {});   // 有人回来了 → 解除警告
  }
}

module.exports = { startRoomMonitor };
