// Cliente de la API oficial de WhatsApp Business (Meta Cloud API), sin SDK.
// Requiere WHATSAPP_TOKEN y WHATSAPP_PHONE_NUMBER_ID. WHATSAPP_APP_SECRET valida los avisos entrantes.
const crypto = require('crypto');

const API = (process.env.WHATSAPP_API_BASE || 'https://graph.facebook.com/v21.0').replace(/\/$/, '');
const enabled = () => Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
const cut = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

async function call(payload) {
  const res = await fetch(`${API}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.WHATSAPP_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `WhatsApp respondió ${res.status}`);
  return data;
}

// Texto simple (los enlaces muestran vista previa).
const text = (to, body) => call({ recipient_type: 'individual', to, type: 'text', text: { body: cut(body, 4096), preview_url: true } });

// Hasta 3 botones de respuesta. buttons: [{ id, title }]
const buttons = (to, body, list) => call({
  recipient_type: 'individual', to, type: 'interactive',
  interactive: { type: 'button', body: { text: cut(body, 1024) },
    action: { buttons: list.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: cut(b.id, 256), title: cut(b.title, 20) } })) } },
});

// Lista de opciones (hasta 10). rows: [{ id, title, description }]
const list = (to, body, label, rows, sectionTitle = 'Opciones') => call({
  recipient_type: 'individual', to, type: 'interactive',
  interactive: { type: 'list', body: { text: cut(body, 1024) },
    action: { button: cut(label, 20), sections: [{ title: cut(sectionTitle, 24),
      rows: rows.slice(0, 10).map((r) => ({ id: cut(r.id, 200), title: cut(r.title, 24), ...(r.description ? { description: cut(r.description, 72) } : {}) })) }] } },
});

const markRead = (messageId) => call({ status: 'read', message_id: messageId }).catch(() => {});

// Verifica la cabecera X-Hub-Signature-256 (sha256=HMAC del cuerpo con el App Secret).
function verifySignature(rawBody, header, secret) {
  if (!header || !secret || !header.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const got = header.slice(7);
  return got.length === expected.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

module.exports = { enabled, text, buttons, list, markRead, verifySignature };
