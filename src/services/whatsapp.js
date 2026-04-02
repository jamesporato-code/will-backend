const axios = require('axios');
const logger = require('../utils/logger');

const API_VERSION = process.env.WHATSAPP_API_VERSION || 'v21.0';
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const BASE_URL = `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/messages`;
const headers = { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' };

async function sendText(to, text) {
  try {
    const res = await axios.post(BASE_URL, {
      messaging_product: 'whatsapp', to, type: 'text', text: { body: text },
    }, { headers });
    return res.data;
  } catch (err) {
    logger.error('Erreur envoi WhatsApp texte', { to, error: err.response?.data || err.message });
    throw err;
  }
}

async function sendButtons(to, bodyText, buttons, headerText, footerText) {
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
    }, { headers });
    return res.data;
  } catch (err) {
    logger.error('Erreur envoi WhatsApp boutons', { to, error: err.response?.data || err.message });
    throw err;
  }
}

async function sendList(to, bodyText, buttonLabel, sections, headerText) {
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
    }, { headers });
    return res.data;
  } catch (err) {
    logger.error('Erreur envoi WhatsApp liste', { to, error: err.response?.data || err.message });
    throw err;
  }
}

async function markAsRead(messageId) {
  try {
    await axios.post(BASE_URL, { messaging_product: 'whatsapp', status: 'read', message_id: messageId }, { headers });
  } catch (err) { logger.debug('Erreur markAsRead', err.message); }
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
    return parsed;
  } catch (err) { logger.error('Erreur parsing webhook', err); return null; }
}

module.exports = { sendText, sendButtons, sendList, markAsRead, parseWebhookMessage };
