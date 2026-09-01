-- Cada bloque de horario de una ruta: ej. LINAMAR / ENTRADA / 15:00
CREATE TABLE IF NOT EXISTS turnos (
  id SERIAL PRIMARY KEY,
  ruta TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('ENTRADA', 'SALIDA')),
  hora_programada TIME NOT NULL,
  orden INTEGER NOT NULL DEFAULT 0
);

-- Cada unidad asignada dentro de un turno, con su parada/colonia
CREATE TABLE IF NOT EXISTS asignaciones (
  id SERIAL PRIMARY KEY,
  turno_id INTEGER NOT NULL REFERENCES turnos(id) ON DELETE CASCADE,
  unidad TEXT NOT NULL,
  parada TEXT NOT NULL,
  orden INTEGER NOT NULL DEFAULT 0
);

-- Registro real de hora de llegada / inicio, manual o traída de Samsara
CREATE TABLE IF NOT EXISTS registros (
  id SERIAL PRIMARY KEY,
  asignacion_id INTEGER NOT NULL REFERENCES asignaciones(id) ON DELETE CASCADE,
  fecha DATE NOT NULL DEFAULT CURRENT_DATE,
  tipo TEXT NOT NULL CHECK (tipo IN ('llegada', 'inicio')),
  hora TIME NOT NULL,
  fuente TEXT NOT NULL CHECK (fuente IN ('manual', 'samsara')),
  detalle TEXT,
  creado_en TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE (asignacion_id, fecha, tipo)
);

-- Cache de mapeo Unidad (ej. "C51") -> vehicleId de Samsara
CREATE TABLE IF NOT EXISTS samsara_vehiculos (
  unidad TEXT PRIMARY KEY,
  samsara_id TEXT NOT NULL,
  actualizado_en TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_registros_fecha ON registros (fecha);
CREATE INDEX IF NOT EXISTS idx_asignaciones_turno ON asignaciones (turno_id);

-- Control de entradas y salidas del patio de carga
CREATE TABLE IF NOT EXISTS patio_registros (
  id SERIAL PRIMARY KEY,
  placa TEXT NOT NULL,
  conductor TEXT NOT NULL,
  empresa TEXT NOT NULL,
  anden TEXT,
  tipo TEXT NOT NULL CHECK (tipo IN ('carga', 'descarga')),
  notas TEXT,
  entrada_en TIMESTAMP NOT NULL DEFAULT now(),
  salida_en TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_patio_activos ON patio_registros (salida_en);
CREATE INDEX IF NOT EXISTS idx_patio_entrada ON patio_registros (entrada_en);
