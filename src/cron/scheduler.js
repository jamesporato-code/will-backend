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
// Pro — parcours qui s'enrichit en continu :
//   Lundi → Samedi : prochaine session du module courant
//   Dimanche       : récap hebdo
//   Quand tous les modules sont terminés : rotation hebdo
//     Lun/Mer/Ven : actu IA
//     Mar/Jeu/Sam : outil du jour
//     Dim         : récap
//
// Crons :
//   - Toutes les 15 min : envoi aux users dont preferred_hour+minute matchent Paris
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
  // Toutes les 15 minutes : envoi aux users dont l'heure+minute préférée correspond
  cron.schedule('*/15 * * * *', async () => {
    const now = new Date();
    const parisHour = parseInt(
      now.toLocaleString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', hour12: false }),
      10
    );
    const parisMinute = parseInt(
      now.toLocaleString('fr-FR', { timeZone: 'Europe/Paris', minute: '2-digit' }),
      10
    );
    // Arrondi au quart d'heure le plus proche pour matcher 0/15/30/45
    const slotMinute = [0, 15, 30, 45].reduce((prev, curr) =>
      Math.abs(curr - parisMinute) < Math.abs(prev - parisMinute) ? curr : prev
    );
    logger.info('Cron 15min : vérification pour ' + parisHour + 'h' + (slotMinute < 10 ? '0' + slotMinute : slotMinute));
    await sendDailyMessages(parisHour, slotMinute);
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

  logger.info('Crons planifiés : 15min + trial reminders (10h) + reset compteur (minuit)');
}

// ============================================
// DISPATCH HORAIRE — appelé par le cron
// ============================================
async function sendDailyMessages(currentHour, currentMinute = 0) {
  try {
    const usersResult = await query(
      `SELECT id FROM users
       WHERE onboarding_complete = true
       AND plan IN ('trial', 'pro')
       AND (plan != 'trial' OR created_at > NOW() - INTERVAL '7 days')
       AND daily_opt_in != false
       AND COALESCE(preferred_hour, 8) = $1
       AND COALESCE(preferred_minute, 0) = $2`,
      [currentHour, currentMinute]
    );

    const ids = usersResult.rows.map(r => r.id);
    const slotLabel = currentHour + 'h' + (currentMinute < 10 ? '0' + currentMinute : currentMinute);
    logger.info(ids.length + ' utilisateurs à notifier pour ' + slotLabel);

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

    // Hors fenetre 24h Meta : envoie un template approuve "ta session est prete"
    // au lieu du free-form, qui serait silencieusement bloque par WhatsApp.
    // - opts.first : exclu (juste apres onboarding, fenetre ouverte)
    // - opts.skipWindowCheck : exclu (caller force le free-form, ex: reponse au template)
    const templateName = process.env.WHATSAPP_TEMPLATE_DAILY_REMINDER;
    if (templateName && !opts.first && !opts.skipWindowCheck) {
      const within = await isWithin24hWindow(userId);
      if (!within) {
        const firstName = user.display_name?.split(' ')[0] || 'toi';
        try {
          await whatsapp.sendTemplate(user.whatsapp_id, templateName, 'fr', { first_name: firstName });
          await query('UPDATE users SET pending_daily = true WHERE id = $1', [userId]);
          logger.info('Template reminder envoye (hors fenetre 24h)', { userId });
          return { ok: true, type: 'template_reminder' };
        } catch (err) {
          logger.error('Echec envoi template, on laisse tomber', { userId, error: err.message });
          return { ok: false, error: 'template send failed: ' + err.message };
        }
      }
    }

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

// Verifie si le user a envoye un message dans les 24 dernieres heures (fenetre Meta).
// En dehors, on doit passer par un template approuve sinon WhatsApp drop le message.
// `last_user_message_at` est mis a jour par le webhook sur chaque message entrant.
async function isWithin24hWindow(userId) {
  try {
    const result = await query(
      `SELECT 1 FROM users WHERE id = $1 AND last_user_message_at >= NOW() - INTERVAL '24 hours' LIMIT 1`,
      [userId]
    );
    return result.rows.length > 0;
  } catch (err) {
    logger.error('Erreur check 24h window', { userId, error: err.message });
    // En cas d'erreur, on assume ouverte pour eviter le spam de templates payants
    return true;
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

// Si l'utilisateur a échangé avec Will dans les ~30 dernières minutes,
// il est dans une "conversation active" → on saute le "Bonjour".
async function isConversationActive(userId) {
  try {
    const result = await query(
      `SELECT 1 FROM messages WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '30 minutes' LIMIT 1`,
      [userId]
    );
    return result.rows.length > 0;
  } catch (err) {
    return false;
  }
}

async function sendTrialDaily(user, opts = {}) {
  const name = user.display_name?.split(' ')[0] || '';
  // Pas de "Bonjour" si on vient de finir l'onboarding ou si une conversation est en cours
  const skipGreet = opts.first === true || (await isConversationActive(user.id));
  const greet = skipGreet ? '' : (name ? 'Bonjour ' + name + '.' : 'Bonjour.');
  // opts.first force le jour 1 quand l'onboarding vient juste de finir
  const trialDay = opts.first ? 1 : getTrialDay(user);

  // J1 → J5 : sessions du Module 1
  if (trialDay >= 1 && trialDay <= 5) {
    const result = await contentTypes.generateParcours(user);
    if (!result || !result.text) {
      return await sendFallback(user, greet, 'parcours generation failed');
    }

    const intro = opts.first
      ? 'On démarre ton parcours.'
      : (skipGreet ? 'Voici ta session du jour.' : greet + ' Voici ta session du jour.');

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
        { id: 'daily_minidefi', title: 'Mini-défi' },
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
    const j6Intro = skipGreet
      ? 'Aujourd\'hui un aperçu de ce que tu reçois en Pro : l\'actu IA du jour.'
      : greet + ' Aujourd\'hui un aperçu de ce que tu reçois en Pro : l\'actu IA du jour.';
    await whatsapp.sendText(user.whatsapp_id, j6Intro + '\n\n' + actu);
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
    const fallbackBody = skipGreet
      ? 'Ton essai se termine demain. Tu as découvert le Module 1 (Introduction à l\'IA). Pour continuer le parcours qui s\'enrichit en continu (nouveaux modules, actu, outils, prompts), passe Pro à 6,99 €/mois.'
      : greet + ' Ton essai se termine demain. Tu as découvert le Module 1 (Introduction à l\'IA). Pour continuer le parcours qui s\'enrichit en continu (nouveaux modules, actu, outils, prompts), passe Pro à 6,99 €/mois.';
    const body = recap
      ? recap + '\n\nDemain ton essai se termine. Pour continuer le parcours qui s\'enrichit en continu, passe Pro à 6,99 €/mois.'
      : fallbackBody;

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
// PRO — parcours évolutif + rotation post-parcours
// ============================================
async function sendProDaily(user, opts = {}) {
  const name = user.display_name?.split(' ')[0] || '';
  const skipGreet = opts.first === true || (await isConversationActive(user.id));
  const greet = skipGreet ? '' : (name ? 'Bonjour ' + name + '.' : 'Bonjour.');
  const prefix = skipGreet ? '' : greet + '\n\n';

  const parisDate = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
  const jsDay = parisDate.getDay(); // 0=dim, 1=lun, ..., 6=sam

  // Vérifie si le parcours est terminé
  const session = await getCurrentSession(user);
  const parcoursDone = !session || session.done === true;

  // Dimanche : récap (parcours en cours) ou rotation (parcours fini)
  if (jsDay === 0) {
    const recap = await contentTypes.generateRecapHebdo(user);
    if (recap) {
      await whatsapp.sendText(user.whatsapp_id, prefix + recap);
      await userService.incrementDailyCount(user.id);
      return { ok: true, type: 'pro_recap' };
    }
    return await sendFallback(user, greet, 'recap generation failed');
  }

  // Parcours terminé → rotation actu/outil/prompt
  if (parcoursDone) {
    return await sendProRotation(user, prefix, jsDay);
  }

  // Lundi → Samedi : prochaine session du module courant
  const result = await contentTypes.generateParcours(user);
  if (!result || !result.text) {
    return await sendFallback(user, greet, 'parcours generation failed');
  }

  const sessionLabel = result.session
    ? 'Module ' + result.session.module.position + ' · Session ' + (result.session.sessionIndex + 1) + '/' + result.session.module.sessions
    : 'Ton parcours Will';

  await cacheResponse('daily:' + user.id, result.text, 86400);
  await whatsapp.sendText(user.whatsapp_id, prefix + result.text);
  await new Promise(r => setTimeout(r, 800));
  await whatsapp.sendButtons(
    user.whatsapp_id,
    'Que veux-tu faire ensuite ?',
    [
      { id: 'daily_deep', title: 'J\'approfondis' },
      { id: 'daily_example', title: 'Exemple concret' },
      { id: 'daily_minidefi', title: 'Mini-défi' },
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

async function sendProRotation(user, prefix, jsDay) {
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
    return await sendFallback(user, '', 'rotation generation failed');
  }

  await cacheResponse('daily:' + user.id, content, 86400);
  await whatsapp.sendText(user.whatsapp_id, (prefix || '') + content);
  await new Promise(r => setTimeout(r, 800));
  await whatsapp.sendButtons(
    user.whatsapp_id,
    'Que veux-tu faire ensuite ?',
    [
      { id: 'daily_deep', title: 'J\'approfondis' },
      { id: 'daily_example', title: 'Exemple concret' },
      { id: 'daily_minidefi', title: 'Mini-défi' },
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
    const lead = greet ? greet + ' ' : '';
    await whatsapp.sendText(
      user.whatsapp_id,
      lead + 'Je rencontre un petit souci pour préparer ta session. Réessaie dans quelques minutes ou pose-moi directement ta question.'
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
      { id: 'daily_minidefi', title: 'Mini-défi' },
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
        'Tu as commencé à découvrir l\'IA avec le Module 1. Pour continuer le parcours qui s\'enrichit en continu et ne pas perdre ton élan, passe Pro.',
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
        'merci d\'avoir testé Will. Pour continuer à apprendre l\'IA au quotidien (parcours qui s\'enrichit en continu, actu, outils, prompts) :\n\n' +
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
