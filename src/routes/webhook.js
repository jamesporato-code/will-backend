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
  return res.sendStatus(403);
});

// Messages entrants
router.post('/', async (req, res) => {
  res.sendStatus(200);
  try {
    const parsed = whatsapp.parseWebhookMessage(req.body);
    if (!parsed) return;

    logger.info('Message recu', { from: parsed.from, type: parsed.type, text: parsed.text?.substring(0, 50), buttonId: parsed.buttonId || null });

    await whatsapp.markAsRead(parsed.messageId);
    const user = await userService.findOrCreateUser(parsed.from, parsed.displayName);

    // Handle payment confirmation (user redirected from Stripe)
    if (parsed.text?.startsWith('paiement_confirme_')) {
      const plan = parsed.text.replace('paiement_confirme_', '');
      await handlePaymentConfirmed(user, plan);
      return;
    }

    // "mon compte" command
    const textLower = (parsed.text || '').toLowerCase().trim();
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
    if (parsed.buttonId?.startsWith('account_') || parsed.buttonId?.startsWith('plan_') || parsed.buttonId?.startsWith('level_')) {
      await handleAccountAction(user, parsed);
      return;
    }

    // Message limits
    const canSend = await userService.canSendMessage(user);
    if (!canSend.allowed) {
      await handleLimitReached(user, canSend.reason);
      return;
    }

    // Content buttons
    if (parsed.buttonId?.startsWith('topic_') || parsed.buttonId?.startsWith('daily_')) {
      await handleContentButton(user, parsed);
      return;
    }

    // Free message
    await handleFreeMessage(user, parsed);
  } catch (err) {
    logger.error('Erreur traitement webhook', err);
  }
});

// Stripe webhook for payment events
router.post('/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    logger.error('Erreur signature Stripe webhook', err.message);
    return res.status(400).send('Webhook Error');
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const plan = session.metadata?.plan;
    const whatsappId = session.metadata?.whatsappId;
    const userId = session.metadata?.userId;

    if (whatsappId && plan) {
      try {
        await userService.updateProfile(parseInt(userId), {
          plan: plan,
          stripe_customer_id: session.customer,
          stripe_subscription_id: session.subscription,
        });

        const planNames = { etudiant: 'Etudiant', pro: 'Pro' };
        await whatsapp.sendText(
          whatsappId,
          "Paiement confirme ! Bienvenue sur le plan " + (planNames[plan] || plan) + " !\n\n" +
          "Ton plan est maintenant actif. Tu peux me poser toutes tes questions !"
        );
        await new Promise(r => setTimeout(r, 1500));
        await whatsapp.sendButtons(
          whatsappId,
          "Pour commencer, qu'est-ce qui t'interesse le plus ?",
          [
            { id: 'topic_outils', title: 'Decouvrir des outils' },
            { id: 'topic_prompt', title: 'Ecrire de bons prompts' },
            { id: 'topic_actu', title: 'Actu IA du moment' },
          ]
        );
        logger.info('Plan active via Stripe webhook', { userId, plan, whatsappId });
      } catch (err) {
        logger.error('Erreur activation plan Stripe', err);
      }
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    const customerId = subscription.customer;
    try {
      const user = await userService.findByStripeCustomerId(customerId);
      if (user) {
        await userService.updateProfile(user.id, { plan: 'cancelled' });
        await whatsapp.sendText(
          user.whatsapp_id,
          "Ton abonnement a ete annule. Tu peux te reabonner a tout moment en tapant \"mon compte\".\n\nMerci d'avoir utilise Will !"
        );
      }
    } catch (err) {
      logger.error('Erreur annulation abo', err);
    }
  }

  res.json({ received: true });
});

async function handlePaymentConfirmed(user, plan) {
  // User came back from Stripe - check if plan was already updated by webhook
  if (user.plan === plan) {
    await whatsapp.sendText(user.whatsapp_id, "Ton plan " + plan + " est deja actif ! Pose-moi une question ");
  } else {
    await whatsapp.sendText(
      user.whatsapp_id,
      "Merci ! Ton paiement est en cours de verification. Ton plan sera active dans quelques instants.\n\nEn attendant, tu peux deja me poser des questions !"
    );
  }
}

async function handleMyAccount(user) {
  const planNames = { trial: 'Essai gratuit (7j)', freemium: 'Gratuit', etudiant: 'Etudiant', pro: 'Pro', cancelled: 'Annule' };
  const limits = { trial: 5, freemium: 3, etudiant: 40, pro: 'Illimite' };
  const info =
    "Ton compte Will\n\n" +
    "Plan : " + (planNames[user.plan] || user.plan) + "\n" +
    "Niveau : " + (user.level || 'debutant') + "\n" +
    "Domaine : " + (user.job || 'Non renseigne') + "\n" +
    "Messages/jour : " + (limits[user.plan] || '?') + "\n" +
    "Messages utilises : " + (user.daily_message_count || 0);

  if (user.plan === 'pro' || user.plan === 'etudiant') {
    // Paying user - show manage options
    await whatsapp.sendButtons(user.whatsapp_id, info, [
      { id: 'account_manage', title: 'Gerer mon abo' },
      { id: 'account_change_level', title: 'Changer niveau' },
    ]);
  } else {
    // Free/trial user - show upgrade options
    await whatsapp.sendButtons(user.whatsapp_id, info, [
      { id: 'plan_etudiant', title: 'Etudiant 4,99\u20ac' },
      { id: 'plan_pro', title: 'Pro 7,99\u20ac' },
    ], null, 'Passe au niveau superieur');
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
      level: user.level, job: user.job, plan: user.plan, displayName: user.display_name,
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
    topic_outils: "Super choix !\n\nVoici 3 outils IA que tout le monde devrait connaitre en 2026 :\n\n1. Claude (Anthropic) - Le meilleur pour ecrire, analyser et raisonner\n2. Perplexity - Google dope a l'IA, avec des sources\n3. Gamma - Creer des presentations en 30 secondes\n\nLequel tu veux qu'on explore ensemble ?",
    topic_prompt: "Le secret d'un bon prompt, c'est la structure \n\nVoici la formule magique :\n\nRole + Contexte + Tache + Format\n\nExemple :\n\"Tu es un expert marketing. Mon entreprise vend [X]. Ecris-moi 3 accroches pour une pub Instagram. Format : une phrase + un emoji.\"\n\nEssaie maintenant : envoie-moi un prompt et je te dis comment l'ameliorer !",
    topic_actu: "Voici le top actu IA de cette semaine \n\nJe te prepare un resume chaque matin - en attendant, pose-moi une question sur un sujet qui t'interesse !",
  };
  const response = topicResponses[parsed.buttonId] || "Bonne question ! Dis-moi en plus et je te guide ";
  await userService.saveMessage(user.id, 'assistant', response, 'chat');
  await userService.incrementDailyCount(user.id);
  await whatsapp.sendText(user.whatsapp_id, response);
}

async function handleLimitReached(user, reason) {
  if (reason === 'trial_expired') {
    await whatsapp.sendButtons(user.whatsapp_id,
      "Ta periode d'essai de 7 jours est terminee !\n\nPour continuer a apprendre avec moi, choisis un plan :\n\nEtudiant - 4,99\u20ac/mois (40 msg/jour)\nPro - 7,99\u20ac/mois (illimite + priorite)",
      [
        { id: 'plan_etudiant', title: 'Etudiant 4,99\u20ac' },
        { id: 'plan_pro', title: 'Pro 7,99\u20ac' },
      ], null, 'Sans engagement'
    );
  } else if (reason === 'daily_limit') {
    const msg = user.plan === 'etudiant'
      ? "Tu as atteint ta limite de 40 messages aujourd'hui.\n\nPasse au plan Pro pour des messages illimites !"
      : "Tu as atteint ta limite de messages pour aujourd'hui.\n\nDebloque plus de messages avec un abonnement !";
    await whatsapp.sendButtons(user.whatsapp_id, msg, [
      { id: 'plan_pro', title: 'Pro - Illimite' },
      { id: 'account_info', title: 'Mon compte' },
    ]);
  }
}

async function handleAccountAction(user, parsed) {
  if (parsed.buttonId === 'account_info') {
    await handleMyAccount(user);
  }

  if (parsed.buttonId === 'account_change_level') {
    await whatsapp.sendButtons(user.whatsapp_id, 'Quel est ton nouveau niveau ?', [
      { id: 'level_debutant', title: 'Debutant' },
      { id: 'level_intermediaire', title: 'Intermediaire' },
      { id: 'level_avance', title: 'Avance' },
    ]);
  }

  if (parsed.buttonId?.startsWith('level_') && user.onboarding_complete) {
    const level = parsed.buttonId.replace('level_', '');
    await userService.updateProfile(user.id, { level });
    await whatsapp.sendText(user.whatsapp_id, "Mis a jour ! Ton niveau est maintenant : " + level);
  }

  if (parsed.buttonId === 'account_manage') {
    if (user.stripe_customer_id && (user.plan === 'etudiant' || user.plan === 'pro')) {
      try {
        const portalSession = await stripe.billingPortal.sessions.create({
          customer: user.stripe_customer_id,
          return_url: 'https://wa.me/33749181083',
        });
        await whatsapp.sendText(user.whatsapp_id,
          "Gere ton abonnement ici :\n" + portalSession.url + "\n\nTu peux modifier, changer ou annuler ton plan a tout moment."
        );
      } catch (err) {
        logger.error('Erreur portal Stripe', err.message);
        await whatsapp.sendText(user.whatsapp_id, "Contacte support@will-ai.fr pour gerer ton abonnement.");
      }
    } else {
      await whatsapp.sendButtons(user.whatsapp_id, 'Choisis ton plan :', [
        { id: 'plan_etudiant', title: 'Etudiant 4,99\u20ac' },
        { id: 'plan_pro', title: 'Pro 7,99\u20ac' },
      ]);
    }
  }

  if (parsed.buttonId === 'plan_etudiant' || parsed.buttonId === 'plan_pro') {
    const plan = parsed.buttonId.replace('plan_', '');
    const checkoutUrl = await createCheckoutUrl(user, plan);
    if (checkoutUrl) {
      const planNames = { etudiant: 'Etudiant (4,99\u20ac/mois)', pro: 'Pro (7,99\u20ac/mois)' };
      await whatsapp.sendText(user.whatsapp_id,
        "Voici ton lien de paiement pour le plan " + planNames[plan] + " :\n\n" + checkoutUrl + "\n\nPaiement securise par Stripe. Sans engagement."
      );
    } else {
      await whatsapp.sendText(user.whatsapp_id, "Erreur lors de la creation du lien. Reessaie dans quelques instants !");
    }
  }
}

async function createCheckoutUrl(user, plan) {
  try {
    const priceIds = { etudiant: process.env.STRIPE_PRICE_ETUDIANT, pro: process.env.STRIPE_PRICE_PRO };
    const priceId = priceIds[plan];
    if (!priceId) { logger.error('Price ID manquant: ' + plan); return null; }
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: 'https://wa.me/33749181083?text=paiement_confirme_' + plan,
      cancel_url: 'https://wa.me/33749181083?text=mon%20compte',
      metadata: { userId: String(user.id), whatsappId: user.whatsapp_id, plan },
      allow_promotion_codes: true,
    });
    return session.url;
  } catch (err) {
    logger.error('Erreur checkout Stripe', err.message);
    return null;
  }
}

module.exports = router;
