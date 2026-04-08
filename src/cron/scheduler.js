const cron = require('node-cron');
const logger = require('../utils/logger');
const { query } = require('../db/pool');
const whatsapp = require('../services/whatsapp');
const claude = require('../services/claude');
const { cacheResponse, getCachedResponse } = require('../services/redis');

function startDailyCron() {
  // Toutes les heures, on envoie aux utilisateurs dont l'heure préférée correspond
  cron.schedule('0 * * * *', async () => {
    const now = new Date();
    const parisHour = parseInt(now.toLocaleString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', hour12: false }), 10);
    logger.info('Cron horaire : vérification pour ' + parisHour + 'h');
    await sendDailyMessages(parisHour);
  }, { timezone: 'Europe/Paris' });

  logger.info('Cron planifié : vérification horaire des messages quotidiens');
}

async function sendDailyMessages(currentHour) {
  try {
    const usersResult = await query(
      `SELECT id, whatsapp_id, level, display_name, job, plan, preferred_hour
       FROM users
       WHERE onboarding_complete = true
         AND daily_opt_in IS NOT false
         AND plan != 'cancelled'
         AND (plan != 'trial' OR trial_ends_at > NOW())
         AND COALESCE(preferred_hour, 8) = $1`,
      [currentHour]
    );

    const users = usersResult.rows;
    logger.info(users.length + ' utilisateurs \u00e0 notifier pour ' + currentHour + 'h');

    for (const user of users) {
      try {
        const name = user.display_name?.split(' ')[0] || '';

        // G\u00e9n\u00e9rer le contenu quotidien via Claude
        const dailyContent = await claude.generateDailyContent({
          displayName: name,
          level: user.level || 'd\u00e9butant',
          job: user.job || '',
        });

        if (!dailyContent) {
          // Fallback si Claude fail
          await whatsapp.sendText(
            user.whatsapp_id,
            'Bonjour ' + name + ' ! \ud83d\udc4b\n\nUne question IA pour toi : as-tu essay\u00e9 un nouvel outil IA cette semaine ?\n\nR\u00e9ponds-moi, je suis curieux ! \ud83e\udd14'
          );
        } else {
          const greeting = 'Bonjour ' + name + ' ! \ud83d\udc4b\n\n';

          // Stocker le contenu dans Redis pour les boutons de suivi (TTL 24h)
          await cacheResponse('daily:' + user.id, dailyContent, 86400);

          // Envoyer avec boutons interactifs
          await whatsapp.sendButtons(
            user.whatsapp_id,
            greeting + dailyContent,
            [
              { id: 'daily_deep', title: "J'approfondis \ud83d\udd0d" },
              { id: 'daily_example', title: 'Exemple concret \ud83d\udcbc' },
              { id: 'daily_next', title: 'Notion suivante \u27a1\ufe0f' },
            ],
            null,
            'Ton daily IA personnalis\u00e9'
          );
        }

        // Pause entre les envois pour respecter les rate limits
        await new Promise(resolve => setTimeout(resolve, 500));
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
