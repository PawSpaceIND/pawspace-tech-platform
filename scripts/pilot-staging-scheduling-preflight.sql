-- Pilot-only staging preparation. This is executed once before concurrent traffic.
-- It replaces the former customer-request 100-day roster fan-out without changing production behavior.
CREATE TABLE IF NOT EXISTS scheduling_availability (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  city_id TEXT NOT NULL,
  zone_id TEXT NOT NULL,
  date TEXT NOT NULL,
  windows_json TEXT NOT NULL,
  source TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scheduling_availability_provider_date ON scheduling_availability(provider_id,date);
CREATE INDEX IF NOT EXISTS idx_scheduling_availability_date_provider_source ON scheduling_availability(date,provider_id,source);

-- Keep repeated pilot certifications independent from one another. The synthetic harness deliberately
-- uses group ids shaped PILOT-<run>-SG-<actor>; old successful runs must not consume a future actor's
-- deterministic Grooming/Training/Taxi/Walking slot. Delete only that explicit synthetic namespace and
-- leave every non-PILOT reservation, decision, offer and recovery row untouched.
DELETE FROM provider_assignment_offers WHERE group_id LIKE 'PILOT-%-SG-%';
DELETE FROM provider_recovery_cases WHERE group_id LIKE 'PILOT-%-SG-%';
DELETE FROM scheduling_reservations WHERE group_id LIKE 'PILOT-%-SG-%';
DELETE FROM scheduling_assignment_decisions WHERE group_id LIKE 'PILOT-%-SG-%';

-- The live matching rule correctly refuses a radius-constrained request when a provider has no active
-- geocoded home base. Synthetic pilot traffic includes a real geofence, so staging must carry deterministic
-- Bengaluru home bases for its synthetic provider roster. This is staging-only fixture preparation; it
-- does not weaken or bypass the geofence rule and is never executed against production.
CREATE TABLE IF NOT EXISTS provider_home_base (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  address TEXT NOT NULL,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  effective_from INTEGER NOT NULL,
  effective_until INTEGER,
  reason TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_provider_home_base_provider ON provider_home_base(provider_id,effective_from);

INSERT OR IGNORE INTO provider_home_base
  (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at)
SELECT 'pilot_home_'||p.id,
       p.id,
       'Pilot staging Bengaluru home base',
       12.9352,
       77.6245,
       1767225600000,
       NULL,
       'Deterministic pilot staging geofence fixture',
       'pilot_staging_preflight',
       CAST(strftime('%s','now') AS INTEGER)*1000
FROM provider_capacity_profiles p
WHERE p.city_id='blr' AND p.live=1 AND p.status='active'
  AND NOT EXISTS (
    SELECT 1 FROM provider_home_base h
    WHERE h.provider_id=p.id
      AND h.effective_from<=CAST(strftime('%s','now') AS INTEGER)*1000
      AND (h.effective_until IS NULL OR h.effective_until>CAST(strftime('%s','now') AS INTEGER)*1000)
  );

WITH RECURSIVE dates(day,n) AS (
  SELECT date('now','+5 day'),0
  UNION ALL
  SELECT date(day,'+1 day'),n+1 FROM dates WHERE n<179
), candidates AS (
  SELECT p.id provider_id,p.city_id,
         'blr-east' zone_id,
         CASE
           WHEN instr(p.services_json,'boarding')>0 THEN '["00:00-23:59"]'
           WHEN instr(p.services_json,'pet_taxi')>0 THEN '["06:00-22:00"]'
           WHEN instr(p.services_json,'dog_walking')>0 THEN '["06:00-21:00"]'
           ELSE '["09:00-19:00"]'
         END windows_json
  FROM provider_capacity_profiles p
  WHERE p.city_id='blr' AND p.live=1 AND p.status='active'
)
INSERT OR IGNORE INTO scheduling_availability
  (id,provider_id,city_id,zone_id,date,windows_json,source,updated_at)
SELECT 'pilot_preflight_'||c.provider_id||'_'||d.day||'_'||c.zone_id,
       c.provider_id,c.city_id,c.zone_id,d.day,c.windows_json,'uat_roster',
       CAST(strftime('%s','now') AS INTEGER)*1000
FROM candidates c CROSS JOIN dates d
WHERE NOT EXISTS (
  SELECT 1 FROM scheduling_availability a
  WHERE a.provider_id=c.provider_id AND a.date=d.day
    AND a.source IN ('partner_app','operations','roster')
);
