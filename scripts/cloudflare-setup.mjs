import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import webpush from 'web-push';

const target = fileURLToPath(new URL('../.dev.vars', import.meta.url));
if (existsSync(target)) {
  console.log('Ya existe .dev.vars. Se conservan la contraseña y las claves push. No se modificó ningún secreto.');
} else {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  let email;
  try { email = (await terminal.question('Email del responsable de los avisos: ')).trim(); }
  finally { terminal.close(); }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Ingresá un email válido.');
  const keys = webpush.generateVAPIDKeys();
  const values = { OWNER_PASSWORD: randomBytes(24).toString('base64url'), PUSH_SUBJECT: 'mailto:' + email, VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey };
  writeFileSync(target, Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
  console.log('Configuración privada guardada en .dev.vars (excluida de Git).');
  console.log('Para ingresar al panel: usuario admin. Consultá OWNER_PASSWORD dentro de ese archivo.');
}
console.log('No se publicó nada ni se contrató ningún servicio. Seguí docs/cloudflare.md para publicar gratis.');
