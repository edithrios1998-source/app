# VuelaLatino

Aplicación web para vender boletos de avión desde una agencia: búsqueda de vuelos, comparación de tarifas, reserva con datos de pasajeros y emisión de boletos cuando el cliente paga en la agencia.

El cliente puede **pagar en línea con tarjeta (Stripe)** y sus boletos se emiten al instante, o pagar en la agencia. La app no se conecta a los sistemas de reservas de las aerolíneas: los vuelos, horarios y precios los administra la agencia en su panel.

## Pantallas

| Ruta | Para quién | Qué hace |
|---|---|---|
| `/` | Clientes y agentes | Busca vuelos (ida o ida y vuelta), compara tarifas Básica / Clásica / Flexible, captura pasajeros y crea la reserva |
| `/reserva` | Clientes | Consulta la reserva con código + apellido, ve el itinerario y los boletos |
| `/personal` | Agencia | Reservas (cobrar y emitir, cancelar), vuelos y horarios, aerolíneas, aeropuertos, precios y plazos, usuarios |

## Reglas principales

- **Precio por pasajero:** precio base del vuelo × tarifa (Básica ×1, Clásica ×1.30, Flexible ×1.75), +10 % si faltan menos de 21 días y +25 % si faltan menos de 7.
- **Impuestos y cargos:** porcentaje de impuestos + cargo por servicio por pasajero (configurables).
- **Plazo de pago:** la reserva aparta asientos durante el plazo configurado (24 h por defecto); si no se paga, vence y libera los asientos.
- **Vuelos internacionales:** exigen pasaporte para cada pasajero.
- **Hora de llegada:** se calcula con la duración y la diferencia UTC de cada aeropuerto (ajustable en el panel por horario de verano).
- **Estados:** Pendiente de pago → Boleto emitido; o Cancelada / Vencida. Si un pago en línea llega para una reserva vencida sin asientos, cancelada o con monto distinto, queda en *Pagada: requiere revisión* para reembolsar desde Stripe.

Las aerolíneas "Aerolínea Ejemplo" y "Vuelos Demo" y sus horarios son datos de prueba.

## Variables de entorno

| Variable | Uso |
|---|---|
| `DATABASE_URL` | PostgreSQL. Si falta, usa una base en memoria (solo pruebas). |
| `ADMIN_USER` / `ADMIN_PASSWORD` | Crea el primer administrador cuando la base está vacía. |
| `SESSION_SECRET` | Firma de la cookie de sesión. |
| `PGSSL` | `1` para conectar a Postgres con SSL (URL externa). |
| `STRIPE_SECRET_KEY` | Clave secreta de Stripe (`sk_test_…` para pruebas, `sk_live_…` para cobrar). Sin ella, el pago en línea se oculta. |
| `STRIPE_WEBHOOK_SECRET` | Secreto del webhook (`whsec_…`) para confirmar pagos aunque el cliente cierre la ventana. |
| `PUBLIC_URL` | URL pública de la app (ej. `https://vuelalatino.onrender.com`) para el regreso desde Stripe. |

## Correr en local

```bash
npm install
npm start   # http://localhost:3000
```

## Pago en línea (Stripe)

1. Crea una cuenta en stripe.com y copia la clave secreta de **modo de prueba** (Developers → API keys).
2. En Stripe → Developers → Webhooks agrega el endpoint `https://TU-APP/api/stripe/webhook` con los eventos `checkout.session.completed` y `checkout.session.async_payment_succeeded`, y copia su secreto.
3. Pon `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` y `PUBLIC_URL` en las variables de entorno del servicio.
4. Prueba con la tarjeta 4242 4242 4242 4242 (cualquier fecha futura y CVC). Cuando todo funcione, cambia a las claves `live`.

Los reembolsos se hacen desde el panel de Stripe.

## Deploy

Render: Web Service (Node, `npm install` / `npm start`) conectado a este repositorio, más una base PostgreSQL de Render.
