// ============================================
// FICHES OUTILS & PROMPTS — pré-écrites, en DB
// Rotation déterministe par user × jour (pas de redite immédiate).
// ============================================

const { query } = require('../db/pool');
const logger = require('../utils/logger');

let toolsCache = null;
let promptsCache = null;
let cacheLoadedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function loadCards(force = false) {
  const now = Date.now();
  if (!force && toolsCache && promptsCache && (now - cacheLoadedAt) < CACHE_TTL_MS) {
    return { tools: toolsCache, prompts: promptsCache };
  }
  try {
    const toolsRes = await query(
      `SELECT * FROM tool_cards WHERE active = true ORDER BY position ASC, id ASC`
    );
    const promptsRes = await query(
      `SELECT * FROM prompt_cards WHERE active = true ORDER BY position ASC, id ASC`
    );
    toolsCache = toolsRes.rows;
    promptsCache = promptsRes.rows;
    cacheLoadedAt = now;
    return { tools: toolsCache, prompts: promptsCache };
  } catch (err) {
    logger.error('Erreur loadCards', { error: err.message });
    return { tools: toolsCache || [], prompts: promptsCache || [] };
  }
}

function clearCache() {
  toolsCache = null;
  promptsCache = null;
  cacheLoadedAt = 0;
}

// Rotation déterministe : jour-de-l'année + user.id mod count
function pickDaily(items, user) {
  if (!items || items.length === 0) return null;
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 0);
  const dayOfYear = Math.floor((now - start) / 86400000);
  const seed = (dayOfYear + (user?.id || 0)) % items.length;
  return items[seed];
}

function renderToolCard(card) {
  if (!card) return null;
  const lines = [];
  lines.push('OUTIL DU JOUR — ' + card.name);
  if (card.category) lines.push('Catégorie : ' + card.category);
  lines.push('');
  if (card.description) {
    lines.push(card.description);
    lines.push('');
  }
  if (card.why_it_matters) {
    lines.push('Pourquoi c\'est utile :');
    lines.push(card.why_it_matters);
    lines.push('');
  }
  if (card.how_to_use) {
    lines.push('Comment l\'utiliser :');
    lines.push(card.how_to_use);
    lines.push('');
  }
  if (card.url) {
    lines.push('Lien : ' + card.url);
  }
  return lines.join('\n').trim();
}

function renderPromptCard(card) {
  if (!card) return null;
  const lines = [];
  lines.push('PROMPT DU JOUR — ' + card.title);
  if (card.category) lines.push('Catégorie : ' + card.category);
  lines.push('');
  if (card.use_case) {
    lines.push(card.use_case);
    lines.push('');
  }
  lines.push('--- PROMPT À COPIER ---');
  lines.push(card.prompt_template);
  lines.push('--- FIN DU PROMPT ---');
  if (card.example_output) {
    lines.push('');
    lines.push('Exemple de résultat :');
    lines.push(card.example_output);
  }
  return lines.join('\n').trim();
}

async function getDailyToolText(user) {
  const { tools } = await loadCards();
  const card = pickDaily(tools, user);
  return renderToolCard(card);
}

async function getDailyPromptText(user) {
  const { prompts } = await loadCards();
  const card = pickDaily(prompts, user);
  return renderPromptCard(card);
}

module.exports = {
  loadCards,
  clearCache,
  pickDaily,
  renderToolCard,
  renderPromptCard,
  getDailyToolText,
  getDailyPromptText,
};
