# VuelaLatino

Aplicación web para vender boletos de avión **solo en línea**: búsqueda de vuelos, comparación de tarifas, reserva con datos de pasajeros y emisión automática de boletos cuando el cliente completa el pago.

Todos los pagos son **en línea con tarjeta (Stripe)**, completos o en abonos; no hay cobro en mostrador. **Sin las claves de Stripe configuradas no se pueden crear reservas** (el sitio muestra los vuelos y avisa que las ventas abrirán pronto). La app no se conecta a los sistemas de reservas de las aerolíneas: los vuelos, horarios y precios los administra la agencia en su panel.

## Pantallas

| Ruta | Para quién | Qué hace |
|---|---|---|
| `/` | Clientes y agentes | Busca vuelos (ida o ida y vuelta), compara tarifas Básica / Clásica / Flexible, captura pasajeros y crea la reserva |
| `/reserva` | Clientes | Consulta la reserva con código + apellido, ve el itinerario y los boletos |
| `/` (calendario) | Clientes | En los resultados, "Ver calendario de precios del mes" muestra el precio más bajo de cada día y marca los más baratos |
| `/personal` | Agencia | Reservas (consultar, ver pagos, corregir datos, asientos, cancelar), **Pagos** (pagos en línea por fecha, saldos por cobrar, CSV), **Calendario** (salidas, vencimientos y cobros por día), vuelos y horarios, aerolíneas, aeropuertos, precios y plazos, usuarios |

## Reglas principales

- **Precio por pasajero:** precio base del vuelo × tarifa (Básica ×1, Clásica ×1.30, Flexible ×1.75), +10 % si faltan menos de 21 días y +25 % si faltan menos de 7.
- **Impuestos y cargos:** porcentaje de impuestos + cargo por servicio por pasajero (configurables).
- **Plazo de pago:** la reserva aparta asientos durante el plazo configurado (24 h por defecto); si no se paga, vence y libera los asientos.
- **Selección de asientos:** mapa por vuelo (6 por fila); filas 1–3 Preferente, dos filas de salida de emergencia y el resto Estándar. Básica paga cualquier asiento, Clásica tiene el estándar gratis y Flexible todos gratis (precios configurables). Se elige al reservar o después en Mi reserva; con boleto emitido solo se cambia a asientos sin costo adicional o de igual precio.
- **Corrección de datos:** antes de pagar, el cliente corrige pasajeros y contacto desde Mi reserva. Con boleto emitido, el contacto se actualiza al momento y los cambios de pasajeros llegan como solicitud a la pestaña Correcciones de la agencia. En el nombre solo se permiten hasta 3 letras de diferencia después de emitir. La agencia también corrige directamente; todo queda en el historial.
- **Pagos en abonos:** la reserva se aparta con un anticipo mínimo (30 % por defecto) y el saldo se liquida en uno o varios abonos hasta 15 días antes del primer vuelo (ambos configurables en Precios y plazos). Con el anticipo, el plazo de la reserva se extiende hasta esa fecha; al cubrir el total se emiten los boletos. Si el vuelo sale antes, se paga completa. Los abonos se pagan en línea desde Mi reserva. Si una reserva con anticipo vence o se cancela, queda anotado cuánto se recibió para reembolsar o aplicar.
- **Vuelos internacionales:** exigen pasaporte para cada pasajero.
- **Hora de llegada:** se calcula con la duración y la diferencia UTC de cada aeropuerto (ajustable en el panel por horario de verano).
- **Estados:** Pendiente de pago → Boleto emitido; o Cancelada / Vencida. Si un pago en línea llega para una reserva vencida sin asientos, cancelada o con monto distinto, queda en *Pagada: requiere revisión* para reembolsar desde Stripe.

Las aerolíneas "Aerolínea Ejemplo" y "Vuelos Demo" y sus horarios son datos de prueba.

## Variables de entorno

| Variable | Uso |
|---|---|
| `DATABASE_URL` | PostgreSQL. Si falta, usa una base en memoria (solo pruebas). |
| `ADMIN_USER` / `ADMIN_PASSWORD` | Crea el primer administrador cuando la base está vacía. |
| `SESSION_SECRET` | Firma de la cookie de sesión. **Obligatoria en producción** (mínimo 32 caracteres); sin ella el servidor no arranca. |
| `PGSSL` | `1` para conectar a Postgres con SSL (URL externa). |
| `STRIPE_SECRET_KEY` | Clave secreta de Stripe (`sk_test_…` para pruebas, `sk_live_…` para cobrar). Sin ella no se pueden crear reservas. |
| `STRIPE_WEBHOOK_SECRET` | Secreto del webhook (`whsec_…`) para confirmar pagos aunque el cliente cierre la ventana. |
| `PUBLIC_URL` | URL pública de la app (ej. `https://vuelalatino.onrender.com`) para el regreso desde Stripe. |

## Instalar y correr en local

Requisitos: Node.js 20 o superior.

```bash
npm install
cp .env.example .env   # y llena ADMIN_PASSWORD y SESSION_SECRET
npm start              # http://localhost:3000
```

Sin `DATABASE_URL` usa una base de datos en memoria (se borra al reiniciar). Las variables están descritas en `.env.example`; el archivo `.env` nunca se sube a git.

## Pago en línea (Stripe)

1. Crea una cuenta en stripe.com y copia la clave secreta de **modo de prueba** (Developers → API keys).
2. En Stripe → Developers → Webhooks agrega el endpoint `https://TU-APP/api/stripe/webhook` con los eventos `checkout.session.completed` y `checkout.session.async_payment_succeeded`, y copia su secreto.
3. Pon `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` y `PUBLIC_URL` en las variables de entorno del servicio.
4. Prueba con la tarjeta 4242 4242 4242 4242 (cualquier fecha futura y CVC). Cuando todo funcione, cambia a las claves `live`.

Los reembolsos se hacen desde el panel de Stripe.

## Seguridad

- **Secretos:** claves y contraseñas solo en variables de entorno (`.env` en local, panel de Render en producción). `.env` y `.env.*` están en `.gitignore`.
- **Validación en el servidor:** toda entrada se valida en la API (tipos, formatos, longitudes máximas, fechas, montos). Cuerpo JSON máximo de 100 KB; las listas tienen tope de registros (`LIMIT`). La app no recibe archivos.
- **XSS:** todo texto del usuario se escapa antes de mostrarse (`esc()`); no hay scripts ni manejadores en línea (el código está en `public/js/`) y se envía una **Content Security Policy** con `script-src 'self'`.
- **SQL:** solo consultas parametrizadas (`$1, $2…`).
- **Permisos:** las rutas `/api/staff/*` exigen sesión del personal y `/api/admin/*` rol de administrador. El cliente solo ve su reserva con código + apellido, con documentos ocultos.
- **Límites de solicitudes por IP:** 300/min en la API; 10 intentos de login por 15 min; 60 consultas de reserva/pago por 15 min; 20 reservas por hora.
- **Encabezados:** HSTS y redirección a HTTPS en producción, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`.
- **CORS:** no se habilita; la API solo responde a este mismo sitio y rechaza solicitudes que cambian datos desde otro origen.
- **Dependencias:** revisar con `npm audit` (0 vulnerabilidades al 25/11/2026).

## Errores, registros y respaldos

- Páginas propias de **404** y **500**; la API responde mensajes en español sin detalles técnicos. Los errores internos se registran en la consola del servidor (logs de Render) con una referencia que también ve el usuario.
- **Respaldo:** en el panel, *Precios y plazos → Descargar respaldo* (solo administradores) baja un JSON con todas las tablas, sin contraseñas. Hazlo con regularidad: la base gratuita de Render **no tiene respaldos automáticos** (los planes de pago sí).
- **Legal:** `/privacidad` (aviso de privacidad) y `/terminos` (términos de uso) son un modelo general; revísalos con un abogado y completa los datos de la empresa. El sitio solo usa una cookie técnica de sesión para el personal, por lo que no requiere aviso de cookies.

## Deploy

Render: Web Service (Node, `npm install` / `npm start`) conectado a este repositorio, más una base PostgreSQL de Render.
