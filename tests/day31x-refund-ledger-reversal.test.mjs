/*
 * Day-31 wave 9: bridging a verified gateway refund into the collection ledger.
 *
 * razorpay refund.processed -> booking refund case lookup -> amount agreement -> collection
 * reversal posted once.
 *
 * lib/refund-collection-reversal.ts had no test importing it. It is the step that turns money
 * leaving Razorpay into money leaving the books. Two things go wrong here and neither shows up
 * as an error at the time: the same refund posted twice (the books now say we refunded more than
 * we did), or a refund posted for an amount that is not the one the gateway actually moved.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world } from "./helpers/execution-harness.mjs";

installWorkersHooks("__D31X_RCR_DB__", "__D31X_RCR_ENV__");

const BOOKING = "BK-RCR-001";
const PAYMENT = "PAY-RCR-001";
const CUSTOMER = "CUS-RCR-001";
const REFUND_CASE = "RC-RCR-001";
const GATEWAY_REFUND = "rfnd_D31TEST001";
const REFUND_AMOUNT = 1500;

async function seedReversal({ refundAmount = REFUND_AMOUNT, gatewayReference = GATEWAY_REFUND } = {}) {
  const { sqlite, db } = world("__D31X_RCR_DB__", "__D31X_RCR_ENV__");
  const { ensureCollectionLedgerTables } = await import("../lib/collection-ledger.ts");
  await ensureCollectionLedgerTables(db).catch(() => {});
  const reversal = await import("../lib/refund-collection-reversal.ts");
  const now = Date.now();

  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,city_id TEXT,service_code TEXT,provider_id TEXT,status TEXT,total_amount REAL,currency TEXT,scheduled_start TEXT)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT,amount REAL,amount_due_now REAL,currency TEXT,method TEXT,mode TEXT,status TEXT,gateway TEXT,idempotency_key TEXT UNIQUE,detail_json TEXT DEFAULT '{}',created_at INTEGER,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_refund_cases (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,payment_id TEXT,amount REAL NOT NULL DEFAULT 0,reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'requested',requested_by TEXT NOT NULL,approved_by TEXT,gateway_reference TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");

  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,city_id,service_code,status,total_amount,currency,scheduled_start) VALUES (?,?,'blr','grooming','cancelled',3000,'INR',?)")
    .run(BOOKING, CUSTOMER, new Date(now).toISOString());
  sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,currency,method,mode,status,gateway,idempotency_key,created_at,updated_at) VALUES (?,?,?,3000,3000,'INR','razorpay','full','partially_refunded','razorpay_sandbox',?,?,?)")
    .run(PAYMENT, BOOKING, CUSTOMER, `idem-${PAYMENT}`, now, now);
  sqlite.prepare("INSERT INTO booking_refund_cases (id,booking_id,payment_id,amount,reason,status,requested_by,gateway_reference,created_at,updated_at) VALUES (?,?,?,?,?,'processed','ops@pawspace.in',?,?,?)")
    .run(REFUND_CASE, BOOKING, PAYMENT, refundAmount, "Day-31 cancellation refund", gatewayReference, now, now);
  return { sqlite, db, reversal };
}

/*
 * The real table, named explicitly. An earlier revision of this helper fell back to listing
 * sqlite_master when the table name was wrong, so "no ledger rows" silently became "one table
 * matched" and the refused-reversal assertion read a table name as if it were a posting.
 */
const ledgerRows = (sqlite) => sqlite.prepare("SELECT * FROM collection_ledger_postings").all();

test("a verified gateway refund posts one reversal against the booking", async () => {
  const { db, reversal } = await seedReversal();
  const result = await reversal.postBookingRefundCollectionReversal(db, {
    gatewayRefundId: GATEWAY_REFUND, amountSubunits: REFUND_AMOUNT * 100, createdAt: Date.now(),
  });
  assert.notEqual(result.handled, false, `the reversal must post: ${JSON.stringify(result)}`);
});

test("the same gateway refund replayed does not reverse the money twice", async () => {
  /*
   * Razorpay retries a webhook it did not get a 2xx for, and reconciliation re-runs over the same
   * window. Both call this with the identical refund id. A second reversal would tell the books
   * we refunded twice what we actually did.
   */
  const { sqlite, db, reversal } = await seedReversal();
  const args = { gatewayRefundId: GATEWAY_REFUND, amountSubunits: REFUND_AMOUNT * 100, createdAt: Date.now() };
  await reversal.postBookingRefundCollectionReversal(db, args);
  const after1 = ledgerRows(sqlite).length;
  await reversal.postBookingRefundCollectionReversal(db, args);
  await reversal.postBookingRefundCollectionReversal(db, { ...args, createdAt: Date.now() + 60_000 });
  assert.equal(ledgerRows(sqlite).length, after1,
    "the gateway refund id is the accounting identity - replays must post nothing new");
});

test("a refund for an amount the case does not agree with is refused", async () => {
  /*
   * The webhook says how much actually moved. If that disagrees with the case we approved,
   * something is wrong and the books must not be written either way.
   */
  const { sqlite, db, reversal } = await seedReversal();
  for (const [label, subunits] of [
    ["more than approved", (REFUND_AMOUNT + 1) * 100],
    ["less than approved", (REFUND_AMOUNT - 1) * 100],
    ["an order of magnitude out", REFUND_AMOUNT * 1000],
  ]) {
    await assert.rejects(
      () => reversal.postBookingRefundCollectionReversal(db, { gatewayRefundId: GATEWAY_REFUND, amountSubunits: subunits }),
      /amount mismatch/i,
      `a refund of ${label} must not be posted`,
    );
  }
  assert.equal(ledgerRows(sqlite).length, 0, "and a refused reversal must write nothing at all");
});

test("an unknown or absent gateway refund id is reported, not guessed at", async () => {
  const { db, reversal } = await seedReversal();
  assert.deepEqual(
    await reversal.postBookingRefundCollectionReversal(db, { gatewayRefundId: "", amountSubunits: 100 }),
    { handled: false, reason: "refund_reference_missing" },
  );
  assert.deepEqual(
    await reversal.postBookingRefundCollectionReversal(db, { gatewayRefundId: null, amountSubunits: 100 }),
    { handled: false, reason: "refund_reference_missing" },
  );
  const unknown = await reversal.postBookingRefundCollectionReversal(db, { gatewayRefundId: "rfnd_NEVER_SEEN", amountSubunits: 100 });
  assert.equal(unknown.handled, false);
  assert.equal(unknown.reason, "booking_refund_case_not_found",
    "a refund we have no case for must be surfaced, never posted on a guess");
});

test("a refund case with no amount cannot post a reversal", async () => {
  const { db, reversal } = await seedReversal({ refundAmount: 0 });
  await assert.rejects(
    () => reversal.postBookingRefundCollectionReversal(db, { gatewayRefundId: GATEWAY_REFUND, amountSubunits: 0 }),
    /positive refund amount/,
    "a zero-value reversal is not an accounting event",
  );
});

test("a refund case with no canonical payment cannot post a reversal", async () => {
  /*
   * The collection ledger reverses a specific collection. Without the payment id there is nothing
   * to reverse against, and posting anyway would leave an unattributable entry in the books.
   */
  const { sqlite, db, reversal } = await seedReversal();
  sqlite.prepare("UPDATE booking_refund_cases SET payment_id=NULL WHERE id=?").run(REFUND_CASE);
  await assert.rejects(
    () => reversal.postBookingRefundCollectionReversal(db, { gatewayRefundId: GATEWAY_REFUND, amountSubunits: REFUND_AMOUNT * 100 }),
    /canonical payment id/,
  );
});

test("the webhook's own timestamp dates the entry, and a missing one does not break it", async () => {
  const { db, reversal } = await seedReversal();
  const backdated = Date.parse("2026-09-01T10:00:00Z");
  const result = await reversal.postBookingRefundCollectionReversal(db, {
    gatewayRefundId: GATEWAY_REFUND, amountSubunits: REFUND_AMOUNT * 100, createdAt: backdated,
  });
  assert.notEqual(result.handled, false);

  const { db: db2, reversal: rev2 } = await seedReversal();
  const noTimestamp = await rev2.postBookingRefundCollectionReversal(db2, {
    gatewayRefundId: GATEWAY_REFUND, amountSubunits: REFUND_AMOUNT * 100, createdAt: null,
  });
  assert.notEqual(noTimestamp.handled, false, "an absent timestamp must fall back, not fail the posting");
});

test("an absent amount is taken as the approved amount rather than as zero", async () => {
  /*
   * Number(undefined) is NaN and Number(null) is 0. Treating a missing amount as zero would post
   * a reversal of nothing and mark the refund as reconciled.
   */
  const { db, reversal } = await seedReversal();
  const result = await reversal.postBookingRefundCollectionReversal(db, {
    gatewayRefundId: GATEWAY_REFUND, amountSubunits: undefined,
  });
  assert.notEqual(result.handled, false, "an absent amount must fall back to the approved amount");
});
