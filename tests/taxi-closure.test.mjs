/**
 * Pet Taxi closure — the whole vertical, end to end. EXECUTED.
 *
 * WHAT THIS FILE USED TO BE. Six tests that read eleven files as strings. The first claimed to close
 * "one canonical customer to driver to Ops to Finance path" and proved it by asserting that
 * `app/taxi/canonical-taxi-page.tsx` contains the word `createCanonicalTaxiBooking` and that
 * `app/team/finance/taxi/taxi-finance-workspace.tsx` contains `loadTaxiFinance`. Five identifiers in
 * five files is not a path. Another asserted that `lib/api-gateway.ts` contains
 * `/api/taxi-finance[\s\S]*finance\.view` — a regex over the whole file, which any later occurrence of
 * "finance.view" anywhere below satisfies regardless of which route it belongs to.
 *
 * Now seven EXECUTED tests. ONE booking is driven through the real customer, driver, Operations and
 * Finance modules in sequence and the same booking id is read back out of each surface, so the path is
 * the assertion rather than a set of identifiers.
 *
 * Requests go to https://ops.pawspace.example. The gateway test below asserts which permission each
 * taxi surface demands; on localhost `npm test` resolves a preview superuser holding ["*"] and every
 * one of those answers would be the same.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { customerSessionCookie, freshSqlite, makeD1, nextKey, refusal, seedActiveCommercialTerm, seedCanonicalTrip, seedVehicle, taxiUrl } from "./helpers/taxi-harness.mjs";

installWorkersHooks("__TAXI_CLOSE_DB__", "__TAXI_CLOSE_ENV__");

const lifecycle = await import("../lib/taxi-lifecycle.ts");
const proof = await import("../lib/taxi-proof-governance.ts");
const finance = await import("../lib/taxi-finance-governance.ts");
const ops = await import("../lib/taxi-ops-governance.ts");
const recovery = await import("../lib/taxi-recovery-governance.ts");
const gateway = await import("../lib/api-gateway.ts");
const financeRoute = await import("../app/api/taxi-finance/route.ts");
const proofRoute = await import("../app/api/taxi-proof/route.ts");

const CUSTOMER_PRINCIPAL = "+919800000061";
const FINANCE_STAFF = "finance.closure@pawspace.test";
const FINANCE_SECOND = "checker.closure@pawspace.test";
const OPS_STAFF = "ops.closure@pawspace.test";
const SUPPORT = "support.closure@pawspace.test";
const REPLACEMENT = "taxi_meena";

/** One canonical Pet Taxi world with every gate's tables and the staff identities the gates need. */
async function closureWorld(overrides = {}) {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__TAXI_CLOSE_DB__ = db;
  globalThis.__TAXI_CLOSE_ENV__ = {};
  const trip = seedCanonicalTrip(sqlite, overrides);
  // ensureTaxiOpsTables pulls in the lifecycle, finance, proof and capacity schemas, so every gate's
  // tables come from the modules that own them.
  await ops.ensureTaxiOpsTables(db);
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'app',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  const now = Date.now();
  sqlite.prepare("INSERT OR IGNORE INTO canonical_customers (id,city_id,name,primary_phone,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run(trip.customerId, "blr", "Closure Customer", CUSTOMER_PRINCIPAL, now, now);

  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db);
  const staff = sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)");
  staff.run("U-CL-FIN", FINANCE_STAFF, "Finance Closure", "finance", now, now);
  staff.run("U-CL-FIN2", FINANCE_SECOND, "Finance Checker", "finance", now, now);
  staff.run("U-CL-OPS", OPS_STAFF, "Ops Closure", "admin", now, now);
  staff.run("U-CL-SUPPORT", SUPPORT, "Support Closure", "associate", now, now);
  return { sqlite, db, trip };
}

const drive = (db, trip, action, extra = {}) => lifecycle.mutateTaxiBooking(db, {
  bookingId: trip.bookingId, action, actorId: extra.actorId ?? trip.providerId, idempotencyKey: extra.key ?? nextKey(action), ...extra,
});

async function recordRouteSamples(db, trip, count = 2) {
  for (let index = 0; index < count; index += 1) {
    await proof.mutateTaxiProof(db, {
      bookingId: trip.bookingId, action: "record_location_sample", actorId: trip.providerId,
      idempotencyKey: nextKey("sample"), latitude: 12.97 + index / 1000, longitude: 77.64 + index / 1000, accuracyMeters: 8,
    });
  }
}

/** The driver journey up to a confirmed drop-off handover, which is where completion becomes possible. */
async function driveToDropoff(sqlite, db, trip, { samples = 2 } = {}) {
  await drive(db, trip, "accept");
  const vehicleId = seedVehicle(sqlite, { providerId: trip.providerId });
  await drive(db, trip, "assign_vehicle", { vehicleId });
  await drive(db, trip, "confirm_pickup", { handoverMethod: "owner" });
  await drive(db, trip, "start_trip");
  await recordRouteSamples(db, trip, samples);
  await drive(db, trip, "arrive_dropoff");
  await drive(db, trip, "confirm_dropoff", { handoverMethod: "clinic_staff" });
  return vehicleId;
}

const decide = async (path, { actorEmail, cookie, method = "GET", body } = {}) => {
  const headers = {
    ...(method === "GET" ? {} : { "content-type": "application/json" }),
    ...(actorEmail ? { "oai-authenticated-user-email": actorEmail } : {}),
    ...(cookie ? { cookie } : {}),
  };
  const request = new Request(taxiUrl(path), method === "GET" ? { headers } : { method, headers, body: JSON.stringify(body ?? {}) });
  const decision = await gateway.authorizeApiRequest(request, { DB: globalThis.__TAXI_CLOSE_DB__ });
  return decision instanceof Response ? { refused: decision.status } : { permission: decision.permission };
};

// ---------------------------------------------------------------------------------------------
test("Closure: one booking travels the customer, driver, Operations and Finance path", async () => {
  const { sqlite, db, trip } = await closureWorld();
  await seedActiveCommercialTerm(db);

  // THE DRIVER JOURNEY, through the real lifecycle module.
  await driveToDropoff(sqlite, db, trip);
  const completed = await drive(db, trip, "complete_trip");
  assert.equal(completed.status, "completed");
  assert.equal(completed.paymentStatus, "due", "completion opens the money, it does not collect it");
  assert.equal(completed.routeSamples, 2);
  assert.equal(completed.liveMoney, false);

  // OPERATIONS sees the SAME booking, with the finance exception the completion created.
  const opsSnapshot = await ops.getTaxiOpsSnapshot(db);
  const queued = opsSnapshot.bookings.find((item) => String(item.id) === trip.bookingId);
  assert.ok(queued, "the completed booking must appear in the canonical Operations queue");
  assert.equal(String(queued.trip_id), trip.tripId, "and it is the same trip, not a copy");
  assert.ok(queued.exceptionFlags.includes("trip_payment_due"), `Operations must see the money as due: ${JSON.stringify(queued.exceptionFlags)}`);
  assert.ok(queued.exceptionFlags.includes("settlement_not_ready"));
  assert.equal(Number(queued.tripPayment.amount), trip.amount);

  // FINANCE sees the same booking through its own route, and collects the money.
  const financeRead = await financeRoute.GET(new Request(taxiUrl(`/api/taxi-finance?bookingId=${trip.bookingId}`), { headers: { "oai-authenticated-user-email": FINANCE_STAFF } }));
  assert.equal(financeRead.status, 200);
  const financeData = (await financeRead.json()).data;
  assert.equal(String(financeData.booking.id), trip.bookingId);
  assert.equal(String(financeData.trip.id), trip.tripId);
  assert.equal(String(financeData.trip.trip_payment_status), "due");
  assert.equal(financeData.sandboxOnly, true);
  assert.equal(financeData.productionPaymentTimingPolicy, "pending");

  const paid = await finance.mutateTaxiFinance(db, { bookingId: trip.bookingId, action: "record_trip_payment", actorId: FINANCE_STAFF, idempotencyKey: nextKey("pay"), reason: "collected in sandbox", paymentReference: "SBX-CLOSE-1" });
  assert.equal(paid.status, "sandbox_paid");
  const settlement = await finance.mutateTaxiFinance(db, { bookingId: trip.bookingId, action: "prepare_settlement", actorId: FINANCE_STAFF, idempotencyKey: nextKey("settle"), reason: "completed and paid" });
  assert.equal(settlement.grossPaidValue, trip.amount);
  assert.equal(settlement.tax, "configuration_required", "and Finance still invents no tax status");

  // OPERATIONS reflects the collection: the payment flag clears, and the queue is one booking, not two.
  const afterPayment = await ops.getTaxiOpsSnapshot(db);
  const settled = afterPayment.bookings.find((item) => String(item.id) === trip.bookingId);
  assert.equal(settled.exceptionFlags.includes("trip_payment_due"), false);
  assert.equal(afterPayment.bookings.length, 1, "one booking, one row in the queue, all the way through");
  assert.equal(afterPayment.metrics.total, 1);

  // And the reconciliation reads the same numbers back.
  const reconciled = await finance.mutateTaxiFinance(db, { bookingId: trip.bookingId, action: "reconcile", actorId: FINANCE_SECOND, idempotencyKey: nextKey("recon"), reason: "closing the trip" });
  assert.deepEqual({ due: reconciled.tripDueTotal, paid: reconciled.paidTotal, net: reconciled.netPaidTotal, unpaid: reconciled.unpaidTripTotal },
    { due: trip.amount, paid: trip.amount, net: trip.amount, unpaid: 0 });
});

// ---------------------------------------------------------------------------------------------
test("Closure: completion is server-gated by canonical route evidence", async () => {
  const { sqlite, db, trip } = await closureWorld();
  await seedActiveCommercialTerm(db);

  // ZERO samples: refused. The old test asserted the refusal SENTENCE appeared in the module.
  await driveToDropoff(sqlite, db, trip, { samples: 0 });
  const none = await refusal(drive(db, trip, "complete_trip"));
  assert.equal(none?.status, 409);
  assert.match(String(none?.message), /at least two canonical sandbox route samples/);
  assert.equal(String(sqlite.prepare("SELECT status FROM taxi_trips WHERE id=?").get(trip.tripId).status), "dropoff_confirmed",
    "and the trip is not completed");
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) c FROM taxi_trip_payment_events WHERE booking_id=?").get(trip.bookingId).c), 0,
    "no payment event is opened");

  // ONE sample is still not a route.
  const single = await closureWorld({ bookingId: "BKG-CLOSE-1", tripId: "TRIP-CLOSE-1", reservationId: "RES-CLOSE-1", groupId: "GRP-CLOSE-1", customerId: "CUST-CLOSE-1" });
  await seedActiveCommercialTerm(single.db);
  await driveToDropoff(single.sqlite, single.db, single.trip, { samples: 1 });
  assert.equal((await refusal(drive(single.db, single.trip, "complete_trip")))?.status, 409);

  // The route evidence must belong to THIS trip. Samples recorded on another trip do not count, which
  // is what makes the count a gate rather than a global counter.
  const other = seedCanonicalTrip(single.sqlite, { bookingId: "BKG-CLOSE-2", tripId: "TRIP-CLOSE-2", reservationId: "RES-CLOSE-2", groupId: "GRP-CLOSE-2", customerId: "CUST-CLOSE-2", tripStatus: "in_progress" });
  await recordRouteSamples(single.db, other, 5);
  assert.equal((await refusal(drive(single.db, single.trip, "complete_trip")))?.status, 409,
    "another trip's route samples cannot complete this one");

  // TWO samples on the right trip, and completion is allowed — the non-vacuity control. It has to be a
  // fresh trip: route samples are only accepted while the trip is in_progress, which is itself the
  // evidence separation this file is about, so a sample cannot be back-filled after the handover.
  const good = await closureWorld({ bookingId: "BKG-CLOSE-4", tripId: "TRIP-CLOSE-4", reservationId: "RES-CLOSE-4", groupId: "GRP-CLOSE-4", customerId: "CUST-CLOSE-4" });
  await seedActiveCommercialTerm(good.db);
  await driveToDropoff(good.sqlite, good.db, good.trip, { samples: 2 });
  const completed = await drive(good.db, good.trip, "complete_trip");
  assert.equal(completed.status, "completed");
  assert.equal(completed.routeSamples, 2);
  assert.equal(completed.gpsConnected, true, "the sandbox GPS source is connected");
  // And a sample cannot be added after the handover, so "two samples" means two samples taken en route.
  assert.equal((await refusal(recordRouteSamples(single.db, single.trip, 1)))?.status, 409,
    "route evidence cannot be back-filled once the trip is no longer in progress");

  // Completion is also gated on the HANDOVER, not only the route: a trip still in progress is refused
  // however much route evidence it has.
  const moving = await closureWorld({ bookingId: "BKG-CLOSE-3", tripId: "TRIP-CLOSE-3", reservationId: "RES-CLOSE-3", groupId: "GRP-CLOSE-3", customerId: "CUST-CLOSE-3" });
  await seedActiveCommercialTerm(moving.db);
  await drive(moving.db, moving.trip, "accept");
  await drive(moving.db, moving.trip, "assign_vehicle", { vehicleId: seedVehicle(moving.sqlite, { providerId: moving.trip.providerId }) });
  await drive(moving.db, moving.trip, "confirm_pickup", { handoverMethod: "owner" });
  await drive(moving.db, moving.trip, "start_trip");
  await recordRouteSamples(moving.db, moving.trip, 4);
  const early = await refusal(drive(moving.db, moving.trip, "complete_trip"));
  assert.equal(early?.status, 409);
  assert.match(String(early?.message), /Confirmed drop-off handover is required/);
});

// ---------------------------------------------------------------------------------------------
test("Closure: the customer reaches their own trip's management and incident surfaces", async () => {
  const { sqlite, db, trip } = await closureWorld();
  await driveToDropoff(sqlite, db, trip, { samples: 0 });
  sqlite.prepare("UPDATE taxi_trips SET status='in_progress' WHERE id=?").run(trip.tripId);
  const incident = await proof.mutateTaxiProof(db, { bookingId: trip.bookingId, action: "report_incident", actorId: trip.providerId, idempotencyKey: nextKey("incident"), severity: "urgent", summary: "pet unsettled in heavy traffic" });

  const owner = await customerSessionCookie(db, { principalKey: CUSTOMER_PRINCIPAL, customerId: trip.customerId });
  const stranger = await customerSessionCookie(db, { principalKey: "+919800000099", customerId: "CUST-CLOSE-STRANGER" });

  // THE CUSTOMER SCOPE of the proof surface returns their own trip's evidence and incidents.
  const read = await proofRoute.GET(new Request(taxiUrl(`/api/taxi-proof?bookingId=${trip.bookingId}&scope=customer`), { headers: { cookie: owner.cookie } }));
  assert.equal(read.status, 200);
  const data = (await read.json()).data;
  assert.equal(String(data.bookingId), trip.bookingId);
  assert.equal(String(data.tripId), trip.tripId);
  assert.equal(data.incidents.length, 1);
  assert.equal(String(data.incidents[0].id), incident.incidentId);
  assert.equal(data.sandboxOnly, true);

  // ANOTHER customer, with an equally valid session, sees nothing of it.
  const intruder = await proofRoute.GET(new Request(taxiUrl(`/api/taxi-proof?bookingId=${trip.bookingId}&scope=customer`), { headers: { cookie: stranger.cookie } }));
  assert.ok([401, 403].includes(intruder.status), `a different customer must be refused: ${intruder.status}`);
  assert.ok([401, 403].includes((await proofRoute.GET(new Request(taxiUrl(`/api/taxi-proof?bookingId=${trip.bookingId}&scope=customer`)))).status),
    "and so does an anonymous caller");

  // THE CUSTOMER can acknowledge the incident and request a cancellation, and can do nothing to money.
  const acknowledged = await proofRoute.POST(new Request(taxiUrl("/api/taxi-proof"), {
    method: "POST", headers: { "content-type": "application/json", cookie: owner.cookie },
    body: JSON.stringify({ bookingId: trip.bookingId, action: "acknowledge_incident", idempotencyKey: nextKey("ack"), incidentId: incident.incidentId }),
  }));
  assert.equal(acknowledged.status, 200);
  assert.equal((await acknowledged.json()).data.automaticRefund, false, "acknowledging is not accepting a settlement");
  const financeAttempt = await financeRoute.POST(new Request(taxiUrl("/api/taxi-finance"), {
    method: "POST", headers: { "content-type": "application/json", cookie: owner.cookie },
    body: JSON.stringify({ bookingId: trip.bookingId, action: "record_refund", idempotencyKey: nextKey("refund"), reason: "self-serve refund", refundReference: "SBX-SELF" }),
  }));
  assert.ok([401, 403].includes(financeAttempt.status), `a customer must not record a refund: ${financeAttempt.status}`);
  // A customer cannot read the Finance surface either, even for their own booking.
  assert.ok([401, 403].includes((await financeRoute.GET(new Request(taxiUrl(`/api/taxi-finance?bookingId=${trip.bookingId}`), { headers: { cookie: owner.cookie } }))).status));
});

// ---------------------------------------------------------------------------------------------
test("Closure: recovery re-drives the same trip to completion with its route intact", async () => {
  const { sqlite, db, trip } = await closureWorld();
  await seedActiveCommercialTerm(db);
  const routeBefore = sqlite.prepare("SELECT origin_label,destination_label,route_code,synthetic_distance_km,scheduled_start,scheduled_end,reservation_id FROM taxi_trips WHERE id=?").get(trip.tripId);

  // The original driver fails before pickup, so Operations opens a recovery.
  sqlite.prepare("UPDATE canonical_bookings SET status='reassignment_needed' WHERE id=?").run(trip.bookingId);
  sqlite.prepare("UPDATE taxi_trips SET status='recovery_pending' WHERE booking_id=?").run(trip.bookingId);
  sqlite.prepare("UPDATE scheduling_reservations SET status='cancelled' WHERE group_id=?").run(trip.groupId);
  sqlite.prepare("INSERT INTO taxi_recovery_cases (id,booking_id,trip_id,failed_provider_id,reason_code,status,detail_json,opened_at,updated_at) VALUES (?,?,?,?,'driver_no_show','ops_escalation','{}',?,?)")
    .run("REC-CLOSE", trip.bookingId, trip.tripId, trip.providerId, Date.now(), Date.now());
  sqlite.prepare("INSERT OR REPLACE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES (?,?,?,'full_time',?,?,1,4.8,90,1,20,6,3,'active',1,'2026-01-01',NULL,'harness',?)")
    .run(REPLACEMENT, "blr", "Meena R.", JSON.stringify(["pet_taxi"]), JSON.stringify(["blr-east"]), Date.now());
  seedVehicle(sqlite, { vehicleId: `VEH-${REPLACEMENT}`, providerId: REPLACEMENT });

  await ops.mutateTaxiOps(db, { bookingId: trip.bookingId, action: "assign_replacement", actorId: OPS_STAFF, idempotencyKey: nextKey("offer"), providerId: REPLACEMENT, reason: "original driver did not arrive" });
  // Operations cannot close it until the driver accepts — the guard that keeps the queue honest.
  assert.equal((await refusal(ops.mutateTaxiOps(db, { bookingId: trip.bookingId, action: "close_recovery", actorId: OPS_STAFF, idempotencyKey: nextKey("close"), reason: "assuming the driver accepts" })))?.status, 409);
  const accepted = await recovery.acceptTaxiReplacement(db, { bookingId: trip.bookingId, providerId: REPLACEMENT, actorId: `provider:${REPLACEMENT}`, idempotencyKey: nextKey("accept") });
  assert.equal(accepted.routePreserved, true);
  await ops.mutateTaxiOps(db, { bookingId: trip.bookingId, action: "close_recovery", actorId: OPS_STAFF, idempotencyKey: nextKey("close"), reason: "replacement driver accepted and is en route" });

  // THE SAME TRIP, THE SAME ROUTE — asserted field by field, not by a routePreserved:true flag alone.
  const routeAfter = sqlite.prepare("SELECT id,origin_label,destination_label,route_code,synthetic_distance_km,scheduled_start,scheduled_end,reservation_id FROM taxi_trips WHERE booking_id=?").get(trip.bookingId);
  assert.equal(String(routeAfter.id), trip.tripId);
  assert.deepEqual({
    origin: String(routeAfter.origin_label), destination: String(routeAfter.destination_label), route: String(routeAfter.route_code),
    distance: Number(routeAfter.synthetic_distance_km), start: String(routeAfter.scheduled_start), end: String(routeAfter.scheduled_end),
    reservation: String(routeAfter.reservation_id),
  }, {
    origin: String(routeBefore.origin_label), destination: String(routeBefore.destination_label), route: String(routeBefore.route_code),
    distance: Number(routeBefore.synthetic_distance_km), start: String(routeBefore.scheduled_start), end: String(routeBefore.scheduled_end),
    reservation: String(routeBefore.reservation_id),
  });

  // AND THE REPLACEMENT DRIVER COMPLETES IT. This is what "closure" means: recovery is not a dead end.
  const replacementTrip = { ...trip, providerId: REPLACEMENT };
  await drive(db, replacementTrip, "assign_vehicle", { vehicleId: `VEH-${REPLACEMENT}` });
  await drive(db, replacementTrip, "confirm_pickup", { handoverMethod: "owner" });
  await drive(db, replacementTrip, "start_trip");
  await recordRouteSamples(db, replacementTrip, 2);
  await drive(db, replacementTrip, "arrive_dropoff");
  await drive(db, replacementTrip, "confirm_dropoff", { handoverMethod: "clinic_staff" });
  const completed = await drive(db, replacementTrip, "complete_trip");
  assert.equal(completed.status, "completed");
  assert.equal(completed.tripId, trip.tripId, "the trip that completes is the trip the customer booked");
  assert.equal(completed.amount, trip.amount, "and it is billed at the amount originally quoted");

  // Operations shows the recovery flag gone and the money due against the SAME booking.
  const queued = (await ops.getTaxiOpsSnapshot(db)).bookings.find((item) => String(item.id) === trip.bookingId);
  assert.equal(queued.exceptionFlags.includes("driver_recovery"), false);
  assert.ok(queued.exceptionFlags.includes("trip_payment_due"));
  assert.equal(String(queued.provider_id), REPLACEMENT, "and the money is owed on the replacement driver's trip");
});

// ---------------------------------------------------------------------------------------------
test("Closure: the gateway routes every taxi surface to the correct authority", async () => {
  const { sqlite, db, trip } = await closureWorld();
  const owner = await customerSessionCookie(db, { principalKey: CUSTOMER_PRINCIPAL, customerId: trip.customerId });

  // THE PUBLIC QUOTE is the only public taxi surface, and it is genuinely public.
  assert.deepEqual(await decide("/api/taxi-commercial"), { permission: null });

  /*
   * Every other surface, resolved by authorizeApiRequest with a real identity. The old test asserted
   * `/api/taxi-finance[\s\S]*finance\.view` over the whole gateway file — a regex any later occurrence
   * of "finance.view" satisfies, whichever route it belonged to. These are the answers the gateway
   * actually gives, per path, per method and per action.
   */
  assert.deepEqual(await decide("/api/taxi-bookings", { cookie: owner.cookie, method: "POST", body: {} }), { permission: "scheduling.book" });
  assert.deepEqual(await decide("/api/taxi-finance", { actorEmail: FINANCE_STAFF }), { permission: "finance.view" });
  assert.deepEqual(await decide("/api/taxi-ops", { actorEmail: OPS_STAFF }), { permission: "bookings.manage" });
  assert.deepEqual(await decide("/api/taxi-recovery", { actorEmail: SUPPORT, method: "POST", body: {} }), { permission: "bookings.view" });

  // The lifecycle and proof surfaces answer differently for the CUSTOMER scope than for staff — one
  // path, two authorities, decided by the scope parameter.
  assert.deepEqual(await decide("/api/taxi-lifecycle?scope=customer", { cookie: owner.cookie }), { permission: "scheduling.book" });
  assert.deepEqual(await decide("/api/taxi-lifecycle", { actorEmail: SUPPORT }), { permission: "bookings.view" });
  assert.deepEqual(await decide("/api/taxi-proof?scope=customer", { cookie: owner.cookie }), { permission: "scheduling.book" });
  assert.deepEqual(await decide("/api/taxi-proof", { actorEmail: SUPPORT }), { permission: "bookings.view" });

  // And the WRITE authority depends on the action in the body, not just the path.
  assert.deepEqual(await decide("/api/taxi-finance", { cookie: owner.cookie, method: "POST", body: { action: "request_cancel" } }), { permission: "scheduling.book" });
  assert.deepEqual(await decide("/api/taxi-finance", { actorEmail: FINANCE_STAFF, method: "POST", body: { action: "approve_cancel" } }), { permission: "finance.manage" });
  assert.deepEqual(await decide("/api/taxi-proof", { cookie: owner.cookie, method: "POST", body: { action: "acknowledge_incident" } }), { permission: "scheduling.book" });
  assert.deepEqual(await decide("/api/taxi-proof", { actorEmail: SUPPORT, method: "POST", body: { action: "prepare_media" } }), { permission: "bookings.view" });
  assert.deepEqual(await decide("/api/taxi-proof", { actorEmail: OPS_STAFF, method: "POST", body: { action: "record_media_scan" } }), { permission: "bookings.manage" });
  assert.deepEqual(await decide("/api/taxi-lifecycle", { actorEmail: OPS_STAFF, method: "POST", body: { action: "no_show" } }), { permission: "bookings.manage" });
  assert.deepEqual(await decide("/api/taxi-lifecycle", { actorEmail: SUPPORT, method: "POST", body: { action: "accept" } }), { permission: "bookings.view" });

  // THE REFUSALS, so none of the above is "everything is allowed". A finance actor holds no booking
  // permission and an operations actor holds no finance permission.
  assert.deepEqual(await decide("/api/taxi-ops", { actorEmail: FINANCE_STAFF }), { refused: 403 },
    "a finance identity holds no booking-management permission");
  assert.deepEqual(await decide("/api/taxi-finance", { actorEmail: SUPPORT }), { refused: 403 },
    "and a booking-side identity without finance.view cannot read the Finance surface");
  assert.deepEqual(await decide("/api/taxi-proof", { actorEmail: OPS_STAFF, method: "POST", body: { action: "record_media_scan" } }), { permission: "bookings.manage" });
  assert.deepEqual(await decide("/api/taxi-proof", { actorEmail: SUPPORT, method: "POST", body: { action: "record_media_scan" } }), { refused: 403 },
    "a view-only role cannot reach a scan-approval action");
  // And no taxi surface but the quote is reachable without an identity.
  for (const path of ["/api/taxi-bookings", "/api/taxi-lifecycle", "/api/taxi-finance", "/api/taxi-proof", "/api/taxi-ops", "/api/taxi-recovery"]) {
    const anonymous = await decide(path);
    assert.ok(anonymous.refused === 401 || anonymous.refused === 403, `${path} must refuse an anonymous caller: ${JSON.stringify(anonymous)}`);
  }
});

// ---------------------------------------------------------------------------------------------
test("Closure: every gate reports itself sandbox-governed and not production ready", async () => {
  const { sqlite, db, trip } = await closureWorld();
  await seedActiveCommercialTerm(db);
  await driveToDropoff(sqlite, db, trip);
  await drive(db, trip, "complete_trip");

  // OPERATIONS readiness, as values.
  const opsSnapshot = await ops.getTaxiOpsSnapshot(db);
  assert.equal(opsSnapshot.readiness.productionReady, false);
  assert.equal(opsSnapshot.readiness.routeEvidence, "deterministic_sandbox_verified");
  assert.equal(opsSnapshot.readiness.gpsConnected, true);
  assert.equal(opsSnapshot.readiness.telemetryMode, "deterministic_sandbox");
  assert.deepEqual(opsSnapshot.readiness.externalDependencies.productionMaps, "disconnected");
  assert.deepEqual(opsSnapshot.readiness.externalDependencies.payments, "sandbox_only");
  assert.deepEqual(opsSnapshot.readiness.externalDependencies.objectStorage, "disconnected");
  assert.deepEqual(opsSnapshot.readiness.externalDependencies.malwareScanner, "disconnected");

  // PROOF readiness, and the two canonical evidence requirements as values.
  const proofSnapshot = await proof.getTaxiProofSnapshot(db, trip.bookingId);
  assert.equal(proofSnapshot.productionGpsConnected, false);
  assert.equal(proofSnapshot.productionMapsVerified, false);
  assert.equal(proofSnapshot.routeEnvironment, "deterministic_sandbox");
  assert.deepEqual(proofSnapshot.communications, { mode: "queued_only", liveDelivery: false });
  assert.deepEqual(proofSnapshot.canonicalProofRequirements.map((item) => item.label), ["Before Picture", "After Picture"]);

  // FINANCE readiness, from its own route rather than from a constant.
  const financeRead = await financeRoute.GET(new Request(taxiUrl(`/api/taxi-finance?bookingId=${trip.bookingId}`), { headers: { "oai-authenticated-user-email": FINANCE_STAFF } }));
  const financeData = (await financeRead.json()).data;
  assert.equal(financeData.sandboxOnly, true);
  assert.equal(financeData.productionPaymentTimingPolicy, "pending");

  // The completion event itself records that no live money moved and that GPS was the sandbox source.
  const event = sqlite.prepare("SELECT detail_json FROM taxi_trip_events WHERE booking_id=? AND event_type='trip_completed'").get(trip.bookingId);
  const detail = JSON.parse(String(event.detail_json));
  assert.equal(detail.liveMoney, false);
  assert.equal(detail.gpsConnected, true);
  assert.equal(detail.paymentStatus, "due");
});

// ---------------------------------------------------------------------------------------------
test("Closure: the closure plan document states it is not a production launch", async () => {
  /*
   * THIS ONE STAYS A SOURCE ASSERTION, and is reported as such.
   *
   * "docs/TAXI_CLOSURE_PLAN.md says in writing that closing Gate 5 is not a production-launch
   * declaration" is a property of a DOCUMENT. There is no function to call and no row to read: the
   * document either says it or it does not, and the whole point of the assertion is that a future
   * editor cannot quietly delete the caveat while the engineering gates still report
   * productionReady:false. The behavioural half of the same claim — that every gate really does report
   * itself sandbox-only — is executed in the test above, so this is the residue that genuinely cannot
   * be executed rather than a conversion that was skipped.
   */
  const plan = await readFile(new URL("../docs/TAXI_CLOSURE_PLAN.md", import.meta.url), "utf8");
  assert.match(plan, /not a production-launch declaration/i,
    "the closure plan must keep saying in writing that it is not a launch");
});
