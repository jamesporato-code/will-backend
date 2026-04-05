require('dotenv').config();
const express = require('express');
const path = require('path');
const logger = require('./utils/logger');
const webhookRoutes = require('./routes/webhook');
const stripeRoutes = require('./routes/stripe');
const adminRoutes = require('./routes/admin');
const { initDB } = require('./db/pool');
const { startDailyCron } = require('./cron/scheduler');

const app = express();
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// Fichiers statiques (dashboard admin)
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Will - Coach IA WhatsApp', version: '1.1.0' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
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

