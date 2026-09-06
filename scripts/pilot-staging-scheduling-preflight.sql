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

WITH RECURSIVE dates(day,n) AS (
  SELECT date('now','+5 day'),0
  UNION ALL
  SELECT date(day,'+1 day'),n+1 FROM dates WHERE n<119
), candidates AS (
  SELECT p.id provider_id,p.city_id,
         CASE WHEN instr(p.zones_json,'blr-east')>0 THEN 'blr-east' ELSE 'blr-east' END zone_id,
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
