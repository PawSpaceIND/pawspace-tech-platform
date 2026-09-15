/*
 * The Grooming finance ledger reported Rs 0 captured and the full amount receivable for payments the
 * same row showed as captured. [FIN-W1-D4]
 *
 * Observed on the seeded book: "Invoiced Rs 0 · Captured Rs 0 · Refunded Rs 0 · Receivable Rs 9,594"
 * over rows reading "UATD-BK-GROOM-1 ... Payment: captured ... Captured Rs 0", while booking_payments
 * held nine captured rows totalling Rs 20,793. The route read `captured` from
 * payment_reconciliation_records.captured_amount through a LEFT JOIN and derived
 * `receivable = max(0, payment_amount - captured)`; payment_reconciliation_records is empty, so every
 * captured payment counted as nothing collected and 100% owed.
 *
 * The finding is NOT that the table is empty - it is that a *reconciled* captured figure was labelled
 * plain *Captured*, and an assurance gap was labelled *Receivable*, i.e. money an operator believed a
 * customer still owed. These tests drive the REAL route handler and assert what the operator is told.
 *
 * The D1 shim here is the shared counting harness with ONE correction: real D1 returns a result set
 * for every statement in a batch, and the shared shim only models writes. This route reads its ledger
 * through db.batch([...]) - the batching lib/uat-scheduling-d1-contention pins - so without that
 * correction the ledger would read as empty and the suite would assert nothing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";
import { installWorkersHooks, enterWorkersDbScope } from "./helpers/module-hooks.mjs";
import { seedActors, asActor, ORIGIN } from "./helpers/execution-harness.mjs";

installWorkersHooks("__GROOM_FIN_TRUTH_DB__", "__GROOM_FIN_TRUTH_ENV__");

const FINANCE = "finance@pawspace.test";
const NOW = Date.UTC(2026, 7, 20);

/** freshCountingD1, with batch returning each statement's rows the way real D1 does. */
function batchReadingD1() {
  const harness = freshCountingD1();
  const db = {
    ...harness.db,
    batch: async (list) => Promise.all(list.map((statement) => (/^\s*SELECT/i.test(statement.sql) ? statement.all() : statement.run()))),
  };
  return { ...harness, db };
}

async function financeWorld() {
  const w = batchReadingD1();
  enterWorkersDbScope(w.db);
  globalThis.__GROOM_FIN_TRUTH_DB__ = w.db;
  globalThis.__GROOM_FIN_TRUTH_ENV__ = { PAWSPACE_PAYMENT_ENV: "sandbox", PAWSPACE_PAYMENT_LIVE_APPROVED: "false" };
  await seedActors(w.sqlite, w.db, [{ id: "USR-FIN", email: FINANCE, role: "finance" }]);
  // Let the route provision its OWN schema the way a cold D1 would, rather than guessing the DDL here.
  const empty = await ledger(w);
  assert.equal(empty.summary.bookings, 0);
  assert.equal(Number(w.sqlite.prepare("SELECT COUNT(*) c FROM payment_reconciliation_records").get().c), 0);
  return w;
}

/** One grooming booking + its payment, exactly as the canonical checkout writes them. */
function booking(w, { id, amount, paymentStatus, bookingStatus = "completed" }) {
  w.sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES (?,?,?,'[]','[]','blr','blr-east','grooming','dog-basic','Bath & Basic',?,'groom_arun',?,?,?,'customer_app',?,'INR','{}','test',?,?)")
    .run(id, `idem-${id}`, "CUS-1", `sg-${id}`, new Date(NOW).toISOString(), new Date(NOW + 3_600_000).toISOString(), bookingStatus, amount, NOW, NOW);
  w.sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,currency,method,mode,status,gateway,idempotency_key,detail_json,created_at,updated_at) VALUES (?,?,?,?,?,'INR','upi','prepaid',?,'uat_sandbox',?,'{}',?,?)")
    .run(`PAY-${id}`, id, "CUS-1", amount, amount, paymentStatus, `pay-idem-${id}`, NOW, NOW);
  return `PAY-${id}`;
}

async function ledger(w) {
  const { GET } = await import("../app/api/grooming-finance/route.ts");
  const response = await GET(asActor(FINANCE, "/api/grooming-finance"));
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

test("D4: captured payments are reported as captured, not as a receivable", async () => {
  const w = await financeWorld();
  // The seeded shape: captured money on the payment ledger, and a reconciliation table with no rows.
  const captured = [1366, 1366, 1366];
  captured.forEach((amount, index) => booking(w, { id: `UATD-BK-GROOM-${index + 1}`, amount, paymentStatus: "captured" }));
  booking(w, { id: "UATD-BK-GROOM-OPEN", amount: 799, paymentStatus: "created", bookingStatus: "confirmed" });
  assert.equal(Number(w.sqlite.prepare("SELECT COUNT(*) c FROM payment_reconciliation_records").get().c), 0,
    "the reconciliation ledger really is empty - that is the condition under test (the table exists, nothing wrote to it)");

  const body = await ledger(w);
  const total = captured.reduce((sum, value) => sum + value, 0);

  assert.equal(body.summary.collected, total, "Captured must be the money the payment ledger says arrived");
  assert.equal(body.summary.receivable, 799, "Receivable is the ONE payment that was never captured, not all four");
  assert.equal(body.summary.capturedPerPaymentLedger, total);
  assert.equal(body.summary.capturedPerReconciliation, 0, "and the reconciled figure is still honestly zero");
  assert.equal(body.summary.capturedAwaitingReconciliation, total, "reported as an assurance gap, not as money owed");
  assert.equal(body.summary.paymentsWithReconciliationRecord, 0);
  assert.equal(body.summary.unreconciled, 4);

  for (const item of body.items) {
    const isCaptured = String(item.payment_status) === "captured";
    assert.equal(Number(item.captured_amount), isCaptured ? Number(item.payment_amount) : 0,
      `${item.booking_id}: the Captured column must not contradict the Payment column on its own row`);
    assert.equal(Number(item.receivable), isCaptured ? 0 : Number(item.payment_amount));
    assert.equal(item.reconciled_captured_amount, null, "no reconciliation record means null, never a silent 0");
    assert.equal(String(item.captured_basis), "booking_payments.status+amount");
  }
  // The source switch is declared, not silent.
  assert.match(String(body.source), /booking_payments/);
  assert.match(String(body.basis.collected), /booking_payments/);
  assert.match(String(body.basis.receivable), /NOT money awaiting reconciliation/);
  assert.match(String(body.basis.capturedPerReconciliation), /payment_reconciliation_records/);
});

test("D4: once reconciliation confirms the capture, both figures agree and nothing double counts", async () => {
  const w = await financeWorld();
  const paymentId = booking(w, { id: "UATD-BK-GROOM-R1", amount: 2000, paymentStatus: "captured" });
  w.sqlite.prepare("INSERT INTO payment_reconciliation_records (payment_id,booking_id,gateway,environment,expected_amount,captured_amount,refunded_amount,currency,gateway_status,reconciliation_status,variance_amount,last_event_id,updated_at) VALUES (?,?,'razorpay','sandbox',2000,2000,0,'INR','captured','matched',0,'evt-1',?)")
    .run(paymentId, "UATD-BK-GROOM-R1", NOW);

  const body = await ledger(w);
  assert.equal(body.summary.collected, 2000);
  assert.equal(body.summary.capturedPerReconciliation, 2000, "the two sources agree once reconciliation has run");
  assert.equal(body.summary.capturedAwaitingReconciliation, 0, "and the assurance gap closes");
  assert.equal(body.summary.receivable, 0);
  assert.equal(body.summary.reconciled, 1);
  assert.equal(body.summary.unreconciled, 0);
  assert.equal(Number(body.items[0].reconciled_captured_amount), 2000);
});

test("D4: a refund whose amount no reconciliation record states is declared, not rendered as zero", async () => {
  const w = await financeWorld();
  booking(w, { id: "UATD-BK-GROOM-REF", amount: 1500, paymentStatus: "refunded" });

  const body = await ledger(w);
  assert.equal(body.summary.collected, 1500, "a refunded payment was captured first - the money did arrive");
  assert.equal(body.summary.receivable, 0, "and it is not owed by the customer");
  assert.equal(body.summary.refunded, 0, "no reconciliation record states a refunded amount");
  assert.equal(body.summary.refundsPendingReconciliation, 1, "so the unknown is COUNTED rather than passed off as zero");
  assert.equal(body.items[0].refund_amount_unknown, true);
});

test("D4: the ledger read stays a read and stays inside its D1 budget", async () => {
  const w = await financeWorld();
  for (let i = 0; i < 6; i += 1) booking(w, { id: `UATD-BK-GROOM-B${i}`, amount: 1000 + i, paymentStatus: i % 2 ? "captured" : "created" });
  await ledger(w);
  w.reset();
  const before = await ledger(w);
  const firstCalls = w.calls();
  for (let i = 6; i < 20; i += 1) booking(w, { id: `UATD-BK-GROOM-B${i}`, amount: 1000 + i, paymentStatus: "captured" });
  w.reset();
  const after = await ledger(w);
  assert.equal(w.calls(), firstCalls, "the ledger read must not get more expensive as the book grows");
  assert.ok(after.summary.collected > before.summary.collected, "and it must actually see the new rows");
});
