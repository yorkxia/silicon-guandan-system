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
      payment_type TEXT DEFAULT 'Venmo',
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
      backup_partner_name_enc TEXT,
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
  // ============ 掼蛋监控模块 sb_* 表 ============
  await query(`
    CREATE TABLE IF NOT EXISTS sb_users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'regional',
      display_name TEXT DEFAULT '',
      is_active SMALLINT DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS sb_regions (
      id SERIAL PRIMARY KEY,
      country TEXT NOT NULL,
      area_code TEXT UNIQUE NOT NULL,
      area_name_zh TEXT NOT NULL,
      area_name_en TEXT NOT NULL,
      cities TEXT DEFAULT '',
      assigned_user_id INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS sb_ads (
      id SERIAL PRIMARY KEY,
      region_id INTEGER,
      title TEXT NOT NULL,
      content_type TEXT DEFAULT 'text',
      content_text TEXT DEFAULT '',
      content_url TEXT DEFAULT '',
      link_url TEXT DEFAULT '',
      start_time TIMESTAMP,
      end_time TIMESTAMP,
      is_active SMALLINT DEFAULT 1,
      impressions INTEGER DEFAULT 0,
      clicks INTEGER DEFAULT 0,
      created_by INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS sb_visits (
      id SERIAL PRIMARY KEY,
      ip_hash TEXT DEFAULT '',
      country TEXT DEFAULT '',
      region_code TEXT DEFAULT '',
      city TEXT DEFAULT '',
      page TEXT DEFAULT 'scoreboard',
      user_agent TEXT DEFAULT '',
      visited_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS sb_user_regions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      region_id INTEGER NOT NULL,
      UNIQUE(user_id, region_id)
    )
  `);

  // ============ 时事与股票形势模块 sb_intel_* 表 ============
  await query(`
    CREATE TABLE IF NOT EXISTS sb_intel_config (
      id           INTEGER PRIMARY KEY DEFAULT 1,
      news_times   TEXT DEFAULT '07:30,11:30,17:00',
      news_sources TEXT DEFAULT 'bbc,reuters,cnn,foxnews,ap,abc,nbc,guardian,france24,cgtn,rt,wsj',
      news_email   TEXT DEFAULT 'York.xia@gmail.com',
      flight_origin       TEXT DEFAULT 'SFO',
      flight_destinations TEXT DEFAULT '欧洲,日本,台湾,韩国,香港,上海,南京',
      flight_cabin        TEXT DEFAULT 'business',
      flight_months       INTEGER DEFAULT 1,
      flight_email        TEXT DEFAULT 'York.xia@gmail.com',
      stock_watchlist     TEXT DEFAULT 'AAPL,NVDA,MSFT,GOOG,META,AMZN,TSLA,AMD,NFLX,AVGO',
      anthropic_api_key   TEXT DEFAULT '',
      seats_aero_key      TEXT DEFAULT '',
      updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`INSERT INTO sb_intel_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);

  await query(`
    CREATE TABLE IF NOT EXISTS sb_intel_news (
      id           SERIAL PRIMARY KEY,
      session_type TEXT NOT NULL,
      summary      TEXT NOT NULL,
      sources_used TEXT DEFAULT '',
      fetched_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS sb_intel_flights (
      id           SERIAL PRIMARY KEY,
      session_type TEXT NOT NULL,
      results_json TEXT NOT NULL,
      origin       TEXT DEFAULT 'SFO',
      cabin        TEXT DEFAULT 'business',
      fetched_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS sb_intel_stocks (
      id           SERIAL PRIMARY KEY,
      session_type TEXT NOT NULL,
      analysis     TEXT NOT NULL,
      watchlist_json TEXT DEFAULT '{}',
      fetched_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 迁移：添加 frequency_minutes 列（如果不存在）
  await query(`ALTER TABLE sb_ads ADD COLUMN IF NOT EXISTS frequency_minutes INTEGER DEFAULT NULL`);
  // 迁移：添加 backup_partner_name_enc 列（如果不存在）
  await query(`ALTER TABLE registrations ADD COLUMN IF NOT EXISTS backup_partner_name_enc TEXT`);
  // 迁移：添加 payment_type 列（如果不存在）
  await query(`ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS payment_type TEXT DEFAULT 'Venmo'`);
  // 迁移：掼蛋付款邮件确认 token + 激活天数
  await query(`ALTER TABLE gd_payments ADD COLUMN IF NOT EXISTS confirm_token TEXT DEFAULT ''`);
  await query(`ALTER TABLE gd_activations ADD COLUMN IF NOT EXISTS activation_days INTEGER DEFAULT 31`);
  // 迁移：报名记录的区域定位 + 注册渠道（为网上赛事参赛者报表准备）
  await query(`ALTER TABLE registrations ADD COLUMN IF NOT EXISTS region_code TEXT DEFAULT NULL`);
  await query(`ALTER TABLE registrations ADD COLUMN IF NOT EXISTS channel TEXT DEFAULT 'web'`);

  // ============ 网上赛事 · 掼蛋赛事管理员模块 ot_* 表 ============
  // 独立账号体系：登录入口 /ot-staff/login，session 字段 req.session.otStaff，
  // 与主后台 users 表完全隔离，仅能访问"四人/六人掼蛋赛事"两个页面
  await query(`
    CREATE TABLE IF NOT EXISTS ot_staff (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT DEFAULT '',
      is_active SMALLINT DEFAULT 1,
      created_by INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 默认 sb admin
  const sbAdminExists = await queryOne('SELECT id FROM sb_users WHERE username = $1', ['sbadmin']);
  if (!sbAdminExists) {
    const hash = bcrypt.hashSync('SbAdmin2026!', 12);
    await query('INSERT INTO sb_users (username, password_hash, role, display_name) VALUES ($1, $2, $3, $4)',
      ['sbadmin', hash, 'admin', '监控管理员']);
    console.log('✅ Scoreboard admin created: sbadmin / SbAdmin2026!');
  }

  // 默认地理区域
  const regionDefaults = [
    { country: 'US', code: 'US-WEST',    zh: '美国西部',   en: 'US West',    cities: '洛杉矶,旧金山,硅谷,西雅图,圣何塞' },
    { country: 'US', code: 'US-EAST',    zh: '美国东部',   en: 'US East',    cities: '纽约,华盛顿DC,波士顿,费城' },
    { country: 'US', code: 'US-SOUTH',   zh: '美国南部',   en: 'US South',   cities: '休斯顿,迈阿密,亚特兰大,达拉斯' },
    { country: 'US', code: 'US-CENTRAL', zh: '美国中部',   en: 'US Central', cities: '芝加哥,丹佛,明尼阿波利斯' },
    { country: 'US', code: 'US-NORTH',   zh: '美国北部',   en: 'US North',   cities: '底特律,克利夫兰,水牛城' },
    { country: 'CA', code: 'CA-WEST',    zh: '加拿大西部', en: 'CA West',    cities: '温哥华,维多利亚,卡尔加里' },
    { country: 'CA', code: 'CA-EAST',    zh: '加拿大东部', en: 'CA East',    cities: '多伦多,渥太华,蒙特利尔,魁北克' },
    { country: 'CA', code: 'CA-CENTRAL', zh: '加拿大中部', en: 'CA Central', cities: '温尼伯,萨斯卡通,里贾纳' },
    { country: 'CN', code: 'CN',         zh: '中国大陆',   en: 'China',      cities: '北京,上海,深圳,广州,成都' },
    { country: 'TW', code: 'TW',         zh: '台湾',       en: 'Taiwan',     cities: '台北,高雄,台中' },
    { country: 'HK', code: 'HK',         zh: '香港',       en: 'Hong Kong',  cities: '香港' },
    { country: 'GLOBAL', code: 'GLOBAL', zh: '全球其他',   en: 'Global',     cities: '' },
  ];
  for (const r of regionDefaults) {
    await query(
      'INSERT INTO sb_regions (country, area_code, area_name_zh, area_name_en, cities) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (area_code) DO NOTHING',
      [r.country, r.code, r.zh, r.en, r.cities]
    );
  }

  // ============ 掼蛋计分器管理模块 gd_* 表 ============
  await query(`
    CREATE TABLE IF NOT EXISTS gd_users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      contact TEXT DEFAULT '',
      device_id TEXT DEFAULT '',
      device_info TEXT DEFAULT '',
      install_ts BIGINT DEFAULT 0,
      last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      notes TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS gd_payments (
      id SERIAL PRIMARY KEY,
      user_id INTEGER,
      amount TEXT DEFAULT '',
      currency TEXT DEFAULT 'CNY',
      payment_method TEXT DEFAULT 'wechat',
      status TEXT DEFAULT 'pending',
      paid_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      confirmed_by TEXT DEFAULT '',
      confirmed_at TIMESTAMP,
      notes TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS gd_activations (
      id SERIAL PRIMARY KEY,
      user_id INTEGER,
      payment_id INTEGER,
      code TEXT UNIQUE NOT NULL,
      valid_from TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      valid_until TIMESTAMP NOT NULL,
      device_id TEXT DEFAULT '',
      is_used SMALLINT DEFAULT 0,
      used_at TIMESTAMP,
      used_device_id TEXT DEFAULT '',
      created_by TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // ============================================================
  // 网上掼蛋对战模块 gdo_* 表（阶段二）
  // gdo = Guandan Online，与离线计分器 gd_* 表完全独立
  // ============================================================

  // 玩家身份表：由 localStorage token 驱动，无需注册
  await query(`
    CREATE TABLE IF NOT EXISTS gdo_players (
      id              SERIAL PRIMARY KEY,
      player_token    VARCHAR(64) UNIQUE NOT NULL,
      display_name    VARCHAR(32) NOT NULL DEFAULT '匿名玩家',
      games_played    INT NOT NULL DEFAULT 0,
      games_won       INT NOT NULL DEFAULT 0,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_active_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // 游戏房间表：一个房间对应一场「升级」对局（多轮）
  // level_team1/2 用整数存级别：2=二，3=三…10=十，11=J，12=Q，13=K，14=A
  await query(`
    CREATE TABLE IF NOT EXISTS gdo_rooms (
      id            SERIAL PRIMARY KEY,
      room_code     VARCHAR(8) UNIQUE NOT NULL,
      game_mode     VARCHAR(4) NOT NULL CHECK (game_mode IN ('4p', '6p')),
      room_type     VARCHAR(16) NOT NULL DEFAULT 'random'
                      CHECK (room_type IN ('random', 'private', 'tournament')),
      status        VARCHAR(16) NOT NULL DEFAULT 'waiting'
                      CHECK (status IN ('waiting', 'playing', 'finished', 'abandoned')),
      level_team1   SMALLINT NOT NULL DEFAULT 2,
      level_team2   SMALLINT NOT NULL DEFAULT 2,
      round_count   INT NOT NULL DEFAULT 0,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      started_at    TIMESTAMPTZ,
      finished_at   TIMESTAMPTZ
    )
  `);

  // 座位表：玩家 ↔ 房间对应关系，含队伍、socket、就绪状态
  // 四人：seat 1-4，team 1={1,3} team 2={2,4}
  // 六人：seat 1-6，team 1={1,3,5} team 2={2,4,6}
  await query(`
    CREATE TABLE IF NOT EXISTS gdo_seats (
      id            SERIAL PRIMARY KEY,
      room_id       INT NOT NULL REFERENCES gdo_rooms(id) ON DELETE CASCADE,
      player_id     INT NOT NULL REFERENCES gdo_players(id),
      seat          SMALLINT NOT NULL,
      team          SMALLINT NOT NULL CHECK (team IN (1, 2)),
      socket_id     VARCHAR(48),
      is_ready      BOOLEAN NOT NULL DEFAULT FALSE,
      is_connected  BOOLEAN NOT NULL DEFAULT TRUE,
      joined_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (room_id, seat),
      UNIQUE (room_id, player_id)
    )
  `);

  // 局结算表：每轮完成后写入一条，记录完成顺序和升级结果
  // result_type: '大胜'(头+二同队+3),'小胜'(头+三同队+2),'末胜'(头+末同队+1)
  await query(`
    CREATE TABLE IF NOT EXISTS gdo_rounds (
      id                SERIAL PRIMARY KEY,
      room_id           INT NOT NULL REFERENCES gdo_rooms(id) ON DELETE CASCADE,
      round_number      SMALLINT NOT NULL,
      finish_order      INT[] NOT NULL DEFAULT '{}',
      winner_team       SMALLINT CHECK (winner_team IN (1, 2)),
      result_type       VARCHAR(8),
      level_delta       SMALLINT,
      level_team1_after SMALLINT,
      level_team2_after SMALLINT,
      started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at       TIMESTAMPTZ
    )
  `);

  // 匹配队列表：个人随机匹配用，matched 后填入 room_id
  await query(`
    CREATE TABLE IF NOT EXISTS gdo_queue (
      id            SERIAL PRIMARY KEY,
      player_id     INT NOT NULL REFERENCES gdo_players(id),
      player_token  VARCHAR(64) NOT NULL,
      game_mode     VARCHAR(4) NOT NULL CHECK (game_mode IN ('4p', '6p')),
      socket_id     VARCHAR(48),
      status        VARCHAR(16) NOT NULL DEFAULT 'waiting'
                      CHECK (status IN ('waiting', 'matched', 'cancelled', 'timeout')),
      queued_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      matched_at    TIMESTAMPTZ,
      room_id       INT REFERENCES gdo_rooms(id)
    )
  `);

  // 索引（幂等：PostgreSQL 支持 CREATE INDEX IF NOT EXISTS）
  await query(`CREATE INDEX IF NOT EXISTS idx_gdo_rooms_status   ON gdo_rooms(status)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_gdo_seats_room     ON gdo_seats(room_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_gdo_rounds_room    ON gdo_rounds(room_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_gdo_queue_status   ON gdo_queue(status, game_mode)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_gdo_players_token  ON gdo_players(player_token)`);

  /* 阶段四迁移：gdo_rounds 加 hands_json 列 */
  await query(`ALTER TABLE gdo_rounds ADD COLUMN IF NOT EXISTS hands_json JSONB`);

  /* 阶段五迁移：gdo_rounds 加游戏进行中状态列（用于断线重连） */
  await query(`ALTER TABLE gdo_rounds ADD COLUMN IF NOT EXISTS current_hands_json JSONB`);
  await query(`ALTER TABLE gdo_rounds ADD COLUMN IF NOT EXISTS turn_state_json JSONB`);

  /* 六人赛事迁移：A级连败计数 + 进贡待处理信息 */
  await query(`ALTER TABLE gdo_rooms ADD COLUMN IF NOT EXISTS a_fails_team1 SMALLINT NOT NULL DEFAULT 0`);
  await query(`ALTER TABLE gdo_rooms ADD COLUMN IF NOT EXISTS a_fails_team2 SMALLINT NOT NULL DEFAULT 0`);
  await query(`ALTER TABLE gdo_rooms ADD COLUMN IF NOT EXISTS tribute_json JSONB`);
  await query(`ALTER TABLE gdo_rooms ADD COLUMN IF NOT EXISTS banker_team SMALLINT`);  // 坐庄队(级牌=其级数)

  console.log('✅ Database initialized');
}

module.exports = { query, queryOne, initDB };
