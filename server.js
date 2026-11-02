import express from 'express';
import { management, managementPath, nodeStore } from './lib/management.js';
import webpush from 'web-push';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
export function today() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
export function daysBetween(a, b) { return Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000); }
export function addDays(date, days) { const d = new Date(date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
function validDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s; }
function requireValue(ok, message) { if (!ok) { const e = new Error(message); e.status = 400; throw e; } }
const plans = [{ id: 'full', name: 'Pase libre', price: 28000, days: 30 }, { id: 'three', name: '3 veces por semana', price: 22000, days: 30 }, { id: 'morning', name: 'Turno mañana', price: 19000, days: 30 }];

export function runtimeConfig(env = process.env) {
  const host = env.HOST || (env.RENDER === 'true' ? '0.0.0.0' : '127.0.0.1');
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT debe ser un puerto válido.');
  const exposed = !['127.0.0.1', 'localhost', '::1'].includes(host);
  if ((exposed || env.NODE_ENV === 'production' || env.RENDER === 'true') && (!env.OWNER_PASSWORD || env.OWNER_PASSWORD.length < 16)) {
    throw new Error('Configurá OWNER_PASSWORD con al menos 16 caracteres antes de exponer el panel.');
  }
  if (env.RENDER === 'true') {
    if (!env.DATA_DIR || !path.isAbsolute(env.DATA_DIR)) throw new Error('Render requiere DATA_DIR apuntando a una ruta absoluta dentro del disco persistente.');
    if (!env.PUSH_SUBJECT || env.PUSH_SUBJECT === 'mailto:admin@example.com') throw new Error('Configurá PUSH_SUBJECT con el contacto real del responsable (mailto:tu-email).');
  }
  return { host, port };
}

export function createApp({ dataDir = process.env.DATA_DIR || path.join(root, 'data'), seed = process.env.SEED_DEMO !== 'false', sendPush = webpush.sendNotification.bind(webpush), ownerPassword = process.env.OWNER_PASSWORD, pushSubject = process.env.PUSH_SUBJECT || 'mailto:admin@example.com' } = {}) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(dataDir, 'gympanel.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS members (id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '', plan TEXT NOT NULL, expires TEXT NOT NULL, token TEXT NOT NULL UNIQUE, created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS payments (id INTEGER PRIMARY KEY, member_id INTEGER NOT NULL REFERENCES members(id), amount INTEGER NOT NULL, method TEXT NOT NULL, date TEXT NOT NULL, old_expires TEXT NOT NULL, new_expires TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS payment_requests (request_key TEXT PRIMARY KEY, payment_id INTEGER NOT NULL REFERENCES payments(id));
    CREATE TABLE IF NOT EXISTS subscriptions (endpoint TEXT PRIMARY KEY, member_id INTEGER NOT NULL REFERENCES members(id), subscription TEXT NOT NULL, created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS notices (id INTEGER PRIMARY KEY, member_id INTEGER NOT NULL REFERENCES members(id), title TEXT NOT NULL, body TEXT NOT NULL, created TEXT NOT NULL, kind TEXT NOT NULL, expiry TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS reminder_once ON notices(member_id, kind, expiry) WHERE kind != 'test';`);
  if (!db.prepare('PRAGMA table_info(members)').all().some(c => c.name === 'balance')) {
    db.exec("ALTER TABLE members ADD COLUMN balance INTEGER NOT NULL DEFAULT 0 CHECK(balance>=0); ALTER TABLE members ADD COLUMN balance_note TEXT NOT NULL DEFAULT '';");
  }
  const paymentColumns = db.prepare('PRAGMA table_info(payments)').all();
  if (!paymentColumns.some(c => c.name === 'kind')) db.exec("ALTER TABLE payments ADD COLUMN kind TEXT NOT NULL DEFAULT 'renewal';");
  if (!paymentColumns.some(c => c.name === 'request_key')) db.exec('ALTER TABLE payments ADD COLUMN request_key TEXT;');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS payment_key_unique ON payments(request_key);');
  db.exec(readFileSync(path.join(root,'lib/management-schema.sql'),'utf8'));
  const getPlans = () => db.prepare('SELECT * FROM plans ORDER BY active DESC,rowid').all();
  const getClasses = () => db.prepare('SELECT * FROM classes WHERE active=1 ORDER BY weekday,starts').all();
  const keyPath = path.join(dataDir, 'vapid.json');
  if (!existsSync(keyPath)) writeFileSync(keyPath, JSON.stringify(webpush.generateVAPIDKeys()), { mode: 0o600 });
  const keys = JSON.parse(readFileSync(keyPath, 'utf8'));
  webpush.setVapidDetails(pushSubject, keys.publicKey, keys.privateKey);
  if (seed && !db.prepare('SELECT id FROM members LIMIT 1').get()) {
    const demo = [['Lucía Fernández', 'full', 12], ['Martín Rodríguez', 'three', 2], ['Camila Torres', 'full', -4], ['Nicolás Gómez', 'morning', 18], ['Valentina López', 'full', 0], ['Santiago Díaz', 'three', 1], ['Sofía Martínez', 'morning', -8], ['Tomás Romero', 'full', 24]];
    for (const [name, plan, offset] of demo) {
      const expires = addDays(today(), offset);
      const result = db.prepare('INSERT INTO members (name, plan, expires, token, created) VALUES (?, ?, ?, ?, ?)').run(name, plan, expires, randomBytes(24).toString('hex'), today());
      if (offset > 3) db.prepare('INSERT INTO payments (member_id, amount, method, date, old_expires, new_expires) VALUES (?, ?, ?, ?, ?, ?)').run(result.lastInsertRowid, plans.find(p => p.id === plan).price, 'Transferencia', today(), addDays(expires, -30), expires);
    }
  }
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '12kb' }));
  app.use((req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); res.set('Referrer-Policy', 'no-referrer'); res.set('X-Frame-Options', 'DENY'); next(); });
  function owner(req, res, next) {
    if (!ownerPassword) return next();
    const auth = req.get('authorization') || '';
    const raw = auth.startsWith('Basic ') ? Buffer.from(auth.slice(6), 'base64').toString() : '';
    const input = Buffer.from(raw.slice(raw.indexOf(':') + 1));
    const expected = Buffer.from(ownerPassword);
    if (raw.startsWith('admin:') && input.length === expected.length && timingSafeEqual(input, expected)) return next();
    res.set('WWW-Authenticate', 'Basic realm="Gympanel"').status(401).send('Ingresá con el usuario admin y la contraseña del dueño.');
  }
  app.get(['/', '/index.html'], owner, (req, res) => res.sendFile(path.join(root, 'public/index.html')));
  app.use('/api/owner', owner);
  app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use('/api/owner', async (req,res,next) => {
    if (!['GET','HEAD'].includes(req.method)) {
      const origin=req.get('origin');
      if (req.get('sec-fetch-site')==='cross-site' || origin && new URL(origin).host!==req.get('host')) return res.status(403).json({error:'Origen de la solicitud no permitido.'});
    }
    const route=req.originalUrl.split('?')[0];
    if (!managementPath(route)) return next();
    try { const result=await management({store:nodeStore(db),path:route,method:req.method,data:req.body,date:today(),deliver});res.status(result.status).json(result.body); } catch(error) {next(error);}
  });
  app.get('/healthz', (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { db.prepare('SELECT 1').get(); res.json({ status: 'ok' }); }
    catch { res.status(503).json({ status: 'unavailable' }); }
  });
  const allMembers = () => db.prepare(`SELECT m.*, (SELECT count(*) FROM subscriptions s WHERE s.member_id=m.id) as devices FROM members m ORDER BY m.name COLLATE NOCASE`).all();
  app.get('/api/owner/dashboard', (req, res) => res.json({ today: today(), demo: seed, protected: Boolean(ownerPassword), plans: getPlans(), classes: getClasses(), members: allMembers(), payments: db.prepare('SELECT p.*, m.name FROM payments p JOIN members m ON m.id=p.member_id ORDER BY p.id DESC').all(), notices: db.prepare('SELECT n.*, m.name FROM notices n JOIN members m ON m.id=n.member_id ORDER BY n.id DESC LIMIT 100').all() }));
  function memberInput(body) {
    const { name, phone = '', plan, expires } = body;
    requireValue(typeof name === 'string' && name.trim().length >= 2 && name.trim().length <= 100, 'Ingresá un nombre de entre 2 y 100 caracteres.');
    requireValue(typeof phone === 'string' && phone.length <= 30, 'El teléfono no es válido.');
    requireValue(getPlans().some(p => p.id === plan && (p.active || body.existingPlan === plan)), 'Seleccioná un plan válido.');
    requireValue(validDate(expires), 'Ingresá una fecha de vencimiento válida.');
    return [name.trim(), phone.trim(), plan, expires];
  }
  app.post('/api/owner/members', (req, res) => {
    const values = memberInput({...req.body, existingPlan: undefined});
    const result = db.prepare('INSERT INTO members (name, phone, plan, expires, token, created) VALUES (?, ?, ?, ?, ?, ?)').run(...values, randomBytes(24).toString('hex'), today());
    res.status(201).json({ id: Number(result.lastInsertRowid) });
  });
  app.put('/api/owner/members/:id', (req, res) => {
    const existing = db.prepare('SELECT plan FROM members WHERE id=?').get(req.params.id);
    const values = memberInput({...req.body, existingPlan: existing?.plan});
    const result = db.prepare('UPDATE members SET name=?, phone=?, plan=?, expires=? WHERE id=?').run(...values, req.params.id);
    if (!result.changes) return res.status(404).json({ error: 'Socio no encontrado.' });
    res.json({ ok: true });
  });
  app.post('/api/owner/payments', (req, res) => {
    const { memberId, amount, method, requestKey } = req.body;
    requireValue(typeof requestKey === 'string' && /^[a-zA-Z0-9-]{16,80}$/.test(requestKey), 'Falta el identificador del cobro. Volvé a abrir el formulario.');
    const previous = db.prepare('SELECT * FROM payments WHERE request_key=? OR id=(SELECT payment_id FROM payment_requests WHERE request_key=?)').get(requestKey,requestKey);
    if (previous) {
      requireValue(previous.member_id === Number(memberId) && previous.amount === amount && previous.method === method && previous.kind === 'renewal', 'El identificador de cobro ya fue utilizado.');
      return res.json({ expires: previous.new_expires, replayed: true });
    }
    const member = db.prepare('SELECT * FROM members WHERE id=?').get(Number(memberId));
    requireValue(member, 'Seleccioná un socio válido.');
    requireValue(Number.isSafeInteger(amount) && amount > 0 && amount <= 100000000, 'El importe debe ser un número entero positivo.');
    requireValue(['Transferencia', 'Efectivo', 'Tarjeta'].includes(method), 'Seleccioná un medio de pago válido.');
    const plan = getPlans().find(p => p.id === member.plan);
    requireValue(amount === plan.price, `La renovación completa de este plan cuesta $${plan.price}. No se admiten pagos parciales en esta versión.`);
    const newExpires = addDays(member.expires > today() ? member.expires : today(), plan.days);
    db.exec('BEGIN IMMEDIATE');
    try {
      const payment = db.prepare('INSERT INTO payments (member_id, amount, method, date, old_expires, new_expires,request_key) VALUES (?, ?, ?, ?, ?, ?,?)').run(member.id, amount, method, today(), member.expires, newExpires,requestKey);
      db.prepare('INSERT INTO payment_requests VALUES (?, ?)').run(requestKey, payment.lastInsertRowid);
      db.prepare('UPDATE members SET expires=? WHERE id=?').run(newExpires, member.id);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    res.status(201).json({ expires: newExpires });
  });
  function findMember(req, res, next) {
    const member = db.prepare('SELECT id, name, plan, expires, token, balance FROM members WHERE token=?').get(req.params.token);
    if (!member) return res.status(404).json({ error: 'Esta credencial no existe.' });
    req.member = member; next();
  }
  app.get('/api/member/:token', findMember, (req, res) => res.json({ ...req.member, today: today(), plan: getPlans().find(p => p.id === req.member.plan), classes: getClasses(), payments: db.prepare('SELECT amount, method, date, new_expires,kind FROM payments WHERE member_id=? ORDER BY id DESC').all(req.member.id), notices: db.prepare('SELECT title, body, created FROM notices WHERE member_id=? ORDER BY id DESC LIMIT 30').all(req.member.id), publicKey: keys.publicKey }));
  app.post('/api/member/:token/subscribe', findMember, (req, res) => {
    const s = req.body;
    requireValue(typeof s.endpoint === 'string' && s.endpoint.length < 2048, 'Suscripción inválida.');
    let url; try { url = new URL(s.endpoint); } catch { requireValue(false, 'Destino push inválido.'); }
    // Only supported browser push providers; prevents arbitrary outbound requests.
    const providers = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com'];
    requireValue(url.protocol === 'https:' && !url.username && !url.password && !url.port && providers.includes(url.hostname), 'Proveedor push no compatible.');
    requireValue(s.keys && typeof s.keys.p256dh === 'string' && /^[A-Za-z0-9_-]{87}=?$/.test(s.keys.p256dh) && typeof s.keys.auth === 'string' && /^[A-Za-z0-9_-]{22}={0,2}$/.test(s.keys.auth), 'Claves push inválidas.');
    const existing = db.prepare('SELECT member_id FROM subscriptions WHERE endpoint=?').get(s.endpoint);
    requireValue(!existing || existing.member_id === req.member.id, 'Este navegador ya está asociado a otro socio. Desactivá primero sus avisos.');
    db.prepare('INSERT OR REPLACE INTO subscriptions VALUES (?, ?, ?, ?)').run(s.endpoint, req.member.id, JSON.stringify(s), today());
    res.status(201).json({ ok: true });
  });
  app.post('/api/member/:token/unsubscribe', findMember, (req, res) => {
    requireValue(typeof req.body.endpoint === 'string', 'Suscripción inválida.');
    db.prepare('DELETE FROM subscriptions WHERE endpoint=? AND member_id=?').run(req.body.endpoint, req.member.id);
    res.json({ ok: true });
  });
  async function deliver(member, title, body, kind) {
    const subs = db.prepare('SELECT * FROM subscriptions WHERE member_id=?').all(member.id);
    let sent = 0, failed = 0, expired = 0;
    for (const sub of subs) {
      try { await sendPush(JSON.parse(sub.subscription), JSON.stringify({ title, body, url: `/socio/${member.token}` }), { TTL: 3600, timeout: 10000 }); sent++; }
      catch (e) { if ([404, 410].includes(e.statusCode)) { db.prepare('DELETE FROM subscriptions WHERE endpoint=?').run(sub.endpoint); expired++; } else failed++; }
    }
    // Persist automatic reminder only after delivery to every surviving device.
    if (((kind === 'test' || kind.startsWith('manual:')) && sent) || (kind !== 'test' && sent && !failed)) db.prepare('INSERT OR IGNORE INTO notices (member_id,title,body,created,kind,expiry) VALUES (?,?,?,?,?,?)').run(member.id, title, body, today(), kind, member.expires);
    return { sent, failed, expired, devices: subs.length };
  }
  app.post('/api/member/:token/test', findMember, async (req, res) => {
    const result = await deliver(req.member, '¡Tus avisos están activados!', 'Te vamos a recordar cuando tu membresía esté por vencer.', 'test');
    res.status(result.sent ? 200 : 503).json({ ...result, error: result.sent ? undefined : 'No se pudo entregar. Revisá los permisos y la conexión del servicio push.' });
  });
  let running = false;
  async function reminders() {
    if (running) return { busy: true };
    running = true;
    const result = { sent: 0, failed: 0, expired: 0 };
    try {
      for (const member of allMembers()) {
        const days = daysBetween(today(), member.expires);
        if (![3, 1, 0, -1].includes(days)) continue;
        const kind = `expiry:${days}`;
        if (db.prepare('SELECT id FROM notices WHERE member_id=? AND kind=? AND expiry=?').get(member.id, kind, member.expires)) continue;
        const body = days > 0 ? `Tu membresía vence ${days === 1 ? 'mañana' : 'en 3 días'}. Acercate a recepción para renovarla.` : days === 0 ? 'Tu membresía vence hoy. Renovala en recepción para seguir entrenando.' : 'Tu membresía venció ayer. Te esperamos en recepción para renovarla.';
        const delivery = await deliver(member, 'Un recordatorio para seguir 💪', body, kind);
        for (const key of Object.keys(result)) result[key] += delivery[key];
      }
      return result;
    } finally { running = false; }
  }
  app.post('/api/owner/reminders', async (req, res) => res.json(await reminders()));
  app.get('/manifest/:token.webmanifest', findMember, (req, res) => {
    res.type('application/manifest+json').set('Cache-Control', 'no-store').json({
      name: 'Mi membresía · Gympanel', short_name: 'Mi gimnasio',
      id: `/socio/${req.member.token}`, start_url: `/socio/${req.member.token}`,
      scope: '/', display: 'standalone', background_color: '#f2f6fc', theme_color: '#285ce6',
      icons: [192, 512].map(size => ({ src: `/icon-${size}.png`, sizes: `${size}x${size}`, type: 'image/png', purpose: 'any' }))
    });
  });
  app.get('/socio/:token', (req, res) => res.sendFile(path.join(root, 'public/member.html')));
  app.use(express.static(path.join(root, 'public'), { index: false }));
  app.use((err, req, res, next) => { const status = err.status || 500; if (status >= 500) console.error('Request failed:', err.message); res.status(status).json({ error: status >= 500 ? 'Ocurrió un error. Intentá nuevamente.' : err.message }); });
  return { app, db, reminders };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { host, port } = runtimeConfig();
  const { app, db, reminders } = createApp();
  const server = app.listen(port, host, () => console.log(`Gympanel iniciado en puerto ${port}. ${process.env.OWNER_PASSWORD ? 'Acceso del dueño protegido.' : 'Modo demo local: configurá OWNER_PASSWORD antes de exponerlo.'}`));
  server.on('error', error => { console.error('No se pudo iniciar el servidor:', error.message); process.exit(1); });
  const timer = setInterval(() => reminders().catch(e => console.error('Recordatorios:', e.message)), 60000);
  timer.unref();
  reminders().catch(e => console.error('Recordatorios:', e.message));
  let stopping = false;
  function shutdown() {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    server.close(() => { db.close(); process.exit(0); });
    server.closeIdleConnections();
    setTimeout(() => process.exit(1), 20000).unref();
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
