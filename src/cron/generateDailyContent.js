require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const { pool, query } = require('../db/pool');
const logger = require('../utils/logger');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// 7 jours de contenu (day_of_week correspond a getDay() JS)
const DAILY_CONTENT = [
  { dayOfWeek: 1, type: 'outil', name: 'Lundi', offset: 0 },
  { dayOfWeek: 2, type: 'tuto', name: 'Mardi', offset: 1 },
  { dayOfWeek: 3, type: 'cas_usage', name: 'Mercredi', offset: 2 },
  { dayOfWeek: 4, type: 'prompt', name: 'Jeudi', offset: 3 },
  { dayOfWeek: 5, type: 'defi', name: 'Vendredi', offset: 4 },
  { dayOfWeek: 6, type: 'tendance', name: 'Samedi', offset: 5 },
  { dayOfWeek: 0, type: 'recap', name: 'Dimanche', offset: 6 },
];

const LEVELS = ['beginner', 'intermediate'];

async function generateWeekContent() {
  const nextMonday = getNextMonday();
  logger.info('Generation de contenu pour la semaine du ' + nextMonday.toISOString().split('T')[0]);

  for (const day of DAILY_CONTENT) {
    for (const level of LEVELS) {
      try {
        const publishDate = new Date(nextMonday);
        publishDate.setDate(publishDate.getDate() + day.offset);

        const prompt = 'Tu generes du contenu pour Will, un coach IA sur WhatsApp. ' +
          'Type: ' + day.type + ', Niveau: ' + level + ', Jour: ' + day.name + '. ' +
          'Reponds avec un JSON: {"title":"...","body":"...","buttons":[{"id":"daily_action1","title":"..."},{"id":"daily_action2","title":"..."}]}. ' +
          'Max 200 mots, pas de markdown, en francais.';

        const response = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 500,
          messages: [{ role: 'user', content: prompt }],
        });

        const content = JSON.parse(response.content[0].text);

        await query(
          'INSERT INTO daily_content (day_of_week, content_type, level, title, body, buttons, published_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          [day.dayOfWeek, day.type, level, content.title, content.body, JSON.stringify(content.buttons), publishDate]
        );

        await new Promise(r => setTimeout(r, 1000));
      } catch (err) {
        logger.error('Erreur generation ' + day.type + '/' + level, err.message);
      }
    }
  }

  logger.info('Generation terminee (7 jours x 2 niveaux = 14 contenus)');
  process.exit(0);
}

function getNextMonday() {
  const today = new Date();
  const day = today.getDay();
  const diff = day === 0 ? 1 : 8 - day;
  const monday = new Date(today);
  monday.setDate(today.getDate() + diff);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

generateWeekContent();
