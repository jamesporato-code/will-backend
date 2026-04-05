require('dotenv').config();
const { pool } = require('./pool');
const logger = require('../utils/logger');

async function migrate() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS teams (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        admin_user_id INTEGER,
        max_seats INTEGER DEFAULT 10,
        stripe_subscription_id VARCHAR(100),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        whatsapp_id VARCHAR(30) UNIQUE NOT NULL,
        display_name VARCHAR(100),
        level VARCHAR(20) DEFAULT 'debutant',
        job VARCHAR(100),
        interests VARCHAR(200),
        plan VARCHAR(20) DEFAULT 'trial',
        trial_ends_at TIMESTAMPTZ,
        stripe_customer_id VARCHAR(100),
        stripe_subscription_id VARCHAR(100),
        team_id INTEGER REFERENCES teams(id),
        daily_messages_count INTEGER DEFAULT 0,
        daily_messages_reset_at DATE DEFAULT CURRENT_DATE,
        onboarding_complete BOOLEAN DEFAULT false,
        onboarding_step INTEGER DEFAULT 0,
        preferred_hour INTEGER DEFAULT 8,
        timezone VARCHAR(50) DEFAULT 'Europe/Paris',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        role VARCHAR(10) NOT NULL,
        content TEXT NOT NULL,
        message_type VARCHAR(20) DEFAULT 'chat',
        whatsapp_message_id VARCHAR(100),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS daily_content (
        id SERIAL PRIMARY KEY,
        day_of_week INTEGER NOT NULL,
        content_type VARCHAR(20) NOT NULL,
        level VARCHAR(20) NOT NULL,
        title VARCHAR(200) NOT NULL,
        body TEXT NOT NULL,
        buttons JSONB,
        follow_ups JSONB,
        published_at DATE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Add columns if they don't exist (for existing databases)
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_step INTEGER DEFAULT 0;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS interests VARCHAR(200);`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_hour INTEGER DEFAULT 8;`);

    await pool.query('CREATE INDEX IF NOT EXISTS idx_users_whatsapp ON users(whatsapp_id);');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_messages_user_created ON messages(user_id, created_at DESC);');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_daily_content_schedule ON daily_content(day_of_week, level, published_at);');

    logger.info('Migrations executees avec succes');
    process.exit(0);
  } catch (err) {
    logger.error('Erreur de migration', err);
    process.exit(1);
  }
}

migrate();
