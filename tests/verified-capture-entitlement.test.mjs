import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

// ---------------------------------------------------------------------------
// PAY-002. The three defects the PAY-001 review found still open, all of them cases where LIVE money was
// recorded as collected without a gateway ever confirming it:
//
//   1. Subscriptions were EXEMPT from verify-first (`liveMode && !isSubscription && ...`). A LIVE booking
//      posting {method:"upi",status:"captured"} created customer_grooming_subscriptions with
//      status='active' and its sessions reserved — redeemable grooming sessions granted for one HTTP
//      request. The exemption existed because the purchase gate demanded a captured payment, so removing
//      it alone would have made subscriptions unbuyable; purchase and entitlement are now separate.
//
//   2. payStayBalance minted an `SBX-BAL-*` reference and moved the schedule to `paid` in EVERY
//      environment. In LIVE the second half of a 50/50 stay became settled money with no Razorpay order
//      and no charge: a ₹10,000 stay fully "paid" having collected ₹5,000.
//
//   3. linkGatewayOrder wrote payment_reconciliation_records.expected_amount from the full booking
//      amount while the order charged the stage amount, so Finance's own row contradicted the order at
//      the moment of creation.
//
// These run the REAL code: the canonical-bookings POST handler, the real gateway-event processor, the real
// subscription wallet and the real order-intent function, against a real SQLite database with the Razorpay
// HTTP call stubbed. No assertion here matches source text for behaviour — every claim about money is a
// row read back out of the database after the production code path wrote it.
// ---------------------------------------------------------------------------
installWorkersHooks("__PAY002_DB__", "__PAY002_ENV__");

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

function makeD1(sqlite) {
  const statement = (sql, args) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (list) => { const out = []; for (const item of list) out.push(await item.run()); return out; },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

/** A fresh isolate: new sqlite, new D1 binding (the libs memoise DDL on the binding object). */
function freshDb(env = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PAY002_DB__ = db;
  globalThis.__PAY002_ENV__ = env;
  return { sqlite, db };
}

const SCHEDULING_DDL = [
  "CREATE TABLE IF NOT EXISTS scheduling_assignment_decisions (group_id TEXT PRIMARY KEY,strategy TEXT NOT NULL,shortlist_json TEXT NOT NULL,selected_provider_id TEXT,status TEXT NOT NULL,actor_id TEXT,reason TEXT,updated_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS scheduling_reservations (id TEXT PRIMARY KEY,group_id TEXT NOT NULL,provider_id TEXT NOT NULL,service_code TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,capacity_units INTEGER NOT NULL DEFAULT 1,occurrence_number INTEGER NOT NULL DEFAULT 1,care_mode TEXT,status TEXT NOT NULL,explanation_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL)",
];

const START = "2026-11-04T09:00:00.000Z", END = "2026-11-04T11:00:00.000Z";

/** Seed the scheduling decision the booking POST requires before it will confirm anything. */
function seedScheduling(sqlite, groupId, providerId = "PRV-SUB-1") {
  for (const ddl of SCHEDULING_DDL) sqlite.exec(ddl);
  sqlite.prepare("INSERT INTO scheduling_assignment_decisions (group_id,strategy,shortlist_json,selected_provider_id,status,actor_id,reason,updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(groupId, "balanced", "[]", providerId, "assigned", "test", "seeded", Date.now());
  sqlite.prepare("INSERT INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,care_mode,status,explanation_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(`RES-${groupId}`, groupId, providerId, "grooming", "blr", "koramangala", "CUS-SUB-1", "[]", START, END, 1, 1, null, "reserved", "{}", Date.now());
}

/** The real subscription purchase, posted at the real route handler. */
function subscriptionRequest(overrides = {}) {
  const groupId = overrides.scheduleGroupId ?? "SG-SUB-1";
  return new Request("http://localhost/api/canonical-bookings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      idempotencyKey: overrides.idempotencyKey ?? "idem-sub-1",
      scheduleGroupId: groupId,
      customer: { id: "CUS-SUB-1", name: "Subscription buyer", primaryPhone: "+919000000001" },
      pets: [{ sourceId: "p1", name: "Rex", species: "dog" }],
      cityId: "blr", zoneId: "koramangala",
      serviceCode: "grooming", packageCode: "sub-3-dog", packageName: "3 sessions · Dog",
      scheduledStart: START, scheduledEnd: END,
      provider: { id: "PRV-SUB-1", name: "Groomer One", model: "full_time" },
      totalAmount: 3597, amountDueNow: 3597,
      payment: { method: "upi", mode: "prepaid", status: "captured", detail: "customer app", ...(overrides.payment ?? {}) },
      pricing: { discount: 0 },
    }),
  });
}

const sub = (sqlite) => sqlite.prepare("SELECT * FROM customer_grooming_subscriptions").get();
const usage = (sqlite) => sqlite.prepare("SELECT * FROM booking_subscription_usage").get();
const payment = (sqlite) => sqlite.prepare("SELECT * FROM booking_payments").get();

/** Post a LIVE subscription purchase and hand back everything needed to inspect the result. */
async function liveSubscriptionPurchase(opts = {}) {
  const { sqlite, db } = freshDb({ PAWSPACE_PAYMENT_ENV: "live" });
  seedScheduling(sqlite, opts.scheduleGroupId ?? "SG-SUB-1");
  const { POST } = await import("../app/api/canonical-bookings/route.ts");
  const response = await POST(subscriptionRequest(opts));
  return { sqlite, db, response, body: await response.json() };
}

// ---------------------------------------------------------------------------
// Defect 1 — the LIVE subscription verify-first bypass.
// ---------------------------------------------------------------------------

test("LIVE subscription + client 'captured' + no webhook: booking exists, entitlement does not", async () => {
  const { sqlite, response, body } = await liveSubscriptionPurchase();
  assert.equal(response.status, 201, `the purchase itself must still succeed: ${JSON.stringify(body)}`);

  // The payment was recorded awaiting verification, not captured.
  assert.equal(payment(sqlite).status, "created", "a LIVE online payment cannot self-declare capture");

  // And the entitlement is not usable by anybody.
  const subscription = sub(sqlite);
  assert.ok(subscription, "the purchase intent is recorded");
  assert.equal(subscription.status, "pending_payment", "no active entitlement before verified capture");
  assert.equal(Number(subscription.sessions_reserved), 0, "and no sessions reserved against it");
  assert.equal(usage(sqlite).status, "pending_payment");
  assert.equal(Number(usage(sqlite).sessions_reserved), 0);
});

test("LIVE subscription pending payment: the wallet refuses to move any credit", async () => {
  const { sqlite, db } = await liveSubscriptionPurchase();
  const subscriptionId = sub(sqlite).id, bookingId = sub(sqlite).source_booking_id;
  const { mutateSubscriptionWallet } = await import("../lib/subscription-wallet.ts");
  // This is the property that makes "pending_payment" real rather than decorative: the production wallet
  // path, not a status string comparison in the test.
  await assert.rejects(
    () => mutateSubscriptionWallet(db, { subscriptionId, bookingId, action: "reserve", credits: 1, idempotencyKey: "w-1", actorId: "test" }),
    (error) => /pending_payment/.test(error.message),
    "an unverified subscription must not be able to reserve a session",
  );
});

test("a forged or unknown payment mode does not buy an entitlement either", async () => {
  // Non-prepaid is refused outright: a subscription cannot be bought on a split or pay-later plan.
  for (const mode of ["split_50_50", "split", "full", "pay_after_service", "totally_made_up", ""]) {
    const { sqlite, response } = await liveSubscriptionPurchase({ payment: { mode }, idempotencyKey: `idem-${mode || "blank"}`, scheduleGroupId: "SG-SUB-1" });
    assert.equal(response.status, 409, `mode '${mode}' must not create a subscription`);
    assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM customer_grooming_subscriptions").get().c, 0, `mode '${mode}' left an entitlement behind`);
  }
  // And the one mode that IS allowed still cannot self-capture, whatever online method is used.
  for (const method of ["upi", "card", "netbanking", "payment_link"]) {
    const { sqlite, response } = await liveSubscriptionPurchase({ payment: { method } });
    assert.equal(response.status, 201);
    assert.equal(payment(sqlite).status, "created", `method '${method}' must await verification`);
    assert.equal(sub(sqlite).status, "pending_payment");
  }
});

/** A signature-verified Razorpay capture for a booking, as the webhook route would build it. */
const captureEvent = (bookingId, amount, eventId, type = "payment.captured") => ({
  provider: "razorpay", environment: "live", eventId, eventType: type, bookingId,
  gatewayPaymentId: `pay_${eventId}`, amountSubunits: Math.round(amount * 100), currency: "INR",
  signatureVerified: true, payloadHash: `hash_${eventId}`,
});

test("a verified matching webhook activates the entitlement exactly once", async () => {
  const { sqlite, db } = await liveSubscriptionPurchase();
  const bookingId = sub(sqlite).source_booking_id;
  const { processGatewayEvent } = await import("../lib/grooming-payment-reconciliation.ts");

  const first = await processGatewayEvent(db, captureEvent(bookingId, 3597, "evt-cap-1"));
  assert.equal(first.status, "processed");
  assert.equal(payment(sqlite).status, "captured");
  const active = sub(sqlite);
  assert.equal(active.status, "active", "the verified capture is what creates the usable entitlement");
  assert.equal(Number(active.sessions_reserved), 1, "the plan's reserved session is granted now, not at purchase");
  assert.equal(usage(sqlite).status, "reserved");
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM booking_lifecycle_events WHERE event_type='subscription_activated'").get().c, 1);

  // The wallet now works — the entitlement really is available, not just relabelled.
  const { readSubscriptionWallet } = await import("../lib/subscription-wallet.ts");
  const wallet = await readSubscriptionWallet(db, active.id);
  assert.equal(wallet.balances.total, 3);
  assert.equal(wallet.balances.reserved, 1);
  assert.equal(wallet.balances.available, 2);
});

test("a duplicate webhook creates no duplicate subscription and no duplicate sessions", async () => {
  const { sqlite, db } = await liveSubscriptionPurchase();
  const bookingId = sub(sqlite).source_booking_id;
  const { processGatewayEvent } = await import("../lib/grooming-payment-reconciliation.ts");
  await processGatewayEvent(db, captureEvent(bookingId, 3597, "evt-cap-1"));

  // Same event id replayed: rejected as a duplicate at the event log.
  const replay = await processGatewayEvent(db, captureEvent(bookingId, 3597, "evt-cap-1"));
  assert.equal(replay.duplicate, true);

  // A DIFFERENT event id reporting the same capture (Razorpay sends payment.captured and order.paid):
  // processed, but the guarded activation must not reserve a second session.
  const second = await processGatewayEvent(db, captureEvent(bookingId, 3597, "evt-cap-2", "order.paid"));
  assert.equal(second.status, "processed");
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM customer_grooming_subscriptions").get().c, 1);
  assert.equal(Number(sub(sqlite).sessions_reserved), 1, "a second capture event must not re-reserve sessions");
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM booking_subscription_usage").get().c, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM booking_lifecycle_events WHERE event_type='subscription_activated'").get().c, 1, "activated exactly once");
});

test("a verified payment failure leaves no usable subscription credits", async () => {
  const { sqlite, db } = await liveSubscriptionPurchase();
  const bookingId = sub(sqlite).source_booking_id, subscriptionId = sub(sqlite).id;
  const { processGatewayEvent } = await import("../lib/grooming-payment-reconciliation.ts");
  await processGatewayEvent(db, captureEvent(bookingId, 3597, "evt-fail-1", "payment.failed"));

  assert.equal(payment(sqlite).status, "failed");
  const failed = sub(sqlite);
  assert.equal(failed.status, "payment_failed");
  assert.equal(Number(failed.sessions_reserved), 0);
  const { mutateSubscriptionWallet } = await import("../lib/subscription-wallet.ts");
  await assert.rejects(
    () => mutateSubscriptionWallet(db, { subscriptionId, bookingId, action: "reserve", credits: 1, idempotencyKey: "w-f", actorId: "test" }),
    (error) => /payment_failed/.test(error.message),
  );
});

test("sandbox/UAT behaviour is unchanged and explicitly environment-gated", async () => {
  const { sqlite } = freshDb({ PAWSPACE_PAYMENT_ENV: "sandbox" });
  seedScheduling(sqlite, "SG-SUB-1");
  const { POST } = await import("../app/api/canonical-bookings/route.ts");
  const response = await POST(subscriptionRequest());
  assert.equal(response.status, 201);
  // In sandbox no money exists, so the UAT capture stands and the entitlement is active immediately —
  // exactly the behaviour testers rely on, and it must not regress into pending.
  assert.equal(payment(sqlite).status, "captured");
  assert.equal(sub(sqlite).status, "active");
  assert.equal(Number(sub(sqlite).sessions_reserved), 1);
  assert.equal(usage(sqlite).status, "reserved");

  // The gate is the environment variable and nothing else.
  assert.match(read("app/api/canonical-bookings/route.ts"), /PAWSPACE_PAYMENT_ENV/);
});

// ---------------------------------------------------------------------------
// PAY-002 delta — defect 1: the LIVE gate must fail CLOSED on the payment method. Keeping a submitted
// capture without gateway proof is a SERVER decision (payments.manage recording an offline collection),
// never something a client's method label can assert.
// ---------------------------------------------------------------------------

/** The subscription request body, so we can re-address it to any host/identity with a chosen method. */
async function bodyWith(method, status = "captured") {
  return await subscriptionRequest({ payment: { method, status } }).text();
}

test("LIVE: an arbitrary/unsupported method + submitted captured fails closed, even for a superuser", async () => {
  // localhost => development-preview superuser, which holds payments.manage. Even so, an off-list method
  // is not a server-authorized OFFLINE collection, so the capture is demoted and the subscription — which
  // needs a captured or online-awaiting payment — is refused. No credits are minted from a made-up label.
  const { sqlite } = freshDb({ PAWSPACE_PAYMENT_ENV: "live" });
  seedScheduling(sqlite, "SG-SUB-1");
  const { POST } = await import("../app/api/canonical-bookings/route.ts");
  const response = await POST(new Request("http://localhost/api/canonical-bookings", { method: "POST", headers: { "content-type": "application/json" }, body: await bodyWith("crypto") }));
  assert.equal(response.status, 409, "an unsupported method cannot self-declare a captured subscription purchase");
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM customer_grooming_subscriptions").get().c, 0, "and no entitlement is created");
});

test("LIVE: the authorized offline path (cash + payments.manage) keeps captured", async () => {
  // Same superuser, method 'cash': this IS a server-authorized offline collection, so the capture stands
  // and the entitlement activates — legitimate cash collection is not broken.
  const { sqlite } = freshDb({ PAWSPACE_PAYMENT_ENV: "live" });
  seedScheduling(sqlite, "SG-SUB-1");
  const { POST } = await import("../app/api/canonical-bookings/route.ts");
  const response = await POST(new Request("http://localhost/api/canonical-bookings", { method: "POST", headers: { "content-type": "application/json" }, body: await bodyWith("cash") }));
  assert.equal(response.status, 201, JSON.stringify(await response.json()));
  assert.equal(payment(sqlite).status, "captured", "a payments.manage actor may record an offline cash capture");
  assert.equal(sub(sqlite).status, "active", "and the entitlement is active");
  assert.equal(Number(sub(sqlite).sessions_reserved), 1);
});

test("LIVE: the SAME cash capture is demoted for a caller without payments.manage — authorization decides, not the method", async () => {
  // A real workspace identity (non-preview host) whose role lacks payments.manage. The identical cash +
  // captured request that a superuser could keep is demoted here, so the subscription is refused. This is
  // what makes the offline path server-authorized rather than a client-controlled 'cash' spelling.
  const { sqlite, db } = freshDb({ PAWSPACE_PAYMENT_ENV: "live" });
  seedScheduling(sqlite, "SG-SUB-1");
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db);
  const now = Date.now(), email = "desk.agent@pawspace.test";
  sqlite.prepare("INSERT OR REPLACE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(`U:${email}`, email, "Desk Agent", "associate", "active", now, now);
  sqlite.prepare("INSERT OR REPLACE INTO customer_identity_links (email,customer_id,status,verified_at,updated_at) VALUES (?,?,?,?,?)").run(email, "CUS-SUB-1", "active", now, now);
  const { POST } = await import("../app/api/canonical-bookings/route.ts");
  // Confirm the resolved actor is genuine and unprivileged (never the preview superuser).
  const { resolveActor } = await import("../lib/server-auth.ts");
  const actor = await resolveActor(new Request("https://app.pawspace.in/x", { headers: { "oai-authenticated-user-email": email } }));
  assert.equal(actor.roleCode, "associate");
  assert.equal(actor.developmentPreview, false);
  assert.ok(!actor.permissions.includes("*") && !actor.permissions.includes("payments.manage"), "the actor must not hold payments.manage");
  const response = await POST(new Request("https://app.pawspace.in/api/canonical-bookings", { method: "POST", headers: { "content-type": "application/json", "oai-authenticated-user-email": email }, body: await bodyWith("cash") }));
  assert.equal(response.status, 409, "cash + captured from an unauthorized caller is demoted, so the subscription is refused");
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM customer_grooming_subscriptions").get().c, 0, "and no entitlement is created");
});

// ---------------------------------------------------------------------------
// PAY-002 delta — defect 2: the subscription transition must be atomic and safely retryable. A
// dependent-write failure must not half-apply it or permanently strand it; a replay must repair it
// without double-granting. Verified with a TRANSACTIONAL D1 shim (batch = one transaction) and an
// injectable fault on a dependent write.
// ---------------------------------------------------------------------------

/** A D1 shim whose batch() is a real transaction, with a fault that can be injected on a chosen write. */
function faultDb(env) {
  const sqlite = new DatabaseSync(":memory:");
  const faults = { patterns: [] };
  const stmt = (sql, args) => ({
    bind: (...bound) => stmt(sql, bound),
    first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
    run: async () => {
      if (faults.patterns.some((p) => sql.includes(p))) throw new Error(`injected fault on: ${sql.slice(0, 48)}`);
      const info = sqlite.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(info.changes) } };
    },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  const db = {
    prepare: (sql) => stmt(sql, []),
    batch: async (list) => {
      sqlite.exec("BEGIN");
      try { const out = []; for (const item of list) out.push(await item.run()); sqlite.exec("COMMIT"); return out; }
      catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
  globalThis.__PAY002_DB__ = db;
  globalThis.__PAY002_ENV__ = env;
  return { sqlite, db, faults };
}

const activatedCount = (sqlite) => Number(sqlite.prepare("SELECT COUNT(*) c FROM booking_lifecycle_events WHERE event_type='subscription_activated'").get().c);
const capturedAmount = (sqlite, bookingId) => { const r = sqlite.prepare("SELECT captured_amount FROM payment_reconciliation_records WHERE booking_id=?").get(bookingId); return r ? Number(r.captured_amount) : 0; };
/** A capture with EXPLICIT references, so a redelivery can share them (the same underlying capture). */
const refCapture = ({ bookingId, eventId, payId, orderId, amount = 3597, type = "payment.captured" }) => ({
  provider: "razorpay", environment: "live", eventId, eventType: type, bookingId,
  gatewayPaymentId: payId, gatewayOrderId: orderId, amountSubunits: Math.round(amount * 100),
  currency: "INR", signatureVerified: true, payloadHash: `hash_${eventId}`,
});

test("retry: a transiently failed activation is repaired by EXACT-eventId gateway redelivery, exactly once, with no money recounted", async () => {
  const { sqlite, db, faults } = faultDb({ PAWSPACE_PAYMENT_ENV: "live" });
  seedScheduling(sqlite, "SG-SUB-1");
  const { POST } = await import("../app/api/canonical-bookings/route.ts");
  assert.equal((await POST(subscriptionRequest())).status, 201);
  const bookingId = sub(sqlite).source_booking_id;
  const { processGatewayEvent } = await import("../lib/grooming-payment-reconciliation.ts");
  const CAP = { bookingId, eventId: "evt-cap-X", payId: "pay-X", orderId: "ord-X", amount: 3597 };

  // First verified capture with the activation batch failing atomically.
  faults.patterns = ["UPDATE booking_subscription_usage"];
  const first = await processGatewayEvent(db, refCapture(CAP));
  assert.equal(first.status, "processed");
  // Payment capture financial state is correct and intact...
  assert.equal(payment(sqlite).status, "captured", "the payment itself is captured");
  const capturedAfterFirst = capturedAmount(sqlite, bookingId);
  assert.equal(capturedAfterFirst, 3597, "captured_amount reflects the real capture");
  // ...while the subscription rolled back to pending.
  assert.equal(sub(sqlite).status, "pending_payment", "the entitlement stays pending after the transient failure");
  assert.equal(activatedCount(sqlite), 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM payment_reconciliation_exceptions WHERE exception_type='subscription_activation_failed'").get().c, 1);

  // The gateway redelivers the EXACT SAME event id (its own retry). It is a duplicate for money, but it
  // completes the subscription transition.
  faults.patterns = [];
  const redeliver = await processGatewayEvent(db, refCapture(CAP));
  assert.equal(redeliver.duplicate, true, "money-wise it is a duplicate — nothing is re-processed");
  assert.equal(sub(sqlite).status, "active", "but the pending entitlement is now repaired");
  assert.equal(Number(sub(sqlite).sessions_reserved), 1, "exactly one session reserved");
  assert.equal(usage(sqlite).status, "reserved");
  assert.equal(activatedCount(sqlite), 1, "activated exactly once");
  assert.equal(capturedAmount(sqlite, bookingId), capturedAfterFirst, "captured_amount is unchanged by the repair");

  // Further exact redeliveries are true no-ops.
  await processGatewayEvent(db, refCapture(CAP));
  assert.equal(Number(sub(sqlite).sessions_reserved), 1, "still one — never double-granted");
  assert.equal(activatedCount(sqlite), 1);
  assert.equal(capturedAmount(sqlite, bookingId), capturedAfterFirst);
});

test("retry: a fresh notification for the SAME underlying capture also repairs the entitlement, without increasing captured_amount", async () => {
  const { sqlite, db, faults } = faultDb({ PAWSPACE_PAYMENT_ENV: "live" });
  seedScheduling(sqlite, "SG-SUB-1");
  const { POST } = await import("../app/api/canonical-bookings/route.ts");
  assert.equal((await POST(subscriptionRequest())).status, 201);
  const bookingId = sub(sqlite).source_booking_id;
  const { processGatewayEvent } = await import("../lib/grooming-payment-reconciliation.ts");

  // payment.captured fails the activation; the money is recorded once.
  faults.patterns = ["UPDATE booking_subscription_usage"];
  await processGatewayEvent(db, refCapture({ bookingId, eventId: "evt-pc", payId: "pay-Y", orderId: "ord-Y", amount: 3597 }));
  assert.equal(sub(sqlite).status, "pending_payment");
  const capturedOnce = capturedAmount(sqlite, bookingId);
  assert.equal(capturedOnce, 3597);

  // order.paid for the SAME capture (shares the order reference) — a repeat for money, so captured_amount
  // must NOT grow, but it repairs the pending entitlement.
  faults.patterns = [];
  const fresh = await processGatewayEvent(db, refCapture({ bookingId, eventId: "evt-op", payId: "pay-Y", orderId: "ord-Y", amount: 3597, type: "order.paid" }));
  assert.equal(fresh.reason, "capture_already_collected", "the same money is recognised as already collected");
  assert.equal(capturedAmount(sqlite, bookingId), capturedOnce, "captured_amount is NOT increased by the repair notification");
  assert.equal(sub(sqlite).status, "active", "and the entitlement is repaired");
  assert.equal(Number(sub(sqlite).sessions_reserved), 1);
  assert.equal(activatedCount(sqlite), 1, "activated exactly once");
});

test("retry: a transiently failed payment-failure close is repaired by EXACT-eventId redelivery, leaving zero usable credits", async () => {
  const { sqlite, db, faults } = faultDb({ PAWSPACE_PAYMENT_ENV: "live" });
  seedScheduling(sqlite, "SG-SUB-1");
  const { POST } = await import("../app/api/canonical-bookings/route.ts");
  assert.equal((await POST(subscriptionRequest())).status, 201);
  const bookingId = sub(sqlite).source_booking_id, subscriptionId = sub(sqlite).id;
  const { processGatewayEvent } = await import("../lib/grooming-payment-reconciliation.ts");
  const FAIL = { bookingId, eventId: "evt-fail-X", payId: "pay-F", orderId: "ord-F", amount: 3597, type: "payment.failed" };

  faults.patterns = ["UPDATE booking_subscription_usage"];
  await processGatewayEvent(db, refCapture(FAIL));
  assert.equal(sub(sqlite).status, "pending_payment", "the transient failure must not half-close the entitlement");
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM payment_reconciliation_exceptions WHERE exception_type='subscription_failure_recording_failed'").get().c, 1);

  // Exact-eventId redelivery repairs the closure.
  faults.patterns = [];
  const redeliver = await processGatewayEvent(db, refCapture(FAIL));
  assert.equal(redeliver.duplicate, true);
  assert.equal(sub(sqlite).status, "payment_failed", "the redelivery completes the closure");
  assert.equal(Number(sub(sqlite).sessions_reserved), 0, "no usable sessions");
  const { mutateSubscriptionWallet } = await import("../lib/subscription-wallet.ts");
  await assert.rejects(
    () => mutateSubscriptionWallet(db, { subscriptionId, bookingId, action: "reserve", credits: 1, idempotencyKey: "wf", actorId: "test" }),
    (error) => /payment_failed/.test(error.message),
    "a failed subscription can never reserve a credit",
  );
});
