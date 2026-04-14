const whatsapp = require('./whatsapp');
const { updateProfile } = require('./userService');
const claude = require('./claude');
const { cacheResponse } = require('../services/redis');
const logger = require('../utils/logger');
const { query } = require('../db/pool');
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// ============================================
// SECTEURS (8 options)
// ============================================
const SECTORS = [
  { id: 'marketing', title: 'Marketing / Comm', description: 'Pub, contenu, réseaux sociaux' },
  { id: 'tech', title: 'Tech / Dev', description: 'Développement, data, produit, IT' },
  { id: 'business', title: 'Business / Finance', description: 'Vente, gestion, conseil' },
  { id: 'creation', title: 'Création / Design', description: 'Graphisme, vidéo, UX, photo' },
  { id: 'education', title: 'Éducation / RH', description: 'Formation, recrutement' },
  { id: 'sante', title: 'Santé / Sciences', description: 'Médical, recherche, pharma' },
  { id: 'etudiant', title: 'Étudiant', description: 'Licence, master, doctorat' },
  { id: 'autre', title: 'Autre', description: 'Autre secteur ou indépendant' },
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
// INTÉRÊTS IA (24 choix sur 6 sections)
// ============================================
const IA_INTERESTS_SECTIONS = [
  {
    title: '💼 Business & Entrepreneuriat',
    rows: [
      { id: 'business', title: 'Business / Startup', description: 'Pitch, stratégie, scaling' },
      { id: 'sales', title: 'Vente & Commercial', description: 'Prospection, closing, négo' },
      { id: 'finance', title: 'Finance & Invest.', description: 'Analyse, reporting, levée' },
      { id: 'management', title: 'Management', description: 'Équipe, leadership' },
    ],
  },
  {
    title: '📣 Marketing & Com',
    rows: [
      { id: 'marketing', title: 'Marketing général', description: 'Stratégie, acquisition' },
      { id: 'socialmedia', title: 'Social media', description: 'Posts, community mgmt' },
      { id: 'seo', title: 'SEO / Content', description: 'Référencement, blog' },
      { id: 'branding', title: 'Branding / Pub', description: 'Marque, campagnes' },
    ],
  },
  {
    title: '✍️ Création & Écriture',
    rows: [
      { id: 'copywriting', title: 'Copywriting', description: 'Rédaction persuasive' },
      { id: 'storytelling', title: 'Storytelling', description: 'Narration, script' },
      { id: 'content', title: 'Création contenu', description: 'Blog, podcast, vidéo' },
      { id: 'visual', title: 'Créa visuelle', description: 'Image, design, Midjourney' },
    ],
  },
  {
    title: '📚 Études & Apprentissage',
    rows: [
      { id: 'studies', title: 'Études / Devoirs', description: 'Mémoires, révisions' },
      { id: 'research', title: 'Recherche acad.', description: 'Thèse, publications' },
      { id: 'teaching', title: 'Enseignement', description: 'Cours, pédagogie' },
      { id: 'languages', title: 'Langues étrang.', description: 'Apprentissage langues' },
    ],
  },
  {
    title: '💻 Tech & Data',
    rows: [
      { id: 'dev', title: 'Développement', description: 'Code, Copilot, Cursor' },
      { id: 'data', title: 'Data & Analyse', description: 'Excel, SQL, insights' },
      { id: 'automation', title: 'Automatisation', description: 'Zapier, Make, n8n' },
      { id: 'ai', title: 'AI / Deep tech', description: 'Agents, MCP, modèles' },
    ],
  },
  {
    title: '🎯 Perso & Métiers',
    rows: [
      { id: 'productivity', title: 'Productivité', description: 'Gain de temps au quotidien' },
      { id: 'projectmgmt', title: 'Gestion projet', description: 'Planning, coordination' },
      { id: 'hr', title: 'RH / Coaching', description: 'Recrut., formation' },
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

  // ==========================================
  // STEP 0 : Welcome enrichi + démarrer
  // ==========================================
  if (step === 0) {
    try {
      const greeting = name ? ('Salut ' + name + ' ! 👋') : 'Salut ! 👋';
      await whatsapp.sendText(
        user.whatsapp_id,
        greeting + '\n\n' +
        'Moi c\'est *Will*, ton coach perso en intelligence artificielle 🤖\n\n' +
        '━━━━━━━━━━━━━━━━\n\n' +
        '🎯 *Ma mission*\n' +
        'T\'aider à maîtriser l\'IA au quotidien — pour bosser plus vite, apprendre des trucs ou juste être à la pointe.\n\n' +
        '📬 *Comment ça marche*\n' +
        'Chaque jour, je t\'envoie un message personnalisé :\n' +
        '• Une *notion clé* du jour\n' +
        '• Un *cas d\'usage* concret adapté à ton profil\n' +
        '• Un *défi pratique* à tester en 3 min\n\n' +
        '💬 *Et si tu as une question ?*\n' +
        'Pose-la-moi à tout moment, je te réponds avec les meilleures pratiques IA de 2026.\n\n' +
        '━━━━━━━━━━━━━━━━\n\n' +
        '⚡ *Avant de démarrer*, je te pose 5 questions rapides pour personnaliser tout ça (1 min).\n\n' +
        'C\'est parti ! 👇'
      );
      await delay(2500);
      await whatsapp.sendButtons(
        user.whatsapp_id,
        '*Question 1/5* — Quel est ton niveau actuel en IA ?',
        [
          { id: 'ob_level_debutant', title: 'Débutant 🔰' },
          { id: 'ob_level_intermediaire', title: 'Intermédiaire 🙋' },
          { id: 'ob_level_avance', title: 'Avancé ⚡' },
        ],
        null,
        'Pas de mauvaise réponse 😉'
      );
      await updateProfile(user.id, { onboarding_step: 1 });
      return true;
    } catch (err) {
      logger.error('Onboarding step 0 FAILED', { userId: user.id, error: err.message, stack: err.stack?.substring(0, 300) });
      throw err;
    }
  }

  // ==========================================
  // STEP 1 : Got level → ask main sector
  // ==========================================
  if (step === 1 && parsed.buttonId?.startsWith('ob_level_')) {
    const level = parsed.buttonId.replace('ob_level_', '');
    await updateProfile(user.id, { level, onboarding_step: 2 });

    const levelMsg = {
      debutant: 'Parfait, on va y aller progressivement ! 👌',
      intermediaire: 'Top, tu as déjà de bonnes bases ! 💪',
      avance: 'Excellent, on va pouvoir aller loin ensemble ! 🚀',
    };
    await whatsapp.sendText(user.whatsapp_id, levelMsg[level] || 'Noté !');
    await delay(1200);
    await sendSectorList(
      user.whatsapp_id,
      '*Question 2/5* — Dans quel secteur tu travailles principalement ? 🎯',
      'Choisir mon secteur',
      []
    );
    return true;
  }

  // ==========================================
  // STEP 2 : Got main sector → ask add 2nd sector
  // ==========================================
  if (step === 2 && parsed.listId?.startsWith('ob_sector_')) {
    const sectorId = parsed.listId.replace('ob_sector_', '');
    await updateProfile(user.id, { job: getSectorLabel(sectorId), onboarding_step: 3 });

    await whatsapp.sendButtons(
      user.whatsapp_id,
      'Tu veux ajouter d\'autres secteurs ? Max 3 en tout pour que je croise mieux mes conseils 🎯\n\n' +
      '_(Ex : un étudiant qui travaille aussi en marketing peut ajouter les deux.)_',
      [
        { id: 'ob_add_sector_yes', title: 'Oui, j\'ajoute ➕' },
        { id: 'ob_add_sector_no', title: 'Non, continuer ➡️' },
      ],
      null,
      'Optionnel — tu peux en rester à 1'
    );
    return true;
  }

  // ==========================================
  // STEP 3 : User chooses to add 2nd sector or not
  // ==========================================
  if (step === 3 && parsed.buttonId?.startsWith('ob_add_sector_')) {
    if (parsed.buttonId === 'ob_add_sector_no') {
      // Skip to ia_interest
      await updateProfile(user.id, { onboarding_step: 6 });
      await askIaInterest(user);
      return true;
    }
    // User wants to add 2nd sector
    await updateProfile(user.id, { onboarding_step: 4 });
    const primaryLabel = user.job || '';
    // Exclude primary sector from list
    const primaryId = SECTORS.find(s => s.title === primaryLabel)?.id;
    await sendSectorList(
      user.whatsapp_id,
      'Ton 2ème secteur ? 🎯',
      'Choisir',
      primaryId ? [primaryId] : []
    );
    return true;
  }

  // ==========================================
  // STEP 4 : Got 2nd sector → ask 3rd
  // ==========================================
  if (step === 4 && parsed.listId?.startsWith('ob_sector_')) {
    const sectorId = parsed.listId.replace('ob_sector_', '');
    // Load current secondary_jobs and append
    const result = await query('SELECT secondary_jobs FROM users WHERE id = $1', [user.id]);
    const current = result.rows[0]?.secondary_jobs || [];
    const newSecondary = Array.isArray(current) ? [...current, getSectorLabel(sectorId)] : [getSectorLabel(sectorId)];
    await query('UPDATE users SET secondary_jobs = $1::jsonb WHERE id = $2', [JSON.stringify(newSecondary), user.id]);
    await updateProfile(user.id, { onboarding_step: 5 });

    await whatsapp.sendButtons(
      user.whatsapp_id,
      'Top ! Tu veux ajouter un 3ème et dernier secteur ?',
      [
        { id: 'ob_add_third_yes', title: 'Oui, 3ème ➕' },
        { id: 'ob_add_third_no', title: 'Non, continuer ➡️' },
      ]
    );
    return true;
  }

  // ==========================================
  // STEP 5 : User chooses to add 3rd sector or not
  // ==========================================
  if (step === 5 && parsed.buttonId?.startsWith('ob_add_third_')) {
    if (parsed.buttonId === 'ob_add_third_no') {
      await updateProfile(user.id, { onboarding_step: 6 });
      await askIaInterest(user);
      return true;
    }
    // Fetch current job + secondary_jobs to exclude
    const result = await query('SELECT job, secondary_jobs FROM users WHERE id = $1', [user.id]);
    const primaryId = SECTORS.find(s => s.title === result.rows[0]?.job)?.id;
    const secondaryTitles = result.rows[0]?.secondary_jobs || [];
    const secondaryIds = SECTORS.filter(s => secondaryTitles.includes(s.title)).map(s => s.id);
    const excludeIds = [primaryId, ...secondaryIds].filter(Boolean);

    await updateProfile(user.id, { onboarding_step: 51 });
    await sendSectorList(
      user.whatsapp_id,
      'Ton 3ème secteur ? 🎯',
      'Choisir',
      excludeIds
    );
    return true;
  }

  // ==========================================
  // STEP 51 : Got 3rd sector → ia_interest
  // ==========================================
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

  // ==========================================
  // STEP 6 : Got ia_interest (or "other")
  // ==========================================
  if (step === 6 && parsed.listId?.startsWith('ob_interest_')) {
    const interestId = parsed.listId.replace('ob_interest_', '');
    if (interestId === 'other') {
      await updateProfile(user.id, { ia_interest: 'other', onboarding_step: 61 });
      await whatsapp.sendText(
        user.whatsapp_id,
        'Décris-moi en 1 phrase ce que tu veux apprendre ou appliquer avec l\'IA ✍️\n\n' +
        '_Exemple : "Utiliser l\'IA pour ma boîte de conseil en immobilier"_'
      );
      return true;
    }
    await updateProfile(user.id, { ia_interest: interestId, onboarding_step: 7 });
    await askConsent(user);
    return true;
  }

  // ==========================================
  // STEP 61 : Got free text for "other" interest
  // ==========================================
  if (step === 61 && parsed.text) {
    const customInterest = parsed.text.trim().substring(0, 200);
    await updateProfile(user.id, { ia_interest_other: customInterest, onboarding_step: 7 });
    await whatsapp.sendText(user.whatsapp_id, 'Parfait, noté ! 📝');
    await delay(800);
    await askConsent(user);
    return true;
  }

  // ==========================================
  // STEP 7 : Got consent → ask hour or skip
  // ==========================================
  if (step === 7 && parsed.buttonId?.startsWith('ob_consent_')) {
    if (parsed.buttonId === 'ob_consent_no') {
      await updateProfile(user.id, { daily_opt_in: false, onboarding_step: 9 });
      await whatsapp.sendText(
        user.whatsapp_id,
        'Pas de souci ! 👍 Tu ne recevras pas de messages quotidiens.\n\n' +
        'Tu pourras toujours me poser tes questions sur l\'IA quand tu veux.\n\n' +
        'Si tu changes d\'avis, tape /daily pour activer les messages quotidiens.'
      );
      await delay(1500);
      await sendRecapAndPlan(user, null);
      return true;
    }
    await updateProfile(user.id, { daily_opt_in: true, onboarding_step: 8 });
    await whatsapp.sendText(user.whatsapp_id, 'Merci ! 🎉 Tu recevras ton message quotidien personnalisé.');
    await delay(1000);
    await whatsapp.sendText(user.whatsapp_id, 'Tu peux aussi écrire l\'heure que tu préfères en texte libre (ex : 8h30, 14h00) ✍️');
    await delay(1000);
    await askHour(user);
    return true;
  }

  // ==========================================
  // STEP 8 : Got hour → recap + plan
  // ==========================================
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
        'Hmm, je n\'ai pas compris l\'heure 🤔\n\nÉcris-la au format 8h30, 14h00, ou choisis dans la liste ci-dessous 👇'
      );
      await delay(500);
      await askHour(user);
      return true;
    }

    await updateProfile(user.id, { preferred_hour: hour, onboarding_step: 9 });
    await sendRecapAndPlan(user, hour);
    return true;
  }

  // ==========================================
  // STEP 9 : Got plan → complete + first daily
  // ==========================================
  if (step === 9 && parsed.buttonId?.startsWith('ob_plan_')) {
    const planMap = {
      ob_plan_trial: { name: 'trial', price: 0 },
      ob_plan_etudiant: { name: 'student', price: 4.99 },
      ob_plan_pro: { name: 'pro', price: 7.99 },
    };
    const plan = planMap[parsed.buttonId];
    if (!plan) return false;

    if (plan.price === 0) {
      await updateProfile(user.id, { plan: plan.name, onboarding_step: 10, onboarding_complete: true });
      await whatsapp.sendText(
        user.whatsapp_id,
        'C\'est parti ! 🎉\n\n' +
        'Tu commences avec l\'essai gratuit (7 jours, 15 messages/jour).\n\n' +
        'Des questions ? Tape /help pour voir toutes mes commandes 🚀'
      );

      if (user.daily_opt_in !== false) {
        await delay(2500);
        await sendFirstDaily(user);
      }
      return true;
    } else {
      const checkoutUrl = await createCheckoutUrl(user.id, plan.name, plan.price);
      if (!checkoutUrl) {
        await whatsapp.sendText(user.whatsapp_id, 'Oups, problème lors de la création du paiement. Réessaye plus tard 😔');
        return false;
      }
      await updateProfile(user.id, { plan: plan.name, onboarding_step: 10, onboarding_complete: true });
      await whatsapp.sendText(
        user.whatsapp_id,
        'Voici ton lien de paiement 👇\n\n' + checkoutUrl + '\n\n🔒 Paiement sécurisé par Stripe. Sans engagement.'
      );
      return true;
    }
  }

  if (parsed.text && !parsed.buttonId && !parsed.listId) {
    logger.warn('Text input during onboarding', { userId: user.id, step });
    if (step !== 8 && step !== 61) {
      await whatsapp.sendText(user.whatsapp_id, 'Utilise les boutons ou la liste ci-dessus pour continuer 👆');
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
    '*Question 4/5* — Sur quoi tu veux appliquer l\'IA en priorité ? 🎯\n\nÇa m\'aide à te proposer des parcours et exemples ultra-pertinents.',
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
    'Super, merci pour tes réponses ! 🙌\n\n' +
    'Pour t\'accompagner au mieux, j\'aimerais t\'envoyer *un message personnalisé chaque jour* sur l\'IA, adapté à ton profil.\n\n' +
    '📋 En acceptant, tu consens à :\n' +
    '• Recevoir un message quotidien de Will sur WhatsApp\n' +
    '• Le traitement de tes données (profil, préférences) pour personnaliser le contenu\n\n' +
    'Tu peux te désinscrire à tout moment en tapant /stop.\n\n' +
    '🔒 Politique de confidentialité : https://will-coach-ia.netlify.app/privacy'
  );
  await delay(2000);
  await whatsapp.sendButtons(
    user.whatsapp_id,
    '*Question 5/5* — Acceptes-tu de recevoir un message quotidien de Will ? 📬',
    [
      { id: 'ob_consent_yes', title: 'J\'accepte ✅' },
      { id: 'ob_consent_no', title: 'Non merci ❌' },
    ],
    null,
    'Tu pourras changer d\'avis à tout moment'
  );
}

async function askHour(user) {
  await whatsapp.sendList(
    user.whatsapp_id,
    'À quelle heure tu veux recevoir ton message quotidien ? ⏰',
    'Choisir mon heure',
    [
      { title: 'Matin ☀️', rows: [
        { id: 'ob_hour_7', title: '7h00', description: 'Tôt le matin 🌅' },
        { id: 'ob_hour_8', title: '8h00', description: 'Début de journée' },
        { id: 'ob_hour_9', title: '9h00', description: 'En arrivant au travail' },
        { id: 'ob_hour_10', title: '10h00', description: 'Milieu de matinée' },
        { id: 'ob_hour_12', title: '12h00', description: 'Pause déjeuner 🍲' },
      ] },
      { title: 'Après-midi / Soir 🌙', rows: [
        { id: 'ob_hour_14', title: '14h00', description: 'Après-midi' },
        { id: 'ob_hour_16', title: '16h00', description: 'Fin d\'après-midi' },
        { id: 'ob_hour_18', title: '18h00', description: 'Fin de journée' },
        { id: 'ob_hour_20', title: '20h00', description: 'Soirée 🌙' },
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
    'Ton profil Will est prêt ! ✅',
    '',
    '📊 Niveau : ' + (user.level || 'débutant'),
    '💼 Secteur(s) : ' + allSectors,
    '🎯 Focus IA : ' + interestLabel,
  ];
  if (hour !== null && hour !== undefined) {
    recapLines.push('⏰ Message quotidien : ' + hour + 'h00');
  } else {
    recapLines.push('📬 Messages quotidiens : désactivés');
  }
  recapLines.push('');
  recapLines.push('Je vais personnaliser tous mes conseils en fonction de ça 💪');

  await whatsapp.sendText(user.whatsapp_id, recapLines.join('\n'));
  await delay(2000);
  await whatsapp.sendButtons(
    user.whatsapp_id,
    'Dernière étape : choisis comment tu veux utiliser Will 👇\n\n' +
    '🆕 *Essai gratuit* — 7 jours, 15 msg/jour\n' +
    '🎓 *Étudiant* — 4,99€/mois, 40 msg/jour\n' +
    '🚀 *Pro* — 7,99€/mois, illimité + priorité',
    [
      { id: 'ob_plan_trial', title: 'Essai gratuit 7j' },
      { id: 'ob_plan_etudiant', title: 'Étudiant 4,99€' },
      { id: 'ob_plan_pro', title: 'Pro 7,99€' },
    ],
    null,
    'Tu pourras changer à tout moment'
  );
}

async function sendFirstDaily(user) {
  try {
    const dailyContent = await claude.generateDailyContent({
      displayName: user.display_name?.split(' ')[0] || '',
      level: user.level || 'débutant',
      job: user.job || '',
    });
    if (!dailyContent) {
      logger.warn('First daily: no content generated', { userId: user.id });
      return;
    }
    await cacheResponse('daily:' + user.id, dailyContent, 86400);
    await whatsapp.sendButtons(
      user.whatsapp_id,
      dailyContent,
      [
        { id: 'daily_deep', title: 'J\'approfondis 🔍' },
        { id: 'daily_example', title: 'Exemple concret 💼' },
        { id: 'daily_next', title: 'Notion suivante ➡️' },
      ]
    );
    logger.info('First daily sent after onboarding', { userId: user.id });
  } catch (err) {
    logger.error('Error sending first daily', { userId: user.id, error: err.message });
  }
}

async function createCheckoutUrl(userId, planName, price) {
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: { name: 'Will - Plan ' + planName },
          unit_amount: Math.round(price * 100),
          recurring: { interval: 'month' },
        },
        quantity: 1,
      }],
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

module.exports = { handleOnboarding, createCheckoutUrl };
