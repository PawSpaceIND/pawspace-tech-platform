import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";

// ---------------------------------------------------------------------------
// Module hooks: (1) extensionless relative .ts imports for Node's native ESM
// loader, and (2) a live "cloudflare:workers" shim so the REAL API route
// handlers run in-process against a node:sqlite-backed D1. env is a Proxy so
// each test can swap globalThis.__PAWSPACE_TEST_ENV without stale bindings.
// ---------------------------------------------------------------------------
const WORKERS_SHIM = `export const env = new Proxy({}, { get: (_, key) => globalThis.__PAWSPACE_TEST_ENV?.[key] });`;
const workersUrl = `data:text/javascript,${encodeURIComponent(WORKERS_SHIM)}`;

if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true };
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context);
        throw error;
      }
    },
  });
} else {
  const hook = `const workersUrl = ${JSON.stringify(workersUrl)};
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true };
    try { return await nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(specifier + ".ts", context);
      throw error;
    }
  }`;
  nodeModule.register(new URL(`data:text/javascript,${encodeURIComponent(hook)}`));
}

const walkingLifecycle = await import("../lib/walking-lifecycle.ts");
const walkingGovernance = await import("../lib/walking-governance.ts");
const walkingOps = await import("../lib/walking-ops-governance.ts");
const walkingFinance = await import("../lib/walking-finance-governance.ts");
const walkingProof = await import("../lib/walking-proof-governance.ts");
const walkingRecovery = await import("../lib/walking-recovery-governance.ts");
const taxiLifecycle = await import("../lib/taxi-lifecycle.ts");
const taxiOps = await import("../lib/taxi-ops-governance.ts");
const taxiFinance = await import("../lib/taxi-finance-governance.ts");
const taxiProof = await import("../lib/taxi-proof-governance.ts");
const taxiRecovery = await import("../lib/taxi-recovery-governance.ts");
const commercialTerms = await import("../lib/provider-commercial-terms.ts");
const capacity = await import("../lib/provider-capacity-governance.ts");
const providerDailyTravel = await import("../lib/provider-daily-travel.ts");
const walkingBookingsRoute = await import("../app/api/walking-bookings/route.ts");
const partnerFeedRoute = await import("../app/api/partner-job-feed/route.ts");

// ---------------------------------------------------------------------------
// D1-over-node:sqlite shim (with meta.changes) + escape-aware DDL extraction.
// ---------------------------------------------------------------------------
function makeD1(sqlite) {
  function statement(sql, args) {
    return {
      bind: (...boundArgs) => statement(sql, boundArgs),
      first: async () => {
        const row = sqlite.prepare(sql).get(...args);
        return row === undefined ? null : row;
      },
      run: async () => {
        const info = sqlite.prepare(sql).run(...args);
        return { success: true, meta: { changes: Number(info.changes) } };
      },
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    };
  }
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (statements) => {
      const results = [];
      for (const stmt of statements) results.push(await stmt.run());
      return results;
    },
  };
}

function statementsOf(source) {
  const out = [];
  const pattern = /\.prepare\(\s*(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
  let match;
  while ((match = pattern.exec(source))) out.push(match[2].replace(/\\(["'`\\])/g, "$1"));
  return out;
}
const schedulingDDL = statementsOf(fs.readFileSync("app/api/uat-scheduling/route.ts", "utf8")).filter((sql) => /^CREATE (TABLE|INDEX|UNIQUE INDEX)/i.test(sql.trim()));
// canonical_bookings / provider_work_orders / booking_payments / canonical_customers etc. — copied
// verbatim from their owning route (app/api/walking-bookings ensureTables) per the real DDL.
const canonicalDDL = statementsOf(fs.readFileSync("app/api/walking-bookings/route.ts", "utf8")).filter((sql) => /^CREATE (TABLE|INDEX|UNIQUE INDEX)/i.test(sql.trim()));

const DAY = 86_400_000;
const NOW = Date.now();
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();
const SHA = "a".repeat(64);
const FIXTURE_DOORSTEP = Object.freeze({
  address: "Bengaluru, Karnataka",
  latitude: 12.9716,
  longitude: 77.5946,
});

async function rejects(promise, status, pattern) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof Response, `expected a Response throw, got ${error}`);
    assert.equal(error.status, status, `expected HTTP ${status}, got ${error.status}: ${await error.clone().text()}`);
    const text = await error.text();
    assert.match(text, pattern);
    return;
  }
  assert.fail(`expected rejection matching ${pattern}`);
}

// ---------------------------------------------------------------------------
// Stack builder: every table comes from its REAL owner — the walking/taxi
// ensure-chains, the provider capacity lib, and the uat-scheduling route DDL.
// ---------------------------------------------------------------------------
async function opsStack() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PAWSPACE_TEST_ENV = { DB: db };
  const auth = await import("../lib/server-auth.ts");
  await auth.ensureSecurityTables(db);
  for (const sql of [...schedulingDDL, ...canonicalDDL]) sqlite.exec(sql);
  await capacity.seedProviderCapacityDefaults(db);
  await providerDailyTravel.ensureProviderDailyTravelTables(db);
  await walkingOps.ensureWalkingOpsTables(db);
  await walkingProof.ensureWalkingProofTables(db);
  await taxiOps.ensureTaxiOpsTables(db);
  await taxiProof.ensureTaxiProofTables(db);

  const seedProvider = (id, { services = ["dog_walking"], name = id, model = "full_time" } = {}) =>
    sqlite.prepare("INSERT INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES (?,?,?,?,?,?,1,4.5,90,1,0,10,3,'active',1,'2026-08-01',NULL,'test',?)")
      .run(id, "tstcity", name, model, JSON.stringify(services), JSON.stringify(["tst-zone"]), NOW);

  const seedVehicle = (vehicleId, providerId) =>
    sqlite.prepare("INSERT INTO taxi_vehicle_profiles (id,provider_id,label,vehicle_type,pet_restraint,inspection_status,active,updated_at) VALUES (?,?,?,?,?,'uat_verified',1,?)")
      .run(vehicleId, providerId, `${providerId} vehicle`, "hatchback", "rear-seat harness", NOW);

  const seedServiceAddress = (bookingId) =>
    sqlite.prepare("INSERT INTO booking_service_addresses (booking_id,address,latitude,longitude,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
      .run(bookingId, FIXTURE_DOORSTEP.address, FIXTURE_DOORSTEP.latitude, FIXTURE_DOORSTEP.longitude, "test_fixture", NOW, NOW);

  async function seedActiveCommercialTerm({ serviceCode, providerId }) {
    const draft = await commercialTerms.saveCommercialTerm(db, {
      serviceCode,
      providerId,
      engagementModel: "commission_standard",
      providerSharePct: 0.70,
      effectiveFrom: "2026-01-01",
      reason: `${serviceCode} hardening fixture terms`,
      actorId: "commercial-maker@test",
    });
    await commercialTerms.activateCommercialTerm(db, {
      termId: draft.id,
      approvalReference: `TEST-${serviceCode.toUpperCase()}`,
      actorId: "commercial-checker@test",
    });
    return draft.id;
  }

  await seedActiveCommercialTerm({ serviceCode: "pet_taxi", providerId: null });
  await seedActiveCommercialTerm({ serviceCode: "dog_walking", providerId: null });

  // Creates a Dog Walking booking through the REAL customer path: server quote
  // (lib/walking-governance) + POST /api/walking-bookings route handler.
  async function createWalkingBooking({ tag, providerId, walkCount = 2, customerId = `CUS-${tag}` }) {
    const groupId = `GRP-${tag}`;
    const windows = Array.from({ length: walkCount }, (_, index) => ({
      occurrence: index + 1,
      start: iso((2 + index) * DAY),
      end: iso((2 + index) * DAY + 30 * 60_000),
    }));
    sqlite.prepare("INSERT INTO scheduling_assignment_decisions (group_id,strategy,shortlist_json,selected_provider_id,status,actor_id,reason,updated_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(groupId, "governed", "[]", providerId, "assigned", "test", "test", NOW);
    for (const window of windows)
      sqlite.prepare("INSERT INTO scheduling_reservations (id, group_id, provider_id, service_code, city_id, zone_id, customer_id, pet_ids_json, scheduled_start, scheduled_end, capacity_units, occurrence_number, care_mode, status, explanation_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(`RES-${tag}-${window.occurrence}`, groupId, providerId, "dog_walking", "tstcity", "tst-zone", customerId, "[]", window.start, window.end, 1, window.occurrence, "once", "held", "{}", NOW);
    const weekdays = walkCount === 1 ? [] : [...new Set(windows.map((window) => new Date(window.start).getUTCDay()))];
    const quote = await walkingGovernance.createWalkingQuote(db, {
      packageCode: "walking-30", mode: walkCount === 1 ? "once" : "recurring", petCount: 1, walkCount,
      weekdays, scheduledStart: windows[0].start, scheduledEnd: windows[0].end, paymentMode: "pay_after_service",
    });
    const actorEmail = `walking.${customerId.toLowerCase().replace(/[^a-z0-9]+/g, ".")}@fixture.pawspace.test`;
    sqlite.prepare("INSERT OR REPLACE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,'customer','active',?,?)")
      .run(`USR-WALK-${tag}`, actorEmail, "Walking customer fixture", NOW, NOW);
    sqlite.prepare("INSERT OR REPLACE INTO customer_identity_links (email,customer_id,status,verified_at,updated_at) VALUES (?,?,'active',?,?)")
      .run(actorEmail, customerId, NOW, NOW);
    const response = await walkingBookingsRoute.POST(new Request("http://localhost/api/walking-bookings", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "oai-authenticated-user-email": actorEmail,
      },
      body: JSON.stringify({
        idempotencyKey: `book-${tag}`, scheduleGroupId: groupId, walkingQuoteId: quote.quoteId,
        customer: { id: customerId, name: "Test Customer", primaryPhone: "9999900001" },
        pets: [{ sourceId: "bruno", name: "Bruno" }],
        cityId: "tstcity", zoneId: "tst-zone", packageCode: quote.packageCode, packageName: quote.packageName,
        walkCount, weekdays: quote.weekdays, scheduledStart: quote.scheduledStart, scheduledEnd: quote.scheduledEnd,
        provider: { id: providerId, name: providerId, model: "full_time" },
        totalAmount: quote.totalAmount, amountDueNow: 0,
        payment: { method: "upi", mode: "pay_after_service", detail: "pay after each walk" },
      }),
    }));
    const clone = response.clone();
    let errText = "";
    try { errText = await clone.text(); } catch (e) {}
    if (response.status !== 201) {
      console.error(">>> ROUTE_FAILURE_PAYLOAD:", response.status, errText);
    }
    const payload = JSON.parse(errText || "{}");
    assert.equal(response.status, 201, `walking booking route failed: ${errText}`);
    seedServiceAddress(payload.data.bookingId);
    return { bookingId: payload.data.bookingId, groupId, customerId, sessions: payload.data.sessions, quote, payload };
  }

  function seedTaxiBooking({ tag, providerId, customerId = `CUS-${tag}`, amount = 599 }) {
    const bookingId = `PS-UAT-TAXI-${tag}`, groupId = `GRP-${tag}`, tripId = `TRIP-${tag}`, reservationId = `RES-${tag}-1`;
    const start = iso(2 * DAY), end = iso(2 * DAY + 45 * 60_000);
    sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(bookingId, `idem-${tag}`, customerId, "[]", "[]", "tstcity", "tst-zone", "pet_taxi", "taxi-city", "City Pet Taxi", groupId, providerId, start, end, "confirmed", "customer_app", amount, "INR", "{}", "test", NOW, NOW);
    sqlite.prepare("INSERT INTO provider_work_orders (id,booking_id,schedule_group_id,provider_id,provider_name,provider_model,service_code,scheduled_start,scheduled_end,occurrence_count,status,assignment_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,1,'assigned','{}',?,?)")
      .run(`WO-${tag}`, bookingId, groupId, providerId, providerId, "full_time", "pet_taxi", start, end, NOW, NOW);
    sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,currency,method,mode,status,gateway,idempotency_key,detail_json,created_at,updated_at) VALUES (?,?,?,?,0,'INR','upi','pay_after_service','created','uat_sandbox',?,'{}',?,?)")
      .run(`PAY-${tag}`, bookingId, customerId, amount, `pay-${tag}`, NOW, NOW);
    sqlite.prepare("INSERT INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,care_mode,status,explanation_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,1,1,NULL,'assigned','{}',?)")
      .run(reservationId, groupId, providerId, "pet_taxi", "tstcity", "tst-zone", customerId, "[]", start, end, NOW);
    sqlite.prepare("INSERT INTO scheduling_assignment_decisions (group_id,strategy,shortlist_json,selected_provider_id,status,actor_id,reason,updated_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(groupId, "governed", "[]", providerId, "assigned", "test", "test", NOW);
    sqlite.prepare("INSERT INTO taxi_trips (id,booking_id,schedule_group_id,reservation_id,provider_id,origin_label,destination_label,route_code,synthetic_distance_km,estimated_duration_minutes,scheduled_start,scheduled_end,status,vehicle_id,pickup_verification_status,dropoff_verification_status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'scheduled',NULL,'pending','pending',?,?)")
      .run(tripId, bookingId, groupId, reservationId, providerId, "Home", "Vet clinic", "TST-R1", 8.4, 45, start, end, NOW, NOW);
    seedServiceAddress(bookingId);
    return { bookingId, groupId, tripId, reservationId, customerId, amount };
  }

  return { sqlite, db, seedProvider, seedVehicle, seedActiveCommercialTerm, createWalkingBooking, seedTaxiBooking };
}

const wMutate = (stack, bookingId, action, extra = {}) =>
  walkingLifecycle.mutateWalkingBooking(stack.db, {
    bookingId,
    action,
    actorId: extra.actorId ?? "walker1@test",
    idempotencyKey: extra.idempotencyKey ?? crypto.randomUUID(),
    ...(action === "start_walk" ? { latitude: FIXTURE_DOORSTEP.latitude, longitude: FIXTURE_DOORSTEP.longitude } : {}),
    ...extra,
  });
const tMutate = (stack, bookingId, action, extra = {}) =>
  taxiLifecycle.mutateTaxiBooking(stack.db, { bookingId, action, actorId: extra.actorId ?? "driver1@test", idempotencyKey: extra.idempotencyKey ?? crypto.randomUUID(), ...extra });
const wProof = (stack, bookingId, action, extra = {}) =>
  walkingProof.mutateWalkingProof(stack.db, { bookingId, action, actorId: extra.actorId ?? "walker1@test", idempotencyKey: extra.idempotencyKey ?? crypto.randomUUID(), ...extra });
const tProof = (stack, bookingId, action, extra = {}) =>
  taxiProof.mutateTaxiProof(stack.db, { bookingId, action, actorId: extra.actorId ?? "driver1@test", idempotencyKey: extra.idempotencyKey ?? crypto.randomUUID(), ...extra });
const wFinance = (stack, bookingId, action, extra = {}) =>
  walkingFinance.mutateWalkingFinance(stack.db, { bookingId, action, actorId: extra.actorId ?? "finance@test", idempotencyKey: extra.idempotencyKey ?? crypto.randomUUID(), ...extra });
const tFinance = (stack, bookingId, action, extra = {}) =>
  taxiFinance.mutateTaxiFinance(stack.db, { bookingId, action, actorId: extra.actorId ?? "finance@test", idempotencyKey: extra.idempotencyKey ?? crypto.randomUUID(), ...extra });

async function sample(stack, bookingId, sessionId, index) {
  return wProof(stack, bookingId, "record_location_sample", { sessionId, latitude: 12.9 + index / 1000, longitude: 77.6, accuracyMeters: 12 });
}
async function completeWalkingSession(stack, bookingId, sessionId, actorId = "walker1@test") {
  await wMutate(stack, bookingId, "confirm_handover", { sessionId, handoverMethod: "owner", actorId });
  await wMutate(stack, bookingId, "start_walk", { sessionId, actorId });
  await sample(stack, bookingId, sessionId, 1);
  await sample(stack, bookingId, sessionId, 2);
  return wMutate(stack, bookingId, "complete_walk", { sessionId, actorId });
}

// ---------------------------------------------------------------------------
// 1. Full chain (task 2): real customer booking path -> session rows -> partner
//    job feed -> lifecycle completion -> finance settlement over completed
//    occurrences only.
// ---------------------------------------------------------------------------
test("full chain: walking-flow booking path -> walking_sessions -> partner job feed -> completion -> finance", async () => {
  const stack = await opsStack();
  const { sqlite } = stack;
  stack.seedProvider("walker_one");
  await stack.seedActiveCommercialTerm({ serviceCode: "dog_walking", providerId: "walker_one" });
  const { bookingId, sessions } = await stack.createWalkingBooking({ tag: "CHAIN", providerId: "walker_one", walkCount: 2 });

  // Session rows exist with the canonical shape the route promised.
  const rows = sqlite.prepare("SELECT id,occurrence_number,status,handover_status,provider_id FROM walking_sessions WHERE booking_id=? ORDER BY occurrence_number").all(bookingId);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => [Number(row.occurrence_number), String(row.status), String(row.handover_status), String(row.provider_id)]), [[1, "scheduled", "pending", "walker_one"], [2, "scheduled", "pending", "walker_one"]]);
  assert.equal(sessions.length, 2);

  // The partner job feed (real route handler) shows the booking to the walker.
  const feedResponse = await partnerFeedRoute.GET(new Request("http://localhost/api/partner-job-feed?providerId=walker_one"));
  assert.equal(feedResponse.status, 200);
  const feedPayload = await feedResponse.json();
  assert.ok(JSON.stringify(feedPayload).includes(bookingId), "partner job feed must include the new walking booking");

  // Lifecycle: accept -> per-session handover/start/evidence/complete.
  const accepted = await wMutate(stack, bookingId, "accept");
  assert.equal(accepted.status, "assigned");
  const [first, second] = rows.map((row) => String(row.id));

  // Completion is route-evidence gated and start requires a confirmed handover.
  await rejects(wMutate(stack, bookingId, "start_walk", { sessionId: first }), 409, /Confirmed handover is required/);
  await wMutate(stack, bookingId, "confirm_handover", { sessionId: first, handoverMethod: "owner" });
  await wMutate(stack, bookingId, "start_walk", { sessionId: first });
  await rejects(wMutate(stack, bookingId, "complete_walk", { sessionId: first }), 409, /requires at least two canonical sandbox route samples/);
  await sample(stack, bookingId, first, 1);
  await sample(stack, bookingId, first, 2);
  const firstDone = await wMutate(stack, bookingId, "complete_walk", { sessionId: first, idempotencyKey: "chain-complete-1" });
  assert.equal(firstDone.status, "completed");
  assert.equal(firstDone.amount, 349);
  assert.equal(firstDone.allComplete, false);
  const replay = await wMutate(stack, bookingId, "complete_walk", { sessionId: first, idempotencyKey: "chain-complete-1" });
  assert.equal(replay.duplicatePrevented, true, "a consumed idempotency key must be replay-safe");

  const secondDone = await completeWalkingSession(stack, bookingId, second);
  assert.equal(secondDone.allComplete, true);
  assert.equal(sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(bookingId).status, "completed");

  // Finance sees exactly the completed occurrences: one due event per completed walk.
  const events = sqlite.prepare("SELECT session_id,amount,status FROM walking_session_payment_events WHERE booking_id=? ORDER BY session_id").all(bookingId);
  assert.deepEqual(events.map((row) => [String(row.session_id), Number(row.amount), String(row.status)]), [[first, 349, "due"], [second, 349, "due"]]);

  // Settlement is blocked while completed walks are unpaid, then derives ONLY from paid completed occurrences.
  await rejects(wFinance(stack, bookingId, "prepare_settlement"), 409, /must be sandbox-paid before settlement/);
  const pay1 = await wFinance(stack, bookingId, "record_session_payment", { sessionId: first, paymentReference: "REF-CHAIN-1" });
  assert.equal(pay1.aggregateStatus, "partial");
  const pay2 = await wFinance(stack, bookingId, "record_session_payment", { sessionId: second, paymentReference: "REF-CHAIN-2" });
  assert.equal(pay2.aggregateStatus, "paid");
  assert.equal(sqlite.prepare("SELECT status FROM booking_payments WHERE booking_id=?").get(bookingId).status, "paid");
  const settlement = await wFinance(stack, bookingId, "prepare_settlement");
  assert.equal(settlement.grossPaidValue, 698, "settlement gross must equal the paid completed occurrences only");
  const reconciliation = await wFinance(stack, bookingId, "reconcile");
  assert.equal(reconciliation.completedDueTotal, 698);
  assert.equal(reconciliation.paidTotal, 698);
  assert.equal(reconciliation.unpaidCompletedTotal, 0);
  assert.equal(reconciliation.taxState, "configuration_required", "tax stays configuration_required in UAT");
});

// ---------------------------------------------------------------------------
// 2. D1 regression: mid-programme walker replacement with a handover-confirmed
//    session. Completed sessions preserved; remaining reassigned and walkable.
// ---------------------------------------------------------------------------
test("regression: mid-programme replacement resets handover state so the replacement walker can actually walk", async () => {
  const stack = await opsStack();
  const { sqlite } = stack;
  stack.seedProvider("walker_one");
  stack.seedProvider("walker_two");
  await stack.seedActiveCommercialTerm({ serviceCode: "dog_walking", providerId: "walker_two" });
  const { bookingId } = await stack.createWalkingBooking({ tag: "RECOV", providerId: "walker_one", walkCount: 2 });
  await wMutate(stack, bookingId, "accept");
  const [first, second] = sqlite.prepare("SELECT id FROM walking_sessions WHERE booking_id=? ORDER BY occurrence_number").all(bookingId).map((row) => String(row.id));
  await completeWalkingSession(stack, bookingId, first);

  // Session 2's handover is already confirmed when the walker fails.
  await wMutate(stack, bookingId, "confirm_handover", { sessionId: second, handoverMethod: "building_staff" });
  assert.equal(sqlite.prepare("SELECT handover_status FROM walking_sessions WHERE id=?").get(second).handover_status, "complete");
  const recovery = await wMutate(stack, bookingId, "walker_unavailable", { reason: "Walker injured mid-programme" });
  assert.equal(recovery.status, "ops_escalation");

  // Completed session 1 is preserved verbatim; session 2 is recovery_pending with handover RESET.
  const preserved = sqlite.prepare("SELECT status,provider_id FROM walking_sessions WHERE id=?").get(first);
  assert.deepEqual([String(preserved.status), String(preserved.provider_id)], ["completed", "walker_one"]);
  const pending = sqlite.prepare("SELECT status,handover_status FROM walking_sessions WHERE id=?").get(second);
  assert.deepEqual([String(pending.status), String(pending.handover_status)], ["recovery_pending", "pending"], "recovery must reset handover_status so the replacement can re-confirm");

  const offered = await walkingOps.mutateWalkingOps(stack.db, { bookingId, action: "assign_replacement", actorId: "ops@test", idempotencyKey: crypto.randomUUID(), providerId: "walker_two", reason: "Eligible replacement for remaining walks" });
  assert.equal(offered.status, "replacement_offered");
  assert.equal(offered.remainingSessions, 1);

  // D2 regression: the plain lifecycle accept can no longer swallow a replacement offer.
  await rejects(wMutate(stack, bookingId, "accept", { actorId: "walker2@test" }), 409, /not awaiting walker acceptance/);

  const acceptedReplacement = await walkingRecovery.acceptWalkingReplacement(stack.db, { bookingId, providerId: "walker_two", actorId: "walker2@test", idempotencyKey: crypto.randomUUID() });
  assert.equal(acceptedReplacement.status, "assigned");
  assert.equal(acceptedReplacement.completedSessionsPreserved, true);
  const closed = await walkingOps.mutateWalkingOps(stack.db, { bookingId, action: "close_recovery", actorId: "ops@test", idempotencyKey: crypto.randomUUID(), reason: "Replacement accepted remaining walks" });
  assert.equal(closed.status, "resolved");

  // The replacement walker re-confirms handover (previously a UNIQUE-constraint crash) and completes.
  const done = await completeWalkingSession(stack, bookingId, second, "walker2@test");
  assert.equal(done.allComplete, true);
  const handover = sqlite.prepare("SELECT provider_id,confirmed_by FROM walking_handover_events WHERE session_id=?").get(second);
  assert.deepEqual([String(handover.provider_id), String(handover.confirmed_by)], ["walker_two", "walker2@test"], "the handover record must reflect the replacement walker");
  assert.equal(sqlite.prepare("SELECT provider_id FROM walking_sessions WHERE id=?").get(first).provider_id, "walker_one", "completed history keeps its original walker");
  assert.equal(sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(bookingId).status, "completed");
  // Per-session finance still derives from BOTH completed occurrences across both walkers.
  const dueTotal = sqlite.prepare("SELECT COALESCE(SUM(amount),0) total FROM walking_session_payment_events WHERE booking_id=? AND status='due'").get(bookingId).total;
  assert.equal(Number(dueTotal), 698);
});

// ---------------------------------------------------------------------------
// 3. Taxi: pickup/dropoff verification states + D2/D3 regressions around
//    driver replacement after a confirmed pickup.
// ---------------------------------------------------------------------------
test("regression: taxi driver replacement re-attributes pickup/dropoff handover to the replacement driver", async () => {
  const stack = await opsStack();
  const { sqlite } = stack;
  stack.seedProvider("taxi_one", { services: ["pet_taxi"] });
  stack.seedProvider("taxi_two", { services: ["pet_taxi"] });
  stack.seedVehicle("TXV-ONE", "taxi_one");
  stack.seedVehicle("TXV-TWO", "taxi_two");
  await stack.seedActiveCommercialTerm({ serviceCode: "pet_taxi", providerId: "taxi_two" });
  const { bookingId, tripId, amount } = stack.seedTaxiBooking({ tag: "TREC", providerId: "taxi_one" });

  await tMutate(stack, bookingId, "accept");
  await rejects(tMutate(stack, bookingId, "confirm_pickup", { handoverMethod: "owner" }), 409, /vehicle assignment is required/);
  await tMutate(stack, bookingId, "assign_vehicle", { vehicleId: "TXV-ONE" });
  await tMutate(stack, bookingId, "confirm_pickup", { handoverMethod: "owner" });
  let trip = sqlite.prepare("SELECT status,pickup_verification_status FROM taxi_trips WHERE booking_id=?").get(bookingId);
  assert.deepEqual([String(trip.status), String(trip.pickup_verification_status)], ["pickup_confirmed", "uat_confirmed"]);
  assert.equal(sqlite.prepare("SELECT provider_id FROM taxi_pickup_handover_events WHERE trip_id=?").get(tripId).provider_id, "taxi_one");

  // Pre-trip failure after pickup confirmation branches into recovery; trip window/route preserved.
  const recovery = await tMutate(stack, bookingId, "decline", { reason: "Vehicle breakdown before start" });
  assert.equal(recovery.status, "ops_escalation");
  const offered = await taxiOps.mutateTaxiOps(stack.db, { bookingId, action: "assign_replacement", actorId: "ops@test", idempotencyKey: crypto.randomUUID(), providerId: "taxi_two", reason: "Eligible replacement driver with verified vehicle" });
  assert.equal(offered.status, "replacement_offered");
  trip = sqlite.prepare("SELECT status,vehicle_id,pickup_verification_status,dropoff_verification_status FROM taxi_trips WHERE booking_id=?").get(bookingId);
  assert.deepEqual([String(trip.status), trip.vehicle_id, String(trip.pickup_verification_status), String(trip.dropoff_verification_status)], ["scheduled", null, "pending", "pending"], "replacement resets vehicle and verification states");

  // D2 regression: the plain lifecycle accept can no longer swallow a replacement offer.
  await rejects(tMutate(stack, bookingId, "accept", { actorId: "driver2@test" }), 409, /not awaiting driver acceptance/);
  const acceptedReplacement = await taxiRecovery.acceptTaxiReplacement(stack.db, { bookingId, providerId: "taxi_two", actorId: "driver2@test", idempotencyKey: crypto.randomUUID() });
  assert.equal(acceptedReplacement.status, "assigned");
  const closed = await taxiOps.mutateTaxiOps(stack.db, { bookingId, action: "close_recovery", actorId: "ops@test", idempotencyKey: crypto.randomUUID(), reason: "Replacement driver accepted trip" });
  assert.equal(closed.status, "resolved");

  // D3 regression: the replacement driver's pickup handover must carry THEIR provider id.
  await tMutate(stack, bookingId, "assign_vehicle", { vehicleId: "TXV-TWO", actorId: "driver2@test" });
  await tMutate(stack, bookingId, "confirm_pickup", { handoverMethod: "owner", actorId: "driver2@test" });
  const pickup = sqlite.prepare("SELECT provider_id,confirmed_by FROM taxi_pickup_handover_events WHERE trip_id=?").get(tripId);
  assert.deepEqual([String(pickup.provider_id), String(pickup.confirmed_by)], ["taxi_two", "driver2@test"], "pickup verification must be attributed to the replacement driver");

  // Verification states through completion; evidence-class events stay in the proof workflow.
  await tMutate(stack, bookingId, "start_trip", { actorId: "driver2@test" });
  await rejects(tMutate(stack, bookingId, "trip_event", { tripEventType: "photo_update", actorId: "driver2@test" }), 409, /governed Taxi proof workflow/);
  await tProof(stack, bookingId, "record_location_sample", { latitude: 12.91, longitude: 77.61, accuracyMeters: 10, actorId: "driver2@test" });
  await tProof(stack, bookingId, "record_location_sample", { latitude: 12.92, longitude: 77.62, accuracyMeters: 10, actorId: "driver2@test" });
  await rejects(tMutate(stack, bookingId, "confirm_dropoff", { actorId: "driver2@test" }), 409, /Drop-off arrival is required/);
  await tMutate(stack, bookingId, "arrive_dropoff", { actorId: "driver2@test" });
  await tMutate(stack, bookingId, "confirm_dropoff", { actorId: "driver2@test" });
  const dropoff = sqlite.prepare("SELECT provider_id FROM taxi_dropoff_handover_events WHERE trip_id=?").get(tripId);
  assert.equal(String(dropoff.provider_id), "taxi_two");
  const done = await tMutate(stack, bookingId, "complete_trip", { actorId: "driver2@test" });
  assert.equal(done.status, "completed");
  assert.equal(done.amount, amount);
  trip = sqlite.prepare("SELECT status,pickup_verification_status,dropoff_verification_status FROM taxi_trips WHERE booking_id=?").get(bookingId);
  assert.deepEqual([String(trip.status), String(trip.pickup_verification_status), String(trip.dropoff_verification_status)], ["completed", "uat_confirmed", "uat_confirmed"]);

  // Taxi finance: the settlement derives only from the completed, sandbox-paid trip.
  await rejects(tFinance(stack, bookingId, "prepare_settlement"), 409, /must be sandbox-paid before settlement/);
  const paid = await tFinance(stack, bookingId, "record_trip_payment", { paymentReference: "REF-TREC-1" });
  assert.equal(paid.status, "sandbox_paid");
  assert.equal(sqlite.prepare("SELECT status FROM booking_payments WHERE booking_id=?").get(bookingId).status, "paid");
  const settlement = await tFinance(stack, bookingId, "prepare_settlement");
  assert.equal(settlement.grossPaidValue, amount);
  const reconciliation = await tFinance(stack, bookingId, "reconcile");
  assert.equal(reconciliation.paidTotal, amount);
  assert.equal(reconciliation.unpaidTripTotal, 0);
});

test("taxi settlement cannot be prepared for an incomplete trip", async () => {
  const stack = await opsStack();
  stack.seedProvider("taxi_one", { services: ["pet_taxi"] });
  stack.seedVehicle("TXV-ONE", "taxi_one");
  const { bookingId } = stack.seedTaxiBooking({ tag: "TINC", providerId: "taxi_one" });
  await tMutate(stack, bookingId, "accept");
  await rejects(tFinance(stack, bookingId, "prepare_settlement"), 409, /only after canonical Pet Taxi completion/);
  await rejects(tFinance(stack, bookingId, "record_trip_payment", { paymentReference: "REF-NONE" }), 404, /payment-due event not found/);
});

// ---------------------------------------------------------------------------
// 4. D4 regression: proof self-approval guards (walking + taxi).
// ---------------------------------------------------------------------------
test("regression: walking proof cannot be scan-approved by its submitter; incidents cannot be self-acknowledged or self-resolved", async () => {
  const stack = await opsStack();
  stack.seedProvider("walker_one");
  const { bookingId } = await stack.createWalkingBooking({ tag: "WPROOF", providerId: "walker_one", walkCount: 1 });
  await wMutate(stack, bookingId, "accept");
  const sessionId = String(stack.sqlite.prepare("SELECT id FROM walking_sessions WHERE booking_id=?").get(bookingId).id);
  await wMutate(stack, bookingId, "confirm_handover", { sessionId, handoverMethod: "owner" });
  await wMutate(stack, bookingId, "start_walk", { sessionId });
  assert.equal(stack.sqlite.prepare("SELECT status FROM walking_sessions WHERE id=?").get(sessionId).status, "in_progress", "proof scan fixture requires an active walk");

  const prepared = await wProof(stack, bookingId, "prepare_media", { sessionId, purpose: "walking_update", mimeType: "image/jpeg", sizeBytes: 2048, sha256: SHA, actorId: "ops1@test" });
  await wProof(stack, bookingId, "sandbox_finalize_media", { uploadToken: prepared.upload.token, storageObjectId: "walking/objects/wproof-1", actorId: "ops1@test" });
  await rejects(wProof(stack, bookingId, "record_media_scan", { mediaRef: prepared.mediaRef, scanResult: "clean", actorId: "ops1@test" }), 403, /cannot be scan-approved by the actor who submitted it/);
  const scanned = await wProof(stack, bookingId, "record_media_scan", { mediaRef: prepared.mediaRef, scanResult: "clean", actorId: "ops2@test" });
  assert.equal(scanned.proofReady, true);
  await wProof(stack, bookingId, "record_photo_update", { sessionId, mediaRef: prepared.mediaRef, note: "Bruno mid-walk" });

  const incident = await wProof(stack, bookingId, "report_incident", { sessionId, severity: "urgent", summary: "Bruno slipped the harness", actionTaken: "Re-secured" });
  await rejects(wProof(stack, bookingId, "acknowledge_incident", { sessionId, incidentId: incident.incidentId, actorId: "walker1@test" }), 403, /cannot be acknowledged by the actor who reported it/);
  await rejects(wProof(stack, bookingId, "resolve_incident", { sessionId, incidentId: incident.incidentId, resolution: "Self resolution attempt", actorId: "walker1@test" }), 403, /cannot be resolved by the actor who reported it/);
  const acknowledged = await wProof(stack, bookingId, "acknowledge_incident", { sessionId, incidentId: incident.incidentId, actorId: "customer@test" });
  assert.equal(acknowledged.customerAcknowledged, true);
  const resolved = await wProof(stack, bookingId, "resolve_incident", { sessionId, incidentId: incident.incidentId, resolution: "Harness replaced, walk finished safely", actorId: "ops2@test" });
  assert.equal(resolved.status, "resolved");
});

test("regression: taxi proof self-approval is refused the same way", async () => {
  const stack = await opsStack();
  stack.seedProvider("taxi_one", { services: ["pet_taxi"] });
  stack.seedVehicle("TXV-ONE", "taxi_one");
  const { bookingId } = stack.seedTaxiBooking({ tag: "TPROOF", providerId: "taxi_one" });
  await tMutate(stack, bookingId, "accept");
  await tMutate(stack, bookingId, "assign_vehicle", { vehicleId: "TXV-ONE" });
  await tMutate(stack, bookingId, "confirm_pickup", { handoverMethod: "owner" });
  await tMutate(stack, bookingId, "start_trip");

  const prepared = await tProof(stack, bookingId, "prepare_media", { purpose: "taxi_update", mimeType: "image/png", sizeBytes: 4096, sha256: SHA, actorId: "ops1@test" });
  await tProof(stack, bookingId, "sandbox_finalize_media", { uploadToken: prepared.upload.token, storageObjectId: "taxi/objects/tproof-1", actorId: "ops1@test" });
  await rejects(tProof(stack, bookingId, "record_media_scan", { mediaRef: prepared.mediaRef, scanResult: "clean", actorId: "ops1@test" }), 403, /cannot be scan-approved by the actor who submitted it/);
  const scanned = await tProof(stack, bookingId, "record_media_scan", { mediaRef: prepared.mediaRef, scanResult: "clean", actorId: "ops2@test" });
  assert.equal(scanned.proofReady, true);

  const incident = await tProof(stack, bookingId, "report_incident", { severity: "attention", summary: "Pet anxious in traffic", actionTaken: "Calmed with water break" });
  await rejects(tProof(stack, bookingId, "acknowledge_incident", { incidentId: incident.incidentId, actorId: "driver1@test" }), 403, /cannot be acknowledged by the actor who reported it/);
  await rejects(tProof(stack, bookingId, "resolve_incident", { incidentId: incident.incidentId, resolution: "Self resolution attempt", actorId: "driver1@test" }), 403, /cannot be resolved by the actor who reported it/);
  const resolved = await tProof(stack, bookingId, "resolve_incident", { incidentId: incident.incidentId, resolution: "Pet settled; trip completed without harm", actorId: "ops2@test" });
  assert.equal(resolved.status, "resolved");
});

// ---------------------------------------------------------------------------
// 5. D5 regression: cancelled booking with fully-paid completed walks reaches
//    aggregate 'paid'; completed charges are preserved through cancellation.
// ---------------------------------------------------------------------------
test("regression: paying the preserved completed walk on a cancelled booking settles booking_payments to paid", async () => {
  const stack = await opsStack();
  const { sqlite } = stack;
  stack.seedProvider("walker_one");
  const { bookingId, customerId } = await stack.createWalkingBooking({ tag: "CANC", providerId: "walker_one", walkCount: 2 });
  await wMutate(stack, bookingId, "accept");
  const [first, second] = sqlite.prepare("SELECT id FROM walking_sessions WHERE booking_id=? ORDER BY occurrence_number").all(bookingId).map((row) => String(row.id));
  await completeWalkingSession(stack, bookingId, first);
  assert.equal(sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(bookingId).status, "assigned", "cancellation fixture requires the programme to be between walks");
  assert.equal(sqlite.prepare("SELECT status FROM walking_sessions WHERE id=?").get(first).status, "completed", "completed walk evidence must exist before cancellation");
  assert.equal(sqlite.prepare("SELECT status FROM walking_sessions WHERE id=?").get(second).status, "scheduled", "remaining walk must not be active when cancellation is requested");

  await wFinance(stack, bookingId, "request_cancel", { reason: "Customer travelling", actorId: `customer:${customerId}` });
  await rejects(wFinance(stack, bookingId, "approve_cancel", { reason: "Self approval", approvedRefundAmount: 0, actorId: `customer:${customerId}` }), 409, /Segregation of duties/);
  const cancelled = await wFinance(stack, bookingId, "approve_cancel", { reason: "Policy: charge completed walks only", approvedRefundAmount: 0 });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.completedWalkChargesPreserved, true);
  assert.equal(sqlite.prepare("SELECT status FROM walking_sessions WHERE id=?").get(first).status, "completed", "completed session survives cancellation");
  assert.equal(sqlite.prepare("SELECT status FROM walking_sessions WHERE id=?").get(second).status, "cancelled");

  const paid = await wFinance(stack, bookingId, "record_session_payment", { sessionId: first, paymentReference: "REF-CANC-1" });
  assert.equal(paid.aggregateStatus, "paid", "a cancelled booking with every completed walk paid must aggregate to paid, not partial");
  assert.equal(sqlite.prepare("SELECT status FROM booking_payments WHERE booking_id=?").get(bookingId).status, "paid");
  // Settlement stays completed-bookings-only (pinned policy): cancelled bookings are refused.
  await rejects(wFinance(stack, bookingId, "prepare_settlement"), 409, /only after all canonical walks complete/);
  const reconciliation = await wFinance(stack, bookingId, "reconcile");
  assert.equal(reconciliation.paidTotal, 349);
  assert.equal(reconciliation.unpaidCompletedTotal, 0);
});

// ---------------------------------------------------------------------------
// 6. Recovery-branch pins: offer expiry, no_show, evidence-gated walk events.
// ---------------------------------------------------------------------------
test("walking offer expiry, no_show recovery and evidence-class walk events stay governed", async () => {
  const stack = await opsStack();
  const { sqlite } = stack;
  stack.seedProvider("walker_one");
  const { bookingId, groupId } = await stack.createWalkingBooking({ tag: "GOV", providerId: "walker_one", walkCount: 1 });
  // An expired pending offer blocks acceptance.
  sqlite.prepare("INSERT INTO provider_assignment_offers (group_id,booking_id,provider_id,status,offered_at,expires_at,responded_at,response_reason,attempt_no,updated_at) VALUES (?,?,?,'pending',?,?,NULL,NULL,1,?)")
    .run(groupId, bookingId, "walker_one", NOW - 10 * 60_000, NOW - 60_000, NOW);
  await rejects(wMutate(stack, bookingId, "accept"), 409, /offer expired/);
  sqlite.prepare("UPDATE provider_assignment_offers SET expires_at=? WHERE group_id=?").run(NOW + 30 * 60_000, groupId);
  await wMutate(stack, bookingId, "accept");
  const sessionId = String(sqlite.prepare("SELECT id FROM walking_sessions WHERE booking_id=?").get(bookingId).id);
  await wMutate(stack, bookingId, "confirm_handover", { sessionId, handoverMethod: "owner" });
  await wMutate(stack, bookingId, "start_walk", { sessionId });
  // Photo/route/incident evidence is refused by lifecycle walk_event.
  await rejects(wMutate(stack, bookingId, "walk_event", { sessionId, walkEventType: "photo_update" }), 409, /governed Walking proof workflow/);
  const logged = await wMutate(stack, bookingId, "walk_event", { sessionId, walkEventType: "pee" });
  assert.equal(logged.status, "logged");

  // no_show is a pre-service recovery transition; keep it on a fresh assigned booking rather than
  // mutating the already in-progress evidence scenario above.
  const { bookingId: noShowBookingId } = await stack.createWalkingBooking({ tag: "GOV-NOSHOW", providerId: "walker_one", walkCount: 1 });
  await wMutate(stack, noShowBookingId, "accept");
  const noShow = await wMutate(stack, noShowBookingId, "no_show", { reason: "Customer unreachable at pickup", actorId: "ops@test" });
  assert.equal(noShow.status, "ops_escalation");
  assert.equal(sqlite.prepare("SELECT reason_code FROM walking_recovery_cases WHERE booking_id=?").get(noShowBookingId).reason_code, "no_show");
  assert.equal(sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(noShowBookingId).status, "reassignment_needed");
});

// ---------------------------------------------------------------------------
// 7. Route permission posture (source-level pins per action).
// ---------------------------------------------------------------------------
test("walking and taxi routes keep per-action permission boundaries", () => {
  const read = (path) => fs.readFileSync(path, "utf8");
  const walkingRoute = read("app/api/walking-lifecycle/route.ts");
  assert.match(walkingRoute, /if\(action==="no_show"\)requirePermission\(actor,"bookings\.manage"\)/);
  assert.match(walkingRoute, /providerActions=new Set<WalkingAction>\(\["accept","decline","confirm_handover","start_walk","walk_event","complete_walk","walker_unavailable"\]\)/);
  assert.match(walkingRoute, /await requireProviderOwnership\(db,actor,providerId\)/);
  const taxiRoute = read("app/api/taxi-lifecycle/route.ts");
  assert.match(taxiRoute, /if\(action==="no_show"\)requirePermission\(actor,"bookings\.manage"\)/);
  assert.match(taxiRoute, /requireProviderOwnership/);
  for (const path of ["app/api/walking-ops/route.ts", "app/api/taxi-ops/route.ts"]) {
    const source = read(path);
    assert.match(source, /requirePermission\(actor,"bookings\.manage"\)/, `${path} writes must be staff-only`);
    assert.doesNotMatch(source, /requirePermission\(actor,"bookings\.view"\)/, `${path} system-wide reads must not use bookings.view`);
  }
  for (const path of ["app/api/walking-finance/route.ts", "app/api/taxi-finance/route.ts"]) {
    const source = read(path);
    assert.match(source, /customerActions=new Set<\w+>\(\["request_cancel"\]\)/, `${path} customers may only request cancellation`);
    assert.match(source, /requirePermission\(actor,"finance\.manage"\)/, `${path} money writes require finance.manage`);
    assert.match(source, /requireCustomerOwnership/, `${path} customer actions require ownership`);
  }
  for (const path of ["app/api/walking-proof/route.ts", "app/api/taxi-proof/route.ts"]) {
    const source = read(path);
    assert.match(source, /staffActions=new Set<\w+>\(\["sandbox_finalize_media","record_media_scan","revoke_media","resolve_incident"\]\)/, `${path} scan/revoke/resolve stay staff-only`);
    assert.match(source, /customerActions=new Set<\w+>\(\["acknowledge_incident"\]\)/, `${path} acknowledge stays customer-scoped`);
  }
  for (const path of ["app/api/walking-recovery/route.ts", "app/api/taxi-recovery/route.ts"]) {
    assert.match(read(path), /requireProviderOwnership/, `${path} replacement acceptance requires the replacement provider identity`);
  }
});
