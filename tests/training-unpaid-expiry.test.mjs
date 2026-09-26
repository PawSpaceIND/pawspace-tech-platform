/*
 * Unpaid Dog Training bookings expire (Dog Training follow-up 6, owner-approved 26 Sep 2026).
 *
 * An unpaid Training booking held its trainer's sessions and scheduling reservations for good. It now
 * expires at the earlier of 7 days after booking or its first reserved session's start, as one money-free
 * governed cancellation run by the 5-minute scheduler (lib/training-unpaid-expiry.ts); money that still
 * arrives is refunded automatically.
 *
 * Everything below drives the REAL modules against a real SQLite engine through the Training harness:
 * the sweep, the lifecycle, the capture saga, the automatic refund sweep, the payment-order entry point
 * and its route, and the background scheduler. Only Razorpay's HTTP boundary is stubbed. What must stay
 * true, and is asserted by reading the rows back:
 *   - an expired booking releases its trainer's sessions and slots and moves no money;
 *   - a booking that is paid, funded, in flight or already being delivered is never expired;
 *   - the expiry is atomic and idempotent under replays, overlapping runs, a racing capture and a held lock;
 *   - what the customer spent (wallet, PawPoints, a coupon) comes back exactly once;
 *   - late money is refunded once, and never revives the booking;
 *   - an ended booking cannot open a new payment order through any route.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  freshWorld, seedBooking, seedReservation, seedGovernedPayment, sessionCookie, routeCall, sessionStart, sessionEnd,
  CUSTOMER, TRAINER, OTHER_TRAINER, DB_GLOBAL, ENV_GLOBAL,
} from "./helpers/training-lifecycle-harness.mjs";
import { world as rawWorld } from "./helpers/execution-harness.mjs";

const expiry = await import("../lib/training-unpaid-expiry.ts");
const {
  runTrainingUnpaidExpirySweep, expireUnpaidTrainingBooking, ensureTrainingUnpaidExpiryTables, trainingUnpaidExpiryNotice,
  TRAINING_UNPAID_EXPIRY_MS, CHECKOUT_GRACE_MS, ACTOR, POLICY_VERSION, TRAINING_UNPAID_EXPIRY_EVENT, TRAINING_LATE_CAPTURE_EVENT,
  TRAINING_UNPAID_EXPIRY_NOTICE_TEMPLATE, TRAINING_LATE_CAPTURE_REFUND_REASON,
} = expiry;
const { materializeTrainingBooking } = await import("../lib/training-programme.ts");
const { mutateTrainingSession } = await import("../lib/training-session-lifecycle.ts");
const { withLifecycleMutationLock } = await import("../lib/lifecycle-mutation-lock.ts");
const { createBookingPaymentOrder } = await import("../lib/payment-order-intent.ts");
const { createCanonicalSalesPaymentLink } = await import("../lib/sales-core-tools.ts");
const paymentOrderRoute = await import("../app/api/payment-order/route.ts");
const { commitRazorpayCaptureAtomic, executeRazorpayCapturePostCommit } = await import("../lib/razorpay-capture-atomic.ts");
const { runAutomaticBookingRefundSweep } = await import("../lib/automatic-booking-refund.ts");
const { evaluateCancellationRefund, resolveRefundPolicy } = await import("../lib/refund-policy-governance.ts");
const cancellation = await import("../lib/training-cancellation.ts");
const { issueRecoveryEntitlement } = await import("../lib/payment-recovery-governance.ts");
const coupons = await import("../lib/coupon-governance.ts");
const wallet = await import("../lib/pawspace-wallet-governance.ts");
const points = await import("../lib/paw-points-governance.ts");
const { ensureSchedulingReservationLeaseGovernance } = await import("../lib/scheduling-reservation-leases.ts");
const { ensureProviderCapacityTables } = await import("../lib/provider-capacity-governance.ts");
const { ensureProviderWorkspaceTables } = await import("../lib/provider-workspace.ts");
const { ensureStayPaymentTables, staySplitScheduleStatement } = await import("../lib/stay-split-payments.ts");
const { ensurePaymentReconciliationTables } = await import("../lib/grooming-payment-reconciliation.ts");
const { ensureTaxiRideTables } = await import("../lib/taxi-ride-governance.ts");
const { runOrderNotificationSweep } = await import("../lib/order-notification-governance.ts");
const { runBackgroundScheduler } = await import("../lib/background-scheduler.ts");
const { UNPAID_REPORT_AFTER_MS } = await import("../lib/uat-staging-training-cleanup.mjs");

/* Razorpay sandbox test credentials the client needs to consider itself connected; nothing leaves the process. */
const ENV = {
  PAWSPACE_PAYMENT_ENV: "sandbox", PAWSPACE_PAYMENT_LIVE_APPROVED: "false", FORBID_PRODUCTION: "true",
  RAZORPAY_KEY_ID_SANDBOX: "rzp_test_unpaidexpiry", RAZORPAY_KEY_SECRET_SANDBOX: "synthetic-expiry-secret-not-a-credential",
};
const MIN = 60_000, DAY = 86_400_000, NOW = Date.now();
/** The harness books every fixture at NOW with its first session a fortnight out: this is past the 7-day window only. */
const AFTER_WINDOW = NOW + TRAINING_UNPAID_EXPIRY_MS + 60 * MIN;
const TOTAL = 8000;

const one = (world, sql, ...args) => world.sqlite.prepare(sql).get(...args);
const rows = (world, sql, ...args) => world.sqlite.prepare(sql).all(...args);
const hasTable = (world, name) => Boolean(one(world, "SELECT 1 ok FROM sqlite_master WHERE type='table' AND name=?", name));
const countIn = (world, table, where = "1=1", ...args) => hasTable(world, table) ? one(world, `SELECT COUNT(*) n FROM ${table} WHERE ${where}`, ...args).n : 0;
const status = (world, table, where, ...args) => one(world, `SELECT status FROM ${table} WHERE ${where}`, ...args)?.status;
const sweep = (world, asOf = AFTER_WINDOW, extra = {}) => runTrainingUnpaidExpirySweep(world.db, ENV, { asOf, ...extra });

/**
 * An unpaid Dog Training booking as the customer app leaves it before payment: the booking and its work
 * order in payment_pending, a prepaid payment row in 'created', no governed funding, and (unless it is a
 * programme-less Meet & Greet) the programme materialised - session 1 scheduled, the rest locked.
 */
async function seedUnpaid(world, { id = "B1", group = `G-${id}`, sessions = 4, dayBase = 0, provider = TRAINER, packageCode = "obedience-starter", packageName = "Obedience Starter", materialize = true, createdAt = null } = {}) {
  seedBooking(world, { id, group, sessions, dayBase, provider, packageCode, packageName, total: TOTAL, dueNow: TOTAL, governedPayment: false, status: "payment_pending" });
  world.sqlite.prepare("UPDATE booking_payments SET status='created',mode='prepaid' WHERE booking_id=?").run(id);
  world.sqlite.prepare("INSERT INTO provider_work_orders (id,booking_id,schedule_group_id,provider_id,provider_name,provider_model,service_code,scheduled_start,scheduled_end,occurrence_count,status,assignment_json,created_at,updated_at) VALUES (?,?,?,?,?,'full_time','dog_training',?,?,?,'payment_pending','{}',?,?)")
    .run(`WO-${id}`, id, group, provider, "Kiran", sessionStart(dayBase), sessionEnd(dayBase + sessions - 1), sessions, NOW, NOW);
  if (createdAt !== null) world.sqlite.prepare("UPDATE canonical_bookings SET created_at=? WHERE id=?").run(createdAt, id);
  if (materialize) await materializeTrainingBooking(world.db, { bookingId: id, actorId: "uat" });
  return id;
}

const sessionsOf = (world, bookingId) => rows(world, "SELECT id,status,sequence_no,schedule_reservation_id FROM training_sessions WHERE booking_id=? ORDER BY sequence_no", bookingId);
const reservationsOf = (world, bookingId) => rows(world, "SELECT id,status FROM scheduling_reservations WHERE group_id=(SELECT schedule_group_id FROM canonical_bookings WHERE id=?) ORDER BY occurrence_number", bookingId);

let orderSeq = 0;
/**
 * Razorpay's HTTP boundary. Order creation answers with a fresh order; an order's payments read answers
 * with `payments(orderId)` or fails with `readStatus`; a refund answers with a refund id. Anything else is
 * a test failure - no other outbound request is allowed.
 */
function razorpay(t) {
  const stub = { calls: [], readStatus: 200, payments: () => [] };
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const href = String(url), method = init.method || "GET", body = init.body ? JSON.parse(String(init.body)) : null;
    stub.calls.push({ href, method, body });
    if (href === "https://api.razorpay.com/v1/orders" && method === "POST") return Response.json({ id: `order_EXPIRY${++orderSeq}`, amount: body.amount, currency: body.currency, status: "created" });
    const read = /^https:\/\/api\.razorpay\.com\/v1\/orders\/(order_[A-Za-z0-9_]+)\/payments$/.exec(href);
    if (read) return stub.readStatus === 200 ? Response.json({ entity: "collection", items: stub.payments(read[1]) }) : Response.json({ error: { description: "provider unavailable" } }, { status: stub.readStatus });
    const refund = /^https:\/\/api\.razorpay\.com\/v1\/payments\/(pay_[A-Za-z0-9_]+)\/refund$/.exec(href);
    if (refund && method === "POST") return Response.json({ id: `rfnd_${refund[1].slice(4)}`, entity: "refund", amount: body.amount, payment_id: refund[1], status: "processed" });
    throw new Error(`unexpected outbound request ${method} ${href}`);
  });
  return stub;
}

/** Opens a real Razorpay order for the booking through the payment-order entry point (a checkout that was started). */
async function openOrder(world, bookingId) {
  const order = await createBookingPaymentOrder(world.db, ENV, { bookingId, customerId: CUSTOMER, actorId: CUSTOMER });
  assert.equal(order.connected, true, JSON.stringify(order));
  return one(world, "SELECT * FROM payment_intents WHERE booking_id=?", bookingId);
}

async function refusal(promise) {
  let caught = null;
  try { await promise; } catch (error) { caught = error; }
  assert.ok(caught instanceof Response, `expected a governed refusal, got ${caught?.message ?? caught}`);
  return { status: caught.status, body: await caught.json() };
}

/** A governed coupon campaign with a one-use-per-customer limit, and a quote priced for this customer. */
async function couponQuote(world, code = "TRAINEXPIRY") {
  if (!one(world, "SELECT 1 ok FROM sqlite_master WHERE type='table' AND name='coupon_campaigns'") || !one(world, "SELECT 1 ok FROM coupon_campaigns WHERE code=?", code)) {
    await coupons.saveCouponCampaign(world.db, {
      id: `CPN-${code}`, code, name: "Training expiry coupon", status: "active", serviceCodes: ["dog_training"], cityIds: ["blr"], channels: ["customer_app"],
      customerKinds: ["new", "existing", "subscriber"], packageScope: "all", packageCodes: [], crossSellFromServices: [], firstOrderOnly: false, minOrder: 0, maxOrder: null,
      subscriptionEligible: false, fullPaymentOnly: false, discountType: "fixed", discountValue: 500, maxDiscount: 500, perCustomerLimit: 1, totalLimit: 10,
      validFrom: Date.now() - DAY, validUntil: Date.now() + 30 * DAY,
    });
  }
  const quote = await coupons.quoteCoupon(world.db, { code, customerId: CUSTOMER, serviceCode: "dog_training", cityId: "blr", channel: "customer_app", packageCode: "obedience-starter", orderValue: TOTAL, paymentMode: "full", isSubscription: false });
  assert.equal(quote.valid, true, JSON.stringify(quote));
  return quote;
}
const prepareCoupon = (world, quote, bookingId) => coupons.prepareCouponBooking(world.db, {
  quoteId: quote.quoteId, bookingId, customerId: CUSTOMER, serviceCode: "dog_training", cityId: "blr", packageCode: "obedience-starter",
  submittedTotal: quote.finalAmount, submittedDiscount: quote.discount, idempotencyKey: `coupon:${bookingId}`, now: Date.now(),
});
/** Redeems the coupon inside a booking batch, exactly as app/api/canonical-bookings does. */
async function consumeCoupon(world, bookingId) {
  const prepared = await prepareCoupon(world, await couponQuote(world), bookingId);
  await world.db.batch([prepared.redemptionStatement, prepared.claimStatement]);
  assert.equal(status(world, "coupon_redemptions", "booking_id=?", bookingId), "consumed");
}

/** Every row the expiry writes for one booking, for replay and overlap comparisons. */
function footprint(world, bookingId) {
  return {
    markers: countIn(world, "training_unpaid_expiries", "booking_id=?", bookingId),
    lifecycleEvents: countIn(world, "booking_lifecycle_events", "booking_id=?", bookingId),
    notices: countIn(world, "booking_customer_notifications", "booking_id=?", bookingId),
    sessionEvents: countIn(world, "training_session_events", "booking_id=?", bookingId),
    programmeEvents: countIn(world, "training_programme_events", "booking_id=?", bookingId),
    messages: countIn(world, "communication_messages", "booking_id=?", bookingId),
    cancelledSessions: countIn(world, "training_sessions", "booking_id=? AND status='cancelled'", bookingId),
    cancelledReservations: countIn(world, "scheduling_reservations", "group_id=(SELECT schedule_group_id FROM canonical_bookings WHERE id=?) AND status='cancelled'", bookingId),
    heldLocks: countIn(world, "lifecycle_mutation_locks"),
  };
}

// --- 2. the 7-day trigger, and everything an expiry releases ------------------------------------------

test("an unpaid booking past its 7-day window is cancelled with its sessions, slots, offer, decision, split schedule, coupon and entitlement", async () => {
  const world = freshWorld(ENV);
  const id = await seedUnpaid(world);
  const [s1] = sessionsOf(world, id);
  // The customer asked to move session 1 (no payment gate on that action), which opened a reschedule case.
  await mutateTrainingSession(world.db, { sessionId: s1.id, action: "request_reschedule", actorId: `customer:${CUSTOMER}`, idempotencyKey: "rr-1", reason: "Customer is travelling that week" });
  assert.equal(countIn(world, "training_session_recovery_cases", "booking_id=? AND status='open'", id), 1);
  // Everything else the booking holds: a pending partner offer, the assignment decision, a manual job offer,
  // a Training split balance schedule, a consumed coupon and the customer's ₹300 recovery entitlement.
  await ensureProviderCapacityTables(world.db);
  world.sqlite.prepare("INSERT INTO provider_assignment_offers (group_id,booking_id,provider_id,status,offered_at,expires_at,attempt_no,updated_at) VALUES (?,?,?,'pending',?,?,1,?)").run(`G-${id}`, id, TRAINER, NOW, NOW + 30 * MIN, NOW);
  // DDL copied from lib/customer-live-tracking-schema.ts.
  world.sqlite.exec("CREATE TABLE IF NOT EXISTS scheduling_assignment_decisions (group_id TEXT PRIMARY KEY,strategy TEXT NOT NULL,shortlist_json TEXT NOT NULL,selected_provider_id TEXT,status TEXT NOT NULL,actor_id TEXT,reason TEXT,updated_at INTEGER NOT NULL)");
  world.sqlite.prepare("INSERT INTO scheduling_assignment_decisions (group_id,strategy,shortlist_json,selected_provider_id,status,actor_id,reason,updated_at) VALUES (?,'round_robin','[]',?,'assigned','system:scheduler','auto',?)").run(`G-${id}`, TRAINER, NOW);
  await ensureProviderWorkspaceTables(world.db);
  world.sqlite.prepare("INSERT INTO provider_job_offers (id,provider_id,booking_id,status,offered_at,expires_at,detail_json) VALUES (?,?,?,'offered',?,NULL,'{}')").run(`JO-${id}`, OTHER_TRAINER, id, NOW);
  await ensureStayPaymentTables(world.db);
  await staySplitScheduleStatement(world.db, { bookingId: id, serviceCode: "dog_training", customerId: CUSTOMER, totalAmount: TOTAL, paidNowAmount: TOTAL / 2, balanceAmount: TOTAL / 2, balanceDueAt: Date.parse(sessionStart(3)) }).run();
  await consumeCoupon(world, id);
  await issueRecoveryEntitlement(world.db, { customerId: CUSTOMER, bookingId: id, at: NOW });

  const report = await sweep(world);

  assert.equal(report.expired, 1, JSON.stringify(report));
  assert.deepEqual(report.expiredBookingIds, [id]);
  assert.deepEqual(report.errors, []);
  assert.equal(status(world, "canonical_bookings", "id=?", id), "cancelled");
  assert.equal(status(world, "provider_work_orders", "booking_id=?", id), "cancelled");
  const payment = one(world, "SELECT status,detail_json FROM booking_payments WHERE booking_id=?", id);
  assert.equal(payment.status, "cancelled", "checkout and the payment-order guard refuse a cancelled payment");
  assert.equal(JSON.parse(payment.detail_json).cancelReason, "training_payment_window_expired");
  assert.deepEqual({ ...one(world, "SELECT status,cancelled_sessions FROM training_programmes WHERE booking_id=?", id) }, { status: "cancelled", cancelled_sessions: 4 });
  assert.deepEqual(sessionsOf(world, id).map(s => s.status), ["cancelled", "cancelled", "cancelled", "cancelled"]);
  assert.deepEqual(reservationsOf(world, id).map(r => r.status), ["cancelled", "cancelled", "cancelled", "cancelled"], "'cancelled' is the only status that frees the trainer's slots");
  assert.equal(status(world, "provider_assignment_offers", "group_id=?", `G-${id}`), "cancelled");
  const decision = one(world, "SELECT status,actor_id,reason FROM scheduling_assignment_decisions WHERE group_id=?", `G-${id}`);
  assert.deepEqual({ ...decision }, { status: "cancelled", actor_id: ACTOR, reason: "training_payment_window_expired" });
  assert.equal(status(world, "provider_job_offers", "booking_id=?", id), "expired");
  assert.equal(status(world, "stay_payment_schedules", "booking_id=?", id), "cancelled", "the overdue-balance sweep must never chase a balance on an expired booking");
  assert.equal(status(world, "coupon_redemptions", "booking_id=?", id), "released");
  const entitlement = one(world, "SELECT status,cancel_reason FROM payment_recovery_entitlements WHERE booking_id=?", id);
  assert.deepEqual({ ...entitlement }, { status: "cancelled", cancel_reason: "booking_expired_unpaid" }, "no more 'Complete abandoned payment' outreach for a booking that cannot be paid");
  const recoveryCase = one(world, "SELECT status,detail_json FROM training_session_recovery_cases WHERE booking_id=?", id);
  assert.equal(recoveryCase.status, "resolved");
  assert.equal(JSON.parse(recoveryCase.detail_json).resolution, "booking_expired_unpaid");

  const marker = one(world, "SELECT * FROM training_unpaid_expiries WHERE booking_id=?", id);
  assert.equal(marker.trigger, "payment_window_elapsed");
  assert.equal(marker.policy_version, POLICY_VERSION);
  assert.equal(marker.window_ms, TRAINING_UNPAID_EXPIRY_MS);
  assert.ok(marker.programme_id && marker.credits_restored_at, "the programme is recorded and the post-commit steps completed");
  assert.equal(countIn(world, "training_unpaid_expiries"), 1);
  const events = rows(world, "SELECT id,event_type,actor_id,detail_json FROM booking_lifecycle_events WHERE booking_id=?", id);
  assert.equal(events.length, 1);
  assert.deepEqual([events[0].id, events[0].event_type, events[0].actor_id], [`training-unpaid-expiry:${id}`, TRAINING_UNPAID_EXPIRY_EVENT, ACTOR]);
  const detail = JSON.parse(events[0].detail_json);
  assert.equal(detail.trigger, "payment_window_elapsed");
  assert.equal(detail.windowMs, TRAINING_UNPAID_EXPIRY_MS);
  assert.equal(detail.sessionsReleased, 4);
  assert.equal(detail.reservationsReleased, 4);
  assert.equal(detail.collected, 0);
  assert.equal(detail.couponReleased, "TRAINEXPIRY");
  assert.equal(detail.refundEvaluation.customerRefundAmount, 0, "nothing was paid, so the recorded evaluation owes nothing");
  assert.equal(countIn(world, "booking_customer_notifications", "booking_id=?", id), 1);
  const sessionEvents = rows(world, "SELECT event_type,detail_json FROM training_session_events WHERE booking_id=? AND event_type='expired_unpaid'", id);
  assert.equal(sessionEvents.length, 4, "one expiry event per released session");
  assert.ok(sessionEvents.every(e => JSON.parse(e.detail_json).consumption === "not_consumed"), "an expired session is never counted as used");
  assert.equal(countIn(world, "lifecycle_mutation_locks"), 0, "the lifecycle lock is released");
});

// --- 3. the first-session trigger ---------------------------------------------------------------------

test("the first reserved session's start expires an unpaid booking before its 7 days are up", async () => {
  const world = freshWorld(ENV);
  const id = await seedUnpaid(world, { dayBase: -10 });
  const firstStart = Date.parse(sessionStart(-10));
  assert.ok(firstStart < NOW + TRAINING_UNPAID_EXPIRY_MS, "the fixture's first session falls inside the 7-day window");

  const early = await sweep(world, firstStart - MIN);
  assert.equal(early.expired, 0, "a minute before the session starts the customer can still pay");
  assert.equal(status(world, "canonical_bookings", "id=?", id), "payment_pending");

  const due = await sweep(world, firstStart);
  assert.equal(due.expired, 1, JSON.stringify(due));
  assert.equal(one(world, "SELECT trigger FROM training_unpaid_expiries WHERE booking_id=?", id).trigger, "first_session_start");
  const detail = JSON.parse(one(world, "SELECT detail_json FROM booking_lifecycle_events WHERE booking_id=?", id).detail_json);
  assert.equal(detail.trigger, "first_session_start");
  assert.equal(Date.parse(detail.firstSessionStart), firstStart);
  assert.equal(status(world, "canonical_bookings", "id=?", id), "cancelled");
});

// --- 4. no money moves ---------------------------------------------------------------------------------

test("an expiry moves no money: no refund, credit note, invoice number, consumption, earning or recovery case, and payment intents and gateway links are untouched", async (t) => {
  const world = freshWorld(ENV);
  const rz = razorpay(t);
  const id = await seedUnpaid(world);
  // The Finance tables exist, so "zero rows" below is a statement about them rather than about a missing table.
  await cancellation.ensureTrainingCancellationTables(world.db);
  await openOrder(world, id);
  const intentsBefore = rows(world, "SELECT * FROM payment_intents WHERE booking_id=?", id);
  const linksBefore = rows(world, "SELECT * FROM payment_gateway_links WHERE booking_id=?", id);
  const reconciliationBefore = rows(world, "SELECT * FROM payment_reconciliation_records WHERE booking_id=?", id);

  const report = await sweep(world);

  assert.equal(report.expired, 1, JSON.stringify(report));
  assert.equal(report.providerReads, 1, "the open order was checked with Razorpay before the booking was expired");
  assert.ok(rz.calls.some(call => call.method === "GET" && call.href.endsWith("/payments")), "the provider read happened");
  for (const table of ["training_refund_instructions", "training_credit_notes", "booking_refund_cases", "training_cancellation_cases", "training_session_consumptions", "training_session_earnings", "training_session_recovery_cases"]) {
    assert.ok(hasTable(world, table), `${table} exists`);
    assert.equal(countIn(world, table, "booking_id=?", id), 0, `${table} must stay empty`);
  }
  assert.equal(countIn(world, "training_finance_invoices", "booking_id=? AND invoice_number IS NOT NULL", id), 0, "no invoice is numbered");
  assert.deepEqual(rows(world, "SELECT * FROM payment_intents WHERE booking_id=?", id), intentsBefore, "the intent stays capturable, so a late payment is still recorded");
  assert.deepEqual(rows(world, "SELECT * FROM payment_gateway_links WHERE booking_id=?", id), linksBefore);
  assert.deepEqual(rows(world, "SELECT * FROM payment_reconciliation_records WHERE booking_id=?", id), reconciliationBefore);
  assert.equal(rz.calls.filter(call => call.href.endsWith("/refund")).length, 0, "no refund is requested at the gateway");
});

// --- 5. non-vacuity ------------------------------------------------------------------------------------

test("paid, funded, in-flight and started bookings are left exactly as they are while an eligible one expires beside them", async (t) => {
  const world = freshWorld(ENV);
  razorpay(t);
  await ensurePaymentReconciliationTables(world.db);
  // Inside the window: booked now, first session a fortnight away, swept a day later.
  const inside = await seedUnpaid(world, { id: "B-INSIDE", provider: OTHER_TRAINER });
  world.sqlite.prepare("UPDATE canonical_bookings SET created_at=? WHERE id=?").run(AFTER_WINDOW - DAY, inside);
  // Confirmed and captured, the harness default.
  seedBooking(world, { id: "B-CONFIRMED", group: "G-B-CONFIRMED", dayBase: 30 });
  // payment_pending, but the payment row already says captured (the webhook's first write landed).
  const capturedRow = await seedUnpaid(world, { id: "B-CAPTURED-ROW", dayBase: 40 });
  world.sqlite.prepare("UPDATE booking_payments SET status='captured' WHERE booking_id=?").run(capturedRow);
  // payment_pending with a reconciliation that already recorded captured money.
  const reconciled = await seedUnpaid(world, { id: "B-RECONCILED", dayBase: 50 });
  world.sqlite.prepare("INSERT INTO payment_reconciliation_records (payment_id,booking_id,gateway,environment,expected_amount,captured_amount,refunded_amount,currency,gateway_status,reconciliation_status,variance_amount,last_event_id,updated_at) VALUES (?,?,'razorpay','sandbox',?,?,0,'INR','captured','matched',0,'evt',?)").run(`PAY-${reconciled}`, reconciled, TOTAL, TOTAL, NOW);
  // payment_pending with an intent Razorpay already moved to CAPTURED.
  const capturedIntent = await seedUnpaid(world, { id: "B-INTENT-CAPTURED", dayBase: 60 });
  await openOrder(world, capturedIntent);
  world.sqlite.prepare("UPDATE payment_intents SET state='CAPTURED',updated_at=? WHERE booking_id=?").run(NOW, capturedIntent);
  // Sandbox-attested: the Training funding predicate counts it as paid, so the lifecycle would let it run.
  seedBooking(world, { id: "B-ATTESTED", group: "G-B-ATTESTED", dayBase: 70, status: "payment_pending", total: TOTAL, dueNow: TOTAL });
  world.sqlite.prepare("UPDATE booking_payments SET status='created' WHERE booking_id='B-ATTESTED'").run();
  // A session already moved on: accepted (written directly - the lifecycle refuses to accept an unpaid session)
  // and a staff no_show, which has no payment gate.
  const accepted = await seedUnpaid(world, { id: "B-ACCEPTED", dayBase: 80 });
  world.sqlite.prepare("UPDATE training_sessions SET status='accepted' WHERE booking_id=? AND sequence_no=1").run(accepted);
  const noShow = await seedUnpaid(world, { id: "B-NO-SHOW", dayBase: 90 });
  await mutateTrainingSession(world.db, { sessionId: sessionsOf(world, noShow)[0].id, action: "no_show", actorId: "ops:staff", idempotencyKey: "ns-1", reason: "Customer absent at the door", staffOverride: true });
  // A checkout started five minutes before the sweep.
  const inFlight = await seedUnpaid(world, { id: "B-IN-FLIGHT", dayBase: 100 });
  await openOrder(world, inFlight);
  world.sqlite.prepare("UPDATE payment_intents SET updated_at=? WHERE booking_id=?").run(AFTER_WINDOW - 5 * MIN, inFlight);
  // The one that should expire.
  const eligible = await seedUnpaid(world, { id: "B-ELIGIBLE", dayBase: 110 });

  const before = Object.fromEntries(["B-INSIDE", "B-CONFIRMED", capturedRow, reconciled, capturedIntent, "B-ATTESTED", accepted, noShow, inFlight].map(id => [id, { booking: status(world, "canonical_bookings", "id=?", id), payment: status(world, "booking_payments", "booking_id=?", id), sessions: sessionsOf(world, id).map(s => s.status), reservations: reservationsOf(world, id).map(r => r.status) }]));

  const report = await sweep(world);

  assert.deepEqual(report.expiredBookingIds, [eligible], JSON.stringify(report));
  assert.equal(report.skippedByReason.funded, 1, "the sandbox-attested booking is recognised as funded");
  for (const [id, state] of Object.entries(before)) {
    assert.deepEqual({ booking: status(world, "canonical_bookings", "id=?", id), payment: status(world, "booking_payments", "booking_id=?", id), sessions: sessionsOf(world, id).map(s => s.status), reservations: reservationsOf(world, id).map(r => r.status) }, state, `${id} must be untouched`);
    assert.equal(countIn(world, "training_unpaid_expiries", "booking_id=?", id), 0, `${id} has no expiry marker`);
  }
  assert.equal(status(world, "canonical_bookings", "id=?", eligible), "cancelled");
  // Called directly, each refusal says why.
  const direct = async (bookingId) => (await expireUnpaidTrainingBooking(world.db, ENV, { bookingId, asOf: AFTER_WINDOW })).reason;
  assert.equal(await direct(inFlight), "checkout_in_progress");
  assert.equal(await direct(accepted), "session_progressed");
  assert.equal(await direct(noShow), "session_progressed");
  assert.equal(await direct("B-ATTESTED"), "funded");
  assert.equal(await direct(capturedIntent), "captured");
  assert.equal(await direct(reconciled), "captured");
  assert.equal(await direct(capturedRow), "payment_not_expirable");
  assert.equal(await direct(inside), "not_due");
  assert.equal(await direct("B-CONFIRMED"), "funded");
});

// --- 6. a staff-cancelled session does not block expiry --------------------------------------------------

test("a booking with a session staff already cancelled still expires, and the cancel recovery case is resolved", async () => {
  const world = freshWorld(ENV);
  const id = await seedUnpaid(world);
  const cancelled = await mutateTrainingSession(world.db, { sessionId: sessionsOf(world, id)[0].id, action: "cancel_session", actorId: "ops:staff", idempotencyKey: "cs-1", reason: "UAT stale test data cleanup", staffOverride: true });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(countIn(world, "training_session_recovery_cases", "booking_id=? AND recovery_type='cancel' AND status='open'", id), 1);

  const report = await sweep(world);

  assert.equal(report.expired, 1, JSON.stringify(report));
  assert.deepEqual(sessionsOf(world, id).map(s => s.status), ["cancelled", "cancelled", "cancelled", "cancelled"]);
  assert.equal(one(world, "SELECT cancelled_sessions FROM training_programmes WHERE booking_id=?", id).cancelled_sessions, 4);
  assert.equal(countIn(world, "training_session_recovery_cases", "booking_id=? AND status='open'", id), 0, "the cancel case no longer inflates openRecovery");
  assert.equal(countIn(world, "training_session_events", "booking_id=? AND event_type='expired_unpaid'", id), 3, "only the three sessions the expiry released get an expiry event");
});

// --- 7. programme-less Meet & Greet --------------------------------------------------------------------

test("a programme-less Meet & Greet expires the same way and its customer is still told", async () => {
  const world = freshWorld(ENV);
  const id = await seedUnpaid(world, { id: "B-MEET", sessions: 1, packageCode: "trainer-meet-greet", packageName: "Trainer Meet & Greet", materialize: false });
  assert.equal(countIn(world, "training_programmes", "booking_id=?", id), 0);

  const report = await sweep(world);

  assert.equal(report.expired, 1, JSON.stringify(report));
  assert.equal(status(world, "canonical_bookings", "id=?", id), "cancelled");
  assert.deepEqual(reservationsOf(world, id).map(r => r.status), ["cancelled"]);
  assert.equal(one(world, "SELECT programme_id FROM training_unpaid_expiries WHERE booking_id=?", id).programme_id, null);
  const notice = one(world, "SELECT message FROM booking_customer_notifications WHERE booking_id=?", id);
  assert.equal(notice.message, trainingUnpaidExpiryNotice("Trainer Meet & Greet"));
  assert.match(notice.message, /\(Trainer Meet & Greet\)/);
});

// --- customer notice -----------------------------------------------------------------------------------

test("the customer's WhatsApp notice commits with the expiry, reads plainly, goes out as transactional, and nothing tells them a payment arrived", async () => {
  const world = freshWorld(ENV);
  const id = await seedUnpaid(world);

  await sweep(world);

  const notice = one(world, "SELECT * FROM booking_customer_notifications WHERE booking_id=?", id);
  assert.equal(notice.channel, "whatsapp");
  assert.equal(notice.template_code, TRAINING_UNPAID_EXPIRY_NOTICE_TEMPLATE);
  assert.equal(notice.event_id, `training-unpaid-expiry:${id}`, "the notice points at the lifecycle event it announces");
  assert.equal(notice.customer_id, CUSTOMER);
  assert.equal(notice.message, "Your PawSpace Dog Training booking (Obedience Starter) was not paid, so the trainer's sessions have been released. No money was taken. Any coupon, wallet credit or PawPoints you used on it have been returned to you. You can book again whenever you are ready.");
  assert.doesNotMatch(notice.message, /payment_pending|unpaid|expir|reservation|window|marker|sweep|refund|cancelled/i, "no internal terms");
  const messages = rows(world, "SELECT channel,purpose,template_key,payload_json FROM communication_messages WHERE booking_id=?", id);
  assert.equal(messages.length, 1, JSON.stringify(messages));
  assert.deepEqual([messages[0].channel, messages[0].purpose, messages[0].template_key], ["whatsapp", "transactional", TRAINING_UNPAID_EXPIRY_NOTICE_TEMPLATE]);
  assert.equal(JSON.parse(messages[0].payload_json).body, notice.message);

  // The order-notification sweep turns lifecycle events into customer messages and words any event type
  // containing "paid" as a received payment. The expiry's event must not be one of those.
  await runOrderNotificationSweep(world.db, { actorId: "test" });
  assert.equal(countIn(world, "order_notifications", "booking_id=? AND (event_type=? OR body LIKE '%received successfully%')", id, TRAINING_UNPAID_EXPIRY_EVENT), 0);
  assert.equal(countIn(world, "communication_messages", "booking_id=? AND payload_json LIKE '%received successfully%'", id), 0);
});

// --- 8. idempotent replay and overlapping runs -------------------------------------------------------

test("replaying the sweep, and two overlapping sweeps, leave exactly the rows of one expiry", async () => {
  const replay = freshWorld(ENV);
  const a = await seedUnpaid(replay);
  const first = await sweep(replay);
  const once = footprint(replay, a);
  const second = await sweep(replay);
  assert.equal(first.expired, 1);
  assert.equal(second.expired, 0);
  assert.deepEqual(footprint(replay, a), once, "a replay writes nothing");
  assert.deepEqual(once, { markers: 1, lifecycleEvents: 1, notices: 1, sessionEvents: 4, programmeEvents: 2, messages: 1, cancelledSessions: 4, cancelledReservations: 4, heldLocks: 0 });

  const overlap = freshWorld(ENV);
  const b = await seedUnpaid(overlap);
  const reports = await Promise.all([sweep(overlap), sweep(overlap)]);
  assert.equal(reports.reduce((sum, report) => sum + report.expired, 0), 1, JSON.stringify(reports));
  assert.deepEqual(footprint(overlap, b), once, "two overlapping runs leave the same rows as one");
});

// --- 9. money racing the expiry ------------------------------------------------------------------------

/*
 * The races the in-transaction predicate exists for. Each one lands between the sweep's checks and its
 * batch - the batch is wrapped, as a concurrent writer would interleave - and must turn the whole batch
 * into a no-op: a payment row the webhook marked captured, and a sandbox payment attestation (which the
 * Training funding predicate counts as paid).
 */
for (const [label, land] of [
  ["a capture", (world, id) => world.sqlite.prepare("UPDATE booking_payments SET status='captured' WHERE booking_id=?").run(id)],
  ["a sandbox payment attestation", (world, id) => seedGovernedPayment(world, { bookingId: id, total: TOTAL, captured: TOTAL, sessions: 4, mode: "prepaid" })],
]) {
  test(`${label} that commits between candidate selection and the expiry batch turns the batch into a no-op`, async () => {
    const world = freshWorld(ENV);
    const id = await seedUnpaid(world);
    assert.equal(status(world, "booking_payments", "booking_id=?", id), "created", "the fixture starts unpaid");
    const batch = world.db.batch;
    let raced = 0;
    world.db.batch = async (statements) => {
      if (statements.some(statement => /INSERT INTO training_unpaid_expiries/.test(statement.sql))) { raced++; land(world, id); }
      return batch(statements);
    };

    const report = await sweep(world);
    world.db.batch = batch;

    assert.equal(raced, 1, "the wrapper saw the expiry batch");
    assert.equal(report.expired, 0);
    assert.equal(report.skippedByReason.no_longer_expirable, 1, JSON.stringify(report));
    assert.equal(status(world, "canonical_bookings", "id=?", id), "payment_pending", "the paid booking is not cancelled");
    assert.notEqual(status(world, "booking_payments", "booking_id=?", id), "cancelled");
    assert.deepEqual(sessionsOf(world, id).map(s => s.status), ["scheduled", "locked", "locked", "locked"]);
    assert.deepEqual(reservationsOf(world, id).map(r => r.status), ["assigned", "assigned", "assigned", "assigned"]);
    for (const table of ["training_unpaid_expiries", "booking_lifecycle_events", "booking_customer_notifications"]) assert.equal(countIn(world, table, "booking_id=?", id), 0, `${table} has nothing`);
    assert.equal(countIn(world, "training_session_events", "booking_id=? AND event_type='expired_unpaid'", id), 0);
  });
}

// --- 10. the lifecycle lock ----------------------------------------------------------------------------

test("a booking whose lifecycle lock is held is skipped as lock_busy and expires on the next run", async () => {
  const world = freshWorld(ENV);
  const id = await seedUnpaid(world);
  let held;
  await withLifecycleMutationLock(world.db, { bookingId: id, actorId: "ops:staff", action: "reschedule" }, async () => { held = await sweep(world); });

  assert.equal(held.expired, 0);
  assert.equal(held.skippedByReason.lock_busy, 1, JSON.stringify(held));
  assert.equal(status(world, "canonical_bookings", "id=?", id), "payment_pending");
  assert.equal(one(world, "SELECT last_outcome FROM training_unpaid_expiry_checks WHERE booking_id=?", id).last_outcome, "lock_busy");

  const next = await sweep(world, AFTER_WINDOW + 5 * MIN);
  assert.equal(next.expired, 1, JSON.stringify(next));
  assert.equal(status(world, "canonical_bookings", "id=?", id), "cancelled");
});

// --- 11. starvation ------------------------------------------------------------------------------------

test("sixty older funded payment_pending bookings do not stop a newer eligible one from expiring in the first run", async () => {
  const world = freshWorld(ENV);
  for (let i = 0; i < 60; i++) {
    const id = `F-${String(i).padStart(2, "0")}`;
    seedBooking(world, { id, group: `G-${id}`, reservations: false, status: "payment_pending", total: TOTAL, dueNow: TOTAL });
    world.sqlite.prepare("UPDATE booking_payments SET status='created' WHERE booking_id=?").run(id);
    world.sqlite.prepare("UPDATE canonical_bookings SET created_at=? WHERE id=?").run(NOW - 30 * DAY + i * MIN, id);
  }
  const eligible = await seedUnpaid(world, { id: "B-NEWER", createdAt: NOW - 8 * DAY });

  const report = await sweep(world, NOW, { limit: 50 });

  assert.deepEqual(report.expiredBookingIds, [eligible], JSON.stringify({ ...report, skippedByReason: report.skippedByReason }));
  assert.equal(report.skippedByReason.funded, 60);
  assert.equal(countIn(world, "canonical_bookings", "id LIKE 'F-%' AND status='payment_pending'"), 60, "every funded booking is left alone");
});

// --- 12. slot release ----------------------------------------------------------------------------------

test("after expiry another customer can take the trainer's slot, which conflicted before", async () => {
  const world = freshWorld(ENV);
  const id = await seedUnpaid(world);
  await ensureSchedulingReservationLeaseGovernance(world.db);
  const sameWindow = { group: "G-NEXT-CUSTOMER", provider: TRAINER, customer: "cus_next", start: sessionStart(0), end: sessionEnd(0) };
  assert.throws(() => seedReservation(world, { id: "R-NEXT-1", ...sameWindow }), /UNIQUE constraint failed/, "the unpaid booking holds the slot");

  assert.equal((await sweep(world)).expired, 1);

  seedReservation(world, { id: "R-NEXT-2", ...sameWindow });
  assert.equal(status(world, "scheduling_reservations", "id=?", "R-NEXT-2"), "assigned");
  assert.equal(status(world, "scheduling_reservations", "id=?", `R-${id}-1`), "cancelled");
});

// --- 13. credits come back exactly once --------------------------------------------------------------

test("wallet principal and PawPoints spent on the booking are restored exactly once, even when a stale cancellation is approved later", async () => {
  const world = freshWorld(ENV);
  const id = await seedUnpaid(world);
  await wallet.creditWallet(world.db, { customerId: CUSTOMER, amount: 1000, source: "goodwill", idempotencyKey: "seed-wallet", note: "Test balance", actorId: "ops:staff" });
  await wallet.redeemWalletForBooking(world.db, { customerId: CUSTOMER, bookingId: id, walletAmount: 500, actorId: CUSTOMER });
  await points.grantGoodwillPoints(world.db, { customerId: CUSTOMER, points: 1000, reason: "Test PawPoints", actorId: "ops:staff", idempotencyKey: "seed-points" });
  await points.redeemPoints(world.db, { customerId: CUSTOMER, points: 400, bookingId: id, actorId: CUSTOMER });
  assert.equal(await wallet.walletBalance(world.db, CUSTOMER), 500);
  assert.equal(await points.pawPointsBalance(world.db, CUSTOMER), 600);
  // A cancellation the customer asked for before paying, never decided.
  await cancellation.saveTrainingCancellationPolicy(world.db, { cityId: "blr", feeType: "none", feeValue: 0, noShowTreatment: "chargeable", effectiveFrom: new Date().toISOString().slice(0, 10), reason: "Published for the expiry suite", actorId: "finance:maker" });
  const requested = await cancellation.requestTrainingCancellation(world.db, { bookingId: id, reason: "Customer changed plans before paying", idempotencyKey: "tc-credits", actorId: `customer:${CUSTOMER}` });
  assert.equal(requested.status, "calculated");

  const report = await sweep(world);

  assert.equal(report.expired, 1, JSON.stringify(report));
  assert.equal(await wallet.walletBalance(world.db, CUSTOMER), 1000, "the ₹500 wallet principal is back");
  assert.equal(await points.pawPointsBalance(world.db, CUSTOMER), 1000, "the 400 PawPoints are back");
  const credits = JSON.parse(one(world, "SELECT credits_json FROM training_unpaid_expiries WHERE booking_id=?", id).credits_json);
  assert.equal(credits.wallet.amountRestored, 500);
  assert.equal(credits.pawPoints.pointsRestored, 400);
  assert.deepEqual(credits.cancellationCases, [requested.caseId]);
  assert.equal(countIn(world, "training_cancellation_events", "case_id=? AND event_type='superseded_by_unpaid_expiry'", requested.caseId), 1);

  await sweep(world, AFTER_WINDOW + 10 * MIN);
  const approved = await cancellation.approveTrainingCancellation(world.db, { caseId: requested.caseId, reason: "Approving the earlier customer request", actorId: "finance:checker" });

  assert.equal(approved.status, "approved_no_refund");
  assert.equal(await wallet.walletBalance(world.db, CUSTOMER), 1000, "no second wallet credit");
  assert.equal(await points.pawPointsBalance(world.db, CUSTOMER), 1000, "no second PawPoints credit");
  assert.equal(countIn(world, "pawspace_wallet_ledger", "idempotency_key=?", `wallet-cancellation-restore:${id}`), 1);
  assert.equal(countIn(world, "paw_points_ledger", "idempotency_key=?", `restore:cancelled-booking:${id}`), 1);
});

test("a post-commit failure leaves the expiry committed, and the repair pass restores the credits once", async () => {
  const world = freshWorld(ENV);
  const id = await seedUnpaid(world);
  await wallet.creditWallet(world.db, { customerId: CUSTOMER, amount: 800, source: "goodwill", idempotencyKey: "seed-wallet", note: "Test balance", actorId: "ops:staff" });
  await wallet.redeemWalletForBooking(world.db, { customerId: CUSTOMER, bookingId: id, walletAmount: 300, actorId: CUSTOMER });
  const prepare = world.db.prepare;
  let failures = 0;
  world.db.prepare = (sql) => {
    if (failures === 0 && /INSERT INTO pawspace_wallet_ledger/.test(sql)) { failures++; throw new Error("simulated D1 outage"); }
    return prepare(sql);
  };

  const report = await sweep(world);
  world.db.prepare = prepare;

  assert.equal(failures, 1);
  assert.equal(report.expired, 1, "the expiry itself committed");
  assert.match(report.errors.join("\n"), /post-commit:simulated D1 outage/);
  assert.equal(one(world, "SELECT credits_restored_at FROM training_unpaid_expiries WHERE booking_id=?", id).credits_restored_at, null);
  assert.equal(await wallet.walletBalance(world.db, CUSTOMER), 500);

  const tooSoon = await sweep(world, AFTER_WINDOW + 30_000);
  assert.equal(tooSoon.repairs, 0, "an overlapping run never races the winner's own post-commit");
  const repaired = await sweep(world, AFTER_WINDOW + 5 * MIN);
  assert.equal(repaired.repairs, 1, JSON.stringify(repaired));
  assert.equal(await wallet.walletBalance(world.db, CUSTOMER), 800);
  assert.ok(one(world, "SELECT credits_restored_at FROM training_unpaid_expiries WHERE booking_id=?", id).credits_restored_at);
  await sweep(world, AFTER_WINDOW + 20 * MIN);
  assert.equal(await wallet.walletBalance(world.db, CUSTOMER), 800, "repairs never credit twice");
});

test("sessions a racing materialisation wrote after the expiry are cancelled by the repair pass", async () => {
  const world = freshWorld(ENV);
  const id = await seedUnpaid(world, { materialize: false });
  assert.equal((await sweep(world)).expired, 1);
  // What lib/training-programme.ts leaves behind when it read the booking before the expiry committed and
  // inserted after: a 'scheduled' programme with session 1 scheduled and the rest locked.
  world.sqlite.prepare("INSERT INTO training_programmes (id,booking_id,customer_id,provider_id,city_id,zone_id,plan_code,plan_name,pet_ids_json,status,total_sessions,created_at,updated_at) VALUES ('TP-LATE',?,?,?,'blr','blr-east','obedience-starter','Obedience Starter','[]','scheduled',2,?,?)").run(id, CUSTOMER, TRAINER, NOW, NOW);
  for (const [n, state] of [[1, "scheduled"], [2, "locked"]]) {
    world.sqlite.prepare("INSERT INTO training_sessions (id,programme_id,booking_id,schedule_reservation_id,sequence_no,provider_id,scheduled_start,scheduled_end,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(`TS-LATE-${n}`, "TP-LATE", id, `R-${id}-${n}`, n, TRAINER, sessionStart(n - 1), sessionEnd(n - 1), state, NOW, NOW);
  }

  const report = await sweep(world, AFTER_WINDOW + 5 * MIN);

  assert.equal(report.repairs, 1, JSON.stringify(report));
  assert.deepEqual(sessionsOf(world, id).map(s => s.status), ["cancelled", "cancelled"]);
  assert.deepEqual({ ...one(world, "SELECT status,cancelled_sessions FROM training_programmes WHERE id='TP-LATE'") }, { status: "cancelled", cancelled_sessions: 2 });
  assert.equal((await sweep(world, AFTER_WINDOW + 10 * MIN)).repairs, 0, "nothing is left to repair");
});

// --- 14. coupon limits ---------------------------------------------------------------------------------

test("the released coupon gives the customer their use back: the per-customer limit refuses before expiry and passes after", async () => {
  const world = freshWorld(ENV);
  const id = await seedUnpaid(world);
  const quoteForUnpaid = await couponQuote(world);
  const quoteForNext = await couponQuote(world);
  const prepared = await prepareCoupon(world, quoteForUnpaid, id);
  await world.db.batch([prepared.redemptionStatement, prepared.claimStatement]);

  await assert.rejects(prepareCoupon(world, quoteForNext, "B-NEXT"), /Customer coupon limit reached/, "the unpaid booking holds the customer's one use");

  assert.equal((await sweep(world)).expired, 1);

  const next = await prepareCoupon(world, quoteForNext, "B-NEXT");
  assert.equal(next.discount, 500, "the same customer can use the code on a new booking");
  assert.equal(status(world, "coupon_redemptions", "booking_id=?", id), "released");
  assert.equal(status(world, "coupon_quotes", "id=?", quoteForUnpaid.quoteId), "consumed", "the old quote stays spent; a new booking prices a new one");
});

// --- 15. late money ------------------------------------------------------------------------------------

test("money captured after expiry never revives the booking and is refunded once, through the governed policy", async (t) => {
  const world = freshWorld(ENV);
  const rz = razorpay(t);
  const id = await seedUnpaid(world);
  await cancellation.saveTrainingCancellationPolicy(world.db, { cityId: "blr", feeType: "none", feeValue: 0, noShowTreatment: "chargeable", effectiveFrom: new Date().toISOString().slice(0, 10), reason: "Published for the expiry suite", actorId: "finance:maker" });
  const stale = await cancellation.requestTrainingCancellation(world.db, { bookingId: id, reason: "Customer changed plans before paying", idempotencyKey: "tc-late", actorId: `customer:${CUSTOMER}` });
  const intent = await openOrder(world, id);
  assert.equal((await sweep(world)).expired, 1);

  // The customer pays the order that was open before the expiry.
  const committed = await commitRazorpayCaptureAtomic(world.db, {
    authority: "provider_api", eventId: "provider-api:capture:pay_LATE1", environment: "sandbox", intentId: intent.id, bookingId: id, paymentId: intent.payment_id,
    gatewayOrderId: intent.gateway_order_id, gatewayPaymentId: "pay_LATE1", amountPaise: intent.amount_paise, currency: "INR", payloadHash: "late-capture-hash",
  });
  const effects = await executeRazorpayCapturePostCommit(world.db, { outboxId: committed.effectsOutboxId, workerId: "late-capture-test" });
  assert.equal(effects.completed, true, JSON.stringify(effects));
  assert.equal(status(world, "canonical_bookings", "id=?", id), "cancelled", "a capture never revives an expired booking");
  assert.equal(status(world, "booking_payments", "booking_id=?", id), "captured", "the money is recorded");

  const asOf = AFTER_WINDOW + 5 * MIN;
  const report = await sweep(world, asOf);

  assert.equal(report.lateCaptureRefunds, 1, JSON.stringify(report));
  const refundCase = one(world, "SELECT * FROM booking_refund_cases WHERE booking_id=?", id);
  assert.equal(refundCase.id, "TUX-REFUND-pay_LATE1");
  assert.deepEqual([refundCase.status, refundCase.amount, refundCase.reason, refundCase.requested_by, refundCase.payment_id], ["requested", TOTAL, TRAINING_LATE_CAPTURE_REFUND_REASON, ACTOR, `PAY-${id}`]);
  const booking = one(world, "SELECT scheduled_start FROM canonical_bookings WHERE id=?", id);
  const expected = evaluateCancellationRefund(await resolveRefundPolicy(world.db, { serviceCode: "dog_training", cityId: "blr" }), { scheduledStart: booking.scheduled_start, bookingStatus: "cancelled", cancelledBy: "platform", amountPaid: TOTAL, now: asOf });
  assert.deepEqual(JSON.parse(refundCase.policy_json), JSON.parse(JSON.stringify(expected)), "the case carries the governed policy's own evaluation");
  assert.equal(expected.automatic, true);
  assert.equal(expected.requiresApproval, false);
  assert.equal(status(world, "booking_payments", "booking_id=?", id), "refund_pending");
  assert.equal(one(world, "SELECT late_capture_refund_case_id FROM training_unpaid_expiries WHERE booking_id=?", id).late_capture_refund_case_id, refundCase.id);
  assert.equal(countIn(world, "booking_lifecycle_events", "booking_id=? AND event_type=?", id, TRAINING_LATE_CAPTURE_EVENT), 1);

  const again = await sweep(world, asOf + 5 * MIN);
  assert.equal(again.lateCaptureRefunds, 0);
  assert.equal(countIn(world, "booking_refund_cases", "booking_id=?", id), 1, "a further sweep adds nothing");

  const refunds = await runAutomaticBookingRefundSweep(world.db, ENV, { asOf });
  assert.equal(refunds.initiated, 1, JSON.stringify(refunds));
  const gatewayRefunds = rz.calls.filter(call => call.href.endsWith("/refund"));
  assert.equal(gatewayRefunds.length, 1);
  assert.ok(gatewayRefunds[0].href.includes("/payments/pay_LATE1/"));
  assert.ok(gatewayRefunds[0].body.amount <= intent.amount_paise, "never more than was captured");
  assert.deepEqual({ ...one(world, "SELECT status,gateway_reference FROM booking_refund_cases WHERE id=?", refundCase.id) }, { status: "processing", gateway_reference: "rfnd_LATE1" });
  await runAutomaticBookingRefundSweep(world.db, ENV, { asOf: asOf + 5 * MIN });
  assert.equal(rz.calls.filter(call => call.href.endsWith("/refund")).length, 1, "the gateway is asked once");

  // Finance approves the request the customer made before paying. The payment reads refund_pending, so the
  // approval computes nothing captured: no second refund instruction for money already being returned.
  const approved = await cancellation.approveTrainingCancellation(world.db, { caseId: stale.caseId, reason: "Approving the earlier customer request", actorId: "finance:checker" });
  assert.equal(approved.status, "approved_no_refund");
  assert.equal(countIn(world, "training_refund_instructions", "booking_id=?", id), 0);
  assert.equal(status(world, "canonical_bookings", "id=?", id), "cancelled");
});

// --- 16. the provider pre-check ------------------------------------------------------------------------

test("an open order Razorpay reports captured confirms the booking instead of expiring it", async (t) => {
  const world = freshWorld(ENV);
  const rz = razorpay(t);
  const id = await seedUnpaid(world);
  const intent = await openOrder(world, id);
  rz.payments = (orderId) => [{ id: "pay_PRECHECK1", entity: "payment", order_id: orderId, status: "captured", captured: true, amount: intent.amount_paise, currency: "INR", notes: { booking_id: id, payment_id: intent.payment_id } }];

  const report = await sweep(world);

  assert.equal(report.expired, 0);
  assert.equal(report.skippedByReason.captured_at_provider, 1, JSON.stringify(report));
  assert.equal(status(world, "canonical_bookings", "id=?", id), "confirmed", "the normal capture path confirmed it");
  assert.equal(status(world, "booking_payments", "booking_id=?", id), "captured");
  assert.equal(countIn(world, "training_unpaid_expiries", "booking_id=?", id), 0);
  assert.deepEqual(sessionsOf(world, id).map(s => s.status), ["scheduled", "locked", "locked", "locked"]);
});

test("a provider read that fails leaves the booking alone this run, is counted, and the booking expires once Razorpay answers", async (t) => {
  const world = freshWorld(ENV);
  const rz = razorpay(t);
  const id = await seedUnpaid(world);
  await openOrder(world, id);
  rz.readStatus = 503;

  const failed = await sweep(world);

  assert.equal(failed.expired, 0);
  assert.equal(failed.skippedByReason.provider_unverifiable, 1, JSON.stringify(failed));
  assert.equal(failed.providerReads, 1);
  assert.equal(status(world, "canonical_bookings", "id=?", id), "payment_pending", "an unverified read never cancels a booking that may be paid");

  rz.readStatus = 200;
  const answered = await sweep(world, AFTER_WINDOW + 5 * MIN);
  assert.equal(answered.expired, 1, JSON.stringify(answered));
});

// --- 17. no new payment after expiry -------------------------------------------------------------------

test("an expired booking cannot open a payment order through the entry point, its route or the Sales link, while live balances still can", async (t) => {
  const world = freshWorld(ENV);
  const rz = razorpay(t);
  const id = await seedUnpaid(world);
  const stillUnpaid = await seedUnpaid(world, { id: "B-STILL-UNPAID", dayBase: 20, provider: OTHER_TRAINER, createdAt: AFTER_WINDOW - DAY });
  assert.deepEqual((await sweep(world)).expiredBookingIds, [id]);
  assert.equal(status(world, "canonical_bookings", "id=?", id), "cancelled");
  const ordersBefore = rz.calls.length;

  const direct = await refusal(createBookingPaymentOrder(world.db, ENV, { bookingId: id, customerId: CUSTOMER, actorId: CUSTOMER }));
  assert.deepEqual([direct.status, direct.body.code], [409, "booking_not_payable"]);
  const sales = await refusal(createCanonicalSalesPaymentLink(world.db, ENV, { bookingId: id, customerId: CUSTOMER, actorId: "sales@pawspace.in" }));
  assert.deepEqual([sales.status, sales.body.code], [409, "booking_not_payable"]);
  const cookie = await sessionCookie(world.db, "customer", CUSTOMER);
  const route = await routeCall(paymentOrderRoute.POST, "POST", "/api/payment-order", { body: { customerId: CUSTOMER, bookingId: id }, cookie });
  assert.equal(route.status, 409, JSON.stringify(route.body));
  assert.equal(route.body.code, "booking_not_payable");
  assert.equal(rz.calls.length, ordersBefore, "no gateway order was requested for the expired booking");

  // Non-vacuity: a booking still inside its window, a Pet Taxi balance after the trip and a confirmed
  // Training split balance all still open orders through the same entry point.
  assert.equal((await createBookingPaymentOrder(world.db, ENV, { bookingId: stillUnpaid, customerId: CUSTOMER, actorId: CUSTOMER })).connected, true);
  const insert = (bookingId, serviceCode, bookingStatus, amount, dueNow, paymentStatus = "captured") => {
    world.sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES (?,?,?,'[]','[]','blr','blr-east',?,'pkg','Package',?,?,?,?,?,'customer_app',?,'INR','{}','test',?,?)")
      .run(bookingId, `idem-${bookingId}`, CUSTOMER, serviceCode, `G-${bookingId}`, TRAINER, sessionStart(0), sessionEnd(0), bookingStatus, amount, NOW, NOW);
    world.sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,method,mode,status,idempotency_key,created_at,updated_at) VALUES (?,?,?,?,?,'upi','split',?,?,?,?)").run(`PAY-${bookingId}`, bookingId, CUSTOMER, amount, dueNow, paymentStatus, `payk-${bookingId}`, NOW, NOW);
  };
  // Each half of the guard on its own: an unpaid Boarding reservation the customer cancelled keeps its
  // payment row at 'created', and a confirmed booking can carry a partially refunded payment.
  insert("B-BOARDING-CANCELLED", "boarding", "cancelled", 6000, 6000, "created");
  insert("B-PART-REFUNDED", "grooming", "confirmed", 2000, 2000, "partially_refunded");
  for (const bookingId of ["B-BOARDING-CANCELLED", "B-PART-REFUNDED"]) {
    const refused = await refusal(createBookingPaymentOrder(world.db, ENV, { bookingId, customerId: CUSTOMER, actorId: CUSTOMER }));
    assert.deepEqual([refused.status, refused.body.code], [409, "booking_not_payable"], bookingId);
  }
  assert.equal(rz.calls.length, ordersBefore + 1, "only the still-unpaid booking reached the gateway");
  insert("B-TAXI", "pet_taxi", "completed", 1000, 500);
  await ensureTaxiRideTables(world.db);
  world.sqlite.prepare("INSERT INTO taxi_payment_schedules (booking_id,customer_id,total_amount,booking_fee_amount,balance_amount,status,created_at,updated_at) VALUES ('B-TAXI',?,1000,500,500,'pending_balance',?,?)").run(CUSTOMER, NOW, NOW);
  const taxi = await createBookingPaymentOrder(world.db, ENV, { bookingId: "B-TAXI", customerId: CUSTOMER, actorId: CUSTOMER });
  assert.deepEqual([taxi.connected, taxi.stage, taxi.amount], [true, "outstanding_balance", 500]);
  insert("B-SPLIT", "dog_training", "confirmed", TOTAL, TOTAL / 2);
  await ensureStayPaymentTables(world.db);
  await staySplitScheduleStatement(world.db, { bookingId: "B-SPLIT", serviceCode: "dog_training", customerId: CUSTOMER, totalAmount: TOTAL, paidNowAmount: TOTAL / 2, balanceAmount: TOTAL / 2, balanceDueAt: Date.parse(sessionStart(3)) }).run();
  const split = await createBookingPaymentOrder(world.db, ENV, { bookingId: "B-SPLIT", customerId: CUSTOMER, actorId: CUSTOMER });
  assert.deepEqual([split.connected, split.stage, split.amount], [true, "outstanding_balance", TOTAL / 2]);
});

// --- 18. scheduler wiring and cold databases ------------------------------------------------------------

const trainingTables = (sqlite) => sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'training%'").all().map(row => row.name);

test("the scheduler runs the sweep as 'trainingUnpaidExpiry': clean and table-free on a cold database, and it expires a seeded booking", async () => {
  const asOf = AFTER_WINDOW - (AFTER_WINDOW % (5 * MIN)) + 2 * MIN;
  // Fully cold.
  const cold = rawWorld(DB_GLOBAL, ENV_GLOBAL, ENV);
  assert.equal(await ensureTrainingUnpaidExpiryTables(cold.db), false, "nothing is created without canonical_bookings");
  const coldRun = await runBackgroundScheduler(cold.db, { actorId: "test", asOf });
  assert.deepEqual(coldRun.errors, []);
  assert.equal(coldRun.trainingUnpaidExpiry.skipped, true);
  assert.equal(coldRun.trainingUnpaidExpiry.reason, "schema_missing");
  assert.deepEqual(trainingTables(cold.sqlite), [], "no Training table or package seed on a cold database");

  // The alerting-hardening shape: canonical_bookings (a Boarding booking) and nothing else of the booking core.
  const partial = rawWorld(DB_GLOBAL, ENV_GLOBAL, ENV);
  partial.sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,source_pet_ids_json TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,service_code TEXT NOT NULL,package_code TEXT NOT NULL,package_name TEXT NOT NULL,schedule_group_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'confirmed',channel TEXT NOT NULL DEFAULT 'customer_app',total_amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',pricing_json TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  partial.sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,total_amount,created_by,created_at,updated_at) VALUES ('BK-1','bk-1','cus_1','[]','[]','blr','blr-east','boarding','pkg','Pkg','GRP-1','host_maya_rohan','2026-08-20','2026-08-22','confirmed',2500,'t',?,?)").run(NOW, NOW);
  const partialRun = await runBackgroundScheduler(partial.db, { actorId: "test", asOf });
  assert.deepEqual(partialRun.errors, []);
  assert.equal(partialRun.trainingUnpaidExpiry.skipped, true);
  assert.deepEqual(trainingTables(partial.sqlite), []);

  // The booking core with no Training booking in it still creates nothing.
  const noTraining = freshWorld(ENV);
  const direct = await runTrainingUnpaidExpirySweep(noTraining.db, ENV, { asOf });
  assert.deepEqual([direct.skipped, direct.processed, direct.expired], [false, 0, 0]);
  assert.deepEqual(trainingTables(noTraining.sqlite), []);

  // Seeded: the scheduled run expires the booking.
  const seeded = freshWorld(ENV);
  const id = await seedUnpaid(seeded);
  const run = await runBackgroundScheduler(seeded.db, { actorId: "test", asOf });
  assert.ok(!run.errors.some(error => error.startsWith("trainingUnpaidExpiry")), JSON.stringify(run.errors));
  assert.equal(run.trainingUnpaidExpiry.expired, 1, JSON.stringify(run.trainingUnpaidExpiry));
  assert.equal(status(seeded, "canonical_bookings", "id=?", id), "cancelled");
});

// --- 19. one window, three places -----------------------------------------------------------------------

test("the 7-day window equals the ₹300 recovery entitlement's lifetime and the staging cleanup's health-check threshold", async () => {
  const world = freshWorld(ENV);
  const issued = await issueRecoveryEntitlement(world.db, { customerId: CUSTOMER, bookingId: "B-ANY", at: NOW });
  assert.equal(issued.entitlement.expiresAt - issued.entitlement.issuedAt, TRAINING_UNPAID_EXPIRY_MS, "expiry ends the recovery play; it never cuts it short");
  assert.equal(UNPAID_REPORT_AFTER_MS, TRAINING_UNPAID_EXPIRY_MS);
  assert.equal(CHECKOUT_GRACE_MS, 15 * MIN);
});
