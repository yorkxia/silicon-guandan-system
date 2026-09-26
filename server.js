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

/* 兜底：Node 15+ 默认「未捕获的 Promise 拒绝」会直接终止整个进程——一旦某个边缘case漏了
   try/catch，就会瞬间踢掉全服所有房间的所有玩家（这比任何单个bug本身伤害都大）。
   这里只做"记录+不崩"，绝不能让一次孤立的业务错误变成全局断线事故；uncaughtException 属于
   状态可能已损坏的更严重情况，仍记录后让进程退出，交给 Render 自动重启（比静默失联更快恢复、
   且日志里能看到真实原因，而不是无迹可查的 OOM/无响应）。 */
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason && reason.stack || reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && err.stack || err);
  process.exit(1);
});

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  /* 默认 pingTimeout=20s/pingInterval=25s 对"手机切后台/微信内置浏览器挂起/服务端瞬时繁忙"
     太敏感，很容易把仍在场的玩家误判成掉线（进 40 秒宽限托管流程，体验上就是"莫名其妙被接管"）。
     放宽到 60s/25s：真正断网的玩家仍会在 85 秒内被判定掉线（现有 40 秒宽限托管完全覆盖得住），
     只是不再对短暂的网络抖动/后台节流过度敏感。 */
  pingTimeout: 60000,
  pingInterval: 25000
});

/* 每 5 分钟记录一次内存占用，供排查"长时间运行是否内存持续增长"——只打日志，不做任何决策，
   不影响主流程；Render 日志里能直接看到 rss/heapUsed 随时间的真实曲线，不用再凭空猜测。 */
setInterval(() => {
  const m = process.memoryUsage();
  const mb = (n) => (n / 1024 / 1024).toFixed(1);
  console.log(`[内存] rss=${mb(m.rss)}MB heapUsed=${mb(m.heapUsed)}MB heapTotal=${mb(m.heapTotal)}MB external=${mb(m.external)}MB`);
}, 5 * 60 * 1000);

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
