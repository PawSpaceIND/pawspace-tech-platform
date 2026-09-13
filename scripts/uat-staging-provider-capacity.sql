-- UAT STAGING provider roster (city-wide, every Bengaluru zone).
--
-- Why this exists: the scheduler assigns providers from provider_capacity_profiles filtered by
-- (city_id, service in services_json, zone in zones_json, live=1, status='active', effective window).
-- Without a matching profile the reserve path returns NO_SCHEDULE_AVAILABLE and the customer sees
-- "No provider is available for the date and time you chose." The staging deploy loads only the staff
-- directory (employee-seed.sql), and the runtime founder_seed defaults cover blr-east only, so testers
-- in any other zone (e.g. BTM Layout 560068 = blr-south) could never complete a booking.
--
-- Two gates every row here must satisfy, both enforced by lib/ at request time:
--
--   1. PROVENANCE. lib/provider-assignment-eligibility.ts refuses any provider that has no onboarding
--      verification record UNLESS the runtime is PAWSPACE_SCHEDULING_ENV=uat AND the profile's
--      updated_by is exactly 'founder_seed' (the same provenance the runtime defaults use). A row with
--      any other updated_by is silently dropped from the candidate set BEFORE evaluation, which is why
--      an earlier version of this file (updated_by='uat_staging_seed') loaded fine yet every booking
--      still failed with an EMPTY evaluations list. The UPDATE below repairs rows already loaded.
--
--   2. SERVICE RADIUS. Grooming and Dog Training are matched within SERVICE_DISCOVERY_RADIUS_KM (16 km)
--      of the customer's geocoded address (lib/service-discovery-address.ts), so each of those
--      providers needs a current provider_home_base row or it is refused with "no active geocoded home
--      base". Staging does not enable the test home-base fixture, so this file seeds one provider per
--      zone with a home base inside that zone, plus a central base for the city-wide rows. Boarding,
--      Sitting, Walking and Taxi are not radius-gated and stay city-wide.
--
-- PAWSPACE_SCHEDULING_ENV="uat" on staging means seedUatRoster then auto-creates scheduling_availability
-- on the customer's reserve path; gate 3 at the end of this file also publishes authored availability for
-- the next two weeks so capacity does not depend on that per-request write. Idempotent: INSERT OR
-- IGNORE / WHERE NOT EXISTS, safe to re-run. UAT roster DATA on isolated staging only; it does not
-- weaken any booking, payment, or identity gate, and never touches production.

CREATE TABLE IF NOT EXISTS provider_capacity_profiles (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,provider_model TEXT NOT NULL,services_json TEXT NOT NULL,zones_json TEXT NOT NULL,live INTEGER NOT NULL DEFAULT 1,rating REAL NOT NULL DEFAULT 0,quality_score REAL NOT NULL DEFAULT 0,capacity INTEGER NOT NULL DEFAULT 1,travel_buffer_minutes INTEGER NOT NULL DEFAULT 30,max_daily_jobs INTEGER NOT NULL DEFAULT 6,acceptance_timeout_minutes INTEGER NOT NULL DEFAULT 3,status TEXT NOT NULL DEFAULT 'active',version INTEGER NOT NULL DEFAULT 1,effective_from TEXT NOT NULL,effective_to TEXT,updated_by TEXT NOT NULL,updated_at INTEGER NOT NULL);

-- Repair rows loaded by the earlier version of this file: same UAT roster, wrong provenance.
UPDATE provider_capacity_profiles SET updated_by='founder_seed',version=version+1,updated_at=1789300000000 WHERE updated_by='uat_staging_seed';

-- ---------------------------------------------------------------------------------------------------
-- Grooming (radius-gated): one full-time groomer per zone, each based inside their zone, plus a
-- city-wide full-time team and a city-wide commission partner (exercises the accept/decline offer path).
-- ---------------------------------------------------------------------------------------------------
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_groom_ft','blr','PawSpace Grooming Team (UAT)','full_time','["grooming"]','["blr-east","blr-south","blr-north","blr-west","blr-central"]',1,4.9,97,1,30,20,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_groom_cm','blr','PawSpace Grooming Partner (UAT)','commission','["grooming"]','["blr-east","blr-south","blr-north","blr-west","blr-central"]',1,4.8,93,1,30,20,60,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_groom_east','blr','Divya K. (UAT East)','full_time','["grooming"]','["blr-east"]',1,4.9,96,1,30,12,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_groom_south','blr','Rahul M. (UAT South)','full_time','["grooming"]','["blr-south"]',1,4.9,96,1,30,12,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_groom_north','blr','Priya N. (UAT North)','full_time','["grooming"]','["blr-north"]',1,4.8,94,1,30,12,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_groom_west','blr','Suresh V. (UAT West)','full_time','["grooming"]','["blr-west"]',1,4.8,94,1,30,12,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_groom_central','blr','Meera S. (UAT Central)','full_time','["grooming"]','["blr-central"]',1,4.9,95,1,30,12,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);

-- ---------------------------------------------------------------------------------------------------
-- Dog training (radius-gated, recurring): one full-time trainer per zone plus a city-wide team.
-- ---------------------------------------------------------------------------------------------------
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_train_ft','blr','PawSpace Training Team (UAT)','full_time','["dog_training"]','["blr-east","blr-south","blr-north","blr-west","blr-central"]',1,4.9,95,1,45,12,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_train_east','blr','Arjun T. (UAT East)','full_time','["dog_training"]','["blr-east"]',1,4.9,95,1,45,8,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_train_south','blr','Kavya R. (UAT South)','full_time','["dog_training"]','["blr-south"]',1,4.9,95,1,45,8,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_train_north','blr','Nikhil B. (UAT North)','full_time','["dog_training"]','["blr-north"]',1,4.8,93,1,45,8,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_train_west','blr','Anitha G. (UAT West)','full_time','["dog_training"]','["blr-west"]',1,4.8,93,1,45,8,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_train_central','blr','Rohan D. (UAT Central)','full_time','["dog_training"]','["blr-central"]',1,4.9,94,1,45,8,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);

-- ---------------------------------------------------------------------------------------------------
-- Boarding / Pet sitting / Dog walking / Pet taxi: not radius-gated, city-wide.
-- ---------------------------------------------------------------------------------------------------
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_host_cm','blr','PawSpace Boarding Host (UAT)','commission','["boarding"]','["blr-east","blr-south","blr-north","blr-west","blr-central"]',1,4.9,96,4,0,12,60,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_sit_cm','blr','PawSpace Sitter (UAT)','commission','["pet_sitting"]','["blr-east","blr-south","blr-north","blr-west","blr-central"]',1,4.8,92,4,30,12,60,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_walk_ft','blr','PawSpace Walker (UAT)','full_time','["dog_walking"]','["blr-east","blr-south","blr-north","blr-west","blr-central"]',1,4.9,96,1,20,20,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_taxi_ft','blr','PawSpace Pet Taxi (UAT)','full_time','["pet_taxi"]','["blr-east","blr-south","blr-north","blr-west","blr-central"]',1,4.9,96,1,20,16,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);

-- ---------------------------------------------------------------------------------------------------
-- Home bases for every radius-gated provider (grooming + training), one per zone, well inside the
-- 16 km service radius of every governed pincode in that zone. The runtime founder_seed defaults
-- (groom_*/train_*, blr-east) get an Indiranagar base too, so the built-in east roster also matches on
-- staging. WHERE NOT EXISTS: a base authored through Ops or the partner app is never overridden.
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS provider_home_base (id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,address TEXT NOT NULL,latitude REAL NOT NULL,longitude REAL NOT NULL,effective_from INTEGER NOT NULL,effective_until INTEGER,reason TEXT NOT NULL,updated_by TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_provider_home_base_provider ON provider_home_base(provider_id,effective_from);

INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) SELECT 'UAT-PHB-uatcap_groom_ft','uatcap_groom_ft','UAT base: MG Road, Bengaluru 560001',12.9756,77.6066,0,NULL,'UAT staging roster home base','founder_seed',1789300000000 WHERE NOT EXISTS (SELECT 1 FROM provider_home_base WHERE provider_id='uatcap_groom_ft');
INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) SELECT 'UAT-PHB-uatcap_groom_cm','uatcap_groom_cm','UAT base: Shivajinagar, Bengaluru 560042',12.9850,77.6050,0,NULL,'UAT staging roster home base','founder_seed',1789300000000 WHERE NOT EXISTS (SELECT 1 FROM provider_home_base WHERE provider_id='uatcap_groom_cm');
INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) SELECT 'UAT-PHB-uatcap_groom_east','uatcap_groom_east','UAT base: Indiranagar, Bengaluru 560038',12.9784,77.6408,0,NULL,'UAT staging roster home base','founder_seed',1789300000000 WHERE NOT EXISTS (SELECT 1 FROM provider_home_base WHERE provider_id='uatcap_groom_east');
INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) SELECT 'UAT-PHB-uatcap_groom_south','uatcap_groom_south','UAT base: BTM Layout 2nd Stage, Bengaluru 560068',12.9166,77.6101,0,NULL,'UAT staging roster home base','founder_seed',1789300000000 WHERE NOT EXISTS (SELECT 1 FROM provider_home_base WHERE provider_id='uatcap_groom_south');
INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) SELECT 'UAT-PHB-uatcap_groom_north','uatcap_groom_north','UAT base: Hebbal, Bengaluru 560024',13.0358,77.5970,0,NULL,'UAT staging roster home base','founder_seed',1789300000000 WHERE NOT EXISTS (SELECT 1 FROM provider_home_base WHERE provider_id='uatcap_groom_north');
INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) SELECT 'UAT-PHB-uatcap_groom_west','uatcap_groom_west','UAT base: Rajajinagar, Bengaluru 560010',12.9910,77.5550,0,NULL,'UAT staging roster home base','founder_seed',1789300000000 WHERE NOT EXISTS (SELECT 1 FROM provider_home_base WHERE provider_id='uatcap_groom_west');
INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) SELECT 'UAT-PHB-uatcap_groom_central','uatcap_groom_central','UAT base: Ulsoor, Bengaluru 560008',12.9810,77.6200,0,NULL,'UAT staging roster home base','founder_seed',1789300000000 WHERE NOT EXISTS (SELECT 1 FROM provider_home_base WHERE provider_id='uatcap_groom_central');

INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) SELECT 'UAT-PHB-uatcap_train_ft','uatcap_train_ft','UAT base: MG Road, Bengaluru 560001',12.9756,77.6066,0,NULL,'UAT staging roster home base','founder_seed',1789300000000 WHERE NOT EXISTS (SELECT 1 FROM provider_home_base WHERE provider_id='uatcap_train_ft');
INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) SELECT 'UAT-PHB-uatcap_train_east','uatcap_train_east','UAT base: Indiranagar, Bengaluru 560038',12.9784,77.6408,0,NULL,'UAT staging roster home base','founder_seed',1789300000000 WHERE NOT EXISTS (SELECT 1 FROM provider_home_base WHERE provider_id='uatcap_train_east');
INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) SELECT 'UAT-PHB-uatcap_train_south','uatcap_train_south','UAT base: BTM Layout 2nd Stage, Bengaluru 560068',12.9166,77.6101,0,NULL,'UAT staging roster home base','founder_seed',1789300000000 WHERE NOT EXISTS (SELECT 1 FROM provider_home_base WHERE provider_id='uatcap_train_south');
INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) SELECT 'UAT-PHB-uatcap_train_north','uatcap_train_north','UAT base: Hebbal, Bengaluru 560024',13.0358,77.5970,0,NULL,'UAT staging roster home base','founder_seed',1789300000000 WHERE NOT EXISTS (SELECT 1 FROM provider_home_base WHERE provider_id='uatcap_train_north');
INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) SELECT 'UAT-PHB-uatcap_train_west','uatcap_train_west','UAT base: Rajajinagar, Bengaluru 560010',12.9910,77.5550,0,NULL,'UAT staging roster home base','founder_seed',1789300000000 WHERE NOT EXISTS (SELECT 1 FROM provider_home_base WHERE provider_id='uatcap_train_west');
INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) SELECT 'UAT-PHB-uatcap_train_central','uatcap_train_central','UAT base: Ulsoor, Bengaluru 560008',12.9810,77.6200,0,NULL,'UAT staging roster home base','founder_seed',1789300000000 WHERE NOT EXISTS (SELECT 1 FROM provider_home_base WHERE provider_id='uatcap_train_central');

-- Runtime founder_seed defaults (blr-east only) so the built-in east roster can also match on staging.
INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) SELECT 'UAT-PHB-groom_arun','groom_arun','UAT base: Indiranagar, Bengaluru 560038',12.9784,77.6408,0,NULL,'UAT staging roster home base','founder_seed',1789300000000 WHERE NOT EXISTS (SELECT 1 FROM provider_home_base WHERE provider_id='groom_arun');
INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) SELECT 'UAT-PHB-groom_kiran','groom_kiran','UAT base: Domlur, Bengaluru 560071',12.9611,77.6387,0,NULL,'UAT staging roster home base','founder_seed',1789300000000 WHERE NOT EXISTS (SELECT 1 FROM provider_home_base WHERE provider_id='groom_kiran');
INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) SELECT 'UAT-PHB-groom_sanjay','groom_sanjay','UAT base: Kalyan Nagar, Bengaluru 560043',13.0230,77.6410,0,NULL,'UAT staging roster home base','founder_seed',1789300000000 WHERE NOT EXISTS (SELECT 1 FROM provider_home_base WHERE provider_id='groom_sanjay');
INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) SELECT 'UAT-PHB-train_kiran','train_kiran','UAT base: Indiranagar, Bengaluru 560038',12.9784,77.6408,0,NULL,'UAT staging roster home base','founder_seed',1789300000000 WHERE NOT EXISTS (SELECT 1 FROM provider_home_base WHERE provider_id='train_kiran');
INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) SELECT 'UAT-PHB-train_ramesh','train_ramesh','UAT base: Marathahalli, Bengaluru 560037',12.9591,77.6974,0,NULL,'UAT staging roster home base','founder_seed',1789300000000 WHERE NOT EXISTS (SELECT 1 FROM provider_home_base WHERE provider_id='train_ramesh');
INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) SELECT 'UAT-PHB-train_meera','train_meera','UAT base: Whitefield, Bengaluru 560066',12.9698,77.7500,0,NULL,'UAT staging roster home base','founder_seed',1789300000000 WHERE NOT EXISTS (SELECT 1 FROM provider_home_base WHERE provider_id='train_meera');

-- ---------------------------------------------------------------------------------------------------
-- Identity: staff login (asha.groomer1) opens the Partner workspace as the city-wide UAT groomer, and a
-- synthetic partner OTP number per UAT groomer AND per UAT trainer lets a tester sign in to /partner-app
-- with the sandbox OTP (shown on screen; no real SMS). partner-otp matches canonical_providers by
-- 10-digit phone, and the row id is the provider_capacity_profiles id so the session owns that
-- provider's work orders. Groomers use 9000000901-907, trainers 9000000931-936.
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS provider_identity_links (email TEXT PRIMARY KEY,provider_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',verified_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
INSERT INTO provider_identity_links (email,provider_id,status,verified_at,updated_at) VALUES ('asha.groomer1@tkpetcare.in','uatcap_groom_ft','active',1785542400000,1785542400000) ON CONFLICT(email) DO UPDATE SET provider_id=excluded.provider_id,status='active',verified_at=excluded.verified_at,updated_at=excluded.updated_at;

CREATE TABLE IF NOT EXISTS canonical_providers (id TEXT PRIMARY KEY,city_id TEXT,name TEXT NOT NULL,phone TEXT NOT NULL UNIQUE,email TEXT,source TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
INSERT OR IGNORE INTO canonical_providers (id,city_id,name,phone,email,source,created_at,updated_at) VALUES
 ('uatcap_groom_ft','blr','PawSpace Grooming Team (UAT)','9000000901',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('uatcap_groom_cm','blr','PawSpace Grooming Partner (UAT)','9000000902',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('uatcap_groom_east','blr','Divya K. (UAT East)','9000000903',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('uatcap_groom_south','blr','Rahul M. (UAT South)','9000000904',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('uatcap_groom_north','blr','Priya N. (UAT North)','9000000905',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('uatcap_groom_west','blr','Suresh V. (UAT West)','9000000906',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('uatcap_groom_central','blr','Meera S. (UAT Central)','9000000907',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('uatcap_train_ft','blr','PawSpace Training Team (UAT)','9000000931',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('uatcap_train_east','blr','Arjun T. (UAT East)','9000000932',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('uatcap_train_south','blr','Kavya R. (UAT South)','9000000933',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('uatcap_train_north','blr','Nikhil B. (UAT North)','9000000934',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('uatcap_train_west','blr','Anitha G. (UAT West)','9000000935',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('uatcap_train_central','blr','Rohan D. (UAT Central)','9000000936',NULL,'uat_staging_seed',1789300000000,1789300000000);

-- ---------------------------------------------------------------------------------------------------
-- 3. PUBLISHED AVAILABILITY. backend/src/scheduling.ts refuses a provider with no scheduling_availability
--    row for the date ("No published availability") or a requested time outside every window ("outside
--    roster"). On a uat runtime the reserve path auto-writes source='uat_roster' rows (seedUatRoster),
--    but only for the requested date, only 09:00-19:00 for day services, and only where no authored row
--    exists. This block publishes authored source='roster' rows for every seeded provider, every zone in
--    its zones_json, yesterday..+15 days (UTC; the extra day each side absorbs the IST offset):
--    06:00-22:00 IST for day services, all day for boarding. Authored rows are the authority for a
--    provider/date (lib/scheduling-roster-authority.ts), so they must cover EVERY zone the provider
--    serves - a partial set would hide the zones it omits. Ids use the prefix 'uatseed_' so they never
--    collide with the runtime's 'uat_<id>_<date>_<zone>' ids: a colliding INSERT OR IGNORE would leave a
--    uat_roster row where an authored one is expected and silently drop that zone. Re-running extends
--    the window forward; existing rows are left untouched.
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scheduling_availability (id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,date TEXT NOT NULL,windows_json TEXT NOT NULL,source TEXT NOT NULL,updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_scheduling_availability_provider_date ON scheduling_availability(provider_id,date);
CREATE INDEX IF NOT EXISTS idx_scheduling_availability_date_provider_source ON scheduling_availability(date,provider_id,source);
WITH RECURSIVE days(d,n) AS (SELECT date('now','-1 day'),0 UNION ALL SELECT date(d,'+1 day'),n+1 FROM days WHERE n<16)
INSERT OR IGNORE INTO scheduling_availability (id,provider_id,city_id,zone_id,date,windows_json,source,updated_at)
SELECT 'uatseed_'||p.id||'_'||days.d||'_'||z.value,p.id,p.city_id,z.value,days.d,CASE WHEN p.services_json LIKE '%"boarding"%' THEN '["00:00-23:59"]' ELSE '["06:00-22:00"]' END,'roster',strftime('%s','now')*1000
FROM provider_capacity_profiles p,json_each(p.zones_json) z,days
WHERE p.id LIKE 'uatcap\_%' ESCAPE '\';
