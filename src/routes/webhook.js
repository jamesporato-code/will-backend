const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const whatsapp = require('../services/whatsapp');
const claude = require('../services/claude');
const userService = require('../services/userService');
const onboarding = require('../services/onboarding');
const { getCachedResponse, cacheResponse } = require('../services/redis');

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

router.post('/', async (req, res) => {
  res.sendStatus(200);
  try {
    const parsed = whatsapp.parseWebhookMessage(req.body);
    if (!parsed) return;
    logger.info('Message recu', { from: parsed.from, type: parsed.type, text: parsed.text?.substring(0, 50) });
    await whatsapp.markAsRead(parsed.messageId);
    const user = await userService.findOrCreateUser(parsed.from, parsed.displayName);

    if (!user.onboarding_complete) {
      if (!parsed.buttonId) { await onboarding.startOnboarding(user); return; }
      const handled = await onboarding.handleOnboardingResponse(user, parsed.buttonId);
      if (handled) return;
    }

    if (parsed.buttonId?.startsWith('account_') || parsed.buttonId?.startsWith('plan_')) {
      await handleAccountAction(user, parsed); return;
    }

    const canSend = userService.canSendMessage(user);
    if (!canSend.allowed) { await handleLimitReached(user, canSend.reason); return; }

    if (parsed.buttonId?.startsWith('topic_') || parsed.buttonId?.startsWith('daily_')) {
      await handleContentButton(user, parsed); return;
    }

    await handleFreeMessage(user, parsed);
  } catch (err) { logger.error('Erreur traitement webhook', err); }
});

async function handleFreeMessage(user, parsed) {
  const userText = parsed.text || '';
  const cacheKey = userText.toLowerCase().trim().replace(/[^a-z0-9 ]/g, '').substring(0, 100);
  const cached = await getCachedResponse(cacheKey);
  let response;
  if (cached) { response = cached; }
  else {
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
    await whatsapp.sendButtons(user.whatsapp_id,
      'Ta periode d\'essai est terminee !\n\nPour continuer a apprendre avec moi, choisis un plan :',
      [{ id: 'plan_starter', title: 'Starter - 7/mois' }, { id: 'plan_pro', title: 'Pro - 9,99/mois' }],
      null, 'Sans engagement');
  } else if (reason === 'daily_limit') {
    await whatsapp.sendButtons(user.whatsapp_id,
      'Tu as atteint ta limite de messages pour aujourd\'hui\n\nPasse au plan Pro pour des messages illimites !',
      [{ id: 'plan_pro', title: 'Passer en Pro' }, { id: 'account_info', title: 'Mon compte' }]);
  }
}

async function handleAccountAction(user, parsed) {
  if (parsed.buttonId === 'account_info') {
    const info = 'Ton compte Will\n\n- Plan : ' + user.plan + '\n- Niveau : ' + user.level + '\n- Metier : ' + (user.job || 'Non renseigne') + '\n- Messages aujourd\'hui : ' + user.daily_messages_count;
    await whatsapp.sendButtons(user.whatsapp_id, info, [
      { id: 'account_change_level', title: 'Changer niveau' }, { id: 'account_manage', title: 'Gerer mon plan' }]);
  }
  if (parsed.buttonId === 'account_change_level') {
    await whatsapp.sendButtons(user.whatsapp_id, 'Quel est ton nouveau niveau ?', [
      { id: 'level_debutant', title: 'Debutant' }, { id: 'level_intermediaire', title: 'Intermediaire' }, { id: 'level_avance', title: 'Avance' }]);
  }
  if (parsed.buttonId === 'plan_starter' || parsed.buttonId === 'plan_pro') {
    await whatsapp.sendText(user.whatsapp_id, 'Le paiement sera disponible tres bientot !\n\nEn attendant, profite de ton acces gratuit.');
  }
}

module.exports = router;
