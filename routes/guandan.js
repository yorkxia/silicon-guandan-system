const express = require('express');
const router = express.Router();
const { query } = require('../db/init');
const { geoLocate, ipHash } = require('../utils/geo');

// 掼蛋计分器（服务端渲染版）
router.get('/', async (req, res) => {
  try {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip;
    const geo = await geoLocate(ip);
    const now = new Date();

    // 服务端记录访问（fire and forget）
    query(
      'INSERT INTO sb_visits (ip_hash, country, region_code, city, page, user_agent) VALUES ($1,$2,$3,$4,$5,$6)',
      [ipHash(ip), geo.country, geo.region_code, geo.city, 'guandan', (req.headers['user-agent'] || '').slice(0, 200)]
    ).catch(() => {});

    // 查询本区域广告（服务端直接注入，无需客户端 fetch）
    const ads = await query(`
      SELECT a.*, r.area_code as r_code FROM sb_ads a
      LEFT JOIN sb_regions r ON r.id = a.region_id
      WHERE a.is_active = 1
        AND (a.start_time IS NULL OR a.start_time <= $1)
        AND (a.end_time IS NULL OR a.end_time >= $1)
        AND (
          a.region_id IS NULL
          OR r.area_code = 'GLOBAL'
          OR r.area_code = $2
        )
      ORDER BY
        CASE WHEN r.area_code = $2 THEN 0 ELSE 1 END,
        CASE WHEN a.frequency_minutes IS NOT NULL THEN 0 ELSE 1 END,
        a.frequency_minutes ASC NULLS LAST,
        a.created_at DESC
    `, [now, geo.region_code]).catch(() => []);

    res.render('guandan', { ads, geo });
  } catch (e) {
    console.error('Guandan route error:', e.message);
    res.render('guandan', { ads: [], geo: {} });
  }
});

module.exports = router;
