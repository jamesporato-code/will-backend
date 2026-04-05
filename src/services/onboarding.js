const whatsapp = require('./whatsapp');
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

  logger.info('Onboarding step', { userId: user.id, step, buttonId: parsed.buttonId, listId: parsed.listId, text: parsed.text?.substring(0, 30) });

  // Step 0: Welcome + ask level
  if (step === 0) {
    const greeting = name ? ('Salut ' + name + ' !') : 'Salut !';
    await whatsapp.sendText(
      user.whatsapp_id,
      greeting + '\n\n' +
      "Moi c'est Will, ton assistant personnel specialise en IA.\n\n" +
      "Mon job : t'aider a maitriser l'IA au quotidien, que ce soit pour ton travail, tes projets ou ta curiosite.\n\n" +
      "Avant de demarrer, je vais te poser quelques questions rapides pour personnaliser ton experience (30 secondes)."
    );
    await delay(2000);
    await whatsapp.sendButtons(
      user.whatsapp_id,
      "Quel est ton niveau actuel en intelligence artificielle ?",
      [
        { id: 'ob_level_debutant', title: 'Debutant' },
        { id: 'ob_level_intermediaire', title: 'Intermediaire' },
        { id: 'ob_level_avance', title: 'Avance' },
      ],
      null, "Pas de mauvaise reponse"
    );
    await updateProfile(user.id, { onboarding_step: 1 });
    return true;
  }

  // Step 1: Got level - ask job
  if (step === 1 && parsed.buttonId?.startsWith('ob_level_')) {
    const level = parsed.buttonId.replace('ob_level_', '');
    await updateProfile(user.id, { level, onboarding_step: 2 });
    const levelMsg = { debutant: "Parfait, on va y aller progressivement !", intermediaire: "Top, tu as deja de bonnes bases !", avance: "Excellent, on va pouvoir aller loin ensemble !" };
    await whatsapp.sendText(user.whatsapp_id, levelMsg[level] || "Note !");
    await delay(1000);
    await whatsapp.sendList(
      user.whatsapp_id,
      "Dans quel domaine tu travailles ? Ca me permet d'adapter mes conseils a ton quotidien.",
      "Choisir mon domaine",
      [{ title: "Domaines", rows: [
        { id: 'ob_job_marketing', title: 'Marketing / Comm', description: 'Pub, contenu, reseaux sociaux' },
        { id: 'ob_job_tech', title: 'Tech / Dev', description: 'Developpement, data, produit, IT' },
        { id: 'ob_job_business', title: 'Business / Finance', description: 'Vente, gestion, conseil' },
        { id: 'ob_job_creation', title: 'Creation / Design', description: 'Graphisme, video, UX, photo' },
        { id: 'ob_job_education', title: 'Education / RH', description: 'Formation, recrutement' },
        { id: 'ob_job_sante', title: 'Sante / Sciences', description: 'Medical, recherche, pharma' },
        { id: 'ob_job_etudiant', title: 'Etudiant', description: 'Licence, master, doctorat' },
        { id: 'ob_job_autre', title: 'Autre', description: 'Autre secteur ou independant' },
      ]}]
    );
    return true;
  }

  // Step 2: Got job - ask goal
  if (step === 2 && parsed.listId?.startsWith('ob_job_')) {
    const jobMap = { ob_job_marketing: 'Marketing / Communication', ob_job_tech: 'Tech / Developpement', ob_job_business: 'Business / Finance', ob_job_creation: 'Creation / Design', ob_job_education: 'Education / RH', ob_job_sante: 'Sante / Sciences', ob_job_etudiant: 'Etudiant', ob_job_autre: 'Autre' };
    const job = jobMap[parsed.listId] || parsed.text || 'Non precise';
    await updateProfile(user.id, { job, onboarding_step: 3 });
    await whatsapp.sendButtons(
      user.whatsapp_id,
      "Et concretement, qu'est-ce que tu attends le plus de Will ?",
      [
        { id: 'ob_goal_productivite', title: 'Gagner du temps' },
        { id: 'ob_goal_apprendre', title: 'Apprendre l\'IA' },
        { id: 'ob_goal_veille', title: 'Rester informe' },
      ],
      null, "Ca m'aide a prioriser tes contenus"
    );
    return true;
  }

  // Step 3: Got goal - recap + plan choice
  if (step === 3 && parsed.buttonId?.startsWith('ob_goal_')) {
    const goalMap = { ob_goal_productivite: 'Gagner en productivite', ob_goal_apprendre: 'Apprendre a maitriser l\'IA', ob_goal_veille: 'Rester informe sur l\'IA' };
    const interests = goalMap[parsed.buttonId] || 'Explorer l\'IA';
    await updateProfile(user.id, { interests, onboarding_step: 4 });
    const recap = "Ton profil Will est pret !\n\n" +
      "Niveau : " + (user.level || 'debutant') + "\n" +
      "Domaine : " + (user.job || 'Non precise') + "\n" +
      "Objectif : " + interests + "\n\n" +
      "Je vais personnaliser tous mes conseils en fonction de ca.";
    await whatsapp.sendText(user.whatsapp_id, recap);
    await delay(2000);
    await whatsapp.sendButtons(
      user.whatsapp_id,
      "Derniere etape : choisis comment tu veux utiliser Will.\n\n" +
      "Essai gratuit - 7 jours, 5 msg/jour\n" +
      "Etudiant - 4,99\u20ac/mois, 40 msg/jour\n" +
      "Pro - 7,99\u20ac/mois, illimite + priorite",
      [
        { id: 'ob_plan_trial', title: 'Essai gratuit 7j' },
        { id: 'ob_plan_etudiant', title: 'Etudiant 4,99\u20ac' },
        { id: 'ob_plan_pro', title: 'Pro 7,99\u20ac' },
      ],
      null, 'Tu pourras changer a tout moment'
    );
    return true;
  }

  // Step 4: Got plan choice - complete
  if (step === 4 && parsed.buttonId?.startsWith('ob_plan_')) {
    const planChoice = parsed.buttonId.replace('ob_plan_', '');
    await updateProfile(user.id, { plan: 'trial', onboarding_complete: true, onboarding_step: 5 });

    if (planChoice === 'trial') {
      // Free trial
      await whatsapp.sendText(
        user.whatsapp_id,
        "C'est parti ! Tu as 7 jours d'essai gratuit avec 5 messages par jour.\n\n" +
        "Tu peux passer a un plan payant a tout moment en tapant \"mon compte\".\n\n" +
        "Maintenant, pose-moi ta premiere question sur l'IA !"
      );
      await delay(1500);
      await whatsapp.sendButtons(
        user.whatsapp_id,
        "Pour commencer, qu'est-ce qui t'interesse le plus ?",
        [
          { id: 'topic_outils', title: 'Decouvrir des outils' },
          { id: 'topic_prompt', title: 'Ecrire de bons prompts' },
          { id: 'topic_actu', title: 'Actu IA du moment' },
        ]
      );
    } else {
      // Paid plan - send Stripe link directly, no mention of free trial
      const checkoutUrl = await createCheckoutUrl(user, planChoice);
      if (checkoutUrl) {
        const planNames = { etudiant: 'Etudiant (4,99\u20ac/mois)', pro: 'Pro (7,99\u20ac/mois)' };
        await whatsapp.sendText(
          user.whatsapp_id,
          "Excellent choix ! Voici ton lien de paiement pour le plan " +
          (planNames[planChoice] || planChoice) + " :\n\n" +
          checkoutUrl + "\n\n" +
          "Paiement securise par Stripe. Sans engagement.\n\n" +
          "Des que le paiement est confirme, ton plan sera active automatiquement !"
        );
      } else {
        await whatsapp.sendText(
          user.whatsapp_id,
          "Oups, une erreur est survenue avec le lien de paiement. Reessaie en tapant \"mon compte\" ou contacte-nous a support@will-ai.fr."
        );
      }
    }
    return true;
  }

  // Text during onboarding
  if (!parsed.buttonId && !parsed.listId) {
    await whatsapp.sendText(
      user.whatsapp_id,
      "On finit d'abord la configuration rapide et apres tu pourras me poser toutes tes questions ! Utilise les boutons ci-dessus pour continuer."
    );
    return true;
  }

  logger.warn('Unrecognized onboarding input', { step, buttonId: parsed.buttonId, listId: parsed.listId });
  return false;
}

async function createCheckoutUrl(user, plan) {
  try {
    const priceIds = { etudiant: process.env.STRIPE_PRICE_ETUDIANT, pro: process.env.STRIPE_PRICE_PRO };
    const priceId = priceIds[plan];
    if (!priceId) { logger.error('Price ID manquant pour plan: ' + plan); return null; }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: 'https://wa.me/33749181083?text=paiement_confirme_' + plan,
      cancel_url: 'https://wa.me/33749181083?text=mon%20compte',
      metadata: { userId: String(user.id), whatsappId: user.whatsapp_id, plan: plan },
      allow_promotion_codes: true,
    });
    return session.url;
  } catch (err) {
    logger.error('Erreur creation checkout Stripe', err.message);
    return null;
  }
}

module.exports = { handleOnboarding };
