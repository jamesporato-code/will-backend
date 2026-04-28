// ============================================
// WEBHOOK WhatsApp — Will Coach IA
// Plan unique : Trial (7j gratuit) → Pro (6,99 €/mois)
// Stripe webhook (src/routes/stripe.js) est la SEULE source de vérité
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
const menu = require('../services/menu');
const { getCachedResponse } = require('../services/redis');
const { handleProMenuChoice, sendDailyForUser } = require('../cron/scheduler');
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Vérification Meta
router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    logger.info('Webhook vérifié par Meta');
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

    logger.info('Message reçu', {
      from: parsed.from,
      type: parsed.type,
      text: parsed.text?.substring(0, 50),
      buttonId: parsed.buttonId || null,
    });

    await whatsapp.markAsRead(parsed.messageId);
    const user = await userService.findOrCreateUser(parsed.from, parsed.displayName);

    // === REDIRECT POST-PAIEMENT (texte non fiable, juste UX) ===
    if (parsed.text?.startsWith('paiement_confirme_')) {
      logger.info('Redirect post-paiement reçu (UX only, no plan change)', { userId: user.id });
      if (user.plan === 'pro') {
        await whatsapp.sendText(
          user.whatsapp_id,
          'Tout est en ordre, ton plan Pro est actif. Pose-moi tes questions sur l\'IA quand tu veux.'
        );
      } else {
        await whatsapp.sendText(
          user.whatsapp_id,
          'Merci. Je vérifie ton paiement avec Stripe — ça prend quelques secondes. Tu recevras un message dès que c\'est confirmé.'
        );
      }
      return;
    }

    const textLower = (parsed.text || '').toLowerCase().trim();

    // === SLASH COMMANDS (disponibles avant et après onboarding) ===
    if (textLower === '/menu' || textLower === 'menu') {
      if (!user.onboarding_complete) {
        const handled = await onboarding.handleOnboarding(user, parsed);
        if (handled) return;
      }
      await menu.showMainMenu(user);
      return;
    }

    if (textLower === '/help' || textLower === 'help' || textLower === '/aide') {
      await menu.showHelp(user);
      return;
    }

    if (textLower === '/stop' || textLower === 'stop') {
      await userService.updateProfile(user.id, { daily_opt_in: false });
      await whatsapp.sendText(
        user.whatsapp_id,
        'Messages quotidiens désactivés.\n\n' +
        'Tu peux toujours me poser des questions quand tu veux. Tape /daily pour les réactiver.'
      );
      return;
    }

    if (textLower === '/daily') {
      const newStatus = !user.daily_opt_in;
      await userService.updateProfile(user.id, { daily_opt_in: newStatus });
      const hour = user.preferred_hour || 8;
      const minute = user.preferred_minute || 0;
      const minPad = minute < 10 ? '0' + minute : '' + minute;
      await whatsapp.sendText(
        user.whatsapp_id,
        newStatus
          ? 'Messages quotidiens réactivés. Tu recevras le prochain à ' + hour + 'h' + minPad + '.'
          : 'Messages quotidiens désactivés. Tape /daily pour les réactiver.'
      );
      return;
    }

    // "mon compte"
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

    // Limites de messages
    const canSend = await userService.canSendMessage(user);
    if (!canSend.allowed) {
      await handleLimitReached(user, canSend.reason);
      return;
    }

    // Quiz capture profil (depuis menu_quiz)
    if (parsed.listId?.startsWith('quiz_')) {
      const handled = await menu.handleQuizAnswer(user, parsed.listId);
      if (handled) return;
    }

    // Hub /menu : nouveaux boutons (menu_hub, menu_today, menu_help, menu_quiz)
    if (parsed.buttonId?.startsWith('menu_') || parsed.listId?.startsWith('menu_')) {
      const id = parsed.buttonId || parsed.listId;
      const handled = await menu.handleMenuButton(user, id);
      if (handled) return;
      // Fallback : menu_parcours / menu_actu / menu_outil / menu_prompt / menu_account
      if (id === 'menu_account') {
        await handleMyAccount(user);
        return;
      }
      await handleProMenuChoice(user, id);
      return;
    }

    // Boutons de contenu (topic + daily)
    if (parsed.buttonId?.startsWith('topic_') || parsed.buttonId?.startsWith('daily_')) {
      await handleContentButton(user, parsed);
      return;
    }

    // Texte libre → redirige vers le hub /menu (Will fonctionne par boutons)
    if (parsed.text) {
      await menu.showMainMenu(
        user,
        'Will fonctionne entièrement par boutons — pas besoin d\'écrire. Choisis ce que tu veux faire ci-dessous.'
      );
      return;
    }

  } catch (err) {
    logger.error('Erreur traitement webhook', err);
  }
});

async function handleMyAccount(user) {
  const planNames = {
    trial: 'Essai gratuit (7 jours)',
    pro: 'Pro',
    cancelled: 'Annulé',
  };
  const limits = { trial: 15, pro: 'Illimité', cancelled: 0 };

  const stats = await getUserStats(user.id);
  const info = '*Ton compte Will*\n\n' +
    'Plan : ' + (planNames[user.plan] || user.plan) + '\n' +
    'Niveau : ' + (user.level || 'débutant') + '\n' +
    'Domaine : ' + (user.job || 'Non renseigné') + '\n' +
    'Messages par jour : ' + (limits[user.plan] || '?') + '\n' +
    'Utilisés aujourd\'hui : ' + (user.daily_message_count || 0) + '\n\n' +
    '*Ton activité*\n' +
    '- ' + stats.msgWeek + ' messages cette semaine\n' +
    '- ' + stats.msgTotal + ' messages au total\n' +
    '- ' + stats.activeDaysMonth + ' jours actifs sur les 30 derniers\n' +
    '~' + stats.hoursSavedTotal + 'h gagnées depuis ton inscription';

  if (user.plan === 'pro') {
    await whatsapp.sendButtons(user.whatsapp_id, info, [
      { id: 'account_manage', title: 'Gérer mon abo' },
      { id: 'account_change_level', title: 'Changer niveau' },
    ]);
  } else {
    await whatsapp.sendButtons(user.whatsapp_id, info, [
      { id: 'plan_pro', title: 'Pro 6,99/mois' },
      { id: 'account_change_level', title: 'Changer niveau' },
    ], null, 'Pro pour tout débloquer');
  }
}

async function handleContentButton(user, parsed) {
  const buttonId = parsed.buttonId;

  if (buttonId.startsWith('daily_')) {
    await handleDailyButton(user, buttonId);
    return;
  }

  const topicResponses = {
    topic_outils: 'Bon choix.\n\n' +
      'Trois outils IA incontournables pour démarrer :\n\n' +
      '1. Claude (Anthropic) — Le plus solide pour écrire, analyser, raisonner\n' +
      '2. Perplexity — Recherche web augmentée à l\'IA, avec sources\n' +
      '3. Gamma — Présentations générées en quelques secondes\n\n' +
      'Lequel veux-tu qu\'on explore en premier ?',
    topic_prompt: 'Le secret d\'un bon prompt, c\'est sa structure.\n\n' +
      'La formule de base :\nRôle + Contexte + Tâche + Format\n\n' +
      'Exemple :\n"Tu es un expert marketing. Mon entreprise vend [X]. ' +
      'Écris-moi 3 accroches pour une pub Instagram. Format : une phrase + un emoji."\n\n' +
      'Essaie : envoie-moi un prompt et je te dis comment l\'améliorer.',
    topic_actu: 'Je te prépare un résumé d\'actu IA chaque matin.\n\n' +
      'En attendant, pose-moi une question sur un sujet qui t\'intéresse.',
  };
  const response = topicResponses[buttonId] || 'Dis-m\'en plus et je te guide.';
  await userService.saveMessage(user.id, 'assistant', response, 'chat');
  await userService.incrementDailyCount(user.id);
  await whatsapp.sendText(user.whatsapp_id, response);
}

async function handleDailyButton(user, buttonId) {
  const buttonTypeMap = { daily_deep: 'deep', daily_example: 'example', daily_minidefi: 'minidefi' };
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
    if (buttonType !== 'minidefi') nextButtons.push({ id: 'daily_minidefi', title: 'Mini-défi' });
    if (nextButtons.length > 0) {
      await whatsapp.sendButtons(user.whatsapp_id, 'Tu veux continuer à explorer ?', nextButtons);
    }
  } catch (err) {
    logger.error('Error handling daily button', err.message);
    await whatsapp.sendText(
      user.whatsapp_id,
      'Une erreur s\'est produite. Tu peux me poser une question directement.'
    );
  }
}

async function handleLimitReached(user, reason) {
  if (reason === 'trial_expired') {
    await whatsapp.sendButtons(
      user.whatsapp_id,
      'Ta période d\'essai de 7 jours est terminée.\n\n' +
      'Pour continuer ton parcours :\n\n' +
      'Pro — 6,99 €/mois (parcours qui s\'enrichit en continu, actu, outils, prompts)\n' +
      'Sans engagement, tu annules quand tu veux.',
      [{ id: 'plan_pro', title: 'Pro 6,99/mois' }],
      null,
      'Sans engagement'
    );
  } else if (reason === 'daily_limit') {
    await whatsapp.sendButtons(
      user.whatsapp_id,
      'Tu as atteint ta limite de messages aujourd\'hui.\n\nPasse au Pro pour des messages illimités.',
      [
        { id: 'plan_pro', title: 'Pro illimité' },
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
      { id: 'level_debutant', title: 'Débutant' },
      { id: 'level_intermediaire', title: 'Intermédiaire' },
      { id: 'level_avance', title: 'Avancé' },
    ]);
    return;
  }

  if (parsed.buttonId?.startsWith('level_') && user.onboarding_complete) {
    const level = parsed.buttonId.replace('level_', '');
    await userService.updateProfile(user.id, { level });
    await whatsapp.sendText(user.whatsapp_id, 'Mis à jour. Ton niveau est maintenant : ' + level + '.');
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
          'Gère ton abonnement ici :\n' + portalSession.url + '\n\nTu peux modifier ou annuler à tout moment.'
        );
      } catch (err) {
        logger.error('Erreur portal Stripe', err.message);
        await whatsapp.sendText(user.whatsapp_id, 'Contacte support@will-ai.fr pour gérer ton abonnement.');
      }
    } else {
      await whatsapp.sendButtons(user.whatsapp_id, 'Passe au Pro pour tout débloquer.', [
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
        'Voici ton lien de paiement (Pro, 6,99 €/mois) :\n\n' +
        checkoutUrl + '\n\nPaiement sécurisé par Stripe. Sans engagement.'
      );
    } else {
      await whatsapp.sendText(user.whatsapp_id, 'Erreur lors de la création du lien. Réessaie dans quelques instants.');
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
