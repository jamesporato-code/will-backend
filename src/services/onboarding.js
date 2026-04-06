const whatsapp = require('./whatsapp');
const { updateProfile } = require('./userService');
const logger = require('../utils/logger');
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function handleOnboarding(user, parsed) {
  const step = user.onboarding_step || 0;
  const name = user.display_name?.split(' ')[0] || '';

  logger.info('Onboarding step', { userId: user.id, step, buttonId: parsed.buttonId, listId: parsed.listId, text: parsed.text?.substring(0, 30) });

  // Step 0: Welcome + ask level
  if (step === 0) {
    try {
      const greeting = name ? ('Salut ' + name + ' ! 👋') : 'Salut ! 👋';
      logger.info('Onboarding step 0: sending greeting', { userId: user.id, whatsappId: user.whatsapp_id });
      await whatsapp.sendText(
        user.whatsapp_id,
        greeting + '\n\n' +
        "Moi c'est Will, ton coach perso spécialisé en IA 🤖\n\n" +
        "Mon job : t'aider à maîtriser l'IA au quotidien, que ce soit pour ton travail, tes projets ou ta curiosité.\n\n" +
        "Avant de démarrer, je vais te poser quelques questions rapides pour personnaliser ton expérience ⚡ (30 secondes)."
      );
      logger.info('Onboarding step 0: greeting sent, sending buttons', { userId: user.id });
      await delay(2000);
      await whatsapp.sendButtons(
        user.whatsapp_id,
        "Quel est ton niveau actuel en intelligence artificielle ?",
        [
          { id: 'ob_level_debutant', title: 'Débutant' },
          { id: 'ob_level_intermediaire', title: 'Intermédiaire' },
          { id: 'ob_level_avance', title: 'Avancé' },
        ],
        null,
        "Pas de mauvaise réponse 😉"
      );
      logger.info('Onboarding step 0: buttons sent, updating profile', { userId: user.id });
      await updateProfile(user.id, { onboarding_step: 1 });
      logger.info('Onboarding step 0: complete', { userId: user.id });
      return true;
    } catch (err) {
      logger.error('Onboarding step 0 FAILED', { userId: user.id, error: err.message, stack: err.stack?.substring(0, 300), response: err.response?.data });
      throw err;
    }
  }

  // Step 1: Got level - ask job
  if (step === 1 && parsed.buttonId?.startsWith('ob_level_')) {
    const level = parsed.buttonId.replace('ob_level_', '');
    await updateProfile(user.id, { level, onboarding_step: 2 });

    const levelMsg = {
      debutant: "Parfait, on va y aller progressivement ! 👌",
      intermediaire: "Top, tu as déjà de bonnes bases ! 💪",
      avance: "Excellent, on va pouvoir aller loin ensemble ! 🚀"
    };
    await whatsapp.sendText(user.whatsapp_id, levelMsg[level] || "Noté !");
    await delay(1000);
    await whatsapp.sendList(
      user.whatsapp_id,
      "Dans quel domaine tu travailles ? Ça me permet d'adapter mes conseils à ton quotidien 🎯",
      "Choisir mon domaine",
      [{
        title: "Domaines",
        rows: [
          { id: 'ob_job_marketing', title: 'Marketing / Comm', description: 'Pub, contenu, réseaux sociaux' },
          { id: 'ob_job_tech', title: 'Tech / Dev', description: 'Développement, data, produit, IT' },
          { id: 'ob_job_business', title: 'Business / Finance', description: 'Vente, gestion, conseil' },
          { id: 'ob_job_creation', title: 'Création / Design', description: 'Graphisme, vidéo, UX, photo' },
          { id: 'ob_job_education', title: 'Éducation / RH', description: 'Formation, recrutement' },
          { id: 'ob_job_sante', title: 'Santé / Sciences', description: 'Médical, recherche, pharma' },
          { id: 'ob_job_etudiant', title: 'Étudiant', description: 'Licence, master, doctorat' },
          { id: 'ob_job_autre', title: 'Autre', description: 'Autre secteur ou indépendant' },
        ]
      }]
    );
    return true;
  }

  // Step 2: Got job - ask goal
  if (step === 2 && parsed.listId?.startsWith('ob_job_')) {
    const jobMap = {
      ob_job_marketing: 'Marketing / Communication',
      ob_job_tech: 'Tech / Développement',
      ob_job_business: 'Business / Finance',
      ob_job_creation: 'Création / Design',
      ob_job_education: 'Éducation / RH',
      ob_job_sante: 'Santé / Sciences',
      ob_job_etudiant: 'Étudiant',
      ob_job_autre: 'Autre'
    };
    const job = jobMap[parsed.listId] || parsed.text || 'Non précisé';
    await updateProfile(user.id, { job, onboarding_step: 3 });

    await whatsapp.sendButtons(
      user.whatsapp_id,
      "Et concrètement, qu'est-ce que tu attends le plus de Will ? 🤔",
      [
        { id: 'ob_goal_productivite', title: 'Gagner du temps' },
        { id: 'ob_goal_apprendre', title: "Apprendre l'IA" },
        { id: 'ob_goal_veille', title: 'Rester informé' },
      ],
      null,
      "Ça m'aide à prioriser tes contenus"
    );
    return true;
  }

  // Step 3: Got goal - ask preferred daily message hour
  if (step === 3 && parsed.buttonId?.startsWith('ob_goal_')) {
    const goalMap = {
      ob_goal_productivite: 'Gagner en productivité',
      ob_goal_apprendre: "Apprendre à maîtriser l'IA",
      ob_goal_veille: "Rester informé sur l'IA"
    };
    const interests = goalMap[parsed.buttonId] || "Explorer l'IA";
    await updateProfile(user.id, { interests, onboarding_step: 4 });

    await whatsapp.sendText(user.whatsapp_id, "Parfait ! Chaque jour je t'envoie un message personnalisé sur l'IA 📬");
    await delay(1000);

    // Mention that user can type the time
    await whatsapp.sendText(user.whatsapp_id, "Tu peux aussi écrire directement l'heure que tu préfères (ex : 8h30, 14h00) ✍️");
    await delay(1000);

    // Expanded 2-section list with more time options
    await whatsapp.sendList(
      user.whatsapp_id,
      "À quelle heure tu veux recevoir ton message quotidien ? ⏰",
      "Choisir mon heure",
      [
        {
          title: "Matin ☀️",
          rows: [
            { id: 'ob_hour_6', title: '6h00', description: 'Très tôt le matin' },
            { id: 'ob_hour_7', title: '7h00', description: 'Tôt le matin 🌅' },
            { id: 'ob_hour_8', title: '8h00', description: 'Début de journée' },
            { id: 'ob_hour_9', title: '9h00', description: 'En arrivant au travail' },
            { id: 'ob_hour_10', title: '10h00', description: 'Milieu de matinée' },
            { id: 'ob_hour_11', title: '11h00', description: 'Fin de matinée' },
            { id: 'ob_hour_12', title: '12h00', description: 'Pause déjeuner 🍲' },
          ]
        },
        {
          title: "Après-midi / Soir 🌙",
          rows: [
            { id: 'ob_hour_13', title: '13h00', description: 'Début d\'après-midi' },
            { id: 'ob_hour_14', title: '14h00', description: 'Milieu d\'après-midi' },
            { id: 'ob_hour_15', title: '15h00', description: 'Milieu d\'après-midi' },
            { id: 'ob_hour_16', title: '16h00', description: 'Fin d\'après-midi' },
            { id: 'ob_hour_17', title: '17h00', description: 'Fin d\'après-midi' },
            { id: 'ob_hour_18', title: '18h00', description: 'Fin de journée' },
            { id: 'ob_hour_19', title: '19h00', description: 'Soirée' },
            { id: 'ob_hour_20', title: '20h00', description: 'En soirée 🌙' },
            { id: 'ob_hour_21', title: '21h00', description: 'Tard le soir' },
            { id: 'ob_hour_22', title: '22h00', description: 'Très tard le soir' },
          ]
        }
      ]
    );
    return true;
  }

  // Step 4: Got preferred hour - recap + plan choice
  if (step === 4) {
    let hour = null;

    // Handle list selection
    if (parsed.listId?.startsWith('ob_hour_')) {
      hour = parseInt(parsed.listId.replace('ob_hour_', ''), 10);
    }
    // Handle text input for hour (e.g., "8h", "8h30", "08:30", "14h00", "9", etc.)
    else if (parsed.text) {
      const text = parsed.text.trim().toLowerCase();
      // Try to parse various time formats
      let match;
      // Format: "8h30", "14h00", "8h"
      match = text.match(/^(\d{1,2})\s*h\s*(\d{0,2})$/);
      if (!match) {
        // Format: "08:30", "14:00"
        match = text.match(/^(\d{1,2})\s*:\s*(\d{0,2})$/);
      }
      if (!match) {
        // Just a number: "8", "14", "20"
        match = text.match(/^(\d{1,2})$/);
        if (match) match[2] = '0';
      }
      if (match) {
        const h = parseInt(match[1], 10);
        if (h >= 0 && h <= 23) {
          hour = h;
        }
      }
    }

    if (hour === null) {
      // Invalid input at step 4
      await whatsapp.sendText(
        user.whatsapp_id,
        "Hmm, je n'ai pas compris l'heure 🤔\n\nÉcris-la au format 8h30, 14h00, ou choisis dans la liste ci-dessous 👇"
      );
      await delay(500);
      await whatsapp.sendList(
        user.whatsapp_id,
        "À quelle heure tu veux recevoir ton message quotidien ? ⏰",
        "Choisir mon heure",
        [
          {
            title: "Matin ☀️",
            rows: [
              { id: 'ob_hour_6', title: '6h00', description: 'Très tôt le matin' },
              { id: 'ob_hour_7', title: '7h00', description: 'Tôt le matin 🌅' },
              { id: 'ob_hour_8', title: '8h00', description: 'Début de journée' },
              { id: 'ob_hour_9', title: '9h00', description: 'En arrivant au travail' },
              { id: 'ob_hour_10', title: '10h00', description: 'Milieu de matinée' },
              { id: 'ob_hour_11', title: '11h00', description: 'Fin de matinée' },
              { id: 'ob_hour_12', title: '12h00', description: 'Pause déjeuner 🍲' },
            ]
          },
          {
            title: "Après-midi / Soir 🌙",
            rows: [
              { id: 'ob_hour_13', title: '13h00', description: 'Début d\'après-midi' },
              { id: 'ob_hour_14', title: '14h00', description: 'Milieu d\'après-midi' },
              { id: 'ob_hour_15', title: '15h00', description: 'Milieu d\'après-midi' },
              { id: 'ob_hour_16', title: '16h00', description: 'Fin d\'après-midi' },
              { id: 'ob_hour_17', title: '17h00', description: 'Fin d\'après-midi' },
              { id: 'ob_hour_18', title: '18h00', description: 'Fin de journée' },
              { id: 'ob_hour_19', title: '19h00', description: 'Soirée' },
              { id: 'ob_hour_20', title: '20h00', description: 'En soirée 🌙' },
              { id: 'ob_hour_21', title: '21h00', description: 'Tard le soir' },
              { id: 'ob_hour_22', title: '22h00', description: 'Très tard le soir' },
            ]
          }
        ]
      );
      return true;
    }

    // Valid hour - continue with recap
    await updateProfile(user.id, { preferred_hour: hour, onboarding_step: 5 });

    const hourDisplay = hour + 'h00';
    const recap = "Ton profil Will est prêt ! ✅\n\n" +
      "📊 Niveau : " + (user.level || 'débutant') + "\n" +
      "💼 Domaine : " + (user.job || 'Non précisé') + "\n" +
      "🎯 Objectif : " + (user.interests || "Explorer l'IA") + "\n" +
      "⏰ Message quotidien : " + hourDisplay + "\n\n" +
      "Je vais personnaliser tous mes conseils en fonction de ça 💪";
    await whatsapp.sendText(user.whatsapp_id, recap);
    await delay(2000);
    await whatsapp.sendButtons(
      user.whatsapp_id,
      "Dernière étape : choisis comment tu veux utiliser Will 👇\n\n" +
      "🆕 Essai gratuit — 7 jours, 5 msg/jour\n" +
      "🎓 Étudiant — 4,99€/mois, 40 msg/jour\n" +
      "🚀 Pro — 7,99€/mois, illimité + priorité",
      [
        { id: 'ob_plan_trial', title: 'Essai gratuit 7j' },
        { id: 'ob_plan_etudiant', title: 'Étudiant 4,99€' },
        { id: 'ob_plan_pro', title: 'Pro 7,99€' },
      ],
      null,
      'Tu pourras changer à tout moment'
    );
    return true;
  }

  // Step 5: Got plan choice - complete
  if (step === 5 && parsed.buttonId?.startsWith('ob_plan_')) {
    const planMap = {
      ob_plan_trial: { name: 'trial', price: 0 },
      ob_plan_etudiant: { name: 'student', price: 4.99 },
      ob_plan_pro: { name: 'pro', price: 7.99 }
    };
    const plan = planMap[parsed.buttonId];
    if (!plan) return false;

    if (plan.price === 0) {
      // Trial plan - no payment needed
      await updateProfile(user.id, { plan: plan.name, onboarding_step: 6, onboarding_complete: true });
      await whatsapp.sendText(
        user.whatsapp_id,
        "C'est parti ! 🎉\n\n" +
        "Tu commences avec l'essai gratuit (7 jours, 5 messages/jour).\n\n" +
        "Demain tu recevras ton premier message personnalisé ✉️\n\n" +
        "Des questions ? Tape /help pour voir tous mes commandes 🚀"
      );
      return true;
    } else {
      // Paid plan - create Stripe checkout
      const checkoutUrl = await createCheckoutUrl(user.id, plan.name, plan.price);
      if (!checkoutUrl) {
        await whatsapp.sendText(user.whatsapp_id, "Oups, problème lors de la création du paiement. Réessaye plus tard 😔");
        return false;
      }
      await updateProfile(user.id, { plan: plan.name, onboarding_step: 6, onboarding_complete: true });
      await whatsapp.sendText(
        user.whatsapp_id,
        "Voici ton lien de paiement 👇\n\n" + checkoutUrl + "\n\n🔒 Paiement sécurisé par Stripe. Sans engagement."
      );
      return true;
    }
  }

  // Text during onboarding fallback
  if (parsed.text && !parsed.buttonId && !parsed.listId) {
    logger.warn('Text input during onboarding', { userId: user.id, step });

    // Step 4 is handled above with text parsing
    // For other steps, prompt user to use buttons/lists
    if (step !== 4) {
      await whatsapp.sendText(
        user.whatsapp_id,
        "Utilise les boutons ou la liste pour continuer 👆"
      );
      return true;
    }
  }

  return false;
}

async function createCheckoutUrl(userId, planName, price) {
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'eur',
            product_data: {
              name: 'Will - Plan ' + planName,
            },
            unit_amount: Math.round(price * 100),
            recurring: {
              interval: 'month',
            }
          },
          quantity: 1,
        }
      ],
      mode: 'subscription',
      success_url: 'https://your-domain.com/onboarding/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://your-domain.com/onboarding/cancel',
      client_reference_id: userId,
    });
    return session.url;
  } catch (error) {
    logger.error('Stripe checkout error', { userId, error: error.message });
    return null;
  }
}

module.exports = {
  handleOnboarding,
  createCheckoutUrl,
};
