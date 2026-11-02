# Gympanel

Primera versión para un gimnasio: socios, membresías, registro manual de cobros y avisos Web Push. Interfaz en español argentino, importes en ARS y calendario de Buenos Aires. Incluye datos ficticios para probar el circuito.

## Prueba online gratuita en Cloudflare

La versión para **Cloudflare Workers Free + D1 Free** conserva la interfaz y guarda socios, cobros y avisos en D1. Los recordatorios se revisan cada hora con Cron, sin mantener un servidor encendido. No requiere Render ni disco de pago. Seguí la [guía de publicación gratuita](docs/cloudflare.md) para configurar la cuenta, la base y los secretos. La publicación necesita tu sesión de Cloudflare; el repositorio por sí solo no crea una URL pública.

`npm run test:cloudflare` verifica el Worker en el entorno local de Cloudflare, incluyendo pagos concurrentes, persistencia D1 y cifrado push. `npm run cloudflare:deploy` publica con los secretos privados de `.dev.vars`. La demo admite tres dispositivos por socio y procesa hasta diez socios por revisión. El servidor Node descrito abajo sigue disponible para uso local o Render.

## Desarrollo

Requiere **Node.js 24.x** (versión verificada: 24.19.0). Usa Express, SQLite integrado en Node y `web-push`. No requiere Docker ni una base externa.

```sh
cd /workspace/gympanel
npm ci
npm start
```

El servidor escucha en la interfaz local, puerto 3000. `npm run dev` reinicia el proceso al cambiar archivos del servidor. `npm test` ejecuta pruebas de integración con bases temporales; `npm run check` revisa la sintaxis. Las pruebas no envían notificaciones reales.

El panel permite:

- Crear y editar socios, asignar un plan y su vencimiento; buscar y filtrar por estado.
- Registrar una cuota completa mediante transferencia, efectivo o tarjeta. Es un registro manual: no procesa dinero ni verifica transferencias.
- Renovar 30 días desde el vencimiento si sigue vigente, o desde hoy si venció. Cada confirmación tiene una clave de idempotencia para evitar duplicados al reintentar.
- Consultar ingresos del mes, evolución de seis meses e historial de pagos.
- Compartir una credencial privada del socio, con sus pagos y vencimiento.
- Activar/desactivar push por dispositivo y solicitar un aviso de prueba desde la credencial.

Los tres planes y sus precios son iniciales, definidos en `server.js`; esta versión todavía no incluye un editor de planes. “Base Training” es el nombre ficticio usado en la demostración.

## Configuración

Podés copiar `.env.example` a `.env`. `npm start` y `npm run dev` cargan ese archivo sin sobrescribir las variables del proceso. Nunca subas `.env` a Git.

| Variable | Valor predeterminado | Uso |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Interfaz del servidor. Para exponerla, exige `OWNER_PASSWORD` de al menos 16 caracteres. |
| `PORT` | `3000` | Puerto HTTP detrás del proxy HTTPS. |
| `DATA_DIR` | `./data` junto al servidor | Directorio persistente para base y claves. |
| `SEED_DEMO` | `true` | Crea ocho socios ficticios únicamente si no hay socios. Usá `false` para una base real vacía. No borra datos existentes. |
| `OWNER_PASSWORD` | sin definir | Usuario `admin` mediante HTTP Basic. Fuera de localhost o en producción exige al menos 16 caracteres. |
| `PUSH_SUBJECT` | `mailto:admin@example.com` | Reemplazar por un email real del responsable antes de usar push con socios. |

Para datos reales, usá un `DATA_DIR` nuevo con `SEED_DEMO=false`, HTTPS y una contraseña fuerte del dueño. El servidor rechaza un `HOST` público sin contraseña. No expongas la demo local mediante un túnel sin configurar primero la contraseña: un proxy puede publicar localhost.

Los enlaces de credencial contienen tokens aleatorios que dan acceso a los datos de ese socio. Compartilos solo con su titular. El panel y la API del dueño requieren la contraseña si está configurada. La app está pensada para un único gimnasio y un único administrador; todavía no tiene roles, recuperación de cuenta ni rotación de enlaces.

## Push e instalación en el celular

1. Publicar el servidor detrás de **HTTPS**, con proceso siempre activo y almacenamiento persistente. Esto no viene desplegado por este repositorio.
2. Configurar `OWNER_PASSWORD` y `PUSH_SUBJECT`. Conservar `data/vapid.json`: sus claves se generan automáticamente y son privadas. Rotarlas invalida las suscripciones existentes.
3. Permitir salida HTTPS a `fcm.googleapis.com` (Chrome), `updates.push.services.mozilla.com` (Firefox) y `web.push.apple.com` (Safari). La suscripción del navegador también requiere acceso al proveedor desde el teléfono.
4. Desde Socios, abrir la credencial y copiar el enlace usando la dirección pública HTTPS. No compartir una dirección local.
5. En Android, abrir con un navegador compatible e instalar cuando esté disponible. En iPhone, usar iOS 16.4+ y **Compartir → Agregar a Inicio**, luego abrir desde el ícono.
6. Tocar **Activar notificaciones**, aceptar el permiso y usar **Enviar aviso de prueba**. Se guarda la suscripción real, no una simulación.

El service worker recibe los avisos incluso con la página cerrada, sujeto a las restricciones del sistema, permisos y conexión. La credencial requiere Internet: no se cachean datos personales para uso sin conexión. Desactivar notificaciones en un dispositivo no afecta los demás.

### Recordatorios

El servidor revisa cada minuto y al iniciar: 3 días antes, 1 día antes, el día del vencimiento y 1 día después. “Revisar recordatorios” ejecuta la misma revisión manualmente. Si el servidor permanece apagado todo un día, el recordatorio correspondiente a ese día no se recupera después.

Se registra un recordatorio automático cuando el proveedor acepta el envío a todos los dispositivos vigentes, y se evita repetirlo para ese socio, fecha y etapa. Se eliminan suscripciones expiradas (404/410). Los fallos transitorios se reintentan en la siguiente revisión. Si un dispositivo tuvo éxito y otro falló, el primero puede recibir un duplicado en el reintento. La aceptación del proveedor **no prueba que la persona haya visto el aviso**; los avisos usan una etiqueta común para reemplazar el aviso previo.

No hay costo por mensaje de WhatsApp ni dependencia de ese servicio. El alojamiento y la operación del servidor sí pueden tener costo.

## Datos y verificación

SQLite se guarda en `data/gympanel.sqlite`; las claves VAPID, en `data/vapid.json`. Ambos quedan fuera de Git. Montar `DATA_DIR` en un volumen persistente y respaldarlo mediante una copia consistente de SQLite (no copiar solo el archivo principal mientras haya escrituras WAL).

Las pruebas verifican validación de socios, persistencia, autenticación, vencimientos, cobros, reintentos idempotentes, aislamiento de suscripciones, eliminación de endpoints expirados y deduplicación de recordatorios. La entrega push se prueba con un transporte controlado. La recepción real en Android/iPhone requiere el circuito HTTPS anterior y debe validarse en esos dispositivos antes de un lanzamiento.

## Despliegue en Render

El proyecto incluye `render.yaml` para importar como **Blueprint**, con servidor Node.js 24, disco persistente, contraseña obligatoria, comprobación de salud en `/healthz` y despliegues posteriores manuales. La primera publicación incluye socios ficticios para evaluación.

Seguí la [guía paso a paso de Render](docs/render.md), incluyendo la revisión del costo antes de crear el servicio. Este archivo prepara el despliegue: no crea una cuenta ni publica la aplicación por sí mismo.
