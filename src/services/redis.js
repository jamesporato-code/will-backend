const Redis = require('ioredis');
const logger = require('../utils/logger');

let redis = null;

function getRedis() {
  if (!redis) {
    if (process.env.REDIS_URL) {
      redis = new Redis(process.env.REDIS_URL, {
        maxRetriesPerRequest: 3,
        retryStrategy(times) {
          if (times > 3) return null;
          return Math.min(times * 200, 2000);
        },
      });
      redis.on('error', (err) => logger.warn('Redis erreur', err.message));
      redis.on('connect', () => logger.info('Redis connecte'));
    } else {
      logger.warn('REDIS_URL non defini - cache desactive');
      return {
        get: async () => null,
        set: async () => 'OK',
        setex: async () => 'OK',
        del: async () => 1,
        incr: async () => 1,
      };
    }
  }
  return redis;
}

async function cacheResponse(key, value, ttlSeconds = 3600) {
  const r = getRedis();
  await r.setex(`will:cache:${key}`, ttlSeconds, JSON.stringify(value));
}

async function getCachedResponse(key) {
  const r = getRedis();
  const cached = await r.get(`will:cache:${key}`);
  return cached ? JSON.parse(cached) : null;
}

async function deleteCache(key) {
  const r = getRedis();
  await r.del(`will:cache:${key}`);
}

module.exports = { getRedis, cacheResponse, getCachedResponse, deleteCache };
