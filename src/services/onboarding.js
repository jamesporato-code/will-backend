const whatsapp = require('./whatsapp');
const { updateProfile } = require('./userService');
const contentTypes = require('./contentTypes');
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
  { id: 'marketing', title: 'Marketing / Comm', description: 'Pub, contenu, reseaux sociaux' },
  { id: 'tech', title: 'Tech / Dev / Data', description: 'Code, IA, data, produit, IT' },
  { id: 'business', title: 'Business / Finance', description: 'Vente, gestion, conseil, compta' },
  { id: 'creation', title: 'Creation / Design', description: 'Graphisme, video, UX, photo' },
  { id: 'education', title: 'Education / Formation', description: 'Enseignement, e-learning, RH' },
  { id: 'sante', title: 'Sante / Bien-etre', description: 'Medical, pharma, coaching' },
  { id: 'juridique', title: 'Droit / Immobilier', description: 'Juridique, notariat, immo' },
  { id: 'artisanat', title: 'Artisanat / Commerce', description: 'Boutique, resto, artisan' },
  { id: 'freelance', title: 'Freelance / Startup', description: 'Independant, entrepreneur' },
  { id: 'autre', title: 'Autre secteur', description: 'Je precise apres' },
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
// INTERETS IA (10 choix sur 2 sections)
// ============================================
const IA_INTERESTS_SECTIONS = [
  {
    title: 'Pro & Business',
    rows: [
      { id: 'business', title: 'Business / Startup', description: 'Pitch, strategie, scaling' },
      { id: 'marketing', title: 'Marketing & Vente', description: 'Acquisition, social, closing' },
      { id: 'content', title: 'Creation contenu', description: 'Copy, blog, video, image' },
      { id: 'dev', title: 'Code & Data', description: 'Dev, Copilot, SQL, agents IA' },
      { id: 'management', title: 'Management / RH', description: 'Equipe, recrut., leadership' },
    ],
  },
  {
    title: 'Perso & Skills',
    rows: [
      { id: 'studies', title: 'Etudes / Apprentissage', description: 'Revisions, memoires, langues' },
      { id: 'productivity', title: 'Productivite', description: 'Gain de temps au quotidien' },
      { id: 'automation', title: 'Automatisation', description: 'Zapier, Make, workflows' },
      { id: 'ai', title: 'AI / Deep tech', description: 'Agents, MCP, LLMs, modeles' },
      { id: 'other', title: 'Autre', description: 'Je precise en 1 phrase' },
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

  // STEP 0 : Welcome + demarrer
  if (step === 0) {
    const greeting = name ? ('Salut ' + name + ' !') : 'Salut !';
    await whatsapp.sendText(
      user.whatsapp_id,
      greeting + '\n\n' +
      'Moi c\'est *Will*, ton coach perso en intelligence artificielle.\n\n' +
      '*Ma mission* : t\'aider a maitriser l\'IA au quotidien pour bosser plus vite, apprendre des trucs ou rester a la pointe.\n\n' +
      '*Comment ca marche*\n' +
      'Chaque jour, je t\'envoie un message personnalise : une notion cle, un cas concret adapte a ton profil et un defi a tester en 3 min.\n\n' +
      '*Une question ?* Pose-la-moi a tout moment.\n\n' +
      'Avant de demarrer, 5 questions rapides pour personnaliser ton experience (1 min). C\'est parti !'
    );
    await delay(2500);
    await whatsapp.sendButtons(
      user.whatsapp_id,
      '*Question 1/5* — Quel est ton niveau actuel en IA ?',
      [
        { id: 'ob_level_debutant', title: 'Debutant' },
        { id: 'ob_level_intermediaire', title: 'Intermediaire' },
        { id: 'ob_level_avance', title: 'Avance' },
      ],
      null,
      'Pas de mauvaise reponse'
    );
    await updateProfile(user.id, { onboarding_step: 1 });
    return true;
  }

  // STEP 1 : niveau -> secteur principal
  if (step === 1 && parsed.buttonId?.startsWith('ob_level_')) {
    const level = parsed.buttonId.replace('ob_level_', '');
    await updateProfile(user.id, { level, onboarding_step: 2 });

    const levelMsg = {
      debutant: 'Parfait, on va y aller progressivement !',
      intermediaire: 'Top, tu as deja de bonnes bases !',
      avance: 'Excellent, on va aller loin ensemble !',
    };
    await whatsapp.sendText(user.whatsapp_id, levelMsg[level] || 'Note !');
    await delay(1200);
    await sendSectorList(
      user.whatsapp_id,
      '*Question 2/5* — Dans quel secteur tu travailles principalement ?',
      'Choisir mon secteur',
      []
    );
    return true;
  }

  // STEP 2 : secteur principal -> 2eme ?
  if (step === 2 && parsed.listId?.startsWith('ob_sector_')) {
    const sectorId = parsed.listId.replace('ob_sector_', '');
    await updateProfile(user.id, { job: getSectorLabel(sectorId), onboarding_step: 3 });

    await whatsapp.sendButtons(
      user.whatsapp_id,
      'Tu veux ajouter d\'autres secteurs ? Max 3 pour que je croise mieux mes conseils.\n\n' +
      '_(Ex : un etudiant qui bosse aussi en marketing peut ajouter les deux.)_',
      [
        { id: 'ob_add_sector_yes', title: 'Oui, j\'ajoute' },
        { id: 'ob_add_sector_no', title: 'Non, continuer' },
      ],
      null,
      'Optionnel — tu peux en rester a 1'
    );
    return true;
  }

  // STEP 3 : 2eme secteur ?
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
      'Ton 2eme secteur ?',
      'Choisir',
      primaryId ? [primaryId] : []
    );
    return true;
  }

  // STEP 4 : 2eme secteur -> 3eme ?
  if (step === 4 && parsed.listId?.startsWith('ob_sector_')) {
    const sectorId = parsed.listId.replace('ob_sector_', '');
    const result = await query('SELECT secondary_jobs FROM users WHERE id = $1', [user.id]);
    const current = result.rows[0]?.secondary_jobs || [];
    const newSecondary = Array.isArray(current) ? [...current, getSectorLabel(sectorId)] : [getSectorLabel(sectorId)];
    await query('UPDATE users SET secondary_jobs = $1::jsonb WHERE id = $2', [JSON.stringify(newSecondary), user.id]);
    await updateProfile(user.id, { onboarding_step: 5 });

    await whatsapp.sendButtons(
      user.whatsapp_id,
      'Top ! Tu veux ajouter un 3eme et dernier secteur ?',
      [
        { id: 'ob_add_third_yes', title: 'Oui, 3eme' },
        { id: 'ob_add_third_no', title: 'Non, continuer' },
      ]
    );
    return true;
  }

  // STEP 5 : 3eme secteur ?
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
      'Ton 3eme secteur ?',
      'Choisir',
      excludeIds
    );
    return true;
  }

  // STEP 51 : 3eme secteur -> ia_interest
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
        'Decris-moi en 1 phrase ce que tu veux apprendre ou appliquer avec l\'IA.\n\n' +
        '_Exemple : "Utiliser l\'IA pour ma boite de conseil en immobilier"_'
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
    await whatsapp.sendText(user.whatsapp_id, 'Parfait, note !');
    await delay(800);
    await askConsent(user);
    return true;
  }

  // STEP 7 : consentement -> heure ou skip
  if (step === 7 && parsed.buttonId?.startsWith('ob_consent_')) {
    if (parsed.buttonId === 'ob_consent_no') {
      await updateProfile(user.id, { daily_opt_in: false, onboarding_step: 9 });
      await whatsapp.sendText(
        user.whatsapp_id,
        'Pas de souci ! Tu ne recevras pas de messages quotidiens.\n\n' +
        'Tu peux toujours me poser tes questions sur l\'IA quand tu veux.\n\n' +
        'Si tu changes d\'avis, tape /daily pour activer les messages quotidiens.'
      );
      await delay(1500);
      await sendRecapAndPlan(user, null);
      return true;
    }
    await updateProfile(user.id, { daily_opt_in: true, onboarding_step: 8 });
    await whatsapp.sendText(user.whatsapp_id, 'Merci ! Tu recevras ton message quotidien personnalise.');
    await delay(1000);
    await whatsapp.sendText(user.whatsapp_id, 'Tu peux ecrire l\'heure que tu preferes en texte libre (ex : 8h30, 14h00) ou choisir dans la liste.');
    await delay(1000);
    await askHour(user);
    return true;
  }

  // STEP 8 : heure -> recap + plan
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
        'Hmm, je n\'ai pas compris l\'heure.\n\nEcris-la au format 8h30, 14h00, ou choisis dans la liste ci-dessous.'
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
        'C\'est parti !\n\n' +
        'Tu commences avec l\'essai gratuit (7 jours, 15 messages/jour).\n\n' +
        'Des questions ? Tape /help pour voir toutes mes commandes.'
      );

      // Ne lance le 1er daily que si l'utilisateur a opt-in
      const optInRow = await query('SELECT daily_opt_in FROM users WHERE id = $1', [user.id]);
      if (optInRow.rows[0]?.daily_opt_in !== false) {
        await delay(2500);
        await sendFirstDaily(user);
      }
      return true;
    }

    if (parsed.buttonId === 'ob_plan_pro') {
      const checkoutUrl = await createCheckoutUrl(user);
      if (!checkoutUrl) {
        await whatsapp.sendText(user.whatsapp_id, 'Oups, probleme lors de la creation du paiement. Reessaye plus tard.');
        return false;
      }
      // SECURITE : on ne set PAS plan='pro' ici. C'est le webhook Stripe
      // checkout.session.completed qui fait foi (cf src/routes/stripe.js).
      await updateProfile(user.id, { onboarding_step: 10, onboarding_complete: true });
      await whatsapp.sendText(
        user.whatsapp_id,
        'Voici ton lien de paiement (Pro 6,99/mois) :\n\n' + checkoutUrl + '\n\n' +
        'Paiement securise par Stripe. Sans engagement.'
      );
      return true;
    }
    return false;
  }

  if (parsed.text && !parsed.buttonId && !parsed.listId) {
    logger.warn('Text input during onboarding', { userId: user.id, step });
    if (step !== 8 && step !== 61) {
      await whatsapp.sendText(user.whatsapp_id, 'Utilise les boutons ou la liste ci-dessus pour continuer.');
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
    '*Question 4/5* — Sur quoi tu veux appliquer l\'IA en priorite ?\n\nCa m\'aide a te proposer des parcours et exemples ultra-pertinents.',
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
    'Super, merci pour tes reponses !\n\n' +
    'Pour t\'accompagner au mieux, j\'aimerais t\'envoyer *un message personnalise chaque jour* sur l\'IA, adapte a ton profil.\n\n' +
    'En acceptant, tu consens a :\n' +
    '- Recevoir un message quotidien de Will sur WhatsApp\n' +
    '- Le traitement de tes donnees (profil, preferences) pour personnaliser le contenu\n\n' +
    'Tu peux te desinscrire a tout moment en tapant /stop.\n\n' +
    'Politique de confidentialite : https://will-coach-ia.netlify.app/privacy'
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
    'Tu pourras changer d\'avis a tout moment'
  );
}

async function askHour(user) {
  await whatsapp.sendList(
    user.whatsapp_id,
    'A quelle heure tu veux recevoir ton message quotidien ?',
    'Choisir mon heure',
    [
      { title: 'Matin', rows: [
        { id: 'ob_hour_7', title: '7h00', description: 'Tot le matin' },
        { id: 'ob_hour_8', title: '8h00', description: 'Debut de journee' },
        { id: 'ob_hour_9', title: '9h00', description: 'En arrivant au travail' },
        { id: 'ob_hour_10', title: '10h00', description: 'Milieu de matinee' },
        { id: 'ob_hour_12', title: '12h00', description: 'Pause dejeuner' },
      ] },
      { title: 'Apres-midi / Soir', rows: [
        { id: 'ob_hour_14', title: '14h00', description: 'Apres-midi' },
        { id: 'ob_hour_16', title: '16h00', description: 'Fin d\'apres-midi' },
        { id: 'ob_hour_18', title: '18h00', description: 'Fin de journee' },
        { id: 'ob_hour_20', title: '20h00', description: 'Soiree' },
        { id: 'ob_hour_22', title: '22h00', description: 'Tard le soir' },
      ] },
    ]
  );
}

async function sendRecapAndPlan(user, hour) {
  const result = await query('SELECT job, secondary_jobs, ia_interest, ia_interest_other FROM users WHERE id = $1', [user.id]);
  const row = result.rows[0] || {};
  const primaryJob = row.job || 'Non precise';
  const secondaryArr = Array.isArray(row.secondary_jobs) ? row.secondary_jobs : [];
  const allSectors = [primaryJob, ...secondaryArr].filter(Boolean).join(', ');
  const interestLabel = row.ia_interest === 'other'
    ? (row.ia_interest_other || 'Autre')
    : getInterestLabel(row.ia_interest);

  const recapLines = [
    'Ton profil Will est pret !',
    '',
    'Niveau : ' + (user.level || 'debutant'),
    'Secteur(s) : ' + allSectors,
    'Focus IA : ' + interestLabel,
  ];
  if (hour !== null && hour !== undefined) {
    recapLines.push('Message quotidien : ' + hour + 'h00');
  } else {
    recapLines.push('Messages quotidiens : desactives');
  }
  recapLines.push('');
  recapLines.push('Je vais personnaliser tous mes conseils en fonction de ca.');

  await whatsapp.sendText(user.whatsapp_id, recapLines.join('\n'));
  await delay(2000);
  await whatsapp.sendButtons(
    user.whatsapp_id,
    'Derniere etape : choisis comment tu veux utiliser Will.\n\n' +
    '*Essai gratuit* — 7 jours, 15 msg/jour, contenu mixe (parcours + actu)\n' +
    '*Pro* — 6,99/mois, illimite, parcours complet + actu + outils + prompts',
    [
      { id: 'ob_plan_trial', title: 'Essai gratuit 7j' },
      { id: 'ob_plan_pro', title: 'Pro 6,99/mois' },
    ],
    null,
    'Tu pourras passer Pro a tout moment'
  );
}

async function sendFirstDaily(user) {
  try {
    // Recharger le profil complet pour generateParcours (job, secondary_jobs, ia_interest, etc.)
    const result = await query('SELECT * FROM users WHERE id = $1', [user.id]);
    const fullUser = result.rows[0];
    if (!fullUser) return;

    const out = await contentTypes.generateParcours(fullUser);
    if (!out || !out.text) {
      logger.warn('First daily: no content generated', { userId: user.id });
      return;
    }
    await cacheResponse('daily:' + user.id, out.text, 86400);
    await whatsapp.sendButtons(
      user.whatsapp_id,
      out.text,
      [
        { id: 'daily_deep', title: 'J\'approfondis' },
        { id: 'daily_example', title: 'Exemple concret' },
        { id: 'daily_next', title: 'Notion suivante' },
      ]
    );
    if (out.nextProgress) {
      await updateProfile(user.id, {
        current_module: out.nextProgress.current_module,
        module_progress: out.nextProgress.module_progress,
      });
    }
    logger.info('First daily sent after onboarding', { userId: user.id });
  } catch (err) {
    logger.error('Error sending first daily', { userId: user.id, error: err.message });
  }
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
