const express = require('express');
const router = express.Router();
const { getDB } = require('../db/init');
const { encrypt } = require('../utils/crypto');

function getContent(page) {
  const db = getDB();
  const rows = db.prepare('SELECT key_name, value_zh, value_en FROM page_content WHERE page = ?').all(page);
  const c = {};
  rows.forEach(r => { c[r.key_name] = { zh: r.value_zh, en: r.value_en }; });
  return c;
}

// Home page
router.get('/', (req, res) => {
  const db = getDB();
  const tournaments = db.prepare(`
    SELECT t.*,
      (SELECT COUNT(*) FROM registrations r WHERE r.tournament_id = t.id) as reg_count
    FROM tournaments t
    WHERE t.status = 'active'
    ORDER BY t.created_at DESC
  `).all();
  const content = getContent('home');
  res.render('index', { tournaments, content });
});

// Registration page
router.get('/register/:id', (req, res) => {
  const db = getDB();
  const tournament = db.prepare('SELECT * FROM tournaments WHERE id = ? AND status = ?').get(req.params.id, 'active');
  if (!tournament) return res.redirect('/');
  const content = getContent('register');
  res.render('register', { tournament, content });
});

// Registration submit
router.post('/register/:id', (req, res) => {
  const db = getDB();
  const tournament = db.prepare('SELECT * FROM tournaments WHERE id = ? AND status = ?').get(req.params.id, 'active');
  if (!tournament) return res.redirect('/');

  const { name, phone, email, team_name, partner_name, random_partner, payment_check } = req.body;

  if (!name || !name.trim()) {
    req.flash('error', '请填写姓名 | Name is required');
    return res.redirect(`/register/${req.params.id}`);
  }
  if (!phone || !phone.trim()) {
    req.flash('error', '请填写电话号码 | Phone number is required');
    return res.redirect(`/register/${req.params.id}`);
  }
  // Server-side payment check — must confirm payment before registering
  if (payment_check !== 'yes') {
    req.flash('error', '请先完成付款并勾选付款确认框，才能提交报名！| Please complete payment and check the confirmation box before submitting.');
    return res.redirect(`/register/${req.params.id}`);
  }

  const nameEnc = encrypt(name.trim());
  const phoneEnc = encrypt(phone.trim());
  const emailEnc = email && email.trim() ? encrypt(email.trim()) : null;
  const teamNameEnc = team_name && team_name.trim() ? encrypt(team_name.trim()) : null;
  const partnerNameEnc = partner_name && partner_name.trim() ? encrypt(partner_name.trim()) : null;
  // random_partner only relevant when no partner name provided
  const randomPartner = (!partner_name || !partner_name.trim()) && random_partner === 'yes' ? 1 : 0;

  db.prepare(`
    INSERT INTO registrations (tournament_id, name_enc, phone_enc, email_enc, team_name_enc, partner_name_enc, random_partner)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(tournament.id, nameEnc, phoneEnc, emailEnc, teamNameEnc, partnerNameEnc, randomPartner);

  res.redirect(`/success?t=${encodeURIComponent(tournament.title_zh)}&v=${encodeURIComponent(tournament.venmo || '@yorkxia')}&f=${tournament.fee || 10}`);
});

// Success page
router.get('/success', (req, res) => {
  res.render('success', {
    tournament: req.query.t || '掼蛋比赛',
    venmo: req.query.v || '@yorkxia',
    fee: req.query.f || 10
  });
});

module.exports = router;
