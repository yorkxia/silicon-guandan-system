/* 内部保活 / 机器人测试系统控制端点
 * - GET /internal/bot-tick?key=xxx
 *     供【外部定时器】(GitHub Actions / UptimeRobot 等)每 ≤14 分钟访问一次：
 *       ① 这一次"外部进来的请求"让 Render 免费实例保持唤醒(不休眠)；
 *       ② 顺带对齐机器人开关(poll)，Render 冷启后能自愈恢复机器人。
 * - GET /internal/bot-control?key=xxx&action=start|stop
 *     便捷启停(也可由监控台直接改 gd_settings.bot_sim_enabled)。
 * key 校验：process.env.BOT_TICK_KEY || process.env.BOT_SECRET || 默认值。
 */
const express = require('express');
const router = express.Router();
const { query } = require('../db/init');
const botRunner = require('../socket/botRunner');

function keyOK(req) {
  const need = process.env.BOT_TICK_KEY || process.env.BOT_SECRET || 'guandan-botsim-2026';
  return (req.query.key || '') === need;
}

async function getStatus() {
  try {
    const r = await query("SELECT sval FROM gd_settings WHERE skey='bot_sim_status'");
    return r && r.length && r[0].sval ? JSON.parse(r[0].sval) : null;
  } catch (e) { return null; }
}

router.get('/internal/bot-tick', async (req, res) => {
  if (!keyOK(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
  try { await botRunner.poll(); } catch (e) {}      // 对齐开关 + 写状态 + 每日清理判定
  const status = await getStatus();
  res.json({ ok: true, awake: true, ts: Date.now(), status });
});

router.get('/internal/bot-control', async (req, res) => {
  if (!keyOK(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
  const action = (req.query.action || '').toLowerCase();
  if (action !== 'start' && action !== 'stop') return res.status(400).json({ ok: false, error: 'action must be start|stop' });
  try {
    await query(
      `INSERT INTO gd_settings(skey,sval,updated_at) VALUES('bot_sim_enabled',$1,NOW())
       ON CONFLICT (skey) DO UPDATE SET sval=$1, updated_at=NOW()`,
      [action === 'start' ? '1' : '0']
    );
    await botRunner.poll();
    res.json({ ok: true, action, status: await getStatus() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
