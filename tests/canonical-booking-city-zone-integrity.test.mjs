import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { VEHICLE_SERVICE_CODE, governedVehicleQuote } from "./helpers/governed-canonical-vehicle.mjs";

// ---------------------------------------------------------------------------
// A canonical booking persists the CLIENT-supplied cityId/zoneId, but the reservation it confirms was
// made for a specific city and zone. Provider equality alone does not close that gap: the same provider
// row satisfies a Bengaluru reservation while the booking labels itself Chennai, and everything
// downstream — routing, pricing, city reporting, partner dispatch — then reads the label, not the
// reservation. Trust the reservation, never the client.
//
// The invariant is checked AFTER the idempotency replay, so a booking stored before the rule existed
// still replays, and BEFORE every booking, pet, payment, work-order and lifecycle write, so a
// mismatched payload costs nothing.
//
// These drive the REAL exported POST handler against a real SQLite database. Nothing here matches
// source text: every claim is a status the handler returned or a row counted in the database after it.
// ---------------------------------------------------------------------------
installWorkersHooks("__CITY_ZONE_DB__", "__CITY_ZONE_ENV__");

function makeD1(sqlite) {
  const statement = (sql, args) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (list) => { const out = []; for (const item of list) out.push(await item.run()); return out; },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

const SCHEDULING_DDL = [
  "CREATE TABLE IF NOT EXISTS scheduling_assignment_decisions (group_id TEXT PRIMARY KEY,strategy TEXT NOT NULL,shortlist_json TEXT NOT NULL,selected_provider_id TEXT,status TEXT NOT NULL,actor_id TEXT,reason TEXT,updated_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS scheduling_reservations (id TEXT PRIMARY KEY,group_id TEXT NOT NULL,provider_id TEXT NOT NULL,service_code TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,capacity_units INTEGER NOT NULL DEFAULT 1,occurrence_number INTEGER NOT NULL DEFAULT 1,care_mode TEXT,status TEXT NOT NULL,explanation_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL)",
];

const CUSTOMER = "CUS-CITYZONE-1", PROVIDER = "PRV-CITYZONE-1";
const START = "2026-11-04T09:00:00.000Z", END = "2026-11-04T11:00:00.000Z";
/** What the reservation was actually made for. The booking is judged against exactly this. */
const RESERVED_CITY = "blr", RESERVED_ZONE = "koramangala";
const MISMATCH_MESSAGE = "The booking city/zone does not match the reserved provider's city and zone";

function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  globalThis.__CITY_ZONE_DB__ = makeD1(sqlite);
  globalThis.__CITY_ZONE_ENV__ = { PAWSPACE_PAYMENT_ENV: "sandbox" };
  return sqlite;
}

/** Seed the assignment + reservation the booking POST requires, always for the RESERVED city/zone. */
function seedScheduling(sqlite, groupId, serviceCode = VEHICLE_SERVICE_CODE) {
  for (const ddl of SCHEDULING_DDL) sqlite.exec(ddl);
  sqlite.prepare("INSERT OR REPLACE INTO scheduling_assignment_decisions (group_id,strategy,shortlist_json,selected_provider_id,status,actor_id,reason,updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(groupId, "balanced", "[]", PROVIDER, "assigned", "test", "seeded", 1);
  sqlite.prepare("INSERT OR REPLACE INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,care_mode,status,explanation_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(`RES-${groupId}`, groupId, PROVIDER, serviceCode, RESERVED_CITY, RESERVED_ZONE, CUSTOMER, "[]", START, END, 1, 1, null, "reserved", "{}", 1);
}

/**
 * Built as an object then stringified, so a test can omit cityId/zoneId entirely or send a malformed
 * type — the shapes are part of what is under test.
 */
function bookingBody({ key, group, city = RESERVED_CITY, zone = RESERVED_ZONE, serviceCode = VEHICLE_SERVICE_CODE, omitCity = false, omitZone = false, quote = null }) {
  const body = {
    idempotencyKey: key, scheduleGroupId: group,
    customer: { id: CUSTOMER, name: "City zone tester", primaryPhone: "+919000000001" },
    pets: [{ sourceId: "cz-pet-1", name: "Rex", species: "dog" }],
    cityId: city, zoneId: zone,
    serviceCode, packageCode: quote?.packageCode ?? "home-visit", packageName: quote?.packageName ?? "Pet Sitting",
    scheduledStart: START, scheduledEnd: END,
    provider: { id: PROVIDER, name: "Assigned provider", model: "full_time" },
    totalAmount: quote?.totalAmount ?? 1349, amountDueNow: quote?.amountDueNow ?? 1349,
    payment: { method: "upi", mode: "prepaid", status: "captured", detail: "customer app" },
    pricing: quote ? { discount: quote.discount, trainingQuoteId: quote.quoteId } : { discount: 0 },
  };
  if (omitCity) delete body.cityId;
  if (omitZone) delete body.zoneId;
  return JSON.stringify(body);
}

/**
 * `governed:false` probes a service exactly as a client would with no server quote - that is what the
 * per-service expectation table below measures. Everything else uses the governed vehicle, so the flow
 * under test is one that WOULD reach 201 and is stopped only by the invariant being asserted.
 */
async function book(sqlite, options) {
  if (options.schedule !== false) seedScheduling(sqlite, options.group, options.serviceCode);
  const governed = options.governed !== false && (options.serviceCode ?? VEHICLE_SERVICE_CODE) === VEHICLE_SERVICE_CODE;
  const quote = governed ? await governedVehicleQuote(globalThis.__CITY_ZONE_DB__, { scheduledStart: START, petCount: 1 }) : null;
  const { POST } = await import("../app/api/canonical-bookings/route.ts");
  const response = await POST(new Request("http://localhost/api/canonical-bookings", {
    method: "POST", headers: { "content-type": "application/json" }, body: bookingBody({ ...options, quote }),
  }));
  let body = null;
  try { body = JSON.parse(await response.clone().text()); } catch { /* non-JSON body */ }
  return { status: response.status, body };
}

/** Every table the booking write batch touches. A refused request must move none of them. */
const TOUCHED_TABLES = ["canonical_pets", "canonical_bookings", "booking_payments", "provider_work_orders", "booking_lifecycle_events"];
const counts = (sqlite) => Object.fromEntries(TOUCHED_TABLES.map((table) => {
  try { return [table, sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n]; } catch { return [table, 0]; }
}));
const ZERO = Object.fromEntries(TOUCHED_TABLES.map((table) => [table, 0]));

/** Create the tables without leaving a booking behind, so a refused FIRST request has a real baseline. */
async function warmSchema(sqlite) {
  await book(sqlite, { key: "cz-warm", group: "SG-CZ-WARM" });
  for (const table of TOUCHED_TABLES) sqlite.exec(`DELETE FROM ${table}`);
}

// --- the reservation is the authority ---------------------------------------------------------

test("a booking whose city and zone match the reservation is accepted and persists that city/zone", async () => {
  const sqlite = freshDb();
  const result = await book(sqlite, { key: "cz-match", group: "SG-CZ-MATCH" });
  assert.equal(result.status, 201, `a matching booking must still be accepted: ${JSON.stringify(result.body)}`);

  const row = sqlite.prepare("SELECT city_id,zone_id FROM canonical_bookings WHERE idempotency_key=?").get("cz-match");
  assert.equal(row.city_id, RESERVED_CITY, "the stored city is the reserved city");
  assert.equal(row.zone_id, RESERVED_ZONE, "the stored zone is the reserved zone");
});

test("a city mismatch is refused 409 and writes nothing", async () => {
  const sqlite = freshDb();
  await warmSchema(sqlite);
  const before = counts(sqlite);
  assert.deepEqual(before, ZERO, "baseline must be empty so a stray write cannot hide");

  const result = await book(sqlite, { key: "cz-city", group: "SG-CZ-CITY", city: "maa" });
  assert.equal(result.status, 409, `a Chennai-labelled booking over a Bengaluru reservation must be refused: ${JSON.stringify(result.body)}`);
  assert.equal(result.body.error, MISMATCH_MESSAGE);
  assert.deepEqual(counts(sqlite), ZERO, "a refused city mismatch must leave every written table empty");
});

test("a zone mismatch is refused 409 and writes nothing", async () => {
  const sqlite = freshDb();
  await warmSchema(sqlite);

  // Same city, different zone: the zone alone decides routing and dispatch, so it is checked too.
  const result = await book(sqlite, { key: "cz-zone", group: "SG-CZ-ZONE", zone: "blr-east" });
  assert.equal(result.status, 409, `a zone mismatch must be refused: ${JSON.stringify(result.body)}`);
  assert.equal(result.body.error, MISMATCH_MESSAGE);
  assert.deepEqual(counts(sqlite), ZERO, "a refused zone mismatch must leave every written table empty");
});

test("repeated mismatches stay zero-write and never accumulate a partial booking", async () => {
  const sqlite = freshDb();
  await warmSchema(sqlite);

  const statuses = [];
  for (let attempt = 1; attempt <= 4; attempt++) {
    const result = await book(sqlite, { key: `cz-repeat-${attempt}`, group: `SG-CZ-REPEAT-${attempt}`, city: "maa", zone: "maa-central" });
    statuses.push(result.status);
    assert.deepEqual(counts(sqlite), ZERO, `attempt ${attempt} must write nothing`);
  }
  assert.deepEqual(statuses, [409, 409, 409, 409], "every attempt is refused identically");
});

test("a missing or malformed city/zone follows the existing rule rather than being allowed through", async () => {
  const sqlite = freshDb();
  await warmSchema(sqlite);

  // validate() does not police cityId/zoneId, so absence and wrong types reach this invariant and are
  // compared against the reservation like any other value. What must never happen is a write.
  for (const [label, options] of [
    ["absent cityId", { key: "cz-nocity", group: "SG-CZ-NOCITY", omitCity: true }],
    ["absent zoneId", { key: "cz-nozone", group: "SG-CZ-NOZONE", omitZone: true }],
    ["numeric cityId", { key: "cz-numcity", group: "SG-CZ-NUMCITY", city: 7 }],
    ["null zoneId", { key: "cz-nullzone", group: "SG-CZ-NULLZONE", zone: null }],
  ]) {
    const result = await book(sqlite, options);
    assert.equal(result.status, 409, `${label} must not reach the write path: ${JSON.stringify(result.body)}`);
    assert.equal(result.body.error, MISMATCH_MESSAGE, `${label} is refused by the city/zone rule`);
    assert.deepEqual(counts(sqlite), ZERO, `${label} must write nothing`);
  }
});

test("ordering invariant: a stored booking still replays even when the replay payload's city/zone would now be refused", async () => {
  const sqlite = freshDb();

  const created = await book(sqlite, { key: "cz-history", group: "SG-CZ-HISTORY" });
  assert.equal(created.status, 201, `the historical booking must be created: ${JSON.stringify(created.body)}`);
  const stored = sqlite.prepare("SELECT id FROM canonical_bookings WHERE idempotency_key=?").get("cz-history");
  const before = counts(sqlite);

  // Same idempotency key, now carrying a city the rule refuses. The replay lookup runs first, so this
  // must return the ORIGINAL booking rather than a 409 — history can never be orphaned by a new rule.
  const replay = await book(sqlite, { key: "cz-history", group: "SG-CZ-HISTORY", city: "maa", zone: "maa-central" });
  assert.equal(replay.status, 200, `the replay must not be refused by the new rule: ${JSON.stringify(replay.body)}`);
  assert.equal(replay.body.data.duplicatePrevented, true, "the replay is served from the stored booking");
  assert.equal(replay.body.data.bookingId, stored.id, "the replay returns the original booking id");
  assert.deepEqual(counts(sqlite), before, "a replay writes nothing new");
});

/**
 * Per-service expectations.
 *
 * `match` is the status each flow returns for a CONSISTENT payload - unchanged by this rule. Every
 * ungoverned probe stops at its OWN commercial governance (no policy or server quote is seeded for it),
 * which is exactly why the matching column proves the city/zone rule is not what stops it. pet_sitting
 * used to be the exception that reached 201 here, because it had no commercial governance on this route
 * at all - that was PTJA-P0-02, and it is now refused toward the governed Sitting route. The flow that
 * reaches 201 is the governed vehicle, which is a stronger probe: it is a booking that would otherwise
 * succeed.
 *
 * `guardedByCityZone` records which flows actually reach this invariant. Grooming does not: it resolves
 * its commercial policy from cityId/zoneId BEFORE the reservation is read, so an unserviced city is
 * refused there first. That refusal is pre-existing and returns 500 for a missing policy — a known
 * main-line defect this change neither causes nor fixes, tracked separately. pet_sitting no longer does
 * either: its refusal is now the first thing this route says about that service.
 */
const SERVICE_EXPECTATIONS = [
  { label: "grooming", serviceCode: "grooming", governed: false, match: 409, guardedByCityZone: false },
  { label: "dog_training (no server quote)", serviceCode: "dog_training", governed: false, match: 409, guardedByCityZone: true },
  { label: "boarding", serviceCode: "boarding", governed: false, match: 409, guardedByCityZone: true },
  { label: "pet_sitting", serviceCode: "pet_sitting", governed: false, match: 409, guardedByCityZone: false },
  { label: "governed vehicle", serviceCode: VEHICLE_SERVICE_CODE, governed: true, match: 201, guardedByCityZone: true },
];

test("every service keeps its own behaviour when city/zone match", async () => {
  for (const { label, serviceCode, governed, match } of SERVICE_EXPECTATIONS) {
    const sqlite = freshDb();
    const result = await book(sqlite, { key: `cz-ok-${label}`, group: `SG-CZ-OK-${serviceCode}-${governed}`, serviceCode, governed });
    assert.equal(result.status, match, `${label}: a consistent booking must keep its existing status: ${JSON.stringify(result.body)}`);
    assert.notEqual(result.body?.error, MISMATCH_MESSAGE, `${label}: a consistent booking is never refused by the city/zone rule`);
  }
});

test("a mismatched city/zone is refused with zero writes in every service flow", async () => {
  for (const { label, serviceCode, governed, guardedByCityZone } of SERVICE_EXPECTATIONS) {
    const sqlite = freshDb();
    await warmSchema(sqlite);
    const result = await book(sqlite, { key: `cz-bad-${label}`, group: `SG-CZ-BAD-${serviceCode}-${governed}`, serviceCode, governed, city: "maa", zone: "maa-central" });

    assert.ok(result.status >= 400, `${label}: a mismatch must never be accepted (got ${result.status})`);
    assert.deepEqual(counts(sqlite), ZERO, `${label}: a refused mismatch must write nothing`);
    if (guardedByCityZone) {
      // Without this invariant a fully governed booking returned 201 and PERSISTED a Chennai-labelled
      // booking over a Bengaluru reservation; Training and Boarding passed the reservation check
      // unchallenged.
      assert.equal(result.status, 409, `${label}: refused by the city/zone rule: ${JSON.stringify(result.body)}`);
      assert.equal(result.body.error, MISMATCH_MESSAGE, `${label}: refused for city/zone specifically`);
    } else {
      assert.notEqual(result.status, 201, `${label}: must not be accepted`);
    }
  }
});
