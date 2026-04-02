const Anthropic = require('@anthropic-ai/sdk');
const logger = require('../utils/logger');
const { query } = require('../db/pool');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const WILL_SYSTEM_PROMPT = `Tu es Will, un coach IA personnel sur WhatsApp. Tu apprends aux gens a utiliser l'IA au quotidien.

PERSONNALITE :
- Ton : amical, enthousiaste mais pas forceur. Tu tutoies toujours.
- Tu es expert en IA mais tu expliques simplement
- Tu utilises des emojis avec parcimonie (1-2 par message max)
- Tu es concis : messages courts, adaptes a WhatsApp (max 300 mots)
- Tu donnes des exemples concrets lies au metier de l'utilisateur quand possible

REGLES :
- Tu reponds TOUJOURS en francais
- Tu ne donnes JAMAIS de code sauf si l'utilisateur est developpeur et le demande
- Tu proposes souvent des actions concretes ("Essaie ca maintenant : ...")
- Si l'utilisateur pose une question hors sujet IA, redirige gentiment
- Tu t'adaptes au niveau de l'utilisateur (debutant/intermediaire/avance)

FORMAT :
- Messages courts et decoupes en paragraphes
- Pas de markdown (pas de ** ni de # - c'est WhatsApp)
- Utilise des sauts de ligne pour aerer
- Termine souvent par une question ou une suggestion d'action`;

async function generateResponse(userId, userMessage, userContext = {}) {
  try {
    const historyResult = await query(
      'SELECT role, content FROM messages WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10',
      [userId]
    );
    const conversationHistory = historyResult.rows.reverse().map(row => ({
      role: row.role,
      content: row.content,
    }));
    conversationHistory.push({ role: 'user', content: userMessage });

    const contextLine = buildContextLine(userContext);

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      system: WILL_SYSTEM_PROMPT + (contextLine ? '\n\nCONTEXTE UTILISATEUR :\n' + contextLine : ''),
      messages: conversationHistory,
    });

    const assistantMessage = response.content[0].text;
    logger.debug('Reponse Claude generee', {
      userId,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    });
    return assistantMessage;
  } catch (err) {
    logger.error('Erreur Claude API', { userId, error: err.message });
    return "Oups, j'ai eu un petit bug. Reessaie dans quelques secondes !";
  }
}

function buildContextLine(ctx) {
  const parts = [];
  if (ctx.level) parts.push('Niveau : ' + ctx.level);
  if (ctx.job) parts.push('Metier : ' + ctx.job);
  if (ctx.plan) parts.push('Plan : ' + ctx.plan);
  if (ctx.displayName) parts.push('Prenom : ' + ctx.displayName);
  return parts.join('\n');
}

module.exports = { generateResponse };
