-- Full-access UAT founder login.
--
-- The generated seeds (employee-seed.sql / uat-demo-seed.sql) only create manager, finance, associate
-- and service_provider staff logins. None of those roles can open EVERY team module (a manager has no
-- finance.view, a finance user has no marketing.view, etc.), and docs/UAT-TESTER-GUIDE.md points testers
-- at founder@pawspace.in, which nothing actually created. This file makes that identity real so a tester
-- can sign in ONCE and reach every module.
--
-- resolveUatStaffActor (lib/uat-staging-auth.ts) resolves a login's permissions from the role_definitions
-- table and refuses any role with no definition, so both rows below are required. Idempotent
-- (INSERT OR IGNORE); safe to re-run. The CREATE TABLE guards let this file load standalone on a fresh DB.

CREATE TABLE IF NOT EXISTS role_definitions (code TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, permissions_json TEXT NOT NULL, system_role INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS app_users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role_code TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);

INSERT OR IGNORE INTO role_definitions (code,name,description,permissions_json,system_role,updated_at)
VALUES ('founder','Founder','Permanent owner-level identity with complete oversight and protected founder controls.','["*"]',1,1785542400000);

INSERT OR IGNORE INTO app_users (id,email,name,role_code,status,created_at,updated_at)
VALUES ('UATD-USR-FOUNDER','founder@pawspace.in','UAT Founder','founder','active',1705276800000,1785542400000);

-- Loginable PROVIDER phone for the Partner-app OTP flow. partner-otp (lib/partner-otp.ts) resolves a
-- provider from canonical_providers by phone; nothing seeded that table, so a phone OTP login always
-- minted a brand-new empty provider and the /partner assignments widget stayed at "Identity session
-- required". This row ties phone 9000000001 to provider groom_arun — the same provider that owns the
-- seeded grooming work orders and is linked to uat.demo.groomer@tkpetcare.in via provider_identity_links
-- — so a tester logs into the Partner app with 9000000001 (OTP shown on screen) and sees the real jobs.
CREATE TABLE IF NOT EXISTS canonical_providers (id TEXT PRIMARY KEY,city_id TEXT,name TEXT NOT NULL,phone TEXT NOT NULL UNIQUE,email TEXT,source TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
INSERT OR IGNORE INTO canonical_providers (id,city_id,name,phone,email,source,created_at,updated_at)
VALUES ('groom_arun','blr','Arun (UAT Groomer)','9000000001',NULL,'uat_demo_seed',1705276800000,1785542400000);
