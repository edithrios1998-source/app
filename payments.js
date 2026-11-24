// Pagos en línea con Stripe Checkout (API REST, sin SDK).
// Requiere STRIPE_SECRET_KEY. STRIPE_WEBHOOK_SECRET habilita la confirmación por webhook.
const crypto = require('crypto');

const API = process.env.STRIPE_API_BASE || 'https://api.stripe.com';
const enabled = () => Boolean(process.env.STRIPE_SECRET_KEY);

// Codifica objetos anidados al formato de formulario que usa Stripe: a[b][0][c]=x
function form(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') form(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

async function stripe(method, path, params) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + process.env.STRIPE_SECRET_KEY,
      ...(params ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: params ? form(params).toString() : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `Stripe respondió ${res.status}`;
    throw Object.assign(new Error(msg), { stripe: true });
  }
  return data;
}

async function createCheckout({ booking, description, successUrl, cancelUrl, expiresAt }) {
  return stripe('POST', '/v1/checkout/sessions', {
    mode: 'payment',
    customer_email: booking.contact_email,
    client_reference_id: booking.code,
    metadata: { booking_code: booking.code },
    payment_intent_data: { metadata: { booking_code: booking.code }, description },
    line_items: { 0: { quantity: 1, price_data: { currency: 'usd', unit_amount: Math.round(booking.total * 100), product_data: { name: `Reserva ${booking.code}`, description } } } },
    success_url: successUrl,
    cancel_url: cancelUrl,
    expires_at: Math.floor(expiresAt.getTime() / 1000),
    locale: 'es',
  });
}

const getCheckout = (id) => stripe('GET', '/v1/checkout/sessions/' + encodeURIComponent(id));

// Verifica la cabecera Stripe-Signature (t=...,v1=...) con HMAC-SHA256.
function verifyWebhook(rawBody, header, secret, toleranceSec = 300) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')).filter((p) => p.length === 2).map(([k, v]) => [k.trim(), v]));
  const sigs = header.split(',').filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  const t = Number(parts.t);
  if (!t || !sigs.length || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

module.exports = { enabled, createCheckout, getCheckout, verifyWebhook };
