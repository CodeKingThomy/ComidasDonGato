const $ = s => document.querySelector(s), money = n => '$' + Number(n).toLocaleString('es-AR');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let zones = [], isOpen = true, pickup = '', cat = 'Todas', products = [], cart = JSON.parse(localStorage.getItem('cart') || '{}');
const save = () => localStorage.setItem('cart', JSON.stringify(cart));

async function load() {
  const d = await (await fetch('/api/products')).json();
  products = d.products; zones = d.zones; isOpen = d.open; pickup = d.pickup_address; $('#closed').hidden = isOpen;
  $('#promo').hidden = !d.promo;
  if (d.promo) $('#promo').textContent = `🎉 ${d.promo.name}: ${d.promo.discount_percent}% OFF en todo el menú`;
  Object.keys(cart).forEach(id => { const p = products.find(x => x.id == id); if (!p || !p.stock) delete cart[id]; else cart[id] = Math.min(cart[id], p.stock); });
  save(); render();
}
function render() {
  const cats = ['Todas', ...new Set(products.map(p => p.category).filter(Boolean))];
  $('#cats').innerHTML = cats.length > 2 ? cats.map(c => `<button class="${c === cat ? '' : 'sec'}" data-c="${esc(c)}">${esc(c)}</button>`).join('') : '';
  $('#grid').innerHTML = products.filter(p => cat === 'Todas' || p.category === cat).map(p => `<article class="card"><div class="img">${p.featured ? '<span class="badge">⭐ Comida del día</span>' : ''}${p.image ? `<img src="${esc(p.image)}" alt="${esc(p.name)}">` : '🍽️'}</div>
    <div class="body"><h3>${esc(p.name)}</h3><p>${esc(p.description)}</p>
    <div class="price">${p.final_price < p.price ? `<s>${money(p.price)}</s>` : ''}${money(p.final_price)}</div>
    <div class="stock">${p.stock > 0 ? `Disponibles: ${p.stock}` : 'Agotado'}</div>
    <button ${p.stock < 1 ? 'disabled' : ''} onclick="change(${p.id},1)">Agregar</button></div></article>`).join('') || '<p>Pronto vamos a cargar el menú 🐾</p>';
  renderCart();
}
function change(id, d) {
  const p = products.find(x => x.id == id), q = (cart[id] || 0) + d;
  if (q <= 0) delete cart[id]; else if (q <= p.stock) cart[id] = q; else alert('No hay más stock de ' + p.name);
  save(); renderCart();
}
function renderCart() {
  const ids = Object.keys(cart); let total = 0;
  $('#count').textContent = ids.reduce((a, i) => a + cart[i], 0);
  $('#cartItems').innerHTML = ids.map(id => {
    const p = products.find(x => x.id == id); total += p.final_price * cart[id];
    return `<div class="row"><span>${esc(p.name)}<br><small>${money(p.final_price)}</small></span>
    <span class="qty"><button class="sec" onclick="change(${id},-1)">−</button>${cart[id]}<button class="sec" onclick="change(${id},1)">+</button></span></div>`;
  }).join('') || '<p>Todavía no agregaste nada.</p>';
  $('#total').textContent = money(total); $('#goCheckout').disabled = !ids.length;
}
$('#openCart').onclick = () => cartDlg.showModal();
$('#cats').onclick = e => { if (e.target.dataset.c) { cat = e.target.dataset.c; render(); } };
const dt = () => document.querySelector('[name=dt]:checked').value;
const subtotal = () => Object.keys(cart).reduce((a, id) => a + products.find(x => x.id == id).final_price * cart[id], 0);
function updSum() {
  const env = dt() === 'envio', z = zones.find(x => x.id == $('#zone').value), c = env && z ? z.cost : 0;
  $('#envioBox').hidden = !env; $('#retiroBox').hidden = env;
  $('#retiroBox').textContent = '🏪 Retirás en: ' + (pickup || 'el local (te confirmamos la dirección)');
  $('#sum').innerHTML = `Subtotal ${money(subtotal())}<br>Envío ${env ? money(c) : '—'}<br><b>Total ${money(subtotal() + c)}</b>`;
}
$('#goCheckout').onclick = () => {
  cartDlg.close(); $('#coMsg').innerHTML = isOpen ? '' : '<div class="msg">😴 Estamos cerrados ahora.</div>';
  $('#zone').innerHTML = zones.map(z => `<option value="${z.id}">${esc(z.name)} (${money(z.cost)})</option>`).join('');
  if (!zones.length) document.querySelector('[name=dt][value=retiro]').checked = true;
  $('#dlv').hidden = !zones.length; updSum(); coDlg.showModal();
};
document.querySelectorAll('[name=dt]').forEach(r => r.onchange = updSum); $('#zone').onchange = updSum;
$('#confirm').onclick = async () => {
  const btn = $('#confirm'); btn.disabled = true;
  const body = { name: $('#name').value, phone: $('#phone').value, address: $('#address').value, notes: $('#notes').value,
    payment_method: document.querySelector('[name=pm]:checked').value, delivery_type: dt(), zone_id: $('#zone').value, items: Object.entries(cart).map(([id, qty]) => ({ id: +id, qty })) };
  try {
    const r = await fetch('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json();
    if (!r.ok) { $('#coMsg').innerHTML = `<div class="msg">⚠️ ${esc(d.error)}</div>`; load(); return; }
    cart = {}; save();
    if (d.init_point) { location.href = d.init_point; return; }
    coDlg.close(); load();
    $('#notice').innerHTML = `<div class="msg">✅ ¡Pedido #${d.id} recibido! Total ${money(d.total)}. Pagás en efectivo al recibirlo. ¡Gracias!</div>`;
    scrollTo(0, 0);
  } catch { $('#coMsg').innerHTML = '<div class="msg">⚠️ Error de conexión</div>'; }
  finally { btn.disabled = false; }
};
const pago = new URLSearchParams(location.search).get('pago');
if (pago) { cart = {}; save(); $('#notice').innerHTML = `<div class="msg">${pago === 'ok' ? '✅ ¡Pago recibido! Estamos preparando tu pedido.' : pago === 'pendiente' ? '⏳ Tu pago está pendiente de acreditación.' : '❌ El pago no se completó. Podés intentar de nuevo.'}</div>`; }
load();
