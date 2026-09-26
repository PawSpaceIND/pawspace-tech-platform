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
-- Grooming (radius-gated): eight full-time groomers per zone, each based inside their zone, plus a
-- city-wide full-time team and a city-wide commission partner (exercises the accept/decline offer path).
-- ---------------------------------------------------------------------------------------------------
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_groom_ft','blr','PawSpace Grooming Team (UAT)','full_time','["grooming"]','["blr-east","blr-south","blr-north","blr-west","blr-central"]',1,4.9,97,1,30,20,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_groom_cm','blr','PawSpace Grooming Partner (UAT)','commission','["grooming"]','["blr-east","blr-south","blr-north","blr-west","blr-central"]',1,4.8,93,1,30,20,60,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_groom_east','blr','Divya K. (UAT East)','full_time','["grooming"]','["blr-east"]',1,4.9,96,1,30,12,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_groom_south','blr','Rahul M. (UAT South)','full_time','["grooming"]','["blr-south"]',1,4.9,96,1,30,12,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_groom_north','blr','Priya N. (UAT North)','full_time','["grooming"]','["blr-north"]',1,4.8,94,1,30,12,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_groom_west','blr','Suresh V. (UAT West)','full_time','["grooming"]','["blr-west"]',1,4.8,94,1,30,12,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_groom_central','blr','Meera S. (UAT Central)','full_time','["grooming"]','["blr-central"]',1,4.9,95,1,30,12,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);

-- Two more dedicated full-time groomers per zone. The engine holds one job per provider per overlapping
-- window ("Existing booking conflicts with travel/service buffer"), so with a single groomer per zone the
-- first tester to confirm a slot exhausted it for everyone else and every later attempt on that slot was
-- refused NO_SCHEDULE_AVAILABLE even though the roster gates all passed. More per zone keep parallel
-- testers (and the automated proof) from starving each other on the same date and time.
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_groom_east_2','blr','Tanvi P. (UAT East 2)','full_time','["grooming"]','["blr-east"]',1,4.8,94,1,30,12,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_groom_east_3','blr','Vikram L. (UAT East 3)','full_time','["grooming"]','["blr-east"]',1,4.7,93,1,30,12,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_groom_south_2','blr','Farah A. (UAT South 2)','full_time','["grooming"]','["blr-south"]',1,4.8,94,1,30,12,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_groom_south_3','blr','Manoj K. (UAT South 3)','full_time','["grooming"]','["blr-south"]',1,4.7,93,1,30,12,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_groom_north_2','blr','Sneha C. (UAT North 2)','full_time','["grooming"]','["blr-north"]',1,4.8,94,1,30,12,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_groom_north_3','blr','Deepak H. (UAT North 3)','full_time','["grooming"]','["blr-north"]',1,4.7,93,1,30,12,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_groom_west_2','blr','Lakshmi J. (UAT West 2)','full_time','["grooming"]','["blr-west"]',1,4.8,94,1,30,12,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_groom_west_3','blr','Karan Y. (UAT West 3)','full_time','["grooming"]','["blr-west"]',1,4.7,93,1,30,12,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_groom_central_2','blr','Pooja E. (UAT Central 2)','full_time','["grooming"]','["blr-central"]',1,4.8,94,1,30,12,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_groom_central_3','blr','Aditya F. (UAT Central 3)','full_time','["grooming"]','["blr-central"]',1,4.7,93,1,30,12,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);

-- Headroom teams (_4/_5), ranked below the others by quality score so they are picked only once the rest of the
-- zone is booked: automated proofs and parallel testers consume the higher-ranked groomers first, and a
-- manual tester still finds a free groomer in every window on the same date.
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_groom_east_4','blr','Ishaan R. (UAT East 4)','full_time','["grooming"]','["blr-east"]',1,4.7,92,1,30,12,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_groom_east_5','blr','Nandini S. (UAT East 5)','full_time','["grooming"]','["blr-east"]',1,4.6,91,1,30,12,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_groom_south_4','blr','Bhavana T. (UAT South 4)','full_time','["grooming"]','["blr-south"]',1,4.7,92,1,30,12,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_groom_south_5','blr','Kiran V. (UAT South 5)','full_time','["grooming"]','["blr-south"]',1,4.6,91,1,30,12,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_groom_north_4','blr','Rekha M. (UAT North 4)','full_time','["grooming"]','["blr-north"]',1,4.7,92,1,30,12,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_groom_north_5','blr','Sameer J. (UAT North 5)','full_time','["grooming"]','["blr-north"]',1,4.6,91,1,30,12,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_groom_west_4','blr','Anjali D. (UAT West 4)','full_time','["grooming"]','["blr-west"]',1,4.7,92,1,30,12,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_groom_west_5','blr','Harish P. (UAT West 5)','full_time','["grooming"]','["blr-west"]',1,4.6,91,1,30,12,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_groom_central_4','blr','Preethi N. (UAT Central 4)','full_time','["grooming"]','["blr-central"]',1,4.7,92,1,30,12,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_groom_central_5','blr','Varun G. (UAT Central 5)','full_time','["grooming"]','["blr-central"]',1,4.6,91,1,30,12,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);

-- Manual-test reserve (_6/_7/_8), ranked lowest: automated proofs and parallel testers exhaust a date one
-- groomer-window at a time (each booking also blocks that groomer's adjacent windows through the travel
-- buffer), and a manual tester must still find a free groomer on the date everyone is using.
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_groom_east_6','blr','Neha O. (UAT East 6)','full_time','["grooming"]','["blr-east"]',1,4.6,90,1,30,12,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_groom_east_7','blr','Rajesh Q. (UAT East 7)','full_time','["grooming"]','["blr-east"]',1,4.5,89,1,30,12,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_groom_east_8','blr','Sunil W. (UAT East 8)','full_time','["grooming"]','["blr-east"]',1,4.5,88,1,30,12,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_groom_south_6','blr','Divya Z. (UAT South 6)','full_time','["grooming"]','["blr-south"]',1,4.6,90,1,30,12,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_groom_south_7','blr','Arun X. (UAT South 7)','full_time','["grooming"]','["blr-south"]',1,4.5,89,1,30,12,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_groom_south_8','blr','Meghna B. (UAT South 8)','full_time','["grooming"]','["blr-south"]',1,4.5,88,1,30,12,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_groom_north_6','blr','Kavitha U. (UAT North 6)','full_time','["grooming"]','["blr-north"]',1,4.6,90,1,30,12,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_groom_north_7','blr','Praveen I. (UAT North 7)','full_time','["grooming"]','["blr-north"]',1,4.5,89,1,30,12,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_groom_north_8','blr','Shalini L. (UAT North 8)','full_time','["grooming"]','["blr-north"]',1,4.5,88,1,30,12,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_groom_west_6','blr','Ganesh M. (UAT West 6)','full_time','["grooming"]','["blr-west"]',1,4.6,90,1,30,12,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_groom_west_7','blr','Ritu N. (UAT West 7)','full_time','["grooming"]','["blr-west"]',1,4.5,89,1,30,12,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_groom_west_8','blr','Vinay K. (UAT West 8)','full_time','["grooming"]','["blr-west"]',1,4.5,88,1,30,12,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_groom_central_6','blr','Aisha R. (UAT Central 6)','full_time','["grooming"]','["blr-central"]',1,4.6,90,1,30,12,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_groom_central_7','blr','Mohan T. (UAT Central 7)','full_time','["grooming"]','["blr-central"]',1,4.5,89,1,30,12,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_groom_central_8','blr','Latha S. (UAT Central 8)','full_time','["grooming"]','["blr-central"]',1,4.5,88,1,30,12,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);

-- ---------------------------------------------------------------------------------------------------
-- Dog training (radius-gated, recurring): one full-time trainer per zone plus a city-wide team.
-- ---------------------------------------------------------------------------------------------------
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_train_ft','blr','PawSpace Training Team (UAT)','full_time','["dog_training"]','["blr-east","blr-south","blr-north","blr-west","blr-central"]',1,4.9,95,25,45,200,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_train_east','blr','Arjun T. (UAT East)','full_time','["dog_training"]','["blr-east"]',1,4.9,95,1,45,8,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_train_south','blr','Kavya R. (UAT South)','full_time','["dog_training"]','["blr-south"]',1,4.9,95,1,45,8,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_train_north','blr','Nikhil B. (UAT North)','full_time','["dog_training"]','["blr-north"]',1,4.8,93,1,45,8,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_train_west','blr','Anitha G. (UAT West)','full_time','["dog_training"]','["blr-west"]',1,4.8,93,1,45,8,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_train_central','blr','Rohan D. (UAT Central)','full_time','["dog_training"]','["blr-central"]',1,4.9,94,1,45,8,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);
-- STAGING ONLY: the city-wide Training team is the trainer testers can always book (owner request
-- 2026-09-26: "during testing no trainer availability shouldn't come, keep this open").
--
-- Why: appointment scheduling held one job per trainer per travel-buffer window, and every tester's
-- Training booking stayed on the calendar, so an 8-session programme (a tester on /v2/training, East
-- Bengaluru, from 12 Oct 2026 10:00 IST every 4 days) clashed somewhere on one of its dates with every
-- trainer and was shown "No available trainer has been confirmed in East Bengaluru for this programme".
-- On a runtime that declares PAWSPACE_SCHEDULING_ENV=uat (staging does; production never does, and
-- deploy-production.yml refuses it) app/api/uat-scheduling lets a Training provider hold overlapping
-- sessions up to its capacity, never two with the identical window. capacity 25 / max_daily_jobs 200
-- makes this team trainer effectively always free for testers. The zone trainers above stay at capacity
-- 1, so staging still exercises the one-trainer-one-session path. On any runtime without the declaration
-- capacity is ignored for appointments, so these numbers change nothing there.
--
-- The INSERT above covers a fresh database; this UPDATE repairs the row an earlier seed already loaded
-- (INSERT OR IGNORE leaves it at capacity 1). It only raises, only touches the seed's own row
-- (updated_by='founder_seed'), so a trainer profile Ops has edited is never overruled, and it matches
-- nothing once applied, so re-running it on every staging deploy is a no-op.
UPDATE provider_capacity_profiles SET capacity=max(capacity,25),max_daily_jobs=max(max_daily_jobs,200),version=version+1,updated_at=1789300000000 WHERE id='uatcap_train_ft' AND updated_by='founder_seed' AND (capacity<25 OR max_daily_jobs<200);

-- STAGING ONLY: four more seats of the same city-wide team (owner decision 2026-09-26, same request).
-- Parallel sessions cover overlapping windows, but never the IDENTICAL one: the unique index
-- uq_scheduling_reservations_active_provider_window allows one active hold per provider per exact
-- (start,end). Testers who keep /v2/training's defaults (3 days ahead, 10:00, weekly) pick exactly the
-- same windows, so the second of them could not share the team trainer and, with the zone trainer
-- busy, the third was told "No available trainer". Each seat takes one more identical window. The
-- seats are full profiles of their own (capacity 25, 200 daily jobs, founder_seed provenance, a home
-- base and a partner OTP number below), so whichever seat a booking gets, a tester can sign in as it.
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_train_ft_2','blr','PawSpace Training Team 2 (UAT)','full_time','["dog_training"]','["blr-east","blr-south","blr-north","blr-west","blr-central"]',1,4.9,95,25,45,200,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_train_ft_3','blr','PawSpace Training Team 3 (UAT)','full_time','["dog_training"]','["blr-east","blr-south","blr-north","blr-west","blr-central"]',1,4.9,95,25,45,200,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_train_ft_4','blr','PawSpace Training Team 4 (UAT)','full_time','["dog_training"]','["blr-east","blr-south","blr-north","blr-west","blr-central"]',1,4.9,95,25,45,200,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_train_ft_5','blr','PawSpace Training Team 5 (UAT)','full_time','["dog_training"]','["blr-east","blr-south","blr-north","blr-west","blr-central"]',1,4.9,95,25,45,200,3,'active',1,'2026-01-01',NULL,'founder_seed',1789300000000);

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
INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) SELECT 'UAT-PHB-uatcap_groom_east_2','uatcap_groom_east_2','UAT base: Indiranagar, Bengaluru 560038',12.9784,77.6408,0,NULL,'UAT staging roster home base','founder_seed',1789300000000 WHERE NOT EXISTS (SELECT 1 FROM provider_home_base WHERE provider_id='uatcap_groom_east_2');
INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) SELECT 'UAT-PHB-uatcap_groom_east_3','uatcap_groom_east_3','UAT base: Indiranagar, Bengaluru 560038',12.9784,77.6408,0,NULL,'UAT staging roster home base','founder_seed',1789300000000 WHERE NOT EXISTS (SELECT 1 FROM provider_home_base WHERE provider_id='uatcap_groom_east_3');
INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) SELECT 'UAT-PHB-uatcap_groom_south_2','uatcap_groom_south_2','UAT base: BTM Layout 2nd Stage, Bengaluru 560068',12.9166,77.6101,0,NULL,'UAT staging roster home base','founder_seed',1789300000000 WHERE NOT EXISTS (SELECT 1 FROM provider_home_base WHERE provider_id='uatcap_groom_south_2');
INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) SELECT 'UAT-PHB-uatcap_groom_south_3','uatcap_groom_south_3','UAT base: BTM Layout 2nd Stage, Bengaluru 560068',12.9166,77.6101,0,NULL,'UAT staging roster home base','founder_seed',1789300000000 WHERE NOT EXISTS (SELECT 1 FROM provider_home_base WHERE provider_id='uatcap_groom_south_3');
INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) SELECT 'UAT-PHB-uatcap_groom_north_2','uatcap_groom_north_2','UAT base: Hebbal, Bengaluru 560024',13.0358,77.5970,0,NULL,'UAT staging roster home base','founder_seed',1789300000000 WHERE NOT EXISTS (SELECT 1 FROM provider_home_base WHERE provider_id='uatcap_groom_north_2');
INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) SELECT 'UAT-PHB-uatcap_groom_north_3','uatcap_groom_north_3','UAT base: Hebbal, Bengaluru 560024',13.0358,77.5970,0,NULL,'UAT staging roster home base','founder_seed',1789300000000 WHERE NOT EXISTS (SELECT 1 FROM provider_home_base WHERE provider_id='uatcap_groom_north_3');
INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) SELECT 'UAT-PHB-uatcap_groom_west_2','uatcap_groom_west_2','UAT base: Rajajinagar, Bengaluru 560010',12.9910,77.5550,0,NULL,'UAT staging roster home base','founder_seed',1789300000000 WHERE NOT EXISTS (SELECT 1 FROM provider_home_base WHERE provider_id='uatcap_groom_west_2');
INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) SELECT 'UAT-PHB-uatcap_groom_west_3','uatcap_groom_west_3','UAT base: Rajajinagar, Bengaluru 560010',12.9910,77.5550,0,NULL,'UAT staging roster home base','founder_seed',1789300000000 WHERE NOT EXISTS (SELECT 1 FROM provider_home_base WHERE provider_id='uatcap_groom_west_3');
INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) SELECT 'UAT-PHB-uatcap_groom_central_2','uatcap_groom_central_2','UAT base: Ulsoor, Bengaluru 560008',12.9810,77.6200,0,NULL,'UAT staging roster home base','founder_seed',1789300000000 WHERE NOT EXISTS (SELECT 1 FROM provider_home_base WHERE provider_id='uatcap_groom_central_2');
INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) SELECT 'UAT-PHB-uatcap_groom_central_3','uatcap_groom_central_3','UAT base: Ulsoor, Bengaluru 560008',12.9810,77.6200,0,NULL,'UAT staging roster home base','founder_seed',1789300000000 WHERE NOT EXISTS (SELECT 1 FROM provider_home_base WHERE provider_id='uatcap_groom_central_3');
INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) SELECT 'UAT-PHB-uatcap_groom_east_4','uatcap_groom_east_4','UAT base: Indiranagar, Bengaluru 560038',12.9784,77.6408,0,NULL,'UAT staging roster home base','founder_seed',1789300000000 WHERE NOT EXISTS (SELECT 1 FROM provider_home_base WHERE provider_id='uatcap_groom_east_4');
INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) SELECT 'UAT-PHB-uatcap_groom_east_5','uatcap_groom_east_5','UAT base: Indiranagar, Bengaluru 560038',12.9784,77.6408,0,NULL,'UAT staging roster home base','founder_seed',1789300000000 WHERE NOT EXISTS (SELECT 1 FROM provider_home_base WHERE provider_id='uatcap_groom_east_5');
INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) SELECT 'UAT-PHB-uatcap_groom_south_4','uatcap_groom_south_4','UAT base: BTM Layout 2nd Stage, Bengaluru 560068',12.9166,77.6101,0,NULL,'UAT staging roster home base','founder_seed',1789300000000 WHERE NOT EXISTS (SELECT 1 FROM provider_home_base WHERE provider_id='uatcap_groom_south_4');
INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) SELECT 'UAT-PHB-uatcap_groom_south_5','uatcap_groom_south_5','UAT base: BTM Layout 2nd Stage, Bengaluru 560068',12.9166,77.6101,0,NULL,'UAT staging roster home base','founder_seed',1789300000000 WHERE NOT EXISTS (SELECT 1 FROM provider_home_base WHERE provider_id='uatcap_groom_south_5');
INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) SELECT 'UAT-PHB-uatcap_groom_north_4','uatcap_groom_north_4','UAT base: Hebbal, Bengaluru 560024',13.0358,77.5970,0,NULL,'UAT staging roster home base','founder_seed',1789300000000 WHERE NOT EXISTS (SELECT 1 FROM provider_home_base WHERE provider_id='uatcap_groom_north_4');
INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) SELECT 'UAT-PHB-uatcap_groom_north_5','uatcap_groom_north_5','UAT base: Hebbal, Bengaluru 560024',13.0358,77.5970,0,NULL,'UAT staging roster home base','founder_seed',1789300000000 WHERE NOT EXISTS (SELECT 1 FROM provider_home_base WHERE provider_id='uatcap_groom_north_5');
INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) SELECT 'UAT-PHB-uatcap_groom_west_4','uatcap_groom_west_4','UAT base: Rajajinagar, Bengaluru 560010',12.9910,77.5550,0,NULL,'UAT staging roster home base','founder_seed',1789300000000 WHERE NOT EXISTS (SELECT 1 FROM provider_home_base WHERE provider_id='uatcap_groom_west_4');
INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) SELECT 'UAT-PHB-uatcap_groom_west_5','uatcap_groom_west_5','UAT base: Rajajinagar, Bengaluru 560010',12.9910,77.5550,0,NULL,'UAT staging roster home base','founder_seed',1789300000000 WHERE NOT EXISTS (SELECT 1 FROM provider_home_base WHERE provider_id='uatcap_groom_west_5');
INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) SELECT 'UAT-PHB-uatcap_groom_central_4','uatcap_groom_central_4','UAT base: Ulsoor, Bengaluru 560008',12.9810,77.6200,0,NULL,'UAT staging roster home base','founder_seed',1789300000000 WHERE NOT EXISTS (SELECT 1 FROM provider_home_base WHERE provider_id='uatcap_groom_central_4');
INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) SELECT 'UAT-PHB-uatcap_groom_central_5','uatcap_groom_central_5','UAT base: Ulsoor, Bengaluru 560008',12.9810,77.6200,0,NULL,'UAT staging roster home base','founder_seed',1789300000000 WHERE NOT EXISTS (SELECT 1 FROM provider_home_base WHERE provider_id='uatcap_groom_central_5');
INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) SELECT 'UAT-PHB-uatcap_groom_east_6','uatcap_groom_east_6','UAT base: Indiranagar, Bengaluru 560038',12.9784,77.6408,0,NULL,'UAT staging roster home base','founder_seed',1789300000000 WHERE NOT EXISTS (SELECT 1 FROM provider_home_base WHERE provider_id='uatcap_groom_east_6');
INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) SELECT 'UAT-PHB-uatcap_groom_east_7','uatcap_groom_east_7','UAT base: Indiranagar, Bengaluru 560038',12.9784,77.6408,0,NULL,'UAT staging roster home base','founder_seed',1789300000000 WHERE NOT EXISTS (SELECT 1 FROM provider_home_base WHERE provider_id='uatcap_groom_east_7');
INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) SELECT 'UAT-PHB-uatcap_groom_east_8','uatcap_groom_east_8','UAT base: Indiranagar, Bengaluru 560038',12.9784,77.6408,0,NULL,'UAT staging roster home base','founder_seed',1789300000000 WHERE NOT EXISTS (SELECT 1 FROM provider_home_base WHERE provider_id='uatcap_groom_east_8');
INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) SELECT 'UAT-PHB-uatcap_groom_south_6','uatcap_groom_south_6','UAT base: BTM Layout 2nd Stage, Bengaluru 560068',12.9166,77.6101,0,NULL,'UAT staging roster home base','founder_seed',1789300000000 WHERE NOT EXISTS (SELECT 1 FROM provider_home_base WHERE provider_id='uatcap_groom_south_6');
INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) SELECT 'UAT-PHB-uatcap_groom_south_7','uatcap_groom_south_7','UAT base: BTM Layout 2nd Stage, Bengaluru 560068',12.9166,77.6101,0,NULL,'UAT staging roster home base','founder_seed',1789300000000 WHERE NOT EXISTS (SELECT 1 FROM provider_home_base WHERE provider_id='uatcap_groom_south_7');
INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) SELECT 'UAT-PHB-uatcap_groom_south_8','uatcap_groom_south_8','UAT base: BTM Layout 2nd Stage, Bengaluru 560068',12.9166,77.6101,0,NULL,'UAT staging roster home base','founder_seed',1789300000000 WHERE NOT EXISTS (SELECT 1 FROM provider_home_base WHERE provider_id='uatcap_groom_south_8');
INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) SELECT 'UAT-PHB-uatcap_groom_north_6','uatcap_groom_north_6','UAT base: Hebbal, Bengaluru 560024',13.0358,77.5970,0,NULL,'UAT staging roster home base','founder_seed',1789300000000 WHERE NOT EXISTS (SELECT 1 FROM provider_home_base WHERE provider_id='uatcap_groom_north_6');
INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) SELECT 'UAT-PHB-uatcap_groom_north_7','uatcap_groom_north_7','UAT base: Hebbal, Bengaluru 560024',13.0358,77.5970,0,NULL,'UAT staging roster home base','founder_seed',1789300000000 WHERE NOT EXISTS (SELECT 1 FROM provider_home_base WHERE provider_id='uatcap_groom_north_7');
INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) SELECT 'UAT-PHB-uatcap_groom_north_8','uatcap_groom_north_8','UAT base: Hebbal, Bengaluru 560024',13.0358,77.5970,0,NULL,'UAT staging roster home base','founder_seed',1789300000000 WHERE NOT EXISTS (SELECT 1 FROM provider_home_base WHERE provider_id='uatcap_groom_north_8');
INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) SELECT 'UAT-PHB-uatcap_groom_west_6','uatcap_groom_west_6','UAT base: Rajajinagar, Bengaluru 560010',12.9910,77.5550,0,NULL,'UAT staging roster home base','founder_seed',1789300000000 WHERE NOT EXISTS (SELECT 1 FROM provider_home_base WHERE provider_id='uatcap_groom_west_6');
INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) SELECT 'UAT-PHB-uatcap_groom_west_7','uatcap_groom_west_7','UAT base: Rajajinagar, Bengaluru 560010',12.9910,77.5550,0,NULL,'UAT staging roster home base','founder_seed',1789300000000 WHERE NOT EXISTS (SELECT 1 FROM provider_home_base WHERE provider_id='uatcap_groom_west_7');
INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) SELECT 'UAT-PHB-uatcap_groom_west_8','uatcap_groom_west_8','UAT base: Rajajinagar, Bengaluru 560010',12.9910,77.5550,0,NULL,'UAT staging roster home base','founder_seed',1789300000000 WHERE NOT EXISTS (SELECT 1 FROM provider_home_base WHERE provider_id='uatcap_groom_west_8');
INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) SELECT 'UAT-PHB-uatcap_groom_central_6','uatcap_groom_central_6','UAT base: Ulsoor, Bengaluru 560008',12.9810,77.6200,0,NULL,'UAT staging roster home base','founder_seed',1789300000000 WHERE NOT EXISTS (SELECT 1 FROM provider_home_base WHERE provider_id='uatcap_groom_central_6');
INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) SELECT 'UAT-PHB-uatcap_groom_central_7','uatcap_groom_central_7','UAT base: Ulsoor, Bengaluru 560008',12.9810,77.6200,0,NULL,'UAT staging roster home base','founder_seed',1789300000000 WHERE NOT EXISTS (SELECT 1 FROM provider_home_base WHERE provider_id='uatcap_groom_central_7');
INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) SELECT 'UAT-PHB-uatcap_groom_central_8','uatcap_groom_central_8','UAT base: Ulsoor, Bengaluru 560008',12.9810,77.6200,0,NULL,'UAT staging roster home base','founder_seed',1789300000000 WHERE NOT EXISTS (SELECT 1 FROM provider_home_base WHERE provider_id='uatcap_groom_central_8');

INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) SELECT 'UAT-PHB-uatcap_train_ft','uatcap_train_ft','UAT base: MG Road, Bengaluru 560001',12.9756,77.6066,0,NULL,'UAT staging roster home base','founder_seed',1789300000000 WHERE NOT EXISTS (SELECT 1 FROM provider_home_base WHERE provider_id='uatcap_train_ft');
INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) SELECT 'UAT-PHB-uatcap_train_ft_2','uatcap_train_ft_2','UAT base: MG Road, Bengaluru 560001',12.9756,77.6066,0,NULL,'UAT staging roster home base','founder_seed',1789300000000 WHERE NOT EXISTS (SELECT 1 FROM provider_home_base WHERE provider_id='uatcap_train_ft_2');
INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) SELECT 'UAT-PHB-uatcap_train_ft_3','uatcap_train_ft_3','UAT base: MG Road, Bengaluru 560001',12.9756,77.6066,0,NULL,'UAT staging roster home base','founder_seed',1789300000000 WHERE NOT EXISTS (SELECT 1 FROM provider_home_base WHERE provider_id='uatcap_train_ft_3');
INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) SELECT 'UAT-PHB-uatcap_train_ft_4','uatcap_train_ft_4','UAT base: MG Road, Bengaluru 560001',12.9756,77.6066,0,NULL,'UAT staging roster home base','founder_seed',1789300000000 WHERE NOT EXISTS (SELECT 1 FROM provider_home_base WHERE provider_id='uatcap_train_ft_4');
INSERT INTO provider_home_base (id,provider_id,address,latitude,longitude,effective_from,effective_until,reason,updated_by,created_at) SELECT 'UAT-PHB-uatcap_train_ft_5','uatcap_train_ft_5','UAT base: MG Road, Bengaluru 560001',12.9756,77.6066,0,NULL,'UAT staging roster home base','founder_seed',1789300000000 WHERE NOT EXISTS (SELECT 1 FROM provider_home_base WHERE provider_id='uatcap_train_ft_5');
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
-- provider's work orders. Groomers use 9000000901-907, trainers 9000000931-936, and the four more
-- Training Team seats 9000000937-940.
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS provider_identity_links (email TEXT PRIMARY KEY,provider_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',verified_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
INSERT INTO provider_identity_links (email,provider_id,status,verified_at,updated_at) VALUES ('asha.groomer1@tkpetcare.in','uatcap_groom_ft','active',1785542400000,1785542400000) ON CONFLICT(email) DO UPDATE SET provider_id=excluded.provider_id,status='active',verified_at=excluded.verified_at,updated_at=excluded.updated_at;

CREATE TABLE IF NOT EXISTS canonical_providers (id TEXT PRIMARY KEY,city_id TEXT,name TEXT NOT NULL,phone TEXT NOT NULL UNIQUE,email TEXT,source TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
-- Manual-test reserve groomers: 9000000951-953 east, 954-956 south, 957-959 north, 960-962 west, 963-965 central.
-- Upsert on id (the trainers below use 9000000931-936, and an earlier seed had given these rows numbers in
-- that range): a row that already exists is renumbered so every synthetic number stays unique.
INSERT INTO canonical_providers (id,city_id,name,phone,email,source,created_at,updated_at) VALUES
 ('uatcap_groom_east_6','blr','Neha O. (UAT East 6)','9000000951',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('uatcap_groom_east_7','blr','Rajesh Q. (UAT East 7)','9000000952',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('uatcap_groom_east_8','blr','Sunil W. (UAT East 8)','9000000953',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('uatcap_groom_south_6','blr','Divya Z. (UAT South 6)','9000000954',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('uatcap_groom_south_7','blr','Arun X. (UAT South 7)','9000000955',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('uatcap_groom_south_8','blr','Meghna B. (UAT South 8)','9000000956',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('uatcap_groom_north_6','blr','Kavitha U. (UAT North 6)','9000000957',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('uatcap_groom_north_7','blr','Praveen I. (UAT North 7)','9000000958',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('uatcap_groom_north_8','blr','Shalini L. (UAT North 8)','9000000959',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('uatcap_groom_west_6','blr','Ganesh M. (UAT West 6)','9000000960',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('uatcap_groom_west_7','blr','Ritu N. (UAT West 7)','9000000961',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('uatcap_groom_west_8','blr','Vinay K. (UAT West 8)','9000000962',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('uatcap_groom_central_6','blr','Aisha R. (UAT Central 6)','9000000963',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('uatcap_groom_central_7','blr','Mohan T. (UAT Central 7)','9000000964',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('uatcap_groom_central_8','blr','Latha S. (UAT Central 8)','9000000965',NULL,'uat_staging_seed',1789300000000,1789300000000)
 ON CONFLICT(id) DO UPDATE SET phone=excluded.phone,name=excluded.name,updated_at=excluded.updated_at;
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
 ('uatcap_train_central','blr','Rohan D. (UAT Central)','9000000936',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('uatcap_train_ft_2','blr','PawSpace Training Team 2 (UAT)','9000000937',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('uatcap_train_ft_3','blr','PawSpace Training Team 3 (UAT)','9000000938',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('uatcap_train_ft_4','blr','PawSpace Training Team 4 (UAT)','9000000939',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('uatcap_train_ft_5','blr','PawSpace Training Team 5 (UAT)','9000000940',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('host_arjun_tara','blr','Arjun & Tara','9000000970',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('host_maa_meena','blr','Meena & Karthik','9000000971',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('host_maya_rohan','blr','Maya & Rohan','9000000972',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('host_priya_dev','blr','Priya & Dev','9000000973',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('host_sana','blr','Sana F.','9000000974',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('sit_asha','blr','Asha R.','9000000975',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('sit_neha','blr','Neha P.','9000000976',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('sit_sana','blr','Sana F.','9000000977',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('taxi_imran','blr','Imran A.','9000000978',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('taxi_maa_arun','blr','Arun V.','9000000979',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('taxi_meera','blr','Meera S.','9000000980',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('taxi_rahul','blr','Rahul K.','9000000981',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('uatcap_host_cm','blr','PawSpace Boarding Host (UAT)','9000000982',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('uatcap_sit_cm','blr','PawSpace Sitter (UAT)','9000000983',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('uatcap_taxi_ft','blr','PawSpace Pet Taxi (UAT)','9000000984',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('uatcap_walk_ft','blr','PawSpace Walker (UAT)','9000000985',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('walk_asha','blr','Asha R.','9000000986',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('walk_kiran','blr','Kiran M.','9000000987',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('walk_maa_divya','blr','Divya R.','9000000988',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('walk_nisha','blr','Nisha P.','9000000989',NULL,'uat_staging_seed',1789300000000,1789300000000);
-- Partner OTP numbers for the extra per-zone groomers: 9000000911-912 east, 913-914 south, 915-916 north,
-- 917-918 west, 919-920 central; headroom teams 921-922 east, 923-924 south, 925-926 north, 927-928 west,
-- 929-930 central.
INSERT OR IGNORE INTO canonical_providers (id,city_id,name,phone,email,source,created_at,updated_at) VALUES
 ('uatcap_groom_east_2','blr','Tanvi P. (UAT East 2)','9000000911',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('uatcap_groom_east_3','blr','Vikram L. (UAT East 3)','9000000912',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('uatcap_groom_south_2','blr','Farah A. (UAT South 2)','9000000913',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('uatcap_groom_south_3','blr','Manoj K. (UAT South 3)','9000000914',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('uatcap_groom_north_2','blr','Sneha C. (UAT North 2)','9000000915',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('uatcap_groom_north_3','blr','Deepak H. (UAT North 3)','9000000916',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('uatcap_groom_west_2','blr','Lakshmi J. (UAT West 2)','9000000917',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('uatcap_groom_west_3','blr','Karan Y. (UAT West 3)','9000000918',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('uatcap_groom_central_2','blr','Pooja E. (UAT Central 2)','9000000919',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('uatcap_groom_central_3','blr','Aditya F. (UAT Central 3)','9000000920',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('uatcap_groom_east_4','blr','Ishaan R. (UAT East 4)','9000000921',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('uatcap_groom_east_5','blr','Nandini S. (UAT East 5)','9000000922',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('uatcap_groom_south_4','blr','Bhavana T. (UAT South 4)','9000000923',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('uatcap_groom_south_5','blr','Kiran V. (UAT South 5)','9000000924',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('uatcap_groom_north_4','blr','Rekha M. (UAT North 4)','9000000925',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('uatcap_groom_north_5','blr','Sameer J. (UAT North 5)','9000000926',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('uatcap_groom_west_4','blr','Anjali D. (UAT West 4)','9000000927',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('uatcap_groom_west_5','blr','Harish P. (UAT West 5)','9000000928',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('uatcap_groom_central_4','blr','Preethi N. (UAT Central 4)','9000000929',NULL,'uat_staging_seed',1789300000000,1789300000000),
 ('uatcap_groom_central_5','blr','Varun G. (UAT Central 5)','9000000930',NULL,'uat_staging_seed',1789300000000,1789300000000);

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
-- Overnight-capable UAT services must remain bookable across midnight. Repair existing authored
-- Pet Sitting roster rows first: INSERT OR IGNORE alone would preserve an older 06:00-22:00 row and
-- make the default overnight Sitting journey impossible even though the sitter is active. This only
-- touches synthetic uatcap_* roster rows; partner_app / operations availability remains authoritative.
UPDATE scheduling_availability
SET windows_json='["00:00-23:59"]',updated_at=strftime('%s','now')*1000
WHERE source='roster'
  AND provider_id IN (
    SELECT id FROM provider_capacity_profiles
    WHERE id LIKE 'uatcap\_%' ESCAPE '\' AND services_json LIKE '%"pet_sitting"%'
  );
WITH RECURSIVE days(d,n) AS (SELECT date('now','-1 day'),0 UNION ALL SELECT date(d,'+1 day'),n+1 FROM days WHERE n<16)
INSERT OR IGNORE INTO scheduling_availability (id,provider_id,city_id,zone_id,date,windows_json,source,updated_at)
SELECT 'uatseed_'||p.id||'_'||days.d||'_'||z.value,p.id,p.city_id,z.value,days.d,CASE WHEN p.services_json LIKE '%"boarding"%' OR p.services_json LIKE '%"pet_sitting"%' THEN '["00:00-23:59"]' ELSE '["06:00-22:00"]' END,'roster',strftime('%s','now')*1000
FROM provider_capacity_profiles p,json_each(p.zones_json) z,days
WHERE p.id LIKE 'uatcap\_%' ESCAPE '\';

-- ---------------------------------------------------------------------------------------------------
-- 4. PUNCTUALITY / GPS TRACKING POLICY. The partner arrival gate ("Mark arrived") needs fresh trusted GPS
--    evidence within 250 m of the doorstep, and GPS telemetry (POST /api/grooming-route) fails closed
--    unless an approved, tracking-enabled punctuality policy exists for the service
--    (lib/universal-location-recovery.ts activePunctualityPolicy): without one every fix is refused with
--    "configuration_required: punctuality_policy:grooming" and no partner can ever mark arrival on
--    staging. Publish the same UAT policy the local e2e seed uses (scripts/e2e/seed-identities.mjs),
--    city-wide, for the two doorstep services. INSERT OR IGNORE: a policy authored through Ops
--    (location-recovery save_policy) is never overridden. location_control_settings ('global',
--    gps_ingestion_enabled=1) is created by the runtime itself.
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS booking_punctuality_policies (id TEXT PRIMARY KEY,service_code TEXT NOT NULL,city_id TEXT,provider_model TEXT,tracking_enabled INTEGER NOT NULL DEFAULT 0,eta_freshness_seconds INTEGER,allowed_accuracy_meters REAL,grace_minutes INTEGER,customer_alert_minutes INTEGER,ops_escalation_minutes INTEGER,reassignment_minutes INTEGER,evidence_requirements_json TEXT NOT NULL DEFAULT '[]',excluded_reasons_json TEXT NOT NULL DEFAULT '[]',raw_gps_retention_days INTEGER,approval_state TEXT NOT NULL DEFAULT 'draft',effective_from TEXT NOT NULL,effective_to TEXT,approved_by TEXT,updated_at INTEGER NOT NULL);
INSERT OR IGNORE INTO booking_punctuality_policies (id,service_code,city_id,provider_model,tracking_enabled,eta_freshness_seconds,allowed_accuracy_meters,grace_minutes,customer_alert_minutes,ops_escalation_minutes,reassignment_minutes,evidence_requirements_json,excluded_reasons_json,raw_gps_retention_days,approval_state,effective_from,effective_to,approved_by,updated_at) VALUES
 ('UAT-GPS-GROOMING','grooming',NULL,NULL,1,300,50,10,15,20,30,'["foreground_gps"]','[]',30,'approved','2026-01-01',NULL,'founder_seed',1789300000000),
 ('UAT-GPS-DOG-TRAINING','dog_training',NULL,NULL,1,300,50,10,15,20,30,'["foreground_gps"]','[]',30,'approved','2026-01-01',NULL,'founder_seed',1789300000000);

-- ---------------------------------------------------------------------------------------------------
-- UAT-ONLY placeholder trainer compensation rule (LP-N17, owner decision 2026-09-22).
--
-- Why this exists: a completed Training session resolves its rate through training_compensation_rules
-- (city, optional provider, optional package, published, inside its effective window). Staging had no
-- published rule at all, so every completed session was held at 'pending rate configuration - No
-- published trainer compensation rule matches this completed session' and trainer earnings, payout
-- statements and the Finance training views could not be exercised by a tester at all.
--
-- THIS IS NOT A COMPENSATION POLICY. The rate is a round, obviously synthetic sandbox number so the
-- flow can be driven end to end; provider_id and package_code are NULL so it covers every seeded
-- trainer and package. Finance publishes the real rule, which supersedes this one on version order.
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS training_compensation_rules (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,provider_id TEXT,package_code TEXT,rate_type TEXT NOT NULL DEFAULT 'per_completed_session',rate_value REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',status TEXT NOT NULL DEFAULT 'published',version INTEGER NOT NULL DEFAULT 1,effective_from TEXT NOT NULL,effective_to TEXT,updated_by TEXT NOT NULL,reason TEXT NOT NULL,updated_at INTEGER NOT NULL);
INSERT OR IGNORE INTO training_compensation_rules (id,city_id,provider_id,package_code,rate_type,rate_value,currency,status,version,effective_from,effective_to,updated_by,reason,updated_at) VALUES
 ('UAT-TRAINER-RATE-BLR','blr',NULL,NULL,'per_completed_session',1000,'INR','published',1,'2026-01-01',NULL,'uat_staging_seed','UAT-ONLY-NOT-PRODUCTION: placeholder sandbox rate so trainer earnings can be tested. Not a compensation policy.',1789300000000);

-- ---------------------------------------------------------------------------------------------------
-- AI AUDIENCE ROLLOUT (owner decision 2026-09-22, decision 3 of 10).
--
-- The customer AI is open to CUSTOMERS in UAT only. Staging defaulted to 'off', so a tester talking to
-- the assistant on /chat reached a human handoff every time and the customer AI could not be exercised
-- at all - the rollout stage was never something a tester could get past, because widening it is a
-- settings.manage action on /team/ai/rollout that no UAT persona holds.
--
-- Opening it here is safe because the stage is NOT a standing permission: lib/ai-audience-rollout.ts
-- only honours 'customers' on a UAT deployment (PAWSPACE_DEPLOYMENT_ENV in local/preview/staging/uat/e2e)
-- and fails closed everywhere else, so this row cannot open the AI to customers if the database is ever
-- restored or promoted somewhere it should not be. The provider gate is untouched: with no provider key
-- the assistant still hands off honestly rather than inventing an answer.
--
-- The UPDATE is the upward repair for staging databases that already carry a seeded row. It is scoped to
-- rows the SEEDS own, so a human who deliberately set the stage on /team/ai/rollout keeps their choice -
-- a seed must never overrule a person, in either direction.
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_audience_rollout (id INTEGER PRIMARY KEY CHECK(id=1),stage TEXT NOT NULL DEFAULT 'off',reason TEXT,updated_by TEXT NOT NULL,updated_at INTEGER NOT NULL);
INSERT OR IGNORE INTO ai_audience_rollout (id,stage,reason,updated_by,updated_at) VALUES
 (1,'customers','UAT-ONLY: owner decision 2026-09-22 opens the assistant to customers on UAT deployments so human testers can exercise it. Honoured only where PAWSPACE_DEPLOYMENT_ENV is a UAT environment.','uat_staging_seed',1789300000000);
UPDATE ai_audience_rollout SET stage='customers',reason='UAT-ONLY: owner decision 2026-09-22 opens the assistant to customers on UAT deployments so human testers can exercise it. Honoured only where PAWSPACE_DEPLOYMENT_ENV is a UAT environment.',updated_by='uat_staging_seed',updated_at=1789300000000 WHERE id=1 AND stage IN ('off','staff_only') AND updated_by IN ('uat_staging_seed','founder_seed','founder@pawspace.in');

-- UPWARD REPAIR for the trainer rate above, the same shape as the provider acceptance windows in #968.
--
-- INSERT OR IGNORE leaves an existing row exactly as it was, so a staging database that already carries
-- UAT-TRAINER-RATE-BLR in a draft or superseded state keeps it, every completed session stays held at
-- 'pending rate configuration', and trainer earnings remain untestable - which is the whole reason the
-- row was added. The repair only publishes the seed's OWN row (updated_by='uat_staging_seed', carrying
-- the UAT-ONLY marker) and does not touch the rate: a rate is a commercial figure, and raising one
-- automatically would be inventing compensation policy rather than repairing a seed. Finance's own
-- published rule supersedes this one on version order and is never modified here.
UPDATE training_compensation_rules SET status='published',updated_at=1789300000000 WHERE id='UAT-TRAINER-RATE-BLR' AND status!='published' AND updated_by='uat_staging_seed' AND reason LIKE 'UAT-ONLY-NOT-PRODUCTION:%';

-- ---------------------------------------------------------------------------------------------------
-- 5. UAT GROOMER DRIFT REPAIR. Testers change the shared staging roster: /control Provider Capacity "Save"
--    rewrites updated_by to their email (the scheduler then drops the groomer before evaluation), a partner
--    "unavailable" toggle writes a 10-year provider_unavailability row, trust-safety strikes and verification
--    holds set live=0. Every run of this file puts the seeded grooming roster back to bookable. Seeded ids only
--    (uatcap_groom* and the runtime east defaults); partner_app / operations availability rows are untouched.
-- ---------------------------------------------------------------------------------------------------
UPDATE provider_capacity_profiles
SET updated_by='founder_seed',live=1,status='active',version=version+1,updated_at=strftime('%s','now')*1000
WHERE (id LIKE 'uatcap\_groom%' ESCAPE '\' OR id IN ('groom_arun','groom_kiran','groom_sanjay'))
  AND (updated_by!='founder_seed' OR live!=1 OR status!='active');
CREATE TABLE IF NOT EXISTS provider_unavailability (id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,starts_at TEXT NOT NULL,ends_at TEXT NOT NULL,reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
UPDATE provider_unavailability
SET status='cleared',ends_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),updated_at=strftime('%s','now')*1000
WHERE status='active' AND (provider_id LIKE 'uatcap\_groom%' ESCAPE '\' OR provider_id IN ('groom_arun','groom_kiran','groom_sanjay'));
