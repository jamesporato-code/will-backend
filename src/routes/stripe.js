const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const logger = require('../utils/logger');
const { query } = require('../db/pool');
const userService = require('../services/userService');
const whatsapp = require('../services/whatsapp');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Map Stripe price IDs to plan names
const PRICE_TO_PLAN = {
  [process.env.STRIPE_PRICE_ETUDIANT]: 'etudiant',
  [process.env.STRIPE_PRICE_PRO]: 'pro',
  [process.env.STRIPE_PRICE_MAX]: 'max',
};

// Create Checkout Session endpoint
router.post('/create-checkout', express.json(), async (req, res) => {
  try {
    const { userId, plan, whatsappId } = req.body;

    const priceIds = {
      etudiant: process.env.STRIPE_PRICE_ETUDIANT,
      pro: process.env.STRIPE_PRICE_PRO,
      max: process.env.STRIPE_PRICE_MAX,
    };

    const priceId = priceIds[plan];
    if (!priceId) {
      return res.status(400).json({ error: 'Plan invalide' });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: (process.env.SITE_URL || 'https://will-ai.fr') + '/merci?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: (process.env.SITE_URL || 'https://will-ai.fr') + '/offres',
      metadata: { userId: String(userId), whatsappId, plan },
      allow_promotion_codes: true,
    });

    res.json({ url: session.url });
  } catch (err) {
    logger.error('Erreur creation session Stripe', err.message);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

// Stripe Webhook
router.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    logger.error('Signature Stripe invalide', err.message);
    return res.status(400).send('Signature invalide');
  }

  logger.info('Stripe event recu: ' + event.type);

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
      default:
        logger.info('Event Stripe ignore: ' + event.type);
    }
  } catch (err) {
    logger.error('Erreur traitement event Stripe', err);
  }

  res.sendStatus(200);
});

async function handleCheckoutCompleted(session) {
  const { userId, whatsappId, plan } = session.metadata;
  const customerId = session.customer;
  const subscriptionId = session.subscription;

  logger.info('Checkout complete', { userId, plan, customerId });

  // Update user with plan + Stripe IDs
  await userService.updateProfile(parseInt(userId), {
    plan: plan,
    stripe_customer_id: customerId,
    stripe_subscription_id: subscriptionId,
  });

  // Send WhatsApp confirmation
  if (whatsappId) {
    const planNames = { etudiant: 'Etudiant (4,99â¬/mois)', pro: 'Pro (7,99â¬/mois)', max: 'Max (11,99â¬/mois)' };
    const planName = planNames[plan] || plan;
    await whatsapp.sendText(whatsappId,
      'Paiement confirme !\n\n' +
      'Tu es maintenant sur le plan ' + planName + '.\n\n' +
      'Merci de ta confiance ! On continue a apprendre ensemble ?'
    );
  }
}

async function handleSubscriptionCancelled(subscription) {
  const customerId = subscription.customer;
  const user = await userService.findByStripeCustomerId(customerId);

  if (!user) {
    logger.warn('Subscription cancelled - user not found for customer: ' + customerId);
    return;
  }

  logger.info('Subscription cancelled', { userId: user.id, customerId });

  await userService.updateProfile(user.id, { plan: 'cancelled' });

  await whatsapp.sendText(user.whatsapp_id,
    'Ton abonnement a ete annule.\n\n' +
    'Tu peux te reabonner a tout moment en m\'envoyant un message !\n\n' +
    'A bientot !'
  );
}

async function handleSubscriptionUpdated(subscription) {
  const customerId = subscription.customer;
  const user = await userService.findByStripeCustomerId(customerId);

  if (!user) return;

  // Check if subscription went past_due or unpaid
  if (subscription.status === 'past_due') {
    await whatsapp.sendText(user.whatsapp_id,
      'Attention : ton dernier paiement a echoue.\n\n' +
      'Verifie tes informations de paiement pour ne pas perdre ton acces.\n\n' +
      'Lien : ' + (process.env.STRIPE_CUSTOMER_PORTAL_URL || 'https://billing.stripe.com')
    );
  }
}

async function handlePaymentFailed(invoice) {
  const customerId = invoice.customer;
  const user = await userService.findByStripeCustomerId(customerId);

  if (!user) {
    logger.warn('Payment failed - user not found for customer: ' + customerId);
    return;
  }

  logger.info('Payment failed', { userId: user.id, customerId });

  await whatsapp.sendText(user.whatsapp_id,
    'Oups, ton paiement n\'a pas pu etre traite.\n\n' +
    'Verifie ta carte bancaire et reessaie.\n' +
    'Si le probleme persiste, ecris-moi !'
  );
}

module.exports = router;
