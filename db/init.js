const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function query(sql, params = []) {
  const client = await pool.connect();
  try {
    const result = await client.query(sql, params);
    return result.rows;
  } finally {
    client.release();
  }
}

async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

async function initDB() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      is_super_admin SMALLINT DEFAULT 0,
      is_locked SMALLINT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS tournaments (
      id SERIAL PRIMARY KEY,
      title_zh TEXT NOT NULL,
      title_en TEXT NOT NULL,
      description_zh TEXT DEFAULT '',
      description_en TEXT DEFAULT '',
      date TEXT DEFAULT '',
      location_zh TEXT DEFAULT '',
      location_en TEXT DEFAULT '',
      max_participants INTEGER DEFAULT 100,
      fee INTEGER DEFAULT 10,
      venmo TEXT DEFAULT '@yorkxia',
      status TEXT DEFAULT 'active',
      created_by INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      wechat_qr TEXT DEFAULT '',
      wechat_note TEXT DEFAULT ''
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS registrations (
      id SERIAL PRIMARY KEY,
      tournament_id INTEGER NOT NULL,
      name_enc TEXT NOT NULL,
      phone_enc TEXT NOT NULL,
      email_enc TEXT,
      payment_confirmed SMALLINT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      team_name_enc TEXT,
      partner_name_enc TEXT,
      random_partner SMALLINT DEFAULT 0
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS page_content (
      id SERIAL PRIMARY KEY,
      page TEXT NOT NULL,
      key_name TEXT NOT NULL,
      value_zh TEXT,
      value_en TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(page, key_name)
    )
  `);

  // Default admin
  const adminExists = await queryOne('SELECT id FROM users WHERE username = $1', ['admin']);
  if (!adminExists) {
    const hash = bcrypt.hashSync('Admin2025!', 12);
    await query('INSERT INTO users (username, password_hash, is_super_admin) VALUES ($1, $2, 1)', ['admin', hash]);
    console.log('✅ Default admin created: admin / Admin2025!');
  }

  // Default page content
  const defaultContent = [
    { page: 'home', key: 'hero_title', zh: '硅谷掼蛋联赛', en: 'Silicon Valley Guandan League' },
    { page: 'home', key: 'hero_subtitle', zh: '🐎 2026马年春季联赛 · 现在报名参赛！', en: '🐎 2026 Year of the Horse Spring Tournament · Register Now!' },
    { page: 'home', key: 'hero_desc', zh: '欢迎参加硅谷最具活力的掼蛋比赛，与高手同台竞技，展示您的牌技！', en: 'Join the most vibrant Guandan tournament in Silicon Valley. Compete with the best!' },
    { page: 'home', key: 'about_title', zh: '关于掼蛋', en: 'About Guandan' },
    { page: 'home', key: 'about_text', zh: '掼蛋是一种流行于中国的四人纸牌游戏，分成两队对抗，以最先出完所有手牌为目标。比赛融合了策略、技巧与团队配合，老少皆宜，趣味横生！', en: 'Guandan is a popular Chinese card game for four players split into two teams. The goal is to be the first team to play all your cards. It combines strategy, skill, and teamwork — fun for all ages!' },
    { page: 'home', key: 'payment_note', zh: '报名费 $10，请通过 Venmo 支付至', en: 'Registration fee $10, please pay via Venmo to' },
    { page: 'register', key: 'title', zh: '比赛报名', en: 'Tournament Registration' },
    { page: 'register', key: 'subtitle', zh: '填写以下信息完成报名，并通过 Venmo 支付报名费', en: 'Complete the form below and pay via Venmo to register' },
    { page: 'register', key: 'payment_note', zh: '请在提交报名后，通过 Venmo 向 @yorkxia 支付 $10 报名费，并在备注中注明参赛者姓名和赛事名称。', en: 'After submitting, please pay $10 via Venmo to @yorkxia. Include your name and tournament name in the note.' },
    { page: 'register', key: 'wechat_note', zh: '或通过微信扫码支付 $10 报名费，请在备注中注明您的姓名和赛事名称。', en: 'Or scan the WeChat QR code to pay $10. Include your name and tournament name in the payment note.' },
    { page: 'register', key: 'wechat_qr', zh: '', en: '' },
  ];
  for (const c of defaultContent) {
    await query(
      'INSERT INTO page_content (page, key_name, value_zh, value_en) VALUES ($1, $2, $3, $4) ON CONFLICT (page, key_name) DO NOTHING',
      [c.page, c.key, c.zh, c.en]
    );
  }
  console.log('✅ Database initialized');
}

module.exports = { query, queryOne, initDB };
