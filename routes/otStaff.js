const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { queryOne } = require('../db/init');
const { requireOtStaffAuth } = require('../middleware/otStaffAuth');

// ── 登录 ─────────────────────────────────────────────────

router.get('/login', (req, res) => {
  if (req.session.otStaff) return res.redirect('/ot-staff/tournaments-online');
  res.render('ot-staff/login', { error: req.flash('error'), success: req.flash('success') });
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    req.flash('error', '请填写用户名和密码 | Please enter username and password');
    return res.redirect('/ot-staff/login');
  }
  try {
    const staff = await queryOne('SELECT * FROM ot_staff WHERE username = $1', [username]);
    if (!staff || !bcrypt.compareSync(password, staff.password_hash)) {
      req.flash('error', '用户名或密码错误 | Invalid username or password');
      return res.redirect('/ot-staff/login');
    }
    if (!staff.is_active) {
      req.flash('error', '账号已被停用，请联系系统管理员 | Account disabled, contact admin');
      return res.redirect('/ot-staff/login');
    }
    req.session.otStaff = { id: staff.id, username: staff.username, display_name: staff.display_name };
    res.redirect('/ot-staff/tournaments-online');
  } catch (e) {
    console.error(e);
    req.flash('error', 'Server error, please try again');
    res.redirect('/ot-staff/login');
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/ot-staff/login');
});

// ── 网上赛事（仅四人/六人页面，无其他权限） ───────────────

router.get('/tournaments-online', requireOtStaffAuth, (req, res) => {
  res.render('ot-staff/tournaments-online', {
    otStaff: req.session.otStaff,
    success: req.flash('success'),
    error: req.flash('error'),
  });
});

router.get('/tournaments-6p', requireOtStaffAuth, (req, res) => {
  res.render('ot-staff/tournaments-6p', {
    otStaff: req.session.otStaff,
    success: req.flash('success'),
    error: req.flash('error'),
  });
});

module.exports = router;
