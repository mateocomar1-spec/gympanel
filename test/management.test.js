import {test} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp,today,addDays} from '../server.js';
import {managementContract} from './management-contract.js';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';

test('Node management: custom plans, schedule, recorded balances, debt collections and idempotent push',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'gympanel-management-')),calls=[];
 const {app,db}=createApp({dataDir:dir,seed:false,ownerPassword:'',sendPush:async(...args)=>{calls.push(args);}});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 t.after(async()=>{await new Promise(r=>server.close(r));db.close();rmSync(dir,{recursive:true,force:true});});
 const request=async(path,method='GET',data)=>{const r=await fetch(`http://127.0.0.1:${server.address().port}`+path,{method,headers:{'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});return {status:r.status,body:await r.json()};};
 const member=async(overrides)=>{const r=await request('/api/owner/members','POST',{name:'Ana Pérez',phone:'',plan:'full',expires:today(),...overrides});return db.prepare('SELECT * FROM members WHERE id=?').get(r.body.id);};
 const subscribe=async m=>{await request('/api/member/'+m.token+'/subscribe','POST',{endpoint:'https://fcm.googleapis.com/fcm/send/management',keys:{p256dh:'A'.repeat(87),auth:'B'.repeat(22)}});};
 await managementContract({request,member,today,addDays,subscribe,calls});
});

test('Local upgrade preserves an old database and adds zero balances without changing paid amounts',t=>{
 const dir=mkdtempSync(join(tmpdir(),'gympanel-upgrade-'));
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const old=new DatabaseSync(join(dir,'gympanel.sqlite'));
 old.exec(`CREATE TABLE members(id INTEGER PRIMARY KEY,name TEXT NOT NULL,phone TEXT NOT NULL DEFAULT '',plan TEXT NOT NULL,expires TEXT NOT NULL,token TEXT NOT NULL UNIQUE,created TEXT NOT NULL);
 CREATE TABLE payments(id INTEGER PRIMARY KEY,member_id INTEGER NOT NULL REFERENCES members(id),amount INTEGER NOT NULL,method TEXT NOT NULL,date TEXT NOT NULL,old_expires TEXT NOT NULL,new_expires TEXT NOT NULL);
 INSERT INTO members VALUES(1,'Socio anterior','','full','2026-12-01','enlace-anterior','2026-11-01');
 INSERT INTO payments VALUES(1,1,28000,'Efectivo','2026-11-01','2026-11-01','2026-12-01');`);
 old.close();
 const upgraded=createApp({dataDir:dir,seed:false});
 const member=upgraded.db.prepare('SELECT * FROM members').get();
 assert.equal(member.token,'enlace-anterior');assert.equal(member.expires,'2026-12-01');assert.equal(member.balance,0);
 const payment=upgraded.db.prepare('SELECT * FROM payments').get();assert.equal(payment.amount,28000);assert.equal(payment.kind,'renewal');
 assert.equal(upgraded.db.prepare('SELECT count(*) AS n FROM plans').get().n,3);
 upgraded.db.close();
 const reopened=createApp({dataDir:dir,seed:false});assert.equal(reopened.db.prepare('SELECT count(*) AS n FROM members').get().n,1);reopened.db.close();
});
