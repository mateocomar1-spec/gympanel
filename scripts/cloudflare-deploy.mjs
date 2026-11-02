import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
if (config.d1_databases[0].database_id === '00000000-0000-0000-0000-000000000000') throw new Error('Primero creá la base D1 y completá database_id. Seguí docs/cloudflare.md.');
if (!existsSync(new URL('../.dev.vars', import.meta.url))) throw new Error('Primero ejecutá npm run cloudflare:setup.');
const secrets = Object.fromEntries(readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8').trim().split(/\r?\n/).map(line => { const pos = line.indexOf('='); return [line.slice(0, pos), JSON.parse(line.slice(pos + 1))]; }));
if (!secrets.OWNER_PASSWORD || secrets.OWNER_PASSWORD.length < 16 || !secrets.VAPID_PRIVATE_KEY || !secrets.VAPID_PUBLIC_KEY || !secrets.PUSH_SUBJECT) throw new Error('La configuración privada está incompleta.');
function wrangler(args, input) {
  const result = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', ...args], { cwd: root, env: process.env, input, stdio: input ? ['pipe', 'inherit', 'inherit'] : 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
wrangler(['d1', 'migrations', 'apply', 'DB', '--remote']);
// Create/update the Worker with no secrets first: it fails closed with HTTP 503.
wrangler(['deploy']);
// Pass secrets via stdin, never shell arguments or logs. This publishes the secrets.
wrangler(['secret', 'bulk'], JSON.stringify(secrets));
console.log('Publicación completa. Abrí la URL HTTPS mostrada por Wrangler. Usuario: admin. Contraseña: OWNER_PASSWORD de .dev.vars.');
