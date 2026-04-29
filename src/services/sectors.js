// ============================================
// SECTEURS & NIVEAUX (v4)
// 10 secteurs figés (limite WhatsApp list = 10 rows)
// 2 niveaux : beginner, intermediate (advanced supprimé)
// ============================================

const SECTORS = [
  { slug: 'freelance',  label: 'Freelance / Consultant',     description: 'Indépendant, prestations' },
  { slug: 'dev',        label: 'Dev / Tech / Produit',       description: 'Développeur, PM, ingénieur' },
  { slug: 'marketing',  label: 'Marketing / Comm',           description: 'Growth, content, SEO, brand' },
  { slug: 'creative',   label: 'Créatif / Design',           description: 'Designer, créateur, contenu' },
  { slug: 'sales',      label: 'Sales / Business Dev',       description: 'Commercial, BD, account' },
  { slug: 'founder',    label: 'Founder / Entrepreneur',     description: 'Startup, projet, side-project' },
  { slug: 'corporate',  label: 'Manager / Corporate',        description: 'Salarié, manager, ops' },
  { slug: 'hr',         label: 'RH / People',                description: 'Recrutement, talent, formation' },
  { slug: 'finance',    label: 'Finance / Légal',            description: 'Compta, contrôle, juridique' },
  { slug: 'student',    label: 'Étudiant / En formation',    description: 'Études, reconversion' },
];

const SECTOR_SLUGS = SECTORS.map(s => s.slug);

function getSectorLabel(slug) {
  if (!slug) return null;
  const s = SECTORS.find(x => x.slug === slug);
  return s ? s.label : null;
}

function isValidSector(slug) {
  return SECTOR_SLUGS.includes(slug);
}

const LEVELS = [
  { slug: 'beginner',     label: 'Débutant',      description: 'Je découvre l\'IA' },
  { slug: 'intermediate', label: 'Intermédiaire', description: 'J\'utilise déjà l\'IA régulièrement' },
];

const LEVEL_SLUGS = LEVELS.map(l => l.slug);

function getLevelLabel(slug) {
  if (!slug) return null;
  const l = LEVELS.find(x => x.slug === slug);
  return l ? l.label : null;
}

function isValidLevel(slug) {
  return LEVEL_SLUGS.includes(slug);
}

// Pour les users existants avec un user.level = 'advanced', on bascule vers 'intermediate'
function normalizeLevel(slug) {
  if (slug === 'advanced' || slug === 'avance') return 'intermediate';
  if (LEVEL_SLUGS.includes(slug)) return slug;
  return 'beginner';
}

module.exports = {
  SECTORS,
  SECTOR_SLUGS,
  getSectorLabel,
  isValidSector,
  LEVELS,
  LEVEL_SLUGS,
  getLevelLabel,
  isValidLevel,
  normalizeLevel,
};
