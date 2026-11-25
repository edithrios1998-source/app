renderHeader('/personal');
let me = null, cfg = null, cat = null;
const DAYS = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
const daysTxt = (d) => d.length === 7 ? 'Diario' : [...d].map((x) => DAYS[x - 1]).join(' ');
const closeModal = () => $('#modal').classList.add('hidden');
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

async function boot() {
  cfg = await api('/api/config');
  me = (await api('/api/auth/me')).user;
  $('#login').classList.toggle('hidden', !!me); $('#panel').classList.toggle('hidden', !me);
  if (!me) return;
  $('#who').textContent = me.name; $('#role').textContent = me.role === 'admin' ? '· Administrador' : '· Agente de ventas';
  $$('.admin-only').forEach((el) => el.classList.toggle('hidden', me.role !== 'admin'));
  $('#fs').innerHTML = '<option value="">Todos los estados</option>' + Object.entries(cfg.statuses).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
  loadBookings();
  refreshCorrCount().catch(() => {});
  refreshAgCount().catch(() => {});
}
const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
const goTab = (name) => $(`.tabs button[data-tab="${name}"]`).click();
$('#login-f').addEventListener('submit', async (e) => {
  e.preventDefault(); hideMsg($('#login-err'));
  try { await api('/api/auth/login', { method: 'POST', body: { username: $('#u').value, password: $('#p').value } }); $('#p').value = ''; boot(); }
  catch (ex) { showMsg($('#login-err'), ex.message); }
});
$('#logout').addEventListener('click', async () => { await api('/api/auth/logout', { method: 'POST' }); location.reload(); });
$$('.tabs button').forEach((b) => b.addEventListener('click', () => {
  $$('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
  $$('[data-pane]').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== b.dataset.tab));
  const pane = $(`[data-pane="${b.dataset.tab}"]`);
  $$('.pane-err', pane).forEach((x) => x.remove());
  pane.setAttribute('aria-busy', 'true');
  Promise.resolve(({ bookings: loadBookings, payments: loadPayments, calendar: loadCalendar, agenda: loadAgenda, corrections: loadCorrections, routes: loadRoutes, catalog: loadCatalog, settings: loadSettings, users: loadUsers })[b.dataset.tab]())
    .catch((e) => {
      if (/Inicia sesión/.test(e.message)) return location.reload();
      pane.insertAdjacentHTML('afterbegin', `<div class="alert error pane-err">${icon('info', 'ico-sm')}<span>No se pudo cargar: ${esc(e.message)} <button type="button" class="linkbtn" data-retry>Reintentar</button></span></div>`);
      $('[data-retry]', pane).onclick = () => b.click();
    })
    .finally(() => pane.removeAttribute('aria-busy'));
}));
// Errores no atendidos (p. ej. la sesión expiró): aviso visible en lugar de fallar en silencio.
window.addEventListener('unhandledrejection', (e) => {
  const msg = e.reason && e.reason.message ? e.reason.message : 'Ocurrió un error.';
  if (/Inicia sesión/.test(msg)) return location.reload();
  toast(msg);
});

// ----- reservas -----
let qT; $('#q').addEventListener('input', () => { clearTimeout(qT); qT = setTimeout(loadBookings, 300); });
$('#fs').addEventListener('change', loadBookings); $('#reload').addEventListener('click', loadBookings);
async function loadBookings() {
  const [rows, stats] = await Promise.all([api('/api/staff/bookings?' + new URLSearchParams({ q: $('#q').value, status: $('#fs').value })), api('/api/staff/stats')]);
  const order = Object.keys(cfg.statuses);
  stats.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
  $('#stats').innerHTML = stats.length ? stats.map((s) => `<div class="stat"><div class="muted small-txt">${esc(s.label)}</div><div class="n">${s.n}</div><div class="muted small-txt">${s.pax} pax · ${usd(s.total)}</div></div>`).join('') : '<div class="muted">Aún no hay reservas.</div>';
  $('#rows').innerHTML = rows.length ? rows.map((b) => `<tr class="click" data-id="${b.id}">
    <td><b style="letter-spacing:1px">${esc(b.code)}</b><div class="muted small-txt">${b.origin === 'web' ? 'En línea' : 'Agencia'}</div></td>
    <td class="small-txt">${dt(b.created_at)}</td><td>${esc(b.contact_name)}</td>
    <td class="small-txt">${b.segments.map((s) => `<b>${esc(s.route)}</b> ${esc(s.flight)} · ${esc(dDate(s.date))}`).join('<br>')}</td>
    <td>${b.pax_count}</td><td>${usd(b.total)}${b.status === 'pendiente_pago' && b.paid_amount > 0 ? `<div class="small-txt" style="color:var(--ok)">Pagado ${usd(b.paid_amount)}</div>` : ''}</td>
    <td><span class="badge b-${esc(b.status)}">${esc(b.status_label)}</span>${b.status === 'pendiente_pago' ? `<div class="muted small-txt">vence ${dt(b.expires_at)}</div>` : ''}</td></tr>`).join('')
    : '<tr><td colspan="7" class="muted">Sin resultados.</td></tr>';
  $$('#rows tr[data-id]').forEach((tr) => tr.addEventListener('click', () => openBooking(tr.dataset.id)));
}
async function openBooking(id) {
  const b = await api('/api/staff/bookings/' + id);
  const admin = me.role === 'admin';
  const canCancel = (b.status === 'pendiente_pago' && (!b.paid_amount || admin)) || (['emitido', 'pago_revision'].includes(b.status) && admin) || (b.status === 'vencido' && b.paid_amount > 0 && admin);
  const dep = b.deposit;
  const canFix = ['pendiente_pago', 'emitido', 'pago_revision'].includes(b.status);
  $('#mb').innerHTML = `<div class="modal-head no-print" style="margin-bottom:12px"><h2 style="margin:0">Reserva ${esc(b.code)}</h2><button class="secondary small" id="mclose">Cerrar</button></div>
    ${bookingHtml(b, { staff: true })}
    <div class="card no-print" style="margin-top:14px"><h2>Historial</h2><ul class="timeline">${b.events.map((e) => `<li><b>${esc(e.label)}</b>${e.note ? ' — ' + esc(e.note) : ''}<br><span class="muted small-txt">${dt(e.at)}${e.user_name ? ' · ' + esc(e.user_name) : ''}</span></li>`).join('')}</ul></div>
    <div class="card no-print" style="margin-top:14px">
      ${b.status === 'pendiente_pago' ? `<h2>Registrar pago</h2>
        <div class="pay-sum"><div><span>Total</span><b>${usd(b.total)}</b></div><div><span>Pagado</span><b>${usd(b.paid_amount)}</b></div><div class="due"><span>Saldo</span><b>${usd(b.balance)}</b></div></div>
        <p class="muted small-txt" style="margin:8px 0 0">${dep && dep.allowed
          ? `Acepta abonos: ${b.paid_amount > 0 ? 'abono' : 'anticipo'} mínimo <b>${usd(dep.min)}</b>. El saldo se liquida antes del <b>${esc(dLong(dep.deadline))}</b>.`
          : 'Esta reserva se cobra completa (el vuelo está cerca o no admite abonos).'} Verifica que los nombres coincidan con los documentos.</p>
        <div class="row3"><div><label for="pa">Monto (USD)</label><input id="pa" type="number" step="0.01" min="${dep && dep.allowed ? dep.min : b.balance}" max="${b.balance}" value="${b.balance}" ${dep && dep.allowed ? '' : 'readonly'}></div>
          <div><label for="pm">Forma de pago</label><select id="pm"><option>Efectivo</option><option>Tarjeta en terminal</option><option>Transferencia</option><option>Depósito bancario</option></select></div>
          <div><label for="pn">Nota (opcional)</label><input id="pn" placeholder="Ej. folio de terminal"></div></div>
        <button class="accent block" id="pay" style="margin-top:14px"></button>` : ''}
      <div class="alert error hidden" id="merr"></div>
      <div class="row" style="margin-top:12px">
        <button class="secondary" data-print>Imprimir</button>
        ${canFix ? '<button class="secondary" id="fix">Corregir datos</button><button class="secondary" id="seats">Asientos</button>' : ''}
        ${canCancel ? '<button class="danger" id="cancel">Cancelar reserva</button>' : ''}
      </div>
      <div id="fix-body"></div>
    </div>`;
  $('#modal').classList.remove('hidden'); $('#mclose').onclick = closeModal;
  if ($('#pay')) {
    const label = () => {
      const a = Number($('#pa').value) || 0;
      $('#pay').textContent = a >= b.balance - 0.005 ? `Registrar ${usd(b.balance)} y emitir ${b.pax_count} boleto${b.pax_count > 1 ? 's' : ''}` : `Registrar ${b.paid_amount > 0 ? 'abono' : 'anticipo'} de ${usd(a)}`;
    };
    $('#pa').addEventListener('input', label); label();
    $('#pay').onclick = async () => {
      const a = Number($('#pa').value) || 0;
      if (!confirm(`¿Registrar ${usd(a)} USD en ${$('#pm').value} para la reserva ${b.code}?`)) return;
      try { await api(`/api/staff/bookings/${b.id}/payments`, { method: 'POST', body: { amount: a, method: $('#pm').value, note: $('#pn').value } }); loadBookings(); openBooking(b.id); }
      catch (e) { showMsg($('#merr'), e.message); }
    };
  }
  if ($('#seats')) $('#seats').onclick = () => {
    $('#fix-body').innerHTML = '<h2 style="margin-top:18px">Asientos</h2><div id="seat-ed"></div>';
    mountSeatEditor($('#seat-ed'), b, {
      note: b.status === 'pendiente_pago' ? 'El costo de los asientos se suma al total de la reserva.' : 'Boleto emitido: si el nuevo asiento cuesta más, cobra la diferencia en mostrador (queda anotado en el historial).',
      save: (seg, seats) => api('/api/staff/bookings/' + b.id + '/seats', { method: 'PUT', body: { segment: seg, seats } }),
      onSaved: (nb) => { if (nb) { loadBookings(); openBooking(b.id); } else $('#fix-body').innerHTML = ''; },
    });
    $('#fix-body').scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  if ($('#fix')) $('#fix').onclick = () => {
    $('#fix').classList.add('hidden');
    $('#fix-body').innerHTML = '<h2 style="margin-top:18px">Corregir datos</h2>' + correctionFormHtml(b, { staff: true });
    $('#fix-body').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('#corr-cancel').onclick = () => { $('#fix-body').innerHTML = ''; $('#fix').classList.remove('hidden'); };
    $('#corr-form').addEventListener('submit', async (e) => {
      e.preventDefault(); hideMsg($('#corr-err'));
      try { await api('/api/staff/bookings/' + b.id + '/correct', { method: 'PUT', body: collectCorrection() }); loadBookings(); openBooking(b.id); }
      catch (ex) { showMsg($('#corr-err'), ex.message); }
    });
  };
  if ($('#cancel')) $('#cancel').onclick = async () => {
    if (!confirm(`¿Cancelar la reserva ${b.code}? Los asientos se liberan y no se puede deshacer.`)) return;
    try { await api(`/api/staff/bookings/${b.id}/cancel`, { method: 'POST', body: {} }); loadBookings(); openBooking(b.id); }
    catch (e) { showMsg($('#merr'), e.message); }
  };
}

// ----- pagos -----
let payData = null;
['#pf', '#pt', '#pmf'].forEach((s) => $(s).addEventListener('change', loadPayments));
async function loadPayments() {
  if (!$('#pf').value) { $('#pf').value = addDays(cfg.today, -30); $('#pt').value = cfg.today; }
  const p = payData = await api('/api/staff/payments?' + new URLSearchParams({ from: $('#pf').value, to: $('#pt').value, method: $('#pmf').value }));
  if ($('#pmf').options.length === 1) $('#pmf').innerHTML += p.methods.map((m) => `<option>${esc(m)}</option>`).join('');
  const owed = p.balances.reduce((t, b) => t + b.balance, 0);
  $('#pay-stats').innerHTML = [['Cobrado hoy', p.summary.day], ['Esta semana', p.summary.week], ['Este mes', p.summary.month]]
    .map(([t, v]) => `<div class="stat"><div class="muted small-txt">${t}</div><div class="n">${usd(v)}</div></div>`).join('')
    + `<div class="stat"><div class="muted small-txt">Saldos por cobrar</div><div class="n">${usd(owed)}</div><div class="muted small-txt">${p.balances.length} reserva${p.balances.length === 1 ? '' : 's'}</div></div>`;
  $('#pay-methods').innerHTML = `<span class="chip"><b>Total del periodo: ${usd(p.total)}</b> · ${p.rows.length} pago${p.rows.length === 1 ? '' : 's'}</span>`
    + p.by_method.map((m) => `<span class="chip">${esc(m.method)}: <b>${usd(m.total)}</b> (${m.n})</span>`).join('');
  $('#pay-rows').innerHTML = p.rows.map((x) => `<tr class="click" data-id="${x.booking_id}"><td class="small-txt">${dt(x.at)}</td>
    <td><b style="letter-spacing:1px">${esc(x.code)}</b><div><span class="badge b-${esc(x.status)}">${esc(x.status_label)}</span></div></td><td>${esc(x.contact_name)}</td>
    <td>${esc(x.method)}${x.note ? `<div class="muted small-txt">${esc(x.note)}</div>` : ''}</td><td class="small-txt">${esc(x.user_name || 'En línea')}</td>
    <td style="text-align:right"><b>${usd(x.amount)}</b></td></tr>`).join('') || '<tr><td colspan="6" class="muted">No hay pagos en estas fechas.</td></tr>';
  const balRow = (b, withDue) => `<tr class="click" data-id="${b.id}"><td><b style="letter-spacing:1px">${esc(b.code)}</b></td><td>${esc(b.contact_name)}<div class="muted small-txt">${esc(b.contact_phone)}</div></td>
    <td>${usd(b.total)}</td><td>${usd(b.paid)}</td>${withDue ? `<td><b>${usd(b.balance)}</b></td><td class="small-txt">${dt(b.expires_at)}</td>` : ''}</tr>`;
  $('#bal-rows').innerHTML = p.balances.map((b) => balRow(b, true)).join('') || '<tr><td colspan="6" class="muted">No hay saldos pendientes.</td></tr>';
  $('#stale-card').classList.toggle('hidden', !p.expired_with_money.length);
  $('#stale-rows').innerHTML = p.expired_with_money.map((b) => balRow(b, false)).join('');
  $$('[data-pane=payments] tr[data-id]').forEach((tr) => tr.addEventListener('click', () => openBooking(tr.dataset.id)));
}
$('#pay-csv').addEventListener('click', () => {
  if (!payData) return;
  const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const lines = [['Fecha', 'Reserva', 'Cliente', 'Forma de pago', 'Referencia', 'Nota', 'Registró', 'Monto USD'].map(q).join(',')]
    .concat(payData.rows.map((x) => [new Date(x.at).toLocaleString('es-MX'), x.code, x.contact_name, x.method, x.ref, x.note, x.user_name || 'En línea', x.amount.toFixed(2)].map(q).join(',')));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  a.download = `pagos_${payData.from}_${payData.to}.csv`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

// ----- calendario de la agencia -----
let calMonth = null, calData = null, calSel = null;
$('#cal-prev').onclick = () => { calMonth = shiftMonth(calMonth, -1); loadCalendar(); };
$('#cal-next').onclick = () => { calMonth = shiftMonth(calMonth, 1); loadCalendar(); };
$('#cal-today').onclick = () => { calMonth = cfg.today.slice(0, 7); calSel = cfg.today; loadCalendar(); };
async function loadCalendar() {
  calMonth = calMonth || cfg.today.slice(0, 7);
  calSel = calSel && calSel.startsWith(calMonth) ? calSel : (cfg.today.startsWith(calMonth) ? cfg.today : calMonth + '-01');
  $('#cal-title').textContent = monthTitle(calMonth);
  calData = await api('/api/staff/calendar?month=' + calMonth);
  $('#cal-grid').innerHTML = monthGridHtml(calMonth, (d, n) => {
    const x = calData.days[d];
    const chips = x ? [
      x.departures.length ? `<i class="c-dep">✈ ${x.departures.length}</i>` : '',
      x.expiring.length ? `<i class="c-exp">⏰ ${x.expiring.length}</i>` : '',
      x.payments.n ? `<i class="c-pay">${usd0(x.payments.total)}</i>` : '',
      x.appointments.length ? `<i class="c-apt">${x.appointments.length} cita${x.appointments.length > 1 ? 's' : ''}</i>` : '',
      x.tasks.length ? `<i class="c-task">${x.tasks.filter((t) => t.done).length}/${x.tasks.length} tareas</i>` : '',
    ].join('') : '';
    return `<button type="button" class="aday ${d === cfg.today ? 'today' : ''} ${d === calSel ? 'on' : ''}" data-d="${d}"><span class="n">${n}</span><span class="chips-s">${chips}</span></button>`;
  });
  $$('#cal-grid .aday').forEach((b) => b.addEventListener('click', () => { calSel = b.dataset.d; $$('#cal-grid .aday').forEach((x) => x.classList.toggle('on', x === b)); drawCalDay(); }));
  drawCalDay();
}
function drawCalDay() {
  const x = calData.days[calSel] || { departures: [], expiring: [], payments: { n: 0, total: 0 }, appointments: [], tasks: [] };
  const link = (id, code) => `<button type="button" class="linkbtn" data-open="${id}"><b style="letter-spacing:1px">${esc(code)}</b></button>`;
  const sec = (title, items, empty) => `<h3>${title}</h3>${items.length ? `<ul class="day-list">${items.join('')}</ul>` : `<p class="muted small-txt" style="margin:0">${empty}</p>`}`;
  $('#cal-day').innerHTML = `<div class="modal-head" style="flex-wrap:wrap"><h2 style="margin:0">${esc(cap(dLong(calSel)))}</h2>
      <button class="secondary small" id="cal-open-ag">Abrir agenda de este día</button></div>
    ${sec('✈ Salidas de clientes', x.departures.map((s) => `<li><span class="t">${esc(s.time)}</span> ${esc(s.flight)} <b>${esc(s.route)}</b> · ${link(s.booking_id, s.code)} ${esc(s.contact_name)} · ${s.pax} pax <span class="badge b-${esc(s.status)}">${esc(s.status_label)}</span></li>`), 'Ningún cliente vuela este día.')}
    ${sec('⏰ Reservas que vencen', x.expiring.map((e) => `<li><span class="t">${new Date(e.at).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })}</span> ${link(e.booking_id, e.code)} ${esc(e.contact_name)} · saldo <b>${usd(e.balance)}</b></li>`), 'Ninguna reserva vence este día.')}
    ${sec('$ Cobrado', x.payments.n ? [`<li><b>${usd(x.payments.total)}</b> en ${x.payments.n} pago${x.payments.n > 1 ? 's' : ''}</li>`] : [], 'Sin cobros.')}
    ${sec('Citas', x.appointments.map((a) => `<li><span class="t">${esc(a.time)}</span> ${esc(a.name)} · ${esc(a.reason)} <span class="badge ${APPT_BADGE[a.status]}">${esc(APPT_LABEL[a.status])}</span></li>`), 'Sin citas.')}
    ${sec('Tareas', x.tasks.map((t) => `<li>${t.done ? '✅' : '⬜'} ${t.time ? `<span class="t">${esc(t.time)}</span> ` : ''}${esc(t.title)}</li>`), 'Sin tareas.')}`;
  $$('#cal-day [data-open]').forEach((a) => a.onclick = (e) => { e.preventDefault(); openBooking(a.dataset.open); });
  $('#cal-open-ag').onclick = () => { agDate = calSel; goTab('agenda'); };
}

// ----- agenda -----
const APPT_LABEL = { pendiente: 'Por confirmar', confirmada: 'Confirmada', atendida: 'Atendida', no_asistio: 'No asistió', cancelada: 'Cancelada' };
const APPT_BADGE = { pendiente: 'b-pendiente_pago', confirmada: 'b-emitido', atendida: 'b-vencido', no_asistio: 'b-cancelado', cancelada: 'b-cancelado' };
const REM = { vence: ['⏰', 'Vence pronto'], saldo: ['$', 'Saldo pendiente'], anticipo: ['!', 'Vencida con anticipo'], revision: ['!', 'Pago en revisión'], cita: ['📅', 'Cita por confirmar'], correccion: ['✎', 'Correcciones'] };
let agDate = null, agData = null;
async function refreshAgCount() {
  const r = await api('/api/staff/agenda');
  const n = r.reminders.length + r.tasks.filter((t) => !t.done).length;
  $('#ag-count').textContent = n; $('#ag-count').classList.toggle('hidden', !n);
}
$('#ag-prev').onclick = () => { agDate = addDays(agDate, -1); loadAgenda(); };
$('#ag-next').onclick = () => { agDate = addDays(agDate, 1); loadAgenda(); };
$('#ag-today').onclick = () => { agDate = cfg.today; loadAgenda(); };
$('#ag-date').onchange = () => { if ($('#ag-date').value) { agDate = $('#ag-date').value; loadAgenda(); } };
async function loadAgenda() {
  agDate = agDate || cfg.today;
  const r = agData = await api('/api/staff/agenda?date=' + agDate);
  $('#ag-date').value = agDate;
  $('#ag-title').textContent = cap(dLong(agDate)) + (agDate === cfg.today ? ' · hoy' : '');
  const free = r.slots.reduce((t, s) => t + s.left, 0);
  const close = r.open ? (() => { const [h, m] = r.slots.at(-1).time.split(':').map(Number); const t = h * 60 + m + 30; return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; })() : '';
  $('#ag-slots').textContent = r.open ? `Horario de ${r.slots[0].time} a ${close} · ${free} lugar${free === 1 ? '' : 'es'} libre${free === 1 ? '' : 's'} para citas.` : 'La agencia no abre este día.';
  $('#appt-list').innerHTML = r.appointments.length ? r.appointments.map((a) => `<div class="appt ${a.status}" data-id="${a.id}">
      <div class="appt-t">${esc(a.time)}</div>
      <div class="appt-b"><div><b>${esc(a.name)}</b> · <a href="tel:${esc(a.phone)}">${esc(a.phone)}</a>${a.email ? ' · ' + esc(a.email) : ''} <span class="badge ${APPT_BADGE[a.status]}">${esc(a.status_label)}</span></div>
        <div class="small-txt">${esc(a.reason_label)}${a.booking_code ? ` · Reserva <button type="button" class="linkbtn" data-code="${esc(a.booking_code)}"><b>${esc(a.booking_code)}</b></button>` : ''} · <span class="muted">Folio ${esc(a.code)} · ${a.origin === 'web' ? 'agendada en línea' : 'agendada en agencia'}</span></div>
        ${a.notes ? `<div class="small-txt muted">“${esc(a.notes)}”</div>` : ''}
        ${['pendiente', 'confirmada'].includes(a.status) ? `<div class="appt-act">
          ${a.status === 'pendiente' ? '<button class="small accent" data-st="confirmada">Confirmar</button>' : ''}
          <button class="small secondary" data-st="atendida">Atendida</button><button class="small secondary" data-st="no_asistio">No asistió</button>
          <button class="small secondary" data-mv>Reprogramar</button><button class="small danger" data-st="cancelada">Cancelar</button></div>` : ''}</div></div>`).join('')
    : `<div class="empty" style="padding:18px">Sin citas este día.</div>`;
  $$('#appt-list .appt').forEach((el) => {
    const a = r.appointments.find((x) => String(x.id) === el.dataset.id);
    $$('[data-st]', el).forEach((b) => b.onclick = async () => {
      if (b.dataset.st === 'cancelada' && !confirm(`¿Cancelar la cita de ${a.name}?`)) return;
      try { await api('/api/staff/appointments/' + a.id, { method: 'PUT', body: { status: b.dataset.st } }); loadAgenda(); refreshAgCount(); } catch (e) { alert(e.message); }
    });
    if ($('[data-mv]', el)) $('[data-mv]', el).onclick = () => apptForm(a);
  });
  $$('#appt-list [data-code]').forEach((x) => x.onclick = async (e) => { e.preventDefault(); try { openBooking((await api('/api/staff/booking-by-code/' + x.dataset.code)).id); } catch (ex) { alert(ex.message); } });
  // tareas
  $('#ta').innerHTML = '<option value="">Cualquiera</option>' + r.users.map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('');
  $('#task-list').innerHTML = r.tasks.length ? r.tasks.map((t) => `<div class="task ${t.done ? 'done' : ''} ${t.overdue ? 'late' : ''}" data-id="${t.id}">
      <label class="check"><input type="checkbox" ${t.done ? 'checked' : ''}> <span><b>${esc(t.title)}</b>
        <span class="small-txt muted">${t.overdue ? `<b style="color:var(--danger)">Atrasada (${esc(dDate(t.due_date))})</b> · ` : ''}${t.due_time ? esc(t.due_time) + ' · ' : ''}${t.booking_code ? `Reserva <button type="button" class="linkbtn" data-code="${esc(t.booking_code)}">${esc(t.booking_code)}</button> · ` : ''}${t.assigned_name ? 'Para ' + esc(t.assigned_name) : 'Para cualquiera'}${t.done ? ' · Hecha por ' + esc(t.done_by || '') : ''}</span></span></label>
      <button class="ghost small" data-del aria-label="Borrar tarea">${icon('x', 'ico-sm')}</button></div>`).join('')
    : '<p class="muted small-txt">No hay tareas para este día.</p>';
  $$('#task-list .task').forEach((el) => {
    $('input', el).onchange = async (e) => { await api('/api/staff/tasks/' + el.dataset.id, { method: 'PUT', body: { done: e.target.checked } }); loadAgenda(); refreshAgCount(); };
    $('[data-del]', el).onclick = async () => { if (!confirm('¿Borrar esta tarea?')) return; await api('/api/staff/tasks/' + el.dataset.id, { method: 'DELETE' }); loadAgenda(); refreshAgCount(); };
  });
  $$('#task-list [data-code]').forEach((x) => x.onclick = async (e) => { e.preventDefault(); try { openBooking((await api('/api/staff/booking-by-code/' + x.dataset.code)).id); } catch (ex) { alert(ex.message); } });
  // pendientes automáticos
  $('#rem-list').innerHTML = r.reminders.length ? r.reminders.map((x, i) => `<div class="rem rem-${x.kind}">
      <span class="rem-i">${REM[x.kind][0]}</span>
      <div><div class="small-txt"><b>${REM[x.kind][1]}</b>${x.code ? ` · <button type="button" class="linkbtn" data-open="${x.booking_id}"><b>${esc(x.code)}</b></button>` : ''}${x.at ? ` · ${dt(x.at)}` : ''}</div>
        <div class="small-txt">${esc(x.text)}</div>
        <div class="rem-act">${x.kind === 'cita' ? `<button class="ghost small" data-day="${x.date}">Ver día</button>` : ''}${x.kind === 'correccion' ? '<button class="ghost small" data-corr>Revisar</button>' : ''}
          ${x.code ? `<button class="ghost small" data-task="${i}">+ Tarea para hoy</button>` : ''}</div></div></div>`).join('')
    : '<div class="empty" style="padding:18px">Todo al día ✓</div>';
  $$('#rem-list [data-open]').forEach((a) => a.onclick = (e) => { e.preventDefault(); openBooking(a.dataset.open); });
  $$('#rem-list [data-day]').forEach((b) => b.onclick = () => { agDate = b.dataset.day; loadAgenda(); });
  $$('#rem-list [data-corr]').forEach((b) => b.onclick = () => goTab('corrections'));
  $$('#rem-list [data-task]').forEach((b) => b.onclick = async () => {
    const x = r.reminders[Number(b.dataset.task)];
    const title = { vence: 'Llamar: reserva por vencer sin pago', saldo: 'Llamar: recordar saldo pendiente', anticipo: 'Resolver reserva vencida con anticipo', revision: 'Revisar pago en línea' }[x.kind] || 'Dar seguimiento';
    try { await api('/api/staff/tasks', { method: 'POST', body: { title, due_date: cfg.today, booking_code: x.code } }); showMsg($('#task-msg'), 'Tarea agregada para hoy.', 'ok'); agDate = cfg.today; loadAgenda(); refreshAgCount(); }
    catch (e) { alert(e.message); }
  });
}
$('#task-f').addEventListener('submit', async (e) => {
  e.preventDefault(); hideMsg($('#task-msg'));
  try {
    await api('/api/staff/tasks', { method: 'POST', body: { title: $('#tt').value, due_date: agDate, due_time: $('#th').value, booking_code: $('#tc').value.trim(), assigned_to: $('#ta').value } });
    $('#tt').value = ''; $('#th').value = ''; $('#tc').value = '';
    loadAgenda(); refreshAgCount();
  } catch (ex) { showMsg($('#task-msg'), ex.message); }
});
$('#appt-new').onclick = () => apptForm(null);
// Nueva cita (a = null) o reprogramar una existente.
function apptForm(a) {
  const isNew = !a;
  const reasons = agData.reasons;
  $('#mb').innerHTML = `<div class="modal-head"><h2 style="margin:0">${isNew ? 'Nueva cita' : 'Reprogramar cita de ' + esc(a.name)}</h2><button class="secondary small" id="mclose">Cerrar</button></div>
    <form id="af">
      ${isNew ? `<label>Motivo</label><select id="a-r">${Object.entries(reasons).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select>` : ''}
      <div class="row"><div><label>Día</label><input id="a-d" type="date" min="${cfg.today}" value="${esc(isNew ? (agDate < cfg.today ? cfg.today : agDate) : a.date)}"></div>
        <div><label>Hora</label><select id="a-t"></select></div></div>
      ${isNew ? `<div class="row3"><div><label>Nombre</label><input id="a-n"></div><div><label>Teléfono</label><input id="a-p" type="tel"></div><div><label>Correo (opcional)</label><input id="a-e" type="email"></div></div>
      <div class="row"><div><label>Código de reserva (opcional)</label><input id="a-c" maxlength="6" style="text-transform:uppercase"></div><div><label>Notas</label><input id="a-o" maxlength="400"></div></div>` : ''}
      <div class="alert error hidden" id="aerr"></div>
      <button class="block" type="submit" style="margin-top:14px">${isNew ? 'Agendar (queda confirmada)' : 'Guardar nuevo horario'}</button>
    </form>`;
  $('#modal').classList.remove('hidden'); $('#mclose').onclick = closeModal;
  const fillSlots = async () => {
    const s = await api('/api/appointments/slots?date=' + $('#a-d').value);
    $('#a-t').innerHTML = s.open ? s.slots.map((x) => `<option value="${x.time}" ${x.left < 1 && !(a && a.date === $('#a-d').value && a.time === x.time) ? 'disabled' : ''}>${x.time}${x.left < 1 ? ' (lleno)' : ` · ${x.left} libre${x.left > 1 ? 's' : ''}`}</option>`).join('') : '<option value="">Cerrado</option>';
    const firstFree = $$('#a-t option').find((o) => !o.disabled && o.value);
    if (a && a.date === $('#a-d').value) $('#a-t').value = a.time; else if (firstFree) $('#a-t').value = firstFree.value;
  };
  $('#a-d').onchange = fillSlots; fillSlots();
  $('#af').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      if (isNew) await api('/api/staff/appointments', { method: 'POST', body: { reason: $('#a-r').value, date: $('#a-d').value, time: $('#a-t').value, name: $('#a-n').value, phone: $('#a-p').value, email: $('#a-e').value, booking_code: $('#a-c').value.trim(), notes: $('#a-o').value } });
      else await api('/api/staff/appointments/' + a.id, { method: 'PUT', body: { status: a.status, date: $('#a-d').value, time: $('#a-t').value } });
      closeModal(); agDate = $('#a-d').value; loadAgenda(); refreshAgCount();
    } catch (ex) { showMsg($('#aerr'), ex.message); }
  });
}

// ----- correcciones -----
$('#cs').addEventListener('change', loadCorrections);
async function refreshCorrCount() {
  const n = (await api('/api/staff/corrections?status=pendiente')).length;
  $('#corr-count').textContent = n; $('#corr-count').classList.toggle('hidden', !n);
}
async function loadCorrections() {
  const list = await api('/api/staff/corrections?status=' + $('#cs').value);
  refreshCorrCount();
  $('#corr-list').innerHTML = list.length ? list.map((c) => `
    <div class="pax-card" data-id="${c.id}">
      <div class="modal-head" style="flex-wrap:wrap"><h4><span class="n">${esc(c.code.slice(0, 2))}</span> Reserva <button type="button" class="linkbtn" data-open="${c.booking_id}">${esc(c.code)}</button> · ${esc(c.passenger)}</h4>
        <span class="muted small-txt">${dt(c.created_at)}</span></div>
      <table style="margin-top:10px"><thead><tr><th>Dato</th><th>Actual</th><th>Corrección pedida</th></tr></thead><tbody>
        ${Object.entries(c.changes).map(([k, v]) => `<tr><td>${esc(c.fields[k] || k)}</td><td><s>${esc(v.from || '—')}</s></td><td><b>${esc(v.to || '—')}</b></td></tr>`).join('')}</tbody></table>
      <p class="small-txt" style="margin:10px 0 0"><b>Motivo del cliente:</b> ${esc(c.reason)}</p>
      ${c.status === 'pendiente' ? `
        <div class="row" style="align-items:end;margin-top:6px">
          <div><label>Respuesta al cliente (obligatoria si rechazas)</label><input data-k="resp" maxlength="300" placeholder="Ej. Corregido según pasaporte"></div>
          <div style="display:flex;gap:8px"><button class="danger" data-act="no">Rechazar</button><button class="accent" data-act="yes">Aprobar y aplicar</button></div>
        </div><div class="alert error hidden" data-k="err"></div>`
        : `<p class="small-txt muted" style="margin:8px 0 0"><span class="badge ${CR_STATUS[c.status][1]}">${CR_STATUS[c.status][0]}</span> por ${esc(c.resolved_by || '')} · ${c.resolved_at ? dt(c.resolved_at) : ''}${c.response ? ' · ' + esc(c.response) : ''}</p>`}
    </div>`).join('') : '<div class="empty">No hay solicitudes.</div>';
  $$('#corr-list [data-open]').forEach((a) => a.onclick = (e) => { e.preventDefault(); openBooking(a.dataset.open); });
  $$('#corr-list .pax-card').forEach((card) => $$('[data-act]', card).forEach((btn) => btn.onclick = async () => {
    const approve = btn.dataset.act === 'yes';
    try {
      await api('/api/staff/corrections/' + card.dataset.id + '/resolve', { method: 'POST', body: { approve, response: $('[data-k=resp]', card).value } });
      loadCorrections();
    } catch (e) { showMsg($('[data-k=err]', card), e.message); }
  }));
}

// ----- catálogo (admin) -----
async function getCat() { cat = await api('/api/admin/catalog'); return cat; }
async function loadRoutes() {
  await getCat();
  if (!$('#rq').dataset.bound) { $('#rq').addEventListener('input', drawRoutes); $('#route-new').addEventListener('click', () => editRoute(null)); $('#rq').dataset.bound = 1; }
  drawRoutes();
}
function drawRoutes() {
  const q = $('#rq').value.toLowerCase();
  const al = Object.fromEntries(cat.airlines.map((a) => [a.code, a]));
  const list = cat.routes.filter((r) => !q || `${r.airline}${r.flight_no} ${r.airline} ${r.flight_no} ${r.origin} ${r.destination}`.toLowerCase().includes(q));
  $('#routes').innerHTML = list.map((r) => `<tr class="click" data-id="${r.id}">
    <td><div class="airline">${alLogo(al[r.airline] || { code: r.airline, color: '#666' })}<b>${esc(r.airline)} ${esc(r.flight_no)}</b></div></td>
    <td><b>${esc(r.origin)} → ${esc(r.destination)}</b></td><td>${esc(r.dep_time)}</td><td>${dur(r.duration_min)}</td>
    <td class="small-txt">${daysTxt(r.days)}</td><td>${r.seats}</td><td>${usd(r.base_price)}</td>
    <td>${r.active ? '<span class="badge b-emitido">Activo</span>' : '<span class="badge b-vencido">Inactivo</span>'}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">Sin vuelos.</td></tr>';
  $$('#routes tr[data-id]').forEach((tr) => tr.addEventListener('click', () => editRoute(cat.routes.find((r) => String(r.id) === tr.dataset.id))));
}
function editRoute(r) {
  const isNew = !r;
  r = r || { airline: cat.airlines[0]?.code, flight_no: '', origin: 'MEX', destination: 'CUN', dep_time: '08:00', duration_min: 120, days: '1234567', seats: 150, base_price: 99, active: true };
  const apOpts = (sel) => cat.airports.map((a) => `<option value="${a.code}" ${a.code === sel ? 'selected' : ''}>${a.code} · ${esc(a.city)}</option>`).join('');
  $('#mb').innerHTML = `<div class="modal-head"><h2 style="margin:0">${isNew ? 'Agregar vuelo' : 'Editar ' + esc(r.airline + ' ' + r.flight_no)}</h2><button class="secondary small" id="mclose">Cerrar</button></div>
    <form id="rf">
      <div class="row4">
        <div><label>Aerolínea</label><select id="r-al">${cat.airlines.map((a) => `<option value="${a.code}" ${a.code === r.airline ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></div>
        <div><label>Número de vuelo</label><input id="r-no" value="${esc(r.flight_no)}" placeholder="123"></div>
        <div><label>Origen</label><select id="r-o">${apOpts(r.origin)}</select></div>
        <div><label>Destino</label><select id="r-d">${apOpts(r.destination)}</select></div>
      </div>
      <div class="row4">
        <div><label>Salida (hora local)</label><input id="r-t" type="time" value="${esc(r.dep_time)}"></div>
        <div><label>Duración (min)</label><input id="r-du" type="number" min="20" value="${r.duration_min}"></div>
        <div><label>Asientos</label><input id="r-s" type="number" min="1" value="${r.seats}"></div>
        <div><label>Precio base (USD)</label><input id="r-p" type="number" step="0.01" min="1" value="${r.base_price}"></div>
      </div>
      <label>Días de operación</label>
      <div class="days">${DAYS.map((d, i) => `<label><input type="checkbox" value="${i + 1}" ${r.days.includes(String(i + 1)) ? 'checked' : ''}> ${['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'][i]}</label>`).join('')}</div>
      <p class="hint" id="r-arr"></p>
      <label class="check"><input type="checkbox" id="r-act" ${r.active ? 'checked' : ''}> <span>Activo (se puede vender)</span></label>
      <div class="alert error hidden" id="rerr"></div>
      <button class="block" type="submit" style="margin-top:14px">${isNew ? 'Agregar vuelo' : 'Guardar cambios'}</button>
    </form>`;
  $('#modal').classList.remove('hidden'); $('#mclose').onclick = closeModal;
  const calc = () => {
    const A = cat.airports.find((a) => a.code === $('#r-o').value), B = cat.airports.find((a) => a.code === $('#r-d').value);
    const [h, m] = ($('#r-t').value || '00:00').split(':').map(Number);
    const local = h * 60 + m - A.utc_offset * 60 + Number($('#r-du').value || 0) + B.utc_offset * 60;
    const mins = ((local % 1440) + 1440) % 1440, off = Math.floor(local / 1440);
    $('#r-arr').textContent = `Llega a ${B.city} a las ${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')} hora local${off > 0 ? ' (día siguiente)' : off < 0 ? ' (día anterior)' : ''}.`;
  };
  ['#r-o', '#r-d', '#r-t', '#r-du'].forEach((s) => $(s).addEventListener('input', calc)); calc();
  $('#rf').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = { airline: $('#r-al').value, flight_no: $('#r-no').value, origin: $('#r-o').value, destination: $('#r-d').value, dep_time: $('#r-t').value,
      duration_min: $('#r-du').value, seats: $('#r-s').value, base_price: $('#r-p').value, active: $('#r-act').checked,
      days: $$('.days input:checked').map((i) => i.value).join('') };
    try { await api(isNew ? '/api/admin/routes' : '/api/admin/routes/' + r.id, { method: isNew ? 'POST' : 'PUT', body }); closeModal(); showMsg($('#routes-msg'), 'Guardado.', 'ok'); loadRoutes(); }
    catch (ex) { showMsg($('#rerr'), ex.message); }
  });
}
async function loadCatalog() {
  await getCat();
  $('#demo-note').innerHTML = icon('info', 'ico-sm') + '<span>Ya están dadas de alta las principales aerolíneas reales de la región; aparecen en el inicio. Para venderlas en línea, carga sus vuelos en "Vuelos y horarios". "Aerolínea Ejemplo" y "Vuelos Demo" son de prueba: desactívalas cuando tengas vuelos reales.</span>';
  $('#airlines').innerHTML = cat.airlines.map((a) => `<tr data-code="${a.code}"><td><div class="airline">${alLogo(a)}<b>${esc(a.name)}</b>${a.demo ? ' <span class="badge b-vencido">Ejemplo</span>' : ''}</div></td><td>${esc(a.code)}</td><td class="small-txt">${esc(a.country || '')}</td>
    <td><input type="color" value="${esc(a.color)}" data-k="color" style="width:52px;height:34px;padding:2px"></td>
    <td>${a.active ? '<span class="badge b-emitido">Activa</span>' : '<span class="badge b-vencido">Inactiva</span>'}</td>
    <td style="white-space:nowrap"><button class="secondary small" data-act="toggle">${a.active ? 'Desactivar' : 'Activar'}</button></td></tr>`).join('');
  $$('#airlines tr').forEach((tr) => {
    const a = cat.airlines.find((x) => x.code === tr.dataset.code);
    $('[data-act=toggle]', tr).onclick = async () => { await api('/api/admin/airlines/' + a.code, { method: 'PUT', body: { active: !a.active } }); loadCatalog(); };
    $('[data-k=color]', tr).onchange = async (e) => { await api('/api/admin/airlines/' + a.code, { method: 'PUT', body: { color: e.target.value } }); loadCatalog(); };
  });
  $('#airports').innerHTML = cat.airports.map((a) => `<tr data-code="${a.code}"><td><b>${esc(a.code)}</b></td><td>${esc(a.city)}<div class="muted small-txt">${esc(a.name)}</div></td><td>${esc(a.country)}</td>
    <td><input type="number" step="0.5" value="${a.utc_offset}" style="width:80px" data-k="off"></td>
    <td>${a.active ? '<span class="badge b-emitido">Activo</span>' : '<span class="badge b-vencido">Inactivo</span>'}</td>
    <td><button class="secondary small" data-act="toggle">${a.active ? 'Desactivar' : 'Activar'}</button></td></tr>`).join('');
  $$('#airports tr').forEach((tr) => {
    const a = cat.airports.find((x) => x.code === tr.dataset.code);
    $('[data-act=toggle]', tr).onclick = async () => { await api('/api/admin/airports/' + a.code, { method: 'PUT', body: { active: !a.active } }); loadCatalog(); };
    $('[data-k=off]', tr).onchange = async (e) => {
      try { await api('/api/admin/airports/' + a.code, { method: 'PUT', body: { utc_offset: Number(e.target.value) } }); showMsg($('#ap-msg'), 'Zona horaria de ' + a.code + ' actualizada.', 'ok'); }
      catch (ex) { showMsg($('#ap-msg'), ex.message); }
    };
  });
}
$('#al-f').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await api('/api/admin/airlines', { method: 'POST', body: { code: $('#al-code').value, name: $('#al-name').value, country: $('#al-country').value, color: $('#al-color').value } }); e.target.reset(); showMsg($('#al-msg'), 'Aerolínea agregada.', 'ok'); loadCatalog(); }
  catch (ex) { showMsg($('#al-msg'), ex.message); }
});
$('#ap-f').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await api('/api/admin/airports', { method: 'POST', body: { code: $('#ap-code').value, city: $('#ap-city').value, country: $('#ap-country').value, name: $('#ap-name').value, utc_offset: $('#ap-off').value } }); e.target.reset(); showMsg($('#ap-msg'), 'Aeropuerto agregado.', 'ok'); loadCatalog(); }
  catch (ex) { showMsg($('#ap-msg'), ex.message); }
});

async function loadSettings() {
  const s = (await getCat()).settings;
  $('#s-tax').value = Math.round(s.tax_rate * 1000) / 10; $('#s-fee').value = s.service_fee; $('#s-hold').value = s.hold_hours;
  $('#s-std').value = s.seat_std; $('#s-front').value = s.seat_front; $('#s-exit').value = s.seat_exit;
  $('#s-dep').value = Math.round(s.deposit_pct * 100); $('#s-fpd').value = s.full_pay_days; $('#s-cap').value = s.appt_capacity;
}
$('#set-f').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await api('/api/admin/settings', { method: 'PUT', body: { tax_rate: Number($('#s-tax').value) / 100, service_fee: Number($('#s-fee').value), hold_hours: Number($('#s-hold').value), seat_std: Number($('#s-std').value), seat_front: Number($('#s-front').value), seat_exit: Number($('#s-exit').value),
    deposit_pct: Number($('#s-dep').value) / 100, full_pay_days: Number($('#s-fpd').value), appt_capacity: Number($('#s-cap').value) } }); showMsg($('#set-msg'), 'Guardado. Aplica a reservas nuevas.', 'ok'); }
  catch (ex) { showMsg($('#set-msg'), ex.message); }
});

// ----- usuarios -----
async function loadUsers() {
  const list = await api('/api/admin/users');
  $('#users').innerHTML = list.map((u) => `<tr data-id="${u.id}"><td><b>${esc(u.username)}</b></td><td>${esc(u.name)}</td><td>${u.role === 'admin' ? 'Administrador' : 'Agente'}</td>
    <td>${u.active ? '<span class="badge b-emitido">Activo</span>' : '<span class="badge b-cancelado">Inactivo</span>'}</td>
    <td style="white-space:nowrap"><button class="secondary small" data-act="pw">Cambiar contraseña</button> ${u.id !== me.id ? `<button class="secondary small" data-act="toggle">${u.active ? 'Desactivar' : 'Activar'}</button>` : ''}</td></tr>`).join('');
  $$('#users tr').forEach((tr) => {
    const u = list.find((x) => String(x.id) === tr.dataset.id);
    $$('button', tr).forEach((b) => b.onclick = async () => {
      try {
        if (b.dataset.act === 'pw') { const pw = prompt('Nueva contraseña para ' + u.username + ' (mínimo 8):'); if (!pw) return; await api('/api/admin/users/' + u.id, { method: 'PUT', body: { password: pw } }); alert('Contraseña actualizada.'); }
        else { await api('/api/admin/users/' + u.id, { method: 'PUT', body: { active: !u.active } }); loadUsers(); }
      } catch (e) { alert(e.message); }
    });
  });
}
$('#user-f').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await api('/api/admin/users', { method: 'POST', body: { username: $('#nu').value, name: $('#nn').value, role: $('#nr').value, password: $('#np').value } }); e.target.reset(); showMsg($('#user-msg'), 'Usuario creado.', 'ok'); loadUsers(); }
  catch (ex) { showMsg($('#user-msg'), ex.message); }
});

boot().catch((e) => toast(e.message));
