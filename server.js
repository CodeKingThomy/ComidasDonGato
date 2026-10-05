const express = require('express'), path = require('path'), fs = require('fs');
const multer = require('multer'), Database = require('better-sqlite3');
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'dongato123';
const MP_TOKEN = process.env.MP_ACCESS_TOKEN || '';
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const UPLOADS = path.join(__dirname, 'public', 'uploads');
fs.mkdirSync(UPLOADS, { recursive: true });

const db = new Database(path.join(__dirname, 'dongato.db'));
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
  price INTEGER NOT NULL, stock INTEGER NOT NULL DEFAULT 0, image TEXT, active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS promos(id INTEGER PRIMARY KEY, name TEXT NOT NULL, discount_percent INTEGER NOT NULL,
  start_date TEXT, end_date TEXT, weekend_only INTEGER DEFAULT 0, active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY, customer_name TEXT, phone TEXT, address TEXT, notes TEXT,
  payment_method TEXT, payment_status TEXT DEFAULT 'pendiente', status TEXT DEFAULT 'nuevo', total INTEGER,
  created_at TEXT DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS order_items(id INTEGER PRIMARY KEY, order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER, name TEXT, price INTEGER, qty INTEGER);
`);

const addCol = (t, c, d) => { try { db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`); } catch {} };
addCol('products', 'category', "TEXT DEFAULT ''"); addCol('products', 'featured', 'INTEGER DEFAULT 0');
addCol('orders', 'delivery_type', "TEXT DEFAULT 'envio'"); addCol('orders', 'delivery_cost', 'INTEGER DEFAULT 0'); addCol('orders', 'zone', 'TEXT');
db.exec(`CREATE TABLE IF NOT EXISTS zones(id INTEGER PRIMARY KEY, name TEXT NOT NULL, cost INTEGER NOT NULL DEFAULT 0, active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);`);
const TZ = 'America/Argentina/Buenos_Aires';
const getSet = (k, d) => { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k); return r ? JSON.parse(r.value) : d; };
const setSet = (k, v) => db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, JSON.stringify(v));
const DEF_SCHEDULE = Array.from({ length: 7 }, () => ({ on: true, from: '11:00', to: '23:00' }));
function isOpen() {
  const mode = getSet('open_mode', 'auto');
  if (mode === 'open') return true; if (mode === 'closed') return false;
  const now = new Date(), today = now.toLocaleDateString('en-CA', { timeZone: TZ });
  const t = now.toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
  const d = getSet('schedule', DEF_SCHEDULE)[new Date(today + 'T12:00:00').getDay()];
  if (!d || !d.on) return false;
  return d.from <= d.to ? (t >= d.from && t <= d.to) : (t >= d.from || t <= d.to);
}

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS,
    filename: (req, f, cb) => cb(null, Date.now() + path.extname(f.originalname).toLowerCase()),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, f, cb) => cb(null, /image\/(jpeg|png|webp)/.test(f.mimetype)),
});

// Promo vigente (usa hora de Argentina). Se aplica la de mayor descuento a todos los productos.
function currentPromo() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
  const wd = new Date(today + 'T12:00:00').getDay();
  const ok = db.prepare('SELECT * FROM promos WHERE active=1').all().filter(p => {
    if (p.start_date && today < p.start_date) return false;
    if (p.end_date && today > p.end_date) return false;
    if (p.weekend_only && wd !== 0 && wd !== 6) return false;
    return true;
  });
  return ok.sort((a, b) => b.discount_percent - a.discount_percent)[0] || null;
}
const finalPrice = (price, promo) => promo ? Math.round(price * (1 - promo.discount_percent / 100)) : price;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
const admin = (req, res, next) =>
  req.get('x-admin-password') === ADMIN_PASSWORD ? next() : res.status(401).json({ error: 'No autorizado' });

// ---------- Cliente ----------
app.get('/api/products', (req, res) => {
  const promo = currentPromo();
  const products = db.prepare('SELECT * FROM products WHERE active=1 ORDER BY featured DESC, id DESC').all()
    .map(p => ({ ...p, final_price: finalPrice(p.price, promo) }));
  res.json({ products, promo, open: isOpen(), pickup_address: getSet('pickup_address', ''),
    zones: db.prepare('SELECT id,name,cost FROM zones WHERE active=1 ORDER BY name').all() });
});

app.post('/api/orders', async (req, res) => {
  const { name, phone, address, notes, payment_method, items, delivery_type, zone_id } = req.body || {};
  const envio = delivery_type !== 'retiro';
  if (!isOpen()) return res.status(400).json({ error: 'Ahora estamos cerrados 😴 Volvé en nuestro horario de atención' });
  if (!name?.trim() || !phone?.trim() || (envio && !address?.trim())) return res.status(400).json({ error: 'Completá nombre, teléfono' + (envio ? ' y dirección' : '') });
  if (!['mercadopago', 'efectivo'].includes(payment_method)) return res.status(400).json({ error: 'Medio de pago inválido' });
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'El carrito está vacío' });
  if (payment_method === 'mercadopago' && !MP_TOKEN) return res.status(400).json({ error: 'Mercado Pago no está configurado todavía' });
  const zone = envio ? db.prepare('SELECT * FROM zones WHERE id=? AND active=1').get(zone_id) : null;
  if (envio && !zone) return res.status(400).json({ error: 'Elegí tu zona de entrega' });
  const shipping = zone ? zone.cost : 0, promo = currentPromo();
  let order;
  try {
    order = db.transaction(() => {
      let total = shipping; const lines = [];
      for (const it of items) {
        const p = db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(it.id);
        const qty = parseInt(it.qty);
        if (!p) throw new Error('Una comida ya no está disponible');
        if (!(qty >= 1) || qty > p.stock) throw new Error(`Stock insuficiente de ${p.name} (quedan ${p.stock})`);
        const price = finalPrice(p.price, promo);
        db.prepare('UPDATE products SET stock=stock-? WHERE id=?').run(qty, p.id);
        total += price * qty; lines.push({ product_id: p.id, name: p.name, price, qty });
      }
      const id = db.prepare('INSERT INTO orders(customer_name,phone,address,notes,payment_method,total,delivery_type,delivery_cost,zone) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(name.trim(), phone.trim(), envio ? address.trim() : 'Retira en el local', (notes || '').trim(), payment_method, total, envio ? 'envio' : 'retiro', shipping, zone ? zone.name : null).lastInsertRowid;
      const ins = db.prepare('INSERT INTO order_items(order_id,product_id,name,price,qty) VALUES(?,?,?,?,?)');
      lines.forEach(l => ins.run(id, l.product_id, l.name, l.price, l.qty));
      return { id, total, lines };
    })();
  } catch (e) { return res.status(400).json({ error: e.message }); }

  if (payment_method === 'efectivo') return res.json({ id: order.id, total: order.total });
  try {
    const https = BASE_URL.startsWith('https');
    const body = {
      items: [...order.lines.map(l => ({ title: l.name, quantity: l.qty, unit_price: l.price, currency_id: 'ARS' })),
        ...(shipping ? [{ title: 'Envío', quantity: 1, unit_price: shipping, currency_id: 'ARS' }] : [])],
      external_reference: String(order.id),
      back_urls: { success: `${BASE_URL}/?pago=ok`, failure: `${BASE_URL}/?pago=error`, pending: `${BASE_URL}/?pago=pendiente` },
      ...(https && { auto_return: 'approved', notification_url: `${BASE_URL}/api/mp/webhook` }),
    };
    const r = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST', headers: { Authorization: `Bearer ${MP_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!d.init_point) throw new Error('MP respondió sin link de pago');
    res.json({ id: order.id, total: order.total, init_point: d.init_point });
  } catch (e) {
    res.status(502).json({ error: `Pedido #${order.id} creado, pero falló Mercado Pago. Contactanos por teléfono.` });
  }
});

// Mercado Pago avisa acá cuando se acredita un pago
app.post('/api/mp/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const id = req.query['data.id'] || req.body?.data?.id;
    if (!id || !MP_TOKEN) return;
    const r = await fetch(`https://api.mercadopago.com/v1/payments/${id}`, { headers: { Authorization: `Bearer ${MP_TOKEN}` } });
    const p = await r.json();
    if (p.status === 'approved' && p.external_reference)
      db.prepare("UPDATE orders SET payment_status='pagado' WHERE id=?").run(p.external_reference);
  } catch (e) { console.error('webhook', e.message); }
});

// ---------- Admin ----------
app.get('/api/admin/products', admin, (req, res) => res.json(db.prepare('SELECT * FROM products ORDER BY id DESC').all()));

app.post('/api/admin/products', admin, upload.single('image'), (req, res) => {
  const { name, description = '', price, stock, category = '', featured } = req.body;
  if (!name?.trim() || !(+price >= 0) || !(+stock >= 0)) return res.status(400).json({ error: 'Datos inválidos' });
  db.prepare('INSERT INTO products(name,description,price,stock,image,category,featured) VALUES(?,?,?,?,?,?,?)')
    .run(name.trim(), description, Math.round(+price), parseInt(stock), req.file ? '/uploads/' + req.file.filename : null, category.trim(), featured ? 1 : 0);
  res.json({ ok: true });
});

app.put('/api/admin/products/:id', admin, (req, res) => {
  const { price, stock, active, featured, category } = req.body;
  db.prepare('UPDATE products SET price=?, stock=?, active=?, featured=?, category=? WHERE id=?')
    .run(Math.round(+price), parseInt(stock), active ? 1 : 0, featured ? 1 : 0, (category || '').trim(), req.params.id);
  res.json({ ok: true });
});

app.delete('/api/admin/products/:id', admin, (req, res) => {
  db.prepare('UPDATE products SET active=0, stock=0 WHERE id=?').run(req.params.id); // se oculta para no romper pedidos viejos
  res.json({ ok: true });
});

app.get('/api/admin/promos', admin, (req, res) => res.json({ promos: db.prepare('SELECT * FROM promos ORDER BY id DESC').all(), current: currentPromo() }));
app.post('/api/admin/promos', admin, (req, res) => {
  const { name, discount_percent, start_date, end_date, weekend_only } = req.body;
  if (!name?.trim() || !(+discount_percent > 0 && +discount_percent <= 90)) return res.status(400).json({ error: 'Nombre y descuento (1-90) obligatorios' });
  db.prepare('INSERT INTO promos(name,discount_percent,start_date,end_date,weekend_only) VALUES(?,?,?,?,?)')
    .run(name.trim(), parseInt(discount_percent), start_date || null, end_date || null, weekend_only ? 1 : 0);
  res.json({ ok: true });
});
app.put('/api/admin/promos/:id', admin, (req, res) => {
  db.prepare('UPDATE promos SET active=? WHERE id=?').run(req.body.active ? 1 : 0, req.params.id); res.json({ ok: true });
});
app.delete('/api/admin/promos/:id', admin, (req, res) => { db.prepare('DELETE FROM promos WHERE id=?').run(req.params.id); res.json({ ok: true }); });

app.get('/api/admin/orders', admin, (req, res) => {
  const orders = db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 200').all();
  const items = db.prepare('SELECT * FROM order_items WHERE order_id=?');
  res.json(orders.map(o => ({ ...o, items: items.all(o.id) })));
});
app.put('/api/admin/orders/:id', admin, (req, res) => {
  const { status, payment_status } = req.body;
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!o) return res.sendStatus(404);
  db.transaction(() => {
    if (status === 'cancelado' && o.status !== 'cancelado') // devuelve el stock
      db.prepare('SELECT * FROM order_items WHERE order_id=?').all(o.id)
        .forEach(i => db.prepare('UPDATE products SET stock=stock+? WHERE id=?').run(i.qty, i.product_id));
    db.prepare('UPDATE orders SET status=?, payment_status=? WHERE id=?').run(status || o.status, payment_status || o.payment_status, o.id);
  })();
  res.json({ ok: true });
});

app.get('/api/admin/settings', admin, (req, res) => res.json({ open_mode: getSet('open_mode', 'auto'),
  schedule: getSet('schedule', DEF_SCHEDULE), pickup_address: getSet('pickup_address', ''), open_now: isOpen() }));
app.put('/api/admin/settings', admin, (req, res) => {
  const { open_mode, schedule, pickup_address } = req.body;
  if (['auto', 'open', 'closed'].includes(open_mode)) setSet('open_mode', open_mode);
  if (Array.isArray(schedule) && schedule.length === 7) setSet('schedule', schedule);
  if (typeof pickup_address === 'string') setSet('pickup_address', pickup_address.trim());
  res.json({ ok: true });
});
app.get('/api/admin/zones', admin, (req, res) => res.json(db.prepare('SELECT * FROM zones WHERE active=1 ORDER BY name').all()));
app.post('/api/admin/zones', admin, (req, res) => {
  const { name, cost } = req.body;
  if (!name?.trim() || !(+cost >= 0)) return res.status(400).json({ error: 'Zona y costo obligatorios' });
  db.prepare('INSERT INTO zones(name,cost) VALUES(?,?)').run(name.trim(), Math.round(+cost)); res.json({ ok: true });
});
app.delete('/api/admin/zones/:id', admin, (req, res) => { db.prepare('UPDATE zones SET active=0 WHERE id=?').run(req.params.id); res.json({ ok: true }); });

app.get('/api/admin/report', admin, (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 365);
  const R = `date(o.created_at) >= date('now','localtime','-${days - 1} day') AND o.status!='cancelado'`;
  const q = sql => db.prepare(sql);
  res.json({
    today: q(`SELECT COUNT(*) n, COALESCE(SUM(total),0) t FROM orders o WHERE date(created_at)=date('now','localtime') AND status!='cancelado'`).get(),
    sum: q(`SELECT COUNT(*) n, COALESCE(SUM(total),0) t FROM orders o WHERE ${R}`).get(),
    byDay: q(`SELECT date(created_at) d, COUNT(*) n, SUM(total) t FROM orders o WHERE ${R} GROUP BY d ORDER BY d`).all(),
    top: q(`SELECT i.name, SUM(i.qty) q, SUM(i.qty*i.price) t FROM order_items i JOIN orders o ON o.id=i.order_id WHERE ${R} GROUP BY i.name ORDER BY q DESC LIMIT 10`).all(),
    byPay: q(`SELECT payment_method m, payment_status s, COUNT(*) n, SUM(total) t FROM orders o WHERE ${R} GROUP BY m, s`).all(),
    byType: q(`SELECT delivery_type k, COUNT(*) n FROM orders o WHERE ${R} GROUP BY k`).all(),
  });
});

app.listen(PORT, () => console.log(`Comidas Don Gato → http://localhost:${PORT}  |  Admin → /admin.html`));
