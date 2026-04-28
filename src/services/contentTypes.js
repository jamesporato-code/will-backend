// ============================================
// 4 TYPES DE CONTENU â Will Coach IA
// Type A : Parcours structurÃ© (tuto interactif)
// Type B : Actu IA quotidienne
// Type C : Outil du jour (Pro)
// Type D : Prompt du jour (Pro, 1x/semaine)
// ============================================

const Anthropic = require('@anthropic-ai/sdk');
const logger = require('../utils/logger');
const { query } = require('../db/pool');
const { getCurrentSession, getNextProgress } = require('./modules');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-haiku-4-5-20251001';

// ============================================
// Recherche web Tavily (shared)
// ============================================
async function webSearch(searchQuery) {
  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: process.env.TAVILY_API_KEY,
        query: searchQuery,
        max_results: 5,
        search_depth: 'basic',
      }),
    });
    if (!response.ok) throw new Error('Tavily ' + response.status);
    const data = await response.json();
    return data.results.map((r, i) => '[' + (i + 1) + '] ' + r.title + '\n' + r.content + '\nSource: ' + r.url).join('\n\n');
  } catch (err) {
    logger.error('Tavily search error', { error: err.message });
    return '';
  }
}

function strip(text) {
  return text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/(?<!\w)\*(.+?)\*(?!\w)/g, '$1')
    .replace(/(?<!\w)_(.+?)_(?!\w)/g, '$1')
    .replace(/^[\-\*]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`(.+?)`/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildUserContext(user) {
  const parts = [];
  if (user.display_name) parts.push('Prenom : ' + user.display_name.split(' ')[0]);
  if (user.level) parts.push('Niveau : ' + user.level);
  if (user.job) parts.push('Domaine principal : ' + user.job);
  const sec = user.secondary_jobs;
  if (sec && Array.isArray(sec) && sec.length > 0) parts.push('Domaines secondaires : ' + sec.join(', '));
  if (user.ia_interest) parts.push('Focus IA : ' + user.ia_interest);
  return parts.join('\n');
}

// ============================================
// TYPE A â Parcours structurÃ©
// ============================================
async function generateParcours(user) {
  const session = await getCurrentSession(user);
  if (!session || session.done) {
    return {
      text: 'Felicitations ! Tu as termine tout le parcours Will ! Tu es maintenant un expert IA. Continue a me poser tes questions au quotidien.',
      done: true,
    };
  }

  const { module: mod, sessionIndex, topic, progressPercent, overallPercent } = session;
  const isDynamic = mod.dynamic;
  const domainContext = isDynamic
    ? 'Ce module est ADAPTE au domaine de l\'utilisateur. Utilise des exemples concrets lies a son metier.'
    : '';

  const prompt = `Tu es Will, coach IA sur WhatsApp. Genere UNE SESSION de parcours structure.

MODULE : ${mod.name} (position ${mod.position})
SESSION : ${sessionIndex + 1}/${mod.sessions}
SUJET : ${topic}
PROGRESSION : ${progressPercent}% du module en cours

PROFIL :
${buildUserContext(user)}

${domainContext}

STRUCTURE OBLIGATOIRE (5 messages en 1) :
1. Accroche courte + rappel progression (ex: "Module ${mod.id} - Session ${sessionIndex + 1}/${mod.sessions} (${overallPercent}%)")
2. La notion principale expliquee simplement (3-5 phrases)
3. Un exemple concret dans le domaine de l'utilisateur
4. Un defi pratique a faire (exercice actionnable)
5. Teaser pour la prochaine session du module

REGLES :
- 150-250 mots total
- Texte brut WhatsApp, pas de markdown
- 3-4 emojis max
- Tutoiement, ton direct et expert
- Commence par la barre de progression`;

  try {
    const response = await anthropic.messages.create({
      model: MODEL, max_tokens: 500, temperature: 0.6,
      system: 'Tu es un expert IA pedagogue. Texte brut uniquement, pas de markdown.',
      messages: [{ role: 'user', content: prompt }],
    });
    const text = strip(response.content.find(b => b.type === 'text')?.text || '');
    const nextProgress = await getNextProgress(user);
    return { text, nextProgress, session };
  } catch (err) {
    logger.error('Erreur generation parcours', { error: err.message, userId: user.id });
    return null;
  }
}

// ============================================
// TYPE B â Actu IA quotidienne
// ============================================
async function generateActuIA(user) {
  let actuData = '';
  if (process.env.TAVILY_API_KEY) {
    actuData = await webSearch('latest AI news today artificial intelligence tools 2026');
  }

  const prompt = `Tu es Will, coach IA sur WhatsApp. Genere le BULLETIN ACTU IA du jour.

PROFIL :
${buildUserContext(user)}

${actuData ? 'ACTUALITES FRAICHES (source web) :\n' + actuData + '\n' : ''}

STRUCTURE OBLIGATOIRE :
1. Titre court du bulletin (ex: "Actu IA du jour")
2. NEWS 1 : titre + 2 phrases d'analyse + "ce que ca change pour toi"
3. NEWS 2 : titre + 2 phrases d'analyse + "ce que ca change pour toi"
4. NEWS 3 : titre + 2 phrases d'analyse + "ce que ca change pour toi"

REGLES :
- 150-200 mots
- Adapte l'angle au domaine de l'utilisateur
- Texte brut WhatsApp, pas de markdown
- 3-4 emojis
- Chaque news doit etre concrete et actionnable`;

  try {
    const response = await anthropic.messages.create({
      model: MODEL, max_tokens: 500, temperature: 0.7,
      system: 'Tu es un journaliste IA expert. Texte brut uniquement.',
      messages: [{ role: 'user', content: prompt }],
    });
    return strip(response.content.find(b => b.type === 'text')?.text || '');
  } catch (err) {
    logger.error('Erreur generation actu IA', { error: err.message });
    return null;
  }
}

// ============================================
// TYPE C â Outil du jour (Pro)
// ============================================
async function generateOutilDuJour(user) {
  // 1) Essayer une fiche pré-écrite depuis la DB (rapide, contrôlé).
  try {
    const cards = require('./cards');
    const text = await cards.getDailyToolText(user);
    if (text) return text;
  } catch (err) {
    logger.error('cards.getDailyToolText error, fallback Claude', { error: err.message });
  }

  // 2) Fallback : génération Claude si la table est vide ou en erreur.
  let toolData = '';
  if (process.env.TAVILY_API_KEY) {
    toolData = await webSearch('best new AI tools 2026 productivity business');
  }

  const prompt = `Tu es Will, coach IA sur WhatsApp. Presente UN OUTIL IA du jour.

PROFIL :
${buildUserContext(user)}

${toolData ? 'OUTILS RECENTS (source web) :\n' + toolData + '\n' : ''}

STRUCTURE OBLIGATOIRE (4 parties en 1 message) :
1. PRESENTATION : nom de l'outil, ce qu'il fait, pourquoi maintenant (2 phrases)
2. CAS D'USAGE : exemple concret dans le domaine de l'utilisateur (3 phrases)
3. LA LIMITE : le point faible principal (honnetete = credibilite) (1-2 phrases)
4. VERDICT : note sur 5 + recommandation + lien si dispo (1-2 phrases)

REGLES :
- Choisis un outil DIFFERENT chaque jour (pas ChatGPT ou Claude, des outils specifiques)
- 120-180 mots
- Texte brut WhatsApp
- 3 emojis max
- Sois honnete sur les limites`;

  try {
    const response = await anthropic.messages.create({
      model: MODEL, max_tokens: 400, temperature: 0.7,
      system: 'Tu es un testeur d\'outils IA expert et honnete. Texte brut uniquement.',
      messages: [{ role: 'user', content: prompt }],
    });
    return strip(response.content.find(b => b.type === 'text')?.text || '');
  } catch (err) {
    logger.error('Erreur generation outil du jour', { error: err.message });
    return null;
  }
}

// ============================================
// TYPE D â Prompt du jour (Pro, 1x/semaine)
// ============================================
async function generatePromptDuJour(user) {
  // 1) Essayer une fiche pré-écrite depuis la DB.
  try {
    const cards = require('./cards');
    const text = await cards.getDailyPromptText(user);
    if (text) return text;
  } catch (err) {
    logger.error('cards.getDailyPromptText error, fallback Claude', { error: err.message });
  }

  // 2) Fallback Claude.
  const prompt = `Tu es Will, coach IA sur WhatsApp. Genere LE PROMPT DU JOUR.

PROFIL :
${buildUserContext(user)}

STRUCTURE OBLIGATOIRE :
1. Intro courte : a quoi sert ce prompt (1 phrase)
2. LE PROMPT complet, pret a copier-coller, avec des [VARIABLES] a remplacer en majuscules
3. EXEMPLE de resultat obtenu avec ce prompt (3-4 phrases)
4. VARIANTE : une adaptation du prompt pour un autre cas d'usage (1-2 phrases)

REGLES :
- Le prompt doit etre DIRECTEMENT utile dans le domaine de l'utilisateur
- 150-200 mots total
- Texte brut WhatsApp
- Le prompt doit fonctionner sur ChatGPT ou Claude
- 2-3 emojis max
- Le prompt doit etre suffisamment complexe pour apporter de la valeur (pas juste "ecris un email")`;

  try {
    const response = await anthropic.messages.create({
      model: MODEL, max_tokens: 500, temperature: 0.7,
      system: 'Tu es un expert en prompt engineering. Texte brut uniquement.',
      messages: [{ role: 'user', content: prompt }],
    });
    return strip(response.content.find(b => b.type === 'text')?.text || '');
  } catch (err) {
    logger.error('Erreur generation prompt du jour', { error: err.message });
    return null;
  }
}

// ============================================
// Recap hebdomadaire (samedi/dimanche)
// ============================================
async function generateRecapHebdo(user) {
  const session = await getCurrentSession(user);
  const overallPercent = session?.overallPercent || 0;
  const moduleName = session?.module?.name || 'Parcours';

  const prompt = `Tu es Will, coach IA. Genere un RECAP HEBDOMADAIRE court.

PROFIL :
${buildUserContext(user)}

STATS :
- Module en cours : ${moduleName}
- Progression globale : ${overallPercent}%
- Streak : ${user.streak || 0} jours

STRUCTURE :
1. Bravo + recap de la semaine (2 phrases)
2. Ce que l'utilisateur a appris (2 phrases)
3. Teaser de la semaine prochaine (1 phrase)
4. Motivation (1 phrase)

REGLES : 80-120 mots, texte brut WhatsApp, 3 emojis, tutoiement`;

  try {
    const response = await anthropic.messages.create({
      model: MODEL, max_tokens: 300, temperature: 0.6,
      system: 'Tu es un coach motivant. Texte brut uniquement.',
      messages: [{ role: 'user', content: prompt }],
    });
    return strip(response.content.find(b => b.type === 'text')?.text || '');
  } catch (err) {
    logger.error('Erreur generation recap', { error: err.message });
    return null;
  }
}

module.exports = {
  generateParcours,
  generateActuIA,
  generateOutilDuJour,
  generatePromptDuJour,
  generateRecapHebdo,
  webSearch,
  strip,
};
