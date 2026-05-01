const axios = require('axios');
const logger = require('../utils/logger');

const API_VERSION = process.env.WHATSAPP_API_VERSION || 'v21.0';
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const BASE_URL = `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/messages`;
const headers = { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' };

// Log config at startup for debugging
logger.info('WhatsApp service initialized', { API_VERSION, PHONE_NUMBER_ID, hasToken: !!ACCESS_TOKEN, tokenFirst10: ACCESS_TOKEN ? ACCESS_TOKEN.substring(0, 10) + '...' : 'none' });

async function sendText(to, text) {
  logger.info('WhatsApp sendText CALLED', { to, textLength: text?.length, url: BASE_URL });
  try {
    const res = await axios.post(BASE_URL, {
      messaging_product: 'whatsapp', to, type: 'text', text: { body: text },
    }, { headers, timeout: 15000 });
    logger.info('WhatsApp sendText SUCCESS', { to, status: res.status, responseData: JSON.stringify(res.data) });
    return res.data;
  } catch (err) {
    logger.error('WhatsApp sendText FAILED', { to, code: err.code, status: err.response?.status, error: JSON.stringify(err.response?.data || err.message) });
    throw err;
  }
}

async function sendButtons(to, bodyText, buttons, headerText, footerText) {
  logger.info('WhatsApp sendButtons CALLED', { to, bodyTextLength: bodyText?.length, buttonCount: buttons?.length });
  const interactive = {
    type: 'button',
    body: { text: bodyText },
    action: {
      buttons: buttons.map((btn, i) => ({
        type: 'reply',
        reply: { id: btn.id || `btn_${i}`, title: btn.title.substring(0, 20) },
      })),
    },
  };
  if (headerText) interactive.header = { type: 'text', text: headerText };
  if (footerText) interactive.footer = { text: footerText };
  try {
    const res = await axios.post(BASE_URL, {
      messaging_product: 'whatsapp', to, type: 'interactive', interactive,
    }, { headers, timeout: 15000 });
    logger.info('WhatsApp sendButtons SUCCESS', { to, status: res.status, responseData: JSON.stringify(res.data) });
    return res.data;
  } catch (err) {
    logger.error('WhatsApp sendButtons FAILED', { to, code: err.code, status: err.response?.status, error: JSON.stringify(err.response?.data || err.message) });
    throw err;
  }
}

// Envoi d'un template approuve Meta (utilise pour ouvrir/relancer hors fenetre 24h).
// `bodyParams` est un tableau de strings qui remplace {{1}}, {{2}}, etc dans le body.
async function sendTemplate(to, name, language = 'fr', bodyParams = []) {
  logger.info('WhatsApp sendTemplate CALLED', { to, name, language, paramCount: bodyParams.length });
  const template = { name, language: { code: language } };
  if (bodyParams.length > 0) {
    template.components = [{
      type: 'body',
      parameters: bodyParams.map(p => ({ type: 'text', text: String(p) })),
    }];
  }
  try {
    const res = await axios.post(BASE_URL, {
      messaging_product: 'whatsapp', to, type: 'template', template,
    }, { headers, timeout: 15000 });
    logger.info('WhatsApp sendTemplate SUCCESS', { to, name, status: res.status, responseData: JSON.stringify(res.data) });
    return res.data;
  } catch (err) {
    logger.error('WhatsApp sendTemplate FAILED', { to, name, code: err.code, status: err.response?.status, error: JSON.stringify(err.response?.data || err.message) });
    throw err;
  }
}

async function sendList(to, bodyText, buttonLabel, sections, headerText) {
  logger.info('WhatsApp sendList CALLED', { to, bodyTextLength: bodyText?.length });
  const interactive = {
    type: 'list',
    body: { text: bodyText },
    action: {
      button: buttonLabel.substring(0, 20),
      sections: sections.map(section => ({
        title: section.title,
        rows: section.rows.map(row => ({
          id: row.id, title: row.title.substring(0, 24), description: row.description?.substring(0, 72),
        })),
      })),
    },
  };
  if (headerText) interactive.header = { type: 'text', text: headerText };
  try {
    const res = await axios.post(BASE_URL, {
      messaging_product: 'whatsapp', to, type: 'interactive', interactive,
    }, { headers, timeout: 15000 });
    logger.info('WhatsApp sendList SUCCESS', { to, status: res.status, responseData: JSON.stringify(res.data) });
    return res.data;
  } catch (err) {
    logger.error('WhatsApp sendList FAILED', { to, code: err.code, status: err.response?.status, error: JSON.stringify(err.response?.data || err.message) });
    throw err;
  }
}

async function markAsRead(messageId) {
  try {
    await axios.post(BASE_URL, { messaging_product: 'whatsapp', status: 'read', message_id: messageId }, { headers, timeout: 10000 });
  } catch (err) { logger.info('Erreur markAsRead', { error: err.message, code: err.code }); }
}

function parseWebhookMessage(body) {
  try {
    const value = body.entry?.[0]?.changes?.[0]?.value;
    if (!value?.messages?.[0]) return null;
    const message = value.messages[0];
    const contact = value.contacts?.[0];
    const parsed = {
      from: message.from, messageId: message.id, timestamp: message.timestamp,
      displayName: contact?.profile?.name, type: message.type,
    };
    if (message.type === 'text') parsed.text = message.text.body;
    if (message.type === 'interactive') {
      if (message.interactive.type === 'button_reply') {
        parsed.text = message.interactive.button_reply.title;
        parsed.buttonId = message.interactive.button_reply.id;
      }
      if (message.interactive.type === 'list_reply') {
        parsed.text = message.interactive.list_reply.title;
        parsed.listId = message.interactive.list_reply.id;
      }
    }
    // Quick-reply d'un template approuve (clic sur un bouton de template)
    if (message.type === 'button') {
      parsed.text = message.button?.text;
      parsed.buttonPayload = message.button?.payload;
    }
    return parsed;
  } catch (err) { logger.error('Erreur parsing webhook', err); return null; }
}

module.exports = { sendText, sendButtons, sendList, sendTemplate, markAsRead, parseWebhookMessage };
