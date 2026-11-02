import webpush from 'web-push';
import { management, managementPath, d1Store } from '../lib/management.js';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

const plans = [{ id: 'full', name: 'Pase libre', price: 28000, days: 30 }, { id: 'three', name: '3 veces por semana', price: 22000, days: 30 }, { id: 'morning', name: 'Turno mañana', price: 19000, days: 30 }];
const providers = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com'];
const json = (data, status = 200) => Response.json(data, { status });
export const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
export function addDays(date, days) { const d = new Date(date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000);
function requireValue(ok, message, status = 400) { if (!ok) throw Object.assign(new Error(message), { status }); }
function configured(env) {
  return env.DB && env.OWNER_PASSWORD?.length >= 16 && /^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.PUSH_SUBJECT || '') && /^[\w-]{87}$/.test(env.VAPID_PUBLIC_KEY || '') && /^[\w-]{43}$/.test(env.VAPID_PRIVATE_KEY || '');
}
function authenticated(request, env) {
  try {
    const auth = request.headers.get('authorization') || '';
    if (!auth.startsWith('Basic ')) return false;
    const raw = Buffer.from(auth.slice(6), 'base64').toString();
    const hash = value => createHash('sha256').update(value).digest();
    return timingSafeEqual(hash(raw), hash('admin:' + env.OWNER_PASSWORD));
  } catch { return false; }
}
function secure(response) {
  const out = new Response(response.body, response);
  out.headers.set('X-Content-Type-Options', 'nosniff');
  out.headers.set('Referrer-Policy', 'no-referrer');
  out.headers.set('X-Frame-Options', 'DENY');
  out.headers.set('Cache-Control', 'no-store');
  return out;
}
async function body(request) {
  requireValue(request.headers.get('content-type')?.split(';')[0].trim() === 'application/json', 'Usá contenido JSON.', 415);
  requireValue(Number(request.headers.get('content-length') || 0) <= 12288, 'El formulario es demasiado grande.', 413);
  const reader = request.body?.getReader();
  requireValue(reader, 'Falta el formulario.');
  const chunks = []; let size = 0;
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > 12288) { await reader.cancel(); requireValue(false, 'El formulario es demasiado grande.', 413); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let value;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { requireValue(false, 'El formulario JSON no es válido.'); }
  requireValue(value && typeof value === 'object' && !Array.isArray(value), 'El formulario no es válido.');
  return value;
}
function memberInput(data, availablePlans, existingPlan) {
  const { name, phone = '', plan, expires } = data;
  requireValue(typeof name === 'string' && name.trim().length >= 2 && name.trim().length <= 100, 'Ingresá un nombre de entre 2 y 100 caracteres.');
  requireValue(typeof phone === 'string' && phone.length <= 30, 'El teléfono no es válido.');
  requireValue(availablePlans.some(p => p.id === plan && (p.active || existingPlan === plan)), 'Seleccioná un plan válido.');
  requireValue(typeof expires === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(expires) && Number.isFinite(Date.parse(expires)) && new Date(expires).toISOString().slice(0, 10) === expires, 'Ingresá una fecha de vencimiento válida.');
  return [name.trim(), phone.trim(), plan, expires];
}
async function seedDemo(db, env) {
  if (env.SEED_DEMO !== 'true' || await db.prepare("SELECT value FROM app_meta WHERE key='demo_initialized'").first()) return;
  const count = await db.prepare('SELECT count(*) AS n FROM members').first();
  const statements = [];
  if (!count.n) {
    const demo = [['Lucía Fernández', 'full', 12], ['Martín Rodríguez', 'three', 2], ['Camila Torres', 'full', -4], ['Nicolás Gómez', 'morning', 18], ['Valentina López', 'full', 0], ['Santiago Díaz', 'three', 1], ['Sofía Martínez', 'morning', -8], ['Tomás Romero', 'full', 24]];
    for (const [name, plan, offset] of demo) {
      const token = randomBytes(24).toString('hex'), expires = addDays(today(), offset);
      statements.push(db.prepare("INSERT INTO members(name,plan,expires,token,created) SELECT ?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM app_meta WHERE key='demo_initialized')").bind(name, plan, expires, token, today()));
      if (offset > 3) statements.push(db.prepare("INSERT INTO payments(member_id,amount,method,date,old_expires,new_expires,request_key) SELECT id,?,'Transferencia',?,?,?,? FROM members WHERE token=?").bind(plans.find(p => p.id === plan).price, today(), addDays(expires, -30), expires, 'demo-' + token, token));
    }
  }
  statements.push(db.prepare("INSERT OR IGNORE INTO app_meta VALUES('demo_initialized','true')"));
  await db.batch(statements);
}
async function payment(db, data) {
  const { memberId, amount, method, requestKey } = data;
  requireValue(typeof requestKey === 'string' && /^[a-zA-Z0-9-]{16,80}$/.test(requestKey), 'Falta el identificador del cobro. Volvé a abrir el formulario.');
  requireValue(Number.isSafeInteger(Number(memberId)) && Number(memberId) > 0, 'Seleccioná un socio válido.');
  const previous = await db.prepare('SELECT * FROM payments WHERE request_key=?').bind(requestKey).first();
  function replay(row) {
    requireValue(row.member_id === Number(memberId) && row.amount === amount && row.method === method && row.kind === 'renewal', 'El identificador de cobro ya fue utilizado.');
    return json({ expires: row.new_expires, replayed: true });
  }
  if (previous) return replay(previous);
  requireValue(Number.isSafeInteger(amount) && amount > 0 && amount <= 100000000, 'El importe debe ser un número entero positivo.');
  requireValue(['Transferencia', 'Efectivo', 'Tarjeta'].includes(method), 'Seleccioná un medio de pago válido.');
  const member = await db.prepare('SELECT * FROM members WHERE id=?').bind(Number(memberId)).first();
  requireValue(member, 'Seleccioná un socio válido.');
  const plan = await db.prepare('SELECT * FROM plans WHERE id=?').bind(member.plan).first();
  requireValue(amount === plan.price, `La renovación completa de este plan cuesta $${plan.price}. No se admiten pagos parciales en esta versión.`);
  // INSERT reads the current expiry and the trigger renews it in ONE SQLite statement.
  // Distinct concurrent payments accumulate; the same request key renews only once.
  
  const inserted = await db.prepare(`INSERT INTO payments(member_id,amount,method,date,old_expires,new_expires,request_key)
    SELECT m.id,?,?,?,m.expires,date(CASE WHEN m.expires > ? THEN m.expires ELSE ? END, '+' || p.days || ' days'),?
    FROM members m JOIN plans p ON p.id=m.plan WHERE m.id=? AND ?=p.price
    ON CONFLICT(request_key) DO NOTHING RETURNING *`).bind(amount, method, today(), today(), today(), requestKey, Number(memberId), amount).first();
  if (inserted) return json({ expires: inserted.new_expires }, 201);
  const existing = await db.prepare('SELECT * FROM payments WHERE request_key=?').bind(requestKey).first();
  if (existing) return replay(existing);
  requireValue(false, 'El plan cambió durante el cobro. Volvé a abrir el formulario.', 409);
}
function validateSubscription(s) {
  requireValue(typeof s.endpoint === 'string' && s.endpoint.length < 2048, 'Suscripción inválida.');
  let url; try { url = new URL(s.endpoint); } catch { requireValue(false, 'Destino push inválido.'); }
  requireValue(url.protocol === 'https:' && !url.username && !url.password && !url.port && providers.includes(url.hostname), 'Proveedor push no compatible.');
  requireValue(s.keys && typeof s.keys.p256dh === 'string' && /^[A-Za-z0-9_-]{87}=?$/.test(s.keys.p256dh) && typeof s.keys.auth === 'string' && /^[A-Za-z0-9_-]{22}={0,2}$/.test(s.keys.auth), 'Claves push inválidas.');
}
export async function sendPush(subscription, payload, env, transport = fetch) {
  const details = webpush.generateRequestDetails(subscription, JSON.stringify(payload), {
    TTL: 3600, vapidDetails: { subject: env.PUSH_SUBJECT, publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY }
  });
  const response = await transport(details.endpoint, { method: details.method, headers: details.headers, body: details.body, redirect: 'manual', signal: AbortSignal.timeout(10000) });
  await response.body?.cancel();
  if (!response.ok) throw Object.assign(new Error('El proveedor push rechazó el envío.'), { statusCode: response.status });
}
async function deliver(db, env, member, title, text, kind, send = sendPush) {
  const { results: subs } = await db.prepare('SELECT * FROM subscriptions WHERE member_id=?').bind(member.id).all();
  const result = { sent: 0, failed: 0, expired: 0, devices: subs.length };
  for (const sub of subs) {
    try { await send(JSON.parse(sub.subscription), { title, body: text, url: `/socio/${member.token}` }, env); result.sent++; }
    catch (error) {
      if ([404, 410].includes(error.statusCode)) { await db.prepare('DELETE FROM subscriptions WHERE endpoint=? AND member_id=?').bind(sub.endpoint, member.id).run(); result.expired++; }
      else result.failed++;
    }
  }
  if (result.sent && (kind === 'test' || kind.startsWith('manual:') || !result.failed)) await db.prepare('INSERT OR IGNORE INTO notices(member_id,title,body,created,kind,expiry) VALUES(?,?,?,?,?,?)').bind(member.id, title, text, today(), kind, member.expires).run();
  return result;
}
export async function reminders(db, env, { send = sendPush } = {}) {
  const result = { sent: 0, failed: 0, expired: 0 };
  const { results: members } = await db.prepare(`SELECT m.* FROM members m
    WHERE expires IN (?,?,?,?) AND EXISTS(SELECT 1 FROM subscriptions s WHERE s.member_id=m.id)
    AND NOT EXISTS(SELECT 1 FROM notices n WHERE n.member_id=m.id AND n.expiry=m.expires AND n.kind='expiry:' || CAST(julianday(m.expires)-julianday(?) AS INTEGER))
    ORDER BY COALESCE((SELECT j.attempted_at FROM reminder_jobs j WHERE j.member_id=m.id AND j.expiry=m.expires AND j.kind='expiry:' || CAST(julianday(m.expires)-julianday(?) AS INTEGER)),0),m.id LIMIT 10`).bind(addDays(today(), 3), addDays(today(), 1), today(), addDays(today(), -1), today(), today()).all();
  // Persistent leases coordinate cron and manual reviews across Worker isolates.
  for (const member of members) {
    const days = daysBetween(today(), member.expires), kind = `expiry:${days}`, now = Date.now();
    const claimed = await db.prepare(`INSERT INTO reminder_jobs(member_id,kind,expiry,lease_until,attempted_at) VALUES(?,?,?,?,?)
      ON CONFLICT(member_id,kind,expiry) DO UPDATE SET lease_until=excluded.lease_until,attempted_at=excluded.attempted_at
      WHERE reminder_jobs.completed=0 AND reminder_jobs.lease_until < ? RETURNING member_id`).bind(member.id, kind, member.expires, now + 240000, now, now).first();
    if (!claimed) continue;
    // A renewal can have happened after the candidate query.
    const current = await db.prepare('SELECT expires FROM members WHERE id=?').bind(member.id).first();
    if (current.expires !== member.expires) { await db.prepare('UPDATE reminder_jobs SET completed=1 WHERE member_id=? AND kind=? AND expiry=?').bind(member.id, kind, member.expires).run(); continue; }
    const text = days > 0 ? `Tu membresía vence ${days === 1 ? 'mañana' : 'en 3 días'}. Acercate a recepción para renovarla.` : days === 0 ? 'Tu membresía vence hoy. Renovala en recepción para seguir entrenando.' : 'Tu membresía venció ayer. Te esperamos en recepción para renovarla.';
    const delivered = await deliver(db, env, member, 'Un recordatorio para seguir 💪', text, kind, send);
    for (const key of Object.keys(result)) result[key] += delivered[key];
    await db.prepare('UPDATE reminder_jobs SET completed=?,lease_until=0 WHERE member_id=? AND kind=? AND expiry=?').bind(delivered.sent > 0 && !delivered.failed ? 1 : 0, member.id, kind, member.expires).run();
  }
  return result;
}
async function route(request, env) {
  const url = new URL(request.url), path = url.pathname;
  if (!configured(env)) return json({ error: 'Falta completar la configuración privada de Gympanel.' }, 503);
  const db = env.DB.withSession('first-primary');
  if (path === '/healthz' && request.method === 'GET') { await db.prepare('SELECT 1').first(); return json({ status: 'ok' }); }
  const ownerRoute = ['/', '/index.html', '/index'].includes(path) || path.startsWith('/api/owner');
  if (ownerRoute && !authenticated(request, env)) {
    const response = json({ error: 'Ingresá con el usuario admin y la contraseña del dueño.' }, 401);
    response.headers.set('WWW-Authenticate', 'Basic realm="Gympanel", charset="UTF-8"');
    return response;
  }
  if (!['GET', 'HEAD'].includes(request.method)) {
    const origin = request.headers.get('origin');
    requireValue(!origin || origin === url.origin, 'Origen de la solicitud no permitido.', 403);
    requireValue(request.headers.get('sec-fetch-site') !== 'cross-site', 'Origen de la solicitud no permitido.', 403);
  }
  if (managementPath(path)) {
    const result=await management({store:d1Store(db),path,method:request.method,data:['POST','PUT'].includes(request.method)?await body(request):{},date:today(),deliver:(member,title,text,kind)=>deliver(db,env,member,title,text,kind)});
    return json(result.body,result.status);
  }
  const getPlans = async () => (await db.prepare('SELECT * FROM plans ORDER BY active DESC,rowid').all()).results;
  const getClasses = async () => (await db.prepare('SELECT * FROM classes WHERE active=1 ORDER BY weekday,starts').all()).results;
  if (path === '/api/owner/dashboard' && request.method === 'GET') {
    await seedDemo(db, env);
    const [members, payments, notices] = await db.batch([
      db.prepare('SELECT m.*, (SELECT count(*) FROM subscriptions s WHERE s.member_id=m.id) AS devices FROM members m ORDER BY m.name COLLATE NOCASE'),
      db.prepare('SELECT p.*,m.name FROM payments p JOIN members m ON m.id=p.member_id ORDER BY p.id DESC'),
      db.prepare('SELECT n.*,m.name FROM notices n JOIN members m ON m.id=n.member_id ORDER BY n.id DESC LIMIT 100')
    ]);
    return json({ today: today(), demo: env.SEED_DEMO === 'true', protected: true, reminderSchedule: 'cada hora', plans: await getPlans(), classes: await getClasses(), members: members.results, payments: payments.results, notices: notices.results });
  }
  if (path === '/api/owner/members' && request.method === 'POST') {
    const values = memberInput(await body(request), await getPlans());
    const member = await db.prepare('INSERT INTO members(name,phone,plan,expires,token,created) VALUES(?,?,?,?,?,?) RETURNING id').bind(...values, randomBytes(24).toString('hex'), today()).first();
    return json(member, 201);
  }
  const edit = path.match(/^\/api\/owner\/members\/(\d+)$/);
  if (edit && request.method === 'PUT') {
    const existing = await db.prepare('SELECT plan FROM members WHERE id=?').bind(Number(edit[1])).first();
    const values = memberInput(await body(request), await getPlans(), existing?.plan);
    const member = await db.prepare('UPDATE members SET name=?,phone=?,plan=?,expires=? WHERE id=? RETURNING id').bind(...values, Number(edit[1])).first();
    requireValue(member, 'Socio no encontrado.', 404); return json({ ok: true });
  }
  if (path === '/api/owner/payments' && request.method === 'POST') return payment(db, await body(request));
  if (path === '/api/owner/reminders' && request.method === 'POST') return json(await reminders(db, env));
  const memberRoute = path.match(/^\/api\/member\/([a-f0-9]{48})(?:\/(subscribe|unsubscribe|test))?$/);
  const manifestRoute = path.match(/^\/manifest\/([a-f0-9]{48})\.webmanifest$/);
  if (memberRoute || manifestRoute) {
    const member = await db.prepare('SELECT id,name,plan,expires,token,balance FROM members WHERE token=?').bind((memberRoute || manifestRoute)[1]).first();
    requireValue(member, 'Esta credencial no existe.', 404);
    if (manifestRoute && request.method === 'GET') return new Response(JSON.stringify({ name: 'Mi membresía · Gympanel', short_name: 'Mi gimnasio', id: `/socio/${member.token}`, start_url: `/socio/${member.token}`, scope: '/', display: 'standalone', background_color: '#f2f6fc', theme_color: '#285ce6', icons: [192, 512].map(size => ({ src: `/icon-${size}.png`, sizes: `${size}x${size}`, type: 'image/png', purpose: 'any' })) }), { headers: { 'Content-Type': 'application/manifest+json' } });
    const action = memberRoute?.[2];
    if (memberRoute && !action && request.method === 'GET') {
      const [payments, notices] = await db.batch([db.prepare('SELECT amount,method,date,new_expires,kind FROM payments WHERE member_id=? ORDER BY id DESC').bind(member.id), db.prepare('SELECT title,body,created FROM notices WHERE member_id=? ORDER BY id DESC LIMIT 30').bind(member.id)]);
      return json({ ...member, today: today(), plan: (await getPlans()).find(p => p.id === member.plan), classes: await getClasses(), payments: payments.results, notices: notices.results, publicKey: env.VAPID_PUBLIC_KEY });
    }
    if (action === 'subscribe' && request.method === 'POST') {
      const s = await body(request); validateSubscription(s);
      const existing = await db.prepare('SELECT member_id FROM subscriptions WHERE endpoint=?').bind(s.endpoint).first();
      requireValue(!existing || existing.member_id === member.id, 'Este navegador ya está asociado a otro socio. Desactivá primero sus avisos.');
      const count = await db.prepare('SELECT count(*) AS n FROM subscriptions WHERE member_id=?').bind(member.id).first();
      requireValue(existing || count.n < 3, 'Ya hay tres dispositivos activados para este socio.');
      // The ownership and device limit checks are also atomic in SQL.
      const saved = await db.prepare(`INSERT INTO subscriptions(endpoint,member_id,subscription,created)
        SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM subscriptions WHERE endpoint=? AND member_id=?) OR (SELECT count(*) FROM subscriptions WHERE member_id=?) < 3
        ON CONFLICT(endpoint) DO UPDATE SET subscription=excluded.subscription WHERE subscriptions.member_id=excluded.member_id RETURNING endpoint`).bind(s.endpoint, member.id, JSON.stringify(s), today(), s.endpoint, member.id, member.id).first();
      requireValue(saved, 'No se pudo asociar este dispositivo. Revisá sus avisos.'); return json({ ok: true }, 201);
    }
    if (action === 'unsubscribe' && request.method === 'POST') {
      const data = await body(request); requireValue(typeof data.endpoint === 'string', 'Suscripción inválida.');
      await db.prepare('DELETE FROM subscriptions WHERE endpoint=? AND member_id=?').bind(data.endpoint, member.id).run(); return json({ ok: true });
    }
    if (action === 'test' && request.method === 'POST') {
      // Limit repeated push tests from a shared member link to once per minute.
      const claim = await db.prepare(`INSERT INTO app_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE CAST(app_meta.value AS INTEGER) < ? RETURNING key`).bind('test:' + member.id, String(Date.now() + 60000), Date.now()).first();
      requireValue(claim, 'Esperá un minuto antes de enviar otro aviso de prueba.', 429);
      const result = await deliver(db, env, member, '¡Tus avisos están activados!', 'Te vamos a recordar cuando tu membresía esté por vencer.', 'test');
      return json({ ...result, error: result.sent ? undefined : 'No se pudo entregar. Revisá los permisos y la conexión del servicio push.' }, result.sent ? 200 : 503);
    }
  }
  if (request.method === 'GET' || request.method === 'HEAD') {
    let asset;
    if (['/', '/index', '/index.html'].includes(path)) asset = '/index.html';
    else if (/^\/socio\/[a-f0-9]{48}$/.test(path)) asset = '/member.html';
    else if (['/app.js', '/styles.css', '/sw.js', '/icon.svg', '/icon-192.png', '/icon-512.png'].includes(path)) asset = path;
    if (asset) { const assetUrl = new URL(asset, url); return env.ASSETS.fetch(new Request(assetUrl, { method: request.method })); }
  }
  return json({ error: 'No se encontró esta página.' }, 404);
}
export default {
  async fetch(request, env) {
    try { return secure(await route(request, env)); }
    catch (error) { if (!error.status) console.error('Gympanel: error interno en la solicitud.'); return secure(json({ error: error.status ? error.message : 'Ocurrió un error. Intentá nuevamente.' }, error.status || 500)); }
  },
  async scheduled(event, env, ctx) {
    if (!configured(env)) throw new Error('Falta completar la configuración privada de Gympanel.');
    ctx.waitUntil(reminders(env.DB.withSession('first-primary'), env));
  }
};
