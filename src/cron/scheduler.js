const cron = require('node-cron');
const logger = require('../utils/logger');
const { query } = require('../db/pool');
const whatsapp = require('../services/whatsapp');

function startDailyCron() {
  // Tous les jours a 8h (lundi au dimanche)
  cron.schedule('0 8 * * *', async () => {
    logger.info('Cron : envoi des messages quotidiens');
    await sendDailyMessages();
  }, { timezone: 'Europe/Paris' });

  logger.info('Cron planifie : messages quotidiens a 8h (lun-dim)');
}

async function sendDailyMessages() {
  try {
    const dayOfWeek = new Date().getDay(); // 0 = Dimanche, 1 = Lundi, ... 6 = Samedi

    const usersResult = await query(
      "SELECT id, whatsapp_id, level, display_name, plan FROM users WHERE onboarding_complete = true AND plan != 'cancelled' AND (plan != 'trial' OR trial_ends_at > NOW())"
    );
    const users = usersResult.rows;
    logger.info(users.length + ' utilisateurs a notifier');

    for (const user of users) {
      try {
        const contentResult = await query(
          'SELECT * FROM daily_content WHERE day_of_week = $1 AND level = $2 AND published_at = CURRENT_DATE LIMIT 1',
          [dayOfWeek, user.level]
        );

        const name = user.display_name?.split(' ')[0] || '';

        if (contentResult.rows.length > 0) {
          const content = contentResult.rows[0];
          const greeting = 'Bonjour ' + name + ' !\n\n';

          if (content.buttons) {
            const buttons = typeof content.buttons === 'string' ? JSON.parse(content.buttons) : content.buttons;
            await whatsapp.sendButtons(user.whatsapp_id, greeting + content.body, buttons, content.title);
          } else {
            await whatsapp.sendText(user.whatsapp_id, greeting + content.body);
          }
        } else {
          await whatsapp.sendText(user.whatsapp_id,
            'Bonjour ' + name + ' !\n\nUne question IA pour toi ce matin : as-tu essaye un nouvel outil IA cette semaine ?\n\nReponds-moi, je suis curieux !'
          );
        }

        await new Promise(resolve => setTimeout(resolve, 200));
      } catch (err) {
        logger.error('Erreur envoi quotidien a ' + user.whatsapp_id, err.message);
      }
    }

    logger.info('Messages quotidiens envoyes');
  } catch (err) {
    logger.error('Erreur cron quotidien', err);
  }
}

module.exports = { startDailyCron, sendDailyMessages };
