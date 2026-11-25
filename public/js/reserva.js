renderHeader('/reserva');
const qs = new URLSearchParams(location.search);
if (qs.get('code')) $('#code').value = qs.get('code');

function render(b, lastName, banner = '') {
  const canFix = lastName && ['pendiente_pago', 'emitido'].includes(b.status);
  const future = b.segments.some((s) => s.date >= new Date().toISOString().slice(0, 10));
  $('#res').innerHTML = banner + bookingHtml(b) + (b.status === 'pendiente_pago' ? `
    <div class="card no-print" style="margin-top:14px">
      <div class="modal-head" style="flex-wrap:wrap"><div><h2>¿Vas a pagar en la agencia?</h2>
        <p class="muted small-txt" style="margin:0">Agenda una cita y te atendemos sin filas para tu pago o abono.</p></div>
        <a class="btn secondary" href="/cita?motivo=pago&code=${encodeURIComponent(b.code)}">Agendar cita</a></div>
    </div>` : '') + (canFix && future ? `
    <div class="card no-print" style="margin-top:14px">
      <div class="modal-head" style="flex-wrap:wrap"><div><h2>Tus asientos</h2>
        <p class="muted small-txt" style="margin:0">${b.status === 'emitido' ? 'Puedes cambiar a asientos sin costo adicional. Los asientos con costo extra se compran en la agencia.' : 'Elige o cambia tus asientos. Si tienen costo, se suma al total de tu reserva.'}</p></div>
        <button class="secondary" id="seats-open" type="button">${b.segments.some((s) => s.seats.some(Boolean)) ? 'Cambiar asientos' : 'Elegir asientos'}</button></div>
      <div id="seats-body" style="margin-top:12px"></div>
    </div>` : '') + (canFix ? `
    <div class="card no-print" id="fix-card" style="margin-top:14px">
      <div class="modal-head" style="flex-wrap:wrap"><div><h2>¿Algún dato está mal?</h2>
        <p class="muted small-txt" style="margin:0">Corrige nombres, fecha de nacimiento, documento o datos de contacto.</p></div>
        <button class="secondary" id="fix-open" type="button">Corregir datos</button></div>
      <div id="fix-body"></div>
    </div>` : '') + `
    <div class="card" style="margin-top:14px"><h2>Historial</h2><ul class="timeline">${b.events.map((ev) => `<li><b>${esc(ev.label)}</b>${ev.note ? `<div class="small-txt">${esc(ev.note)}</div>` : ""}<span class="muted small-txt">${dt(ev.at)}</span></li>`).join('')}</ul></div>
    <div class="row no-print" style="margin-top:16px;max-width:420px"><button class="secondary" data-print>Imprimir ${b.status === 'emitido' ? 'boletos' : 'reserva'}</button><a class="btn" href="/">Buscar otro vuelo</a></div>`;
  if (lastName) bindPayBox(b, lastName);
  if (canFix) $('#fix-open').addEventListener('click', () => openFix(b, lastName));
  if ($('#seats-open')) $('#seats-open').addEventListener('click', () => {
    $('#seats-open').classList.add('hidden');
    mountSeatEditor($('#seats-body'), b, {
      save: (seg, seats) => api(`/api/bookings/${encodeURIComponent(b.code)}/seats`, { method: 'POST', body: { last_name: lastName, segment: seg, seats } }),
      onSaved: (nb) => {
        if (!nb) { $('#seats-open').classList.remove('hidden'); return; }
        render(nb, lastName, `<div class="alert ok">${icon('check', 'ico-sm')}<span>Asientos guardados.${nb.status === 'pendiente_pago' && nb.seats_total ? ' Nuevo total: ' + usd(nb.total) + ' USD.' : ''}</span></div>`);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      },
    });
  });
}

function openFix(b, lastName) {
  $('#fix-open').classList.add('hidden');
  $('#fix-body').innerHTML = correctionFormHtml(b);
  $('#corr-cancel').onclick = () => { $('#fix-body').innerHTML = ''; $('#fix-open').classList.remove('hidden'); };
  $('#corr-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    hideMsg($('#corr-err'));
    const data = collectCorrection();
    const btn = $('#corr-form button[type=submit]'); btn.disabled = true;
    try {
      const r = await api(`/api/bookings/${encodeURIComponent(b.code)}/correct`, { method: 'POST', body: { last_name: lastName, ...data } });
      // Si se corrigió el apellido usado para entrar, seguir con el nuevo.
      const keep = r.booking.passengers.some((p) => p.last_name.toLowerCase().includes(lastName.toLowerCase())) ? lastName : r.booking.passengers[0].last_name;
      const msg = r.requested
        ? `Enviamos ${r.requested} solicitud${r.requested > 1 ? 'es' : ''} de corrección a la agencia. Verás la respuesta en esta página.${r.applied ? ' Tus datos de contacto ya se actualizaron.' : ''}`
        : r.applied ? 'Listo: tus datos se corrigieron.' : 'No hubo cambios que guardar.';
      render(r.booking, keep, `<div class="alert ok">${icon('check', 'ico-sm')}<span>${esc(msg)}</span></div>`);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (ex) { showMsg($('#corr-err'), ex.message); btn.disabled = false; }
  });
}

$('#f').addEventListener('submit', async (e) => {
  e.preventDefault();
  hideMsg($('#err')); $('#res').innerHTML = '';
  try {
    const last = $('#last').value;
    const b = await api('/api/bookings/lookup', { method: 'POST', body: { code: $('#code').value.trim(), last_name: last } });
    render(b, last);
  } catch (ex) { showMsg($('#err'), ex.message); }
});

(async () => {
  window.ONLINE_PAY = (await api('/api/config')).online_payments;
  // Regreso desde la página de pago
  if (qs.get('session_id') && qs.get('code')) {
    $('#find').classList.add('hidden');
    $('#res').innerHTML = '<div class="empty">Confirmando tu pago…</div>';
    try {
      const r = await api('/api/payments/confirm', { method: 'POST', body: { code: qs.get('code'), session_id: qs.get('session_id') } });
      const ok = r.booking.status === 'emitido';
      render(r.booking, null, ok
        ? `<div class="alert ok">${icon('check', 'ico-sm')}<span><b>¡Pago recibido!</b> Tus boletos están emitidos. Te recomendamos imprimir o guardar esta página.</span></div>`
        : r.paid ? '' : `<div class="alert warn">${icon('clock', 'ico-sm')}<span>Tu pago aún se está procesando. Vuelve a consultar en unos minutos.</span></div>`);
      history.replaceState(null, '', '/reserva?code=' + encodeURIComponent(qs.get('code')));
    } catch (ex) {
      $('#find').classList.remove('hidden');
      $('#res').innerHTML = `<div class="alert error">${esc(ex.message)}</div>`;
    }
  } else if (qs.get('pago') === 'cancelado') {
    $('#res').innerHTML = `<div class="alert warn">${icon('info', 'ico-sm')}<span>No se completó el pago. Tu reserva sigue apartada hasta que venza: escribe tu apellido para intentar de nuevo o paga en la agencia.</span></div>`;
    $('#last').focus();
  }
})().catch(() => {});
