/**
 * FINDINGS 6, 7, 10 (city / zone data-integrity) — FIXED. Converted to assert the SECURE result.
 *
 * All three defects shared one root: the scheduling + booking chain had no city as a first-class,
 * validated field. cityId is now a first-class, validated, normalized input threaded through the
 * scheduling path, canonical-bookings now enforces booking city/zone == the reserved provider's
 * city/zone, and resolveZoneByPincode no longer invents a Bengaluru zone for another city.
 *
 * This suite runs the REAL route handlers (app/api/uat-scheduling/route.ts and
 * app/api/canonical-bookings/route.ts) and the REAL zone resolver (lib/service-zones.ts) against a
 * real node:sqlite D1, for a Bengaluru customer+provider pair AND a second city (Chennai, cityId
 * "maa"). It asserts the chain is now consistent / fails closed for the second city.
 *
 *   FINDING 6  — cityId is now honored: a Chennai request carries cityId="maa" and is scheduled
 *                against the maa provider pool. No maa providers are seeded, so it resolves
 *                NO_SCHEDULE_AVAILABLE — and is NEVER stamped as a Bengaluru reservation.
 *   FINDING 7  — canonical-bookings now rejects (409) a booking whose city/zone does not match the
 *                reserved provider's city/zone: a blr reservation can no longer be confirmed into a
 *                booking labelled Chennai. The provider-mismatch 409 control still holds.
 *   FINDING 10 — resolveZoneByPincode never falls back to "blr-east" for another city. UPDATED for
 *                finding #188: Chennai (maa) zones are now configured, so a maa pincode resolves to a
 *                genuine Chennai zone (never a Bengaluru one) rather than not-serviceable.
 *
 * NOTE (finding #188): a Chennai (maa) provider pool is now seeded by default. The FINDING 6 Chennai
 * cases below still fail closed (NO_SCHEDULE_AVAILABLE, never a blr reservation) because their request
 * window / zone does not match the seeded maa roster — the invariant they pin (a maa request is never
 * stamped as a Bengaluru reservation) is unchanged.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { createD1 } from "./helpers/d1.mjs";

installWorkersHooks("__CITY_DB__", "__CITY_ENV__");

// ---- D1 shim over real SQLite (prepare/bind/first/run/all/batch/exec) --------------------------
function makeD1(sqlite) {
  // Uses the transactional D1 shim (BEGIN/COMMIT/ROLLBACK) from helpers/d1.mjs so a
  // failing batch() rolls back, exactly as Cloudflare D1 does.
  return createD1(sqlite);
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

test("FINDING 6 (fixed) — CHENNAI pair (a): a Chennai customer sends cityId='maa' + zone 'maa-central' and is scheduled maa-scoped: NO_SCHEDULE_AVAILABLE, never a Bengaluru reservation", async () => {
  const sqlite = freshDb();
  // cityId is now a first-class input. The provider pool is loaded for 'maa'
  // (loadGovernedProviders(db,'maa',...)); no seeded provider is in maa, so the pool is empty and the
  // request fails closed — critically, it is NEVER stamped as a Bengaluru reservation.
  const res = await postScheduling({
    clientRequestId: "SG-MAA-6a", customerId: "CUS-MAA", petIds: ["Simba"],
    serviceCode: "grooming", cityId: "maa", zoneId: "maa-central", scheduledStart: START, scheduledEnd: END,
  });
  const body = await res.json();
  console.log("[F6 MAA-a] status =", res.status, "error =", body?.error);

  assert.equal(res.status, 409, "a genuine Chennai city+zone produces no schedule (no maa providers seeded)");
  assert.equal(body.error, "NO_SCHEDULE_AVAILABLE", "Chennai request -> maa provider pool -> empty");
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM scheduling_reservations WHERE group_id=?").get("SG-MAA-6a").c, 0, "no reservation for an unserviceable Chennai request");
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM scheduling_reservations WHERE group_id=? AND city_id='blr'").get("SG-MAA-6a").c, 0, "and NEVER a Bengaluru reservation for a maa request");
});

test("FINDING 6 (fixed) — CHENNAI pair (b): a maa request is never stamped city_id='blr'; with no maa providers it resolves NO_SCHEDULE_AVAILABLE, not a Bengaluru reservation", async () => {
  const sqlite = freshDb();
  // cityId='maa' is now carried and honored. Even if a mis-routed zone is supplied, scheduling loads
  // the maa provider pool, so a maa request can NEVER be silently fulfilled as a Bengaluru reservation.
  const res = await postScheduling({
    clientRequestId: "SG-MAA-6b", customerId: "CUS-MAA", petIds: ["Simba"],
    serviceCode: "grooming", cityId: "maa", zoneId: "blr-east", scheduledStart: START, scheduledEnd: END,
  });
  const body = await res.json();
  console.log("[F6 MAA-b] status =", res.status, "error =", body?.error);

  assert.equal(res.status, 409, "a maa request with no maa providers yields no schedule");
  assert.equal(body.error, "NO_SCHEDULE_AVAILABLE", "the pool is loaded for maa, of which none are seeded");
  // THE CHAIN NO LONGER BREAKS: no reservation exists, and certainly not a Bengaluru one.
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM scheduling_reservations WHERE group_id=?").get("SG-MAA-6b").c, 0, "no reservation is created for an unserviceable maa request");
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM scheduling_reservations WHERE group_id=? AND city_id='blr'").get("SG-MAA-6b").c, 0, "a Chennai (maa) request is NEVER stamped as a Bengaluru reservation");
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

test("FINDING 7 (fixed) — a BENGALURU reservation confirmed into a booking labelled CHENNAI (maa/maa-central) is now REJECTED 409 (city/zone mismatch)", async () => {
  const sqlite = freshDb();                       // sandbox payment env (default)
  seedBlrReservation(sqlite, "SG-F7", "groom_kiran");

  const res = await postBooking(bookingBody({ scheduleGroupId: "SG-F7", providerId: "groom_kiran" }));
  const body = await res.json();
  console.log("[F7] status =", res.status, "body =", JSON.stringify(body));

  // The provider matches (so the provider guard passes) but the city/zone invariant now rejects it.
  assert.equal(res.status, 409, `the mismatched-city booking is now REJECTED: ${JSON.stringify(body)}`);
  assert.match(body.error, /city\/zone does not match|city and zone/i, "the error names the city/zone mismatch invariant");

  // No booking row is written for the mismatched request.
  const booking = sqlite.prepare("SELECT city_id,zone_id,provider_id FROM canonical_bookings WHERE schedule_group_id=?").get("SG-F7");
  assert.equal(booking, undefined, "no booking row persisted on the city/zone mismatch");
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM canonical_bookings").get().c, 0, "no canonical_bookings written for a mismatched-city request");
});

test("FINDING 7 (control) — the route STILL rejects a mismatched PROVIDER (409), alongside the new city/zone invariant", async () => {
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

test("FINDING 10 (fixed) — a Chennai pincode in a Live 'maa' city range resolves to a Chennai (maa) zone, never an East Bengaluru zone", async () => {
  // UPDATED for finding #188: the original assertion (a maa pincode resolves NOT-serviceable/null)
  // pinned the intermediate state where the fix for #10 was in — resolveZoneByPincode no longer invents
  // Object.keys(SERVICE_ZONES)[0] ('blr-east') for another city — but Chennai itself had NO zone
  // configured yet, so a Chennai pincode was still not serviceable. #188 completes the launch: Chennai
  // zones (maa-central/…) now exist in SERVICE_ZONES, so a Chennai pincode inside a Live 'maa' range
  // resolves to its OWN Chennai zone. The invariant the #10 fix guarantees is unchanged and re-asserted:
  // the resolved zone is a genuine maa zone, NEVER a Bengaluru (blr) fallback.
  const sqlite = freshDb();
  sqlite.exec("CREATE TABLE IF NOT EXISTS city_launch_configs (city TEXT,city_code TEXT,pincodes TEXT,status TEXT)");
  sqlite.prepare("INSERT INTO city_launch_configs (city,city_code,pincodes,status) VALUES (?,?,?,?)")
    .run("Chennai", "maa", "600001-600100", "Live");

  // 600042 (Velachery) is inside the Live maa range but not in the explicit pincode table, so it
  // resolves via the city launch config's `${cityCode}-central` fallback — which is a Chennai zone.
  const resolved = await serviceZones.resolveZoneByPincode(globalThis.__CITY_DB__, "600042");
  console.log("[F10] pincode 600042 ->", JSON.stringify(resolved));

  assert.ok(resolved, "a Chennai pincode inside a Live maa range now resolves (Chennai is launched)");
  assert.equal(resolved.assignment.city, "Chennai", "it resolves as a Chennai address");
  assert.equal(String(resolved.zone.zoneId).slice(0, 3), "maa", "to a genuine Chennai (maa) zone");
  assert.notEqual(String(resolved.zone.zoneId).slice(0, 3), "blr", "NEVER an East-Bengaluru fallback (finding #10 invariant holds)");

  // Control: a real Bengaluru pincode still resolves to a blr zone — cross-city resolution is clean.
  const blr = await serviceZones.resolveZoneByPincode(globalThis.__CITY_DB__, "560001");
  assert.ok(blr && String(blr.zone.zoneId).startsWith("blr"), "a real Bengaluru pincode still resolves to a blr zone");
});
