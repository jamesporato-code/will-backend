const cron = require('node-cron');
const logger = require('../utils/logger');
const { query } = require('../db/pool');
const whatsapp = require('../services/whatsapp');

function startDailyCron() {
  // Toutes les heures, on envoie aux utilisateurs dont l'heure pr\u00e9f\u00e9r\u00e9e correspond
  cron.schedule('0 * * * *', async () => {
    const now = new Date();
    const parisHour = parseInt(now.toLocaleString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', hour12: false }), 10);
    logger.info('Cron horaire : v\u00e9rification pour ' + parisHour + 'h');
    await sendDailyMessages(parisHour);
  }, { timezone: 'Europe/Paris' });

  logger.info('Cron planifi\u00e9 : v\u00e9rification horaire des messages quotidiens');
}

async function sendDailyMessages(currentHour) {
  try {
    const dayOfWeek = new Date().getDay(); // 0 = Dimanche, 1 = Lundi, ... 6 = Samedi

    const usersResult = await query(
      `SELECT id, whatsapp_id, level, display_name, plan, preferred_hour
       FROM users
       WHERE onboarding_complete = true
         AND plan != 'cancelled'
         AND (plan != 'trial' OR trial_ends_at > NOW())
         AND COALESCE(preferred_hour, 8) = $1`,
      [currentHour]
    );

    const users = usersResult.rows;
    logger.info(users.length + ' utilisateurs \u00e0 notifier pour ' + currentHour + 'h');

    for (const user of users) {
      try {
        const contentResult = await query(
          'SELECT * FROM daily_content WHERE day_of_week = $1 AND level = $2 AND published_at = CURRENT_DATE LIMIT 1',
          [dayOfWeek, user.level]
        );

        const name = user.display_name?.split(' ')[0] || '';

        if (contentResult.rows.length > 0) {
          const content = contentResult.rows[0];
          const greeting = 'Bonjour ' + name + ' ! \u{1F44B}\n\n';

          if (content.buttons) {
            const buttons = typeof content.buttons === 'string'
              ? JSON.parse(content.buttons)
              : content.buttons;
            await whatsapp.sendButtons(user.whatsapp_id, greeting + content.body, buttons, content.title);
          } else {
            await whatsapp.sendText(user.whatsapp_id, greeting + content.body);
          }
        } else {
          await whatsapp.sendText(user.whatsapp_id,
            'Bonjour ' + name + ' ! \u{1F44B}\n\nUne question IA pour toi : as-tu essay\u00e9 un nouvel outil IA cette semaine ?\n\nR\u00e9ponds-moi, je suis curieux ! \u{1F914}'
          );
        }

        await new Promise(resolve => setTimeout(resolve, 200));
      } catch (err) {
        logger.error('Erreur envoi quotidien \u00e0 ' + user.whatsapp_id, err.message);
      }
    }

    logger.info('Messages quotidiens envoy\u00e9s pour ' + currentHour + 'h');
  } catch (err) {
    logger.error('Erreur cron quotidien', err);
  }
}

module.exports = { startDailyCron, sendDailyMessages };

