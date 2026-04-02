require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const { pool, query } = require('../db/pool');
const logger = require('../utils/logger');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const CONTENT_TYPES = { 1: 'outil', 2: 'tuto', 3: 'cas_usage', 4: 'prompt', 5: 'defi' };
const LEVELS = ['debutant', 'intermediaire', 'avance'];

async function generateWeekContent() {
  const nextMonday = getNextMonday();
  logger.info('Generation de contenu pour la semaine du ' + nextMonday.toISOString().split('T')[0]);
  for (const [dayNum, type] of Object.entries(CONTENT_TYPES)) {
    for (const level of LEVELS) {
      try {
        const publishDate = new Date(nextMonday);
        publishDate.setDate(publishDate.getDate() + (parseInt(dayNum) - 1));
        const prompt = 'Tu generes du contenu pour Will, un coach IA sur WhatsApp. Type: ' + type + ', Niveau: ' + level + ', Jour: ' + getDayName(parseInt(dayNum)) + '. Reponds avec un JSON: {"title":"...","body":"...","buttons":[{"id":"daily_action1","title":"..."},{"id":"daily_action2","title":"..."}]}. Max 200 mots, pas de markdown, en francais.';
        const response = await anthropic.messages.create({
          model: 'claude-sonnet-4-5-20250514', max_tokens: 500,
          messages: [{ role: 'user', content: prompt }],
        });
        const content = JSON.parse(response.content[0].text);
        await query(
          'INSERT INTO daily_content (day_of_week, content_type, level, title, body, buttons, published_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          [parseInt(dayNum), type, level, content.title, content.body, JSON.stringify(content.buttons), publishDate]
        );
        await new Promise(r => setTimeout(r, 1000));
      } catch (err) { logger.error('Erreur generation ' + type + '/' + level, err.message); }
    }
  }
  logger.info('Generation terminee');
  process.exit(0);
}

function getNextMonday() {
  const today = new Date(); const day = today.getDay();
  const diff = day === 0 ? 1 : 8 - day;
  const monday = new Date(today); monday.setDate(today.getDate() + diff); monday.setHours(0,0,0,0);
  return monday;
}
function getDayName(num) { return ['','Lundi','Mardi','Mercredi','Jeudi','Vendredi'][num]; }

generateWeekContent();
