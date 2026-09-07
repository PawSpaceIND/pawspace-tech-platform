#!/usr/bin/env node
/*
 * Seed dedicated E2E identities into the LOCAL Miniflare D1, before the Playwright suite runs.
 * Deliberately NOT using lib/development-preview.ts: these are real governed actor roles.
 */
import { DatabaseSync } from "node:sqlite";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

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
  admin:    { id: "E2E-USR-ADMIN", email: "e2e.admin@pawspace.test", role: "admin", name: "E2E Admin" },
  finance:  { id: "E2E-USR-FINANCE", email: "e2e.finance@pawspace.test", role: "finance", name: "E2E Finance" },
};
export const CUSTOMER_ID = "E2E-CUS-UI-001";
export const PROVIDER_ID = "E2E-PRV-UI-001";
export const BOOKING_ID = "E2E-BK-UI-001";

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
  const now = Date.now();
  const out = [];

  db.exec("CREATE TABLE IF NOT EXISTS provider_capacity_profiles (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,provider_model TEXT NOT NULL,services_json TEXT NOT NULL,zones_json TEXT NOT NULL,live INTEGER NOT NULL DEFAULT 1,rating REAL NOT NULL DEFAULT 0,quality_score REAL NOT NULL DEFAULT 0,capacity INTEGER NOT NULL DEFAULT 1,travel_buffer_minutes INTEGER NOT NULL DEFAULT 30,max_daily_jobs INTEGER NOT NULL DEFAULT 6,acceptance_timeout_minutes INTEGER NOT NULL DEFAULT 3,status TEXT NOT NULL DEFAULT 'active',version INTEGER NOT NULL DEFAULT 1,effective_from TEXT NOT NULL,effective_to TEXT,updated_by TEXT NOT NULL,updated_at INTEGER NOT NULL)");

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
  out.push(upsert(db, "customer_identity_links", {
    email: IDENTITIES.customer.email, customer_id: CUSTOMER_ID, status: "active", verified_at: now, updated_at: now,
  }));
  out.push(upsert(db, "provider_identity_links", {
    email: IDENTITIES.provider.email, provider_id: PROVIDER_ID, status: "active", verified_at: now, updated_at: now,
  }));
  out.push(upsert(db, "provider_capacity_profiles", {
    id: PROVIDER_ID, city_id: "blr", name: "E2E UI Provider", provider_model: "commission",
    services_json: '["grooming"]', zones_json: '["blr-east"]', live: 1,
    rating: 4.9, quality_score: 95, capacity: 1, travel_buffer_minutes: 30,
    max_daily_jobs: 6, acceptance_timeout_minutes: 3, status: "active", version: 1,
    effective_from: "2026-08-01", effective_to: null, updated_by: "e2e:seed", updated_at: now,
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
