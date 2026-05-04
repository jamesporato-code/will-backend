require('dotenv').config();
const express = require('express');
const path = require('path');
const logger = require('./utils/logger');
const webhookRoutes = require('./routes/webhook');
const stripeRoutes = require('./routes/stripe');
const adminRoutes = require('./routes/admin');
const { initDB, query } = require('./db/pool');
const { getRedis } = require('./services/redis');
const { startDailyCron } = require('./cron/scheduler');

const app = express();
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// Fichiers statiques (dashboard admin)
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Will - Coach IA WhatsApp', version: '1.1.0' });
});

// Health endpoint complet : check DB + Redis. Renvoie 503 si quelque chose
// est down (UptimeRobot s'en sert pour alerter).
app.get('/health', async (req, res) => {
  const checks = { db: false, redis: false };
  try {
    await query('SELECT 1');
    checks.db = true;
  } catch (err) {
    logger.error('Health check DB failed', { error: err.message });
  }
  try {
    const r = getRedis();
    if (typeof r.ping === 'function') {
      const pong = await r.ping();
      checks.redis = pong === 'PONG';
    } else {
      // Stub fallback (REDIS_URL non defini) : on considere OK pour ne pas alerter
      checks.redis = true;
    }
  } catch (err) {
    logger.error('Health check Redis failed', { error: err.message });
  }
  const healthy = checks.db && checks.redis;
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'healthy' : 'degraded',
    checks,
    timestamp: new Date().toISOString(),
  });
});

app.use('/api/webhook', webhookRoutes);
app.use('/api/stripe', stripeRoutes);
app.use('/api/admin', adminRoutes);

const PORT = process.env.PORT || 3000;

async function start() {
  try {
    await initDB();
    logger.info('Base de donnees connectee');
    app.listen(PORT, () => {
      logger.info(`Will backend en ecoute sur le port ${PORT}`);
    });
    startDailyCron();
  } catch (err) {
    logger.error('Erreur au demarrage', err);
    process.exit(1);
  }
}

start();

