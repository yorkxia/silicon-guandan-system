/* 逐表统计行数 —— 用法：DATABASE_URL="..." node scripts/dbcount.js
   只读操作，仅 SELECT COUNT(*)；不打印连接串。*/
const { Pool } = require('pg');

const url = process.env.DATABASE_URL;
if (!url) { console.error('缺少 DATABASE_URL 环境变量'); process.exit(1); }

const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });

(async () => {
  try {
    const tbls = await pool.query(`
      SELECT tablename FROM pg_tables
      WHERE schemaname='public' ORDER BY tablename`);
    let total = 0;
    const rows = [];
    for (const { tablename } of tbls.rows) {
      const r = await pool.query(`SELECT COUNT(*)::int AS c FROM "${tablename}"`);
      rows.push([tablename, r.rows[0].c]);
      total += r.rows[0].c;
    }
    rows.sort((a, b) => b[1] - a[1]);
    console.log('\n表名'.padEnd(30) + '行数');
    console.log('-'.repeat(40));
    for (const [t, c] of rows) console.log(t.padEnd(30) + c);
    console.log('-'.repeat(40));
    console.log('合计表数: ' + rows.length + ' ，总行数: ' + total);
  } catch (e) {
    console.error('查询失败:', e.message);
    process.exit(2);
  } finally {
    await pool.end();
  }
})();
