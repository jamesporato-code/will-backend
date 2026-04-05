const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const logger = require('../utils/logger');
const userService = require('../services/userService');
const whatsapp = require('../services/whatsapp');

const PRICE_TO_PLAN = {
  [process.env.STRIPE_PRICE_ETUDIANT]: 'etudiant',
  [process.env.STRIPE_PRICE_PRO]: 'pro',
};

// Stripe webhook
router.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    logger.error('Erreur signature webhook Stripe', err.message);
    return res.status(400).send('Webhook Error');
  }

  logger.info('Stripe event recu', { type: event.type });

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event.data.object);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionCancelled(event.data.object);
        break;
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event.data.object);
        break;
      case 'invoice.payment_failed':
        await handlePaymentFailed(event.data.object);
        break;
    }
  } catch (err) {
    logger.error('Erreur traitement event Stripe', err.message);
  }

  res.json({ received: true });
});

async function handleCheckoutCompleted(session) {
  const { userId, whatsappId, plan } = session.metadata;
  if (!userId || !plan) return;

  await userService.updateProfile(parseInt(userId), {
    plan: plan,
    stripe_customer_id: session.customer,
    stripe_subscription_id: session.subscription,
  });

  const planNames = { etudiant: 'Etudiant', pro: 'Pro' };

  if (whatsappId) {
    await whatsapp.sendText(
      whatsappId,
      'Paiement confirme ! Bienvenue sur le plan ' + (planNames[plan] || plan) + ' !\n\n' +
      'Ton plan est maintenant actif. Tu peux me poser toutes tes questions sur l\'IA !\n\n' +
      'Tape "mon compte" a tout moment pour gerer ton abonnement.'
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
  }

  logger.info('Checkout complete', { userId, plan });
}

async function handleSubscriptionCancelled(subscription) {
  const user = await userService.findByStripeCustomerId(subscription.customer);
  if (!user) return;

  await userService.updateProfile(user.id, { plan: 'cancelled' });

  if (user.whatsapp_id) {
    await whatsapp.sendButtons(
      user.whatsapp_id,
      "Ton abonnement a ete annule.\n\nTu peux te reabonner a tout moment !",
      [
        { id: 'plan_etudiant', title: 'Etudiant 4,99\u20ac' },
        { id: 'plan_pro', title: 'Pro 7,99\u20ac' },
      ],
      null,
      'Merci d\'avoir utilise Will'
    );
  }
  logger.info('Subscription cancelled', { userId: user.id });
}

async function handleSubscriptionUpdated(subscription) {
  const user = await userService.findByStripeCustomerId(subscription.customer);
  if (!user) return;

  const priceId = subscription.items?.data?.[0]?.price?.id;
  const newPlan = PRICE_TO_PLAN[priceId];

  if (newPlan && newPlan !== user.plan) {
    await userService.updateProfile(user.id, { plan: newPlan });
    if (user.whatsapp_id) {
      const planNames = { etudiant: 'Etudiant', pro: 'Pro' };
      await whatsapp.sendText(
        user.whatsapp_id,
        'Ton plan a ete mis a jour : ' + (planNames[newPlan] || newPlan) + ' ! Les changements sont actifs immediatement.'
      );
    }
    logger.info('Plan mis a jour', { userId: user.id, newPlan });
  }
}

async function handlePaymentFailed(invoice) {
  const user = await userService.findByStripeCustomerId(invoice.customer);
  if (!user) return;

  if (user.whatsapp_id) {
    await whatsapp.sendText(
      user.whatsapp_id,
      'Le paiement de ton abonnement Will a echoue.\n\n' +
      'Verifie tes informations de paiement pour continuer a profiter de Will.\n\n' +
      'Tape "mon compte" pour gerer ton abonnement.'
    );
  }
  logger.info('Payment failed', { userId: user.id });
}

module.exports = router;
