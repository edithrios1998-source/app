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
  const links = [['/', 'Vuelos'], ['/reserva', 'Mi reserva'], ['/personal', 'Agencia']];
  const h = document.createElement('header');
  h.className = 'top';
  h.innerHTML = `<div class="wrap">
    <a class="logo" href="/"><span class="logo-mark">${icon('plane', 'ico-sm')}</span><span>Vuela<b>Latino</b></span></a>
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

// Boleto / itinerario de una reserva
function bookingHtml(b, { staff = false } = {}) {
  const issued = b.status === 'emitido';
  const head = `<div class="locator">
      <div><div class="lbl">Código de reserva</div><div class="code">${esc(b.code)}</div>
        <div class="small-txt" style="opacity:.85">Creada ${dt(b.created_at)} · ${b.pax_count} pasajero${b.pax_count > 1 ? 's' : ''}</div></div>
      <div style="text-align:right"><span class="badge b-${esc(b.status)}" style="font-size:.85rem">${esc(b.status_label)}</span>
        <div style="font-size:1.6rem;font-weight:800;margin-top:6px">${usd(b.total)} <small style="font-size:.8rem;opacity:.8">USD</small></div></div>
    </div>`;
  const pending = b.status === 'pendiente_pago'
    ? `<div class="alert warn">${icon('clock', 'ico-sm')}<span><b>Paga antes de ${dt(b.expires_at)}</b> en la agencia presentando tu código de reserva. Si no se paga a tiempo, la reserva se cancela y los asientos se liberan.</span></div>` : '';
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
        <div><span class="muted small-txt">Pasajeros</span>${b.passengers.map((p) => `<div style="font-weight:700;font-size:.86rem">${esc(p.last_name.toUpperCase())}/${esc(p.first_name.toUpperCase())}</div>`).join('')}</div>
        <div class="small-txt muted">${issued ? 'Documenta 2 h antes (nacional) o 3 h (internacional).' : 'Boleto pendiente de emisión.'}</div>
      </div>
    </div>`).join('');
  const pax = `<div class="card" style="margin-bottom:14px"><h2>Pasajeros</h2><div class="table-wrap"><table>
      <thead><tr><th>Nombre</th><th>Nacimiento</th><th>Documento</th><th>Boleto</th></tr></thead>
      <tbody>${b.passengers.map((p) => `<tr><td><b>${esc(p.first_name)} ${esc(p.last_name)}</b><div class="muted small-txt">${esc(p.nationality)}</div></td>
        <td>${esc(p.birth_date)}</td><td>${esc(p.doc_type)} ${esc(p.doc_number)}</td>
        <td>${p.ticket_number ? `<b>${esc(p.ticket_number)}</b>` : '<span class="muted">Pendiente</span>'}</td></tr>`).join('')}</tbody></table></div></div>`;
  const price = `<div class="card"><h2>Detalle del precio</h2>
      ${b.segments.map((s) => `<div class="sum-line"><span>${esc(s.origin)} → ${esc(s.destination)} · ${esc(s.fare_name)} × ${b.pax_count}</span><span>${usd(s.price_per_pax * b.pax_count)}</span></div>`).join('')}
      <div class="sum-line"><span>Impuestos y cargos</span><span>${usd(b.taxes)}</span></div>
      <div class="sum-total"><span>Total USD</span><b>${usd(b.total)}</b></div>
      <div class="hint">Contacto: ${esc(b.contact_name)} · ${esc(b.contact_email)} · ${esc(b.contact_phone)}</div></div>`;
  return head + pending + segs + pax + price + (staff ? '' : '');
}
