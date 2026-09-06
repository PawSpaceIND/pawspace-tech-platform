/**
 * Terminal booking states, proven for every recovery vertical. [PTJA-W3-TS]
 *
 * THE APPROVED RULE, supplied by the business:
 *   - `completed` and `cancelled` are BOTH terminal.
 *   - A cancelled booking cannot be reassigned; the customer must create a new booking.
 *   - A completed booking cannot return to `reassignment_needed`.
 *   - The original booking, cancellation, payment, refund and audit history are preserved.
 *   - For an IN-PROGRESS service, do not automatically cancel or regress its state because a provider
 *     document later expires or is rejected. Keep the work intact and open an Operations
 *     incident/reassignment workflow where applicable.
 *
 * WHAT THIS SUITE IS. The guards themselves already exist in lib/sitting-lifecycle.ts,
 * lib/walking-lifecycle.ts, lib/boarding-stay-lifecycle.ts and lib/taxi-lifecycle.ts, closed earlier in
 * this audit. What did NOT exist was executable proof for Boarding and Pet Taxi -
 * tests/ptja-w1-leftover-regressions.test.mjs covers Sitting and Walking only - or for the in-progress
 * half of the rule. These cases are therefore GREEN on arrival rather than red-first, and each is
 * sabotage-verified instead: the ledger records which reversion fails which case. Per the business's
 * own instruction, nothing here is closed on source inspection.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__PTJA_TS_DB__", "__PTJA_TS_ENV__");

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


/**
 * Inserts a row filling every NOT NULL column the table declares, so a fixture cannot fail for a
 * reason unrelated to the rule under test. Supplied values win; anything else gets a type-appropriate
 * placeholder.
 */
function insertRow(sqlite, table, values) {
  const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.length) throw new Error(`fixture: table ${table} does not exist`);
  const used = [], bound = [];
  for (const column of columns) {
    const name = String(column.name);
    if (name in values) { used.push(name); bound.push(values[name]); continue; }
    if (Number(column.notnull) !== 1 || column.dflt_value !== null) continue;
    used.push(name);
    bound.push(/INT|REAL|NUM/i.test(String(column.type)) ? 0 : "");
  }
  const slots = used.map(() => "?").join(",");
  sqlite.prepare(`INSERT INTO ${table} (${used.join(",")}) VALUES (${slots})`).run(...bound);
}

const attempt = (promise) => promise.then(
  (value) => ({ ok: true, value }),
  async (error) => ({ ok: false, status: error instanceof Response ? error.status : 0, message: error instanceof Response ? await error.clone().text() : String(error?.message ?? error) }),
);

function baseWorld() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PTJA_TS_DB__ = db;
  globalThis.__PTJA_TS_ENV__ = {};
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT,customer_id TEXT,pet_ids_json TEXT,city_id TEXT,zone_id TEXT,service_code TEXT,package_code TEXT,package_name TEXT,schedule_group_id TEXT,provider_id TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT,channel TEXT,total_amount REAL,currency TEXT,pricing_json TEXT,created_by TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT,schedule_group_id TEXT,provider_id TEXT,provider_name TEXT,provider_model TEXT,service_code TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_assignment_offers (id TEXT PRIMARY KEY,group_id TEXT,provider_id TEXT,status TEXT,responded_at INTEGER,response_reason TEXT,booking_id TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS scheduling_reservations (id TEXT PRIMARY KEY,group_id TEXT,provider_id TEXT,service_code TEXT,city_id TEXT,zone_id TEXT,customer_id TEXT,pet_ids_json TEXT,scheduled_start TEXT,scheduled_end TEXT,capacity_units INTEGER,occurrence_number INTEGER,care_mode TEXT,status TEXT,explanation_json TEXT,created_at INTEGER,lease_expires_at INTEGER,customer_session_id TEXT)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT,customer_id TEXT,amount REAL,amount_due_now REAL,currency TEXT,method TEXT,mode TEXT,status TEXT,gateway TEXT,idempotency_key TEXT,detail_json TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS scheduling_assignment_decisions (group_id TEXT PRIMARY KEY,strategy TEXT,shortlist_json TEXT,selected_provider_id TEXT,status TEXT,actor_id TEXT,reason TEXT,updated_at INTEGER)");
  return { sqlite, db };
}

const seedBooking = (sqlite, { id, serviceCode, status, now }) => {
  sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES (?,?,'CUS-1','[]','blr','blr-east',?,'pkg','Package',?,'PROV-A','2026-08-01T09:00:00.000Z','2026-08-01T11:00:00.000Z',?,'customer_app',5000,'INR','{}','seed',?,?)")
    .run(id, `idem-${id}`, serviceCode, `SG-${id}`, status, now, now);
  sqlite.prepare("INSERT INTO provider_work_orders (id,booking_id,schedule_group_id,provider_id,provider_name,provider_model,service_code,scheduled_start,scheduled_end,status,created_at,updated_at) VALUES (?,?,?,'PROV-A','Provider','full_time',?,'2026-08-01T09:00:00.000Z','2026-08-01T11:00:00.000Z',?,?,?)")
    .run(`WO-${id}`, id, `SG-${id}`, serviceCode, status === "completed" ? "completed" : "assigned", now, now);
};

// ---------------------------------------------------------------------------------------------------
// Boarding — the vertical with the guard but no executable proof
// ---------------------------------------------------------------------------------------------------

async function boardingWorld(bookingStatus) {
  const { sqlite, db } = baseWorld();
  const now = Date.now();
  const boarding = await import("../lib/boarding-stay-lifecycle.ts");
  await (await import("../lib/boarding-governance.ts")).ensureBoardingGovernanceTables(db).catch(() => null);
  await boarding.ensureBoardingStayLifecycleTables(db).catch(() => null);
  seedBooking(sqlite, { id: "BK-BOARD", serviceCode: "boarding", status: bookingStatus, now });
  const values = {
    id: "STAY-1", booking_id: "BK-BOARD", schedule_group_id: "SG-BK-BOARD", host_provider_id: "PROV-A",
    customer_id: "CUS-1", city_id: "blr", zone_id: "blr-east", status: "awaiting_host_acceptance",
    check_in: "2026-08-01T09:00:00.000Z", check_out: "2026-08-05T11:00:00.000Z",
    pet_ids_json: "[]", capacity_units: 1, created_at: now, updated_at: now,
  };
  insertRow(sqlite, "boarding_stays", values);
  return { sqlite, db, boarding };
}

for (const status of ["completed", "cancelled"]) {
  test(`TS-01 (Boarding): a host decline cannot regress a ${status} booking`, async () => {
    const { sqlite, db, boarding } = await boardingWorld(status);
    const result = await attempt(boarding.mutateBoardingStay(db, {
      stayId: "STAY-1", action: "decline", actorId: "PROV-A", idempotencyKey: `board-${status}`,
      reason: "host fell ill",
    }));
    assert.equal(result.ok, false, `a ${status} Boarding booking has no assignment left to recover: ${JSON.stringify(result).slice(0, 300)}`);
    assert.equal(String(sqlite.prepare("SELECT status FROM canonical_bookings WHERE id='BK-BOARD'").get().status), status,
      "and its status is untouched, not overwritten with reassignment_needed");
    assert.equal(String(sqlite.prepare("SELECT status FROM provider_work_orders WHERE booking_id='BK-BOARD'").get().status) === "recovery_pending", false,
      "and the work order is not dragged back into recovery");
  });
}

test("TS-02 (Boarding): a live stay still declines into recovery", async () => {
  // Non-vacuity. Refusing every decline would satisfy TS-01 and remove Boarding host recovery, which is
  // the entire purpose of the branch.
  const { sqlite, db, boarding } = await boardingWorld("confirmed");
  const result = await attempt(boarding.mutateBoardingStay(db, {
    stayId: "STAY-1", action: "decline", actorId: "PROV-A", idempotencyKey: "board-live", reason: "host fell ill",
  }));
  assert.equal(result.ok, true, `a live stay must still decline: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(String(sqlite.prepare("SELECT status FROM canonical_bookings WHERE id='BK-BOARD'").get().status), "reassignment_needed",
    "and the booking enters recovery");
});

// ---------------------------------------------------------------------------------------------------
// Pet Taxi — the vertical that WROTE the rule, also without executable proof of it
// ---------------------------------------------------------------------------------------------------

async function taxiWorld(tripStatus, bookingStatus = "assigned") {
  const { sqlite, db } = baseWorld();
  const now = Date.now();
  const taxi = await import("../lib/taxi-lifecycle.ts");
  await (await import("../lib/taxi-ops-governance.ts")).ensureTaxiOpsTables(db).catch(() => null);
  await taxi.ensureTaxiLifecycleTables(db).catch(() => null);
  seedBooking(sqlite, { id: "BK-TAXI", serviceCode: "pet_taxi", status: bookingStatus, now });
  const values = {
    id: "TRIP-1", booking_id: "BK-TAXI", schedule_group_id: "SG-BK-TAXI", reservation_id: "RES-1",
    provider_id: "PROV-A", origin_label: "Indiranagar", destination_label: "Koramangala",
    route_code: "route-1", synthetic_distance_km: 5, estimated_duration_minutes: 20,
    scheduled_start: "2026-08-01T09:00:00.000Z", scheduled_end: "2026-08-01T09:45:00.000Z",
    status: tripStatus, pickup_verification_status: "pending", dropoff_verification_status: "pending",
    created_at: now, updated_at: now,
  };
  insertRow(sqlite, "taxi_trips", values);
  return { sqlite, db, taxi };
}

for (const tripStatus of ["in_progress", "completed"]) {
  test(`TS-03 (Pet Taxi): a ${tripStatus} trip goes to the safety workflow, not reassignment`, async () => {
    const { sqlite, db, taxi } = await taxiWorld(tripStatus);
    const result = await attempt(taxi.mutateTaxiBooking(db, {
      bookingId: "BK-TAXI", action: "decline", actorId: "PROV-A", idempotencyKey: `taxi-${tripStatus}`,
      reason: "driver unavailable",
    }));
    assert.equal(result.ok, false, `a ${tripStatus} trip must not be reassigned: ${JSON.stringify(result).slice(0, 300)}`);
    assert.match(String(result.message), /safety incident/i, `and say so: ${String(result.message).slice(0, 200)}`);
    assert.notEqual(String(sqlite.prepare("SELECT status FROM canonical_bookings WHERE id='BK-TAXI'").get().status), "reassignment_needed",
      "and the booking is not regressed");
  });
}

test("TS-04 (Pet Taxi): a scheduled trip still declines into recovery", async () => {
  // Non-vacuity for TS-03.
  const { sqlite, db, taxi } = await taxiWorld("scheduled");
  const result = await attempt(taxi.mutateTaxiBooking(db, {
    bookingId: "BK-TAXI", action: "decline", actorId: "PROV-A", idempotencyKey: "taxi-live", reason: "driver unavailable",
  }));
  assert.equal(result.ok, true, `a scheduled trip must still decline: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(String(sqlite.prepare("SELECT status FROM canonical_bookings WHERE id='BK-TAXI'").get().status), "reassignment_needed",
    "and enters recovery");
});

// ---------------------------------------------------------------------------------------------------
// A provider document expiring must not touch work that is already running
// ---------------------------------------------------------------------------------------------------

test("TS-05: revoking a provider's verification preserves in-progress work and opens a case", async () => {
  const { sqlite, db } = baseWorld();
  const now = Date.now();
  const capacity = await import("../lib/provider-capacity-governance.ts");
  await capacity.ensureProviderCapacityTables(db);
  const eligibility = await import("../lib/provider-assignment-eligibility.ts");
  seedBooking(sqlite, { id: "BK-LIVE", serviceCode: "dog_walking", status: "in_service", now });
  sqlite.prepare("INSERT INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,status,created_at) VALUES ('RES-LIVE','SG-BK-LIVE','PROV-A','dog_walking','blr','blr-east','CUS-1','[]',?,?,1,1,'confirmed',?)")
    .run(new Date(now - 600_000).toISOString(), new Date(now + 600_000).toISOString(), now);

  const outcome = await eligibility.revokeProviderVerification(db, {
    providerId: "PROV-A", verificationType: "police_verification",
    reason: "Clearance lapsed", actorId: "ops@pawspace.test",
  });

  assert.equal(String(sqlite.prepare("SELECT status FROM canonical_bookings WHERE id='BK-LIVE'").get().status), "in_service",
    "the walk happening right now is not cancelled or regressed");
  assert.equal(String(sqlite.prepare("SELECT status FROM scheduling_reservations WHERE id='RES-LIVE'").get().status), "confirmed",
    "and its reservation is left alone");
  assert.ok(outcome.recoveryCases >= 1, `an Operations case is opened instead: ${JSON.stringify(outcome)}`);
  assert.equal(outcome.removedFromMatching, true, "and the provider is out of NEW matching immediately");
  const opened = sqlite.prepare("SELECT reason_code,detail_json FROM provider_recovery_cases WHERE failed_provider_id='PROV-A'").get();
  assert.ok(opened, "the case is recorded");
  assert.match(String(opened.detail_json), /workPreserved/, `naming that the work was preserved: ${String(opened?.detail_json).slice(0, 200)}`);
});
