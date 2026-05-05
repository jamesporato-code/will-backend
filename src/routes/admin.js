const express = require('express');
const router = express.Router();
const axios = require('axios');
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

    // ============================================
    // FUNNEL — etapes-cles d'acquisition + activation
    // ============================================
    const funnelToday = await query(`
      SELECT
        COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE)                                        AS signups,
        COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE AND onboarding_complete = true)         AS onboarded,
        COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE AND last_user_message_at >= CURRENT_DATE) AS active,
        COUNT(*) FILTER (WHERE plan = 'pro' AND updated_at >= CURRENT_DATE)                       AS pro_conversions
      FROM users
    `);
    const funnelWeek = await query(`
      SELECT
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')                                  AS signups,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days' AND onboarding_complete = true)   AS onboarded,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days' AND last_user_message_at >= NOW() - INTERVAL '24 hours') AS active,
        COUNT(*) FILTER (WHERE plan = 'pro' AND updated_at >= NOW() - INTERVAL '7 days')                 AS pro_conversions
      FROM users
    `);
    const funnelMonth = await query(`
      SELECT
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')                                  AS signups,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days' AND onboarding_complete = true)   AS onboarded,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days' AND last_user_message_at >= NOW() - INTERVAL '7 days') AS active,
        COUNT(*) FILTER (WHERE plan = 'pro' AND updated_at >= NOW() - INTERVAL '30 days')                 AS pro_conversions
      FROM users
    `);

    // Etat operationnel template / fenetre 24h
    const opsHealth = await query(`
      SELECT
        COUNT(*) FILTER (WHERE pending_action = 'daily')                                              AS pending_daily,
        COUNT(*) FILTER (WHERE pending_action LIKE 'trial_%')                                         AS pending_trial_reminder,
        COUNT(*) FILTER (WHERE plan IN ('trial','pro') AND onboarding_complete = true
                              AND (last_user_message_at IS NULL OR last_user_message_at < NOW() - INTERVAL '24 hours')) AS outside_24h_window,
        COUNT(*) FILTER (WHERE plan = 'trial' AND onboarding_complete = true
                              AND created_at <= NOW() - INTERVAL '7 days')                           AS trial_expired_unconverted
      FROM users
    `);

    const buildFunnel = (row) => {
      const s = parseInt(row.signups || 0);
      const o = parseInt(row.onboarded || 0);
      const a = parseInt(row.active || 0);
      const p = parseInt(row.pro_conversions || 0);
      const pct = (num, den) => (den > 0 ? ((num / den) * 100).toFixed(1) : null);
      return {
        signups: s,
        onboarded: o,
        active: a,
        pro_conversions: p,
        rate_signup_to_onboarded: pct(o, s),
        rate_onboarded_to_active: pct(a, o),
        rate_signup_to_pro: pct(p, s),
      };
    };

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
      funnel: {
        today: buildFunnel(funnelToday.rows[0] || {}),
        week:  buildFunnel(funnelWeek.rows[0] || {}),
        month: buildFunnel(funnelMonth.rows[0] || {}),
      },
      ops: {
        pending_daily:           parseInt(opsHealth.rows[0].pending_daily || 0),
        pending_trial_reminder:  parseInt(opsHealth.rows[0].pending_trial_reminder || 0),
        outside_24h_window:      parseInt(opsHealth.rows[0].outside_24h_window || 0),
        trial_expired_unconverted: parseInt(opsHealth.rows[0].trial_expired_unconverted || 0),
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
        id: sub.id,
        customerId: sub.customer?.id,
        customerEmail: sub.customer?.email,
        customerName: sub.customer?.name,
        plan: sub.items.data[0]?.price?.nickname || sub.items.data[0]?.price?.id,
        amount: amount / 100,
        currency: sub.currency,
        status: sub.status,
        cancelAtPeriodEnd: sub.cancel_at_period_end,
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
        id: c.id,
        amount: c.amount / 100,
        currency: c.currency,
        customerEmail: c.billing_details?.email,
        date: new Date(c.created * 1000),
        description: c.description,
        refunded: c.refunded,
        amount_refunded: c.amount_refunded / 100,
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
// POST /api/admin/wipe-all - DELETE TOTAL : users + messages remis a zero.
// A utiliser uniquement avant les premiers vrais users.
// ============================================
router.post('/wipe-all', adminAuth, async (req, res) => {
  try {
    if (req.query.confirm !== 'yes') {
      return res.status(400).json({
        error: 'Confirmation requise. Ajoute ?confirm=yes a l\'URL.',
      });
    }

    const before = await query(`
      SELECT
        (SELECT COUNT(*)::int FROM users) AS users,
        (SELECT COUNT(*)::int FROM messages) AS messages
    `);

    // Ordre : messages d'abord (FK vers users), puis users.
    await query('DELETE FROM messages');
    await query('DELETE FROM users');
    // Reset des sequences pour repartir a id=1
    await query("SELECT setval('users_id_seq', 1, false)").catch(() => null);
    await query("SELECT setval('messages_id_seq', 1, false)").catch(() => null);

    logger.warn('FULL WIPE by admin', { before: before.rows[0] });
    res.json({
      success: true,
      message: 'Tous les users et messages ont ete supprimes.',
      before: before.rows[0],
    });
  } catch (err) {
    logger.error('Admin wipe-all error', { error: err.message });
    res.status(500).json({ error: 'Erreur serveur', detail: err.message });
  }
});

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
        last_message_date = NULL,
        last_user_message_at = NULL,
        pending_daily = false,
        pending_action = NULL,
        payment_failed_at = NULL,
        payment_grace_until = NULL
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

// POST /api/admin/trigger-actu/:id - force l'envoi de l'actu IA pour un user
router.post('/trigger-actu/:id', adminAuth, async (req, res) => {
  try {
    const { sendActuForUser } = require('../cron/scheduler');
    const userId = req.params.id;
    const userCheck = await query('SELECT id FROM users WHERE id = $1', [userId]);
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Utilisateur non trouvé' });
    }
    const result = await sendActuForUser(userId);
    logger.info('Actu triggered manually by admin', { userId, result });
    if (!result.ok) {
      return res.status(500).json({ success: false, error: result.error, userId });
    }
    res.json({
      success: true,
      message: 'Actu IA envoyée',
      type: result.type,
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
      // pending_action TEXT : 'daily' | 'actu' | 'trial_j5' | 'trial_j6' | 'trial_j7' | 'trial_j14'
      // Remplace pending_daily (qui ne supportait que le daily) par un champ qui
      // sait quoi delivrer quand le user repond au template.
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_action TEXT",
      // Migration : les users avec pending_daily=true heritent de pending_action='daily'
      "UPDATE users SET pending_action = 'daily' WHERE pending_daily = true AND pending_action IS NULL",
      // 2e push journee : actu IA configurable par user (mode + heure)
      // - 'scheduled' (defaut) : actu envoyee a actu_hour/actu_minute
      // - 'bundled'  : actu envoyee juste apres le daily du matin
      // - 'disabled' : pas d'actu push (toujours dispo via /menu)
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS actu_mode TEXT DEFAULT 'scheduled'",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS actu_hour INTEGER DEFAULT 12",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS actu_minute INTEGER DEFAULT 30",
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
  // ============================================
  // Modules transverses (positions 11+) — ajoutes apres le parcours initial.
  // Universels par defaut (applicable_sectors: null), filtres si pertinent.
  // ============================================
  { slug: 'donnees-rgpd', position: 11, name: "IA et donnees : RGPD, anonymisation",
    level: 'beginner', dynamic: false,
    applicable_sectors: null, applicable_levels: ['beginner', 'intermediate'], sessions: [
    "Ce que tu peux et ne peux pas envoyer a l'IA",
    "Anonymiser tes donnees avant de les envoyer",
    "RGPD et IA : les bases pour ne pas te tromper",
    "Choisir un outil IA conforme a tes contraintes pro",
    "Cas pratique : preparer un document pour analyse IA en mode safe",
    "Recap module + check-list de conformite",
  ]},
  { slug: 'redaction', position: 12, name: "Ecrire mieux avec l'IA",
    level: 'beginner', dynamic: false,
    applicable_sectors: null, applicable_levels: ['beginner', 'intermediate'], sessions: [
    "Structure d'un bon texte : intro, corps, chute",
    "Adapter le ton a ton audience",
    "Reecrire un texte existant pour le rendre meilleur",
    "Ecrire pour LinkedIn, mail, slide deck — un format = un style",
    "Detecter et corriger le style 'ChatGPT' (trop generique)",
    "Recap module + ton style a toi",
  ]},
  { slug: 'recherche', position: 13, name: "Recherche augmentee",
    level: 'beginner', dynamic: false,
    applicable_sectors: null, applicable_levels: ['beginner', 'intermediate'], sessions: [
    "Perplexity, ChatGPT search, Gemini : qui sert quoi",
    "Formuler une bonne requete de recherche",
    "Verifier les sources : eviter les hallucinations",
    "Comparer plusieurs sources rapidement",
    "Veille automatisee : recevoir l'info quand elle sort",
    "Recap module + ta routine de recherche",
  ]},
  { slug: 'creativite', position: 14, name: "IA et creativite",
    level: 'intermediate', dynamic: false,
    applicable_sectors: ['marketing', 'creative', 'dev', 'founder'],
    applicable_levels: ['beginner', 'intermediate'], sessions: [
    "Brainstorming structure : divergence puis convergence",
    "Generer 50 idees en 5 minutes (et choisir les bonnes)",
    "Sortir des idees convenues : prompts pour la creativite",
    "Visualiser une idee : DALL-E, Midjourney pour cadrer",
    "Iterer sur une idee jusqu'a la perfection",
    "Recap module + ta methode creative",
  ]},
  { slug: 'decisionnel', position: 15, name: "IA pour decider",
    level: 'intermediate', dynamic: false,
    applicable_sectors: ['founder', 'corporate', 'finance', 'freelance'],
    applicable_levels: ['intermediate'], sessions: [
    "SWOT augmente : forces / faiblesses / opportunites / menaces avec l'IA",
    "Modeliser un dilemme et obtenir des recommandations",
    "Detecter tes biais cognitifs avec un prompt critique",
    "Comparer 3 options avec une matrice de decision IA",
    "Cas pratique : prendre une decision pro complexe",
    "Recap module + ton cadre de decision personnel",
  ]},
  { slug: 'negociation', position: 16, name: "Preparer tes negos avec l'IA",
    level: 'intermediate', dynamic: false,
    applicable_sectors: ['sales', 'founder', 'freelance', 'hr'],
    applicable_levels: ['intermediate'], sessions: [
    "Analyser la position de l'autre partie avec l'IA",
    "Lister tes meilleures et pires options (BATNA)",
    "Preparer 5 contre-arguments avec l'IA",
    "Simuler la nego : l'IA joue l'autre cote",
    "Adapter ton script en temps reel pendant la nego",
    "Recap module + ta playbook nego",
  ]},
  { slug: 'apprentissage', position: 17, name: "Apprendre avec l'IA",
    level: 'beginner', dynamic: false,
    applicable_sectors: null, applicable_levels: ['beginner', 'intermediate'], sessions: [
    "Te faire expliquer un concept selon ton niveau exact",
    "Creer des exercices cibles sur ce que tu rates",
    "Memoriser durablement : la repetition espacee assistee par IA",
    "Apprendre une competence en 30 jours avec l'IA",
    "Cas pratique : maitriser un sujet complexe en 7 jours",
    "Recap module + ton plan d'apprentissage perso",
  ]},
  { slug: 'analyse-data', position: 18, name: "Analyser des donnees avec l'IA",
    level: 'intermediate', dynamic: false,
    applicable_sectors: ['finance', 'dev', 'marketing', 'corporate'],
    applicable_levels: ['intermediate'], sessions: [
    "Excel/CSV : faire parler tes donnees sans formules",
    "Identifier patterns et anomalies dans tes chiffres",
    "Construire un dashboard visuel a partir d'un fichier",
    "Croiser plusieurs fichiers pour repondre a une question business",
    "Cas pratique : analyser le P&L d'une boite",
    "Recap module + ta routine analyse",
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
// POST /api/admin/modules/sync-defaults — pousse les modules DEFAULT_MODULES
// manquants en DB sans toucher aux modules existants. Utile quand on a ajoute
// de nouveaux modules au code source apres un seed initial.
// ============================================
router.post('/modules/sync-defaults', adminAuth, async (req, res) => {
  try {
    const existing = await query('SELECT slug FROM modules');
    const existingSlugs = new Set(existing.rows.map(r => r.slug));
    let modulesAdded = 0;
    let sessionsAdded = 0;
    const added = [];
    for (const m of DEFAULT_MODULES) {
      if (existingSlugs.has(m.slug)) continue;
      const modRes = await query(
        `INSERT INTO modules (slug, position, name, level, dynamic, active, applicable_sectors, applicable_levels)
         VALUES ($1, $2, $3, $4, $5, true, $6, $7)
         RETURNING id`,
        [m.slug, m.position, m.name, m.level, m.dynamic, m.applicable_sectors, m.applicable_levels]
      );
      const modId = modRes.rows[0].id;
      modulesAdded++;
      for (let i = 0; i < m.sessions.length; i++) {
        await query(
          `INSERT INTO module_sessions (module_id, position, topic, active)
           VALUES ($1, $2, $3, true)`,
          [modId, i, m.sessions[i]]
        );
        sessionsAdded++;
      }
      added.push({ slug: m.slug, position: m.position, sessions: m.sessions.length });
    }
    require('../services/modules').clearCache();
    logger.info('Sync DEFAULT_MODULES', { modulesAdded, sessionsAdded });
    res.json({ success: true, modulesAdded, sessionsAdded, added });
  } catch (err) {
    logger.error('Admin sync-defaults error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

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
    target_level: 'intermediate',
    target_jobs: [],
  },
  // === DEV / TECH ===
  {
    slug: 'cursor', name: 'Cursor', category: 'Dev',
    description: "L'IDE forké de VSCode avec une IA Claude/GPT-4 intégrée nativement. Édit ton code par instructions en langage naturel.",
    url: 'https://cursor.com',
    why_it_matters: "Plus d'aller-retour ChatGPT ↔ VSCode. Tu sélectionnes du code, tu écris ce que tu veux, Cursor refactore en place. La référence pour les devs IA-natifs en 2026.",
    how_to_use: "1. Télécharge Cursor (gratuit avec quota)\n2. Cmd+K pour générer du code, Cmd+L pour chatter avec le projet entier\n3. Active 'Composer' pour des refactorings multi-fichiers",
    target_level: 'intermediate',
    target_jobs: ['dev'],
  },
  {
    slug: 'github-copilot', name: 'GitHub Copilot', category: 'Dev',
    description: "L'autocomplétion IA dans ton IDE habituel (VSCode, JetBrains, Neovim). Suggestions inline pendant que tu codes.",
    url: 'https://github.com/features/copilot',
    why_it_matters: "Le standard discret. 10 USD/mois, ça t'autocomplète 30-50% du code que tu allais écrire. ROI évident dès la 1re semaine pour un dev qui produit.",
    how_to_use: "1. Abonnement Copilot via ton compte GitHub\n2. Installe l'extension dans ton IDE\n3. Tape un commentaire descriptif → Tab pour accepter la suggestion",
    target_level: 'beginner',
    target_jobs: ['dev'],
  },
  {
    slug: 'v0', name: 'V0 (Vercel)', category: 'Dev / Design',
    description: "Génère des composants React + Tailwind à partir d'un prompt ou d'une image. Conçu par Vercel, parfait pour prototyper vite.",
    url: 'https://v0.dev',
    why_it_matters: "Tu décris une UI ou tu colles un screenshot Figma, V0 sort le code React directement utilisable. Idéal pour les MVPs et les itérations design rapides.",
    how_to_use: "1. Compte gratuit (avec quota) sur v0.dev\n2. Décris ton UI ou drop une image\n3. Itère via chat, exporte le code ou déploie sur Vercel d'un clic",
    target_level: 'intermediate',
    target_jobs: ['dev', 'creative', 'founder'],
  },
  {
    slug: 'bolt', name: 'Bolt.new', category: 'Dev',
    description: "Crée des applications web full-stack complètes (front + back + DB) depuis un simple prompt. WebContainer dans le navigateur.",
    url: 'https://bolt.new',
    why_it_matters: "Pas besoin d'environnement local. Tu décris ton app, Bolt génère le code, l'exécute en live, te laisse itérer. Magique pour valider une idée en 1h.",
    how_to_use: "1. Va sur bolt.new (compte StackBlitz)\n2. Décris ton app en 2-3 phrases (stack incluse)\n3. Bolt génère + lance ; itère par chat, déploie sur Netlify directement",
    target_level: 'beginner',
    target_jobs: ['dev', 'founder'],
  },
  {
    slug: 'lovable', name: 'Lovable', category: 'Dev / Founder',
    description: "Plateforme française qui transforme une description en app web complète, avec base de données Supabase et auth incluses.",
    url: 'https://lovable.dev',
    why_it_matters: "L'alternative française à Bolt, plus orientée founder non-tech. Couvre auth + DB + déploiement sans configuration. Parfait pour valider une idée business.",
    how_to_use: "1. Compte gratuit sur lovable.dev\n2. Décris ton app en français, Lovable génère\n3. Connecte Supabase auto pour la DB, push sur GitHub d'un clic",
    target_level: 'beginner',
    target_jobs: ['founder', 'dev'],
  },
  // === SALES ===
  {
    slug: 'apollo', name: 'Apollo.io', category: 'Sales',
    description: "Base de données B2B (250M+ contacts) avec outreach automatisé. Le couteau suisse du SDR moderne.",
    url: 'https://apollo.io',
    why_it_matters: "Tu cherches le DPO d'une PME tech à Lyon ? Apollo te le sort + son email + 5 signaux d'achat récents. Plus efficace que LinkedIn Sales Nav pour beaucoup de cas.",
    how_to_use: "1. Compte freemium (50 emails/mois) sur apollo.io\n2. Filtre par persona (titre, secteur, tech stack, taille)\n3. Lance une séquence email + LinkedIn auto",
    target_level: 'intermediate',
    target_jobs: ['sales', 'founder'],
  },
  {
    slug: 'lemlist', name: 'Lemlist', category: 'Sales',
    description: "Plateforme de cold outreach française. Personnalisation à grande échelle (variables custom, images dynamiques, vidéos).",
    url: 'https://lemlist.com',
    why_it_matters: "Le cold email générique a un taux de réponse de 1%. Lemlist + IA permet d'envoyer 100 mails ultra-personnalisés en 1h, avec un taux de 8-15%.",
    how_to_use: "1. Inscris-toi sur lemlist.com (essai 14j)\n2. Importe ta liste prospects + enrichis avec Apollo/Clay\n3. Crée une séquence 5 touchpoints (email + LinkedIn) avec variables IA",
    target_level: 'intermediate',
    target_jobs: ['sales', 'founder'],
  },
  {
    slug: 'clay', name: 'Clay', category: 'Sales / Data',
    description: "Tableur sous stéroïdes pour orchestrer enrichissement, scoring et outreach B2B. Combine 100+ sources de données.",
    url: 'https://clay.com',
    why_it_matters: "Le terrain de jeu des SDRs ops. Tu prends une liste de 1000 leads, tu les enrichis (web, LinkedIn, news, technos), tu scores par IA, tu pousses vers ton outil d'outreach. Industriel.",
    how_to_use: "1. Compte sur clay.com (essai 14j)\n2. Crée un workflow : input liste → enrichissement → scoring IA → output outreach\n3. Branche sur ta CRM via Zapier ou webhook",
    target_level: 'intermediate',
    target_jobs: ['sales'],
  },
  // === MARKETING ===
  {
    slug: 'jasper', name: 'Jasper', category: 'Marketing',
    description: "Plateforme copywriting IA orientée équipes marketing : templates par usage (ad, email, blog), brand voice, workflows.",
    url: 'https://jasper.ai',
    why_it_matters: "Pour les équipes qui produisent du contenu en série et veulent une cohérence de ton sans baby-sitter ChatGPT. Vrai outil d'équipe avec brand voice, library, approbations.",
    how_to_use: "1. Essai 7j sur jasper.ai\n2. Configure ta brand voice (échantillons + règles)\n3. Utilise les templates pour ad, blog, email — chaque sortie respecte la voix",
    target_level: 'intermediate',
    target_jobs: ['marketing'],
  },
  {
    slug: 'surfer-seo', name: 'Surfer SEO', category: 'Marketing',
    description: "Optimisation contenu data-driven. Tu rentres un mot-clé, Surfer te dit quoi écrire pour ranker (mots-clés, structure, longueur).",
    url: 'https://surferseo.com',
    why_it_matters: "Le contenu SEO 'à l'instinct' est mort. Surfer compare ton article aux 10 premiers résultats Google et te dit exactement ce qui manque pour les dépasser.",
    how_to_use: "1. Compte sur surferseo.com (essai 7j)\n2. Lance un Content Editor sur ton mot-clé\n3. Atteins le score >70 en suivant les suggestions (mots-clés, headings, longueur)",
    target_level: 'intermediate',
    target_jobs: ['marketing'],
  },
  {
    slug: 'adcreative-ai', name: 'AdCreative.ai', category: 'Marketing',
    description: "Génère et teste des creatives publicitaires (image + texte) optimisées pour la performance. Connecté Meta Ads, Google Ads.",
    url: 'https://adcreative.ai',
    why_it_matters: "Tester 50 creatives manuellement = 1 semaine. AdCreative en sort 50 en 1h, score chaque variant par IA prédictive et te dit lesquelles lancer.",
    how_to_use: "1. Compte sur adcreative.ai (essai 7j)\n2. Renseigne ta marque + objectif (lead, ventes)\n3. Génère 20-50 variantes, push les top scores dans ton ad manager",
    target_level: 'intermediate',
    target_jobs: ['marketing'],
  },
  {
    slug: 'copy-ai', name: 'Copy.ai', category: 'Marketing',
    description: "Plateforme copywriting IA polyvalente : workflows go-to-market complets (de la recherche au lancement).",
    url: 'https://copy.ai',
    why_it_matters: "Plus orienté workflows que Jasper. Tu construis une chaîne 'recherche concurrent → analyse → angle de positionnement → 5 ads' et ça tourne en 5 min.",
    how_to_use: "1. Compte freemium sur copy.ai\n2. Choisis un workflow GTM ou crée le tien\n3. Connecte tes données (Salesforce, Hubspot) pour personnaliser",
    target_level: 'intermediate',
    target_jobs: ['marketing', 'sales'],
  },
  // === CREATIVE ===
  {
    slug: 'dall-e-3', name: 'DALL-E 3', category: 'Image',
    description: "Le générateur d'image d'OpenAI, intégré à ChatGPT. Excellente compréhension du prompt, idéal pour itérer en conversation.",
    url: 'https://openai.com/dall-e-3',
    why_it_matters: "Inclus dans ChatGPT Plus. DALL-E 3 comprend mieux les prompts longs et nuancés que Midjourney, parfait pour les illustrations conceptuelles, les schémas, les visuels de présentation.",
    how_to_use: "1. Active ChatGPT Plus (20 USD/mois)\n2. Demande directement 'Génère une image de…'\n3. Itère par conversation : 'rends-la plus minimaliste', 'change le fond en bleu nuit'",
    target_level: 'beginner',
    target_jobs: ['creative', 'marketing'],
  },
  {
    slug: 'flux', name: 'Flux (Black Forest Labs)', category: 'Image',
    description: "Modèle image open-source qui rivalise avec Midjourney. Disponible via Replicate, Fal.ai, ou en local.",
    url: 'https://fal.ai/models/fal-ai/flux',
    why_it_matters: "La meilleure qualité image open-source en 2026. Pas de censure stricte, peut tourner sur tes propres serveurs, intégrable via API. Pour les pros qui veulent contrôler.",
    how_to_use: "1. Crée un compte fal.ai ou replicate.com (paiement à l'usage)\n2. Choisis Flux Pro pour la qualité, Flux Schnell pour la vitesse\n3. Intègre via API dans tes outils",
    target_level: 'intermediate',
    target_jobs: ['creative', 'dev'],
  },
  {
    slug: 'runway', name: 'Runway', category: 'Vidéo',
    description: "Génération et édition vidéo IA : text-to-video, image-to-video, suppression d'objet, motion brush.",
    url: 'https://runwayml.com',
    why_it_matters: "Création de B-roll en 30 secondes, suppression d'éléments dans une scène, génération d'idents : Runway transforme la prod vidéo. Standard chez les agences créa.",
    how_to_use: "1. Compte sur runwayml.com (125 crédits gratuits)\n2. Choisis Gen-3 pour la qualité\n3. Génère depuis texte ou image, édite avec les outils Magic",
    target_level: 'intermediate',
    target_jobs: ['creative', 'marketing'],
  },
  {
    slug: 'suno', name: 'Suno', category: 'Audio',
    description: "Génère des morceaux musicaux complets (paroles + instrumental + voix) à partir d'une description.",
    url: 'https://suno.com',
    why_it_matters: "Jingle de podcast, musique de fond pour vidéo, idée de chanson : Suno te sort un morceau de 2 min en 30 secondes. Qualité bluffante.",
    how_to_use: "1. Compte freemium sur suno.com (10 morceaux/jour)\n2. Décris le style + le sujet, ou fournis tes paroles\n3. Itère sur les variantes, télécharge en MP3",
    target_level: 'beginner',
    target_jobs: ['creative', 'marketing'],
  },
  {
    slug: 'heygen', name: 'HeyGen', category: 'Vidéo / Avatars',
    description: "Crée des vidéos avec des avatars IA qui parlent. Clone ta voix et ton visage pour produire des vidéos sans tournage.",
    url: 'https://heygen.com',
    why_it_matters: "Vidéos de formation interne, capsules marketing multilingues, onboarding personnalisé : tu écris un script, ton avatar le récite. Économie x10 vs tournage.",
    how_to_use: "1. Compte sur heygen.com (essai gratuit)\n2. Choisis un avatar de la bibliothèque ou clone le tien (3 min de vidéo source)\n3. Colle ton script, choisis la langue, génère",
    target_level: 'intermediate',
    target_jobs: ['marketing', 'creative', 'hr'],
  },
  // === DATA / FINANCE ===
  {
    slug: 'julius-ai', name: 'Julius AI', category: 'Data',
    description: "Analyse de données conversationnelle. Drop un CSV/Excel, pose tes questions en français, Julius produit des graphiques et insights.",
    url: 'https://julius.ai',
    why_it_matters: "L'alternative grand public à Code Interpreter pour ceux qui ne sont pas dans ChatGPT Plus. Spécialisé data, sait gérer de gros fichiers, exporte en PDF/Excel.",
    how_to_use: "1. Compte sur julius.ai (essai gratuit)\n2. Drop ton fichier CSV/Excel\n3. Pose tes questions ('quel est le segment le plus rentable ?'), Julius génère analyses et viz",
    target_level: 'intermediate',
    target_jobs: ['finance', 'marketing', 'corporate'],
  },
  // === HR ===
  {
    slug: 'pin', name: 'Pin (HelloPin)', category: 'RH',
    description: "Plateforme de pré-sourcing IA. Décris le poste, Pin trouve, qualifie et contacte les candidats potentiels sur LinkedIn.",
    url: 'https://hellopin.io',
    why_it_matters: "Recrutement tech difficile = pénurie + temps de sourcing énorme. Pin automatise les 60% bas du funnel (recherche + contact init), ton recruteur traite que les leads chauds.",
    how_to_use: "1. Demo sur hellopin.io\n2. Décris le poste + critères + ton style de message\n3. Pin lance le sourcing + outreach, tu reviens valider les candidats intéressés",
    target_level: 'intermediate',
    target_jobs: ['hr', 'founder'],
  },
  // === UNIVERSAL ===
  {
    slug: 'make', name: 'Make (Integromat)', category: 'Automatisation',
    description: "Alternative Zapier plus visuelle et puissante. Workflows complexes avec branches conditionnelles et boucles.",
    url: 'https://make.com',
    why_it_matters: "Là où Zapier devient cher au-dessus de 5000 tasks, Make est 5-10x moins cher. Et la canvas visuelle permet des workflows que Zapier ne sait pas faire (boucles, agrégations).",
    how_to_use: "1. Compte freemium (1000 ops/mois) sur make.com\n2. Crée un scénario avec triggers + modules + filtres\n3. Active, débogue avec l'historique d'exécutions",
    target_level: 'intermediate',
    target_jobs: ['dev', 'marketing', 'sales'],
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
    target_jobs: [],
  },
  // === SALES ===
  {
    slug: 'cold-email-relance', title: "Cold email de relance qui répond",
    category: 'Sales',
    use_case: "Relancer un prospect qui n'a pas répondu à 1 ou 2 emails sans avoir l'air désespéré.",
    prompt_template: `Tu es un SDR senior B2B. Rédige un email de relance court (60 mots max) pour mon prospect qui n'a pas répondu à mes 2 derniers messages.

Règles :
- Objet : 5 mots max, qui pique la curiosité, pas "Relance"
- Pas de "j'espère que vous allez bien"
- Une phrase qui rappelle le contexte sans culpabiliser
- Une nouvelle valeur (chiffre, cas client, signal récent du prospect)
- CTA : 1 question fermée OU 1 option de désinscription explicite
- Ton : direct, humain, jamais corporate

Contexte :
Prospect : [TITRE + ENTREPRISE]
Mon offre : [OFFRE EN 1 LIGNE]
Signal récent du prospect : [LEVÉE, RECRUTEMENT, PRESSE, RIEN]
Mes 2 derniers messages portaient sur : [SUJET]`,
    example_output: "Objet : 47% chez Acme — Bonjour Sophie, je sais que vous croulez sous les pings. Acme (votre concurrent direct) a passé 47% de ses leads en pipe en 8 semaines avec notre approche. Si pertinent, j'ai 15 min mardi 10h. Sinon dites-moi 'pas pour moi', je n'insiste plus.",
    target_level: 'intermediate',
    target_jobs: ['sales', 'founder'],
  },
  {
    slug: 'qualif-bant', title: "Qualification BANT/MEDDIC d'un lead",
    category: 'Sales',
    use_case: "Évaluer rapidement si un lead vaut le coup avant d'investir 3 RDV pour rien.",
    prompt_template: `Tu es un sales engineer qui qualifie les leads. À partir des notes de mon RDV de découverte, tu produis une fiche de qualification structurée.

Pour chaque dimension, score de 0 à 5 + justification courte + question à poser au prochain RDV :

1. **Budget** : ont-ils l'argent ? Est-il alloué ?
2. **Authority** : qui décide vraiment ? Mon contact a-t-il le pouvoir ?
3. **Need** : leur problème est-il concret + douloureux + urgent ?
4. **Timeline** : décident-ils dans 30/60/90 jours ?
5. **(MEDDIC) Champion** : ai-je un allié interne qui pousse pour nous ?

Verdict final :
- Score total /25
- Recommandation : "Pousser" / "Continuer doucement" / "Drop"
- 3 prochaines actions concrètes

Notes du RDV :
"""
[NOTES BRUTES OU TRANSCRIPT]
"""`,
    example_output: "Budget : 3/5 — \"on a une enveloppe IA mais pas validée Q2\" → question : \"Qui valide l'enveloppe et quand ?\". Authority : 2/5 — mon contact est CTO mais le DAF arbitre…",
    target_level: 'intermediate',
    target_jobs: ['sales'],
  },
  {
    slug: 'discovery-call-script', title: "Script d'appel discovery 30 min",
    category: 'Sales',
    use_case: "Préparer un appel de découverte structuré qui sort des vraies infos en 30 minutes.",
    prompt_template: `Tu es un coach commercial. Construis-moi un script d'appel discovery de 30 min, structuré pour ressortir avec : besoin clair, budget, timeline, décideurs, prochaine étape.

Découpe :
- 0-2 min : opener + cadre de l'appel
- 2-5 min : qualification rapide (rôle, contexte, top 3 priorités)
- 5-15 min : exploration du problème (pourquoi maintenant, ce qu'ils ont essayé, le coût du status quo)
- 15-22 min : exploration de la solution idéale (à quoi ressemblerait le succès, qui d'autre est impliqué, contraintes)
- 22-27 min : process de décision (budget, timeline, décideurs, alternatives)
- 27-30 min : closing (synthèse, prochaine étape, calendrier)

Pour chaque section :
- 2-3 questions ouvertes type "raconte-moi"
- 1 question piège pour valider la sincérité
- Ce que je dois prendre en note

Mon offre : [OFFRE]
Type de prospect : [TITRE + SECTEUR]
Mon objectif post-appel : [DEMO / RDV TECHNIQUE / DROP]`,
    example_output: "0-2 min : \"Ravi de vous rencontrer Camille. On a 30 min — mon objectif c'est de comprendre votre contexte, voir si on peut aider, et si oui définir une prochaine étape claire. Ça vous va ?\"…",
    target_level: 'intermediate',
    target_jobs: ['sales'],
  },
  // === MARKETING ===
  {
    slug: 'hook-linkedin', title: "Hook LinkedIn qui fait scroller",
    category: 'Marketing',
    use_case: "Tu écris un post LinkedIn et il faut que les 3 premières lignes accrochent assez pour qu'on déplie le 'voir plus'.",
    prompt_template: `Tu es un content creator LinkedIn senior. À partir de mon idée de post, génère 5 hooks différents (3 lignes max chacun) qui poussent au "voir plus".

Règles :
- Pas de "Aujourd'hui je vous parle de…"
- Pas de "Connaissez-vous…"
- Privilégie : chiffre choquant, contre-intuition, anecdote perso, question piège, mini-histoire
- Une émotion par hook : surprise, curiosité, agacement, identification, fierté
- Phrase 1 = punch ; phrase 2 = développe ; phrase 3 = teaser sur la suite

Pour chaque hook : indique le levier émotionnel + à qui ça parle.

Mon idée : [IDÉE]
Mon angle / ma thèse : [CE QUE JE VEUX FAIRE PASSER]
Mon audience cible : [QUI]`,
    example_output: "Hook 1 (surprise) : 'On a viré 60% de notre tooling marketing en 3 mois. Le résultat : +30% de pipe. Voici les 5 outils qu'on a gardés et pourquoi…'",
    target_level: 'intermediate',
    target_jobs: ['marketing', 'founder'],
  },
  {
    slug: 'persona-utilisateur', title: "Persona utilisateur en 30 minutes",
    category: 'Marketing / Produit',
    use_case: "Avant de lancer un produit ou une campagne, tu veux un persona précis qui guide les décisions, pas un cliché Pinterest.",
    prompt_template: `Tu es un UX researcher senior. À partir des informations sur mon utilisateur cible, construis un persona actionnable.

Structure :
1. **Identité** : prénom, âge, métier, niveau d'anciennenneté, secteur
2. **Sa journée type** : 3 moments clés où il/elle pourrait utiliser mon produit
3. **Ses 3 vrais problèmes** (pas inventés, basés sur les inputs)
4. **Ce qu'il/elle a déjà essayé** : outils + raisons de l'abandon
5. **Ses critères de décision** : 3 critères ranked (prix, gain de temps, intégration, etc.)
6. **Ses canaux de confiance** : où il/elle s'informe (newsletters, podcasts, communautés)
7. **Ce qui le/la disqualifierait** : un déclencheur de "non" immédiat
8. **Le pitch qui marche** : 2 phrases en mode "elevator"

Évite les caricatures (\"il aime le café\", \"elle adore Netflix\") — tout doit être actionnable pour le marketing ou le produit.

Mon produit : [PRODUIT EN 1 PHRASE]
Inputs sur l'utilisateur : [INTERVIEWS, SONDAGE, CRM]`,
    example_output: "Identité : Camille, 34 ans, Head of Growth, scaleup B2B SaaS Series A, 80 employés…",
    target_level: 'intermediate',
    target_jobs: ['marketing', 'product', 'founder'],
  },
  {
    slug: 'plan-editorial-12sem', title: "Plan éditorial 12 semaines",
    category: 'Marketing',
    use_case: "Tu prends en main le contenu d'une marque et tu veux 3 mois de planning sans tout improviser.",
    prompt_template: `Tu es un content strategist senior. Construis un plan éditorial de 12 semaines, à raison de 3 contenus/semaine, structuré autour de 3 piliers narratifs.

Format :
1. **3 piliers** : pour chaque, 1 promesse + le persona qu'il sert + 5 angles potentiels
2. **Calendrier semaine par semaine** :
   - Lundi (pilier #1) : titre + format (post, vidéo, article) + objectif (notoriété/engagement/conversion)
   - Mercredi (pilier #2) : idem
   - Vendredi (pilier #3) : idem
3. **3 séries récurrentes** sur les 12 semaines (ex: \"Le retour client du mois\")
4. **Les 5 events / saisonnalités** à ne pas rater dans la période
5. **KPIs** : 1 KPI principal + 2 secondaires à suivre

Marque : [QUI]
Audience : [PERSONA]
Objectif business : [LEAD / CA / NOTORIÉTÉ]
Période : [DATES]`,
    example_output: "Pilier 1 : 'L'expertise terrain' — promesse : 'On vous montre comment on fait, sans bullshit'…",
    target_level: 'intermediate',
    target_jobs: ['marketing', 'creative'],
  },
  {
    slug: 'brief-creatif', title: "Brief créatif clair pour agence ou freelance",
    category: 'Marketing / Créatif',
    use_case: "Tu briefes un designer, une agence ou un freelance et tu veux éviter les 4 allers-retours pour mettre tout le monde d'accord.",
    prompt_template: `Tu es un strategic planner. À partir de mon contexte, rédige un brief créatif court mais complet (1 page) pour le freelance ou l'agence qui va exécuter.

Structure :
1. **Contexte business** (3 phrases) : pourquoi on fait ça, maintenant
2. **Cible** : 1 persona précis + 1 phrase d'insight clé
3. **Insight** : la tension que la création doit résoudre
4. **Promesse** : ce qu'on veut faire ressentir/comprendre
5. **Tone of voice** : 3 adjectifs + 1 marque qui incarne (ou contre-modèle "surtout pas comme X")
6. **Reasons to believe** : 3 preuves qu'on peut donner
7. **Mandatories** : ce qui est obligatoire (logo, claim, CTA, format)
8. **Anti-mandatories** : ce qu'on ne veut surtout PAS
9. **Livrables attendus** : nb de pistes, format, deadline
10. **Budget + délai**

Sans jargon, sans phrases creuses. Si une info manque, écris \"À préciser\".

Inputs :
[CONTEXTE LIBRE QUE TU AS]`,
    example_output: "Contexte business : On lance la V2 de notre produit en septembre. Notre concurrent a sorti un truc agressif et nos leads se posent des questions…",
    target_level: 'intermediate',
    target_jobs: ['marketing', 'creative'],
  },
  // === DEV / TECH ===
  {
    slug: 'code-review', title: "Code review structurée",
    category: 'Dev',
    use_case: "Tu reviewes un PR et tu veux des commentaires utiles, pas du picking sur le formatage.",
    prompt_template: `Tu es un staff engineer qui fait des reviews exigeantes mais bienveillantes. Voici un diff. Produis une review structurée :

1. **Verdict** : ✅ Mergeable / 🟡 Demande corrections / 🔴 Refonte nécessaire
2. **3 points forts** (pas du flagornage, vraiment)
3. **Problèmes critiques** (bugs, sécurité, perfs) — rangés par sévérité
4. **Améliorations** (lisibilité, design, nommage) — niveau "nice to have"
5. **Tests manquants** : ce qui doit être couvert avant merge
6. **Questions ouvertes** : si quelque chose n'est pas clair, demande à l'auteur
7. **Suggestion finale** : 1 phrase qui résume "voici ce que je ferais à ta place"

Pour chaque commentaire : cite le fichier + ligne + extrait pertinent.

Diff :
"""
[DIFF GIT OU PR]
"""

Stack / contraintes du projet : [TECH STACK + CONTEXTE]`,
    example_output: "Verdict : 🟡 Demande corrections. 3 points forts : 1) bonne extraction du service en module isolé, 2) tests d'intégration ajoutés…",
    target_level: 'intermediate',
    target_jobs: ['dev'],
  },
  {
    slug: 'adr-architecture', title: "Architecture Decision Record (ADR)",
    category: 'Dev',
    use_case: "Tu prends une décision technique structurante et tu veux la documenter proprement pour les futurs devs.",
    prompt_template: `Tu es un staff engineer qui rédige des ADR (Architecture Decision Records) clairs. À partir de ma décision, produis un ADR au format Michael Nygard :

1. **Titre** : "ADR-XXX : [décision en 6 mots]"
2. **Status** : Proposed / Accepted / Deprecated / Superseded
3. **Context** : la situation, les contraintes, les forces en jeu (3-5 phrases)
4. **Decision** : ce qu'on a décidé, en 1 phrase actionnable
5. **Consequences** :
   - Positives (2-3 puces)
   - Négatives (2-3 puces)
   - Neutral (1-2 puces)
6. **Alternatives considérées** : 2-3 options évaluées + pourquoi rejetées (1 ligne chacune)
7. **References** : liens vers RFCs, docs, benchmarks

Style : neutre, factuel, pas de marketing. 400 mots max.

Ma décision : [LA DÉCISION]
Contexte : [POURQUOI MAINTENANT]
Alternatives évaluées : [LISTE]`,
    example_output: "ADR-014 : Adopter Postgres pour le pricing engine. Status : Accepted. Context : Le pricing actuel tourne sur DynamoDB. Les 3 derniers incidents ont montré que…",
    target_level: 'intermediate',
    target_jobs: ['dev'],
  },
  {
    slug: 'test-cases-from-spec', title: "Cas de tests à partir d'une spec",
    category: 'Dev',
    use_case: "Tu as une feature à coder et tu veux la liste des tests à écrire avant même de commencer (TDD).",
    prompt_template: `Tu es un QA engineer expert. À partir de cette spec, génère la liste des cas de tests à couvrir.

Structure :
1. **Tests unitaires** : par fonction publique
2. **Tests d'intégration** : interactions entre modules / API / DB
3. **Tests E2E** : parcours utilisateur complet
4. **Cas limites** : valeurs vides, max, négatives, concurrentes
5. **Tests de sécurité** : injections, auth, rate limiting
6. **Tests de perf** : 1-2 cas si pertinent

Pour chaque test :
- Nom au format \`should_<comportement>_when_<condition>\`
- Input : exemple précis
- Output attendu : exemple précis
- Priorité : Must / Should / Could

Évite les tests redondants. Vise la couverture du comportement, pas du code.

Spec :
"""
[SPEC OU TICKET]
"""`,
    example_output: "Tests unitaires : 1) should_return_403_when_user_not_authenticated. Input : POST /api/orders sans token. Output : { status: 403, error: 'unauthorized' }. Priority: Must…",
    target_level: 'intermediate',
    target_jobs: ['dev'],
  },
  // === FOUNDER ===
  {
    slug: 'pitch-deck-10-slides', title: "Pitch deck investisseur 10 slides",
    category: 'Founder',
    use_case: "Tu prépares un deck pour une levée Seed/Série A et tu veux la structure qui marche, pas une réinvention.",
    prompt_template: `Tu es un partner VC qui voit 30 decks par semaine. Aide-moi à construire un deck de 10 slides qui passe le filtre des 90 secondes.

Pour chaque slide : titre + bullet points + 1 visuel suggéré.

1. **Title** : nom + claim 6 mots + le total raise
2. **Problem** : la douleur, en 1 phrase + 1 chiffre choc
3. **Solution** : ce qu'on fait + screenshot/diagramme
4. **Why now** : la fenêtre de tir (régulation, tech, marché)
5. **Market** : TAM/SAM/SOM avec sources
6. **Traction** : 3 metrics qui prouvent qu'on n'est pas idiots (rev, users, growth)
7. **Business model** : comment on fait de l'argent + unit economics
8. **Competition** : matrice 2x2 où on est seul en haut à droite
9. **Team** : 3 founders, leur edge, pourquoi NOUS
10. **Ask** : montant + use of funds + 12-18 mois milestones

Style : 1 idée par slide, pas de pavés, chiffres ronds.

Inputs :
Boîte : [NOM + DESCRIPTION 2 LIGNES]
Stade : [PRE-SEED / SEED / SERIES A]
Métriques actuelles : [REV, USERS, GROWTH]
Le raise visé : [MONTANT + UTILISATION]`,
    example_output: "Slide 1 — Title : Acme · 'Le Stripe de l'IA pour les PME' · Seed round 2,5 M€…",
    target_level: 'intermediate',
    target_jobs: ['founder'],
  },
  {
    slug: 'okr-trimestre', title: "OKRs trimestriels carrés",
    category: 'Founder / Manager',
    use_case: "Tu démarres un trimestre et tu veux des OKRs qui motivent l'équipe sans tomber dans le KPI plat.",
    prompt_template: `Tu es un coach OKR senior (méthode Christina Wodtke). À partir de l'objectif business du trimestre, structure des OKRs carrés.

Pour le trimestre :
- **1 Objective** unique, qualitatif, ambitieux mais réaliste, qui inspire (max 8 mots)
- **3 Key Results** mesurables, chiffrés, qui dénotent un progrès réel (pas du \"on y travaille\")
- Pour chaque KR : la formule de calcul + la baseline + la cible

Critères de validation :
- Objective : si on l'atteint, l'année est gagnée ?
- Key Results : un sceptique pourrait-il contester qu'on a réussi ?
- Si je rate 1 KR sur 3, c'est encore un succès ?

Bonus :
- 1 \"Healthcheck metric\" à surveiller (ne pas casser le côté dark)
- 3 risques identifiés + mitigation

Contexte business : [SITUATION + AMBITION]
Équipe concernée : [TAILLE + FONCTION]
Période : [Q + DATES]`,
    example_output: "Objective : Devenir l'outil incontournable des équipes RH françaises. KR1 : passer de 12 à 30 logos clients (formule : COUNT distinct paying customers, baseline 12, cible 30)…",
    target_level: 'intermediate',
    target_jobs: ['founder', 'corporate'],
  },
  {
    slug: 'hiring-spec', title: "Spec poste claire pour recruter",
    category: 'RH / Founder',
    use_case: "Avant de recruter, tu veux une fiche de poste précise qui filtre les bons profils sans rebuter les meilleurs.",
    prompt_template: `Tu es un recruteur senior tech. À partir du brief, rédige une fiche poste qui :
- attire les A-players
- filtre les candidatures faibles
- donne au candidat tout ce qu'il faut pour décider en 5 min

Structure :
1. **Pourquoi ce poste maintenant ?** (3 phrases honnêtes)
2. **Mission** : 1 phrase + 3 résultats attendus dans les 6 mois
3. **À quoi ressemble une journée type** (5 puces)
4. **Ce que tu apportes** : 4 must-haves + 3 bonus (jamais 12 critères)
5. **Ce que tu n'auras PAS** : ce qui n'est pas dans le scope (transparence)
6. **Stack / outils** : ce qui est utilisé + ce qu'on cherche à intégrer
7. **L'équipe** : qui tu rejoins (2-3 lignes par profil)
8. **Compensation** : fourchette précise + variable + equity si applicable
9. **Process** : 3-4 étapes max + délai entre chaque
10. **Comment postuler** : 1 phrase + ce qu'on attend (CV ? lien ? case study ?)

Évite : "rockstar", "ninja", "passionné", "culture fit", "fast-paced environment".

Inputs :
Boîte : [QUI + STADE]
Poste : [TITRE]
Niveau : [JUNIOR / MID / SENIOR / STAFF]
Budget : [FOURCHETTE]
Pourquoi c'est intéressant maintenant : [TRACTION, IMPACT, ÉQUIPE]`,
    example_output: "Pourquoi maintenant : On a clos la Series A en mars, on passe de 8 à 25 personnes en 12 mois. Le 1er ML engineer, c'est toi…",
    target_level: 'intermediate',
    target_jobs: ['hr', 'founder'],
  },
  // === HR / MANAGER ===
  {
    slug: 'feedback-difficile', title: "Préparer un feedback difficile",
    category: 'RH / Manager',
    use_case: "Tu dois donner un feedback difficile (perf, comportement) et tu veux le faire bien : ferme sur les faits, juste sur les solutions.",
    prompt_template: `Tu es un coach manager. Aide-moi à préparer un entretien de feedback difficile en suivant la méthode SBI (Situation / Behavior / Impact) + plan d'action.

Structure :
1. **L'objectif de l'entretien** : ce que je veux qu'il/elle reparte avec
2. **La SBI principale** :
   - Situation : contexte précis (quand, où, qui)
   - Behavior : comportement observé (factuel, pas d'interprétation)
   - Impact : conséquence concrète (sur l'équipe, le client, le projet)
3. **Anticiper les réactions** : 3 réactions possibles (déni, justification, larmes) + ma réponse pour chacune
4. **Cadre de l'échange** : phrase d'ouverture + temps imparti + tone
5. **Plan d'action** : 2-3 actions concrètes attendues + dates de check-in
6. **Mes ressources internes** : quelles formations / mentoring / outils je peux proposer
7. **La ligne rouge** : à quoi je m'engage en cas de non-progrès

Style : chaque section en 3-5 lignes max. Pas de \"il faudrait\" — toujours des phrases actionnables.

Contexte :
Personne : [RÔLE + ANCIENNETÉ]
Le problème : [DESCRIPTION FACTUELLE]
Ce que j'ai déjà essayé : [HISTORIQUE]
Mon objectif : [CHANGEMENT VISÉ]`,
    example_output: "Objectif : Que Marc reparte conscient que sa façon de couper la parole en réunion bloque l'équipe + qu'il s'engage sur 2 actions…",
    target_level: 'intermediate',
    target_jobs: ['hr', 'corporate'],
  },
  {
    slug: 'offre-emploi-inclusive', title: "Offre d'emploi inclusive",
    category: 'RH',
    use_case: "Réécrire une offre d'emploi pour qu'elle attire des candidats plus divers sans tomber dans le langage corporate.",
    prompt_template: `Tu es un expert recrutement DEI (Diversity, Equity, Inclusion). À partir de mon offre actuelle, réécris-la en suivant ces règles :

1. **Genre** : pas de masculin générique. \"Tu seras\" plutôt que \"Le candidat sera\". Adjectifs neutres.
2. **Critères** : suppression des prérequis arbitraires (ex: \"5 ans d'expérience minimum\" remplacé par \"capable de…\"). Distinction nette \"Must\" / \"Bonus\".
3. **Langage** : suppression de termes virilisants (\"ninja\", \"warrior\", \"crush\", \"hardcore\") et de jargon corporate vide (\"culture fit\", \"passionné\", \"famille\").
4. **Compensation** : mention explicite de la fourchette salariale + benefits.
5. **Process** : étapes claires, délais, qui rencontre qui.
6. **Inclusion explicite** : phrase d'engagement DEI sourced (pas template Linkedin).
7. **Accessibilité** : mention des aménagements possibles si pertinent.

Format de sortie : offre réécrite + tableau des changements (avant / après / pourquoi).

Mon offre actuelle :
"""
[OFFRE]
"""`,
    example_output: "Offre réécrite : 'Rejoindre [boîte] comme Product Designer'… | Tableau changements : | Avant: 'Le candidat aura 5 ans d'XP' / Après: 'Tu te sens à l'aise pour mener un projet design de A à Z' / Pourquoi: l'expérience prouvée importe plus que les années.",
    target_level: 'beginner',
    target_jobs: ['hr'],
  },
  // === FINANCE ===
  {
    slug: 'analyse-pnl', title: "Analyse P&L en 5 questions",
    category: 'Finance',
    use_case: "Tu as un P&L sous les yeux et tu veux en sortir une analyse claire pour ton CODIR ou ton board.",
    prompt_template: `Tu es un CFO senior. À partir de ce P&L, produis une analyse structurée en répondant à 5 questions.

Format : pour chaque question, 2-3 phrases + 1 chiffre clé + 1 action recommandée.

1. **Où on gagne de l'argent ?** : top 3 lignes de revenus + leur trajectoire
2. **Où on en perd ?** : top 3 lignes de coûts + leur trajectoire
3. **Quelles tendances anormales ?** : 2-3 variations >20% vs N-1 ou budget
4. **Quels risques pour les 6 mois à venir ?** : 2-3 risques identifiés
5. **Si je n'ai qu'1 levier à actionner, c'est quoi ?** : recommandation principale chiffrée

Bonus :
- 3 questions à poser au prochain CODIR
- 3 KPIs à surveiller mensuellement

Style : factuel, chiffré, pas de \"il convient de\". Vise une lecture en 5 min par un dirigeant non-financier.

P&L :
"""
[CHIFFRES P&L]
"""

Contexte : [PÉRIODE + COMPARATIFS]`,
    example_output: "1. Où on gagne : SaaS B2B représente 68% du CA, en croissance de 22% YoY. Action : doubler l'équipe sales sur ce segment…",
    target_level: 'intermediate',
    target_jobs: ['finance', 'founder', 'corporate'],
  },
  {
    slug: 'budget-previsionnel', title: "Budget prévisionnel 12 mois",
    category: 'Finance / Founder',
    use_case: "Tu construis un prévisionnel pour ta boîte (création, renouvellement, levée) et tu veux qu'il tienne debout.",
    prompt_template: `Tu es un CFO de scale-up. Aide-moi à construire un budget prévisionnel sur 12 mois, mois par mois, qui soit défendable face à un investisseur ou une banque.

Structure (en tableau) :
1. **Revenus** : par segment ou produit, avec hypothèses (taux de conversion, ticket moyen, churn)
2. **Coûts variables** : COGS, commissions, infra
3. **Marge brute** : montant + %
4. **Coûts fixes** : salaires (avec détail recrutements), loyers, outils, marketing fixe
5. **EBITDA** : montant + %
6. **Trésorerie cumulée** : avec point bas + alerte cash <3 mois

Pour chaque ligne :
- 1 phrase d'hypothèse derrière le chiffre (\"on suppose 12 nouveaux logos/mois\")
- Source de la donnée (\"basé sur le run rate des 3 derniers mois\")

Stress tests :
- Scenario pessimiste : -30% sur les revenus
- Scenario optimiste : +30% sur les revenus
- Pour chaque : nouveau point bas + recommandation

Contexte boîte : [STADE + ANCIENNETÉ]
Métriques actuelles : [CA, CROISSANCE, BURN]
Objectif des 12 prochains mois : [LEVÉE / RENTABILITÉ / CROISSANCE]`,
    example_output: "Janvier — Revenus : 92k€ (12 nouveaux logos x ticket moyen 7,5k€ + 2k€ d'expansion sur la base existante). Hypothèse : on garde notre taux de conversion 8% inbound…",
    target_level: 'intermediate',
    target_jobs: ['finance', 'founder'],
  },
  // === DATA / PRODUCTIVITY ===
  {
    slug: 'comparer-3-options', title: "Comparer 3 options avec une matrice de décision",
    category: 'Productivité / Décisionnel',
    use_case: "Tu hésites entre plusieurs choix (outil, candidat, fournisseur, stratégie) et tu veux décider sans biais.",
    prompt_template: `Tu es un consultant en aide à la décision. Construis une matrice comparative pour mes 3 options.

Structure :
1. **Lister les critères** : 5-8 critères pertinents pour ma décision (poids 1-5 par critère selon importance)
2. **Évaluer chaque option** sur chaque critère (note 0-5 + 1 phrase de justification)
3. **Calculer le score pondéré** par option
4. **Identifier les sensibilités** : si je change le poids d'1 critère, le verdict change-t-il ?
5. **Verdict + caveat** : la recommandation + ce qui pourrait l'invalider

Format de sortie : tableau Markdown + 1 paragraphe d'analyse.

Anti-règles :
- Pas de critère qui dépend uniquement du goût ("c'est plus joli")
- Pas de score parfait 5/5 sans justification chiffrée
- Si une info manque, marque \"À investiguer\"

Ma décision : [QUOI CHOISIR]
Option A : [DESCRIPTION]
Option B : [DESCRIPTION]
Option C : [DESCRIPTION]
Mon contexte / contraintes : [BUDGET, TIMING, ÉQUIPE]`,
    example_output: "| Critère | Poids | Option A | Option B | Option C |\n| Coût TCO 3 ans | 5 | 3 (45k€) | 4 (30k€) | 2 (60k€) |\n| Vitesse de mise en place | 4 | 5 (1 sem) | 3 (3 sem) |…",
    target_level: 'intermediate',
    target_jobs: ['founder', 'corporate', 'finance'],
  },
  {
    slug: 'analyser-csv', title: "Analyser un fichier CSV/Excel par questions",
    category: 'Data',
    use_case: "Tu as un fichier de données (export CRM, finances, RH) et tu veux en sortir des insights sans formules Excel.",
    prompt_template: `Tu es un data analyst senior. À partir des données fournies, réponds à mes questions et propose des insights non demandés mais pertinents.

Pour chaque réponse :
1. **La donnée brute** (chiffre + période + filtres appliqués)
2. **L'analyse** : ce que ça veut dire en 2 phrases
3. **Le contexte** : par rapport à quoi (mois précédent, moyenne, benchmark)
4. **Action proposée** : 1 chose à faire avec cette info

À la fin :
- **3 insights non demandés** : trucs intéressants que tu as repérés dans les données
- **2 questions que je devrais me poser** : angles morts
- **1 visualisation recommandée** : quel graphe sortir pour communiquer ça

Si une donnée manque ou est incohérente, signale-le explicitement plutôt que d'inventer.

Données :
"""
[CSV / EXCEL CONTENT OU EXPORT]
"""

Mes questions : [LISTE DES QUESTIONS]
Contexte business : [QUI EST LIRA L'ANALYSE]`,
    example_output: "Q1 : Quel est mon top 3 segments client en CA ? R : Donnée brute : SaaS Mid-Market 38% du CA Q1, Enterprise 32%, SMB 18%. Analyse : Le Mid-Market progresse de 12% vs Q4…",
    target_level: 'intermediate',
    target_jobs: ['finance', 'marketing', 'product'],
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
// POST /api/admin/tool-cards/sync-defaults — pousse les tool cards manquantes
// (par slug) sans toucher aux existantes.
// ============================================
router.post('/tool-cards/sync-defaults', adminAuth, async (req, res) => {
  try {
    const existing = await query('SELECT slug FROM tool_cards');
    const existingSlugs = new Set(existing.rows.map(r => r.slug));
    let added = 0;
    const addedSlugs = [];
    for (let i = 0; i < DEFAULT_TOOL_CARDS.length; i++) {
      const t = DEFAULT_TOOL_CARDS[i];
      if (existingSlugs.has(t.slug)) continue;
      await query(
        `INSERT INTO tool_cards (slug, name, category, description, url, why_it_matters, how_to_use, target_level, target_jobs, active, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, $10)`,
        [t.slug, t.name, t.category || null, t.description || null, t.url || null,
         t.why_it_matters || null, t.how_to_use || null, t.target_level || null,
         JSON.stringify(t.target_jobs || []), i]
      );
      added++;
      addedSlugs.push(t.slug);
    }
    require('../services/cards').clearCache();
    logger.info('Sync DEFAULT_TOOL_CARDS', { added });
    res.json({ success: true, added, addedSlugs });
  } catch (err) {
    logger.error('Admin tool-cards sync-defaults error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/prompt-cards/sync-defaults — pousse les prompt cards manquantes
router.post('/prompt-cards/sync-defaults', adminAuth, async (req, res) => {
  try {
    const existing = await query('SELECT slug FROM prompt_cards');
    const existingSlugs = new Set(existing.rows.map(r => r.slug));
    let added = 0;
    const addedSlugs = [];
    for (let i = 0; i < DEFAULT_PROMPT_CARDS.length; i++) {
      const p = DEFAULT_PROMPT_CARDS[i];
      if (existingSlugs.has(p.slug)) continue;
      await query(
        `INSERT INTO prompt_cards (slug, title, category, use_case, prompt_template, example_output, target_level, target_jobs, active, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9)`,
        [p.slug, p.title, p.category || null, p.use_case || null,
         p.prompt_template, p.example_output || null, p.target_level || null,
         JSON.stringify(p.target_jobs || []), i]
      );
      added++;
      addedSlugs.push(p.slug);
    }
    require('../services/cards').clearCache();
    logger.info('Sync DEFAULT_PROMPT_CARDS', { added });
    res.json({ success: true, added, addedSlugs });
  } catch (err) {
    logger.error('Admin prompt-cards sync-defaults error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

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
// STRIPE — config check, cancel sub, customer portal
// ============================================
router.get('/stripe-config', adminAuth, async (req, res) => {
  try {
    const Stripe = require('stripe');
    const secret = process.env.STRIPE_SECRET_KEY || '';
    const stripe = new Stripe(secret);
    const checks = {
      mode: secret.startsWith('sk_live_')
        ? 'live'
        : secret.startsWith('sk_test_')
        ? 'test'
        : 'missing',
      has_secret_key: !!secret,
      has_webhook_secret: !!process.env.STRIPE_WEBHOOK_SECRET,
      has_price_pro: !!process.env.STRIPE_PRICE_PRO,
      price_pro: null,
      price_pro_error: null,
      webhooks: [],
      webhooks_error: null,
    };

    if (process.env.STRIPE_PRICE_PRO) {
      try {
        const price = await stripe.prices.retrieve(process.env.STRIPE_PRICE_PRO);
        checks.price_pro = {
          id: price.id,
          amount: price.unit_amount / 100,
          currency: price.currency,
          interval: price.recurring?.interval || null,
          active: price.active,
          livemode: price.livemode,
          product: price.product,
          nickname: price.nickname,
        };
      } catch (err) {
        checks.price_pro_error = err.message;
      }
    }

    try {
      const endpoints = await stripe.webhookEndpoints.list({ limit: 10 });
      checks.webhooks = endpoints.data.map(w => ({
        id: w.id,
        url: w.url,
        enabled_events: w.enabled_events,
        status: w.status,
        livemode: w.livemode,
      }));
    } catch (err) {
      checks.webhooks_error = err.message;
    }

    res.json(checks);
  } catch (err) {
    logger.error('Admin stripe-config error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/stripe-prices - cree un nouveau price sur le meme produit
// que le price actuel (STRIPE_PRICE_PRO). Body : { amount_cents, currency?, interval? }
// Repond avec le nouveau price ID a mettre dans STRIPE_PRICE_PRO sur Railway.
router.post('/stripe-prices', adminAuth, async (req, res) => {
  try {
    const Stripe = require('stripe');
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const { amount_cents, currency, interval } = req.body || {};
    if (!amount_cents || amount_cents < 0) {
      return res.status(400).json({ error: 'amount_cents requis (entier en centimes)' });
    }
    if (!process.env.STRIPE_PRICE_PRO) {
      return res.status(400).json({ error: 'STRIPE_PRICE_PRO non configure : impossible de retrouver le produit' });
    }
    const currentPrice = await stripe.prices.retrieve(process.env.STRIPE_PRICE_PRO);
    const productId = typeof currentPrice.product === 'string'
      ? currentPrice.product
      : currentPrice.product.id;

    const newPrice = await stripe.prices.create({
      product: productId,
      unit_amount: amount_cents,
      currency: (currency || currentPrice.currency || 'eur').toLowerCase(),
      recurring: { interval: interval || currentPrice.recurring?.interval || 'month' },
      nickname: currentPrice.nickname || null,
    });

    logger.info('Stripe price created by admin', {
      newPriceId: newPrice.id,
      productId,
      amount_cents,
    });
    res.json({
      success: true,
      old_price_id: currentPrice.id,
      new_price: {
        id: newPrice.id,
        amount: newPrice.unit_amount / 100,
        currency: newPrice.currency,
        interval: newPrice.recurring?.interval,
        product: productId,
        livemode: newPrice.livemode,
      },
      next_step: `Sur Railway, remplace STRIPE_PRICE_PRO par ${newPrice.id} puis redeploie.`,
    });
  } catch (err) {
    logger.error('Admin create stripe price error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/stripe-prices/:priceId/archive - archive un price (le rend inactif)
router.post('/stripe-prices/:priceId/archive', adminAuth, async (req, res) => {
  try {
    const Stripe = require('stripe');
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const updated = await stripe.prices.update(req.params.priceId, { active: false });
    res.json({ success: true, price_id: updated.id, active: updated.active });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/subscriptions/:subId?at_period_end=1 - annule un abo Stripe
router.delete('/subscriptions/:subId', adminAuth, async (req, res) => {
  try {
    const Stripe = require('stripe');
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const atPeriodEnd = req.query.at_period_end === '1';
    const sub = atPeriodEnd
      ? await stripe.subscriptions.update(req.params.subId, { cancel_at_period_end: true })
      : await stripe.subscriptions.cancel(req.params.subId);
    logger.info('Stripe subscription cancelled by admin', { subId: req.params.subId, atPeriodEnd });
    res.json({
      success: true,
      subscription: {
        id: sub.id,
        status: sub.status,
        cancel_at_period_end: sub.cancel_at_period_end,
        current_period_end: sub.current_period_end,
      },
    });
  } catch (err) {
    logger.error('Admin cancel subscription error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/stripe-charges - liste les paiements recents (dernier 30 jours par defaut)
router.get('/stripe-charges', adminAuth, async (req, res) => {
  try {
    const Stripe = require('stripe');
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const days = parseInt(req.query.days, 10) || 30;
    const since = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
    const charges = await stripe.charges.list({
      limit: 50,
      created: { gte: since },
    });
    const payments = charges.data.map(c => ({
      id: c.id,
      amount: c.amount / 100,
      currency: c.currency,
      status: c.status,
      refunded: c.refunded,
      amount_refunded: c.amount_refunded / 100,
      customerEmail: c.billing_details?.email,
      customerName: c.billing_details?.name,
      date: new Date(c.created * 1000).toISOString(),
      description: c.description,
      payment_intent: c.payment_intent,
    }));
    res.json({ payments });
  } catch (err) {
    logger.error('Admin stripe-charges error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/refunds - rembourse un paiement Stripe (full ou partial)
// Body : { charge_id, amount_cents? } — si amount_cents absent, full refund.
router.post('/refunds', adminAuth, async (req, res) => {
  try {
    const Stripe = require('stripe');
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const { charge_id, amount_cents } = req.body || {};
    if (!charge_id) return res.status(400).json({ error: 'charge_id requis' });
    const params = { charge: charge_id };
    if (amount_cents) params.amount = amount_cents;
    const refund = await stripe.refunds.create(params);
    logger.info('Stripe refund issued by admin', { chargeId: charge_id, amount_cents, refundId: refund.id });
    res.json({
      success: true,
      refund: {
        id: refund.id,
        amount: refund.amount / 100,
        currency: refund.currency,
        status: refund.status,
        charge: refund.charge,
      },
    });
  } catch (err) {
    logger.error('Admin refund error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/customer-portal/:userId - cree une session billing portal Stripe
router.post('/customer-portal/:userId', adminAuth, async (req, res) => {
  try {
    const Stripe = require('stripe');
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const userResult = await query(
      'SELECT id, stripe_customer_id, whatsapp_id FROM users WHERE id = $1',
      [req.params.userId]
    );
    const user = userResult.rows[0];
    if (!user) return res.status(404).json({ error: 'User non trouve' });
    if (!user.stripe_customer_id) {
      return res.status(400).json({ error: 'User n\'a pas de customer Stripe' });
    }
    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: (req.body && req.body.return_url) || `https://wa.me/${user.whatsapp_id}`,
    });
    res.json({ success: true, url: session.url });
  } catch (err) {
    logger.error('Admin customer-portal error', { error: err.message });
    res.status(500).json({ error: err.message });
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

// ============================================
// WHATSAPP TEMPLATES (admin) — soumet/liste les templates Meta via l'API Cloud.
// Necessite que WHATSAPP_ACCESS_TOKEN ait la permission whatsapp_business_management.
// ============================================
const META_GRAPH = 'https://graph.facebook.com/v21.0';

async function fetchWabaId() {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId) throw new Error('WHATSAPP_ACCESS_TOKEN ou WHATSAPP_PHONE_NUMBER_ID manquant');
  // Permet d'override via env pour debug ou comptes multi-WABA
  if (process.env.WHATSAPP_BUSINESS_ACCOUNT_ID) {
    return { wabaId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID, phone: { source: 'env' } };
  }
  // Le champ correct sur le phone number node est `whatsapp_business_account` (objet) puis .id.
  const res = await axios.get(
    `${META_GRAPH}/${phoneId}?fields=display_phone_number,verified_name,whatsapp_business_account{id,name}`,
    { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 }
  );
  const wabaId = res.data?.whatsapp_business_account?.id;
  if (!wabaId) throw new Error('Impossible de recuperer le WABA ID : ' + JSON.stringify(res.data));
  return { wabaId, phone: res.data };
}

router.get('/whatsapp-templates', adminAuth, async (req, res) => {
  try {
    const { wabaId, phone } = await fetchWabaId();
    const token = process.env.WHATSAPP_ACCESS_TOKEN;
    const list = await axios.get(
      `${META_GRAPH}/${wabaId}/message_templates?limit=100`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 }
    );
    res.json({ wabaId, phone, templates: list.data?.data || [], paging: list.data?.paging });
  } catch (err) {
    logger.error('Admin whatsapp-templates GET error', { error: err.message, response: err.response?.data });
    res.status(500).json({ error: err.message, response: err.response?.data });
  }
});

router.post('/whatsapp-templates', adminAuth, async (req, res) => {
  try {
    const { wabaId } = await fetchWabaId();
    const token = process.env.WHATSAPP_ACCESS_TOKEN;

    // Payload par defaut : will_daily_reminder (UTILITY, fr, body avec {{1}} + footer + 1 quick reply)
    const payload = req.body && Object.keys(req.body).length > 0 ? req.body : {
      name: 'will_daily_reminder',
      language: 'fr',
      category: 'UTILITY',
      components: [
        {
          type: 'BODY',
          text: 'Bonjour {{1}}, ta session Will du jour est prête. Réponds pour la recevoir.',
          example: { body_text: [['James']] },
        },
        { type: 'FOOTER', text: 'Will · coach IA' },
        {
          type: 'BUTTONS',
          buttons: [{ type: 'QUICK_REPLY', text: 'Recevoir ma session' }],
        },
      ],
    };

    const created = await axios.post(
      `${META_GRAPH}/${wabaId}/message_templates`,
      payload,
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    res.json({ success: true, wabaId, payload, response: created.data });
  } catch (err) {
    logger.error('Admin whatsapp-templates POST error', { error: err.message, response: err.response?.data });
    res.status(500).json({ error: err.message, response: err.response?.data });
  }
});

module.exports = router;
