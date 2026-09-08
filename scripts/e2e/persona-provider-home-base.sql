-- Disposable local persona fixture. The runtime scheduler still enforces the actual service radius.
CREATE TABLE IF NOT EXISTS provider_home_base (
 id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, address TEXT NOT NULL,
 latitude REAL NOT NULL, longitude REAL NOT NULL, effective_from INTEGER NOT NULL,
 effective_until INTEGER, reason TEXT NOT NULL, updated_by TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_provider_home_base_provider ON provider_home_base(provider_id,effective_from);
INSERT OR IGNORE INTO provider_home_base
 (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at)
SELECT 'E2E-HOME-GROOM-ARUN','groom_arun','E2E fixture: Indiranagar, Bengaluru 560038',
 12.9783692,77.6408356,1,NULL,'Disposable local browser persona provider base','e2e_fixture',1
WHERE NOT EXISTS (SELECT 1 FROM provider_home_base WHERE provider_id='groom_arun');
