// Capa de datos: PostgreSQL en producción (DATABASE_URL); base en memoria (pg-mem) para pruebas locales.
const bcrypt = require('bcryptjs');

let pool;
if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === '1' ? { rejectUnauthorized: false } : false,
  });
} else {
  const { newDb } = require('pg-mem');
  const { Pool } = newDb().adapters.createPg();
  pool = new Pool();
  console.warn('[db] DATABASE_URL no definido: usando base de datos EN MEMORIA (los datos se pierden al reiniciar).');
}
const query = (text, params) => pool.query(text, params);

// Aeropuertos: código IATA, ciudad, nombre, país, diferencia horaria (UTC, horario estándar).
const AIRPORTS = [
  ['MEX', 'Ciudad de México', 'Aeropuerto Internacional Benito Juárez', 'México', -6],
  ['GDL', 'Guadalajara', 'Aeropuerto Internacional de Guadalajara', 'México', -6],
  ['MTY', 'Monterrey', 'Aeropuerto Internacional de Monterrey', 'México', -6],
  ['CUN', 'Cancún', 'Aeropuerto Internacional de Cancún', 'México', -5],
  ['TIJ', 'Tijuana', 'Aeropuerto Internacional de Tijuana', 'México', -8],
  ['LAX', 'Los Ángeles', 'Aeropuerto Internacional de Los Ángeles', 'Estados Unidos', -8],
  ['IAH', 'Houston', 'Aeropuerto Intercontinental George Bush', 'Estados Unidos', -6],
  ['MIA', 'Miami', 'Aeropuerto Internacional de Miami', 'Estados Unidos', -5],
  ['JFK', 'Nueva York', 'Aeropuerto Internacional John F. Kennedy', 'Estados Unidos', -5],
  ['GUA', 'Ciudad de Guatemala', 'Aeropuerto Internacional La Aurora', 'Guatemala', -6],
  ['SAL', 'San Salvador', 'Aeropuerto Internacional de El Salvador', 'El Salvador', -6],
  ['SJO', 'San José', 'Aeropuerto Internacional Juan Santamaría', 'Costa Rica', -6],
  ['PTY', 'Ciudad de Panamá', 'Aeropuerto Internacional de Tocumen', 'Panamá', -5],
  ['SDQ', 'Santo Domingo', 'Aeropuerto Internacional Las Américas', 'República Dominicana', -4],
  ['BOG', 'Bogotá', 'Aeropuerto Internacional El Dorado', 'Colombia', -5],
  ['MDE', 'Medellín', 'Aeropuerto Internacional José María Córdova', 'Colombia', -5],
  ['LIM', 'Lima', 'Aeropuerto Internacional Jorge Chávez', 'Perú', -5],
  ['UIO', 'Quito', 'Aeropuerto Internacional Mariscal Sucre', 'Ecuador', -5],
];

// Aerolíneas y rutas DE EJEMPLO para probar la app. El administrador las reemplaza por las reales.
const AIRLINES = [
  ['EJ', 'Aerolínea Ejemplo', '#0b6e5f'],
  ['VD', 'Vuelos Demo', '#1d4ed8'],
];
// Aerolíneas reales que operan en Latinoamérica: [código IATA, nombre, color, país].
// Sus vuelos y horarios no se inventan: la agencia los carga en "Vuelos y horarios".
const REAL_AIRLINES = [
  ['AM', 'Aeroméxico', '#0b2343', 'México'],
  ['Y4', 'Volaris', '#6b2c91', 'México'],
  ['VB', 'Viva Aerobus', '#00843d', 'México'],
  ['AV', 'Avianca', '#da291c', 'Colombia'],
  ['P5', 'Wingo', '#5b2d8e', 'Colombia'],
  ['CM', 'Copa Airlines', '#0032a0', 'Panamá'],
  ['DM', 'Arajet', '#0086c8', 'República Dominicana'],
  ['LA', 'LATAM Airlines', '#1b0088', 'Chile'],
  ['H2', 'Sky Airline', '#27348b', 'Chile'],
  ['JA', 'JetSMART', '#002f87', 'Chile'],
  ['AR', 'Aerolíneas Argentinas', '#0f6fb5', 'Argentina'],
  ['G3', 'GOL', '#e8590c', 'Brasil'],
  ['AD', 'Azul', '#0033a0', 'Brasil'],
  ['OB', 'Boliviana de Aviación', '#00529b', 'Bolivia'],
  ['AA', 'American Airlines', '#0078d2', 'Estados Unidos'],
  ['UA', 'United Airlines', '#005daa', 'Estados Unidos'],
  ['DL', 'Delta Air Lines', '#c8102e', 'Estados Unidos'],
  ['B6', 'JetBlue', '#003876', 'Estados Unidos'],
  ['AC', 'Air Canada', '#d22630', 'Canadá'],
  ['IB', 'Iberia', '#d7192d', 'España'],
  ['UX', 'Air Europa', '#00347c', 'España'],
];

// [aerolínea, número, origen, destino, salida, duración (min), días (1=lun..7=dom), asientos, precio base USD]
const ROUTES = [
  ['EJ', '101', 'MEX', 'CUN', '07:15', 130, '1234567', 150, 89],
  ['EJ', '103', 'MEX', 'CUN', '13:40', 130, '1234567', 150, 99],
  ['EJ', '105', 'MEX', 'CUN', '19:55', 130, '12345', 150, 79],
  ['EJ', '102', 'CUN', 'MEX', '10:20', 140, '1234567', 150, 89],
  ['EJ', '104', 'CUN', 'MEX', '16:45', 140, '1234567', 150, 95],
  ['EJ', '201', 'MEX', 'GDL', '08:00', 80, '1234567', 120, 59],
  ['EJ', '202', 'GDL', 'MEX', '10:05', 80, '1234567', 120, 59],
  ['EJ', '301', 'MEX', 'MTY', '06:50', 95, '12345', 120, 65],
  ['EJ', '302', 'MTY', 'MEX', '09:15', 95, '12345', 120, 65],
  ['EJ', '401', 'MEX', 'TIJ', '09:30', 205, '1234567', 180, 119],
  ['EJ', '402', 'TIJ', 'MEX', '14:10', 200, '1234567', 180, 119],
  ['EJ', '501', 'MEX', 'LAX', '11:05', 235, '1234567', 180, 189],
  ['EJ', '502', 'LAX', 'MEX', '00:30', 225, '1234567', 180, 179],
  ['EJ', '601', 'MEX', 'GUA', '08:45', 125, '1357', 120, 149],
  ['EJ', '602', 'GUA', 'MEX', '12:00', 130, '1357', 120, 149],
  ['VD', '710', 'MEX', 'BOG', '10:10', 290, '1234567', 180, 239],
  ['VD', '711', 'BOG', 'MEX', '16:30', 300, '1234567', 180, 239],
  ['VD', '720', 'BOG', 'MDE', '07:00', 55, '1234567', 120, 49],
  ['VD', '721', 'MDE', 'BOG', '09:10', 55, '1234567', 120, 49],
  ['VD', '730', 'BOG', 'LIM', '12:15', 195, '1234567', 150, 169],
  ['VD', '731', 'LIM', 'BOG', '16:40', 195, '1234567', 150, 169],
  ['VD', '740', 'PTY', 'BOG', '09:20', 105, '1234567', 150, 129],
  ['VD', '741', 'BOG', 'PTY', '12:40', 105, '1234567', 150, 129],
  ['VD', '750', 'MIA', 'BOG', '08:30', 205, '1234567', 180, 199],
  ['VD', '751', 'BOG', 'MIA', '13:50', 210, '1234567', 180, 199],
  ['VD', '760', 'SAL', 'IAH', '07:40', 205, '1234567', 150, 219],
  ['VD', '761', 'IAH', 'SAL', '13:15', 200, '1234567', 150, 219],
  ['VD', '770', 'PTY', 'SDQ', '10:00', 145, '1357', 150, 179],
  ['VD', '771', 'SDQ', 'PTY', '14:20', 150, '1357', 150, 179],
  ['VD', '780', 'SJO', 'PTY', '06:30', 75, '1234567', 120, 99],
  ['VD', '781', 'PTY', 'SJO', '19:10', 75, '1234567', 120, 99],
  ['VD', '790', 'UIO', 'BOG', '08:15', 95, '1234567', 120, 119],
  ['VD', '791', 'BOG', 'UIO', '18:05', 95, '1234567', 120, 119],
  ['VD', '800', 'MIA', 'JFK', '09:00', 185, '1234567', 180, 129],
  ['VD', '801', 'JFK', 'MIA', '14:00', 190, '1234567', 180, 129],
];

async function init() {
  await query(`CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
    name TEXT NOT NULL, role TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await query(`CREATE TABLE IF NOT EXISTS airports (
    code TEXT PRIMARY KEY, city TEXT NOT NULL, name TEXT NOT NULL, country TEXT NOT NULL,
    utc_offset NUMERIC NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE)`);
  await query(`CREATE TABLE IF NOT EXISTS airlines (
    code TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE)`);
  await query(`CREATE TABLE IF NOT EXISTS routes (
    id SERIAL PRIMARY KEY, airline TEXT NOT NULL, flight_no TEXT NOT NULL,
    origin TEXT NOT NULL, destination TEXT NOT NULL, dep_time TEXT NOT NULL, duration_min INTEGER NOT NULL,
    days TEXT NOT NULL, seats INTEGER NOT NULL, base_price NUMERIC NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE)`);
  await query(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  await query(`CREATE TABLE IF NOT EXISTS bookings (
    id SERIAL PRIMARY KEY, code TEXT UNIQUE NOT NULL, status TEXT NOT NULL,
    contact_name TEXT NOT NULL, contact_email TEXT NOT NULL, contact_phone TEXT NOT NULL,
    pax_count INTEGER NOT NULL, subtotal NUMERIC NOT NULL, taxes NUMERIC NOT NULL, total NUMERIC NOT NULL,
    origin TEXT NOT NULL, created_by INTEGER, expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await query(`CREATE TABLE IF NOT EXISTS segments (
    id SERIAL PRIMARY KEY, booking_id INTEGER NOT NULL, route_id INTEGER NOT NULL, flight_date TEXT NOT NULL,
    airline TEXT NOT NULL, flight_no TEXT NOT NULL, origin TEXT NOT NULL, destination TEXT NOT NULL,
    dep_time TEXT NOT NULL, arr_time TEXT NOT NULL, arr_offset INTEGER NOT NULL, duration_min INTEGER NOT NULL,
    fare TEXT NOT NULL, price_per_pax NUMERIC NOT NULL)`);
  await query(`CREATE TABLE IF NOT EXISTS passengers (
    id SERIAL PRIMARY KEY, booking_id INTEGER NOT NULL, first_name TEXT NOT NULL, last_name TEXT NOT NULL,
    birth_date TEXT NOT NULL, gender TEXT, nationality TEXT NOT NULL, doc_type TEXT NOT NULL, doc_number TEXT NOT NULL,
    ticket_number TEXT)`);
  for (const col of ['payment_method TEXT', 'payment_ref TEXT', 'paid_at TIMESTAMPTZ', 'stripe_session_id TEXT']) {
    await query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS ' + col);
  }
  await query(`CREATE TABLE IF NOT EXISTS seat_assignments (
    id SERIAL PRIMARY KEY, booking_id INTEGER NOT NULL, segment_id INTEGER NOT NULL, passenger_id INTEGER NOT NULL,
    seat TEXT NOT NULL, seat_type TEXT NOT NULL, price NUMERIC NOT NULL)`);
  await query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS seats_total NUMERIC');
  await query('UPDATE bookings SET seats_total = 0 WHERE seats_total IS NULL');
  await query(`CREATE TABLE IF NOT EXISTS correction_requests (
    id SERIAL PRIMARY KEY, booking_id INTEGER NOT NULL, passenger_id INTEGER NOT NULL,
    changes TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL,
    response TEXT, resolved_by TEXT, resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await query(`CREATE TABLE IF NOT EXISTS booking_events (
    id SERIAL PRIMARY KEY, booking_id INTEGER NOT NULL, status TEXT NOT NULL, note TEXT, user_name TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);

  // Pagos recibidos y monto pagado por reserva.
  await query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS paid_amount NUMERIC');
  await query('UPDATE bookings SET paid_amount = 0 WHERE paid_amount IS NULL');
  await query(`CREATE TABLE IF NOT EXISTS payments (
    id SERIAL PRIMARY KEY, booking_id INTEGER NOT NULL, amount NUMERIC NOT NULL, method TEXT NOT NULL,
    ref TEXT, note TEXT, user_name TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await query('CREATE UNIQUE INDEX IF NOT EXISTS payments_ref_uq ON payments (ref)');
  // Reservas pagadas antes de existir la tabla de pagos: se registra su pago completo.
  const { rows: paidBefore } = await query(
    'SELECT id, total, payment_method, payment_ref, paid_at FROM bookings WHERE paid_at IS NOT NULL AND paid_amount = 0');
  for (const b of paidBefore) {
    const { rows: has } = await query('SELECT 1 FROM payments WHERE booking_id = $1', [b.id]);
    if (has.length) continue;
    await query('INSERT INTO payments (booking_id, amount, method, ref, note, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [b.id, b.total, b.payment_method || 'Sin especificar', b.payment_ref || null, 'Pago registrado antes de la sección de pagos', b.paid_at]);
    await query('UPDATE bookings SET paid_amount = total WHERE id = $1', [b.id]);
  }

  const count = async (t) => Number((await query(`SELECT COUNT(*)::int AS n FROM ${t}`)).rows[0].n);
  if (!(await count('airports'))) {
    for (const a of AIRPORTS) await query('INSERT INTO airports (code, city, name, country, utc_offset) VALUES ($1,$2,$3,$4,$5)', a);
  }
  if (!(await count('airlines'))) {
    for (const a of AIRLINES) await query('INSERT INTO airlines (code, name, color) VALUES ($1,$2,$3)', a);
  }
  await query('ALTER TABLE airlines ADD COLUMN IF NOT EXISTS country TEXT');
  await query('ALTER TABLE airlines ADD COLUMN IF NOT EXISTS demo BOOLEAN');
  await query("UPDATE airlines SET demo = (code IN ('EJ', 'VD')) WHERE demo IS NULL");
  // Aerolíneas reales (se agregan una sola vez; la agencia puede desactivarlas o editarlas).
  for (const [code, name, color, country] of REAL_AIRLINES) {
    const { rows } = await query('SELECT 1 FROM airlines WHERE code = $1', [code]);
    if (!rows.length) await query('INSERT INTO airlines (code, name, color, country, demo) VALUES ($1,$2,$3,$4,FALSE)', [code, name, color, country]);
  }
  if (!(await count('routes'))) {
    for (const r of ROUTES) {
      await query(`INSERT INTO routes (airline, flight_no, origin, destination, dep_time, duration_min, days, seats, base_price)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, r);
    }
  }
  const defaults = { tax_rate: '0.16', hold_hours: '24', service_fee: '10', seat_std: '8', seat_front: '15', seat_exit: '20',
    whatsapp: '' };
  for (const [k, v] of Object.entries(defaults)) {
    const { rows } = await query('SELECT 1 FROM settings WHERE key = $1', [k]);
    if (!rows.length) await query('INSERT INTO settings (key, value) VALUES ($1,$2)', [k, v]);
  }
  if (!(await count('users'))) {
    const username = process.env.ADMIN_USER || 'admin';
    const password = process.env.ADMIN_PASSWORD;
    if (!password) console.warn('[db] ADMIN_PASSWORD no definido: no se creó el administrador.');
    else {
      await query('INSERT INTO users (username, password_hash, name, role) VALUES ($1,$2,$3,$4)',
        [username, bcrypt.hashSync(password, 10), 'Administrador', 'admin']);
      console.log(`[db] Usuario administrador "${username}" creado.`);
    }
  }
}

module.exports = { query, init };
