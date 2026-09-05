import test from "node:test";
import assert from "node:assert/strict";
import { setupJourney, runCompletedJourney, routeCall, sessionCookie } from "./helpers/grooming-journey-harness.mjs";

const LEASE_MS = 15 * 60_000;

async function leaseGovernance() {
  return import("../lib/scheduling-reservation-leases.ts");
}

async function bareLeaseContext() {
  const ctx = await setupJourney();
  ctx.sqlite.exec(`
    CREATE TABLE scheduling_assignment_decisions (
      group_id TEXT PRIMARY KEY,strategy TEXT NOT NULL,shortlist_json TEXT NOT NULL,
      selected_provider_id TEXT,status TEXT NOT NULL,actor_id TEXT,reason TEXT,updated_at INTEGER NOT NULL
    );
    CREATE TABLE scheduling_reservations (
      id TEXT PRIMARY KEY,group_id TEXT NOT NULL,provider_id TEXT NOT NULL,service_code TEXT NOT NULL,
      city_id TEXT NOT NULL,zone_id TEXT NOT NULL,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,
      scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,capacity_units INTEGER NOT NULL DEFAULT 1,
      occurrence_number INTEGER NOT NULL DEFAULT 1,care_mode TEXT,status TEXT NOT NULL,
      explanation_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS provider_assignment_offers (
      group_id TEXT PRIMARY KEY,booking_id TEXT,provider_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',
      offered_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,responded_at INTEGER,response_reason TEXT,
      attempt_no INTEGER NOT NULL DEFAULT 1,updated_at INTEGER NOT NULL
    );
    CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,schedule_group_id TEXT NOT NULL UNIQUE,status TEXT NOT NULL);
  `);
  const governance = await leaseGovernance();
  await governance.ensureSchedulingReservationLeaseGovernance(ctx.db);
  return { ...ctx, governance };
}

async function customerSession(ctx, customerId) {
  const cookie = await sessionCookie(ctx.db, "customer", customerId, `customer:${customerId}`);
  const row = ctx.sqlite.prepare("SELECT id,expires_at,status FROM platform_identity_sessions WHERE subject_type='customer' AND subject_id=? ORDER BY issued_at DESC LIMIT 1").get(customerId);
  assert.ok(row?.id, "the test must bind the reservation to a real issued customer session");
  return { cookie, sessionId: String(row.id), expiresAt: Number(row.expires_at) };
}

function seedLease(ctx, { groupId, customerId, sessionId, leaseExpiresAt, now, providerId = "groom_arun" }) {
  ctx.sqlite.prepare("INSERT INTO scheduling_assignment_decisions (group_id,strategy,shortlist_json,selected_provider_id,status,actor_id,reason,updated_at) VALUES (?,'auto','{}',?,'assigned','system','Auto-assigned',?)")
    .run(groupId, providerId, now);
  ctx.sqlite.prepare("INSERT INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,care_mode,status,explanation_json,created_at,lease_expires_at,customer_session_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'assigned','{}',?,?,?)")
    .run(`RES-${groupId}`, groupId, providerId, "grooming", "blr", "blr-east", customerId, '["PET-1"]', "2026-11-26T10:00:00.000Z", "2026-11-26T12:00:00.000Z", 1, 1, null, now, leaseExpiresAt, sessionId);
  ctx.sqlite.prepare("INSERT INTO provider_assignment_offers (group_id,provider_id,status,offered_at,expires_at,attempt_no,updated_at) VALUES (?,?,'pending',?,?,1,?)")
    .run(groupId, providerId, now, now + LEASE_MS, now);
}

test("expired customer session releases its reservation exactly once", async (t) => {
  const ctx = await bareLeaseContext(); t.after(ctx.close);
  const now = Date.now(), customerId = "CUST-LEASE-EXPIRED", groupId = "GROOM-LEASE-EXPIRED";
  const session = await customerSession(ctx, customerId);
  seedLease(ctx, { groupId, customerId, sessionId: session.sessionId, leaseExpiresAt: now - 1, now });
  ctx.sqlite.prepare("UPDATE platform_identity_sessions SET expires_at=? WHERE id=?").run(now - 1, session.sessionId);

  const first = await ctx.governance.cleanupExpiredReservationLeases(ctx.db, now);
  assert.deepEqual(first, { groups: 1, reservations: 1 });
  assert.equal(ctx.sqlite.prepare("SELECT status FROM scheduling_reservations WHERE group_id=?").get(groupId).status, "cancelled");
  const decision = ctx.sqlite.prepare("SELECT status,actor_id,reason,updated_at FROM scheduling_assignment_decisions WHERE group_id=?").get(groupId);
  assert.deepEqual({ ...decision }, { status: "expired", actor_id: "system:reservation-lease-cleanup", reason: "reservation_lease_expired", updated_at: now });
  assert.equal(ctx.sqlite.prepare("SELECT status FROM provider_assignment_offers WHERE group_id=?").get(groupId).status, "cancelled");
  assert.deepEqual({ ...ctx.sqlite.prepare("SELECT reason,released_at FROM scheduling_reservation_lease_cleanup WHERE group_id=?").get(groupId) }, { reason: "reservation_lease_expired", released_at: now });

  const replay = await ctx.governance.cleanupExpiredReservationLeases(ctx.db, now + 5_000);
  assert.deepEqual(replay, { groups: 0, reservations: 0 });
  assert.deepEqual({ ...ctx.sqlite.prepare("SELECT status,actor_id,reason,updated_at FROM scheduling_assignment_decisions WHERE group_id=?").get(groupId) }, { ...decision }, "a retry must not rewrite the decision timestamp or reason");
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM scheduling_reservation_lease_cleanup WHERE group_id=?").get(groupId).n, 1, "cleanup has one durable idempotency row");
  for (const table of ["canonical_bookings"]) assert.equal(ctx.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
});

test("a forged session token cannot claim or release another customer's reservation", async (t) => {
  const ctx = await bareLeaseContext(); t.after(ctx.close);
  const now = Date.now(), customerId = "CUST-LEASE-VICTIM", groupId = "GROOM-LEASE-VICTIM";
  const authentic = await customerSession(ctx, customerId);
  seedLease(ctx, { groupId, customerId, sessionId: authentic.sessionId, leaseExpiresAt: now + LEASE_MS, now });
  const forged = new Request("https://uat.pawspace.in/api/uat-scheduling", { headers: { cookie: "pawspace_identity_session=forged-token-never-issued" } });

  const lease = await ctx.governance.reservationLeaseForRequest(ctx.db, forged, customerId, now);
  assert.deepEqual(lease, { customerSessionId: null, leaseExpiresAt: now + LEASE_MS }, "an unknown token supplies no customer-session authority");
  assert.deepEqual(await ctx.governance.cleanupExpiredReservationLeases(ctx.db, now), { groups: 0, reservations: 0 });
  assert.equal(ctx.sqlite.prepare("SELECT status,customer_session_id FROM scheduling_reservations WHERE group_id=?").get(groupId).status, "assigned");
  assert.equal(ctx.sqlite.prepare("SELECT customer_session_id FROM scheduling_reservations WHERE group_id=?").get(groupId).customer_session_id, authentic.sessionId);
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM scheduling_reservation_lease_cleanup").get().n, 0);
});

test("an active session cannot confirm after its lease expires at the atomic booking boundary", async (t) => {
  const ctx = await setupJourney(); t.after(ctx.close);
  const customerId = "CUST-LEASE-BOUNDARY", groupId = "GROOM-LEASE-BOUNDARY";
  const session = await customerSession(ctx, customerId);
  const startDate = new Date(Date.now() + 9 * 86_400_000); startDate.setUTCHours(5, 30, 0, 0);
  const start = startDate.toISOString(), end = new Date(startDate.getTime() + 2 * 60 * 60_000).toISOString();
  const scheduled = await routeCall("../../app/api/uat-scheduling/route.ts", "POST", "/api/uat-scheduling", {
    clientRequestId: groupId, customerId, petIds: ["PET-LEASE-BOUNDARY"], serviceCode: "grooming",
    cityId: "blr", zoneId: "blr-east", scheduledStart: start, scheduledEnd: end, preferredProviderId: "groom_arun",
  }, session.cookie);
  assert.equal(scheduled.status, 200, JSON.stringify(scheduled.body));
  assert.equal(ctx.sqlite.prepare("SELECT status FROM platform_identity_sessions WHERE id=?").get(session.sessionId).status, "active");
  assert.ok(Number(ctx.sqlite.prepare("SELECT lease_expires_at FROM scheduling_reservations WHERE group_id=?").get(groupId).lease_expires_at) > Date.now());

  let expiredInsideBookingBoundary = false;
  ctx.db.beforeBatch = async (items) => {
    if (!items.some((item) => String(item._sql).trim().startsWith("INSERT INTO booking_reservation_confirmation_guards"))) return;
    ctx.db.beforeBatch = null;
    expiredInsideBookingBoundary = true;
    ctx.sqlite.prepare("UPDATE scheduling_reservations SET lease_expires_at=0 WHERE group_id=?").run(groupId);
  };
  const rejected = await routeCall("../../app/api/canonical-bookings/route.ts", "POST", "/api/canonical-bookings", {
    idempotencyKey: groupId, scheduleGroupId: groupId,
    customer: { id: customerId, name: "Boundary Customer", primaryPhone: "+919900000818" },
    pets: [{ sourceId: "PET-LEASE-BOUNDARY", name: "Tara", species: "dog" }],
    cityId: "blr", zoneId: "blr-east", serviceCode: "grooming", packageCode: "dog-basic", packageName: "Bath & Basic",
    scheduledStart: start, scheduledEnd: end, provider: scheduled.body.data.provider,
    totalAmount: 1899, amountDueNow: 1899,
    payment: { method: "upi", mode: "prepaid", status: "created", detail: "atomic lease boundary" }, pricing: { discount: 0 },
  }, session.cookie);

  assert.equal(expiredInsideBookingBoundary, true, "the lease must expire after the friendly pre-check and immediately before the atomic booking batch");
  assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
  assert.equal(rejected.body.code, "reservation_expired");
  assert.equal(ctx.sqlite.prepare("SELECT status FROM platform_identity_sessions WHERE id=?").get(session.sessionId).status, "active", "lease expiry is independent of authentication expiry");
  assert.equal(ctx.sqlite.prepare("SELECT status FROM scheduling_reservations WHERE group_id=?").get(groupId).status, "cancelled");
  assert.equal(ctx.sqlite.prepare("SELECT status FROM scheduling_assignment_decisions WHERE group_id=?").get(groupId).status, "expired");
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM scheduling_reservation_lease_cleanup WHERE group_id=?").get(groupId).n, 1);
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM booking_reservation_confirmation_guards WHERE group_id=?").get(groupId).n, 0, "the rejected guard insert rolls back with the booking batch");
  for (const table of ["canonical_customers", "canonical_pets", "canonical_bookings", "booking_payments", "provider_work_orders", "booking_lifecycle_events"]) {
    assert.equal(ctx.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0, `${table} must remain empty after atomic lease expiry`);
  }
});

test("a replacement login preserves the superseded session's reservation until lease timeout", async (t) => {
  const ctx = await bareLeaseContext(); t.after(ctx.close);
  const now = Date.now(), customerId = "CUST-LEASE-RELOGIN", groupId = "GROOM-LEASE-RELOGIN";
  const original = await customerSession(ctx, customerId);
  seedLease(ctx, { groupId, customerId, sessionId: original.sessionId, leaseExpiresAt: now + LEASE_MS, now });
  await sessionCookie(ctx.db, "customer", customerId, `customer:${customerId}`);
  const originalRow = ctx.sqlite.prepare("SELECT status FROM platform_identity_sessions WHERE id=?").get(original.sessionId);
  const replacement = ctx.sqlite.prepare("SELECT id,status,expires_at FROM platform_identity_sessions WHERE subject_type='customer' AND subject_id=? AND status='active' LIMIT 1").get(customerId);
  assert.equal(originalRow.status, "superseded");
  assert.ok(replacement?.id && replacement.id !== original.sessionId, "re-login must issue a distinct active replacement session");
  assert.ok(Number(replacement.expires_at) > now);

  assert.deepEqual(await ctx.governance.cleanupExpiredReservationLeases(ctx.db, now), { groups: 0, reservations: 0 });
  assert.equal(ctx.sqlite.prepare("SELECT status FROM scheduling_reservations WHERE group_id=?").get(groupId).status, "assigned", "session rotation must not discard a still-live customer reservation");
  assert.equal(ctx.sqlite.prepare("SELECT status FROM scheduling_assignment_decisions WHERE group_id=?").get(groupId).status, "assigned");
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM scheduling_reservation_lease_cleanup WHERE group_id=?").get(groupId).n, 0);
  assert.equal(ctx.sqlite.prepare("SELECT status FROM platform_identity_sessions WHERE id=?").get(replacement.id).status, "active");
});

test("expired reservation cleanup restores real scheduler capacity", async (t) => {
  const ctx = await setupJourney(); t.after(ctx.close);
  const firstCustomer = "CUST-MAA-LEASE-A", secondCustomer = "CUST-MAA-LEASE-B", firstGroup = "GROOM-MAA-LEASE-A", secondGroup = "GROOM-MAA-LEASE-B";
  const firstSession = await customerSession(ctx, firstCustomer), secondCookie = await sessionCookie(ctx.db, "customer", secondCustomer, `customer:${secondCustomer}`);
  const startDate = new Date(Date.now() + 7 * 86_400_000); startDate.setUTCHours(10, 0, 0, 0);
  const start = startDate.toISOString(), end = new Date(startDate.getTime() + 2 * 60 * 60_000).toISOString();
  const payload = { petIds: ["PET-MAA-LEASE"], serviceCode: "grooming", cityId: "maa", zoneId: "chennai-core", scheduledStart: start, scheduledEnd: end, preferredProviderId: "groom_maa" };
  const first = await routeCall("../../app/api/uat-scheduling/route.ts", "POST", "/api/uat-scheduling", { ...payload, clientRequestId: firstGroup, customerId: firstCustomer }, firstSession.cookie);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const blocked = await routeCall("../../app/api/uat-scheduling/route.ts", "POST", "/api/uat-scheduling", { ...payload, clientRequestId: secondGroup, customerId: secondCustomer }, secondCookie);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error, "NO_SCHEDULE_AVAILABLE", "Chennai has one seeded groomer, so the occupied lease must consume the slot");

  const governance = await leaseGovernance();
  await governance.ensureSchedulingReservationLeaseGovernance(ctx.db);
  const now = Date.now();
  ctx.sqlite.prepare("UPDATE scheduling_reservations SET customer_session_id=?,lease_expires_at=? WHERE group_id=?").run(firstSession.sessionId, now - 1, firstGroup);
  ctx.sqlite.prepare("UPDATE platform_identity_sessions SET expires_at=? WHERE id=?").run(now - 1, firstSession.sessionId);
  assert.deepEqual(await governance.cleanupExpiredReservationLeases(ctx.db, now), { groups: 1, reservations: 1 });

  const restored = await routeCall("../../app/api/uat-scheduling/route.ts", "POST", "/api/uat-scheduling", { ...payload, clientRequestId: secondGroup, customerId: secondCustomer }, secondCookie);
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.equal(restored.body.data.provider.id, "groom_maa");
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM scheduling_reservations WHERE group_id=? AND status!='cancelled'").get(firstGroup).n, 0);
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM scheduling_reservations WHERE group_id=? AND status!='cancelled'").get(secondGroup).n, 1);
});

// The booking window must be pinned, not inherited from the clock. Without setUTCHours this booked
// "eight days from now at whatever time the suite happens to run", so the request fell outside the
// seeded provider roster whenever the suite ran outside working hours and the journey 409'd with
// NO_SCHEDULE_AVAILABLE - a calendar-dependent failure, not a capacity defect. Both sibling tests in
// this file already pin the hour this way.
function leaseStart(){const start=new Date(Date.now()+8*86_400_000);start.setUTCHours(5,30,0,0);return start.toISOString();}

test("cleanup never releases capacity behind an existing canonical booking", async (t) => {
  const ctx = await setupJourney(); t.after(ctx.close);
  const config = { customerId: "CUST-LEASE-CONFIRMED", customerName: "Confirmed Lease", phone: "+919900000909", petSourceId: "PET-LEASE-CONFIRMED", petName: "Miso", cityId: "blr", zoneId: "blr-east", pincode: "560038", latitude: 12.9716, longitude: 77.5946, preferredProviderId: "groom_arun", groupId: "GROOM-LEASE-CONFIRMED", start: leaseStart(), stopAfterCapture: true };
  const result = await runCompletedJourney(ctx, config);
  assert.equal(result.booked.status, 201, JSON.stringify(result.booked.body));
  const governance = await leaseGovernance();
  await governance.ensureSchedulingReservationLeaseGovernance(ctx.db);
  const session = ctx.sqlite.prepare("SELECT id FROM platform_identity_sessions WHERE subject_type='customer' AND subject_id=? ORDER BY issued_at DESC LIMIT 1").get(config.customerId);
  const now = Date.now();
  ctx.sqlite.prepare("UPDATE scheduling_reservations SET customer_session_id=?,lease_expires_at=? WHERE group_id=?").run(session.id, now - 1, config.groupId);
  ctx.sqlite.prepare("UPDATE platform_identity_sessions SET expires_at=? WHERE id=?").run(now - 1, session.id);

  assert.deepEqual(await governance.cleanupExpiredReservationLeases(ctx.db, now), { groups: 0, reservations: 0 });
  assert.equal(ctx.sqlite.prepare("SELECT status FROM scheduling_reservations WHERE group_id=?").get(config.groupId).status, "assigned");
  assert.equal(ctx.sqlite.prepare("SELECT status FROM scheduling_assignment_decisions WHERE group_id=?").get(config.groupId).status, "assigned");
  assert.equal(ctx.sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(result.bookingId).status, "confirmed");
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM booking_payments WHERE booking_id=?").get(result.bookingId).n, 1);
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM provider_work_orders WHERE booking_id=?").get(result.bookingId).n, 1);
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM scheduling_reservation_lease_cleanup WHERE group_id=?").get(config.groupId).n, 0);
});


test("a later lease generation for the same group can expire after an earlier cleanup", async (t) => {
  const ctx = await bareLeaseContext(); t.after(ctx.close);
  const firstNow = Date.now(), groupId = "GROOM-LEASE-SECOND-GEN", customerId = "CUST-LEASE-SECOND-GEN";
  const session = await customerSession(ctx, customerId);
  seedLease(ctx, { groupId, customerId, sessionId: session.sessionId, leaseExpiresAt: firstNow - 1, now: firstNow });
  assert.deepEqual(await ctx.governance.cleanupExpiredReservationLeases(ctx.db, firstNow), { groups: 1, reservations: 1 });

  const secondNow = firstNow + 60 * 60_000;
  ctx.sqlite.prepare("UPDATE scheduling_assignment_decisions SET status='assigned',actor_id='ops@pawspace.in',reason='reassigned',updated_at=? WHERE group_id=?").run(secondNow - 1000, groupId);
  ctx.sqlite.prepare("UPDATE provider_assignment_offers SET status='pending',responded_at=NULL,response_reason=NULL,updated_at=? WHERE group_id=?").run(secondNow - 1000, groupId);
  ctx.sqlite.prepare("INSERT INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,care_mode,status,explanation_json,created_at,lease_expires_at,customer_session_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'assigned','{}',?,?,?)")
    .run(`RES-${groupId}-2`, groupId, "groom_arun", "grooming", "blr", "blr-east", customerId, '["PET-2"]', "2026-11-27T10:00:00.000Z", "206-11-27T12:00:00.000Z", 1, 1, null, secondNow - 1000, secondNow - 1, session.sessionId);

  assert.deepEqual(await ctx.governance.cleanupExpiredReservationLeases(ctx.db, secondNow), { groups: 1, reservations: 1 });
  assert.equal(ctx.sqlite.prepare("SELECT status FROM scheduling_reservations WHERE id=?").get(`RES-${groupId}-2`).status, "cancelled");
  assert.deepEqual({ ...ctx.sqlite.prepare("SELECT status,actor_id,reason,updated_at FROM scheduling_assignment_decisions WHERE group_id=?").get(groupId) }, { status: "expired", actor_id: "system:reservation-lease-cleanup", reason: "reservation_lease_expired", updated_at: secondNow });
  assert.equal(ctx.sqlite.prepare("SELECT status FROM provider_assignment_offers WHERE group_id=?").get(groupId).status, "cancelled");
  assert.equal(ctx.sqlite.prepare("SELECT released_at FROM scheduling_reservation_lease_cleanup WHERE group_id=?").get(groupId).released_at, secondNow);
});
