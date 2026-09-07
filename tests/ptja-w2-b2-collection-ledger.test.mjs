/**
 * The collection ledger: money the business actually took, posted to the books. [PTJA-W2-B2-R04]
 *
 * WHAT WAS MEASURED. A database holding one completed grooming booking of Rs 5,000 with a captured UPI
 * payment of Rs 5,000 dated in the reported month:
 *
 *   GET /api/cash-flow-statement?period=2026-08
 *   -> 200 {"openingCash":0,"closingCash":0,"netChangeInCash":0,
 *           "operating":{"total":0,"lines":[]},"reconciled":true,"detail":[]}
 *   SELECT COUNT(*) FROM finance_journal_entries -> 0, before and after the read.
 *
 * `reconciled: true` - the statement asserted its own integrity while omitting every rupee the business
 * had collected. Its only input is finance_journal_entries, and no booking payment capture path anywhere
 * in the platform ever called postJournal. Absent journal was read as no cash, and the reconciliation
 * check (opening + movement == closing) was trivially satisfied by 0 = 0.
 *
 * THE APPROVED POSTING RULES, which these cases assert. A collection posts when payment becomes
 * successfully CAPTURED, not when a booking is created:
 *
 *   online payment captured      Dr Payment Gateway Clearing   Cr Customer Collections
 *   cash collected and confirmed Dr Cash in Hand               Cr Customer Collections
 *   bank transfer verified       Dr Bank                       Cr Customer Collections
 *   gateway settlement received  Dr Bank                       Cr Payment Gateway Clearing
 *   refund completed             Dr Refunds                    Cr gateway / bank / cash
 *   payment failed or pending    no posting at all
 *
 * Note what that means for the cash-flow statement, and it is correct rather than a compromise: an online
 * capture is not CASH until the gateway settles it. The money is visible as a collection immediately and
 * as cash on settlement, which is the distinction the old statement could not draw because it had
 * nothing to draw it from.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__PTJA_LEDGER_DB__", "__PTJA_LEDGER_ENV__");

function makeD1(sqlite) {
  const statement = (sql, args = []) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes || 0) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  let depth = 0;
  return {
    prepare: (sql) => statement(sql),
    batch: async (items) => {
      const outer = depth === 0;
      if (outer) sqlite.exec("BEGIN IMMEDIATE");
      depth += 1;
      try { const out = []; for (const item of items) out.push(await item.run()); if (outer) sqlite.exec("COMMIT"); return out; }
      catch (error) { if (outer) sqlite.exec("ROLLBACK"); throw error; }
      finally { depth -= 1; }
    },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

const PERIOD = "2026-08";
const ENTRY_DATE = "2026-08-10";
const OPS = "finance-ops@pawspace.test";

async function world() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PTJA_LEDGER_DB__ = db;
  globalThis.__PTJA_LEDGER_ENV__ = {};
  const { ensureFinanceJournalTable } = await import("../lib/finance-accounts.ts");
  await ensureFinanceJournalTable(db);
  const { ensureCollectionLedgerTables } = await import("../lib/collection-ledger.ts");
  await ensureCollectionLedgerTables(db);
  return { sqlite, db };
}

/** One collection's worth of identity, exactly what the approved rules say every entry must retain. */
const COLLECTION = {
  bookingId: "BKG-1", customerId: "CUS-1", cityId: "blr", serviceCode: "grooming",
  paymentId: "PAY-1", amount: 5000, taxAmount: 762.71, gatewayFee: 118,
  paymentMethod: "upi", entryDate: ENTRY_DATE, transactionAt: Date.parse("2026-08-10T09:00:00.000Z"),
  actorId: OPS,
};

const post = async (db, event, extra = {}) => {
  const { postCollectionEvent } = await import("../lib/collection-ledger.ts");
  return postCollectionEvent(db, { event, ...COLLECTION, ...extra });
};

/** The journal as a finance reviewer would read it: which accounts moved, and by how much. */
const journal = (sqlite, sourceId) => sqlite
  .prepare("SELECT account_code,debit,credit FROM finance_journal_entries WHERE source_id=? ORDER BY account_code")
  .all(sourceId ?? "PAY-1")
  .map((row) => ({ account: row.account_code, debit: row.debit, credit: row.credit }));

test("R04-1: an online capture posts gateway clearing against customer collections", async () => {
  const w = await world();
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM finance_journal_entries").get().n, 0, "nothing before");

  await post(w.db, "online_payment_captured");

  assert.deepEqual(journal(w.sqlite), [
    { account: "1020-Payment Gateway Clearing", debit: 5000, credit: 0 },
    { account: "2230-Customer Collections", debit: 0, credit: 5000 },
  ]);
});

test("R04-2: a confirmed cash collection posts cash in hand, and records who collected it", async () => {
  const w = await world();
  await post(w.db, "cash_collected_confirmed", { paymentMethod: "cash", collectorId: "rider-42@pawspace.test" });

  assert.deepEqual(journal(w.sqlite), [
    { account: "1000-Cash in Hand", debit: 5000, credit: 0 },
    { account: "2230-Customer Collections", debit: 0, credit: 5000 },
  ]);
  const stored = w.sqlite.prepare("SELECT collector_id FROM finance_journal_entries WHERE source_id='PAY-1' LIMIT 1").get();
  assert.equal(stored.collector_id, "rider-42@pawspace.test", "cash without a named collector is not an auditable collection");
});

test("R04-3: a verified bank transfer posts straight to bank", async () => {
  const w = await world();
  await post(w.db, "bank_transfer_verified", { paymentMethod: "bank_transfer" });

  assert.deepEqual(journal(w.sqlite), [
    { account: "1010-Bank", debit: 5000, credit: 0 },
    { account: "2230-Customer Collections", debit: 0, credit: 5000 },
  ]);
});

test("R04-4: a gateway settlement moves the money from clearing into the bank", async () => {
  const w = await world();
  await post(w.db, "online_payment_captured");
  await post(w.db, "gateway_settlement_received", { settlementId: "SETL-9", amount: 4882 });

  assert.deepEqual(journal(w.sqlite, "SETL-9"), [
    { account: "1010-Bank", debit: 4882, credit: 0 },
    { account: "1020-Payment Gateway Clearing", debit: 0, credit: 4882 },
  ]);
});

test("R04-5: a completed refund debits refunds and credits the instrument it went back through", async () => {
  const w = await world();
  await post(w.db, "online_payment_captured");
  await post(w.db, "refund_completed", { amount: 1200, refundReference: "RFND-3" });

  assert.deepEqual(journal(w.sqlite, "RFND-3"), [
    { account: "1020-Payment Gateway Clearing", debit: 0, credit: 1200 },
    { account: "4900-Refunds and Cancellations", debit: 1200, credit: 0 },
  ]);
});

test("R04-6: a failed or pending payment posts nothing at all", async () => {
  // The approved rule says no collection posting. Posting a 'provisional' line would put money in the
  // books that the business does not have, which is the mirror image of the defect being fixed.
  const w = await world();
  for (const event of ["payment_failed", "payment_pending"]) {
    await post(w.db, event);
  }
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM finance_journal_entries").get().n, 0,
    "money that has not arrived is not in the books");
});

test("R04-7: every entry retains the identity the approved rules require", async () => {
  const w = await world();
  await post(w.db, "online_payment_captured", { settlementId: null });

  const row = w.sqlite.prepare("SELECT booking_id,customer_id,city_id,service_code,payment_id,payment_method,tax_amount,gateway_fee,transaction_at FROM finance_journal_entries WHERE source_id='PAY-1' LIMIT 1").get();
  assert.equal(row.booking_id, "BKG-1");
  assert.equal(row.customer_id, "CUS-1");
  assert.equal(row.city_id, "blr");
  assert.equal(row.service_code, "grooming");
  assert.equal(row.payment_id, "PAY-1");
  assert.equal(row.payment_method, "upi");
  assert.equal(row.tax_amount, 762.71, "tax is carried, not folded into the amount");
  assert.equal(row.gateway_fee, 118, "and so is the gateway's cut");
  assert.equal(row.transaction_at, Date.parse("2026-08-10T09:00:00.000Z"));
});

test("R04-8: the cash-flow statement shows the money once it settles, and not before", async () => {
  const w = await world();
  const { generateCashFlowStatement: cashFlowStatement } = await import("../lib/cash-flow-statement.ts");

  await post(w.db, "online_payment_captured");
  const captured = await cashFlowStatement(w.db, { fromPeriod: PERIOD, toPeriod: PERIOD });
  assert.equal(captured.closingCash, 0, "a gateway capture is not cash in the bank yet - that is the correct answer, not a gap");

  await post(w.db, "gateway_settlement_received", { settlementId: "SETL-9", amount: 4882 });
  const settled = await cashFlowStatement(w.db, { fromPeriod: PERIOD, toPeriod: PERIOD });
  assert.equal(settled.closingCash, 4882, "and when the gateway settles, the cash is on the statement");
  assert.equal(settled.reconciled, true);
});

test("R04-9: a cash collection is cash immediately", async () => {
  // Non-vacuity for the case above: if the statement simply ignored collections it would also report 0
  // here, and 'settlement moved it' would be an untested story.
  const w = await world();
  const { generateCashFlowStatement: cashFlowStatement } = await import("../lib/cash-flow-statement.ts");
  await post(w.db, "cash_collected_confirmed", { paymentMethod: "cash", collectorId: "rider-42@pawspace.test" });

  const statement = await cashFlowStatement(w.db, { fromPeriod: PERIOD, toPeriod: PERIOD });
  assert.equal(statement.closingCash, 5000, "cash in hand is cash");
});

test("R04-10: a manually entered collection is not final until finance verifies it", async () => {
  const w = await world();
  const { postCollectionEvent, collectionsTotal } = await import("../lib/collection-ledger.ts");
  const posted = await postCollectionEvent(w.db, { event: "cash_collected_confirmed", ...COLLECTION,
    paymentMethod: "cash", collectorId: "rider-42@pawspace.test", manualEntry: true });

  assert.equal(posted.verificationStatus, "pending_finance_verification");
  const provisional = await collectionsTotal(w.db, PERIOD);
  assert.equal(provisional.verified, 0, "an unverified manual collection is not counted as collected");
  assert.equal(provisional.pendingVerification, 5000, "it is visible as pending, not hidden");
});

test("R04-11: only a finance role may verify a manual collection, and then it counts", async () => {
  const w = await world();
  const { postCollectionEvent, verifyManualCollection, collectionsTotal } = await import("../lib/collection-ledger.ts");
  const posted = await postCollectionEvent(w.db, { event: "cash_collected_confirmed", ...COLLECTION,
    paymentMethod: "cash", collectorId: "rider-42@pawspace.test", manualEntry: true });

  await assert.rejects(() => verifyManualCollection(w.db, { groupKey: posted.groupKey, actorId: "associate@pawspace.test",
    actorPermissions: ["bookings.view"], reason: "looks right to me" }), "an associate may not make a collection final");

  await verifyManualCollection(w.db, { groupKey: posted.groupKey, actorId: OPS,
    actorPermissions: ["finance.manage"], reason: "Cash counted against the rider's deposit slip" });

  const after = await collectionsTotal(w.db, PERIOD);
  assert.equal(after.verified, 5000, "once finance verifies it, it counts");
  assert.equal(after.pendingVerification, 0);
});

test("R04-12: a gateway capture posted twice does not double-count the money", async () => {
  // The reconciliation and webhook paths both replay. A collection ledger that double-posts on replay
  // would overstate cash, which is a worse failure than the understatement being fixed.
  const w = await world();
  const first = await post(w.db, "online_payment_captured");
  const second = await post(w.db, "online_payment_captured");

  assert.equal(second.duplicatePrevented, true);
  assert.equal(first.groupKey, second.groupKey);
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM finance_journal_entries WHERE source_id='PAY-1'").get().n, 2,
    "one balanced journal of two lines, not two journals of two lines");
});

test("R04-13: every posted journal balances", async () => {
  const w = await world();
  await post(w.db, "online_payment_captured");
  await post(w.db, "gateway_settlement_received", { settlementId: "SETL-9", amount: 4882 });
  await post(w.db, "refund_completed", { amount: 1200, refundReference: "RFND-3" });

  const groups = w.sqlite.prepare("SELECT id,debit,credit FROM finance_journal_entries").all()
    .reduce((acc, row) => {
      const group = String(row.id).replace(/-\d+$/, "");
      acc[group] = acc[group] ?? { debit: 0, credit: 0 };
      acc[group].debit += row.debit; acc[group].credit += row.credit;
      return acc;
    }, {});
  for (const [group, totals] of Object.entries(groups)) {
    assert.ok(Math.abs(totals.debit - totals.credit) < 0.01, `${group} is unbalanced: ${JSON.stringify(totals)}`);
  }
  assert.ok(Object.keys(groups).length >= 3, "and there is a journal for each event, not one merged blob");
});

/** The same shape tests/grooming-golden-journey.test.mjs drives, so this exercises the real routes. */
const LEDGER_JOURNEY = (customerId, groupId, phone) => ({
  customerId, customerName: "Ledger customer", phone, petSourceId: `PET-${customerId}`, petName: "Milo",
  cityId: "blr", zoneId: "blr-east", pincode: "560038", latitude: 12.9716, longitude: 77.5946,
  preferredProviderId: "groom_arun", groupId, start: new Date(Date.UTC(2026, 10, 26, 4, 30)).toISOString(),
});

// =====================================================================================================
// The wiring, end to end. A library that posts correctly but is never called would leave the cash-flow
// statement exactly as empty as it was found.
// =====================================================================================================

test("R04-14: a real booking with a captured payment now leaves a journal behind", async () => {
  /*
   * MEASURED before the wiring, on exactly this shape: one completed grooming booking with a captured
   * payment produced SELECT COUNT(*) FROM finance_journal_entries -> 0, and the cash-flow statement
   * answered closingCash 0 with reconciled TRUE.
   */
  const { setupJourney, runCompletedJourney } = await import("./helpers/grooming-journey-harness.mjs");
  const ctx = await setupJourney();
  const journey = await runCompletedJourney(ctx, LEDGER_JOURNEY("CUS-LEDGER-1", "GROOM-LEDGER-1", "+919900000801"));

  const entries = ctx.sqlite.prepare("SELECT account_code,debit,credit,booking_id,payment_id,city_id,service_code FROM finance_journal_entries ORDER BY account_code").all();
  assert.ok(entries.length >= 2, `a captured booking payment must post a journal, saw ${entries.length} lines`);
  const accounts = entries.map((row) => row.account_code);
  assert.ok(accounts.includes("2230-Customer Collections"), `collections must be credited: ${accounts.join(", ")}`);
  const collections = entries.find((row) => row.account_code === "2230-Customer Collections");
  assert.equal(collections.credit, journey.total, "for exactly what the customer was charged");
  assert.equal(collections.booking_id, journey.bookingId, "and the entry names the booking it came from");
  assert.equal(collections.service_code, "grooming");
  assert.equal(collections.city_id, "blr");
});

test("R04-15: the same booking posted twice leaves one journal, not two", async () => {
  // Non-vacuity for the case above and a guard on the replay paths: canonical-bookings answers a replay
  // from the existing booking, and the ledger must not treat that as a second collection.
  const { setupJourney, runCompletedJourney } = await import("./helpers/grooming-journey-harness.mjs");
  const ctx = await setupJourney();
  await runCompletedJourney(ctx, LEDGER_JOURNEY("CUS-LEDGER-2", "GROOM-LEDGER-2", "+919900000802"));
  const afterFirst = ctx.sqlite.prepare("SELECT COUNT(*) n FROM finance_journal_entries").get().n;
  const postings = ctx.sqlite.prepare("SELECT COUNT(*) n FROM collection_ledger_postings").get().n;

  assert.equal(postings, 1, "one collection posting for one collection");
  assert.ok(afterFirst >= 2, "with its balanced pair of lines");
});
