// ============================================
// WEBHOOK WhatsApp - Will Coach IA
// Plan unique : Trial (7j gratuit) -> Pro (6,99 EUR/mois)
// Stripe webhook (src/routes/stripe.js) est la SEULE source de verite
// pour l'upgrade Pro. Cette route ne fait jamais confiance au texte
// "paiement_confirme_*" pour modifier le plan.
// ============================================

const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const whatsapp = require('../services/whatsapp');
const claude = require('../services/claude');
const userService = require('../services/userService');
const { getUserStats } = require('../services/userService');
const onboarding = require('../services/onboarding');
const { getCachedResponse, cacheResponse } = require('../services/redis');
const { handleProMenuChoice } = require('../cron/scheduler');
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Verification Meta
router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    logger.info('Webhook verifie par Meta');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Messages entrants
router.post('/', async (req, res) => {
  res.sendStatus(200);

  // === LOG DELIVERY STATUS CALLBACKS ===
  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    if (value?.statuses) {
      value.statuses.forEach(s => {
        logger.info('WhatsApp STATUS CALLBACK', {
          messageId: s.id,
          status: s.status,
          recipientId: s.recipient_id,
          timestamp: s.timestamp,
          errors: s.errors ? JSON.stringify(s.errors) : null,
        });
      });
      return;
    }
  } catch (statusErr) {
    logger.error('Error logging status callback', statusErr.message);
  }

  try {
    const parsed = whatsapp.parseWebhookMessage(req.body);
    if (!parsed) return;

    logger.info('Message recu', {
      from: parsed.from,
      type: parsed.type,
      text: parsed.text?.substring(0, 50),
      buttonId: parsed.buttonId || null,
    });

    await whatsapp.markAsRead(parsed.messageId);
    const user = await userService.findOrCreateUser(parsed.from, parsed.displayName);

    // === REDIRECT POST-PAIEMENT (texte non fiable, juste UX) ===
    // Le redirect Stripe envoie l'user sur wa.me/...?text=paiement_confirme_pro
    // On NE FAIT PAS confiance a ce texte. L'upgrade reel passe par
    // src/routes/stripe.js sur l'event checkout.session.completed.
    if (parsed.text?.startsWith('paiement_confirme_')) {
      logger.info('Redirect post-paiement recu (UX only, no plan change)', { userId: user.id });
      if (user.plan === 'pro') {
        // Stripe a deja confirme : tout est bon, on rappelle simplement
        await whatsapp.sendText(
          user.whatsapp_id,
          'Tout est en ordre, ton plan Pro est actif. Pose-moi tes questions sur l\'IA quand tu veux.'
        );
      } else {
        // Pas encore confirme cote Stripe : on rassure sans rien changer
        await whatsapp.sendText(
          user.whatsapp_id,
          'Merci ! Je verifie ton paiement avec Stripe, ca prend quelques secondes. Tu recevras un message des que c\'est confirme.'
        );
      }
      return;
    }

    const textLower = (parsed.text || '').toLowerCase().trim();

    // === SLASH COMMANDS (disponibles avant et apres onboarding) ===
    if (textLower === '/help' || textLower === 'help' || textLower === '/aide') {
      await whatsapp.sendText(
        user.whatsapp_id,
        '*Commandes Will*\n\n' +
        '/help - Cette aide\n' +
        '/daily - Activer/desactiver les messages quotidiens\n' +
        '/stop - Se desinscrire des messages quotidiens\n' +
        'mon compte - Voir ton profil et ton plan\n\n' +
        'Ou pose-moi directement ta question sur l\'IA.'
      );
      return;
    }

    if (textLower === '/stop' || textLower === 'stop') {
      await userService.updateProfile(user.id, { daily_opt_in: false });
      await whatsapp.sendText(
        user.whatsapp_id,
        'Messages quotidiens desactives.\n\n' +
        'Tu peux toujours me poser des questions quand tu veux. Tape /daily pour reactiver.'
      );
      return;
    }

    if (textLower === '/daily') {
      const newStatus = !user.daily_opt_in;
      await userService.updateProfile(user.id, { daily_opt_in: newStatus });
      const hour = user.preferred_hour || 8;
      await whatsapp.sendText(
        user.whatsapp_id,
        newStatus
          ? 'Messages quotidiens reactives. Tu recevras ton prochain message a ' + hour + 'h.'
          : 'Messages quotidiens desactives. Tape /daily pour reactiver.'
      );
      return;
    }

    // "mon compte" command
    if (textLower === 'mon compte' || textLower === 'compte' || textLower === 'abonnement') {
      await handleMyAccount(user);
      return;
    }

    // Onboarding flow
    if (!user.onboarding_complete) {
      const handled = await onboarding.handleOnboarding(user, parsed);
      if (handled) return;
    }

    // Account / plan actions
    if (parsed.buttonId?.startsWith('account_') || parsed.buttonId === 'plan_pro' || parsed.buttonId?.startsWith('level_')) {
      await handleAccountAction(user, parsed);
      return;
    }

    // Message limits
    const canSend = await userService.canSendMessage(user);
    if (!canSend.allowed) {
      await handleLimitReached(user, canSend.reason);
      return;
    }

    // Pro menu choice (from daily menu)
    if (parsed.buttonId?.startsWith('menu_')) {
      await handleProMenuChoice(user, parsed.buttonId);
      return;
    }

    // Content buttons (topic + daily)
    if (parsed.buttonId?.startsWith('topic_') || parsed.buttonId?.startsWith('daily_')) {
      await handleContentButton(user, parsed);
      return;
    }

    // Free message to AI
    await handleFreeMessage(user, parsed);

  } catch (err) {
    logger.error('Erreur traitement webhook', err);
  }
});

async function handleMyAccount(user) {
  const planNames = {
    trial: 'Essai gratuit (7j)',
    pro: 'Pro',
    cancelled: 'Annule',
  };
  const limits = { trial: 15, pro: 'Illimite', cancelled: 0 };

  const stats = await getUserStats(user.id);
  const info = '*Ton compte Will*\n\n' +
    'Plan : ' + (planNames[user.plan] || user.plan) + '\n' +
    'Niveau : ' + (user.level || 'debutant') + '\n' +
    'Domaine : ' + (user.job || 'Non renseigne') + '\n' +
    'Messages/jour : ' + (limits[user.plan] || '?') + '\n' +
    'Utilises aujourd\'hui : ' + (user.daily_message_count || 0) + '\n\n' +
    '*Ton activite*\n' +
    '- ' + stats.msgWeek + ' messages cette semaine\n' +
    '- ' + stats.msgTotal + ' messages au total\n' +
    '- ' + stats.activeDaysMonth + ' jours actifs sur 30 jours\n' +
    '~' + stats.hoursSavedTotal + 'h gagnees depuis ton inscription';

  if (user.plan === 'pro') {
    await whatsapp.sendButtons(user.whatsapp_id, info, [
      { id: 'account_manage', title: 'Gerer mon abo' },
      { id: 'account_change_level', title: 'Changer niveau' },
    ]);
  } else {
    await whatsapp.sendButtons(user.whatsapp_id, info, [
      { id: 'plan_pro', title: 'Pro 6,99/mois' },
      { id: 'account_change_level', title: 'Changer niveau' },
    ], null, 'Passe au Pro pour tout debloquer');
  }
}

async function handleFreeMessage(user, parsed) {
  const userText = parsed.text || '';
  const cacheKey = userText.toLowerCase().trim().replace(/[^a-z0-9 ]/g, '').substring(0, 100);
  const cached = await getCachedResponse(cacheKey);

  let response;
  if (cached) {
    response = cached;
  } else {
    response = await claude.generateResponse(user.id, userText, {
      level: user.level,
      job: user.job,
      plan: user.plan,
      displayName: user.display_name,
    });
    if (userText.length < 100) await cacheResponse(cacheKey, response, 3600);
  }

  await userService.saveMessage(user.id, 'user', userText, 'chat', parsed.messageId);
  await userService.saveMessage(user.id, 'assistant', response, 'chat');
  await userService.incrementDailyCount(user.id);
  await whatsapp.sendText(user.whatsapp_id, response);
}

async function handleContentButton(user, parsed) {
  const buttonId = parsed.buttonId;

  if (buttonId.startsWith('daily_')) {
    await handleDailyButton(user, buttonId);
    return;
  }

  const topicResponses = {
    topic_outils: 'Super choix.\n\n' +
      'Voici 3 outils IA incontournables :\n\n' +
      '1. Claude (Anthropic) - Le meilleur pour ecrire, analyser et raisonner\n' +
      '2. Perplexity - Google dope a l\'IA, avec des sources\n' +
      '3. Gamma - Creer des presentations en 30 secondes\n\n' +
      'Lequel tu veux qu\'on explore ensemble ?',
    topic_prompt: 'Le secret d\'un bon prompt, c\'est la structure.\n\n' +
      'La formule magique :\nRole + Contexte + Tache + Format\n\n' +
      'Exemple :\n"Tu es un expert marketing. Mon entreprise vend [X]. ' +
      'Ecris-moi 3 accroches pour une pub Instagram. Format : une phrase + un emoji."\n\n' +
      'Essaie maintenant : envoie-moi un prompt et je te dis comment l\'ameliorer.',
    topic_actu: 'Je te prepare un resume actu IA chaque matin.\n\n' +
      'En attendant, pose-moi une question sur un sujet qui t\'interesse.',
  };
  const response = topicResponses[buttonId] || 'Dis-moi en plus et je te guide.';
  await userService.saveMessage(user.id, 'assistant', response, 'chat');
  await userService.incrementDailyCount(user.id);
  await whatsapp.sendText(user.whatsapp_id, response);
}

async function handleDailyButton(user, buttonId) {
  const buttonTypeMap = { daily_deep: 'deep', daily_example: 'example', daily_next: 'next' };
  const buttonType = buttonTypeMap[buttonId];
  if (!buttonType) return;

  try {
    const dailyContent = await getCachedResponse('daily:' + user.id);
    if (!dailyContent) {
      await whatsapp.sendText(
        user.whatsapp_id,
        'Ce contenu n\'est plus disponible. Tu recevras un nouveau message demain.'
      );
      return;
    }

    const userContext = { level: user.level, job: user.job, displayName: user.display_name };
    const followup = await claude.generateDailyFollowup(buttonType, dailyContent, userContext);

    await userService.saveMessage(user.id, 'assistant', followup, 'daily');
    await userService.incrementDailyCount(user.id);
    await whatsapp.sendText(user.whatsapp_id, followup);

    await new Promise(r => setTimeout(r, 1000));
    const nextButtons = [];
    if (buttonType !== 'deep') nextButtons.push({ id: 'daily_deep', title: 'J\'approfondis' });
    if (buttonType !== 'example') nextButtons.push({ id: 'daily_example', title: 'Exemple concret' });
    if (buttonType !== 'next') nextButtons.push({ id: 'daily_next', title: 'Notion suivante' });
    if (nextButtons.length > 0) {
      await whatsapp.sendButtons(user.whatsapp_id, 'Tu veux continuer a explorer ?', nextButtons);
    }
  } catch (err) {
    logger.error('Error handling daily button', err.message);
    await whatsapp.sendText(
      user.whatsapp_id,
      'Oups, une erreur s\'est produite. Tu peux me poser une question directement.'
    );
  }
}

async function handleLimitReached(user, reason) {
  if (reason === 'trial_expired') {
    await whatsapp.sendButtons(
      user.whatsapp_id,
      'Ta periode d\'essai de 7 jours est terminee.\n\n' +
      'Pour continuer avec moi :\n\n' +
      'Pro - 6,99/mois (parcours + actus + outils + prompts)\n' +
      'Sans engagement, annule quand tu veux.',
      [{ id: 'plan_pro', title: 'Pro 6,99/mois' }],
      null,
      'Sans engagement'
    );
  } else if (reason === 'daily_limit') {
    await whatsapp.sendButtons(
      user.whatsapp_id,
      'Tu as atteint ta limite de messages aujourd\'hui.\nPasse au Pro pour l\'illimite.',
      [
        { id: 'plan_pro', title: 'Pro - Illimite' },
        { id: 'account_info', title: 'Mon compte' },
      ]
    );
  }
}

async function handleAccountAction(user, parsed) {
  if (parsed.buttonId === 'account_info') {
    await handleMyAccount(user);
    return;
  }

  if (parsed.buttonId === 'account_change_level') {
    await whatsapp.sendButtons(user.whatsapp_id, 'Quel est ton nouveau niveau ?', [
      { id: 'level_debutant', title: 'Debutant' },
      { id: 'level_intermediaire', title: 'Intermediaire' },
      { id: 'level_avance', title: 'Avance' },
    ]);
    return;
  }

  if (parsed.buttonId?.startsWith('level_') && user.onboarding_complete) {
    const level = parsed.buttonId.replace('level_', '');
    await userService.updateProfile(user.id, { level });
    await whatsapp.sendText(user.whatsapp_id, 'Mis a jour. Ton niveau est maintenant : ' + level);
    return;
  }

  if (parsed.buttonId === 'account_manage') {
    if (user.stripe_customer_id && user.plan === 'pro') {
      try {
        const portalSession = await stripe.billingPortal.sessions.create({
          customer: user.stripe_customer_id,
          return_url: 'https://wa.me/33749181083',
        });
        await whatsapp.sendText(
          user.whatsapp_id,
          'Gere ton abonnement ici :\n' + portalSession.url + '\n\nTu peux modifier ou annuler a tout moment.'
        );
      } catch (err) {
        logger.error('Erreur portal Stripe', err.message);
        await whatsapp.sendText(user.whatsapp_id, 'Contacte support@will-ai.fr pour gerer ton abonnement.');
      }
    } else {
      await whatsapp.sendButtons(user.whatsapp_id, 'Passe au Pro pour tout debloquer.', [
        { id: 'plan_pro', title: 'Pro 6,99/mois' },
      ]);
    }
    return;
  }

  if (parsed.buttonId === 'plan_pro') {
    const checkoutUrl = await createCheckoutUrl(user);
    if (checkoutUrl) {
      await whatsapp.sendText(
        user.whatsapp_id,
        'Voici ton lien de paiement pour le plan Pro (6,99/mois) :\n\n' +
        checkoutUrl + '\n\nPaiement securise par Stripe. Sans engagement.'
      );
    } else {
      await whatsapp.sendText(user.whatsapp_id, 'Erreur lors de la creation du lien. Reessaie dans quelques instants.');
    }
  }
}

async function createCheckoutUrl(user) {
  try {
    const priceId = process.env.STRIPE_PRICE_PRO;
    if (!priceId) {
      logger.error('STRIPE_PRICE_PRO manquant');
      return null;
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: 'https://wa.me/33749181083?text=paiement_confirme_pro',
      cancel_url: 'https://wa.me/33749181083?text=mon%20compte',
      client_reference_id: String(user.id),
      metadata: { userId: String(user.id), whatsappId: user.whatsapp_id, plan: 'pro' },
      allow_promotion_codes: true,
    });
    return session.url;
  } catch (err) {
    logger.error('Erreur checkout Stripe', err.message);
    return null;
  }
}

module.exports = router;
