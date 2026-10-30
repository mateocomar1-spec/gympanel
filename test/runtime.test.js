import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

// Exercises the actual production entrypoint, shutdown and persistent state.
test('Render process starts protected, preserves members and VAPID across restarts', { timeout: 20000 }, async t => {
 const dataDir = mkdtempSync(join(tmpdir(), 'gympanel-runtime-'));
 const password = randomBytes(24).toString('hex');
 const probe = createServer();
 probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
 const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
 const url = `http://127.0.0.1:${port}`;
 let child;
 const env = { ...process.env, RENDER: 'true', HOST: '0.0.0.0', PORT: String(port), DATA_DIR: dataDir, NODE_ENV: 'production', SEED_DEMO: 'false', OWNER_PASSWORD: password, PUSH_SUBJECT: 'mailto:owner@test.example' };
 async function stop() {
   if (!child || child.exitCode !== null || child.signalCode !== null) return;
   const exited = once(child, 'exit'); child.kill('SIGTERM');
   const [code] = await exited; assert.equal(code, 0, 'graceful shutdown');
 }
 t.after(async () => { await stop(); rmSync(dataDir, { recursive: true, force: true }); });
 async function start() {
   let output = '';
   child = spawn(process.execPath, ['server.js'], { cwd: new URL('../', import.meta.url), env, stdio: ['ignore','pipe','pipe'] });
   child.stdout.on('data', chunk => output += chunk);
   child.stderr.on('data', chunk => output += chunk);
   for (let i=0;i<100;i++) {
     if (child.exitCode !== null) throw new Error(`Server exited before readiness: ${output}`);
     try { const response=await fetch(url+'/healthz'); if(response.ok) return; } catch {}
     await delay(50);
   }
   throw new Error('Readiness timed out');
 }
 const headers = { Authorization: 'Basic '+Buffer.from('admin:'+password).toString('base64'), 'Content-Type': 'application/json' };
 await start();
 assert.equal((await fetch(url+'/')).status,401);
 const health=await (await fetch(url+'/healthz')).json();assert.deepEqual(health,{status:'ok'});
 const created=await fetch(url+'/api/owner/members',{method:'POST',headers,body:JSON.stringify({name:'Socio persistente',plan:'full',expires:'2026-12-01'})});
 assert.equal(created.status,201);
 const keys = readFileSync(join(dataDir,'vapid.json'),'utf8');
 await stop(); await start();
 const result=await fetch(url+'/api/owner/dashboard',{headers});assert.equal(result.status,200);
 const dashboard=await result.json();assert.equal(dashboard.members.length,1);assert.equal(dashboard.members[0].name,'Socio persistente');
 assert.equal(readFileSync(join(dataDir,'vapid.json'),'utf8'),keys);
});
