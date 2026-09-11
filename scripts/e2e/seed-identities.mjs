#!/usr/bin/env node
/*
 * Seed dedicated E2E identities into the LOCAL Miniflare D1, before the Playwright suite runs.
 * Deliberately NOT using lib/development-preview.ts: these are real governed actor roles.
 */
import { DatabaseSync } from "node:sqlite";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { defaultRoles } from "../../lib/platform-security.ts";

const D1_DIRS = [
  "dist/server/.wrangler/state/v3/d1/miniflare-D1DatabaseObject",
  ".wrangler/state/v3/d1/miniflare-D1DatabaseObject",
];

function locateDb() {
  if (process.env.E2E_D1_PATH) return process.env.E2E_D1_PATH;
  for (const dir of D1_DIRS) {
    let entries;
    try { entries = readdirSync(dir); } catch { continue; }
    const files = entries
      .filter((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite")
      .map((f) => ({ f, size: statSync(join(dir, f)).size }))
      .sort((a, b) => b.size - a.size);
    if (files.length) return join(dir, files[0].f);
  }
  throw new Error(`no Miniflare D1 file in ${D1_DIRS.join(" or ")} - start the dev server first`);
}

export const IDENTITIES = {
  customer: { id: "E2E-USR-CUSTOMER", email: "e2e.customer@pawspace.test", role: "customer", name: "E2E Customer" },
  provider: { id: "E2E-USR-PROVIDER", email: "e2e.provider@pawspace.test", role: "service_provider", name: "E2E Provider" },
  autoGroomer: { id: "E2E-USR-AUTO-GROOMER", email: "e2e.auto.groomer@pawspace.test", role: "service_provider", name: "E2E Auto Groomer" },
  groomKiran: { id: "E2E-USR-GROOM-KIRAN", email: "e2e.groom.kiran@pawspace.test", role: "service_provider", name: "E2E Groom Kiran" },
  groomSanjay: { id: "E2E-USR-GROOM-SANJAY", email: "e2e.groom.sanjay@pawspace.test", role: "service_provider", name: "E2E Groom Sanjay" },
  admin:    { id: "E2E-USR-ADMIN", email: "e2e.admin@pawspace.test", role: "admin", name: "E2E Admin" },
  finance:  { id: "E2E-USR-FINANCE", email: "e2e.finance@pawspace.test", role: "finance", name: "E2E Finance" },
};
export const CUSTOMER_ID = "E2E-CUS-UI-001";
export const PROVIDER_ID = "E2E-PRV-UI-001";
export const BOOKING_ID = "E2E-BK-UI-001";
const PROVIDER_APPLICATION_ID = "E2E-POAPP-UI-001";

const has = (db, table) => Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));

function upsert(db, table, row) {
  if (!has(db, table)) return { table, skipped: "no such table" };
  const info = db.prepare(`PRAGMA table_info(${table})`).all();
  const available = new Set(info.map((c) => c.name));
  const filled = { ...row };
  for (const c of info) {
    if (c.notnull && c.dflt_value === null && filled[c.name] === undefined) {
      const type = String(c.type || "").toUpperCase();
      filled[c.name] = /INT|REAL|NUM/.test(type) ? (/_at$/.test(c.name) ? Date.now() : 0) : `e2e:${c.name}`;
    }
  }
  const keys = Object.keys(filled).filter((k) => available.has(k));
  if (!keys.length) return { table, skipped: "no matching columns" };
  db.prepare(`INSERT OR REPLACE INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...keys.map((k) => filled[k]));
  return { table, wrote: keys.length };
}

export function seed(dbPath = locateDb()) {
  const db = new DatabaseSync(dbPath);
  // The hardened runner stops Wrangler before seeding, but workerd can retain the final SQLite
  // writer lock briefly after the port closes. Wait a bounded interval for that local lock instead
  // of turning a clean shutdown race into a false E2E failure.
  db.exec("PRAGMA busy_timeout=5000");
  const now = Date.now();
  const out = [];

  // A disposable browser D1 starts almost empty. Seed identities only after the same canonical
  // authorization/customer/booking tables used by production code exist; otherwise the generic
  // upsert helper intentionally skips them and the first governed API request correctly returns 403.
  // This is schema/bootstrap only — it does not bypass authorization or grant test-only permissions.
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role_code TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS role_definitions (code TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, permissions_json TEXT NOT NULL, system_role INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'customer_app',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS canonical_pets (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,name TEXT NOT NULL,species TEXT NOT NULL,breed TEXT,vaccination_status TEXT NOT NULL DEFAULT 'not_provided',source_pet_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS canonical_providers (id TEXT PRIMARY KEY,city_id TEXT,name TEXT NOT NULL,phone TEXT NOT NULL UNIQUE,email TEXT,source TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS customer_identity_links (email TEXT PRIMARY KEY, customer_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', verified_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS provider_identity_links (email TEXT PRIMARY KEY, provider_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', verified_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,source_pet_ids_json TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,service_code TEXT NOT NULL,package_code TEXT NOT NULL,package_name TEXT NOT NULL,schedule_group_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'confirmed',channel TEXT NOT NULL DEFAULT 'customer_app',total_amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',pricing_json TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,amount REAL NOT NULL,amount_due_now REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',method TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,gateway TEXT NOT NULL DEFAULT 'uat_sandbox',idempotency_key TEXT NOT NULL UNIQUE,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,schedule_group_id TEXT NOT NULL,provider_id TEXT NOT NULL,provider_name TEXT NOT NULL,provider_model TEXT NOT NULL,service_code TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,occurrence_count INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'assigned',assignment_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
  `);

  // Keep E2E RBAC identical to the application defaults. Tests receive no bespoke wildcard role.
  for (const role of defaultRoles) {
    out.push(upsert(db, "role_definitions", {
      code: role.code, name: role.name, description: role.description,
      permissions_json: JSON.stringify(role.permissions), system_role: 1, updated_at: now,
    }));
  }

  db.exec("CREATE TABLE IF NOT EXISTS provider_capacity_profiles (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,provider_model TEXT NOT NULL,services_json TEXT NOT NULL,zones_json TEXT NOT NULL,live INTEGER NOT NULL DEFAULT 1,rating REAL NOT NULL DEFAULT 0,quality_score REAL NOT NULL DEFAULT 0,capacity INTEGER NOT NULL DEFAULT 1,travel_buffer_minutes INTEGER NOT NULL DEFAULT 30,max_daily_jobs INTEGER NOT NULL DEFAULT 6,acceptance_timeout_minutes INTEGER NOT NULL DEFAULT 3,status TEXT NOT NULL DEFAULT 'active',version INTEGER NOT NULL DEFAULT 1,effective_from TEXT NOT NULL,effective_to TEXT,updated_by TEXT NOT NULL,updated_at INTEGER NOT NULL)");
  // The hardened multi-actor journey exercises the real server-bound ARRIVED gate. That gate must
  // fail closed unless an approved punctuality/tracking policy exists, so seed the same local-only UAT
  // policy shape used by the executable grooming journey harness rather than bypassing the guard.
  db.exec("CREATE TABLE IF NOT EXISTS booking_punctuality_policies (id TEXT PRIMARY KEY,service_code TEXT NOT NULL,city_id TEXT,provider_model TEXT,tracking_enabled INTEGER NOT NULL DEFAULT 0,eta_freshness_seconds INTEGER,allowed_accuracy_meters REAL,grace_minutes INTEGER,customer_alert_minutes INTEGER,ops_escalation_minutes INTEGER,reassignment_minutes INTEGER,evidence_requirements_json TEXT NOT NULL DEFAULT '[]',excluded_reasons_json TEXT NOT NULL DEFAULT '[]',raw_gps_retention_days INTEGER,approval_state TEXT NOT NULL DEFAULT 'draft',effective_from TEXT NOT NULL,effective_to TEXT,approved_by TEXT,updated_at INTEGER NOT NULL)");
  // Provider assignment is intentionally fail-closed when onboarding verification is absent. The
  // hardened E2E actor therefore carries a real local application plus the current grooming mandate
  // (Aadhaar + PAN) instead of relying on the founder_seed UAT exemption used by legacy fixtures.
  db.exec("CREATE TABLE IF NOT EXISTS provider_onboarding_applications (id TEXT PRIMARY KEY,provider_id TEXT,vertical_key TEXT NOT NULL,country_code TEXT NOT NULL,region_code TEXT,city_code TEXT,status TEXT NOT NULL,locale_code TEXT NOT NULL,basic_info_json TEXT NOT NULL,policy_ref TEXT,quiz_version_ref TEXT,verification_status TEXT NOT NULL DEFAULT 'not_started',quiz_status TEXT NOT NULL DEFAULT 'not_started',interview_status TEXT NOT NULL DEFAULT 'not_started',human_decision TEXT,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  db.exec("CREATE TABLE IF NOT EXISTS provider_verifications (id TEXT PRIMARY KEY,application_id TEXT NOT NULL,category TEXT NOT NULL,verification_type TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',automated INTEGER NOT NULL DEFAULT 0,provider_ref TEXT,detail_json TEXT NOT NULL DEFAULT '{}',updated_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,expires_at INTEGER,UNIQUE(application_id,verification_type))");

  for (const who of Object.values(IDENTITIES)) {
    out.push(upsert(db, "app_users", {
      id: who.id, email: who.email, name: who.name, role_code: who.role,
      status: "active", created_at: now, updated_at: now,
    }));
  }

  out.push(upsert(db, "canonical_customers", {
    id: CUSTOMER_ID, name: "E2E UI Customer", primary_phone: "9800000111",
    email: IDENTITIES.customer.email, city_id: "blr", status: "active",
    consent_json: '{"serviceUpdates":true,"marketing":false}', created_at: now, updated_at: now,
  }));
  out.push(upsert(db, "canonical_pets", {
    id: "E2E-PET-UI-001", customer_id: CUSTOMER_ID, source_pet_id: "E2E-PET-UI-001",
    name: "Bruno", species: "dog", breed: "indie", weight_kg: 14,
    vaccination_status: "vaccinated", created_at: now, updated_at: now,
  }));
  out.push(upsert(db, "canonical_providers", {
    id: PROVIDER_ID, name: "E2E UI Provider", phone: "9800000222", city_id: "blr",
    status: "active", engagement_model: "commission_standard", created_at: now, updated_at: now,
  }));
  for (const provider of [
    ["host_maya_rohan","Maya & Rohan","9000000953"], ["host_sana","Sana F.","9000000954"],
    ["host_arjun_tara","Arjun & Tara","9000000955"], ["host_priya_dev","Priya & Dev","9000000956"],
    ["sit_sana","Sana F.","9000000945"], ["sit_neha","Neha P.","9000000946"], ["sit_asha","Asha R.","9000000947"],
  ]) out.push(upsert(db, "canonical_providers", {
    id: provider[0], name: provider[1], phone: provider[2], city_id: "blr", source: "e2e_seed", created_at: now, updated_at: now,
  }));
  out.push(upsert(db, "customer_identity_links", {
    email: IDENTITIES.customer.email, customer_id: CUSTOMER_ID, status: "active", verified_at: now, updated_at: now,
  }));
  out.push(upsert(db, "provider_identity_links", {
    email: IDENTITIES.provider.email, provider_id: PROVIDER_ID, status: "active", verified_at: now, updated_at: now,
  }));
  // The real auto-ranker can select the canonical UAT full-time groomer ahead of the commission E2E
  // provider. Give that real seeded provider a local-only identity so the correlated journey follows
  // the scheduler's decision instead of forcing a test-specific assignment.
  out.push(upsert(db, "provider_identity_links", {
    email: IDENTITIES.autoGroomer.email, provider_id: "groom_arun", status: "active", verified_at: now, updated_at: now,
  }));
  out.push(upsert(db, "provider_identity_links", {
    email: IDENTITIES.groomKiran.email, provider_id: "groom_kiran", status: "active", verified_at: now, updated_at: now,
  }));
  out.push(upsert(db, "provider_identity_links", {
    email: IDENTITIES.groomSanjay.email, provider_id: "groom_sanjay", status: "active", verified_at: now, updated_at: now,
  }));
  out.push(upsert(db, "provider_capacity_profiles", {
    id: PROVIDER_ID, city_id: "blr", name: "E2E UI Provider", provider_model: "commission",
    services_json: '["grooming"]', zones_json: '["blr-east"]', live: 1,
    rating: 4.9, quality_score: 95, capacity: 1, travel_buffer_minutes: 30,
    max_daily_jobs: 6, acceptance_timeout_minutes: 3, status: "active", version: 1,
    effective_from: "2026-08-01", effective_to: null, updated_by: "e2e:seed", updated_at: now,
  }));
  out.push(upsert(db, "provider_onboarding_applications", {
    id: PROVIDER_APPLICATION_ID, provider_id: PROVIDER_ID, vertical_key: "grooming",
    country_code: "IN", region_code: "KA", city_code: "BLR", status: "verification",
    locale_code: "en", basic_info_json: "{}", verification_status: "verified",
    quiz_status: "not_started", interview_status: "not_started", created_by: "e2e:seed",
    created_at: now, updated_at: now,
  }));
  const verificationExpiry = now + 30 * 86400000;
  out.push(upsert(db, "provider_verifications", {
    id: "E2E-PVER-AADHAAR-001", application_id: PROVIDER_APPLICATION_ID, category: "groomer",
    verification_type: "aadhaar", status: "verified", automated: 1,
    detail_json: '{"source":"e2e_local_fixture"}', updated_by: "e2e:seed",
    created_at: now, updated_at: now, expires_at: verificationExpiry,
  }));
  out.push(upsert(db, "provider_verifications", {
    id: "E2E-PVER-PAN-001", application_id: PROVIDER_APPLICATION_ID, category: "groomer",
    verification_type: "pan", status: "verified", automated: 1,
    detail_json: '{"source":"e2e_local_fixture"}', updated_by: "e2e:seed",
    created_at: now, updated_at: now, expires_at: verificationExpiry,
  }));
  out.push(upsert(db, "booking_punctuality_policies", {
    id: "GPS-GROOM-E2E", service_code: "grooming", city_id: null, provider_model: null,
    tracking_enabled: 1, eta_freshness_seconds: 300, allowed_accuracy_meters: 50,
    grace_minutes: 10, customer_alert_minutes: 15, ops_escalation_minutes: 20,
    reassignment_minutes: 30, evidence_requirements_json: '["foreground_gps"]',
    excluded_reasons_json: '[]', raw_gps_retention_days: 30, approval_state: "approved",
    effective_from: "2020-01-01", effective_to: null, approved_by: "e2e:seed", updated_at: now,
  }));

  const start = new Date(now + 3 * 86400000).toISOString();
  const end = new Date(now + 3 * 86400000 + 7200000).toISOString();
  out.push(upsert(db, "canonical_bookings", {
    id: BOOKING_ID,
    idempotency_key: "e2e-ui-booking-001",
    customer_id: CUSTOMER_ID,
    pet_ids_json: '["E2E-PET-UI-001"]',
    source_pet_ids_json: '["E2E-PET-UI-001"]',
    city_id: "blr", zone_id: "blr-east",
    service_code: "grooming", package_code: "pkg-std", package_name: "Standard Groom",
    schedule_group_id: "E2E-SG-UI-001", provider_id: PROVIDER_ID,
    scheduled_start: start, scheduled_end: end, status: "confirmed", channel: "customer_app",
    total_amount: 1500, currency: "INR", pricing_json: "{}", created_by: "e2e:seed",
    created_at: now, updated_at: now,
  }));
  out.push(upsert(db, "booking_payments", {
    id: "E2E-PAY-UI-001", booking_id: BOOKING_ID, customer_id: CUSTOMER_ID,
    amount: 1500, amount_due_now: 1500, currency: "INR", method: "card", mode: "prepaid",
    status: "captured", gateway: "razorpay", idempotency_key: "e2e-ui-001",
    detail_json: "{}", created_at: now, updated_at: now,
  }));
  out.push(upsert(db, "provider_work_orders", {
    id: "E2E-WO-UI-001", booking_id: BOOKING_ID, schedule_group_id: "E2E-SG-UI-001",
    provider_id: PROVIDER_ID, provider_name: "E2E UI Provider", provider_model: "commission",
    service_code: "grooming", scheduled_start: start, scheduled_end: end,
    occurrence_count: 1, status: "awaiting_acceptance", created_at: now, updated_at: now,
  }));

  db.close();
  return { dbPath, results: out };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { dbPath, results } = seed();
  console.log(`seeded ${dbPath}`);
  for (const r of results) console.log(`  ${r.table}: ${r.skipped ? `SKIPPED (${r.skipped})` : `${r.wrote} cols`}`);
}
