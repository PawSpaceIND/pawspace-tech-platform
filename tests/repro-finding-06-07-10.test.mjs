/**
 * REPRO — FINDINGS 6, 7, 10 (city / zone data-integrity) against EXACT main (commit 1240359).
 *
 * All three defects share one root: the scheduling + booking chain has no city as a first-class,
 * validated field. Bengaluru ("blr") is baked into the code, and the one place that should prove
 * "the booking's city/zone == the reserved provider's city/zone" never checks it.
 *
 * This suite runs the REAL route handlers (app/api/uat-scheduling/route.ts and
 * app/api/canonical-bookings/route.ts) and the REAL zone resolver (lib/service-zones.ts) against a
 * real node:sqlite D1, for a Bengaluru customer+provider pair AND a second synthetic city
 * (Chennai, cityId "maa"). It asserts where the city/zone chain BREAKS for the second city.
 *
 *   FINDING 6  — scheduling is hardcoded to "blr": provider pool, availability, rules, scheduling
 *                request and reservation persistence all use the literal "blr". The scheduling input
 *                (RequestBody) has no cityId at all. Proven by EXECUTION + file:line citations.
 *   FINDING 7  — canonical-bookings validates the reservation's PROVIDER but never its city_id/zone_id
 *                against the client-supplied cityId/zoneId. Proven by EXECUTION: a blr reservation is
 *                confirmed into a booking labelled Chennai (maa/maa-central) with a 201.
 *   FINDING 10 — resolveZoneByPincode falls back to Object.keys(SERVICE_ZONES)[0] ("blr-east") for a
 *                live city whose `${cityCode}-central` zone does not exist. Proven by EXECUTION: a
 *                Chennai pincode resolves to city:Chennai but zone:East Bengaluru.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__CITY_DB__", "__CITY_ENV__");

// ---- D1 shim over real SQLite (prepare/bind/first/run/all/batch/exec) --------------------------
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

function freshDb(env = {}) {
  const sqlite = new DatabaseSync(":memory:");
  globalThis.__CITY_DB__ = makeD1(sqlite);
  globalThis.__CITY_ENV__ = env;
  return sqlite;
}

// Fixed future window (engine has no "must be future" rule, but this keeps the day board sane).
const START = "2026-09-01T04:30:00.000Z", END = "2026-09-01T06:30:00.000Z";

const schedulingRoute = await import("../app/api/uat-scheduling/route.ts");
const bookingRoute = await import("../app/api/canonical-bookings/route.ts");
const serviceZones = await import("../lib/service-zones.ts");

const postScheduling = (body) => schedulingRoute.POST(new Request("http://localhost/api/uat-scheduling", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
const postBooking = (body) => bookingRoute.POST(new Request("http://localhost/api/canonical-bookings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

// =====================================================================================================
// FINDING 6 — scheduling is hardcoded to Bengaluru ("blr"); the input carries no cityId.
// =====================================================================================================

test("FINDING 6 — BENGALURU pair: real reserve yields a blr provider pool + a city_id='blr' reservation", async () => {
  const sqlite = freshDb();
  // A Bengaluru customer in a real Bengaluru zone (blr-east, e.g. 560066 Whitefield).
  const res = await postScheduling({
    clientRequestId: "SG-BLR-6", customerId: "CUS-BLR", petIds: ["Bruno"],
    serviceCode: "grooming", zoneId: "blr-east", scheduledStart: START, scheduledEnd: END,
  });
  const body = await res.json();
  console.log("[F6 BLR] status =", res.status, "provider =", body?.data?.provider?.id, "providerCity =", body?.data?.provider?.cityId);

  assert.equal(res.status, 200, `Bengaluru reserve must succeed: ${JSON.stringify(body)}`);
  assert.ok(body.data.provider, "a blr provider was selected");
  assert.equal(body.data.provider.cityId, "blr", "the eligible-provider pool is Bengaluru");

  const reservation = sqlite.prepare("SELECT city_id,zone_id,provider_id FROM scheduling_reservations WHERE group_id=?").get("SG-BLR-6");
  assert.equal(reservation.city_id, "blr", "reservation persisted city_id='blr'");
  assert.equal(reservation.zone_id, "blr-east");
  // Consistency across the chain holds for Bengaluru: selected city (blr) == zone city == provider city == reservation city.
});

test("FINDING 6 — CHENNAI pair (a): a Chennai customer sending their own city zone 'maa-central' gets NO provider pool", async () => {
  const sqlite = freshDb();
  // The scheduling RequestBody has NO cityId field — a Chennai customer can only send a zoneId.
  // Their real city zone is maa-central. The provider pool is loaded as loadGovernedProviders(db,"blr",...)
  // (literal "blr"), and no seeded provider carries zone "maa-central", so the pool is empty.
  const res = await postScheduling({
    clientRequestId: "SG-MAA-6a", customerId: "CUS-MAA", petIds: ["Simba"],
    serviceCode: "grooming", zoneId: "maa-central", scheduledStart: START, scheduledEnd: END,
  });
  const body = await res.json();
  console.log("[F6 MAA-a] status =", res.status, "error =", body?.error);

  assert.equal(res.status, 409, "a genuine Chennai zone produces no schedule");
  assert.equal(body.error, "NO_SCHEDULE_AVAILABLE", "Chennai customer + Chennai zone -> no eligible provider pool exists");
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM scheduling_reservations WHERE group_id=?").get("SG-MAA-6a").c, 0, "no reservation for a real Chennai zone");
});

test("FINDING 6 — CHENNAI pair (b): even when a Chennai customer is routed to a blr zone, the reservation is stamped city_id='blr', never 'maa'", async () => {
  const sqlite = freshDb();
  // Per FINDING 10 a Chennai pincode can resolve to a blr-* zone. So the Chennai customer reaches
  // scheduling with zoneId 'blr-east'. They DO get a reservation now — but it is a Bengaluru one:
  // there is no way to ask for or record a Chennai (maa) reservation. cityId is not an input.
  const res = await postScheduling({
    clientRequestId: "SG-MAA-6b", customerId: "CUS-MAA", petIds: ["Simba"],
    serviceCode: "grooming", zoneId: "blr-east", scheduledStart: START, scheduledEnd: END,
  });
  const body = await res.json();
  console.log("[F6 MAA-b] status =", res.status, "provider =", body?.data?.provider?.id, "providerCity =", body?.data?.provider?.cityId);

  assert.equal(res.status, 200);
  const reservation = sqlite.prepare("SELECT city_id,zone_id FROM scheduling_reservations WHERE group_id=?").get("SG-MAA-6b");
  // THE CHAIN BREAKS: the Chennai customer's reservation is Bengaluru's.
  assert.equal(reservation.city_id, "blr", "the reservation is stamped Bengaluru, not Chennai");
  assert.notEqual(reservation.city_id, "maa", "a Chennai (maa) reservation is unreachable — scheduling has no cityId to carry");
});

// =====================================================================================================
// FINDING 7 — canonical-bookings never checks reservation.city_id/zone_id == booking cityId/zoneId.
// =====================================================================================================

const SCHEDULING_DDL = [
  "CREATE TABLE IF NOT EXISTS scheduling_assignment_decisions (group_id TEXT PRIMARY KEY,strategy TEXT NOT NULL,shortlist_json TEXT NOT NULL,selected_provider_id TEXT,status TEXT NOT NULL,actor_id TEXT,reason TEXT,updated_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS scheduling_reservations (id TEXT PRIMARY KEY,group_id TEXT NOT NULL,provider_id TEXT NOT NULL,service_code TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,capacity_units INTEGER NOT NULL DEFAULT 1,occurrence_number INTEGER NOT NULL DEFAULT 1,care_mode TEXT,status TEXT NOT NULL,explanation_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL)",
];

/** Seed exactly what uat-scheduling would write for a BENGALURU reservation (city_id='blr', zone blr-east). */
function seedBlrReservation(sqlite, groupId, providerId) {
  for (const ddl of SCHEDULING_DDL) sqlite.exec(ddl);
  sqlite.prepare("INSERT INTO scheduling_assignment_decisions (group_id,strategy,shortlist_json,selected_provider_id,status,actor_id,reason,updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(groupId, "auto", "[]", providerId, "assigned", "system", "seeded", Date.now());
  sqlite.prepare("INSERT INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,care_mode,status,explanation_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(`RES-${groupId}`, groupId, providerId, "pet_sitting", "blr", "blr-east", "CUS-MAA", "[]", START, END, 1, 1, null, "assigned", "{}", Date.now());
}

function bookingBody(overrides = {}) {
  return {
    idempotencyKey: overrides.idempotencyKey ?? "idem-f7-1",
    scheduleGroupId: overrides.scheduleGroupId ?? "SG-F7",
    customer: { id: "CUS-MAA", name: "Chennai customer", primaryPhone: "+919000000009" },
    pets: [{ sourceId: "p1", name: "Simba", species: "dog" }],
    // CLIENT-SUPPLIED city/zone: Chennai, even though the reservation being referenced is Bengaluru's.
    cityId: overrides.cityId ?? "maa",
    zoneId: overrides.zoneId ?? "maa-central",
    serviceCode: "pet_sitting", packageCode: "sit-basic", packageName: "Pet sitting",
    scheduledStart: START, scheduledEnd: END,
    provider: { id: overrides.providerId ?? "groom_kiran", name: "Host", model: "commission" },
    totalAmount: 2400, amountDueNow: 2400,
    payment: { method: "upi", mode: "prepaid", status: "captured", detail: "customer app" },
    pricing: { discount: 0 },
  };
}

test("FINDING 7 — a BENGALURU reservation is confirmed into a booking labelled CHENNAI (maa/maa-central): mismatch accepted", async () => {
  const sqlite = freshDb();                       // sandbox payment env (default)
  seedBlrReservation(sqlite, "SG-F7", "groom_kiran");

  const res = await postBooking(bookingBody({ scheduleGroupId: "SG-F7", providerId: "groom_kiran" }));
  const body = await res.json();
  console.log("[F7] status =", res.status, "body =", JSON.stringify(body));

  assert.equal(res.status, 201, `the mismatched-city booking is ACCEPTED: ${JSON.stringify(body)}`);

  const booking = sqlite.prepare("SELECT city_id,zone_id,provider_id FROM canonical_bookings WHERE schedule_group_id=?").get("SG-F7");
  const reservation = sqlite.prepare("SELECT city_id,zone_id,provider_id FROM scheduling_reservations WHERE group_id=?").get("SG-F7");
  console.log("[F7] booking city/zone =", booking.city_id, booking.zone_id, "| reservation city/zone =", reservation.city_id, reservation.zone_id);

  // The provider matched (the route DOES check provider) ...
  assert.equal(booking.provider_id, reservation.provider_id, "provider is the one guard the route enforces");
  // ... but the CITY and ZONE were never checked: the booking is Chennai, the reservation Bengaluru.
  assert.equal(booking.city_id, "maa", "booking persisted the client's Chennai cityId");
  assert.equal(reservation.city_id, "blr", "the reservation it was validated against is Bengaluru");
  assert.notEqual(booking.city_id, reservation.city_id, "CHAIN BREAK: booking city != reservation city, yet accepted");
  assert.notEqual(booking.zone_id, reservation.zone_id, "CHAIN BREAK: booking zone != reservation zone, yet accepted");
});

test("FINDING 7 (control) — the route DOES reject a mismatched PROVIDER, proving city/zone is the missing invariant", async () => {
  const sqlite = freshDb();
  seedBlrReservation(sqlite, "SG-F7C", "groom_kiran");
  // Same mismatched Chennai city/zone, but now the provider does NOT match the reservation.
  const res = await postBooking(bookingBody({ scheduleGroupId: "SG-F7C", idempotencyKey: "idem-f7c", providerId: "groom_sanjay" }));
  const body = await res.json();
  console.log("[F7 control] status =", res.status, "error =", body?.error);
  assert.equal(res.status, 409, "a wrong provider is rejected");
  assert.match(body.error, /provider/i, "the only reservation-vs-booking equality the route enforces is on the provider");
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM canonical_bookings").get().c, 0, "no booking written when the provider mismatches");
});

// =====================================================================================================
// FINDING 10 — resolveZoneByPincode falls back to Object.keys(SERVICE_ZONES)[0] ('blr-east').
// =====================================================================================================

test("FINDING 10 — a Chennai pincode in a Live 'maa' city range resolves to city:Chennai, zone:East Bengaluru", async () => {
  const sqlite = freshDb();
  // A launched second city whose city_code is 'maa'. No 'maa-central' zone exists in SERVICE_ZONES.
  sqlite.exec("CREATE TABLE IF NOT EXISTS city_launch_configs (city TEXT,city_code TEXT,pincodes TEXT,status TEXT)");
  sqlite.prepare("INSERT INTO city_launch_configs (city,city_code,pincodes,status) VALUES (?,?,?,?)")
    .run("Chennai", "maa", "600001-600100", "Live");

  const resolved = await serviceZones.resolveZoneByPincode(globalThis.__CITY_DB__, "600042"); // T. Nagar, Chennai
  console.log("[F10] pincode 600042 ->", JSON.stringify(resolved));

  assert.ok(resolved, "the Chennai pincode is inside a Live city range, so it is not turned away");
  assert.equal(resolved.assignment.city, "Chennai", "the city is correctly Chennai");
  // CHAIN BREAK: because SERVICE_ZONES has no 'maa-central', the fallback picks Object.keys(SERVICE_ZONES)[0].
  assert.equal(resolved.zone.zoneId, "blr-east", "zone fell back to the FIRST SERVICE_ZONES key");
  assert.equal(resolved.zone.zoneName, "East Bengaluru", "a Chennai pincode is labelled with an East Bengaluru zone");
  assert.notEqual(resolved.zone.zoneId.slice(0, 3), "maa", "no Chennai zone is ever produced");
});
