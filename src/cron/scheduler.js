// ============================================
// SCHEDULER — Will Coach IA
// Flow quotidien par plan :
// - Trial (7 jours) : contenu mixe selon le jour J1..J7
//   J1-J2 parcours, J3 actu, J4 parcours, J5 outil, J6 prompt, J7 recap
// - Pro : menu quotidien (parcours / actu / outil ou prompt)
// + Crons :
//   - Reset compteur quotidien minuit Paris
//   - Relances trial (J+5, J+6, J+7, J+14)
// ============================================

const cron = require('node-cron');
const logger = require('../utils/logger');
const { query } = require('../db/pool');
const whatsapp = require('../services/whatsapp');
const contentTypes = require('../services/contentTypes');
const userService = require('../services/userService');
const { cacheResponse } = require('../services/redis');

function startDailyCron() {
  // Toutes les heures : envoi aux users dont l'heure preferee correspond
  cron.schedule('0 * * * *', async () => {
    const now = new Date();
    const parisHour = parseInt(now.toLocaleString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', hour12: false }), 10);
    logger.info('Cron horaire : verification pour ' + parisHour + 'h');
    await sendDailyMessages(parisHour);
  }, { timezone: 'Europe/Paris' });

  // Cron relances trial : tous les jours a 10h Paris
  cron.schedule('0 10 * * *', async () => {
    logger.info('Cron trial reminders : verification');
    await sendTrialReminders();
  }, { timezone: 'Europe/Paris' });

  // Cron reset compteur quotidien : minuit Paris
  cron.schedule('0 0 * * *', async () => {
    try {
      const result = await query(
        'UPDATE users SET daily_message_count = 0 WHERE daily_message_count > 0'
      );
      logger.info('Daily counter reset', { rowsAffected: result.rowCount });
    } catch (err) {
      logger.error('Erreur reset compteur quotidien', { error: err.message });
    }
  }, { timezone: 'Europe/Paris' });

  logger.info('Crons planifies : horaire + trial reminders (10h) + reset compteur (minuit)');
}

// ============================================
// DISPATCH QUOTIDIEN
// ============================================
async function sendDailyMessages(currentHour) {
  try {
    const usersResult = await query(
      `SELECT * FROM users
       WHERE onboarding_complete = true
       AND plan != 'cancelled'
       AND (plan != 'trial' OR created_at > NOW() - INTERVAL '7 days')
       AND daily_opt_in != false
       AND COALESCE(preferred_hour, 8) = $1`,
      [currentHour]
    );

    const users = usersResult.rows;
    logger.info(users.length + ' utilisateurs a notifier pour ' + currentHour + 'h');

    for (const user of users) {
      try {
        await updateStreak(user);

        if (user.plan === 'trial') {
          await sendTrialDaily(user);
        } else if (user.plan === 'pro') {
          await sendProMenu(user);
        }

        await new Promise(r => setTimeout(r, 500));
      } catch (err) {
        logger.error('Erreur envoi quotidien', { userId: user.id, wa: user.whatsapp_id, error: err.message });
      }
    }
  } catch (err) {
    logger.error('Erreur cron quotidien', { error: err.message });
  }
}

// ============================================
// TRIAL : contenu mixe selon le jour de l'essai
// J1 parcours, J2 parcours, J3 actu, J4 parcours, J5 outil, J6 prompt, J7 recap
// ============================================
function getTrialDay(user) {
  const created = new Date(user.created_at);
  const now = new Date();
  const days = Math.floor((now - created) / (1000 * 60 * 60 * 24));
  return Math.min(Math.max(days + 1, 1), 7);
}

async function sendTrialDaily(user) {
  const name = user.display_name?.split(' ')[0] || '';
  const trialDay = getTrialDay(user);

  let content = null;
  let contentType = '';
  let nextProgress = null;

  if (trialDay === 1 || trialDay === 2 || trialDay === 4) {
    const result = await contentTypes.generateParcours(user);
    if (result && result.text) {
      content = result.text;
      contentType = 'parcours';
      nextProgress = result.nextProgress;
    }
  } else if (trialDay === 3) {
    content = await contentTypes.generateActuIA(user);
    contentType = 'actu';
  } else if (trialDay === 5) {
    content = await contentTypes.generateOutilDuJour(user);
    contentType = 'outil';
  } else if (trialDay === 6) {
    content = await contentTypes.generatePromptDuJour(user);
    contentType = 'prompt';
  } else if (trialDay === 7) {
    content = await contentTypes.generateRecapHebdo(user);
    contentType = 'recap';
  }

  if (!content) {
    await whatsapp.sendText(user.whatsapp_id, 'Bonjour ' + name + ' ! Pose-moi une question sur l\'IA aujourd\'hui !');
    return;
  }

  await cacheResponse('daily:' + user.id, content, 86400);

  const buttons = contentType === 'recap'
    ? [
        { id: 'daily_deep', title: 'Voir mes stats' },
        { id: 'plan_pro', title: 'Passer Pro 6,99' },
      ]
    : [
        { id: 'daily_deep', title: 'J\'approfondis' },
        { id: 'daily_example', title: 'Exemple concret' },
        { id: 'daily_next', title: 'Notion suivante' },
      ];

  const footer = contentType === 'parcours' ? 'Ton parcours Will'
    : contentType === 'actu' ? 'Actu IA du jour'
    : contentType === 'outil' ? 'Outil du jour'
    : contentType === 'prompt' ? 'Prompt du jour'
    : 'Recap hebdo Will';

  await whatsapp.sendButtons(
    user.whatsapp_id,
    'Bonjour ' + name + ' !\n\n' + content,
    buttons, null, footer
  );

  if (nextProgress) {
    await query(
      'UPDATE users SET current_module = $1, module_progress = $2 WHERE id = $3',
      [nextProgress.current_module, JSON.stringify(nextProgress.module_progress), user.id]
    );
  }
  await userService.incrementDailyCount(user.id);
}

// ============================================
// PRO : menu quotidien (choix)
// ============================================
async function sendProMenu(user) {
  const name = user.display_name?.split(' ')[0] || '';

  const parisDate = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
  const jsDay = parisDate.getDay(); // 0=dim, 1=lun, ..., 6=sam

  // Dimanche : recap auto (pas de menu)
  if (jsDay === 0) {
    const recap = await contentTypes.generateRecapHebdo(user);
    if (recap) {
      await whatsapp.sendText(user.whatsapp_id, 'Bonjour ' + name + ' !\n\n' + recap);
    }
    return;
  }

  const { getCurrentSession } = require('../services/modules');
  const session = getCurrentSession(user);
  const pct = session?.overallPercent || 0;

  // Jeudi : Parcours / Actu / Prompt — autres jours : Parcours / Actu / Outil
  const buttons = jsDay === 4
    ? [
        { id: 'menu_parcours', title: 'Parcours (' + pct + '%)' },
        { id: 'menu_actu', title: 'Actu IA du jour' },
        { id: 'menu_prompt', title: 'Prompt du jour' },
      ]
    : [
        { id: 'menu_parcours', title: 'Parcours (' + pct + '%)' },
        { id: 'menu_actu', title: 'Actu IA du jour' },
        { id: 'menu_outil', title: 'Outil du jour' },
      ];

  await whatsapp.sendButtons(
    user.whatsapp_id,
    'Bonjour ' + name + ' ! Qu\'est-ce que tu veux faire ce matin ?',
    buttons,
    null, 'Menu Will Pro'
  );
}

// ============================================
// Choix du menu Pro (appele depuis webhook)
// ============================================
async function handleProMenuChoice(user, buttonId) {
  let content = null;
  let footer = '';
  let nextProgress = null;

  if (buttonId === 'menu_parcours') {
    const result = await contentTypes.generateParcours(user);
    if (result && result.text) {
      content = result.text;
      footer = 'Ton parcours Will';
      nextProgress = result.nextProgress;
    }
  } else if (buttonId === 'menu_actu') {
    content = await contentTypes.generateActuIA(user);
    footer = 'Actu IA du jour';
  } else if (buttonId === 'menu_outil') {
    content = await contentTypes.generateOutilDuJour(user);
    footer = 'Outil du jour';
  } else if (buttonId === 'menu_prompt') {
    content = await contentTypes.generatePromptDuJour(user);
    footer = 'Prompt du jour';
  }

  if (!content) {
    await whatsapp.sendText(user.whatsapp_id, 'Oups, petit bug ! Reessaie dans quelques secondes.');
    return;
  }

  await cacheResponse('daily:' + user.id, content, 86400);

  await whatsapp.sendButtons(
    user.whatsapp_id,
    content,
    [
      { id: 'daily_deep', title: 'J\'approfondis' },
      { id: 'daily_example', title: 'Exemple concret' },
      { id: 'daily_next', title: 'Notion suivante' },
    ],
    null, footer
  );

  if (nextProgress) {
    await query(
      'UPDATE users SET current_module = $1, module_progress = $2 WHERE id = $3',
      [nextProgress.current_module, JSON.stringify(nextProgress.module_progress), user.id]
    );
  }
  await userService.incrementDailyCount(user.id);
}

// ============================================
// STREAK
// ============================================
async function updateStreak(user) {
  try {
    const lastActivity = user.last_message_date;
    const today = new Date().toISOString().split('T')[0];

    if (lastActivity) {
      const lastDate = new Date(lastActivity).toISOString().split('T')[0];
      const diffDays = Math.floor((new Date(today) - new Date(lastDate)) / 86400000);
      if (diffDays === 1) {
        await query('UPDATE users SET streak = COALESCE(streak, 0) + 1 WHERE id = $1', [user.id]);
      } else if (diffDays > 1) {
        await query('UPDATE users SET streak = 1 WHERE id = $1', [user.id]);
      }
    } else {
      await query('UPDATE users SET streak = 1 WHERE id = $1', [user.id]);
    }
  } catch (err) {
    logger.error('Erreur update streak', { userId: user.id, error: err.message });
  }
}

// ============================================
// RELANCES TRIAL : J+5, J+6, J+7, J+14
// ============================================
async function sendTrialReminders() {
  try {
    await sendReminderBatch(5, 6,
      (name) => (name ? 'Salut ' + name + ' !\n\n' : '') +
        'Plus que 2 jours pour profiter de ton essai gratuit !\n\n' +
        'Tu as deja commence a decouvrir l\'IA avec Will. Continue ton parcours sans interruption.\n\n' +
        'Passe Pro pour garder acces a tout (6,99/mois) :',
      'trial_reminder_j5'
    );

    await sendReminderBatch(6, 7,
      (name) => (name ? name + ', ' : '') +
        'Dernier jour de ton essai gratuit !\n\n' +
        'Demain, ton acces sera coupe. Continue ton parcours Will sans interruption :',
      'trial_reminder_j6'
    );

    await sendReminderBatch(7, 8,
      (name) => 'Ton essai gratuit est termine !\n\n' +
        (name ? name + ', ' : '') +
        'Merci d\'avoir teste Will. Pour continuer a apprendre l\'IA au quotidien (parcours + actu + outils + prompts) :\n\n' +
        'Pro : 6,99/mois, sans engagement.',
      'trial_reminder_j7'
    );

    await sendReminderBatch(14, 15,
      (name) => (name ? name + ', ' : '') +
        'Ca fait 2 semaines que ton essai Will est termine.\n\n' +
        'L\'IA evolue vite. Reviens apprendre avec Will pour ne pas rater le train !\n\n' +
        'Dernier rappel, apres je te laisse tranquille.',
      'trial_reminder_j14'
    );

  } catch (err) {
    logger.error('Erreur cron trial reminders', { error: err.message });
  }
}

async function sendReminderBatch(minDays, maxDays, messageBuilder, reminderField) {
  try {
    const result = await query(
      `SELECT id, whatsapp_id, display_name FROM users
       WHERE plan = 'trial'
       AND onboarding_complete = true
       AND created_at <= NOW() - INTERVAL '${minDays} days'
       AND created_at > NOW() - INTERVAL '${maxDays} days'
       AND (${reminderField} IS NULL OR ${reminderField} = false)`,
      []
    );

    for (const user of result.rows) {
      try {
        const name = user.display_name?.split(' ')[0] || '';
        const msg = messageBuilder(name);

        await whatsapp.sendButtons(user.whatsapp_id, msg, [
          { id: 'plan_pro', title: 'Passer Pro 6,99' },
        ], null, 'Sans engagement');

        await query(`UPDATE users SET ${reminderField} = true WHERE id = $1`, [user.id]);
        logger.info('Trial reminder sent', { userId: user.id, type: reminderField });
        await new Promise(r => setTimeout(r, 500));
      } catch (err) {
        logger.error('Erreur reminder', { userId: user.id, type: reminderField, error: err.message });
      }
    }
  } catch (err) {
    logger.error('Erreur batch reminder ' + reminderField, { error: err.message });
  }
}

module.exports = { startDailyCron, sendDailyMessages, handleProMenuChoice };
