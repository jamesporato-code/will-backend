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
        sector = NULL,
        interests = NULL,
        daily_opt_in = NULL,
        preferred_hour = NULL,
        preferred_minute = 0,
        ia_frequency = NULL,
        ia_goal = NULL,
        ia_time_budget = NULL,
        menu_quiz_step = 0,
        free_text_context = NULL,
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
// POST /api/admin/reset-all-users?confirm=yes - Reset onboarding de TOUS les users
// Destructif : remet tout le monde à zéro (onboarding, parcours, plan trial).
// Usage : refonte v4, restart prop. Nécessite ?confirm=yes pour éviter accidents.
// ============================================
router.post('/reset-all-users', adminAuth, async (req, res) => {
  try {
    if (req.query.confirm !== 'yes') {
      return res.status(400).json({
        error: 'Confirmation requise. Ajoute ?confirm=yes a l\'URL.',
      });
    }

    const countBefore = await query('SELECT COUNT(*)::int AS n FROM users');
    const totalUsers = countBefore.rows[0]?.n || 0;

    const result = await query(`
      UPDATE users SET
        onboarding_step = 0,
        onboarding_complete = false,
        level = NULL,
        job = NULL,
        sector = NULL,
        interests = NULL,
        daily_opt_in = NULL,
        preferred_hour = NULL,
        preferred_minute = 0,
        ia_frequency = NULL,
        ia_goal = NULL,
        ia_time_budget = NULL,
        menu_quiz_step = 0,
        free_text_context = NULL,
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
    `);

    logger.warn('ALL USERS RESET by admin', { totalUsers, affected: result.rowCount });

    res.json({
      success: true,
      message: 'Tous les utilisateurs ont ete reinitialises',
      totalUsers,
      affected: result.rowCount,
    });
  } catch (err) {
    logger.error('Admin reset-all-users error', { error: err.message });
    res.status(500).json({ error: 'Erreur serveur', detail: err.message });
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
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS free_text_context TEXT",
      // v4 : taxonomie secteurs + tags modules
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS sector TEXT",
      "ALTER TABLE modules ADD COLUMN IF NOT EXISTS applicable_sectors TEXT[]",
      "ALTER TABLE modules ADD COLUMN IF NOT EXISTS applicable_levels TEXT[]",
      // Template WhatsApp hors fenetre 24h
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS last_user_message_at TIMESTAMP",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_daily BOOLEAN DEFAULT false",
      // Cron tourne par quarts d'heure → snap preferred_minute aux slots 0/15/30/45.
      // Sans ça les users qui ont tape "9h05" en onboarding ne recoivent jamais leur daily.
      `UPDATE users
        SET preferred_hour   = (preferred_hour + CASE WHEN preferred_minute >= 53 THEN 1 ELSE 0 END) % 24,
            preferred_minute = CASE
              WHEN preferred_minute < 8  THEN 0
              WHEN preferred_minute < 23 THEN 15
              WHEN preferred_minute < 38 THEN 30
              WHEN preferred_minute < 53 THEN 45
              ELSE 0
            END
        WHERE preferred_minute IS NOT NULL AND preferred_minute % 15 <> 0`,
      // Normalisation level : drop 'advanced' (n'existe plus en v4)
      "UPDATE users SET level = 'intermediate' WHERE level = 'advanced'",
      "UPDATE modules SET level = 'intermediate' WHERE level = 'advanced'",
      // v4 : migration users.level FR -> EN (l'onboarding stockait en FR avant)
      "UPDATE users SET level = 'beginner'     WHERE level = 'debutant'",
      "UPDATE users SET level = 'intermediate' WHERE level IN ('intermediaire', 'avance')",
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
      `CREATE TABLE IF NOT EXISTS tool_cards (
        id SERIAL PRIMARY KEY,
        slug TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        category TEXT,
        description TEXT,
        url TEXT,
        why_it_matters TEXT,
        how_to_use TEXT,
        target_level TEXT,
        target_jobs JSONB DEFAULT '[]'::jsonb,
        active BOOLEAN DEFAULT true,
        position INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )`,
      `CREATE TABLE IF NOT EXISTS prompt_cards (
        id SERIAL PRIMARY KEY,
        slug TEXT UNIQUE NOT NULL,
        title TEXT NOT NULL,
        category TEXT,
        use_case TEXT,
        prompt_template TEXT NOT NULL,
        example_output TEXT,
        target_level TEXT,
        target_jobs JSONB DEFAULT '[]'::jsonb,
        active BOOLEAN DEFAULT true,
        position INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )`,
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
    // v4 : applique les tags par défaut aux modules déjà créés (idempotent)
    const tagsResult = await applyDefaultModuleTags();
    const seedToolsResult = await seedToolCardsIfEmpty();
    const seedPromptsResult = await seedPromptCardsIfEmpty();
    logger.info('DB migration run by admin', {
      results, seed: seedResult, tags: tagsResult, seedTools: seedToolsResult, seedPrompts: seedPromptsResult
    });
    res.json({
      success: true, results,
      seed: seedResult,
      tags: tagsResult,
      seedTools: seedToolsResult,
      seedPrompts: seedPromptsResult,
    });
  } catch (err) {
    logger.error('Admin migrate error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// SEED des modules par défaut (v4 — taggués sectors + levels)
// applicable_sectors : null = universel
// applicable_levels  : null = tous niveaux (beginner+intermediate)
// ============================================
const DEFAULT_MODULES = [
  { slug: 'intro-ia', position: 1, name: "Introduction à l'IA", level: 'beginner', dynamic: false,
    applicable_sectors: null, applicable_levels: ['beginner'], sessions: [
    "Qu'est-ce que l'IA ? Les bases en 3 minutes",
    "LLMs : comment marchent ChatGPT, Claude, Gemini",
    "Les types d'IA : générative, prédictive, conversationnelle",
    "Ce que l'IA sait faire (et ne sait PAS faire)",
    "Récap module + défi pratique",
  ]},
  { slug: 'chatgpt-claude', position: 2, name: "ChatGPT & Claude — prise en main", level: 'beginner', dynamic: false,
    applicable_sectors: null, applicable_levels: ['beginner'], sessions: [
    "Créer son compte et première conversation",
    "Les bons réflexes : contexte, format, contraintes",
    "ChatGPT vs Claude : forces et faiblesses",
    "Exercice : rédiger un email pro avec l'IA",
    "Récap module + défi pratique",
  ]},
  { slug: 'prompt-engineering', position: 3, name: "Prompt Engineering", level: 'beginner', dynamic: false,
    applicable_sectors: null, applicable_levels: ['beginner', 'intermediate'], sessions: [
    "La structure d'un bon prompt : Rôle + Contexte + Tâche + Format",
    "Le role playing : transformer l'IA en expert",
    "Le chain-of-thought : faire raisonner l'IA étape par étape",
    "Le few-shot : donner des exemples pour guider",
    "Le méga-prompt : structurer des demandes complexes",
    "Exercice : optimiser 3 prompts réels",
    "Récap module + défi pratique",
  ]},
  { slug: 'productivite', position: 4, name: "IA pour la productivité", level: 'intermediate', dynamic: false,
    applicable_sectors: null, applicable_levels: ['beginner', 'intermediate'], sessions: [
    "Emails et communication : gagner 1h par jour",
    "Rapports et analyses : synthèse automatique",
    "Brainstorming et créativité : 10 idées en 2 min",
    "Organisation : IA + Notion, Obsidian, calendrier",
    "Récap module + défi pratique",
  ]},
  { slug: 'domaine-1', position: 5, name: "IA dans ton domaine #1", level: 'intermediate', dynamic: true,
    applicable_sectors: null, applicable_levels: ['beginner', 'intermediate'], sessions: [
    "Les cas d'usage IA les plus impactants dans ton secteur",
    "Prompt spécialisé #1 pour ton métier",
    "Prompt spécialisé #2 pour ton métier",
    "Automatiser une tâche répétitive de ton quotidien",
    "Cas pratique complet : workflow IA de A à Z",
    "Les outils IA spécifiques à ton domaine",
    "Récap module + défi pratique",
  ]},
  { slug: 'domaine-2', position: 6, name: "IA dans ton domaine #2", level: 'intermediate', dynamic: true,
    applicable_sectors: null, applicable_levels: ['intermediate'], sessions: [
    "Exploration de ton 2e domaine avec l'IA",
    "Prompt spécialisé #1 pour ce domaine",
    "Prompt spécialisé #2 pour ce domaine",
    "Croiser tes 2 domaines avec l'IA",
    "Cas pratique : projet multi-domaines",
    "Outils IA spécifiques",
    "Récap module + défi pratique",
  ]},
  { slug: 'outils-ia', position: 7, name: "Les meilleurs outils IA", level: 'intermediate', dynamic: false,
    applicable_sectors: null, applicable_levels: ['beginner', 'intermediate'], sessions: [
    "Outils texte : Claude, ChatGPT, Perplexity, Mistral",
    "Outils image : Midjourney, DALL-E, Flux, Ideogram",
    "Outils vidéo et audio : Runway, Suno, ElevenLabs",
    "Outils productivité : Gamma, Notion AI, Granola",
    "Récap module + ta boîte à outils personnalisée",
  ]},
  { slug: 'automatisation', position: 8, name: "Automatisation — Zapier, Make, n8n", level: 'intermediate', dynamic: false,
    applicable_sectors: null, applicable_levels: ['intermediate'], sessions: [
    "C'est quoi l'automatisation ? No-code vs low-code",
    "Zapier : ton premier workflow en 10 min",
    "Make (Integromat) : workflows visuels avancés",
    "n8n : l'alternative open source",
    "Connecter l'IA à tes outils du quotidien",
    "Cas pratique : automatiser un process complet",
    "Récap module + défi pratique",
  ]},
  { slug: 'agents-ia', position: 9, name: "IA Agents & workflows complexes", level: 'intermediate', dynamic: false,
    applicable_sectors: null, applicable_levels: ['intermediate'], sessions: [
    "Qu'est-ce qu'un agent IA ? Autonomie vs contrôle",
    "GPTs personnalisés et Claude Projects",
    "MCP : connecter Claude à tes outils",
    "Construire un agent avec des instructions système",
    "Multi-agents : orchestrer plusieurs IA",
    "Cas pratique : ton assistant IA personnel",
    "Récap module + défi pratique",
  ]},
  { slug: 'domaine-3', position: 10, name: "IA dans ton domaine #3", level: 'intermediate', dynamic: true,
    applicable_sectors: null, applicable_levels: ['intermediate'], sessions: [
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
        `INSERT INTO modules (slug, position, name, level, dynamic, active, applicable_sectors, applicable_levels)
         VALUES ($1, $2, $3, $4, $5, true, $6, $7)
         RETURNING id`,
        [m.slug, m.position, m.name, m.level, m.dynamic, m.applicable_sectors, m.applicable_levels]
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

// v4 : applique les tags par défaut (applicable_sectors/applicable_levels)
// aux modules existants dont les tags sont NULL.
// Ne touche pas un module dont les tags ont déjà été définis manuellement.
async function applyDefaultModuleTags() {
  try {
    let updated = 0;
    for (const m of DEFAULT_MODULES) {
      const r = await query(
        `UPDATE modules
         SET applicable_sectors = COALESCE(applicable_sectors, $2),
             applicable_levels  = COALESCE(applicable_levels,  $3),
             level = $4
         WHERE slug = $1
         RETURNING id`,
        [m.slug, m.applicable_sectors, m.applicable_levels, m.level]
      );
      if (r.rowCount > 0) updated++;
    }
    return { ok: true, updated };
  } catch (err) {
    logger.error('Erreur applyDefaultModuleTags', { error: err.message });
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
// SEED des fiches Outils par défaut
// ============================================
const DEFAULT_TOOL_CARDS = [
  {
    slug: 'chatgpt', name: 'ChatGPT', category: 'Généraliste',
    description: "L'assistant IA grand public d'OpenAI. Excellente compréhension générale, intégration vocale et image, écosystème de GPTs personnalisés.",
    url: 'https://chat.openai.com',
    why_it_matters: "C'est l'IA la plus connue, donc parfaite pour démarrer. Plus de 200M d'utilisateurs : la qualité du modèle et l'écosystème (vision, voix, GPTs, code) en font un outil polyvalent du quotidien.",
    how_to_use: "1. Crée un compte gratuit sur chat.openai.com\n2. Active le mode vocal pour des conversations naturelles\n3. Explore les GPTs spécialisés dans le store",
    target_level: 'beginner',
  },
  {
    slug: 'claude', name: 'Claude', category: 'Analyse & rédaction',
    description: "L'IA d'Anthropic, particulièrement forte sur l'analyse de longs documents, le raisonnement nuancé et la rédaction de qualité.",
    url: 'https://claude.ai',
    why_it_matters: "Claude excelle là où ChatGPT s'essouffle : documents de 100+ pages, raisonnement multi-étapes, écriture qui ne sonne pas robotique. Indispensable pour quiconque travaille avec du texte long.",
    how_to_use: "1. Inscris-toi sur claude.ai (gratuit)\n2. Drop un PDF complet ou colle un long texte → demande-lui un résumé structuré\n3. Utilise Claude Projects pour donner du contexte permanent à tes conversations",
    target_level: 'beginner',
  },
  {
    slug: 'perplexity', name: 'Perplexity', category: 'Recherche web',
    description: "Le moteur de recherche augmenté à l'IA. Cite ses sources, explore le web en temps réel, parfait pour la veille et le fact-checking.",
    url: 'https://perplexity.ai',
    why_it_matters: "Là où ChatGPT et Claude inventent parfois, Perplexity cite. Idéal pour de la recherche pro où tu dois pouvoir vérifier l'info ou la citer dans un rapport.",
    how_to_use: "1. Pose ta question directement, comme à Google\n2. Active le mode \"Pro\" pour des recherches plus profondes\n3. Clique sur les sources citées pour les vérifier",
    target_level: 'beginner',
  },
  {
    slug: 'mistral-le-chat', name: 'Mistral Le Chat', category: 'Alternative française',
    description: "Le ChatGPT français. Mistral propose un assistant IA souverain, gratuit, avec exécution de code et génération d'images intégrées.",
    url: 'https://chat.mistral.ai',
    why_it_matters: "Souveraineté des données, hébergement européen, modèle open-weight de qualité. Pour qui veut éviter d'envoyer ses données aux US tout en gardant un outil compétitif.",
    how_to_use: "1. Compte gratuit sur chat.mistral.ai\n2. Active le mode \"Flash Answers\" pour des réponses ultra-rapides\n3. Utilise le canvas pour itérer sur du code ou des docs",
    target_level: 'beginner',
  },
  {
    slug: 'midjourney', name: 'Midjourney', category: 'Image',
    description: "Le générateur d'images IA de référence pour la qualité artistique. Disponible sur Discord et sur le web depuis 2024.",
    url: 'https://midjourney.com',
    why_it_matters: "Quand DALL-E sort des images correctes, Midjourney sort des images dignes d'agences. Le rendu, la lumière, le sens artistique sont au-dessus du marché.",
    how_to_use: "1. Abonnement payant (10 USD/mois minimum)\n2. Décris ta scène avec style, lumière, lentille (--ar 16:9 --v 6)\n3. Itère avec les variantes V1-V4 ou utilise --vary pour explorer",
    target_level: 'intermediate',
  },
  {
    slug: 'elevenlabs', name: 'ElevenLabs', category: 'Voix',
    description: "Voix IA hyper-réalistes, multilingues, avec clonage de voix possible. Utilisé pour le doublage, les podcasts, la lecture audio.",
    url: 'https://elevenlabs.io',
    why_it_matters: "La meilleure synthèse vocale du marché, à des années-lumière des voix robotiques d'avant. Ouvre des cas d'usage : audiobooks personnels, version audio de tes articles, doublage de vidéos.",
    how_to_use: "1. Compte gratuit (10 min/mois) sur elevenlabs.io\n2. Choisis une voix dans la bibliothèque ou clone la tienne\n3. Colle ton texte, ajuste la stabilité et le style, génère l'audio",
    target_level: 'intermediate',
  },
  {
    slug: 'gamma', name: 'Gamma', category: 'Présentations',
    description: "Génère des présentations complètes (slides, design, contenu) à partir d'un simple prompt ou d'un texte existant.",
    url: 'https://gamma.app',
    why_it_matters: "Tu décris ton sujet en 2 lignes, tu obtiens une présentation propre en 30 secondes. Énorme gain de temps pour qui pitche, forme ou présente régulièrement.",
    how_to_use: "1. Compte gratuit (400 crédits) sur gamma.app\n2. Choisis \"Generate\" puis décris le contenu et le ton souhaité\n3. Édite slide par slide, exporte en PDF ou PPT",
    target_level: 'beginner',
  },
  {
    slug: 'notion-ai', name: 'Notion AI', category: 'Productivité',
    description: "L'IA intégrée directement dans Notion. Résume, traduit, écrit et structure tes notes sans quitter ton workspace.",
    url: 'https://notion.so',
    why_it_matters: "Si tu vis déjà dans Notion, Notion AI t'évite le copier-coller permanent vers ChatGPT. L'IA voit ton contexte (pages, bases de données) et travaille directement dans tes docs.",
    how_to_use: "1. Active Notion AI (10 USD/mois après essai)\n2. Tape /ai dans n'importe quelle page pour invoquer l'IA\n3. Utilise Q&A pour interroger toute ta base Notion",
    target_level: 'intermediate',
  },
  {
    slug: 'granola', name: 'Granola', category: 'Réunions',
    description: "Le note-taker de réunions qui écoute, transcrit et structure tes meetings sans bot intrusif dans l'appel.",
    url: 'https://granola.ai',
    why_it_matters: "Pas de bot \"Granola is recording\" qui flippe tes interlocuteurs. L'app capte l'audio en local, et te ressort un compte-rendu structuré (décisions, action items, suivi).",
    how_to_use: "1. Télécharge Granola pour Mac (Windows en cours)\n2. Lance l'enregistrement avant ton meeting (en local)\n3. Récupère le compte-rendu structuré et envoie aux participants",
    target_level: 'intermediate',
  },
  {
    slug: 'zapier', name: 'Zapier', category: 'Automatisation',
    description: "L'outil n°1 pour connecter tes apps entre elles sans une ligne de code. 7000+ intégrations disponibles.",
    url: 'https://zapier.com',
    why_it_matters: "L'IA seule ne change pas ton workflow. Zapier fait la liaison : un email arrive → l'IA résume → ça atterrit dans Notion. C'est le glue qui transforme l'IA en automatisation utile.",
    how_to_use: "1. Compte gratuit (100 tasks/mois) sur zapier.com\n2. Crée un \"Zap\" : trigger (ex: nouvel email) + action (ex: envoyer à ChatGPT)\n3. Branche la sortie ChatGPT sur ta destination (Slack, Notion, etc.)",
    target_level: 'advanced',
  },
];

async function seedToolCardsIfEmpty() {
  try {
    const countRes = await query('SELECT COUNT(*)::int AS n FROM tool_cards');
    const n = countRes.rows[0]?.n || 0;
    if (n > 0) return { skipped: true, existing: n };
    let inserted = 0;
    for (let i = 0; i < DEFAULT_TOOL_CARDS.length; i++) {
      const t = DEFAULT_TOOL_CARDS[i];
      await query(
        `INSERT INTO tool_cards (slug, name, category, description, url, why_it_matters, how_to_use, target_level, target_jobs, active, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, $10)`,
        [t.slug, t.name, t.category || null, t.description || null, t.url || null,
         t.why_it_matters || null, t.how_to_use || null, t.target_level || null,
         JSON.stringify(t.target_jobs || []), i]
      );
      inserted++;
    }
    return { seeded: true, count: inserted };
  } catch (err) {
    logger.error('Erreur seedToolCardsIfEmpty', { error: err.message });
    return { error: err.message };
  }
}

// ============================================
// SEED des fiches Prompts par défaut
// ============================================
const DEFAULT_PROMPT_CARDS = [
  {
    slug: 'brainstorm-structure', title: "Brainstorm structuré", category: 'Idéation',
    use_case: "Quand tu cherches des idées sur un sujet et tu veux éviter les listes plates et ennuyeuses.",
    prompt_template: `Tu es un facilitateur de brainstorming senior. Ton job : générer 10 idées sur le sujet "[SUJET]" en suivant cette structure :

1. 3 idées "consensus" (faciles, attendues)
2. 4 idées "intéressantes" (plus créatives mais réalisables)
3. 2 idées "audacieuses" (qui sortent du cadre)
4. 1 idée "absurde" (volontairement provocante)

Pour chaque idée : 1 ligne de titre + 2 lignes de description + le risque principal.

Sujet : [SUJET]
Contexte : [CONTEXTE]
Contrainte clé : [CONTRAINTE]`,
    example_output: "Idée 1 (consensus) : Lancer une newsletter hebdo. Description : ... Risque : ...",
    target_level: 'beginner',
  },
  {
    slug: 'resume-executif', title: "Résumé exécutif (1 page)", category: 'Rédaction',
    use_case: "Pour transformer un long document (rapport, étude, contrat) en synthèse lisible en 2 minutes.",
    prompt_template: `Tu es un consultant senior qui rédige des résumés exécutifs pour des dirigeants pressés. Tu lis le document suivant et tu produis :

1. **Le verdict** (1 phrase) — l'essentiel à retenir
2. **3 points-clés** (3 puces, 1 ligne chacune)
3. **Les chiffres importants** (3 max, contextualisés)
4. **Les risques / angles morts** (2 max)
5. **La recommandation** (1 phrase actionnable)

Total : 200 mots max. Pas de jargon, pas de "il convient de noter".

Document à résumer :
"""
[TEXTE DU DOCUMENT]
"""`,
    example_output: "Le verdict : Le marché européen progresse de 8 % en 2025... 3 points-clés : ... Recommandation : Investir dans le segment B2B avant Q3.",
    target_level: 'beginner',
  },
  {
    slug: 'fiche-client', title: "Fiche client en 2 minutes", category: 'Commercial',
    use_case: "Avant un rendez-vous client, tu veux une synthèse propre sur l'entreprise + des angles d'accroche.",
    prompt_template: `Tu es un préparateur de RDV commerciaux. À partir des infos publiques, je veux une fiche prête à imprimer pour le RDV avec [NOM ENTREPRISE].

Structure :
1. **Identité** : secteur, taille (CA, effectif si dispo), année, dirigeants
2. **Positionnement** : ce qui les différencie en 1 phrase
3. **Actu récente** (3 derniers mois) : 2-3 faits saillants
4. **Enjeux probables** : 3 sujets qui les concernent vu leur secteur/taille
5. **Angles d'accroche** : 3 phrases d'ouverture personnalisées pour le RDV
6. **Pièges à éviter** : 1-2 sujets à manier avec précaution

Si une info n'est pas vérifiable, tu écris "Non vérifié" plutôt que d'inventer.

Entreprise : [NOM]
Mon offre : [OFFRE]
Mon objectif RDV : [OBJECTIF]`,
    example_output: "Identité : SaaS B2B, 80 employés, CA estimé 12M€... Angle 1 : \"J'ai vu que vous avez recruté 3 ingés ML en mars — vous attaquez la prédictif ?\"",
    target_level: 'intermediate',
  },
  {
    slug: 'email-pro-reponse', title: "L'email pro qui obtient une réponse", category: 'Communication',
    use_case: "Pour les emails sortants à enjeu (prospection, demande, relance) — éviter les emails qui finissent ignorés.",
    prompt_template: `Tu es un coach en email pro. Rédige un email court qui maximise le taux de réponse, en suivant ces règles :

- Objet : 6 mots max, intrigant ou bénéfice clair (pas \"Demande de RDV\")
- Bonjour : prénom seul (jamais \"Madame, Monsieur\")
- Phrase 1 : un signal personnalisé (pas \"j'espère que vous allez bien\")
- Phrase 2 : ce que je veux, en 1 phrase
- Phrase 3 : la valeur pour mon destinataire (pas pour moi)
- CTA : 1 question fermée avec 2 options (oui/non, mardi/jeudi)
- Signature : prénom + 1 ligne de qualif max

Total : 80 mots max.

Contexte :
Destinataire : [QUI]
Mon objectif : [QUOI]
Signal personnalisé que j'ai : [SIGNAL]
Valeur pour lui/elle : [VALEUR]`,
    example_output: "Objet : 12 secondes de votre attention\nBonjour Sophie,\nJ'ai vu votre talk au DevoxxFR sur l'observabilité...",
    target_level: 'intermediate',
  },
  {
    slug: 'pitch-idee', title: "Le pitch d'idée 60 secondes", category: 'Communication',
    use_case: "Tu as 1 minute pour vendre une idée à ton boss, à un client, à un investisseur. Tu prépares le pitch propre.",
    prompt_template: `Tu es un coach en pitch. Aide-moi à structurer un pitch de 60 secondes (≈150 mots) pour mon idée.

Structure imposée :
1. **L'accroche** (10s) : le problème en 1 phrase choquante ou contre-intuitive
2. **La promesse** (10s) : ce que mon idée résout, en 1 phrase
3. **La preuve** (15s) : 2 chiffres ou exemples concrets
4. **La différenciation** (10s) : pourquoi c'est nous et pas un autre
5. **L'ask** (15s) : exactement ce que je demande à mon interlocuteur

À éviter : adjectifs vagues (\"innovant\", \"unique\"), jargon, phrases longues.

Mon idée : [IDÉE]
Mon audience : [À QUI]
Ce que je veux qu'ils fassent : [ASK]`,
    example_output: "Accroche : 70 % des PME françaises perdent 4h/semaine sur des tâches IA mal automatisées. Promesse : ...",
    target_level: 'intermediate',
  },
  {
    slug: 'fiche-produit', title: "Fiche produit qui vend", category: 'Marketing',
    use_case: "Pour rédiger une fiche produit (e-commerce, SaaS landing) qui convertit au lieu de juste décrire.",
    prompt_template: `Tu es un copywriter senior spécialisé conversion. Rédige une fiche produit pour [PRODUIT] qui maximise le clic sur le bouton d'achat.

Structure :
1. **Headline** (max 8 mots) : bénéfice n°1, pas la feature
2. **Sous-titre** (max 15 mots) : pour qui + pourquoi maintenant
3. **3 bénéfices clés** : verbe d'action + résultat concret + chiffre si possible
4. **Comment ça marche** : 3 étapes, 1 ligne chacune
5. **Preuve sociale** : 1 témoignage court + 1 chiffre d'usage
6. **Levée d'objection** : la principale crainte du client + ta réponse
7. **CTA principal** : 4 mots max, verbe d'action

Style : phrases courtes, tu parles AU client (\"tu\" / \"vous\"), pas de mots vides.

Produit : [NOM + DESCRIPTION 2 LIGNES]
Cible : [QUI]
Prix : [PRIX]
Différenciateur : [CE QUI NOUS REND UNIQUE]`,
    example_output: "Headline : Lance ton SaaS en 7 jours. Sous-titre : Pour les freelances tech qui veulent...",
    target_level: 'intermediate',
  },
  {
    slug: 'faq-from-text', title: "FAQ générée depuis un texte", category: 'Productivité',
    use_case: "Tu as un long doc (politique RH, conditions, manuel) et tu veux en sortir une FAQ utile pour tes équipes ou clients.",
    prompt_template: `Tu es un rédacteur de FAQ pédagogiques. Lis le document suivant et génère 10 questions-réponses pertinentes.

Règles :
- Les questions sont formulées comme un vrai utilisateur les poserait (pas du jargon)
- Les réponses font 2-4 phrases max
- Ordre : du plus fréquent au plus pointu
- Si une question n'a pas de réponse claire dans le doc, écris \"Non précisé dans le document — à valider en interne\"
- Cite la section du doc en fin de réponse si possible (ex: \"[Section 3.2]\")

Document :
"""
[TEXTE DU DOCUMENT]
"""

Audience cible de la FAQ : [QUI]`,
    example_output: "Q1 : Combien de jours de congés j'ai par an ? R : Tu as 25 jours ouvrés... [Section 4.1]",
    target_level: 'beginner',
  },
  {
    slug: 'plan-formation', title: "Plan de formation personnalisé", category: 'Apprentissage',
    use_case: "Tu veux te former sur un sujet (IA, no-code, langage X) en 30 jours sans tomber dans 100 tutos sans fil rouge.",
    prompt_template: `Tu es un coach en apprentissage. Construis-moi un plan de formation personnalisé sur 30 jours, à raison de 30 min/jour, sur le sujet "[SUJET]".

Structure :
1. **Semaine 1 — Fondations** : 7 sessions, du concept de base aux 3 outils incontournables
2. **Semaine 2 — Pratique guidée** : 7 sessions avec exercices imposés
3. **Semaine 3 — Projet** : 7 sessions pour construire un projet réel défini en jour 15
4. **Semaine 4 — Approfondissement** : 7 sessions pour combler les angles morts + 1 ressource avancée par jour
5. **Jour 30** : auto-évaluation + 3 prochaines étapes

Pour chaque jour : titre de la session (1 ligne) + livrable concret (1 ligne) + 1 ressource externe.

Mon niveau actuel : [NIVEAU]
Mon objectif final : [OBJECTIF MESURABLE]
Mes contraintes : [TEMPS, OUTILS, BUDGET]`,
    example_output: "Jour 1 : Comprendre les LLMs en 30 min. Livrable : Une page Notion avec ta définition. Ressource : ...",
    target_level: 'intermediate',
  },
  {
    slug: 'revue-presse', title: "Revue de presse synthétique", category: 'Veille',
    use_case: "Pour transformer 5-10 articles d'actu en une synthèse propre, structurée par enjeux, sans liste plate.",
    prompt_template: `Tu es un analyste presse senior. Voici plusieurs articles sur le sujet [THÈME]. Produis une revue de presse en suivant cette structure :

1. **Le climat général** (2 phrases) : où en est le sujet cette semaine
2. **3 angles forts** : pour chaque angle, 1 titre + 2 phrases + les sources qui le portent
3. **La controverse** : un point où les sources divergent + qui dit quoi
4. **Le signal faible** : 1 info passée presque inaperçue mais à surveiller
5. **L'angle mort** : 1 question importante qu'aucun article ne traite

Total : 350 mots max. Cite tes sources entre crochets après chaque info ([Le Monde, 14/03], [TechCrunch, 12/03]).

Articles :
"""
[ARTICLES OU LIENS]
"""`,
    example_output: "Climat général : Cette semaine, les régulateurs européens accélèrent... Angle fort 1 : Les amendes IA Act prennent forme [Politico, 13/03]",
    target_level: 'advanced',
  },
  {
    slug: 'compte-rendu-reunion', title: "Compte-rendu de réunion clean", category: 'Productivité',
    use_case: "Tu sors d'une réunion, tu as des notes en vrac (ou une transcription), tu veux un CR exploitable et envoyable.",
    prompt_template: `Tu es l'assistant·e de direction qui rédige les comptes-rendus officiels. Transforme ces notes brutes en un CR pro, en suivant cette structure :

1. **En-tête** : date, durée, participants, objet
2. **Décisions prises** : liste, avec qui décide et la deadline si mentionnée
3. **Actions à mener** : liste, format \"Qui fait Quoi pour Quand\"
4. **Points en suspens** : sujets non tranchés + qui doit les arbitrer
5. **Prochaine étape** : date du prochain point ou jalon

Règles :
- Pas de paraphrase de discussion ("X a dit que..."), uniquement les sorties actionnables
- Si une info manque (ex: deadline), écris \"À préciser\"
- Ton neutre, factuel
- 300 mots max

Notes brutes :
"""
[NOTES OU TRANSCRIPTION]
"""`,
    example_output: "Décisions : Le budget Q2 est validé à 45k€ — décidé par Marc, à confirmer en CODIR du 25/03. Actions : Sophie prépare le brief design pour le 10/04...",
    target_level: 'beginner',
  },
];

async function seedPromptCardsIfEmpty() {
  try {
    const countRes = await query('SELECT COUNT(*)::int AS n FROM prompt_cards');
    const n = countRes.rows[0]?.n || 0;
    if (n > 0) return { skipped: true, existing: n };
    let inserted = 0;
    for (let i = 0; i < DEFAULT_PROMPT_CARDS.length; i++) {
      const p = DEFAULT_PROMPT_CARDS[i];
      await query(
        `INSERT INTO prompt_cards (slug, title, category, use_case, prompt_template, example_output, target_level, target_jobs, active, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9)`,
        [p.slug, p.title, p.category || null, p.use_case || null,
         p.prompt_template, p.example_output || null, p.target_level || null,
         JSON.stringify(p.target_jobs || []), i]
      );
      inserted++;
    }
    return { seeded: true, count: inserted };
  } catch (err) {
    logger.error('Erreur seedPromptCardsIfEmpty', { error: err.message });
    return { error: err.message };
  }
}

// ============================================
// CRUD Tool cards
// ============================================
router.get('/tool-cards', adminAuth, async (req, res) => {
  try {
    const r = await query('SELECT * FROM tool_cards ORDER BY position ASC, id ASC');
    res.json({ tools: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/tool-cards', adminAuth, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.slug || !b.name) return res.status(400).json({ error: 'slug + name requis' });
    const r = await query(
      `INSERT INTO tool_cards (slug, name, category, description, url, why_it_matters, how_to_use, target_level, target_jobs, active, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [b.slug, b.name, b.category || null, b.description || null, b.url || null,
       b.why_it_matters || null, b.how_to_use || null, b.target_level || null,
       JSON.stringify(b.target_jobs || []), b.active !== false, b.position ?? 0]
    );
    require('../services/cards').clearCache();
    res.json({ tool: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/tool-cards/:id', adminAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const allowed = ['slug', 'name', 'category', 'description', 'url', 'why_it_matters', 'how_to_use', 'target_level', 'target_jobs', 'active', 'position'];
    const fields = Object.keys(req.body || {}).filter(k => allowed.includes(k));
    if (fields.length === 0) return res.status(400).json({ error: 'Aucun champ à modifier' });
    const sets = fields.map((f, i) => `${f} = $${i + 2}`);
    const values = fields.map(f => f === 'target_jobs' ? JSON.stringify(req.body[f]) : req.body[f]);
    const sql = `UPDATE tool_cards SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1 RETURNING *`;
    const r = await query(sql, [id, ...values]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Fiche introuvable' });
    require('../services/cards').clearCache();
    res.json({ tool: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// CRUD Prompt cards
// ============================================
router.get('/prompt-cards', adminAuth, async (req, res) => {
  try {
    const r = await query('SELECT * FROM prompt_cards ORDER BY position ASC, id ASC');
    res.json({ prompts: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/prompt-cards', adminAuth, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.slug || !b.title || !b.prompt_template) {
      return res.status(400).json({ error: 'slug + title + prompt_template requis' });
    }
    const r = await query(
      `INSERT INTO prompt_cards (slug, title, category, use_case, prompt_template, example_output, target_level, target_jobs, active, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [b.slug, b.title, b.category || null, b.use_case || null, b.prompt_template,
       b.example_output || null, b.target_level || null,
       JSON.stringify(b.target_jobs || []), b.active !== false, b.position ?? 0]
    );
    require('../services/cards').clearCache();
    res.json({ prompt: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/prompt-cards/:id', adminAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const allowed = ['slug', 'title', 'category', 'use_case', 'prompt_template', 'example_output', 'target_level', 'target_jobs', 'active', 'position'];
    const fields = Object.keys(req.body || {}).filter(k => allowed.includes(k));
    if (fields.length === 0) return res.status(400).json({ error: 'Aucun champ à modifier' });
    const sets = fields.map((f, i) => `${f} = $${i + 2}`);
    const values = fields.map(f => f === 'target_jobs' ? JSON.stringify(req.body[f]) : req.body[f]);
    const sql = `UPDATE prompt_cards SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1 RETURNING *`;
    const r = await query(sql, [id, ...values]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Fiche introuvable' });
    require('../services/cards').clearCache();
    res.json({ prompt: r.rows[0] });
  } catch (err) {
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
