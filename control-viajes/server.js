require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const { Pool, types } = require('pg');

types.setTypeParser(1082, (v) => v); // DATE -> 'YYYY-MM-DD' (sin corrimiento de zona horaria)

const PORT = process.env.PORT || 3000;
const TOL = parseInt(process.env.TOLERANCIA_MIN || '5', 10);
const CRIT = parseInt(process.env.CRITICO_MIN || '15', 10);
const DASHBOARD_PUBLICO = process.env.DASHBOARD_PUBLICO === 'true';
const TZ = process.env.TZ_APP || 'America/Monterrey';

const dbUrl = process.env.DATABASE_URL || '';
const sinSSL = process.env.PGSSL === 'false' || /localhost|127\.0\.0\.1|\.railway\.internal/.test(dbUrl);
const pool = new Pool({ connectionString: dbUrl, ssl: sinSSL ? false : { rejectUnauthorized: false } });

// ---------- Esquema (se crea solo al arrancar, sin migración manual) ----------
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS viajes (
      id                  SERIAL PRIMARY KEY,
      fecha               DATE NOT NULL DEFAULT CURRENT_DATE,
      cliente             TEXT NOT NULL,
      turno               TEXT,
      ruta                TEXT NOT NULL,
      unidad_asignada     TEXT,
      operador            TEXT,
      inicio_ruta         TIME,
      hora_encendido_real TIME,
      llegada_programada  TIME,
      hora_llegada_real   TIME,
      pasajeros           INT,
      capacidad           INT,
      notas               TEXT,
      creado_en           TIMESTAMPTZ NOT NULL DEFAULT now(),
      actualizado_en      TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS viajes_fecha_idx ON viajes (fecha);
  `);
}

// ---------- Utilidades ----------
const CAMPOS = {
  fecha: 'date', cliente: 'text', turno: 'text', ruta: 'text', unidad_asignada: 'text', operador: 'text',
  inicio_ruta: 'time', hora_encendido_real: 'time', llegada_programada: 'time', hora_llegada_real: 'time',
  pasajeros: 'int', capacidad: 'int', notas: 'text',
};
const HORAS = Object.keys(CAMPOS).filter((k) => CAMPOS[k] === 'time');

function hoy() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function minutosAhora() {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  const [h, m] = p.split(':').map(Number);
  return (h % 24) * 60 + m;
}
function aMin(t) { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; }
function difMin(a, b) { // a - b en minutos, tolerante a cruce de medianoche (turno nocturno)
  if (!a || !b) return null;
  let d = aMin(a) - aMin(b);
  if (d < -720) d += 1440;
  if (d > 720) d -= 1440;
  return d;
}
function normHora(v) {
  const m = String(v).trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap])?\.?\s*m?\.?$/i);
  if (!m) return null;
  let h = +m[1]; const mi = +m[2]; const ap = m[3] && m[3].toLowerCase();
  if (ap === 'p' && h < 12) h += 12;
  if (ap === 'a' && h === 12) h = 0;
  if (h > 23 || mi > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}
function fechaParam(f) { return /^\d{4}-\d{2}-\d{2}$/.test(f || '') ? f : hoy(); }

function limpiar(fila) {
  const out = {}; const errores = [];
  for (const [k, tipo] of Object.entries(CAMPOS)) {
    if (!(k in fila) || fila[k] === undefined) continue;
    const crudo = fila[k];
    if (crudo === null || String(crudo).trim() === '') { out[k] = null; continue; }
    const v = String(crudo).trim();
    if (tipo === 'time') {
      const h = normHora(v);
      if (!h) { errores.push(`${k}: "${v}" no es una hora válida (usa HH:MM)`); continue; }
      out[k] = h;
    } else if (tipo === 'int') {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) { errores.push(`${k}: "${v}" debe ser un número entero`); continue; }
      out[k] = n;
    } else if (tipo === 'date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) { errores.push(`${k}: "${v}" debe ser AAAA-MM-DD`); continue; }
      out[k] = v;
    } else {
      out[k] = v.slice(0, 300);
    }
  }
  return { out, errores };
}

function enriquecer(v) {
  for (const k of HORAS) if (v[k]) v[k] = v[k].slice(0, 5);
  const retraso_salida = difMin(v.hora_encendido_real, v.inicio_ruta);
  const retraso_llegada = difMin(v.hora_llegada_real, v.llegada_programada);
  let estatus;
  if (v.hora_llegada_real) {
    const r = retraso_llegada ?? 0;
    estatus = r > CRIT ? 'critico' : r > TOL ? 'retraso' : 'a_tiempo';
  } else if (v.hora_encendido_real) estatus = 'en_ruta';
  else estatus = 'pendiente';
  return { ...v, retraso_salida, retraso_llegada, estatus };
}

async function obtenerViajes(fecha) {
  const { rows } = await pool.query(
    `SELECT id, fecha, cliente, turno, ruta, unidad_asignada, operador, inicio_ruta, hora_encendido_real,
            llegada_programada, hora_llegada_real, pasajeros, capacidad, notas, actualizado_en
       FROM viajes WHERE fecha = $1
      ORDER BY cliente, turno NULLS LAST, inicio_ruta NULLS LAST, id`, [fecha]);
  return rows.map(enriquecer);
}

function contadorVacio() {
  return { total: 0, a_tiempo: 0, retraso: 0, critico: 0, en_ruta: 0, pendiente: 0, pasajeros: 0, pax_con_cap: 0, capacidad: 0 };
}
function cerrar(c) {
  const llegados = c.a_tiempo + c.retraso + c.critico;
  c.puntualidad = llegados ? Math.round((c.a_tiempo / llegados) * 100) : null;
  c.ocupacion = c.capacidad ? Math.round((c.pax_con_cap / c.capacidad) * 100) : null;
  return c;
}

function resumen(viajes, fecha) {
  const kpis = contadorVacio(); const porCliente = {}; const alertas = [];
  const esHoy = fecha === hoy(); const ahora = minutosAhora();

  for (const v of viajes) {
    const c = (porCliente[v.cliente] ||= { cliente: v.cliente, ...contadorVacio() });
    for (const t of [kpis, c]) {
      t.total++; t[v.estatus]++;
      if (v.pasajeros != null) {
        t.pasajeros += v.pasajeros;
        if (v.capacidad) { t.pax_con_cap += v.pasajeros; t.capacidad += v.capacidad; }
      }
    }
    const id = `${v.ruta} · ${v.unidad_asignada || 'sin unidad'}`;
    const ctx = [v.cliente, v.turno && `turno ${v.turno}`, v.operador].filter(Boolean).join(' · ');

    if (v.estatus === 'critico' || v.estatus === 'retraso') {
      alertas.push({ nivel: v.estatus === 'critico' ? 'crit' : 'warn', min: v.retraso_llegada,
        titulo: `${id} llegó ${v.retraso_llegada} min tarde`, detalle: `${ctx} · programada ${v.llegada_programada}`, cuando: v.hora_llegada_real });
    } else if (v.estatus === 'en_ruta' && v.retraso_salida > TOL) {
      alertas.push({ nivel: v.retraso_salida > CRIT ? 'crit' : 'warn', min: v.retraso_salida,
        titulo: `${id} salió ${v.retraso_salida} min tarde`, detalle: `${ctx} · inicio programado ${v.inicio_ruta}`, cuando: v.hora_encendido_real });
    } else if (v.estatus === 'pendiente' && esHoy && v.inicio_ruta) {
      let d = ahora - aMin(v.inicio_ruta); if (d < -720) d += 1440;
      if (d > TOL) alertas.push({ nivel: d > CRIT ? 'crit' : 'warn', min: d,
        titulo: `${id} no ha encendido`, detalle: `${ctx} · inicio programado ${v.inicio_ruta}`, cuando: `+${d} min` });
    }
    if (v.estatus === 'pendiente' && !v.unidad_asignada) {
      alertas.push({ nivel: 'warn', min: 0, titulo: `${v.ruta} sin unidad asignada`, detalle: ctx, cuando: v.inicio_ruta || '' });
    }
  }
  alertas.sort((a, b) => (a.nivel === b.nivel ? (b.min || 0) - (a.min || 0) : a.nivel === 'crit' ? -1 : 1));
  return { kpis: cerrar(kpis), porCliente: Object.values(porCliente).map(cerrar), alertas };
}

// ---------- App ----------
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(session({
  store: new PgSession({ pool, tableName: 'sesiones', createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'dev-inseguro',
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === 'true', maxAge: 12 * 3600 * 1000 },
}));
app.use('/static', express.static(path.join(__dirname, 'public')));

const vista = (n) => path.join(__dirname, 'views', n);
function requiereAuth(req, res, next) {
  if (req.session.user) return next();
  if (req.originalUrl.startsWith('/api/')) return res.status(401).json({ error: 'Sesión expirada. Vuelve a iniciar sesión.' });
  res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
}
const lectura = (req, res, next) => (DASHBOARD_PUBLICO ? next() : requiereAuth(req, res, next));

app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/', (req, res) => res.redirect('/dashboard'));
app.get('/login', (req, res) => res.sendFile(vista('login.html')));
app.post('/login', async (req, res) => {
  const { usuario = '', password = '' } = req.body;
  let ok = usuario === (process.env.ADMIN_USER || 'admin');
  if (ok && process.env.ADMIN_PASS_HASH) ok = await bcrypt.compare(password, process.env.ADMIN_PASS_HASH);
  else if (ok) ok = !!process.env.ADMIN_PASS && password === process.env.ADMIN_PASS;
  const next = typeof req.query.next === 'string' && /^\/(?!\/)/.test(req.query.next) ? req.query.next : '/captura';
  if (!ok) return res.redirect('/login?error=1&next=' + encodeURIComponent(next));
  req.session.regenerate(() => { req.session.user = usuario; res.redirect(next); });
});
app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

app.get('/captura', requiereAuth, (req, res) => res.sendFile(vista('captura.html')));
app.get('/dashboard', lectura, (req, res) => res.sendFile(vista('dashboard.html')));

// ---------- API ----------
app.get('/api/viajes', requiereAuth, async (req, res, next) => {
  try {
    const fecha = fechaParam(req.query.fecha);
    res.json({ fecha, config: { tolerancia: TOL, critico: CRIT }, viajes: await obtenerViajes(fecha) });
  } catch (e) { next(e); }
});

app.post('/api/viajes', requiereAuth, async (req, res, next) => {
  const filas = Array.isArray(req.body && req.body.filas) ? req.body.filas : [];
  if (!filas.length) return res.status(400).json({ error: 'No hay filas para guardar.' });
  if (filas.length > 500) return res.status(400).json({ error: 'Máximo 500 filas por envío.' });
  const fechaDef = fechaParam(req.body.fecha);
  const limpias = []; const detalle = [];
  filas.forEach((f, i) => {
    const { out, errores } = limpiar(f || {});
    if (!out.cliente) errores.push('cliente es obligatorio');
    if (!out.ruta) errores.push('ruta es obligatoria');
    if (errores.length) detalle.push({ fila: i, errores });
    else limpias.push({ ...out, fecha: out.fecha || fechaDef });
  });
  if (detalle.length) return res.status(400).json({ error: 'Hay filas con datos inválidos.', detalle });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ids = [];
    for (const f of limpias) {
      const keys = Object.keys(f);
      const { rows } = await client.query(
        `INSERT INTO viajes (${keys.join(',')}) VALUES (${keys.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING id`,
        keys.map((k) => f[k]));
      ids.push(rows[0].id);
    }
    await client.query('COMMIT');
    res.json({ ok: true, ids });
  } catch (e) { await client.query('ROLLBACK'); next(e); } finally { client.release(); }
});

app.put('/api/viajes/:id', requiereAuth, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { out, errores } = limpiar(req.body || {});
    if ('cliente' in out && !out.cliente) errores.push('cliente es obligatorio');
    if ('ruta' in out && !out.ruta) errores.push('ruta es obligatoria');
    if (errores.length) return res.status(400).json({ error: errores.join('; ') });
    const keys = Object.keys(out);
    if (!keys.length) return res.json({ ok: true });
    const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    const r = await pool.query(`UPDATE viajes SET ${sets}, actualizado_en = now() WHERE id = $${keys.length + 1}`,
      [...keys.map((k) => out[k]), id]);
    if (!r.rowCount) return res.status(404).json({ error: 'El registro ya no existe.' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.delete('/api/viajes/:id', requiereAuth, async (req, res, next) => {
  try {
    await pool.query('DELETE FROM viajes WHERE id = $1', [parseInt(req.params.id, 10)]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.get('/api/dashboard', lectura, async (req, res, next) => {
  try {
    const fecha = fechaParam(req.query.fecha);
    const viajes = await obtenerViajes(fecha);
    res.json({ fecha, hoy: hoy(), generado: new Date().toISOString(), config: { tolerancia: TOL, critico: CRIT },
      ...resumen(viajes, fecha), viajes, puedeEditar: !!req.session.user });
  } catch (e) { next(e); }
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Error del servidor: ' + err.message });
});

initDB()
  .then(() => app.listen(PORT, () => console.log(`Control de viajes en :${PORT}`)))
  .catch((e) => { console.error('No se pudo inicializar la base de datos:', e.message); process.exit(1); });
