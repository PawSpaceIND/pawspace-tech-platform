/**
 * Recognised revenue and collected revenue, both authoritative, reported side by side. [PTJA-W2-08-F03]
 *
 * WHAT WAS MEASURED. For one CLOSED and locked month, two governed finance surfaces published two
 * different revenue figures for the same period, with nothing reconciling them:
 *
 *   monthlyCloseView('2026-07')  -> revenue {bookings:15000, bookingCount:2}, checklist
 *                                   revenue_reconciled ok:TRUE value 15000
 *   generatePnlReport('2026-07') -> totalTurnoverAmount 5000, dataSource 'platform_live'
 *
 * The close returns a frozen snapshot; the P&L recomputes live from canonical_bookings. A late refund
 * cancelled a Rs 10,000 booking inside the locked period, so the two drifted permanently apart - and
 * neither surface reported the refund at all. A reader could not tell which number was authoritative,
 * and the close asserted `revenue_reconciled ok:true` while being 10,000 away from the other figure.
 *
 * THE APPROVED ANSWER is not to pick a winner. Both stay authoritative, for different questions:
 *
 *   recognised revenue  the authoritative P&L / revenue figure
 *   collected revenue   the authoritative cash-flow and collection figure
 *
 * Service revenue is recognised when the service is COMPLETED and financially approved. Advance payments
 * stay customer advances / deferred revenue until delivery. Refunds and cancellations reverse or adjust
 * the appropriate amount. Monthly reporting shows recognised revenue, gross collections, refunds, net
 * collections, deferred revenue, outstanding receivables, and the recognised-minus-collected
 * reconciliation - and the two figures are NEVER forced to match.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__PTJA_REVREC_DB__", "__PTJA_REVREC_ENV__");

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

const PERIOD = "2026-07";
const DATE = "2026-07-15";
const OPS = "finance@pawspace.test";

async function world() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PTJA_REVREC_DB__ = db;
  globalThis.__PTJA_REVREC_ENV__ = {};
  const { ensureCollectionLedgerTables } = await import("../lib/collection-ledger.ts");
  const { ensureRevenueRecognitionTables } = await import("../lib/revenue-recognition-governance.ts");
  await ensureCollectionLedgerTables(db);
  await ensureRevenueRecognitionTables(db);
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,provider_id TEXT,service_code TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT,scheduled_start TEXT NOT NULL,scheduled_end TEXT,status TEXT NOT NULL,total_amount REAL NOT NULL,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT,amount REAL NOT NULL,status TEXT NOT NULL,method TEXT,updated_at INTEGER)");
  return { sqlite, db };
}

/** One booking, its payment, and optionally the collection that was actually taken for it. */
async function booking(w, { id, amount, status, paymentStatus = "captured", collected = null, serviceDate = DATE }) {
  const now = Date.parse(`${serviceDate}T09:00:00.000Z`);
  w.sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,provider_id,service_code,city_id,scheduled_start,status,total_amount,updated_at) VALUES (?,?,?,'grooming','blr',?,?,?,?)")
    .run(id, `CUS-${id}`, "groom_arun", `${serviceDate}T09:00:00.000Z`, status, amount, now);
  w.sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,status,method,updated_at) VALUES (?,?,?,?,?,'upi',?)")
    .run(`PAY-${id}`, id, `CUS-${id}`, amount, paymentStatus, now);
  if (collected !== null) {
    const { postCollectionEvent } = await import("../lib/collection-ledger.ts");
    await postCollectionEvent(w.db, { event: "online_payment_captured", bookingId: id, customerId: `CUS-${id}`,
      cityId: "blr", serviceCode: "grooming", paymentId: `PAY-${id}`, amount: collected, paymentMethod: "upi",
      entryDate: serviceDate, transactionAt: now, actorId: OPS });
  }
}

const report = async (w, period = PERIOD) => {
  const { monthlyRevenueReconciliation } = await import("../lib/revenue-reconciliation-report.ts");
  return monthlyRevenueReconciliation(w.db, { period });
};

test("F03-1: the report publishes all seven lines the approved policy requires", async () => {
  const w = await world();
  const result = await report(w);
  for (const line of ["recognisedRevenue", "grossCollections", "refunds", "netCollections",
    "deferredRevenue", "outstandingReceivables", "recognisedMinusCollected"]) {
    assert.ok(line in result, `the monthly report must publish ${line}: ${Object.keys(result).join(", ")}`);
  }
});

test("F03-2: revenue is recognised when the service is completed and financially approved", async () => {
  const w = await world();
  await booking(w, { id: "BK-DONE", amount: 5000, status: "completed", collected: 5000 });

  const result = await report(w);
  assert.equal(result.recognisedRevenue, 5000, "a completed, paid booking is recognised revenue");
});

test("F03-3: a booking that has not been delivered is deferred, not recognised", async () => {
  // The approved rule: advance payments remain customer advances / deferred revenue until delivery.
  const w = await world();
  await booking(w, { id: "BK-ADVANCE", amount: 8000, status: "confirmed", collected: 8000 });

  const result = await report(w);
  assert.equal(result.recognisedRevenue, 0, "money taken for a service not yet delivered is not revenue");
  assert.equal(result.grossCollections, 8000, "but it IS collected, and the collection figure says so");
  assert.equal(result.deferredRevenue, 8000, "and it sits in deferred revenue until the service happens");
});

test("F03-4: a completed service whose payment is not approved is not recognised", async () => {
  // "Completed AND financially approved" is a conjunction. Recognising on delivery alone would book
  // revenue for money the business may never see.
  const w = await world();
  await booking(w, { id: "BK-UNPAID", amount: 3000, status: "completed", paymentStatus: "pending", collected: null });

  const result = await report(w);
  assert.equal(result.recognisedRevenue, 0, "delivery without an approved payment is not revenue yet");
  assert.equal(result.outstandingReceivables, 3000, "it is a receivable - work done, money not in");
});

test("F03-5: refunds are reported as their own line and reduce net collections", async () => {
  const w = await world();
  await booking(w, { id: "BK-REF", amount: 10000, status: "completed", collected: 10000 });
  const { postCollectionEvent } = await import("../lib/collection-ledger.ts");
  await postCollectionEvent(w.db, { event: "refund_completed", bookingId: "BK-REF", customerId: "CUS-BK-REF",
    cityId: "blr", serviceCode: "grooming", paymentId: "PAY-BK-REF", refundReference: "RFND-1",
    amount: 4000, entryDate: DATE, transactionAt: Date.parse(`${DATE}T10:00:00.000Z`), actorId: OPS });

  const result = await report(w);
  assert.equal(result.grossCollections, 10000, "gross collections are what came in");
  assert.equal(result.refunds, 4000, "refunds are their own line, not a disappearance");
  assert.equal(result.netCollections, 6000, "and net collections are what the business kept");
});

test("F03-6: the two figures are reported side by side and never forced to match", async () => {
  /*
   * The exact shape that produced the finding: one month where recognised and collected genuinely
   * differ. The old surfaces published 15000 and 5000 for the same locked month with no reconciliation
   * and a green `revenue_reconciled` tick. Here the difference is stated, explained and reconciled.
   */
  const w = await world();
  await booking(w, { id: "BK-A", amount: 10000, status: "confirmed", collected: 10000 });   // paid, not delivered
  await booking(w, { id: "BK-B", amount: 5000, status: "completed", collected: 5000 });     // delivered and paid

  const result = await report(w);
  assert.equal(result.recognisedRevenue, 5000, "only the delivered service is revenue");
  assert.equal(result.grossCollections, 15000, "but 15,000 was collected");
  assert.equal(result.recognisedMinusCollected, -10000, "and the report states the gap rather than hiding it");
  assert.equal(result.forcedToMatch, false, "the two figures are never reconciled by adjusting one to the other");
});

test("F03-7: the reconciliation explains the whole difference, line by line", async () => {
  // A number stating "we are 10,000 apart" without saying why is the same problem in a nicer format.
  const w = await world();
  await booking(w, { id: "BK-A", amount: 10000, status: "confirmed", collected: 10000 });
  await booking(w, { id: "BK-B", amount: 5000, status: "completed", collected: 5000 });
  await booking(w, { id: "BK-C", amount: 3000, status: "completed", paymentStatus: "pending", collected: null });

  const result = await report(w);
  const bridge = result.reconciliation;
  assert.ok(Array.isArray(bridge.components) && bridge.components.length, "the bridge names its components");
  const total = bridge.components.reduce((sum, item) => sum + item.amount, 0);
  assert.ok(Math.abs(total - result.recognisedMinusCollected) < 0.01,
    `the components must add up to the gap: ${JSON.stringify(bridge.components)} against ${result.recognisedMinusCollected}`);
  assert.ok(bridge.components.some((item) => /deferred|advance/i.test(item.label)), "deferred revenue is one of them");
  assert.ok(bridge.components.some((item) => /receivable/i.test(item.label)), "and so are receivables");
});

test("F03-8: a month where everything was delivered and paid reconciles to zero", async () => {
  // Non-vacuity. If the bridge always reported a gap, the reconciliation would be noise.
  const w = await world();
  await booking(w, { id: "BK-CLEAN", amount: 7000, status: "completed", collected: 7000 });

  const result = await report(w);
  assert.equal(result.recognisedRevenue, 7000);
  assert.equal(result.grossCollections, 7000);
  assert.equal(result.recognisedMinusCollected, 0, "delivered and paid in the same month means no gap");
  assert.deepEqual(result.reconciliation.components.filter((item) => item.amount !== 0), []);
});

test("F03-9: each figure names which report it is authoritative for", async () => {
  // The finding was a reader unable to tell which number to trust. Publishing both without saying what
  // each is FOR would leave that unanswered.
  const w = await world();
  const result = await report(w);
  assert.match(result.authority.recognisedRevenue, /P&L|profit|revenue/i);
  assert.match(result.authority.collections, /cash|collection/i);
});

test("F03-10: an unverified manual collection is not counted as collected", async () => {
  // The collection ledger holds it as pending finance verification; the revenue report must honour that
  // rather than quietly promoting it to a published figure.
  const w = await world();
  const { postCollectionEvent } = await import("../lib/collection-ledger.ts");
  await postCollectionEvent(w.db, { event: "cash_collected_confirmed", bookingId: "BK-M", customerId: "CUS-M",
    cityId: "blr", serviceCode: "grooming", paymentId: "PAY-M", amount: 2500, paymentMethod: "cash",
    collectorId: "rider-7@pawspace.test", manualEntry: true, entryDate: DATE,
    transactionAt: Date.parse(`${DATE}T11:00:00.000Z`), actorId: OPS });

  const result = await report(w);
  assert.equal(result.grossCollections, 0, "an unverified manual collection is not a published collection");
  assert.equal(result.pendingFinanceVerification, 2500, "it is disclosed as pending, not dropped");
});
