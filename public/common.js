// ===== Utilidades compartidas =====
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = (n) => '$' + Number(n).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usd0 = (n) => '$' + Math.round(Number(n)).toLocaleString('es-MX');
const dt = (d) => new Date(d).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' });
const dDate = (s, opts = { weekday: 'short', day: 'numeric', month: 'short' }) => new Date(s + 'T12:00:00Z').toLocaleDateString('es-MX', { ...opts, timeZone: 'UTC' });
const dLong = (s) => dDate(s, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const dur = (m) => `${Math.floor(m / 60)} h${m % 60 ? ' ' + (m % 60) + ' min' : ''}`;
const addDays = (s, n) => new Date(Date.parse(s + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

const P = {
  plane: '<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z" transform="rotate(45 12 12)"/>',
  swap: '<path d="M7 7h13l-4-4M17 17H4l4 4"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  bag: '<rect x="5" y="7" width="14" height="13" rx="2"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/>',
  shield: '<path d="M12 3 4 6v6c0 4.5 3.4 8 8 9 4.6-1 8-4.5 8-9V6l-8-3z"/><path d="m9 12 2 2 4-4"/>',
  ticket: '<path d="M3 8a2 2 0 0 0 2-2h14a2 2 0 0 0 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 0-2 2H5a2 2 0 0 0-2-2v-2a2 2 0 0 0 0-4V8z"/><path d="M14 6v12" stroke-dasharray="2 2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  card: '<rect x="2.5" y="5" width="19" height="14" rx="2"/><path d="M2.5 10h19M6 15h4"/>',
  passport: '<rect x="5" y="3" width="14" height="18" rx="2"/><circle cx="12" cy="10" r="3"/><path d="M9 16h6"/>',
};
const icon = (n, cls = 'ico') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[n] || ''}</svg>`;

function renderHeader(active) {
  const links = [['/', 'Vuelos'], ['/reserva', 'Mi reserva'], ['/cita', 'Agendar cita'], ['/personal', 'Agencia']];
  const h = document.createElement('header');
  h.className = 'top';
  h.innerHTML = `<div class="wrap">
    <a class="logo" href="/" aria-label="VuelaLatino, inicio"><img src="/favicon.svg" alt="" width="36" height="36"><span>Vuela<b>Latino</b></span></a>
    <nav class="main" id="mainnav">${links.map(([href, t]) => `<a href="${href}" class="${active === href ? 'on' : ''}">${t}</a>`).join('')}</nav>
    <button class="secondary small menu-btn" id="menubtn" aria-label="Menú">${icon('menu', 'ico-sm')}</button>
  </div>`;
  document.body.prepend(h);
  $('#menubtn').addEventListener('click', () => $('#mainnav').classList.toggle('open'));
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) throw new Error((data && data.error) || 'Ocurrió un error. Intenta de nuevo.');
  return data;
}
function showMsg(el, text, kind = 'error') {
  if (!el) return;
  el.className = 'alert ' + kind;
  el.innerHTML = icon(kind === 'ok' ? 'check' : 'info', 'ico-sm') + '<span>' + esc(text) + '</span>';
  el.classList.remove('hidden');
}
function hideMsg(el) { if (el) el.classList.add('hidden'); }

const alLogo = (a) => `<span class="al-logo" style="background:${esc(a.color)}">${esc(a.code)}</span>`;
const nextDay = (o) => (o > 0 ? `<sup>+${o}</sup>` : o < 0 ? `<sup>${o}</sup>` : '');

// Fila de vuelo (resultado de búsqueda)
function flightHtml(f, pax) {
  const min = Math.min(...f.fares.map((x) => x.price));
  return `<div class="flight" data-route="${f.route_id}">
    <div class="flight-main" role="button" tabindex="0" aria-expanded="false">
      <div class="airline">${alLogo(f.airline)}<div><b>${esc(f.airline.name)}</b><span>${esc(f.flight_no)} · Directo</span></div></div>
      <div class="times">
        <div class="time"><b>${esc(f.dep_time)}</b><span>${esc(f.origin)}</span></div>
        <div class="path">${dur(f.duration_min)}<div class="line">${icon('plane')}</div>Sin escalas</div>
        <div class="time" style="text-align:right"><b>${esc(f.arr_time)}${nextDay(f.arr_offset)}</b><span>${esc(f.destination)}</span></div>
      </div>
      <div class="price-col"><span class="from">Desde, por persona</span><b>${usd0(min)}</b>
        ${f.seats_left <= 9 ? `<span class="seats">¡Quedan ${f.seats_left} asientos!</span>` : `<span class="from">Total ${pax} pax: ${usd0(min * pax)}</span>`}</div>
    </div>
    <div class="fares hidden">
      ${f.fares.map((fa) => `<div class="fare ${fa.code === 'clasica' ? 'pop' : ''}">
        <h4>${esc(fa.name)}</h4>
        <div class="fp">${usd(fa.price)} <small>por persona</small></div>
        <ul>${fa.includes.map((i) => `<li class="yes">${icon('check', 'ico-sm')}<span>${esc(i)}</span></li>`).join('')}
          ${fa.excludes.map((i) => `<li class="no">${icon('x', 'ico-sm')}<span>${esc(i)}</span></li>`).join('')}</ul>
        <button class="${fa.code === 'clasica' ? 'accent' : 'secondary'} block" data-fare="${fa.code}">Elegir ${esc(fa.name)}</button>
      </div>`).join('')}
    </div>
  </div>`;
}

// Recuadro "Pagar ahora" (Stripe). lastName autoriza el pago sin pedir de nuevo los datos.
function payBoxHtml(b) {
  if (!window.ONLINE_PAY || b.status !== 'pendiente_pago') return '';
  const bal = b.balance ?? b.total, dep = b.deposit, part = b.paid_amount > 0;
  return `<div class="paybox no-print" id="paybox">
    <div><h3>${icon('card')} ${part ? 'Paga tu saldo o haz otro abono con tarjeta' : 'Paga ahora con tarjeta y recibe tus boletos al instante'}</h3>
      <p>${part ? `Saldo <b>${usd(bal)} USD</b>` : `Total <b>${usd(b.total)} USD</b>`}. El pago se hace en la página segura de Stripe; no guardamos los datos de tu tarjeta.</p>
      ${dep && dep.allowed ? `<div class="pay-opts">
        <label class="check"><input type="radio" name="paymode" value="full" checked> <span>Pagar ${part ? 'el saldo' : 'el total'}: <b>${usd(bal)}</b> y emitir mis boletos</span></label>
        <label class="check"><input type="radio" name="paymode" value="part"> <span>${part ? 'Hacer un abono' : `Apartar con anticipo (desde ${usd(dep.min)})`}: <input id="payamt" type="number" step="0.01" min="${dep.min}" max="${bal}" value="${dep.min}" aria-label="Monto a pagar"> USD</span></label>
        <p class="hint" style="margin:0">Con anticipo tu reserva queda apartada; liquida el resto antes del <b>${esc(dLong(dep.deadline))}</b> (${dep.days} días antes del vuelo).</p>
      </div>` : ''}
      <div class="cards"><span>VISA</span><span>MASTERCARD</span><span>AMEX</span></div></div>
    <button class="accent" id="paynow" type="button">Pagar ${usd(bal)}</button>
    <div class="alert error hidden" id="payerr" style="grid-column:1/-1;margin:0"></div>
  </div>`;
}
function bindPayBox(b, lastName) {
  const btn = $('#paynow');
  if (!btn) return;
  const bal = b.balance ?? b.total;
  const amount = () => ($('input[name=paymode]:checked')?.value === 'part' ? Number($('#payamt').value) : bal);
  const label = () => { btn.textContent = 'Pagar ' + usd(amount() || 0); };
  $$('input[name=paymode]').forEach((r) => r.addEventListener('change', label));
  if ($('#payamt')) $('#payamt').addEventListener('input', () => { $('input[name=paymode][value=part]').checked = true; label(); });
  btn.addEventListener('click', async () => {
    hideMsg($('#payerr'));
    btn.disabled = true; btn.textContent = 'Abriendo pago seguro…';
    try {
      const r = await api(`/api/bookings/${encodeURIComponent(b.code)}/checkout`, { method: 'POST', body: { last_name: lastName, amount: amount() } });
      location.href = r.url;
    } catch (e) { showMsg($('#payerr'), e.message); btn.disabled = false; label(); }
  });
}

// ----- Calendario mensual (precios y agencia) -----
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const monthTitle = (m) => { const [y, mo] = m.split('-').map(Number); return MONTHS[mo - 1] + ' ' + y; };
const shiftMonth = (m, n) => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo - 1 + n, 1)).toISOString().slice(0, 7); };
// cell(fecha) devuelve el contenido de cada día. Semana de lunes a domingo.
function monthGridHtml(m, cell) {
  const [y, mo] = m.split('-').map(Number);
  const lead = (new Date(Date.UTC(y, mo - 1, 1)).getUTCDay() + 6) % 7;
  const n = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  let cells = '<span class="mcal-pad"></span>'.repeat(lead);
  for (let d = 1; d <= n; d++) cells += cell(`${m}-${String(d).padStart(2, '0')}`, d);
  return `<div class="mcal"><div class="mcal-g mcal-h">${['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'].map((x) => `<span>${x}</span>`).join('')}</div><div class="mcal-g">${cells}</div></div>`;
}

// Pagos recibidos de una reserva
function paymentsHtml(b, { staff = false } = {}) {
  if (!b.payments || !b.payments.length) return '';
  return `<div class="card" style="margin-bottom:14px"><h2>Pagos</h2><div class="table-wrap"><table>
    <thead><tr><th>Fecha</th><th>Forma de pago</th>${staff ? '<th>Registró / referencia</th>' : ''}<th style="text-align:right">Monto</th></tr></thead>
    <tbody>${b.payments.map((p) => `<tr><td class="small-txt">${dt(p.at)}</td><td>${esc(p.method)}${staff && p.note ? `<div class="muted small-txt">${esc(p.note)}</div>` : ''}</td>
      ${staff ? `<td class="small-txt">${esc(p.user_name || 'En línea')}${p.ref ? `<div class="muted">${esc(p.ref)}</div>` : ''}</td>` : ''}<td style="text-align:right"><b>${usd(p.amount)}</b></td></tr>`).join('')}</tbody></table></div>
    <div class="sum-line"><span>Pagado</span><b>${usd(b.paid_amount)}</b></div>
    ${b.status === 'pendiente_pago' ? `<div class="sum-total"><span>Saldo por pagar</span><b>${usd(b.balance)}</b></div>` : ''}</div>`;
}

// ----- Mapa de asientos -----
// map: respuesta de /api/seatmap. sel: arreglo por pasajero ('12A' o null). own: asientos que ya son de esta reserva.
function mountSeatMap(el, { map, paxNames, sel, own = [], onChange, note = '' }) {
  const S = { sel: sel.slice(), cur: Math.max(0, sel.findIndex((x) => !x)) };
  const ownSet = new Set(own.filter(Boolean));
  const byRow = {};
  map.seats.forEach((x) => { (byRow[x.row] = byRow[x.row] || {})[x.letter] = x; });
  const priceOf = (code) => map.seats.find((x) => x.seat === code)?.price || 0;
  const fee = () => S.sel.reduce((t, c) => t + (c ? priceOf(c) : 0), 0);
  const priceTxt = (p) => (p ? usd(p) : 'Sin costo');
  function draw() {
    const exitRows = new Set(map.seats.filter((x) => x.type === 'exit').map((x) => x.row));
    let rows = '';
    for (let r = 1; r <= map.rows; r++) {
      if (exitRows.has(r) && !exitRows.has(r - 1)) rows += '<div class="cabin-exit"><span>◄ SALIDA</span><span>SALIDA ►</span></div>';
      const cell = (l) => {
        const x = byRow[r]?.[l];
        if (!x) return '<span></span>';
        const mine = S.sel.indexOf(x.seat);
        const taken = x.taken && !ownSet.has(x.seat) && mine < 0;
        return `<button type="button" class="seat ${x.type} ${taken ? 'taken' : ''} ${mine >= 0 ? 'sel' : ''}" data-seat="${x.seat}" ${taken ? 'disabled' : ''}
          title="${x.seat} · ${esc(map.types[x.type])} · ${taken ? 'Ocupado' : priceTxt(x.price)}" aria-label="Asiento ${x.seat}${taken ? ' ocupado' : ''}">${mine >= 0 ? 'P' + (mine + 1) : l}</button>`;
      };
      rows += `<div class="cabin-row">${['A', 'B', 'C'].map(cell).join('')}<span class="rn">${r}</span>${['D', 'E', 'F'].map(cell).join('')}</div>`;
    }
    el.innerHTML = `<div class="seat-wrap">
      <div><div class="cabin"><div class="cabin-row head"><span>A</span><span>B</span><span>C</span><span></span><span>D</span><span>E</span><span>F</span></div>${rows}</div></div>
      <div class="seat-side">
        <div class="pax-pick">${paxNames.map((n, i) => `<button type="button" class="${i === S.cur ? 'on' : ''}" data-p="${i}"><span>${esc(n)}</span><span class="st">${S.sel[i] || 'Elegir'}</span></button>`).join('')}</div>
        <div class="legend">
          <div><i style="background:#fde2c8"></i>${esc(map.types.front)} · <b>${priceTxt(map.prices.front)}</b></div>
          <div><i style="background:#d5f2e3"></i>${esc(map.types.exit)} · <b>${priceTxt(map.prices.exit)}</b></div>
          <div><i style="background:#dbe5f7"></i>${esc(map.types.std)} · <b>${priceTxt(map.prices.std)}</b></div>
          <div><i style="background:#e3e7ee"></i>Ocupado</div>
        </div>
        ${note ? `<p class="hint" style="margin:0">${note}</p>` : ''}
        <div class="seat-total"><span>Asientos</span><span>${priceTxt(fee())}</span></div>
        <button type="button" class="ghost small" data-clear>Quitar asiento de ${esc(paxNames[S.cur] || '')}</button>
      </div></div>`;
    $$('.seat:not(:disabled)', el).forEach((b) => b.addEventListener('click', () => {
      const code = b.dataset.seat;
      const other = S.sel.indexOf(code);
      if (other >= 0 && other !== S.cur) S.sel[other] = null; // pasar el asiento a quien se está eligiendo
      S.sel[S.cur] = code;
      const next = S.sel.findIndex((x, i) => !x && i !== S.cur);
      S.cur = next >= 0 ? next : (S.cur + 1) % S.sel.length;
      draw(); onChange(S.sel.slice(), fee());
    }));
    $$('.pax-pick button', el).forEach((b) => b.addEventListener('click', () => { S.cur = Number(b.dataset.p); draw(); }));
    $('[data-clear]', el).addEventListener('click', () => { S.sel[S.cur] = null; draw(); onChange(S.sel.slice(), fee()); });
  }
  draw();
  onChange(S.sel.slice(), fee());
}
const SEAT_TYPE_SHORT = { front: 'Preferente', exit: 'Salida emergencia', std: 'Estándar' };

// Editor de asientos de una reserva existente (Mi reserva y panel). save(segIdx, seats) guarda y devuelve la reserva.
function mountSeatEditor(el, b, { save, note = '', onSaved }) {
  let seg = 0, pending = null;
  const names = b.passengers.map((p, i) => `${i + 1}. ${p.first_name} ${p.last_name}`);
  async function show() {
    const sg = b.segments[seg];
    el.innerHTML = `${b.segments.length > 1 ? `<div class="seg-tabs">${b.segments.map((x, i) => `<button type="button" class="${i === seg ? 'on' : ''}" data-s="${i}">${esc(x.origin)} → ${esc(x.destination)} · ${esc(dDate(x.date))}</button>`).join('')}</div>` : ''}
      <div id="se-map"><div class="empty">Cargando mapa…</div></div>
      <div class="alert error hidden" id="se-err"></div>
      <div class="row" style="margin-top:12px"><button type="button" class="secondary" id="se-cancel">Cerrar</button><button type="button" id="se-save">Guardar asientos ${esc(sg.origin)}–${esc(sg.destination)}</button></div>`;
    $$('.seg-tabs button', el).forEach((x) => x.addEventListener('click', () => { seg = Number(x.dataset.s); show(); }));
    $('#se-cancel', el).addEventListener('click', () => { el.innerHTML = ''; onSaved && onSaved(null); });
    try {
      const map = await api(`/api/seatmap?route_id=${sg.route_id}&date=${sg.date}&fare=${sg.fare}`);
      const cur = sg.seats.map((x) => (x ? x.seat : null));
      mountSeatMap($('#se-map', el), { map, paxNames: names, sel: cur, own: cur, note, onChange: (sel) => { pending = sel; } });
    } catch (e) { showMsg($('#se-err', el), e.message); }
    $('#se-save', el).addEventListener('click', async () => {
      hideMsg($('#se-err', el));
      try { const nb = await save(seg, pending); b = nb; onSaved && onSaved(nb); }
      catch (e) { showMsg($('#se-err', el), e.message); }
    });
  }
  show();
}

// ----- Corrección de datos -----
const PAX_LABELS = { first_name: 'Nombre(s)', last_name: 'Apellido(s)', birth_date: 'Fecha de nacimiento', gender: 'Sexo', nationality: 'Nacionalidad', doc_type: 'Documento', doc_number: 'Número de documento' };
const DOC_TYPES = ['Pasaporte', 'INE', 'DNI', 'Cédula de identidad', 'Otro documento oficial'];
const CR_STATUS = { pendiente: ['En revisión', 'b-pendiente_pago'], aprobada: ['Aprobada', 'b-emitido'], rechazada: ['Rechazada', 'b-cancelado'] };

function correctionsHtml(b) {
  if (!b.corrections || !b.corrections.length) return '';
  return `<div class="card" style="margin-bottom:14px"><h2>Solicitudes de corrección</h2>
    ${b.corrections.slice().reverse().map((c) => `<div class="sum-seg">
      <div class="r"><span>Pasajero ${c.passenger}</span><span class="badge ${CR_STATUS[c.status][1]}">${CR_STATUS[c.status][0]}</span></div>
      <div class="d">${Object.entries(c.changes).map(([k, v]) => `${PAX_LABELS[k] || k}: <s>${esc(v.from || '—')}</s> → <b>${esc(v.to || '—')}</b>`).join(' · ')}</div>
      <div class="d">Motivo: ${esc(c.reason)} · ${dt(c.created_at)}</div>
      ${c.response ? `<div class="d">Respuesta de la agencia: <b>${esc(c.response)}</b></div>` : ''}</div>`).join('')}</div>`;
}

function correctionFormHtml(b, { staff = false } = {}) {
  const issued = b.status !== 'pendiente_pago';
  const opt = (v, cur, label) => `<option value="${esc(v)}" ${v === (cur || '') ? 'selected' : ''}>${esc(label || v)}</option>`;
  return `<form id="corr-form" novalidate>
    ${issued && !staff ? `<div class="alert info">${icon('info', 'ico-sm')}<span>Tus boletos ya están emitidos: los cambios de pasajeros se envían como <b>solicitud</b> a la agencia, que la revisa. En el nombre solo se pueden corregir hasta 3 letras (errores de escritura). Los datos de contacto se actualizan de inmediato.</span></div>`
      : issued ? `<div class="alert warn">${icon('info', 'ico-sm')}<span>Boleto emitido: en el nombre solo se permiten hasta 3 letras de diferencia.</span></div>`
      : `<div class="alert info">${icon('info', 'ico-sm')}<span>Tu reserva aún no está pagada: los cambios se guardan de inmediato.</span></div>`}
    ${b.international ? `<p class="hint">${icon('passport', 'ico-sm')} Vuelo internacional: el documento debe ser pasaporte.</p>` : ''}
    ${b.passengers.map((p, i) => `<div class="pax-card" data-i="${i}"><h4><span class="n">${i + 1}</span> Pasajero ${i + 1}${p.ticket_number ? ` · Boleto ${esc(p.ticket_number)}` : ''}</h4>
      <div class="row">
        <div><label>Nombre(s)</label><input name="first_name" value="${esc(p.first_name)}"></div>
        <div><label>Apellido(s)</label><input name="last_name" value="${esc(p.last_name)}"></div>
      </div>
      <div class="row3">
        <div><label>Fecha de nacimiento</label><input name="birth_date" type="date" value="${esc(p.birth_date)}"></div>
        <div><label>Sexo</label><select name="gender">${opt('', p.gender, 'Prefiero no decir')}${opt('F', p.gender, 'Femenino')}${opt('M', p.gender, 'Masculino')}${opt('X', p.gender, 'No binario')}</select></div>
        <div><label>Nacionalidad</label><input name="nationality" value="${esc(p.nationality)}"></div>
      </div>
      <div class="row">
        <div><label>Documento</label><select name="doc_type">${DOC_TYPES.map((d) => opt(d, p.doc_type)).join('')}</select></div>
        <div><label>Número de documento</label>${staff ? `<input name="doc_number" value="${esc(p.doc_number)}">`
          : `<input name="doc_number" value="" placeholder="Sin cambios (termina en ${esc(String(p.doc_number).slice(-3))})">`}</div>
      </div></div>`).join('')}
    <h3>${icon('user', 'ico-sm')} Contacto</h3>
    <div class="row3">
      <div><label>Nombre</label><input name="c_name" value="${esc(b.contact_name)}"></div>
      <div><label>Correo</label><input name="c_email" type="email" value="${esc(b.contact_email)}"></div>
      <div><label>Teléfono</label><input name="c_phone" type="tel" value="${esc(b.contact_phone)}"></div>
    </div>
    ${issued || staff ? `<label for="corr-reason">${staff ? 'Motivo (opcional)' : 'Motivo de la corrección *'}</label><textarea id="corr-reason" rows="2" maxlength="300" placeholder="Ej. el apellido lleva acento, la fecha de nacimiento estaba mal"></textarea>` : ''}
    <div class="alert error hidden" id="corr-err"></div>
    <div class="row" style="margin-top:14px"><button type="button" class="secondary" id="corr-cancel">Cancelar</button><button type="submit">${issued && !staff ? 'Enviar solicitud' : 'Guardar cambios'}</button></div>
  </form>`;
}
function collectCorrection() {
  const f = $('#corr-form');
  return {
    passengers: $$('.pax-card', f).map((c) => Object.fromEntries($$('[name]', c).map((i) => [i.name, i.value.trim()]))),
    contact: { name: $('[name=c_name]', f).value, email: $('[name=c_email]', f).value, phone: $('[name=c_phone]', f).value },
    reason: $('#corr-reason') ? $('#corr-reason').value : '',
  };
}

// Boleto / itinerario de una reserva
function bookingHtml(b, { staff = false } = {}) {
  const issued = b.status === 'emitido';
  const head = `<div class="locator">
      <div><div class="lbl">Código de reserva</div><div class="code">${esc(b.code)}</div>
        <div class="small-txt" style="opacity:.85">Creada ${dt(b.created_at)} · ${b.pax_count} pasajero${b.pax_count > 1 ? 's' : ''}</div></div>
      <div style="text-align:right"><span class="badge b-${esc(b.status)}" style="font-size:.85rem">${esc(b.status_label)}</span>
        <div style="font-size:1.6rem;font-weight:800;margin-top:6px">${usd(b.total)} <small style="font-size:.8rem;opacity:.8">USD</small></div>
        ${b.status === 'pendiente_pago' && b.paid_amount > 0 ? `<div class="small-txt" style="opacity:.9">Saldo: <b>${usd(b.balance)}</b></div>` : ''}</div>
    </div>`;
  const dep = b.deposit;
  const pending = b.status === 'pendiente_pago' && b.paid_amount > 0
    ? `<div class="alert info">${icon('clock', 'ico-sm')}<span>Llevas pagado <b>${usd(b.paid_amount)}</b> de ${usd(b.total)}. <b>Liquida el saldo de ${usd(b.balance)} USD antes de ${dt(b.expires_at)}</b>${window.ONLINE_PAY ? ' en línea o' : ''} en la agencia; puedes hacerlo en varios abonos. Al completar el pago se emiten tus boletos.</span></div>`
    : b.status === 'pendiente_pago'
    ? `<div class="alert warn">${icon('clock', 'ico-sm')}<span><b>Paga antes de ${dt(b.expires_at)}</b>${window.ONLINE_PAY ? ' con tarjeta en línea o' : ''} en la agencia con tu código de reserva. Si no se paga a tiempo, la reserva se cancela y los asientos se liberan.${dep && dep.allowed ? ` <br><b>¿Prefieres pagar en abonos?</b> Aparta con un anticipo desde ${usd(dep.min)} (${Math.round(dep.pct * 100)} %) y liquida el resto antes del ${esc(dLong(dep.deadline))}.` : ''}</span></div>`
    : b.status === 'pago_revision'
      ? `<div class="alert info">${icon('info', 'ico-sm')}<span>Recibimos tu pago, pero la reserva necesita revisión (por ejemplo, venció antes de completarse el pago). La agencia te contactará para emitir tu boleto o reembolsarte.</span></div>`
      : b.status === 'emitido' && b.payment_method ? `<div class="alert ok">${icon('check', 'ico-sm')}<span>Pagado con <b>${esc(b.payment_method)}</b>${b.paid_at ? ' el ' + dt(b.paid_at) : ''}. Tus boletos están emitidos.</span></div>` : '';
  const segs = b.segments.map((s, i) => `
    <div class="ticket">
      <div class="ticket-main">
        <div class="ticket-top"><div class="airline">${alLogo(s.airline)}<div><b>${esc(s.airline.name)}</b><span>${esc(s.flight_no)} · ${esc(s.fare_name)}</span></div></div>
          <span class="badge" style="background:var(--surface-2);color:var(--ink-2)">${b.segments.length > 1 ? (i === 0 ? 'Ida' : 'Regreso') : 'Sencillo'}</span></div>
        <div class="big-route">
          <div><div class="code">${esc(s.origin)}</div><div class="city">${esc(s.origin_city)}</div><div class="t">${esc(s.dep_time)}</div></div>
          <div class="path">${dur(s.duration_min)}<div class="line">${icon('plane')}</div>Directo</div>
          <div style="text-align:right"><div class="code">${esc(s.destination)}</div><div class="city">${esc(s.destination_city)}</div><div class="t">${esc(s.arr_time)}${nextDay(s.arr_offset)}</div></div>
        </div>
        <div class="kv">
          <div><span>Fecha</span><b>${esc(dDate(s.date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }))}</b></div>
          <div><span>Vuelo</span><b>${esc(s.flight_no)}</b></div>
          <div><span>Tarifa</span><b>${esc(s.fare_name)}</b></div>
          <div><span>Equipaje</span><b>${s.fare === 'basica' ? 'Solo personal' : s.fare === 'clasica' ? '1 × 23 kg' : '2 × 23 kg'}</b></div>
        </div>
      </div>
      <div class="ticket-stub">
        <div><span class="muted small-txt">Pasajeros · Asiento</span>${b.passengers.map((p, pi) => `<div style="font-weight:700;font-size:.86rem;display:flex;justify-content:space-between;gap:8px"><span>${esc(p.last_name.toUpperCase())}/${esc(p.first_name.toUpperCase())}</span><span style="color:var(--brand)">${s.seats && s.seats[pi] ? esc(s.seats[pi].seat) : '—'}</span></div>`).join('')}</div>
        <div class="small-txt muted">${issued ? 'Documenta 2 h antes (nacional) o 3 h (internacional).' : 'Boleto pendiente de emisión.'}</div>
      </div>
    </div>`).join('');
  const pax = `<div class="card" style="margin-bottom:14px"><h2>Pasajeros</h2><div class="table-wrap"><table>
      <thead><tr><th>Nombre</th><th>Nacimiento</th><th>Documento</th><th>Asientos</th><th>Boleto</th></tr></thead>
      <tbody>${b.passengers.map((p, pi) => `<tr><td><b>${esc(p.first_name)} ${esc(p.last_name)}</b><div class="muted small-txt">${esc(p.nationality)}</div></td>
        <td>${esc(p.birth_date)}</td><td>${esc(p.doc_type)} ${esc(p.doc_number)}</td><td class="small-txt">${b.segments.map((sg) => `${esc(sg.origin)}–${esc(sg.destination)}: <b>${sg.seats && sg.seats[pi] ? esc(sg.seats[pi].seat) : 'Al documentar'}</b>`).join('<br>')}</td>
        <td>${p.ticket_number ? `<b>${esc(p.ticket_number)}</b>` : '<span class="muted">Pendiente</span>'}</td></tr>`).join('')}</tbody></table></div></div>`;
  const price = `<div class="card"><h2>Detalle del precio</h2>
      ${b.segments.map((s) => `<div class="sum-line"><span>${esc(s.origin)} → ${esc(s.destination)} · ${esc(s.fare_name)} × ${b.pax_count}</span><span>${usd(s.price_per_pax * b.pax_count)}</span></div>`).join('')}
      <div class="sum-line"><span>Impuestos y cargos</span><span>${usd(b.taxes)}</span></div>
      ${b.seats_total ? `<div class="sum-line"><span>Selección de asientos</span><span>${usd(b.seats_total)}</span></div>` : ''}
      <div class="sum-total"><span>Total USD</span><b>${usd(b.total)}</b></div>
      <div class="hint">Contacto: ${esc(b.contact_name)} · ${esc(b.contact_email)} · ${esc(b.contact_phone)}</div></div>`;
  return head + pending + (staff ? '' : payBoxHtml(b)) + segs + pax + correctionsHtml(b) + paymentsHtml(b, { staff }) + price;
}
