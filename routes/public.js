const express = require('express');
const router = express.Router();
const { query, queryOne } = require('../db/init');
const { encrypt, decrypt } = require('../utils/crypto');
const { geoLocate } = require('../utils/geo');

async function getContent(page) {
  const rows = await query('SELECT key_name, value_zh, value_en FROM page_content WHERE page = $1', [page]);
  const c = {};
  rows.forEach(r => { c[r.key_name] = { zh: r.value_zh, en: r.value_en }; });
  return c;
}

// 计算一个姓名字符串中包含的人数
// 规则：按中文逗号、英文逗号、顿号、分号分割，每段至少2个字符视为1人
function countNamesInStr(str) {
  if (!str || !str.trim()) return 0;
  return str.split(/[，,、；;]+/)
    .map(s => s.trim())
    .filter(s => s.length >= 2)
    .length;
}

// 计算一个赛事当前实际参赛人数（报名人 + 队友）
async function calcPersonCount(tournamentId) {
  const rows = await query(
    'SELECT name_enc, partner_name_enc FROM registrations WHERE tournament_id = $1',
    [tournamentId]
  );
  let total = 0;
  for (const r of rows) {
    total += 1; // 报名者本人
    if (r.partner_name_enc) {
      try {
        const partnerStr = decrypt(r.partner_name_enc);
        total += countNamesInStr(partnerStr);
      } catch { /* ignore decrypt errors */ }
    }
  }
  return total;
}

// 计算备选人数（填了备选队友姓名的报名数）
async function calcBackupCount(tournamentId) {
  const r = await queryOne(
    'SELECT COUNT(*) as c FROM registrations WHERE tournament_id = $1 AND backup_partner_name_enc IS NOT NULL',
    [tournamentId]
  );
  return parseInt(r.c);
}

// Home page
router.get('/', async (req, res) => {
  try {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip;
    const geo = await geoLocate(ip);
    const now = new Date();
    const [tournaments, content, ads] = await Promise.all([
      query(`
        SELECT t.*, (SELECT COUNT(*) FROM registrations r WHERE r.tournament_id = t.id) as reg_count
        FROM tournaments t WHERE t.status = 'active' ORDER BY t.created_at DESC
      `),
      getContent('home'),
      query(`
        SELECT a.* FROM sb_ads a
        LEFT JOIN sb_regions r ON r.id = a.region_id
        WHERE a.is_active = 1
          AND (a.start_time IS NULL OR a.start_time <= $1)
          AND (a.end_time   IS NULL OR a.end_time   >= $1)
          AND (a.region_id IS NULL OR r.area_code = 'GLOBAL' OR r.area_code = $2)
        ORDER BY
          CASE WHEN r.area_code = $2 THEN 0 ELSE 1 END,
          CASE WHEN a.frequency_minutes IS NOT NULL THEN 0 ELSE 1 END,
          a.frequency_minutes ASC NULLS LAST,
          a.created_at DESC
      `, [now, geo.region_code]).catch(() => [])
    ]);
    res.render('index', { tournaments, content, ads });
  } catch (e) {
    console.error(e);
    res.status(500).send('Server Error');
  }
});

// Team name uniqueness check API (for real-time frontend validation)
router.get('/api/check-team-name', async (req, res) => {
  try {
    const { tid, name } = req.query;
    if (!tid || !name || !name.trim()) return res.json({ taken: false });
    const rows = await query('SELECT team_name_enc FROM registrations WHERE tournament_id = $1 AND team_name_enc IS NOT NULL', [tid]);
    const normalized = name.trim().toLowerCase();
    const taken = rows.some(r => {
      try { return decrypt(r.team_name_enc).trim().toLowerCase() === normalized; } catch { return false; }
    });
    res.json({ taken });
  } catch (e) {
    console.error(e);
    res.json({ taken: false });
  }
});

// Tournament live stats API (for dynamic counter)
router.get('/api/tournament-stats/:id', async (req, res) => {
  try {
    const [person_count, backup_count] = await Promise.all([
      calcPersonCount(req.params.id),
      calcBackupCount(req.params.id),
    ]);
    res.json({ reg_count: person_count, backup_count });
  } catch (e) { res.json({ reg_count: 0, backup_count: 0 }); }
});

// Registration page
router.get('/register/:id', async (req, res) => {
  try {
    const tournament = await queryOne('SELECT * FROM tournaments WHERE id = $1 AND status = $2', [req.params.id, 'active']);
    if (!tournament) return res.redirect('/');
    const [content, person_count, backup_count] = await Promise.all([
      getContent('register'),
      calcPersonCount(tournament.id),
      calcBackupCount(tournament.id),
    ]);
    res.render('register', { tournament, content, reg_count: person_count, backup_count });
  } catch (e) {
    console.error(e);
    res.status(500).send('Server Error');
  }
});

// Registration submit
router.post('/register/:id', async (req, res) => {
  try {
    const tournament = await queryOne('SELECT * FROM tournaments WHERE id = $1 AND status = $2', [req.params.id, 'active']);
    if (!tournament) return res.redirect('/');

    const { name, phone, email, team_name, partner_name, backup_partner_name, random_partner } = req.body;
    if (!name || !phone || !email || !team_name || !team_name.trim()) {
      req.flash('error', '❌ 姓名、电话、邮箱、参赛队名均为必填项 | Name, phone, email, and team name are required.');
      return res.redirect(`/register/${req.params.id}`);
    }

    // 计算当前实际参赛人数，加上本次新增人数，超限则拒绝
    const currentPersons = await calcPersonCount(tournament.id);
    const newPersons = 1 + countNamesInStr(partner_name || '');
    if (currentPersons + newPersons > tournament.max_participants) {
      return res.redirect('/success?status=full');
    }

    // Check team name uniqueness
    if (team_name && team_name.trim()) {
      const existing = await query('SELECT team_name_enc FROM registrations WHERE tournament_id = $1 AND team_name_enc IS NOT NULL', [tournament.id]);
      const normalized = team_name.trim().toLowerCase();
      const taken = existing.some(r => {
        try { return decrypt(r.team_name_enc).trim().toLowerCase() === normalized; } catch { return false; }
      });
      if (taken) {
        req.flash('error', `❌ 队名"${team_name}"已被其他参赛者使用，请更换队名 | Team name "${team_name}" is already taken, please choose another.`);
        return res.redirect(`/register/${req.params.id}`);
      }
    }

    await query(
      `INSERT INTO registrations (tournament_id, name_enc, phone_enc, email_enc, team_name_enc, partner_name_enc, backup_partner_name_enc, random_partner)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        tournament.id,
        encrypt(name),
        encrypt(phone),
        email ? encrypt(email) : null,
        team_name ? encrypt(team_name) : null,
        partner_name ? encrypt(partner_name) : null,
        backup_partner_name ? encrypt(backup_partner_name) : null,
        random_partner ? 1 : 0
      ]
    );
    res.redirect(`/success?status=ok&tid=${req.params.id}`);
  } catch (e) {
    console.error(e);
    res.status(500).send('Server Error');
  }
});

router.get('/success', async (req, res) => {
  try {
    const tid = req.query.tid;
    let tournamentName = '';
    let venmo = '@yorkxia';
    let fee = 10;
    if (tid) {
      const t = await queryOne('SELECT * FROM tournaments WHERE id = $1', [tid]);
      if (t) {
        tournamentName = t.name;
        venmo = t.venmo || venmo;
        fee = t.fee || fee;
      }
    }
    res.render('success', { status: req.query.status, tournament: tournamentName, venmo, fee });
  } catch (e) {
    console.error(e);
    res.status(500).send('Server Error');
  }
});

// ── 掼蛋计分器 API ────────────────────────────────────

// CORS for API
router.use('/api/gd', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Register device + payment submission
router.post('/api/gd/register', async (req, res) => {
  try {
    const { name, contact, device_id, device_info, install_ts } = req.body;
    if (!name || !device_id) return res.json({ ok: false, error: 'missing fields' });

    // Upsert user by device_id
    const existing = await queryOne('SELECT id FROM gd_users WHERE device_id = $1', [device_id]);
    let userId;
    if (existing) {
      await query('UPDATE gd_users SET name=$1, contact=$2, device_info=$3, last_seen=NOW() WHERE id=$4',
        [name, contact || '', device_info || '', existing.id]);
      userId = existing.id;
    } else {
      const newUser = await queryOne(
        'INSERT INTO gd_users (name, contact, device_id, device_info, install_ts) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [name, contact || '', device_id, device_info || '', install_ts || 0]
      );
      userId = newUser.id;
    }

    // Create payment record
    const { amount, currency, payment_method } = req.body;
    const payment = await queryOne(
      'INSERT INTO gd_payments (user_id, amount, currency, payment_method, status) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [userId, amount || '', currency || 'CNY', payment_method || 'wechat', 'pending']
    );

    res.json({ ok: true, user_id: userId, payment_id: payment.id });
  } catch (e) {
    console.error('GD register error:', e.message);
    res.json({ ok: false, error: e.message });
  }
});

// Activate with QR code
router.post('/api/gd/activate', async (req, res) => {
  try {
    const { code, device_id } = req.body;
    if (!code) return res.json({ ok: false, error: 'missing code' });

    const act = await queryOne('SELECT * FROM gd_activations WHERE code = $1', [code]);
    if (!act) return res.json({ ok: false, error: '激活码无效' });
    if (act.valid_until && new Date(act.valid_until) < new Date()) return res.json({ ok: false, error: '激活码已过期' });
    if (act.is_used) return res.json({ ok: false, error: '激活码已使用，每个激活码仅限一台设备，请联系管理员重新生成' });

    // 首次使用：绑定设备，立即标记失效（一码一机）
    await query('UPDATE gd_activations SET is_used=1, used_at=NOW(), used_device_id=$1 WHERE id=$2',
      [device_id || '', act.id]);

    res.json({ ok: true, valid_until: act.valid_until, user_id: act.user_id });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Check device activation status
router.get('/api/gd/status', async (req, res) => {
  try {
    const { device_id } = req.query;
    if (!device_id) return res.json({ ok: false });
    const act = await queryOne(
      'SELECT valid_until FROM gd_activations WHERE used_device_id=$1 AND valid_until > NOW() ORDER BY valid_until DESC LIMIT 1',
      [device_id]
    );
    res.json({ ok: true, active: !!act, valid_until: act ? act.valid_until : null });
  } catch (e) {
    res.json({ ok: false });
  }
});

module.exports = router;
