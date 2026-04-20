// ============================================
// MODULES DU PARCOURS STRUCTURÃ â Will Coach IA
// 10 modules progressifs, 5-7 sessions chacun
// ============================================

const MODULES = [
  {
    id: 1, name: 'Introduction Ã  l\'IA', level: 'beginner', sessions: 5,
    topics: [
      'Qu\'est-ce que l\'IA ? Les bases en 3 minutes',
      'LLMs : comment marchent ChatGPT, Claude, Gemini',
      'Les types d\'IA : gÃ©nÃ©rative, prÃ©dictive, conversationnelle',
      'Ce que l\'IA sait faire (et ne sait PAS faire)',
      'RÃ©cap module + dÃ©fi pratique',
    ],
  },
  {
    id: 2, name: 'ChatGPT & Claude â prise en main', level: 'beginner', sessions: 5,
    topics: [
      'CrÃ©er son compte et premiÃ¨re conversation',
      'Les bons rÃ©flexes : contexte, format, contraintes',
      'ChatGPT vs Claude : forces et faiblesses',
      'Exercice : rÃ©diger un email pro avec l\'IA',
      'RÃ©cap module + dÃ©fi pratique',
    ],
  },
  {
    id: 3, name: 'Prompt Engineering', level: 'beginner+', sessions: 7,
    topics: [
      'La structure d\'un bon prompt : RÃ´le + Contexte + TÃ¢che + Format',
      'Le role playing : transformer l\'IA en expert',
      'Le chain-of-thought : faire raisonner l\'IA Ã©tape par Ã©tape',
      'Le few-shot : donner des exemples pour guider',
      'Le mÃ©ga-prompt : structurer des demandes complexes',
      'Exercice : optimiser 3 prompts rÃ©els',
      'RÃ©cap module + dÃ©fi pratique',
    ],
  },
  {
    id: 4, name: 'IA pour la productivitÃ©', level: 'intermediate', sessions: 5,
    topics: [
      'Emails et communication : gagner 1h par jour',
      'Rapports et analyses : synthÃ¨se automatique',
      'Brainstorming et crÃ©ativitÃ© : 10 idÃ©es en 2 min',
      'Organisation : IA + Notion, Obsidian, calendrier',
      'RÃ©cap module + dÃ©fi pratique',
    ],
  },
  {
    id: 5, name: 'IA dans ton domaine #1', level: 'intermediate', sessions: 7, dynamic: true,
    topics: [
      'Les cas d\'usage IA les plus impactants dans ton secteur',
      'Prompt spÃ©cialisÃ© #1 pour ton mÃ©tier',
      'Prompt spÃ©cialisÃ© #2 pour ton mÃ©tier',
      'Automatiser une tÃ¢che rÃ©pÃ©titive de ton quotidien',
      'Cas pratique complet : workflow IA de A Ã  Z',
      'Les outils IA spÃ©cifiques Ã  ton domaine',
      'RÃ©cap module + dÃ©fi pratique',
    ],
  },
  {
    id: 6, name: 'IA dans ton domaine #2', level: 'intermediate', sessions: 7, dynamic: true,
    topics: [
      'Exploration de ton 2e domaine avec l\'IA',
      'Prompt spÃ©cialisÃ© #1 pour ce domaine',
      'Prompt spÃ©cialisÃ© #2 pour ce domaine',
      'Croiser tes 2 domaines avec l\'IA',
      'Cas pratique : projet multi-domaines',
      'Outils IA spÃ©cifiques',
      'RÃ©cap module + dÃ©fi pratique',
    ],
  },
  {
    id: 7, name: 'Les meilleurs outils IA', level: 'intermediate', sessions: 5,
    topics: [
      'Outils texte : Claude, ChatGPT, Perplexity, Mistral',
      'Outils image : Midjourney, DALL-E, Flux, Ideogram',
      'Outils vidÃ©o et audio : Runway, Suno, ElevenLabs',
      'Outils productivitÃ© : Gamma, Notion AI, Granola',
      'RÃ©cap module + ta boÃ®te Ã  outils personnalisÃ©e',
    ],
  },
  {
    id: 8, name: 'Automatisation â Zapier, Make, n8n', level: 'advanced', sessions: 7,
    topics: [
      'C\'est quoi l\'automatisation ? No-code vs low-code',
      'Zapier : ton premier workflow en 10 min',
      'Make (Integromat) : workflows visuels avancÃ©s',
      'n8n : l\'alternative open source',
      'Connecter l\'IA Ã  tes outils du quotidien',
      'Cas pratique : automatiser un process complet',
      'RÃ©cap module + dÃ©fi pratique',
    ],
  },
  {
    id: 9, name: 'IA Agents & workflows complexes', level: 'advanced', sessions: 7,
    topics: [
      'Qu\'est-ce qu\'un agent IA ? Autonomie vs contrÃ´le',
      'GPTs personnalisÃ©s et Claude Projects',
      'MCP : connecter Claude Ã  tes outils',
      'Construire un agent avec des instructions systÃ¨me',
      'Multi-agents : orchestrer plusieurs IA',
      'Cas pratique : ton assistant IA personnel',
      'RÃ©cap module + dÃ©fi pratique',
    ],
  },
  {
    id: 10, name: 'IA dans ton domaine #3', level: 'advanced', sessions: 7, dynamic: true,
    topics: [
      'Deep dive dans ton 3e domaine',
      'Techniques avancÃ©es de prompt pour ce domaine',
      'Combiner les 3 domaines : ta stack IA complÃ¨te',
      'StratÃ©gie IA pour les 6 prochains mois',
      'Les tendances IA Ã  surveiller dans ton secteur',
      'Projet final : ton workflow IA complet',
      'RÃ©cap parcours complet + certificat Will',
    ],
  },
];

// Retourne le module de dÃ©part selon le niveau
function getStartModule(level) {
  if (level === 'advanced' || level === 'avance') return 3;
  if (level === 'intermediate' || level === 'intermediaire') return 1;
  return 1; // beginner
}

// Retourne la session courante d'un user
function getCurrentSession(user) {
  const moduleId = user.current_module || getStartModule(user.level);
  const mod = MODULES.find(m => m.id === moduleId);
  if (!mod) return null;

  const progress = user.module_progress || {};
  const sessionsCompleted = progress[moduleId] || 0;

  if (sessionsCompleted >= mod.sessions) {
    // Module fini, passer au suivant
    const nextMod = MODULES.find(m => m.id === moduleId + 1);
    if (!nextMod) return { done: true, totalModules: MODULES.length };
    return {
      module: nextMod,
      sessionIndex: 0,
      topic: nextMod.topics[0],
      progressPercent: 0,
      overallPercent: Math.round(((moduleId) / MODULES.length) * 100),
    };
  }

  return {
    module: mod,
    sessionIndex: sessionsCompleted,
    topic: mod.topics[sessionsCompleted] || mod.topics[0],
    progressPercent: Math.round((sessionsCompleted / mod.sessions) * 100),
    overallPercent: Math.round(((moduleId - 1 + sessionsCompleted / mod.sessions) / MODULES.length) * 100),
  };
}

// Avancer d'une session
function getNextProgress(user) {
  const moduleId = user.current_module || getStartModule(user.level);
  const mod = MODULES.find(m => m.id === moduleId);
  if (!mod) return { current_module: 1, module_progress: {} };

  const progress = { ...(user.module_progress || {}) };
  const sessionsCompleted = (progress[moduleId] || 0) + 1;
  progress[moduleId] = sessionsCompleted;

  if (sessionsCompleted >= mod.sessions) {
    // Module terminÃ©, avancer
    const nextId = moduleId + 1;
    if (nextId > MODULES.length) {
      return { current_module: moduleId, module_progress: progress, parcoursDone: true };
    }
    return { current_module: nextId, module_progress: progress };
  }

  return { current_module: moduleId, module_progress: progress };
}

module.exports = { MODULES, getStartModule, getCurrentSession, getNextProgress };
