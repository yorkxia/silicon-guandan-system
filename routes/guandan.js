const express = require('express');
const router = express.Router();
const { query, queryOne } = require('../db/init');
const { geoLocate, ipHash } = require('../utils/geo');

// 掼蛋计分器（服务端渲染版）
router.get('/', async (req, res) => {
  try {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip;
    const geo = await geoLocate(ip);
    const now = new Date();

    // 服务端记录访问，拿到这条访问行的 id 传给前端：前端起名后按 id 精确回填昵称，
    // 不再靠 IP+时间窗口猜「哪一行是这次访问」(移动网络 IP 会漂移，猜不准就导致监控台昵称永远空着)。
    let visitId = null;
    try {
      const row = await queryOne(
        'INSERT INTO sb_visits (ip_hash, country, region_code, city, page, user_agent) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
        [ipHash(ip), geo.country, geo.region_code, geo.city, 'guandan', (req.headers['user-agent'] || '').slice(0, 200)]
      );
      visitId = row ? row.id : null;
    } catch (e) { /* 访问记录失败不影响页面渲染 */ }

    // 查询本区域广告（服务端直接注入，无需客户端 fetch）
    const ads = await query(`
      SELECT a.*, r.area_code as r_code FROM sb_ads a
      LEFT JOIN sb_regions r ON r.id = a.region_id
      WHERE a.is_active = 1
        AND (a.start_time IS NULL OR a.start_time <= $1)
        AND (a.end_time IS NULL OR a.end_time >= $1)
        AND (
          a.region_ids IS NULL OR a.region_ids = ''
          OR EXISTS (SELECT 1 FROM sb_regions rr
                     WHERE rr.id = ANY(string_to_array(a.region_ids, ',')::int[])
                       AND (rr.area_code = 'GLOBAL' OR rr.area_code = $2))
        )
        AND (a.placements IS NULL OR a.placements = '' OR 'scorer' = ANY(string_to_array(a.placements, ',')))
      ORDER BY
        CASE WHEN r.area_code = $2 THEN 0 ELSE 1 END,
        CASE WHEN a.frequency_minutes IS NOT NULL THEN 0 ELSE 1 END,
        a.frequency_minutes ASC NULLS LAST,
        a.created_at DESC
    `, [now, geo.region_code]).catch(() => []);

    res.render('guandan', { ads, geo, visitId });
  } catch (e) {
    console.error('Guandan route error:', e.message);
    res.render('guandan', { ads: [], geo: {}, visitId: null });
  }
});

module.exports = router;
