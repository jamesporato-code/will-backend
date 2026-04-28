const whatsapp = require('./whatsapp');
const { updateProfile } = require('./userService');
const { cacheResponse } = require('./redis');
const logger = require('../utils/logger');
const { query } = require('../db/pool');
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// ============================================
// SECTEURS (10 options)
// ============================================
const SECTORS = [
  { id: 'marketing', title: 'Marketing / Comm', description: 'Pub, contenu, réseaux sociaux' },
  { id: 'tech', title: 'Tech / Dev / Data', description: 'Code, IA, data, produit, IT' },
  { id: 'business', title: 'Business / Finance', description: 'Vente, gestion, conseil, compta' },
  { id: 'creation', title: 'Création / Design', description: 'Graphisme, vidéo, UX, photo' },
  { id: 'education', title: 'Éducation / Formation', description: 'Enseignement, e-learning, RH' },
  { id: 'sante', title: 'Santé / Bien-être', description: 'Médical, pharma, coaching' },
  { id: 'juridique', title: 'Droit / Immobilier', description: 'Juridique, notariat, immo' },
  { id: 'artisanat', title: 'Artisanat / Commerce', description: 'Boutique, resto, artisan' },
  { id: 'freelance', title: 'Freelance / Startup', description: 'Indépendant, entrepreneur' },
  { id: 'autre', title: 'Autre secteur', description: 'Je précise après' },
];

function getSectorLabel(id) {
  const s = SECTORS.find(x => x.id === id);
  return s ? s.title : id;
}

async function sendSectorList(whatsappId, bodyText, buttonLabel, excludeIds = []) {
  const rows = SECTORS
    .filter(s => !excludeIds.includes(s.id))
    .map(s => ({ id: 'ob_sector_' + s.id, title: s.title, description: s.description }));
  await whatsapp.sendList(
    whatsappId,
    bodyText,
    buttonLabel,
    [{ title: 'Secteurs', rows }]
  );
}

// ============================================
// INTÉRÊTS IA (10 choix sur 2 sections)
// ============================================
const IA_INTERESTS_SECTIONS = [
  {
    title: 'Pro & Business',
    rows: [
      { id: 'business', title: 'Business / Startup', description: 'Pitch, stratégie, scaling' },
      { id: 'marketing', title: 'Marketing & Vente', description: 'Acquisition, social, closing' },
      { id: 'content', title: 'Création contenu', description: 'Copy, blog, vidéo, image' },
      { id: 'dev', title: 'Code & Data', description: 'Dev, Copilot, SQL, agents IA' },
      { id: 'management', title: 'Management / RH', description: 'Équipe, recrut., leadership' },
    ],
  },
  {
    title: 'Perso & Skills',
    rows: [
      { id: 'studies', title: 'Études / Apprentissage', description: 'Révisions, mémoires, langues' },
      { id: 'productivity', title: 'Productivité', description: 'Gain de temps au quotidien' },
      { id: 'automation', title: 'Automatisation', description: 'Zapier, Make, workflows' },
      { id: 'ai', title: 'AI / Deep tech', description: 'Agents, MCP, LLMs, modèles' },
      { id: 'other', title: 'Autre', description: 'Je précise en 1 phrase' },
    ],
  },
];

const IA_INTEREST_LABELS = {};
IA_INTERESTS_SECTIONS.forEach(sec => sec.rows.forEach(r => IA_INTEREST_LABELS[r.id] = r.title));

function getInterestLabel(id) {
  return IA_INTEREST_LABELS[id] || id;
}

// ============================================
// HANDLE ONBOARDING
// ============================================
async function handleOnboarding(user, parsed) {
  const step = user.onboarding_step || 0;
  const name = user.display_name?.split(' ')[0] || '';

  logger.info('Onboarding step', {
    userId: user.id,
    step,
    buttonId: parsed.buttonId,
    listId: parsed.listId,
    text: parsed.text?.substring(0, 30)
  });

  // STEP 0 : Welcome + démarrer
  if (step === 0) {
    const greeting = name ? ('Bonjour ' + name + '.') : 'Bonjour.';
    await whatsapp.sendText(
      user.whatsapp_id,
      greeting + '\n\n' +
      'Je suis *Will*, ton coach IA personnel sur WhatsApp.\n\n' +
      'Mon rôle : t\'accompagner chaque jour pour intégrer l\'IA dans ton métier — un parcours structuré, des cas concrets adaptés à ton domaine, et des défis pratiques.\n\n' +
      'Avant de commencer, 5 questions courtes pour calibrer ton parcours (1 minute).'
    );
    await delay(2200);
    await whatsapp.sendButtons(
      user.whatsapp_id,
      '*Question 1/5* — Quel est ton niveau actuel en IA ?',
      [
        { id: 'ob_level_debutant', title: 'Débutant' },
        { id: 'ob_level_intermediaire', title: 'Intermédiaire' },
        { id: 'ob_level_avance', title: 'Avancé' },
      ],
      null,
      'Aucun niveau requis'
    );
    await updateProfile(user.id, { onboarding_step: 1 });
    return true;
  }

  // STEP 1 : niveau → secteur principal
  if (step === 1 && parsed.buttonId?.startsWith('ob_level_')) {
    const level = parsed.buttonId.replace('ob_level_', '');
    await updateProfile(user.id, { level, onboarding_step: 2 });

    const levelMsg = {
      debutant: 'Très bien. Je vais adapter le rythme pour poser des bases solides.',
      intermediaire: 'Parfait. On va aller à l\'essentiel et construire sur tes acquis.',
      avance: 'Compris. Je te pousserai sur les sujets avancés (agents, MCP, automatisations).',
    };
    await whatsapp.sendText(user.whatsapp_id, levelMsg[level] || 'Noté.');
    await delay(1200);
    await sendSectorList(
      user.whatsapp_id,
      '*Question 2/5* — Dans quel secteur travailles-tu principalement ?',
      'Choisir mon secteur',
      []
    );
    return true;
  }

  // STEP 2 : secteur principal → 2ème ?
  if (step === 2 && parsed.listId?.startsWith('ob_sector_')) {
    const sectorId = parsed.listId.replace('ob_sector_', '');
    await updateProfile(user.id, { job: getSectorLabel(sectorId), onboarding_step: 3 });

    await whatsapp.sendButtons(
      user.whatsapp_id,
      'Souhaites-tu ajouter un ou deux secteurs supplémentaires ? Jusqu\'à 3 au total — ça me permet de croiser des conseils plus précis.\n\n' +
      '_Exemple : un consultant qui bosse aussi en marketing peut ajouter les deux._',
      [
        { id: 'ob_add_sector_yes', title: 'Oui, ajouter' },
        { id: 'ob_add_sector_no', title: 'Non, continuer' },
      ],
      null,
      'Optionnel'
    );
    return true;
  }

  // STEP 3 : 2ème secteur ?
  if (step === 3 && parsed.buttonId?.startsWith('ob_add_sector_')) {
    if (parsed.buttonId === 'ob_add_sector_no') {
      await updateProfile(user.id, { onboarding_step: 6 });
      await askIaInterest(user);
      return true;
    }
    await updateProfile(user.id, { onboarding_step: 4 });
    const primaryLabel = user.job || '';
    const primaryId = SECTORS.find(s => s.title === primaryLabel)?.id;
    await sendSectorList(
      user.whatsapp_id,
      'Ton 2ème secteur ?',
      'Choisir',
      primaryId ? [primaryId] : []
    );
    return true;
  }

  // STEP 4 : 2ème secteur → 3ème ?
  if (step === 4 && parsed.listId?.startsWith('ob_sector_')) {
    const sectorId = parsed.listId.replace('ob_sector_', '');
    const result = await query('SELECT secondary_jobs FROM users WHERE id = $1', [user.id]);
    const current = result.rows[0]?.secondary_jobs || [];
    const newSecondary = Array.isArray(current) ? [...current, getSectorLabel(sectorId)] : [getSectorLabel(sectorId)];
    await query('UPDATE users SET secondary_jobs = $1::jsonb WHERE id = $2', [JSON.stringify(newSecondary), user.id]);
    await updateProfile(user.id, { onboarding_step: 5 });

    await whatsapp.sendButtons(
      user.whatsapp_id,
      'Noté. Tu veux ajouter un 3ème et dernier secteur ?',
      [
        { id: 'ob_add_third_yes', title: 'Oui, 3ème' },
        { id: 'ob_add_third_no', title: 'Non, continuer' },
      ]
    );
    return true;
  }

  // STEP 5 : 3ème secteur ?
  if (step === 5 && parsed.buttonId?.startsWith('ob_add_third_')) {
    if (parsed.buttonId === 'ob_add_third_no') {
      await updateProfile(user.id, { onboarding_step: 6 });
      await askIaInterest(user);
      return true;
    }
    const result = await query('SELECT job, secondary_jobs FROM users WHERE id = $1', [user.id]);
    const primaryId = SECTORS.find(s => s.title === result.rows[0]?.job)?.id;
    const secondaryTitles = result.rows[0]?.secondary_jobs || [];
    const secondaryIds = SECTORS.filter(s => secondaryTitles.includes(s.title)).map(s => s.id);
    const excludeIds = [primaryId, ...secondaryIds].filter(Boolean);

    await updateProfile(user.id, { onboarding_step: 51 });
    await sendSectorList(
      user.whatsapp_id,
      'Ton 3ème secteur ?',
      'Choisir',
      excludeIds
    );
    return true;
  }

  // STEP 51 : 3ème secteur → ia_interest
  if (step === 51 && parsed.listId?.startsWith('ob_sector_')) {
    const sectorId = parsed.listId.replace('ob_sector_', '');
    const result = await query('SELECT secondary_jobs FROM users WHERE id = $1', [user.id]);
    const current = result.rows[0]?.secondary_jobs || [];
    const newSecondary = Array.isArray(current) ? [...current, getSectorLabel(sectorId)] : [getSectorLabel(sectorId)];
    await query('UPDATE users SET secondary_jobs = $1::jsonb WHERE id = $2', [JSON.stringify(newSecondary), user.id]);
    await updateProfile(user.id, { onboarding_step: 6 });
    await askIaInterest(user);
    return true;
  }

  // STEP 6 : ia_interest (ou "other")
  if (step === 6 && parsed.listId?.startsWith('ob_interest_')) {
    const interestId = parsed.listId.replace('ob_interest_', '');
    if (interestId === 'other') {
      await updateProfile(user.id, { ia_interest: 'other', onboarding_step: 61 });
      await whatsapp.sendText(
        user.whatsapp_id,
        'Décris-moi en une phrase ce que tu veux apprendre ou appliquer avec l\'IA.\n\n' +
        '_Exemple : "Utiliser l\'IA pour ma boîte de conseil en immobilier."_'
      );
      return true;
    }
    await updateProfile(user.id, { ia_interest: interestId, onboarding_step: 7 });
    await askConsent(user);
    return true;
  }

  // STEP 61 : "other" libre
  if (step === 61 && parsed.text) {
    const customInterest = parsed.text.trim().substring(0, 200);
    await updateProfile(user.id, { ia_interest_other: customInterest, onboarding_step: 7 });
    await whatsapp.sendText(user.whatsapp_id, 'Noté.');
    await delay(800);
    await askConsent(user);
    return true;
  }

  // STEP 7 : consentement → heure ou skip
  if (step === 7 && parsed.buttonId?.startsWith('ob_consent_')) {
    if (parsed.buttonId === 'ob_consent_no') {
      await updateProfile(user.id, { daily_opt_in: false, onboarding_step: 9 });
      await whatsapp.sendText(
        user.whatsapp_id,
        'Compris. Tu ne recevras pas de messages quotidiens.\n\n' +
        'Tu peux toujours me poser des questions quand tu veux. Pour les réactiver plus tard, tape /daily.'
      );
      await delay(1500);
      await sendRecapAndPlan(user, null);
      return true;
    }
    await updateProfile(user.id, { daily_opt_in: true, onboarding_step: 8 });
    await whatsapp.sendText(user.whatsapp_id, 'Parfait. Tu recevras un message quotidien adapté à ton profil.');
    await delay(1000);
    await whatsapp.sendText(user.whatsapp_id, 'Tu peux écrire ton heure préférée (ex : 8h30, 14h00) ou choisir dans la liste ci-dessous.');
    await delay(1000);
    await askHour(user);
    return true;
  }

  // STEP 8 : heure → recap + plan
  if (step === 8) {
    let hour = null;
    if (parsed.listId?.startsWith('ob_hour_')) {
      hour = parseInt(parsed.listId.replace('ob_hour_', ''), 10);
    } else if (parsed.text) {
      const text = parsed.text.trim().toLowerCase();
      let match;
      match = text.match(/^(\d{1,2})\s*h\s*(\d{0,2})$/);
      if (!match) match = text.match(/^(\d{1,2})\s*:\s*(\d{0,2})$/);
      if (!match) {
        match = text.match(/^(\d{1,2})$/);
        if (match) match[2] = '0';
      }
      if (match) {
        const h = parseInt(match[1], 10);
        if (h >= 0 && h <= 23) hour = h;
      }
    }

    if (hour === null) {
      await whatsapp.sendText(
        user.whatsapp_id,
        'Je n\'ai pas reconnu l\'heure. Écris-la au format 8h30 ou 14h00, ou choisis dans la liste ci-dessous.'
      );
      await delay(500);
      await askHour(user);
      return true;
    }

    await updateProfile(user.id, { preferred_hour: hour, onboarding_step: 9 });
    await sendRecapAndPlan(user, hour);
    return true;
  }

  // STEP 9 : choix plan
  if (step === 9 && parsed.buttonId?.startsWith('ob_plan_')) {
    if (parsed.buttonId === 'ob_plan_trial') {
      await updateProfile(user.id, { onboarding_step: 10, onboarding_complete: true });
      await whatsapp.sendText(
        user.whatsapp_id,
        'Parfait. Ton essai gratuit démarre maintenant : 7 jours pour découvrir le Module 1 (Introduction à l\'IA).\n\n' +
        'Je t\'envoie ta première session dans quelques secondes. À tout moment, tape /help pour voir les commandes.'
      );

      // Ne lance le 1er daily que si l'utilisateur a opt-in
      const optInRow = await query('SELECT daily_opt_in FROM users WHERE id = $1', [user.id]);
      if (optInRow.rows[0]?.daily_opt_in !== false) {
        await delay(2500);
        // Délègue au scheduler unifié pour rester source unique de vérité
        const { sendDailyForUser } = require('../cron/scheduler');
        await sendDailyForUser(user.id, { first: true });
      }
      return true;
    }

    if (parsed.buttonId === 'ob_plan_pro') {
      const checkoutUrl = await createCheckoutUrl(user);
      if (!checkoutUrl) {
        await whatsapp.sendText(user.whatsapp_id, 'Problème de création du paiement. Réessaie dans quelques instants.');
        return false;
      }
      // SÉCURITÉ : on ne set PAS plan='pro' ici. C'est le webhook Stripe
      // checkout.session.completed qui fait foi (cf src/routes/stripe.js).
      await updateProfile(user.id, { onboarding_step: 10, onboarding_complete: true });
      await whatsapp.sendText(
        user.whatsapp_id,
        'Voici ton lien de paiement (Pro, 6,99 €/mois) :\n\n' + checkoutUrl + '\n\n' +
        'Paiement sécurisé par Stripe. Sans engagement.'
      );
      return true;
    }
    return false;
  }

  if (parsed.text && !parsed.buttonId && !parsed.listId) {
    logger.warn('Text input during onboarding', { userId: user.id, step });
    if (step !== 8 && step !== 61) {
      await whatsapp.sendText(user.whatsapp_id, 'Utilise les boutons ou la liste ci-dessus pour avancer.');
      return true;
    }
  }

  return false;
}

// ============================================
// HELPERS
// ============================================

async function askIaInterest(user) {
  await whatsapp.sendList(
    user.whatsapp_id,
    '*Question 4/5* — Sur quoi veux-tu appliquer l\'IA en priorité ?\n\nÇa m\'aide à te proposer des exemples et exercices ultra-pertinents.',
    'Choisir mon focus',
    IA_INTERESTS_SECTIONS.map(sec => ({
      title: sec.title,
      rows: sec.rows.map(r => ({ id: 'ob_interest_' + r.id, title: r.title, description: r.description })),
    }))
  );
}

async function askConsent(user) {
  await whatsapp.sendText(
    user.whatsapp_id,
    'Merci pour tes réponses.\n\n' +
    'Pour t\'accompagner au mieux, je propose de t\'envoyer *un message personnalisé chaque jour* sur l\'IA, calibré sur ton profil.\n\n' +
    'En acceptant, tu consens à :\n' +
    '— Recevoir un message quotidien de Will sur WhatsApp\n' +
    '— Le traitement de tes données (profil, préférences) pour personnaliser le contenu\n\n' +
    'Tu peux te désinscrire à tout moment en tapant /stop.\n\n' +
    'Politique de confidentialité : https://will-coach-ia.netlify.app/privacy'
  );
  await delay(2000);
  await whatsapp.sendButtons(
    user.whatsapp_id,
    '*Question 5/5* — Acceptes-tu de recevoir un message quotidien de Will ?',
    [
      { id: 'ob_consent_yes', title: 'J\'accepte' },
      { id: 'ob_consent_no', title: 'Non merci' },
    ],
    null,
    'Modifiable à tout moment'
  );
}

async function askHour(user) {
  await whatsapp.sendList(
    user.whatsapp_id,
    'À quelle heure souhaites-tu recevoir ton message quotidien ?',
    'Choisir mon heure',
    [
      { title: 'Matin', rows: [
        { id: 'ob_hour_7', title: '7h00', description: 'Tôt le matin' },
        { id: 'ob_hour_8', title: '8h00', description: 'Début de journée' },
        { id: 'ob_hour_9', title: '9h00', description: 'En arrivant au travail' },
        { id: 'ob_hour_10', title: '10h00', description: 'Milieu de matinée' },
        { id: 'ob_hour_12', title: '12h00', description: 'Pause déjeuner' },
      ] },
      { title: 'Après-midi / Soir', rows: [
        { id: 'ob_hour_14', title: '14h00', description: 'Après-midi' },
        { id: 'ob_hour_16', title: '16h00', description: 'Fin d\'après-midi' },
        { id: 'ob_hour_18', title: '18h00', description: 'Fin de journée' },
        { id: 'ob_hour_20', title: '20h00', description: 'Soirée' },
        { id: 'ob_hour_22', title: '22h00', description: 'Tard le soir' },
      ] },
    ]
  );
}

async function sendRecapAndPlan(user, hour) {
  const result = await query('SELECT job, secondary_jobs, ia_interest, ia_interest_other FROM users WHERE id = $1', [user.id]);
  const row = result.rows[0] || {};
  const primaryJob = row.job || 'Non précisé';
  const secondaryArr = Array.isArray(row.secondary_jobs) ? row.secondary_jobs : [];
  const allSectors = [primaryJob, ...secondaryArr].filter(Boolean).join(', ');
  const interestLabel = row.ia_interest === 'other'
    ? (row.ia_interest_other || 'Autre')
    : getInterestLabel(row.ia_interest);

  const recapLines = [
    'Ton profil Will est calibré.',
    '',
    'Niveau : ' + (user.level || 'débutant'),
    'Secteur(s) : ' + allSectors,
    'Focus IA : ' + interestLabel,
  ];
  if (hour !== null && hour !== undefined) {
    recapLines.push('Message quotidien : ' + hour + 'h00');
  } else {
    recapLines.push('Messages quotidiens : désactivés');
  }
  recapLines.push('');
  recapLines.push('Je vais personnaliser tous mes conseils en fonction.');

  await whatsapp.sendText(user.whatsapp_id, recapLines.join('\n'));
  await delay(2000);
  await whatsapp.sendButtons(
    user.whatsapp_id,
    'Dernière étape — choisis ta formule.\n\n' +
    '*Essai gratuit (7 jours)*\nDécouverte du Module 1 (Introduction à l\'IA), 5 sessions + un aperçu actu/prompt et un récap. 15 messages chat/jour.\n\n' +
    '*Pro (6,99 €/mois)*\nParcours complet (10 modules), messages illimités, actu IA, outils et prompts du jour. Sans engagement.',
    [
      { id: 'ob_plan_trial', title: 'Essai gratuit 7j' },
      { id: 'ob_plan_pro', title: 'Pro 6,99/mois' },
    ],
    null,
    'Tu pourras passer Pro à tout moment'
  );
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
  } catch (error) {
    logger.error('Stripe checkout error', { userId: user.id, error: error.message });
    return null;
  }
}

module.exports = { handleOnboarding, createCheckoutUrl };
