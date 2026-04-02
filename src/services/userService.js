const { query } = require('../db/pool');
const logger = require('../utils/logger');

async function findOrCreateUser(whatsappId, displayName) {
  const existing = await query('SELECT * FROM users WHERE whatsapp_id = $1', [whatsappId]);
  if (existing.rows.length > 0) {
    const user = existing.rows[0];
    const today = new Date().toISOString().split('T')[0];
    if (user.daily_messages_reset_at?.toISOString().split('T')[0] !== today) {
      await query('UPDATE users SET daily_messages_count = 0, daily_messages_reset_at = $1 WHERE id = $2', [today, user.id]);
      user.daily_messages_count = 0;
    }
    return user;
  }
  const trialEnds = new Date();
  trialEnds.setDate(trialEnds.getDate() + 7);
  const result = await query(
    "INSERT INTO users (whatsapp_id, display_name, plan, trial_ends_at) VALUES ($1, $2, 'trial', $3) RETURNING *",
    [whatsappId, displayName, trialEnds]
  );
  logger.info('Nouvel utilisateur cree', { whatsappId, displayName });
  return result.rows[0];
}

async function incrementDailyCount(userId) {
  await query('UPDATE users SET daily_messages_count = daily_messages_count + 1 WHERE id = $1', [userId]);
}

async function updateProfile(userId, updates) {
  const fields = []; const values = []; let idx = 1;
  for (const [key, value] of Object.entries(updates)) {
    if (['level', 'job', 'plan', 'onboarding_complete', 'display_name'].includes(key)) {
      fields.push(`${key} = $${idx}`); values.push(value); idx++;
    }
  }
  if (fields.length === 0) return;
  fields.push('updated_at = NOW()');
  values.push(userId);
  await query(`UPDATE users SET ${fields.join(', ')} WHERE id = $${idx}`, values);
}

async function saveMessage(userId, role, content, messageType, whatsappMessageId) {
  await query(
    'INSERT INTO messages (user_id, role, content, message_type, whatsapp_message_id) VALUES ($1, $2, $3, $4, $5)',
    [userId, role, content, messageType || 'chat', whatsappMessageId || null]
  );
}

function canSendMessage(user) {
  const limits = { trial: 30, starter: 30, pro: 999999, team: 999999, cancelled: 0 };
  const limit = limits[user.plan] || 0;
  if (user.plan === 'trial' && user.trial_ends_at && new Date(user.trial_ends_at) < new Date()) {
    return { allowed: false, reason: 'trial_expired' };
  }
  if (user.daily_messages_count >= limit) return { allowed: false, reason: 'daily_limit' };
  return { allowed: true };
}

module.exports = { findOrCreateUser, incrementDailyCount, updateProfile, saveMessage, canSendMessage };
