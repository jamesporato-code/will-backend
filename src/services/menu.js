// ============================================
// HUB /menu — navigation 100% boutons
// + Mini-coaching (quiz capture profil sans free-text)
// ============================================

const whatsapp = require('./whatsapp');
const userService = require('./userService');
const logger = require('../utils/logger');
const { query } = require('../db/pool');
const { getCachedResponse } = require('./redis');

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
    { id: 'menu_today', title: 'Revoir le message du jour', description: 'Relire ton dernier daily' },
    { id: 'menu_parcours', title: 'Ma session du jour', description: 'Module 1 — Introduction' },
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

module.exports = {
  showMainMenu,
  handleMenuButton,
  handleQuizAnswer,
  replayTodayDaily,
  showHelp,
  startQuiz,
};
