const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const logger = require('../utils/logger');
const userService = require('../services/userService');
const whatsapp = require('../services/whatsapp');

// Mapping Stripe Price ID -> plan name
const PRICE_TO_PLAN = {
  [process.env.STRIPE_PRICE_ETUDIANT]: 'etudiant',
  [process.env.STRIPE_PRICE_PRO]: 'pro',
};

// Create checkout session
router.post('/create-checkout', async (req, res) => {
  try {
    const { userId, plan } = req.body;
    const priceIds = {
      etudiant: process.env.STRIPE_PRICE_ETUDIANT,
      pro: process.env.STRIPE_PRICE_PRO,
    };

    const priceId = priceIds[plan];
    if (!priceId) {
      return res.status(400).json({ error: 'Plan invalide' });
    }

    const user = await userService.findByStripeCustomerId(userId);

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: (process.env.SITE_URL || 'https://will-ai.fr') + '/merci?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: (process.env.SITE_URL || 'https://will-ai.fr') + '/offres',
      metadata: {
        userId: String(req.body.userId),
        whatsappId: req.body.whatsappId,
        plan: plan,
      },
      allow_promotion_codes: true,
    });

    res.json({ url: session.url });
  } catch (err) {
    logger.error('Erreur creation checkout', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Stripe webhook
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
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

  const planNames = {
    etudiant: 'Etudiant (4,99\u20ac/mois)',
    pro: 'Pro (7,99\u20ac/mois)',
  };

  if (whatsappId) {
    await whatsapp.sendText(whatsappId,
      'Paiement confirme ! Tu es maintenant sur le plan ' + (planNames[plan] || plan) + '.\n\n' +
      'Merci de ta confiance ! Continue a me poser tes questions sur l\'IA.');
  }

  logger.info('Checkout complete', { userId, plan });
}

async function handleSubscriptionCancelled(subscription) {
  const user = await userService.findByStripeCustomerId(subscription.customer);
  if (!user) return;

  await userService.updateProfile(user.id, { plan: 'cancelled' });

  if (user.whatsapp_id) {
    await whatsapp.sendText(user.whatsapp_id,
      'Ton abonnement Will a ete annule.\n\n' +
      'Tu peux te reabonner a tout moment en m\'envoyant un message !');
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
    logger.info('Plan mis a jour', { userId: user.id, newPlan });
  }
}

async function handlePaymentFailed(invoice) {
  const user = await userService.findByStripeCustomerId(invoice.customer);
  if (!user) return;

  if (user.whatsapp_id) {
    await whatsapp.sendText(user.whatsapp_id,
      'Oups ! Le paiement de ton abonnement Will a echoue.\n\n' +
      'Verifie tes informations de paiement pour continuer a profiter de Will.');
  }

  logger.info('Payment failed', { userId: user.id });
}

module.exports = router;
