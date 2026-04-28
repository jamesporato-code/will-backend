// ============================================
// MODULES — lus depuis la DB (table modules + module_sessions)
// Cache en mémoire 5 min, invalidé après modif admin.
// ============================================

const { query } = require('../db/pool');
const logger = require('../utils/logger');

let modulesCache = null;
let cacheLoadedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function loadModules(force = false) {
  const now = Date.now();
  if (!force && modulesCache && (now - cacheLoadedAt) < CACHE_TTL_MS) {
    return modulesCache;
  }

  try {
    const modsRes = await query(
      `SELECT id, slug, position, name, level, dynamic, active
       FROM modules WHERE active = true ORDER BY position ASC`
    );
    const sessRes = await query(
      `SELECT id, module_id, position, topic
       FROM module_sessions WHERE active = true ORDER BY module_id ASC, position ASC`
    );

    const sessByModule = new Map();
    for (const s of sessRes.rows) {
      if (!sessByModule.has(s.module_id)) sessByModule.set(s.module_id, []);
      sessByModule.get(s.module_id).push(s);
    }

    const list = modsRes.rows.map(m => {
      const topics = (sessByModule.get(m.id) || []).map(s => s.topic);
      return {
        id: m.position,
        dbId: m.id,
        slug: m.slug,
        position: m.position,
        name: m.name,
        level: m.level,
        dynamic: !!m.dynamic,
        topics,
        sessions: topics.length,
      };
    });

    modulesCache = list;
    cacheLoadedAt = now;
    return list;
  } catch (err) {
    logger.error('Erreur loadModules', { error: err.message });
    return modulesCache || [];
  }
}

function clearCache() {
  modulesCache = null;
  cacheLoadedAt = 0;
}

// Module de départ selon le niveau (position dans le parcours)
function getStartModule(level) {
  if (level === 'advanced' || level === 'avance') return 3;
  return 1;
}

// Session courante d'un user
async function getCurrentSession(user) {
  const modules = await loadModules();
  if (modules.length === 0) return null;

  const startPos = getStartModule(user.level);
  const currentPos = user.current_module || startPos;
  const mod = modules.find(m => m.position === currentPos);
  if (!mod) return { done: true, totalModules: modules.length };

  const progress = user.module_progress || {};
  const sessionsCompleted = progress[currentPos] || 0;

  if (sessionsCompleted >= mod.sessions) {
    const nextMod = modules.find(m => m.position === currentPos + 1);
    if (!nextMod) return { done: true, totalModules: modules.length };
    return {
      module: nextMod,
      sessionIndex: 0,
      topic: nextMod.topics[0] || '',
      progressPercent: 0,
      overallPercent: Math.round((currentPos / modules.length) * 100),
      totalModules: modules.length,
    };
  }

  return {
    module: mod,
    sessionIndex: sessionsCompleted,
    topic: mod.topics[sessionsCompleted] || mod.topics[0] || '',
    progressPercent: Math.round((sessionsCompleted / mod.sessions) * 100),
    overallPercent: Math.round(((currentPos - 1 + sessionsCompleted / mod.sessions) / modules.length) * 100),
    totalModules: modules.length,
  };
}

// Avancer d'une session
async function getNextProgress(user) {
  const modules = await loadModules();
  if (modules.length === 0) return { current_module: 1, module_progress: {} };

  const startPos = getStartModule(user.level);
  const currentPos = user.current_module || startPos;
  const mod = modules.find(m => m.position === currentPos);
  if (!mod) {
    return { current_module: currentPos, module_progress: user.module_progress || {} };
  }

  const progress = { ...(user.module_progress || {}) };
  const sessionsCompleted = (progress[currentPos] || 0) + 1;
  progress[currentPos] = sessionsCompleted;

  if (sessionsCompleted >= mod.sessions) {
    const nextMod = modules.find(m => m.position === currentPos + 1);
    if (!nextMod) {
      return { current_module: currentPos, module_progress: progress, parcoursDone: true };
    }
    return { current_module: currentPos + 1, module_progress: progress };
  }

  return { current_module: currentPos, module_progress: progress };
}

module.exports = { loadModules, clearCache, getStartModule, getCurrentSession, getNextProgress };
