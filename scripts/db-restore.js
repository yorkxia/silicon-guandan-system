/* ============================================================
 * 数据库恢复脚本：把「网上掼蛋赛事控制台」导出的 JSON 全库备份回灌到数据库。
 * 连接串从环境变量 DATABASE_URL 读取，绝不写死密钥。
 *
 * 用法：
 *   预览（只对比备份 vs 现库行数，不写入）：
 *     DATABASE_URL="..." node scripts/db-restore.js --file=backups/gdb_backup_xxx.json
 *
 *   补充恢复（默认，安全）：逐表 INSERT ... ON CONFLICT DO NOTHING，
 *   只补库里缺失的行，绝不覆盖或删除现有数据：
 *     DATABASE_URL="..." node scripts/db-restore.js --file=xxx.json --confirm
 *
 *   整库替换恢复（危险！先清空所有表再灌入备份，用于灾后重建到空库）：
 *     DATABASE_URL="..." node scripts/db-restore.js --file=xxx.json --replace --confirm
 *
 *  说明：
 *   - 按外键依赖顺序插入；恢复后自动 setval 重置自增序列，避免新数据 id 冲突。
 *   - 加密字段(registrations 等)原样回灌，能否解密取决于 ENCRYPTION_KEY 是否与备份时一致。
 *   - 整个恢复在单事务内，失败自动回滚。
 * ============================================================ */
const { Pool } = require('pg');
const fs = require('fs');

const url = process.env.DATABASE_URL;
if (!url) { console.error('❌ 缺少 DATABASE_URL 环境变量'); process.exit(1); }

const argv = process.argv.slice(2).join(' ');
const fileMatch = argv.match(/--file=(\S+)/);
const doConfirm = /--confirm/.test(argv);
const doReplace = /--replace/.test(argv);
if (!fileMatch) { console.error('❌ 请用 --file=<备份.json> 指定备份文件'); process.exit(1); }

const filePath = fileMatch[1];
if (!fs.existsSync(filePath)) { console.error('❌ 找不到备份文件：' + filePath); process.exit(1); }

let backup;
try { backup = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
catch (e) { console.error('❌ 备份文件不是合法 JSON：' + e.message); process.exit(1); }
const tablesData = backup && backup.data;
if (!tablesData || typeof tablesData !== 'object') { console.error('❌ 备份缺少 data 字段（不是本控制台导出的格式）'); process.exit(1); }

// 外键依赖顺序：父表在前，子表在后（备份里有但这里没列出的表追加到末尾）
const ORDER = [
  'users', 'ot_staff', 'tournaments', 'page_content',
  'sb_users', 'sb_regions', 'sb_ads',
  'sb_intel_config', 'sb_intel_news', 'sb_intel_flights', 'sb_intel_stocks',
  'sb_visits', 'sb_user_regions',
  'gd_users', 'gd_payments', 'gd_activations',
  'gdo_players',
  'gdo_rooms', 'gdo_seats', 'gdo_rounds', 'gdo_queue',
  'gdo6_rooms', 'gdo6_seats', 'gdo6_rounds', 'gdo6_queue',
  'gdo_visits'
];
function orderedTables() {
  const present = Object.keys(tablesData);
  const head = ORDER.filter(t => present.includes(t));
  const rest = present.filter(t => !ORDER.includes(t));
  return head.concat(rest);
}

const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });

// 值按列类型转换：jsonb/json → 字符串；其余(含 pg 数组、时间戳字符串)交给驱动
function convert(val, udt) {
  if (val === null || val === undefined) return null;
  if (udt === 'jsonb' || udt === 'json') return typeof val === 'string' ? val : JSON.stringify(val);
  return val;
}

(async () => {
  try {
    // 拉取每张表的列类型
    const colRows = await pool.query(
      `SELECT table_name, column_name, udt_name FROM information_schema.columns WHERE table_schema='public'`);
    const typeMap = {};
    for (const r of colRows.rows) {
      (typeMap[r.table_name] = typeMap[r.table_name] || {})[r.column_name] = r.udt_name;
    }

    const tables = orderedTables();

    // 预览对比
    console.log('\n=== 备份 vs 现库 行数对比 ===');
    console.log('表名'.padEnd(24) + '备份'.padStart(10) + '现库'.padStart(10));
    console.log('-'.repeat(44));
    let totalBackup = 0;
    for (const t of tables) {
      const nBackup = Array.isArray(tablesData[t]) ? tablesData[t].length : 0;
      totalBackup += nBackup;
      let nDb = '—';
      if (typeMap[t]) { const r = await pool.query(`SELECT COUNT(*)::int c FROM "${t}"`); nDb = r.rows[0].c; }
      console.log(t.padEnd(24) + String(nBackup).padStart(10) + String(nDb).padStart(10));
    }
    console.log('-'.repeat(44));
    console.log('备份总行数：' + totalBackup + (backup.meta ? '（生成于 ' + backup.meta.generated_at + '）' : ''));

    if (!doConfirm) {
      console.log('\n⚠️  预览模式，未写入任何数据。');
      console.log('    补充恢复(只补不覆盖)： --confirm');
      console.log('    整库替换(先清空,危险)： --replace --confirm\n');
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      if (doReplace) {
        // 整库替换：先清空所有目标表（CASCADE 处理外键），再全量灌入
        const existing = tables.filter(t => typeMap[t]);
        console.log('\n🧨 --replace：清空 ' + existing.length + ' 张表后重建…');
        await client.query(`TRUNCATE ${existing.map(t => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
      } else {
        console.log('\n➕ 补充恢复：逐表 INSERT ... ON CONFLICT DO NOTHING（不覆盖现有数据）…');
      }

      let inserted = 0;
      for (const t of tables) {
        if (!typeMap[t]) { console.log('  跳过（库中无此表）：' + t); continue; }
        const rows = tablesData[t] || [];
        let cnt = 0;
        for (const row of rows) {
          const cols = Object.keys(row).filter(c => typeMap[t][c]); // 只灌库里存在的列
          if (!cols.length) continue;
          const vals = cols.map(c => convert(row[c], typeMap[t][c]));
          const ph = cols.map((_, i) => '$' + (i + 1)).join(',');
          const sql = `INSERT INTO "${t}" (${cols.map(c => `"${c}"`).join(',')}) VALUES (${ph}) ON CONFLICT DO NOTHING`;
          const r = await client.query(sql, vals);
          cnt += r.rowCount || 0;
        }
        inserted += cnt;
        if (rows.length) console.log('  ' + t.padEnd(24) + '灌入 ' + cnt + ' / ' + rows.length + ' 行');
      }

      // 重置自增序列，避免后续新数据 id 冲突
      for (const t of tables) {
        if (!typeMap[t] || !typeMap[t].id) continue;
        await client.query(
          `SELECT setval(pg_get_serial_sequence($1,'id'), COALESCE((SELECT MAX(id) FROM "${t}"),1))`, [t]
        ).catch(() => {});   // 无序列的表忽略
      }

      await client.query('COMMIT');
      console.log('\n✅ 恢复完成，共写入 ' + inserted + ' 行；自增序列已重置。\n');
    } catch (e) {
      await client.query('ROLLBACK');
      throw new Error('恢复失败，已回滚：' + e.message);
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('❌ ' + e.message);
    process.exit(2);
  } finally {
    await pool.end();
  }
})();
