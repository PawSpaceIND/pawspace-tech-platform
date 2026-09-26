-- UAT STAGING ONLY. Run after scripts/uat-staging-provider-capacity.sql (deploy-staging and seed-staging do).
-- ---------------------------------------------------------------------------------------------------
-- CITY-WIDE UAT GROOMERS (owner decision, 26 Sept): testers must not run out of groomers. Every seeded
--    groomer serves all five zones, so each slot has the whole seeded team (about 42) instead of about 10.
--    Staging only; relies on the 45 km UAT service radius. Double-booking rules are unchanged.
-- ---------------------------------------------------------------------------------------------------
-- The availability insert below publishes each groomer's new zones (INSERT OR IGNORE over json_each(zones_json)).
UPDATE provider_capacity_profiles SET zones_json='["blr-east","blr-south","blr-north","blr-west","blr-central"]',version=version+1,updated_at=strftime('%s','now')*1000
WHERE id LIKE 'uatcap\_groom%' ESCAPE '\' AND updated_by='founder_seed' AND zones_json!='["blr-east","blr-south","blr-north","blr-west","blr-central"]';
WITH RECURSIVE days(d,n) AS (SELECT date('now','-1 day'),0 UNION ALL SELECT date(d,'+1 day'),n+1 FROM days WHERE n<16)
INSERT OR IGNORE INTO scheduling_availability (id,provider_id,city_id,zone_id,date,windows_json,source,updated_at)
SELECT 'uatseed_'||p.id||'_'||days.d||'_'||z.value,p.id,p.city_id,z.value,days.d,CASE WHEN p.services_json LIKE '%"boarding"%' OR p.services_json LIKE '%"pet_sitting"%' THEN '["00:00-23:59"]' ELSE '["06:00-22:00"]' END,'roster',strftime('%s','now')*1000
FROM provider_capacity_profiles p,json_each(p.zones_json) z,days
WHERE p.id LIKE 'uatcap\_%' ESCAPE '\';
