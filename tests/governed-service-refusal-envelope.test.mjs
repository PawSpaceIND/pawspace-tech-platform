/*
 * A service refusal must reach the partner as the reason the server actually computed.
 *
 * MEASURED DEFECT. lib/server-auth.ts authError() returns a thrown Response verbatim ONLY when
 * isGovernedHttpError() says so - membership in a module-private WeakSet in lib/governed-http-error.ts,
 * tested by object identity. A bare `throw new Response("...")` is not in that set, so authError kept
 * the status and REPLACED the body with the route's generic fallback:
 *
 *   POST /api/boarding-stays  action=check_in   ->  409 {"error":"Unable to update Boarding stay"}
 *                                                   (the server knew: "A ready care plan is required
 *                                                    before check-in")
 *   POST /api/boarding-proof  action=record_...  ->  409 {"error":"Unable to update Boarding proof
 *                                                    records"} for any of fourteen exact reasons.
 *
 * The host could not self-correct, because nothing on the screen said what was wrong.
 *
 * These tests EXECUTE the real lifecycle and proof functions against a real SQLite-backed D1 and push
 * the thrown refusal through the REAL authError from lib/server-auth.ts - the same call the route's
 * catch block makes - then read the body a caller would receive.
 *
 * ONE MODULE GRAPH, ON PURPOSE. The WeakSet is compared by object identity, so a second copy of
 * lib/governed-http-error.ts would report every response as ungoverned and every assertion below
 * would be vacuous. Every module here therefore comes from ONE graph: the `../lib/*.ts` graph opened
 * by installWorkersHooks. tests/helpers/ts-module-loader.mjs importLibModule() cannot be that graph
 * for this suite - it transpiles lib/ into a temp directory and rewrites only `./sibling` specifiers,
 * so lib/walking-lifecycle.ts's `import ... from "../backend/src/scheduling"` resolves to
 * /tmp/backend/src/scheduling and the module will not load at all. importLibModule IS used below, for
 * exactly one thing: to obtain a DETACHED second copy of governed-http-error, so the suite can prove
 * the identity property it depends on instead of assuming it (see "the WeakSet is checked against the
 * live instance").
 */
import test from "node:test";
import assert from "node:assert/strict";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";
import { importLibModule } from "./helpers/ts-module-loader.mjs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__GOVERNED_REFUSAL_DB__", "__GOVERNED_REFUSAL_ENV__");
globalThis.__GOVERNED_REFUSAL_ENV__ = {};

const { authError } = await import("../lib/server-auth.ts");
const { isGovernedHttpError } = await import("../lib/governed-http-error.ts");
/** A deliberately SEPARATE copy of the module, used only to demonstrate the identity requirement. */
const detachedGovernance = await importLibModule("governed-http-error");

// ---------------------------------------------------------------------------
// Fixtures. DDL for the tables these modules READ but do not own is copied verbatim from the owning
// source (app/api/canonical-bookings/route.ts), exactly as tests/helpers/stay-harness.mjs does, so an
// upstream schema change surfaces as a real error rather than a fixture that quietly diverges.
// ---------------------------------------------------------------------------
const CANONICAL_BOOKINGS = "CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT,customer_id TEXT NOT NULL,pet_ids_json TEXT DEFAULT '[]',city_id TEXT,zone_id TEXT,service_code TEXT NOT NULL,package_code TEXT,package_name TEXT,schedule_group_id TEXT,provider_id TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT NOT NULL DEFAULT 'confirmed',channel TEXT,total_amount REAL,currency TEXT DEFAULT 'INR',pricing_json TEXT DEFAULT '{}',created_by TEXT,created_at INTEGER,updated_at INTEGER)";
const PROVIDER_WORK_ORDERS = "CREATE TABLE IF NOT EXISTS provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,schedule_group_id TEXT NOT NULL,provider_id TEXT NOT NULL,provider_name TEXT NOT NULL,provider_model TEXT NOT NULL,service_code TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,occurrence_count INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'assigned',assignment_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)";
const BOOKING_PAYMENTS = "CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT,amount REAL NOT NULL,amount_due_now REAL DEFAULT 0,currency TEXT DEFAULT 'INR',method TEXT,mode TEXT,status TEXT NOT NULL,gateway TEXT,idempotency_key TEXT,detail_json TEXT DEFAULT '{}',created_at INTEGER,updated_at INTEGER)";

const NOW = Date.now();
const PAST = new Date(NOW - 3_600_000).toISOString();
const FUTURE = new Date(NOW + 86_400_000).toISOString();

function world() {
  const w = freshCountingD1();
  w.sqlite.exec(CANONICAL_BOOKINGS);
  w.sqlite.exec(PROVIDER_WORK_ORDERS);
  w.sqlite.exec(BOOKING_PAYMENTS);
  return w;
}

function seedBooking(w, { id, serviceCode, status = "confirmed", providerId = "prov_1", customerId = "CUS-1", groupId = "GRP-1", pricing = "{}" }) {
  w.sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,service_code,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,total_amount,pricing_json,city_id,zone_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, customerId, serviceCode, groupId, providerId, PAST, FUTURE, status, 499, pricing, "blr", "blr-east", NOW, NOW);
  w.sqlite.prepare("INSERT OR REPLACE INTO provider_work_orders (id,booking_id,schedule_group_id,provider_id,provider_name,provider_model,service_code,scheduled_start,scheduled_end,occurrence_count,status,assignment_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,1,?,'{}',?,?)")
    .run(`WO-${id}`, id, groupId, providerId, providerId, "full_time", serviceCode, PAST, FUTURE, status === "assigned" ? "accepted" : "assigned", NOW, NOW);
}

function seedBoardingStay(w, { stayId, bookingId, providerId = "host_1", status, carePlanStatus, checkInStatus = "pending" }) {
  w.sqlite.prepare("INSERT INTO boarding_stays (id,booking_id,customer_id,host_provider_id,city_id,zone_id,package_code,check_in_at,check_out_at,billed_units,pet_count,status,care_plan_status,check_in_status,check_out_status,extension_status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(stayId, bookingId, "CUS-1", providerId, "blr", "blr-east", "boarding-4h", PAST, FUTURE, 1, 1, status, carePlanStatus, checkInStatus, "pending", "none", NOW, NOW);
}

function seedWalkingSession(w, { sessionId, bookingId, providerId = "walker_1", status, handoverStatus = "pending" }) {
  w.sqlite.prepare("INSERT INTO walking_sessions (id,booking_id,schedule_group_id,reservation_id,provider_id,occurrence_number,scheduled_start,scheduled_end,status,handover_status,completion_status,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?,?,?,'pending',?,?)")
    .run(sessionId, bookingId, "GRP-1", `RES-${sessionId}`, providerId, PAST, FUTURE, status, handoverStatus, NOW, NOW);
}

function seedTaxiTrip(w, { tripId, bookingId, providerId = "driver_1", status, pickup = "pending" }) {
  w.sqlite.prepare("INSERT INTO taxi_trips (id,booking_id,schedule_group_id,reservation_id,provider_id,origin_label,destination_label,route_code,synthetic_distance_km,estimated_duration_minutes,scheduled_start,scheduled_end,status,pickup_verification_status,dropoff_verification_status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(tripId, bookingId, "GRP-1", `RES-${tripId}`, providerId, "Indiranagar", "Vet clinic", "R1", 5, 20, PAST, FUTURE, status, pickup, "pending", NOW, NOW);
}

/** Return the thrown value, or fail loudly if the call unexpectedly succeeded. */
async function refused(promise, label) {
  try { await promise; } catch (error) { return error; }
  assert.fail(`${label}: expected a refusal, but the call succeeded`);
}

/**
 * Exactly what every consuming route does in its catch block: `return authError(error, fallback)`.
 * Returns what the partner's browser would actually receive.
 */
async function throughRouteCatch(error, fallback) {
  const response = authError(error, fallback);
  const text = await response.clone().text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* a plain-sentence body is legitimate for some routes */ }
  return { status: response.status, text, message: parsed && typeof parsed.error === "string" ? parsed.error : text };
}

/**
 * Assert the caller was told the real reason with the real status - not the route's fallback.
 *
 * The body a caller would receive is computed FIRST and quoted in every failure message, so a
 * regression reads as "the partner was shown <fallback> instead of <reason>" rather than as an
 * abstract boolean about a WeakSet.
 */
async function assertRealReasonSurvives(error, { fallback, status, reason, label }) {
  assert.ok(error instanceof Response, `${label}: the refusal must be a Response, got ${error?.constructor?.name}: ${error?.message ?? ""}`);
  const seen = await throughRouteCatch(error, fallback);
  const shown = `the partner was shown ${seen.status} "${seen.message}"; the server knew "${reason}"`;
  assert.ok(isGovernedHttpError(error), `${label}: the refusal is NOT registered as a governed 4xx, so authError replaced its body with the route fallback - ${shown}`);
  assert.equal(seen.status, status, `${label}: status must be preserved - ${shown}`);
  assert.notEqual(seen.message, fallback, `${label}: the partner must be told the real reason, not the route fallback - ${shown}`);
  assert.equal(seen.message, reason, `${label}: the exact server-side sentence must survive - ${shown}`);
  return seen;
}

// ---------------------------------------------------------------------------
// 1. lib/boarding-stay-lifecycle.ts - the exact 409 measured on POST /api/boarding-stays.
// ---------------------------------------------------------------------------
test("boarding-stay-lifecycle: check-in refused for a missing care plan reaches the host as the real reason", async () => {
  const w = world();
  const lifecycle = await import("../lib/boarding-stay-lifecycle.ts");
  await lifecycle.ensureBoardingStayLifecycleTables(w.db);
  seedBooking(w, { id: "BKG-B1", serviceCode: "boarding", status: "assigned", providerId: "host_1" });
  seedBoardingStay(w, { stayId: "STAY-B1", bookingId: "BKG-B1", status: "confirmed", carePlanStatus: "required" });

  const error = await refused(lifecycle.mutateBoardingStay(w.db, { stayId: "STAY-B1", action: "check_in", actorId: "host_1", idempotencyKey: "gov-b1" }), "boarding check_in");
  await assertRealReasonSurvives(error, {
    fallback: "Unable to update Boarding stay",
    status: 409,
    reason: "A ready care plan is required before check-in",
    label: "boarding check_in",
  });
});

// ---------------------------------------------------------------------------
// 2. lib/boarding-proof-governance.ts - one of the fourteen exact media reasons the host never saw.
// ---------------------------------------------------------------------------
test("boarding-proof-governance: a missing media asset names itself instead of 'Unable to update Boarding proof records'", async () => {
  const w = world();
  const lifecycle = await import("../lib/boarding-stay-lifecycle.ts");
  const proof = await import("../lib/boarding-proof-governance.ts");
  await lifecycle.ensureBoardingStayLifecycleTables(w.db);
  await proof.ensureBoardingProofTables(w.db);
  seedBooking(w, { id: "BKG-B2", serviceCode: "boarding", status: "in_progress", providerId: "host_1" });
  seedBoardingStay(w, { stayId: "STAY-B2", bookingId: "BKG-B2", status: "in_progress", carePlanStatus: "ready", checkInStatus: "complete" });

  const error = await refused(proof.mutateBoardingProof(w.db, {
    stayId: "STAY-B2", action: "record_daily_update", actorId: "host_1", idempotencyKey: "gov-b2",
    note: "Bruno ate well and played in the garden", mediaRef: "media://asset/BMEDIA-DOESNOTEXIST",
  }), "boarding proof");
  await assertRealReasonSurvives(error, {
    fallback: "Unable to update Boarding proof records",
    status: 409,
    reason: "Boarding media asset does not exist",
    label: "boarding proof",
  });
});

// ---------------------------------------------------------------------------
// 3. lib/walking-lifecycle.ts
// ---------------------------------------------------------------------------
test("walking-lifecycle: handover before walker acceptance reaches the walker as the real reason", async () => {
  const w = world();
  const lifecycle = await import("../lib/walking-lifecycle.ts");
  const ops = await import("../lib/walking-ops-governance.ts");
  await lifecycle.ensureWalkingLifecycleTables(w.db);
  await ops.ensureWalkingOpsTables(w.db);
  seedBooking(w, { id: "BKG-W1", serviceCode: "dog_walking", status: "confirmed", providerId: "walker_1" });
  seedWalkingSession(w, { sessionId: "WSESS-W1", bookingId: "BKG-W1", status: "scheduled" });

  const error = await refused(lifecycle.mutateWalkingBooking(w.db, {
    bookingId: "BKG-W1", action: "confirm_handover", actorId: "walker_1", idempotencyKey: "gov-w1", sessionId: "WSESS-W1",
  }), "walking confirm_handover");
  await assertRealReasonSurvives(error, {
    fallback: "Unable to update Dog Walking lifecycle",
    status: 409,
    reason: "Walker acceptance is required before handover",
    label: "walking confirm_handover",
  });
});

// ---------------------------------------------------------------------------
// 4. lib/walking-proof-governance.ts
// ---------------------------------------------------------------------------
test("walking-proof-governance: a missing media asset names itself instead of the route fallback", async () => {
  const w = world();
  const lifecycle = await import("../lib/walking-lifecycle.ts");
  const ops = await import("../lib/walking-ops-governance.ts");
  const proof = await import("../lib/walking-proof-governance.ts");
  await lifecycle.ensureWalkingLifecycleTables(w.db);
  await ops.ensureWalkingOpsTables(w.db);
  await proof.ensureWalkingProofTables(w.db);
  seedBooking(w, { id: "BKG-W2", serviceCode: "dog_walking", status: "in_progress", providerId: "walker_1" });
  seedWalkingSession(w, { sessionId: "WSESS-W2", bookingId: "BKG-W2", status: "in_progress", handoverStatus: "complete" });

  const error = await refused(proof.mutateWalkingProof(w.db, {
    bookingId: "BKG-W2", action: "record_photo_update", actorId: "walker_1", idempotencyKey: "gov-w2",
    sessionId: "WSESS-W2", note: "Halfway through the walk", mediaRef: "media://asset/WMEDIA-DOESNOTEXIST",
  }), "walking proof");
  await assertRealReasonSurvives(error, {
    fallback: "Unable to update Dog Walking proof records",
    status: 409,
    reason: "Dog Walking media asset does not exist",
    label: "walking proof",
  });
});

// ---------------------------------------------------------------------------
// 5. lib/taxi-lifecycle.ts
// ---------------------------------------------------------------------------
test("taxi-lifecycle: accepting a booking that is not awaiting acceptance reaches the driver as the real reason", async () => {
  const w = world();
  const lifecycle = await import("../lib/taxi-lifecycle.ts");
  const ops = await import("../lib/taxi-ops-governance.ts");
  await lifecycle.ensureTaxiLifecycleTables(w.db);
  await ops.ensureTaxiOpsTables(w.db);
  seedBooking(w, { id: "BKG-T1", serviceCode: "pet_taxi", status: "assigned", providerId: "driver_1" });
  seedTaxiTrip(w, { tripId: "TRIP-T1", bookingId: "BKG-T1", status: "accepted" });

  const error = await refused(lifecycle.mutateTaxiBooking(w.db, {
    bookingId: "BKG-T1", action: "accept", actorId: "driver_1", idempotencyKey: "gov-t1",
  }), "taxi accept");
  await assertRealReasonSurvives(error, {
    fallback: "Unable to update Pet Taxi lifecycle",
    status: 409,
    reason: "Pet Taxi booking is not awaiting driver acceptance",
    label: "taxi accept",
  });
});

// ---------------------------------------------------------------------------
// 6. lib/taxi-proof-governance.ts
// ---------------------------------------------------------------------------
test("taxi-proof-governance: a missing media asset names itself instead of the route fallback", async () => {
  const w = world();
  const lifecycle = await import("../lib/taxi-lifecycle.ts");
  const ops = await import("../lib/taxi-ops-governance.ts");
  const proof = await import("../lib/taxi-proof-governance.ts");
  await lifecycle.ensureTaxiLifecycleTables(w.db);
  await ops.ensureTaxiOpsTables(w.db);
  await proof.ensureTaxiProofTables(w.db);
  seedBooking(w, { id: "BKG-T2", serviceCode: "pet_taxi", status: "in_progress", providerId: "driver_1" });
  seedTaxiTrip(w, { tripId: "TRIP-T2", bookingId: "BKG-T2", status: "in_progress", pickup: "complete" });

  const error = await refused(proof.mutateTaxiProof(w.db, {
    bookingId: "BKG-T2", action: "record_photo_update", actorId: "driver_1", idempotencyKey: "gov-t2",
    note: "Pet secured in the carrier", mediaRef: "media://asset/TMEDIA-DOESNOTEXIST",
  }), "taxi proof");
  await assertRealReasonSurvives(error, {
    fallback: "Unable to update Pet Taxi proof records",
    status: 409,
    reason: "Pet Taxi media asset does not exist",
    label: "taxi proof",
  });
});

// ---------------------------------------------------------------------------
// 7. lib/sitting-proof-governance.ts
// ---------------------------------------------------------------------------
test("sitting-proof-governance: a missing media asset names itself instead of the route fallback", async () => {
  const w = world();
  const sitting = await import("../lib/sitting-lifecycle.ts");
  const proof = await import("../lib/sitting-proof-governance.ts");
  await sitting.ensureSittingLifecycleTables(w.db);
  await proof.ensureSittingProofTables(w.db);
  seedBooking(w, { id: "BKG-S1", serviceCode: "pet_sitting", status: "in_progress", providerId: "sitter_1" });

  const error = await refused(proof.mutateSittingProof(w.db, {
    bookingId: "BKG-S1", action: "record_update", actorId: "sitter_1", idempotencyKey: "gov-s1",
    note: "Settled in for the evening", mediaRef: "media://asset/SMEDIA-DOESNOTEXIST",
  }), "sitting proof");
  await assertRealReasonSurvives(error, {
    fallback: "Unable to update Sitting proof records",
    status: 409,
    reason: "Sitting media asset does not exist",
    label: "sitting proof",
  });
});

// ---------------------------------------------------------------------------
// 8. lib/walking-governance.ts - the one module whose consumers read the body with response.text().
//
// app/api/walking-bookings/route.ts and app/api/walking-commercial/route.ts both unwrap a thrown
// Response with `json({error: await error.text()}, error.status)`. A JSON body here would be
// double-encoded into {"error":"{\"error\":\"...\"}"} and shown to a customer verbatim - the defect
// tests/ptja-p1-governed-refusal-envelope.test.mjs pins on /api/canonical-bookings. So this module's
// refusals are governed while their bodies stay plain sentences.
// ---------------------------------------------------------------------------

/** Verbatim shape of app/api/walking-bookings/route.ts failure(). */
async function walkingBookingsFailure(error) {
  if (error instanceof Response) {
    const message = await error.clone().text().catch(() => "");
    return { status: error.status || 500, body: { error: message || "Dog Walking booking failed" } };
  }
  return { status: 500, body: { error: error instanceof Error ? error.message : "Dog Walking booking failed" } };
}

test("walking-governance: the quote refusal is governed AND stays a plain sentence for its .text() consumers", async () => {
  const w = world();
  const governance = await import("../lib/walking-governance.ts");
  await governance.ensureWalkingGovernanceTables(w.db);

  const error = await refused(governance.createWalkingQuote(w.db, {
    packageCode: "walking-30", mode: "once", petCount: 1, walkCount: 1,
    scheduledStart: FUTURE, scheduledEnd: new Date(NOW + 86_400_000 + 30 * 60_000).toISOString(),
    paymentMode: "prepaid",
  }), "walking quote");

  const REASON = "Dog Walking Gate 1 uses pay-after-service UAT billing only";
  assert.ok(error instanceof Response, "the refusal must be a Response");
  assert.equal(error.status, 409);

  // Through authError (a route that ever routes this module's throws there gets the sentence, not a fallback).
  const seen = await throughRouteCatch(error, "Dog Walking commercial request failed");
  const shown = `the customer was shown ${seen.status} "${seen.message}"; the server knew "${REASON}"`;
  assert.ok(isGovernedHttpError(error), `the refusal is NOT registered as a governed 4xx, so authError replaced its body with the route fallback - ${shown}`);
  assert.equal(seen.status, 409, shown);
  assert.equal(seen.text, REASON, shown);

  // Through the mechanism the two real consumers actually use.
  const unwrapped = await walkingBookingsFailure(error);
  assert.equal(unwrapped.status, 409);
  assert.equal(unwrapped.body.error, "Dog Walking Gate 1 uses pay-after-service UAT billing only");
  assert.doesNotMatch(unwrapped.body.error, /^\s*[{[]/, "the customer must never be shown a JSON envelope");
  assert.doesNotMatch(unwrapped.body.error, /\\"|"error"/, "nor an escaped one");
});

// ---------------------------------------------------------------------------
// CONTROLS. These prove the suite pins GOVERNANCE, not merely "a 4xx happened".
// ---------------------------------------------------------------------------
test("control: an UNGOVERNED thrown Response is still redacted to the route fallback", async () => {
  const ungoverned = new Response("A precise reason nobody approved for a caller", { status: 409 });
  assert.equal(isGovernedHttpError(ungoverned), false, "a bare Response must never be trusted");

  const seen = await throughRouteCatch(ungoverned, "Unable to update Boarding stay");
  assert.equal(seen.status, 409, "the status still passes through");
  assert.equal(seen.message, "Unable to update Boarding stay", "but the body MUST be the fallback");
  assert.doesNotMatch(seen.text, /A precise reason nobody approved/, "an unapproved sentence must not reach the caller");
});

test("control: a platform fault is still a redacted 500, never a plausible 4xx", async () => {
  for (const fault of [new TypeError("Cannot read properties of undefined (reading 'id')"), new Error("D1_ERROR: no such column: care_plan_status at offset 42")]) {
    const seen = await throughRouteCatch(fault, "Unable to update Boarding stay");
    assert.equal(seen.status, 500, `a ${fault.constructor.name} must stay a 500`);
    assert.equal(seen.message, "Unable to update Boarding stay", "and must be redacted");
    assert.doesNotMatch(seen.text, /D1_ERROR|undefined \(reading/, "the internal detail must not leak");
  }
});

test("control: a D1 failure raised INSIDE a converted module still surfaces as a redacted 500", async () => {
  const w = world();
  const lifecycle = await import("../lib/boarding-stay-lifecycle.ts");
  await lifecycle.ensureBoardingStayLifecycleTables(w.db);
  seedBooking(w, { id: "BKG-B3", serviceCode: "boarding", status: "assigned", providerId: "host_1" });
  seedBoardingStay(w, { stayId: "STAY-B3", bookingId: "BKG-B3", status: "confirmed", carePlanStatus: "required" });

  // The stay lookup itself fails the way D1 fails - after the module's own input gates have passed.
  const brokenDb = {
    ...w.db,
    prepare(sql) {
      if (/FROM boarding_stays s JOIN canonical_bookings/.test(sql)) {
        return { bind: () => ({ first: async () => { throw new Error("D1_ERROR: database is locked at offset 17"); } }) };
      }
      return w.db.prepare(sql);
    },
  };

  const error = await refused(lifecycle.mutateBoardingStay(brokenDb, { stayId: "STAY-B3", action: "check_in", actorId: "host_1", idempotencyKey: "gov-b3" }), "broken D1");
  assert.ok(!(error instanceof Response), "a D1 failure must not be dressed up as an HTTP refusal");
  const seen = await throughRouteCatch(error, "Unable to update Boarding stay");
  assert.equal(seen.status, 500, "a platform fault must stay a 500 so the defect is visible");
  assert.equal(seen.message, "Unable to update Boarding stay");
});

test("the WeakSet is checked against the live instance, so the assertions above are not vacuous", async () => {
  const w = world();
  const lifecycle = await import("../lib/boarding-stay-lifecycle.ts");
  await lifecycle.ensureBoardingStayLifecycleTables(w.db);
  seedBooking(w, { id: "BKG-B4", serviceCode: "boarding", status: "assigned", providerId: "host_1" });
  seedBoardingStay(w, { stayId: "STAY-B4", bookingId: "BKG-B4", status: "confirmed", carePlanStatus: "required" });
  const error = await refused(lifecycle.mutateBoardingStay(w.db, { stayId: "STAY-B4", action: "check_in", actorId: "host_1", idempotencyKey: "gov-b4" }), "identity check");

  assert.ok(isGovernedHttpError(error), "the graph this suite asserts against recognises the refusal");
  assert.equal(detachedGovernance.isGovernedHttpError(error), false,
    "a SECOND copy of lib/governed-http-error.ts must NOT recognise it - that is precisely why every module in this suite is loaded from one graph; mixing graphs would make every assertion above pass vacuously");
});

// ---------------------------------------------------------------------------
// Requirement 3, pinned. These five throws are deliberately NOT governed: each reports canonical data
// that is absent or malformed, which no caller did and no caller can correct. Turning one into a
// plausible 4xx would bury a real platform defect behind a partner-facing sentence.
// ---------------------------------------------------------------------------
test("platform faults in these modules stay raw, so they keep surfacing as redacted 500s", async () => {
  const { readFileSync } = await import("node:fs");
  const expected = [
    ["lib/walking-lifecycle.ts", 'throw new Response("Canonical per-walk amount is missing",{status:409})'],
    ["lib/walking-lifecycle.ts", 'throw new Response("Dog Walking completion idempotency record is missing",{status:500})'],
    ["lib/taxi-lifecycle.ts", 'throw new Response("Canonical Pet Taxi amount is missing",{status:409})'],
    ["lib/taxi-lifecycle.ts", 'throw new Response("Pet Taxi final balance is invalid",{status:409})'],
    ["lib/taxi-lifecycle.ts", 'throw new Response("Pet Taxi completion payment event was not recorded",{status:500})'],
  ];
  for (const [file, snippet] of expected) {
    assert.ok(readFileSync(new URL(`../${file}`, import.meta.url), "utf8").includes(snippet),
      `${file} must keep this throw ungoverned - it reports corrupt canonical data, not a caller mistake: ${snippet}`);
  }
});
