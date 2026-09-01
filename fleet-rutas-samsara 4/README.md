# Dashboard de Rutas - Llegada / Inicio (manual o Samsara)

Dashboard con las rutas LINAMAR, MODINE, WIEGAND y CLS (la data viene de tu
hoja de asignaciones). Para cada unidad puedes capturar la **hora de llegada**
y la **hora de inicio**:

- **Manual**: escribes la hora y das clic en "Manual".
- **Samsara**: das clic en "Traer de Samsara" y el sistema busca el último
  dato GPS de esa unidad en Samsara y lo guarda como hora real, junto con
  la ubicación aproximada.

Los registros se guardan por fecha, así que puedes navegar días anteriores
con el selector de fecha.

## 0. Login

El dashboard ahora pide usuario y contraseña antes de mostrar cualquier cosa
(la página de login y las rutas de la API están protegidas por sesión).

Es un solo usuario compartido (pensado para tu equipo de despacho), no hay
registro de cuentas. Para configurarlo:

```bash
npm run generar-password -- "la_contraseña_que_quieras"
```

Esto imprime una línea `ADMIN_PASSWORD_HASH=...`. Cópiala tal cual a tu `.env`,
junto con el usuario que quieras usar:

```
ADMIN_USER=admin
ADMIN_PASSWORD_HASH=$2a$10$........................................
SESSION_SECRET=algo_largo_y_aleatorio   # ej: openssl rand -hex 32
SESSION_SECURE=false                     # ponlo en "true" solo cuando ya tengas HTTPS
```

Si quieres cambiar la contraseña más adelante, vuelve a correr
`npm run generar-password -- "nueva_contraseña"` y reemplaza el hash en `.env`
(luego reinicia la app).

Las sesiones se guardan en la misma base de Postgres (tabla `session`, se crea
sola), así que sobreviven si reinicias el proceso o el servidor.

## 1. Instalación local

```bash
npm install
cp .env.example .env
# edita .env con tu DATABASE_URL, SAMSARA_API_TOKEN y las variables de login (ver arriba)
npm run seed     # crea las tablas y siembra las rutas de la imagen (solo la primera vez)
npm start
```

Abre `http://localhost:3000` — te va a redirigir a `/login`.

## 2. Desplegar en Railway (mismo patrón que tus otros proyectos)

1. Sube esta carpeta a un repo de GitHub (o usa `railway up` desde la CLI).
2. En Railway, crea un nuevo proyecto y agrega un servicio Postgres si aún
   no tienes uno para este proyecto.
3. Agrega un servicio para este código (Deploy from GitHub repo).
4. En las variables de entorno del servicio agrega:
   - `DATABASE_URL` → puedes referenciarla desde el plugin de Postgres
     (`${{Postgres.DATABASE_URL}}`) o pegarla directamente.
   - `SAMSARA_API_TOKEN` → tu token de Samsara.
   - `TZ_ZONA` → `America/Monterrey` (opcional, ya es el default).
   - `ADMIN_USER`, `ADMIN_PASSWORD_HASH`, `SESSION_SECRET`, `SESSION_SECURE`
     → ver la sección "0. Login" de arriba.
5. Railway detecta `npm start` automáticamente desde `package.json`.
6. Antes de usar el dashboard por primera vez, corre el seed una sola vez.
   Puedes hacerlo desde la pestaña "Shell" del servicio en Railway:
   ```bash
   npm run seed
   ```
7. Abre la URL pública que te da Railway.

## 3. Notas sobre Samsara

- El nombre de la unidad en tu hoja (ej. `C51`, `TP49`) debe coincidir
  **exactamente** con el nombre del vehículo en Samsara para que el
  botón "Traer de Samsara" lo encuentre. Si cambian nombres o agregan
  unidades nuevas, usa el botón "Sincronizar vehículos Samsara" en la
  parte de arriba del dashboard.
- El endpoint usado es `/fleet/vehicles/stats?types=gps`, que trae el
  **último** dato GPS conocido del vehículo (no un historial). Es decir,
  el botón captura la hora en el momento en que lo presionas, con la
  posición más reciente que Samsara tenga de esa unidad — útil para
  marcar "llegó ahorita" o "salió ahorita" mientras ves la unidad en
  movimiento o detenida en la ubicación esperada.
- Si más adelante quieres detección automática por geocerca (que se
  registre solo al entrar/salir de la planta, sin botón), se puede
  agregar usando los webhooks de Samsara para eventos de geocerca — dime
  y lo armamos como siguiente paso.

## 4. Estructura

```
fleet-rutas-samsara/
├── db/
│   ├── schema.sql       # tablas
│   └── seed.js          # siembra la data de tu hoja de rutas
├── src/
│   ├── db.js             # conexión Postgres
│   ├── samsara.js        # llamadas a la API de Samsara
│   └── server.js         # servidor Express + endpoints + login/sesión
├── public/
│   ├── login.html         # página de login (sin protección)
│   └── app/                # dashboard (protegido, requiere sesión)
│       ├── index.html
│       ├── app.js
│       └── styles.css
├── scripts/
│   └── generar-password.js  # genera el hash para ADMIN_PASSWORD_HASH
├── package.json
└── .env.example
```

## 5. Endpoints de la API

- `POST /login` — body `{ "usuario": "...", "password": "..." }`. Sin esto,
  todo lo demás (dashboard y `/api/*`) responde 401 o redirige a `/login`.
- `POST /logout` — cierra la sesión.
- `GET /api/rutas?fecha=YYYY-MM-DD` — rutas, turnos, asignaciones y
  registros de esa fecha.
- `POST /api/registros` — guarda/actualiza un registro.
  ```json
  { "asignacion_id": 12, "tipo": "llegada", "fuente": "manual", "hora": "15:07" }
  ```
  o
  ```json
  { "asignacion_id": 12, "tipo": "inicio", "fuente": "samsara" }
  ```
- `DELETE /api/registros/:id` — borra un registro (para corregir).
- `POST /api/samsara/sync` — refresca el mapeo unidad → vehicleId de Samsara.
