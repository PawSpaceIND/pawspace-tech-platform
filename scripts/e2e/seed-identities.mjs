#!/usr/bin/env node
/*
 * Seed dedicated E2E identities into the LOCAL Miniflare D1, before the Playwright suite runs.
 *
 * Deliberately NOT using lib/development-preview.ts. That grants superuser ["*"] on localhost, and a
 * customer or partner journey driven as a superuser proves nothing about the real permission model -
 * it is the same trap that lets 185 of the existing tests pass for the wrong reason. These are three
 * real rows in app_users with three real role codes, plus the customer/provider/booking records the
 * journeys need.
 *
 * Writes directly to the Miniflare SQLite file rather than through the app, so seeding cannot itself
 * be the thing under test.
 */
import { DatabaseSync } from "node:sqlite";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/*
 * Wrangler resolves its .wrangler/state directory relative to the CONFIG FILE, not the repo root.
 * scripts/e2e/serve.sh passes --config dist/server/wrangler.json, so the server's D1 lives under
 * dist/server/.wrangler - NOT the repo-root .wrangler that the node test suite uses.
 *
 * Both exist, and the root one is much larger, so "pick the biggest sqlite" seeds the wrong database
 * and every browser journey then fails with "Access has not been provisioned". Cost me a debugging
 * round; hence the explicit order and the E2E_D1_PATH escape hatch.
 */
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
  admin:    { id: "E2E-USR-ADMIN",    email: "e2e.admin@pawspace.test",    role: "admin",            name: "E2E Admin" },
};
export const CUSTOMER_ID = "E2E-CUS-UI-001";
export const PROVIDER_ID = "E2E-PRV-UI-001";
export const BOOKING_ID  = "E2E-BK-UI-001";

const has = (db, table) => Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));
const cols = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);

/*
 * Insert only the columns that actually exist, and fill any NOT NULL column the caller did not
 * supply. Both halves matter: the first means a schema change cannot break seeding with an unknown
 * column, the second means it cannot break with a newly-required one. Discovered the hard way -
 * canonical_pets requires updated_at, which this fixture did not know about.
 */
function upsert(db, table, row) {
  if (!has(db, table)) return { table, skipped: "no such table" };
  const info = db.prepare(`PRAGMA table_info(${table})`).all();
  const available = new Set(info.map((c) => c.name));
  const filled = { ...row };
  for (const c of info) {
    if (c.notnull && c.dflt_value === null && filled[c.name] === undefined) {
      // Required, no default, not supplied. Choose by declared type so the row is still meaningful.
      const type = String(c.type || "").toUpperCase();
      filled[c.name] = /INT|REAL|NUM/.test(type) ? (/_at$/.test(c.name) ? Date.now() : 0) : `e2e:${c.name}`;
    }
  }
  const keys = Object.keys(filled).filter((k) => available.has(k));
  if (!keys.length) return { table, skipped: "no matching columns" };
  const sql = `INSERT OR REPLACE INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`;
  db.prepare(sql).run(...keys.map((k) => filled[k]));
  return { table, wrote: keys.length };
}

export function seed(dbPath = locateDb()) {
  const db = new DatabaseSync(dbPath);
  const now = Date.now();
  const out = [];

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
    id: "E2E-PET-UI-001", customer_id: CUSTOMER_ID, name: "Bruno", species: "dog",
    breed: "indie", weight_kg: 14, created_at: now,
  }));
  out.push(upsert(db, "canonical_providers", {
    id: PROVIDER_ID, name: "E2E UI Provider", phone: "9800000222", city_id: "blr",
    status: "active", engagement_model: "commission_standard", created_at: now, updated_at: now,
  }));

  const start = new Date(now + 3 * 86400000).toISOString();
  const end = new Date(now + 3 * 86400000 + 7200000).toISOString();
  out.push(upsert(db, "canonical_bookings", {
    id: BOOKING_ID, customer_id: CUSTOMER_ID, city_id: "blr", zone_id: "z1",
    service_code: "pet_grooming", package_code: "pkg-std", package_name: "Standard Groom",
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
    provider_id: PROVIDER_ID, provider_name: "E2E UI Provider", provider_model: "commission_standard",
    service_code: "pet_grooming", scheduled_start: start, scheduled_end: end,
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
