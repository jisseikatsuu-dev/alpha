const BASE_URL = 'https://api.samsara.com';

function authHeaders() {
  if (!process.env.SAMSARA_API_TOKEN) {
    throw new Error('Falta SAMSARA_API_TOKEN en las variables de entorno.');
  }
  return {
    Authorization: `Bearer ${process.env.SAMSARA_API_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

// Trae TODOS los vehículos de la flota, paginando con cursor (igual patrón
// que ya usas en el script de combustible).
async function fetchAllVehicles() {
  const vehicles = [];
  let after;

  do {
    const url = new URL(`${BASE_URL}/fleet/vehicles`);
    url.searchParams.set('limit', '512');
    if (after) url.searchParams.set('after', after);

    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Samsara /fleet/vehicles ${res.status}: ${body}`);
    }
    const data = await res.json();
    vehicles.push(...(data.data || []));
    after = data.pagination?.hasNextPage ? data.pagination.endCursor : null;
  } while (after);

  return vehicles;
}

// Sincroniza el mapeo "unidad" (nombre en Samsara, ej. C51) -> vehicleId,
// guardándolo en la tabla samsara_vehiculos para no tener que listar
// toda la flota en cada consulta.
async function syncVehiculos(pool) {
  const vehicles = await fetchAllVehicles();
  let guardados = 0;

  for (const v of vehicles) {
    const nombre = (v.name || '').trim();
    if (!nombre) continue;
    await pool.query(
      `INSERT INTO samsara_vehiculos (unidad, samsara_id, actualizado_en)
       VALUES ($1, $2, now())
       ON CONFLICT (unidad) DO UPDATE SET samsara_id = EXCLUDED.samsara_id, actualizado_en = now()`,
      [nombre, String(v.id)]
    );
    guardados++;
  }
  return { total: vehicles.length, guardados };
}

// Busca el samsara_id de una unidad en cache; si no está, sincroniza una
// vez y reintenta (por si es un vehículo nuevo que aún no se había cacheado).
async function getSamsaraIdParaUnidad(pool, unidad) {
  const r = await pool.query('SELECT samsara_id FROM samsara_vehiculos WHERE unidad = $1', [unidad]);
  if (r.rows.length) return r.rows[0].samsara_id;

  await syncVehiculos(pool);
  const r2 = await pool.query('SELECT samsara_id FROM samsara_vehiculos WHERE unidad = $1', [unidad]);
  return r2.rows[0]?.samsara_id || null;
}

// Trae el último dato GPS conocido de un vehículo (hora, ubicación, velocidad).
async function getUltimoGps(vehicleId) {
  const url = new URL(`${BASE_URL}/fleet/vehicles/stats`);
  url.searchParams.set('types', 'gps');
  url.searchParams.set('vehicleIds', vehicleId);

  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Samsara /fleet/vehicles/stats ${res.status}: ${body}`);
  }
  const data = await res.json();
  const entry = (data.data || [])[0];
  const gps = entry?.gps;
  if (!gps) return null;

  return {
    time: gps.time, // ISO 8601 UTC
    latitud: gps.latitude,
    longitud: gps.longitude,
    velocidadMph: gps.speedMilesPerHour ?? null,
    ubicacion: gps.reverseGeo?.formattedLocation || null,
  };
}

// Atajo: dado el nombre de unidad, regresa el último GPS (resolviendo el id primero).
async function getUltimoGpsPorUnidad(pool, unidad) {
  const samsaraId = await getSamsaraIdParaUnidad(pool, unidad);
  if (!samsaraId) {
    throw new Error(`La unidad "${unidad}" no se encontró en Samsara. Corre una sincronización.`);
  }
  const gps = await getUltimoGps(samsaraId);
  if (!gps) {
    throw new Error(`Samsara no tiene datos GPS recientes para la unidad "${unidad}".`);
  }
  return gps;
}

module.exports = {
  fetchAllVehicles,
  syncVehiculos,
  getSamsaraIdParaUnidad,
  getUltimoGps,
  getUltimoGpsPorUnidad,
};
