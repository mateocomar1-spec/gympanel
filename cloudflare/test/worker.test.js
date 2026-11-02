import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import webpush from 'web-push';
import ece from 'http_ece';
import { unstable_splitSqlQuery } from 'wrangler';
import { today, addDays } from '../worker.js';
import { managementContract } from '../../test/management-contract.js';

async function fixture(t, { demo = false, password = 'a-private-test-password', pushStatus = () => 201, beforeUpgrade } = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'gympanel-worker-'));
  const keys = webpush.generateVAPIDKeys(), calls = [];
  const options = {
    name: 'gympanel',
    modules: true, scriptPath: resolve('work/cloudflare-build/worker.js'),
    compatibilityDate: '2026-11-02', compatibilityFlags: ['nodejs_compat'],
    bindings: { OWNER_PASSWORD: password, PUSH_SUBJECT: 'mailto:owner@test.example', VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, SEED_DEMO: String(demo) },
    d1Databases: ['DB'], d1Persist: folder,
    assets: { directory: resolve('public'), binding: 'ASSETS', run_worker_first: true, routerConfig: { has_user_worker: true }, assetConfig: { html_handling: 'none' } },
    outboundService: async request => {
      assert.equal(new URL(request.url).hostname, 'fcm.googleapis.com');
      calls.push({ headers: Object.fromEntries(request.headers), body: Buffer.from(await request.arrayBuffer()), url: request.url });
      return new Response('', { status: pushStatus(request.url) });
    }
  };
  const runtimeOptions = () => ({ ...convertV4MiniflareOptions(options), resourcePersistencePath: folder });
  let mf = new Miniflare(runtimeOptions());
  t.after(async () => { await mf.dispose(); rmSync(folder, { recursive: true, force: true }); });
  let db = await mf.getD1Database('DB');
  for (const migration of readdirSync('cloudflare/migrations').filter(name=>name.endsWith('.sql')).sort()) {
    await db.batch(unstable_splitSqlQuery(readFileSync('cloudflare/migrations/'+migration,'utf8')).map(sql=>db.prepare(sql)));
    if (migration === '0001_initial.sql' && beforeUpgrade) await beforeUpgrade(db);
  }
  async function request(path, method = 'GET', data, { owner = true, headers = {} } = {}) {
    const response = await mf.dispatchFetch('https://gympanel.test' + path, {
      method, headers: { ...(owner ? { Authorization: 'Basic ' + Buffer.from('admin:' + password).toString('base64') } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: data ? JSON.stringify(data) : undefined, redirect: 'manual'
    });
    const type = response.headers.get('Content-Type');
    const value = type?.includes('json') ? await response.json() : await response.text();
    return { status: response.status, body: value, headers: response.headers };
  }
  async function member(overrides = {}) {
    const created = await request('/api/owner/members', 'POST', { name: 'Ana Pérez', phone: '', plan: 'full', expires: today(), ...overrides });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    return db.prepare('SELECT * FROM members WHERE id=?').bind(created.body.id).first();
  }
  async function restart() { await mf.dispose(); mf = new Miniflare(runtimeOptions()); db = await mf.getD1Database('DB'); }
  return { request, member, db, calls, keys, restart, scheduled: async () => (await mf.getWorker()).scheduled({ cron: '0 * * * *' }) };
}
function subscription(id = randomUUID()) {
  const curve = createECDH('prime256v1'); curve.generateKeys();
  const auth = randomBytes(16).toString('base64url');
  return { data: { endpoint: 'https://fcm.googleapis.com/fcm/send/' + id, keys: { p256dh: curve.getPublicKey().toString('base64url'), auth } }, curve, auth };
}

test('Workers protects HTML and APIs, serves assets, rejects bad input and cross-site writes', async t => {
  const { request } = await fixture(t);
  for (const path of ['/', '/index', '/index.html', '/api/owner/dashboard']) {
    const response = await request(path, 'GET', undefined, { owner: false });
    assert.equal(response.status, 401, path);
    assert.match(response.headers.get('WWW-Authenticate'), /Basic/);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
  assert.equal((await request('/healthz', 'GET', undefined, { owner: false })).status, 200);
  assert.match((await request('/')).body, /Gympanel/i);
  assert.equal((await request('/app.js', 'GET', undefined, { owner: false })).status, 200);
  assert.equal((await request('/member.html')).status, 404);
  assert.equal((await request('/api/member/invalid')).status, 404);
  assert.equal((await request('/api/owner/members', 'POST', { name: 'A', plan: 'full', expires: today() })).status, 400);
  assert.equal((await request('/api/owner/members', 'POST', { name: 'Ana', plan: 'full', expires: '2026-02-30' })).status, 400);
  assert.equal((await request('/api/owner/members', 'POST', {}, { headers: { Origin: 'https://evil.test' } })).status, 403);
  assert.equal((await request('/api/owner/members', 'POST', { name: 'x'.repeat(13000) })).status, 413);
});
test('Workers fails closed if the administrator password is not configured', async t => {
  const { request } = await fixture(t, { password: '' });
  assert.equal((await request('/')).status, 503);
  assert.equal((await request('/api/owner/dashboard')).status, 503);
});
test('D1 demo initializes once even with concurrent dashboards and survives a Worker restart', async t => {
  const { request, restart } = await fixture(t, { demo: true });
  const responses = await Promise.all([request('/api/owner/dashboard'), request('/api/owner/dashboard')]);
  for (const response of responses) { assert.equal(response.status, 200); assert.equal(response.body.members.length, 8); }
  const before = responses[0].body.members.map(m => m.token);
  await restart();
  const after = await request('/api/owner/dashboard');
  assert.deepEqual(after.body.members.map(m => m.token), before);
  assert.equal(after.body.payments.length, 3);
  assert.equal(after.body.reminderSchedule, 'cada hora');
});
test('D1 concurrent payment retries renew once; distinct payments accumulate atomically and persist', async t => {
  const { member, request, restart } = await fixture(t);
  const m = await member({ expires: addDays(today(), 10) });
  const data = { memberId: m.id, amount: 28000, method: 'Efectivo', requestKey: randomUUID() };
  const responses = await Promise.all(Array.from({ length: 4 }, () => request('/api/owner/payments', 'POST', data)));
  assert.equal(responses.filter(r => r.status === 201).length, 1, JSON.stringify(responses));
  assert.equal(responses.filter(r => r.status === 200).length, 3);
  assert.equal((await request('/api/owner/payments', 'POST', { ...data, amount: 100 })).status, 400);
  const second = await Promise.all(Array.from({ length: 2 }, () => request('/api/owner/payments', 'POST', { ...data, requestKey: randomUUID() })));
  assert.ok(second.every(r => r.status === 201));
  await restart();
  const dashboard = (await request('/api/owner/dashboard')).body;
  assert.equal(dashboard.payments.length, 3);
  assert.equal(dashboard.members[0].expires, addDays(m.expires, 90));
  const expired = await member({ name: 'Otro socio', expires: addDays(today(), -10) });
  assert.equal((await request('/api/owner/payments', 'POST', { ...data, memberId: expired.id, requestKey: randomUUID() })).body.expires, addDays(today(), 30));
});
test('Member data stays scoped, subscriptions cannot be stolen, and Workers sends encrypted Web Push', async t => {
  const { request, member, calls } = await fixture(t);
  const first = await member(), second = await member({ name: 'Otro socio' });
  const sub = subscription();
  const path = '/api/member/' + first.token;
  assert.equal((await request(path + '/subscribe', 'POST', sub.data, { owner: false })).status, 201);
  assert.equal((await request('/api/member/' + second.token + '/subscribe', 'POST', sub.data, { owner: false })).status, 400);
  await request('/api/member/' + second.token + '/unsubscribe', 'POST', { endpoint: sub.data.endpoint }, { owner: false });
  const sent = await request(path + '/test', 'POST', {}, { owner: false });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.sent, 1);
  assert.equal(calls[0].headers['content-encoding'], 'aes128gcm');
  assert.match(calls[0].headers.authorization, /^vapid /);
  const decoded = JSON.parse(ece.decrypt(calls[0].body, { version: 'aes128gcm', privateKey: sub.curve, authSecret: sub.auth }).toString());
  assert.equal(decoded.url, '/socio/' + first.token);
  assert.match(decoded.title, /activados/);
  assert.equal((await request(path + '/test', 'POST', {}, { owner: false })).status, 429);
  const personal = (await request(path, 'GET', undefined, { owner: false })).body;
  assert.equal(personal.name, first.name); assert.equal(personal.notices.length, 1);
  assert.equal('phone' in personal, false);
  const manifest = await request('/manifest/' + first.token + '.webmanifest', 'GET', undefined, { owner: false });
  assert.equal(manifest.body.start_url, '/socio/' + first.token);
  assert.equal((await request('/socio/' + first.token, 'GET', undefined, { owner: false })).status, 200);
  assert.equal((await request(path + '/subscribe', 'POST', { ...sub.data, endpoint: 'https://evil.test/' }, { owner: false })).status, 400);
});
test('Real scheduled Worker deduplicates reminders, removes expired devices and retries transient failures', async t => {
  let fail = true;
  const { request, member, calls, db, scheduled } = await fixture(t, { pushStatus: url => url.endsWith('/expired') ? 410 : fail ? 503 : 201 });
  const m = await member({ expires: addDays(today(), 3) }), path = '/api/member/' + m.token;
  for (const id of ['expired', 'retry']) await request(path + '/subscribe', 'POST', subscription(id).data, { owner: false });
  await scheduled();
  assert.equal((await db.prepare('SELECT count(*) AS n FROM subscriptions').first()).n, 1);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM notices').first()).n, 0);
  fail = false;
  await scheduled();
  assert.equal((await db.prepare('SELECT count(*) AS n FROM notices').first()).n, 1);
  assert.equal(calls.length, 3);
  await Promise.all([request('/api/owner/reminders', 'POST', {}), request('/api/owner/reminders', 'POST', {})]);
  await scheduled(); assert.equal(calls.length, 3);
  await request('/api/owner/payments', 'POST', { memberId: m.id, amount: 28000, method: 'Efectivo', requestKey: randomUUID() });
  await scheduled(); assert.equal(calls.length, 3);
});

test('D1 management: custom plans, schedule, recorded balances, debt collections and idempotent push',async t=>{
  const f=await fixture(t);
  await managementContract({...f,today,addDays,subscribe:async m=>{
    const r=await f.request('/api/member/'+m.token+'/subscribe','POST',subscription().data,{owner:false});
    assert.equal(r.status,201);
  }});
});

test('D1 upgrade preserves existing members, payments, devices and private links',async t=>{
  const token='a'.repeat(48);
  const f=await fixture(t,{beforeUpgrade:async db=>{
    await db.prepare('INSERT INTO members(id,name,plan,expires,token,created) VALUES(1,?,?,?,?,?)').bind('Socio anterior','full',today(),token,today()).run();
    await db.prepare("INSERT INTO payments(member_id,amount,method,date,old_expires,new_expires,request_key) VALUES(1,28000,'Efectivo',?,?,?,?)").bind(today(),today(),addDays(today(),30),randomUUID()).run();
    const s=subscription();
    await db.prepare('INSERT INTO subscriptions VALUES(?,?,?,?)').bind(s.data.endpoint,1,JSON.stringify(s.data),today()).run();
  }});
  const dashboard=(await f.request('/api/owner/dashboard')).body;
  assert.equal(dashboard.members[0].token,token);assert.equal(dashboard.members[0].devices,1);
  assert.equal(dashboard.members[0].balance,0);assert.equal(dashboard.payments[0].amount,28000);
  assert.equal(dashboard.payments[0].kind,'renewal');
  assert.equal((await f.request('/api/member/'+token)).body.expires,addDays(today(),30));
  assert.deepEqual((await f.db.prepare('PRAGMA foreign_key_check').all()).results,[]);
});
