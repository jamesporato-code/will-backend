const pool = require('../db/pool');

async function findOrCreateUser(whatsappId, displayName) {
  const existing = await pool.query('SELECT * FROM users WHERE whatsapp_id = $1', [whatsappId]);
  if (existing.rows.length > 0) return existing.rows[0];

  const result = await pool.query(
    `INSERT INTO users (whatsapp_id, display_name, plan, daily_message_count, last_message_date, created_at)
     VALUES ($1, $2, 'trial', 0, CURRENT_DATE, NOW()) RETURNING *`,
    [whatsappId, displayName || null]
  );
  return result.rows[0];
}

async function canSendMessage(user) {
  const limits = { trial: 15, etudiant: 40, pro: 999999, cancelled: 0 };
  const limit = limits[user.plan] || 0;

  const today = new Date().toISOString().split('T')[0];
  const lastDate = user.last_message_date
    ? new Date(user.last_message_date).toISOString().split('T')[0]
    : null;

  if (lastDate !== today) {
    await pool.query(
      'UPDATE users SET daily_message_count = 0, last_message_date = CURRENT_DATE WHERE id = $1',
      [user.id]
    );
    user.daily_message_count = 0;
  }

  if (user.plan === 'trial') {
    const created = new Date(user.created_at);
    const now = new Date();
    const days = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    if (days > 7) return { allowed: false, reason: 'trial_expired' };
  }

  if (user.daily_message_count >= limit) return { allowed: false, reason: 'daily_limit' };
  return { allowed: true };
}

async function incrementDailyCount(userId) {
  await pool.query(
    'UPDATE users SET daily_message_count = daily_message_count + 1 WHERE id = $1',
    [userId]
  );
}

async function updateProfile(userId, updates) {
  const allowed = ['name', 'display_name', 'job', 'level', 'interests', 'plan',
    'onboarding_complete', 'onboarding_step', 'stripe_customer_id',
    'stripe_subscription_id', 'preferred_hour'];

  const fields = Object.keys(updates).filter(k => allowed.includes(k));
  if (fields.length === 0) return;

  const sets = fields.map((f, i) => `${f} = $${i + 2}`);
  const values = fields.map(f => updates[f]);

  await pool.query(
    `UPDATE users SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1`,
    [userId, ...values]
  );
}

async function findByStripeCustomerId(stripeCustomerId) {
  const result = await pool.query(
    'SELECT * FROM users WHERE stripe_customer_id = $1',
    [stripeCustomerId]
  );
  return result.rows[0] || null;
}

async function saveMessage(userId, role, content, type, externalId) {
  await pool.query(
    'INSERT INTO messages (user_id, role, content, type, external_id, created_at) VALUES ($1, $2, $3, $4, $5, NOW())',
    [userId, role, content, type || 'chat', externalId || null]
  );
}

// ============================================
// Stats utilisateur : messages semaine, total, gain de temps estime
// ============================================
async function getUserStats(userId) {
  try {
    const result = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM messages WHERE user_id = $1 AND role = 'user' AND created_at >= NOW() - INTERVAL '7 days') as msg_week,
        (SELECT COUNT(*) FROM messages WHERE user_id = $1 AND role = 'user') as msg_total,
        (SELECT COUNT(DISTINCT DATE(created_at)) FROM messages WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '30 days') as active_days_month
    `, [userId]);
    const row = result.rows[0] || {};
    const msgWeek = parseInt(row.msg_week || 0, 10);
    const msgTotal = parseInt(row.msg_total || 0, 10);
    const activeDaysMonth = parseInt(row.active_days_month || 0, 10);
    // 5 min / message estime
    const minutesSavedWeek = msgWeek * 5;
    const minutesSavedTotal = msgTotal * 5;
    return {
      msgWeek,
      msgTotal,
      activeDaysMonth,
      minutesSavedWeek,
      minutesSavedTotal,
      hoursSavedTotal: (minutesSavedTotal / 60).toFixed(1),
      hoursSavedWeek: (minutesSavedWeek / 60).toFixed(1),
    };
  } catch (err) {
    return { msgWeek: 0, msgTotal: 0, activeDaysMonth: 0, minutesSavedWeek: 0, minutesSavedTotal: 0, hoursSavedTotal: '0.0', hoursSavedWeek: '0.0' };
  }
}

module.exports = {
  findOrCreateUser,
  canSendMessage,
  incrementDailyCount,
  updateProfile,
  findByStripeCustomerId,
  saveMessage,
  getUserStats,
};
