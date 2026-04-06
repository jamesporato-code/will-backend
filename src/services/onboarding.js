
// v2 updateconst whatsapp = require('./whatsapp');
const { updateProfile } = require('./userService');
const logger = require('../utils/logger');
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function handleOnboarding(user, parsed) {
  const step = user.onboarding_step || 0;
  const name = user.display_name?.split(' ')[0] || '';

  logger.info('Onboarding step', {
    userId: user.id, step,
    buttonId: parsed.buttonId, listId: parsed.listId,
    text: parsed.text?.substring(0, 30)
  });

  // Step 0: Welcome + ask level
  if (step === 0) {
    const greeting = name ? ('Salut ' + name + ' ! \u{1F44B}') : 'Salut ! \u{1F44B}';
    await whatsapp.sendText(
      user.whatsapp_id,
      greeting + '\n\n' +
      "Moi c'est Will, ton coach perso sp\u00e9cialis\u00e9 en IA \u{1F916}\n\n" +
      "Mon job : t'aider \u00e0 ma\u00eetriser l'IA au quotidien, que ce soit pour ton travail, tes projets ou ta curiosit\u00e9.\n\n" +
      "Avant de d\u00e9marrer, je vais te poser quelques questions rapides pour personnaliser ton exp\u00e9rience \u26A1 (30 secondes)."
    );
    await delay(2000);
    await whatsapp.sendButtons(
      user.whatsapp_id,
      "Quel est ton niveau actuel en intelligence artificielle ?",
      [
        { id: 'ob_level_debutant', title: 'D\u00e9butant' },
        { id: 'ob_level_intermediaire', title: 'Interm\u00e9diaire' },
        { id: 'ob_level_avance', title: 'Avanc\u00e9' },
      ],
      null,
      "Pas de mauvaise r\u00e9ponse \u{1F609}"
    );
    await updateProfile(user.id, { onboarding_step: 1 });
    return true;
  }

  // Step 1: Got level - ask job
  if (step === 1 && parsed.buttonId?.startsWith('ob_level_')) {
    const level = parsed.buttonId.replace('ob_level_', '');
    await updateProfile(user.id, { level, onboarding_step: 2 });

    const levelMsg = {
      debutant: "Parfait, on va y aller progressivement ! \u{1F44C}",
      intermediaire: "Top, tu as d\u00e9j\u00e0 de bonnes bases ! \u{1F4AA}",
      avance: "Excellent, on va pouvoir aller loin ensemble ! \u{1F680}"
    };
    await whatsapp.sendText(user.whatsapp_id, levelMsg[level] || "Not\u00e9 !");
    await delay(1000);

    await whatsapp.sendList(
      user.whatsapp_id,
      "Dans quel domaine tu travailles ? \u00c7a me permet d'adapter mes conseils \u00e0 ton quotidien \u{1F3AF}",
      "Choisir mon domaine",
      [{
        title: "Domaines",
        rows: [
          { id: 'ob_job_marketing', title: 'Marketing / Comm', description: 'Pub, contenu, r\u00e9seaux sociaux' },
          { id: 'ob_job_tech', title: 'Tech / Dev', description: 'D\u00e9veloppement, data, produit, IT' },
          { id: 'ob_job_business', title: 'Business / Finance', description: 'Vente, gestion, conseil' },
          { id: 'ob_job_creation', title: 'Cr\u00e9ation / Design', description: 'Graphisme, vid\u00e9o, UX, photo' },
          { id: 'ob_job_education', title: '\u00c9ducation / RH', description: 'Formation, recrutement' },
          { id: 'ob_job_sante', title: 'Sant\u00e9 / Sciences', description: 'M\u00e9dical, recherche, pharma' },
          { id: 'ob_job_etudiant', title: '\u00c9tudiant', description: 'Licence, master, doctorat' },
          { id: 'ob_job_autre', title: 'Autre', description: 'Autre secteur ou ind\u00e9pendant' },
        ]
      }]
    );
    return true;
  }

  // Step 2: Got job - ask goal
  if (step === 2 && parsed.listId?.startsWith('ob_job_')) {
    const jobMap = {
      ob_job_marketing: 'Marketing / Communication',
      ob_job_tech: 'Tech / D\u00e9veloppement',
      ob_job_business: 'Business / Finance',
      ob_job_creation: 'Cr\u00e9ation / Design',
      ob_job_education: '\u00c9ducation / RH',
      ob_job_sante: 'Sant\u00e9 / Sciences',
      ob_job_etudiant: '\u00c9tudiant',
      ob_job_autre: 'Autre'
    };
    const job = jobMap[parsed.listId] || parsed.text || 'Non pr\u00e9cis\u00e9';
    await updateProfile(user.id, { job, onboarding_step: 3 });

    await whatsapp.sendButtons(
      user.whatsapp_id,
      "Et concr\u00e8tement, qu'est-ce que tu attends le plus de Will ? \u{1F914}",
      [
        { id: 'ob_goal_productivite', title: 'Gagner du temps' },
        { id: 'ob_goal_apprendre', title: "Apprendre l'IA" },
        { id: 'ob_goal_veille', title: 'Rester inform\u00e9' },
      ],
      null,
      "\u00c7a m'aide \u00e0 prioriser tes contenus"
    );
    return true;
  }

  // Step 3: Got goal - ask preferred daily message hour
  if (step === 3 && parsed.buttonId?.startsWith('ob_goal_')) {
    const goalMap = {
      ob_goal_productivite: 'Gagner en productivit\u00e9',
      ob_goal_apprendre: "Apprendre \u00e0 ma\u00eetriser l'IA",
      ob_goal_veille: "Rester inform\u00e9 sur l'IA"
    };
    const interests = goalMap[parsed.buttonId] || "Explorer l'IA";
    await updateProfile(user.id, { interests, onboarding_step: 4 });

    await whatsapp.sendText(user.whatsapp_id, "Parfait ! Chaque jour je t'envoie un message personnalis\u00e9 sur l'IA \u{1F4EC}");
    await delay(1000);

    await whatsapp.sendList(
      user.whatsapp_id,
      "\u00c0 quelle heure tu veux recevoir ton message quotidien ? \u23F0",
      "Choisir mon heure",
      [{
        title: "Horaires",
        rows: [
          { id: 'ob_hour_7', title: '7h00', description: 'T\u00f4t le matin \u{1F305}' },
          { id: 'ob_hour_8', title: '8h00', description: 'D\u00e9but de journ\u00e9e' },
          { id: 'ob_hour_9', title: '9h00', description: 'En arrivant au travail' },
          { id: 'ob_hour_12', title: '12h00', description: 'Pause d\u00e9jeuner \u{1F372}' },
          { id: 'ob_hour_18', title: '18h00', description: 'Fin de journ\u00e9e' },
          { id: 'ob_hour_20', title: '20h00', description: 'En soir\u00e9e \u{1F319}' },
        ]
      }]
    );
    return true;
  }

  // Step 4: Got preferred hour - recap + plan choice
  if (step === 4 && parsed.listId?.startsWith('ob_hour_')) {
    const hour = parseInt(parsed.listId.replace('ob_hour_', ''), 10);
    await updateProfile(user.id, { preferred_hour: hour, onboarding_step: 5 });

    const recap = "Ton profil Will est pr\u00eat ! \u2705\n\n" +
      "\u{1F4CA} Niveau : " + (user.level || 'd\u00e9butant') + "\n" +
      "\u{1F4BC} Domaine : " + (user.job || 'Non pr\u00e9cis\u00e9') + "\n" +
      "\u{1F3AF} Objectif : " + (user.interests || "Explorer l'IA") + "\n" +
      "\u23F0 Message quotidien : " + hour + "h00\n\n" +
      "Je vais personnaliser tous mes conseils en fonction de \u00e7a \u{1F4AA}";
    await whatsapp.sendText(user.whatsapp_id, recap);
    await delay(2000);

    await whatsapp.sendButtons(
      user.whatsapp_id,
      "Derni\u00e8re \u00e9tape : choisis comment tu veux utiliser Will \u{1F447}\n\n" +
      "\u{1F195} Essai gratuit \u2014 7 jours, 5 msg/jour\n" +
      "\u{1F393} \u00c9tudiant \u2014 4,99\u20ac/mois, 40 msg/jour\n" +
      "\u{1F680} Pro \u2014 7,99\u20ac/mois, illimit\u00e9 + priorit\u00e9",
      [
        { id: 'ob_plan_trial', title: 'Essai gratuit 7j' },
        { id: 'ob_plan_etudiant', title: '\u00c9tudiant 4,99\u20ac' },
        { id: 'ob_plan_pro', title: 'Pro 7,99\u20ac' },
      ],
      null,
      'Tu pourras changer \u00e0 tout moment'
    );
    return true;
  }

  // Step 5: Got plan choice - complete
  if (step === 5 && parsed.buttonId?.startsWith('ob_plan_')) {
    const planChoice = parsed.buttonId.replace('ob_plan_', '');
    await updateProfile(user.id, { plan: 'trial', onboarding_complete: true, onboarding_step: 6 });

    if (planChoice === 'trial') {
      await whatsapp.sendText(
        user.whatsapp_id,
        "C'est parti ! \u{1F389}\n\n" +
        "Tu as 7 jours d'essai gratuit avec 5 messages par jour.\n\n" +
        "Tu peux passer \u00e0 un plan payant \u00e0 tout moment en tapant \"mon compte\".\n\n" +
        "Maintenant, pose-moi ta premi\u00e8re question sur l'IA ! \u{1F4AC}"
      );
      await delay(1500);
      await whatsapp.sendButtons(
        user.whatsapp_id,
        "Pour commencer, qu'est-ce qui t'int\u00e9resse le plus ? \u{1F447}",
        [
          { id: 'topic_outils', title: 'D\u00e9couvrir des outils' },
          { id: 'topic_prompt', title: '\u00c9crire de bons prompts' },
          { id: 'topic_actu', title: 'Actu IA du moment' },
        ]
      );
    } else {
      const checkoutUrl = await createCheckoutUrl(user, planChoice);
      if (checkoutUrl) {
        const planNames = {
          etudiant: '\u00c9tudiant (4,99\u20ac/mois)',
          pro: 'Pro (7,99\u20ac/mois)'
        };
        await whatsapp.sendText(
          user.whatsapp_id,
          "Excellent choix ! \u{1F525}\n\n" +
          "Voici ton lien de paiement pour le plan " + (planNames[planChoice] || planChoice) + " :\n\n" +
          checkoutUrl + "\n\n" +
          "\u{1F512} Paiement s\u00e9curis\u00e9 par Stripe. Sans engagement.\n\n" +
          "D\u00e8s que le paiement est confirm\u00e9, ton plan sera activ\u00e9 automatiquement !"
        );
      } else {
        await whatsapp.sendText(
          user.whatsapp_id,
          "Oups, une erreur est survenue avec le lien de paiement \u{1F615} R\u00e9essaie en tapant \"mon compte\" ou contacte-nous \u00e0 support@will-ai.fr."
        );
      }
    }
    return true;
  }

  // Text during onboarding
  if (!parsed.buttonId && !parsed.listId) {
    await whatsapp.sendText(
      user.whatsapp_id,
      "On finit d'abord la configuration rapide et apr\u00e8s tu pourras me poser toutes tes questions ! \u{1F60A} Utilise les boutons ci-dessus pour continuer \u{1F446}"
    );
    return true;
  }

  logger.warn('Unrecognized onboarding input', { step, buttonId: parsed.buttonId, listId: parsed.listId });
  return false;
}

async function createCheckoutUrl(user, plan) {
  try {
    const priceIds = {
      etudiant: process.env.STRIPE_PRICE_ETUDIANT,
      pro: process.env.STRIPE_PRICE_PRO
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
      success_url: 'https://wa.me/33749181083?text=paiement_confirme_' + plan,
      cancel_url: 'https://wa.me/33749181083?text=mon%20compte',
      metadata: {
        userId: String(user.id),
        whatsappId: user.whatsapp_id,
        plan: plan
      },
      allow_promotion_codes: true,
    });
    return session.url;
  } catch (err) {
    logger.error('Erreur cr\u00e9ation checkout Stripe', err.message);
    return null;
  }
}

module.exports = { handleOnboarding };

