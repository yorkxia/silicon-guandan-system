/* ============================================================
 * 只清除【压测机器人 LT- 前缀】产生的数据，不动任何真实玩家/房间。
 * 与 gdo-clear.js（清空全部对战数据，不分真假玩家）不同——这个脚本按
 * player_token LIKE 'LT-%' 过滤，且只删"全员都是机器人"的房间，
 * 真实玩家哪怕曾经和机器人同房（理论上不会发生，机器人只开随机码私人房）
 * 也会被保护，不会被误删。
 *
 * 用法（连接串从环境变量读，不写死密钥）：
 *   预览（只看会删多少，不删除）：
 *     DATABASE_URL="<外部连接串>" node scripts/gdo-clear-bots.js
 *   确认清除（加 --yes 才真正删除）：
 *     DATABASE_URL="<外部连接串>" node scripts/gdo-clear-bots.js --yes
 * ============================================================ */
const { Pool } = require('pg');

const url = process.env.DATABASE_URL;
if (!url) { console.error('❌ 缺少 DATABASE_URL 环境变量'); process.exit(1); }
const confirm = process.argv.includes('--yes');

const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });

/* 找出"全员都是机器人"的房间号（4人/6人各一次），混了真实玩家的房间不在此列 */
async function botOnlyRoomIds(roomsTable, seatsTable) {
  const r = await pool.query(`
    SELECT s.room_id FROM ${seatsTable} s
    JOIN gdo_players p ON p.id = s.player_id
    GROUP BY s.room_id
    HAVING BOOL_AND(p.player_token LIKE 'LT-%')
  `);
  return r.rows.map(row => row.room_id);
}

async function run() {
  const botPlayers = await pool.query(`SELECT id FROM gdo_players WHERE player_token LIKE 'LT-%'`);
  const botPlayerCount = botPlayers.rowCount;

  const rooms4 = await botOnlyRoomIds('gdo_rooms', 'gdo_seats');
  const rooms6 = await botOnlyRoomIds('gdo6_rooms', 'gdo6_seats');

  console.log('\n=== 机器人测试数据（清除前）===');
  console.log('  机器人玩家(gdo_players, token以LT-开头)：' + botPlayerCount);
  console.log('  纯机器人四人房间(gdo_rooms)：' + rooms4.length);
  console.log('  纯机器人六人房间(gdo6_rooms)：' + rooms6.length);

  if (!confirm) {
    console.log('\n⚠️  预览模式，未删除任何数据。确认清除请加 --yes\n');
    return;
  }
  if (botPlayerCount === 0 && rooms4.length === 0 && rooms6.length === 0) {
    console.log('\n✅ 没有机器人测试数据，无需清除。\n'); return;
  }

  console.log('\n🧹 正在清除机器人测试数据…');
  await pool.query(`DELETE FROM gdo_queue WHERE player_id IN (SELECT id FROM gdo_players WHERE player_token LIKE 'LT-%')`);
  await pool.query(`DELETE FROM gdo6_queue WHERE player_id IN (SELECT id FROM gdo_players WHERE player_token LIKE 'LT-%')`);
  if (rooms4.length) await pool.query(`DELETE FROM gdo_rooms WHERE id = ANY($1::int[])`, [rooms4]);   // cascades to gdo_seats/gdo_rounds
  if (rooms6.length) await pool.query(`DELETE FROM gdo6_rooms WHERE id = ANY($1::int[])`, [rooms6]);  // cascades to gdo6_seats/gdo6_rounds
  const del = await pool.query(`
    DELETE FROM gdo_players
    WHERE player_token LIKE 'LT-%'
      AND id NOT IN (SELECT player_id FROM gdo_seats)
      AND id NOT IN (SELECT player_id FROM gdo6_seats)
  `);

  console.log('✅ 完成。删除机器人玩家 ' + del.rowCount + ' 个、纯机器人房间 ' + (rooms4.length + rooms6.length) + ' 个。');
  console.log('   （真实玩家、真实房间、报名/用户/记分牌等业务表未受影响）\n');
}

run().catch(e => { console.error('❌ 失败：', e.message); process.exit(2); }).finally(() => pool.end());
