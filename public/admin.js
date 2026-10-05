const $ = s => document.querySelector(s), money = n => '$' + Number(n).toLocaleString('es-AR');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function api(url, opt = {}) {
  let pw = sessionStorage.pw || (sessionStorage.pw = prompt('Contraseña de administrador:') || '');
  opt.headers = { ...(opt.headers || {}), 'x-admin-password': pw };
  if (opt.body && !(opt.body instanceof FormData)) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(opt.body); }
  const r = await fetch('/api/admin' + url, opt);
  if (r.status === 401) { sessionStorage.clear(); alert('Contraseña incorrecta'); location.reload(); throw 0; }
  const d = await r.json(); if (!r.ok) { alert(d.error || 'Error'); throw 0; } return d;
}
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => {
  document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x === b));
  ['orders', 'products', 'promos', 'local', 'report'].forEach(t => $('#' + t).hidden = t !== b.dataset.t);
});
const STATUS = ['nuevo', 'preparando', 'listo', 'entregado', 'cancelado'];

async function loadOrders() {
  const os = await api('/orders'); notify(os);
  $('#orders').innerHTML = os.map(o => `<div class="panel order ${o.payment_status === 'pagado' ? 'pagado' : ''} ${o.status}">
    <b>#${o.id}</b> · ${esc(o.created_at)} · <b>${money(o.total)}</b>
    <span class="tag ${o.payment_status === 'pagado' ? 't-ok' : 't-wait'}">${o.payment_method === 'mercadopago' ? '💳 Mercado Pago' : '💵 Efectivo'} · ${o.payment_status === 'pagado' ? 'PAGADO' : (o.payment_method === 'efectivo' ? 'A PAGAR EN EFECTIVO' : 'PAGO PENDIENTE')}</span>
    <p>👤 ${esc(o.customer_name)} · 📞 <a href="https://wa.me/${esc(o.phone.replace(/\D/g, ''))}" target="_blank">${esc(o.phone)}</a><br>${o.delivery_type === 'retiro' ? '🏪 RETIRA EN EL LOCAL' : `🛵 ENVÍO · ${esc(o.zone)} (${money(o.delivery_cost)})<br>📍 ${esc(o.address)}`}${o.notes ? `<br>📝 ${esc(o.notes)}` : ''}</p>
    <ul>${o.items.map(i => `<li>${i.qty} × ${esc(i.name)} (${money(i.price)})</li>`).join('')}</ul>
    <select onchange="upd(${o.id},{status:this.value,payment_status:'${o.payment_status}'})">${STATUS.map(s => `<option ${s === o.status ? 'selected' : ''}>${s}</option>`).join('')}</select>
    ${o.payment_status !== 'pagado' ? `<button style="margin-top:8px" onclick="upd(${o.id},{status:'${o.status}',payment_status:'pagado'})">Marcar como pagado</button>` : ''}</div>`).join('') || '<p>Sin pedidos todavía.</p>';
}
const upd = (id, body) => api('/orders/' + id, { method: 'PUT', body }).then(loadOrders);

async function loadProducts() {
  const ps = await api('/products');
  $('#plist').innerHTML = ps.filter(p => p.active).map(p => `<div class="panel row" style="gap:12px;flex-wrap:wrap">
    ${p.image ? `<img src="${esc(p.image)}" width="70" height="70" style="object-fit:cover;border-radius:8px">` : '🍽️'}<b style="flex:1;min-width:120px">${p.featured ? '⭐ ' : ''}${esc(p.name)}</b><input id="ca${p.id}" value="${esc(p.category)}" placeholder="Categoría" style="width:110px"><label style="margin:0"><input id="ft${p.id}" type="checkbox" ${p.featured ? 'checked' : ''} style="width:auto"> del día</label>
    <label style="margin:0">$<input id="pr${p.id}" type="number" value="${p.price}" style="width:90px"></label>
    <label style="margin:0">Stock <input id="st${p.id}" type="number" value="${p.stock}" style="width:70px"></label>
    <button onclick="saveP(${p.id})">Guardar</button><button class="bad" onclick="delP(${p.id})">Quitar</button></div>`).join('') || '<p>Todavía no cargaste comidas.</p>';
}
const saveP = id => api('/products/' + id, { method: 'PUT', body: { price: $('#pr' + id).value, stock: $('#st' + id).value, active: true, category: $('#ca' + id).value, featured: $('#ft' + id).checked } }).then(loadProducts);
const delP = id => confirm('¿Quitar esta comida del menú?') && api('/products/' + id, { method: 'DELETE' }).then(loadProducts);
$('#pf').onsubmit = async e => { e.preventDefault(); await api('/products', { method: 'POST', body: new FormData(e.target) }); e.target.reset(); loadProducts(); };

async function loadPromos() {
  const { promos, current } = await api('/promos');
  $('#prlist').innerHTML = (current ? `<div class="msg">✅ Promo vigente ahora: <b>${esc(current.name)}</b> (${current.discount_percent}%)</div>` : '<div class="msg">No hay promo vigente en este momento.</div>') +
    promos.map(p => `<div class="panel row"><span><b>${esc(p.name)}</b> · ${p.discount_percent}% ${p.weekend_only ? '· fines de semana' : ''} ${p.start_date ? '· desde ' + p.start_date : ''} ${p.end_date ? '· hasta ' + p.end_date : ''}</span>
    <span><button class="sec" onclick="togP(${p.id},${p.active ? 0 : 1})">${p.active ? 'Pausar' : 'Activar'}</button> <button class="bad" onclick="delPr(${p.id})">Borrar</button></span></div>`).join('');
}
const togP = (id, active) => api('/promos/' + id, { method: 'PUT', body: { active } }).then(loadPromos);
const delPr = id => api('/promos/' + id, { method: 'DELETE' }).then(loadPromos);
$('#prf').onsubmit = async e => {
  e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); f.weekend_only = !!f.weekend_only;
  await api('/promos', { method: 'POST', body: f }); e.target.reset(); loadPromos();
};
loadOrders(); loadProducts(); loadPromos(); setInterval(loadOrders, 10000);

// ---- Aviso de pedidos nuevos ----
var lastId = null;
function notify(os) {
  const mx = os.reduce((a, o) => Math.max(a, o.id), 0);
  if (lastId !== null && mx > lastId) {
    beep(); document.title = '🔔 ¡Nuevo pedido!';
    if (window.Notification && Notification.permission === 'granted') new Notification('Nuevo pedido en Don Gato');
    loadReport();
  }
  lastId = mx;
}
function beep() { try { const c = new AudioContext(), o = c.createOscillator(); o.connect(c.destination); o.frequency.value = 880; o.start(); o.stop(c.currentTime + .5); } catch {} }
onfocus = () => document.title = 'Admin · Don Gato';
document.addEventListener('click', () => window.Notification && Notification.permission === 'default' && Notification.requestPermission(), { once: true });

// ---- Local: estado, horarios, retiro y zonas ----
const DAYS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
async function loadLocal() {
  const s = await api('/settings');
  $('#mode').value = s.open_mode; $('#pickup').value = s.pickup_address;
  $('#openNow').textContent = s.open_now ? '🟢 Ahora el local figura ABIERTO' : '🔴 Ahora el local figura CERRADO';
  $('#sched').innerHTML = s.schedule.map((d, i) => `<div class="row"><label style="margin:0;color:var(--ink);width:120px"><input type="checkbox" id="on${i}" ${d.on ? 'checked' : ''} style="width:auto"> ${DAYS[i]}</label>
    <input type="time" id="fr${i}" value="${d.from}" style="width:120px"> a <input type="time" id="to${i}" value="${d.to}" style="width:120px"></div>`).join('');
  const z = await api('/zones');
  $('#zlist').innerHTML = z.map(x => `<div class="row"><span>🛵 ${esc(x.name)} · ${money(x.cost)}</span><button type="button" class="bad" onclick="delZ(${x.id})">Borrar</button></div>`).join('');
}
$('#saveSet').onclick = async () => {
  await api('/settings', { method: 'PUT', body: { open_mode: $('#mode').value, pickup_address: $('#pickup').value,
    schedule: DAYS.map((_, i) => ({ on: $('#on' + i).checked, from: $('#fr' + i).value, to: $('#to' + i).value })) } });
  alert('Guardado ✅'); loadLocal();
};
const delZ = id => api('/zones/' + id, { method: 'DELETE' }).then(loadLocal);
$('#zf').onsubmit = async e => { e.preventDefault(); await api('/zones', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); e.target.reset(); loadLocal(); };

// ---- Reporte de ventas ----
async function loadReport() {
  const r = await api('/report?days=' + $('#days').value), max = Math.max(1, ...r.byDay.map(d => d.t));
  const pm = { mercadopago: '💳 Mercado Pago', efectivo: '💵 Efectivo' };
  $('#rep').innerHTML = `<div class="cols"><div class="panel"><small>Hoy</small><h2>${money(r.today.t)}</h2>${r.today.n} pedidos</div>
    <div class="panel"><small>Período</small><h2>${money(r.sum.t)}</h2>${r.sum.n} pedidos</div>
    <div class="panel"><small>Ticket promedio</small><h2>${money(r.sum.n ? Math.round(r.sum.t / r.sum.n) : 0)}</h2></div></div>
    <div class="panel"><h3>Ventas por día</h3>${r.byDay.map(d => `<div class="bar"><span>${d.d.slice(5)}</span><i style="width:${d.t / max * 70}%"></i><b>${money(d.t)} (${d.n})</b></div>`).join('') || 'Sin ventas'}</div>
    <div class="panel"><h3>Comidas más vendidas</h3>${r.top.map(t => `<div class="row"><span>${esc(t.name)}</span><span>${t.q} u. · ${money(t.t)}</span></div>`).join('') || 'Sin datos'}</div>
    <div class="panel"><h3>Pagos y entregas</h3>${r.byPay.map(p => `<div class="row"><span>${pm[p.m]} · ${p.s}</span><span>${p.n} · ${money(p.t)}</span></div>`).join('')}
    ${r.byType.map(t => `<div class="row"><span>${t.k === 'retiro' ? '🏪 Retiro' : '🛵 Envío'}</span><span>${t.n} pedidos</span></div>`).join('')}</div>`;
}
$('#days').onchange = loadReport; loadLocal(); loadReport();
