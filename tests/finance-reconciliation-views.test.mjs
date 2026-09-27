/**
 * Round-2 transactions audit: /team/finance listed Grooming bookings only (its ledger read service_code='grooming'),
 * and there was no reconciliation or exceptions screen - open over-collection and refund-overage exceptions and
 * captures stuck before they reached the books were visible only through the API.
 *
 * The money here is written by the platform's own code: Razorpay captures through the atomic capture commit and its
 * post-commit saga, a refused capture through the real webhook route, a refund through the real refund webhook. The
 * reads run through the real GET /api/payment-reconciliation on a NON-preview host, so finance.view is really checked,
 * and the Finance screens render what the route returned.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { installFinancialLifecycleSchema } from "./helpers/financial-lifecycle-schema.mjs";
import { createTransactionalChaosD1 } from "./helpers/transaction-chaos-harness.mjs";
import { asActor, seedActors } from "./helpers/execution-harness.mjs";

installWorkersHooks("__FINANCE_VIEWS_DB__", "__FINANCE_VIEWS_ENV__");

const route = await import("../app/api/payment-reconciliation/route.ts");
const webhook = await import("../app/api/razorpay-webhook/route.ts");
const atomic = await import("../lib/razorpay-capture-atomic.ts");
const reconciliation = await import("../lib/grooming-payment-reconciliation.ts");
const React = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const ledger = await import("../app/team/finance/finance-ledger.tsx");
const view = await import("../app/team/finance/reconciliation/reconciliation-workspace.tsx");

const SECRET = "whsec_finance_views_fixture";
const FINANCE = "finance.checker@pawspace.test";
const DESK = "care.desk@pawspace.test"; // associate: bookings.view, no finance.view

/** One booking per service, paid the way that service is paid, with the anomalies Finance has to see. */
async function world() {
  const h = createTransactionalChaosD1();
  installFinancialLifecycleSchema(h.sqlite);
  globalThis.__FINANCE_VIEWS_DB__ = h.db;
  globalThis.__FINANCE_VIEWS_ENV__ = { PAWSPACE_PAYMENT_ENV: "sandbox", RAZORPAY_WEBHOOK_SECRET_SANDBOX: SECRET };
  h.sqlite.exec(`CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,status TEXT NOT NULL,city_id TEXT,service_code TEXT,package_name TEXT,total_amount REAL,currency TEXT,scheduled_start TEXT,updated_at INTEGER);
    CREATE TABLE booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT,amount REAL NOT NULL,amount_due_now REAL,currency TEXT NOT NULL,method TEXT,mode TEXT,status TEXT NOT NULL,gateway TEXT,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER,updated_at INTEGER);
    CREATE TABLE stay_payment_schedules (booking_id TEXT PRIMARY KEY,service_code TEXT,customer_id TEXT,total_amount REAL,paid_now_amount REAL,balance_amount REAL,balance_due_at INTEGER,status TEXT,paid_at INTEGER,payment_ref TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE taxi_payment_schedules (booking_id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,total_amount REAL NOT NULL,booking_fee_amount REAL NOT NULL,balance_amount REAL NOT NULL,status TEXT NOT NULL DEFAULT 'booking_fee_pending',booking_fee_paid_at INTEGER,booking_fee_reference TEXT,final_paid_at INTEGER,final_payment_reference TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE booking_invoices (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,invoice_number TEXT NOT NULL UNIQUE,status TEXT NOT NULL DEFAULT 'draft',currency TEXT NOT NULL DEFAULT 'INR',gross_amount REAL NOT NULL,tax_amount REAL NOT NULL DEFAULT 0,net_amount REAL NOT NULL,issued_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE booking_refund_cases (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,payment_id TEXT,amount REAL NOT NULL DEFAULT 0,reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'requested',requested_by TEXT NOT NULL,approved_by TEXT,gateway_reference TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);`);
  const now = Date.now() - 30 * 60_000;
  const book = (id, service, total, dueNow, mode, minutesAgo) => {
    h.sqlite.prepare("INSERT INTO canonical_bookings VALUES (?,?,'confirmed','blr',?,?,?,'INR','2026-11-01T10:00:00.000Z',?)").run(id, `CUS-${id}`, service, `${service} package`, total, now + minutesAgo);
    h.sqlite.prepare("INSERT INTO booking_payments VALUES (?,?,?,?,?,'INR','upi',?,'created','razorpay_sandbox','{}',?,?)").run(`PAY-${id}`, id, `CUS-${id}`, total, dueNow, mode, now, now);
  };
  book("BK-BRD", "boarding", 499, 499, "prepaid", 1);
  book("BK-SIT", "pet_sitting", 2000, 1000, "split_50_50", 2);
  h.sqlite.prepare("INSERT INTO stay_payment_schedules VALUES ('BK-SIT','pet_sitting','CUS-BK-SIT',2000,1000,1000,?, 'pending_balance',NULL,NULL,?,?)").run(now + 86_400_000, now, now);
  book("BK-TAXI", "pet_taxi", 1000, 500, "split_50_50", 3);
  h.sqlite.prepare("INSERT INTO taxi_payment_schedules (booking_id,customer_id,total_amount,booking_fee_amount,balance_amount,status,created_at,updated_at) VALUES ('BK-TAXI','CUS-BK-TAXI',1000,500,500,'booking_fee_pending',?,?)").run(now, now);
  book("BK-GRM", "grooming", 1349, 1349, "prepaid", 4);
  book("BK-TRN", "dog_training", 1500, 1500, "prepaid", 5);
  await reconciliation.ensurePaymentReconciliationTables(h.db);
  await seedActors(h.sqlite, h.db, [{ id: "U-FIN", email: FINANCE, role: "finance" }, { id: "U-DESK", email: DESK, role: "associate" }]);

  const capture = async (bookingId, pay, rupees, { effects = true } = {}) => {
    const result = await atomic.commitRazorpayCaptureAtomic(h.db, {
      authority: "provider_api", eventId: `provider-api:capture:${pay}`, environment: "sandbox", intentId: null, bookingId, paymentId: `PAY-${bookingId}`,
      gatewayOrderId: `order_${pay}`, gatewayPaymentId: pay, amountPaise: Math.round(rupees * 100), currency: "INR", payloadHash: `hash-${pay}`,
    });
    if (effects && result.effectsOutboxId) await atomic.executeRazorpayCapturePostCommit(h.db, { outboxId: result.effectsOutboxId, workerId: `views-${pay}` });
    return result;
  };
  // Boarding: the same ₹499 stay paid twice (two checkout tabs) - over-collected.
  await capture("BK-BRD", "pay_brd_1", 499);
  await capture("BK-BRD", "pay_brd_2", 499);
  // Pet Sitting: the deposit of a 50/50 split. Pet Taxi: the 50% booking fee, whose post-commit work has not run.
  await capture("BK-SIT", "pay_sit_dep", 1000);
  await capture("BK-TAXI", "pay_taxi_fee", 500, { effects: false });
  h.sqlite.prepare("UPDATE financial_outbox SET created_at=? WHERE json_extract(payload_json,'$.bookingId')='BK-TAXI'").run(Date.now() - 20 * 60_000);
  // Grooming: paid, invoiced and refunded ₹300 through the gateway.
  await capture("BK-GRM", "pay_grm", 1349);
  h.sqlite.prepare("INSERT INTO booking_invoices VALUES ('INV-GRM','BK-GRM','CUS-BK-GRM','GRM-BLR-26-27-000001','issued_uat','INR',1349,0,1349,?,?,?)").run(now, now, now);
  h.sqlite.prepare("INSERT INTO booking_refund_cases VALUES ('RFD-GRM','BK-GRM','PAY-BK-GRM',300,'goodwill','approved','care@pawspace.test','finance@pawspace.test',NULL,?,?)").run(now, now);
  const refunded = await reconciliation.processGatewayEvent(h.db, { provider: "razorpay", environment: "sandbox", eventId: "evt_grm_refund", eventType: "refund.processed", bookingId: "BK-GRM",
    gatewayPaymentId: "pay_grm", gatewayRefundId: "rfnd_grm", amountSubunits: 30000, currency: "INR", signatureVerified: true, payloadHash: "sha256:grm-refund" });
  assert.equal(refunded.status, "processed", JSON.stringify(refunded));
  // A capture Razorpay took for an order no booking payment owns: refused by the real webhook route.
  const raw = JSON.stringify({ event: "payment.captured", created_at: Math.floor(Date.now() / 1000), payload: { payment: { entity: { id: "pay_stray", order_id: "order_stray", amount: 64900, currency: "INR", status: "captured", notes: { booking_id: "BK-GONE" } } } } });
  const stray = await webhook.POST(new Request("https://app.pawspace.in/api/razorpay-webhook", { method: "POST", headers: { "x-razorpay-event-id": "evt_stray", "x-razorpay-signature": createHmac("sha256", SECRET).update(raw).digest("hex") }, body: raw }));
  assert.equal(stray.status, 409);
  return h;
}

async function get(email, query) {
  const response = await route.GET(asActor(email, `/api/payment-reconciliation${query}`));
  return { status: response.status, body: await response.json() };
}
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

test("the Finance ledger lists every service's bookings with their payment state", async () => {
  const h = await world();
  try {
    const all = await get(FINANCE, "?view=bookings");
    assert.equal(all.status, 200, JSON.stringify(all.body));
    const { items, services, openExceptions } = all.body.data;
    assert.deepEqual(items.map((item) => item.serviceCode).sort(), ["boarding", "dog_training", "grooming", "pet_sitting", "pet_taxi"], "Boarding, Pet Sitting, Pet Taxi, Grooming and Training, not Grooming only");
    const row = Object.fromEntries(items.map((item) => [item.bookingId, item]));
    assert.deepEqual({ status: row["BK-BRD"].paymentStatus, captured: row["BK-BRD"].capturedAmount, recon: row["BK-BRD"].reconciliationStatus, variance: row["BK-BRD"].varianceAmount, open: row["BK-BRD"].openExceptions },
      { status: "captured", captured: 998, recon: "over_collected", variance: 499, open: 1 });
    assert.deepEqual({ recon: row["BK-SIT"].reconciliationStatus, schedule: row["BK-SIT"].scheduleStatus, balance: row["BK-SIT"].balanceAmount, captured: row["BK-SIT"].capturedAmount },
      { recon: "partially_captured", schedule: "pending_balance", balance: 1000, captured: 1000 });
    assert.deepEqual({ schedule: row["BK-TAXI"].scheduleStatus, captured: row["BK-TAXI"].capturedAmount }, { schedule: "pending_balance", captured: 500 });
    assert.deepEqual({ status: row["BK-GRM"].paymentStatus, refunded: row["BK-GRM"].refundedAmount, net: row["BK-GRM"].netCollected, invoice: row["BK-GRM"].invoiceNumber },
      { status: "partially_refunded", refunded: 300, net: 1049, invoice: "GRM-BLR-26-27-000001" });
    assert.deepEqual({ status: row["BK-TRN"].paymentStatus, captured: row["BK-TRN"].capturedAmount }, { status: "created", captured: null });
    const boarding = services.find((service) => service.code === "boarding");
    assert.deepEqual({ bookings: boarding.bookings, captured: boarding.captured, attention: boarding.attention }, { bookings: 1, captured: 998, attention: 1 });
    assert.equal(openExceptions, 2, "the over-collection and the refused capture");

    const taxi = await get(FINANCE, "?view=bookings&service=pet_taxi");
    assert.deepEqual(taxi.body.data.items.map((item) => item.bookingId), ["BK-TAXI"]);
    assert.equal((await get(FINANCE, "?view=bookings&service=walking_on_the_moon")).status, 400);
    assert.equal((await get(DESK, "?view=bookings")).status, 403, "finance.view is required");

    // The screen shows what the route returned.
    const html = renderToStaticMarkup(React.createElement(ledger.FinanceLedger, { data: all.body.data, loading: false, service: "", onService: () => {} }));
    for (const name of ["Boarding", "Pet Sitting", "Pet Taxi", "Grooming", "Training"]) assert.match(html, new RegExp(`>${name}<`), `${name} is on the Finance home`);
    for (const id of ["BK-BRD", "BK-SIT", "BK-TAXI", "BK-GRM", "BK-TRN"]) assert.ok(html.includes(id), id);
    assert.match(html, /href="\/team\/finance\/boarding\?bookingId=BK-BRD"/, "each booking opens in its service workspace");
    assert.match(text(html), /over collected 1 open exception\(s\)/);
    assert.match(text(html), /captured · 50\/50 split · balance ₹1,000\.00 due/, "a split stay shows what it still owes");
    assert.match(text(html), /2 open payment exception\(s\) need Finance review\. Open reconciliation & exceptions/);
  } finally { h.close(); }
});

test("the reconciliation view shows over-collection, refused and stuck captures for every service, read-only", async () => {
  const h = await world();
  try {
    const overview = await get(FINANCE, "?view=overview");
    assert.equal(overview.status, 200, JSON.stringify(overview.body));
    const data = overview.body.data;
    assert.deepEqual(data.exceptions.map((item) => item.type).sort(), ["over_collection", "unmatched_gateway_capture"]);
    assert.deepEqual(data.records.map((row) => [row.bookingId, row.serviceCode, row.reconciliationStatus, row.varianceAmount]), [["BK-BRD", "boarding", "over_collected", 499]]);
    const [stuck] = data.stuckCaptures.webhooks;
    assert.deepEqual({ event: stuck.eventId, status: stuck.status, reason: stuck.failureReason, amount: stuck.amount, booking: stuck.claimedBookingId, counted: stuck.captureRecorded },
      { event: "evt_stray", status: "FAILED", reason: "capture_has_no_canonical_payment_link", amount: 649, booking: "BK-GONE", counted: false });
    assert.deepEqual(data.stuckCaptures.effects.map((row) => [row.bookingId, row.gatewayPaymentId, row.amount]), [["BK-TAXI", "pay_taxi_fee", 500]]);
    assert.deepEqual({ ...data.summary }, { openExceptions: 2, criticalExceptions: 2, overCollected: 1, refundOverage: 0, needsAttention: 1, stuckWebhooks: 1, uncountedCaptures: 1, pendingCaptureEffects: 1 });
    assert.equal((await get(DESK, "?view=overview")).status, 403);

    // The existing exceptions read is unchanged.
    const plain = await get(FINANCE, "?status=open");
    assert.deepEqual(Object.keys(plain.body.data), ["exceptions"]);
    assert.equal(plain.body.data.exceptions.length, 2);
    assert.equal((await get(FINANCE, "?view=everything")).status, 400);

    const html = renderToStaticMarkup(React.createElement(view.PaymentReconciliationView, { data, status: "open", onStatus: () => {}, loading: false, error: "" }));
    const shown = text(html);
    assert.match(shown, /Over-collection \(paid more than the booking value\) critical BK-BRD PAY-BK-BRD booking value ₹499\.00 · captured ₹998\.00 · excess ₹499\.00 open/);
    assert.match(shown, /Capture no booking payment owns critical/);
    assert.match(shown, /evt_stray FAILED capture has no canonical payment link order_stray pay_stray ₹649\.00 BK-GONE No, not in the books/);
    assert.match(shown, /BK-TAXI pay_taxi_fee ₹500\.00/);
    assert.doesNotMatch(html, /<form|method="post"/i, "the view is read-only");
  } finally { h.close(); }
});

test("the Finance home and the reconciliation page are linked and framed", async () => {
  const home = await import("../app/team/finance/page.tsx");
  const homeHtml = renderToStaticMarkup(React.createElement(home.default));
  assert.match(homeHtml, /<h1[^>]*>Service finance &amp; reconciliation<\/h1>/);
  assert.match(homeHtml, /<a [^>]*href="\/team\/finance\/reconciliation"[^>]*>Reconciliation &amp; exceptions<\/a>/);
  for (const [href, name] of [["/team/finance/boarding", "Boarding finance"], ["/team/finance/sitting", "Pet Sitting finance"], ["/team/finance/taxi", "Pet Taxi finance"], ["/team/finance/training", "Training finance"]]) {
    assert.match(homeHtml, new RegExp(`<a [^>]*href="${href.replaceAll("/", "\\/")}"[^>]*>${name}<\\/a>`));
  }
  assert.match(homeHtml, /Loading bookings across services…/, "the all-services ledger is requested on arrival");

  const page = await import("../app/team/finance/reconciliation/page.tsx");
  const pageHtml = renderToStaticMarkup(React.createElement(page.default));
  assert.match(pageHtml, /<h1[^>]*>Payment reconciliation &amp; exceptions<\/h1>/);
  assert.match(pageHtml, /data-staff-module="true"/, "inside the shared staff frame");
  assert.match(pageHtml, /Loading payment exceptions and reconciliation…/);
  assert.match(pageHtml, /<a [^>]*href="\/team\/finance"[^>]*>Finance home<\/a>/);

  // It sits under the Finance workspace entry of the staff navigation, which finance.view already gates.
  const { activeStaffLink } = await import("../app/components/staff-workspace/navigation.ts");
  assert.equal(activeStaffLink("/team/finance/reconciliation"), "/team/finance");
});
