-- Migración: Control de entradas y salidas del patio de carga
-- Ejecutar una sola vez contra la base de datos de Railway (psql, o el
-- cliente SQL que uses). No afecta las tablas existentes (turnos,
-- asignaciones, registros, samsara_vehiculos).

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
