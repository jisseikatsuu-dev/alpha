require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../src/db');

// Data tomada de la hoja de rutas (Linamar, Modine, Wiegand, CLS)
const TURNOS = [
  {
    ruta: 'LINAMAR',
    tipo: 'ENTRADA',
    hora_programada: '15:00',
    asignaciones: [
      ['C51', 'RESERVAS'],
      ['C97', 'VALLES/VILLAS'],
      ['C107', 'NUEVA VICTORIA'],
      ['TP49', 'KM'],
      ['TP08', 'APOYO KM'],
      ['C23', 'FRESNOS GEO'],
    ],
  },
  {
    ruta: 'LINAMAR',
    tipo: 'SALIDA',
    hora_programada: '16:36',
    asignaciones: [
      ['C23', 'RESERVAS'],
      ['C42', 'VILLAS/VALLES'],
      ['TP08', 'VOLUNTADES'],
      ['TP49', 'KM Y KM APOYO'],
      ['TP51', 'FRESNOS GEO'],
      ['C54', 'BACK UP'],
    ],
  },
  {
    ruta: 'MODINE',
    tipo: 'ENTRADA',
    hora_programada: '15:00',
    asignaciones: [
      ['C02', 'RESERVAS'],
      ['C29', 'VILLAS'],
      ['C08', 'VALLES'],
      ['C15', 'VOLUNTADES'],
      ['TP38', 'FRESNOS GEO'],
      ['TP37', 'CAMPANARIO'],
      ['TP06', 'LOMAS'],
      ['C19', 'CONSTITUCIONAL'],
    ],
  },
  {
    ruta: 'MODINE',
    tipo: 'SALIDA',
    hora_programada: '16:06',
    asignaciones: [
      ['C19', 'RESERVAS'],
      ['C107', 'VILLAS'],
      ['C08', 'VALLES'],
      ['TP37', 'FRESNOS GEO'],
      ['TP38', 'CAMPANARIO'],
      ['C15', 'J. LONGORIA'],
    ],
  },
  {
    ruta: 'WIEGAND',
    tipo: 'SALIDA',
    hora_programada: '15:30',
    asignaciones: [
      ['C35', 'INFONAVIT'],
      ['C29', 'FCO VILLA'],
      ['C54', 'LA JOYA'],
      ['TP08', 'KM'],
      ['TP51', 'LOMAS'],
      ['C91', 'COLINAS'],
      ['C42', 'RESERVAS'],
      ['C53', 'NUEVA ERA'],
      ['C58', 'VILLAS DE SAN MIGUEL'],
      ['C23', 'SOLIDARIDAD'],
    ],
  },
  {
    ruta: 'CLS',
    tipo: 'ENTRADA',
    hora_programada: '16:00',
    asignaciones: [
      ['TP01', 'SOLIDARIDAD'],
      ['TP25', 'RESERVAS'],
      ['TP14', 'VALLES'],
      ['TP32', 'KM'],
      ['TP27', 'FRESNOS'],
      ['TP24', 'VILLAS'],
      ['TP15', 'CENTRO'],
    ],
  },
  {
    ruta: 'CLS',
    tipo: 'SALIDA',
    hora_programada: '16:45',
    asignaciones: [
      ['TP01', 'SOLIDARIDAD'],
      ['TP25', 'RESERVAS'],
      ['TP14', 'VALLES'],
      ['TP32', 'KM'],
      ['TP15', 'FRESNOS'],
      ['TP24', 'VILLAS'],
      ['TP27', 'CENTRO'],
      ['TP06', 'RUTA NUEVA'],
    ],
  },
];

async function seed() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);
  console.log('Esquema aplicado.');

  const { rows: existentes } = await pool.query('SELECT COUNT(*)::int AS n FROM turnos');
  if (existentes[0].n > 0) {
    console.log(`Ya hay ${existentes[0].n} turnos en la base. No se vuelve a sembrar.`);
    console.log('Si quieres resembrar, borra las tablas turnos/asignaciones primero.');
    return;
  }

  for (let i = 0; i < TURNOS.length; i++) {
    const t = TURNOS[i];
    const { rows } = await pool.query(
      `INSERT INTO turnos (ruta, tipo, hora_programada, orden) VALUES ($1,$2,$3,$4) RETURNING id`,
      [t.ruta, t.tipo, t.hora_programada, i]
    );
    const turnoId = rows[0].id;

    for (let j = 0; j < t.asignaciones.length; j++) {
      const [unidad, parada] = t.asignaciones[j];
      await pool.query(
        `INSERT INTO asignaciones (turno_id, unidad, parada, orden) VALUES ($1,$2,$3,$4)`,
        [turnoId, unidad, parada, j]
      );
    }
    console.log(`Sembrado: ${t.ruta} ${t.tipo} (${t.asignaciones.length} unidades)`);
  }

  console.log('Listo.');
}

seed()
  .catch((err) => {
    console.error('Error sembrando:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
