// ============================================
// SCHEDULER â Will Coach IA
// Flow quotidien par plan :
// - Trial : 1 session parcours/jour (module intro)
// - Etudiant : calendrier fixe (L/Me/V parcours, Ma/Je actu, Sa recap)
// - Pro : menu quotidien (choix du contenu)
// + Crons de relance trial (J+5, J+6, J+7, J+14)
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

  logger.info('Crons planifies : horaire + trial reminders (10h)');
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

    // Jour de la semaine (1=Lundi ... 7=Dimanche) en heure Paris
    const now = new Date();
    const dayOfWeek = parseInt(now.toLocaleString('fr-FR', { timeZone: 'Europe/Paris', weekday: 'short' }).substring(0, 3), 10);
    // Alternative plus fiable
    const parisDate = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
    const jsDay = parisDate.getDay(); // 0=dim, 1=lun, 2=mar, ...

    for (const user of users) {
      try {
        // Incrementer le streak
        await updateStreak(user);

        if (user.plan === 'trial') {
          await sendTrialDaily(user);
        } else if (user.plan === 'pro') {
          await sendProMenu(user, jsDay);
        } else {
          // etudiant (ou student)
          await sendEtudiantDaily(user, jsDay);
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
// TRIAL : 1 session parcours intro/jour
// ============================================
async function sendTrialDaily(user) {
  const name = user.display_name?.split(' ')[0] || '';
  const result = await contentTypes.generateParcours(user);
  if (!result || !result.text) {
    await whatsapp.sendText(user.whatsapp_id, 'Bonjour ' + name + ' ! Pose-moi une question sur l\'IA aujourd\'hui !');
    return;
  }

  await cacheResponse('daily:' + user.id, result.text, 86400);

  await whatsapp.sendButtons(
    user.whatsapp_id,
    'Bonjour ' + name + ' !\n\n' + result.text,
    [
      { id: 'daily_deep', title: 'J\'approfondis' },
      { id: 'daily_example', title: 'Exemple concret' },
      { id: 'daily_next', title: 'Notion suivante' },
    ],
    null, 'Ton parcours Will'
  );

  // Sauvegarder la progression
  if (result.nextProgress) {
    await query(
      'UPDATE users SET current_module = $1, module_progress = $2 WHERE id = $3',
      [result.nextProgress.current_module, JSON.stringify(result.nextProgress.module_progress), user.id]
    );
  }
  await userService.incrementDailyCount(user.id);
}

// ============================================
// ETUDIANT : calendrier fixe
// L=parcours, Ma=actu, Me=parcours, Je=actu, V=parcours, Sa=recap, Di=rien
// ============================================
async function sendEtudiantDaily(user, jsDay) {
  const name = user.display_name?.split(' ')[0] || '';

  // Dimanche = repos
  if (jsDay === 0) return;

  let content = null;
  let contentType = '';

  if (jsDay === 1 || jsDay === 3 || jsDay === 5) {
    // Lundi, Mercredi, Vendredi : Parcours structure (Type A)
    const result = await contentTypes.generateParcours(user);
    if (result && result.text) {
      content = result.text;
      contentType = 'parcours';
      if (result.nextProgress) {
        await query(
          'UPDATE users SET current_module = $1, module_progress = $2 WHERE id = $3',
          [result.nextProgress.current_module, JSON.stringify(result.nextProgress.module_progress), user.id]
        );
      }
    }
  } else if (jsDay === 2 || jsDay === 4) {
    // Mardi, Jeudi : Actu IA (Type B)
    content = await contentTypes.generateActuIA(user);
    contentType = 'actu';
  } else if (jsDay === 6) {
    // Samedi : Recap hebdo
    content = await contentTypes.generateRecapHebdo(user);
    contentType = 'recap';
  }

  if (!content) {
    await whatsapp.sendText(user.whatsapp_id, 'Bonjour ' + name + ' ! Pose-moi une question sur l\'IA !');
    return;
  }

  await cacheResponse('daily:' + user.id, content, 86400);

  const buttons = contentType === 'recap'
    ? [
        { id: 'daily_deep', title: 'Voir mes stats' },
        { id: 'daily_next', title: 'Teaser lundi' },
      ]
    : [
        { id: 'daily_deep', title: 'J\'approfondis' },
        { id: 'daily_example', title: 'Exemple concret' },
        { id: 'daily_next', title: 'Notion suivante' },
      ];

  const footer = contentType === 'parcours' ? 'Ton parcours Will'
    : contentType === 'actu' ? 'Actu IA du jour'
    : 'Recap hebdo Will';

  await whatsapp.sendButtons(
    user.whatsapp_id,
    'Bonjour ' + name + ' !\n\n' + content,
    buttons, null, footer
  );
  await userService.incrementDailyCount(user.id);
}

// ============================================
// PRO : menu quotidien (choix)
// ============================================
async function sendProMenu(user, jsDay) {
  const name = user.display_name?.split(' ')[0] || '';

  // Dimanche : recap auto (pas de menu)
  if (jsDay === 0) {
    const recap = await contentTypes.generateRecapHebdo(user);
    if (recap) {
      await whatsapp.sendText(user.whatsapp_id, 'Bonjour ' + name + ' !\n\n' + recap);
    }
    return;
  }

  // Calculer la progression du parcours pour le bouton
  const { getCurrentSession } = require('./modules');
  const session = getCurrentSession(user);
  const pct = session?.overallPercent || 0;

  // Le jeudi : Parcours / Actu / Prompt (pas d'outil)
  // Les autres jours : Parcours / Actu / Outil
  let buttons;
  if (jsDay === 4) {
    // Jeudi
    buttons = [
      { id: 'menu_parcours', title: 'Parcours (' + pct + '%)' },
      { id: 'menu_actu', title: 'Actu IA du jour' },
      { id: 'menu_prompt', title: 'Prompt du jour' },
    ];
  } else {
    buttons = [
      { id: 'menu_parcours', title: 'Parcours (' + pct + '%)' },
      { id: 'menu_actu', title: 'Actu IA du jour' },
      { id: 'menu_outil', title: 'Outil du jour' },
    ];
  }

  await whatsapp.sendButtons(
    user.whatsapp_id,
    'Bonjour ' + name + ' ! Qu\'est-ce que tu veux faire ce matin ?',
    buttons,
    null, 'Menu Will Pro'
  );
}

// ============================================
// Gerer le choix du menu Pro (appele depuis webhook)
// ============================================
async function handleProMenuChoice(user, buttonId) {
  let content = null;
  let footer = '';

  if (buttonId === 'menu_parcours') {
    const result = await contentTypes.generateParcours(user);
    if (result && result.text) {
      content = result.text;
      footer = 'Ton parcours Will';
      if (result.nextProgress) {
        await query(
          'UPDATE users SET current_module = $1, module_progress = $2 WHERE id = $3',
          [result.nextProgress.current_module, JSON.stringify(result.nextProgress.module_progress), user.id]
        );
      }
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
  await userService.incrementDailyCount(user.id);
}

// ============================================
// STREAK
// ============================================
async function updateStreak(user) {
  try {
    // Si le user a ete actif hier, incrementer le streak ; sinon, reset a 1
    const lastActivity = user.last_message_date;
    const today = new Date().toISOString().split('T')[0];

    if (lastActivity) {
      const lastDate = new Date(lastActivity).toISOString().split('T')[0];
      const diffDays = Math.floor((new Date(today) - new Date(lastDate)) / (86400000));
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
    // J+5 : "Plus que 2 jours"
    await sendReminderBatch(5, 6,
      (name) => (name ? 'Salut ' + name + ' !\n\n' : '') +
        'Plus que 2 jours pour profiter de ton essai gratuit !\n\n' +
        'Tu as deja commence a decouvrir l\'IA avec Will. Continue ton parcours sans interruption.\n\n' +
        'Passe au plan payant pour garder acces a tout :',
      'trial_reminder_j5'
    );

    // J+6 : "Dernier jour"
    await sendReminderBatch(6, 7,
      (name) => (name ? name + ', ' : '') +
        'Dernier jour de ton essai gratuit !\n\n' +
        'Demain, ton acces sera coupe. Continue ton parcours sans interruption :',
      'trial_reminder_j6'
    );

    // J+7 : "Essai termine"
    await sendReminderBatch(7, 8,
      (name) => 'Ton essai gratuit est termine !\n\n' +
        (name ? name + ', ' : '') +
        'Merci d\'avoir teste Will. Pour continuer a apprendre l\'IA au quotidien :\n\n' +
        'Etudiant : 4,99/mois (actu IA + parcours)\n' +
        'Pro : 7,99/mois (tout + outils + prompts du jour)',
      'trial_reminder_j7'
    );

    // J+14 : "Dernier rappel"
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
          { id: 'plan_etudiant', title: 'Etudiant 4,99' },
          { id: 'plan_pro', title: 'Pro 7,99' },
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
