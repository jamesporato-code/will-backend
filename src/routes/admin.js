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
      WHERE plan IN ('etudiant', 'pro')
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
// POST /api/admin/trigger-daily/:id - Trigger daily message now
// ============================================
router.post('/trigger-daily/:id', adminAuth, async (req, res) => {
  try {
    const whatsapp = require('../services/whatsapp');
    const claude = require('../services/claude');
    const { cacheResponse } = require('../services/redis');

    const userId = req.params.id;
    const userResult = await query(
      'SELECT id, whatsapp_id, level, display_name, job FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Utilisateur non trouv\u00e9' });
    }

    const user = userResult.rows[0];
    const userContext = {
      level: user.level,
      job: user.job,
      displayName: user.display_name,
    };

    // Generate daily content via Claude + Tavily
    const dailyContent = await claude.generateDailyContent(userContext);

    if (!dailyContent) {
      return res.status(500).json({ error: 'Erreur g\u00e9n\u00e9ration contenu' });
    }

    // Cache for 24h so button followups work
    await cacheResponse('daily:' + user.id, dailyContent, 86400);

    // Send via WhatsApp with 3 interactive buttons
    await whatsapp.sendButtons(user.whatsapp_id, dailyContent, [
      { id: 'daily_deep', title: "J'approfondis \ud83d\udd0d" },
      { id: 'daily_example', title: 'Exemple concret \ud83d\udcbc' },
      { id: 'daily_next', title: 'Notion suivante \u27a1\ufe0f' },
    ]);

    logger.info('Daily triggered manually by admin', { userId: user.id });

    res.json({
      success: true,
      message: 'Daily envoy\u00e9',
      content: dailyContent,
    });
  } catch (err) {
    logger.error('Admin trigger-daily error', { error: err.message });
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
      "ALTER TABLE users ALTER COLUMN current_module DROP DEFAULT",
      "ALTER TABLE users ALTER COLUMN current_module TYPE INTEGER USING 1",
      "ALTER TABLE users ALTER COLUMN current_module SET DEFAULT 1",
    ];
    const results = [];
    for (const sql of statements) {
      try {
        await query(sql);
        results.push({ sql, ok: true });
      } catch (err) {
        results.push({ sql, ok: false, error: err.message });
      }
    }
    logger.info('DB migration run by admin', { results });
    res.json({ success: true, results });
  } catch (err) {
    logger.error('Admin migrate error', { error: err.message });
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
