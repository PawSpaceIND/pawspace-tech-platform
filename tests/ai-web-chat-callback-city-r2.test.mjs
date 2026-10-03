/**
 * Proposal 3 revised. New cross-city work uses configured eligibility and does not require a prior booking.
 * An existing bookingId binds that row and the explicit active-status list.
 * Fetch throws. No live telephony and no model spend.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks as installProposalHooks } from "./helpers/module-hooks.mjs";
import { uatVoiceEnv, ALLOWLISTED_PHONE } from "./helpers/voice-harness.mjs";

installProposalHooks("__CITY_PROP_DB__", "__CITY_PROP_ENV__");
const fetches = [];
globalThis.fetch = async (input) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : String(input?.url || input);
  fetches.push(url);
  throw new Error(`network denied: ${url}`);
};
const control = await import("../lib/ai-first-control-plane.ts");
const PHONE = `+91${ALLOWLISTED_PHONE}`;

function makeD1(sqlite, reads) {
  const touch = (sql) => { if (/canonical_bookings/i.test(sql)) reads.push(sql); };
  const statement = (sql, args) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => { touch(sql); const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
    run: async () => { touch(sql); const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
    all: async () => { touch(sql); return { results: sqlite.prepare(sql).all(...args) }; },
  });
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (items) => { const results = []; for (const item of items) results.push(await item.run()); return results; },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}
async function world(env) {
  const reads = [];
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite, reads);
  globalThis.__CITY_PROP_DB__ = db;
  globalThis.__CITY_PROP_ENV__ = env;
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  const { ensureCustomerAccountTables } = await import("../lib/customer-account.ts");
  await ensureSecurityTables(db);
  await ensureCustomerAccountTables(db);
  return { sqlite, db, reads };
}
function seedCustomer(sqlite, customerId, phone, cityId = "blr") {
  const now = Date.now();
  sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,secondary_phone,email,source,consent_json,created_at,updated_at) VALUES (?,?,?,?,NULL,NULL,'customer_app','{}',?,?)")
    .run(customerId, cityId, `Customer ${customerId}`, phone, now, now);
}
function actor() {
  return { email: "customer.callback@pawspace.test", name: "Callback Customer", roleCode: "customer", permissions: ["customers.manage"], developmentPreview: false, identitySource: "customer_app", principalType: "phone", principalKey: PHONE };
}
function seedService(sqlite, serviceCode, cityId) {
  sqlite.exec("CREATE TABLE IF NOT EXISTS catalogue_packages (id TEXT PRIMARY KEY, service_code TEXT NOT NULL, package_code TEXT NOT NULL, city_id TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1)");
  sqlite.prepare("INSERT OR REPLACE INTO catalogue_packages (id, service_code, package_code, city_id, active) VALUES (?,?,?,?,1)").run(`pkg-${serviceCode}-${cityId}`, serviceCode, "standard", cityId);
}
function ensureLaunchSchema(sqlite) {
  sqlite.exec("CREATE TABLE IF NOT EXISTS city_launch_configs (id TEXT PRIMARY KEY,city_code TEXT NOT NULL UNIQUE,city TEXT NOT NULL,state TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'Draft',centre TEXT NOT NULL DEFAULT '',radius_km REAL NOT NULL DEFAULT 15,pincodes TEXT NOT NULL DEFAULT '',gst_included INTEGER NOT NULL DEFAULT 1,services_json TEXT NOT NULL DEFAULT '{}',version INTEGER NOT NULL DEFAULT 1,updated_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE INDEX IF NOT EXISTS idx_city_launch_status ON city_launch_configs(status)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS city_launch_config_audit (id TEXT PRIMARY KEY,city_config_id TEXT NOT NULL,city TEXT NOT NULL,action TEXT NOT NULL,before_json TEXT,after_json TEXT NOT NULL,actor_id TEXT NOT NULL,created_at INTEGER NOT NULL)");
}
function seedLaunch(sqlite, cityCode, status, services) {
  ensureLaunchSchema(sqlite);
  const now = Date.now();
  sqlite.prepare("INSERT OR REPLACE INTO city_launch_configs (id,city_code,city,state,status,centre,radius_km,pincodes,gst_included,services_json,version,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,'',15,'',1,?,1,'city-proposal',?,?)")
    .run(`city-${cityCode}`, cityCode, cityCode, "Test", status, JSON.stringify(services), now, now);
}
function seedBooking(sqlite, id, customerId, cityId, serviceCode, status) {
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, city_id TEXT NOT NULL, service_code TEXT NOT NULL, status TEXT NOT NULL)");
  sqlite.prepare("INSERT INTO canonical_bookings (id, customer_id, city_id, service_code, status) VALUES (?,?,?,?,?)").run(id, customerId, cityId, serviceCode, status);
}
function n(sqlite, name) {
  const exists = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
  return exists ? Number(sqlite.prepare(`SELECT COUNT(*) n FROM ${name}`).get().n) : 0;
}
function input(customerId, idempotencyKey, extra = {}) {
  return { actor: actor(), customerId, message: "Please call me back", idempotencyKey, ...extra };
}
async function refuses(sqlite, db, body, status = 409) {
  const before = fetches.length;
  await assert.rejects(() => control.requestGovernedCustomerCallback(db, globalThis.__CITY_PROP_ENV__, body), (error) => error instanceof Response && error.status === status);
  assert.equal(n(sqlite, "voice_call_orders"), 0);
  assert.equal(n(sqlite, "voice_call_consents"), 0);
  assert.equal(n(sqlite, "ai_callback_request_context"), 0);
  assert.equal(fetches.length, before);
}

test("omitted cityId dials canonical_customers.city_id and an empty city is refused", async () => {
  const env = uatVoiceEnv();
  const ctx = await world(env);
  seedCustomer(ctx.sqlite, "CUS-HYD", PHONE, "hyd");
  const placed = await control.requestGovernedCustomerCallback(ctx.db, env, input("CUS-HYD", "city-omit"));
  assert.equal(placed.matched, true);
  assert.equal(placed.cityId, "hyd");
  assert.equal(ctx.sqlite.prepare("SELECT city_id, customer_id FROM voice_call_orders").get().city_id, "hyd");
  assert.notEqual(ctx.sqlite.prepare("SELECT city_id FROM voice_call_orders").get().city_id, "blr");
  assert.equal(ctx.sqlite.prepare("SELECT city_id FROM ai_callback_request_context").get().city_id, "hyd");

  const empty = await world(env);
  seedCustomer(empty.sqlite, "CUS-EMPTY", PHONE, "");
  await refuses(empty.sqlite, empty.db, input("CUS-EMPTY", "city-empty"));
});

test("eligible new cross-city work does not require a prior booking", async () => {
  const env = uatVoiceEnv();
  const catalogue = await world(env);
  seedCustomer(catalogue.sqlite, "CUS-BLR", PHONE, "blr");
  seedService(catalogue.sqlite, "grooming", "hyd");
  const placed = await control.requestGovernedCustomerCallback(catalogue.db, env, input("CUS-BLR", "city-catalogue", { cityId: "hyd", serviceCode: "grooming" }));
  assert.equal(placed.matched, true);
  assert.equal(placed.cityId, "hyd");
  assert.equal(placed.serviceCode, "grooming");
  assert.equal(placed.bookingId, null);
  assert.equal(catalogue.sqlite.prepare("SELECT city_id FROM voice_call_orders").get().city_id, "hyd");
  assert.equal(catalogue.sqlite.prepare("SELECT city_id FROM canonical_customers WHERE id='CUS-BLR'").get().city_id, "blr");

  const walking = await world(env);
  seedCustomer(walking.sqlite, "CUS-WALK", PHONE, "blr");
  seedService(walking.sqlite, "dog_walking", "hyd");
  const walked = await control.requestGovernedCustomerCallback(walking.db, env, input("CUS-WALK", "city-walk", { cityId: "hyd", serviceCode: "dog_walking" }));
  assert.equal(walked.matched, true);
  assert.equal(walked.cityId, "hyd");
  assert.equal(walked.serviceCode, "dog_walking");
  assert.equal(walked.bookingId, null);

  const launch = await world(env);
  seedCustomer(launch.sqlite, "CUS-LAUNCH", PHONE, "blr");
  seedLaunch(launch.sqlite, "maa", "Live", { Grooming: { enabled: true, price: 1349 } });
  const launched = await control.requestGovernedCustomerCallback(launch.db, env, input("CUS-LAUNCH", "city-launch", { cityId: "maa", serviceCode: "grooming" }));
  assert.equal(launched.matched, true);
  assert.equal(launched.cityId, "maa");
  assert.equal(launch.sqlite.prepare("SELECT city_id FROM voice_call_orders").get().city_id, "maa");

  const trainingOnly = await world(env);
  seedCustomer(trainingOnly.sqlite, "CUS-TRAIN", PHONE, "blr");
  seedLaunch(trainingOnly.sqlite, "hyd", "Live", { Training: { enabled: true, price: 3500 } });
  await refuses(trainingOnly.sqlite, trainingOnly.db, input("CUS-TRAIN", "city-dog-training-not-launch", { cityId: "hyd", serviceCode: "dog_training" }));

  const catalogueTraining = await world(env);
  seedCustomer(catalogueTraining.sqlite, "CUS-DT", PHONE, "blr");
  seedService(catalogueTraining.sqlite, "dog_training", "hyd");
  const trained = await control.requestGovernedCustomerCallback(catalogueTraining.db, env, input("CUS-DT", "city-dog-training-catalogue", { cityId: "hyd", serviceCode: "dog_training" }));
  assert.equal(trained.matched, true);
  assert.equal(trained.serviceCode, "dog_training");

  const food = await world(env);
  seedCustomer(food.sqlite, "CUS-FOOD", PHONE, "blr");
  await refuses(food.sqlite, food.db, input("CUS-FOOD", "city-food", { cityId: "hyd", serviceCode: "fresh_food" }));
  const relocation = await world(env);
  seedCustomer(relocation.sqlite, "CUS-MOVE", PHONE, "blr");
  await refuses(relocation.sqlite, relocation.db, input("CUS-MOVE", "city-relocation", { cityId: "hyd", serviceCode: "relocation" }));
  assert.deepEqual(fetches, []);
});

test("an existing booking binds bookingId and the active status list", async () => {
  const env = uatVoiceEnv();
  const booked = await world(env);
  seedCustomer(booked.sqlite, "CUS-BOOK", PHONE, "blr");
  seedBooking(booked.sqlite, "BK-PNQ", "CUS-BOOK", "pnq", "boarding", "confirmed");
  const fromBooking = await control.requestGovernedCustomerCallback(booked.db, env, input("CUS-BOOK", "city-booking", { bookingId: "BK-PNQ" }));
  assert.equal(fromBooking.matched, true);
  assert.equal(fromBooking.cityId, "pnq");
  assert.equal(fromBooking.serviceCode, "boarding");
  assert.equal(fromBooking.bookingId, "BK-PNQ");
  assert.equal(booked.sqlite.prepare("SELECT city_id, booking_id, customer_id FROM ai_callback_request_context").get().booking_id, "BK-PNQ");
  assert.equal(booked.sqlite.prepare("SELECT city_id FROM voice_call_orders").get().city_id, "pnq");
  assert.equal(booked.sqlite.prepare("SELECT city_id FROM canonical_customers WHERE id='CUS-BOOK'").get().city_id, "blr");

  const implied = await world(env);
  seedCustomer(implied.sqlite, "CUS-IMPLIED", PHONE, "blr");
  seedBooking(implied.sqlite, "BK-IMPLIED", "CUS-IMPLIED", "pnq", "boarding", "confirmed");
  await refuses(implied.sqlite, implied.db, input("CUS-IMPLIED", "city-no-booking-id", { cityId: "pnq", serviceCode: "boarding" }));

  for (const status of ["cancelled", "completed", "refunded"]) {
    const ctx = await world(env);
    seedCustomer(ctx.sqlite, "CUS-STALE", PHONE, "blr");
    seedBooking(ctx.sqlite, `BK-${status}`, "CUS-STALE", "hyd", "boarding", status);
    await refuses(ctx.sqlite, ctx.db, input("CUS-STALE", `city-stale-${status}`, { bookingId: `BK-${status}` }));
  }

  for (const status of ["assigned", "in_progress", "reassignment_needed"]) {
    const ctx = await world(env);
    seedCustomer(ctx.sqlite, "CUS-LIVE", PHONE, "blr");
    seedBooking(ctx.sqlite, `BK-${status}`, "CUS-LIVE", "hyd", "boarding", status);
    const placed = await control.requestGovernedCustomerCallback(ctx.db, env, input("CUS-LIVE", `city-live-${status}`, { bookingId: `BK-${status}` }));
    assert.equal(placed.matched, true);
    assert.equal(placed.bookingId, `BK-${status}`);
    assert.equal(placed.cityId, "hyd");
  }
  assert.deepEqual(fetches, []);
});

test("verdict denials and enabled false do not admit a new destination", async () => {
  const env = uatVoiceEnv();
  const paused = await world(env);
  seedCustomer(paused.sqlite, "CUS-PAUSE", PHONE, "blr");
  seedService(paused.sqlite, "grooming", "hyd");
  seedLaunch(paused.sqlite, "hyd", "Paused", { Grooming: { enabled: true, price: 1349 } });
  seedBooking(paused.sqlite, "BK-PAUSE", "CUS-PAUSE", "hyd", "grooming", "confirmed");
  const beforePaused = paused.reads.length;
  await refuses(paused.sqlite, paused.db, input("CUS-PAUSE", "city-paused", { cityId: "hyd", serviceCode: "grooming" }));
  assert.equal(paused.reads.length - beforePaused, 0);

  const disabled = await world(env);
  seedCustomer(disabled.sqlite, "CUS-OFF", PHONE, "blr");
  seedService(disabled.sqlite, "grooming", "hyd");
  seedLaunch(disabled.sqlite, "hyd", "Live", { Grooming: { enabled: false, price: 0 } });
  seedBooking(disabled.sqlite, "BK-OFF", "CUS-OFF", "hyd", "grooming", "confirmed");
  const beforeOff = disabled.reads.length;
  await refuses(disabled.sqlite, disabled.db, input("CUS-OFF", "city-disabled", { cityId: "hyd", serviceCode: "grooming" }));
  assert.equal(disabled.reads.length - beforeOff, 0);
  await refuses(disabled.sqlite, disabled.db, input("CUS-OFF", "city-disabled-booking", { bookingId: "BK-OFF" }));

  const nowhere = await world(env);
  seedCustomer(nowhere.sqlite, "CUS-NOWHERE", PHONE, "blr");
  await refuses(nowhere.sqlite, nowhere.db, input("CUS-NOWHERE", "city-unowned", { cityId: "zzz" }));

  const future = await world(env);
  seedCustomer(future.sqlite, "CUS-FUTURE", PHONE, "hyd");
  const when = new Date(Date.now() + 3 * 86400000).toISOString();
  const unsupported = await control.requestGovernedCustomerCallback(future.db, env, input("CUS-FUTURE", "city-future", { requestedStart: when }));
  assert.equal(unsupported.scheduling, "unsupported");
  assert.equal(unsupported.cityId, "hyd");
  assert.equal(n(future.sqlite, "voice_call_orders"), 0);
  assert.equal(n(future.sqlite, "voice_call_consents"), 0);
  assert.deepEqual(fetches, []);
});
