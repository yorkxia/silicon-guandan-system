/* 分布式改造 阶段2 · 共享 Redis 客户端
 * 未配置 REDIS_URL 时导出 null——调用方（rateGuard/onlineRegistry）必须各自降级为
 * 单实例内存模式，保证没有 Redis 时行为与改造前完全一致，可以先部署这批代码，
 * 之后再单独去 Render 开 Key Value 实例、补上 REDIS_URL，不用两次改代码。
 *
 * enableOfflineQueue:false + maxRetriesPerRequest 小值：Redis 抖动/断线时命令快速
 * 失败(reject)而不是排队等重连，配合调用方的 try/catch fail-open，保证 Redis 故障
 * 不会拖慢或卡住真实玩家的操作。*/
let client = null;

if (process.env.REDIS_URL) {
  try {
    const Redis = require('ioredis');
    client = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
      connectTimeout: 5000,
    });
    client.on('error', (e) => console.error('[Redis]', e.message));
    client.on('connect', () => console.log('[Redis] 已连接'));
  } catch (e) {
    console.error('[Redis] 初始化失败，相关功能降级为单实例内存模式:', e.message);
    client = null;
  }
}

module.exports = client;
