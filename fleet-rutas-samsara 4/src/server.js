require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const pool = require('./db');
const samsara = require('./samsara');

const TZ = process.env.TZ_ZONA || 'America/Monterrey';
const app = express();

if (!process.env.SESSION_SECRET) {
  console.error('Falta SESSION_SECRET en las variables de entorno.');
  process.exit(1);
}
if (!process.env.ADMIN_USER || !process.env.ADMIN_PASSWORD_HASH) {
  console.error('Falta ADMIN_USER o ADMIN_PASSWORD_HASH. Genera el hash con: npm run generar-password -- "tu_contraseña"');
  process.exit(1);
}

// Necesario para que las cookies "secure" funcionen detrás de nginx/ALB.
app.set('trust proxy', 1);

app.use(express.json());

app.use(
  session({
    store: new pgSession({ pool, tableName: 'session', createTableIfMissing: true }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.SESSION_SECURE === 'true',
      maxAge: 1000 * 60 * 60 * 12, // 12 horas
    },
  })
);

// --- Protección simple contra fuerza bruta en /login (en memoria) ---
const intentosLogin = new Map(); // ip -> { count, resetAt }
const LIMITE_INTENTOS = 8;
const VENTANA_MS = 10 * 60 * 1000; // 10 minutos

function loginBloqueado(ip) {
  const registro = intentosLogin.get(ip);
  if (!registro) return false;
  if (Date.now() > registro.resetAt) {
    intentosLogin.delete(ip);
    return false;
  }
  return registro.count >= LIMITE_INTENTOS;
}

function registrarIntentoFallido(ip) {
  const registro = intentosLogin.get(ip) || { count: 0, resetAt: Date.now() + VENTANA_MS };
  registro.count++;
  intentosLogin.set(ip, registro);
}

function limpiarIntentos(ip) {
  intentosLogin.delete(ip);
}

// --- Rutas de login/logout (sin protección) ---
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'login.html'));
});

app.post('/login', async (req, res) => {
  const ip = req.ip;
  if (loginBloqueado(ip)) {
    return res.status(429).json({ error: 'Demasiados intentos fallidos. Espera unos minutos.' });
  }

  const { usuario, password } = req.body || {};
  if (!usuario || !password) {
    return res.status(400).json({ error: 'Faltan usuario o contraseña.' });
  }

  const usuarioValido = usuario === process.env.ADMIN_USER;
  const passwordValida = usuarioValido
    ? await bcrypt.compare(password, process.env.ADMIN_PASSWORD_HASH)
    : false;

  if (!usuarioValido || !passwordValida) {
    registrarIntentoFallido(ip);
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
  }

  limpiarIntentos(ip);
  req.session.autenticado = true;
  req.session.usuario = usuario;
  res.json({ ok: true });
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// --- A partir de aquí, todo requiere sesión iniciada ---
function requireLogin(req, res, next) {
  if (req.session && req.session.autenticado) return next();
  if (req.path.startsWith('/api')) {
    return res.status(401).json({ error: 'No autenticado.' });
  }
  return res.redirect('/login');
}

app.use(requireLogin);
app.use(express.static(path.join(__dirname, '..', 'public', 'app')));

function hoyLocal() {
  // YYYY-MM-DD en la zona horaria configurada
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  return f.format(new Date());
}

function horaLocalDesdeISO(isoUtc) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  return f.format(new Date(isoUtc)); // HH:MM:SS
}

// GET /api/rutas?fecha=YYYY-MM-DD
// Regresa todas las rutas con sus turnos, asignaciones y (si existen)
// los registros de llegada/inicio para esa fecha.
app.get('/api/rutas', async (req, res) => {
  try {
    const fecha = req.query.fecha || hoyLocal();

    const turnos = (
      await pool.query('SELECT * FROM turnos ORDER BY orden ASC, id ASC')
    ).rows;

    const asignaciones = (
      await pool.query('SELECT * FROM asignaciones ORDER BY orden ASC, id ASC')
    ).rows;

    const registros = (
      await pool.query('SELECT * FROM registros WHERE fecha = $1', [fecha])
    ).rows;

    const registrosPorAsignacion = {};
    for (const r of registros) {
      if (!registrosPorAsignacion[r.asignacion_id]) registrosPorAsignacion[r.asignacion_id] = {};
      registrosPorAsignacion[r.asignacion_id][r.tipo] = r;
    }

    const turnosConDatos = turnos.map((t) => ({
      ...t,
      asignaciones: asignaciones
        .filter((a) => a.turno_id === t.id)
        .map((a) => ({
          ...a,
          llegada: registrosPorAsignacion[a.id]?.llegada || null,
          inicio: registrosPorAsignacion[a.id]?.inicio || null,
        })),
    }));

    const rutas = {};
    for (const t of turnosConDatos) {
      if (!rutas[t.ruta]) rutas[t.ruta] = [];
      rutas[t.ruta].push(t);
    }

    res.json({ fecha, rutas });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/registros
// body: { asignacion_id, tipo: 'llegada'|'inicio', fuente: 'manual'|'samsara',
//          hora?: 'HH:MM' (requerido si fuente=manual), fecha?: 'YYYY-MM-DD' }
app.post('/api/registros', async (req, res) => {
  try {
    const { asignacion_id, tipo, fuente } = req.body;
    const fecha = req.body.fecha || hoyLocal();

    if (!asignacion_id || !['llegada', 'inicio'].includes(tipo) || !['manual', 'samsara'].includes(fuente)) {
      return res.status(400).json({ error: 'Faltan campos o son inválidos (asignacion_id, tipo, fuente).' });
    }

    const asigRes = await pool.query('SELECT * FROM asignaciones WHERE id = $1', [asignacion_id]);
    const asignacion = asigRes.rows[0];
    if (!asignacion) return res.status(404).json({ error: 'Asignación no encontrada.' });

    let hora, detalle;

    if (fuente === 'manual') {
      if (!req.body.hora) return res.status(400).json({ error: 'Falta "hora" (HH:MM) para registro manual.' });
      hora = req.body.hora.length === 5 ? `${req.body.hora}:00` : req.body.hora;
      detalle = null;
    } else {
      const gps = await samsara.getUltimoGpsPorUnidad(pool, asignacion.unidad);
      hora = horaLocalDesdeISO(gps.time);
      detalle = gps.ubicacion
        ? `${gps.ubicacion} (Samsara, ${gps.time})`
        : `lat ${gps.latitud}, lon ${gps.longitud} (Samsara, ${gps.time})`;
    }

    const upsert = await pool.query(
      `INSERT INTO registros (asignacion_id, fecha, tipo, hora, fuente, detalle)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (asignacion_id, fecha, tipo)
       DO UPDATE SET hora = EXCLUDED.hora, fuente = EXCLUDED.fuente, detalle = EXCLUDED.detalle, creado_en = now()
       RETURNING *`,
      [asignacion_id, fecha, tipo, hora, fuente, detalle]
    );

    res.json(upsert.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/registros/:id  (para corregir un registro capturado por error)
app.delete('/api/registros/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM registros WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/samsara/sync  -> refresca el mapeo unidad -> vehicleId de Samsara
app.post('/api/samsara/sync', async (req, res) => {
  try {
    const resultado = await samsara.syncVehiculos(pool);
    res.json(resultado);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Dashboard de rutas corriendo en puerto ${PORT}`));
