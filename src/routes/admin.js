const express = require('express');
const router = express.Router();
const { query } = require('../db/pool');
const logger = require('../utils/logger');

// Middleware d'authentification admin simple
const adminAuth = (req, res, next) => {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Non autorisé' });
  }
  next();
};

// ============================================
// GET /api/admin/stats - Statistiques globales
// ============================================
router.get('/stats', adminAuth, async (req, res) => {
  try {
    // Utilisateurs par plan
    const planStats = await query(`
      SELECT plan, COUNT(*) as count
      FROM users
      GROUP BY plan
      ORDER BY count DESC
    `);

    // Utilisateurs par niveau
    const levelStats = await query(`
      SELECT level, COUNT(*) as count
      FROM users
      GROUP BY level
      ORDER BY count DESC
    `);

    // Total utilisateurs
    const totalUsers = await query(`SELECT COUNT(*) as total FROM users`);

    // Utilisateurs onboarding complet
    const onboardedUsers = await query(`
      SELECT COUNT(*) as total FROM users WHERE onboarding_complete = true
    `);

    // Nouveaux utilisateurs (7 derniers jours)
    const newUsersWeek = await query(`
      SELECT COUNT(*) as total FROM users
      WHERE created_at >= NOW() - INTERVAL '7 days'
    `);

    // Nouveaux utilisateurs (30 derniers jours)
    const newUsersMonth = await query(`
      SELECT COUNT(*) as total FROM users
      WHERE created_at >= NOW() - INTERVAL '30 days'
    `);

    // Messages totaux
    const totalMessages = await query(`SELECT COUNT(*) as total FROM messages`);

    // Messages aujourd'hui
    const messagesToday = await query(`
      SELECT COUNT(*) as total FROM messages
      WHERE created_at >= CURRENT_DATE
    `);

    // Messages cette semaine
    const messagesWeek = await query(`
      SELECT COUNT(*) as total FROM messages
      WHERE created_at >= NOW() - INTERVAL '7 days'
    `);

    // Inscription par jour (30 derniers jours)
    const signupsByDay = await query(`
      SELECT DATE(created_at) as date, COUNT(*) as count
      FROM users
      WHERE created_at >= NOW() - INTERVAL '30 days'
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `);

    // Messages par jour (14 derniers jours)
    const messagesByDay = await query(`
      SELECT DATE(created_at) as date, COUNT(*) as count
      FROM messages
      WHERE created_at >= NOW() - INTERVAL '14 days'
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `);

    // Taux de conversion trial -> payant
    const paidUsers = await query(`
      SELECT COUNT(*) as total FROM users
      WHERE plan = 'pro'
    `);

    res.json({
      overview: {
        totalUsers: parseInt(totalUsers.rows[0].total),
        onboardedUsers: parseInt(onboardedUsers.rows[0].total),
        newUsersWeek: parseInt(newUsersWeek.rows[0].total),
        newUsersMonth: parseInt(newUsersMonth.rows[0].total),
        totalMessages: parseInt(totalMessages.rows[0].total),
        messagesToday: parseInt(messagesToday.rows[0].total),
        messagesWeek: parseInt(messagesWeek.rows[0].total),
        paidUsers: parseInt(paidUsers.rows[0].total),
        conversionRate: totalUsers.rows[0].total > 0
          ? ((paidUsers.rows[0].total / totalUsers.rows[0].total) * 100).toFixed(1)
          : 0,
      },
      planStats: planStats.rows,
      levelStats: levelStats.rows,
      signupsByDay: signupsByDay.rows,
      messagesByDay: messagesByDay.rows,
    });
  } catch (err) {
    logger.error('Admin stats error', { error: err.message });
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ============================================
// GET /api/admin/users - Liste des utilisateurs
// ============================================
router.get('/users', adminAuth, async (req, res) => {
  try {
    const { plan, level, search, sort, order, limit, offset } = req.query;

    let sql = `
      SELECT u.*,
        (SELECT COUNT(*) FROM messages WHERE user_id = u.id) as message_count,
        (SELECT MAX(created_at) FROM messages WHERE user_id = u.id AND role = 'user') as last_message_at
      FROM users u
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;

    if (plan) {
      sql += ` AND u.plan = $${paramIndex++}`;
      params.push(plan);
    }
    if (level) {
      sql += ` AND u.level = $${paramIndex++}`;
      params.push(level);
    }
    if (search) {
      sql += ` AND (u.display_name ILIKE $${paramIndex} OR u.whatsapp_id ILIKE $${paramIndex} OR u.job ILIKE $${paramIndex})`;
      params.push('%' + search + '%');
      paramIndex++;
    }

    const sortColumn = ['created_at', 'display_name', 'plan', 'level', 'message_count', 'last_message_at'].includes(sort) ? sort : 'created_at';
    const sortOrder = order === 'asc' ? 'ASC' : 'DESC';
    sql += ` ORDER BY ${sortColumn} ${sortOrder}`;

    const lim = Math.min(parseInt(limit) || 50, 200);
    const off = parseInt(offset) || 0;
    sql += ` LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(lim, off);

    const result = await query(sql, params);

    // Count total for pagination
    let countSql = `SELECT COUNT(*) as total FROM users WHERE 1=1`;
    const countParams = [];
    let countIdx = 1;
    if (plan) { countSql += ` AND plan = $${countIdx++}`; countParams.push(plan); }
    if (level) { countSql += ` AND level = $${countIdx++}`; countParams.push(level); }
    if (search) { countSql += ` AND (display_name ILIKE $${countIdx} OR whatsapp_id ILIKE $${countIdx} OR job ILIKE $${countIdx})`; countParams.push('%' + search + '%'); }

    const countResult = await query(countSql, countParams);

    res.json({
      users: result.rows,
      total: parseInt(countResult.rows[0].total),
      limit: lim,
      offset: off,
    });
  } catch (err) {
    logger.error('Admin users error', { error: err.message });
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ============================================
// GET /api/admin/revenue - Revenus Stripe
// ============================================
router.get('/revenue', adminAuth, async (req, res) => {
  try {
    const Stripe = require('stripe');
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

    // Récupérer les abonnements actifs
    const subscriptions = await stripe.subscriptions.list({
      status: 'active',
      limit: 100,
      expand: ['data.customer'],
    });

    let mrr = 0;
    const subDetails = [];

    for (const sub of subscriptions.data) {
      const amount = sub.items.data[0]?.price?.unit_amount || 0;
      const interval = sub.items.data[0]?.price?.recurring?.interval || 'month';
      const monthlyAmount = interval === 'year' ? amount / 12 : amount;
      mrr += monthlyAmount;

      subDetails.push({
        customerId: sub.customer?.id,
        customerEmail: sub.customer?.email,
        customerName: sub.customer?.name,
        plan: sub.items.data[0]?.price?.nickname || sub.items.data[0]?.price?.id,
        amount: amount / 100,
        currency: sub.currency,
        status: sub.status,
        currentPeriodEnd: new Date(sub.current_period_end * 1000),
        created: new Date(sub.created * 1000),
      });
    }

    // Récupérer les paiements récents (30 derniers jours)
    const charges = await stripe.charges.list({
      limit: 50,
      created: { gte: Math.floor(Date.now() / 1000) - 30 * 24 * 60 * 60 },
    });

    const recentPayments = charges.data
      .filter(c => c.status === 'succeeded')
      .map(c => ({
        amount: c.amount / 100,
        currency: c.currency,
        customerEmail: c.billing_details?.email,
        date: new Date(c.created * 1000),
        description: c.description,
      }));

    const totalRevenue30d = recentPayments.reduce((sum, p) => sum + p.amount, 0);

    // Abonnements annulés récemment
    const cancelledSubs = await stripe.subscriptions.list({
      status: 'canceled',
      limit: 20,
    });

    res.json({
      mrr: mrr / 100,
      activeSubscriptions: subscriptions.data.length,
      totalRevenue30d,
      recentPayments,
      subscriptions: subDetails,
      cancelledCount: cancelledSubs.data.length,
      churnRate: subscriptions.data.length > 0
        ? ((cancelledSubs.data.length / (subscriptions.data.length + cancelledSubs.data.length)) * 100).toFixed(1)
        : 0,
    });
  } catch (err) {
    logger.error('Admin revenue error', { error: err.message });
    res.status(500).json({ error: 'Erreur Stripe: ' + err.message });
  }
});

// ============================================
// GET /api/admin/user/:id - Détail utilisateur
// ============================================
router.get('/user/:id', adminAuth, async (req, res) => {
  try {
    const user = await query(`
      SELECT u.*,
        (SELECT COUNT(*) FROM messages WHERE user_id = u.id) as message_count,
        (SELECT COUNT(*) FROM messages WHERE user_id = u.id AND role = 'user') as user_messages,
        (SELECT COUNT(*) FROM messages WHERE user_id = u.id AND role = 'assistant') as bot_messages,
        (SELECT MAX(created_at) FROM messages WHERE user_id = u.id) as last_activity
      FROM users u WHERE u.id = $1
    `, [req.params.id]);

    if (user.rows.length === 0) {
      return res.status(404).json({ error: 'Utilisateur non trouvé' });
    }

    // Derniers messages
    const recentMessages = await query(`
      SELECT role, content, created_at FROM messages
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 20
    `, [req.params.id]);

    // Activité par jour (14 derniers jours)
    const activity = await query(`
      SELECT DATE(created_at) as date, COUNT(*) as count
      FROM messages WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '14 days'
      GROUP BY DATE(created_at) ORDER BY date ASC
    `, [req.params.id]);

    res.json({
      user: user.rows[0],
      recentMessages: recentMessages.rows.reverse(),
      activity: activity.rows,
    });
  } catch (err) {
    logger.error('Admin user detail error', { error: err.message });
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ============================================
// POST /api/admin/reset-user/:id - Reset user onboarding
// ============================================
router.post('/reset-user/:id', adminAuth, async (req, res) => {
  try {
    const userId = req.params.id;
    const user = await query('SELECT id, display_name, whatsapp_id FROM users WHERE id = $1', [userId]);

    if (user.rows.length === 0) {
      return res.status(404).json({ error: 'Utilisateur non trouv\u00e9' });
    }

    // Reset onboarding fields
    await query(`
      UPDATE users SET
        onboarding_step = 0,
        onboarding_complete = false,
        level = NULL,
        job = NULL,
        interests = NULL,
        daily_opt_in = NULL,
        preferred_hour = NULL,
        preferred_minute = 0,
        ia_frequency = NULL,
        ia_goal = NULL,
        ia_time_budget = NULL,
        menu_quiz_step = 0,
        daily_message_count = 0,
        plan = 'trial',
        created_at = NOW(),
        secondary_jobs = NULL,
        ia_interest = NULL,
        ia_interest_other = NULL,
        trial_reminder_sent = false,
        streak = 0,
        current_module = 1,
        module_progress = '{}'::jsonb,
        trial_reminder_j5 = false,
        trial_reminder_j6 = false,
        trial_reminder_j7 = false,
        trial_reminder_j14 = false,
        last_message_date = NULL
      WHERE id = $1
    `, [userId]);

    logger.info('User reset by admin', { userId, name: user.rows[0].display_name });

    res.json({
      success: true,
      message: 'Utilisateur r\u00e9initialis\u00e9',
      user: user.rows[0],
    });
  } catch (err) {
    logger.error('Admin reset user error', { error: err.message });
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ============================================
// POST /api/admin/trigger-daily/:id - Force le daily maintenant (debug)
// Optionnel : ?first=1 pour simuler le 1er daily post-onboarding
// ============================================
router.post('/trigger-daily/:id', adminAuth, async (req, res) => {
  try {
    const { sendDailyForUser } = require('../cron/scheduler');
    const userId = req.params.id;

    const userCheck = await query('SELECT id FROM users WHERE id = $1', [userId]);
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Utilisateur non trouvé' });
    }

    const opts = req.query.first === '1' ? { first: true } : {};
    const result = await sendDailyForUser(userId, opts);

    logger.info('Daily triggered manually by admin', { userId, result });

    if (!result.ok) {
      return res.status(500).json({
        success: false,
        error: result.error,
        userId,
      });
    }

    res.json({
      success: true,
      message: 'Daily envoyé',
      type: result.type,
      day: result.day,
      userId,
    });
  } catch (err) {
    logger.error('Admin trigger-daily error', { error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Erreur serveur: ' + err.message });
  }
});

// ============================================
// POST /api/admin/migrate - Add streak + module columns
// ============================================
router.post('/migrate', adminAuth, async (req, res) => {
  try {
    const statements = [
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS streak INTEGER DEFAULT 0",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS current_module INTEGER DEFAULT 1",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS module_progress JSONB DEFAULT '{}'::jsonb",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_opt_in BOOLEAN DEFAULT true",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_hour INTEGER DEFAULT 8",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_minute INTEGER DEFAULT 0",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS ia_interest TEXT",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS ia_interest_other TEXT",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS secondary_jobs JSONB DEFAULT '[]'::jsonb",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_reminder_sent BOOLEAN DEFAULT false",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_reminder_j5 BOOLEAN DEFAULT false",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_reminder_j6 BOOLEAN DEFAULT false",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_reminder_j7 BOOLEAN DEFAULT false",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_reminder_j14 BOOLEAN DEFAULT false",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS payment_failed_at TIMESTAMP",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS payment_grace_until TIMESTAMP",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS last_message_date TIMESTAMP",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS ia_frequency TEXT",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS ia_goal TEXT",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS ia_time_budget INTEGER",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS menu_quiz_step INTEGER DEFAULT 0",
      "ALTER TABLE users ALTER COLUMN current_module DROP DEFAULT",
      "ALTER TABLE users ALTER COLUMN current_module TYPE INTEGER USING 1",
      "ALTER TABLE users ALTER COLUMN current_module SET DEFAULT 1",
      `CREATE TABLE IF NOT EXISTS modules (
        id SERIAL PRIMARY KEY,
        slug TEXT UNIQUE NOT NULL,
        position INTEGER NOT NULL UNIQUE,
        name TEXT NOT NULL,
        level TEXT NOT NULL DEFAULT 'beginner',
        dynamic BOOLEAN DEFAULT false,
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )`,
      `CREATE TABLE IF NOT EXISTS module_sessions (
        id SERIAL PRIMARY KEY,
        module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        topic TEXT NOT NULL,
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(module_id, position)
      )`,
      "CREATE INDEX IF NOT EXISTS idx_module_sessions_module ON module_sessions(module_id, position)",
    ];
    const results = [];
    for (const sql of statements) {
      try {
        await query(sql);
        results.push({ sql: sql.substring(0, 80), ok: true });
      } catch (err) {
        results.push({ sql: sql.substring(0, 80), ok: false, error: err.message });
      }
    }

    // Seed des modules par défaut si la table est vide
    const seedResult = await seedModulesIfEmpty();
    logger.info('DB migration run by admin', { results, seed: seedResult });
    res.json({ success: true, results, seed: seedResult });
  } catch (err) {
    logger.error('Admin migrate error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// SEED des modules par défaut
// ============================================
const DEFAULT_MODULES = [
  { slug: 'intro-ia', position: 1, name: "Introduction à l'IA", level: 'beginner', dynamic: false, sessions: [
    "Qu'est-ce que l'IA ? Les bases en 3 minutes",
    "LLMs : comment marchent ChatGPT, Claude, Gemini",
    "Les types d'IA : générative, prédictive, conversationnelle",
    "Ce que l'IA sait faire (et ne sait PAS faire)",
    "Récap module + défi pratique",
  ]},
  { slug: 'chatgpt-claude', position: 2, name: "ChatGPT & Claude — prise en main", level: 'beginner', dynamic: false, sessions: [
    "Créer son compte et première conversation",
    "Les bons réflexes : contexte, format, contraintes",
    "ChatGPT vs Claude : forces et faiblesses",
    "Exercice : rédiger un email pro avec l'IA",
    "Récap module + défi pratique",
  ]},
  { slug: 'prompt-engineering', position: 3, name: "Prompt Engineering", level: 'beginner+', dynamic: false, sessions: [
    "La structure d'un bon prompt : Rôle + Contexte + Tâche + Format",
    "Le role playing : transformer l'IA en expert",
    "Le chain-of-thought : faire raisonner l'IA étape par étape",
    "Le few-shot : donner des exemples pour guider",
    "Le méga-prompt : structurer des demandes complexes",
    "Exercice : optimiser 3 prompts réels",
    "Récap module + défi pratique",
  ]},
  { slug: 'productivite', position: 4, name: "IA pour la productivité", level: 'intermediate', dynamic: false, sessions: [
    "Emails et communication : gagner 1h par jour",
    "Rapports et analyses : synthèse automatique",
    "Brainstorming et créativité : 10 idées en 2 min",
    "Organisation : IA + Notion, Obsidian, calendrier",
    "Récap module + défi pratique",
  ]},
  { slug: 'domaine-1', position: 5, name: "IA dans ton domaine #1", level: 'intermediate', dynamic: true, sessions: [
    "Les cas d'usage IA les plus impactants dans ton secteur",
    "Prompt spécialisé #1 pour ton métier",
    "Prompt spécialisé #2 pour ton métier",
    "Automatiser une tâche répétitive de ton quotidien",
    "Cas pratique complet : workflow IA de A à Z",
    "Les outils IA spécifiques à ton domaine",
    "Récap module + défi pratique",
  ]},
  { slug: 'domaine-2', position: 6, name: "IA dans ton domaine #2", level: 'intermediate', dynamic: true, sessions: [
    "Exploration de ton 2e domaine avec l'IA",
    "Prompt spécialisé #1 pour ce domaine",
    "Prompt spécialisé #2 pour ce domaine",
    "Croiser tes 2 domaines avec l'IA",
    "Cas pratique : projet multi-domaines",
    "Outils IA spécifiques",
    "Récap module + défi pratique",
  ]},
  { slug: 'outils-ia', position: 7, name: "Les meilleurs outils IA", level: 'intermediate', dynamic: false, sessions: [
    "Outils texte : Claude, ChatGPT, Perplexity, Mistral",
    "Outils image : Midjourney, DALL-E, Flux, Ideogram",
    "Outils vidéo et audio : Runway, Suno, ElevenLabs",
    "Outils productivité : Gamma, Notion AI, Granola",
    "Récap module + ta boîte à outils personnalisée",
  ]},
  { slug: 'automatisation', position: 8, name: "Automatisation — Zapier, Make, n8n", level: 'advanced', dynamic: false, sessions: [
    "C'est quoi l'automatisation ? No-code vs low-code",
    "Zapier : ton premier workflow en 10 min",
    "Make (Integromat) : workflows visuels avancés",
    "n8n : l'alternative open source",
    "Connecter l'IA à tes outils du quotidien",
    "Cas pratique : automatiser un process complet",
    "Récap module + défi pratique",
  ]},
  { slug: 'agents-ia', position: 9, name: "IA Agents & workflows complexes", level: 'advanced', dynamic: false, sessions: [
    "Qu'est-ce qu'un agent IA ? Autonomie vs contrôle",
    "GPTs personnalisés et Claude Projects",
    "MCP : connecter Claude à tes outils",
    "Construire un agent avec des instructions système",
    "Multi-agents : orchestrer plusieurs IA",
    "Cas pratique : ton assistant IA personnel",
    "Récap module + défi pratique",
  ]},
  { slug: 'domaine-3', position: 10, name: "IA dans ton domaine #3", level: 'advanced', dynamic: true, sessions: [
    "Deep dive dans ton 3e domaine",
    "Techniques avancées de prompt pour ce domaine",
    "Combiner les 3 domaines : ta stack IA complète",
    "Stratégie IA pour les 6 prochains mois",
    "Les tendances IA à surveiller dans ton secteur",
    "Projet final : ton workflow IA complet",
    "Récap parcours + bilan personnel",
  ]},
];

async function seedModulesIfEmpty() {
  try {
    const countRes = await query('SELECT COUNT(*)::int AS n FROM modules');
    const n = countRes.rows[0]?.n || 0;
    if (n > 0) return { skipped: true, existing: n };

    let modulesInserted = 0;
    let sessionsInserted = 0;
    for (const m of DEFAULT_MODULES) {
      const modRes = await query(
        `INSERT INTO modules (slug, position, name, level, dynamic, active)
         VALUES ($1, $2, $3, $4, $5, true)
         RETURNING id`,
        [m.slug, m.position, m.name, m.level, m.dynamic]
      );
      const modId = modRes.rows[0].id;
      modulesInserted++;
      for (let i = 0; i < m.sessions.length; i++) {
        await query(
          `INSERT INTO module_sessions (module_id, position, topic, active)
           VALUES ($1, $2, $3, true)`,
          [modId, i, m.sessions[i]]
        );
        sessionsInserted++;
      }
    }
    return { seeded: true, modules: modulesInserted, sessions: sessionsInserted };
  } catch (err) {
    logger.error('Erreur seedModulesIfEmpty', { error: err.message });
    return { error: err.message };
  }
}

// ============================================
// GET /api/admin/modules — liste tous les modules avec sessions
// ============================================
router.get('/modules', adminAuth, async (req, res) => {
  try {
    const modsRes = await query(
      `SELECT id, slug, position, name, level, dynamic, active, created_at, updated_at
       FROM modules ORDER BY position ASC`
    );
    const sessRes = await query(
      `SELECT id, module_id, position, topic, active
       FROM module_sessions ORDER BY module_id ASC, position ASC`
    );
    const sessByModule = new Map();
    for (const s of sessRes.rows) {
      if (!sessByModule.has(s.module_id)) sessByModule.set(s.module_id, []);
      sessByModule.get(s.module_id).push(s);
    }
    const modules = modsRes.rows.map(m => ({ ...m, sessions: sessByModule.get(m.id) || [] }));
    res.json({ modules });
  } catch (err) {
    logger.error('Admin GET /modules error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// POST /api/admin/modules — créer un module + ses sessions
// Body : { slug, position, name, level, dynamic, sessions: [topic, topic, ...] }
// ============================================
router.post('/modules', adminAuth, async (req, res) => {
  try {
    const { slug, position, name, level, dynamic, sessions } = req.body || {};
    if (!slug || !name || position === undefined || position === null) {
      return res.status(400).json({ error: 'slug, name, position requis' });
    }
    const modRes = await query(
      `INSERT INTO modules (slug, position, name, level, dynamic, active)
       VALUES ($1, $2, $3, $4, $5, true) RETURNING *`,
      [slug, position, name, level || 'beginner', !!dynamic]
    );
    const mod = modRes.rows[0];
    const insertedSessions = [];
    if (Array.isArray(sessions)) {
      for (let i = 0; i < sessions.length; i++) {
        const topic = typeof sessions[i] === 'string' ? sessions[i] : sessions[i]?.topic;
        if (!topic) continue;
        const sRes = await query(
          `INSERT INTO module_sessions (module_id, position, topic, active)
           VALUES ($1, $2, $3, true) RETURNING *`,
          [mod.id, i, topic]
        );
        insertedSessions.push(sRes.rows[0]);
      }
    }
    require('../services/modules').clearCache();
    res.json({ module: mod, sessions: insertedSessions });
  } catch (err) {
    logger.error('Admin POST /modules error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// PUT /api/admin/modules/:id — update module
// ============================================
router.put('/modules/:id', adminAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const allowed = ['slug', 'position', 'name', 'level', 'dynamic', 'active'];
    const fields = Object.keys(req.body || {}).filter(k => allowed.includes(k));
    if (fields.length === 0) return res.status(400).json({ error: 'Aucun champ à modifier' });
    const sets = fields.map((f, i) => `${f} = $${i + 2}`);
    const values = fields.map(f => req.body[f]);
    const sql = `UPDATE modules SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1 RETURNING *`;
    const result = await query(sql, [id, ...values]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Module introuvable' });
    require('../services/modules').clearCache();
    res.json({ module: result.rows[0] });
  } catch (err) {
    logger.error('Admin PUT /modules/:id error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// POST /api/admin/modules/:id/sessions — ajouter une session
// Body : { topic, position? }
// ============================================
router.post('/modules/:id/sessions', adminAuth, async (req, res) => {
  try {
    const moduleId = parseInt(req.params.id, 10);
    const { topic, position } = req.body || {};
    if (!topic) return res.status(400).json({ error: 'topic requis' });
    let pos = position;
    if (pos === undefined || pos === null) {
      const maxRes = await query(
        'SELECT COALESCE(MAX(position), -1) AS max_pos FROM module_sessions WHERE module_id = $1',
        [moduleId]
      );
      pos = (maxRes.rows[0]?.max_pos ?? -1) + 1;
    }
    const result = await query(
      `INSERT INTO module_sessions (module_id, position, topic, active)
       VALUES ($1, $2, $3, true) RETURNING *`,
      [moduleId, pos, topic]
    );
    require('../services/modules').clearCache();
    res.json({ session: result.rows[0] });
  } catch (err) {
    logger.error('Admin POST /modules/:id/sessions error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// PUT /api/admin/sessions/:id — update une session
// ============================================
router.put('/sessions/:id', adminAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const allowed = ['topic', 'position', 'active'];
    const fields = Object.keys(req.body || {}).filter(k => allowed.includes(k));
    if (fields.length === 0) return res.status(400).json({ error: 'Aucun champ à modifier' });
    const sets = fields.map((f, i) => `${f} = $${i + 2}`);
    const values = fields.map(f => req.body[f]);
    const sql = `UPDATE module_sessions SET ${sets.join(', ')} WHERE id = $1 RETURNING *`;
    const result = await query(sql, [id, ...values]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Session introuvable' });
    require('../services/modules').clearCache();
    res.json({ session: result.rows[0] });
  } catch (err) {
    logger.error('Admin PUT /sessions/:id error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// GET /api/admin/trials - Users en trial avec statut d'expiration
// ============================================
router.get('/trials', adminAuth, async (req, res) => {
  try {
    const result = await query(`
      SELECT id, display_name, whatsapp_id, created_at, trial_reminder_sent,
             EXTRACT(DAY FROM (NOW() - created_at))::int as days_since_signup,
             7 - EXTRACT(DAY FROM (NOW() - created_at))::int as days_remaining,
             (SELECT COUNT(*) FROM messages WHERE user_id = users.id) as message_count
      FROM users
      WHERE plan = 'trial' AND onboarding_complete = true
      ORDER BY created_at ASC
    `);
    const trials = result.rows.map(r => ({
      ...r,
      status: r.days_remaining <= 0 ? 'expired' :
              r.days_remaining === 1 ? 'expires_tomorrow' :
              r.days_remaining <= 3 ? 'expires_soon' : 'active'
    }));
    res.json({
      total: trials.length,
      trials,
      summary: {
        active: trials.filter(t => t.status === 'active').length,
        expires_soon: trials.filter(t => t.status === 'expires_soon').length,
        expires_tomorrow: trials.filter(t => t.status === 'expires_tomorrow').length,
        expired: trials.filter(t => t.status === 'expired').length,
      }
    });
  } catch (err) {
    logger.error('Admin trials error', { error: err.message });
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ============================================
// GET /api/admin/payment-issues - Paiements en echec + grace period
// ============================================
router.get('/payment-issues', adminAuth, async (req, res) => {
  try {
    const result = await query(`
      SELECT id, display_name, whatsapp_id, plan, payment_failed_at, payment_grace_until,
             stripe_customer_id,
             CASE
               WHEN payment_grace_until > NOW() THEN 'in_grace_period'
               WHEN payment_grace_until IS NOT NULL AND payment_grace_until < NOW() THEN 'grace_expired'
               WHEN payment_failed_at IS NOT NULL THEN 'payment_failed'
               ELSE 'ok'
             END as status
      FROM users
      WHERE payment_failed_at IS NOT NULL OR plan = 'cancelled'
      ORDER BY COALESCE(payment_failed_at, updated_at) DESC
      LIMIT 100
    `);
    res.json({
      total: result.rows.length,
      users: result.rows,
    });
  } catch (err) {
    logger.error('Admin payment-issues error', { error: err.message });
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
