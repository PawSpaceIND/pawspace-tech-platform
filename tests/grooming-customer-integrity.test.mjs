import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setupJourney, runCompletedJourney, routeCall } from "./helpers/grooming-journey-harness.mjs";

/*
 * Work Order 02. The server half of every customer-integrity claim is now executed on real D1 through
 * the governed journey: scheduling replay, booking idempotency, preview-never-reserves and the
 * pay-now gate. The client half (a React double-click guard, the payment page mount) cannot be
 * executed in node and stays pinned on source, next to the behaviour it protects.
 */
// The grooming checkout these cases describe lives in app/mobile-app/grooming-flow.tsx: app/page.tsx
// hands booking to the governed flow rather than running a second implementation of one [PTJA-P1-F38].
const source = readFileSync(new URL("../app/mobile-app/grooming-flow.tsx", import.meta.url), "utf8");
const entry = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
const transactionSource = readFileSync(new URL("../lib/test-transaction.ts", import.meta.url), "utf8");
const partnerFeedSource = readFileSync(new URL("../lib/partner-job-feed.ts", import.meta.url), "utf8");
const partnerJobsPage = readFileSync(new URL("../app/partner/jobs/page.tsx", import.meta.url), "utf8");
const code = source.split("\n").filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*") && !line.trim().startsWith("/*")).join("\n");
const { listProviderJobs } = await import("../lib/partner-job-feed.ts");
const { resolveGroomingSubscriptionPlan } = await import("../lib/grooming-governance.ts");

async function journey(t, suffix, extra = {}) {
  const ctx = await setupJourney(); t.after(ctx.close);
  const start = new Date(Date.now() + 5 * 86400000); start.setUTCHours(4, 30, 0, 0);
  const config = { customerId: `CUST-INTEGRITY-${suffix}`, customerName: "Asha", phone: "+919900000700", petSourceId: `PET-INTEGRITY-${suffix}`, petName: "Bolt", cityId: "blr", zoneId: "blr-east", pincode: "560038", latitude: 12.9716, longitude: 77.5946, preferredProviderId: "groom_arun", groupId: `GROOM-INTEGRITY-${suffix}`, start: start.toISOString(), stopAfterCapture: true, ...extra };
  return { ctx, config, result: await runCompletedJourney(ctx, config) };
}

test("grooming checkout persists normalized customer identity instead of generated placeholders", async (t) => {
  // The identity is the signed-in customer resolved from the platform session: the journey books as the
  // session subject and the persisted booking carries exactly that id, never a constructed placeholder.
  const { ctx, config, result } = await journey(t, "id");
  const booking = ctx.sqlite.prepare("SELECT customer_id FROM canonical_bookings WHERE id=?").get(result.bookingId);
  assert.equal(booking.customer_id, config.customerId);
  const customer = ctx.sqlite.prepare("SELECT name,primary_phone FROM canonical_customers WHERE id=?").get(config.customerId);
  assert.equal(customer.name, config.customerName);
  assert.doesNotMatch(customer.name, /^PawSpace Customer/);
  assert.match(source, /customerId:customer\.customerId/);
  assert.match(source, /customerName:customerName/);
  assert.match(source, /primary:customerPhone/);
  assert.doesNotMatch(code, /customerName:`PawSpace Customer/);
  assert.match(entry, /loadCustomerAccount\(\)/);
  assert.doesNotMatch(entry, /`WEB-\$\{/);
});

test("grooming checkout persists the selected safety requirement", () => {
  assert.match(source, /requirements:\[`grooming_safety:\$\{safetyNotes\}`/);
  assert.match(source, /Aggressive \/ bite history/);
});

test("assigned groomer receives canonical safety requirements and add-ons from the persisted booking", async (t) => {
  const { ctx, result } = await journey(t, "feed");
  const pricing = JSON.parse(ctx.sqlite.prepare("SELECT pricing_json FROM canonical_bookings WHERE id=?").get(result.bookingId).pricing_json);
  ctx.sqlite.prepare("UPDATE canonical_bookings SET pricing_json=? WHERE id=?").run(JSON.stringify({ ...pricing, requirements: ["grooming_safety:aggressive"], addOns: ["Tick & flea treatment"] }), result.bookingId);
  const feed = await listProviderJobs(ctx.db, result.provider.id);
  const job = [...feed.needsAction, ...feed.today, ...feed.upcoming, ...feed.completed].find((item) => item.bookingId === result.bookingId);
  assert.ok(job, "the assigned groomer sees the booking in their feed");
  assert.deepEqual(job.safetyRequirements, ["grooming_safety:aggressive"]);
  assert.deepEqual(job.addOns, ["Tick & flea treatment"]);
  assert.match(partnerFeedSource, /pricing_json FROM canonical_bookings/);
  assert.match(partnerJobsPage, /job\.serviceCode==="grooming"&&job\.safetyRequirements\.length/);
  assert.match(partnerJobsPage, /job\.serviceCode==="grooming"&&job\.addOns\.length/);
});

test("grooming subscription copy matches the governed 6 and 12 month commercial truth resolved from D1", async (t) => {
  const ctx = await setupJourney(); t.after(ctx.close);
  const six = await resolveGroomingSubscriptionPlan(ctx.db, "sub-6", "blr", "blr-east");
  const twelve = await resolveGroomingSubscriptionPlan(ctx.db, "sub-12", "blr", "blr-east");
  assert.deepEqual({ sessions: six?.sessions, price: six?.singlePrice, validity: six?.validityValue }, { sessions: 6, price: 6594, validity: 6 });
  assert.deepEqual({ sessions: twelve?.sessions, price: twelve?.singlePrice, validity: twelve?.validityValue }, { sessions: 12, price: 11988, validity: 12 });
  assert.match(source, /id:"6",name:"6 sessions",price:6594,validity:"6 months"/);
  assert.match(source, /id:"12",name:"12 sessions",price:11988,validity:"12 months"/);
  assert.doesNotMatch(code, /validity:"8 months"/);
  assert.doesNotMatch(code, /validity:"15 months"/);
});

test("coupon quote uses the verified service-location city instead of a hardcoded geography", () => {
  assert.match(source, /cityId=\{serviceLocation\?\.assignment\.cityId\?\?""\}/);
  assert.doesNotMatch(code, /cityId="blr"/);
});

test("confirmation proof is derived from the public provider profile", () => {
  assert.match(source, /provider-public-profile\?providerId=/);
  assert.match(source, /providerProof\.stats\.completedServices/);
  assert.match(source, /providerProof\.isNewProvider&&/);
  assert.doesNotMatch(code, /1,248 services/);
  assert.doesNotMatch(code, /4 years with PawSpace/);
});

test("a double-submitted booking is one booking: scheduling and booking replays return the same records and write nothing new", async (t) => {
  const { ctx, config, result } = await journey(t, "1");
  assert.equal(result.scheduled.status, 200, JSON.stringify(result.scheduled.body));
  assert.equal(result.scheduleReplay.body.data.groupId, result.scheduled.body.data.groupId);
  assert.equal(result.scheduleReplay.body.data.provider.id, result.provider.id);
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM scheduling_reservations WHERE group_id=? AND status!='cancelled'").get(config.groupId).n, 1, "one held slot, not two");
  assert.equal(result.booked.status, 201, JSON.stringify(result.booked.body));
  assert.equal(result.bookingReplay.status, 200);
  assert.equal(result.bookingReplay.body.data.bookingId, result.bookingId);
  assert.equal(result.bookingReplay.body.data.duplicatePrevented, true);
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM canonical_bookings WHERE idempotency_key=?").get(config.groupId).n, 1);
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM booking_payments WHERE booking_id=?").get(result.bookingId).n, 1);
  // Client-side: the confirm handler is single-flight and the button is disabled while it runs.
  assert.match(source, /const actionLock=useRef\(false\);/);
  assert.match(source, /confirm=async\(\)=>\{if\(actionLock\.current\|\|scheduling\)return;/);
  assert.match(source, /actionLock\.current=true;setScheduling\(true\)/);
  assert.match(source, /finally\{actionLock\.current=false;setScheduling\(false\);\}/);
  assert.match(source, /disabled=\{scheduling\|\|!checkoutReady\}/);
});

test("provider preview never reserves capacity", async (t) => {
  const { ctx, config, result } = await journey(t, "2");
  const start = new Date(config.start); start.setUTCDate(start.getUTCDate() + 1);
  const end = new Date(start.getTime() + 2 * 60 * 60_000);
  const preview = await routeCall("../../app/api/uat-scheduling/route.ts", "POST", "/api/uat-scheduling", { action: "preview", clientRequestId: `${config.groupId}-preview`, customerId: config.customerId, petIds: [config.petSourceId], serviceCode: "grooming", cityId: config.cityId, zoneId: config.zoneId, serviceAddress: "Asha service address", servicePincode: config.pincode, scheduledStart: start.toISOString(), scheduledEnd: end.toISOString() }, result.customerCookie);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.ok(Array.isArray(preview.body.data.providers) && preview.body.data.providers.length >= 1, "the customer sees real eligible groomers");
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM scheduling_reservations WHERE group_id=?").get(`${config.groupId}-preview`).n, 0, "a preview holds nothing");
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM scheduling_reservations WHERE customer_id=? AND status!='cancelled'").get(config.customerId).n, 1, "only the real reservation exists");
  // And the client calls reserve exactly once, from the confirm path.
  assert.equal((code.match(/reserveUatSchedule\(/g) || []).length, 1);
});

test("pay-now is gated on a verified capture: the booking is payment_pending until the gateway event, and the event is consumed once", async (t) => {
  const { ctx, config, result } = await journey(t, "3");
  const events = ctx.sqlite.prepare("SELECT event_type,detail_json FROM booking_lifecycle_events WHERE booking_id=? ORDER BY occurred_at").all(result.bookingId);
  assert.equal(result.booked.body.data.status, "payment_pending", "the client cannot self-confirm an online booking");
  const booking = ctx.sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(result.bookingId);
  const payment = ctx.sqlite.prepare("SELECT status FROM booking_payments WHERE booking_id=?").get(result.bookingId);
  assert.ok([200, 201].includes(result.captured.status), JSON.stringify(result.captured.body));
  assert.equal(result.captureReplay.body.data.result.duplicate, true, "the replayed gateway event is recognised, not re-applied");
  assert.equal(payment.status, "captured");
  assert.equal(booking.status, "confirmed");
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM payment_gateway_events WHERE provider='razorpay' AND event_id=?").get(`evt_${config.groupId}`).n, 1, "the replayed webhook did not create a second event");
  assert.ok(events.length >= 1);
  // Client-side: the shared payment page is the only way to pay and success is not declared locally.
  assert.match(source, /import BookingPaymentPage/);
  assert.match(source, /mode:pay==="online"\?"prepaid":"pay_after_service"/);
  assert.match(source, /setPendingPayment\(\{bookingId:canonical\.bookingId/);
  assert.match(source, /<BookingPaymentPage[^>]*serviceName="Grooming"/);
  assert.match(source, /onVerified=\{(?:async)?\(\)=>\{/);
  assert.doesNotMatch(code, /Paid in UAT sandbox/);
  assert.match(transactionSource, /"payment_pending"/);
});

test("mutable persisted booking inputs participate in the idempotency fingerprint, and the server fingerprint is what dedupes", async (t) => {
  const { ctx, config, result } = await journey(t, "4");
  // The same key with a different amount is still the same booking: the persisted record wins.
  const tampered = await routeCall("../../app/api/canonical-bookings/route.ts", "POST", "/api/canonical-bookings", { ...result.bookingPayload, totalAmount: 1, amountDueNow: 1 }, result.customerCookie);
  assert.ok([200, 409].includes(tampered.status), JSON.stringify(tampered.body));
  assert.equal(ctx.sqlite.prepare("SELECT total_amount FROM canonical_bookings WHERE id=?").get(result.bookingId).total_amount, result.total);
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM canonical_bookings WHERE customer_id=?").get(config.customerId).n, 1);
  assert.match(source, /stableBookingInputKey\(\[/);
  for (const input of ["customer.customerId", "date", "String(slotIndex)", "String(count)", "String(pay)", "safetyNotes", "String(total)", "packId"]) assert.ok(source.includes(input), input);
});

test("grooming schedule copy does not claim unobserved live capacity", () => {
  assert.doesNotMatch(code, /Live groomer calendar/);
  assert.doesNotMatch(code, /update automatically from groomer calendars/);
  assert.doesNotMatch(code, />2 groomers</);
});
