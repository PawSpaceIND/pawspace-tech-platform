-- UAT STAGING provider roster (city-wide).
--
-- Why this exists: the scheduler assigns providers from provider_capacity_profiles filtered by
-- (city_id, service in services_json, zone in zones_json, live=1, status='active', effective window).
-- Without a matching profile the reserve path returns NO_SCHEDULE_AVAILABLE and the customer sees
-- "No provider is available for the date and time you chose." The staging deploy loads only the staff
-- directory (employee-seed.sql), so before this file staging had no bookable roster in any zone.
--
-- This seeds one full-time + one commission provider per core service, each covering EVERY Bengaluru
-- zone (blr-east/south/north/west/central), live and active, effective from the start of 2026, with a
-- generous max_daily_jobs so slots do not fill during testing. PAWSPACE_SCHEDULING_ENV="uat" on staging
-- means seedUatRoster then auto-creates scheduling_availability on the customer's reserve path, so no
-- separate availability seed is needed. Idempotent: INSERT OR IGNORE, safe to re-run.
--
-- This is UAT roster DATA on isolated staging only. It does not weaken any booking, payment, or identity
-- gate, and never touches production.

CREATE TABLE IF NOT EXISTS provider_capacity_profiles (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,provider_model TEXT NOT NULL,services_json TEXT NOT NULL,zones_json TEXT NOT NULL,live INTEGER NOT NULL DEFAULT 1,rating REAL NOT NULL DEFAULT 0,quality_score REAL NOT NULL DEFAULT 0,capacity INTEGER NOT NULL DEFAULT 1,travel_buffer_minutes INTEGER NOT NULL DEFAULT 30,max_daily_jobs INTEGER NOT NULL DEFAULT 6,acceptance_timeout_minutes INTEGER NOT NULL DEFAULT 3,status TEXT NOT NULL DEFAULT 'active',version INTEGER NOT NULL DEFAULT 1,effective_from TEXT NOT NULL,effective_to TEXT,updated_by TEXT NOT NULL,updated_at INTEGER NOT NULL);

-- Grooming: a full-time provider (auto-assigned instantly) and a commission provider, both city-wide.
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_groom_ft','blr','PawSpace Grooming Team (UAT)','full_time','["grooming"]','["blr-east","blr-south","blr-north","blr-west","blr-central"]',1,4.9,97,1,30,20,3,'active',1,'2026-01-01',NULL,'uat_staging_seed',1785542400000);
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_groom_cm','blr','PawSpace Grooming Partner (UAT)','commission','["grooming"]','["blr-east","blr-south","blr-north","blr-west","blr-central"]',1,4.8,93,1,30,20,60,'active',1,'2026-01-01',NULL,'uat_staging_seed',1785542400000);

CREATE TABLE IF NOT EXISTS provider_identity_links (email TEXT PRIMARY KEY,provider_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',verified_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
INSERT INTO provider_identity_links (email,provider_id,status,verified_at,updated_at) VALUES ('asha.groomer1@tkpetcare.in','uatcap_groom_ft','active',1785542400000,1785542400000) ON CONFLICT(email) DO UPDATE SET provider_id=excluded.provider_id,status='active',verified_at=excluded.verified_at,updated_at=excluded.updated_at;

-- Dog training (recurring): full-time so meet-and-greet + programme assign immediately.
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_train_ft','blr','PawSpace Training Team (UAT)','full_time','["dog_training"]','["blr-east","blr-south","blr-north","blr-west","blr-central"]',1,4.9,95,1,45,12,3,'active',1,'2026-01-01',NULL,'uat_staging_seed',1785542400000);

-- Boarding (host): overnight capacity for a few guest pets, city-wide.
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_host_cm','blr','PawSpace Boarding Host (UAT)','commission','["boarding"]','["blr-east","blr-south","blr-north","blr-west","blr-central"]',1,4.9,96,4,0,12,60,'active',1,'2026-01-01',NULL,'uat_staging_seed',1785542400000);

-- Pet sitting: city-wide visits.
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_sit_cm','blr','PawSpace Sitter (UAT)','commission','["pet_sitting"]','["blr-east","blr-south","blr-north","blr-west","blr-central"]',1,4.8,92,4,30,12,60,'active',1,'2026-01-01',NULL,'uat_staging_seed',1785542400000);

-- Dog walking: recurring, city-wide.
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_walk_ft','blr','PawSpace Walker (UAT)','full_time','["dog_walking"]','["blr-east","blr-south","blr-north","blr-west","blr-central"]',1,4.9,96,1,20,20,3,'active',1,'2026-01-01',NULL,'uat_staging_seed',1785542400000);

-- Pet taxi: full-time, city-wide.
INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('uatcap_taxi_ft','blr','PawSpace Pet Taxi (UAT)','full_time','["pet_taxi"]','["blr-east","blr-south","blr-north","blr-west","blr-central"]',1,4.9,96,1,20,16,3,'active',1,'2026-01-01',NULL,'uat_staging_seed',1785542400000);

-- Partner-feed identity link (legacy fallback used by /api/partner-job-feed -> ownProviderId): map the
-- seeded groomer staff email to the full-time grooming provider so that a booking auto-assigned to
-- uatcap_groom_ft appears in that groomer's /partner/jobs feed. This lets the automated persona sweep
-- prove customer booking -> partner job card end to end. Staging UAT only.
CREATE TABLE IF NOT EXISTS provider_identity_links (email TEXT PRIMARY KEY, provider_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', verified_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
INSERT OR IGNORE INTO provider_identity_links (email,provider_id,status,verified_at,updated_at) VALUES ('asha.groomer1@tkpetcare.in','uatcap_groom_ft','active',1785542400000,1785542400000);
