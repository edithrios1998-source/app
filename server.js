try { process.loadEnvFile('.env'); } catch (_) { /* .env es opcional */ }

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieSession = require('cookie-session');
const bcrypt = require('bcryptjs');
const { query, init } = require('./db');
const payments = require('./payments');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

// Tarifas: multiplicador sobre el precio base y lo que incluyen.
const FARES = {
  basica: { name: 'Básica', mult: 1, includes: ['1 artículo personal (bolso o mochila bajo el asiento)', 'Asiento asignado al documentar'], excludes: ['Maleta de mano', 'Maleta documentada', 'Cambios'] },
  clasica: { name: 'Clásica', mult: 1.3, includes: ['Artículo personal + maleta de mano 10 kg', '1 maleta documentada de 23 kg', 'Elección de asiento estándar', 'Cambios con cargo'], excludes: ['Reembolso'] },
  flexible: { name: 'Flexible', mult: 1.75, includes: ['Artículo personal + maleta de mano 10 kg', '2 maletas documentadas de 23 kg', 'Cambios sin cargo', 'Reembolso con cargo', 'Abordaje prioritario'], excludes: [] },
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

app.set('trust proxy', 1);
app.use('/api/stripe/webhook', express.raw({ type: '*/*', limit: '1mb' }));
app.use(express.json({ limit: '100kb' }));
app.use(cookieSession({
  name: 'vl_sess', secret: process.env.SESSION_SECRET || 'dev-only-secret-change-me',
  httpOnly: true, sameSite: 'lax', secure: IS_PROD, maxAge: 12 * 60 * 60 * 1000,
}));
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'same-origin');
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

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
  return { tax_rate: Number(s.tax_rate), hold_hours: Number(s.hold_hours), service_fee: Number(s.service_fee) };
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
  const [{ rows: segs }, { rows: pax }, { rows: ev }, ap, al] = await Promise.all([
    query('SELECT * FROM segments WHERE booking_id = $1 ORDER BY id', [b.id]),
    query('SELECT * FROM passengers WHERE booking_id = $1 ORDER BY id', [b.id]),
    query('SELECT * FROM booking_events WHERE booking_id = $1 ORDER BY id', [b.id]),
    airportMap(), airlineMap(),
  ]);
  return {
    id: b.id, code: b.code, status: b.status, status_label: STATUS[b.status],
    contact_name: b.contact_name, contact_email: b.contact_email, contact_phone: b.contact_phone,
    pax_count: b.pax_count, subtotal: Number(b.subtotal), taxes: Number(b.taxes), total: Number(b.total),
    origin: b.origin, expires_at: b.expires_at, created_at: b.created_at, updated_at: b.updated_at,
    payment_method: b.payment_method, payment_ref: b.payment_ref, paid_at: b.paid_at,
    segments: segs.map((s) => ({
      airline: { code: s.airline, name: al[s.airline]?.name || s.airline, color: al[s.airline]?.color || '#333' },
      flight_no: s.airline + ' ' + s.flight_no, date: s.flight_date, origin: s.origin, destination: s.destination,
      origin_city: ap[s.origin]?.city, destination_city: ap[s.destination]?.city,
      origin_name: ap[s.origin]?.name, destination_name: ap[s.destination]?.name,
      dep_time: s.dep_time, arr_time: s.arr_time, arr_offset: s.arr_offset, duration_min: s.duration_min,
      fare: s.fare, fare_name: FARES[s.fare]?.name, fare_includes: FARES[s.fare]?.includes || [], price_per_pax: Number(s.price_per_pax),
    })),
    passengers: pax.map((p) => ({
      first_name: p.first_name, last_name: p.last_name, birth_date: p.birth_date, gender: p.gender,
      nationality: p.nationality, doc_type: p.doc_type, doc_number: p.doc_number, ticket_number: p.ticket_number,
    })),
    events: ev.map((e) => ({ status: e.status, label: STATUS[e.status], note: e.note, user_name: e.user_name, at: e.created_at })),
  };
}

// Vista pública: oculta documentos completos.
function publicBooking(b) {
  const mask = (s) => (s && s.length > 3 ? '•••' + s.slice(-3) : s);
  return { ...b, id: undefined, payment_ref: undefined, events: b.events.map(({ status, label, at }) => ({ status, label, at })),
    passengers: b.passengers.map((p) => ({ ...p, doc_number: mask(p.doc_number) })) };
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
  res.json({ ...s, online_payments: payments.enabled(), max_pax: MAX_PAX, doc_types: DOC_TYPES, statuses: STATUS, today: todayStr(),
    fares: Object.entries(FARES).map(([code, f]) => ({ code, ...f })) });
}));

app.get('/api/airports', wrap(async (req, res) => {
  const { rows } = await query('SELECT code, city, name, country FROM airports WHERE active = TRUE ORDER BY country, city');
  res.json(rows);
}));

// Destinos con vuelos desde cada aeropuerto (para sugerir rutas válidas).
app.get('/api/routes-map', wrap(async (req, res) => {
  const { rows } = await query('SELECT DISTINCT origin, destination FROM routes WHERE active = TRUE');
  const m = {};
  for (const r of rows) (m[r.origin] = m[r.origin] || []).push(r.destination);
  res.json(m);
}));

app.get('/api/search', wrap(async (req, res) => {
  const from = str(req.query.from, 3).toUpperCase(), to = str(req.query.to, 3).toUpperCase();
  const date = str(req.query.date, 10);
  const pax = Math.min(MAX_PAX, Math.max(1, Number(req.query.pax) || 1));
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
  res.json({ from: ap[from], to: ap[to], date, pax, flights: out.filter((f) => f.seats_left >= 1), next_dates: next, has_route: rows.length > 0 });
}));

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

app.post('/api/bookings', wrap(async (req, res) => {
  await expireOld();
  const segIn = Array.isArray(req.body.segments) ? req.body.segments.slice(0, 2) : [];
  if (!segIn.length) throw new HttpError(400, 'Elige al menos un vuelo.');
  const [ap, al, settings] = await Promise.all([airportMap(), airlineMap(), getSettings()]);
  const segs = [];
  for (const s of segIn) {
    const { rows } = await query('SELECT * FROM routes WHERE id = $1 AND active = TRUE', [Number(s.route_id) || 0]);
    const r = rows[0];
    if (!r || !al[r.airline]?.active) throw new HttpError(400, 'Uno de los vuelos ya no está disponible.');
    if (!isDate(s.date) || s.date < todayStr() || !r.days.includes(String(weekday(s.date)))) throw new HttpError(400, `El vuelo ${r.airline} ${r.flight_no} no opera ese día.`);
    if (!FARES[s.fare]) throw new HttpError(400, 'Tarifa inválida.');
    segs.push({ r, date: s.date, fare: s.fare });
  }
  if (segs.length === 2) {
    const [a, b] = segs;
    if (a.r.origin !== b.r.destination || a.r.destination !== b.r.origin) throw new HttpError(400, 'El vuelo de regreso debe ser la ruta inversa.');
    if (b.date < a.date) throw new HttpError(400, 'El regreso no puede ser antes de la ida.');
  }
  const international = segs.some(({ r }) => ap[r.origin].country !== ap[r.destination].country);
  const pax = readPassengers(req.body.passengers, international);
  const c = req.body.contact || {};
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
  const total = money(subtotal + taxes);
  const code = await newCode();
  const staff = req.session.user;
  const expires = new Date(Date.now() + settings.hold_hours * 3600 * 1000);
  const { rows } = await query(
    `INSERT INTO bookings (code, status, contact_name, contact_email, contact_phone, pax_count, subtotal, taxes, total, origin, created_by, expires_at)
     VALUES ($1,'pendiente_pago',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [code, contact.name, contact.email, contact.phone, pax.length, subtotal, taxes, total, staff ? 'agencia' : 'web', staff ? staff.id : null, expires]);
  const id = rows[0].id;
  for (const s of priced) {
    await query(`INSERT INTO segments (booking_id, route_id, flight_date, airline, flight_no, origin, destination, dep_time, arr_time, arr_offset, duration_min, fare, price_per_pax)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id, s.r.id, s.date, s.r.airline, s.r.flight_no, s.r.origin, s.r.destination, s.r.dep_time, s.arr_time, s.arr_offset, s.r.duration_min, s.fare, s.price]);
  }
  for (const p of pax) {
    await query(`INSERT INTO passengers (booking_id, first_name, last_name, birth_date, gender, nationality, doc_type, doc_number)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [id, p.first_name, p.last_name, p.birth_date, p.gender, p.nationality, p.doc_type, p.doc_number]);
  }
  await query('INSERT INTO booking_events (booking_id, status, note, user_name) VALUES ($1,$2,$3,$4)',
    [id, 'pendiente_pago', staff ? 'Reserva creada en agencia' : 'Reserva creada en línea', staff ? staff.name : null]);
  const b = await loadBooking('id = $1', [id]);
  res.status(201).json(staff ? b : publicBooking(b));
}));

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
    pax_count: b.pax_count, total: Number(b.total), origin: b.origin, created_at: b.created_at, expires_at: b.expires_at,
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
async function settleOnlinePayment(session) {
  const code = session?.metadata?.booking_code || session?.client_reference_id;
  if (!code || session.payment_status !== 'paid') return null;
  const { rows } = await query('SELECT * FROM bookings WHERE code = $1', [code]);
  const b = rows[0];
  if (!b) return null;
  const ref = session.payment_intent || session.id;
  if (b.status === 'emitido' || b.status === 'pago_revision') return b.status;
  const expected = Math.round(Number(b.total) * 100);
  let problem = null;
  if (Number(session.amount_total) !== expected) problem = `Monto pagado (${session.amount_total / 100}) distinto al total.`;
  else if (b.status === 'cancelado') problem = 'La reserva estaba cancelada al recibir el pago.';
  else if (b.status === 'vencido') {
    const { rows: segs } = await query('SELECT route_id, flight_date FROM segments WHERE booking_id = $1', [b.id]);
    for (const sg of segs) {
      const { rows: r } = await query('SELECT seats FROM routes WHERE id = $1', [sg.route_id]);
      if (!r[0] || r[0].seats - (await seatsTaken(sg.route_id, sg.flight_date)) < b.pax_count) { problem = 'La reserva venció y ya no hay asientos suficientes.'; break; }
    }
  }
  if (problem) {
    await query("UPDATE bookings SET status = 'pago_revision', payment_method = $1, payment_ref = $2, paid_at = NOW(), updated_at = NOW() WHERE id = $3", ['Tarjeta en línea (Stripe)', ref, b.id]);
    await query('INSERT INTO booking_events (booking_id, status, note) VALUES ($1,$2,$3)', [b.id, 'pago_revision', problem + ' Revisar y reembolsar desde Stripe si aplica.']);
    return 'pago_revision';
  }
  return issueBooking(b.id, { method: 'Tarjeta en línea (Stripe)', ref, note: 'Ref. ' + ref });
}

app.post('/api/staff/bookings/:id/issue', requireStaff, wrap(async (req, res) => {
  await expireOld();
  const b = await loadBooking('id = $1', [Number(req.params.id) || 0]);
  if (!b) throw new HttpError(404, 'Reserva no encontrada.');
  if (b.status !== 'pendiente_pago') throw new HttpError(400, `No se puede emitir: la reserva está "${b.status_label}".`);
  const method = str(req.body.payment_method, 40);
  if (!['Efectivo', 'Tarjeta en terminal', 'Transferencia'].includes(method)) throw new HttpError(400, 'Indica cómo pagó el cliente.');
  await issueBooking(b.id, { method, userName: req.session.user.name, note: str(req.body.note, 200) });
  res.json(await loadBooking('id = $1', [b.id]));
}));

// ---------- pago en línea ----------
const baseUrl = (req) => (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

app.post('/api/bookings/:code/checkout', wrap(async (req, res) => {
  if (!payments.enabled()) throw new HttpError(503, 'El pago en línea no está disponible por ahora. Paga en la agencia.');
  await expireOld();
  const code = str(req.params.code, 10).toUpperCase();
  const b = await loadBooking('code = $1', [code]);
  const last = norm(req.body.last_name);
  if (!b || !last || !b.passengers.some((p) => norm(p.last_name) === last || norm(p.last_name).split(/\s+/).includes(last))) {
    throw new HttpError(404, 'No encontramos la reserva.');
  }
  if (b.status !== 'pendiente_pago') throw new HttpError(400, `Esta reserva está "${b.status_label}" y no se puede pagar.`);
  // Stripe exige que la sesión expire entre 30 min y 24 h.
  const exp = new Date(Math.max(Date.now() + 31 * 60 * 1000, Math.min(new Date(b.expires_at).getTime(), Date.now() + 23.5 * 3600 * 1000)));
  const desc = b.segments.map((sg) => `${sg.flight_no} ${sg.origin}-${sg.destination} ${sg.date}`).join(' / ') + ` · ${b.pax_count} pasajero(s)`;
  const base = baseUrl(req);
  const session = await payments.createCheckout({
    booking: b, description: desc, expiresAt: exp,
    successUrl: `${base}/reserva?code=${b.code}&session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${base}/reserva?code=${b.code}&pago=cancelado`,
  });
  await query('UPDATE bookings SET stripe_session_id = $1 WHERE id = $2', [session.id, b.id]);
  await query('INSERT INTO booking_events (booking_id, status, note) VALUES ($1,$2,$3)', [b.id, 'pendiente_pago', 'El cliente inició el pago en línea']);
  res.json({ url: session.url });
}));

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
  if (b.status === 'pendiente_pago' || ((b.status === 'emitido' || b.status === 'pago_revision') && admin)) {
    await query("UPDATE bookings SET status = 'cancelado', updated_at = NOW() WHERE id = $1", [b.id]);
    const refundNote = b.payment_method === 'Tarjeta en línea (Stripe)' ? 'Pagada en línea: emitir el reembolso desde el panel de Stripe.' : null;
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
  await query('INSERT INTO airlines (code, name, color) VALUES ($1,$2,$3)', [code, name, color]);
  res.status(201).json({ ok: true });
}));
app.put('/api/admin/airlines/:code', requireAdmin, wrap(async (req, res) => {
  const { rows } = await query('SELECT * FROM airlines WHERE code = $1', [str(req.params.code, 3).toUpperCase()]);
  const a = rows[0]; if (!a) throw new HttpError(404, 'No encontrada.');
  const name = str(req.body.name, 80) || a.name;
  const color = /^#[0-9a-f]{6}$/i.test(req.body.color || '') ? req.body.color : a.color;
  const active = typeof req.body.active === 'boolean' ? req.body.active : a.active;
  await query('UPDATE airlines SET name=$1, color=$2, active=$3 WHERE code=$4', [name, color, active, a.code]);
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

app.get('/healthz', (req, res) => res.send('ok'));
app.use('/api', (req, res) => res.status(404).json({ error: 'No encontrado.' }));
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.code).json({ error: err.message });
  if (err.stripe) { console.error('Stripe:', err.message); return res.status(502).json({ error: 'No se pudo conectar con el procesador de pagos. Intenta de nuevo o paga en la agencia.' }); }
  console.error(err);
  res.status(500).json({ error: 'Error interno. Intenta de nuevo.' });
});

init().then(() => app.listen(PORT, () => console.log(`Servidor listo en http://localhost:${PORT}`)))
  .catch((e) => { console.error('No se pudo iniciar la base de datos', e); process.exit(1); });
