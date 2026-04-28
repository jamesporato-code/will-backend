// ============================================
// SCHEDULER — Will Coach IA
//
// Architecture module-centric (le parcours = colonne vertébrale)
//
// Trial (7 jours) — dégustation du Module 1 :
//   J1..J5 : sessions 1 à 5 du Module 1 (Introduction à l'IA)
//   J6     : aperçu actu IA + teaser d'un prompt utile
//   J7     : récap de la semaine + invitation à passer Pro
//
// Pro — parcours complet :
//   Lundi → Samedi : prochaine session du module courant
//   Dimanche       : récap hebdo
//   Quand les 10 modules sont terminés : rotation hebdo
//     Lun/Mer/Ven : actu IA
//     Mar/Jeu/Sam : outil du jour
//     Dim         : récap
//
// Crons :
//   - Toutes les heures : envoi aux users dont preferred_hour matche l'heure Paris
//   - 10h Paris : relances trial (J5/J6/J7/J14)
//   - Minuit Paris : reset compteur quotidien
// ============================================

const cron = require('node-cron');
const logger = require('../utils/logger');
const { query } = require('../db/pool');
const whatsapp = require('../services/whatsapp');
const contentTypes = require('../services/contentTypes');
const userService = require('../services/userService');
const { cacheResponse } = require('../services/redis');
const { getCurrentSession } = require('../services/modules');

function startDailyCron() {
  // Toutes les heures : envoi aux users dont l'heure préférée correspond
  cron.schedule('0 * * * *', async () => {
    const now = new Date();
    const parisHour = parseInt(
      now.toLocaleString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', hour12: false }),
      10
    );
    logger.info('Cron horaire : vérification pour ' + parisHour + 'h');
    await sendDailyMessages(parisHour);
  }, { timezone: 'Europe/Paris' });

  // Cron relances trial : tous les jours à 10h Paris
  cron.schedule('0 10 * * *', async () => {
    logger.info('Cron trial reminders : vérification');
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

  logger.info('Crons planifiés : horaire + trial reminders (10h) + reset compteur (minuit)');
}

// ============================================
// DISPATCH HORAIRE — appelé par le cron
// ============================================
async function sendDailyMessages(currentHour) {
  try {
    const usersResult = await query(
      `SELECT id FROM users
       WHERE onboarding_complete = true
       AND plan IN ('trial', 'pro')
       AND (plan != 'trial' OR created_at > NOW() - INTERVAL '7 days')
       AND daily_opt_in != false
       AND COALESCE(preferred_hour, 8) = $1`,
      [currentHour]
    );

    const ids = usersResult.rows.map(r => r.id);
    logger.info(ids.length + ' utilisateurs à notifier pour ' + currentHour + 'h');

    for (const userId of ids) {
      const result = await sendDailyForUser(userId);
      if (!result.ok) {
        logger.error('Échec envoi quotidien', { userId, error: result.error });
      }
      await new Promise(r => setTimeout(r, 500));
    }
  } catch (err) {
    logger.error('Erreur cron quotidien', { error: err.message });
  }
}

// ============================================
// DISPATCH PAR USER — source unique de vérité
// Appelé par : cron, onboarding (1er daily), admin trigger-daily
// Retourne { ok, error?, type? }
// ============================================
async function sendDailyForUser(userId, opts = {}) {
  try {
    const userResult = await query('SELECT * FROM users WHERE id = $1', [userId]);
    const user = userResult.rows[0];
    if (!user) return { ok: false, error: 'user not found' };

    if (!user.whatsapp_id) return { ok: false, error: 'user has no whatsapp_id' };

    await updateStreak(user);

    if (user.plan === 'trial') {
      return await sendTrialDaily(user, opts);
    }
    if (user.plan === 'pro') {
      return await sendProDaily(user, opts);
    }
    return { ok: false, error: 'plan ' + user.plan + ' inactive (no daily)' };
  } catch (err) {
    logger.error('sendDailyForUser exception', { userId, error: err.message, stack: err.stack });
    return { ok: false, error: err.message };
  }
}

// ============================================
// TRIAL — 7 jours = dégustation Module 1
// ============================================
function getTrialDay(user) {
  const created = new Date(user.created_at);
  const now = new Date();
  const days = Math.floor((now - created) / (1000 * 60 * 60 * 24));
  return Math.min(Math.max(days + 1, 1), 7);
}

async function sendTrialDaily(user, opts = {}) {
  const name = user.display_name?.split(' ')[0] || '';
  const greet = name ? 'Bonjour ' + name + '.' : 'Bonjour.';
  // opts.first force le jour 1 quand l'onboarding vient juste de finir
  const trialDay = opts.first ? 1 : getTrialDay(user);

  // J1 → J5 : sessions du Module 1
  if (trialDay >= 1 && trialDay <= 5) {
    const result = await contentTypes.generateParcours(user);
    if (!result || !result.text) {
      return await sendFallback(user, greet, 'parcours generation failed');
    }

    const intro = opts.first
      ? greet + ' On démarre ton parcours.'
      : greet + ' Voici ta session du jour.';

    await cacheResponse('daily:' + user.id, result.text, 86400);
    // Body sendButtons limité à 1024 chars côté Meta → on split en 2 messages.
    await whatsapp.sendText(user.whatsapp_id, intro + '\n\n' + result.text);
    await new Promise(r => setTimeout(r, 800));
    await whatsapp.sendButtons(
      user.whatsapp_id,
      'Que veux-tu faire ensuite ?',
      [
        { id: 'daily_deep', title: 'J\'approfondis' },
        { id: 'daily_example', title: 'Exemple concret' },
        { id: 'daily_next', title: 'Notion suivante' },
      ],
      null,
      'Module 1 · Session ' + trialDay + '/5'
    );

    if (result.nextProgress) {
      await query(
        'UPDATE users SET current_module = $1, module_progress = $2 WHERE id = $3',
        [result.nextProgress.current_module, JSON.stringify(result.nextProgress.module_progress), user.id]
      );
    }
    await userService.incrementDailyCount(user.id);
    return { ok: true, type: 'trial_parcours', day: trialDay };
  }

  // J6 : aperçu (actu IA + teaser prompt)
  if (trialDay === 6) {
    const actu = await contentTypes.generateActuIA(user);
    if (!actu) {
      return await sendFallback(user, greet, 'actu generation failed');
    }
    await cacheResponse('daily:' + user.id, actu, 86400);
    await whatsapp.sendText(
      user.whatsapp_id,
      greet + ' Aujourd\'hui un aperçu de ce que tu reçois en Pro : l\'actu IA du jour.\n\n' + actu
    );
    await new Promise(r => setTimeout(r, 800));
    await whatsapp.sendButtons(
      user.whatsapp_id,
      'On creuse ?',
      [
        { id: 'daily_deep', title: 'J\'approfondis' },
        { id: 'plan_pro', title: 'Voir l\'offre Pro' },
      ],
      null,
      'Aperçu Pro · Actu IA'
    );
    await userService.incrementDailyCount(user.id);
    return { ok: true, type: 'trial_preview' };
  }

  // J7 : récap + invitation Pro
  if (trialDay === 7) {
    const recap = await contentTypes.generateRecapHebdo(user);
    const body = recap
      ? recap + '\n\nDemain ton essai se termine. Pour continuer le parcours (Modules 2 à 10), passe Pro à 6,99 €/mois.'
      : greet + ' Ton essai se termine demain. Tu as découvert le Module 1 (Introduction à l\'IA). Pour continuer (Modules 2 à 10, actu, outils, prompts), passe Pro à 6,99 €/mois.';

    await whatsapp.sendButtons(
      user.whatsapp_id,
      body,
      [
        { id: 'plan_pro', title: 'Passer Pro 6,99' },
        { id: 'menu_account', title: 'Mon compte' },
      ],
      null,
      'Dernier jour d\'essai'
    );
    await userService.incrementDailyCount(user.id);
    return { ok: true, type: 'trial_recap' };
  }

  return { ok: false, error: 'trial day out of range: ' + trialDay };
}

// ============================================
// PRO — parcours complet + rotation post-parcours
// ============================================
async function sendProDaily(user, opts = {}) {
  const name = user.display_name?.split(' ')[0] || '';
  const greet = name ? 'Bonjour ' + name + '.' : 'Bonjour.';

  const parisDate = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
  const jsDay = parisDate.getDay(); // 0=dim, 1=lun, ..., 6=sam

  // Vérifie si le parcours est terminé
  const session = getCurrentSession(user);
  const parcoursDone = !session || session.done === true;

  // Dimanche : récap (parcours en cours) ou rotation (parcours fini)
  if (jsDay === 0) {
    const recap = await contentTypes.generateRecapHebdo(user);
    if (recap) {
      await whatsapp.sendText(user.whatsapp_id, greet + '\n\n' + recap);
      await userService.incrementDailyCount(user.id);
      return { ok: true, type: 'pro_recap' };
    }
    return await sendFallback(user, greet, 'recap generation failed');
  }

  // Parcours terminé → rotation actu/outil/prompt
  if (parcoursDone) {
    return await sendProRotation(user, greet, jsDay);
  }

  // Lundi → Samedi : prochaine session du module courant
  const result = await contentTypes.generateParcours(user);
  if (!result || !result.text) {
    return await sendFallback(user, greet, 'parcours generation failed');
  }

  const sessionLabel = result.session
    ? 'Module ' + result.session.module.id + ' · Session ' + (result.session.sessionIndex + 1) + '/' + result.session.module.sessions
    : 'Ton parcours Will';

  await cacheResponse('daily:' + user.id, result.text, 86400);
  await whatsapp.sendText(user.whatsapp_id, greet + '\n\n' + result.text);
  await new Promise(r => setTimeout(r, 800));
  await whatsapp.sendButtons(
    user.whatsapp_id,
    'Que veux-tu faire ensuite ?',
    [
      { id: 'daily_deep', title: 'J\'approfondis' },
      { id: 'daily_example', title: 'Exemple concret' },
      { id: 'daily_next', title: 'Notion suivante' },
    ],
    null,
    sessionLabel
  );

  if (result.nextProgress) {
    await query(
      'UPDATE users SET current_module = $1, module_progress = $2 WHERE id = $3',
      [result.nextProgress.current_module, JSON.stringify(result.nextProgress.module_progress), user.id]
    );
  }
  await userService.incrementDailyCount(user.id);
  return { ok: true, type: 'pro_parcours' };
}

async function sendProRotation(user, greet, jsDay) {
  // Lun(1)/Mer(3)/Ven(5) → actu  ;  Mar(2)/Jeu(4)/Sam(6) → outil ou prompt
  let content = null;
  let footer = '';
  if (jsDay === 1 || jsDay === 3 || jsDay === 5) {
    content = await contentTypes.generateActuIA(user);
    footer = 'Actu IA du jour';
  } else if (jsDay === 2 || jsDay === 4) {
    content = await contentTypes.generateOutilDuJour(user);
    footer = 'Outil du jour';
  } else if (jsDay === 6) {
    content = await contentTypes.generatePromptDuJour(user);
    footer = 'Prompt du jour';
  }

  if (!content) {
    return await sendFallback(user, greet, 'rotation generation failed');
  }

  await cacheResponse('daily:' + user.id, content, 86400);
  await whatsapp.sendText(user.whatsapp_id, greet + '\n\n' + content);
  await new Promise(r => setTimeout(r, 800));
  await whatsapp.sendButtons(
    user.whatsapp_id,
    'Que veux-tu faire ensuite ?',
    [
      { id: 'daily_deep', title: 'J\'approfondis' },
      { id: 'daily_example', title: 'Exemple concret' },
      { id: 'daily_next', title: 'Aller plus loin' },
    ],
    null,
    footer
  );
  await userService.incrementDailyCount(user.id);
  return { ok: true, type: 'pro_rotation' };
}

// ============================================
// FALLBACK — quand un générateur retourne null
// On log et on envoie un message d'attente, mais on ne masque pas l'erreur côté caller
// ============================================
async function sendFallback(user, greet, reason) {
  logger.warn('Daily fallback', { userId: user.id, reason });
  try {
    await whatsapp.sendText(
      user.whatsapp_id,
      greet + ' Je rencontre un petit souci pour préparer ta session. Réessaie dans quelques minutes ou pose-moi directement ta question.'
    );
  } catch (err) {
    logger.error('Erreur envoi fallback', { userId: user.id, error: err.message });
  }
  return { ok: false, error: reason };
}

// ============================================
// CHOIX DU MENU PRO (appelé depuis webhook si l'utilisateur tape "menu pro")
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
    await whatsapp.sendText(
      user.whatsapp_id,
      'Je rencontre un petit souci. Réessaie dans quelques secondes.'
    );
    return;
  }

  await cacheResponse('daily:' + user.id, content, 86400);
  await whatsapp.sendText(user.whatsapp_id, content);
  await new Promise(r => setTimeout(r, 800));
  await whatsapp.sendButtons(
    user.whatsapp_id,
    'Que veux-tu faire ensuite ?',
    [
      { id: 'daily_deep', title: 'J\'approfondis' },
      { id: 'daily_example', title: 'Exemple concret' },
      { id: 'daily_next', title: 'Notion suivante' },
    ],
    null,
    footer
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
      (name) => (name ? 'Bonjour ' + name + '.' : 'Bonjour.') + '\n\n' +
        'Plus que 2 jours pour profiter de ton essai gratuit.\n\n' +
        'Tu as commencé à découvrir l\'IA avec le Module 1. Pour débloquer les Modules 2 à 10 et continuer sans interruption, passe Pro.',
      'trial_reminder_j5'
    );

    await sendReminderBatch(6, 7,
      (name) => (name ? name + ', ' : '') +
        'dernier jour de ton essai gratuit.\n\n' +
        'Demain ton accès s\'arrête. Pour garder ton parcours sans interruption :',
      'trial_reminder_j6'
    );

    await sendReminderBatch(7, 8,
      (name) => 'Ton essai gratuit est terminé.\n\n' +
        (name ? name + ', ' : '') +
        'merci d\'avoir testé Will. Pour continuer à apprendre l\'IA au quotidien (parcours complet, actu, outils, prompts) :\n\n' +
        'Pro : 6,99 €/mois, sans engagement.',
      'trial_reminder_j7'
    );

    await sendReminderBatch(14, 15,
      (name) => (name ? name + ', ' : '') +
        'ça fait 2 semaines que ton essai Will est terminé.\n\n' +
        'L\'IA évolue vite. Si tu veux remettre le pied à l\'étrier, c\'est le moment.\n\n' +
        'Dernier rappel, après je te laisse tranquille.',
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

module.exports = {
  startDailyCron,
  sendDailyMessages,
  sendDailyForUser,
  handleProMenuChoice,
};
