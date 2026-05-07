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
//   - Toutes les 15 min : envoi du daily aux users dont preferred_hour+minute matchent Paris
//   - 12h30 Paris : push actu IA midi (2e contact dans la journee)
//   - 10h Paris : relances trial (J5/J6/J7/J14)
//   - Minuit Paris : reset compteur quotidien
// ============================================

const cron = require('node-cron');
const logger = require('../utils/logger');
const { query } = require('../db/pool');
const whatsapp = require('../services/whatsapp');
const contentTypes = require('../services/contentTypes');
const userService = require('../services/userService');
const { cacheResponse, getCachedResponse } = require('../services/redis');
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

  // Cron actu IA : tous les quarts d'heure, push aux users dont actu_hour/actu_minute matchent.
  // Filtre par actu_mode='scheduled' (les 'bundled' sont declenches par le daily du matin).
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
    const slotMinute = [0, 15, 30, 45].reduce((prev, curr) =>
      Math.abs(curr - parisMinute) < Math.abs(prev - parisMinute) ? curr : prev
    );
    await sendActuAtSlot(parisHour, slotMinute);
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
          await query("UPDATE users SET pending_action = 'daily' WHERE id = $1", [userId]);
          logger.info('Template reminder envoye (hors fenetre 24h)', { userId });
          return { ok: true, type: 'template_reminder' };
        } catch (err) {
          logger.error('Echec envoi template, on laisse tomber', { userId, error: err.message });
          return { ok: false, error: 'template send failed: ' + err.message };
        }
      }
    }

    await updateStreak(user);

    let result;
    if (user.plan === 'trial') {
      result = await sendTrialDaily(user, opts);
    } else if (user.plan === 'pro') {
      result = await sendProDaily(user, opts);
    } else {
      return { ok: false, error: 'plan ' + user.plan + ' inactive (no daily)' };
    }

    // Bundled actu : si le user a choisi 'avec mon daily', on enchaine
    // l'actu IA juste apres. Skip si daily a echoue ou si bundle desactive.
    if (result?.ok && !opts.skipActuBundle && user.actu_mode === 'bundled') {
      try {
        await new Promise(r => setTimeout(r, 1500));
        await sendActuForUser(userId, { skipWindowCheck: true, skipActuBundle: true });
      } catch (err) {
        logger.error('Erreur bundled actu apres daily', { userId, error: err.message });
      }
    }

    return result;
  } catch (err) {
    logger.error('sendDailyForUser exception', { userId, error: err.message, stack: err.stack });
    return { ok: false, error: err.message };
  }
}

// ============================================
// ACTU IA — 2e push journee, configurable par user
//   - actu_mode = 'scheduled' (defaut) : push a actu_hour/actu_minute
//   - actu_mode = 'bundled' : push juste apres le daily (gere dans sendDailyForUser)
//   - actu_mode = 'disabled' : pas de push (toujours dispo via /menu)
// ============================================
async function sendActuAtSlot(currentHour, currentMinute = 0) {
  try {
    const usersResult = await query(
      `SELECT id FROM users
       WHERE onboarding_complete = true
       AND plan IN ('trial', 'pro')
       AND (plan != 'trial' OR created_at > NOW() - INTERVAL '7 days')
       AND daily_opt_in != false
       AND COALESCE(actu_mode, 'scheduled') = 'scheduled'
       AND COALESCE(actu_hour, 12) = $1
       AND COALESCE(actu_minute, 30) = $2`,
      [currentHour, currentMinute]
    );
    const ids = usersResult.rows.map(r => r.id);
    if (ids.length === 0) return;
    const slotLabel = currentHour + 'h' + (currentMinute < 10 ? '0' + currentMinute : currentMinute);
    logger.info(ids.length + ' utilisateurs pour actu IA a ' + slotLabel);
    for (const userId of ids) {
      const r = await sendActuForUser(userId);
      if (!r.ok) {
        logger.error('Echec actu pour user', { userId, error: r.error });
      }
      await new Promise(r => setTimeout(r, 500));
    }
  } catch (err) {
    logger.error('Erreur cron actu', { error: err.message });
  }
}

async function sendActuForUser(userId, opts = {}) {
  try {
    const userResult = await query('SELECT * FROM users WHERE id = $1', [userId]);
    const user = userResult.rows[0];
    if (!user || !user.whatsapp_id) return { ok: false, error: 'no user or whatsapp_id' };

    // Si une action est deja en attente (template daily / trial reminder),
    // on ne touche pas pour ne pas ecraser le contenu en attente de livraison.
    if (user.pending_action && !opts.skipWindowCheck) {
      return { ok: false, error: 'pending_action present: ' + user.pending_action };
    }

    // Hors fenetre 24h : envoie le template, marque pending_action='actu'
    const templateName = process.env.WHATSAPP_TEMPLATE_DAILY_REMINDER;
    if (templateName && !opts.skipWindowCheck) {
      const within = await isWithin24hWindow(userId);
      if (!within) {
        const firstName = user.display_name?.split(' ')[0] || 'toi';
        try {
          await whatsapp.sendTemplate(user.whatsapp_id, templateName, 'fr', { first_name: firstName });
          await query("UPDATE users SET pending_action = 'actu' WHERE id = $1", [userId]);
          logger.info('Template actu envoye (hors fenetre 24h)', { userId });
          return { ok: true, type: 'template_actu_reminder' };
        } catch (err) {
          logger.error('Echec envoi template actu', { userId, error: err.message });
          return { ok: false, error: 'template send failed: ' + err.message };
        }
      }
    }

    // Fenetre ouverte : charge ou genere les 3 news, envoie la premiere
    const news = await loadOrGenerateActuNews(user);
    if (!news || news.length === 0) return { ok: false, error: 'actu generation failed' };
    await deliverActuNews(user, news, 0);
    return { ok: true, type: 'actu' };
  } catch (err) {
    logger.error('sendActuForUser exception', { userId, error: err.message, stack: err.stack });
    return { ok: false, error: err.message };
  }
}

// Charge le cache d'actu IA pour un user (24h TTL). Si vide, genere 3 news fraiches
// via Claude + Tavily et les met en cache.
async function loadOrGenerateActuNews(user) {
  const cacheKey = 'actu_news:' + user.id;
  try {
    const cached = await getCachedResponse(cacheKey);
    if (cached && Array.isArray(cached.news) && cached.news.length > 0) {
      return cached.news;
    }
  } catch (err) {
    logger.warn('Cache read fail actu_news', { userId: user.id, error: err.message });
  }
  const generated = await contentTypes.generateActuIA(user);
  if (!generated || !Array.isArray(generated.news) || generated.news.length === 0) {
    return null;
  }
  try {
    await cacheResponse(cacheKey, { news: generated.news, generated_at: new Date().toISOString() }, 86400);
  } catch (err) {
    logger.warn('Cache write fail actu_news', { userId: user.id, error: err.message });
  }
  return generated.news;
}

// Delivre 1 news a l'index demande, avec un header "X/Y" et des boutons :
// - "Suivante" (actu_next_<N+1>) si une news suivante existe
// - "Outil du jour" et "Voir le menu" comme alternatives
async function deliverActuNews(user, newsArray, index) {
  if (!Array.isArray(newsArray) || index < 0 || index >= newsArray.length) return false;
  const total = newsArray.length;
  const header = '📰 Actu IA · ' + (index + 1) + '/' + total;
  await whatsapp.sendText(user.whatsapp_id, header + '\n\n' + newsArray[index]);
  await new Promise(r => setTimeout(r, 800));

  const buttons = [];
  if (index + 1 < total) {
    buttons.push({ id: 'actu_next_' + (index + 1), title: 'Suivante' });
  }
  buttons.push({ id: 'menu_outil', title: 'Outil du jour' });
  buttons.push({ id: 'menu_hub', title: 'Voir le menu' });

  await whatsapp.sendButtons(
    user.whatsapp_id,
    index + 1 < total
      ? 'Tu veux la suivante ?'
      : 'Et apres ?',
    buttons.slice(0, 3),
    null,
    'Will · actu IA'
  );
  return true;
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
    const newsArray = await loadOrGenerateActuNews(user);
    if (!newsArray || newsArray.length === 0) {
      return await sendFallback(user, greet, 'actu generation failed');
    }
    const j6Intro = skipGreet
      ? 'Aujourd\'hui un aperçu de ce que tu reçois en Pro : l\'actu IA du jour.'
      : greet + ' Aujourd\'hui un aperçu de ce que tu reçois en Pro : l\'actu IA du jour.';
    await whatsapp.sendText(user.whatsapp_id, j6Intro);
    await new Promise(r => setTimeout(r, 600));
    await deliverActuNews(user, newsArray, 0);
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
  // Pour les jours actu, on utilise le flow split (1 news + bouton Suivante).
  // Pour outil/prompt on garde le format unique.
  if (jsDay === 1 || jsDay === 3 || jsDay === 5) {
    if (prefix) {
      await whatsapp.sendText(user.whatsapp_id, prefix.trim());
      await new Promise(r => setTimeout(r, 600));
    }
    const newsArray = await loadOrGenerateActuNews(user);
    if (!newsArray || newsArray.length === 0) {
      return await sendFallback(user, '', 'actu generation failed');
    }
    await deliverActuNews(user, newsArray, 0);
    await userService.incrementDailyCount(user.id);
    return { ok: true, type: 'pro_rotation_actu' };
  }

  let content = null;
  let footer = '';
  if (jsDay === 2 || jsDay === 4) {
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
    // Flow split : on charge ou genere les news et on envoie la 1re avec bouton Suivante.
    // On ne tombe pas dans la branche "content" plus bas.
    const newsArray = await loadOrGenerateActuNews(user);
    if (!newsArray || newsArray.length === 0) {
      await whatsapp.sendText(
        user.whatsapp_id,
        'Je rencontre un petit souci pour preparer l\'actu. Reessaie dans quelques secondes.'
      );
      return;
    }
    await deliverActuNews(user, newsArray, 0);
    return;
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
// Definitions centralisees : un seul endroit ou modifier les copy + ranges.
// ============================================
const TRIAL_REMINDERS = {
  j5: {
    minDays: 5, maxDays: 6, field: 'trial_reminder_j5',
    body: (name) => (name ? 'Bonjour ' + name + '.' : 'Bonjour.') + '\n\n' +
      'Plus que 2 jours pour profiter de ton essai gratuit.\n\n' +
      'Tu as commencé à découvrir l\'IA avec le Module 1. Pour continuer le parcours qui s\'enrichit en continu et ne pas perdre ton élan, passe Pro.',
  },
  j6: {
    minDays: 6, maxDays: 7, field: 'trial_reminder_j6',
    body: (name) => (name ? name + ', ' : '') +
      'dernier jour de ton essai gratuit.\n\n' +
      'Demain ton accès s\'arrête. Pour garder ton parcours sans interruption :',
  },
  j7: {
    minDays: 7, maxDays: 8, field: 'trial_reminder_j7',
    body: (name) => 'Ton essai gratuit est terminé.\n\n' +
      (name ? name + ', ' : '') +
      'merci d\'avoir testé Will. Pour continuer à apprendre l\'IA au quotidien (parcours qui s\'enrichit en continu, actu, outils, prompts) :\n\n' +
      'Pro : 6,99 €/mois, sans engagement.',
  },
  j14: {
    minDays: 14, maxDays: 15, field: 'trial_reminder_j14',
    body: (name) => (name ? name + ', ' : '') +
      'ça fait 2 semaines que ton essai Will est terminé.\n\n' +
      'L\'IA évolue vite. Si tu veux remettre le pied à l\'étrier, c\'est le moment.\n\n' +
      'Dernier rappel, après je te laisse tranquille.',
  },
};

async function sendTrialReminders() {
  try {
    for (const stage of Object.keys(TRIAL_REMINDERS)) {
      await sendReminderBatch(stage);
    }
  } catch (err) {
    logger.error('Erreur cron trial reminders', { error: err.message });
  }
}

async function sendReminderBatch(stage) {
  const def = TRIAL_REMINDERS[stage];
  if (!def) return;
  try {
    const result = await query(
      `SELECT id, whatsapp_id, display_name FROM users
       WHERE plan = 'trial'
       AND onboarding_complete = true
       AND created_at <= NOW() - INTERVAL '${def.minDays} days'
       AND created_at > NOW() - INTERVAL '${def.maxDays} days'
       AND (${def.field} IS NULL OR ${def.field} = false)`,
      []
    );

    for (const user of result.rows) {
      try {
        // Hors fenetre 24h Meta : envoie le template "ta session est prete" et stocke
        // le stage en attente pour le restituer quand le user repondra.
        const templateName = process.env.WHATSAPP_TEMPLATE_DAILY_REMINDER;
        if (templateName) {
          const within = await isWithin24hWindow(user.id);
          if (!within) {
            const firstName = user.display_name?.split(' ')[0] || 'toi';
            await whatsapp.sendTemplate(user.whatsapp_id, templateName, 'fr', { first_name: firstName });
            await query(
              `UPDATE users SET pending_action = $1, ${def.field} = true WHERE id = $2`,
              ['trial_' + stage, user.id]
            );
            logger.info('Trial reminder template envoye (hors fenetre 24h)', { userId: user.id, stage });
            await new Promise(r => setTimeout(r, 500));
            continue;
          }
        }

        // Fenetre ouverte (ou pas de template configure) : envoi free-form direct.
        await sendTrialReminderFreeForm(user, stage);
        await query(`UPDATE users SET ${def.field} = true WHERE id = $1`, [user.id]);
        logger.info('Trial reminder sent', { userId: user.id, stage });
        await new Promise(r => setTimeout(r, 500));
      } catch (err) {
        logger.error('Erreur reminder', { userId: user.id, stage, error: err.message });
      }
    }
  } catch (err) {
    logger.error('Erreur batch reminder ' + stage, { error: err.message });
  }
}

// Envoi free-form du contenu d'un trial reminder. Utilise par le cron quand la
// fenetre 24h est ouverte, et par le webhook quand un user repond a un template
// alors qu'un trial reminder etait en attente.
async function sendTrialReminderFreeForm(user, stage) {
  const def = TRIAL_REMINDERS[stage];
  if (!def) return;
  const name = user.display_name?.split(' ')[0] || '';
  const msg = def.body(name);
  await whatsapp.sendButtons(user.whatsapp_id, msg, [
    { id: 'plan_pro', title: 'Passer Pro 6,99' },
  ], null, 'Sans engagement');
}

module.exports = {
  startDailyCron,
  sendDailyMessages,
  sendDailyForUser,
  sendActuForUser,
  sendActuAtSlot,
  loadOrGenerateActuNews,
  deliverActuNews,
  sendTrialReminderFreeForm,
  handleProMenuChoice,
};
