const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const whatsapp = require('../services/whatsapp');
const claude = require('../services/claude');
const userService = require('../services/userService');
const onboarding = require('../services/onboarding');
const { getCachedResponse, cacheResponse } = require('../services/redis');
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
  logger.warn('Echec verification webhook', { mode, token });
  return res.sendStatus(403);
});

// Messages entrants
router.post('/', async (req, res) => {
  res.sendStatus(200);
  try {
    const parsed = whatsapp.parseWebhookMessage(req.body);
    if (!parsed) return;

    logger.info('Message recu', { from: parsed.from, type: parsed.type, text: parsed.text?.substring(0, 50) });
    await whatsapp.markAsRead(parsed.messageId);

    const user = await userService.findOrCreateUser(parsed.from, parsed.displayName);

    // Onboarding
    if (!user.onboarding_complete) {
      if (!parsed.buttonId) {
        await onboarding.startOnboarding(user);
        return;
      }
      const handled = await onboarding.handleOnboardingResponse(user, parsed.buttonId);
      if (handled) return;
    }

    // Account / plan actions
    if (parsed.buttonId?.startsWith('account_') || parsed.buttonId?.startsWith('plan_')) {
      await handleAccountAction(user, parsed);
      return;
    }

    // Limite messages
    const canSend = userService.canSendMessage(user);
    if (!canSend.allowed) {
      await handleLimitReached(user, canSend.reason);
      return;
    }

    // Boutons contenu quotidien
    if (parsed.buttonId?.startsWith('topic_') || parsed.buttonId?.startsWith('daily_')) {
      await handleContentButton(user, parsed);
      return;
    }

    // Message libre
    await handleFreeMessage(user, parsed);

  } catch (err) {
    logger.error('Erreur traitement webhook', err);
  }
});

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
  const topicResponses = {
    topic_outils: "Super choix !\n\nVoici 3 outils IA que tout le monde devrait connaitre en 2026 :\n\n1. Claude (Anthropic) - Le meilleur pour ecrire, analyser des docs et raisonner\n2. Perplexity - Google dope a l'IA, avec des sources\n3. Gamma - Creer des presentations en 30 secondes\n\nLequel tu veux qu'on explore ensemble ?",
    topic_prompt: "Le secret d'un bon prompt, c'est la structure\n\nVoici la formule magique :\n\nRole + Contexte + Tache + Format\n\nExemple :\n\"Tu es un expert marketing. Mon entreprise vend [X]. Ecris-moi 3 accroches pour une pub Instagram. Format : une phrase + un emoji.\"\n\nEssaie maintenant : envoie-moi un prompt et je te dis comment l'ameliorer !",
    topic_actu: "Voici le top actu IA de cette semaine\n\nJe te prepare un resume chaque matin - en attendant, pose-moi une question sur un sujet qui t'interesse !",
  };

  const response = topicResponses[parsed.buttonId] || "Bonne question ! Dis-moi en plus et je te guide";
  await userService.saveMessage(user.id, 'assistant', response, 'chat');
  await whatsapp.sendText(user.whatsapp_id, response);
}

async function handleLimitReached(user, reason) {
  if (reason === 'trial_expired') {
    const message = 'Ta periode d\'essai de 7 jours est terminee !\n\n' +
      'Pour continuer a apprendre avec moi, choisis un plan :\n\n' +
      'Etudiant - 4,99\u20ac/mois (40 msg/jour)\n' +
      'Pro - 7,99\u20ac/mois (illimite + priorite)\n\n' +
      'Clique ci-dessous pour t\'abonner :';

    await whatsapp.sendButtons(user.whatsapp_id, message, [
      { id: 'plan_etudiant', title: 'Etudiant 4,99\u20ac' },
      { id: 'plan_pro', title: 'Pro 7,99\u20ac' },
    ], null, 'Sans engagement');

  } else if (reason === 'daily_limit') {
    await whatsapp.sendButtons(user.whatsapp_id,
      'Tu as atteint ta limite de messages pour aujourd\'hui (5 messages).\n\n' +
      'Passe au plan Pro pour des messages illimites !',
      [
        { id: 'plan_etudiant', title: 'Etudiant 4,99\u20ac' },
        { id: 'plan_pro', title: 'Pro - Illimite' },
      ]);
  }
}

async function handleAccountAction(user, parsed) {
  if (parsed.buttonId === 'account_info') {
    const planNames = { trial: 'Essai gratuit', etudiant: 'Etudiant', pro: 'Pro', cancelled: 'Annule' };
    const info = 'Ton compte Will\n\n' +
      '- Plan : ' + (planNames[user.plan] || user.plan) + '\n' +
      '- Niveau : ' + user.level + '\n' +
      '- Metier : ' + (user.job || 'Non renseigne') + '\n' +
      '- Messages aujourd\'hui : ' + user.daily_messages_count;

    await whatsapp.sendButtons(user.whatsapp_id, info, [
      { id: 'account_change_level', title: 'Changer niveau' },
      { id: 'account_manage', title: 'Gerer mon plan' },
    ]);
  }

  if (parsed.buttonId === 'account_change_level') {
    await whatsapp.sendButtons(user.whatsapp_id, 'Quel est ton nouveau niveau ?', [
      { id: 'level_debutant', title: 'Debutant' },
      { id: 'level_intermediaire', title: 'Intermediaire' },
      { id: 'level_avance', title: 'Avance' },
    ]);
  }

  if (parsed.buttonId === 'account_manage') {
    if (user.stripe_customer_id && user.plan !== 'trial' && user.plan !== 'cancelled') {
      try {
        const portalSession = await stripe.billingPortal.sessions.create({
          customer: user.stripe_customer_id,
          return_url: process.env.SITE_URL || 'https://will-ai.fr',
        });
        await whatsapp.sendText(user.whatsapp_id,
          'Gere ton abonnement ici :\n' + portalSession.url + '\n\n' +
          'Tu peux modifier ou annuler ton plan a tout moment.');
      } catch (err) {
        logger.error('Erreur creation portal Stripe', err.message);
        await whatsapp.sendText(user.whatsapp_id, 'Ecris-nous a support@will-ai.fr pour gerer ton abonnement.');
      }
    } else {
      await whatsapp.sendButtons(user.whatsapp_id, 'Choisis ton plan pour debloquer tout Will :', [
        { id: 'plan_etudiant', title: 'Etudiant 4,99\u20ac' },
        { id: 'plan_pro', title: 'Pro 7,99\u20ac' },
      ]);
    }
  }

  // Handle plan selection
  if (parsed.buttonId === 'plan_etudiant' || parsed.buttonId === 'plan_pro') {
    const plan = parsed.buttonId.replace('plan_', '');
    const checkoutUrl = await createCheckoutUrl(user, plan);

    if (checkoutUrl) {
      const planNames = { etudiant: 'Etudiant (4,99\u20ac/mois)', pro: 'Pro (7,99\u20ac/mois)' };
      await whatsapp.sendText(user.whatsapp_id,
        'Super ! Voici ton lien de paiement pour le plan ' + planNames[plan] + ' :\n\n' +
        checkoutUrl + '\n\n' +
        'Paiement securise par Stripe. Sans engagement, annulable a tout moment.');
    } else {
      await whatsapp.sendText(user.whatsapp_id, 'Oups, une erreur s\'est produite. Reessaie dans quelques instants !');
    }
  }
}

async function createCheckoutUrl(user, plan) {
  try {
    const priceIds = {
      etudiant: process.env.STRIPE_PRICE_ETUDIANT,
      pro: process.env.STRIPE_PRICE_PRO,
    };

    const priceId = priceIds[plan];
    if (!priceId) {
      logger.error('Price ID manquant pour plan: ' + plan);
      return null;
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: (process.env.SITE_URL || 'https://will-ai.fr') + '/merci?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: (process.env.SITE_URL || 'https://will-ai.fr') + '/offres',
      metadata: {
        userId: String(user.id),
        whatsappId: user.whatsapp_id,
        plan: plan,
      },
      allow_promotion_codes: true,
    });

    return session.url;
  } catch (err) {
    logger.error('Erreur creation checkout Stripe', err.message);
    return null;
  }
}

module.exports = router;
