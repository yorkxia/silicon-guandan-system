/* ============================================================
 * 清除【四人 + 六人掼蛋对战数据】脚本（可反复使用）
 * 只清掼蛋对战相关表，绝不触碰：报名 tournaments/registrations/users、
 * 记分牌 sb_*、以及其它任何业务表。
 *
 * 用法（连接串从环境变量读，不写死密钥）：
 *   预览（只看行数，不删除）：
 *     DATABASE_URL="<外部连接串>" node scripts/gdo-clear.js
 *   确认清除（加 --yes 才真正删除）：
 *     DATABASE_URL="<外部连接串>" node scripts/gdo-clear.js --yes
 *
 * 在 Claude Code 里可用 ! 前缀直接跑，例如：
 *   ! DATABASE_URL="postgresql://.../silicon_guandan_db" node scripts/gdo-clear.js --yes
 * ============================================================ */
const { Pool } = require('pg');

/* 清除顺序无关：TRUNCATE 一次性处理（所有外键都在本列表内，无需 CASCADE）。
   gdo_players 为四人/六人共用的匿名玩家表，一并清空以彻底重置。
   如需保留玩家记录，把 'gdo_players' 从下面删掉即可。*/
const TABLES = [
  'gdo_seats', 'gdo_rounds', 'gdo_queue',
  'gdo6_seats', 'gdo6_rounds', 'gdo6_queue',
  'gdo_rooms', 'gdo6_rooms',
  'gdo_players'
];

const url = process.env.DATABASE_URL;
if (!url) { console.error('❌ 缺少 DATABASE_URL 环境变量'); process.exit(1); }
const confirm = process.argv.includes('--yes');

const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });

async function counts() {
  const out = {};
  for (const t of TABLES) {
    const r = await pool.query(`SELECT COUNT(*)::int AS c FROM "${t}"`);
    out[t] = r.rows[0].c;
  }
  return out;
}

(async () => {
  try {
    const before = await counts();
    const total  = Object.values(before).reduce((a, b) => a + b, 0);

    console.log('\n=== 掼蛋对战数据（清除前）===');
    for (const t of TABLES) console.log('  ' + t.padEnd(16) + before[t]);
    console.log('  合计：' + total + ' 行');

    if (!confirm) {
      console.log('\n⚠️  预览模式，未删除任何数据。');
      console.log('    确认清除请加 --yes：');
      console.log('    DATABASE_URL="..." node scripts/gdo-clear.js --yes\n');
      return;
    }
    if (total === 0) { console.log('\n✅ 已经是空的，无需清除。\n'); return; }

    console.log('\n🧹 正在清除四人 + 六人掼蛋对战数据…');
    await pool.query(`TRUNCATE ${TABLES.map(t => `"${t}"`).join(', ')} RESTART IDENTITY`);

    const after = await counts();
    const total2 = Object.values(after).reduce((a, b) => a + b, 0);
    console.log('✅ 完成。清除后合计：' + total2 + ' 行。');
    console.log('   （报名/用户 tournaments·registrations·users、记分牌 sb_* 等业务表未受影响）\n');
  } catch (e) {
    console.error('❌ 失败：', e.message);
    process.exit(2);
  } finally {
    await pool.end();
  }
})();
