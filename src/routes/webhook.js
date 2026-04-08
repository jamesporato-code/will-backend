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
    logger.info('Webhook v\u00e9rifi\u00e9 par Meta');
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
          conversation: s.conversation ? JSON.stringify(s.conversation) : null,
          pricing: s.pricing ? JSON.stringify(s.pricing) : null,
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

    logger.info('Message re\u00e7u', {
      from: parsed.from,
      type: parsed.type,
      text: parsed.text?.substring(0, 50),
      buttonId: parsed.buttonId || null
    });

    await whatsapp.markAsRead(parsed.messageId);
    const user = await userService.findOrCreateUser(parsed.from, parsed.displayName);

    // === CONFIRMATION DE PAIEMENT (redirect depuis Stripe) ===
    if (parsed.text?.startsWith('paiement_confirme_')) {
      const plan = parsed.text.replace('paiement_confirme_', '').trim();
      logger.info('Paiement confirm\u00e9 via redirect', { userId: user.id, plan });

      const planName = (plan === 'pro') ? 'pro' : 'etudiant';
      await userService.updateProfile(user.id, { plan: planName, onboarding_complete: true });

      const planLabel = planName === 'pro' ? 'Pro' : '\u00c9tudiant';
      await whatsapp.sendText(user.whatsapp_id,
        'Paiement confirm\u00e9 ! \ud83c\udf89 Bienvenue sur le plan ' + planLabel + ' !\n\n' +
        'Ton plan est maintenant actif. Tu peux me poser toutes tes questions sur l\'IA ! \ud83d\ude80'
      );
      await new Promise(r => setTimeout(r, 1500));
      await whatsapp.sendButtons(user.whatsapp_id,
        "Pour commencer, qu'est-ce qui t'int\u00e9resse le plus ? \ud83d\udc47",
        [
          { id: 'topic_outils', title: 'D\u00e9couvrir des outils' },
          { id: 'topic_prompt', title: '\u00c9crire de bons prompts' },
          { id: 'topic_actu', title: 'Actu IA du moment' },
        ]
      );
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
    freemium: 'Gratuit',
    etudiant: '\u00c9tudiant',
    pro: 'Pro',
    cancelled: 'Annul\u00e9'
  };
  const limits = { trial: 5, freemium: 3, etudiant: 40, pro: 'Illimit\u00e9' };

  const info = "\ud83d\udc64 Ton compte Will\n\n" +
    "\ud83d\udccb Plan : " + (planNames[user.plan] || user.plan) + "\n" +
    "\ud83d\udcca Niveau : " + (user.level || 'd\u00e9butant') + "\n" +
    "\ud83d\udcbc Domaine : " + (user.job || 'Non renseign\u00e9') + "\n" +
    "\ud83d\udcac Messages/jour : " + (limits[user.plan] || '?') + "\n" +
    "\u2709\ufe0f Utilis\u00e9s aujourd'hui : " + (user.daily_message_count || 0);

  if (user.plan === 'pro' || user.plan === 'etudiant') {
    await whatsapp.sendButtons(user.whatsapp_id, info, [
      { id: 'account_manage', title: 'G\u00e9rer mon abo' },
      { id: 'account_change_level', title: 'Changer niveau' },
    ]);
  } else {
    await whatsapp.sendButtons(user.whatsapp_id, info, [
      { id: 'plan_etudiant', title: '\u00c9tudiant 4,99\u20ac' },
      { id: 'plan_pro', title: 'Pro 7,99\u20ac' },
    ], null, 'Passe au niveau sup\u00e9rieur \ud83d\ude80');
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

  // Daily interactive buttons (from scheduled messages)
  if (buttonId.startsWith('daily_')) {
    await handleDailyButton(user, buttonId);
    return;
  }

  // Topic buttons (from post-payment suggestions)
  const topicResponses = {
    topic_outils: "Super choix ! \ud83d\udca1\n\nVoici 3 outils IA incontournables :\n\n1. Claude (Anthropic) \u2013 Le meilleur pour \u00e9crire, analyser et raisonner\n2. Perplexity \u2013 Google dop\u00e9 \u00e0 l'IA, avec des sources\n3. Gamma \u2013 Cr\u00e9er des pr\u00e9sentations en 30 secondes\n\nLequel tu veux qu'on explore ensemble ? \ud83d\udd0d",
    topic_prompt: "Le secret d'un bon prompt, c'est la structure \ud83d\udcdd\n\nLa formule magique :\nR\u00f4le + Contexte + T\u00e2che + Format\n\nExemple :\n\"Tu es un expert marketing. Mon entreprise vend [X]. \u00c9cris-moi 3 accroches pour une pub Instagram. Format : une phrase + un emoji.\"\n\nEssaie maintenant : envoie-moi un prompt et je te dis comment l'am\u00e9liorer ! \ud83d\ude80",
    topic_actu: "Je te pr\u00e9pare un r\u00e9sum\u00e9 actu IA chaque matin \ud83d\udcf0\n\nEn attendant, pose-moi une question sur un sujet qui t'int\u00e9resse !",
  };

  const response = topicResponses[buttonId] || "Dis-moi en plus et je te guide ! \ud83d\udcac";
  await userService.saveMessage(user.id, 'assistant', response, 'chat');
  await userService.incrementDailyCount(user.id);
  await whatsapp.sendText(user.whatsapp_id, response);
}

async function handleDailyButton(user, buttonId) {
  const buttonTypeMap = {
    'daily_deep': 'deep',
    'daily_example': 'example',
    'daily_next': 'next',
  };

  const buttonType = buttonTypeMap[buttonId];
  if (!buttonType) return;

  try {
    // Get cached daily content for this user
    const dailyContent = await getCachedResponse('daily:' + user.id);

    if (!dailyContent) {
      await whatsapp.sendText(user.whatsapp_id,
        "Ce contenu n'est plus disponible \ud83d\ude05 Tu recevras un nouveau message demain !"
      );
      return;
    }

    const userContext = {
      level: user.level,
      job: user.job,
      displayName: user.display_name,
    };

    const followup = await claude.generateDailyFollowup(buttonType, dailyContent, userContext);

    await userService.saveMessage(user.id, 'assistant', followup, 'daily');
    await whatsapp.sendText(user.whatsapp_id, followup);

    // Offer next actions (exclude the button already clicked)
    await new Promise(r => setTimeout(r, 1000));

    const nextButtons = [];
    if (buttonType !== 'deep') nextButtons.push({ id: 'daily_deep', title: "J'approfondis \ud83d\udd0d" });
    if (buttonType !== 'example') nextButtons.push({ id: 'daily_example', title: 'Exemple concret \ud83d\udcbc' });
    if (buttonType !== 'next') nextButtons.push({ id: 'daily_next', title: 'Notion suivante \u27a1\ufe0f' });

    if (nextButtons.length > 0) {
      await whatsapp.sendButtons(user.whatsapp_id,
        "Tu veux continuer \u00e0 explorer ? \ud83d\udc47",
        nextButtons
      );
    }
  } catch (err) {
    logger.error('Error handling daily button', err.message);
    await whatsapp.sendText(user.whatsapp_id,
      "Oups, une erreur s'est produite \ud83d\ude05 Tu peux me poser une question directement !"
    );
  }
}

async function handleLimitReached(user, reason) {
  if (reason === 'trial_expired') {
    await whatsapp.sendButtons(user.whatsapp_id,
      "Ta p\u00e9riode d'essai de 7 jours est termin\u00e9e ! \u23f3\n\nPour continuer avec moi :\n\n\ud83c\udf93 \u00c9tudiant \u2014 4,99\u20ac/mois (40 msg/jour)\n\ud83d\ude80 Pro \u2014 7,99\u20ac/mois (illimit\u00e9 + priorit\u00e9)",
      [
        { id: 'plan_etudiant', title: '\u00c9tudiant 4,99\u20ac' },
        { id: 'plan_pro', title: 'Pro 7,99\u20ac' },
      ],
      null,
      'Sans engagement'
    );
  } else if (reason === 'daily_limit') {
    const msg = user.plan === 'etudiant'
      ? "Tu as atteint ta limite de 40 messages aujourd'hui \ud83d\udcac\nPasse au Pro pour l'illimit\u00e9 ! \ud83d\ude80"
      : "Tu as atteint ta limite de messages aujourd'hui \ud83d\udcac\nD\u00e9bloque plus avec un abonnement !";
    await whatsapp.sendButtons(user.whatsapp_id, msg, [
      { id: 'plan_pro', title: 'Pro - Illimit\u00e9' },
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
      { id: 'level_debutant', title: 'D\u00e9butant' },
      { id: 'level_intermediaire', title: 'Interm\u00e9diaire' },
      { id: 'level_avance', title: 'Avanc\u00e9' },
    ]);
  }

  if (parsed.buttonId?.startsWith('level_') && user.onboarding_complete) {
    const level = parsed.buttonId.replace('level_', '');
    await userService.updateProfile(user.id, { level });
    await whatsapp.sendText(user.whatsapp_id, "Mis \u00e0 jour ! \u2705 Ton niveau est maintenant : " + level);
  }

  if (parsed.buttonId === 'account_manage') {
    if (user.stripe_customer_id && (user.plan === 'etudiant' || user.plan === 'pro')) {
      try {
        const portalSession = await stripe.billingPortal.sessions.create({
          customer: user.stripe_customer_id,
          return_url: 'https://wa.me/33749181083',
        });
        await whatsapp.sendText(user.whatsapp_id,
          "G\u00e8re ton abonnement ici \ud83d\udc47\n" + portalSession.url + "\n\nTu peux modifier ou annuler \u00e0 tout moment."
        );
      } catch (err) {
        logger.error('Erreur portal Stripe', err.message);
        await whatsapp.sendText(user.whatsapp_id, "Contacte support@will-ai.fr pour g\u00e9rer ton abonnement \ud83d\udce7");
      }
    } else {
      await whatsapp.sendButtons(user.whatsapp_id, 'Choisis ton plan \ud83d\udc47', [
        { id: 'plan_etudiant', title: '\u00c9tudiant 4,99\u20ac' },
        { id: 'plan_pro', title: 'Pro 7,99\u20ac' },
      ]);
    }
  }

  if (parsed.buttonId === 'plan_etudiant' || parsed.buttonId === 'plan_pro') {
    const plan = parsed.buttonId.replace('plan_', '');
    const checkoutUrl = await createCheckoutUrl(user, plan);

    if (checkoutUrl) {
      const planNames = { etudiant: '\u00c9tudiant (4,99\u20ac/mois)', pro: 'Pro (7,99\u20ac/mois)' };
      await whatsapp.sendText(user.whatsapp_id,
        "Voici ton lien de paiement pour le plan " + planNames[plan] + " \ud83d\udc47\n\n" +
        checkoutUrl + "\n\n\ud83d\udd12 Paiement s\u00e9curis\u00e9 par Stripe. Sans engagement."
      );
    } else {
      await whatsapp.sendText(user.whatsapp_id, "Erreur lors de la cr\u00e9ation du lien \ud83d\ude15 R\u00e9essaie dans quelques instants !");
    }
  }
}

async function createCheckoutUrl(user, plan) {
  try {
    const priceIds = {
      etudiant: process.env.STRIPE_PRICE_ETUDIANT,
      pro: process.env.STRIPE_PRICE_PRO
    };
    const priceId = priceIds[plan];
    if (!priceId) {
      logger.error('Price ID manquant: ' + plan);
      return null;
    }

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
