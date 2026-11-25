try { process.loadEnvFile('.env'); } catch (_) { /* .env es opcional */ }

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieSession = require('cookie-session');
const compression = require('compression');
const bcrypt = require('bcryptjs');
const { query, init } = require('./db');
const payments = require('./payments');
const wa = require('./whatsapp');
const { createBot } = require('./bot');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

// Tarifas: multiplicador sobre el precio base y lo que incluyen.
const FARES = {
  basica: { name: 'Básica', mult: 1, includes: ['1 artículo personal (bolso o mochila bajo el asiento)', 'Asiento asignado al documentar (o elígelo con costo)'], excludes: ['Maleta de mano', 'Maleta documentada', 'Cambios'] },
  clasica: { name: 'Clásica', mult: 1.3, includes: ['Artículo personal + maleta de mano 10 kg', '1 maleta documentada de 23 kg', 'Asiento estándar sin costo', 'Cambios con cargo'], excludes: ['Reembolso'] },
  flexible: { name: 'Flexible', mult: 1.75, includes: ['Artículo personal + maleta de mano 10 kg', '2 maletas documentadas de 23 kg', 'Cualquier asiento sin costo', 'Cambios sin cargo', 'Reembolso con cargo', 'Abordaje prioritario'], excludes: [] },
};
const STATUS = {
  pendiente_pago: 'Pendiente de pago',
  emitido: 'Boleto emitido',
  cancelado: 'Cancelada',
  vencido: 'Vencida (no se pagó a tiempo)',
  pago_revision: 'Pagada: requiere revisión',
};
const DOC_TYPES = ['Pasaporte', 'INE', 'DNI', 'Cédula de identidad', 'Otro documento oficial'];
const MAX_PAX = 9;

// En producción la clave de sesión es obligatoria: sin ella cualquiera podría falsificar sesiones.
if (IS_PROD && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) {
  console.error('Falta SESSION_SECRET (mínimo 32 caracteres) en las variables de entorno.');
  process.exit(1);
}

// Límite de solicitudes por IP en una ventana de tiempo (en memoria).
function rateLimit({ windowMs, max, message }) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (now - v.t > windowMs) hits.delete(k); }, windowMs).unref();
  return (req, res, next) => {
    const now = Date.now();
    let h = hits.get(req.ip);
    if (!h || now - h.t > windowMs) { h = { n: 0, t: now }; hits.set(req.ip, h); }
    if (++h.n > max) {
      res.set('Retry-After', String(Math.ceil((h.t + windowMs - now) / 1000)));
      console.warn(`[rate-limit] ${req.ip} ${req.method} ${req.originalUrl}`);
      return res.status(429).json({ error: message || 'Demasiadas solicitudes. Espera unos minutos e intenta de nuevo.' });
    }
    next();
  };
}

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(compression());
app.use((req, res, next) => {
  // Solo HTTPS en producción (Render pone el protocolo original en X-Forwarded-Proto).
  if (IS_PROD && req.get('x-forwarded-proto') === 'http') return res.redirect(301, 'https://' + req.get('host') + req.originalUrl);
  res.set({
    'Content-Security-Policy': [
      "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com", "img-src 'self' data:", "connect-src 'self'",
      "form-action 'self'", "frame-ancestors 'none'", "base-uri 'self'", "object-src 'none'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  });
  if (IS_PROD) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});
// CORS: la API solo se usa desde este mismo sitio. No se envían encabezados CORS, y las
// solicitudes que cambian datos desde otro origen se rechazan (protección CSRF).
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD'].includes(req.method) || req.path === '/stripe/webhook' || req.path === '/whatsapp/webhook') return next();
  const origin = req.get('origin');
  if (origin && origin !== `${req.protocol}://${req.get('host')}`) return res.status(403).json({ error: 'Origen no permitido.' });
  next();
});
// (Los avisos de WhatsApp llegan desde los servidores de Meta; tienen su propio límite por número en bot.js.)
const apiLimit = rateLimit({ windowMs: 60 * 1000, max: 300 });
app.use('/api', (req, res, next) => (req.path === '/whatsapp/webhook' ? next() : apiLimit(req, res, next)));
const bookingLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 20, message: 'Hiciste muchas reservas seguidas. Espera un rato e intenta de nuevo.' });
const customerLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 60, message: 'Demasiados intentos. Espera 15 minutos e intenta de nuevo.' });
app.post('/api/bookings', bookingLimit);
app.use(['/api/bookings/lookup', '/api/payments/confirm'], customerLimit);
app.use(/^\/api\/bookings\/[^/]+\/(checkout|correct|seats)$/, customerLimit);

app.use('/api/stripe/webhook', express.raw({ type: '*/*', limit: '1mb' }));
app.use('/api/whatsapp/webhook', express.raw({ type: '*/*', limit: '1mb' }));
app.use(express.json({ limit: '100kb' }));
app.use(cookieSession({
  name: 'vl_sess', secret: process.env.SESSION_SECRET || 'dev-only-secret-change-me',
  httpOnly: true, sameSite: 'lax', secure: IS_PROD, maxAge: 12 * 60 * 60 * 1000,
}));
app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html'],
  // HTML, JS y CSS se revalidan siempre (ETag) para que un deploy nunca mezcle versiones.
  setHeaders: (res, file) => res.set('Cache-Control', /\.(html|js|css)$/.test(file) ? 'no-cache' : 'public, max-age=3600'),
}));

// ---------- utilidades ----------
const money = (n) => Math.round(Number(n) * 100) / 100;
const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

const todayStr = () => new Date().toISOString().slice(0, 10);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
const weekday = (d) => { const w = new Date(d + 'T00:00:00Z').getUTCDay(); return w === 0 ? 7 : w; };
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

async function getSettings() {
  const { rows } = await query('SELECT key, value FROM settings');
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return { tax_rate: Number(s.tax_rate), hold_hours: Number(s.hold_hours), service_fee: Number(s.service_fee),
    seat_std: Number(s.seat_std ?? 8), seat_front: Number(s.seat_front ?? 15), seat_exit: Number(s.seat_exit ?? 20),
    whatsapp: String(s.whatsapp || '') };
}

async function airportMap() {
  const { rows } = await query('SELECT * FROM airports');
  return Object.fromEntries(rows.map((a) => [a.code, { ...a, utc_offset: Number(a.utc_offset) }]));
}
async function airlineMap() {
  const { rows } = await query('SELECT * FROM airlines');
  return Object.fromEntries(rows.map((a) => [a.code, a]));
}

// Hora local de llegada a partir de la salida local, la duración y la diferencia horaria de cada aeropuerto.
function arrival(depTime, durationMin, from, to) {
  const [h, m] = depTime.split(':').map(Number);
  const local = h * 60 + m - from.utc_offset * 60 + durationMin + to.utc_offset * 60;
  const offset = Math.floor(local / 1440);
  const mins = ((local % 1440) + 1440) % 1440;
  return { arr_time: `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`, arr_offset: offset };
}

// Precio por pasajero: base × tarifa × anticipación (menos de 7 días +25 %, menos de 21 días +10 %).
function farePrice(base, fare, date) {
  const ahead = daysBetween(todayStr(), date);
  const demand = ahead < 7 ? 1.25 : ahead < 21 ? 1.1 : 1;
  return money(Number(base) * FARES[fare].mult * demand);
}

async function expireOld() {
  await query("UPDATE bookings SET status = 'vencido', updated_at = NOW() WHERE status = 'pendiente_pago' AND expires_at < NOW()");
}

async function seatsTaken(routeId, date) {
  const { rows } = await query(
    `SELECT COALESCE(SUM(b.pax_count), 0) AS n FROM segments s JOIN bookings b ON b.id = s.booking_id
     WHERE s.route_id = $1 AND s.flight_date = $2 AND (b.status = 'emitido' OR (b.status = 'pendiente_pago' AND b.expires_at > NOW()))`,
    [routeId, date]);
  return Number(rows[0].n);
}

function flightView(r, date, ap, al, taken) {
  const from = ap[r.origin], to = ap[r.destination];
  const { arr_time, arr_offset } = arrival(r.dep_time, r.duration_min, from, to);
  return {
    route_id: r.id, date, airline: { code: r.airline, name: al[r.airline]?.name || r.airline, color: al[r.airline]?.color || '#333' },
    flight_no: r.airline + ' ' + r.flight_no, origin: r.origin, destination: r.destination,
    origin_city: from.city, destination_city: to.city, dep_time: r.dep_time, arr_time, arr_offset,
    duration_min: r.duration_min, seats_left: Math.max(0, r.seats - taken),
    international: from.country !== to.country,
    fares: Object.entries(FARES).map(([code, f]) => ({ code, name: f.name, price: farePrice(r.base_price, code, date), includes: f.includes, excludes: f.excludes })),
  };
}

async function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let i = 0; i < 20; i++) {
    let c = ''; for (let j = 0; j < 6; j++) c += A[crypto.randomInt(A.length)];
    const { rows } = await query('SELECT 1 FROM bookings WHERE code = $1', [c]);
    if (!rows.length) return c;
  }
  throw new Error('No se pudo generar código');
}

async function loadBooking(where, params) {
  const { rows } = await query(`SELECT * FROM bookings WHERE ${where}`, params);
  const b = rows[0];
  if (!b) return null;
  const [{ rows: segs }, { rows: pax }, { rows: ev }, ap, al, { rows: cr }, { rows: st }, { rows: pay }, settings] = await Promise.all([
    query('SELECT * FROM segments WHERE booking_id = $1 ORDER BY id', [b.id]),
    query('SELECT * FROM passengers WHERE booking_id = $1 ORDER BY id', [b.id]),
    query('SELECT * FROM booking_events WHERE booking_id = $1 ORDER BY id', [b.id]),
    airportMap(), airlineMap(),
    query('SELECT * FROM correction_requests WHERE booking_id = $1 ORDER BY id', [b.id]),
    query('SELECT * FROM seat_assignments WHERE booking_id = $1', [b.id]),
    query('SELECT * FROM payments WHERE booking_id = $1 ORDER BY id', [b.id]),
    getSettings(),
  ]);
  const paid = money(b.paid_amount || 0);
  return {
    id: b.id, code: b.code, status: b.status, status_label: STATUS[b.status],
    contact_name: b.contact_name, contact_email: b.contact_email, contact_phone: b.contact_phone,
    pax_count: b.pax_count, subtotal: Number(b.subtotal), taxes: Number(b.taxes), total: Number(b.total), seats_total: Number(b.seats_total || 0),
    origin: b.origin, expires_at: b.expires_at, created_at: b.created_at, updated_at: b.updated_at,
    payment_method: b.payment_method, payment_ref: b.payment_ref, paid_at: b.paid_at,
    paid_amount: paid, balance: money(Math.max(0, Number(b.total) - paid)),
    payments: pay.map((p) => ({ id: p.id, amount: Number(p.amount), method: p.method, ref: p.ref, note: p.note, user_name: p.user_name, at: p.created_at })),
    segments: segs.map((s) => ({
      id: s.id, route_id: s.route_id,
      seats: pax.map((p) => { const a = st.find((x) => x.segment_id === s.id && x.passenger_id === p.id); return a ? { seat: a.seat, type: a.seat_type, price: Number(a.price) } : null; }),
      airline: { code: s.airline, name: al[s.airline]?.name || s.airline, color: al[s.airline]?.color || '#333' },
      flight_no: s.airline + ' ' + s.flight_no, date: s.flight_date, origin: s.origin, destination: s.destination,
      origin_city: ap[s.origin]?.city, destination_city: ap[s.destination]?.city,
      origin_name: ap[s.origin]?.name, destination_name: ap[s.destination]?.name,
      dep_time: s.dep_time, arr_time: s.arr_time, arr_offset: s.arr_offset, duration_min: s.duration_min,
      fare: s.fare, fare_name: FARES[s.fare]?.name, fare_includes: FARES[s.fare]?.includes || [], price_per_pax: Number(s.price_per_pax),
    })),
    international: segs.some((s) => ap[s.origin]?.country !== ap[s.destination]?.country),
    passengers: pax.map((p) => ({
      id: p.id, first_name: p.first_name, last_name: p.last_name, birth_date: p.birth_date, gender: p.gender,
      nationality: p.nationality, doc_type: p.doc_type, doc_number: p.doc_number, ticket_number: p.ticket_number,
    })),
    events: ev.map((e) => ({ status: e.status, label: STATUS[e.status], note: e.note, user_name: e.user_name, at: e.created_at })),
    corrections: cr.map((c) => ({ id: c.id, passenger: pax.findIndex((p) => p.id === c.passenger_id) + 1, changes: JSON.parse(c.changes), reason: c.reason,
      status: c.status, response: c.response, resolved_by: c.resolved_by, resolved_at: c.resolved_at, created_at: c.created_at })),
  };
}

// Vista pública: oculta documentos completos.
function publicBooking(b) {
  const mask = (s) => (s && s.length > 3 ? '•••' + s.slice(-3) : s);
  const isFix = (n) => /^(Datos corregidos|Solicitud de corrección|Contacto actualizado|Corrección en agencia)/.test(n || '');
  return { ...b, id: undefined, payment_ref: undefined,
    payments: b.payments.map(({ amount, method, at }) => ({ amount, method, at })),
    events: b.events.map(({ status, label, note, at }) => (isFix(note) ? { status, label: 'Corrección de datos', note, at } : { status, label, at })),
    passengers: b.passengers.map((p) => ({ ...p, id: undefined, doc_number: mask(p.doc_number) })),
    corrections: b.corrections.map((c) => ({ ...c, resolved_by: undefined,
      changes: Object.fromEntries(Object.entries(c.changes).map(([k, v]) => [k, k === 'doc_number' ? { from: mask(v.from), to: mask(v.to) } : v])) })) };
}

// ---------- autenticación ----------
const loginAttempts = new Map();
const requireStaff = (req, res, next) => (req.session.user ? next() : res.status(401).json({ error: 'Inicia sesión.' }));
const requireAdmin = (req, res, next) => (req.session.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Solo administradores.' }));

app.post('/api/auth/login', wrap(async (req, res) => {
  const now = Date.now();
  const a = loginAttempts.get(req.ip) || { n: 0, t: now };
  if (now - a.t > 15 * 60 * 1000) { a.n = 0; a.t = now; }
  if (a.n >= 10) return res.status(429).json({ error: 'Demasiados intentos. Espera 15 minutos.' });
  const { rows } = await query('SELECT * FROM users WHERE username = $1', [str(req.body.username, 60).toLowerCase()]);
  const u = rows[0];
  if (!u || !u.active || !bcrypt.compareSync(String(req.body.password || ''), u.password_hash)) {
    a.n++; loginAttempts.set(req.ip, a);
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
  }
  loginAttempts.delete(req.ip);
  req.session.user = { id: u.id, username: u.username, name: u.name, role: u.role };
  res.json({ user: req.session.user });
}));
app.post('/api/auth/logout', (req, res) => { req.session = null; res.json({ ok: true }); });
app.get('/api/auth/me', (req, res) => res.json({ user: req.session.user || null }));

// ---------- público ----------
app.get('/api/config', wrap(async (req, res) => {
  const s = await getSettings();
  res.json({ ...s, online_payments: payments.enabled(), whatsapp_bot: wa.enabled(), max_pax: MAX_PAX, doc_types: DOC_TYPES, statuses: STATUS, today: todayStr(),
    fares: Object.entries(FARES).map(([code, f]) => ({ code, ...f })) });
}));

app.get('/api/airports', wrap(async (req, res) => {
  const { rows } = await query('SELECT code, city, name, country FROM airports WHERE active = TRUE ORDER BY country, city');
  res.json(rows);
}));

// Aerolíneas activas (sin las de ejemplo) y si ya tienen vuelos a la venta.
app.get('/api/airlines', wrap(async (req, res) => {
  const [{ rows }, { rows: withRoutes }] = await Promise.all([
    query('SELECT code, name, color, country FROM airlines WHERE active = TRUE AND (demo IS NULL OR demo = FALSE) ORDER BY country, name'),
    query('SELECT DISTINCT airline FROM routes WHERE active = TRUE'),
  ]);
  const sell = new Set(withRoutes.map((r) => r.airline));
  res.json(rows.map((a) => ({ code: a.code, name: a.name, color: a.color, country: a.country || '', has_flights: sell.has(a.code) })));
}));

// Destinos con vuelos desde cada aeropuerto (para sugerir rutas válidas).
app.get('/api/routes-map', wrap(async (req, res) => {
  const { rows } = await query('SELECT DISTINCT origin, destination FROM routes WHERE active = TRUE');
  const m = {};
  for (const r of rows) (m[r.origin] = m[r.origin] || []).push(r.destination);
  res.json(m);
}));

app.get('/api/search', wrap(async (req, res) => {
  res.json(await searchFlights(str(req.query.from, 3), str(req.query.to, 3), str(req.query.date, 10), req.query.pax));
}));

// Búsqueda de vuelos (la usan el sitio y el bot de WhatsApp).
async function searchFlights(fromIn, toIn, date, paxIn) {
  const from = String(fromIn || '').toUpperCase(), to = String(toIn || '').toUpperCase();
  const pax = Math.min(MAX_PAX, Math.max(1, Number(paxIn) || 1));
  if (!from || !to || from === to) throw new HttpError(400, 'Elige un origen y un destino distintos.');
  if (!isDate(date)) throw new HttpError(400, 'Fecha inválida.');
  if (date < todayStr()) throw new HttpError(400, 'La fecha ya pasó.');
  if (daysBetween(todayStr(), date) > 330) throw new HttpError(400, 'Solo vendemos hasta 330 días antes del vuelo.');
  await expireOld();
  const [ap, al] = await Promise.all([airportMap(), airlineMap()]);
  if (!ap[from] || !ap[to]) throw new HttpError(400, 'Aeropuerto no disponible.');
  const { rows } = await query(
    `SELECT r.* FROM routes r JOIN airlines a ON a.code = r.airline
     WHERE r.active = TRUE AND a.active = TRUE AND r.origin = $1 AND r.destination = $2 ORDER BY r.dep_time`, [from, to]);
  const wd = String(weekday(date));
  const out = [];
  for (const r of rows.filter((x) => x.days.includes(wd))) {
    out.push(flightView(r, date, ap, al, await seatsTaken(r.id, date)));
  }
  // Próximas fechas con vuelo, para sugerir si no hay ese día.
  let next = [];
  if (!rows.length) next = [];
  else if (!out.length) {
    for (let i = 1; i <= 14 && next.length < 3; i++) {
      const d = addDays(date, i);
      if (rows.some((x) => x.days.includes(String(weekday(d))))) next.push(d);
    }
  }
  return { from: ap[from], to: ap[to], date, pax, flights: out.filter((f) => f.seats_left >= pax), next_dates: next, has_route: rows.length > 0 };
}

function readPassengers(list, international) {
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_PAX) throw new HttpError(400, `Entre 1 y ${MAX_PAX} pasajeros.`);
  return list.map((p, i) => {
    const n = i + 1;
    const x = {
      first_name: str(p.first_name, 60), last_name: str(p.last_name, 60), birth_date: str(p.birth_date, 10),
      gender: ['F', 'M', 'X'].includes(p.gender) ? p.gender : null, nationality: str(p.nationality, 60),
      doc_type: str(p.doc_type, 40), doc_number: str(p.doc_number, 30).toUpperCase(),
    };
    if (x.first_name.length < 2 || x.last_name.length < 2) throw new HttpError(400, `Pasajero ${n}: escribe nombre(s) y apellido(s) como aparecen en su documento.`);
    if (!isDate(x.birth_date) || x.birth_date >= todayStr() || x.birth_date < '1900-01-01') throw new HttpError(400, `Pasajero ${n}: fecha de nacimiento inválida.`);
    if (!x.nationality) throw new HttpError(400, `Pasajero ${n}: indica la nacionalidad.`);
    if (!DOC_TYPES.includes(x.doc_type)) throw new HttpError(400, `Pasajero ${n}: tipo de documento inválido.`);
    if (international && x.doc_type !== 'Pasaporte') throw new HttpError(400, `Pasajero ${n}: los vuelos internacionales requieren pasaporte.`);
    if (x.doc_number.length < 5) throw new HttpError(400, `Pasajero ${n}: número de documento inválido.`);
    return x;
  });
}

// ---------- asientos ----------
const SEAT_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];
const SEAT_TYPES = { front: 'Preferente', exit: 'Salida de emergencia (más espacio)', std: 'Estándar' };
// Filas 1-3 preferentes; dos filas de salida de emergencia a ~40 % del avión.
function seatLayout(totalSeats) {
  const rows = Math.ceil(totalSeats / 6);
  const exitA = Math.max(5, Math.round(rows * 0.4));
  const out = [];
  let n = 0;
  for (let r = 1; r <= rows; r++) {
    const type = r <= 3 ? 'front' : (r === exitA || r === exitA + 1) && rows > 8 ? 'exit' : 'std';
    for (const l of SEAT_LETTERS) { if (n++ < totalSeats) out.push({ seat: r + l, row: r, letter: l, type }); }
  }
  return { rows, seats: out };
}
function seatPrice(type, fare, st) {
  if (fare === 'flexible') return 0;
  if (fare === 'clasica' && type === 'std') return 0;
  return money(type === 'front' ? st.seat_front : type === 'exit' ? st.seat_exit : st.seat_std);
}
async function takenSeats(routeId, date, excludeBookingId = 0) {
  const { rows } = await query(
    `SELECT sa.seat FROM seat_assignments sa JOIN segments s ON s.id = sa.segment_id JOIN bookings b ON b.id = sa.booking_id
     WHERE s.route_id = $1 AND s.flight_date = $2 AND b.id <> $3
       AND (b.status IN ('emitido', 'pago_revision') OR (b.status = 'pendiente_pago' AND b.expires_at > NOW()))`, [routeId, date, excludeBookingId]);
  return new Set(rows.map((r) => r.seat));
}
// Valida los asientos pedidos para un tramo: lista por pasajero (null = sin elegir).
async function checkSeats(route, date, fare, wanted, paxCount, settings, excludeBookingId = 0) {
  const list = Array.isArray(wanted) ? wanted.slice(0, paxCount) : [];
  const layout = new Map(seatLayout(route.seats).seats.map((x) => [x.seat, x]));
  const taken = await takenSeats(route.id, date, excludeBookingId);
  const seen = new Set();
  const out = [];
  for (let i = 0; i < paxCount; i++) {
    const code = list[i] ? String(list[i]).toUpperCase().trim() : '';
    if (!code) { out.push(null); continue; }
    const info = layout.get(code);
    if (!info) throw new HttpError(400, `El asiento ${code} no existe en este avión.`);
    if (seen.has(code)) throw new HttpError(400, `El asiento ${code} está repetido.`);
    if (taken.has(code)) throw new HttpError(409, `El asiento ${code} acaba de ocuparse. Elige otro.`);
    seen.add(code);
    out.push({ seat: code, type: info.type, price: seatPrice(info.type, fare, settings) });
  }
  return out;
}
async function saveSeats(bookingId, segmentId, passengerIds, seats) {
  await query('DELETE FROM seat_assignments WHERE segment_id = $1', [segmentId]);
  for (let i = 0; i < passengerIds.length; i++) {
    const x = seats[i];
    if (x) await query('INSERT INTO seat_assignments (booking_id, segment_id, passenger_id, seat, seat_type, price) VALUES ($1,$2,$3,$4,$5,$6)',
      [bookingId, segmentId, passengerIds[i], x.seat, x.type, x.price]);
  }
}
async function recalcSeatsTotal(bookingId) {
  const { rows } = await query('SELECT COALESCE(SUM(price),0) AS t FROM seat_assignments WHERE booking_id = $1', [bookingId]);
  const t = money(rows[0].t);
  await query('UPDATE bookings SET seats_total = $1, total = subtotal + taxes + $1, updated_at = NOW() WHERE id = $2', [t, bookingId]);
  return t;
}

app.get('/api/seatmap', wrap(async (req, res) => {
  await expireOld();
  const { rows } = await query('SELECT * FROM routes WHERE id = $1', [Number(req.query.route_id) || 0]);
  const r = rows[0];
  const date = str(req.query.date, 10);
  if (!r || !isDate(date)) throw new HttpError(404, 'Vuelo no encontrado.');
  const fare = FARES[req.query.fare] ? req.query.fare : 'basica';
  const st = await getSettings();
  const taken = await takenSeats(r.id, date);
  const { rows: nRows, seats } = seatLayout(r.seats);
  res.json({ rows: nRows, letters: SEAT_LETTERS, types: SEAT_TYPES,
    prices: Object.fromEntries(Object.keys(SEAT_TYPES).map((t) => [t, seatPrice(t, fare, st)])),
    seats: seats.map((x) => ({ ...x, taken: taken.has(x.seat), price: seatPrice(x.type, fare, st) })) });
}));

app.post('/api/bookings', wrap(async (req, res) => {
  const staff = req.session.user;
  if (!staff && req.body.accept_terms !== true) throw new HttpError(400, 'Acepta los términos de uso y el aviso de privacidad para reservar.');
  const b = await createBooking(req.body, { staff, origin: staff ? 'agencia' : 'web' });
  res.status(201).json(staff ? b : publicBooking(b));
}));

// Crea una reserva pendiente de pago (sitio, panel o bot de WhatsApp). body: { segments, passengers, contact }.
async function createBooking(body, { staff = null, origin = 'web' } = {}) {
  if (!payments.enabled()) throw new HttpError(503, 'Las ventas en línea estarán disponibles muy pronto. Gracias por tu paciencia.');
  await expireOld();
  const segIn = Array.isArray(body.segments) ? body.segments.slice(0, 2) : [];
  if (!segIn.length) throw new HttpError(400, 'Elige al menos un vuelo.');
  const [ap, al, settings] = await Promise.all([airportMap(), airlineMap(), getSettings()]);
  const segs = [];
  for (const s of segIn) {
    const { rows } = await query('SELECT * FROM routes WHERE id = $1 AND active = TRUE', [Number(s.route_id) || 0]);
    const r = rows[0];
    if (!r || !al[r.airline]?.active) throw new HttpError(400, 'Uno de los vuelos ya no está disponible.');
    if (!isDate(s.date) || s.date < todayStr() || !r.days.includes(String(weekday(s.date)))) throw new HttpError(400, `El vuelo ${r.airline} ${r.flight_no} no opera ese día.`);
    if (!FARES[s.fare]) throw new HttpError(400, 'Tarifa inválida.');
    segs.push({ r, date: s.date, fare: s.fare, wantSeats: s.seats });
  }
  if (segs.length === 2) {
    const [a, b] = segs;
    if (a.r.origin !== b.r.destination || a.r.destination !== b.r.origin) throw new HttpError(400, 'El vuelo de regreso debe ser la ruta inversa.');
    if (b.date < a.date) throw new HttpError(400, 'El regreso no puede ser antes de la ida.');
  }
  const international = segs.some(({ r }) => ap[r.origin].country !== ap[r.destination].country);
  const pax = readPassengers(body.passengers, international);
  const c = body.contact || {};
  const contact = { name: str(c.name, 120), email: str(c.email, 120).toLowerCase(), phone: str(c.phone, 30) };
  if (contact.name.length < 3) throw new HttpError(400, 'Escribe el nombre de contacto.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)) throw new HttpError(400, 'Correo de contacto inválido.');
  if (contact.phone.replace(/\D/g, '').length < 7) throw new HttpError(400, 'Teléfono de contacto inválido.');

  for (const s of segs) {
    const left = s.r.seats - (await seatsTaken(s.r.id, s.date));
    if (left < pax.length) throw new HttpError(409, `Solo quedan ${Math.max(0, left)} asientos en ${s.r.airline} ${s.r.flight_no}.`);
  }
  const priced = segs.map((s) => ({ ...s, price: farePrice(s.r.base_price, s.fare, s.date), ...arrival(s.r.dep_time, s.r.duration_min, ap[s.r.origin], ap[s.r.destination]) }));
  const subtotal = money(priced.reduce((t, s) => t + s.price, 0) * pax.length);
  const taxes = money(subtotal * settings.tax_rate + settings.service_fee * pax.length);
  for (const s of segs) s.seatSel = await checkSeats(s.r, s.date, s.fare, s.wantSeats, pax.length, settings);
  const seatsTotal = money(segs.reduce((t, s) => t + s.seatSel.reduce((a, x) => a + (x ? x.price : 0), 0), 0));
  const total = money(subtotal + taxes + seatsTotal);
  const code = await newCode();
  const expires = new Date(Date.now() + settings.hold_hours * 3600 * 1000);
  const { rows } = await query(
    `INSERT INTO bookings (code, status, contact_name, contact_email, contact_phone, pax_count, subtotal, taxes, total, origin, created_by, expires_at, seats_total)
     VALUES ($1,'pendiente_pago',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [code, contact.name, contact.email, contact.phone, pax.length, subtotal, taxes, total, origin, staff ? staff.id : null, expires, seatsTotal]);
  const id = rows[0].id;
  const segIds = [];
  for (const s of priced) {
    const { rows: sr } = await query(`INSERT INTO segments (booking_id, route_id, flight_date, airline, flight_no, origin, destination, dep_time, arr_time, arr_offset, duration_min, fare, price_per_pax)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [id, s.r.id, s.date, s.r.airline, s.r.flight_no, s.r.origin, s.r.destination, s.r.dep_time, s.arr_time, s.arr_offset, s.r.duration_min, s.fare, s.price]);
    segIds.push(sr[0].id);
  }
  const paxIds = [];
  for (const p of pax) {
    const { rows: pr } = await query(`INSERT INTO passengers (booking_id, first_name, last_name, birth_date, gender, nationality, doc_type, doc_number)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [id, p.first_name, p.last_name, p.birth_date, p.gender, p.nationality, p.doc_type, p.doc_number]);
    paxIds.push(pr[0].id);
  }
  for (let i = 0; i < segs.length; i++) await saveSeats(id, segIds[i], paxIds, segs[i].seatSel);
  const seatNote = segs.map((s) => s.seatSel.filter(Boolean).map((x) => x.seat).join(', ')).filter(Boolean).join(' / ');
  await query('INSERT INTO booking_events (booking_id, status, note, user_name) VALUES ($1,$2,$3,$4)',
    [id, 'pendiente_pago', ({ agencia: 'Reserva creada en agencia', whatsapp: 'Reserva creada por WhatsApp' }[origin] || 'Reserva creada en línea') + (seatNote ? '. Asientos: ' + seatNote : ''), staff ? staff.name : null]);
  return loadBooking('id = $1', [id]);
}

app.post('/api/bookings/lookup', wrap(async (req, res) => {
  await expireOld();
  const code = str(req.body.code, 10).toUpperCase();
  const last = norm(req.body.last_name);
  const b = code && last ? await loadBooking('code = $1', [code]) : null;
  if (!b || !b.passengers.some((p) => norm(p.last_name) === last || norm(p.last_name).split(/\s+/).includes(last))) {
    return res.status(404).json({ error: 'No encontramos una reserva con ese código y apellido.' });
  }
  res.json(publicBooking(b));
}));

// Cambiar asientos de un tramo. Con boleto emitido solo se cambia a asientos sin costo adicional.
async function changeSeats(b, segIdx, wanted, { staff = false, userName = null } = {}) {
  if (!['pendiente_pago', 'emitido', 'pago_revision'].includes(b.status)) throw new HttpError(400, `La reserva está "${b.status_label}".`);
  const sg = b.segments[Number(segIdx)];
  if (!sg) throw new HttpError(400, 'Vuelo inválido.');
  if (sg.date < todayStr()) throw new HttpError(400, 'Ese vuelo ya salió.');
  const { rows } = await query('SELECT * FROM routes WHERE id = $1', [sg.route_id]);
  if (!rows[0]) throw new HttpError(400, 'Vuelo no disponible.');
  const settings = await getSettings();
  const sel = await checkSeats(rows[0], sg.date, sg.fare, wanted, b.passengers.length, settings, b.id);
  const issued = b.status !== 'pendiente_pago';
  if (issued) {
    // Lo ya pagado no se vuelve a cobrar: un asiento del mismo precio o menor no tiene costo extra.
    sel.forEach((x, i) => { if (x) { const prev = sg.seats[i]; if (prev && prev.seat === x.seat) x.price = prev.price; } });
    const extra = sel.some((x, i) => x && x.price > (sg.seats[i]?.price || 0));
    if (extra) throw new HttpError(400, 'Con los boletos ya emitidos solo se puede cambiar a asientos sin costo adicional (o de igual precio).');
    // Con boleto emitido el total no cambia; se conserva lo pagado.
    sel.forEach((x, i) => { if (x) x.price = Math.min(x.price, sg.seats[i]?.price ?? x.price); });
  }
  await saveSeats(b.id, sg.id, b.passengers.map((p) => p.id), sel);
  if (!issued) await recalcSeatsTotal(b.id);
  const txt = sel.map((x, i) => `P${i + 1}: ${x ? x.seat : 'sin asiento'}`).join(', ');
  await query('INSERT INTO booking_events (booking_id, status, note, user_name) VALUES ($1,$2,$3,$4)',
    [b.id, b.status, `Cambio de asientos ${sg.origin}-${sg.destination}: ${txt}`, userName]);
}

app.post('/api/bookings/:code/seats', wrap(async (req, res) => {
  await expireOld();
  const b = await findForCustomer(req.params.code, req.body.last_name);
  await changeSeats(b, req.body.segment, req.body.seats);
  res.json(publicBooking(await loadBooking('id = $1', [b.id])));
}));
app.put('/api/staff/bookings/:id/seats', requireStaff, wrap(async (req, res) => {
  const b = await loadBooking('id = $1', [Number(req.params.id) || 0]);
  if (!b) throw new HttpError(404, 'Reserva no encontrada.');
  await changeSeats(b, req.body.segment, req.body.seats, { staff: true, userName: req.session.user.name });
  res.json(await loadBooking('id = $1', [b.id]));
}));

// ---------- corrección de datos ----------
const PAX_FIELDS = { first_name: 'Nombre(s)', last_name: 'Apellido(s)', birth_date: 'Fecha de nacimiento', gender: 'Sexo', nationality: 'Nacionalidad', doc_type: 'Tipo de documento', doc_number: 'Número de documento' };
const MAX_NAME_EDIT = 3; // letras que se pueden corregir en el nombre después de emitir el boleto

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[m][n];
}
const nameEdits = (from, to) => levenshtein(norm(`${from.first_name} ${from.last_name}`).replace(/\s+/g, ' '), norm(`${to.first_name} ${to.last_name}`).replace(/\s+/g, ' '));

// Valida un pasajero con las mismas reglas de la reserva; el número de documento vacío conserva el actual.
function validatePassenger(input, current, international, n) {
  const merged = { ...current };
  for (const k of Object.keys(PAX_FIELDS)) {
    if (input[k] === undefined) continue;
    if (k === 'doc_number' && !String(input[k]).trim()) continue;
    merged[k] = input[k];
  }
  try { return readPassengers([merged], international)[0]; }
  catch (e) { throw new HttpError(400, e.message.replace('Pasajero 1', 'Pasajero ' + n)); }
}
function diff(current, next) {
  const out = {};
  for (const k of Object.keys(PAX_FIELDS)) {
    if ((current[k] || '') !== (next[k] || '')) out[k] = { from: current[k] || '', to: next[k] || '' };
  }
  return out;
}
const diffText = (n, d) => `Pasajero ${n}: ` + Object.entries(d).map(([k, v]) => `${PAX_FIELDS[k]} "${k === 'doc_number' ? '•••' + String(v.from).slice(-3) : v.from}" → "${k === 'doc_number' ? '•••' + String(v.to).slice(-3) : v.to}"`).join(', ');

async function applyPassenger(passengerId, data) {
  await query(`UPDATE passengers SET first_name=$1, last_name=$2, birth_date=$3, gender=$4, nationality=$5, doc_type=$6, doc_number=$7 WHERE id=$8`,
    [data.first_name, data.last_name, data.birth_date, data.gender, data.nationality, data.doc_type, data.doc_number, passengerId]);
}
function readContact(c, current) {
  const x = { name: str(c?.name ?? current.contact_name, 120), email: str(c?.email ?? current.contact_email, 120).toLowerCase(), phone: str(c?.phone ?? current.contact_phone, 30) };
  if (x.name.length < 3) throw new HttpError(400, 'Escribe el nombre de contacto.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x.email)) throw new HttpError(400, 'Correo de contacto inválido.');
  if (x.phone.replace(/\D/g, '').length < 7) throw new HttpError(400, 'Teléfono de contacto inválido.');
  return x;
}
async function applyContact(b, c) {
  if (c.name === b.contact_name && c.email === b.contact_email && c.phone === b.contact_phone) return null;
  await query('UPDATE bookings SET contact_name=$1, contact_email=$2, contact_phone=$3, updated_at=NOW() WHERE id=$4', [c.name, c.email, c.phone, b.id]);
  return 'Contacto actualizado';
}
const log = (b, note, user) => query('INSERT INTO booking_events (booking_id, status, note, user_name) VALUES ($1,$2,$3,$4)', [b.id, b.status, note, user || null]);
const nameRuleMsg = `Después de emitir el boleto solo se pueden corregir hasta ${MAX_NAME_EDIT} letras del nombre (errores de escritura). Un cambio mayor es un cambio de pasajero: cancela y haz una reserva nueva.`;

async function findForCustomer(code, lastName) {
  const b = await loadBooking('code = $1', [str(code, 10).toUpperCase()]);
  const last = norm(lastName);
  if (!b || !last || !b.passengers.some((p) => norm(p.last_name) === last || norm(p.last_name).split(/\s+/).includes(last))) {
    throw new HttpError(404, 'No encontramos una reserva con ese código y apellido.');
  }
  return b;
}

// Cliente: antes de pagar corrige directo; con boleto emitido envía solicitud a la agencia.
app.post('/api/bookings/:code/correct', wrap(async (req, res) => {
  await expireOld();
  const b = await findForCustomer(req.params.code, req.body.last_name);
  if (!['pendiente_pago', 'emitido'].includes(b.status)) throw new HttpError(400, `La reserva está "${b.status_label}" y ya no se puede corregir.`);
  const list = Array.isArray(req.body.passengers) ? req.body.passengers : [];
  const changes = [];
  b.passengers.forEach((cur, i) => {
    if (!list[i]) return;
    const next = validatePassenger(list[i], cur, b.international, i + 1);
    const d = diff(cur, next);
    if (Object.keys(d).length) changes.push({ cur, next, d, n: i + 1 });
  });
  const contact = readContact(req.body.contact, b);
  const notes = [];
  const c = await applyContact(b, contact);
  if (c) notes.push(c);

  if (b.status === 'pendiente_pago') {
    for (const ch of changes) { await applyPassenger(ch.cur.id, ch.next); notes.push(diffText(ch.n, ch.d)); }
    if (notes.length) await log(b, 'Datos corregidos por el cliente. ' + notes.join('; '));
    return res.json({ applied: notes.length > 0, requested: 0, booking: publicBooking(await loadBooking('id = $1', [b.id])) });
  }

  // Boleto emitido: solicitud a revisión
  const reason = str(req.body.reason, 300);
  if (changes.length && reason.length < 5) throw new HttpError(400, 'Explica brevemente el motivo de la corrección.');
  for (const ch of changes) {
    if ((ch.d.first_name || ch.d.last_name) && nameEdits(ch.cur, ch.next) > MAX_NAME_EDIT) throw new HttpError(400, `Pasajero ${ch.n}: ${nameRuleMsg}`);
    const { rows } = await query("SELECT 1 FROM correction_requests WHERE passenger_id = $1 AND status = 'pendiente'", [ch.cur.id]);
    if (rows.length) throw new HttpError(400, `Pasajero ${ch.n}: ya tiene una solicitud de corrección en revisión.`);
  }
  for (const ch of changes) {
    const payload = Object.fromEntries(Object.entries(ch.d));
    await query("INSERT INTO correction_requests (booking_id, passenger_id, changes, reason, status) VALUES ($1,$2,$3,$4,'pendiente')",
      [b.id, ch.cur.id, JSON.stringify(payload), reason]);
    notes.push('Solicitud de corrección: ' + diffText(ch.n, ch.d));
  }
  if (notes.length) await log(b, notes.join('; '));
  res.json({ applied: !!c, requested: changes.length, booking: publicBooking(await loadBooking('id = $1', [b.id])) });
}));

// Agencia: corrección directa (con la misma regla de nombre si el boleto está emitido).
app.put('/api/staff/bookings/:id/correct', requireStaff, wrap(async (req, res) => {
  const b = await loadBooking('id = $1', [Number(req.params.id) || 0]);
  if (!b) throw new HttpError(404, 'Reserva no encontrada.');
  if (!['pendiente_pago', 'emitido', 'pago_revision'].includes(b.status)) throw new HttpError(400, `La reserva está "${b.status_label}" y no se puede corregir.`);
  const list = Array.isArray(req.body.passengers) ? req.body.passengers : [];
  const notes = [];
  const pend = [];
  b.passengers.forEach((cur, i) => {
    if (!list[i]) return;
    const next = validatePassenger(list[i], cur, b.international, i + 1);
    const d = diff(cur, next);
    if (!Object.keys(d).length) return;
    if (b.status !== 'pendiente_pago' && (d.first_name || d.last_name) && nameEdits(cur, next) > MAX_NAME_EDIT) throw new HttpError(400, `Pasajero ${i + 1}: ${nameRuleMsg}`);
    pend.push({ cur, next, d, n: i + 1 });
  });
  const contact = readContact(req.body.contact, b);
  for (const p of pend) { await applyPassenger(p.cur.id, p.next); notes.push(diffText(p.n, p.d)); }
  const c = await applyContact(b, contact);
  if (c) notes.push(c);
  const reason = str(req.body.reason, 200);
  if (notes.length) await log(b, 'Corrección en agencia' + (reason ? ` (${reason})` : '') + '. ' + notes.join('; '), req.session.user.name);
  res.json(await loadBooking('id = $1', [b.id]));
}));

app.get('/api/staff/corrections', requireStaff, wrap(async (req, res) => {
  const st = ['pendiente', 'aprobada', 'rechazada'].includes(req.query.status) ? req.query.status : 'pendiente';
  const { rows } = await query(
    `SELECT c.*, b.code, b.status AS booking_status, p.first_name, p.last_name FROM correction_requests c
     JOIN bookings b ON b.id = c.booking_id JOIN passengers p ON p.id = c.passenger_id
     WHERE c.status = $1 ORDER BY c.id DESC LIMIT 200`, [st]);
  res.json(rows.map((r) => ({ id: r.id, booking_id: r.booking_id, code: r.code, booking_status: r.booking_status,
    passenger: `${r.first_name} ${r.last_name}`, changes: JSON.parse(r.changes), fields: PAX_FIELDS, reason: r.reason,
    status: r.status, response: r.response, resolved_by: r.resolved_by, resolved_at: r.resolved_at, created_at: r.created_at })));
}));

app.post('/api/staff/corrections/:id/resolve', requireStaff, wrap(async (req, res) => {
  const { rows } = await query('SELECT * FROM correction_requests WHERE id = $1', [Number(req.params.id) || 0]);
  const cr = rows[0];
  if (!cr) throw new HttpError(404, 'Solicitud no encontrada.');
  if (cr.status !== 'pendiente') throw new HttpError(400, 'Esta solicitud ya fue resuelta.');
  const approve = req.body.approve === true;
  const response = str(req.body.response, 300);
  if (!approve && response.length < 3) throw new HttpError(400, 'Escribe el motivo del rechazo para el cliente.');
  const b = await loadBooking('id = $1', [cr.booking_id]);
  const idx = b.passengers.findIndex((p) => p.id === cr.passenger_id);
  const cur = b.passengers[idx];
  if (approve) {
    const changes = JSON.parse(cr.changes);
    const input = Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.to]));
    const next = validatePassenger(input, cur, b.international, idx + 1);
    if ((changes.first_name || changes.last_name) && nameEdits(cur, next) > MAX_NAME_EDIT) throw new HttpError(400, nameRuleMsg);
    await applyPassenger(cur.id, next);
  }
  await query('UPDATE correction_requests SET status=$1, response=$2, resolved_by=$3, resolved_at=NOW() WHERE id=$4',
    [approve ? 'aprobada' : 'rechazada', response || null, req.session.user.name, cr.id]);
  await log(b, `Solicitud de corrección del pasajero ${idx + 1} ${approve ? 'aprobada' : 'rechazada'}${response ? ': ' + response : ''}`, req.session.user.name);
  res.json({ ok: true });
}));

// ---------- personal ----------
app.get('/api/staff/bookings', requireStaff, wrap(async (req, res) => {
  await expireOld();
  const params = [], where = [];
  const q = norm(req.query.q).slice(0, 60);
  if (q) {
    params.push('%' + q + '%');
    where.push(`(LOWER(b.code) LIKE $1 OR LOWER(b.contact_name) LIKE $1 OR LOWER(b.contact_email) LIKE $1
      OR b.id IN (SELECT booking_id FROM passengers WHERE LOWER(last_name) LIKE $1 OR LOWER(first_name) LIKE $1 OR LOWER(doc_number) LIKE $1))`);
  }
  if (STATUS[req.query.status]) { params.push(req.query.status); where.push(`b.status = $${params.length}`); }
  const { rows } = await query(`SELECT b.* FROM bookings b ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY b.id DESC LIMIT 300`, params);
  const ids = rows.map((r) => r.id);
  const segs = ids.length ? (await query(`SELECT booking_id, origin, destination, flight_date, airline, flight_no FROM segments WHERE booking_id IN (${ids.join(',')}) ORDER BY id`)).rows : [];
  res.json(rows.map((b) => ({
    id: b.id, code: b.code, status: b.status, status_label: STATUS[b.status], contact_name: b.contact_name,
    pax_count: b.pax_count, total: Number(b.total), paid_amount: Number(b.paid_amount || 0), origin: b.origin, created_at: b.created_at, expires_at: b.expires_at,
    segments: segs.filter((s) => s.booking_id === b.id).map((s) => ({ route: s.origin + '–' + s.destination, date: s.flight_date, flight: s.airline + ' ' + s.flight_no })),
  })));
}));

app.get('/api/staff/bookings/:id', requireStaff, wrap(async (req, res) => {
  await expireOld();
  const b = await loadBooking('id = $1', [Number(req.params.id) || 0]);
  if (!b) throw new HttpError(404, 'Reserva no encontrada.');
  res.json(b);
}));

// Emite los boletos de una reserva pagada (idempotente).
async function issueBooking(bookingId, { method, ref, userName, note }) {
  const { rows } = await query('SELECT * FROM bookings WHERE id = $1', [bookingId]);
  const b = rows[0];
  if (!b) throw new HttpError(404, 'Reserva no encontrada.');
  if (b.status === 'emitido' || b.status === 'pago_revision') return b.status;
  const { rows: pax } = await query('SELECT id, ticket_number FROM passengers WHERE booking_id = $1 ORDER BY id', [b.id]);
  for (const p of pax) {
    if (!p.ticket_number) await query('UPDATE passengers SET ticket_number = $1 WHERE id = $2', ['0' + String(crypto.randomInt(100000000, 999999999)) + String(crypto.randomInt(1000, 9999)), p.id]);
  }
  await query("UPDATE bookings SET status = 'emitido', payment_method = $1, payment_ref = $2, paid_at = NOW(), updated_at = NOW() WHERE id = $3", [method, ref || null, b.id]);
  await query('INSERT INTO booking_events (booking_id, status, note, user_name) VALUES ($1,$2,$3,$4)',
    [b.id, 'emitido', `Pago recibido: ${method}. ${note || ''}`.trim(), userName || null]);
  return 'emitido';
}

// Pago en línea confirmado por Stripe: valida el monto y emite. Si la reserva ya no está vigente
// (cancelada, o vencida y sin asientos), la marca para revisión y reembolso manual.
const ONLINE_METHOD = 'Tarjeta en línea (Stripe)';
const fmt = (n) => Number(n).toFixed(2);

// Guarda un pago. Devuelve false si esa referencia ya estaba registrada (aviso repetido de Stripe).
async function insertPayment(bookingId, { amount, method, ref = null, note = null, userName = null }) {
  if (ref && (await query('SELECT 1 FROM payments WHERE ref = $1', [ref])).rows.length) return false;
  try {
    await query('INSERT INTO payments (booking_id, amount, method, ref, note, user_name) VALUES ($1,$2,$3,$4,$5,$6)',
      [bookingId, amount, method, ref, note || null, userName]);
  } catch (e) {
    if (e.code === '23505' || /duplicate|unique/i.test(e.message)) return false;
    throw e;
  }
  await query('UPDATE bookings SET paid_amount = COALESCE(paid_amount, 0) + $1, updated_at = NOW() WHERE id = $2', [amount, bookingId]);
  return true;
}

// Registra el pago del total pendiente y emite los boletos (solo se acepta el pago completo).
async function recordPayment(bookingId, { amount, method, ref = null, userName = null, note = '' }) {
  const b = await loadBooking('id = $1', [bookingId]);
  if (!b) throw new HttpError(404, 'Reserva no encontrada.');
  if (b.status !== 'pendiente_pago') throw new HttpError(400, `No se puede registrar el pago: la reserva está "${b.status_label}".`);
  amount = money(amount);
  if (Math.abs(amount - b.balance) > 0.005) throw new HttpError(400, `El pago debe ser por el total (${fmt(b.balance)} USD).`);
  if (!(await insertPayment(b.id, { amount, method, ref, note, userName }))) return b.status;
  return issueBooking(b.id, { method, ref, userName, note });
}

// Pago en línea confirmado por Stripe. Si la reserva ya no está vigente (cancelada, o vencida y sin
// asientos) o el monto no es el total, se guarda el pago y se marca para revisión.
async function settleOnlinePayment(session) {
  const code = session?.metadata?.booking_code || session?.client_reference_id;
  if (!code || session.payment_status !== 'paid') return null;
  const { rows } = await query('SELECT * FROM bookings WHERE code = $1', [code]);
  const b = rows[0];
  if (!b) return null;
  const ref = session.payment_intent || session.id;
  if ((await query('SELECT 1 FROM payments WHERE ref = $1', [ref])).rows.length) return b.status;
  const amount = money(Number(session.amount_total) / 100);
  const balance = money(Number(b.total) - Number(b.paid_amount || 0));
  let problem = null;
  if (b.status === 'emitido' || b.status === 'pago_revision') problem = 'Se recibió un pago en línea, pero la reserva ya estaba pagada.';
  else if (Math.abs(amount - balance) > 0.005) problem = `Monto pagado (${fmt(amount)}) distinto al total (${fmt(balance)}).`;
  else if (b.status === 'cancelado') problem = 'La reserva estaba cancelada al recibir el pago.';
  else if (b.status === 'vencido') {
    const { rows: segs } = await query('SELECT route_id, flight_date FROM segments WHERE booking_id = $1', [b.id]);
    for (const sg of segs) {
      const { rows: r } = await query('SELECT seats FROM routes WHERE id = $1', [sg.route_id]);
      if (!r[0] || r[0].seats - (await seatsTaken(sg.route_id, sg.flight_date)) < b.pax_count) { problem = 'La reserva venció y ya no hay asientos suficientes.'; break; }
    }
    // Hay lugar: se reactiva la reserva para aplicar el pago.
    if (!problem) await query("UPDATE bookings SET status = 'pendiente_pago', expires_at = $1 WHERE id = $2", [new Date(Date.now() + 3600 * 1000), b.id]);
  }
  if (problem) {
    if (!(await insertPayment(b.id, { amount, method: ONLINE_METHOD, ref, note: 'En revisión: ' + problem }))) return b.status;
    const status = b.status === 'emitido' ? 'emitido' : 'pago_revision';
    await query('UPDATE bookings SET status = $1, payment_method = COALESCE(payment_method, $2), payment_ref = COALESCE(payment_ref, $3), paid_at = COALESCE(paid_at, NOW()), updated_at = NOW() WHERE id = $4', [status, ONLINE_METHOD, ref, b.id]);
    await query('INSERT INTO booking_events (booking_id, status, note) VALUES ($1,$2,$3)', [b.id, status, problem + ' Revisar y reembolsar desde Stripe si aplica.']);
    return status;
  }
  const result = await recordPayment(b.id, { amount, method: ONLINE_METHOD, ref, note: 'Ref. ' + ref });
  // Reservas hechas por WhatsApp: aviso automático de boletos emitidos.
  if (result === 'emitido' && b.origin === 'whatsapp') bot.notifyIssued(b.id).catch((e) => console.error('[whatsapp] aviso de pago', e.message));
  return result;
}

// ---------- pago en línea ----------
const baseUrl = (req) => (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

app.post('/api/bookings/:code/checkout', wrap(async (req, res) => {
  if (!payments.enabled()) throw new HttpError(503, 'El pago en línea no está disponible en este momento. Intenta más tarde.');
  await expireOld();
  const code = str(req.params.code, 10).toUpperCase();
  const b = await loadBooking('code = $1', [code]);
  const last = norm(req.body.last_name);
  if (!b || !last || !b.passengers.some((p) => norm(p.last_name) === last || norm(p.last_name).split(/\s+/).includes(last))) {
    throw new HttpError(404, 'No encontramos la reserva.');
  }
  res.json({ url: await startCheckout(b, baseUrl(req)) });
}));

// Crea la página de pago de Stripe por el total pendiente y devuelve su enlace.
async function startCheckout(b, base, via = 'en línea') {
  if (!payments.enabled()) throw new HttpError(503, 'El pago en línea no está disponible en este momento. Intenta más tarde.');
  if (b.status !== 'pendiente_pago') throw new HttpError(400, `Esta reserva está "${b.status_label}" y no se puede pagar.`);
  // Siempre se cobra el total pendiente (no hay pagos parciales).
  const amount = b.balance;
  if (!(amount > 0)) throw new HttpError(400, 'Esta reserva no tiene monto por pagar.');
  // Stripe exige que la sesión expire entre 30 min y 24 h.
  const exp = new Date(Math.max(Date.now() + 31 * 60 * 1000, Math.min(new Date(b.expires_at).getTime(), Date.now() + 23.5 * 3600 * 1000)));
  const desc = b.segments.map((sg) => `${sg.flight_no} ${sg.origin}-${sg.destination} ${sg.date}`).join(' / ') + ` · ${b.pax_count} pasajero(s)`;
  const session = await payments.createCheckout({
    booking: b, amount, description: desc, expiresAt: exp,
    successUrl: `${base}/reserva?code=${b.code}&session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${base}/reserva?code=${b.code}&pago=cancelado`,
  });
  await query('UPDATE bookings SET stripe_session_id = $1 WHERE id = $2', [session.id, b.id]);
  await query('INSERT INTO booking_events (booking_id, status, note) VALUES ($1,$2,$3)', [b.id, 'pendiente_pago', `El cliente inició el pago ${via} (${fmt(amount)} USD)`]);
  return session.url;
}

// Regreso desde Stripe: se verifica el pago directamente con Stripe antes de emitir.
app.post('/api/payments/confirm', wrap(async (req, res) => {
  if (!payments.enabled()) throw new HttpError(503, 'Pago en línea no disponible.');
  const sid = str(req.body.session_id, 200);
  const code = str(req.body.code, 10).toUpperCase();
  if (!/^cs_[A-Za-z0-9_]+$/.test(sid)) throw new HttpError(400, 'Sesión de pago inválida.');
  const { rows } = await query('SELECT stripe_session_id FROM bookings WHERE code = $1', [code]);
  if (!rows[0] || rows[0].stripe_session_id !== sid) throw new HttpError(404, 'No encontramos ese pago.');
  const session = await payments.getCheckout(sid);
  if (session.payment_status === 'paid') await settleOnlinePayment(session);
  const b = await loadBooking('code = $1', [code]);
  res.json({ paid: session.payment_status === 'paid', booking: publicBooking(b) });
}));

app.post('/api/stripe/webhook', wrap(async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  if (!payments.verifyWebhook(raw, req.get('stripe-signature'), process.env.STRIPE_WEBHOOK_SECRET)) {
    return res.status(400).send('Firma inválida');
  }
  const event = JSON.parse(raw);
  if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
    await settleOnlinePayment(event.data.object);
  }
  res.json({ received: true });
}));

app.post('/api/staff/bookings/:id/cancel', requireStaff, wrap(async (req, res) => {
  const b = await loadBooking('id = $1', [Number(req.params.id) || 0]);
  if (!b) throw new HttpError(404, 'Reserva no encontrada.');
  const admin = req.session.user.role === 'admin';
  // Con dinero recibido (boleto emitido o en revisión) solo cancela un administrador.
  const withMoney = b.paid_amount > 0 || ['emitido', 'pago_revision'].includes(b.status);
  if (withMoney && !admin && ['pendiente_pago', 'emitido', 'pago_revision', 'vencido'].includes(b.status)) {
    throw new HttpError(400, b.status === 'emitido' ? 'Solo un administrador puede cancelar un boleto emitido.' : 'Esta reserva ya tiene pagos: solo un administrador puede cancelarla.');
  }
  if (['pendiente_pago', 'emitido', 'pago_revision'].includes(b.status) || (b.status === 'vencido' && b.paid_amount > 0)) {
    await query("UPDATE bookings SET status = 'cancelado', updated_at = NOW() WHERE id = $1", [b.id]);
    const online = b.payments.filter((p) => p.method === ONLINE_METHOD).reduce((t, p) => t + p.amount, 0);
    const refundNote = b.paid_amount > 0
      ? `Se habían recibido ${fmt(b.paid_amount)} USD: reembolsar o aplicar según la política${online ? ` (${fmt(online)} USD en línea: reembolsar desde el panel de Stripe)` : ''}.`
      : null;
    await query('INSERT INTO booking_events (booking_id, status, note, user_name) VALUES ($1,$2,$3,$4)',
      [b.id, 'cancelado', [str(req.body.note, 200), refundNote].filter(Boolean).join(' ') || null, req.session.user.name]);
    return res.json({ ok: true });
  }
  throw new HttpError(400, b.status === 'emitido' ? 'Solo un administrador puede cancelar un boleto emitido.' : 'Esta reserva ya no se puede cancelar.');
}));

app.get('/api/staff/stats', requireStaff, wrap(async (req, res) => {
  await expireOld();
  const { rows } = await query('SELECT status, COUNT(*)::int AS n, COALESCE(SUM(total),0) AS total, COALESCE(SUM(pax_count),0) AS pax FROM bookings GROUP BY status');
  res.json(rows.map((r) => ({ status: r.status, label: STATUS[r.status], n: Number(r.n), total: Number(r.total), pax: Number(r.pax) })));
}));

// ---------- calendario de precios (público) ----------
const monthRange = (m) => {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m || '')) throw new HttpError(400, 'Mes inválido (AAAA-MM).');
  const first = m + '-01';
  const [y, mo] = m.split('-').map(Number);
  const last = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
  return { first, last };
};

app.get('/api/price-calendar', wrap(async (req, res) => {
  const from = str(req.query.from, 3).toUpperCase(), to = str(req.query.to, 3).toUpperCase();
  const pax = Math.min(MAX_PAX, Math.max(1, Number(req.query.pax) || 1));
  const { first, last } = monthRange(str(req.query.month, 7));
  const start = first < todayStr() ? todayStr() : first;
  const end = [last, addDays(todayStr(), 330)].sort()[0];
  await expireOld();
  const { rows: routes } = await query(
    `SELECT r.* FROM routes r JOIN airlines a ON a.code = r.airline
     WHERE r.active = TRUE AND a.active = TRUE AND r.origin = $1 AND r.destination = $2`, [from, to]);
  const taken = {};
  if (routes.length && start <= end) {
    const { rows } = await query(
      `SELECT s.route_id, s.flight_date, SUM(b.pax_count) AS n FROM segments s JOIN bookings b ON b.id = s.booking_id
       WHERE s.route_id IN (${routes.map((r) => Number(r.id)).join(',')}) AND s.flight_date >= $1 AND s.flight_date <= $2
         AND (b.status IN ('emitido', 'pago_revision') OR (b.status = 'pendiente_pago' AND b.expires_at > NOW()))
       GROUP BY s.route_id, s.flight_date`, [start, end]);
    for (const r of rows) taken[r.route_id + '|' + r.flight_date] = Number(r.n);
  }
  const days = [];
  for (let d = first; d <= last; d = addDays(d, 1)) {
    if (d < start || d > end) { days.push({ date: d, price: null, flights: 0, past: d < start }); continue; }
    const wd = String(weekday(d));
    const ok = routes.filter((r) => r.days.includes(wd) && r.seats - (taken[r.id + '|' + d] || 0) >= pax);
    days.push({ date: d, flights: ok.length, price: ok.length ? Math.min(...ok.map((r) => farePrice(r.base_price, 'basica', d))) : null });
  }
  const prices = days.map((x) => x.price).filter((p) => p !== null);
  res.json({ month: first.slice(0, 7), days, min: prices.length ? Math.min(...prices) : null, max: prices.length ? Math.max(...prices) : null, has_route: routes.length > 0 });
}));

// ---------- pagos (personal) ----------
app.get('/api/staff/payments', requireStaff, wrap(async (req, res) => {
  await expireOld();
  const today = todayStr();
  const from = isDate(req.query.from) ? req.query.from : addDays(today, -30);
  const to = isDate(req.query.to) ? req.query.to : today;
  const method = str(req.query.method, 40);
  const params = [new Date(from + 'T00:00:00Z'), new Date(addDays(to, 1) + 'T00:00:00Z')];
  let extra = '';
  if (method) { params.push(method); extra = ' AND p.method = $3'; }
  const { rows } = await query(
    `SELECT p.*, b.code, b.contact_name, b.status FROM payments p JOIN bookings b ON b.id = p.booking_id
     WHERE p.created_at >= $1 AND p.created_at < $2${extra} ORDER BY p.created_at DESC LIMIT 1000`, params);
  const list = rows.map((p) => ({ id: p.id, at: p.created_at, amount: Number(p.amount), method: p.method, ref: p.ref, note: p.note, user_name: p.user_name,
    booking_id: p.booking_id, code: p.code, contact_name: p.contact_name, status: p.status, status_label: STATUS[p.status] }));
  const byMethod = {};
  for (const p of list) { const m = (byMethod[p.method] = byMethod[p.method] || { method: p.method, n: 0, total: 0 }); m.n++; m.total = money(m.total + p.amount); }
  // Resumen: hoy, semana (desde el lunes) y mes en curso.
  const monday = addDays(today, 1 - weekday(today));
  const { rows: sum } = await query(
    `SELECT
       COALESCE(SUM(CASE WHEN created_at >= $1 THEN amount ELSE 0 END), 0) AS day,
       COALESCE(SUM(CASE WHEN created_at >= $2 THEN amount ELSE 0 END), 0) AS week,
       COALESCE(SUM(amount), 0) AS month
     FROM payments WHERE created_at >= $3`,
    [new Date(today + 'T00:00:00Z'), new Date(monday + 'T00:00:00Z'), new Date([today.slice(0, 7) + '-01', monday].sort()[0] + 'T00:00:00Z')]);
  const { rows: monthRows } = await query('SELECT COALESCE(SUM(amount), 0) AS t FROM payments WHERE created_at >= $1', [new Date(today.slice(0, 7) + '-01T00:00:00Z')]);
  res.json({ from, to, method, rows: list, total: money(list.reduce((t, p) => t + p.amount, 0)), by_method: Object.values(byMethod),
    summary: { day: Number(sum[0].day), week: Number(sum[0].week), month: Number(monthRows[0].t) },
    methods: [...new Set([ONLINE_METHOD, ...(await query('SELECT DISTINCT method FROM payments ORDER BY method')).rows.map((r) => r.method)])] });
}));

// ---------- calendario de la agencia ----------
app.get('/api/staff/calendar', requireStaff, wrap(async (req, res) => {
  await expireOld();
  const { first, last } = monthRange(str(req.query.month, 7));
  const t0 = new Date(first + 'T00:00:00Z'), t1 = new Date(addDays(last, 1) + 'T00:00:00Z');
  const [{ rows: dep }, { rows: exp }, { rows: pay }] = await Promise.all([
    query(`SELECT s.flight_date, s.dep_time, s.origin, s.destination, s.airline, s.flight_no, b.id, b.code, b.pax_count, b.status, b.contact_name
      FROM segments s JOIN bookings b ON b.id = s.booking_id
      WHERE s.flight_date >= $1 AND s.flight_date <= $2 AND b.status IN ('emitido', 'pendiente_pago', 'pago_revision') ORDER BY s.flight_date, s.dep_time LIMIT 3000`, [first, last]),
    query(`SELECT id, code, contact_name, total, paid_amount, expires_at FROM bookings
      WHERE status = 'pendiente_pago' AND expires_at >= $1 AND expires_at < $2 ORDER BY expires_at`, [t0, t1]),
    query('SELECT amount, created_at FROM payments WHERE created_at >= $1 AND created_at < $2', [t0, t1]),
  ]);
  const days = {};
  const day = (d) => (days[d] = days[d] || { departures: [], expiring: [], payments: { n: 0, total: 0 } });
  for (const s of dep) day(s.flight_date).departures.push({ booking_id: s.id, code: s.code, contact_name: s.contact_name, pax: s.pax_count, status: s.status, status_label: STATUS[s.status],
    route: s.origin + '–' + s.destination, flight: s.airline + ' ' + s.flight_no, time: s.dep_time });
  for (const b of exp) day(new Date(b.expires_at).toISOString().slice(0, 10)).expiring.push({ booking_id: b.id, code: b.code, contact_name: b.contact_name,
    balance: money(Number(b.total) - Number(b.paid_amount || 0)), at: b.expires_at });
  for (const p of pay) { const x = day(new Date(p.created_at).toISOString().slice(0, 10)).payments; x.n++; x.total = money(x.total + Number(p.amount)); }
  res.json({ month: first.slice(0, 7), days });
}));

// ---------- administrador ----------
app.get('/api/admin/catalog', requireAdmin, wrap(async (req, res) => {
  const [a, l, r, s] = await Promise.all([
    query('SELECT * FROM airports ORDER BY country, city'), query('SELECT * FROM airlines ORDER BY name'),
    query('SELECT * FROM routes ORDER BY airline, flight_no'), getSettings()]);
  res.json({ airports: a.rows.map((x) => ({ ...x, utc_offset: Number(x.utc_offset) })), airlines: l.rows,
    routes: r.rows.map((x) => ({ ...x, base_price: Number(x.base_price) })), settings: s });
}));

app.put('/api/admin/settings', requireAdmin, wrap(async (req, res) => {
  const tax = Number(req.body.tax_rate), hold = Number(req.body.hold_hours), fee = Number(req.body.service_fee);
  if (!(tax >= 0 && tax <= 1)) throw new HttpError(400, 'Impuesto entre 0 y 100 %.');
  if (!(hold >= 1 && hold <= 168)) throw new HttpError(400, 'Plazo de pago entre 1 y 168 horas.');
  if (!(fee >= 0 && fee <= 500)) throw new HttpError(400, 'Cargo por servicio inválido.');
  const seatVals = ['seat_std', 'seat_front', 'seat_exit'].map((k) => [k, req.body[k] === undefined ? null : Number(req.body[k])]);
  for (const [k, v] of seatVals) { if (v !== null && !(v >= 0 && v <= 500)) throw new HttpError(400, 'Precio de asiento inválido.'); if (v !== null) await query('UPDATE settings SET value = $1 WHERE key = $2', [String(v), k]); }
  if (req.body.whatsapp !== undefined) {
    // Número de WhatsApp de la empresa: solo dígitos, con código de país (8 a 15). Vacío = sin WhatsApp.
    const wa = String(req.body.whatsapp || '').replace(/\D/g, '');
    if (wa && (wa.length < 8 || wa.length > 15)) throw new HttpError(400, 'WhatsApp: escribe el número con código de país (ej. 52 55 1234 5678).');
    const { rows } = await query('SELECT 1 FROM settings WHERE key = $1', ['whatsapp']);
    if (rows.length) await query('UPDATE settings SET value = $1 WHERE key = $2', [wa, 'whatsapp']);
    else await query('INSERT INTO settings (key, value) VALUES ($1, $2)', ['whatsapp', wa]);
  }
  for (const [k, v] of [['tax_rate', tax], ['hold_hours', hold], ['service_fee', fee]]) await query('UPDATE settings SET value = $1 WHERE key = $2', [String(v), k]);
  res.json(await getSettings());
}));

app.post('/api/admin/airlines', requireAdmin, wrap(async (req, res) => {
  const code = str(req.body.code, 3).toUpperCase(), name = str(req.body.name, 80);
  const color = /^#[0-9a-f]{6}$/i.test(req.body.color || '') ? req.body.color : '#0b6e5f';
  if (!/^[A-Z0-9]{2,3}$/.test(code)) throw new HttpError(400, 'Código de 2 o 3 letras/números (ej. AM).');
  if (name.length < 2) throw new HttpError(400, 'Escribe el nombre.');
  const { rows } = await query('SELECT 1 FROM airlines WHERE code = $1', [code]);
  if (rows.length) throw new HttpError(400, 'Ese código ya existe.');
  await query('INSERT INTO airlines (code, name, color, country, demo) VALUES ($1,$2,$3,$4,FALSE)', [code, name, color, str(req.body.country, 60) || null]);
  res.status(201).json({ ok: true });
}));
app.put('/api/admin/airlines/:code', requireAdmin, wrap(async (req, res) => {
  const { rows } = await query('SELECT * FROM airlines WHERE code = $1', [str(req.params.code, 3).toUpperCase()]);
  const a = rows[0]; if (!a) throw new HttpError(404, 'No encontrada.');
  const name = str(req.body.name, 80) || a.name;
  const color = /^#[0-9a-f]{6}$/i.test(req.body.color || '') ? req.body.color : a.color;
  const active = typeof req.body.active === 'boolean' ? req.body.active : a.active;
  const country = req.body.country !== undefined ? str(req.body.country, 60) || null : a.country;
  await query('UPDATE airlines SET name=$1, color=$2, active=$3, country=$4 WHERE code=$5', [name, color, active, country, a.code]);
  res.json({ ok: true });
}));

app.post('/api/admin/airports', requireAdmin, wrap(async (req, res) => {
  const code = str(req.body.code, 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new HttpError(400, 'Código IATA de 3 letras.');
  const city = str(req.body.city, 60), name = str(req.body.name, 100), country = str(req.body.country, 60);
  const off = Number(req.body.utc_offset);
  if (!city || !name || !country) throw new HttpError(400, 'Completa ciudad, nombre y país.');
  if (!(off >= -12 && off <= 14)) throw new HttpError(400, 'Diferencia horaria UTC inválida.');
  const { rows } = await query('SELECT 1 FROM airports WHERE code = $1', [code]);
  if (rows.length) throw new HttpError(400, 'Ese aeropuerto ya existe.');
  await query('INSERT INTO airports (code, city, name, country, utc_offset) VALUES ($1,$2,$3,$4,$5)', [code, city, name, country, off]);
  res.status(201).json({ ok: true });
}));
app.put('/api/admin/airports/:code', requireAdmin, wrap(async (req, res) => {
  const { rows } = await query('SELECT * FROM airports WHERE code = $1', [str(req.params.code, 3).toUpperCase()]);
  const a = rows[0]; if (!a) throw new HttpError(404, 'No encontrado.');
  const off = req.body.utc_offset !== undefined ? Number(req.body.utc_offset) : Number(a.utc_offset);
  if (!(off >= -12 && off <= 14)) throw new HttpError(400, 'Diferencia horaria UTC inválida.');
  const active = typeof req.body.active === 'boolean' ? req.body.active : a.active;
  await query('UPDATE airports SET utc_offset=$1, active=$2 WHERE code=$3', [off, active, a.code]);
  res.json({ ok: true });
}));

async function readRoute(body) {
  const r = {
    airline: str(body.airline, 3).toUpperCase(), flight_no: str(body.flight_no, 6),
    origin: str(body.origin, 3).toUpperCase(), destination: str(body.destination, 3).toUpperCase(),
    dep_time: str(body.dep_time, 5), duration_min: Math.round(Number(body.duration_min)),
    days: [...new Set(String(body.days || '').replace(/[^1-7]/g, ''))].sort().join(''),
    seats: Math.round(Number(body.seats)), base_price: money(body.base_price),
    active: typeof body.active === 'boolean' ? body.active : true,
  };
  const [ap, al] = await Promise.all([airportMap(), airlineMap()]);
  if (!al[r.airline]) throw new HttpError(400, 'Aerolínea inválida.');
  if (!/^\d{1,4}[A-Z]?$/.test(r.flight_no)) throw new HttpError(400, 'Número de vuelo: hasta 4 dígitos (ej. 123).');
  if (!ap[r.origin] || !ap[r.destination] || r.origin === r.destination) throw new HttpError(400, 'Origen y destino inválidos.');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(r.dep_time)) throw new HttpError(400, 'Hora de salida HH:MM.');
  if (!(r.duration_min >= 20 && r.duration_min <= 1200)) throw new HttpError(400, 'Duración entre 20 y 1200 minutos.');
  if (!r.days) throw new HttpError(400, 'Elige al menos un día de operación.');
  if (!(r.seats >= 1 && r.seats <= 900)) throw new HttpError(400, 'Asientos entre 1 y 900.');
  if (!(r.base_price > 0)) throw new HttpError(400, 'Precio base inválido.');
  return r;
}
app.post('/api/admin/routes', requireAdmin, wrap(async (req, res) => {
  const r = await readRoute(req.body);
  await query(`INSERT INTO routes (airline, flight_no, origin, destination, dep_time, duration_min, days, seats, base_price, active)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [r.airline, r.flight_no, r.origin, r.destination, r.dep_time, r.duration_min, r.days, r.seats, r.base_price, r.active]);
  res.status(201).json({ ok: true });
}));
app.put('/api/admin/routes/:id', requireAdmin, wrap(async (req, res) => {
  const id = Number(req.params.id) || 0;
  const { rows } = await query('SELECT 1 FROM routes WHERE id = $1', [id]);
  if (!rows.length) throw new HttpError(404, 'Ruta no encontrada.');
  const r = await readRoute(req.body);
  await query(`UPDATE routes SET airline=$1, flight_no=$2, origin=$3, destination=$4, dep_time=$5, duration_min=$6, days=$7, seats=$8, base_price=$9, active=$10 WHERE id=$11`,
    [r.airline, r.flight_no, r.origin, r.destination, r.dep_time, r.duration_min, r.days, r.seats, r.base_price, r.active, id]);
  res.json({ ok: true });
}));

app.get('/api/admin/users', requireAdmin, wrap(async (req, res) => {
  res.json((await query('SELECT id, username, name, role, active FROM users ORDER BY id')).rows);
}));
app.post('/api/admin/users', requireAdmin, wrap(async (req, res) => {
  const username = str(req.body.username, 40).toLowerCase(), name = str(req.body.name, 80);
  const role = req.body.role === 'admin' ? 'admin' : 'agent', password = String(req.body.password || '');
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) throw new HttpError(400, 'Usuario: 3-40 caracteres (letras, números, . _ -).');
  if (name.length < 2) throw new HttpError(400, 'Escribe el nombre.');
  if (password.length < 8) throw new HttpError(400, 'La contraseña debe tener al menos 8 caracteres.');
  if ((await query('SELECT 1 FROM users WHERE username = $1', [username])).rows.length) throw new HttpError(400, 'Ese usuario ya existe.');
  await query('INSERT INTO users (username, password_hash, name, role) VALUES ($1,$2,$3,$4)', [username, bcrypt.hashSync(password, 10), name, role]);
  res.status(201).json({ ok: true });
}));
app.put('/api/admin/users/:id', requireAdmin, wrap(async (req, res) => {
  const id = Number(req.params.id) || 0;
  if (!(await query('SELECT 1 FROM users WHERE id = $1', [id])).rows.length) throw new HttpError(404, 'Usuario no encontrado.');
  if (id === req.session.user.id && req.body.active === false) throw new HttpError(400, 'No puedes desactivar tu propio usuario.');
  if (typeof req.body.active === 'boolean') await query('UPDATE users SET active = $1 WHERE id = $2', [req.body.active, id]);
  if (req.body.password) {
    if (String(req.body.password).length < 8) throw new HttpError(400, 'La contraseña debe tener al menos 8 caracteres.');
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [bcrypt.hashSync(String(req.body.password), 10), id]);
  }
  res.json({ ok: true });
}));

// ---------- bot de ventas por WhatsApp ----------
const bot = createBot({
  query, searchFlights, createBooking, startCheckout, loadBooking, findForCustomer, getSettings,
  airports: async () => (await query('SELECT code, city, name, country FROM airports WHERE active = TRUE ORDER BY country, city')).rows,
  routesMap: async () => {
    const { rows } = await query(`SELECT DISTINCT r.origin, r.destination FROM routes r JOIN airlines a ON a.code = r.airline
      WHERE r.active = TRUE AND a.active = TRUE`);
    const m = {}; for (const r of rows) (m[r.origin] = m[r.origin] || []).push(r.destination);
    return m;
  },
  baseUrl: () => (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, ''),
  DOC_TYPES, MAX_PAX, todayStr, addDays, daysBetween, isDate, HttpError,
});

// Verificación del webhook al configurarlo en Meta (GET con hub.challenge).
app.get('/api/whatsapp/webhook', (req, res) => {
  const ok = req.query['hub.mode'] === 'subscribe' && process.env.WHATSAPP_VERIFY_TOKEN && req.query['hub.verify_token'] === process.env.WHATSAPP_VERIFY_TOKEN;
  if (!ok) return res.status(403).send('Token inválido');
  res.type('text/plain').send(String(req.query['hub.challenge'] || ''));
});
// Mensajes entrantes. Se valida la firma de Meta y se responde de inmediato; el bot procesa en segundo plano.
app.post('/api/whatsapp/webhook', (req, res) => {
  if (!wa.enabled()) return res.sendStatus(404);
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  if (!wa.verifySignature(raw, req.get('x-hub-signature-256'), process.env.WHATSAPP_APP_SECRET)) return res.status(401).send('Firma inválida');
  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch (_) { return res.sendStatus(400); }
  res.sendStatus(200);
  bot.handleWebhook(body);
});

// Respaldo: descarga todas las tablas en JSON (sin contraseñas). Solo administradores.
app.get('/api/admin/backup', requireAdmin, wrap(async (req, res) => {
  const tables = ['settings', 'airports', 'airlines', 'routes', 'bookings', 'segments', 'passengers', 'seat_assignments',
    'payments', 'correction_requests', 'booking_events'];
  const data = { created_at: new Date().toISOString(), app: 'VuelaLatino', tables: {} };
  for (const t of tables) data.tables[t] = (await query(`SELECT * FROM ${t} ORDER BY 1`)).rows;
  data.tables.users = (await query('SELECT id, username, name, role, active, created_at FROM users ORDER BY id')).rows;
  console.log(`[respaldo] descargado por ${req.session.user.username}`);
  res.set('Content-Disposition', `attachment; filename="vuelalatino-respaldo-${todayStr()}.json"`);
  res.json(data);
}));

// La página de citas ya no existe (la app es solo en línea).
app.get(['/cita', '/cita.html'], (req, res) => res.redirect(301, '/'));

app.get('/healthz', (req, res) => res.send('ok'));
app.use('/api', (req, res) => res.status(404).json({ error: 'No encontrado.' }));
// Página 404 para cualquier otra ruta.
app.use((req, res) => res.status(404).sendFile(path.join(__dirname, 'public', '404.html')));
app.use((err, req, res, next) => {
  const isApi = req.path.startsWith('/api');
  if (err instanceof HttpError) return res.status(err.code).json({ error: err.message });
  if (err.stripe) { console.error('[stripe]', err.message); return res.status(502).json({ error: 'No se pudo conectar con el procesador de pagos. Intenta de nuevo en unos minutos.' }); }
  // Errores del cliente (JSON mal formado, cuerpo muy grande): sin detalles técnicos.
  if (err.status >= 400 && err.status < 500) {
    return res.status(err.status).json({ error: err.status === 413 ? 'Los datos enviados son demasiado grandes.' : 'Solicitud inválida.' });
  }
  const ref = crypto.randomBytes(4).toString('hex');
  console.error(`[error ${ref}] ${new Date().toISOString()} ${req.method} ${req.originalUrl}\n`, err);
  if (isApi) return res.status(500).json({ error: `Error interno. Intenta de nuevo (referencia ${ref}).` });
  res.status(500).sendFile(path.join(__dirname, 'public', '500.html'));
});
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));

init().then(() => app.listen(PORT, () => console.log(`Servidor listo en http://localhost:${PORT}`)))
  .catch((e) => { console.error('No se pudo iniciar la base de datos', e); process.exit(1); });
