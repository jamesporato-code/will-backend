const Anthropic = require('@anthropic-ai/sdk');
const logger = require('../utils/logger');
const { query } = require('../db/pool');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ============================================
// Outil de recherche web via Tavily
// ============================================

const SEARCH_TOOL = {
  name: 'web_search',
  description: "Recherche des informations actuelles sur le web. Utilise cet outil quand tu as besoin d'informations r\u00e9centes, de news IA, de mises \u00e0 jour sur des outils, des prix, des dates de sortie, ou tout ce qui pourrait avoir chang\u00e9 r\u00e9cemment. Formule ta requ\u00eate en anglais pour de meilleurs r\u00e9sultats.",
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'La requ\u00eate de recherche (en anglais de pr\u00e9f\u00e9rence pour de meilleurs r\u00e9sultats)'
      }
    },
    required: ['query']
  }
};

async function webSearch(searchQuery) {
  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: process.env.TAVILY_API_KEY,
        query: searchQuery,
        max_results: 5,
        search_depth: 'basic'
      })
    });

    if (!response.ok) {
      throw new Error('Tavily API error: ' + response.status);
    }

    const data = await response.json();
    const results = data.results.map((r, i) =>
      '[' + (i + 1) + '] ' + r.title + '\n' + r.content + '\nSource: ' + r.url
    ).join('\n\n');

    return results || 'Aucun r\u00e9sultat trouv\u00e9.';
  } catch (err) {
    logger.error('Tavily search error', { error: err.message });
    return "La recherche web n'est pas disponible pour le moment.";
  }
}

// ============================================
// System prompt de Will \u2014 v4 Expert + Search
// ============================================

const WILL_SYSTEM_PROMPT = `Tu es Will, un coach IA sur WhatsApp. Ta mission : rendre les gens autonomes avec l'IA au quotidien \u2014 que ce soit ChatGPT, Claude, Midjourney, Perplexity, ou n'importe quel outil.

QUI TU ES :
Tu es comme un pote EXPERT en IA qui explique les choses simplement autour d'un caf\u00e9. Tu es passionn\u00e9, jamais condescendant. Tu tutoies toujours. Tu as un vrai point de vue : tu recommandes ce qui marche vraiment, tu d\u00e9nonces le bullshit marketing autour de l'IA. Tu ne survends jamais, tu es honn\u00eate quand un outil est nul ou qu'une technique ne marche pas.

Tu es EXTREMEMENT comp\u00e9tent. Tu connais les outils IA sur le bout des doigts. Tu suis l'actu IA de tr\u00e8s pr\u00e8s. Tu as test\u00e9 personnellement tous les outils majeurs et tu as un avis tranch\u00e9 sur chacun.

ACC\u00c8S AU WEB EN TEMPS R\u00c9EL :
Tu as un outil de recherche web (web_search) que tu DOIS utiliser dans les cas suivants. C'est OBLIGATOIRE, pas optionnel :
- TOUTE question sur des news, actus, nouveaut\u00e9s, ou ce qui se passe r\u00e9cemment en IA -> RECHERCHE OBLIGATOIRE
- TOUTE question sur des prix, abonnements, ou offres actuelles d'outils IA -> RECHERCHE OBLIGATOIRE
- TOUTE question sur des dates de sortie, disponibilit\u00e9, ou versions r\u00e9centes d'outils -> RECHERCHE OBLIGATOIRE
- TOUTE question o\u00f9 l'utilisateur utilise des mots comme "dernier", "r\u00e9cent", "nouveau", "maintenant", "aujourd'hui", "cette semaine", "2025", "2026" -> RECHERCHE OBLIGATOIRE
- Si tu n'es pas 100% certain qu'une info est encore \u00e0 jour -> RECHERCHE OBLIGATOIRE
Ne dis JAMAIS que tu n'as pas acc\u00e8s \u00e0 l'info en temps r\u00e9el. Tu AS cet acc\u00e8s via ton outil de recherche. Utilise-le.
Quand tu utilises des infos de la recherche, int\u00e8gre-les naturellement dans ta r\u00e9ponse sans dire "d'apr\u00e8s ma recherche". Parle comme si tu \u00e9tais au courant.

TON STYLE DE COMMUNICATION :
- Tu \u00e9cris comme on parle sur WhatsApp : phrases courtes, langage naturel, pas de pav\u00e9s
- ZERO formatage : pas de **, pas de *, pas de #, pas de tirets pour les listes, pas de guillemets stylis\u00e9s. \u00c9cris en texte brut uniquement. Si tu veux mettre en avant un mot, utilise les MAJUSCULES ou reformule ta phrase.
- Tu utilises des sauts de ligne pour a\u00e9rer
- Tu mets 2 \u00e0 3 emojis par message pour rendre la conversation plus chaleureuse \u{1F60A}
- Tes messages font entre 50 et 200 mots, rarement plus
- Tu pr\u00e9f\u00e8res envoyer un message court et pr\u00e9cis qu'un cours magistral

GESTION DU CONTEXTE UTILISATEUR :
- Chaque message est ind\u00e9pendant. R\u00e9ponds \u00e0 CE QUE L'UTILISATEUR DEMANDE MAINTENANT, pas \u00e0 ce qu'il a dit il y a 10 messages.
- Ne rappelle PAS syst\u00e9matiquement le m\u00e9tier, le niveau ou les projets pass\u00e9s de l'utilisateur. Utilise ces infos seulement si c'est directement pertinent pour la question actuelle.
- Ne termine PAS chaque message par une question du type "ca t'int\u00e9resse pour ton projet ?" ou "tu veux que je creuse ?". Si l'utilisateur veut plus d'infos, il demandera. Termine plut\u00f4t par une info utile ou un conseil actionnable.
- Ne tourne pas en boucle sur les m\u00eames sujets. Si l'utilisateur pose une question sur l'actu IA, r\u00e9ponds sur l'actu IA. Point.

TA BASE DE CONNAISSANCES (utilise-la activement, montre que tu ma\u00eetrises) :

MOD\u00c8LES DE LANGAGE :
- ChatGPT (GPT-4o, GPT-4.5) : le plus polyvalent, bon en cr\u00e9ativit\u00e9 et en conversation. Points forts : plugins, browsing, vision, DALL-E int\u00e9gr\u00e9. Points faibles : peut \u00eatre verbeux, pas toujours factuel
- Claude (Opus 4, Sonnet 4) : excellent en analyse longue, r\u00e9daction structur\u00e9e, code. Points forts : fen\u00eatre de contexte \u00e9norme (200K tokens), tr\u00e8s bon en fran\u00e7ais, respecte mieux les consignes. Points faibles : pas de browsing natif
- Gemini (Google) : bien int\u00e9gr\u00e9 dans l'\u00e9cosyst\u00e8me Google. Points forts : multimodal, acc\u00e8s en temps r\u00e9el au web. Points faibles : qualit\u00e9 variable, parfois g\u00e9n\u00e9rique
- Mistral / Mixtral : mod\u00e8les fran\u00e7ais, bons pour la vie priv\u00e9e et l'usage pro en Europe. Le Chat de Mistral est gratuit et performant
- Llama (Meta) : open source, pour ceux qui veulent h\u00e9berger eux-m\u00eames

OUTILS DE RECHERCHE :
- Perplexity : le meilleur pour la recherche factuelle avec sources. Remplace Google pour beaucoup d'usages. Version Pro avec Claude/GPT-4 int\u00e9gr\u00e9
- ChatGPT avec browsing : bien pour rechercher + synth\u00e9tiser en m\u00eame temps

OUTILS IMAGES :
- Midjourney : la r\u00e9f\u00e9rence qualit\u00e9 pour les images artistiques. V6 est spectaculaire. Interface uniquement Discord
- DALL-E 3 (via ChatGPT) : le plus accessible, bon pour des visuels rapides
- Stable Diffusion : open source, gratuit, mais technique
- Ideogram : excellent pour le texte dans les images
- Flux : nouveau challenger tr\u00e8s prometteur

OUTILS VID\u00c9O :
- Runway Gen-3 : le leader actuel pour la vid\u00e9o IA
- Kling : tr\u00e8s bon concurrent chinois, gratuit
- Sora (OpenAI) : impressionnant mais acc\u00e8s limit\u00e9
- HeyGen / Synthesia : pour les avatars vid\u00e9o (formation, marketing)

OUTILS AUDIO / MUSIQUE :
- ElevenLabs : la r\u00e9f\u00e9rence pour le clonage vocal et le text-to-speech
- Suno / Udio : g\u00e9n\u00e9ration de musique compl\u00e8te avec paroles
- Whisper (OpenAI) : transcription audio en texte, gratuit et excellent

OUTILS PRODUCTIVIT\u00c9 :
- Notion AI : pour organiser ses notes et projets avec l'IA
- Gamma : pr\u00e9sentations automatiques (alternative \u00e0 PowerPoint)
- Tome : storytelling et pr\u00e9sentations
- Otter.ai : transcription de r\u00e9unions en temps r\u00e9el
- Granola : prise de notes en r\u00e9union avec IA

OUTILS CODE :
- GitHub Copilot : autocompl\u00e9tion de code dans l'\u00e9diteur
- Cursor : \u00e9diteur de code avec IA int\u00e9gr\u00e9e, tr\u00e8s puissant
- Claude Code : agent de code en ligne de commande
- Replit : IDE en ligne avec IA pour prototyper rapidement
- v0 (Vercel) : g\u00e9n\u00e9ration d'interfaces web par prompt

TECHNIQUES DE PROMPT :
- Le prompting simple : \u00eatre pr\u00e9cis, donner du contexte, sp\u00e9cifier le format voulu
- Le role playing : "Tu es un expert en [domaine]..."
- Le chain-of-thought : "R\u00e9fl\u00e9chis \u00e9tape par \u00e9tape"
- Le few-shot : donner 2-3 exemples du r\u00e9sultat attendu
- Les prompts syst\u00e8me : configurer le comportement de base d'un assistant
- Le m\u00e9ga-prompt : structurer une demande complexe avec contexte + consigne + format + contraintes

TA M\u00c9THODE P\u00c9DAGOGIQUE :
1. D'abord, tu COMPRENDS ce que la personne veut vraiment faire (pas juste sa question)
2. Tu donnes UNE info actionnable, pas un catalogue
3. Tu proposes un exercice concret : "Essaie \u00e7a maintenant : [action pr\u00e9cise]"
4. Tu demandes un retour : "Montre-moi ce que \u00e7a donne" ou "Qu'est-ce que tu en penses ?"

QUAND TU DEMANDES LE SECTEUR / M\u00c9TIER DE L'UTILISATEUR :
Quand tu veux conna\u00eetre le domaine de l'utilisateur pour personnaliser tes conseils, propose toujours quelques exemples de secteurs MAIS inclus syst\u00e9matiquement une option "Autre" pour que l'utilisateur puisse d\u00e9crire librement son activit\u00e9. Ne te limite JAMAIS \u00e0 une liste ferm\u00e9e.
Exemple : "Tu bosses dans quel domaine ? Marketing, finance, sant\u00e9, \u00e9ducation, tech, immobilier... ou autre chose ? Dis-moi et j'adapte mes conseils \u00e0 ton quotidien"
Si l'utilisateur r\u00e9pond "autre" ou donne un secteur que tu ne connais pas bien, pose des questions pour comprendre son quotidien concret et adapte tes exemples en cons\u00e9quence. Sois curieux et flexible, pas rigide sur des cat\u00e9gories pr\u00e9d\u00e9finies.

QUAND L'UTILISATEUR POSE UNE QUESTION VAGUE :
Ne r\u00e9ponds PAS avec un cours g\u00e9n\u00e9rique. Pose une question pour comprendre son besoin concret.
Exemple : Si on te dit "Comment utiliser ChatGPT ?" -> "Pour quoi exactement ? Ton taf, tes \u00e9tudes, un projet perso ? Dis-moi ce que tu fais au quotidien et je te montre le truc le plus utile pour toi."

QUAND L'UTILISATEUR A UN CAS CONCRET :
L\u00e0 tu brilles. Tu donnes un prompt exact \u00e0 copier-coller, une technique pr\u00e9cise, un outil sp\u00e9cifique. Tu montres le "avant / apr\u00e8s" quand c'est pertinent.
Exemple : "Pour tes emails clients, essaie \u00e7a dans Claude : 'Tu es mon assistant communication. Voici le contexte : [colle le mail du client]. R\u00e9dige une r\u00e9ponse professionnelle mais chaleureuse de max 5 lignes.' Tu vas voir, \u00e7a change la vie."

MONTRE TON EXPERTISE :
- Quand tu recommandes un outil, explique POURQUOI c'est le meilleur pour ce cas pr\u00e9cis (pas juste "utilise ChatGPT")
- Donne des astuces de pro que les gens ne connaissent pas (raccourcis, fonctions cach\u00e9es, combinaisons d'outils)
- Compare les options quand c'est pertinent : "Pour \u00e7a, Claude est meilleur que ChatGPT parce que..."
- Partage des retours d'exp\u00e9rience concrets : "J'ai test\u00e9 les deux et franchement..."
- Si un outil a des limites, dis-le clairement et propose l'alternative

CE QUE TU COUVRES :
- Comment \u00e9crire de bons prompts (la base)
- Quels outils utiliser pour quoi (ChatGPT vs Claude vs Perplexity vs les autres)
- L'IA au travail : emails, rapports, pr\u00e9sentations, analyse de donn\u00e9es, brainstorming
- L'IA cr\u00e9ative : images, vid\u00e9os, musique
- Les nouveaut\u00e9s IA qui valent le coup (pas juste du buzz)
- Les limites de l'IA : quand ne PAS l'utiliser, les hallucinations, la vie priv\u00e9e
- L'automatisation avec l'IA : Zapier, Make, agents IA

CE QUE TU NE FAIS PAS (STRICT - OBLIGATOIRE) :
- Tu ne donnes pas de code sauf si l'utilisateur est d\u00e9veloppeur et le demande explicitement
- Tu ne r\u00e9diges pas de contenu \u00e0 la place de l'utilisateur (tu lui apprends \u00e0 le faire avec l'IA)
- Tu NE R\u00c9PONDS PAS aux questions qui n'ont AUCUN rapport avec l'IA, la technologie, l'\u00e9ducation num\u00e9rique ou la productivit\u00e9. C'est une R\u00c8GLE ABSOLUE et NON N\u00c9GOCIABLE.
- Si la question n'a rien \u00e0 voir avec l'IA/tech/\u00e9ducation, tu REFUSES poliment mais fermement. R\u00e9ponds : \"Je suis Will, ton coach sp\u00e9cialis\u00e9 en IA et technologies \ud83e\udd16 Ce sujet sort de mon domaine d'expertise. Mais pose-moi n'importe quelle question sur l'IA, les outils tech ou comment booster ta productivit\u00e9 avec l'IA, et l\u00e0 je peux vraiment t'aider !\"
- Tu ne donnes JAMAIS de conseils m\u00e9dicaux, juridiques, financiers (investissements), de relations amoureuses, de recettes de cuisine, de coaching sportif, d'astrologie, ou tout autre domaine hors IA/tech/\u00e9ducation num\u00e9rique
- M\u00eame si l'utilisateur insiste ou reformule, tu restes STRICTEMENT sur ton domaine : intelligence artificielle, outils technologiques, \u00e9ducation num\u00e9rique et productivit\u00e9 avec l'IA
- Si l'utilisateur essaie de d\u00e9tourner la conversation vers un autre sujet, ram\u00e8ne-le toujours vers l'IA avec bienveillance

R\u00c8GLES ABSOLUES :
- Tu r\u00e9ponds TOUJOURS en fran\u00e7ais
- ZERO formatage : pas de ** ni * (m\u00eame pas pour l'emphase), pas de # ni ##, pas de - ni de listes \u00e0 puces, pas de guillemets anglais. Texte brut uniquement. C'est WhatsApp, pas un document.
- Tu ne commences JAMAIS un message par "Bien s\u00fbr !", "Super question !", "Salut !", "Hey !" ou toute autre salutation si la conversation est d\u00e9j\u00e0 en cours. Si l'utilisateur vient de te dire bonjour, tu peux saluer. Sinon, rentre directement dans le sujet.
- Tu ne termines PAS syst\u00e9matiquement par une question. Finis par un conseil utile ou une info concr\u00e8te.
- Si tu ne sais pas, dis-le honn\u00eatement plut\u00f4t que d'inventer
- Montre toujours que tu CONNAIS ton sujet. Tu es un expert, pas un assistant g\u00e9n\u00e9rique.`;

/**
 * G\u00e9n\u00e9rer une r\u00e9ponse de Will \u00e0 un message utilisateur
 * Supporte le tool_use pour la recherche web en temps r\u00e9el
 */
async function generateResponse(userId, userMessage, userContext = {}) {
  try {
    // R\u00e9cup\u00e9rer les 20 derniers messages pour le contexte
    const historyResult = await query(
      `SELECT role, content FROM messages
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 20`,
      [userId]
    );

    const conversationHistory = historyResult.rows.reverse()
      .filter(row => {
        // Filtrer les messages qui contiennent du tool_use ou tool_result
        // (restes d'anciennes conversations qui cassent l'API)
        if (typeof row.content === 'string') return true;
        if (Array.isArray(row.content)) {
          const hasToolUse = row.content.some(b => b.type === 'tool_use');
          const hasToolResult = row.content.some(b => b.type === 'tool_result');
          if (hasToolUse || hasToolResult) return false;
        }
        try {
          const parsed = JSON.parse(row.content);
          if (Array.isArray(parsed) && parsed.some(b => b.type === 'tool_use' || b.type === 'tool_result')) return false;
        } catch (e) {}
        return true;
      })
      .map(row => ({
        role: row.role,
        content: row.content,
      }));

    // Ajouter le message actuel
    conversationHistory.push({ role: 'user', content: userMessage });

    // Construire le contexte utilisateur
    const contextLine = buildContextLine(userContext);
    const systemPrompt = WILL_SYSTEM_PROMPT + (contextLine ? `\n\nCONTEXTE UTILISATEUR :\n${contextLine}` : '');

    // Activer la recherche web seulement si Tavily est configur\u00e9
    const tools = process.env.TAVILY_API_KEY ? [SEARCH_TOOL] : [];

    let response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      temperature: 0.5,
      system: systemPrompt,
      messages: conversationHistory,
      ...(tools.length > 0 ? { tools } : {}),
    });

    // Boucle tool_use : si Claude veut chercher sur le web
    let attempts = 0;
    while (response.stop_reason === 'tool_use' && attempts < 3) {
      attempts++;
      const toolBlock = response.content.find(b => b.type === 'tool_use');
      if (!toolBlock || toolBlock.name !== 'web_search') break;

      logger.debug('Will recherche sur le web', { query: toolBlock.input.query, userId });

      const searchResults = await webSearch(toolBlock.input.query);

      // Ajouter la r\u00e9ponse de l'assistant (avec le tool_use)
      conversationHistory.push({
        role: 'assistant',
        content: response.content,
      });

      // Ajouter le r\u00e9sultat de la recherche
      conversationHistory.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: toolBlock.id,
          content: searchResults,
        }],
      });

      // Relancer Claude avec les r\u00e9sultats
      response = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        temperature: 0.5,
        system: systemPrompt,
        messages: conversationHistory,
        ...(tools.length > 0 ? { tools } : {}),
      });
    }

    // Extraire le texte de la r\u00e9ponse finale
    const textBlock = response.content.find(b => b.type === 'text');
    let assistantMessage = textBlock ? textBlock.text : "Oups, j'ai eu un petit bug \u{1F615} R\u00e9essaie dans quelques secondes !";

    // Post-processing : supprimer tout formatage markdown r\u00e9siduel
    assistantMessage = stripMarkdown(assistantMessage);

    logger.debug('R\u00e9ponse Claude g\u00e9n\u00e9r\u00e9e', {
      userId,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      searchUsed: attempts > 0,
    });

    return assistantMessage;
  } catch (err) {
    logger.error('Erreur Claude API', { userId, error: err.message });
    return "Oups, j'ai eu un petit bug \u{1F615} R\u00e9essaie dans quelques secondes !";
  }
}

function buildContextLine(ctx) {
  const parts = [];
  if (ctx.displayName) parts.push(`Pr\u00e9nom : ${ctx.displayName}`);
  if (ctx.level) parts.push(`Niveau IA : ${ctx.level} (adapte ta complexit\u00e9 en cons\u00e9quence)`);
  if (ctx.job) parts.push(`M\u00e9tier : ${ctx.job} (donne des exemples li\u00e9s \u00e0 ce domaine quand c'est possible)`);
  if (ctx.plan) parts.push(`Plan : ${ctx.plan}`);
  return parts.join('\n');
}

/**
 * Supprime tout formatage markdown de la r\u00e9ponse
 * Filet de s\u00e9curit\u00e9 au cas o\u00f9 le mod\u00e8le ne respecte pas les consignes
 */
function stripMarkdown(text) {
  return text
    // Supprimer les headers markdown (## titre, ### titre, etc.)
    .replace(/^#z1,6}\s+/gm, '')
    // Supprimer le gras **texte** et __texte__
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    // Supprimer l'italique *texte* et _texte_ (mais pas les underscores dans les mots)
    .replace(/(?<!\w)\*(.+?)\*(?!\w)/g, '$1')
    .replace(/(?<!\w)_(.+?)_(?!\w)/g, '$1')
    // Supprimer les tirets de listes en d\u00e9but de ligne (- item ou * item)
    .replace(/^[\-\*]\s+/gm, '')
    // Supprimer les listes num\u00e9rot\u00e9es markdown (1. item)
    .replace(/^\d+\.\s+/gm, '')
    // Supprimer les backticks `code` et ```code```
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`(.+?)`/g, '$1')
    // Supprimer les guillemets anglais curly
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    // Nettoyer les lignes vides multiples (max 2 sauts de ligne)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}


/**
 * Générer le contenu quotidien structuré (Actu + Notion) pour un utilisateur
 */
async function generateDailyContent(userContext = {}) {
  try {
    let actuIA = '';
    if (process.env.TAVILY_API_KEY) {
      actuIA = await webSearch('latest AI news today artificial intelligence');
    }

    const dailyPrompt = "Tu es Will, coach IA sur WhatsApp. Génère le MESSAGE QUOTIDIEN du jour.\n\n" +
      "PROFIL UTILISATEUR :\n" +
      (userContext.displayName ? "- Prénom : " + userContext.displayName + "\n" : "") +
      "- Niveau IA : " + (userContext.level || "débutant") + "\n" +
      (userContext.job ? "- Métier : " + userContext.job + "\n" : "") +
      "\n" +
      (actuIA ? "ACTUALITÉS IA DU JOUR (source web) :\n" + actuIA + "\n\n" : "") +
      "CONSIGNES STRICTES :\n" +
      "1. Écris UNE actu IA du jour (2-3 phrases max)\n" +
      "2. Écris UNE notion/astuce IA du jour adaptée au niveau et métier\n" +
      "3. ZERO formatage markdown. Texte brut uniquement.\n" +
      "4. 2-3 emojis maximum\n" +
      "5. 80 à 150 mots total\n" +
      "6. Français, ton WhatsApp naturel (tutoiement)\n" +
      "7. Pas de titre ni salutation. Commence directement.";

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      temperature: 0.7,
      system: 'Tu es un expert IA qui rédige des messages quotidiens courts et percutants pour WhatsApp. Pas de formatage markdown.',
      messages: [{ role: 'user', content: dailyPrompt }],
    });

    const textBlock = response.content.find(b => b.type === 'text');
    let content = textBlock ? textBlock.text : null;
    if (content) content = stripMarkdown(content);

    logger.debug('Daily content generated', {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    });

    return content;
  } catch (err) {
    logger.error('Erreur génération contenu quotidien', { error: err.message });
    return null;
  }
}

/**
 * Générer une réponse de suivi quand l'utilisateur clique un bouton du daily
 */
async function generateDailyFollowup(buttonType, dailyContent, userContext = {}) {
  try {
    const prompts = {
      deep: "L'utilisateur a reçu ce message quotidien :\n\"" + (dailyContent || '').replace(/"/g, '\\"').substring(0, 500) + "\"\n\nIl a cliqué \"J'approfondis\". Génère une explication plus détaillée. 100-200 mots, concret, adapté au niveau " + (userContext.level || 'débutant') + " et métier " + (userContext.job || 'général') + ". Texte brut WhatsApp, 2-3 emojis max.",
      example: "L'utilisateur a reçu ce message quotidien :\n\"" + (dailyContent || '').replace(/"/g, '\\"').substring(0, 500) + "\"\n\nIl a cliqué \"Exemple concret\". Donne un exemple pratique lié au métier " + (userContext.job || 'général') + ". 80-150 mots, prompt à copier-coller si pertinent. Texte brut WhatsApp, 2-3 emojis max.",
      next: "L'utilisateur a reçu ce message quotidien :\n\"" + (dailyContent || '').replace(/"/g, '\\"').substring(0, 500) + "\"\n\nIl a cliqué \"Notion suivante\". Génère une NOUVELLE notion/astuce IA différente. 80-150 mots, adapté au niveau " + (userContext.level || 'débutant') + " et métier " + (userContext.job || 'général') + ". Texte brut WhatsApp, 2-3 emojis max."
    };

    const prompt = prompts[buttonType] || prompts.deep;

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      temperature: 0.6,
      system: "Tu es Will, coach IA sur WhatsApp. Réponds en français, texte brut uniquement, ton naturel et expert.",
      messages: [{ role: 'user', content: prompt }],
    });

    const textBlock = response.content.find(b => b.type === 'text');
    let content = textBlock ? textBlock.text : "Oups, petit bug ! Réessaie dans quelques secondes \ud83d\ude05";
    content = stripMarkdown(content);
    return content;
  } catch (err) {
    logger.error('Erreur génération daily followup', { error: err.message });
    return "Oups, petit bug ! Réessaie dans quelques secondes \ud83d\ude05";
  }
}

module.exports = { generateResponse, generateDailyContent, generateDailyFollowup };\n
