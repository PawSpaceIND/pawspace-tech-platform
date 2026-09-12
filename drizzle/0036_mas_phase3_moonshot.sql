CREATE TABLE IF NOT EXISTS moonshot_pet_telemetry (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL, pet_id TEXT NOT NULL,
  observed_at INTEGER NOT NULL, received_at INTEGER NOT NULL,
  heart_rate_bpm REAL, temperature_c REAL, latitude REAL, longitude REAL, battery_percent REAL,
  payload_json TEXT NOT NULL, debounce_key TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_moonshot_pet_telemetry_pet_time ON moonshot_pet_telemetry(pet_id, observed_at DESC);
CREATE TABLE IF NOT EXISTS moonshot_ops_alerts (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL, booking_id TEXT,
  severity TEXT NOT NULL, status TEXT NOT NULL, tool_code TEXT NOT NULL,
  payload_json TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_moonshot_ops_alerts_status_time ON moonshot_ops_alerts(status, created_at DESC);
