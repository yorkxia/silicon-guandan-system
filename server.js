// Suppress experimental SQLite warning (Node.js built-in sqlite module)
process.removeAllListeners('warning');
process.on('warning', (w) => { if (!w.message.includes('SQLite')) process.stderr.write(w.toString() + '\n'); });

require('dotenv').config();
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const helmet = require('helmet');
const path = require('path');
const { initDB } = require('./db/init');
const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');

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

initDB();

app.use('/', publicRoutes);
app.use('/admin', adminRoutes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✅ 掼蛋比赛系统已启动 | Guandan Tournament System running`);
  console.log(`   访问地址 URL: http://localhost:${PORT}`);
  console.log(`   管理后台 Admin: http://localhost:${PORT}/admin/login`);
  console.log(`   默认账号 Default: admin / Admin2025!\n`);
});
