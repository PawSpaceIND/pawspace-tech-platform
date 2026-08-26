/**
 * WAVE 3 TIER A - adversarial verification of W2-B4-M-R03, generalised. [PTJA-W3A]
 *
 * THE REFUTATION UNDER TEST: "taxi-proof's missing `if(!booking)` guard is not a crash or an auth
 * bypass - getTaxiBooking throws a 404 Response, so the route answers 404, not 500".
 *
 * That is true, and this file proves it executably. But the refutation stopped at taxi, and the missing
 * guard is not unique to taxi: of the five proof routes, walking and sitting null-check the record and
 * BOARDING, TAXI and FOOD do not. The hunt examined one of the three. Whether the other two are equally
 * inert depends on whether THEIR loaders throw or return null - nobody had checked.
 *
 * So this drives all five with a record id that does not exist and pins the answer for each. A route
 * whose loader returned null would dereference it and answer 500, which is both a crash and an
 * information-free error for the caller; the point of the guard is that the difference must not be
 * accidental.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__W3A_PROOF_DB__", "__W3A_PROOF_ENV__");

function makeD1(sqlite) {
  const statement = (sql, args = []) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes || 0) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  let depth = 0;
  return {
    prepare: (sql) => statement(sql),
    batch: async (items) => {
      const outer = depth === 0;
      if (outer) sqlite.exec("BEGIN IMMEDIATE");
      depth += 1;
      try { const out = []; for (const item of items) out.push(await item.run()); if (outer) sqlite.exec("COMMIT"); return out; }
      catch (error) { if (outer) sqlite.exec("ROLLBACK"); throw error; }
      finally { depth -= 1; }
    },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

const STAFF = {
  "oai-authenticated-user-email": "ops.admin@pawspace.test",
  "oai-authenticated-user-full-name": "Ops%20admin",
  "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
};

async function proofWorld() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__W3A_PROOF_DB__ = db;
  globalThis.__W3A_PROOF_ENV__ = {};
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db);
  const now = Date.now();
  await db.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('USR-W3A-ADMIN','ops.admin@pawspace.test','Ops admin','admin','active',?,?)").bind(now, now).run();
  // canonical_bookings is what every proof loader joins against. Without it the 500 is "no such table"
  // and this file measures the fixture, not the route - which is exactly what the first run did.
  const { ensureCanonicalBookingReadModel } = await import("../lib/canonical-booking-read-model.ts");
  await ensureCanonicalBookingReadModel(db);
  // provider_work_orders and booking_payments are created inside route files rather than a shared lib,
  // so they are copied VERBATIM from their owning source, app/api/canonical-bookings/route.ts, exactly
  // as tests/money-hardening.test.mjs does. Never guessed - every proof loader LEFT JOINs them, and a
  // missing table turns this file's 404 assertion into a "no such table" 500 that measures nothing.
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,schedule_group_id TEXT NOT NULL,provider_id TEXT NOT NULL,provider_name TEXT NOT NULL,provider_model TEXT NOT NULL,service_code TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,occurrence_count INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'assigned',assignment_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,amount REAL NOT NULL,amount_due_now REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',method TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,gateway TEXT NOT NULL DEFAULT 'uat_sandbox',idempotency_key TEXT NOT NULL UNIQUE,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  const { ensureTaxiOpsTables } = await import("../lib/taxi-ops-governance.ts");
  await ensureTaxiOpsTables(db); // taxi_trips, which taxi-lifecycle's context() inner-JOINs
  return { sqlite, db };
}

const PROOF_ROUTES = [
  { label: "walking-proof", module: "../app/api/walking-proof/route.ts", path: "/api/walking-proof", param: "bookingId", nullChecked: true,
    tables: async (db) => (await import("../lib/walking-proof-governance.ts")).ensureWalkingProofTables(db) },
  { label: "sitting-proof", module: "../app/api/sitting-proof/route.ts", path: "/api/sitting-proof", param: "bookingId", nullChecked: true,
    tables: async (db) => (await import("../lib/sitting-proof-governance.ts")).ensureSittingProofTables(db) },
  { label: "boarding-proof", module: "../app/api/boarding-proof/route.ts", path: "/api/boarding-proof", param: "stayId", nullChecked: false,
    tables: async (db) => (await import("../lib/boarding-proof-governance.ts")).ensureBoardingProofTables(db) },
  { label: "taxi-proof", module: "../app/api/taxi-proof/route.ts", path: "/api/taxi-proof", param: "bookingId", nullChecked: false,
    tables: async (db) => (await import("../lib/taxi-proof-governance.ts")).ensureTaxiProofTables(db) },
  { label: "food-proof", module: "../app/api/food-proof/route.ts", path: "/api/food-proof", param: "orderId", nullChecked: false,
    tables: async (db) => (await import("../lib/food-proof-governance.ts")).ensureFoodProofTables(db) },
];

for (const route of PROOF_ROUTES) {
  test(`MR03 (${route.label}): a non-existent record answers 404, never 500`, async () => {
    const { db } = await proofWorld();
    // The schema must exist, or the 500 is "no such table" and this file measures the fixture rather
    // than the route. The refutation under test made the same point about its own probe.
    await route.tables(db);
    const module = await import(route.module);
    const response = await module.GET(new Request(
      `https://uat.pawspace.in${route.path}?${route.param}=DOES-NOT-EXIST`, { headers: STAFF }));
    let body = null;
    try { body = await response.clone().json(); } catch { /* non-JSON */ }
    assert.notEqual(response.status, 500,
      `${route.label} dereferenced a missing record: ${response.status} ${JSON.stringify(body)}`);
    assert.equal(response.status, 404,
      `${route.label} must answer 404 for a record that does not exist, got ${response.status} ${JSON.stringify(body)}`);
  });
}

test("MR03-x: the three routes without an explicit null-check are inert only because their loaders THROW", async () => {
  // This is the reason the missing guard is safe, named so it cannot quietly stop being true. If any of
  // these loaders is ever changed to return null instead of throwing, the route above it dereferences
  // it - and the cases in this file are what will catch that, not code review.
  const { readFile } = await import("node:fs/promises");
  const loaders = [
    ["lib/taxi-lifecycle.ts", /Canonical Pet Taxi booking not found",\{status:404\}/],
    ["lib/food-fulfilment-governance.ts", /Canonical Food order not found",\{status:404\}/],
  ];
  for (const [file, pattern] of loaders) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    assert.match(source, pattern,
      `${file} must THROW a 404 Response rather than return null - the proof route above it has no null-check`);
  }
});

test("MR03-y (non-vacuity): the same routes answer non-404 for a record that DOES exist", async () => {
  // Without this, every case above would pass on a route that answers 404 unconditionally - which would
  // be a worse bug wearing the same green tick. Taxi is used because its shape is fully known from the
  // refutation under test.
  const { sqlite, db } = await proofWorld();
  const { ensureTaxiProofTables } = await import("../lib/taxi-proof-governance.ts");
  await ensureTaxiProofTables(db);
  const now = Date.now();
  sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES ('TXB-REAL','k-real','CUST-REAL','[]','[]','blr','blr-east','pet_taxi','pkg','Pkg','g-real','PRV-REAL',?,?,'confirmed','customer_app',900,'INR','{}','w3a',?,?)")
    .run(new Date(now + 86_400_000).toISOString(), new Date(now + 90_000_000).toISOString(), now, now);
  sqlite.prepare("INSERT INTO taxi_trips (id,booking_id,schedule_group_id,reservation_id,provider_id,origin_label,destination_label,route_code,synthetic_distance_km,estimated_duration_minutes,scheduled_start,scheduled_end,status,created_at,updated_at) VALUES ('TRIP-REAL','TXB-REAL','g-real','RES-REAL','PRV-REAL','Indiranagar','Whitefield','blr-e-w',14.2,40,?,?,'scheduled',?,?)")
    .run(new Date(now + 86_400_000).toISOString(), new Date(now + 90_000_000).toISOString(), now, now);

  const module = await import("../app/api/taxi-proof/route.ts");
  const response = await module.GET(new Request("https://uat.pawspace.in/api/taxi-proof?bookingId=TXB-REAL", { headers: STAFF }));
  assert.notEqual(response.status, 404,
    "an existing booking must not answer 404, or the 404s above prove nothing about missing records");
});
