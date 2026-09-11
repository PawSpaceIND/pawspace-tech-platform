/*
 * Day-31 wave 1a: escrow custody - where a customer's money actually sits between capture and
 * provider payout.
 *
 * capture evidence -> reserve custody -> dispute freeze -> arbitration / undisputed release ->
 * settlement intent.
 *
 * lib/escrow-custody-{schema,adjudication,settlement,support}.ts is ~58KB of money-handling code
 * and no test in this repository imports any of it. That is the single largest untested monetary
 * surface in the platform, and it is the one holding funds that belong to somebody else.
 *
 * The invariant everything else hangs off: the platform may never allocate more than it genuinely
 * holds, and every rupee of custody must end up allocated to exactly one of provider or customer.
 * Money that is created, lost, or double-released here is money that was really taken from a real
 * customer, so each case below is written as "what would have to be true for us to be short".
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world } from "./helpers/execution-harness.mjs";

installWorkersHooks("__D31W_ESC_DB__", "__D31W_ESC_ENV__");

const BOOKING = "BK-ESC-001";
const PROVIDER = "PRV-ESC-001";
const CUSTOMER = "CUS-ESC-001";
const PAYMENT = "PAY-ESC-001";
const CAPTURED = 5000;

async function seedEscrow({ captured = CAPTURED, refunded = 0, status = "captured" } = {}) {
  const { sqlite, db } = world("__D31W_ESC_DB__", "__D31W_ESC_ENV__", {
    PAWSPACE_PAYMENT_ENV: "sandbox", PAWSPACE_PAYMENT_LIVE_APPROVED: "false",
  });
  const schema = await import("../lib/escrow-custody-schema.ts");
  const adjudication = await import("../lib/escrow-custody-adjudication.ts");
  const settlement = await import("../lib/escrow-custody-settlement.ts");
  await schema.ensureEscrowCustodyTables(db);

  const now = Date.now();
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT,amount REAL,amount_due_now REAL,currency TEXT DEFAULT 'INR',method TEXT,mode TEXT,status TEXT,gateway TEXT,idempotency_key TEXT UNIQUE,detail_json TEXT DEFAULT '{}',created_at INTEGER,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS payment_reconciliation_records (payment_id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,gateway TEXT,environment TEXT,expected_amount REAL,captured_amount REAL DEFAULT 0,refunded_amount REAL DEFAULT 0,currency TEXT,gateway_status TEXT,reconciliation_status TEXT,variance_amount REAL DEFAULT 0,last_event_id TEXT,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_order_commissions (booking_id TEXT PRIMARY KEY,provider_id TEXT,commission_amount REAL,commission_source TEXT,override_reason TEXT,status TEXT,updated_at INTEGER)");
  sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,currency,method,mode,status,gateway,idempotency_key,created_at,updated_at) VALUES (?,?,?,?,?,'INR','razorpay','full',?,'razorpay_sandbox',?,?,?)")
    .run(PAYMENT, BOOKING, CUSTOMER, captured, captured, status, `idem-${PAYMENT}`, now, now);
  // The reconciliation record is the gateway's own truth. It must agree with the payment row, or
  // the fixture is testing an inconsistency rather than the behaviour under test.
  const capturedOnGateway = status === "captured" ? captured : 0;
  sqlite.prepare("INSERT INTO payment_reconciliation_records (payment_id,booking_id,gateway,environment,expected_amount,captured_amount,refunded_amount,currency,gateway_status,reconciliation_status,updated_at) VALUES (?,?,'razorpay','sandbox',?,?,?,'INR',?,'matched',?)")
    .run(PAYMENT, BOOKING, captured, capturedOnGateway, refunded, status, now);
  return { sqlite, db, schema, adjudication, settlement };
}

const account = (sqlite) => sqlite.prepare("SELECT * FROM escrow_custodial_accounts WHERE booking_id=?").get(BOOKING);
const reserve = (adjudication, db, amount = CAPTURED) => adjudication.reserveEscrowForProviderPayout(db, {
  bookingId: BOOKING, providerId: PROVIDER, amount, currency: "INR",
  actorId: "finance@pawspace.in", reason: "Day-31 reserve captured funds before payout",
});

test("custody may never hold more than was genuinely captured", async () => {
  const { db, adjudication } = await seedEscrow({ captured: 5000 });
  await assert.rejects(
    () => reserve(adjudication, db, 5000.5),
    (error) => { assert.match(error.message, /escrow_capture_insufficient/); return true; },
    "reserving above the captured amount would be inventing money",
  );
  const held = await reserve(adjudication, db, 5000);
  assert.ok(held.accountId, "the exact captured amount must be reservable");
});

test("a refund shrinks what can be held - refunded money is the customer's again", async () => {
  /*
   * Capture 5,000 then refund 3,000. Only 2,000 is genuinely still ours to hold. Reserving against
   * the gross capture would put us 3,000 short the moment the provider was paid.
   */
  const { db, adjudication } = await seedEscrow({ captured: 5000, refunded: 3000 });
  await assert.rejects(() => reserve(adjudication, db, 5000), /escrow_capture_insufficient/,
    "the gross capture is not what is still held");
  await assert.rejects(() => reserve(adjudication, db, 2000.5), /escrow_capture_insufficient/);
  const held = await reserve(adjudication, db, 2000);
  assert.equal(Number(held.custodyAmount ?? 2000), 2000);
});

test("nothing can be held against a payment that never captured", async () => {
  for (const status of ["pending", "failed", "authorized"]) {
    const { db, adjudication } = await seedEscrow({ captured: 5000, status });
    await assert.rejects(() => reserve(adjudication, db, 100), /escrow_capture_insufficient/,
      `a ${status} payment is not money in hand`);
  }
});

test("reserving twice holds the money once", async () => {
  const { sqlite, db, adjudication } = await seedEscrow();
  await reserve(adjudication, db);
  await reserve(adjudication, db);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM escrow_custodial_accounts WHERE booking_id=?").get(BOOKING).n, 1);
  assert.equal(Number(account(sqlite).custody_amount), CAPTURED, "a repeat reserve must not stack custody");
});

test("an open dispute blocks release - the provider is not paid while the customer is contesting", async () => {
  const { db, adjudication } = await seedEscrow();
  await reserve(adjudication, db);
  await adjudication.freezeEscrowForDispute(db, {
    bookingId: BOOKING, disputeReference: "DISP-D31-001",
    reason: "Customer reports the groom was not performed", actorId: "support@pawspace.in",
  });
  await assert.rejects(
    () => adjudication.releaseUndisputedEscrowToProvider(db, {
      bookingId: BOOKING, actorId: "finance@pawspace.in", reason: "Day-31 release attempt during dispute",
    }),
    (error) => { assert.match(error.message, /dispute|blocked/i); return true; },
    "money under dispute must not leave",
  );
});

test("arbitration cannot be reached without a frozen dispute", async () => {
  const { db, adjudication } = await seedEscrow();
  await reserve(adjudication, db);
  await assert.rejects(
    () => adjudication.arbitrateEscrow(db, {
      bookingId: BOOKING, decision: "ARBITRATION_REFUND_CUSTOMER",
      reason: "Day-31 arbitration without any dispute on file", actorId: "ops@pawspace.in",
    }),
    /escrow_arbitration_requires_frozen_dispute/,
    "an arbitration decision needs a dispute to decide",
  );
});

test("a split must allocate the whole custody - not a rupee created, not a rupee lost", async () => {
  const bad = [
    ["under-allocates", { providerAmount: 1000, customerAmount: 1000 }],
    ["over-allocates", { providerAmount: 4000, customerAmount: 4000 }],
    ["gives everything to one side via the split path", { providerAmount: 5000, customerAmount: 0 }],
    ["negative provider share", { providerAmount: -1000, customerAmount: 6000 }],
    ["0% to the customer", { customerPercentage: 0 }],
    ["100% to the customer", { customerPercentage: 100 }],
  ];
  for (const [label, amounts] of bad) {
    const { db, adjudication } = await seedEscrow();
    await reserve(adjudication, db);
    await adjudication.freezeEscrowForDispute(db, {
      bookingId: BOOKING, disputeReference: "DISP-D31-SPLIT",
      reason: "Day-31 partial split boundary case", actorId: "support@pawspace.in",
    });
    await assert.rejects(
      () => adjudication.arbitrateEscrow(db, {
        bookingId: BOOKING, decision: "PARTIAL_SPLIT", ...amounts,
        reason: `Day-31 split that ${label}`, actorId: "ops@pawspace.in",
      }),
      Error,
      `a split that ${label} must be refused`,
    );
  }
});

test("a valid split allocates exactly the custody and moves the commission with it", async () => {
  const { sqlite, db, adjudication } = await seedEscrow();
  sqlite.prepare("INSERT INTO provider_order_commissions (booking_id,provider_id,commission_amount,status,updated_at) VALUES (?,?,?, 'awaiting_approval_2',?)")
    .run(BOOKING, PROVIDER, 5000, Date.now());
  await reserve(adjudication, db);
  await adjudication.freezeEscrowForDispute(db, {
    bookingId: BOOKING, disputeReference: "DISP-D31-OK",
    reason: "Customer reports a partial service failure", actorId: "support@pawspace.in",
  });
  const decision = await adjudication.arbitrateEscrow(db, {
    bookingId: BOOKING, decision: "PARTIAL_SPLIT", providerAmount: 3000, customerAmount: 2000,
    reason: "Day-31: half the groom was completed, agreed split", actorId: "ops@pawspace.in",
  });
  assert.equal(decision.providerAmount, 3000);
  assert.equal(decision.customerAmount, 2000);

  const row = account(sqlite);
  assert.equal(
    Math.round((Number(row.allocated_provider_amount) + Number(row.allocated_customer_amount)) * 100) / 100,
    CAPTURED,
    "every rupee of custody must be allocated to exactly one side",
  );
  assert.equal(
    Number(sqlite.prepare("SELECT commission_amount FROM provider_order_commissions WHERE booking_id=?").get(BOOKING).commission_amount),
    3000,
    "an arbitration that cuts the provider's share must cut the commission still awaiting approval",
  );
});

test("an arbitration decision is final - a second one cannot re-cut the money", async () => {
  const { db, adjudication } = await seedEscrow();
  await reserve(adjudication, db);
  await adjudication.freezeEscrowForDispute(db, {
    bookingId: BOOKING, disputeReference: "DISP-D31-FINAL",
    reason: "Day-31 finality of an arbitration decision", actorId: "support@pawspace.in",
  });
  const first = await adjudication.arbitrateEscrow(db, {
    bookingId: BOOKING, decision: "ARBITRATION_REFUND_CUSTOMER",
    reason: "Day-31: service was not delivered, full refund", actorId: "ops@pawspace.in",
  });
  assert.equal(first.duplicatePrevented, false);
  assert.equal(first.customerAmount, CAPTURED);

  const second = await adjudication.arbitrateEscrow(db, {
    bookingId: BOOKING, decision: "ARBITRATION_RELEASE_PROVIDER",
    reason: "Day-31: someone tries to overturn it in favour of the provider", actorId: "ops2@pawspace.in",
  });
  assert.equal(second.duplicatePrevented, true, "the first decision stands");
  assert.equal(second.customerAmount, CAPTURED, "and the money still belongs to the customer");
});

test("an undisputed release pays the provider once, and only once", async () => {
  const { sqlite, db, adjudication } = await seedEscrow();
  await reserve(adjudication, db);
  const first = await adjudication.releaseUndisputedEscrowToProvider(db, {
    bookingId: BOOKING, actorId: "finance@pawspace.in", reason: "Day-31 no dispute raised in the window",
  });
  const second = await adjudication.releaseUndisputedEscrowToProvider(db, {
    bookingId: BOOKING, actorId: "finance@pawspace.in", reason: "Day-31 duplicate release attempt",
  });
  assert.equal(first.duplicatePrevented, false);
  assert.equal(second.duplicatePrevented, true);
  assert.equal(first.providerAmount, CAPTURED);
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) n FROM escrow_ledger_transactions WHERE booking_id=? AND event_type='RELEASE_PROVIDER'").get(BOOKING).n,
    1,
    "two release calls must leave one ledger entry",
  );
});

test("a payout may only draw on custody the settlement rail has actually confirmed", async () => {
  /*
   * Release is not the last gate. After an undisputed release the account sits at PAYOUT_PENDING
   * and the payout guard still refuses: it wants the settlement rail to have DELIVERED and a
   * SETTLEMENT_CONFIRMED ledger entry with a real external reference behind it. That ordering is
   * the point - money is cleared for payout only once the rail says it moved, not when Ops decided
   * it should.
   */
  const { db, adjudication, settlement } = await seedEscrow();
  await reserve(adjudication, db);

  await assert.rejects(
    () => settlement.requireEscrowProviderReleaseForPayout(db, { bookingId: BOOKING, maximumAmount: CAPTURED }),
    /escrow_settlement_not_confirmed_for_provider|escrow_custody_required/,
    "money merely held is not money cleared for payout",
  );

  await adjudication.releaseUndisputedEscrowToProvider(db, {
    bookingId: BOOKING, actorId: "finance@pawspace.in", reason: "Day-31 release before payout check",
  });
  await assert.rejects(
    () => settlement.requireEscrowProviderReleaseForPayout(db, { bookingId: BOOKING, maximumAmount: CAPTURED }),
    /escrow_settlement_not_confirmed_for_provider:PAYOUT_PENDING/,
    "an adjudicated release is still not a confirmed settlement",
  );

  const claimed = await settlement.claimNextEscrowSettlement(db, { workerId: "d31-settlement-worker" });
  assert.ok(claimed, "the release must have queued a settlement intent");
  await settlement.acknowledgeEscrowSettlement(db, {
    outboxId: String(claimed.id), workerId: "d31-settlement-worker", externalReference: "RZPX-D31-UTR-0001",
  });

  const cleared = await settlement.requireEscrowProviderReleaseForPayout(db, { bookingId: BOOKING, maximumAmount: CAPTURED });
  assert.equal(cleared.providerAmount, CAPTURED);
  assert.equal(cleared.liveApproved, false, "sandbox isolation must hold all the way to the payout gate");

  await assert.rejects(
    () => settlement.requireEscrowProviderReleaseForPayout(db, { bookingId: BOOKING, maximumAmount: CAPTURED - 1 }),
    /escrow_release_exceeds_commission/,
    "a release larger than the commission it is meant to fund must be refused",
  );
});

test("the reconciler catches an account that allocates more than it holds", async () => {
  /*
   * escrow_custodial_accounts is the row requireEscrowProviderReleaseForPayout reads, and that
   * guard compares released_provider_amount only against the commission ceiling handed to it -
   * never against custody. So an inflated figure here pays out money that was never collected.
   * Before this pass reconcileEscrowInvariants reported ok:true for exactly that state: it checks
   * the ledger hash chain and the dispute/outbox machine, and the hash chain protects the ledger's
   * history rather than this projection of it.
   */
  const { sqlite, db, adjudication, settlement } = await seedEscrow();
  await reserve(adjudication, db);
  await adjudication.releaseUndisputedEscrowToProvider(db, {
    bookingId: BOOKING, actorId: "finance@pawspace.in", reason: "Day-31 reconcile a clean account",
  });
  const claimed = await settlement.claimNextEscrowSettlement(db, { workerId: "d31-settlement-worker" });
  await settlement.acknowledgeEscrowSettlement(db, {
    outboxId: String(claimed.id), workerId: "d31-settlement-worker", externalReference: "RZPX-D31-UTR-0002",
  });

  const clean = await settlement.reconcileEscrowInvariants(db);
  assert.equal(clean.ok, true, `a fully settled account must reconcile: ${JSON.stringify(clean.issues).slice(0, 400)}`);

  const breaches = [
    ["allocates 1,000 more than custody holds", "UPDATE escrow_custodial_accounts SET allocated_provider_amount=allocated_provider_amount+1000 WHERE booking_id=?"],
    ["releases more than was allocated", "UPDATE escrow_custodial_accounts SET released_provider_amount=released_provider_amount+1000 WHERE booking_id=?"],
    ["refunds a customer share that was never allocated", "UPDATE escrow_custodial_accounts SET refunded_customer_amount=500 WHERE booking_id=?"],
  ];
  for (const [label, sql] of breaches) {
    const snapshot = sqlite.prepare("SELECT allocated_provider_amount a,released_provider_amount r,refunded_customer_amount c FROM escrow_custodial_accounts WHERE booking_id=?").get(BOOKING);
    sqlite.prepare(sql).run(BOOKING);
    const result = await settlement.reconcileEscrowInvariants(db);
    assert.equal(result.ok, false, `must be reported: an account that ${label}`);
    assert.ok(
      result.issues.some((issue) => issue.alarmType === "ESCROW_CUSTODY_CONSERVATION_BREACH"),
      `must raise a conservation breach for: ${label} (got ${result.issues.map((i) => i.alarmType).join(",")})`,
    );
    assert.equal(result.issues.find((i) => i.alarmType === "ESCROW_CUSTODY_CONSERVATION_BREACH").severity, "P0",
      "money that does not add up is a P0");
    sqlite.prepare("UPDATE escrow_custodial_accounts SET allocated_provider_amount=?,released_provider_amount=?,refunded_customer_amount=? WHERE booking_id=?")
      .run(snapshot.a, snapshot.r, snapshot.c, BOOKING);
  }

  assert.equal((await settlement.reconcileEscrowInvariants(db)).ok, true, "and the account reconciles again once restored");
});

test("a breach is raised as a durable alarm, not just a return value", async () => {
  const { sqlite, db, adjudication, settlement } = await seedEscrow();
  await reserve(adjudication, db);
  sqlite.prepare("UPDATE escrow_custodial_accounts SET allocated_provider_amount=custody_amount+2500 WHERE booking_id=?").run(BOOKING);
  await settlement.reconcileEscrowInvariants(db);
  const alarm = sqlite.prepare("SELECT alarm_type,severity,status FROM escrow_reconciliation_alarms WHERE booking_id=? AND alarm_type='ESCROW_CUSTODY_CONSERVATION_BREACH'").get(BOOKING);
  assert.ok(alarm, "the breach must be persisted where an operator will see it");
  assert.equal(alarm.severity, "P0");
  assert.equal(alarm.status, "OPEN");
});
