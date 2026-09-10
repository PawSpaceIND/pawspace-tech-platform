/**
 * Pet Taxi Gate 3 — Finance. EXECUTED.
 *
 * WHAT THIS FILE USED TO BE. Eight tests that read `lib/taxi-finance-governance.ts`,
 * `app/api/taxi-finance/route.ts` and two React page files as strings. A test named "Pet Taxi
 * cancellation is request-only and never invents refund" asserted that the phrases
 * `policy_review_required`, `refundPolicy:"configuration_required"` and
 * `Approved Pet Taxi refund must be explicit` appeared in the source. Every one of those is a sentence
 * the module already contains; deleting the guard and leaving the sentence behind in a comment would
 * have kept the test green. This is the money path for a whole vertical.
 *
 * Now eight EXECUTED tests. Each drives `mutateTaxiFinance` or the real `POST /api/taxi-finance`
 * against a real SQLite-backed D1 and reads `taxi_cancellation_requests`, `taxi_refund_ledger`,
 * `taxi_trip_payment_events`, `taxi_driver_settlement_ledger` and `taxi_finance_reconciliation` back.
 *
 * Requests go to https://ops.pawspace.example. This file's central claim is that a CUSTOMER may only
 * request and FINANCE alone may approve, and that a requester cannot approve their own refund — three
 * claims about distinct identities. On localhost `npm test` resolves one development-preview superuser
 * holding ["*"] for every request, so all three would pass vacuously.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { customerSessionCookie, freshSqlite, makeD1, nextKey, refusal, seedCanonicalTrip, taxiUrl } from "./helpers/taxi-harness.mjs";

installWorkersHooks("__TAXI_G3_DB__", "__TAXI_G3_ENV__");

const finance = await import("../lib/taxi-finance-governance.ts");
const financeRoute = await import("../app/api/taxi-finance/route.ts");

const CUSTOMER_PRINCIPAL = "+919800000031";
const FINANCE_MAKER = "maker.finance@pawspace.test";
const FINANCE_CHECKER = "checker.finance@pawspace.test";
const MANAGER = "ops.manager@pawspace.test";

/**
 * A canonical Pet Taxi world: the trip, the finance tables, three staff identities and a verified
 * customer binding so requireCustomerOwnership can actually resolve one.
 */
async function financeWorld({ bookingStatus = "confirmed", tripStatus = "scheduled", paymentEvent = null } = {}) {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__TAXI_G3_DB__ = db;
  globalThis.__TAXI_G3_ENV__ = {};

  const seeded = seedCanonicalTrip(sqlite, { tripStatus });
  if (bookingStatus !== "confirmed") {
    sqlite.prepare("UPDATE canonical_bookings SET status=? WHERE id=?").run(bookingStatus, seeded.bookingId);
  }
  await finance.ensureTaxiFinanceTables(db);

  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  const bindings = await import("../lib/identity-binding.ts");
  await ensureSecurityTables(db);
  await bindings.ensureIdentityBindingTables(db);
  const now = Date.now();
  const staff = sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)");
  staff.run("U-G3-MAKER", FINANCE_MAKER, "Maker Finance", "finance", now, now);
  staff.run("U-G3-CHECKER", FINANCE_CHECKER, "Checker Finance", "finance", now, now);
  // `manager` holds scheduling.book but no finance permission — the contrast that makes the Finance
  // gate a gate rather than "any signed-in staff member".
  staff.run("U-G3-MGR", MANAGER, "Ops Manager", "manager", now, now);
  await bindings.upsertIdentityBinding(db, {
    identitySource: "customer_otp", principalType: "phone", principalKey: CUSTOMER_PRINCIPAL,
    subjectType: "customer", subjectId: seeded.customerId, verificationState: "verified",
    actorId: "otp@pawspace.test", reason: "verified OTP sign-in",
  });

  // taxi_trip_payment_events is OWNED by lib/taxi-lifecycle.ts and created by ensureTaxiFinanceTables;
  // only the row is seeded here. Completion writes it for real in tests/taxi-gate2.test.mjs.
  if (paymentEvent) {
    sqlite.prepare("INSERT INTO taxi_trip_payment_events (id,booking_id,trip_id,amount,currency,status,gateway,reference,created_at,updated_at) VALUES (?,?,?,?,'INR',?,'uat_sandbox',?,?,?)")
      .run(`TPAY-${seeded.bookingId}`, seeded.bookingId, seeded.tripId, paymentEvent.amount ?? seeded.amount, paymentEvent.status, paymentEvent.reference ?? null, now, now);
  }
  return { sqlite, db, ...seeded };
}

function seedCanonicalCompletionFinance(sqlite, world, { providerNetPayout = 314.30, providerPayable = 310.00, resolvedAt = Date.now() - 6 * 24 * 60 * 60 * 1000 } = {}) {
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_payout_computations (booking_id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,service_code TEXT NOT NULL,provider_net_payout REAL NOT NULL,computed_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS finance_journal_entries (id TEXT PRIMARY KEY,source_type TEXT NOT NULL,source_id TEXT NOT NULL,account_code TEXT NOT NULL,debit REAL NOT NULL DEFAULT 0,credit REAL NOT NULL DEFAULT 0,posted INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT OR REPLACE INTO provider_payout_computations (booking_id,provider_id,service_code,provider_net_payout,computed_at) VALUES (?,?,?,?,?)").run(world.bookingId, world.providerId, "pet_taxi", providerNetPayout, resolvedAt);
  sqlite.prepare("INSERT OR REPLACE INTO finance_journal_entries (id,source_type,source_id,account_code,debit,credit,posted,created_at) VALUES (?,?,?,?,0,?,1,?)").run(`JE-${world.bookingId}`, "service_completion", world.bookingId, "2110-Provider Payable", providerPayable, resolvedAt);
  return { providerNetPayout, providerPayable, resolvedAt };
}

/** Drive mutateTaxiFinance directly, with a fresh idempotency key unless one is given. */
const act = (db, bookingId, action, extra = {}) =>
  finance.mutateTaxiFinance(db, { bookingId, action, actorId: extra.actorId ?? FINANCE_MAKER, idempotencyKey: extra.key ?? nextKey(action), ...extra });

/**
 * Drive the real route as a named identity.
 *
 * A STAFF identity arrives on the `oai-authenticated-user-email` header; a CUSTOMER arrives on a
 * signed platform-session cookie, because that is how resolveActor finds one. Passing a phone number
 * on the staff header resolves to nothing ("Access has not been provisioned for this identity"), so
 * the customer cases below mint a real session through customerSessionCookie.
 */
const post = async (actorEmail, body, extraHeaders = {}) => {
  const headers = { "content-type": "application/json", ...extraHeaders, ...(actorEmail ? { "oai-authenticated-user-email": actorEmail } : {}) };
  const response = await financeRoute.POST(new Request(taxiUrl("/api/taxi-finance"), { method: "POST", headers, body: JSON.stringify(body) }));
  return { status: response.status, body: await response.json().catch(() => null) };
};

const cancellationRow = (sqlite, bookingId) => sqlite.prepare("SELECT * FROM taxi_cancellation_requests WHERE booking_id=? ORDER BY created_at DESC LIMIT 1").get(bookingId);
const refundRows = (sqlite, bookingId) => sqlite.prepare("SELECT amount,status,reference,policy_source FROM taxi_refund_ledger WHERE booking_id=? ORDER BY created_at").all(bookingId);
const paymentRow = (sqlite, bookingId) => sqlite.prepare("SELECT status,reference,amount FROM taxi_trip_payment_events WHERE booking_id=?").get(bookingId);

// ---------------------------------------------------------------------------------------------
test("Gate 3: a completed trip stays payment-due until a sandbox reference is recorded once", async () => {
  const world = await financeWorld({ bookingStatus: "completed", tripStatus: "completed", paymentEvent: { status: "due" } });
  const { sqlite, db, bookingId } = world;

  // The trip is DUE, and the canonical payment row is not paid.
  assert.equal(String(paymentRow(sqlite, bookingId).status), "due");
  assert.equal(String(sqlite.prepare("SELECT status FROM booking_payments WHERE booking_id=?").get(bookingId).status), "pending");

  // A payment with NO reference is refused: sandbox money still needs an identifier to reconcile to.
  assert.equal((await refusal(act(db, bookingId, "record_trip_payment")))?.status, 400);
  assert.equal(String(paymentRow(sqlite, bookingId).status), "due", "and nothing is marked paid");

  const paid = await act(db, bookingId, "record_trip_payment", { paymentReference: "SBX-PAY-1" });
  assert.equal(paid.status, "sandbox_paid");
  assert.equal(paid.amount, world.amount);
  assert.equal(paid.liveMoney, false, "the result says on its face that no live money moved");
  const row = paymentRow(sqlite, bookingId);
  assert.deepEqual({ status: String(row.status), reference: String(row.reference) }, { status: "sandbox_paid", reference: "SBX-PAY-1" });
  // The canonical booking payment follows, and records that this is sandbox truth with production
  // timing still unresolved.
  const canonical = sqlite.prepare("SELECT status,detail_json FROM booking_payments WHERE booking_id=?").get(bookingId);
  assert.equal(String(canonical.status), "paid");
  assert.deepEqual(JSON.parse(String(canonical.detail_json)), {
    source: "taxi_trip_ledger", sandboxReference: "SBX-PAY-1", liveMoney: false, productionPaymentTimingPolicy: "pending",
  });

  // REFERENCE REUSE is refused. Without the unique index a single sandbox reference could be recorded
  // against several trips and every one of them would report itself paid.
  const other = seedCanonicalTrip(sqlite, { bookingId: "BKG-TAXI-2", tripId: "TRIP-2", reservationId: "RES-2", groupId: "GRP-2", customerId: "CUST-TAXI-2" });
  sqlite.prepare("UPDATE canonical_bookings SET status='completed' WHERE id=?").run(other.bookingId);
  sqlite.prepare("UPDATE taxi_trips SET status='completed' WHERE booking_id=?").run(other.bookingId);
  sqlite.prepare("INSERT INTO taxi_trip_payment_events (id,booking_id,trip_id,amount,currency,status,gateway,created_at,updated_at) VALUES (?,?,?,?,'INR','due','uat_sandbox',?,?)")
    .run("TPAY-2", other.bookingId, other.tripId, other.amount, Date.now(), Date.now());
  assert.equal((await refusal(act(db, other.bookingId, "record_trip_payment", { paymentReference: "SBX-PAY-1" })))?.status, 409,
    "one sandbox reference cannot pay two trips");
  assert.equal(String(paymentRow(sqlite, other.bookingId).status), "due");
  // A DIFFERENT reference works — non-vacuity for the refusal above.
  assert.equal((await act(db, other.bookingId, "record_trip_payment", { paymentReference: "SBX-PAY-2" })).status, "sandbox_paid");

  // Recording payment TWICE on the same trip is reported as a duplicate rather than doubling.
  const again = await act(db, bookingId, "record_trip_payment", { paymentReference: "SBX-PAY-3" });
  assert.equal(again.duplicatePayment, true);
  assert.equal(String(paymentRow(sqlite, bookingId).reference), "SBX-PAY-1", "the original reference stands");

  // And the idempotency key is honoured: the same key returns the same result without acting again.
  const key = nextKey("dup");
  const first = await act(db, other.bookingId, "reconcile", { key });
  const replay = await act(db, other.bookingId, "reconcile", { key });
  assert.equal(replay.duplicatePrevented, true);
  assert.equal(replay.reconciliationId, first.reconciliationId, "one key, one reconciliation row");
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) c FROM taxi_finance_reconciliation WHERE booking_id=?").get(other.bookingId).c), 1);
});

// ---------------------------------------------------------------------------------------------
test("Gate 3: cancellation is request-only and never invents a refund", async () => {
  const { sqlite, db, bookingId } = await financeWorld();

  // A reason is mandatory — "the customer asked" is not an audit trail. Checked FIRST, because once a
  // request is pending the duplicate guard (asserted below) answers before the reason check does.
  assert.equal((await refusal(act(db, bookingId, "request_cancel", { actorId: "customer@pawspace.test" })))?.status, 400);
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) c FROM taxi_cancellation_requests WHERE booking_id=?").get(bookingId).c), 0);

  const requested = await act(db, bookingId, "request_cancel", { actorId: "customer@pawspace.test", reason: "plans changed" });
  assert.equal(requested.status, "policy_review_required");
  assert.equal(requested.refundPolicy, "configuration_required", "a request computes no refund of its own");
  assert.equal(requested.bookingPreserved, true);
  // NOTHING financial exists yet: no refund row, and the booking is still live.
  assert.deepEqual(refundRows(sqlite, bookingId), []);
  assert.equal(String(sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(bookingId).status), "confirmed",
    "a customer request does not cancel the booking");
  assert.equal(String(cancellationRow(sqlite, bookingId).status), "policy_review_required");
  assert.equal(String(cancellationRow(sqlite, bookingId).approved_refund_amount ?? ""), "", "and no amount is recorded");

  // A second pending request is refused rather than queued twice.
  assert.equal((await refusal(act(db, bookingId, "request_cancel", { actorId: "customer@pawspace.test", reason: "changed again" })))?.status, 409);
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) c FROM taxi_cancellation_requests WHERE booking_id=?").get(bookingId).c), 1);

  // AN ACTIVE TRIP cannot be cancelled through the money path at all: it is a safety situation first.
  const active = await financeWorld({ tripStatus: "in_progress" });
  assert.equal((await refusal(act(active.db, active.bookingId, "request_cancel", { actorId: "customer@pawspace.test", reason: "want to stop now" })))?.status, 409);
  assert.equal((await refusal(act(active.db, active.bookingId, "approve_cancel", { actorId: FINANCE_CHECKER, reason: "stopping the trip", approvedRefundAmount: 0 })))?.status, 409);
  assert.deepEqual(refundRows(active.sqlite, active.bookingId), []);

  // A closed booking cannot accept one either.
  const closed = await financeWorld({ bookingStatus: "cancelled" });
  assert.equal((await refusal(act(closed.db, closed.bookingId, "request_cancel", { actorId: "customer@pawspace.test", reason: "already cancelled" })))?.status, 409);
});

// ---------------------------------------------------------------------------------------------
test("Gate 3: an approved refund must be explicit, bounded by paid value, and not self-approved", async () => {
  // A PREPAID trip that has not started. Cancellation only exists before closure — mutateTaxiFinance
  // refuses both request_cancel and approve_cancel on a completed booking, which is asserted in the
  // request-only test above — so the refund path is necessarily exercised on a live booking.
  const world = await financeWorld({ paymentEvent: { status: "sandbox_paid", reference: "SBX-PAID-1", amount: 449 } });
  const { sqlite, db, bookingId } = world;
  await act(db, bookingId, "request_cancel", { actorId: FINANCE_MAKER, reason: "vet appointment cancelled" });

  // SEGREGATION OF DUTIES: the requester cannot approve their own refund. The old test asserted the
  // sentence existed in the file.
  assert.equal((await refusal(act(db, bookingId, "approve_cancel", { actorId: FINANCE_MAKER, reason: "approving my own request", approvedRefundAmount: 100 })))?.status, 409);
  assert.deepEqual(refundRows(sqlite, bookingId), [], "and no refund is created");
  assert.equal(String(cancellationRow(sqlite, bookingId).status), "policy_review_required");

  // THE AMOUNT MUST BE EXPLICIT. An absent amount is not "refund everything".
  assert.equal((await refusal(act(db, bookingId, "approve_cancel", { actorId: FINANCE_CHECKER, reason: "approved by finance" })))?.status, 409);
  // And it cannot exceed what was actually collected in sandbox.
  assert.equal((await refusal(act(db, bookingId, "approve_cancel", { actorId: FINANCE_CHECKER, reason: "approved by finance", approvedRefundAmount: 450 })))?.status, 409);
  assert.equal((await refusal(act(db, bookingId, "approve_cancel", { actorId: FINANCE_CHECKER, reason: "approved by finance", approvedRefundAmount: -1 })))?.status, 409);
  assert.deepEqual(refundRows(sqlite, bookingId), []);

  const approved = await act(db, bookingId, "approve_cancel", { actorId: FINANCE_CHECKER, reason: "goodwill on a cancelled vet run", approvedRefundAmount: 200 });
  assert.equal(approved.status, "cancelled");
  assert.equal(approved.approvedRefundAmount, 200);
  assert.equal(approved.refundStatus, "sandbox_pending", "approval creates a PENDING refund, never a paid one");
  assert.deepEqual(refundRows(sqlite, bookingId).map((row) => [Number(row.amount), String(row.status), row.reference, String(row.policy_source)]),
    [[200, "sandbox_pending", null, "explicit_finance_approval"]]);
  // The whole canonical chain is cancelled together, not just the money.
  assert.equal(String(sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(bookingId).status), "cancelled");
  assert.equal(String(sqlite.prepare("SELECT status FROM taxi_trips WHERE booking_id=?").get(bookingId).status), "cancelled");
  assert.equal(String(sqlite.prepare("SELECT status FROM provider_work_orders WHERE booking_id=?").get(bookingId).status), "cancelled");
  assert.equal(String(sqlite.prepare("SELECT status FROM scheduling_reservations WHERE group_id=?").get(world.groupId).status), "cancelled");
  const decision = cancellationRow(sqlite, bookingId);
  assert.deepEqual({ status: String(decision.status), by: String(decision.decision_by), amount: Number(decision.approved_refund_amount) },
    { status: "approved", by: FINANCE_CHECKER, amount: 200 });

  // ONE approval per booking: the claim table refuses a second, so two approvals cannot produce two
  // refunds for one cancellation.
  await act(db, bookingId, "request_cancel", { actorId: FINANCE_MAKER, reason: "second attempt" }).then(() => null, () => null);
  assert.equal((await refusal(act(db, bookingId, "approve_cancel", { actorId: FINANCE_CHECKER, reason: "approving twice", approvedRefundAmount: 100 })))?.status, 409);
  assert.equal(refundRows(sqlite, bookingId).length, 1, "still one refund");

  // A ZERO refund is a legitimate decision and creates no refund row at all.
  const nothing = await financeWorld({ paymentEvent: { status: "sandbox_paid", reference: "SBX-PAID-2", amount: 449 } });
  await act(nothing.db, nothing.bookingId, "request_cancel", { actorId: FINANCE_MAKER, reason: "cancelled inside the free window" });
  const zero = await act(nothing.db, nothing.bookingId, "approve_cancel", { actorId: FINANCE_CHECKER, reason: "no refund due under policy", approvedRefundAmount: 0 });
  assert.equal(zero.refundStatus, "not_required");
  assert.equal(zero.refundId, null);
  assert.deepEqual(refundRows(nothing.sqlite, nothing.bookingId), []);
});

// ---------------------------------------------------------------------------------------------
test("Gate 3: the refund ledger is sandbox-only and replay resistant", async () => {
  const world = await financeWorld({ paymentEvent: { status: "sandbox_paid", reference: "SBX-PAID-3", amount: 449 } });
  const { sqlite, db, bookingId } = world;

  // With no approved refund pending there is nothing to record.
  assert.equal((await refusal(act(db, bookingId, "record_refund", { actorId: FINANCE_CHECKER, reason: "paying out", refundReference: "SBX-RFND-1" })))?.status, 409);

  await act(db, bookingId, "request_cancel", { actorId: FINANCE_MAKER, reason: "customer cancelled" });
  await act(db, bookingId, "approve_cancel", { actorId: FINANCE_CHECKER, reason: "policy allows a partial refund", approvedRefundAmount: 149 });
  assert.equal(String(refundRows(sqlite, bookingId)[0].status), "sandbox_pending");

  // A reference is mandatory.
  assert.equal((await refusal(act(db, bookingId, "record_refund", { actorId: FINANCE_CHECKER, reason: "paying out" })))?.status, 400);
  assert.equal(String(refundRows(sqlite, bookingId)[0].status), "sandbox_pending");

  const recorded = await act(db, bookingId, "record_refund", { actorId: FINANCE_CHECKER, reason: "sandbox refund raised", refundReference: "SBX-RFND-1" });
  assert.equal(recorded.status, "sandbox_recorded");
  assert.equal(recorded.amount, 149);
  assert.deepEqual(refundRows(sqlite, bookingId).map((row) => [Number(row.amount), String(row.status), String(row.reference)]), [[149, "sandbox_recorded", "SBX-RFND-1"]]);

  // Nothing is pending any more, so a replay of the same action is refused.
  assert.equal((await refusal(act(db, bookingId, "record_refund", { actorId: FINANCE_CHECKER, reason: "again", refundReference: "SBX-RFND-2" })))?.status, 409);

  // REFERENCE REUSE across bookings is refused: one sandbox refund reference cannot settle two refunds.
  // The second booking lives in the SAME database — a second fixture would not share the index that
  // makes this a real constraint.
  const second = seedCanonicalTrip(sqlite, { bookingId: "BKG-TAXI-R2", tripId: "TRIP-R2", reservationId: "RES-R2", groupId: "GRP-R2", customerId: "CUST-TAXI-R2" });
  sqlite.prepare("INSERT INTO taxi_trip_payment_events (id,booking_id,trip_id,amount,currency,status,gateway,reference,created_at,updated_at) VALUES (?,?,?,?,'INR','sandbox_paid','uat_sandbox',?,?,?)")
    .run("TPAY-R2", second.bookingId, second.tripId, second.amount, "SBX-PAID-4", Date.now(), Date.now());
  await act(db, second.bookingId, "request_cancel", { actorId: FINANCE_MAKER, reason: "second customer cancelled" });
  await act(db, second.bookingId, "approve_cancel", { actorId: FINANCE_CHECKER, reason: "policy refund", approvedRefundAmount: 99 });
  assert.equal((await refusal(act(db, second.bookingId, "record_refund", { actorId: FINANCE_CHECKER, reason: "reusing a reference", refundReference: "SBX-RFND-1" })))?.status, 409);
  assert.equal(String(refundRows(sqlite, second.bookingId)[0].status), "sandbox_pending");
  assert.equal((await act(db, second.bookingId, "record_refund", { actorId: FINANCE_CHECKER, reason: "correct reference", refundReference: "SBX-RFND-3" })).status, "sandbox_recorded");
});

// ---------------------------------------------------------------------------------------------
test("Gate 3: settlement waits for completed payment and projects canonical completion finance", async () => {
  const open = await financeWorld({ paymentEvent: { status: "sandbox_paid", reference: "SBX-PAID-5" } });
  assert.equal((await refusal(act(open.db, open.bookingId, "prepare_settlement", { actorId: FINANCE_CHECKER, reason: "early settlement" })))?.status, 409);
  assert.equal(open.sqlite.prepare("SELECT COUNT(*) c FROM taxi_driver_settlement_ledger").get().c, 0);

  const unpaid = await financeWorld({ bookingStatus: "completed", tripStatus: "completed", paymentEvent: { status: "due" } });
  assert.equal((await refusal(act(unpaid.db, unpaid.bookingId, "prepare_settlement", { actorId: FINANCE_CHECKER, reason: "settle now" })))?.status, 409);

  const missing = await financeWorld({ bookingStatus: "completed", tripStatus: "completed", paymentEvent: { status: "sandbox_paid", reference: "SBX-PAID-MISSING", amount: 449 } });
  assert.equal((await refusal(act(missing.db, missing.bookingId, "prepare_settlement", { actorId: FINANCE_CHECKER, reason: "canonical finance required" })))?.status, 409);

  const world = await financeWorld({ bookingStatus: "completed", tripStatus: "completed", paymentEvent: { status: "sandbox_paid", reference: "SBX-PAID-6", amount: 449 } });
  const canonical = seedCanonicalCompletionFinance(world.sqlite, world);
  const key = nextKey("SETTLE");
  const prepared = await act(world.db, world.bookingId, "prepare_settlement", { actorId: FINANCE_CHECKER, key, reason: "trip completed and paid" });
  assert.equal(prepared.status, "settlement_prepared");
  assert.equal(prepared.payoutAmount, canonical.providerPayable);
  assert.equal(prepared.basePayout, canonical.providerNetPayout);
  assert.equal(prepared.payoutRule, "rule_applied");
  assert.equal(prepared.tax, "resolved");
  assert.equal(prepared.approvalStatus, "awaiting_finance_approval");
  assert.equal(prepared.payoutStatus, "not_instructed");
  assert.equal(prepared.payoutSlaDays, 5);
  const ledger = world.sqlite.prepare("SELECT * FROM taxi_driver_settlement_ledger WHERE booking_id=?").get(world.bookingId);
  assert.equal(Number(ledger.payout_amount), canonical.providerPayable);
  assert.equal(Number(ledger.base_payout), canonical.providerNetPayout);
  assert.equal(Number(ledger.eligible_at), canonical.resolvedAt + 5 * 24 * 60 * 60 * 1000);
  assert.deepEqual({ rule: ledger.payout_rule_status, tax: ledger.tax_status, approval: ledger.approval_status, payout: ledger.payout_status }, { rule: "rule_applied", tax: "resolved", approval: "awaiting_finance_approval", payout: "not_instructed" });

  const replay = await act(world.db, world.bookingId, "prepare_settlement", { actorId: FINANCE_CHECKER, key, reason: "trip completed and paid" });
  assert.equal(replay.duplicatePrevented, true);
  assert.equal(Number(world.sqlite.prepare("SELECT COUNT(*) c FROM taxi_driver_settlement_ledger WHERE booking_id=?").get(world.bookingId).c), 1);

  const tooEarlyWorld = await financeWorld({ bookingStatus: "completed", tripStatus: "completed", paymentEvent: { status: "sandbox_paid", reference: "SBX-PAID-EARLY", amount: 449 } });
  seedCanonicalCompletionFinance(tooEarlyWorld.sqlite, tooEarlyWorld, { resolvedAt: Date.now() });
  await act(tooEarlyWorld.db, tooEarlyWorld.bookingId, "prepare_settlement", { actorId: FINANCE_CHECKER, reason: "prepare early" });
  const tooEarly = await refusal(act(tooEarlyWorld.db, tooEarlyWorld.bookingId, "approve_settlement", { actorId: FINANCE_CHECKER, reason: "finance reviewed canonical driver payable" }));
  assert.equal(tooEarly?.status, 409);
  assert.match(tooEarly.message, /5-day payout policy/i);

  const approved = await act(world.db, world.bookingId, "approve_settlement", { actorId: FINANCE_CHECKER, reason: "finance reviewed canonical driver payable" });
  assert.equal(approved.status, "approved");
  assert.equal(approved.payoutAmount, canonical.providerPayable);
  assert.equal(approved.payoutStatus, "not_instructed");
  assert.equal(approved.liveMoney, false);
  const approvedRow = world.sqlite.prepare("SELECT approval_status,approved_by,payout_status,payout_amount FROM taxi_driver_settlement_ledger WHERE booking_id=?").get(world.bookingId);
  assert.equal(approvedRow.approval_status, "approved");
  assert.equal(approvedRow.approved_by, FINANCE_CHECKER);
  assert.equal(approvedRow.payout_status, "not_instructed");
});

// ---------------------------------------------------------------------------------------------
test("Gate 3: reconciliation reports due, paid, refunded and settlement truth", async () => {
  const world = await financeWorld({ bookingStatus: "completed", tripStatus: "completed", paymentEvent: { status: "due", amount: 449 } });
  const { sqlite, db, bookingId } = world;

  // UNPAID: attention required, and the unpaid total is stated rather than netted away.
  const unpaid = await act(db, bookingId, "reconcile", { actorId: FINANCE_CHECKER, reason: "monthly check" });
  assert.deepEqual({
    status: unpaid.status, due: unpaid.tripDueTotal, paid: unpaid.paidTotal,
    unpaid: unpaid.unpaidTripTotal, refund: unpaid.refundTotal, net: unpaid.netPaidTotal,
  }, { status: "attention_required", due: 449, paid: 0, unpaid: 449, refund: 0, net: 0 });
  assert.equal(unpaid.settlementState, "attention_required", "a completed trip with no settlement is flagged");
  assert.equal(unpaid.taxState, "configuration_required");

  // PAID: the unpaid total clears, but tax is still unconfigured so attention stands. Fail-closed
  // reporting: "balanced" must not be reachable while a statutory field is unresolved.
  await act(db, bookingId, "record_trip_payment", { actorId: FINANCE_CHECKER, reason: "collected", paymentReference: "SBX-PAY-R1" });
  seedCanonicalCompletionFinance(sqlite, world);
  await act(db, bookingId, "prepare_settlement", { actorId: FINANCE_CHECKER, reason: "completed and paid" });
  await act(db, bookingId, "approve_settlement", { actorId: FINANCE_CHECKER, reason: "finance reviewed canonical driver payable" });
  const paid = await act(db, bookingId, "reconcile", { actorId: FINANCE_CHECKER, reason: "after payment" });
  assert.deepEqual({ paid: paid.paidTotal, unpaid: paid.unpaidTripTotal, refund: paid.refundTotal, net: paid.netPaidTotal },
    { paid: 449, unpaid: 0, refund: 0, net: 449 });
  assert.equal(paid.settlementState, "approved");
  assert.equal(paid.taxState, "resolved");
  assert.equal(paid.status, "balanced", "approved canonical settlement reconciles cleanly");

  // A recorded refund reduces the NET but not the paid total — both figures are kept. It has to be a
  // different booking: a refund requires a cancellation, and a completed booking cannot be cancelled.
  const cancelled = await financeWorld({ paymentEvent: { status: "sandbox_paid", reference: "SBX-PAID-R2", amount: 449 } });
  await act(cancelled.db, cancelled.bookingId, "request_cancel", { actorId: FINANCE_MAKER, reason: "customer complaint before pickup" });
  await act(cancelled.db, cancelled.bookingId, "approve_cancel", { actorId: FINANCE_CHECKER, reason: "partial goodwill refund", approvedRefundAmount: 149 });
  await act(cancelled.db, cancelled.bookingId, "record_refund", { actorId: FINANCE_CHECKER, reason: "refund raised in sandbox", refundReference: "SBX-RFND-R1" });
  const refunded = await act(cancelled.db, cancelled.bookingId, "reconcile", { actorId: FINANCE_CHECKER, reason: "after refund" });
  assert.deepEqual({ paid: refunded.paidTotal, refund: refunded.refundTotal, net: refunded.netPaidTotal }, { paid: 449, refund: 149, net: 300 });
  assert.equal(refunded.settlementState, "not_due", "a cancelled trip owes the driver nothing");

  // Each reconciliation is a new immutable row, so the history is auditable.
  const rows = sqlite.prepare("SELECT paid_total,refund_total,net_paid_total,unpaid_trip_total,status,checked_by FROM taxi_finance_reconciliation WHERE booking_id=? ORDER BY created_at,id").all(bookingId);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => Number(row.net_paid_total)), [0, 449]);
  assert.deepEqual([...new Set(rows.map((row) => String(row.checked_by)))], [FINANCE_CHECKER], "the checker recorded is the acting identity");
  assert.deepEqual(JSON.parse(String(sqlite.prepare("SELECT detail_json FROM taxi_finance_reconciliation WHERE booking_id=? ORDER BY created_at DESC LIMIT 1").get(bookingId).detail_json)).productionPaymentTimingPolicy, "pending");
});

// ---------------------------------------------------------------------------------------------
test("Gate 3: the Finance API separates a customer request from Finance authority", async () => {
  // A live booking with payment due, so the customer request below is a legal action rather than being
  // refused for a reason that has nothing to do with authority.
  const world = await financeWorld({ paymentEvent: { status: "due", amount: 449 } });
  const { sqlite, bookingId } = world;

  // A CUSTOMER may request a cancellation for their OWN booking, through a real signed session.
  const owner = await customerSessionCookie(world.db, { principalKey: CUSTOMER_PRINCIPAL, customerId: world.customerId });
  const stranger = await customerSessionCookie(world.db, { principalKey: "+919800000099", customerId: "CUST-TAXI-STRANGER" });
  const asCustomer = (session, body) => post("", body, { cookie: session.cookie });

  const requested = await asCustomer(owner, { bookingId, action: "request_cancel", idempotencyKey: nextKey("route"), reason: "plans changed" });
  assert.equal(requested.status, 200, `a bound customer must be able to request: ${JSON.stringify(requested)}`);
  assert.equal(requested.body?.data?.status, "policy_review_required");
  assert.equal(requested.body?.data?.sandboxOnly, true);

  // A DIFFERENT customer, with an equally valid session, cannot request against this booking.
  const intruder = await asCustomer(stranger, { bookingId, action: "request_cancel", idempotencyKey: nextKey("route"), reason: "not my booking" });
  assert.ok([401, 403].includes(intruder.status), `a stranger must be refused: ${JSON.stringify(intruder)}`);

  // EVERY money action is refused to the customer, and none of them writes anything.
  for (const action of ["approve_cancel", "record_trip_payment", "record_refund", "prepare_settlement", "approve_settlement", "reconcile"]) {
    const attempt = await asCustomer(owner, { bookingId, action, idempotencyKey: nextKey("route"), reason: "trying to self-serve money", approvedRefundAmount: 449, paymentReference: "SBX-SELF", refundReference: "SBX-SELF" });
    assert.ok([401, 403].includes(attempt.status), `${action} must be Finance-only: ${JSON.stringify(attempt)}`);
  }
  assert.equal(String(paymentRow(sqlite, bookingId).status), "due", "no customer attempt collected money");
  assert.deepEqual(refundRows(sqlite, bookingId), []);
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) c FROM taxi_driver_settlement_ledger").get().c), 0);
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) c FROM taxi_finance_reconciliation").get().c), 0);

  // A signed-in staff member WITHOUT finance.manage is refused the same actions.
  assert.equal((await post(MANAGER, { bookingId, action: "record_trip_payment", idempotencyKey: nextKey("route"), reason: "collecting", paymentReference: "SBX-MGR" })).status, 403);
  assert.equal(String(paymentRow(sqlite, bookingId).status), "due");

  // FINANCE can, and the actor recorded is the authenticated one — a body-supplied actor is ignored
  // because the route does not read one.
  const collected = await post(FINANCE_CHECKER, { bookingId, action: "record_trip_payment", idempotencyKey: nextKey("route"), reason: "collected in sandbox", paymentReference: "SBX-PAY-ROUTE" });
  assert.equal(collected.status, 200, `${JSON.stringify(collected)}`);
  assert.equal(collected.body.data.status, "sandbox_paid");
  // The body tries to claim a different acting identity; the route must ignore it and record the
  // authenticated one.
  const reconciled = await post(FINANCE_CHECKER, { bookingId, action: "reconcile", idempotencyKey: nextKey("route"), reason: "after collection", actorId: FINANCE_MAKER, checkedBy: FINANCE_MAKER });
  assert.equal(String(sqlite.prepare("SELECT checked_by FROM taxi_finance_reconciliation WHERE booking_id=?").get(bookingId).checked_by), FINANCE_CHECKER);
  assert.equal(reconciled.body.data.productionPaymentTimingPolicy, "pending");

  // An unknown action is a 400, not a silent no-op.
  assert.equal((await post(FINANCE_CHECKER, { bookingId, action: "write_off", idempotencyKey: nextKey("route"), reason: "made-up action" })).status, 400);
  // An anonymous caller reaches nothing.
  assert.ok([401, 403].includes((await post("", { bookingId, action: "reconcile", idempotencyKey: nextKey("route"), reason: "anonymous" })).status));
});

// ---------------------------------------------------------------------------------------------
test("Gate 3: two Finance approvals of one cancellation produce exactly one refund", async () => {
  /*
   * THE CHECK-THEN-ACT WINDOW. Two approvals that both see `policy_review_required` must yield ONE
   * cancellation and ONE refund row.
   *
   * This interleaves STATEMENTS, not transactions: the hook runs the competitor inside the winner's
   * transaction on the same connection (see the note on `depth` in tests/helpers/taxi-harness.mjs), so
   * it is not two concurrent D1 transactions. The ordering is the point — the competitor acts between
   * the claim and the update — and the asserted outcome, one winner refused by
   * taxi_cancellation_approval_claims' PRIMARY KEY, is what real serialised writers would produce too.
   *
   * A `Promise.all` of two calls would not test this: statements against this D1 shim are synchronous,
   * so the first call runs to completion before the second starts and the second is then an ordinary
   * duplicate. The hook below fires a competing approval in the exact gap between the approval batch
   * CLAIMING the cancellation and UPDATING it. taxi_cancellation_approval_claims has booking_id as its
   * PRIMARY KEY and cancellation_request_id UNIQUE, and that is what refuses the second claim.
   */
  const world = await financeWorld({ paymentEvent: { status: "sandbox_paid", reference: "SBX-PAID-RACE", amount: 449 } });
  const { sqlite, db, bookingId } = world;
  await act(db, bookingId, "request_cancel", { actorId: FINANCE_MAKER, reason: "customer cancelled the vet run" });

  let competitor = null;
  db.onSql("UPDATE taxi_cancellation_requests SET status='approved'", async () => {
    competitor = await refusal(act(db, bookingId, "approve_cancel", { actorId: FINANCE_CHECKER, reason: "competing approval in the claim gap", approvedRefundAmount: 300 }));
  });
  const winner = await act(db, bookingId, "approve_cancel", { actorId: FINANCE_CHECKER, reason: "first approval of the cancellation", approvedRefundAmount: 200 })
    .then((value) => ({ ok: value }), (error) => ({ refused: error instanceof Response ? error.status : String(error) }));

  assert.notEqual(competitor, null, "the competing approval must actually have run inside the claim gap");
  const outcomes = [winner.ok ? 200 : winner.refused, competitor?.status ?? competitor];
  assert.deepEqual(outcomes.slice().sort(), [200, 409], `exactly one approval may win: ${JSON.stringify(outcomes)}`);
  assert.equal(refundRows(sqlite, bookingId).length, 1, "one cancellation, one refund row — never two");
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) c FROM taxi_cancellation_approval_claims WHERE booking_id=?").get(bookingId).c), 1);
  assert.equal(String(sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(bookingId).status), "cancelled");
  // And whichever amount won is the one on the ledger — the two must not be mixed.
  const approvedAmount = Number(cancellationRow(sqlite, bookingId).approved_refund_amount);
  assert.equal(Number(refundRows(sqlite, bookingId)[0].amount), approvedAmount,
    "the refund on the ledger is the amount that was actually approved");
});

// ---------------------------------------------------------------------------------------------
test("Gate 3: Razorpay booking-fee and final-balance captures preserve Taxi schedule plus verified canonical timeline", async () => {
  const { ensureFinancialRuntimeTables } = await import("../lib/financial-runtime-schema.ts");
  const { commitRazorpayCaptureAtomic, executeRazorpayCapturePostCommit } = await import("../lib/razorpay-capture-atomic.ts");
  const world = await financeWorld({ bookingStatus: "payment_pending", paymentEvent: null });
  const { sqlite, db, bookingId, customerId } = world;
  const now = Date.now(), paymentId = `PAY-${bookingId}`;
  sqlite.prepare("UPDATE provider_work_orders SET status='payment_pending' WHERE booking_id=?").run(bookingId);
  await ensureFinancialRuntimeTables(db);
  sqlite.exec("CREATE TABLE IF NOT EXISTS payment_gateway_links (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,payment_id TEXT NOT NULL UNIQUE,provider TEXT NOT NULL,environment TEXT NOT NULL,gateway_order_id TEXT UNIQUE,gateway_payment_link_id TEXT UNIQUE,gateway_payment_id TEXT UNIQUE,status TEXT NOT NULL DEFAULT 'active',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS payment_gateway_events (id TEXT PRIMARY KEY,provider TEXT NOT NULL,environment TEXT NOT NULL,event_id TEXT NOT NULL,event_type TEXT NOT NULL,booking_id TEXT,payment_id TEXT,gateway_order_id TEXT,gateway_payment_id TEXT,gateway_refund_id TEXT,amount_subunits INTEGER,currency TEXT,signature_verified INTEGER NOT NULL,payload_hash TEXT NOT NULL,processing_status TEXT NOT NULL DEFAULT 'received',failure_reason TEXT,detail_json TEXT NOT NULL DEFAULT '{}',received_at INTEGER NOT NULL,processed_at INTEGER,UNIQUE(provider,event_id))");
  sqlite.exec("CREATE TABLE IF NOT EXISTS payment_reconciliation_records (payment_id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,gateway TEXT NOT NULL,environment TEXT NOT NULL,expected_amount REAL NOT NULL,captured_amount REAL NOT NULL DEFAULT 0,refunded_amount REAL NOT NULL DEFAULT 0,currency TEXT NOT NULL,gateway_status TEXT NOT NULL DEFAULT 'not_started',reconciliation_status TEXT NOT NULL DEFAULT 'pending',variance_amount REAL NOT NULL DEFAULT 0,last_event_id TEXT,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS taxi_payment_schedules (booking_id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,total_amount REAL NOT NULL,booking_fee_amount REAL NOT NULL,balance_amount REAL NOT NULL,status TEXT NOT NULL DEFAULT 'booking_fee_pending',booking_fee_paid_at INTEGER,booking_fee_reference TEXT,final_paid_at INTEGER,final_payment_reference TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT INTO taxi_payment_schedules (booking_id,customer_id,total_amount,booking_fee_amount,balance_amount,status,created_at,updated_at) VALUES (?,?,?,?,?,'booking_fee_pending',?,?)").run(bookingId, customerId, 449, 100, 349, now, now);
  sqlite.prepare("INSERT INTO payment_gateway_links (id,booking_id,payment_id,provider,environment,status,created_at,updated_at) VALUES (?,?,?,'razorpay','sandbox','active',?,?)").run(`PGL-${bookingId}`, bookingId, paymentId, now, now);
  const seedIntent = (id, amountPaise, orderId) => sqlite.prepare(`INSERT INTO payment_intents (id,booking_id,customer_id,payment_id,provider,environment,idempotency_key,amount_paise,currency,state,order_request_state,gateway_order_id,gross_service_value_paise,platform_fee_paise,partner_earning_paise,tds_paise,gst_paise,commission_rate_bps,commission_rate_version,tax_rule_version,commercial_snapshot_json,version,created_at,updated_at) VALUES (?,?,?,?,'razorpay','sandbox',?,?,'INR','CREATED','ORDER_CREATED',?,0,0,0,0,0,0,'test','test','{}',0,?,?)`).run(id, bookingId, customerId, paymentId, `idem-${id}`, amountPaise, orderId, now, now);
  const seedInbox = (id, eventId) => sqlite.prepare("INSERT INTO gateway_webhook_events (id,provider,environment,event_id,event_type,raw_payload,payload_sha256,signature,processing_status,received_at) VALUES (?,'razorpay','sandbox',?,'payment.captured','{}',?,'test-signature','PROCESSING',?)").run(id, eventId, `hash-${eventId}`, Date.now());
  const capture = async ({ intentId, inboxId, eventId, orderId, gatewayPaymentId, amountPaise }) => {
    seedIntent(intentId, amountPaise, orderId); seedInbox(inboxId, eventId);
    const committed = await commitRazorpayCaptureAtomic(db, { inboxId, eventId, environment: "sandbox", intentId, bookingId, paymentId, gatewayOrderId: orderId, gatewayPaymentId, amountPaise, currency: "INR", payloadHash: `hash-${eventId}` });
    const effects = await executeRazorpayCapturePostCommit(db, { outboxId: committed.effectsOutboxId, workerId: `taxi-g3-${eventId}` });
    assert.equal(effects.completed, true); return committed;
  };
  const fee = await capture({ intentId: "PI-TAXI-FEE", inboxId: "IN-TAXI-FEE", eventId: "evt_taxi_fee", orderId: "order_taxi_fee", gatewayPaymentId: "pay_taxi_fee", amountPaise: 10000 });
  assert.equal(fee.collectedInFull, false);
  let schedule = sqlite.prepare("SELECT * FROM taxi_payment_schedules WHERE booking_id=?").get(bookingId);
  assert.deepEqual({ status: schedule.status, ref: schedule.booking_fee_reference }, { status: "pending_balance", ref: "pay_taxi_fee" });
  assert.equal(sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(bookingId).status, "confirmed");
  assert.equal(sqlite.prepare("SELECT status FROM provider_work_orders WHERE booking_id=?").get(bookingId).status, "assigned");
  const balance = await capture({ intentId: "PI-TAXI-BAL", inboxId: "IN-TAXI-BAL", eventId: "evt_taxi_balance", orderId: "order_taxi_balance", gatewayPaymentId: "pay_taxi_balance", amountPaise: 34900 });
  assert.equal(balance.collectedInFull, true);
  schedule = sqlite.prepare("SELECT * FROM taxi_payment_schedules WHERE booking_id=?").get(bookingId);
  assert.deepEqual({ status: schedule.status, ref: schedule.final_payment_reference }, { status: "paid", ref: "pay_taxi_balance" });
  assert.equal(sqlite.prepare("SELECT captured_amount FROM payment_reconciliation_records WHERE payment_id=?").get(paymentId).captured_amount, 449);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM booking_lifecycle_events WHERE booking_id=? AND event_type='payment_captured'").get(bookingId).n, 2);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM journal_transactions WHERE source_type='razorpay_capture' AND status='POSTED'").get().n, 2);
});
