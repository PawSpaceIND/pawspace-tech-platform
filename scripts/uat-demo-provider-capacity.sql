-- PawSpace UAT governed provider capacity seed.
-- Deterministic and re-runnable; intended for staging/UAT only.
-- These are the same canonical demo providers owned by lib/provider-capacity-governance.ts.

CREATE TABLE IF NOT EXISTS provider_capacity_profiles (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,provider_model TEXT NOT NULL,services_json TEXT NOT NULL,zones_json TEXT NOT NULL,live INTEGER NOT NULL DEFAULT 1,rating REAL NOT NULL DEFAULT 0,quality_score REAL NOT NULL DEFAULT 0,capacity INTEGER NOT NULL DEFAULT 1,travel_buffer_minutes INTEGER NOT NULL DEFAULT 30,max_daily_jobs INTEGER NOT NULL DEFAULT 6,acceptance_timeout_minutes INTEGER NOT NULL DEFAULT 3,status TEXT NOT NULL DEFAULT 'active',version INTEGER NOT NULL DEFAULT 1,effective_from TEXT NOT NULL,effective_to TEXT,updated_by TEXT NOT NULL,updated_at INTEGER NOT NULL);

INSERT OR IGNORE INTO provider_capacity_profiles VALUES ('groom_arun','blr','Arun R.','full_time','["grooming"]','["blr-east"]',1,4.9,96,1,30,4,0,'active',1,'2026-08-01',NULL,'uat_demo_seed',1786600800000);
INSERT OR IGNORE INTO provider_capacity_profiles VALUES ('groom_kiran','blr','Kiran S.','commission','["grooming"]','["blr-east"]',1,4.8,92,1,30,5,3,'active',1,'2026-08-01',NULL,'uat_demo_seed',1786600800000);
INSERT OR IGNORE INTO provider_capacity_profiles VALUES ('train_kiran','blr','Kiran S.','commission','["dog_training"]','["blr-east"]',1,4.9,95,1,45,4,3,'active',1,'2026-08-01',NULL,'uat_demo_seed',1786600800000);
INSERT OR IGNORE INTO provider_capacity_profiles VALUES ('train_meera','blr','Meera T.','commission','["dog_training"]','["blr-east"]',1,4.7,89,1,45,4,3,'active',1,'2026-08-01',NULL,'uat_demo_seed',1786600800000);
INSERT OR IGNORE INTO provider_capacity_profiles VALUES ('host_maya_rohan','blr','Maya & Rohan','commission','["boarding"]','["blr-east"]',1,4.9,96,4,0,12,3,'active',1,'2026-08-01',NULL,'uat_demo_seed',1786600800000);
INSERT OR IGNORE INTO provider_capacity_profiles VALUES ('host_sana','blr','Sana F.','commission','["boarding"]','["blr-east"]',1,4.8,92,3,0,10,3,'active',1,'2026-08-01',NULL,'uat_demo_seed',1786600800000);
INSERT OR IGNORE INTO provider_capacity_profiles VALUES ('sit_neha','blr','Neha P.','commission','["pet_sitting"]','["blr-east"]',1,4.8,92,4,30,6,3,'active',1,'2026-08-01',NULL,'uat_demo_seed',1786600800000);
INSERT OR IGNORE INTO provider_capacity_profiles VALUES ('walk_nisha','blr','Nisha P.','commission','["dog_walking"]','["blr-east"]',1,4.9,96,1,20,10,3,'active',1,'2026-08-01',NULL,'uat_demo_seed',1786600800000);
INSERT OR IGNORE INTO provider_capacity_profiles VALUES ('walk_kiran','blr','Kiran M.','commission','["dog_walking"]','["blr-east"]',1,4.8,92,1,20,10,3,'active',1,'2026-08-01',NULL,'uat_demo_seed',1786600800000);
INSERT OR IGNORE INTO provider_capacity_profiles VALUES ('taxi_rahul','blr','Rahul K.','full_time','["pet_taxi"]','["blr-east"]',1,4.9,96,1,20,8,3,'active',1,'2026-08-01',NULL,'uat_demo_seed',1786600800000);
INSERT OR IGNORE INTO provider_capacity_profiles VALUES ('taxi_meera','blr','Meera S.','full_time','["pet_taxi"]','["blr-east"]',1,4.8,92,1,20,8,3,'active',1,'2026-08-01',NULL,'uat_demo_seed',1786600800000);
