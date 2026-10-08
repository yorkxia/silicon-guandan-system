/* 分布式改造 阶段2 · 大厅在线人数登记表
 * 只影响大厅显示的"在线人数"这个数字，不碰任何对局逻辑。
 *
 * 本地 Map 永远维护一份准确的"本实例"记录；Redis 可用时额外做 write-through 同步，
 * 读数优先用 Redis 的跨实例汇总，Redis 读/写失败时自动退化回本地计数——
 * 不会因为 Redis 抖动导致人数显示卡死或报错。*/
const redis = require('./redisClient');

const localMaps = { '4p': new Map(), '6p': new Map() };

function key(ns) { return 'gd:online:' + ns; }

async function join(ns, socketId, data) {
  localMaps[ns].set(socketId, data);
  if (redis) {
    try { await redis.hset(key(ns), socketId, JSON.stringify(data)); }
    catch (e) { console.error('[onlineRegistry] join Redis写入失败(本地已记):', e.message); }
  }
}

async function leave(ns, socketId) {
  localMaps[ns].delete(socketId);
  if (redis) {
    try { await redis.hdel(key(ns), socketId); }
    catch (e) { console.error('[onlineRegistry] leave Redis删除失败(本地已清):', e.message); }
  }
}

async function count(ns) {
  if (redis) {
    try { return await redis.hlen(key(ns)); }
    catch (e) { console.error('[onlineRegistry] count Redis读取失败，退化为本实例计数:', e.message); }
  }
  return localMaps[ns].size;
}

module.exports = { join, leave, count };
