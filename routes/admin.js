const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const ExcelJS = require('exceljs');
const { query, queryOne } = require('../db/init');
const { encrypt, decrypt } = require('../utils/crypto');
const { requireAuth, requireSuperAdmin } = require('../middleware/auth');
const { sendPaymentConfirmation } = require('../utils/email');

function canAccessTournament(user, tournament) {
  if (!tournament) return false;
  if (user.is_super_admin) return true;
  return tournament.created_by === user.id;
}

// ============ SMTP DEBUG (temporary) ============
router.get('/smtp-check', requireAuth, (req, res) => {
  res.json({
    SMTP_HOST: process.env.SMTP_HOST || '(not set)',
    SMTP_PORT: process.env.SMTP_PORT || '(not set)',
    SMTP_SECURE: process.env.SMTP_SECURE || '(not set)',
    SMTP_USER: process.env.SMTP_USER || '(not set)',
    SMTP_PASS: process.env.SMTP_PASS ? '(set, length=' + process.env.SMTP_PASS.length + ')' : '(not set)',
    EMAIL_FROM: process.env.EMAIL_FROM || '(not set)',
  });
});

// ============ AUTH ============

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/admin/dashboard');
  res.render('admin/login');
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    req.flash('error', '请填写用户名和密码 | Please enter username and password');
    return res.redirect('/admin/login');
  }
  try {
    const user = await queryOne('SELECT * FROM users WHERE username = $1', [username]);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      req.flash('error', '用户名或密码错误 | Invalid username or password');
      return res.redirect('/admin/login');
    }
    if (user.is_locked) {
      req.flash('error', '账号已被锁定，请联系超级管理员 | Account locked, contact super admin');
      return res.redirect('/admin/login');
    }
    req.session.user = { id: user.id, username: user.username, is_super_admin: user.is_super_admin };
    res.redirect('/admin/dashboard');
  } catch (e) {
    console.error(e);
    req.flash('error', 'Server error, please try again');
    res.redirect('/admin/login');
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/admin/login');
});

// ============ DASHBOARD ============

router.get('/dashboard', requireAuth, async (req, res) => {
  try {
    const isSuperAdmin = req.session.user.is_super_admin;
    const userId = req.session.user.id;
    const tournaments = isSuperAdmin
      ? await query(`SELECT t.*, u.username as creator_name, (SELECT COUNT(*) FROM registrations r WHERE r.tournament_id = t.id) as reg_count FROM tournaments t LEFT JOIN users u ON t.created_by = u.id ORDER BY t.created_at DESC`)
      : await query(`SELECT t.*, u.username as creator_name, (SELECT COUNT(*) FROM registrations r WHERE r.tournament_id = t.id) as reg_count FROM tournaments t LEFT JOIN users u ON t.created_by = u.id WHERE t.created_by = $1 ORDER BY t.created_at DESC`, [userId]);

    const tIds = tournaments.map(t => t.id);
    let totalRegs = 0, paidRegs = 0;
    if (tIds.length > 0) {
      const tr = await queryOne('SELECT COUNT(*) as c FROM registrations WHERE tournament_id = ANY($1)', [tIds]);
      const pr = await queryOne('SELECT COUNT(*) as c FROM registrations WHERE payment_confirmed = 1 AND tournament_id = ANY($1)', [tIds]);
      totalRegs = parseInt(tr.c);
      paidRegs = parseInt(pr.c);
    }
    const stats = {
      total_tournaments: tournaments.length,
      active_tournaments: tournaments.filter(t => t.status === 'active').length,
      total_registrations: totalRegs,
      paid_count: paidRegs,
    };
    res.render('admin/dashboard', { tournaments, stats, isSuperAdmin });
  } catch (e) {
    console.error(e);
    res.status(500).send('Server Error');
  }
});

// ============ TOURNAMENTS ============

router.get('/tournaments/new', requireAuth, (req, res) => {
  res.render('admin/tournament-form', { tournament: null });
});

router.post('/tournaments', requireAuth, async (req, res) => {
  const { title_zh, title_en, description_zh, description_en, date, location_zh, location_en, max_participants, fee, venmo, status, wechat_qr, wechat_note } = req.body;
  if (!title_zh || !title_en) {
    req.flash('error', '中英文标题为必填项 | Title in both languages required');
    return res.redirect('/admin/tournaments/new');
  }
  try {
    await query(
      `INSERT INTO tournaments (title_zh, title_en, description_zh, description_en, date, location_zh, location_en, max_participants, fee, venmo, status, created_by, wechat_qr, wechat_note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [title_zh, title_en, description_zh||'', description_en||'', date||'', location_zh||'', location_en||'', max_participants||100, fee||10, venmo||'@yorkxia', status||'active', req.session.user.id, wechat_qr||'', wechat_note||'']
    );
    req.flash('success', '赛事创建成功 | Tournament created successfully');
    res.redirect('/admin/dashboard');
  } catch (e) {
    console.error(e);
    res.status(500).send('Server Error');
  }
});

router.get('/tournaments/:id/edit', requireAuth, async (req, res) => {
  try {
    const tournament = await queryOne('SELECT * FROM tournaments WHERE id = $1', [req.params.id]);
    if (!canAccessTournament(req.session.user, tournament)) {
      req.flash('error', '无权访问此赛事 | Access denied');
      return res.redirect('/admin/dashboard');
    }
    res.render('admin/tournament-form', { tournament });
  } catch (e) { console.error(e); res.status(500).send('Server Error'); }
});

router.post('/tournaments/:id/update', requireAuth, async (req, res) => {
  try {
    const tournament = await queryOne('SELECT * FROM tournaments WHERE id = $1', [req.params.id]);
    if (!canAccessTournament(req.session.user, tournament)) {
      req.flash('error', '无权修改此赛事 | Access denied');
      return res.redirect('/admin/dashboard');
    }
    const { title_zh, title_en, description_zh, description_en, date, location_zh, location_en, max_participants, fee, venmo, status, wechat_qr, wechat_note } = req.body;
    await query(
      `UPDATE tournaments SET title_zh=$1, title_en=$2, description_zh=$3, description_en=$4, date=$5, location_zh=$6, location_en=$7, max_participants=$8, fee=$9, venmo=$10, status=$11, wechat_qr=$12, wechat_note=$13 WHERE id=$14`,
      [title_zh, title_en, description_zh||'', description_en||'', date||'', location_zh||'', location_en||'', max_participants, fee, venmo, status, wechat_qr||'', wechat_note||'', req.params.id]
    );
    req.flash('success', '赛事更新成功 | Tournament updated');
    res.redirect('/admin/dashboard');
  } catch (e) { console.error(e); res.status(500).send('Server Error'); }
});

router.post('/tournaments/:id/delete', requireAuth, async (req, res) => {
  try {
    const tournament = await queryOne('SELECT * FROM tournaments WHERE id = $1', [req.params.id]);
    if (!canAccessTournament(req.session.user, tournament)) {
      req.flash('error', '无权删除此赛事 | Access denied');
      return res.redirect('/admin/dashboard');
    }
    await query('DELETE FROM registrations WHERE tournament_id = $1', [req.params.id]);
    await query('DELETE FROM tournaments WHERE id = $1', [req.params.id]);
    req.flash('success', '赛事已删除 | Tournament deleted');
    res.redirect('/admin/dashboard');
  } catch (e) { console.error(e); res.status(500).send('Server Error'); }
});

// ============ REGISTRATIONS ============

router.get('/tournaments/:id/registrations', requireAuth, async (req, res) => {
  try {
    const tournament = await queryOne('SELECT * FROM tournaments WHERE id = $1', [req.params.id]);
    if (!canAccessTournament(req.session.user, tournament)) {
      req.flash('error', '无权查看此赛事报名 | Access denied');
      return res.redirect('/admin/dashboard');
    }
    const regs = await query('SELECT * FROM registrations WHERE tournament_id = $1 ORDER BY created_at DESC', [req.params.id]);
    const decrypted = regs.map(r => ({
      ...r,
      name: decrypt(r.name_enc),
      phone: decrypt(r.phone_enc),
      email: r.email_enc ? decrypt(r.email_enc) : '',
      team_name: r.team_name_enc ? decrypt(r.team_name_enc) : '',
      partner_name: r.partner_name_enc ? decrypt(r.partner_name_enc) : '',
    }));
    res.render('admin/registrations', { tournament, registrations: decrypted });
  } catch (e) { console.error(e); res.status(500).send('Server Error'); }
});

router.post('/registrations/:id/payment', requireAuth, async (req, res) => {
  try {
    const reg = await queryOne('SELECT * FROM registrations WHERE id = $1', [req.params.id]);
    if (!reg) return res.redirect('/admin/dashboard');
    const tournament = await queryOne('SELECT * FROM tournaments WHERE id = $1', [reg.tournament_id]);
    if (!canAccessTournament(req.session.user, tournament)) {
      req.flash('error', '无权操作 | Access denied');
      return res.redirect('/admin/dashboard');
    }
    const newStatus = reg.payment_confirmed ? 0 : 1;
    await query('UPDATE registrations SET payment_confirmed = $1 WHERE id = $2', [newStatus, req.params.id]);

    if (newStatus === 1) {
      const name = decrypt(reg.name_enc);
      const email = reg.email_enc ? decrypt(reg.email_enc) : null;
      req.flash('success', `✅ 已确认 ${name} 的付款 | Payment confirmed for ${name}`);
      if (!email) {
        req.flash('error', `⚠️ ${name} 未填写邮箱，无法发送通知邮件 | No email on file for ${name}`);
      } else if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
        req.flash('error', '⚠️ SMTP 未配置，通知邮件未发送 | SMTP not configured, email not sent');
        console.error('Email skipped: SMTP_HOST=' + process.env.SMTP_HOST + ' SMTP_USER=' + process.env.SMTP_USER + ' SMTP_PASS=' + (process.env.SMTP_PASS ? 'set' : 'missing'));
      } else {
        req.flash('success', `📧 通知邮件正在发送至 ${email}`);
        sendPaymentConfirmation({ toEmail: email, toName: name, tournamentName: tournament.name })
          .then(() => console.log(`Email sent to ${email}`))
          .catch(err => console.error('Email send error:', err.message));
      }
    } else {
      const name = decrypt(reg.name_enc);
      req.flash('success', `↩️ 已取消 ${name} 的付款确认 | Payment unconfirmed for ${name}`);
    }

    res.redirect(`/admin/tournaments/${reg.tournament_id}/registrations`);
  } catch (e) { console.error(e); res.status(500).send('Server Error'); }
});

router.post('/registrations/:id/delete', requireAuth, async (req, res) => {
  try {
    const reg = await queryOne('SELECT tournament_id FROM registrations WHERE id = $1', [req.params.id]);
    if (!reg) return res.redirect('/admin/dashboard');
    const tournament = await queryOne('SELECT * FROM tournaments WHERE id = $1', [reg.tournament_id]);
    if (!canAccessTournament(req.session.user, tournament)) {
      req.flash('error', '无权操作 | Access denied');
      return res.redirect('/admin/dashboard');
    }
    await query('DELETE FROM registrations WHERE id = $1', [req.params.id]);
    req.flash('success', '记录已删除 | Record deleted');
    res.redirect(`/admin/tournaments/${reg.tournament_id}/registrations`);
  } catch (e) { console.error(e); res.status(500).send('Server Error'); }
});

// Export to Excel
router.get('/tournaments/:id/export', requireAuth, async (req, res) => {
  try {
    const tournament = await queryOne('SELECT * FROM tournaments WHERE id = $1', [req.params.id]);
    if (!canAccessTournament(req.session.user, tournament)) {
      req.flash('error', '无权导出此赛事 | Access denied');
      return res.redirect('/admin/dashboard');
    }
    const regs = await query('SELECT * FROM registrations WHERE tournament_id = $1 ORDER BY created_at', [req.params.id]);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = '硅谷掼蛋联赛';
    workbook.created = new Date();
    const sheet = workbook.addWorksheet('报名名单');
    sheet.columns = [
      { header: '序号', key: 'num', width: 8 },
      { header: '姓名 Name', key: 'name', width: 16 },
      { header: '电话 Phone', key: 'phone', width: 18 },
      { header: '邮箱 Email', key: 'email', width: 26 },
      { header: '参赛队名 Team', key: 'team_name', width: 18 },
      { header: '队友姓名 Partner', key: 'partner_name', width: 16 },
      { header: '随机配队 Random', key: 'random_partner', width: 14 },
      { header: '报名时间 Date', key: 'date', width: 20 },
      { header: '付款状态 Payment', key: 'payment', width: 14 },
    ];
    sheet.spliceRows(1, 0, []);
    sheet.spliceRows(1, 0, []);
    sheet.mergeCells('A1:I1');
    const titleCell = sheet.getCell('A1');
    titleCell.value = `${tournament.title_zh}  |  ${tournament.title_en}`;
    titleCell.font = { bold: true, size: 14, color: { argb: 'FF8B0000' } };
    titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
    sheet.getRow(1).height = 32;
    sheet.mergeCells('A2:I2');
    const subCell = sheet.getCell('A2');
    subCell.value = `导出时间: ${new Date().toLocaleString('zh-CN')}  |  总计: ${regs.length} 人`;
    subCell.font = { size: 10, color: { argb: 'FF666666' } };
    subCell.alignment = { horizontal: 'center' };
    const headerRow = sheet.getRow(3);
    headerRow.eachCell(cell => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF8B0000' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FFD4AC0D' } } };
    });
    headerRow.height = 24;
    regs.forEach((r, i) => {
      const partnerName = r.partner_name_enc ? decrypt(r.partner_name_enc) : '';
      const row = sheet.addRow({
        num: i + 1,
        name: decrypt(r.name_enc),
        phone: decrypt(r.phone_enc),
        email: r.email_enc ? decrypt(r.email_enc) : '',
        team_name: r.team_name_enc ? decrypt(r.team_name_enc) : '',
        partner_name: partnerName,
        random_partner: !partnerName ? (r.random_partner ? '✅ 愿意' : '❌ 不愿意') : '—',
        date: new Date(r.created_at).toLocaleString('zh-CN'),
        payment: r.payment_confirmed ? '✅ 已确认' : '⏳ 待确认',
      });
      if (i % 2 === 0) {
        row.eachCell(cell => {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF9E7' } };
        });
      }
      row.getCell('payment').font = { color: { argb: r.payment_confirmed ? 'FF1E8449' : 'FF9A7D0A' } };
    });
    const filename = `${tournament.title_zh}_报名名单.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (e) { console.error(e); res.status(500).send('Server Error'); }
});

// ============ USERS ============

router.get('/users', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const users = await query('SELECT id, username, is_super_admin, is_locked, created_at FROM users ORDER BY created_at');
    res.render('admin/users', { users });
  } catch (e) { console.error(e); res.status(500).send('Server Error'); }
});

router.post('/users', requireAuth, requireSuperAdmin, async (req, res) => {
  const { username, password, confirm_password } = req.body;
  if (!username || !password || password.length < 8) {
    req.flash('error', '用户名必填，密码至少8位 | Username required, password min 8 chars');
    return res.redirect('/admin/users');
  }
  if (password !== confirm_password) {
    req.flash('error', '两次输入的密码不一致 | Passwords do not match');
    return res.redirect('/admin/users');
  }
  try {
    if (await queryOne('SELECT id FROM users WHERE username = $1', [username])) {
      req.flash('error', '用户名已存在 | Username already exists');
      return res.redirect('/admin/users');
    }
    const hash = bcrypt.hashSync(password, 12);
    await query('INSERT INTO users (username, password_hash) VALUES ($1, $2)', [username, hash]);
    req.flash('success', `用户 ${username} 创建成功 | User created`);
    res.redirect('/admin/users');
  } catch (e) { console.error(e); res.status(500).send('Server Error'); }
});

router.post('/users/:id/toggle-lock', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const user = await queryOne('SELECT * FROM users WHERE id = $1', [req.params.id]);
    if (!user || user.is_super_admin) {
      req.flash('error', '无法操作此账号 | Cannot modify this account');
      return res.redirect('/admin/users');
    }
    await query('UPDATE users SET is_locked = $1 WHERE id = $2', [user.is_locked ? 0 : 1, req.params.id]);
    req.flash('success', user.is_locked ? `已解锁 ${user.username} | Unlocked` : `已锁定 ${user.username} | Locked`);
    res.redirect('/admin/users');
  } catch (e) { console.error(e); res.status(500).send('Server Error'); }
});

router.post('/users/:id/delete', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const user = await queryOne('SELECT * FROM users WHERE id = $1', [req.params.id]);
    if (!user || user.is_super_admin) {
      req.flash('error', '无法删除此账号 | Cannot delete this account');
      return res.redirect('/admin/users');
    }
    await query('DELETE FROM users WHERE id = $1', [req.params.id]);
    req.flash('success', `用户 ${user.username} 已删除 | User deleted`);
    res.redirect('/admin/users');
  } catch (e) { console.error(e); res.status(500).send('Server Error'); }
});

// ============ PAGE CONTENT ============

router.get('/content', requireAuth, async (req, res) => {
  try {
    const content = await query('SELECT * FROM page_content ORDER BY page, key_name');
    res.render('admin/content', { content });
  } catch (e) { console.error(e); res.status(500).send('Server Error'); }
});

router.post('/content/:id', requireAuth, async (req, res) => {
  const { value_zh, value_en } = req.body;
  try {
    await query('UPDATE page_content SET value_zh=$1, value_en=$2, updated_at=CURRENT_TIMESTAMP WHERE id=$3', [value_zh, value_en, req.params.id]);
    req.flash('success', '内容已更新发布 | Content updated and published');
    res.redirect('/admin/content');
  } catch (e) { console.error(e); res.status(500).send('Server Error'); }
});

// ============ PASSWORD SETTINGS ============

router.get('/settings', requireAuth, (req, res) => {
  res.render('admin/settings');
});

router.post('/settings/password', requireAuth, async (req, res) => {
  const { current_password, new_password, confirm_password } = req.body;
  if (!current_password || !new_password || !confirm_password) {
    req.flash('error', '请填写所有密码字段 | All password fields are required');
    return res.redirect('/admin/settings');
  }
  if (new_password !== confirm_password) {
    req.flash('error', '两次输入的新密码不一致 | New passwords do not match');
    return res.redirect('/admin/settings');
  }
  if (new_password.length < 8) {
    req.flash('error', '新密码至少需要8位 | Password must be at least 8 characters');
    return res.redirect('/admin/settings');
  }
  try {
    const user = await queryOne('SELECT * FROM users WHERE id = $1', [req.session.user.id]);
    if (!bcrypt.compareSync(current_password, user.password_hash)) {
      req.flash('error', '当前密码错误 | Current password is incorrect');
      return res.redirect('/admin/settings');
    }
    const hash = bcrypt.hashSync(new_password, 12);
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.session.user.id]);
    req.flash('success', '密码修改成功，请重新登录 | Password changed, please login again');
    req.session.destroy();
    res.redirect('/admin/login');
  } catch (e) { console.error(e); res.status(500).send('Server Error'); }
});

module.exports = router;
