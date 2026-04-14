const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const logger = require('../utils/logger');
const { findByStripeCustomerId, updateProfile } = require('../services/userService');
const { query } = require('../db/pool');
const whatsapp = require('../services/whatsapp');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

// Webhook Stripe : events subscription + invoice
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    if (webhookSecret) {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } else {
      event = JSON.parse(req.body.toString());
      logger.warn('STRIPE_WEBHOOK_SECRET non configure, verification signature skip');
    }
  } catch (err) {
    logger.error('Stripe webhook signature failed', { error: err.message });
    return res.status(400).send('Webhook Error: ' + err.message);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        logger.info('Stripe checkout.session.completed', { customerId: session.customer, clientRefId: session.client_reference_id });
        // Lie l'user au customer Stripe
        if (session.client_reference_id && session.customer) {
          await updateProfile(session.client_reference_id, { stripe_customer_id: session.customer });
        }
        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        const customerId = invoice.customer;
        logger.info('Stripe invoice.payment_succeeded', { customerId });
        const user = await findByStripeCustomerId(customerId);
        if (user) {
          // Reset eventuel etat payment_failed
          await query(
            'UPDATE users SET payment_failed_at = NULL, payment_grace_until = NULL WHERE id = $1',
            [user.id]
          );
          logger.info('Reset payment_failed state', { userId: user.id });
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const customerId = invoice.customer;
        logger.warn('Stripe invoice.payment_failed', { customerId });
        const user = await findByStripeCustomerId(customerId);
        if (user) {
          // Set payment_failed_at + grace period de 3 jours
          await query(
            "UPDATE users SET payment_failed_at = NOW(), payment_grace_until = NOW() + INTERVAL '3 days' WHERE id = $1",
            [user.id]
          );
          // Notification WhatsApp
          try {
            await whatsapp.sendText(
              user.whatsapp_id,
              '\u26a0\ufe0f *Ton paiement a \u00e9chou\u00e9*\n\n' +
              'Pas de panique : tu as une p\u00e9riode de gr\u00e2ce de 3 jours pour mettre \u00e0 jour ta carte.\n\n' +
              'Tape "mon compte" puis "G\u00e9rer mon abo" pour mettre \u00e0 jour ta carte \ud83d\udd11\n\n' +
              'Apr\u00e8s 3 jours sans paiement, ton acc\u00e8s sera suspendu.'
            );
          } catch (waErr) {
            logger.error('Erreur notif payment_failed', { userId: user.id, error: waErr.message });
          }
          logger.info('Payment failed processed', { userId: user.id });
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const customerId = sub.customer;
        logger.info('Stripe customer.subscription.deleted', { customerId });
        const user = await findByStripeCustomerId(customerId);
        if (user) {
          // Downgrade plan
          await updateProfile(user.id, { plan: 'cancelled' });
          // Clear payment_failed state
          await query(
            'UPDATE users SET payment_failed_at = NULL, payment_grace_until = NULL WHERE id = $1',
            [user.id]
          );
          // Notification WhatsApp
          try {
            await whatsapp.sendText(
              user.whatsapp_id,
              '\ud83d\udc4b Ton abonnement a \u00e9t\u00e9 annul\u00e9.\n\n' +
              'Tu n\'as plus acc\u00e8s aux messages Will. Merci d\'avoir test\u00e9 !\n\n' +
              'Si tu veux revenir, tape "mon compte" et choisis un plan \ud83d\ude80'
            );
          } catch (waErr) {
            logger.error('Erreur notif subscription.deleted', { userId: user.id, error: waErr.message });
          }
          logger.info('Subscription cancelled for user', { userId: user.id });
        }
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const customerId = sub.customer;
        logger.info('Stripe customer.subscription.updated', { customerId, status: sub.status });
        // On ignore pour l'instant sauf si cancel_at_period_end
        const user = await findByStripeCustomerId(customerId);
        if (user && sub.cancel_at_period_end) {
          try {
            await whatsapp.sendText(
              user.whatsapp_id,
              '\ud83d\udcec Ton abonnement sera annul\u00e9 \u00e0 la fin de la p\u00e9riode en cours.\n\n' +
              'Tu gardes tous tes acc\u00e8s jusqu\'au ' +
              new Date(sub.current_period_end * 1000).toLocaleDateString('fr-FR') + '.'
            );
          } catch (waErr) {
            logger.error('Erreur notif subscription.updated', { userId: user.id, error: waErr.message });
          }
        }
        break;
      }

      default:
        logger.debug('Stripe event non trait\u00e9', { type: event.type });
    }

    res.json({ received: true });
  } catch (err) {
    logger.error('Erreur traitement webhook Stripe', { type: event?.type, error: err.message });
    res.status(500).json({ error: 'Erreur traitement webhook' });
  }
});

module.exports = router;
