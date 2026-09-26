/*
 * Owner decision M4: a customer who moves a Grooming booking to a dearer slot approves and PAYS THE
 * DIFFERENCE, and only then does the booking move. Same or cheaper keeps the price (covered by
 * tests/grooming-reschedule-reprice-reassign.test.mjs).
 *
 * The booking below is booked at a weekday -8% price (Rs 1,899) and moved to a +15% slot the next day
 * (Rs 2,374), so the difference is Rs 475. Every test runs the real routes and libraries on in-memory
 * node:sqlite through the grooming journey harness: the real change route (quote, pay, status, cancel),
 * the real /api/razorpay-webhook with HMAC signatures computed here, the real customer confirm, the real
 * provider-API probe and refund sweep, and the real provider lifecycle through completion finance.
 * Razorpay's API is answered by a local stub; any other outbound call fails the test.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { setupJourney, runCompletedJourney, routeCall, sessionCookie } from "./helpers/grooming-journey-harness.mjs";
import { fixtureChecklist } from "./helpers/partner-checklist-fixture.mjs";

const IST_MS = 330 * 60_000;
const istDay = iso => new Date(Date.parse(iso) + IST_MS).getUTCDay();
const istDate = iso => new Date(Date.parse(iso) + IST_MS).toISOString().slice(0, 10);
const CHANGE_ROUTE = "../../app/api/grooming-booking-change/route.ts";
const WEBHOOK_SECRET = "reschedule_webhook_secret";
const KEY_ID = "rzp_test_Reschedule01";
const KEY_SECRET = "reschedule_key_secret";

/** Pricing Control for dog-basic: the base price plus percent rules keyed on IST weekdays. */
async function publishPricing(ctx, { basePrice, rules }) {
  const { ensurePricingControlRuntime } = await import("../lib/pricing-control-runtime.ts");
  await ensurePricingControlRuntime(ctx.db);
  ctx.sqlite.prepare("UPDATE service_packages SET active=1,base_price=?,effective_from='2020-01-01',effective_to=NULL WHERE package_code='dog-basic'").run(basePrice);
  const insert = ctx.sqlite.prepare("INSERT INTO dynamic_pricing_rules (id,name,service_code,package_code,city_id,zone_id,rule_type,days_json,start_time,end_time,effective_from,effective_to,adjustment_type,adjustment_value,coupon_policy,priority,status,version,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  for (const rule of rules) insert.run(rule.id, rule.name, "grooming", "dog-basic", "blr", null, rule.type, JSON.stringify([rule.day]), null, null, "2020-01-01", null, "percent", rule.percent, "stackable", 10, "published", 1, "pay-difference-test", Date.now());
}

const reply = body => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
/** Razorpay answered locally: orders, an order's payments (the provider probe) and refunds. */
function razorpayStub(t) {
  const orders = [], refunds = [], orderPayments = new Map(), original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url), method = init.method || "GET";
    if (href === "https://api.razorpay.com/v1/orders" && method === "POST") {
      const body = JSON.parse(String(init.body)), order = { id: `order_RSCH${orders.length + 1}`, amount: body.amount, currency: body.currency, notes: body.notes, status: "created" };
      orders.push(order); return reply(order);
    }
    let match = /^https:\/\/api\.razorpay\.com\/v1\/orders\/([^/]+)\/payments$/.exec(href);
    if (match && method === "GET") return reply({ items: orderPayments.get(decodeURIComponent(match[1])) || [] });
    match = /^https:\/\/api\.razorpay\.com\/v1\/payments\/([^/]+)\/refund$/.exec(href);
    if (match && method === "POST") {
      const body = JSON.parse(String(init.body)), refund = { id: `rfnd_RSCH${refunds.length + 1}`, payment_id: decodeURIComponent(match[1]), amount: body.amount, notes: body.notes };
      refunds.push(refund); return reply(refund);
    }
    throw new Error(`Unexpected network call in a local test: ${method} ${href}`);
  };
  t.after(() => { globalThis.fetch = original; });
  return { orders, refunds, orderPayments };
}

async function journey(t, { id, dearer = true } = {}) {
  const ctx = await setupJourney(); t.after(ctx.close);
  // The sandbox checkout locks and a verified webhook receiver: what paying online requires.
  Object.assign(globalThis.__GROOM_GOLDEN_ENV__, { FORBID_PRODUCTION: "true", RAZORPAY_KEY_ID_SANDBOX: KEY_ID, RAZORPAY_KEY_SECRET_SANDBOX: KEY_SECRET, RAZORPAY_WEBHOOK_SECRET_SANDBOX: WEBHOOK_SECRET });
  const start = new Date(Date.now() + 3 * 86_400_000); start.setUTCHours(3, 30, 0, 0); // 09:00 IST
  const target = new Date(start.getTime() + 86_400_000);                              // 09:00 IST, the next day
  if (dearer) await publishPricing(ctx, { basePrice: 2064, rules: [
    { id: `PD-SAVER-${id}`, name: "Weekday saver", type: "weekday", day: istDay(start.toISOString()), percent: -8 },
    { id: `PD-SURGE-${id}`, name: "Weekend surge", type: "weekend", day: istDay(target.toISOString()), percent: 15 },
  ] });
  const config = { customerId: `CUST-PD-${id}`, customerName: "Mira", phone: "+919900000616", petSourceId: `PET-PD-${id}`, petName: "Milo", cityId: "blr", zoneId: "blr-east", pincode: "560038", latitude: 12.9716, longitude: 77.5946, preferredProviderId: "groom_arun", groupId: `GROOM-PD-${id}`, start: start.toISOString(), stopAfterCapture: true };
  const result = await runCompletedJourney(ctx, config);
  assert.equal(result.booked.status, 201, JSON.stringify(result.booked.body));
  const razorpay = razorpayStub(t);
  const { sqlite, db } = ctx, bookingId = result.bookingId, groupId = config.groupId, cookie = result.customerCookie;
  const one = (sql, ...args) => { const row = sqlite.prepare(sql).get(...args); return row ? { ...row } : row; };
  const all = (sql, ...args) => sqlite.prepare(sql).all(...args).map(row => ({ ...row }));
  const targetStart = target.toISOString(), targetEnd = new Date(target.getTime() + 7_200_000).toISOString();
  const paymentId = one("SELECT id FROM booking_payments WHERE booking_id=?", bookingId).id;
  let attempt = 0;
  const f = {
    ...ctx, result, config, bookingId, groupId, cookie, razorpay, one, all, paymentId,
    start: start.toISOString(), target: targetStart, targetEnd, originalPayment: `pay_${groupId}`,
    call: body => routeCall(CHANGE_ROUTE, "POST", "/api/grooming-booking-change", { bookingId, customerId: config.customerId, ...body }, cookie),
    reschedule: (action = "reschedule") => f.call({ action, reason: "Customer needs another day", scheduledStart: targetStart, scheduledEnd: targetEnd }),
    pay: (offer, overrides = {}) => f.call({ action: "reschedule_pay", requestId: offer.requestId, expectedDifference: offer.priceDifference, expectedConsentRevision: offer.consentRevision, idempotencyKey: `attempt-${id}-${++attempt}`, ...overrides }),
    status: requestId => routeCall(CHANGE_ROUTE, "GET", `/api/grooming-booking-change?requestId=${encodeURIComponent(requestId)}`, null, cookie),
    booking: () => one("SELECT scheduled_start,scheduled_end,status,provider_id,total_amount,pricing_json FROM canonical_bookings WHERE id=?", bookingId),
    work: () => one("SELECT scheduled_start,status,provider_id FROM provider_work_orders WHERE booking_id=?", bookingId),
    payment: () => one("SELECT amount,amount_due_now,status FROM booking_payments WHERE booking_id=?", bookingId),
    recon: () => one("SELECT expected_amount,captured_amount,refunded_amount FROM payment_reconciliation_records WHERE payment_id=?", paymentId),
    request: requestId => one("SELECT * FROM grooming_reschedule_requests WHERE id=?", requestId),
    holds: requestId => all("SELECT provider_id,scheduled_start,status,lease_expires_at,customer_session_id FROM scheduling_reservations WHERE group_id=?", `RSH-${requestId}`),
    reservations: () => all("SELECT provider_id,scheduled_start,status FROM scheduling_reservations WHERE group_id=?", groupId),
    events: type => all("SELECT detail_json FROM booking_lifecycle_events WHERE booking_id=? AND event_type=?", bookingId, type).map(row => JSON.parse(row.detail_json)),
  };
  /** A signed Razorpay notification through the real webhook route. */
  f.webhook = async ({ eventId, orderId, gatewayPaymentId, amount, event = "payment.captured" }) => {
    const payment = { id: gatewayPaymentId, order_id: orderId, amount, currency: "INR", status: "captured", notes: { booking_id: bookingId, payment_id: paymentId } };
    const payload = event === "order.paid" ? { payment: { entity: payment }, order: { entity: { id: orderId, amount_paid: amount, currency: "INR", notes: payment.notes } } } : { payment: { entity: payment } };
    return f.signed(eventId, { event, created_at: Math.floor(Date.now() / 1000), payload });
  };
  f.signed = async (eventId, body) => {
    const { POST } = await import("../app/api/razorpay-webhook/route.ts");
    const raw = JSON.stringify(body), signature = createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex");
    const response = await POST(new Request("https://uat.pawspace.in/api/razorpay-webhook", { method: "POST", headers: { "content-type": "application/json", "x-razorpay-signature": signature, "x-razorpay-event-id": eventId }, body: raw }));
    return { status: response.status, body: await response.json() };
  };
  /** Quote the dearer slot and open its payment. */
  f.quoteAndPay = async () => {
    const quoted = await f.reschedule();
    assert.equal(quoted.status, 409, JSON.stringify(quoted.body));
    assert.equal(quoted.body.code, "reschedule_price_increase");
    const paid = await f.pay(quoted.body);
    assert.equal(paid.status, 201, JSON.stringify(paid.body));
    return { offer: quoted.body, checkout: paid.body.data, requestId: quoted.body.requestId };
  };
  f.capture = (checkout, gatewayPaymentId = `pay_DIFF_${id}`, extra = {}) => f.webhook({ eventId: `evt_${gatewayPaymentId}`, orderId: checkout.orderId, gatewayPaymentId, amount: checkout.amountPaise, ...extra });
  f.refundSweep = async () => (await import("../lib/automatic-booking-refund.ts")).runAutomaticBookingRefundSweep(db, globalThis.__GROOM_GOLDEN_ENV__, {});
  return f;
}

/** Active leave for a groomer over the given window. */
function onLeave(f, providerId, startIso, endIso) {
  f.sqlite.prepare("INSERT INTO provider_unavailability (id,provider_id,starts_at,ends_at,reason,status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,'active','ops@pawspace.test',?,?)").run(`LEAVE-${providerId}-${startIso}`, providerId, startIso, endIso, "Planned leave", Date.now(), Date.now());
}
/** Another customer's reservation occupying a groomer at the given window. */
function occupy(f, providerId, startIso, endIso) {
  f.sqlite.prepare("INSERT INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,care_mode,status,explanation_json,created_at) VALUES (?,?,?,'grooming','blr','blr-east','OTHER-CUSTOMER','[]',?,?,1,1,NULL,'assigned','{}',?)").run(`BUSY-${providerId}`, `OTHER-GROUP-${providerId}`, providerId, startIso, endIso, Date.now());
}

test("1. the quote records the difference but creates no hold and no payment intent", async t => {
  const f = await journey(t, { id: "QUOTE" });
  const before = f.booking();
  const quoted = await f.reschedule("reschedule_quote");
  assert.equal(quoted.status, 409, JSON.stringify(quoted.body));
  assert.equal(quoted.body.code, "reschedule_price_increase");
  assert.equal(quoted.body.priceDifference, 475);
  assert.equal(quoted.body.bookedAmount, 1899);
  assert.equal(quoted.body.newSlotAmount, 2374);
  assert.equal(quoted.body.newTotalAmount, 2374);
  assert.equal(quoted.body.differencePaymentAvailable, true);
  assert.equal(quoted.body.holdMinutes, 10);
  assert.match(quoted.body.requestId, /^GRR-/);
  assert.match(quoted.body.consentRevision, /^[0-9a-f]{64}$/);
  assert.match(quoted.body.error, /₹475 more/);
  assert.match(quoted.body.error, /nothing has been charged/);
  assert.equal(f.request(quoted.body.requestId).status, "quoted");
  assert.deepEqual(f.holds(quoted.body.requestId), [], "no slot is held by a quote");
  assert.equal(f.one("SELECT COUNT(*) n FROM payment_intents WHERE booking_id=?", f.bookingId).n, 0, "no payment intent");
  assert.equal(f.razorpay.orders.length, 0, "no Razorpay order");
  assert.deepEqual(f.booking(), before, "the booking is untouched");

  // Asking again for the same time refreshes the same request instead of opening another.
  const again = await f.reschedule();
  assert.equal(again.body.requestId, quoted.body.requestId);
  assert.equal(again.body.consentRevision, quoted.body.consentRevision);
  assert.equal(f.one("SELECT COUNT(*) n FROM grooming_reschedule_requests WHERE booking_id=?", f.bookingId).n, 1);
});

test("1b. a same-price quote moves nothing and needs no payment", async t => {
  const f = await journey(t, { id: "QSAME", dearer: false });
  const before = f.booking();
  const quoted = await f.reschedule("reschedule_quote");
  assert.equal(quoted.status, 200, JSON.stringify(quoted.body));
  assert.equal(quoted.body.data.differencePaymentRequired, false);
  assert.equal(quoted.body.data.priceDifference, 0);
  assert.deepEqual(f.booking(), before);
  assert.equal(f.one("SELECT COUNT(*) n FROM grooming_reschedule_requests WHERE booking_id=?", f.bookingId).n, 0);
});

test("2. paying holds the slot once, claims one intent and one order; a replay reuses them; a changed price is refused", async t => {
  const f = await journey(t, { id: "PAY" });
  const quoted = await f.reschedule();
  const requestId = quoted.body.requestId;

  // The client's figures must match the quote it approved.
  const wrong = await f.pay(quoted.body, { expectedDifference: 400 });
  assert.equal(wrong.status, 409, JSON.stringify(wrong.body));
  assert.equal(wrong.body.code, "reschedule_price_changed");
  assert.equal(wrong.body.priceDifference, 475);

  // The price changes between quote and payment: re-priced, refused, and the request carries the new figures.
  f.sqlite.prepare("UPDATE dynamic_pricing_rules SET adjustment_value=20 WHERE id='PD-SURGE-PAY'").run();
  const changed = await f.pay(quoted.body);
  assert.equal(changed.status, 409, JSON.stringify(changed.body));
  assert.equal(changed.body.code, "reschedule_price_changed");
  assert.equal(changed.body.priceDifference, 578, "round(2064 x 1.20)=2477, less the 1899 booked");
  assert.notEqual(changed.body.consentRevision, quoted.body.consentRevision);
  assert.deepEqual(f.holds(requestId), [], "nothing is held for a price the customer has not approved");
  assert.equal(f.razorpay.orders.length, 0);

  const before = Date.now();
  const paid = await f.pay({ requestId, priceDifference: changed.body.priceDifference, consentRevision: changed.body.consentRevision });
  assert.equal(paid.status, 201, JSON.stringify(paid.body));
  const checkout = paid.body.data;
  assert.equal(checkout.requestId, requestId);
  assert.match(checkout.orderId, /^order_RSCH/);
  assert.equal(checkout.amountPaise, 57800);
  assert.equal(checkout.keyId, KEY_ID);
  assert.equal(checkout.checkoutTimeoutSeconds, 480);
  assert.deepEqual(checkout.locks, { PAWSPACE_PAYMENT_ENV: "sandbox", FORBID_PRODUCTION: "true", PAWSPACE_PAYMENT_LIVE_APPROVED: "false" });
  const holds = f.holds(requestId);
  assert.equal(holds.length, 1, "one slot hold");
  assert.deepEqual({ provider: holds[0].provider_id, start: holds[0].scheduled_start, status: holds[0].status }, { provider: "groom_arun", start: f.target, status: "assigned" });
  assert.ok(holds[0].lease_expires_at >= before + 9 * 60_000 && holds[0].lease_expires_at <= Date.now() + 10 * 60_000, "held for 10 minutes");
  assert.ok(holds[0].customer_session_id, "the hold belongs to the customer's session");
  const intents = f.all("SELECT id,idempotency_key,amount_paise,gateway_order_id,state,commercial_snapshot_json FROM payment_intents WHERE booking_id=?", f.bookingId);
  assert.equal(intents.length, 1, "one intent");
  assert.equal(intents[0].idempotency_key, `grooming-reschedule:${requestId}:57800`);
  assert.equal(intents[0].gateway_order_id, checkout.orderId);
  assert.equal(JSON.parse(intents[0].commercial_snapshot_json).rescheduleRequestId, requestId);
  assert.equal(f.one("SELECT COUNT(*) n FROM financial_outbox WHERE aggregate_id=? AND event_type='CREATE_RAZORPAY_ORDER'", intents[0].id).n, 1, "one outbox command");
  assert.equal(f.razorpay.orders.length, 1, "one Razorpay order");
  assert.equal(f.razorpay.orders[0].amount, 57800);
  assert.equal(f.one("SELECT gateway_order_id FROM payment_gateway_links WHERE booking_id=?", f.bookingId).gateway_order_id, `order_${f.groupId}`, "the booking's own gateway link is not repointed at the difference order");
  assert.equal(f.request(requestId).status, "awaiting_payment");

  const replay = await f.pay({ requestId, priceDifference: 578, consentRevision: changed.body.consentRevision });
  assert.equal(replay.status, 201, JSON.stringify(replay.body));
  assert.equal(replay.body.data.orderId, checkout.orderId, "a replay returns the same order");
  assert.equal(f.holds(requestId).length, 1);
  assert.equal(f.one("SELECT COUNT(*) n FROM payment_intents WHERE booking_id=?", f.bookingId).n, 1);
  assert.equal(f.razorpay.orders.length, 1, "and never calls Razorpay again");
});

test("3. a signed capture moves the booking, raises its totals, keeps the original payment id and releases the hold", async t => {
  const f = await journey(t, { id: "MOVE" });
  const { checkout, requestId } = await f.quoteAndPay();
  const captured = await f.capture(checkout);
  assert.equal(captured.status, 200, JSON.stringify(captured.body));
  assert.equal(captured.body.atomicCapture, true);

  const booking = f.booking(), work = f.work();
  assert.equal(booking.scheduled_start, f.target, "the booking moved");
  assert.equal(work.scheduled_start, f.target);
  assert.ok(f.reservations().every(row => row.scheduled_start === f.target && row.status === "assigned" && row.provider_id === "groom_arun"));
  assert.ok(f.holds(requestId).every(row => row.status === "cancelled"), "the hold is released by the move");
  assert.equal(booking.total_amount, 2374, "the booking total includes the difference");
  assert.equal(JSON.parse(booking.pricing_json).rescheduleDifferencePaid, 475);
  assert.deepEqual(f.payment(), { amount: 2374, amount_due_now: 2374, status: "captured" });
  assert.deepEqual(f.recon(), { expected_amount: 2374, captured_amount: 2374, refunded_amount: 0 });
  assert.equal(f.one("SELECT gateway_payment_id FROM payment_gateway_links WHERE booking_id=?", f.bookingId).gateway_payment_id, f.originalPayment, "the original payment id is kept");
  const request = f.request(requestId);
  assert.equal(request.status, "applied");
  assert.equal(request.gateway_payment_id, "pay_DIFF_MOVE");
  const [moved] = f.events("booking_rescheduled");
  assert.equal(moved.to.scheduledStart, f.target);
  assert.equal(moved.pricing.differencePaid, 475);
  assert.equal(moved.pricing.storedPriceKept, false);
  assert.equal(moved.pricing.newTotalAmount, 2374);
  assert.equal(f.one("SELECT COUNT(*) n FROM booking_customer_notifications WHERE booking_id=? AND template_code='reschedule_difference_applied'", f.bookingId).n, 1);

  const status = await f.status(requestId);
  assert.equal(status.status, 200, JSON.stringify(status.body));
  assert.equal(status.body.data.request.status, "applied");
  assert.equal(status.body.data.booking.totalAmount, 2374);
  assert.equal(status.body.data.booking.scheduledStart, f.target);
});

test("4. payment.captured and order.paid for the same money give one move and one journal", async t => {
  const f = await journey(t, { id: "DUP" });
  const { checkout, requestId } = await f.quoteAndPay();
  assert.equal((await f.capture(checkout)).status, 200);
  const paid = await f.webhook({ eventId: "evt_ORDER_PAID_DUP", orderId: checkout.orderId, gatewayPaymentId: "pay_DIFF_DUP", amount: checkout.amountPaise, event: "order.paid" });
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  assert.equal(paid.body.duplicateCapture, true);
  const intentId = f.request(requestId).intent_id;
  assert.equal(f.one("SELECT COUNT(*) n FROM journal_transactions WHERE source_type='razorpay_capture' AND source_id=?", intentId).n, 1, "one journal");
  assert.equal(f.events("booking_rescheduled").length, 1, "one move");
  assert.deepEqual(f.all("SELECT status FROM financial_outbox WHERE event_type='GROOMING_RESCHEDULE_APPLY' AND aggregate_id=?", requestId), [{ status: "SUCCEEDED" }]);
  assert.equal(f.booking().total_amount, 2374, "the difference is added once");
  assert.equal(f.recon().captured_amount, 2374);
});

test("5. the customer's confirm, answered by the provider-API probe, moves the booking the same way", async t => {
  const f = await journey(t, { id: "PROBE" });
  const { checkout, requestId } = await f.quoteAndPay();
  // No webhook has arrived; Razorpay reports the order paid when PawSpace asks.
  f.razorpay.orderPayments.set(checkout.orderId, [{ id: "pay_PROBE", order_id: checkout.orderId, amount: checkout.amountPaise, currency: "INR", status: "captured", captured: true, notes: { booking_id: f.bookingId, payment_id: f.paymentId } }]);
  const { POST } = await import("../app/api/customer-checkout/route.ts");
  const signature = createHmac("sha256", KEY_SECRET).update(`${checkout.orderId}|pay_PROBE`).digest("hex");
  const response = await POST(new Request("https://uat.pawspace.in/api/customer-checkout", { method: "POST", headers: { origin: "https://uat.pawspace.in", "content-type": "application/json", cookie: f.cookie, "x-pawspace-role": "admin", "x-internal-service": "true" }, body: JSON.stringify({ action: "confirm", bookingId: f.bookingId, orderId: checkout.orderId, paymentId: "pay_PROBE", signature }) }));
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.data.status, "captured");
  const capture = f.one("SELECT signature_verified,detail_json FROM payment_gateway_events WHERE gateway_payment_id='pay_PROBE' AND event_type='payment.captured'");
  assert.equal(capture.signature_verified, 0);
  assert.equal(JSON.parse(capture.detail_json).captureAuthority, "provider_api", "recorded as an authenticated provider read");
  assert.equal(f.request(requestId).status, "applied");
  assert.equal(f.booking().scheduled_start, f.target);
  assert.equal(f.booking().total_amount, 2374);
  assert.deepEqual(f.recon(), { expected_amount: 2374, captured_amount: 2374, refunded_amount: 0 });
});

test("6. a short capture does not move the booking and the running captured total is kept", async t => {
  const f = await journey(t, { id: "SHORT" });
  const { checkout, requestId } = await f.quoteAndPay();
  const short = await f.webhook({ eventId: "evt_SHORT", orderId: checkout.orderId, gatewayPaymentId: "pay_SHORT", amount: checkout.amountPaise - 100 });
  assert.equal(short.body.status, "exception", JSON.stringify(short.body));
  assert.equal(short.body.reason, "capture_amount_mismatch");
  assert.equal(f.booking().scheduled_start, f.start, "not moved");
  assert.equal(f.booking().total_amount, 1899);
  assert.equal(f.recon().captured_amount, 1899, "the Rs 1,899 already collected is still reported");
  assert.equal(f.request(requestId).status, "awaiting_payment");
  assert.equal(f.holds(requestId)[0].status, "assigned", "the time stays held for a correct payment");
  assert.equal(f.one("SELECT COUNT(*) n FROM financial_outbox WHERE event_type='GROOMING_RESCHEDULE_APPLY'").n, 0);
});

test("7. a lapsed hold is released; a late capture still moves the booking while the slot is free (scheduled probe)", async t => {
  const f = await journey(t, { id: "LATE" });
  const { offer, checkout, requestId } = await f.quoteAndPay();
  f.sqlite.prepare("UPDATE scheduling_reservations SET lease_expires_at=? WHERE group_id=?").run(Date.now() - 1000, `RSH-${requestId}`);
  const { cleanupExpiredReservationLeases } = await import("../lib/scheduling-reservation-leases.ts");
  const released = await cleanupExpiredReservationLeases(f.db);
  assert.equal(released.reservations, 1, "the existing lease cleanup releases the hold");
  const retry = await f.pay(offer);
  assert.equal(retry.status, 409, JSON.stringify(retry.body));
  assert.equal(retry.body.code, "reschedule_hold_expired", "no payment is reopened for a time that is no longer held");
  assert.equal(f.request(requestId).status, "expired");
  const { runGroomingRescheduleSweep } = await import("../lib/grooming-reschedule-payment.ts");
  assert.equal((await runGroomingRescheduleSweep(f.db)).expired, 0, "already closed");
  const expired = await f.status(requestId);
  assert.equal(expired.body.data.request.status, "expired");

  // The customer paid at the last moment; the scheduled probe finds it.
  f.razorpay.orderPayments.set(checkout.orderId, [{ id: "pay_LATE", order_id: checkout.orderId, amount: checkout.amountPaise, currency: "INR", status: "captured", captured: true, notes: { booking_id: f.bookingId } }]);
  f.sqlite.prepare("UPDATE payment_intents SET updated_at=? WHERE gateway_order_id=?").run(Date.now() - 5 * 60_000, checkout.orderId);
  const { runRazorpayCaptureReconciliationSweep } = await import("../lib/razorpay-capture-reconciliation.ts");
  const probe = await runRazorpayCaptureReconciliationSweep(f.db, globalThis.__GROOM_GOLDEN_ENV__, {});
  assert.equal(probe.captured, 1, JSON.stringify(probe));
  assert.equal(f.request(requestId).status, "applied");
  assert.equal(f.booking().scheduled_start, f.target);
  assert.equal(f.booking().total_amount, 2374);
});

test("7b. a late capture after the slot was taken refunds the difference and leaves the booking as it was", async t => {
  const f = await journey(t, { id: "LATEGONE" });
  const { checkout, requestId } = await f.quoteAndPay();
  f.sqlite.prepare("UPDATE scheduling_reservations SET lease_expires_at=? WHERE group_id=?").run(Date.now() - 1000, `RSH-${requestId}`);
  await (await import("../lib/scheduling-reservation-leases.ts")).cleanupExpiredReservationLeases(f.db);
  assert.equal((await (await import("../lib/grooming-reschedule-payment.ts")).runGroomingRescheduleSweep(f.db)).expired, 1, "the scheduled sweep closes the unpaid request");
  assert.equal(f.request(requestId).status, "expired");
  occupy(f, "groom_arun", f.target, f.targetEnd);
  onLeave(f, "groom_kiran", f.target, f.targetEnd);
  onLeave(f, "groom_sanjay", f.target, f.targetEnd);
  assert.equal((await f.capture(checkout, "pay_LATEGONE")).status, 200);
  const request = f.request(requestId);
  assert.equal(request.status, "refund_requested");
  assert.equal(request.failure_reason, "reschedule_no_provider_available");
  assert.equal(f.booking().scheduled_start, f.start, "the booking keeps its time");
  assert.equal(f.booking().total_amount, 1899, "and its price");
  const refundCase = f.one("SELECT amount,purpose,gateway_payment_id,status FROM booking_refund_cases WHERE id=?", request.refund_case_id);
  assert.deepEqual(refundCase, { amount: 475, purpose: "reschedule_difference", gateway_payment_id: "pay_LATEGONE", status: "requested" });
  const report = await f.refundSweep();
  assert.equal(report.failed, 0, JSON.stringify(report.errors));
  assert.deepEqual(f.razorpay.refunds.map(refund => [refund.payment_id, refund.amount]), [["pay_LATEGONE", 47500]], "refunded against the difference payment, on a booking that is not cancelled");
});

test("8. a groomer who became busy is replaced at move time", async t => {
  const f = await journey(t, { id: "SWAP" });
  const { checkout, requestId } = await f.quoteAndPay();
  onLeave(f, "groom_arun", `${istDate(f.target)}T00:00:00.000Z`, new Date(Date.parse(f.target) + 86_400_000).toISOString());
  assert.equal((await f.capture(checkout)).status, 200);
  assert.equal(f.request(requestId).status, "applied");
  const booking = f.booking();
  assert.equal(booking.scheduled_start, f.target);
  assert.notEqual(booking.provider_id, "groom_arun", "another groomer in the zone took the new time");
  assert.equal(f.work().provider_id, booking.provider_id);
  assert.ok(f.reservations().every(row => row.provider_id === booking.provider_id && row.scheduled_start === f.target));
  const [moved] = f.events("booking_rescheduled");
  assert.equal(moved.providerChanged, true);
  assert.equal(moved.previousProviderId, "groom_arun");
  assert.equal(booking.total_amount, 2374);
});

test("8b. when nobody can take the new time at move time, the difference is refunded", async t => {
  const f = await journey(t, { id: "NOBODY" });
  const { checkout, requestId } = await f.quoteAndPay();
  for (const groomer of ["groom_arun", "groom_kiran", "groom_sanjay"]) onLeave(f, groomer, f.target, f.targetEnd);
  assert.equal((await f.capture(checkout)).status, 200);
  const request = f.request(requestId);
  assert.equal(request.status, "refund_requested");
  assert.equal(f.booking().scheduled_start, f.start);
  assert.ok(f.holds(requestId).every(row => row.status === "cancelled"), "the hold is released");
  assert.equal(f.one("SELECT COUNT(*) n FROM booking_customer_notifications WHERE booking_id=? AND template_code='reschedule_difference_refund'", f.bookingId).n, 1, "the customer is told");
  const status = await f.status(requestId);
  assert.equal(status.body.data.request.status, "refund_requested");
  assert.equal(status.body.data.request.refundStatus, "requested");
});

test("9. a booking whose groomer is already on the way is not moved; the difference is refunded", async t => {
  const f = await journey(t, { id: "WAY" });
  const { checkout, requestId } = await f.quoteAndPay();
  const providerCookie = await sessionCookie(f.db, "provider", "groom_arun", "provider:groom_arun");
  for (const action of ["accept", "on_the_way"]) {
    const moved = await routeCall("../../app/api/grooming-lifecycle/route.ts", "POST", "/api/grooming-lifecycle", { bookingId: f.bookingId, action, checklist: fixtureChecklist(action) }, providerCookie);
    assert.equal(moved.status, 200, `${action}: ${JSON.stringify(moved.body)}`);
  }
  assert.equal((await f.capture(checkout)).status, 200);
  assert.equal(f.request(requestId).status, "refund_requested");
  assert.equal(f.booking().status, "on_the_way");
  assert.equal(f.booking().scheduled_start, f.start);
  assert.equal(f.booking().total_amount, 1899);
  assert.equal(f.one("SELECT amount FROM booking_refund_cases WHERE id=?", f.request(requestId).refund_case_id).amount, 475);
});

test("10. cancelling while paying releases the hold; a capture that arrives later is refunded to its own payment", async t => {
  const f = await journey(t, { id: "CXPAY" });
  const { checkout, requestId } = await f.quoteAndPay();
  const cancelled = await f.call({ action: "cancel", reason: "Plans changed while paying" });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.data.refundAmount, 1899);
  assert.ok(f.holds(requestId).every(row => row.status === "cancelled"), "the held slot is released with the booking");
  assert.equal(f.request(requestId).status, "cancelled");

  assert.equal((await f.capture(checkout, "pay_CXPAY")).status, 200);
  const request = f.request(requestId);
  assert.equal(request.status, "refund_requested");
  assert.equal(request.failure_reason, "booking_cancelled");
  assert.equal(f.booking().status, "cancelled");
  const report = await f.refundSweep();
  assert.equal(report.failed, 0, JSON.stringify(report.errors));
  assert.deepEqual(f.razorpay.refunds.map(refund => [refund.payment_id, refund.amount]).sort(), [[f.originalPayment, 189900], ["pay_CXPAY", 47500]].sort(),
    "the booking price goes back to the booking payment and the difference to its own payment");
});

test("11. cancelling after a paid move refunds the difference too, split across both payments", async t => {
  const f = await journey(t, { id: "CXAFTER" });
  const { checkout } = await f.quoteAndPay();
  assert.equal((await f.capture(checkout, "pay_CXAFTER")).status, 200);
  const cancelled = await f.call({ action: "cancel", reason: "Plans changed after moving" });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.data.refundAmount, 2374, "the refund is based on the new total");
  const report = await f.refundSweep();
  assert.equal(report.failed, 0, JSON.stringify(report.errors));
  assert.deepEqual(f.razorpay.refunds.map(refund => [refund.payment_id, refund.amount]), [["pay_CXAFTER", 47500], [f.originalPayment, 189900]], "newest payment first, each capped at its amount");
  assert.deepEqual(f.all("SELECT amount,gateway_payment_id FROM booking_refund_cases WHERE booking_id=? ORDER BY id", f.bookingId), [
    { amount: 475, gateway_payment_id: "pay_CXAFTER" },
    { amount: 1899, gateway_payment_id: f.originalPayment },
  ]);
});

test("12. completion finance settles after a paid move", async t => {
  const f = await journey(t, { id: "DONE" });
  const { checkout } = await f.quoteAndPay();
  assert.equal((await f.capture(checkout, "pay_DONE")).status, 200);
  assert.equal(f.booking().total_amount, 2374);
  const providerId = f.booking().provider_id;
  const providerCookie = await sessionCookie(f.db, "provider", providerId, `provider:${providerId}`);
  const lifecycle = (action, extra = {}) => routeCall("../../app/api/grooming-lifecycle/route.ts", "POST", "/api/grooming-lifecycle", { bookingId: f.bookingId, action, checklist: fixtureChecklist(action), ...extra }, providerCookie);
  const location = f.result.location.body.data;
  // The move re-confirms the same full-time groomer as assigned, so there is nothing left to accept.
  const steps = f.booking().status === "assigned" ? ["on_the_way", "arrived", "start_service"] : ["accept", "on_the_way", "arrived", "start_service"];
  for (const action of steps) {
    if (action === "arrived") {
      const capturedAt = Date.now();
      const gps = await routeCall("../../app/api/grooming-route/route.ts", "POST", "/api/grooming-route", { bookingId: f.bookingId, providerId, latitude: Number(location.latitude), longitude: Number(location.longitude), accuracyMeters: 10, capturedAt, idempotencyKey: `pay-difference:${capturedAt}` }, providerCookie);
      assert.equal(gps.status, 201, JSON.stringify(gps.body));
    }
    const moved = await lifecycle(action);
    assert.equal(moved.status, 200, `${action}: ${JSON.stringify(moved.body)}`);
  }
  const media = [];
  for (const purpose of ["before_service", "after_service"]) {
    const sha256 = purpose === "before_service" ? "c".repeat(64) : "d".repeat(64);
    const prepared = await routeCall("../../app/api/service-media/route.ts", "POST", "/api/service-media", { bookingId: f.bookingId, purpose, mimeType: "image/jpeg", sizeBytes: 128, sha256, fileName: `${purpose}.jpg` }, providerCookie);
    const { id, upload } = prepared.body.data;
    await routeCall("../../app/api/service-media/route.ts", "PATCH", "/api/service-media", { id, action: "confirm_upload", uploadToken: upload.token, storageReference: upload.objectKey, observedSizeBytes: 128, observedSha256: sha256, observedMimeType: "image/jpeg" });
    await routeCall("../../app/api/service-media/route.ts", "PATCH", "/api/service-media", { id, action: "record_scan", scanResult: "clean", reason: `Reviewed the ${purpose.replace("_", " ")} photo` });
    media.push(prepared.body.data.ref);
  }
  assert.equal((await lifecycle("add_proof", { beforePhotoRef: media[0], afterPhotoRef: media[1], checklist: ["coat", "nails", "ears"], completionNotes: "Completed safely" })).status, 200);
  const completed = await lifecycle("complete");
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  const parity = f.one("SELECT customer_gross_collection,variance,status FROM booking_settlement_reconciliations WHERE booking_id=?", f.bookingId);
  assert.deepEqual(parity, { customer_gross_collection: 2374, variance: 0, status: "reconciled" }, "cash collected (Rs 1,899 + Rs 475) matches the order value");
});

test("12b. after a refunded difference, the booking stays paid in full and cancelling still refunds the booking price", async t => {
  const f = await journey(t, { id: "REFTHENCX" });
  const { checkout, requestId } = await f.quoteAndPay();
  for (const groomer of ["groom_arun", "groom_kiran", "groom_sanjay"]) onLeave(f, groomer, f.target, f.targetEnd);
  assert.equal((await f.capture(checkout, "pay_REFTHENCX")).status, 200);
  await f.refundSweep();
  const [refund] = f.razorpay.refunds;
  // Razorpay's refund notification carries no booking notes: the difference payment is not on the booking's
  // gateway link, so it resolves through its own payment intent.
  const refundNotice = { event: "refund.processed", created_at: Math.floor(Date.now() / 1000), payload: { refund: { entity: { id: refund.id, payment_id: "pay_REFTHENCX", amount: 47500, currency: "INR" } }, payment: { entity: { id: "pay_REFTHENCX", order_id: checkout.orderId } } } };
  const processed = await f.signed("evt_RFND_REFTHENCX", refundNotice);
  assert.equal(processed.status, 200, JSON.stringify(processed.body));
  assert.equal(processed.body.status, "processed", JSON.stringify(processed.body));
  // The same refund notified again under another event id changes nothing.
  const repeated = await f.signed("evt_RFND_REFTHENCX_AGAIN", { ...refundNotice, created_at: refundNotice.created_at + 60 });
  assert.equal(repeated.status, 200, JSON.stringify(repeated.body));
  assert.equal(repeated.body.reason, "refund_already_processed", JSON.stringify(repeated.body));
  assert.equal(f.one("SELECT COUNT(*) n FROM booking_lifecycle_events WHERE booking_id=? AND event_type='refund_processed'", f.bookingId).n, 1);
  assert.equal(f.one("SELECT status FROM booking_refund_cases WHERE id=?", f.request(requestId).refund_case_id).status, "processed");
  assert.deepEqual(f.one("SELECT refunded_amount,gateway_status FROM payment_reconciliation_records WHERE payment_id=?", f.paymentId), { refunded_amount: 475, gateway_status: "partially_refunded" }, "the gateway record shows the refund");
  assert.equal(f.payment().status, "captured", "the booking's own price is still paid in full: its invoice and confirmation still read captured");
  assert.equal((await f.status(requestId)).body.data.request.status, "refunded");
  // Paying a difference again is still offered for this booking once a groomer is free at that time.
  f.sqlite.prepare("DELETE FROM provider_unavailability WHERE id LIKE 'LEAVE-%'").run();
  const again = await f.reschedule("reschedule_quote");
  assert.equal(again.body.code, "reschedule_price_increase", JSON.stringify(again.body));
  assert.equal(again.body.differencePaymentAvailable, true);
  const { collectedForBooking } = await import("../lib/collected-funds.ts");
  assert.equal(await collectedForBooking(f.db, f.bookingId), 1899, "the refunded difference is not collected for this booking");
  const cancelled = await f.call({ action: "cancel", reason: "Plans changed after all" });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.data.refundAmount, 1899, "a partly refunded payment still returns the booking price");
  const report = await f.refundSweep();
  assert.equal(report.failed, 0, JSON.stringify(report.errors));
  assert.deepEqual(f.razorpay.refunds.slice(1).map(item => [item.payment_id, item.amount]), [[f.originalPayment, 189900]]);
});

test("13. the reschedule form offers to pay the difference with a consent box and a hold countdown", async () => {
  await import("./helpers/grooming-journey-harness.mjs");
  const React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { default: GroomingRescheduleForm, RescheduleDifferencePanel, holdCountdown } = await import("../app/grooming/manage/grooming-reschedule-form.tsx");
  const offer = { requestId: "GRR-1", consentRevision: "a".repeat(64), difference: 475, bookedAmount: 1899, newSlotAmount: 2374, newTotalAmount: 2374, currency: "INR", holdMinutes: 10 };
  const now = Date.parse("2026-09-26T10:00:00Z");
  const noop = () => {};
  const panel = renderToStaticMarkup(React.createElement(RescheduleDifferencePanel, { offer, toStart: "2026-09-29T03:30:00.000Z", accepted: false, busy: false, holdExpiresAt: now + 599_000, now, onAccept: noop, onPay: noop, onChooseAnother: noop }));
  assert.match(panel, /costs ₹475 more/);
  assert.match(panel, /Your booked price is ₹1,899 and the new time costs ₹2,374/);
  assert.match(panel, /nothing has been charged yet/);
  assert.match(panel, /hold the new time for 10 minutes/);
  assert.match(panel, /Your booking total becomes ₹2,374/);
  assert.match(panel, /the ₹475 is refunded to your original payment method/);
  assert.match(panel, /holding this time for you for another 9:59/);
  assert.match(panel, /<input type="checkbox"\/>/);
  assert.match(panel, /<button type="button" disabled="">Pay ₹475 and move<\/button>/, "paying needs the customer's approval first");
  assert.match(renderToStaticMarkup(React.createElement(RescheduleDifferencePanel, { offer, toStart: "2026-09-29T03:30:00.000Z", accepted: true, busy: false, holdExpiresAt: null, now, onAccept: noop, onPay: noop, onChooseAnother: noop })), /<button type="button">Pay ₹475 and move<\/button>/);
  assert.equal(holdCountdown(now + 61_000, now), "1:01");
  assert.equal(holdCountdown(now - 1, now), "0:00");

  const form = renderToStaticMarkup(React.createElement(GroomingRescheduleForm, { preview: { consentRevision: "r", bookingId: "B-1", currency: "INR", durationMinutes: 120, reschedule: { allowed: true, feeAmount: 0, reasons: [] }, cancellation: { mode: "cancel", refundAmount: 0, reasons: [] }, policyVersion: "p", refundPolicyVersion: "r" }, customerId: "C-1", onChanged: noop, onRefresh: noop }));
  assert.match(form, /nothing is charged until you approve and pay the difference/);
  assert.match(form, /we then hold the new time for 10 minutes while you pay/);

  const { rescheduleDifferenceOffer, rescheduleRefusal, rescheduleRequestMessage } = await import("../lib/grooming-booking-change-client.ts");
  const { ApiError } = await import("../lib/api-fetch.ts");
  const refusal = body => new ApiError("http", 409, String(body.error), body);
  const increase = refusal({ error: "This time costs ₹475 more than your booked price.", code: "reschedule_price_increase", priceDifference: 475, bookedAmount: 1899, newSlotAmount: 2374, newTotalAmount: 2374, currency: "INR", differencePaymentAvailable: true, requestId: "GRR-1", consentRevision: "a".repeat(64), holdMinutes: 10 });
  assert.deepEqual(rescheduleDifferenceOffer(increase), offer);
  assert.equal(rescheduleDifferenceOffer(refusal({ error: "x", code: "reschedule_price_increase", priceDifference: 475, differencePaymentAvailable: false })), null, "no offer where paying online is not available");
  assert.equal(rescheduleRefusal(refusal({ error: "Price changed", code: "reschedule_price_changed" })).canChooseAnotherTime, true);
  assert.equal(rescheduleRefusal(refusal({ error: "Held time ran out", code: "reschedule_hold_expired" })).canChooseAnotherTime, true);
  const money = amount => `₹${amount.toLocaleString("en-IN")}`, at = () => "29 Sept, 9:00 am";
  assert.equal(rescheduleRequestMessage({ request: { status: "applied", toStart: "x", difference: 475, newTotalAmount: 2374 }, booking: null }, money, at), "Booking moved to 29 Sept, 9:00 am. We received your ₹475 payment for the new time, so your booking total is now ₹2,374.");
  assert.match(rescheduleRequestMessage({ request: { status: "refund_requested", toStart: "x", difference: 475, newTotalAmount: 2374 }, booking: null }, money, at), /We could not move your booking to 29 Sept, 9:00 am.*₹475 payment for the new time is being refunded/);
});

test("14. while the difference is being paid, another move is refused until the hold lapses", async t => {
  const f = await journey(t, { id: "INFLIGHT" });
  const { requestId } = await f.quoteAndPay();
  const before = f.booking();
  // Later the same day: the same weekday price, so it would move at once without paying anything.
  const sameStart = new Date(Date.parse(f.start) + 3 * 3_600_000).toISOString(), sameEnd = new Date(Date.parse(f.start) + 5 * 3_600_000).toISOString();
  const quoted = await f.call({ action: "reschedule_quote", reason: "Customer needs another time", scheduledStart: sameStart, scheduledEnd: sameEnd });
  assert.equal(quoted.status, 200, JSON.stringify(quoted.body));
  assert.equal(quoted.body.data.differencePaymentRequired, false, "that time costs the same");
  const moved = await f.call({ action: "reschedule", reason: "Customer needs another time", scheduledStart: sameStart, scheduledEnd: sameEnd });
  assert.equal(moved.status, 409, JSON.stringify(moved.body));
  assert.equal(moved.body.code, "reschedule_payment_in_progress");
  assert.equal(moved.body.requestId, requestId);
  assert.match(moved.body.error, /already paying to move this booking/);
  assert.match(moved.body.error, /has not been changed/);
  assert.deepEqual(f.booking(), before, "nothing moved while the payment is open");
  assert.equal(f.request(requestId).status, "awaiting_payment");

  // Once the hold lapses unpaid, the same-price move goes ahead.
  f.sqlite.prepare("UPDATE grooming_reschedule_requests SET hold_expires_at=? WHERE id=?").run(Date.now() - 1000, requestId);
  const later = await f.call({ action: "reschedule", reason: "Customer needs another time", scheduledStart: sameStart, scheduledEnd: sameEnd });
  assert.equal(later.status, 200, JSON.stringify(later.body));
  assert.equal(f.booking().scheduled_start, sameStart);
  assert.equal(f.request(requestId).status, "expired");
  assert.ok(f.holds(requestId).every(row => row.status === "cancelled"), "the lapsed hold is released");
});

test("14b. a paid difference that is still moving refuses another reschedule", async t => {
  const f = await journey(t, { id: "PAIDMOVING" });
  const { requestId } = await f.quoteAndPay();
  f.sqlite.prepare("UPDATE grooming_reschedule_requests SET status='paid' WHERE id=?").run(requestId);
  const again = await f.reschedule();
  assert.equal(again.status, 409, JSON.stringify(again.body));
  assert.equal(again.body.code, "reschedule_payment_in_progress");
  assert.match(again.body.error, /received your payment to move this booking/);
  assert.equal(f.one("SELECT COUNT(*) n FROM grooming_reschedule_requests WHERE booking_id=?", f.bookingId).n, 1, "no second request to pay for");
});

test("15. a payment reopened late in the hold closes its checkout before the hold lapses", async t => {
  const f = await journey(t, { id: "LATEOPEN" });
  const { offer, requestId } = await f.quoteAndPay();
  const heldUntil = Date.now() + 4 * 60_000;
  f.sqlite.prepare("UPDATE grooming_reschedule_requests SET hold_expires_at=? WHERE id=?").run(heldUntil, requestId);
  f.sqlite.prepare("UPDATE scheduling_reservations SET lease_expires_at=? WHERE group_id=?").run(heldUntil, `RSH-${requestId}`);
  const replay = await f.pay(offer);
  assert.equal(replay.status, 201, JSON.stringify(replay.body));
  const seconds = replay.body.data.checkoutTimeoutSeconds;
  assert.ok(seconds >= 60 && seconds <= 180, `checkout closes a minute before the hold lapses (got ${seconds}s for a 4 minute hold)`);
});

test("7c. a late payment for a lapsed request is refunded when the customer is already paying for a newer time", async t => {
  const f = await journey(t, { id: "SUPERSEDED" });
  const first = await f.quoteAndPay();
  f.sqlite.prepare("UPDATE scheduling_reservations SET lease_expires_at=? WHERE group_id=?").run(Date.now() - 1000, `RSH-${first.requestId}`);
  await (await import("../lib/scheduling-reservation-leases.ts")).cleanupExpiredReservationLeases(f.db);
  await (await import("../lib/grooming-reschedule-payment.ts")).runGroomingRescheduleSweep(f.db);
  assert.equal(f.request(first.requestId).status, "expired");

  // The customer chooses another dearer time on the same surge day and starts paying for that one.
  const laterStart = new Date(Date.parse(f.target) + 3 * 3_600_000).toISOString(), laterEnd = new Date(Date.parse(f.target) + 5 * 3_600_000).toISOString();
  const quoted = await f.call({ action: "reschedule", reason: "Customer needs a later time", scheduledStart: laterStart, scheduledEnd: laterEnd });
  assert.equal(quoted.body.code, "reschedule_price_increase", JSON.stringify(quoted.body));
  assert.notEqual(quoted.body.requestId, first.requestId);
  const paid = await f.pay(quoted.body);
  assert.equal(paid.status, 201, JSON.stringify(paid.body));

  // The first payment arrives late: it must not move the booking to the time the customer gave up.
  assert.equal((await f.capture(first.checkout, "pay_SUPERSEDED_OLD")).status, 200);
  assert.equal(f.request(first.requestId).status, "refund_requested");
  assert.equal(f.request(first.requestId).failure_reason, "superseded_by_a_newer_reschedule");
  assert.match(f.one("SELECT message FROM booking_customer_notifications WHERE booking_id=? AND template_code='reschedule_difference_refund'", f.bookingId).message, /^You chose another time for your PawSpace grooming booking, so the ₹475 you paid earlier for .* is being refunded/);
  assert.equal(f.booking().scheduled_start, f.start, "not moved to the abandoned time");
  assert.equal(f.booking().total_amount, 1899);

  // The newer payment moves the booking to the time the customer chose last.
  assert.equal((await f.capture(paid.body.data, "pay_SUPERSEDED_NEW")).status, 200);
  assert.equal(f.request(quoted.body.requestId).status, "applied");
  assert.equal(f.booking().scheduled_start, laterStart);
  assert.equal(f.booking().total_amount, 2374);
  const report = await f.refundSweep();
  assert.equal(report.failed, 0, JSON.stringify(report.errors));
  assert.deepEqual(f.razorpay.refunds.map(refund => [refund.payment_id, refund.amount]), [["pay_SUPERSEDED_OLD", 47500]]);
});
