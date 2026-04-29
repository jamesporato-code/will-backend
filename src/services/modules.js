// ============================================
// MODULES — lus depuis la DB (table modules + module_sessions)
// Cache en mémoire 5 min, invalidé après modif admin.
// v4 : filtrage par user.sector + user.level via applicable_sectors / applicable_levels
// ============================================

const { query } = require('../db/pool');
const logger = require('../utils/logger');
const { normalizeLevel } = require('./sectors');

let modulesCache = null;
let cacheLoadedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

// Charge tous les modules actifs (sans filtre user). Renvoie aussi les tags
// applicable_sectors / applicable_levels pour permettre un filtrage côté JS.
async function loadModules(force = false) {
  const now = Date.now();
  if (!force && modulesCache && (now - cacheLoadedAt) < CACHE_TTL_MS) {
    return modulesCache;
  }

  try {
    const modsRes = await query(
      `SELECT id, slug, position, name, level, dynamic, active,
              applicable_sectors, applicable_levels
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
        applicableSectors: m.applicable_sectors || null,
        applicableLevels: m.applicable_levels || null,
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

// Filtre les modules pertinents pour un user donné :
// - applicable_sectors NULL/vide = universel
// - sinon le sector du user doit appartenir au tableau
// - applicable_levels NULL/vide = tous niveaux
// - sinon le level du user doit appartenir au tableau
// La position d'origine est conservée pour stabilité du parcours.
function isModuleForUser(mod, sectorSlug, levelSlug) {
  const sectors = mod.applicableSectors;
  const levels = mod.applicableLevels;
  const sectorOk = !sectors || sectors.length === 0 || (sectorSlug && sectors.includes(sectorSlug));
  const levelOk  = !levels  || levels.length  === 0 || (levelSlug && levels.includes(levelSlug));
  return sectorOk && levelOk;
}

async function loadModulesForUser(user, force = false) {
  const all = await loadModules(force);
  const sectorSlug = user?.sector || null;
  const levelSlug = normalizeLevel(user?.level);
  const filtered = all.filter(m => isModuleForUser(m, sectorSlug, levelSlug));
  // Renumérote la position pour le parcours du user (1..N) tout en gardant
  // l'ordre de la position d'origine.
  return filtered.map((m, idx) => ({ ...m, userPosition: idx + 1 }));
}

function clearCache() {
  modulesCache = null;
  cacheLoadedAt = 0;
}

// Module de départ selon le niveau (position dans le parcours filtré pour le user).
// En v4 le filtrage par tags suffit : on retourne toujours la 1ère position.
function getStartModule(_level) {
  return 1;
}

// Trouve le module pertinent pour un user à une position donnée.
// Si la position pointe vers un module qui n'est PAS dans la liste filtrée
// (par ex. l'utilisateur a changé de secteur), on prend le 1er module filtré
// dont la position d'origine est >= currentPos. Sinon le 1er de la liste filtrée.
function findCurrentModule(filtered, currentPos) {
  const exact = filtered.find(m => m.position === currentPos);
  if (exact) return exact;
  const next = filtered.find(m => m.position >= currentPos);
  return next || filtered[0] || null;
}

function findNextModuleAfter(filtered, currentPos) {
  return filtered.find(m => m.position > currentPos) || null;
}

// Session courante d'un user (v4 : filtre par sector + level)
async function getCurrentSession(user) {
  const filtered = await loadModulesForUser(user);
  if (filtered.length === 0) return null;

  const startPos = getStartModule(user.level);
  const currentPos = user.current_module || filtered[0].position;
  const mod = findCurrentModule(filtered, currentPos);
  if (!mod) return { done: true, totalModules: filtered.length };

  const progress = user.module_progress || {};
  const sessionsCompleted = progress[mod.position] || 0;

  if (sessionsCompleted >= mod.sessions) {
    const nextMod = findNextModuleAfter(filtered, mod.position);
    if (!nextMod) return { done: true, totalModules: filtered.length };
    const idx = filtered.findIndex(m => m.position === nextMod.position);
    return {
      module: nextMod,
      sessionIndex: 0,
      topic: nextMod.topics[0] || '',
      progressPercent: 0,
      overallPercent: Math.round((idx / filtered.length) * 100),
      totalModules: filtered.length,
    };
  }

  const idx = filtered.findIndex(m => m.position === mod.position);
  return {
    module: mod,
    sessionIndex: sessionsCompleted,
    topic: mod.topics[sessionsCompleted] || mod.topics[0] || '',
    progressPercent: Math.round((sessionsCompleted / mod.sessions) * 100),
    overallPercent: Math.round(((idx + sessionsCompleted / mod.sessions) / filtered.length) * 100),
    totalModules: filtered.length,
  };
}

// Avancer d'une session (v4 : filtre par sector + level)
async function getNextProgress(user) {
  const filtered = await loadModulesForUser(user);
  if (filtered.length === 0) return { current_module: 1, module_progress: {} };

  const currentPos = user.current_module || filtered[0].position;
  const mod = findCurrentModule(filtered, currentPos);
  if (!mod) {
    return { current_module: currentPos, module_progress: user.module_progress || {} };
  }

  const progress = { ...(user.module_progress || {}) };
  const sessionsCompleted = (progress[mod.position] || 0) + 1;
  progress[mod.position] = sessionsCompleted;

  if (sessionsCompleted >= mod.sessions) {
    const nextMod = findNextModuleAfter(filtered, mod.position);
    if (!nextMod) {
      return { current_module: mod.position, module_progress: progress, parcoursDone: true };
    }
    return { current_module: nextMod.position, module_progress: progress };
  }

  return { current_module: mod.position, module_progress: progress };
}

module.exports = {
  loadModules,
  loadModulesForUser,
  clearCache,
  getStartModule,
  getCurrentSession,
  getNextProgress,
};
