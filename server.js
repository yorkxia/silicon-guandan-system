require('dotenv').config();
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const helmet = require('helmet');
const path = require('path');
const { initDB } = require('./db/init');
const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');
const scoreboardRoutes = require('./routes/scoreboard');
const guandanRoutes = require('./routes/guandan');
const intelligenceRoutes = require('./routes/intelligence');

const app = express();

app.use(helmet({ contentSecurityPolicy: false }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.use(express.json({ limit: '5mb' }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'guandan-secret-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

app.use(flash());

app.use((req, res, next) => {
  res.locals.success = req.flash('success');
  res.locals.error = req.flash('error');
  res.locals.user = req.session.user || null;
  next();
});

app.use('/', publicRoutes);
app.use('/admin', adminRoutes);
app.use('/scoreboard', scoreboardRoutes);
app.use('/scoreboard/intelligence', intelligenceRoutes);
app.use('/guandan', guandanRoutes);

const PORT = process.env.PORT || 3000;
initDB().then(async () => {
  const { startScheduler } = require('./utils/scheduler');
  await startScheduler().catch(e => console.error('Scheduler init error:', e.message));
  app.listen(PORT, () => {
    console.log(`\n✅ 掼蛋比赛系统已启动 | Guandan Tournament System running`);
    console.log(`   访问地址 URL: http://localhost:${PORT}`);
    console.log(`   管理后台 Admin: http://localhost:${PORT}/admin/login`);
    console.log(`   监控系统 Monitor: http://localhost:${PORT}/scoreboard/login`);
    console.log(`   掼蛋计分器 Game:   http://localhost:${PORT}/guandan`);
    console.log(`   默认账号 Default: admin / Admin2025!`);
    console.log(`   RESEND_API_KEY: ${process.env.RESEND_API_KEY ? '✅ set' : '❌ NOT SET'}`);
    console.log(`   EMAIL_FROM: ${process.env.EMAIL_FROM || '(not set)'}\n`);
  });
}).catch(err => {
  console.error('❌ Database init failed:', err);
  process.exit(1);
});
