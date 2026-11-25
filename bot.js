// Bot de ventas por WhatsApp: busca vuelos, toma los datos, crea la reserva y manda el enlace de pago.
// La conversación se guarda en la tabla wa_sessions (una fila por número).
const wa = require('./whatsapp');

const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // tras 2 h sin mensajes, la conversación empieza de nuevo
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const usd = (n) => '$' + Number(n).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (d, opts = { weekday: 'short', day: 'numeric', month: 'short' }) => new Date(d + 'T12:00:00Z').toLocaleDateString('es-MX', { ...opts, timeZone: 'UTC' });
const dur = (m) => `${Math.floor(m / 60)} h${m % 60 ? ' ' + (m % 60) + ' min' : ''}`;
const RESET = /^(hola|holi|buen[oa]s?( dias| tardes| noches)?|menu|inicio|empezar|comenzar|start|hi|hello)[\s!.,¡]*$/;

function createBot(d) {
  // d: { query, searchFlights, createBooking, startCheckout, loadBooking, findForCustomer, getSettings, routesMap, airports, baseUrl, DOC_TYPES, MAX_PAX, todayStr, addDays, daysBetween, isDate, HttpError }
  const seen = new Set();
  const queues = new Map();
  const hits = new Map();

  async function getSession(phone) {
    const { rows } = await d.query('SELECT * FROM wa_sessions WHERE phone = $1', [phone]);
    const r = rows[0];
    if (!r || Date.now() - new Date(r.updated_at).getTime() > SESSION_TTL_MS) return { state: 'new', data: {} };
    return { state: r.state, data: JSON.parse(r.data || '{}') };
  }
  async function saveSession(phone, state, data) {
    const { rows } = await d.query('SELECT 1 FROM wa_sessions WHERE phone = $1', [phone]);
    if (rows.length) await d.query('UPDATE wa_sessions SET state = $1, data = $2, updated_at = NOW() WHERE phone = $3', [state, JSON.stringify(data), phone]);
    else await d.query('INSERT INTO wa_sessions (phone, state, data) VALUES ($1, $2, $3)', [phone, state, JSON.stringify(data)]);
  }

  // ---------- ayudas ----------
  async function airportsWithRoutes() {
    const [aps, map] = await Promise.all([d.airports(), d.routesMap()]);
    return { aps, map, origins: aps.filter((a) => map[a.code]) };
  }
  function matchAirport(textIn, candidates) {
    const t = norm(textIn).replace(/[()]/g, ' ').trim();
    if (!t) return [];
    const code = candidates.filter((a) => norm(a.code) === t || t.split(/\s+/).includes(norm(a.code)));
    if (code.length === 1) return code;
    // Prioridad: ciudad exacta → ciudad que contiene el texto → nombre del aeropuerto → país.
    const city = candidates.filter((a) => norm(a.city) === t);
    if (city.length) return city;
    const part = candidates.filter((a) => norm(a.city).includes(t) || t.includes(norm(a.city)));
    if (part.length) return part;
    const name = candidates.filter((a) => norm(a.name).includes(t));
    if (name.length) return name;
    return candidates.filter((a) => norm(a.country) === t);
  }
  function parseDate(textIn) {
    const t = norm(textIn);
    const today = d.todayStr();
    if (/^hoy$/.test(t)) return today;
    if (/^manana$/.test(t)) return d.addDays(today, 1);
    if (/^pasado manana$/.test(t)) return d.addDays(today, 2);
    const m = t.match(/^(\d{1,2})\s*[/\-.]\s*(\d{1,2})(?:\s*[/\-.]\s*(\d{2,4}))?$/);
    if (!m) return null;
    const dd = Number(m[1]), mm = Number(m[2]);
    let yy = m[3] ? Number(m[3]) : Number(today.slice(0, 4));
    if (yy < 100) yy += 2000;
    let iso = `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
    if (!d.isDate(iso) || new Date(iso + 'T00:00:00Z').getUTCDate() !== dd) return null;
    if (!m[3] && iso < today) iso = `${yy + 1}${iso.slice(4)}`; // sin año: la próxima vez que caiga esa fecha
    return iso;
  }
  function parseBirth(textIn) {
    const m = norm(textIn).match(/^(\d{1,2})\s*[/\-.]\s*(\d{1,2})\s*[/\-.]\s*(\d{4})$/);
    if (!m) return null;
    const iso = `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
    if (!d.isDate(iso) || new Date(iso + 'T00:00:00Z').getUTCDate() !== Number(m[1]) || iso >= d.todayStr() || iso < '1900-01-01') return null;
    return iso;
  }
  const airportTxt = (a) => `${a.city} (${a.code})`;

  // ---------- pantallas ----------
  const menu = (to, intro = '') => wa.buttons(to, `${intro}${intro ? '\n\n' : ''}✈️ *VuelaLatino*\n¡Hola! Soy el asistente de VuelaLatino. Te ayudo a encontrar tu vuelo y pagarlo aquí mismo.\n\n¿Qué quieres hacer?`,
    [{ id: 'menu:buscar', title: 'Buscar vuelos' }, { id: 'menu:reserva', title: 'Mi reserva' }, { id: 'menu:ayuda', title: 'Ayuda' }]);

  async function askOrigin(to) {
    const { origins } = await airportsWithRoutes();
    const body = '🛫 *¿Desde qué ciudad sales?*\nEscribe la ciudad o el código del aeropuerto (ej. *Ciudad de México* o *MEX*).';
    if (origins.length <= 10) return wa.list(to, body, 'Ver ciudades', origins.map((a) => ({ id: 'ap:' + a.code, title: a.city, description: `${a.code} · ${a.country}` })), 'Ciudades de salida');
    return wa.text(to, `${body}\n\nCiudades disponibles: ${origins.map(airportTxt).join(', ')}.`);
  }
  async function askDest(to, data) {
    const { aps, map } = await airportsWithRoutes();
    const dests = (map[data.from] || []).map((c) => aps.find((a) => a.code === c)).filter(Boolean);
    const body = `🛬 Sales de *${data.fromCity}*. *¿A dónde vas?*\nEscribe la ciudad o el código.`;
    if (dests.length <= 10) return wa.list(to, body, 'Ver destinos', dests.map((a) => ({ id: 'ap:' + a.code, title: a.city, description: `${a.code} · ${a.country}` })), 'Destinos');
    return wa.text(to, `${body}\n\nDestinos: ${dests.map(airportTxt).join(', ')}.`);
  }
  const askDate = (to, data) => wa.text(to, `📅 *${data.fromCity} → ${data.toCity}*\n¿Qué día quieres viajar? Escribe la fecha, por ejemplo *15/01* o *15/01/2027* (también *hoy* o *mañana*).`);
  const askPax = (to) => wa.buttons(to, '👥 *¿Cuántos pasajeros?* Toca una opción o escribe el número (máximo ' + d.MAX_PAX + ').',
    [{ id: 'pax:1', title: '1 pasajero' }, { id: 'pax:2', title: '2 pasajeros' }, { id: 'pax:3', title: '3 pasajeros' }]);

  async function showFlights(to, data, phone) {
    let r;
    try { r = await d.searchFlights(data.from, data.to, data.date, data.pax); }
    catch (e) { await wa.text(to, '⚠️ ' + e.message); await saveSession(phone, 'date', data); return askDate(to, data); }
    if (!r.flights.length) {
      if (r.next_dates.length) {
        await saveSession(phone, 'date', data);
        return wa.buttons(to, `😕 No hay vuelos con lugar el *${day(data.date, { weekday: 'long', day: 'numeric', month: 'long' })}*. Estas fechas sí tienen vuelo; toca una o escribe otra fecha:`,
          r.next_dates.map((x) => ({ id: 'date:' + x, title: day(x) })));
      }
      await saveSession(phone, 'date', data);
      return wa.text(to, '😕 No hay vuelos disponibles en esa fecha. Escribe otra fecha, o *menú* para empezar de nuevo.');
    }
    data.flights = r.flights.slice(0, 10).map((f) => ({ route_id: f.route_id, flight_no: f.flight_no, airline: f.airline.name, dep: f.dep_time, arr: f.arr_time, off: f.arr_offset,
      dur: f.duration_min, intl: f.international, fares: f.fares.map((x) => ({ code: x.code, name: x.name, price: x.price, includes: x.includes })) }));
    await saveSession(phone, 'flight', data);
    return wa.list(to, `✈️ *${data.fromCity} → ${data.toCity}*\n${day(data.date, { weekday: 'long', day: 'numeric', month: 'long' })} · ${data.pax} pasajero${data.pax > 1 ? 's' : ''}\n\nElige tu vuelo (precio por persona, antes de impuestos):`,
      'Ver vuelos', data.flights.map((f) => ({ id: 'fl:' + f.route_id, title: `${f.dep} → ${f.arr}${f.off > 0 ? '+1' : ''} · ${f.flight_no}`,
        description: `${f.airline} · ${dur(f.dur)} · desde ${usd(Math.min(...f.fares.map((x) => x.price)))}` })), 'Vuelos');
  }
  function fareMsg(f) {
    return `🎫 *${f.flight_no}* · sale ${f.dep}, llega ${f.arr}${f.off > 0 ? ' (+1 día)' : ''}\n\n` + f.fares.map((x) => `*${x.name} — ${usd(x.price)}* por persona\n${x.includes.slice(0, 3).map((i) => '• ' + i).join('\n')}`).join('\n\n') + '\n\nElige tu tarifa:';
  }
  const PAX_STEPS = ['first_name', 'last_name', 'birth_date', 'nationality', 'doc_type', 'doc_number'];
  async function askPaxField(to, data) {
    const i = data.passengers.length, p = data.cur || {}, n = i + 1, of = data.pax > 1 ? ` (${n} de ${data.pax})` : '';
    const step = PAX_STEPS.find((k) => !p[k]);
    if (step === 'first_name') return wa.text(to, `🧾 *Pasajero ${n}${of}*\nEscribe su *nombre(s)* tal como aparece en su ${data.intl ? 'pasaporte' : 'identificación'}.`);
    if (step === 'last_name') return wa.text(to, `Ahora su *apellido(s)*, como aparece en el documento.`);
    if (step === 'birth_date') return wa.text(to, `*Fecha de nacimiento* de ${p.first_name} (día/mes/año, ej. 23/04/1990).`);
    if (step === 'nationality') return wa.text(to, `*Nacionalidad* de ${p.first_name} (ej. Mexicana).`);
    if (step === 'doc_type') return wa.list(to, `*Tipo de documento* con el que viaja ${p.first_name}:`, 'Elegir documento', d.DOC_TYPES.map((t, k) => ({ id: 'doc:' + k, title: t })), 'Documentos');
    if (step === 'doc_number') return wa.text(to, `*Número de ${p.doc_type}* de ${p.first_name}.`);
    return null;
  }
  async function summary(to, data) {
    const st = await d.getSettings();
    const fare = data.fare;
    const sub = fare.price * data.pax, taxes = sub * st.tax_rate + st.service_fee * data.pax, total = Math.round((sub + taxes) * 100) / 100;
    data.total = total;
    const base = d.baseUrl();
    return wa.buttons(to, `📋 *Revisa tu reserva*\n\n✈️ ${data.fromCity} → ${data.toCity}\n📅 ${day(data.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}\n🕑 ${data.flight.dep} → ${data.flight.arr} · ${data.flight.flight_no}\n🎫 Tarifa ${fare.name}\n\n👥 ${data.passengers.map((p) => `${p.first_name} ${p.last_name}`).join('\n👥 ')}\n✉️ ${data.email}\n\n💳 *Total: ${usd(total)} USD* (impuestos y cargos incluidos)\n\nAl confirmar aceptas los términos de uso (${base}/terminos) y el aviso de privacidad (${base}/privacidad). Se cobra el total al pagar.`,
      [{ id: 'ok', title: 'Confirmar y pagar' }, { id: 'menu:cancelar', title: 'Cancelar' }]);
  }
  function bookingStatusMsg(b) {
    const segs = b.segments.map((s) => `✈️ ${s.origin} → ${s.destination} · ${day(s.date)} · ${s.dep_time} · ${s.flight_no}`).join('\n');
    const pax = b.passengers.map((p) => `👤 ${p.first_name} ${p.last_name}${p.ticket_number ? ' — boleto ' + p.ticket_number : ''}`).join('\n');
    return `📄 *Reserva ${b.code}* — ${b.status_label}\n${segs}\n${pax}\n💳 Total ${usd(b.total)} USD\n\nConsulta e imprime: ${d.baseUrl()}/reserva?code=${b.code}`;
  }

  // ---------- conversación ----------
  async function handle(phone, input) {
    const to = phone;
    const t = (input.text || '').trim();
    const id = input.id || '';
    let { state, data } = await getSession(phone);
    const nt = norm(t);

    if (id === 'menu:cancelar' || /^(cancelar|salir|cancel)$/.test(nt)) { await saveSession(phone, 'menu', {}); return menu(to, 'Listo, cancelé lo que estábamos haciendo.'); }
    if (state === 'new' || id === 'menu:inicio' || (!id && RESET.test(nt))) { await saveSession(phone, 'menu', {}); return menu(to); }
    if (id === 'menu:buscar' || (state === 'menu' && /buscar|vuelo|viaj|boleto/.test(nt))) { await saveSession(phone, 'origin', {}); return askOrigin(to); }
    if (id === 'menu:reserva' || (state === 'menu' && /reserva|codigo/.test(nt))) { await saveSession(phone, 'lk_code', {}); return wa.text(to, '🔎 Escribe tu *código de reserva* (6 caracteres, ej. K9MG5S).'); }
    if (id === 'menu:ayuda' || /^ayuda|^help/.test(nt)) {
      await saveSession(phone, 'menu', {});
      return wa.text(to, `ℹ️ *Ayuda*\n• Escribe *menú* en cualquier momento para empezar de nuevo.\n• Escribe *cancelar* para dejar lo que estés haciendo.\n• También puedes reservar en ${d.baseUrl()}\n• Cambios, cancelaciones o reembolsos: vuelalatino@yahoo.com con tu código de reserva.`);
    }
    if (id.startsWith('pay:')) {
      const code = id.slice(4);
      if (data.lk && data.lk.code === code) {
        try {
          const b = await d.findForCustomer(code, data.lk.last);
          const url = await d.startCheckout(b, d.baseUrl(), 'por WhatsApp');
          return wa.text(to, `💳 Paga el total de *${usd(b.balance)} USD* aquí (página segura de Stripe):\n${url}\n\nEn cuanto pagues te mando tus boletos por aquí.`);
        } catch (e) { return wa.text(to, '⚠️ ' + e.message); }
      }
      return wa.text(to, 'Para pagar, primero consulta tu reserva: escribe *menú* y elige *Mi reserva*.');
    }

    switch (state) {
      case 'menu':
        return menu(to, 'No entendí eso 🤔');

      case 'origin': case 'dest': {
        const { aps, map, origins } = await airportsWithRoutes();
        const pool = state === 'origin' ? origins : (map[data.from] || []).map((c) => aps.find((a) => a.code === c)).filter(Boolean);
        const found = id.startsWith('ap:') ? pool.filter((a) => a.code === id.slice(3)) : matchAirport(t, pool);
        if (!found.length) {
          await wa.text(to, state === 'origin' ? '😕 No encontré esa ciudad de salida.' : `😕 No tenemos vuelos de ${data.fromCity} a esa ciudad.`);
          return state === 'origin' ? askOrigin(to) : askDest(to, data);
        }
        if (found.length > 1) {
          return wa.list(to, 'Encontré varias opciones, ¿cuál es?', 'Elegir', found.slice(0, 10).map((a) => ({ id: 'ap:' + a.code, title: a.city, description: `${a.code} · ${a.name}` })));
        }
        const a = found[0];
        if (state === 'origin') { data.from = a.code; data.fromCity = a.city; await saveSession(phone, 'dest', data); return askDest(to, data); }
        data.to = a.code; data.toCity = a.city;
        await saveSession(phone, 'date', data);
        return askDate(to, data);
      }

      case 'date': {
        const date = id.startsWith('date:') ? id.slice(5) : parseDate(t);
        if (!date) return wa.text(to, 'No entendí la fecha 🤔. Escríbela como *día/mes*, por ejemplo *15/01*.');
        if (date < d.todayStr()) return wa.text(to, 'Esa fecha ya pasó. Escribe una fecha futura.');
        if (d.daysBetween(d.todayStr(), date) > 330) return wa.text(to, 'Solo vendemos hasta 330 días antes del vuelo. Escribe una fecha más cercana.');
        data.date = date;
        if (data.pax) return showFlights(to, data, phone); // cambió solo la fecha
        await saveSession(phone, 'pax', data);
        return askPax(to);
      }

      case 'pax': {
        const n = id.startsWith('pax:') ? Number(id.slice(4)) : Number((t.match(/\d+/) || [])[0]);
        if (!(n >= 1 && n <= d.MAX_PAX)) return wa.text(to, `Escribe un número de pasajeros entre 1 y ${d.MAX_PAX}.`);
        data.pax = n;
        return showFlights(to, data, phone);
      }

      case 'flight': {
        const f = (data.flights || []).find((x) => id === 'fl:' + x.route_id) || (data.flights || []).find((x) => t && (norm(x.flight_no) === nt || x.dep === t));
        if (!f) return wa.text(to, 'Toca *Ver vuelos* y elige uno de la lista, o escribe *menú* para empezar de nuevo.');
        data.flight = f; data.intl = f.intl;
        delete data.flights;
        await saveSession(phone, 'fare', data);
        return wa.buttons(to, fareMsg(f), f.fares.map((x) => ({ id: 'fare:' + x.code, title: `${x.name} ${usd(x.price).replace('.00', '')}` })));
      }

      case 'fare': {
        const code = id.startsWith('fare:') ? id.slice(5) : (data.flight.fares.find((x) => norm(x.name) === nt) || {}).code;
        const fare = data.flight.fares.find((x) => x.code === code);
        if (!fare) return wa.text(to, 'Elige una tarifa con los botones: Básica, Clásica o Flexible.');
        data.fare = fare; data.passengers = []; data.cur = {};
        await saveSession(phone, 'paxdata', data);
        if (data.intl) await wa.text(to, '🛂 Es un vuelo internacional: cada pasajero necesita *pasaporte* vigente.');
        return askPaxField(to, data);
      }

      case 'paxdata': {
        const p = data.cur || {};
        const step = PAX_STEPS.find((k) => !p[k]);
        if (step === 'first_name' || step === 'last_name') {
          const v = t.replace(/\s+/g, ' ').slice(0, 60);
          if (v.length < 2 || /\d/.test(v)) return wa.text(to, 'Escríbelo con letras, como aparece en el documento.');
          p[step] = v;
          if (step === 'last_name' && data.intl) p.doc_type = 'Pasaporte';
        } else if (step === 'birth_date') {
          const v = parseBirth(t);
          if (!v) return wa.text(to, 'Escribe la fecha como *día/mes/año*, por ejemplo *23/04/1990*.');
          p.birth_date = v;
        } else if (step === 'nationality') {
          if (t.length < 3) return wa.text(to, 'Escribe la nacionalidad, por ejemplo *Mexicana*.');
          p.nationality = t.slice(0, 60);
          if (data.intl) p.doc_type = 'Pasaporte';
        } else if (step === 'doc_type') {
          const k = id.startsWith('doc:') ? Number(id.slice(4)) : d.DOC_TYPES.findIndex((x) => norm(x) === nt);
          if (!(k >= 0 && k < d.DOC_TYPES.length)) return wa.text(to, 'Toca *Elegir documento* y elige uno de la lista.');
          p.doc_type = d.DOC_TYPES[k];
        } else if (step === 'doc_number') {
          const v = t.replace(/\s+/g, '').toUpperCase().slice(0, 30);
          if (v.length < 5) return wa.text(to, 'Ese número parece incompleto. Escríbelo de nuevo.');
          p.doc_number = v;
        }
        data.cur = p;
        if (PAX_STEPS.every((k) => p[k])) {
          data.passengers.push(p); data.cur = {};
          if (data.passengers.length >= data.pax) {
            await saveSession(phone, 'email', data);
            return wa.text(to, '✉️ Por último, escribe un *correo electrónico* para enviarte la confirmación.');
          }
        }
        await saveSession(phone, 'paxdata', data);
        return askPaxField(to, data);
      }

      case 'email': {
        const v = t.toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return wa.text(to, 'Ese correo no parece válido. Escríbelo de nuevo (ej. nombre@correo.com).');
        data.email = v.slice(0, 120);
        await saveSession(phone, 'confirm', data);
        return summary(to, data);
      }

      case 'confirm': {
        if (id !== 'ok' && !/^(si|sí|confirmar|confirmo|ok)/.test(nt)) return wa.buttons(to, '¿Confirmamos tu reserva?', [{ id: 'ok', title: 'Confirmar y pagar' }, { id: 'menu:cancelar', title: 'Cancelar' }]);
        const p1 = data.passengers[0];
        try {
          const b = await d.createBooking({
            segments: [{ route_id: data.flight.route_id, date: data.date, fare: data.fare.code }],
            passengers: data.passengers,
            contact: { name: `${p1.first_name} ${p1.last_name}`, email: data.email, phone: '+' + phone },
          }, { origin: 'whatsapp' });
          const url = await d.startCheckout(b, d.baseUrl(), 'por WhatsApp');
          await saveSession(phone, 'menu', { lk: { code: b.code, last: p1.last_name } });
          return wa.text(to, `✅ Reserva *${b.code}* creada. Tus asientos quedan apartados mientras pagas.\n\n💳 *Paga ${usd(b.total)} USD aquí* (página segura de Stripe; el enlace vence en 1 hora):\n${url}\n\nEn cuanto pagues te mando tus boletos por aquí. 🙌`);
        } catch (e) {
          await saveSession(phone, 'menu', {});
          return menu(to, '⚠️ No pude crear la reserva: ' + e.message);
        }
      }

      case 'lk_code': {
        const code = t.toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (code.length !== 6) return wa.text(to, 'El código tiene 6 caracteres (ej. K9MG5S). Escríbelo de nuevo.');
        await saveSession(phone, 'lk_last', { code });
        return wa.text(to, 'Ahora escribe el *apellido* de cualquier pasajero de la reserva.');
      }
      case 'lk_last': {
        try {
          const b = await d.findForCustomer(data.code, t);
          await saveSession(phone, 'menu', { lk: { code: b.code, last: t } });
          if (b.status === 'pendiente_pago') return wa.buttons(to, bookingStatusMsg(b) + `\n\n⏰ Paga antes de que venza para emitir tus boletos.`, [{ id: 'pay:' + b.code, title: 'Pagar ahora' }, { id: 'menu:inicio', title: 'Menú' }]);
          return wa.buttons(to, bookingStatusMsg(b), [{ id: 'menu:inicio', title: 'Menú' }]);
        } catch (e) {
          await saveSession(phone, 'lk_code', {});
          return wa.text(to, '😕 No encontré una reserva con ese código y apellido. Escribe el código de nuevo, o *menú* para salir.');
        }
      }
      default:
        await saveSession(phone, 'menu', {});
        return menu(to);
    }
  }

  // Procesa el aviso de Meta (POST del webhook). Responde rápido y procesa en orden por número.
  function handleWebhook(body) {
    for (const entry of body?.entry || []) {
      for (const ch of entry.changes || []) {
        for (const m of ch.value?.messages || []) {
          if (!m.id || seen.has(m.id)) continue;
          seen.add(m.id); if (seen.size > 5000) seen.delete(seen.values().next().value);
          const phone = String(m.from || '').replace(/\D/g, '');
          if (!phone) continue;
          // Límite: 40 mensajes por minuto por número.
          const now = Date.now(); const h = hits.get(phone) || { n: 0, t: now };
          if (now - h.t > 60000) { h.n = 0; h.t = now; }
          if (++h.n > 40) { hits.set(phone, h); continue; }
          hits.set(phone, h);
          const input = m.type === 'text' ? { text: m.text?.body || '' }
            : m.type === 'interactive' ? { id: m.interactive?.button_reply?.id || m.interactive?.list_reply?.id || '', text: m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || '' }
            : m.type === 'button' ? { text: m.button?.text || '' } : null;
          const prev = queues.get(phone) || Promise.resolve();
          const next = prev.then(async () => {
            wa.markRead(m.id);
            if (!input) return wa.text(phone, 'Por ahora solo entiendo mensajes de texto 🙂. Escribe *menú* para empezar.');
            return handle(phone, { text: String(input.text).slice(0, 500), id: String(input.id || '').slice(0, 200) });
          }).catch((e) => console.error('[whatsapp] error', phone.slice(-4), e.message))
            .finally(() => { if (queues.get(phone) === next) queues.delete(phone); });
          queues.set(phone, next);
        }
      }
    }
  }

  // Aviso automático cuando se confirma el pago de una reserva hecha por WhatsApp.
  async function notifyIssued(bookingId) {
    if (!wa.enabled()) return;
    const b = await d.loadBooking('id = $1', [bookingId]);
    if (!b) return;
    const to = String(b.contact_phone || '').replace(/\D/g, '');
    if (to.length < 8) return;
    await wa.text(to, `🎉 *¡Pago recibido!* Tus boletos están emitidos.\n\n${bookingStatusMsg(b)}\n\nDocumenta 2 h antes (vuelo nacional) o 3 h (internacional). ¡Buen viaje! ✈️`);
  }

  return { enabled: wa.enabled, handleWebhook, notifyIssued, _handle: handle };
}

module.exports = { createBot };
