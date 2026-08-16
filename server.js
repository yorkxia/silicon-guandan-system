require('dotenv').config();
const http = require('http');
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const helmet = require('helmet');
const path = require('path');
const { Server } = require('socket.io');
const { initDB } = require('./db/init');
const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');
const guandanRoutes = require('./routes/guandan');
const otStaffRoutes = require('./routes/otStaff');
const internalRoutes = require('./routes/internal');
const botRunner = require('./socket/botRunner');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

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
  res.locals.otStaff = req.session.otStaff || null;
  next();
});

app.get('/promo.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'promo.html')));
app.use('/', publicRoutes);
app.use('/', internalRoutes);
app.use('/admin', adminRoutes);
app.use('/guandan', guandanRoutes);
app.use('/ot-staff', otStaffRoutes);

/* Socket.io 事件处理 */
require('./socket/index')(io);

const PORT = process.env.PORT || 3000;
/* 先绑定端口(让 Render 健康检查立即通过、绝不卡在 deploying)，再后台初始化数据库/机器人。
   DB 初始化失败也不再 process.exit(退出会导致崩溃循环、部署永远转圈)，只记录、保持监听。*/
server.listen(PORT, () => {
  console.log(`\n✅ 掼蛋比赛系统已监听端口 ${PORT}，正在初始化数据库…`);
  initDB().then(() => {
    try { botRunner.init(io); } catch (e) { console.error('[botsim] init 失败:', e.message); }
    console.log(`   ✅ 数据库就绪 | 管理后台 /admin/login | 计分器 /guandan | 网上赛事 /play`);
    console.log(`   RESEND_API_KEY: ${process.env.RESEND_API_KEY ? '✅ set' : '❌ NOT SET'} | EMAIL_FROM: ${process.env.EMAIL_FROM || '(not set)'}\n`);
  }).catch(err => {
    console.error('❌ 数据库初始化失败（服务保持监听，可稍后修复重试，不退出以免部署卡死）:', err && (err.message || err));
  });
}).on('error', (err) => {
  console.error('❌ 端口监听失败:', err && (err.message || err));
  process.exit(1);
});
