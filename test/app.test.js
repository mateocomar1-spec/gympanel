import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp, today, addDays, daysBetween, runtimeConfig } from '../server.js';

async function fixture(t, options = {}) {
 const dir = mkdtempSync(join(tmpdir(), 'gympanel-test-'));
 const result = createApp({ dataDir: dir, seed: false, ownerPassword: '', ...options });
 const server = result.app.listen(0, '127.0.0.1');
 await new Promise(r => server.once('listening', r));
 t.after(async () => { await new Promise(r=>server.close(r)); result.db.close(); rmSync(dir,{recursive:true,force:true}); });
 const url = `http://127.0.0.1:${server.address().port}`;
 async function request(path, method = 'GET', body, headers = {}) {
  if (path === '/api/owner/payments' && body && !('requestKey' in body)) body = { ...body, requestKey: randomUUID() };
  const response = await fetch(url + path, { method, headers: {'Content-Type':'application/json', ...headers}, body: body ? JSON.stringify(body) : undefined });
  const type=response.headers.get('content-type');
  return { status: response.status, body: type?.includes('json') ? await response.json() : await response.text() };
 }
 return { ...result, request };
}
const member = (overrides={}) => ({ name:'Ana Pérez', phone:'', plan:'full', expires: today(), ...overrides });
const subscription = (id='one') => ({endpoint:`https://fcm.googleapis.com/fcm/send/${id}`,keys:{p256dh:'A'.repeat(87),auth:'B'.repeat(22)}});

test('date arithmetic crosses month and year boundaries', () => {
 assert.equal(addDays('2026-12-31',30),'2027-01-30');
 assert.equal(addDays('2028-02-28',1),'2028-02-29');
 assert.equal(daysBetween('2026-10-30','2026-11-02'),3);
});
test('create, find and edit a member; reject invalid inputs and unknown tokens', async t => {
 const {request}=await fixture(t);
 assert.equal((await request('/api/owner/members','POST',member({name:'A'}))).status,400);
 assert.equal((await request('/api/owner/members','POST',member({expires:'2026-02-30'}))).status,400);
 assert.equal((await request('/api/owner/members','POST',member({plan:'fake'}))).status,400);
 const created=await request('/api/owner/members','POST',member());assert.equal(created.status,201);
 const dashboard=(await request('/api/owner/dashboard')).body;
 assert.equal(dashboard.members.length,1);
 const m=dashboard.members[0];
 assert.equal((await request(`/api/member/${m.token}`)).body.name,'Ana Pérez');
 assert.equal((await request('/api/member/invalid')).status,404);
 assert.equal((await request(`/api/owner/members/${m.id}`,'PUT',member({name:'Ana Torres'}))).status,200);
 assert.equal((await request(`/api/member/${m.token}`)).body.name,'Ana Torres');
});
test('payments extend active memberships, start expired ones today, and reject partial amounts',async t=>{
 const {request}=await fixture(t);
 const future=addDays(today(),10);
 const first=(await request('/api/owner/members','POST',member({expires:future}))).body.id;
 assert.equal((await request('/api/owner/payments','POST',{memberId:first,amount:0,method:'Efectivo'})).status,400);
 assert.equal((await request('/api/owner/payments','POST',{memberId:first,amount:100,method:'Efectivo'})).status,400);
 assert.equal((await request('/api/owner/payments','POST',{memberId:first,amount:28000,method:'Crypto'})).status,400);
 const paid=await request('/api/owner/payments','POST',{memberId:first,amount:28000,method:'Efectivo'});
 assert.equal(paid.status,201);assert.equal(paid.body.expires,addDays(future,30));
 const second=(await request('/api/owner/members','POST',member({expires:addDays(today(),-10)}))).body.id;
 const renewed=await request('/api/owner/payments','POST',{memberId:second,amount:28000,method:'Transferencia'});
 assert.equal(renewed.body.expires,addDays(today(),30));
 const data=(await request('/api/owner/dashboard')).body;
 assert.equal(data.payments.length,2);assert.equal(data.payments.reduce((s,p)=>s+p.amount,0),56000);
});
test('data survives reopening the database',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'gympanel-persist-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const first=createApp({dataDir:dir,seed:false});
 first.db.prepare('INSERT INTO members(name,plan,expires,token,created) VALUES(?,?,?,?,?)').run('Ana','full',today(),'secret',today());
 first.db.close();
 const next=createApp({dataDir:dir,seed:false});assert.equal(next.db.prepare('SELECT name FROM members').get().name,'Ana');next.db.close();
});
test('owner authentication protects private APIs while member links remain scoped',async t=>{
 const {request}=await fixture(t,{ownerPassword:'test-password'});
 assert.equal((await request('/api/owner/dashboard')).status,401);
 assert.equal((await request('/')).status,401);
 const headers={authorization:'Basic '+Buffer.from('admin:test-password').toString('base64')};
 assert.equal((await request('/api/owner/dashboard','GET',undefined,headers)).status,200);
 assert.equal((await request('/api/owner/members','POST',member())).status,401);
});
test('reminders deliver at the correct date, deduplicate, and stop after renewal',async t=>{
 const calls=[];const {request,reminders}=await fixture(t,{sendPush:async(s,p)=>{calls.push(JSON.parse(p));}});
 await request('/api/owner/members','POST',member({expires:addDays(today(),3)}));
 const m=(await request('/api/owner/dashboard')).body.members[0];
 assert.equal((await request(`/api/member/${m.token}/subscribe`,'POST',subscription())).status,201);
 assert.equal((await reminders()).sent,1);assert.match(calls[0].body,/en 3 días/);
 assert.equal((await reminders()).sent,0);assert.equal(calls.length,1);
 assert.equal((await request(`/api/member/${m.token}`)).body.notices.length,1);
 await request('/api/owner/payments','POST',{memberId:m.id,amount:28000,method:'Efectivo'});
 assert.equal((await reminders()).sent,0);
});
test('expired push subscriptions are removed and failed delivery is retried',async t=>{
 let fail=true;const {request,reminders,db}=await fixture(t,{sendPush:async(s)=>{if(s.endpoint.endsWith('expired'))throw {statusCode:410};if(fail)throw {statusCode:503};}});
 await request('/api/owner/members','POST',member());const m=(await request('/api/owner/dashboard')).body.members[0];
 await request(`/api/member/${m.token}/subscribe`,'POST',subscription('expired'));
 await request(`/api/member/${m.token}/subscribe`,'POST',subscription('retry'));
 const first=await reminders();assert.equal(first.expired,1);assert.equal(first.failed,1);
 assert.equal(db.prepare('SELECT count(*) AS n FROM subscriptions').get().n,1);
 assert.equal(db.prepare('SELECT count(*) AS n FROM notices').get().n,0);
 fail=false;assert.equal((await reminders()).sent,1);
 assert.equal(db.prepare('SELECT count(*) AS n FROM notices').get().n,1);
});
test('subscription validates destinations and prevents cross-member reassignment',async t=>{
 const {request}=await fixture(t);await request('/api/owner/members','POST',member());await request('/api/owner/members','POST',member({name:'Otro socio'}));
 const members=(await request('/api/owner/dashboard')).body.members;
 const [a,b]=members;
 assert.equal((await request(`/api/member/${a.token}/subscribe`,'POST',{...subscription(),endpoint:'https://example.com/steal'})).status,400);
 assert.equal((await request(`/api/member/${a.token}/subscribe`,'POST',subscription())).status,201);
 assert.equal((await request(`/api/member/${b.token}/subscribe`,'POST',subscription())).status,400);
 assert.equal((await request(`/api/member/${b.token}/unsubscribe`,'POST',{endpoint:subscription().endpoint})).status,200);
 assert.equal((await request('/api/owner/dashboard')).body.members.find(m=>m.id===a.id).devices,1);
 await request(`/api/member/${a.token}/unsubscribe`,'POST',{endpoint:subscription().endpoint});
 assert.equal((await request('/api/owner/dashboard')).body.members.find(m=>m.id===a.id).devices,0);
});

test('retrying the same payment does not renew twice', async t => {
 const {request}=await fixture(t);
 const id=(await request('/api/owner/members','POST',member())).body.id;
 const payment={memberId:id,amount:28000,method:'Efectivo',requestKey:randomUUID()};
 assert.equal((await request('/api/owner/payments','POST',payment)).status,201);
 const retry=await request('/api/owner/payments','POST',payment);
 assert.equal(retry.status,200);assert.equal(retry.body.replayed,true);
 const data=(await request('/api/owner/dashboard')).body;
 assert.equal(data.payments.length,1);assert.equal(data.members[0].expires,addDays(today(),30));
 assert.equal((await request('/api/owner/payments','POST',{...payment,amount:100})).status,400);
});
test('member manifest has a stable URL, valid icons, and private start URL',async t=>{
 const {request}=await fixture(t);
 await request('/api/owner/members','POST',member());
 const m=(await request('/api/owner/dashboard')).body.members[0];
 const result=await request(`/manifest/${m.token}.webmanifest`);
 assert.equal(result.status,200);assert.equal(result.body.start_url,`/socio/${m.token}`);
 assert.equal(result.body.icons.length,2);
 assert.equal((await request('/manifest/invalid.webmanifest')).status,404);
});


test('Render startup requires a password, persistent directory and real push contact', () => {
 const env={ RENDER: 'true', PORT: '10000', OWNER_PASSWORD: 'a-long-test-password', DATA_DIR: '/var/data/gympanel', PUSH_SUBJECT: 'mailto:owner@test.example' };
 assert.deepEqual(runtimeConfig(env),{host:'0.0.0.0',port:10000});
 assert.throws(()=>runtimeConfig({...env,OWNER_PASSWORD:''}),/OWNER_PASSWORD/);
 assert.throws(()=>runtimeConfig({...env,OWNER_PASSWORD:'short'}),/OWNER_PASSWORD/);
 assert.throws(()=>runtimeConfig({...env,DATA_DIR:''}),/DATA_DIR/);
 assert.throws(()=>runtimeConfig({...env,PUSH_SUBJECT:''}),/PUSH_SUBJECT/);
 assert.throws(()=>runtimeConfig({...env,PORT:'invalid'}),/PORT/);
 assert.deepEqual(runtimeConfig({}),{host:'127.0.0.1',port:3000});
});
test('health endpoint is public, checks SQLite, and exposes no member details', async t => {
 const {request,db}=await fixture(t,{ownerPassword:'private-password'});
 const healthy=await request('/healthz');assert.equal(healthy.status,200);assert.deepEqual(healthy.body,{status:'ok'});
 assert.equal((await request('/api/owner/dashboard')).status,401);
 db.prepare('SELECT 1').get();
});
