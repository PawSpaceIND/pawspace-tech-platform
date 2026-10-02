import test from "node:test";
import assert from "node:assert/strict";
import { setupJourney, routeCall, sessionCookie } from "./helpers/grooming-journey-harness.mjs";
import { seedOwnedPet } from "./helpers/saved-pet-fixture.mjs";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { d1 } from "./helpers/execution-harness.mjs";

// Real governed routes and serialized atomic SQLite batches; no hosted browser or external transport.
// Concurrent promises exercise application interleaving, not independent D1 connection isolation.
const CUSTOMER = "TASK5-CUSTOMER";
const START = "2026-10-04T03:30:00.000Z";
const call = (path, method, body, cookie = "") => routeCall(`../../app${path}/route.ts`, method, path, body, cookie);
async function financeCall(path, body, cookie = "") {
  if (cookie) return call(path, "POST", body, cookie);
  const route = await import(`../app${path}/route.ts`);
  const response = await route.POST(new Request(`https://uat.pawspace.in${path}`, { method: "POST", headers: { "content-type": "application/json", "oai-authenticated-user-email": "task5-finance@pawspace.test" }, body: JSON.stringify(body) }));
  return { status: response.status, body: await response.json() };
}
const end = (start, hours) => new Date(Date.parse(start) + hours * 3600000).toISOString();

async function world(t, species = ["dog", "dog", "dog"]) {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-01T04:00:00Z") });
  const fetchSink = t.mock.method(globalThis, "fetch", async () => { throw new Error("Task5 forbids all external fetches"); });
  t.after(() => assert.equal(fetchSink.mock.callCount(), 0, "no external transport was even attempted"));
  const w = await setupJourney();
  t.after(w.close);
  w.sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('TASK5-FINANCE','task5-finance@pawspace.test','Synthetic Finance','finance','active',?,?)").run(Date.now(), Date.now());
  const pets = [];
  for (let i = 0; i < species.length; i++) {
    const id = `TASK5-PET-${i + 1}`;
    await seedOwnedPet(w.db, CUSTOMER, id, `Synthetic pet ${i + 1}`);
    w.sqlite.prepare("UPDATE canonical_pets SET species=? WHERE id=?").run(species[i], id);
    pets.push({ sourceId: id, name: `Synthetic pet ${i + 1}`, species: species[i], vaccinationStatus: "verified" });
  }
  const cookie = await sessionCookie(w.db, "customer", CUSTOMER, "task5-customer");
  return { ...w, pets, cookie };
}

async function reserve(w, group, pets, service = "grooming", start = START, hours = pets.length * 2) {
  const input = { clientRequestId: group, customerId: CUSTOMER, petIds: pets.map(p => p.sourceId), serviceCode: service,
    cityId: "blr", zoneId: "blr-east", serviceAddress: "Synthetic address, Indiranagar, Bengaluru", servicePincode: "560038",
    scheduledStart: start, scheduledEnd: end(start, hours), ...(service === "grooming" ? { preferredProviderId: "groom_arun" } : { preferredProviderId: "sit_sana", providerSelection: "specific", careMode: "visit" }) };
  return { input, response: await call("/api/uat-scheduling", "POST", input, w.cookie) };
}

async function grooming(w, group, pets, start = START, packageCode = "dog-basic") {
  const { quoteGroomingBookingWithLiveMultiPet } = await import("../lib/live-grooming-governance.ts");
  const quote = await quoteGroomingBookingWithLiveMultiPet(w.db, { packageCode, pets, cityId: "blr", zoneId: "blr-east",
    scheduledStart: start, paymentMode: "prepaid", discount: 0 });
  const reserved = await reserve(w, group, pets, "grooming", start);
  assert.equal(reserved.response.status, 200, JSON.stringify(reserved.response));
  assert.equal(reserved.response.body.data.status, "assigned");
  const payload = { idempotencyKey: group, scheduleGroupId: group,
    customer: { id: CUSTOMER, name: "Synthetic Task5 customer", primaryPhone: "+919000000661" }, pets,
    cityId: "blr", zoneId: "blr-east", serviceCode: "grooming", packageCode, packageName: quote.packageName,
    scheduledStart: start, scheduledEnd: reserved.input.scheduledEnd, provider: reserved.response.body.data.provider,
    totalAmount: quote.totalAmount, amountDueNow: quote.amountDueNow,
    payment: { method: "upi", mode: "prepaid", status: "created", detail: "Task5 local sandbox" }, pricing: { discount: 0 } };
  return { payload, quote };
}

async function book(w, prepared) {
  const response = await call("/api/canonical-bookings", "POST", prepared.payload, w.cookie);
  assert.equal(response.status, 201, JSON.stringify(response));
  return { ...prepared, bookingId: response.body.data.bookingId, response };
}

async function capture(w, booked, amount = booked.quote.totalAmount, suffix = "capture") {
  const linked = await call("/api/grooming-payment-sandbox", "POST", { action: "link_order", bookingId: booked.bookingId,
    gatewayOrderId: `order_task5_${booked.payload.scheduleGroupId}` });
  assert.equal(linked.status, 201, JSON.stringify(linked));
  return call("/api/grooming-payment-sandbox", "POST", { action: "simulate_event", bookingId: booked.bookingId,
    eventType: "payment.captured", eventId: `evt_task5_${booked.payload.scheduleGroupId}_${suffix}`,
    gatewayPaymentId: `pay_task5_${booked.payload.scheduleGroupId}`, amount, currency: "INR" });
}

const payment = (w, id) => w.sqlite.prepare("SELECT booking_id,amount,status FROM booking_payments WHERE booking_id=?").get(id);
const siblingState = (w, b) => ({
  booking: w.sqlite.prepare("SELECT * FROM canonical_bookings WHERE id=?").get(b.bookingId),
  payment: w.sqlite.prepare("SELECT * FROM booking_payments WHERE booking_id=?").get(b.bookingId),
  work: w.sqlite.prepare("SELECT * FROM provider_work_orders WHERE booking_id=?").get(b.bookingId),
  reservations: w.sqlite.prepare("SELECT * FROM scheduling_reservations WHERE group_id=? ORDER BY id").all(b.payload.scheduleGroupId),
  refunds: w.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='booking_refund_cases'").get() ? w.sqlite.prepare("SELECT * FROM booking_refund_cases WHERE booking_id=? ORDER BY id").all(b.bookingId) : [],
  reconciliation: w.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='payment_reconciliation_records'").get() ? w.sqlite.prepare("SELECT * FROM payment_reconciliation_records WHERE booking_id=?").get(b.bookingId) : undefined,
});

async function siblingSitting(w, group = "TASK5-REFUND-SIBLING") {
  const { createSittingQuote } = await import("../lib/sitting-governance.ts");
  const start = "2026-10-07T03:30:00Z", scheduledEnd = end(start, 1);
  const quote = await createSittingQuote(w.db, { packageCode: "sitting-visit-60", petCount: 3, cityId: "blr", zoneId: "blr-east", scheduledStart: start, scheduledEnd, paymentMode: "prepaid" });
  const reserved = await reserve(w, group, w.pets, "pet_sitting", start, 1);
  assert.equal(reserved.response.body.data?.status, "assigned", JSON.stringify(reserved.response));
  return book(w, { quote, payload: { idempotencyKey: group, scheduleGroupId: group,
    customer: { id: CUSTOMER, name: "Synthetic Task5 customer", primaryPhone: "+919000000661" }, pets: w.pets,
    cityId: "blr", zoneId: "blr-east", serviceCode: "pet_sitting", packageCode: quote.packageCode, packageName: quote.packageName,
    scheduledStart: start, scheduledEnd, provider: reserved.response.body.data.provider, totalAmount: quote.totalAmount, amountDueNow: quote.amountDueNow,
    payment: { method: "upi", mode: "prepaid", status: "created", detail: "Task5 sibling sandbox" }, pricing: { discount: 0, sittingQuoteId: quote.quoteId } } });
}

const cancel = (w, b, cookie = w.cookie) => call("/api/grooming-booking-change", "POST", { bookingId: b.bookingId, customerId: CUSTOMER, action: "cancel", reason: "Synthetic cancellation before service" }, cookie);
const refundEvent = (b, refundAmount, eventId, gatewayRefundId, extra = {}) => call("/api/grooming-payment-sandbox", "POST", {
  action: "simulate_event", bookingId: b.bookingId, eventType: "refund.processed", eventId, gatewayRefundId,
  gatewayPaymentId: `pay_task5_${b.payload.scheduleGroupId}`, amount: refundAmount, currency: "INR", ...extra });
const refundStatus = (w, b, id, status, cookie = "") => financeCall("/api/booking-operations", {
  action: "refund_status", bookingId: b.bookingId, providerId: b.payload.provider.id, refundCaseId: id, refundStatus: status, reason: "Synthetic independent refund review" }, cookie);

test("Task5 refunds: cancellation before capture creates no refund, duplicate and foreign-owner requests preserve sibling", async t => {
  const w = await world(t), b = await book(w, await grooming(w, "TASK5-UNPAID-CANCEL", w.pets.slice(0, 2)));
  const sibling = await siblingSitting(w), before = siblingState(w, sibling);
  const other = await sessionCookie(w.db, "customer", "TASK5-OTHER-CUSTOMER", "task5-other-customer");
  assert.equal((await cancel(w, b, other)).status, 403);
  const first = await cancel(w, b);
  assert.equal(first.status, 200, JSON.stringify(first)); assert.equal(first.body.data.refundAmount, 0);
  assert.equal(first.body.data.refundCaseId, null);
  assert.equal((await cancel(w, b)).status, 409);
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM booking_refund_cases WHERE booking_id=?").get(b.bookingId).n, 0);
  assert.equal(payment(w, b.bookingId).status, "cancelled"); assert.deepEqual(siblingState(w, sibling), before);
});

for (const partial of [false, true]) {
  test(`Task5 refunds: ${partial ? "explicit partial-case fixture" : "full cancellation"} callback retries reconcile once and preserve sibling`, async t => {
    const w = await world(t), b = await book(w, await grooming(w, `TASK5-REFUND-${partial}`, w.pets.slice(0, 2)));
    assert.equal((await capture(w, b)).body.data.result.status, "processed");
    const sibling = await siblingSitting(w), siblingBefore = siblingState(w, sibling);
    if (partial) {
      t.mock.timers.setTime(Date.parse(START) - 12 * 3600000);
      // The multi-day clock advance expires the original customer session.
      w.cookie = await sessionCookie(w.db, "customer", CUSTOMER, "task5-customer-partial");
    }
    const cancelled = await cancel(w, b), amount = partial ? 1649 : 3298;
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled)); assert.equal(cancelled.body.data.refundAmount, 3298);
    const id = cancelled.body.data.refundCaseId;
    // Current cancellation contract is full paid-value refund before service, even at 12h.
    // A partial case is an explicit synthetic finance fixture, not a cancellation policy claim.
    if (partial) w.sqlite.prepare("UPDATE booking_refund_cases SET amount=? WHERE id=? AND status='requested'").run(amount, id);
    assert.equal((await cancel(w, b)).status, 409);
    assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM booking_refund_cases WHERE booking_id=?").get(b.bookingId).n, 1);
    assert.equal((await refundStatus(w, b, id, "approved", w.cookie)).status, 403);
    assert.equal((await refundStatus(w, sibling, id, "approved")).status, 404);
    assert.equal((await refundStatus(w, b, id, "completed")).status, 409, "completion cannot skip approval/evidence");
    assert.equal((await refundStatus(w, b, id, "approved")).status, 200);
    const gatewayRefundId = `rfnd_task5_${partial}`, eventId = `evt_refund_task5_${partial}`;
    const wrongAmount = await refundEvent(b, amount + 1, `${eventId}_bad`, gatewayRefundId);
    assert.equal(wrongAmount.body.data.result.reason, "refund_amount_mismatch");
    assert.equal(w.sqlite.prepare("SELECT status FROM booking_refund_cases WHERE id=?").get(id).status, "approved");
    const done = await refundEvent(b, amount, eventId, gatewayRefundId);
    assert.equal(done.body.data.result.status, "processed", JSON.stringify(done));
    assert.equal((await refundEvent(b, amount, eventId, gatewayRefundId)).body.data.result.status, "processed");
    assert.equal((await refundEvent(b, amount, `${eventId}_fresh_retry`, gatewayRefundId)).body.data.result.reason, "refund_already_processed");
    const record = w.sqlite.prepare("SELECT captured_amount,refunded_amount,reconciliation_status FROM payment_reconciliation_records WHERE booking_id=?").get(b.bookingId);
    assert.equal(record.captured_amount, 3298); assert.equal(record.refunded_amount, amount); assert.equal(record.reconciliation_status, "matched");
    assert.equal(payment(w, b.bookingId).status, partial ? "partially_refunded" : "refunded");
    assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM collection_ledger_postings WHERE group_key=?").get(`COLL-refund_completed-${gatewayRefundId}`).n, 1);
    assert.equal((await refundStatus(w, b, id, "completed")).status, 200);
    assert.equal((await refundStatus(w, b, id, "completed")).status, 409);
    assert.deepEqual(siblingState(w, sibling), siblingBefore);
  });
}

test("Task5 refunds: governed 50% post-completion request creates its own approved case and reconciles once", async t => {
  const w = await world(t), b = await book(w, await grooming(w, "TASK5-GOVERNED-PARTIAL", w.pets.slice(0, 2)));
  await capture(w, b);
  const sibling = await siblingSitting(w), siblingBefore = siblingState(w, sibling);
  // Explicit legacy-completed fixture: no completion tax record. The route requires a manual note.
  // This test proves request -> approval -> callback, not service completion or credit-note creation.
  w.sqlite.prepare("UPDATE canonical_bookings SET status='completed' WHERE id=?").run(b.bookingId);
  w.sqlite.prepare("UPDATE provider_work_orders SET status='completed' WHERE booking_id=?").run(b.bookingId);
  const input = { action: "request", bookingId: b.bookingId, percent: 50, reason: "Synthetic service quality escalation", manualNote: "Synthetic legacy completion evidence reviewed", idempotencyKey: "TASK5-PARTIAL-REQUEST" };
  assert.equal((await call("/api/escalation-refunds", "POST", input, w.cookie)).status, 403);
  const requested = await call("/api/escalation-refunds", "POST", input);
  assert.equal(requested.status, 201, JSON.stringify(requested));
  const requestId = requested.body.data.request.id;
  assert.ok(requestId, JSON.stringify(requested));
  assert.equal((await call("/api/escalation-refunds", "POST", input)).status, 200);
  assert.equal((await call("/api/escalation-refunds", "POST", { ...input, bookingId: sibling.bookingId })).status, 409, "request key cannot cross bookings");
  assert.equal((await call("/api/escalation-refunds", "POST", { ...input, percent: 101, idempotencyKey: "TASK5-PERCENT-INVALID" })).status, 400);
  assert.equal((await call("/api/escalation-refunds", "POST", { action: "approve", requestId }, w.cookie)).status, 403);
  assert.equal((await call("/api/escalation-refunds", "POST", { action: "approve", requestId })).status, 409);
  w.sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('TASK5-PARTIAL-CHECKER','task5-partial-checker@pawspace.test','Synthetic checker','finance','active',?,?)").run(Date.now(), Date.now());
  const route = await import("../app/api/escalation-refunds/route.ts");
  const response = await route.POST(new Request("https://uat.pawspace.in/api/escalation-refunds", { method: "POST", headers: { "content-type": "application/json", "oai-authenticated-user-email": "task5-partial-checker@pawspace.test" }, body: JSON.stringify({ action: "approve", requestId, reason: "Independent synthetic finance approval" }) }));
  const approved = await response.json();
  assert.equal(response.status, 200, JSON.stringify(approved));
  const id = approved.data.refundCaseId;
  const refund = w.sqlite.prepare("SELECT amount,status,purpose FROM booking_refund_cases WHERE id=?").get(id);
  assert.equal(refund.amount, 1649); assert.equal(refund.status, "approved");
  assert.equal(refund.purpose, "post_completion_escalation");
  // No provider credentials exist: approval records authority but cannot initiate money movement.
  assert.equal((await refundEvent(b, 1650, "evt_governed_partial_bad", "rfnd_governed_partial")).body.data.result.reason, "refund_amount_mismatch");
  assert.equal(w.sqlite.prepare("SELECT status FROM booking_refund_cases WHERE id=?").get(id).status, "approved");
  const done = await refundEvent(b, 1649, "evt_governed_partial", "rfnd_governed_partial");
  assert.equal(done.body.data.result.status, "processed", JSON.stringify(done));
  assert.equal((await refundEvent(b, 1649, "evt_governed_partial_retry", "rfnd_governed_partial")).body.data.result.reason, "refund_already_processed");
  assert.equal(payment(w, b.bookingId).status, "partially_refunded");
  const totals = w.sqlite.prepare("SELECT captured_amount,refunded_amount,reconciliation_status FROM payment_reconciliation_records WHERE booking_id=?").get(b.bookingId);
  assert.equal(totals.captured_amount, 3298); assert.equal(totals.refunded_amount, 1649); assert.equal(totals.reconciliation_status, "matched");
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM collection_ledger_postings WHERE group_key='COLL-refund_completed-rfnd_governed_partial'").get().n, 1);
  assert.deepEqual(siblingState(w, sibling), siblingBefore);
});

test("Task5 refunds: Sitting full collected refund follows customer request, Finance approval and canonical reversal", async t => {
  const w = await world(t), b = await siblingSitting(w, "TASK5-SITTING-FULL");
  await capture(w, b);
  const selected={};
  const action = async (name, extra = {}, cookie = "") => {
    const field={approve_cancel:'cancellationRequestId',record_refund:'refundId'}[name];
    const result=await financeCall("/api/sitting-finance",{bookingId:b.bookingId,action:name,idempotencyKey:`task5-sitting-${name}`,reason:"Synthetic customer requested cancellation",...(field?{[field]:selected[field]}:{}),...extra},cookie);
    if(result.status===200&&name==='request_cancel')selected.cancellationRequestId=result.body.data.requestId;
    if(result.status===200&&name==='approve_cancel')selected.refundId=result.body.data.refundId;
    return result;
  };
  assert.equal((await action("request_cancel", {}, w.cookie)).status, 200);
  assert.equal((await action("approve_cancel", { approvedRefundAmount: b.quote.totalAmount }, w.cookie)).status, 403);
  assert.equal((await action("approve_cancel", { approvedRefundAmount: b.quote.totalAmount + 1 })).status, 409);
  const approved = await action("approve_cancel", { approvedRefundAmount: b.quote.totalAmount });
  assert.equal(approved.status, 200, JSON.stringify(approved));
  assert.equal((await action("record_refund", { refundReference: "rfnd_task5_sitting_full" }, w.cookie)).status, 403);
  const done = await action("record_refund", { refundReference: "rfnd_task5_sitting_full" });
  assert.equal(done.status, 200, JSON.stringify(done));
  assert.equal(payment(w, b.bookingId).status, "refunded");
  assert.equal(w.sqlite.prepare("SELECT refunded_amount FROM payment_reconciliation_records WHERE booking_id=?").get(b.bookingId).refunded_amount, b.quote.totalAmount);
  assert.equal((await action("record_refund", { refundReference: "rfnd_task5_sitting_full" })).status, 200);
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM collection_ledger_postings WHERE group_key='COLL-refund_completed-rfnd_task5_sitting_full'").get().n, 1);
});

test("Task5 refunds: Boarding explicit partial request/approval posts only the approved captured amount", async t => {
  const w = await world(t);
  const { seedBoardingStay } = await import("./helpers/stay-harness.mjs");
  const fixture = await seedBoardingStay(w.db, w.sqlite, { bookingId: "TASK5-BOARDING-PARTIAL", customerId: CUSTOMER, amount: 699, paymentStatus: "created" });
  const b = { bookingId: fixture.bookingId, quote: { totalAmount: 699 }, payload: { scheduleGroupId: fixture.groupId } };
  await capture(w, b);
  const action = (name, extra = {}, cookie = "") => financeCall("/api/boarding-finance", { bookingId: b.bookingId, action: name, idempotencyKey: `task5-boarding-${name}`, reason: "Synthetic partial refund review", ...extra }, cookie);
  assert.equal((await action("request_cancel", {}, w.cookie)).status, 202);
  assert.equal((await action("approve_cancel", { approvedRefundAmount: 300 }, w.cookie)).status, 403);
  assert.equal((await action("approve_cancel", { approvedRefundAmount: 700 })).status, 409);
  const approved = await action("approve_cancel", { approvedRefundAmount: 300 });
  assert.equal(approved.status, 200, JSON.stringify(approved));
  assert.equal(w.sqlite.prepare("SELECT amount,status FROM booking_refund_cases WHERE id=?").get(approved.body.data.refundId).amount, 300);
  assert.equal((await action("record_refund", { refundReference: "rfnd_task5_boarding_partial" }, w.cookie)).status, 403);
  const done = await action("record_refund", { refundReference: "rfnd_task5_boarding_partial" });
  assert.equal(done.status, 200, JSON.stringify(done));
  assert.equal(payment(w, b.bookingId).status, "partially_refunded");
  assert.equal(w.sqlite.prepare("SELECT refunded_amount FROM payment_reconciliation_records WHERE booking_id=?").get(b.bookingId).refunded_amount, 300);
  assert.equal((await action("record_refund", { refundReference: "rfnd_task5_boarding_partial" })).status, 200);
  assert.equal(w.sqlite.prepare("SELECT refunded_amount FROM payment_reconciliation_records WHERE booking_id=?").get(b.bookingId).refunded_amount, 300);
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM collection_ledger_postings WHERE group_key='COLL-refund_completed-rfnd_task5_boarding_partial'").get().n, 1);
});

test("Task5 refunds: Training with zero delivered sessions refunds all collected funds through its governed API", async t => {
  const w = await world(t);
  const { seedCanonicalStayBooking } = await import("./helpers/stay-harness.mjs");
  const fixture = seedCanonicalStayBooking(w.sqlite, { bookingId: "TASK5-TRAINING-FULL", customerId: CUSTOMER, serviceCode: "dog_training", amount: 2000, amountDueNow: 2000, paymentStatus: "created" });
  const b = { bookingId: fixture.bookingId, quote: { totalAmount: 2000 }, payload: { scheduleGroupId: fixture.groupId } };
  await capture(w, b);
  const { ensureTrainingProgrammeTables } = await import("../lib/training-programme.ts");
  await ensureTrainingProgrammeTables(w.db);
  const now = Date.now(), programmeId = "TASK5-TRAINING-PROGRAMME";
  w.sqlite.prepare("INSERT INTO training_programmes (id,booking_id,customer_id,provider_id,city_id,zone_id,plan_code,plan_name,pet_ids_json,status,total_sessions,completed_sessions,created_at,updated_at) VALUES (?,?,?,?,?,'blr-east','synthetic-two','Synthetic two sessions','[]','scheduled',2,0,?,?)").run(programmeId, b.bookingId, CUSTOMER, fixture.providerId, "blr", now, now);
  for (let i = 1; i <= 2; i++) {
    const reservationId = `${fixture.reservationId}-${i}`;
    w.sqlite.prepare("INSERT INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,status,created_at) VALUES (?,?,?,'dog_training','blr','blr-east',?,'[]',?,?,'confirmed',?)").run(reservationId, fixture.groupId, fixture.providerId, CUSTOMER, START, end(START, 1), now);
    w.sqlite.prepare("INSERT INTO training_sessions (id,programme_id,booking_id,schedule_reservation_id,sequence_no,provider_id,scheduled_start,scheduled_end,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,'locked',?,?)").run(`TASK5-TSESSION-${i}`, programmeId, b.bookingId, reservationId, i, fixture.providerId, START, end(START, 1), now, now);
  }
  const action = (name, extra = {}, cookie = "") => financeCall("/api/training-cancellation", { action: name, reason: "Synthetic full unused programme refund", ...extra }, cookie);
  const policy = await action("configure_policy", { cityId: "blr", feeType: "none", feeValue: 0, noShowTreatment: "refundable", effectiveFrom: "2026-01-01" });
  assert.equal(policy.status, 200, JSON.stringify(policy));
  const requested = await action("request", { bookingId: b.bookingId, idempotencyKey: "task5-training-full" }, w.cookie);
  assert.equal(requested.status, 200, JSON.stringify(requested));
  const caseId = requested.body.data.caseId;
  assert.equal((await action("approve", { caseId }, w.cookie)).status, 403);
  const approved = await action("approve", { caseId });
  assert.equal(approved.status, 200, JSON.stringify(approved)); assert.equal(approved.body.data.approvedRefund, 2000);
  assert.equal((await action("refund_status", { caseId, nextStatus: "processing_sandbox" }, w.cookie)).status, 403);
  assert.equal((await action("refund_status", { caseId, nextStatus: "processing_sandbox" })).status, 200);
  const done = await action("refund_status", { caseId, nextStatus: "completed_sandbox", providerReference: "rfnd_task5_training_full" });
  assert.equal(done.status, 200, JSON.stringify(done));
  assert.equal(payment(w, b.bookingId).status, "refunded");
  assert.equal(w.sqlite.prepare("SELECT refunded_amount FROM payment_reconciliation_records WHERE booking_id=?").get(b.bookingId).refunded_amount, 2000);
  const replay = await action("refund_status", { caseId, nextStatus: "completed_sandbox", providerReference: "rfnd_task5_training_full" });
  assert.equal(replay.status, 409, JSON.stringify(replay));
  assert.match(replay.body.error, /cannot move from completed_sandbox to completed_sandbox/);
  assert.equal(w.sqlite.prepare("SELECT refunded_amount FROM payment_reconciliation_records WHERE booking_id=?").get(b.bookingId).refunded_amount, 2000);
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM collection_ledger_postings WHERE group_key='COLL-refund_completed-rfnd_task5_training_full'").get().n, 1);
});

test("Task5 refunds: Walking Finance can return all collected walk charges while preserving completed evidence", async t => {
  const w = await world(t);
  const { seedWalkingBooking } = await import("./helpers/stay-harness.mjs");
  const fixture = await seedWalkingBooking(w.db, w.sqlite, { bookingId: "TASK5-WALKING-FULL", customerId: CUSTOMER, amount: 349, walkCount: 2 });
  const { ensureWalkingFinanceTables } = await import("../lib/walking-finance-governance.ts");
  await ensureWalkingFinanceTables(w.db);
  const sessionId = fixture.sessions[0].sessionId;
  // Explicit delivered-session fixture; completion enforcement is covered separately, not bypassed by an API call.
  w.sqlite.prepare("UPDATE walking_sessions SET status='completed' WHERE id=?").run(sessionId);
  w.sqlite.prepare("INSERT INTO walking_session_payment_events (id,booking_id,session_id,amount,status,reference,created_at,updated_at) VALUES ('TASK5-WALK-DUE',?,?,349,'due',NULL,?,?)").run(fixture.bookingId, sessionId, Date.now(), Date.now());
  const action = (name, extra = {}, cookie = "") => financeCall("/api/walking-finance", { bookingId: fixture.bookingId, action: name, idempotencyKey: `task5-walking-${name}`, reason: "Synthetic full collected-value review", ...extra }, cookie);
  assert.equal((await action("record_session_payment", { sessionId, paymentReference: "TASK5-WALK-PAID" })).status, 200);
  assert.equal((await action("request_cancel", {}, w.cookie)).status, 200);
  assert.equal((await action("approve_cancel", { approvedRefundAmount: 349 }, w.cookie)).status, 403);
  assert.equal((await action("approve_cancel", { approvedRefundAmount: 350 })).status, 409);
  const approved = await action("approve_cancel", { approvedRefundAmount: 349 });
  assert.equal(approved.status, 200, JSON.stringify(approved));
  assert.equal((await action("record_refund", { refundReference: "TASK5-WALK-FULL-REFUND" }, w.cookie)).status, 403);
  const done = await action("record_refund", { refundReference: "TASK5-WALK-FULL-REFUND" });
  assert.equal(done.status, 200, JSON.stringify(done));
  const totals = await action("reconcile");
  assert.equal(totals.status, 200, JSON.stringify(totals)); assert.equal(totals.body.data.refundTotal, 349); assert.equal(totals.body.data.netPaidTotal, 0);
  assert.equal(w.sqlite.prepare("SELECT status FROM walking_sessions WHERE id=?").get(sessionId).status, "completed");
  assert.equal((await action("record_refund", { refundReference: "TASK5-WALK-FULL-REFUND" })).status, 200);
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM walking_refund_ledger WHERE booking_id=?").get(fixture.bookingId).n, 1);
});

test("Task5 refunds: authenticated maker cannot self-approve; independent staff can approve once", async t => {
  const w = await world(t), b = await book(w, await grooming(w, "TASK5-MAKER-CHECKER", w.pets.slice(0, 2)));
  await capture(w, b);
  const requested = await call("/api/booking-operations", "POST", { bookingId: b.bookingId, providerId: b.payload.provider.id, action: "refund_requested", reason: "Synthetic staff review refund request" });
  assert.equal(requested.status, 201, JSON.stringify(requested)); const id = requested.body.data.refundCaseId;
  const self = await call("/api/booking-operations", "POST", { action: "refund_status", bookingId: b.bookingId, providerId: b.payload.provider.id, refundCaseId: id, refundStatus: "approved", reason: "Synthetic maker attempted self approval" });
  assert.equal(self.status, 409); assert.equal(self.body.code, "refund_self_approval_forbidden");
  w.sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('TASK5-CHECKER','task5-checker@pawspace.test','Synthetic checker','finance','active',?,?)").run(Date.now(), Date.now());
  const route = await import("../app/api/booking-operations/route.ts");
  const response = await route.POST(new Request("https://uat.pawspace.in/api/booking-operations", { method: "POST", headers: { "content-type": "application/json", "oai-authenticated-user-email": "task5-checker@pawspace.test" }, body: JSON.stringify({ action: "refund_status", bookingId: b.bookingId, providerId: b.payload.provider.id, refundCaseId: id, refundStatus: "approved", reason: "Independent synthetic checker reviewed refund" }) }));
  assert.equal(response.status, 200, await response.text());
  assert.equal(w.sqlite.prepare("SELECT approved_by FROM booking_refund_cases WHERE id=?").get(id).approved_by, "task5-checker@pawspace.test");
  assert.equal((await refundStatus(w, b, id, "approved")).status, 409, "an approved case cannot be approved again");
});

test("Task5 refunds: independent committed callback before the competing batch cannot double-count one refund", async t => {
  const w = await world(t), b = await book(w, await grooming(w, "TASK5-REFUND-RACE", w.pets.slice(0, 2)));
  await capture(w, b); const cancelled = await cancel(w, b); const id = cancelled.body.data.refundCaseId;
  assert.equal((await refundStatus(w, b, id, "approved")).status, 200);
  const directory = mkdtempSync(join(tmpdir(), "pawspace-task5-refund-")), file = join(directory, "fixture.sqlite");
  w.sqlite.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
  const first = new DatabaseSync(file), second = new DatabaseSync(file), db1 = d1(first), db2 = d1(second);
  t.after(() => { first.close(); second.close(); rmSync(directory, { recursive: true, force: true }); });
  const { processGatewayEvent } = await import("../lib/grooming-payment-reconciliation.ts");
  const event = { provider: "razorpay", environment: "sandbox", eventId: "task5-race-first", eventType: "refund.processed",
    bookingId: b.bookingId, gatewayOrderId: `order_task5_${b.payload.scheduleGroupId}`, gatewayPaymentId: `pay_task5_${b.payload.scheduleGroupId}`,
    gatewayRefundId: "rfnd_task5_race", amountSubunits: 329800, currency: "INR", signatureVerified: true, payloadHash: "task5-race-first", createdAt: Date.now() };
  let injected = false;
  const batch = db1.batch;
  db1.batch = async items => {
    if (!injected && items.some(item => item.sql.includes("UPDATE booking_refund_cases SET status=CASE"))) {
      injected = true;
      const committed = await processGatewayEvent(db2, { ...event, eventId: "task5-race-second", payloadHash: "task5-race-second" });
      assert.equal(committed.status, "processed");
      assert.equal(first.prepare("SELECT status FROM booking_refund_cases WHERE id=?").get(id).status, "processed", "other connection committed before first batch");
    }
    return batch(items);
  };
  assert.equal((await processGatewayEvent(db1, event)).status, "processed"); assert.equal(injected, true);
  assert.equal(first.prepare("SELECT refunded_amount FROM payment_reconciliation_records WHERE booking_id=?").get(b.bookingId).refunded_amount, 3298);
  assert.equal(first.prepare("SELECT COUNT(*) n FROM collection_ledger_postings WHERE group_key='COLL-refund_completed-rfnd_task5_race'").get().n, 1);
});

for (const count of [2, 3]) {
  test(`Task5: ${count}-pet Training split quote/capture binds amount and retry identity`, async t => {
    const w = await world(t);
    const { createTrainingQuote, captureTrainingQuoteSandbox } = await import("../lib/training-commercial-governance.ts");
    const quote = await createTrainingQuote(w.db, { packageCode: "training-2-starter", petCount: count, scheduledStart: START, paymentMode: "split" });
    const expected = count === 2 ? 5600 : 7700; // published 3500 plan + 60% for each extra pet
    assert.equal(quote.totalAmount, expected); assert.equal(quote.amountDueNow, expected / 2);
    assert.equal(quote.minutesPerSession, count * (45 + 15));
    const input = { quoteId: quote.quoteId, amount: expected / 2, paymentKey: `TASK5-TRAIN-${count}` };
    const first = await captureTrainingQuoteSandbox(w.db, input);
    assert.equal(first.status, "PARTIALLY_PAID"); assert.equal(first.remainingAmount, expected / 2);
    const retry = await captureTrainingQuoteSandbox(w.db, input);
    assert.equal(retry.reference, first.reference); assert.equal(retry.duplicatePrevented, true);
    await assert.rejects(() => captureTrainingQuoteSandbox(w.db, { ...input, paymentKey: "wrong-owner-key" }), e => e instanceof Response && e.status === 403);
    assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM training_quote_payment_attestations WHERE quote_id=?").get(quote.quoteId).n, 1);
  });

  test(`Task5: ${count}-pet Sitting visit prices and capture retries remain quote-bound`, async t => {
    const w = await world(t);
    const { createSittingQuote } = await import("../lib/sitting-governance.ts");
    const { captureSittingQuoteSandbox } = await import("../lib/sitting-payment-governance.ts");
    const quote = await createSittingQuote(w.db, { packageCode: "sitting-visit-60", petCount: count, scheduledStart: START, scheduledEnd: end(START, 1), paymentMode: "prepaid" });
    const expected = count === 2 ? 548 : 697; // published 399 visit + 149 per extra pet
    assert.equal(quote.totalAmount, expected);
    const input = { quoteId: quote.quoteId, amount: expected, paymentKey: `TASK5-SIT-${count}` };
    await assert.rejects(() => captureSittingQuoteSandbox(w.db, { ...input, amount: 1 }), e => e instanceof Response && e.status === 409);
    const first = await captureSittingQuoteSandbox(w.db, input), retry = await captureSittingQuoteSandbox(w.db, input);
    assert.equal(first.environment, "sandbox"); assert.equal(retry.reference, first.reference); assert.equal(retry.duplicatePrevented, true);
    await assert.rejects(() => captureSittingQuoteSandbox(w.db, { ...input, paymentKey: "wrong-owner-key" }), e => e instanceof Response && e.status === 403);
    assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM sitting_quote_payment_attestations WHERE quote_id=?").get(quote.quoteId).n, 1);
  });

  test(`Task5: ${count}-pet two-night Boarding charges every pet and stay unit`, async t => {
    const w = await world(t);
    const { createBoardingQuote } = await import("../lib/boarding-governance.ts");
    const quote = await createBoardingQuote(w.db, { packageCode: "boarding-24h", petCount: count, scheduledStart: START, scheduledEnd: end(START, 48), paymentMode: "prepaid" });
    assert.equal(quote.stayUnits, 2); assert.equal(quote.totalAmount, 699 * count * 2);
    assert.equal(quote.amountDueNow, quote.totalAmount);
    await assert.rejects(() => createBoardingQuote(w.db, { packageCode: "boarding-24h", petCount: count, scheduledStart: START, scheduledEnd: end(START, 48), paymentMode: "split_50_50" }), e => e instanceof Response && e.status === 409);
    const longStay = await createBoardingQuote(w.db, { packageCode: "boarding-24h", petCount: count, scheduledStart: START, scheduledEnd: end(START, 120), paymentMode: "split_50_50" });
    assert.equal(longStay.stayUnits, 5); assert.equal(longStay.totalAmount, 699 * count * 5);
    assert.equal(longStay.amountDueNow, longStay.totalAmount / 2);
  });
}

for (const [count, total] of [[2, 3298], [3, 4947]]) {
  test(`Task5: ${count}-pet Grooming prices and order associations are canonical`, async t => {
    const w = await world(t), prepared = await grooming(w, `TASK5-GROOM-${count}`, w.pets.slice(0, count));
    assert.equal(prepared.quote.totalAmount, total);
    const b = await book(w, prepared);
    const row = w.sqlite.prepare("SELECT pet_ids_json,source_pet_ids_json,total_amount FROM canonical_bookings WHERE id=?").get(b.bookingId);
    assert.equal(JSON.parse(row.pet_ids_json).length, count);
    assert.deepEqual(JSON.parse(row.source_pet_ids_json), prepared.payload.pets.map(p => p.sourceId));
    assert.equal(row.total_amount, total);
    assert.equal(payment(w, b.bookingId).amount, total);
    assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM provider_work_orders WHERE booking_id=?").get(b.bookingId).n, 1);
  });
}

test("Task5: mixed dog/cat Grooming resolves equivalent packages per pet", async t => {
  const w = await world(t, ["dog", "cat"]), p = await grooming(w, "TASK5-MIXED", w.pets, START, "dog-basic");
  assert.equal(p.quote.totalAmount, 3298); // dog basic 1649 + cat basic 1649 multi-pet rates
  const b = await book(w, p);
  assert.equal(payment(w, b.bookingId).amount, 3298);
});

test("Task5: concurrent duplicate submissions persist one booking/payment/work bundle", async t => {
  const w = await world(t), p = await grooming(w, "TASK5-DUP", w.pets.slice(0, 2));
  const replies = await Promise.all([1, 2].map(() => call("/api/canonical-bookings", "POST", p.payload, w.cookie)));
  const winner = replies.find(r => r.status === 201);
  assert.ok(winner, JSON.stringify(replies));
  for (const r of replies) assert.ok([200, 201, 409].includes(r.status), JSON.stringify(r));
  const replay = await call("/api/canonical-bookings", "POST", p.payload, w.cookie);
  assert.equal(replay.status, 200); assert.equal(replay.body.data.bookingId, winner.body.data.bookingId);
  for (const table of ["canonical_bookings", "booking_payments", "provider_work_orders"])
    assert.equal(w.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 1, table);
});

test("Task5: concurrent overlapping fresh groups cannot double-book one groomer", async t => {
  const w = await world(t);
  w.sqlite.prepare("UPDATE provider_capacity_profiles SET live=0 WHERE services_json LIKE '%grooming%' AND id!='groom_arun'").run();
  const replies = await Promise.all(["A", "B"].map(group => reserve(w, `TASK5-RACE-${group}`, w.pets.slice(0, 2))));
  assert.equal(replies.filter(r => r.response.body.data?.status === "assigned").length, 1, JSON.stringify(replies.map(r => r.response)));
  assert.equal(w.sqlite.prepare("SELECT COUNT(DISTINCT group_id) n FROM scheduling_reservations WHERE provider_id='groom_arun' AND status IN ('assigned','confirmed')").get().n, 1);
});

test("Task5: wrong-amount capture stays unpaid; correct capture and retry stay on the same order", async t => {
  const w = await world(t), b = await book(w, await grooming(w, "TASK5-PAY", w.pets));
  const bad = await capture(w, b, 1, "bad");
  assert.equal(bad.status, 201); assert.equal(bad.body.data.result.reason, "capture_amount_mismatch");
  assert.equal(payment(w, b.bookingId).status, "created");
  const good = await capture(w, b);
  assert.equal(good.status, 201); assert.equal(good.body.data.result.status, "processed");
  const replay = await capture(w, b);
  assert.equal(replay.body.data.result.duplicate, true);
  assert.equal(payment(w, b.bookingId).status, "captured");
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM booking_payments WHERE booking_id=?").get(b.bookingId).n, 1);
});

test("Task5: same account cross-service orders survive Grooming reschedule and cancellation independently", async t => {
  const w = await world(t), g = await book(w, await grooming(w, "TASK5-CROSS-GROOM", w.pets.slice(0, 2)));
  const paid = await capture(w, g);
  assert.equal(paid.body.data.result.status, "processed");
  const { createSittingQuote } = await import("../lib/sitting-governance.ts");
  const start = "2026-10-06T03:30:00Z", scheduledEnd = end(start, 1);
  const quote = await createSittingQuote(w.db, { packageCode: "sitting-visit-60", petCount: 3, cityId: "blr", zoneId: "blr-east", scheduledStart: start, scheduledEnd, paymentMode: "prepaid" });
  assert.equal(quote.totalAmount, quote.basePricePerPet + 2 * quote.extraPetPrice);
  const reserved = await reserve(w, "TASK5-CROSS-SIT", w.pets, "pet_sitting", start, 1);
  assert.equal(reserved.response.body.data?.status, "assigned", JSON.stringify(reserved.response));
  const s = await book(w, { quote, payload: { ...g.payload, idempotencyKey: "TASK5-CROSS-SIT", scheduleGroupId: "TASK5-CROSS-SIT", pets: w.pets,
    serviceCode: "pet_sitting", packageCode: quote.packageCode, packageName: quote.packageName, scheduledStart: start, scheduledEnd,
    provider: reserved.response.body.data.provider, totalAmount: quote.totalAmount, amountDueNow: quote.amountDueNow, pricing: { discount: 0, sittingQuoteId: quote.quoteId } } });
  assert.notEqual(g.bookingId, s.bookingId);
  const sittingBefore = w.sqlite.prepare("SELECT * FROM canonical_bookings WHERE id=?").get(s.bookingId);
  const sittingPaymentBefore = payment(w, s.bookingId);
  const groomPets = JSON.parse(w.sqlite.prepare("SELECT pet_ids_json FROM canonical_bookings WHERE id=?").get(g.bookingId).pet_ids_json);
  const sitterPets = JSON.parse(sittingBefore.pet_ids_json);
  assert.ok(groomPets.every(id => sitterPets.includes(id)), "same saved pets retain canonical identity across services");
  const movedStart = "2026-10-05T03:30:00Z";
  const moved = await call("/api/grooming-booking-change", "POST", { bookingId: g.bookingId, customerId: CUSTOMER, action: "reschedule", reason: "Synthetic customer schedule change", scheduledStart: movedStart, scheduledEnd: end(movedStart, 4) }, w.cookie);
  assert.equal(moved.status, 200, JSON.stringify(moved));
  assert.equal(w.sqlite.prepare("SELECT scheduled_start FROM canonical_bookings WHERE id=?").get(g.bookingId).scheduled_start, new Date(movedStart).toISOString());
  assert.ok(w.sqlite.prepare("SELECT scheduled_start,scheduled_end FROM scheduling_reservations WHERE group_id=? AND status!='cancelled'").all(g.payload.scheduleGroupId).every(r => Date.parse(r.scheduled_start) === Date.parse(movedStart) && Date.parse(r.scheduled_end) - Date.parse(r.scheduled_start) === 4 * 3600000));
  const cancelled = await call("/api/grooming-booking-change", "POST", { bookingId: g.bookingId, customerId: CUSTOMER, action: "cancel", reason: "Cancel this order only" }, w.cookie);
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled));
  assert.equal(w.sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(g.bookingId).status, "cancelled");
  assert.deepEqual(w.sqlite.prepare("SELECT * FROM canonical_bookings WHERE id=?").get(s.bookingId), sittingBefore);
  assert.deepEqual(payment(w, s.bookingId), sittingPaymentBefore);
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM canonical_pets WHERE customer_id=?").get(CUSTOMER).n, 3);
});
