const pool = require('../db/pool');

async function findOrCreateUser(whatsappId) {
  const existing = await pool.query('SELECT * FROM users WHERE whatsapp_id = $1', [whatsappId]);
  if (existing.rows.length > 0) return existing.rows[0];

  const result = await pool.query(
    `INSERT INTO users (whatsapp_id, plan, daily_message_count, last_message_date, created_at)
     VALUES ($1, 'trial', 0, CURRENT_DATE, NOW()) RETURNING *`,
    [whatsappId]
  );
  return result.rows[0];
}

async function canSendMessage(user) {
  const limits = { trial: 5, etudiant: 40, pro: 999999, cancelled: 0 };
  const limit = limits[user.plan] || 0;

  const today = new Date().toISOString().split('T')[0];
  const lastDate = user.last_message_date ? new Date(user.last_message_date).toISOString().split('T')[0] : null;

  if (lastDate !== today) {
    await pool.query('UPDATE users SET daily_message_count = 0, last_message_date = CURRENT_DATE WHERE id = $1', [user.id]);
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
  await pool.query('UPDATE users SET daily_message_count = daily_message_count + 1 WHERE id = $1', [userId]);
}

async function updateProfile(userId, updates) {
  const allowed = ['name', 'job', 'level', 'interests', 'plan', 'stripe_customer_id', 'stripe_subscription_id'];
  const fields = Object.keys(updates).filter(k => allowed.includes(k));
  if (fields.length === 0) return;

  const sets = fields.map((f, i) => `${f} = $${i + 2}`);
  const values = fields.map(f => updates[f]);
  await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1`, [userId, ...values]);
}

async function findByStripeCustomerId(stripeCustomerId) {
  const result = await pool.query('SELECT * FROM users WHERE stripe_customer_id = $1', [stripeCustomerId]);
  return result.rows[0] || null;
}

async function saveMessage(userId, role, content) {
  await pool.query(
    'INSERT INTO messages (user_id, role, content, created_at) VALUES ($1, $2, $3, NOW())',
    [userId, role, content]
  );
}

module.exports = { findOrCreateUser, incrementDailyCount, updateProfile, findByStripeCustomerId, saveMessage, canSendMessage };
