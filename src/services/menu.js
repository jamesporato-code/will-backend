// ============================================
// HUB /menu — navigation 100% boutons
// + Mini-coaching (quiz capture profil sans free-text)
// ============================================

const whatsapp = require('./whatsapp');
const userService = require('./userService');
const logger = require('../utils/logger');
const { query } = require('../db/pool');
const { getCachedResponse } = require('./redis');
const { HOUR_ROWS_BY_PERIOD } = require('./onboarding');
const { SECTORS, getSectorLabel, isValidSector } = require('./sectors');

function formatHour(h, m) {
  if (h === null || h === undefined || h === '') return null;
  const mm = (m === null || m === undefined) ? 0 : m;
  const mPad = mm < 10 ? '0' + mm : '' + mm;
  return h + 'h' + mPad;
}

// ============================================
// MAIN MENU — liste hub
// ============================================
async function showMainMenu(user, intro = null) {
  if (intro) {
    await whatsapp.sendText(user.whatsapp_id, intro);
    await new Promise(r => setTimeout(r, 600));
  }
  const isPro = user.plan === 'pro';
  const proRows = [
    { id: 'menu_parcours', title: 'Ma session du jour', description: 'Le module en cours' },
    { id: 'menu_actu', title: 'Actu IA', description: 'L\'info IA du jour' },
    { id: 'menu_outil', title: 'Outil du jour', description: 'Un outil à découvrir' },
    { id: 'menu_prompt', title: 'Prompt du jour', description: 'Un prompt à copier' },
  ];
  const trialRows = [
    { id: 'menu_parcours', title: 'Ma session du jour', description: 'Relire ta session du jour' },
  ];

  const sections = [
    {
      title: isPro ? 'Aujourd\'hui' : 'Mon essai',
      rows: isPro ? proRows : trialRows,
    },
    {
      title: 'Profil & coaching',
      rows: [
        { id: 'menu_quiz', title: 'Mini-coaching', description: 'Affine ton profil en 3 questions' },
        { id: 'menu_account', title: 'Mon compte', description: 'Plan, niveau, stats' },
      ],
    },
    {
      title: 'Aide',
      rows: [
        { id: 'menu_help', title: 'Aide & commandes', description: 'Comment Will fonctionne' },
      ],
    },
  ];

  await whatsapp.sendList(
    user.whatsapp_id,
    'Choisis ce que tu veux faire — tout passe par les boutons, pas besoin d\'écrire.',
    'Ouvrir le menu',
    sections,
    'Will'
  );
}

// ============================================
// REPLAY DU DAILY (lit le cache)
// ============================================
async function replayTodayDaily(user) {
  const content = await getCachedResponse('daily:' + user.id);
  if (!content) {
    await whatsapp.sendButtons(
      user.whatsapp_id,
      'Pas de message du jour à rejouer pour le moment. Tu peux ouvrir ta session du jour à la place.',
      [
        { id: 'menu_parcours', title: 'Ma session du jour' },
        { id: 'menu_hub', title: 'Retour au menu' },
      ]
    );
    return;
  }
  await whatsapp.sendText(user.whatsapp_id, content);
  await new Promise(r => setTimeout(r, 600));
  await whatsapp.sendButtons(
    user.whatsapp_id,
    'Tu veux continuer à explorer ?',
    [
      { id: 'daily_deep', title: 'J\'approfondis' },
      { id: 'daily_example', title: 'Exemple concret' },
      { id: 'daily_minidefi', title: 'Mini-défi' },
    ]
  );
}

// ============================================
// AIDE
// ============================================
async function showHelp(user) {
  await whatsapp.sendButtons(
    user.whatsapp_id,
    '*Comment marche Will*\n\n' +
    '— Chaque jour à ton heure, tu reçois une session de ton parcours\n' +
    '— Tu choisis ensuite : approfondir, exemple ou mini-défi\n' +
    '— Tape /menu à tout moment pour retrouver tes outils\n' +
    '— Ton profil s\'affine via le mini-coaching\n\n' +
    'Pas besoin d\'écrire : tout passe par les boutons.',
    [
      { id: 'menu_hub', title: 'Retour au menu' },
      { id: 'menu_quiz', title: 'Mini-coaching' },
    ]
  );
}

// ============================================
// QUIZ — capture profil sans free-text
// 3 questions enchaînées via listId
// ============================================
async function startQuiz(user) {
  await userService.updateProfile(user.id, { menu_quiz_step: 1 });
  await whatsapp.sendList(
    user.whatsapp_id,
    'Question 1/3 — À quelle fréquence utilises-tu l\'IA aujourd\'hui ?',
    'Choisir',
    [
      { title: 'Fréquence', rows: [
        { id: 'quiz_freq_never', title: 'Jamais', description: 'Je découvre' },
        { id: 'quiz_freq_rarely', title: 'De temps en temps', description: 'Quelques fois par mois' },
        { id: 'quiz_freq_weekly', title: 'Chaque semaine', description: 'Régulièrement' },
        { id: 'quiz_freq_daily', title: 'Chaque jour', description: 'C\'est ancré' },
      ] },
    ]
  );
}

async function askQuizQuestion2(user) {
  await userService.updateProfile(user.id, { menu_quiz_step: 2 });
  await whatsapp.sendList(
    user.whatsapp_id,
    'Question 2/3 — Quel est ton objectif principal avec l\'IA ?',
    'Choisir',
    [
      { title: 'Objectif', rows: [
        { id: 'quiz_goal_time', title: 'Gagner du temps', description: 'Automatiser des tâches' },
        { id: 'quiz_goal_skills', title: 'Monter en compétences', description: 'Devenir bon en IA' },
        { id: 'quiz_goal_project', title: 'Lancer un projet', description: 'Entreprise, side-project' },
        { id: 'quiz_goal_curiosity', title: 'Pure curiosité', description: 'Comprendre ce qui se passe' },
      ] },
    ]
  );
}

async function askQuizQuestion3(user) {
  await userService.updateProfile(user.id, { menu_quiz_step: 3 });
  await whatsapp.sendList(
    user.whatsapp_id,
    'Question 3/3 — Combien de temps par jour tu veux y consacrer ?',
    'Choisir',
    [
      { title: 'Temps quotidien', rows: [
        { id: 'quiz_time_3', title: '3 minutes', description: 'Une lecture rapide' },
        { id: 'quiz_time_5', title: '5 minutes', description: 'Le bon équilibre' },
        { id: 'quiz_time_10', title: '10 minutes', description: 'Pour bien intégrer' },
        { id: 'quiz_time_20', title: '20 min ou plus', description: 'Mode immersion' },
      ] },
    ]
  );
}

async function finishQuiz(user) {
  await userService.updateProfile(user.id, { menu_quiz_step: 0 });
  const row = await query(
    'SELECT ia_frequency, ia_goal, ia_time_budget FROM users WHERE id = $1',
    [user.id]
  );
  const r = row.rows[0] || {};
  const freqLabel = {
    never: 'Tu démarres tout juste',
    rarely: 'Tu utilises l\'IA de temps en temps',
    weekly: 'Tu utilises l\'IA chaque semaine',
    daily: 'L\'IA fait déjà partie de ton quotidien',
  }[r.ia_frequency] || '';
  const goalLabel = {
    time: 'gagner du temps',
    skills: 'monter en compétences',
    project: 'lancer un projet',
    curiosity: 'comprendre l\'IA',
  }[r.ia_goal] || 'progresser';
  const timeLabel = r.ia_time_budget ? r.ia_time_budget + ' min/jour' : '';

  const summary = 'Profil mis à jour.\n\n' +
    (freqLabel ? freqLabel + '.\n' : '') +
    'Objectif : ' + goalLabel + '.\n' +
    (timeLabel ? 'Temps : ' + timeLabel + '.\n' : '') +
    '\nJe vais ajuster mes prochains messages en fonction.';

  await whatsapp.sendButtons(
    user.whatsapp_id,
    summary,
    [
      { id: 'menu_hub', title: 'Retour au menu' },
      { id: 'menu_parcours', title: 'Ma session du jour' },
    ]
  );
}

async function handleQuizAnswer(user, listId) {
  if (listId.startsWith('quiz_freq_')) {
    const freq = listId.replace('quiz_freq_', '');
    await userService.updateProfile(user.id, { ia_frequency: freq });
    await askQuizQuestion2(user);
    return true;
  }
  if (listId.startsWith('quiz_goal_')) {
    const goal = listId.replace('quiz_goal_', '');
    await userService.updateProfile(user.id, { ia_goal: goal });
    await askQuizQuestion3(user);
    return true;
  }
  if (listId.startsWith('quiz_time_')) {
    const time = parseInt(listId.replace('quiz_time_', ''), 10);
    if (!isNaN(time)) {
      await userService.updateProfile(user.id, { ia_time_budget: time });
    }
    await finishQuiz(user);
    return true;
  }
  return false;
}

// ============================================
// HUB ROUTER — appelé depuis webhook pour tous les menu_*
// Retourne true si le bouton a été géré ici.
// ============================================
async function handleMenuButton(user, buttonId) {
  if (buttonId === 'menu_hub') {
    await showMainMenu(user);
    return true;
  }
  if (buttonId === 'menu_today' || buttonId === 'menu_parcours') {
    // v3.6 : menu_parcours rejoue le daily du jour (jamais de progression manuelle).
    // La progression du parcours ne se fait QUE via le cron ou le 1er daily post-onboarding.
    await replayTodayDaily(user);
    return true;
  }
  if (buttonId === 'menu_help') {
    await showHelp(user);
    return true;
  }
  if (buttonId === 'menu_quiz') {
    await startQuiz(user);
    return true;
  }
  return false; // laisse les autres menu_* (actu/outil/prompt/account) passer
}

// ============================================
// CHANGE HOUR — picker 3 étapes (période → heure → minute)
// Les ids encodent l'état pour éviter un state DB temporaire.
// ============================================
async function startChangeHour(user) {
  const current = formatHour(user.preferred_hour, user.preferred_minute);
  const intro = current
    ? 'Tu reçois ton message à ' + current + '. À quel moment de la journée veux-tu le recevoir maintenant ?'
    : 'À quel moment de la journée veux-tu recevoir ton message ?';
  await whatsapp.sendButtons(
    user.whatsapp_id,
    intro,
    [
      { id: 'chh_period_morning', title: 'Matin 5h-12h' },
      { id: 'chh_period_afternoon', title: 'Aprem 13h-18h' },
      { id: 'chh_period_evening', title: 'Soirée 19h-4h' },
    ]
  );
}

async function askChangeHourSelection(user, period) {
  const baseRows = HOUR_ROWS_BY_PERIOD[period] || HOUR_ROWS_BY_PERIOD.morning;
  const rows = baseRows.map(r => ({ ...r, id: r.id.replace('ob_hour_', 'chh_hour_') }));
  await whatsapp.sendList(
    user.whatsapp_id,
    'Choisis l\'heure pile.',
    'Choisir l\'heure',
    [{ title: 'Heures', rows }]
  );
}

async function askChangeMinuteSelection(user, hour) {
  const hLabel = hour + 'h';
  await whatsapp.sendList(
    user.whatsapp_id,
    'À quelle minute autour de ' + hLabel + ' ?',
    'Choisir la minute',
    [
      { title: 'Quart d\'heure', rows: [
        { id: 'chh_min_' + hour + '_0', title: hLabel + '00', description: 'Heure pile' },
        { id: 'chh_min_' + hour + '_15', title: hLabel + '15', description: 'Et quart' },
        { id: 'chh_min_' + hour + '_30', title: hLabel + '30', description: 'Et demi' },
        { id: 'chh_min_' + hour + '_45', title: hLabel + '45', description: 'Moins le quart' },
      ] },
    ]
  );
}

async function finishChangeHour(user, hour, minute) {
  await userService.updateProfile(user.id, { preferred_hour: hour, preferred_minute: minute });
  const label = formatHour(hour, minute);
  await whatsapp.sendButtons(
    user.whatsapp_id,
    'C\'est noté. Tu recevras désormais ton message à ' + label + '.',
    [
      { id: 'menu_account', title: 'Mon compte' },
      { id: 'menu_hub', title: 'Retour au menu' },
    ]
  );
}

// ============================================
// CHANGE SECTOR (depuis Mon compte)
// Flow : list 10 secteurs → choix → confirmation reset parcours / continuer
// IDs : chs_<slug>, chs_reset_yes, chs_reset_no
// ============================================
async function startChangeSector(user) {
  const currentLabel = user.sector ? getSectorLabel(user.sector) : (user.job || null);
  const intro = currentLabel
    ? 'Ton secteur actuel : ' + currentLabel + '.\nQuel secteur veux-tu maintenant ?'
    : 'Quel secteur veux-tu pour ton parcours ?';
  const rows = SECTORS
    .filter(s => s.slug !== user.sector)
    .map(s => ({ id: 'chs_' + s.slug, title: s.label, description: s.description }));
  await whatsapp.sendList(
    user.whatsapp_id,
    intro,
    'Choisir',
    [{ title: 'Secteurs', rows }]
  );
}

async function askResetParcoursAfterSector(user, newSlug) {
  const newLabel = getSectorLabel(newSlug);
  await whatsapp.sendButtons(
    user.whatsapp_id,
    'Nouveau secteur : ' + newLabel + '.\n\nVeux-tu repartir du début du parcours pour ce secteur, ou continuer où tu en es ?',
    [
      { id: 'chs_reset_yes_' + newSlug, title: 'Repartir au début' },
      { id: 'chs_reset_no_' + newSlug, title: 'Continuer où je suis' },
    ]
  );
}

async function applySectorChange(user, newSlug, resetParcours) {
  const updates = {
    sector: newSlug,
    job: getSectorLabel(newSlug),
  };
  if (resetParcours) {
    updates.current_module = 1;
    updates.module_progress = {};
  }
  await userService.updateProfile(user.id, updates);
  const txt = resetParcours
    ? 'Secteur mis à jour. Tu repars du module 1 du parcours adapté à ton nouveau secteur.'
    : 'Secteur mis à jour. Tu continues là où tu en étais ; les prochains modules seront adaptés à ton nouveau secteur.';
  await whatsapp.sendButtons(
    user.whatsapp_id,
    txt,
    [
      { id: 'menu_parcours', title: 'Ma session du jour' },
      { id: 'menu_hub', title: 'Retour au menu' },
    ]
  );
}

async function handleChangeSectorButton(user, id) {
  if (id === 'account_change_sector') {
    await startChangeSector(user);
    return true;
  }
  if (id.startsWith('chs_reset_yes_')) {
    const slug = id.replace('chs_reset_yes_', '');
    if (!isValidSector(slug)) return true;
    await applySectorChange(user, slug, true);
    return true;
  }
  if (id.startsWith('chs_reset_no_')) {
    const slug = id.replace('chs_reset_no_', '');
    if (!isValidSector(slug)) return true;
    await applySectorChange(user, slug, false);
    return true;
  }
  if (id.startsWith('chs_')) {
    const slug = id.replace('chs_', '');
    if (!isValidSector(slug)) return true;
    await askResetParcoursAfterSector(user, slug);
    return true;
  }
  return false;
}

async function handleChangeHourButton(user, buttonId) {
  if (buttonId === 'account_change_hour') {
    await startChangeHour(user);
    return true;
  }
  if (buttonId.startsWith('chh_period_')) {
    const period = buttonId.replace('chh_period_', '');
    await askChangeHourSelection(user, period);
    return true;
  }
  if (buttonId.startsWith('chh_hour_')) {
    const hour = parseInt(buttonId.replace('chh_hour_', ''), 10);
    if (!isNaN(hour)) {
      await askChangeMinuteSelection(user, hour);
    }
    return true;
  }
  if (buttonId.startsWith('chh_min_')) {
    const parts = buttonId.replace('chh_min_', '').split('_');
    const hour = parseInt(parts[0], 10);
    const minute = parseInt(parts[1], 10);
    if (!isNaN(hour) && !isNaN(minute)) {
      await finishChangeHour(user, hour, minute);
    }
    return true;
  }
  return false;
}

module.exports = {
  showMainMenu,
  handleMenuButton,
  handleQuizAnswer,
  replayTodayDaily,
  showHelp,
  startQuiz,
  formatHour,
  handleChangeHourButton,
  handleChangeSectorButton,
};
