const express = require('express');
const router = express.Router();
const { query, queryOne } = require('../db/init');
const { encrypt } = require('../utils/crypto');

async function getContent(page) {
  const rows = await query('SELECT key_name, value_zh, value_en FROM page_content WHERE page = $1', [page]);
  const c = {};
  rows.forEach(r => { c[r.key_name] = { zh: r.value_zh, en: r.value_en }; });
  return c;
}

// Home page
router.get('/', async (req, res) => {
  try {
    const tournaments = await query(`
      SELECT t.*, (SELECT COUNT(*) FROM registrations r WHERE r.tournament_id = t.id) as reg_count
      FROM tournaments t WHERE t.status = 'active' ORDER BY t.created_at DESC
    `);
    const content = await getContent('home');
    res.render('index', { tournaments, content });
  } catch (e) {
    console.error(e);
    res.status(500).send('Server Error');
  }
});

// Registration page
router.get('/register/:id', async (req, res) => {
  try {
    const tournament = await queryOne('SELECT * FROM tournaments WHERE id = $1 AND status = $2', [req.params.id, 'active']);
    if (!tournament) return res.redirect('/');
    const content = await getContent('register');
    res.render('register', { tournament, content });
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

    const { name, phone, email, team_name, partner_name, random_partner } = req.body;
    if (!name || !phone) return res.redirect(`/register/${req.params.id}`);

    const regCount = await queryOne('SELECT COUNT(*) as c FROM registrations WHERE tournament_id = $1', [tournament.id]);
    if (parseInt(regCount.c) >= tournament.max_participants) {
      return res.redirect('/success?status=full');
    }

    await query(
      `INSERT INTO registrations (tournament_id, name_enc, phone_enc, email_enc, team_name_enc, partner_name_enc, random_partner)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        tournament.id,
        encrypt(name),
        encrypt(phone),
        email ? encrypt(email) : null,
        team_name ? encrypt(team_name) : null,
        partner_name ? encrypt(partner_name) : null,
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

module.exports = router;
