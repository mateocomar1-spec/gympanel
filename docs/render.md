# Publicar Gympanel en Render

La configuración está en `render.yaml`. Crea **un Web Service Node.js de pago** y **un disco persistente de 1 GB**, en Virginia. El panel conserva su base SQLite y las claves push en `/var/data/gympanel`. No requiere una base PostgreSQL ni un worker adicional. El proceso web también revisa los recordatorios.

## Costo antes de confirmar

La documentación de Render consultada el 30/10/2026 lista el plan `0.5c-512mb` a **USD 7/mes** y el disco a **USD 0,25 por GB/mes**: referencia inicial **USD 7,25/mes**, más consumos adicionales, impuestos o cambios de tarifa. Confirmar el presupuesto que muestre Render antes de crear el servicio. El plan gratuito no permite el disco persistente necesario para esta versión.

## Pasos desde tu cuenta

1. Entrar a <https://dashboard.render.com/> y crear una cuenta o iniciar sesión.
2. Elegir **New → Blueprint** y conectar GitHub. Dar acceso al repositorio `mateocomar1-spec/gympanel`.
3. Seleccionar el repositorio y la rama `main`. Render debe encontrar `render.yaml` en la raíz.
4. Completar las dos variables solicitadas **dentro de Render**, no en el chat ni en GitHub:
   - `OWNER_PASSWORD`: una contraseña única de al menos 16 caracteres. Guardarla en un gestor de contraseñas. El usuario del panel será `admin`.
   - `PUSH_SUBJECT`: el email real del responsable, con el formato `mailto:tu-email@tu-dominio.com`.
5. Revisar que se esté creando un **Web Service**, no un Static Site; el plan de pago, una sola instancia y disco de 1 GB montado en `/var/data`. Revisar el costo y confirmar la creación solo cuando estés de acuerdo.
6. Esperar a que el despliegue quede **Live**. Abrir la URL HTTPS que Render asigna al servicio, disponible en su página. Esa será la dirección pública real del panel; todavía no existe mientras no se cree el servicio.
7. Ingresar con usuario `admin` y la contraseña configurada. Aparecerán ocho socios ficticios para revisar la primera versión.

No hace falta contratar un dominio propio para esta prueba. Render proporciona un dominio HTTPS. Configurar el dominio definitivo **antes** de invitar socios: las suscripciones push pertenecen al origen y hay que reactivarlas si cambia el dominio.

## Primera prueba online

- Abrir el panel desde la computadora y el celular. Sin contraseña no debe mostrar los datos del dueño.
- Crear un socio de prueba, registrar una cuota y comprobar que su vencimiento se renueva una sola vez.
- Abrir su credencial desde el enlace en Socios. En iPhone, agregar a Inicio y abrir desde ese ícono; en Android, usar un navegador compatible.
- Activar avisos y tocar **Enviar aviso de prueba**. Confirmar que el aviso se recibe en el dispositivo, no solo que el proveedor lo aceptó.
- Desde Render, reiniciar el servicio y comprobar que el socio, el pago y la suscripción siguen presentes. El reinicio corta brevemente el acceso.

La ruta pública `/healthz` devuelve `{"status":"ok"}` cuando el servidor puede consultar SQLite. Se usa para la comprobación automática de Render y no devuelve datos privados. La compilación ejecuta instalación, revisión sintáctica y pruebas con bases temporales: no necesita el disco persistente, que solo se monta al ejecutar el servicio.

## Actualizaciones y datos reales

Los despliegues automáticos están **desactivados**. Después de subir un cambio a GitHub, usar **Manual Deploy → Deploy latest commit** desde el servicio, cuando quieras publicarlo. El disco se conserva al desplegar; no lo eliminar ni cambiar su ruta.

Esta primera publicación usa `SEED_DEMO=true`. Para comenzar con datos reales, preparar una base nueva separada y configurar `SEED_DEMO=false`; cambiar la variable no borra los socios ficticios que ya estén guardados. No mezclar pruebas con datos reales.

Con SQLite se mantiene **una sola instancia** y un solo proceso. El disco de Render no se puede compartir entre servicios; no habilitar escalado horizontal. Los despliegues con disco tienen una breve interrupción. Preparar copias consistentes de SQLite y de `vapid.json` antes de usarlo con socios reales, conservándolas de forma privada.

## Si el despliegue falla

- Error `OWNER_PASSWORD`: completar una contraseña de al menos 16 caracteres en Environment y desplegar de nuevo.
- Error `PUSH_SUBJECT`: usar un contacto real con prefijo `mailto:`.
- Error de versión Node/SQLite: comprobar que no haya una variable `NODE_VERSION` sobrescribiendo `.node-version` (Node 24.19.0).
- No detecta puerto: comprobar `HOST=0.0.0.0`; Render define `PORT` automáticamente.
- Datos que desaparecen: detener la carga de datos y revisar que el disco esté montado en `/var/data` y `DATA_DIR=/var/data/gympanel`.
- No llega un aviso: comprobar HTTPS, permisos, versión del celular, suscripción vigente y conexión. La prueba de recepción real es independiente de que el despliegue esté Live.

Referencias oficiales: [Blueprint](https://render.com/docs/blueprint-spec), [discos](https://render.com/docs/disks), [Node.js](https://render.com/docs/node-version) y [precios](https://render.com/pricing).
