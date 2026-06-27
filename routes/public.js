const express = require('express');
const router = express.Router();
const { query, queryOne } = require('../db/init');
const { encrypt, decrypt } = require('../utils/crypto');
const { geoLocate } = require('../utils/geo');
const crypto = require('crypto');

function amountToDays(amount) {
  if (!amount) return 31;
  if (/永久|lifetime|42\.99/i.test(amount)) return 9999;
  if (/年|year|128|18\.99/i.test(amount)) return 365;
  return 31;
}

async function sendConfirmEmail(user, payment, token) {
  const confirmUrl = `${process.env.APP_BASE_URL || 'https://silicon-guandan-system.onrender.com'}/api/gd/confirm/${token}`;
  const amountDisplay = payment.amount || '(未知)';
  const days = amountToDays(amountDisplay);
  const daysLabel = days === 9999 ? '永久' : days + '天';

  const html = `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;background:#fff;">
  <h2 style="color:#C0392B;">🃏 掼蛋计分器 · 付款通知</h2>
  <table style="width:100%;border-collapse:collapse;margin:16px 0;">
    <tr><td style="padding:6px;color:#555;width:120px;">用户姓名</td><td style="padding:6px;font-weight:bold;">${user.name}</td></tr>
    <tr style="background:#f9f9f9"><td style="padding:6px;color:#555;">联系方式</td><td style="padding:6px;">${user.contact || '(未填)'}</td></tr>
    <tr><td style="padding:6px;color:#555;">付款金额</td><td style="padding:6px;font-weight:bold;color:#C0392B;">${amountDisplay}</td></tr>
    <tr style="background:#f9f9f9"><td style="padding:6px;color:#555;">付款方式</td><td style="padding:6px;">${payment.payment_method}</td></tr>
    <tr><td style="padding:6px;color:#555;">激活天数</td><td style="padding:6px;">${daysLabel}</td></tr>
    <tr style="background:#f9f9f9"><td style="padding:6px;color:#555;">设备ID</td><td style="padding:6px;font-size:0.85em;color:#888;">${user.device_id || '(未知)'}</td></tr>
  </table>
  <div style="text-align:center;margin:28px 0;">
    <a href="${confirmUrl}" style="display:inline-block;background:#27AE60;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-size:1.1em;font-weight:bold;">
      ✅ 确认收到付款 · 立即激活
    </a>
  </div>
  <p style="color:#888;font-size:0.85em;text-align:center;">点击后将自动为该设备开通 ${daysLabel} 使用权限</p>
  <p style="color:#aaa;font-size:0.8em;text-align:center;">此链接仅可使用一次 · 硅谷掼蛋协会</p>
</div>`;

  try {
    if (process.env.RESEND_API_KEY) {
      const { Resend } = require('resend');
      const resend = new Resend(process.env.RESEND_API_KEY);
      await resend.emails.send({
        from: process.env.EMAIL_FROM || 'noreply@siliconguandan.com',
        to: 'siliconguandan@gmail.com',
        subject: `💰 掼蛋付款：${user.name} · ${amountDisplay}`,
        html,
      });
    }
  } catch (e) {
    console.error('GD email send error:', e.message);
  }
}

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

// Promo poster page
router.get('/promo', (req, res) => res.render('promo'));

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

    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip;
    const geo = await geoLocate(ip);

    await query(
      `INSERT INTO registrations (tournament_id, name_enc, phone_enc, email_enc, team_name_enc, partner_name_enc, backup_partner_name_enc, random_partner, region_code, channel)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        tournament.id,
        encrypt(name),
        encrypt(phone),
        email ? encrypt(email) : null,
        team_name ? encrypt(team_name) : null,
        partner_name ? encrypt(partner_name) : null,
        backup_partner_name ? encrypt(backup_partner_name) : null,
        random_partner ? 1 : 0,
        geo.region_code,
        'web'
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

    // Create payment record with confirm token
    const { amount, currency, payment_method } = req.body;
    const confirmToken = crypto.randomBytes(24).toString('hex');
    const payment = await queryOne(
      'INSERT INTO gd_payments (user_id, amount, currency, payment_method, status, confirm_token) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, amount, currency, payment_method, confirm_token',
      [userId, amount || '', currency || 'CNY', payment_method || 'wechat', 'pending', confirmToken]
    );

    // Get user info for email
    const userRec = await queryOne('SELECT * FROM gd_users WHERE id=$1', [userId]);
    if (userRec) {
      await sendConfirmEmail(userRec, payment, confirmToken);
    }

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
      'SELECT valid_from, valid_until, activation_days FROM gd_activations WHERE used_device_id=$1 AND valid_until > NOW() ORDER BY valid_until DESC LIMIT 1',
      [device_id]
    );
    res.json({
      ok: true,
      active: !!act,
      valid_until: act ? act.valid_until : null,
      valid_from: act ? act.valid_from : null,
      activation_days: act ? (act.activation_days || 31) : null
    });
  } catch (e) {
    res.json({ ok: false });
  }
});

// Admin email confirm link → auto-activate device
router.get('/api/gd/confirm/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const payment = await queryOne('SELECT * FROM gd_payments WHERE confirm_token=$1', [token]);
    if (!payment) return res.send('<h2>❌ 链接无效或已过期</h2>');
    if (payment.status === 'confirmed') return res.send('<h2>✅ 已激活（此链接已使用）</h2>');

    const user = await queryOne('SELECT * FROM gd_users WHERE id=$1', [payment.user_id]);
    if (!user) return res.send('<h2>❌ 用户不存在</h2>');

    const days = amountToDays(payment.amount);
    const validUntil = days === 9999
      ? new Date('2099-12-31T23:59:59Z')
      : new Date(Date.now() + days * 86400000);

    // Mark payment confirmed
    await query('UPDATE gd_payments SET status=$1, confirmed_by=$2, confirmed_at=NOW() WHERE id=$3',
      ['confirmed', 'email-link', payment.id]);

    // Create activation record (bind to user's device_id)
    const actCode = crypto.randomBytes(12).toString('hex');
    await query(
      `INSERT INTO gd_activations (user_id, payment_id, code, valid_until, device_id, is_used, used_at, used_device_id, created_by, activation_days)
       VALUES ($1,$2,$3,$4,$5,1,NOW(),$5,'email-confirm',$6)`,
      [user.id, payment.id, actCode, validUntil, user.device_id || '', days]
    );

    const daysLabel = days === 9999 ? '永久' : days + ' 天';
    const untilStr = days === 9999 ? '永久' : validUntil.toLocaleDateString('zh-CN');
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
<style>body{font-family:Arial,sans-serif;max-width:500px;margin:60px auto;text-align:center;padding:20px;}
.box{background:#f0fff4;border:2px solid #27AE60;border-radius:12px;padding:32px;}
h2{color:#27AE60;}p{color:#555;}small{color:#aaa;}</style></head><body>
<div class="box">
  <h2>✅ 已确认付款，激活成功！</h2>
  <p>用户：<strong>${user.name}</strong></p>
  <p>付款：<strong>${payment.amount}</strong></p>
  <p>有效期：<strong>${daysLabel}</strong>（至 ${untilStr}）</p>
  <p>设备将在下次打开计分器时自动更新状态。</p>
  <small>硅谷掼蛋协会 · Silicon Valley Guandan Association</small>
</div></body></html>`);
  } catch (e) {
    console.error('GD confirm error:', e.message);
    res.send('<h2>❌ 服务器错误：' + e.message + '</h2>');
  }
});

// ── PWA 安装落地页 ──────────────────────────────────────────
router.get('/install', (req, res) => {
  res.render('install');
});

module.exports = router;
