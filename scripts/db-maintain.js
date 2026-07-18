/* ============================================================
 * 数据库维护脚本：全库备份 + 安全清理（保留最近 N 个月）
 * 连接串从环境变量 DATABASE_URL 读取，绝不写死密钥。
 *
 * 用法：
 *   全库备份（pg_dump 自定义压缩格式 → backups/）：
 *     DATABASE_URL="<外部连接串>" node scripts/db-maintain.js backup
 *
 *   清理预览（只统计将删除的行数，不删除；N=保留月数）：
 *     DATABASE_URL="..." node scripts/db-maintain.js cleanup --dry-run=3
 *
 *   确认清理（会先自动备份，再删除 N 个月之前的绿灯数据）：
 *     DATABASE_URL="..." node scripts/db-maintain.js cleanup --confirm=3
 *     （--confirm=1 保留最近 1 个月，=2 保留 2 个月，以此类推）
 *     若本机没有 pg_dump 又想强行清理，可加 --skip-backup（不推荐）
 *
 *  ⚠️ 只会清理「绿灯表」：对局过程/日志/瞬态队列。
 *     红线表（gdo_players 积分、registrations 报名、gd_users/gd_payments/
 *     gd_activations、tournaments、users/ot_staff/sb_users、各类配置）
 *     不出现在任何 DELETE 语句中，脚本层面无法误删。
 * ============================================================ */
const { Pool } = require('pg');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const url = process.env.DATABASE_URL;
if (!url) { console.error('❌ 缺少 DATABASE_URL 环境变量'); process.exit(1); }

const mode = process.argv[2];                                   // backup | cleanup
const arg = process.argv.slice(3).join(' ');
const skipBackup = /--skip-backup/.test(arg);
function readMonths(flag) {                                      // 从 --confirm=N / --dry-run=N 取月数
  const m = arg.match(new RegExp(flag + '=(\\d+)'));
  return m ? parseInt(m[1], 10) : null;
}

const BACKUP_DIR = path.join(__dirname, '..', 'backups');

function stamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/* ── 全库备份（pg_dump 自定义格式，自带压缩） ── */
function doBackup() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const file = path.join(BACKUP_DIR, `gdb_backup_${stamp()}.dump`);
  console.log('📦 正在备份全库 → ' + file);
  try {
    execFileSync('pg_dump', ['-Fc', '--no-owner', '--no-privileges', '-d', url, '-f', file],
      { stdio: ['ignore', 'inherit', 'inherit'], env: Object.assign({}, process.env, { PGSSLMODE: 'require' }) });
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error('找不到 pg_dump 命令，请先安装 PostgreSQL 客户端工具（版本需 ≥ 服务器）。');
    throw new Error('pg_dump 失败：' + e.message);
  }
  const sizeMB = (fs.statSync(file).size / 1024 / 1024).toFixed(2);
  console.log(`✅ 备份完成（${sizeMB} MB）：${file}`);
  console.log('   ⚠️ 提醒：registrations 报名信息是加密存储，请务必同时妥善保管 ENCRYPTION_KEY，否则备份数据无法解密。\n');
  return file;
}

/* ── 绿灯清理项：每项 = { 名称, 统计SQL, 删除步骤SQL[] }；$1 = 分界时间点 cutoff ── */
function greenlightPlan() {
  return [
    { name: '四人·已结束老房间(连带座位/轮次级联)',
      count: `SELECT COUNT(*)::int c FROM gdo_rooms WHERE status IN ('finished','abandoned') AND COALESCE(finished_at,created_at) < $1`,
      steps: [
        // 先删引用这些房间的匹配队列（gdo_queue.room_id 无级联，必须先删）
        `DELETE FROM gdo_queue WHERE room_id IN (SELECT id FROM gdo_rooms WHERE status IN ('finished','abandoned') AND COALESCE(finished_at,created_at) < $1)`,
        // 再删房间本身，gdo_seats / gdo_rounds 由 ON DELETE CASCADE 自动删除
        `DELETE FROM gdo_rooms WHERE status IN ('finished','abandoned') AND COALESCE(finished_at,created_at) < $1`
      ] },
    { name: '六人·已结束老房间(连带座位/轮次级联)',
      count: `SELECT COUNT(*)::int c FROM gdo6_rooms WHERE status IN ('finished','abandoned') AND COALESCE(finished_at,created_at) < $1`,
      steps: [
        `DELETE FROM gdo6_queue WHERE room_id IN (SELECT id FROM gdo6_rooms WHERE status IN ('finished','abandoned') AND COALESCE(finished_at,created_at) < $1)`,
        `DELETE FROM gdo6_rooms WHERE status IN ('finished','abandoned') AND COALESCE(finished_at,created_at) < $1`
      ] },
    { name: '四人·瞬态匹配队列(非等待中的旧记录)',
      count: `SELECT COUNT(*)::int c FROM gdo_queue WHERE status IN ('matched','cancelled','timeout') AND queued_at < $1`,
      steps: [ `DELETE FROM gdo_queue WHERE status IN ('matched','cancelled','timeout') AND queued_at < $1` ] },
    { name: '六人·瞬态匹配队列(非等待中的旧记录)',
      count: `SELECT COUNT(*)::int c FROM gdo6_queue WHERE status IN ('matched','cancelled','timeout') AND queued_at < $1`,
      steps: [ `DELETE FROM gdo6_queue WHERE status IN ('matched','cancelled','timeout') AND queued_at < $1` ] },
    { name: 'play页访问埋点日志 gdo_visits',
      count: `SELECT COUNT(*)::int c FROM gdo_visits WHERE visited_at < $1`,
      steps: [ `DELETE FROM gdo_visits WHERE visited_at < $1` ] },
    { name: '流量访问日志 sb_visits',
      count: `SELECT COUNT(*)::int c FROM sb_visits WHERE visited_at < $1`,
      steps: [ `DELETE FROM sb_visits WHERE visited_at < $1` ] },
  ];
}

async function runCleanup(pool, months, dryRun) {
  // cutoff = 现在 - N 个月；早于它的绿灯数据会被清理
  const cut = await pool.query(`SELECT (now() - make_interval(months => $1)) AS cutoff`, [months]);
  const cutoff = cut.rows[0].cutoff;
  console.log(`\n🗓️  保留最近 ${months} 个月；将清理 ${new Date(cutoff).toLocaleString('zh-CN')} 之前的绿灯数据。`);

  const plan = greenlightPlan();

  // 先统计（dry-run 与 confirm 都先看一遍）
  console.log('\n=== 预计清理行数 ===');
  let grand = 0;
  for (const item of plan) {
    const r = await pool.query(item.count, [cutoff]);
    item._n = r.rows[0].c;
    grand += item._n;
    console.log('  ' + String(item._n).padStart(8) + '  ' + item.name);
  }
  console.log('  ' + String(grand).padStart(8) + '  合计');

  if (dryRun) {
    console.log('\n⚠️  预览模式(--dry-run)，未删除任何数据。');
    console.log('    确认清理请改用：--confirm=' + months + '\n');
    return;
  }
  if (grand === 0) { console.log('\n✅ 没有符合条件的旧数据，无需清理。\n'); return; }

  // 事务内执行（任一步失败则整体回滚，保证完整性）
  console.log('\n🧹 正在清理（单事务，失败自动回滚）…');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const item of plan) {
      for (const sql of item.steps) {
        const r = await client.query(sql, [cutoff]);
        if (r.rowCount) console.log(`   - ${item.name}：删除 ${r.rowCount} 行`);
      }
    }
    await client.query('COMMIT');
    console.log('\n✅ 清理完成。红线表（积分/报名/付款/授权/账号/配置）未受影响。\n');
  } catch (e) {
    await client.query('ROLLBACK');
    throw new Error('清理失败，已回滚：' + e.message);
  } finally {
    client.release();
  }
}

(async () => {
  if (mode === 'backup') {
    try { doBackup(); } catch (e) { console.error('❌ ' + e.message); process.exit(2); }
    return;
  }

  if (mode === 'cleanup') {
    const dryN = readMonths('--dry-run');
    const confN = readMonths('--confirm');
    const months = dryN != null ? dryN : confN;
    const dryRun = dryN != null;
    if (months == null || months < 1) {
      console.error('❌ 请指定保留月数，例如：cleanup --dry-run=3 或 cleanup --confirm=3');
      process.exit(1);
    }

    // confirm 模式：先自动备份（除非显式 --skip-backup）
    if (!dryRun && !skipBackup) {
      try { doBackup(); }
      catch (e) {
        console.error('❌ 清理前备份失败：' + e.message);
        console.error('   已中止清理。修复 pg_dump 后重试，或明知风险时加 --skip-backup 强行清理。\n');
        process.exit(2);
      }
    }
    if (!dryRun && skipBackup) console.warn('⚠️  已跳过清理前备份（--skip-backup）。\n');

    const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
    try { await runCleanup(pool, months, dryRun); }
    catch (e) { console.error('❌ ' + e.message); process.exit(2); }
    finally { await pool.end(); }
    return;
  }

  console.error('用法：\n  node scripts/db-maintain.js backup\n  node scripts/db-maintain.js cleanup --dry-run=3\n  node scripts/db-maintain.js cleanup --confirm=3   (N=保留月数)');
  process.exit(1);
})();
