# Publicar Gympanel gratis en Cloudflare

Esta versión usa **Workers Free + D1 Free**, sin Render, dominio propio, tarjeta ni almacenamiento de pago. Usá el subdominio HTTPS `workers.dev` incluido. No actives Workers Paid, R2 ni otros servicios de pago. La publicación remota requiere tu sesión de Cloudflare; preparar el repositorio no publica nada por sí solo.

## 1. Preparar la computadora

Instalá Node.js 24 y Git si no los tenés. Desde una terminal:

```sh
git clone --branch codex/cloudflare-free-demo https://github.com/mateocomar1-spec/gympanel.git
cd gympanel
npm ci
npx wrangler login
```

Si ya tenés la carpeta del proyecto actualizado, abrila y omití `git clone`. El navegador solicitará autorizar Wrangler en tu cuenta; no compartas tu contraseña ni un token por chat. Elegí la cuenta con Workers **Free**. La versión adaptada tiene que estar disponible en la copia que uses; si todavía no se subió a GitHub, usá el paquete de esta entrega.

## 2. Crear la base gratuita

```sh
npx wrangler d1 create gympanel --update-config=false
```

El comando muestra un `database_id`. Abrí `wrangler.jsonc` y reemplazá **solo** `00000000-0000-0000-0000-000000000000` por ese identificador. Conservá el binding `DB`, el nombre de base y `migrations_dir`. Si ya existe una base llamada `gympanel`, consultá `npx wrangler d1 list` y usá su ID; no borres una base existente.

Si hay varias cuentas en tu sesión, configurá `account_id` en `wrangler.jsonc` con la cuenta correcta antes de crear la base y publicar.

## 3. Preparar el acceso privado

```sh
npm run cloudflare:setup
```

Ingresá tu email cuando lo pida. Se genera una contraseña aleatoria fuerte y las claves push. Se guardan en `.dev.vars`, un archivo privado excluido de Git. Abrilo para consultar `OWNER_PASSWORD`; el usuario del panel es `admin`. Guardá una copia privada de este archivo: mantiene el acceso y las mismas claves push en actualizaciones posteriores. No lo subas a GitHub ni lo compartas.

Volver a ejecutar este comando conserva las claves y la contraseña existentes. La configuración no usa el viejo `data/vapid.json` de Node/Render; las suscripciones de esa versión, si existieran, necesitan activarse en el nuevo dominio.

## 4. Publicar

```sh
npm run check
npm test
npm run test:cloudflare
npm run cloudflare:deploy
```

El último comando aplica las migraciones D1, publica el Worker y carga los secretos mediante stdin. Si Wrangler pregunta por registrar un subdominio `workers.dev`, elegí uno disponible. No hace falta comprar un dominio. Si propone contratar un plan de pago, detené el proceso: esta configuración está destinada al plan gratuito.

La URL pública real aparece en la salida de Wrangler. **No hay una URL hasta que termine el despliegue.** Entre publicar el código y cargar los secretos el panel puede responder 503; falla cerrado, sin mostrar datos. Si falla la carga de secretos, repetí `npm run cloudflare:deploy` con el mismo `.dev.vars`.

## 5. Primera prueba

1. Abrí la URL HTTPS. Debe pedir usuario `admin` y la contraseña de `.dev.vars`.
2. Se generan ocho socios ficticios al abrir el panel por primera vez. No se vuelven a generar en cada despliegue.
3. Creá un socio de prueba, registrá un cobro y comprobá el vencimiento.
4. Copiá su credencial y abrila en el celular. En iPhone, agregala a Inicio y abrila desde el ícono; requiere iOS 16.4+. Activá los avisos y enviá uno de prueba.
5. Volvé a publicar y comprobá que se conservaron los socios y pagos en D1.

Las pruebas automáticas ejecutan el Worker en `workerd`, con D1 local y respuestas push controladas; además comprueban que el mensaje cifrado se puede descifrar. La recepción real en Android/iPhone sigue requiriendo la prueba anterior después de publicar.

## Recordatorios y límites de la demo

- Cron revisa cada hora, incluso con el panel cerrado. Puede tardar hasta 15 minutos en activarse o cambiar según Cloudflare.
- Se mantienen las etapas de 3 días antes, 1 día antes, el vencimiento y 1 día después, según Buenos Aires.
- Cada revisión procesa hasta 10 socios y cada socio admite hasta 3 dispositivos. Los siguientes socios quedan para próximas revisiones; los fallos no bloquean siempre a los mismos socios. Es una demo pequeña, no un envío masivo.
- Una concesión temporal en D1 evita ejecutar el mismo recordatorio simultáneamente desde Cron y el botón manual. Los fallos transitorios se reintentan; los endpoints 404/410 se eliminan. Si un dispositivo recibió el aviso y otro falló, el primero puede recibir un duplicado en el reintento. La aceptación del proveedor no confirma lectura.
- Las pruebas push desde cada credencial se limitan a una por minuto.
- Si el sistema está sin servicio un día completo, no recupera el aviso de ese día. Los límites de CPU y consultas del plan gratuito también pueden interrumpir solicitudes; no cambies a un plan de pago para continuar una prueba.
- Workers Free incluye 100.000 solicitudes diarias. D1 Free incluye 5 millones de filas leídas y 100.000 escritas al día, y 5 GB totales (con límites adicionales por base). Al alcanzar los límites gratuitos, las operaciones se rechazan hasta el restablecimiento o hasta liberar espacio. Revisá el consumo en tu cuenta.

## Actualizar la primera versión

La migración `0002_management.sql` agrega planes configurables, clases, saldos y auditoría. Reconstruye las tablas relacionadas para retirar la limitación de los tres planes iniciales, conservando IDs, pagos, suscripciones y enlaces privados. Antes de aplicar sobre una base con datos, exportala y conservá sus secretos privados. Las pruebas incluyen una actualización con datos anteriores y verificación de claves foráneas.

La vista ahora distingue vencimiento de saldo pendiente. No se crean deudas por vencimiento y no se alteran importes históricos al editar un plan. Los saldos se registran explícitamente desde la ficha y se cobran por separado de una renovación.

## Desarrollo local y actualizaciones

```sh
npm run cloudflare:migrate:local
npm run cloudflare:dev
```

Wrangler carga `.dev.vars`. La base local es independiente de D1 remota. El servidor original sigue disponible con `npm start` y usa su propia SQLite; esta adaptación no migra ni borra esos datos.

Para actualizar Cloudflare, conservá el mismo `database_id`, nombre del Worker y `.dev.vars`, y ejecutá `npm run cloudflare:deploy`. Los cambios de código no borran D1. No hay despliegue automático desde GitHub en esta entrega.

Antes de usar socios reales, prepará una base separada y configurá `SEED_DEMO` como `"false"`; cambiar esa variable no elimina los socios de prueba. Hacé una exportación privada con `npx wrangler d1 export DB --remote --output work/respaldo.sql` cuando necesites un respaldo. El respaldo puede contener información personal y tokens privados.

Referencias oficiales: [Workers Free](https://developers.cloudflare.com/workers/platform/pricing/), [límites de Workers](https://developers.cloudflare.com/workers/platform/limits/), [D1](https://developers.cloudflare.com/d1/platform/pricing/), [Wrangler](https://developers.cloudflare.com/workers/wrangler/commands/), [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/).
