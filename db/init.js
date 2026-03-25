const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'guandan.db');
let db;

function getDB() {
  if (!db) {
    db = new Database(DB_PATH);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
  }
  return db;
}

function initDB() {
  const db = getDB();

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      is_super_admin INTEGER DEFAULT 0,
      is_locked INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tournaments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
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
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS registrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tournament_id INTEGER NOT NULL,
      name_enc TEXT NOT NULL,
      phone_enc TEXT NOT NULL,
      email_enc TEXT,
      payment_confirmed INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS page_content (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page TEXT NOT NULL,
      key_name TEXT NOT NULL,
      value_zh TEXT,
      value_en TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(page, key_name)
    );
  `);

  // Default admin
  const adminExists = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
  if (!adminExists) {
    const hash = bcrypt.hashSync('Admin2025!', 12);
    db.prepare('INSERT INTO users (username, password_hash, is_super_admin) VALUES (?, ?, 1)').run('admin', hash);
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

  const ins = db.prepare('INSERT OR IGNORE INTO page_content (page, key_name, value_zh, value_en) VALUES (?, ?, ?, ?)');
  for (const c of defaultContent) {
    ins.run(c.page, c.key, c.zh, c.en);
  }

  // Add new columns to registrations if they don't exist yet (migration)
  const newCols = [
    'ALTER TABLE registrations ADD COLUMN team_name_enc TEXT',
    'ALTER TABLE registrations ADD COLUMN partner_name_enc TEXT',
    'ALTER TABLE registrations ADD COLUMN random_partner INTEGER DEFAULT 0',
    'ALTER TABLE tournaments ADD COLUMN wechat_qr TEXT DEFAULT \'\'',
    'ALTER TABLE tournaments ADD COLUMN wechat_note TEXT DEFAULT \'\'',
  ];
  for (const sql of newCols) {
    try { db.exec(sql); } catch (e) { /* column already exists, skip */ }
  }

  console.log('✅ Database initialized');
}

module.exports = { getDB, initDB };
