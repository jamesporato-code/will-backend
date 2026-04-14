const cron = require('node-cron');
const logger = require('../utils/logger');
const { query } = require('../db/pool');
const whatsapp = require('../services/whatsapp');
const claude = require('../services/claude');
const { cacheResponse, getCachedResponse } = require('../services/redis');
const userService = require('../services/userService');

function startDailyCron() {
  // Toutes les heures, on envoie aux utilisateurs dont l'heure préférée correspond
  cron.schedule('0 * * * *', async () => {
    const now = new Date();
    const parisHour = parseInt(now.toLocaleString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', hour12: false }), 10);
    logger.info('Cron horaire : vérification pour ' + parisHour + 'h');
    await sendDailyMessages(parisHour);
  }, { timezone: 'Europe/Paris' });

  logger.info('Cron planifié : vérification horaire des messages quotidiens');

  // Cron J-1 trial : tous les jours a 10h Paris, rappel aux users dont le trial expire demain
  cron.schedule('0 10 * * *', async () => {
    logger.info('Cron J-1 trial : verification');
    await sendTrialReminders();
  }, { timezone: 'Europe/Paris' });

  logger.info('Cron J-1 trial reminder planifie (10h Europe/Paris)');
}

async function sendDailyMessages(currentHour) {
  try {
    const usersResult = await query(
      `SELECT id, whatsapp_id, level, display_name, job, plan, preferred_hour
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
        await userService.incrementDailyCount(user.id);
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


// ============================================
// Envoi rappel J-1 aux users en trial qui expirent demain
// ============================================
async function sendTrialReminders() {
  try {
    // Users en trial, cree il y a 5-6 jours (trial = 7j donc J-1 = cree il y a 6j)
    // Pas encore recu de rappel
    const result = await query(`
      SELECT id, whatsapp_id, display_name, level, job
      FROM users
      WHERE plan = 'trial'
        AND onboarding_complete = true
        AND created_at <= NOW() - INTERVAL '6 days'
        AND created_at > NOW() - INTERVAL '7 days'
        AND (trial_reminder_sent IS NULL OR trial_reminder_sent = false)
    `);
    const users = result.rows;
    logger.info(users.length + ' users a notifier pour expiration J-1');

    for (const user of users) {
      try {
        const name = user.display_name?.split(' ')[0] || '';
        await whatsapp.sendText(user.whatsapp_id,
          (name ? 'Salut ' + name + ' ! \ud83d\udc4b\n\n' : '') +
          '\u23f3 *Ton essai gratuit expire demain !*\n\n' +
          'Pour continuer \u00e0 recevoir tes conseils IA personnalis\u00e9s, choisis un plan :\n\n' +
          '\ud83c\udf93 *\u00c9tudiant* \u2014 4,99\u20ac/mois (40 msg/jour)\n' +
          '\ud83d\ude80 *Pro* \u2014 7,99\u20ac/mois (illimit\u00e9 + priorit\u00e9)\n\n' +
          'Sans engagement. Tu peux annuler \u00e0 tout moment.'
        );
        await new Promise(r => setTimeout(r, 800));
        await whatsapp.sendButtons(user.whatsapp_id,
          'Choisis ton plan pour continuer avec Will \ud83d\udc47',
          [
            { id: 'plan_etudiant', title: '\u00c9tudiant 4,99\u20ac' },
            { id: 'plan_pro', title: 'Pro 7,99\u20ac' },
          ]
        );
        await query('UPDATE users SET trial_reminder_sent = true WHERE id = $1', [user.id]);
        logger.info('Trial J-1 reminder sent', { userId: user.id });
        await new Promise(r => setTimeout(r, 500));
      } catch (err) {
        logger.error('Erreur trial reminder', { userId: user.id, error: err.message });
      }
    }
  } catch (err) {
    logger.error('Erreur cron J-1 trial', { error: err.message });
  }
}

module.exports = { startDailyCron, sendDailyMessages };
