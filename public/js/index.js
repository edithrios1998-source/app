renderHeader('/');
$('#swap').innerHTML = icon('swap');
$('#go').innerHTML = icon('search', 'ico-sm') + ' Buscar vuelos';
$$('.perk .ib').forEach((el, i) => { el.innerHTML = icon(['shield', 'clock', 'ticket'][i]); });
$('#pax-form h3').innerHTML = icon('user', 'ico-sm') + ' Contacto';

const S = { trip: 'round', pax: 1, legs: [], sel: [], leg: 0, airports: [], map: {}, cfg: null };
const apBy = (c) => S.airports.find((a) => a.code === c);

(async function boot() {
  const [airports, map, cfg] = await Promise.all([api('/api/airports'), api('/api/routes-map'), api('/api/config')]);
  Object.assign(S, { airports, map, cfg });
  window.ONLINE_PAY = cfg.online_payments;
  if (cfg.online_payments) $('#book-btn').textContent = 'Reservar y continuar al pago';
  const origins = airports.filter((a) => map[a.code]);
  const groups = (list) => [...new Set(list.map((a) => a.country))].map((c) =>
    `<optgroup label="${esc(c)}">${list.filter((a) => a.country === c).map((a) => `<option value="${a.code}">${esc(a.city)} (${a.code})</option>`).join('')}</optgroup>`).join('');
  $('#from').innerHTML = groups(origins);
  $('#pax').innerHTML = Array.from({ length: cfg.max_pax }, (_, i) => `<option value="${i + 1}">${i + 1} adulto${i ? 's' : ''}</option>`).join('');
  const qs = new URLSearchParams(location.search);
  $('#from').value = map[qs.get('from')] ? qs.get('from') : 'MEX';
  fillTo(qs.get('to'));
  $('#date').min = cfg.today; $('#ret').min = cfg.today;
  $('#date').value = addDays(cfg.today, 14); $('#ret').value = addDays(cfg.today, 21);

  function fillTo(pref) {
    const dests = (map[$('#from').value] || []).map(apBy).filter(Boolean);
    const cur = pref || $('#to').value;
    $('#to').innerHTML = groups(dests);
    if (dests.some((d) => d.code === cur)) $('#to').value = cur;
  }
  $('#from').addEventListener('change', () => fillTo());
  $('#swap').addEventListener('click', () => {
    const f = $('#from').value, t = $('#to').value;
    if (!map[t]) return;
    $('#from').value = t; fillTo(f);
  });
  $('#date').addEventListener('change', () => { if ($('#ret').value < $('#date').value) $('#ret').value = addDays($('#date').value, 7); $('#ret').min = $('#date').value; });
  $$('.trip-type button').forEach((b) => b.addEventListener('click', () => {
    S.trip = b.dataset.trip;
    $$('.trip-type button').forEach((x) => x.classList.toggle('on', x === b));
    $('.f-ret').style.visibility = S.trip === 'round' ? 'visible' : 'hidden';
  }));

  // Aerolíneas (las reales dadas de alta en el panel)
  api('/api/airlines').then((list) => {
    $('#al-list').innerHTML = list.length ? list.map((x) => `<div class="al-card">
        <span class="al-logo al-big" style="background:${esc(x.color)}">${esc(x.code)}</span>
        <div class="al-info"><b>${esc(x.name)}</b><span>${esc(x.country)}</span></div>
        ${x.has_flights ? '<span class="badge b-emitido">Vuelos en línea</span>' : '<span class="badge b-vencido">Próximamente</span>'}
      </div>`).join('') : '<div class="empty">Pronto agregaremos aerolíneas.</div>';
  }).catch(() => { $('#al-list').innerHTML = '<div class="empty">No se pudieron cargar las aerolíneas.</div>'; });
  if (qs.get('from') && qs.get('to')) $('#search').requestSubmit();
})().catch((e) => showMsg($('#search-err'), e.message));

$('#search').addEventListener('submit', (e) => {
  e.preventDefault();
  hideMsg($('#search-err'));
  const from = $('#from').value, to = $('#to').value, date = $('#date').value, ret = $('#ret').value;
  if (!from || !to) return showMsg($('#search-err'), 'Elige origen y destino.');
  if (!date) return showMsg($('#search-err'), 'Elige la fecha de salida.');
  if (S.trip === 'round' && (!ret || ret < date)) return showMsg($('#search-err'), 'La fecha de regreso debe ser igual o posterior a la salida.');
  S.pax = Number($('#pax').value);
  S.legs = [{ from, to, date }];
  if (S.trip === 'round') S.legs.push({ from: to, to: from, date: ret });
  S.sel = []; S.leg = 0;
  showLeg();
});

function show(id) {
  ['results', 'checkout', 'done'].forEach((s) => $('#' + s).classList.toggle('hidden', s !== id));
  $('#home').classList.toggle('hidden', !!id);
  $('#search').classList.toggle('hidden', id === 'done');
}

async function showLeg() {
  show('results');
  const L = S.legs[S.leg];
  const A = apBy(L.from), B = apBy(L.to);
  $('#res-sub').textContent = `${S.legs.length > 1 ? (S.leg === 0 ? 'Vuelo de ida' : 'Vuelo de regreso') : 'Solo ida'} · ${S.pax} pasajero${S.pax > 1 ? 's' : ''}`;
  $('#res-title').textContent = `${A.city} → ${B.city}`;
  $('#legs').innerHTML = S.legs.map((l, i) => `<div class="leg-tab ${i === S.leg ? 'on' : ''} ${S.sel[i] ? 'done' : ''}"><span class="n">${S.sel[i] ? '✓' : i + 1}</span>
    <div><b>${l.from} → ${l.to}</b><div class="muted small-txt">${S.sel[i] ? esc(S.sel[i].flight.flight_no) + ' · ' + esc(S.sel[i].fare.name) : esc(dDate(l.date))}</div></div></div>`).join('');
  // Tira de fechas ±3 días
  const minDate = S.leg === 1 ? S.legs[0].date : S.cfg.today;
  $('#dates').innerHTML = [-3, -2, -1, 0, 1, 2, 3].map((n) => {
    const d = addDays(L.date, n);
    return `<button type="button" data-d="${d}" class="${n === 0 ? 'on' : ''}" ${d < minDate ? 'disabled' : ''}><span>${esc(dDate(d, { weekday: 'short' }))}</span><b>${esc(dDate(d, { day: 'numeric', month: 'short' }))}</b></button>`;
  }).join('');
  $$('#dates button').forEach((b) => b.addEventListener('click', () => {
    L.date = b.dataset.d;
    if (S.leg === 0 && S.legs[1] && S.legs[1].date < L.date) S.legs[1].date = L.date;
    showLeg();
  }));
  S.calMonth = L.date.slice(0, 7);
  $('#pcal-btn').innerHTML = `${icon('clock', 'ico-sm')} ${S.calOpen ? 'Ocultar calendario de precios' : 'Ver calendario de precios del mes'}`;
  if (S.calOpen) drawPriceCal(); else $('#pcal').classList.add('hidden');
  const box = $('#flights');
  box.innerHTML = '<div class="empty">Buscando vuelos…</div>';
  try {
    const r = await api(`/api/search?from=${L.from}&to=${L.to}&date=${L.date}&pax=${S.pax}`);
    if (!r.flights.length) {
      box.innerHTML = `<div class="empty"><b>No hay vuelos disponibles el ${esc(dLong(L.date))}.</b>
        ${r.next_dates.length ? `<p>Próximas fechas con vuelo:</p><div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">${r.next_dates.map((d) => `<button class="secondary small" data-d="${d}">${esc(dDate(d))}</button>`).join('')}</div>` : '<p>Prueba otra fecha.</p>'}</div>`;
      $$('#flights button[data-d]').forEach((b) => b.addEventListener('click', () => { L.date = b.dataset.d; showLeg(); }));
      return;
    }
    box.innerHTML = r.flights.map((f) => flightHtml(f, S.pax)).join('');
    $$('#flights .flight').forEach((el, i) => {
      const f = r.flights[i];
      const main = $('.flight-main', el), fares = $('.fares', el);
      const toggle = () => {
        const open = fares.classList.contains('hidden');
        $$('#flights .fares').forEach((x) => x.classList.add('hidden'));
        $$('#flights .flight-main').forEach((x) => x.setAttribute('aria-expanded', 'false'));
        fares.classList.toggle('hidden', !open); main.setAttribute('aria-expanded', String(open));
      };
      main.addEventListener('click', toggle);
      main.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
      $$('[data-fare]', el).forEach((b) => b.addEventListener('click', () => {
        S.sel[S.leg] = { flight: f, fare: f.fares.find((x) => x.code === b.dataset.fare) };
        if (S.leg < S.legs.length - 1) { S.leg++; showLeg(); window.scrollTo({ top: $('#results').offsetTop - 80, behavior: 'smooth' }); }
        else showCheckout();
      }));
    });
  } catch (e) { box.innerHTML = `<div class="alert error">${esc(e.message)}</div>`; }
}

// Calendario de precios: el precio más bajo por persona (tarifa Básica) de cada día del mes.
$('#pcal-btn').addEventListener('click', () => {
  S.calOpen = !S.calOpen;
  $('#pcal-btn').innerHTML = `${icon('clock', 'ico-sm')} ${S.calOpen ? 'Ocultar calendario de precios' : 'Ver calendario de precios del mes'}`;
  if (S.calOpen) drawPriceCal(); else $('#pcal').classList.add('hidden');
});
async function drawPriceCal() {
  const L = S.legs[S.leg];
  const box = $('#pcal');
  box.classList.remove('hidden');
  const minDate = S.leg === 1 ? S.legs[0].date : S.cfg.today;
  const m = S.calMonth;
  box.innerHTML = '<div class="empty">Cargando precios…</div>';
  try {
    const r = await api(`/api/price-calendar?from=${L.from}&to=${L.to}&month=${m}&pax=${S.pax}`);
    const by = Object.fromEntries(r.days.map((d) => [d.date, d]));
    const cheap = r.min !== null ? r.min + Math.max(1, (r.max - r.min) * 0.15) : null;
    box.innerHTML = `<div class="modal-head" style="flex-wrap:wrap;gap:8px">
        <div><h3 style="margin:0">${esc(L.from)} → ${esc(L.to)} · ${esc(monthTitle(m))}</h3>
          <p class="muted small-txt" style="margin:2px 0 0">Precio más bajo por persona, tarifa Básica, sin impuestos.${r.min !== null ? ` Desde <b>${usd0(r.min)}</b>.` : ''}</p></div>
        <div style="display:flex;gap:6px"><button type="button" class="secondary small" data-mv="-1" ${m <= S.cfg.today.slice(0, 7) ? 'disabled' : ''} aria-label="Mes anterior">‹</button>
          <button type="button" class="secondary small" data-mv="1" aria-label="Mes siguiente">›</button></div></div>
      ${monthGridHtml(m, (d, n) => {
        const x = by[d] || {};
        const off = d < minDate || x.price === null || x.price === undefined;
        return `<button type="button" class="pday ${off ? 'off' : ''} ${!off && x.price <= cheap ? 'best' : ''} ${d === L.date ? 'on' : ''}" data-d="${d}" ${off ? 'disabled' : ''}
          aria-label="${esc(dLong(d))}${off ? ', sin vuelos' : ', desde ' + usd0(x.price)}"><span class="n">${n}</span><span class="p">${off ? (d < minDate ? '' : '—') : usd0(x.price)}</span></button>`;
      })}
      <div class="pcal-legend"><span><i class="best"></i> Precios más bajos del mes</span><span><i class="off"></i> Sin vuelos o sin lugares</span></div>`;
    $$('[data-mv]', box).forEach((b) => b.addEventListener('click', () => { S.calMonth = shiftMonth(S.calMonth, Number(b.dataset.mv)); drawPriceCal(); }));
    $$('.pday:not(:disabled)', box).forEach((b) => b.addEventListener('click', () => {
      L.date = b.dataset.d;
      if (S.leg === 0 && S.legs[1] && S.legs[1].date < L.date) S.legs[1].date = L.date;
      S.calOpen = false;
      showLeg();
    }));
  } catch (e) { box.innerHTML = `<div class="alert error">${esc(e.message)}</div>`; }
}

function totals() {
  const sub = S.sel.reduce((t, s) => t + s.fare.price, 0) * S.pax;
  const taxes = sub * S.cfg.tax_rate + S.cfg.service_fee * S.pax;
  const seats = (S.seatFee || []).reduce((t, x) => t + (x || 0), 0);
  return { sub, taxes, seats, total: sub + taxes + seats };
}

// Asientos durante la compra (opcional)
const seatMaps = {};
function paxNames() {
  return $$('#pax-list .pax-card').map((c, i) => {
    const n = [$('[name=first_name]', c).value, $('[name=last_name]', c).value].join(' ').trim();
    return `${i + 1}. ${n || 'Pasajero ' + (i + 1)}`;
  });
}
async function showSeatSeg(i) {
  S.seatSeg = i;
  $$('#seat-tabs button').forEach((b) => b.classList.toggle('on', Number(b.dataset.s) === i));
  const sg = S.sel[i];
  const key = sg.flight.route_id + sg.flight.date + sg.fare.code;
  $('#seat-map').innerHTML = '<div class="empty">Cargando mapa de asientos…</div>';
  try {
    seatMaps[key] = seatMaps[key] || await api(`/api/seatmap?route_id=${sg.flight.route_id}&date=${sg.flight.date}&fare=${sg.fare.code}`);
    mountSeatMap($('#seat-map'), { map: seatMaps[key], paxNames: paxNames(), sel: S.seats[i],
      note: sg.fare.code === 'flexible' ? 'Tu tarifa Flexible incluye cualquier asiento sin costo.' : sg.fare.code === 'clasica' ? 'Tu tarifa Clásica incluye asientos estándar sin costo.' : 'Si no eliges, se asigna un asiento gratis al documentar.',
      onChange: (sel, fee) => { S.seats[i] = sel; S.seatFee[i] = fee; drawSummary(); } });
  } catch (e) { $('#seat-map').innerHTML = `<div class="alert error">${esc(e.message)}</div>`; }
}

function showCheckout() {
  show('checkout');
  window.scrollTo({ top: $('#checkout').offsetTop - 80, behavior: 'smooth' });
  const intl = S.sel.some((s) => s.flight.international);
  $('#intl-note').classList.toggle('hidden', !intl);
  if (intl) $('#intl-note').innerHTML = icon('passport', 'ico-sm') + '<span><b>Vuelo internacional:</b> cada pasajero necesita pasaporte vigente y, si aplica, la visa del país de destino.</span>';
  const prev = $$('#pax-list .pax-card').map((c) => Object.fromEntries($$('[name]', c).map((i) => [i.name, i.value])));
  $('#pax-list').innerHTML = Array.from({ length: S.pax }, (_, i) => `
    <div class="pax-card"><h4><span class="n">${i + 1}</span> Pasajero ${i + 1} · Adulto</h4>
      <div class="row">
        <div><label>Nombre(s) *</label><input name="first_name" autocomplete="${i ? 'off' : 'given-name'}"></div>
        <div><label>Apellido(s) *</label><input name="last_name" autocomplete="${i ? 'off' : 'family-name'}"></div>
      </div>
      <div class="row3">
        <div><label>Fecha de nacimiento *</label><input name="birth_date" type="date" max="${S.cfg.today}"></div>
        <div><label>Sexo</label><select name="gender"><option value="">Prefiero no decir</option><option value="F">Femenino</option><option value="M">Masculino</option><option value="X">No binario</option></select></div>
        <div><label>Nacionalidad *</label><input name="nationality" placeholder="Ej. Mexicana"></div>
      </div>
      <div class="row">
        <div><label>Documento *</label><select name="doc_type">${S.cfg.doc_types.map((d) => `<option ${intl && d !== 'Pasaporte' ? 'disabled' : ''}>${d}</option>`).join('')}</select></div>
        <div><label>Número de documento *</label><input name="doc_number" autocomplete="off"></div>
      </div>
    </div>`).join('');
  $$('#pax-list .pax-card').forEach((c, i) => {
    if (prev[i]) $$('[name]', c).forEach((el) => { if (prev[i][el.name] !== undefined) el.value = prev[i][el.name]; });
    if (intl) $('[name=doc_type]', c).value = 'Pasaporte';
  });
  const key = S.sel.map((x) => x.flight.route_id + x.flight.date + x.fare.code).join('|') + S.pax;
  if (S.seatKey !== key) { S.seatKey = key; S.seats = S.sel.map(() => Array(S.pax).fill(null)); S.seatFee = S.sel.map(() => 0); }
  $('#seat-title').innerHTML = icon('ticket', 'ico-sm') + ' Elige tus asientos <span class="muted small-txt" style="font-weight:600">(opcional)</span>';
  $('#seat-hint').textContent = 'Toca un pasajero y luego un asiento. Puedes elegirlos después en Mi reserva.';
  $('#seat-tabs').innerHTML = S.sel.map((x, i) => `<button type="button" data-s="${i}">${x.flight.origin} → ${x.flight.destination} · ${esc(x.fare.name)}</button>`).join('');
  $$('#seat-tabs button').forEach((b) => b.addEventListener('click', () => showSeatSeg(Number(b.dataset.s))));
  $$('#pax-list [name=first_name], #pax-list [name=last_name]').forEach((inp) => inp.addEventListener('change', () => showSeatSeg(S.seatSeg || 0)));
  showSeatSeg(0);
  drawSummary();
}

function drawSummary() {
  const t = totals();
  $('#summary').innerHTML = `<h2>Tu viaje</h2>
    ${S.sel.map((s, i) => `<div class="sum-seg"><div class="r"><span>${s.flight.origin} → ${s.flight.destination}</span><span>${esc(s.flight.dep_time)}</span></div>
      <div class="d">${S.sel.length > 1 ? (i ? 'Regreso' : 'Ida') + ' · ' : ''}${esc(dLong(s.flight.date))}</div>
      <div class="d">${esc(s.flight.airline.name)} ${esc(s.flight.flight_no)} · ${dur(s.flight.duration_min)} · ${esc(s.fare.name)}</div></div>`).join('')}
    <div style="margin-top:10px">
      ${S.sel.map((s) => `<div class="sum-line"><span>${esc(s.fare.name)} ${s.flight.origin}–${s.flight.destination} × ${S.pax}</span><span>${usd(s.fare.price * S.pax)}</span></div>`).join('')}
      <div class="sum-line"><span>Impuestos (${Math.round(S.cfg.tax_rate * 100)} %) y cargo por servicio</span><span>${usd(t.taxes)}</span></div>
      ${(S.seats || []).some((a) => a.some(Boolean)) ? `<div class="sum-line"><span>Asientos (${S.seats.map((a, i) => a.filter(Boolean).join(', ')).filter(Boolean).join(' / ')})</span><span>${t.seats ? usd(t.seats) : 'Sin costo'}</span></div>` : ''}
      <div class="sum-total"><span>Total USD</span><b>${usd(t.total)}</b></div>
      <div class="hint">${S.cfg.online_payments ? 'Después de reservar puedes pagar con tarjeta en línea o' : 'Tienes ' + S.cfg.hold_hours + ' h para pagar'} en la agencia${S.cfg.online_payments ? ' (plazo: ' + S.cfg.hold_hours + ' h)' : ''}.</div>
    </div>`;
}
$('#back-results').addEventListener('click', () => { S.leg = 0; showLeg(); });

$('#pax-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#book-err'); hideMsg(err);
  const passengers = $$('#pax-list .pax-card').map((c) => Object.fromEntries($$('[name]', c).map((i) => [i.name, i.value.trim()])));
  for (const [i, p] of passengers.entries()) {
    if (!p.first_name || !p.last_name || !p.birth_date || !p.nationality || !p.doc_number) return showMsg(err, `Completa los datos del pasajero ${i + 1}.`);
  }
  const contact = { name: $('#c-name').value, email: $('#c-email').value, phone: $('#c-phone').value };
  if (!contact.name || !contact.email || !contact.phone) return showMsg(err, 'Completa los datos de contacto.');
  if (!$('#terms').checked) return showMsg(err, 'Marca la casilla de confirmación.');
  const btn = $('#book-btn'); btn.disabled = true; btn.textContent = 'Reservando…';
  try {
    const b = await api('/api/bookings', { method: 'POST', body: {
      segments: S.sel.map((s, i) => ({ route_id: s.flight.route_id, date: s.flight.date, fare: s.fare.code, seats: S.seats[i] })), passengers, contact, accept_terms: true } });
    Object.keys(seatMaps).forEach((k) => delete seatMaps[k]); S.seatKey = null;
    show('done');
    $('#done').innerHTML = `<div class="alert ok">${icon('check', 'ico-sm')}<span><b>¡Reserva creada!</b> Tus asientos están apartados. ${S.cfg.online_payments ? 'Paga ahora para emitir tus boletos.' : 'Guarda tu código: lo necesitas para pagar y consultar tu reserva.'}</span></div>
      ${bookingHtml(b)}
      <div class="row no-print" style="margin-top:16px;max-width:520px"><button class="secondary" data-print>Imprimir</button><a class="btn" href="/reserva?code=${esc(b.code)}">Ver mi reserva</a></div>`;
    bindPayBox(b, passengers[0].last_name);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (ex) { showMsg(err, ex.message); }
  finally { btn.disabled = false; btn.textContent = S.cfg.online_payments ? 'Reservar y continuar al pago' : 'Reservar y apartar asientos'; }
});
