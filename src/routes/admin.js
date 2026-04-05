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

module.exports = router;
