const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');

router.post('/webhook', async (req, res) => {
  logger.info('Stripe webhook recu (placeholder)');
  res.sendStatus(200);
});

module.exports = router;
