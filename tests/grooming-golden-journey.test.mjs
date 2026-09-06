import test from "node:test";
import assert from "node:assert/strict";
import { setupJourney, runCompletedJourney, routeCall, sessionCookie } from "./helpers/grooming-journey-harness.mjs";

const future = (hour) => {
  // UAT grooming roster is 09:00-19:00 IST. `hour` is the UTC hour of a `:30` instant, which is
  // IST `(hour+6):00`. A two-hour slot therefore fits the roster only when `hour` is 3..11.
  // Offset from the live clock so a leaked Date.now pin cannot push a hardcoded calendar date into
  // the past or beyond the 180-day booking horizon.
  const now = Date.now();
  const start = new Date(now + 3 * 86_400_000);
  start.setUTCHours(hour, 30, 0, 0);
  if (start.getTime() <= now + 2 * 60 * 60_000) start.setUTCDate(start.getUTCDate() + 1);
  return start.toISOString();
};

function countIfTableExists(sqlite, table) {
  const exists = sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  return exists ? Number(sqlite.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c) : 0;
}

function assertCompleted(result, expected) {
  assert.equal(result.coverage.assignment.zoneId, expected.zoneId);
  assert.equal(result.scheduled.status, 200, JSON.stringify(result.scheduled.body));
  assert.equal(result.scheduleReplay.body.data.duplicatePrevented, true);
  assert.equal(result.booked.status, 201, JSON.stringify(result.booked.body));
  assert.equal(result.location.status, 201, JSON.stringify(result.location.body));
  assert.equal(result.location.body.data.cityId, expected.cityId);
  assert.equal(result.location.body.data.zoneId, expected.zoneId);
  assert.equal(result.bookingReplay.body.data.duplicatePrevented, true);
  assert.equal(result.persisted.counts.bookings, 1);
  assert.equal(result.persisted.counts.payments, 1);
  assert.equal(result.persisted.counts.events, 1);
  assert.equal(result.persisted.booking.customer_id, expected.customerId);
  assert.equal(result.persisted.booking.city_id, expected.cityId);
  assert.equal(result.persisted.booking.zone_id, expected.zoneId);
  assert.equal(result.persisted.booking.provider_id, result.provider.id);
  assert.equal(result.persisted.booking.package_name, "Bath & Basic", "server catalogue overrides the client package name");
  assert.equal(result.persisted.booking.total_amount, result.total);
  assert.equal(result.persisted.pet.source_pet_id, expected.petSourceId);
  assert.equal(result.persisted.reservation.customer_id, expected.customerId);
  assert.equal(result.persisted.reservation.city_id, expected.cityId);
  assert.equal(result.persisted.reservation.zone_id, expected.zoneId);
  assert.equal(result.persisted.reservation.provider_id, result.provider.id);
  assert.equal(result.persisted.payment.status, "captured");
  assert.equal(result.persisted.payment.amount, result.persisted.booking.total_amount);
  assert.equal(result.persisted.location.customer_id, expected.customerId);
  assert.equal(result.persisted.location.latitude, expected.latitude);
  assert.equal(result.persisted.location.longitude, expected.longitude);
  assert.match(result.persisted.location.address_text, new RegExp(expected.pincode));
  assert.equal(result.persisted.address.postal_code, expected.pincode);
  assert.equal(result.jobs.status, 200);
  assert.equal(result.jobs.body.jobs.some((job) => job.bookingId === result.bookingId), true);
  assert.deepEqual(result.transitions.map((step) => step.status), [200, 200, 200, 200]);
  assert.equal(result.invalidEarlyComplete.status, 409, "completion without proof fails closed");
  assert.equal(result.proof.status, 200);
  assert.equal(result.completed.status, 200, JSON.stringify(result.completed.body));
  assert.equal(result.persisted.work.status, "completed");
  assert.equal(result.persisted.booking.status, "completed");
  assert.equal(result.visible.body.bookings.some((booking) => booking.id === result.bookingId && booking.status === "completed"), true);
}

test("Bengaluru customer completes one canonical discounted Grooming booking through real routes", async (t) => {
  const ctx = await setupJourney(); t.after(ctx.close);
  const config = { customerId: "CUST-BLR-GOLD", customerName: "Asha Rao", phone: "+919900000101", petSourceId: "PET-SOURCE-BLR", petName: "Milo", cityId: "blr", zoneId: "blr-east", pincode: "560038", latitude: 12.9716, longitude: 77.5946, preferredProviderId: "groom_arun", groupId: "GROOM-GOLD-BLR", couponCode: "UATCARE100", start: future(4) };
  const result = await runCompletedJourney(ctx, config);
  assertCompleted(result, config);
  assert.equal(result.total, 1799);
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) c FROM coupon_redemptions WHERE booking_id=?").get(result.bookingId).c, 1);
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) c FROM booking_invoices WHERE booking_id=?").get(result.bookingId).c, 1);
  assert.equal(result.captureReplay.body.data.result.duplicate, true, "the same gateway event is processed exactly once");
  const intruder = await sessionCookie(ctx.db, "provider", "groom_kiran", "provider:groom_kiran");
  const forbidden = await routeCall("../../app/api/grooming-lifecycle/route.ts", "POST", "/api/grooming-lifecycle", { bookingId: result.bookingId, action: "on_the_way" }, intruder, "https://uat.pawspace.in");
  assert.equal(forbidden.status, 403);
  assert.equal(ctx.sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(result.bookingId).status, "completed");
});

test("second-city journey preserves city/zone/provider and rejects cross-city confirmation without orphans", async (t) => {
  const ctx = await setupJourney(); t.after(ctx.close);
  const config = { customerId: "CUST-MAA-GOLD", customerName: "Divya Iyer", phone: "+919900000202", petSourceId: "PET-SOURCE-MAA", petName: "Kavi", cityId: "maa", zoneId: "chennai-core", pincode: "600001", latitude: 13.0827, longitude: 80.2707, preferredProviderId: "groom_maa", groupId: "GROOM-GOLD-MAA", start: future(9) };
  const result = await runCompletedJourney(ctx, config);
  assertCompleted(result, config);

  const otherCookie = await sessionCookie(ctx.db, "customer", "CUST-CROSS-CITY", "customer:CUST-CROSS-CITY");
  const crossGroup = "GROOM-CROSS-CITY";
  const start = future(5), end = new Date(new Date(start).getTime() + 2 * 60 * 60_000).toISOString();
  const scheduled = await routeCall("../../app/api/uat-scheduling/route.ts", "POST", "/api/uat-scheduling", { clientRequestId: crossGroup, customerId: "CUST-CROSS-CITY", petIds: ["PET-CROSS"], serviceCode: "grooming", cityId: "maa", zoneId: "chennai-core", scheduledStart: start, scheduledEnd: end, preferredProviderId: "groom_maa" }, otherCookie);
  assert.equal(scheduled.status, 200);
  const before = ctx.sqlite.prepare("SELECT COUNT(*) c FROM canonical_bookings").get().c;
  const rejected = await routeCall("../../app/api/canonical-bookings/route.ts", "POST", "/api/canonical-bookings", { idempotencyKey: crossGroup, scheduleGroupId: crossGroup, customer: { id: "CUST-CROSS-CITY", name: "Cross City", primaryPhone: "+919900000303" }, pets: [{ sourceId: "PET-CROSS", name: "Rex", species: "dog" }], cityId: "blr", zoneId: "blr-east", serviceCode: "grooming", packageCode: "dog-basic", packageName: "Bath & Basic", scheduledStart: start, scheduledEnd: end, provider: scheduled.body.data.provider, totalAmount: 1899, amountDueNow: 1899, payment: { method: "upi", mode: "prepaid", status: "created", detail: "cross-city attack" }, pricing: { discount: 0 } }, otherCookie);
  assert.equal(rejected.status, 409);
  assert.match(rejected.body.error, /city\/zone|commercially configured/i);
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) c FROM canonical_bookings").get().c, before);
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) c FROM booking_payments WHERE customer_id='CUST-CROSS-CITY'").get().c, 0);
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) c FROM provider_work_orders WHERE schedule_group_id=?").get(crossGroup).c, 0);
});

test("unsupported location and no-capacity failures create no booking/payment/work-order orphans", async (t) => {
  const ctx = await setupJourney(); t.after(ctx.close);
  const { resolveZoneByPincode } = await import("../lib/service-zones.ts");
  assert.equal(await resolveZoneByPincode(ctx.db, "999999"), null);

  const cookie = await sessionCookie(ctx.db, "customer", "CUST-NOCAP", "customer:CUST-NOCAP");
  await routeCall("../../app/api/canonical-bookings/route.ts", "GET", "/api/canonical-bookings", null);
  const base = { customerId: "CUST-NOCAP", petIds: ["PET-NOCAP"], serviceCode: "grooming", cityId: "maa", zoneId: "chennai-core", scheduledStart: future(7), scheduledEnd: future(9), preferredProviderId: "groom_maa" };
  const first = await routeCall("../../app/api/uat-scheduling/route.ts", "POST", "/api/uat-scheduling", { ...base, clientRequestId: "NOCAP-1" }, cookie);
  const second = await routeCall("../../app/api/uat-scheduling/route.ts", "POST", "/api/uat-scheduling", { ...base, clientRequestId: "NOCAP-2", customerId: "CUST-NOCAP-2" }, await sessionCookie(ctx.db, "customer", "CUST-NOCAP-2", "customer:CUST-NOCAP-2"));
  assert.equal(first.status, 200);
  assert.equal(second.status, 409);
  assert.equal(second.body.error, "NO_SCHEDULE_AVAILABLE");
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) c FROM canonical_bookings").get().c, 0);
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) c FROM booking_payments").get().c, 0);
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) c FROM provider_work_orders").get().c, 0);
});

test("session expiry between coupon quote and booking fails closed without business-entity orphans", async (t) => {
  const ctx = await setupJourney(); t.after(ctx.close);
  const customerId = "CUST-EXPIRED", groupId = "GROOM-EXPIRED", cookie = await sessionCookie(ctx.db, "customer", customerId, `customer:${customerId}`);
  const start = future(10), end = future(12);
  const scheduled = await routeCall("../../app/api/uat-scheduling/route.ts", "POST", "/api/uat-scheduling", { clientRequestId: groupId, customerId, petIds: ["PET-EXPIRED"], serviceCode: "grooming", cityId: "blr", zoneId: "blr-east", scheduledStart: start, scheduledEnd: end, preferredProviderId: "groom_arun" }, cookie);
  assert.equal(scheduled.status, 200);
  const { quoteCoupon } = await import("../lib/coupon-governance.ts");
  const quote = await quoteCoupon(ctx.db, { code: "UATCARE100", customerId, serviceCode: "grooming", cityId: "blr", channel: "customer_app", packageCode: "dog-basic", orderValue: 1899, paymentMode: "full", isSubscription: false });
  assert.equal(quote.valid, true);
  ctx.sqlite.prepare("UPDATE platform_identity_sessions SET expires_at=? WHERE subject_id=?").run(Date.now() - 1, customerId);
  const rejected = await routeCall("../../app/api/canonical-bookings/route.ts", "POST", "/api/canonical-bookings", { idempotencyKey: groupId, scheduleGroupId: groupId, customer: { id: customerId, name: "Expired Customer", primaryPhone: "+919900000404" }, pets: [{ sourceId: "PET-EXPIRED", name: "Rio", species: "dog" }], cityId: "blr", zoneId: "blr-east", serviceCode: "grooming", packageCode: "dog-basic", packageName: "Bath & Basic", scheduledStart: start, scheduledEnd: end, provider: scheduled.body.data.provider, totalAmount: quote.finalAmount, amountDueNow: quote.finalAmount, payment: { method: "upi", mode: "prepaid", status: "created", detail: "expired" }, pricing: { discount: quote.discount, couponCode: "UATCARE100", couponQuoteId: quote.quoteId } }, cookie, "https://uat.pawspace.in");
  assert.equal(rejected.status, 401);
  for (const table of ["canonical_bookings", "booking_payments", "provider_work_orders", "coupon_redemptions"]) {
    assert.equal(countIfTableExists(ctx.sqlite, table), 0, `${table} must remain absent or empty`);
  }
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) c FROM scheduling_reservations WHERE group_id=? AND status!='cancelled'").get(groupId).c, 0, "the expired pre-auth reservation releases capacity before booking authorization fails");
  assert.equal(ctx.sqlite.prepare("SELECT status FROM scheduling_assignment_decisions WHERE group_id=?").get(groupId).status, "expired");
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) c FROM scheduling_reservation_lease_cleanup WHERE group_id=?").get(groupId).c, 1, "lease cleanup is durably idempotent");
});

test("captured booking cancellation releases work and capacity and refund simulation is idempotent", async (t) => {
  const ctx = await setupJourney(); t.after(ctx.close);
  const config = { customerId: "CUST-CANCEL", customerName: "Nila Shah", phone: "+919900000505", petSourceId: "PET-CANCEL", petName: "Loki", cityId: "blr", zoneId: "blr-east", pincode: "560038", latitude: 12.9716, longitude: 77.5946, preferredProviderId: "groom_arun", groupId: "GROOM-CANCEL", start: future(10), stopAfterCapture: true };
  const result = await runCompletedJourney(ctx, config);
  const cancelled = await routeCall("../../app/api/grooming-booking-change/route.ts", "POST", "/api/grooming-booking-change", { bookingId: result.bookingId, customerId: config.customerId, action: "cancel", reason: "Customer requested cancellation" }, result.customerCookie);
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.data.refundAmount, 1899);
  const duplicateCancel = await routeCall("../../app/api/grooming-booking-change/route.ts", "POST", "/api/grooming-booking-change", { bookingId: result.bookingId, customerId: config.customerId, action: "cancel", reason: "Customer requested cancellation retry" }, result.customerCookie);
  assert.equal(duplicateCancel.status, 409);
  assert.equal(ctx.sqlite.prepare("SELECT status FROM provider_work_orders WHERE booking_id=?").get(result.bookingId).status, "cancelled");
  assert.equal(ctx.sqlite.prepare("SELECT status FROM scheduling_reservations WHERE group_id=?").get(config.groupId).status, "cancelled");
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) c FROM booking_refund_cases WHERE booking_id=?").get(result.bookingId).c, 1);
  const refundEvent = { action: "simulate_event", bookingId: result.bookingId, eventType: "refund.processed", eventId: "evt_refund_groom_cancel", gatewayRefundId: "rfnd_groom_cancel", amount: 1899, currency: "INR" };
  const refunded = await routeCall("../../app/api/grooming-payment-sandbox/route.ts", "POST", "/api/grooming-payment-sandbox", refundEvent);
  const refundReplay = await routeCall("../../app/api/grooming-payment-sandbox/route.ts", "POST", "/api/grooming-payment-sandbox", refundEvent);
  assert.equal(refunded.status, 201);
  assert.equal(refundReplay.body.data.result.duplicate, true);
  assert.equal(ctx.sqlite.prepare("SELECT status FROM booking_payments WHERE booking_id=?").get(result.bookingId).status, "refunded");
  assert.equal(ctx.sqlite.prepare("SELECT status FROM booking_refund_cases WHERE booking_id=?").get(result.bookingId).status, "processed");
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) c FROM payment_gateway_events WHERE event_id=?").get(refundEvent.eventId).c, 1);
});

test("provider unavailability added after reserve fails confirmation cleanly and requests reassignment", async (t) => {
  const ctx = await setupJourney(); t.after(ctx.close);
  const customerId = "CUST-LATE-LEAVE", groupId = "GROOM-LATE-LEAVE", cookie = await sessionCookie(ctx.db, "customer", customerId, `customer:${customerId}`);
  const start = future(10), end = future(12);
  const scheduled = await routeCall("../../app/api/uat-scheduling/route.ts", "POST", "/api/uat-scheduling", { clientRequestId: groupId, customerId, petIds: ["PET-LATE-LEAVE"], serviceCode: "grooming", cityId: "blr", zoneId: "blr-east", scheduledStart: start, scheduledEnd: end, preferredProviderId: "groom_arun" }, cookie);
  assert.equal(scheduled.status, 200);
  const now = Date.now();
  let injectedInsideBookingBoundary = false;
  ctx.db.beforeBatch = async (items) => {
    if (!items.some((item) => String(item._sql).trim().startsWith("INSERT INTO provider_booking_confirmation_guards"))) return;
    ctx.db.beforeBatch = null;
    injectedInsideBookingBoundary = true;
    ctx.sqlite.prepare("INSERT INTO provider_unavailability (id,provider_id,starts_at,ends_at,reason,status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,'active','journey-test',?,?)").run("UNAV-LATE", scheduled.body.data.provider.id, start, end, "leave inserted after pre-check and immediately before atomic booking batch", now, now);
  };
  const booked = await routeCall("../../app/api/canonical-bookings/route.ts", "POST", "/api/canonical-bookings", { idempotencyKey: groupId, scheduleGroupId: groupId, customer: { id: customerId, name: "Late Leave", primaryPhone: "+919900000606" }, pets: [{ sourceId: "PET-LATE-LEAVE", name: "Zoe", species: "dog" }], cityId: "blr", zoneId: "blr-east", serviceCode: "grooming", packageCode: "dog-basic", packageName: "Bath & Basic", scheduledStart: start, scheduledEnd: end, provider: scheduled.body.data.provider, totalAmount: 1899, amountDueNow: 1899, payment: { method: "upi", mode: "prepaid", status: "created", detail: "late leave reproduction" }, pricing: { discount: 0 } }, cookie);
  assert.equal(injectedInsideBookingBoundary, true, "the leave must be injected after the friendly SELECT and immediately before the guarded atomic booking batch");
  assert.equal(booked.status, 409);
  assert.equal(booked.body.code, "provider_unavailable_before_booking");
  assert.equal(booked.body.reassignmentRequired, true);
  assert.equal(ctx.sqlite.prepare("SELECT status FROM scheduling_reservations WHERE group_id=?").get(groupId).status, "cancelled");
  assert.equal(ctx.sqlite.prepare("SELECT status FROM scheduling_assignment_decisions WHERE group_id=?").get(groupId).status, "reassignment_needed");
  for (const table of ["canonical_bookings", "booking_payments", "provider_work_orders", "canonical_pets", "booking_lifecycle_events"]) {
    assert.equal(ctx.sqlite.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c, 0, `${table} must remain empty after late provider unavailability`);
  }
});
