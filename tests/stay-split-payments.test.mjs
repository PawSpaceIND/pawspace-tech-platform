import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";

// Same test-only .ts resolve fallback as tests/customer-offers.test.mjs (registerHooks needs
// Node >=22.15; CI runs 22.13, so fall back to module.register()).
if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      try { return nextResolve(specifier, context); }
      catch (error) {
        if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context);
        throw error;
      }
    },
  });
} else {
  const hook = `export async function resolve(specifier, context, nextResolve) {
    try { return await nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(specifier + ".ts", context);
      throw error;
    }
  }`;
  nodeModule.register(new URL(`data:text/javascript,${encodeURIComponent(hook)}`));
}

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// D1 shim over a real SQLite engine, including meta.changes (payStayBalance's atomic
// transition and the overdue sweep both rely on it).
function makeD1(sqlite) {
  function statement(sql, args) {
    return {
      bind: (...boundArgs) => statement(sql, boundArgs),
      first: async () => {
        const row = sqlite.prepare(sql).get(...args);
        return row === undefined ? null : row;
      },
      run: async () => {
        const info = sqlite.prepare(sql).run(...args);
        return { success: true, meta: { changes: Number(info.changes) } };
      },
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    };
  }
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (statements) => {
      const results = [];
      for (const stmt of statements) results.push(await stmt.run());
      return results;
    },
  };
}

const lib = () => import("../lib/stay-split-payments.ts");

// --- Pure pricing rule -------------------------------------------------------------------------

test("splitPaymentPlan: 50% now, 50% balance, due exactly 24h before check-in", async () => {
  const { splitPaymentPlan, BALANCE_LEAD_MS } = await lib();
  const now = Date.now();
  const start = new Date(now + 5 * 86400000).toISOString();
  const plan = splitPaymentPlan({ totalAmount: 4194, scheduledStart: start, now });
  assert.equal(plan.dueNow, 2097);
  assert.equal(plan.balance, 2097);
  assert.equal(plan.balanceDueAt, new Date(start).getTime() - BALANCE_LEAD_MS);
});

test("splitPaymentPlan: odd totals never lose or invent a paisa", async () => {
  const { splitPaymentPlan } = await lib();
  const start = new Date(Date.now() + 3 * 86400000).toISOString();
  const plan = splitPaymentPlan({ totalAmount: 999.99, scheduledStart: start });
  assert.equal(Math.round((plan.dueNow + plan.balance) * 100) / 100, 999.99);
});

test("splitPaymentPlan: stays starting within 24h must pay in full (409)", async () => {
  const { splitPaymentPlan } = await lib();
  const now = Date.now();
  const soon = new Date(now + 23 * 3600000).toISOString();
  await assert.rejects(async () => splitPaymentPlan({ totalAmount: 1000, scheduledStart: soon, now }), (error) => error instanceof Response && error.status === 409);
});

test("splitPaymentPlan: rejects non-positive totals and invalid dates", async () => {
  const { splitPaymentPlan } = await lib();
  await assert.rejects(async () => splitPaymentPlan({ totalAmount: 0, scheduledStart: new Date(Date.now() + 3 * 86400000).toISOString() }), (error) => error instanceof Response && error.status === 400);
  await assert.rejects(async () => splitPaymentPlan({ totalAmount: 100, scheduledStart: "not-a-date" }), (error) => error instanceof Response && error.status === 400);
});

// --- Schedule lifecycle (real execution) --------------------------------------------------------

async function seededDb() {
  const { ensureStayPaymentTables, staySplitScheduleStatement } = await lib();
  const db = makeD1(new DatabaseSync(":memory:"));
  await ensureStayPaymentTables(db);
  const dueAt = Date.now() + 2 * 86400000;
  await staySplitScheduleStatement(db, { bookingId: "BK-1", serviceCode: "boarding", customerId: "cus-1", totalAmount: 4194, paidNowAmount: 2097, balanceAmount: 2097, balanceDueAt: dueAt }).run();
  return { db, dueAt };
}

test("schedule roundtrip: created pending_balance with the exact amounts", async () => {
  const { getStayPaymentSchedule } = await lib();
  const { db, dueAt } = await seededDb();
  const schedule = await getStayPaymentSchedule(db, "BK-1");
  assert.equal(schedule.status, "pending_balance");
  assert.equal(schedule.paidNowAmount, 2097);
  assert.equal(schedule.balanceAmount, 2097);
  assert.equal(schedule.balanceDueAt, dueAt);
  assert.equal(schedule.customerId, "cus-1");
});

test("payStayBalance: settles once, then every retry is duplicatePrevented with the same payment ref", async () => {
  const { payStayBalance, getStayPaymentSchedule } = await lib();
  const { db } = await seededDb();
  const first = await payStayBalance(db, { bookingId: "BK-1", actorId: "customer:cus-1", idempotencyKey: "key-1" });
  assert.equal(first.duplicatePrevented, false);
  assert.equal(first.schedule.status, "paid");
  assert.ok(first.schedule.paymentRef.startsWith("SBX-BAL-"));
  const retry = await payStayBalance(db, { bookingId: "BK-1", actorId: "customer:cus-1", idempotencyKey: "key-1" });
  assert.equal(retry.duplicatePrevented, true);
  assert.equal(retry.schedule.paymentRef, first.schedule.paymentRef);
  const settled = await getStayPaymentSchedule(db, "BK-1");
  assert.equal(settled.status, "paid");
});

test("payStayBalance: unknown booking is a 404, never a silent create", async () => {
  const { payStayBalance } = await lib();
  const { db } = await seededDb();
  await assert.rejects(() => payStayBalance(db, { bookingId: "BK-MISSING", actorId: "x", idempotencyKey: "k" }), (error) => error instanceof Response && error.status === 404);
});

test("sweepOverdueStayBalances: past-due pending goes overdue; paid and future are untouched; idempotent", async () => {
  const { ensureStayPaymentTables, staySplitScheduleStatement, payStayBalance, sweepOverdueStayBalances } = await lib();
  const db = makeD1(new DatabaseSync(":memory:"));
  await ensureStayPaymentTables(db);
  const now = Date.now();
  await staySplitScheduleStatement(db, { bookingId: "BK-PAST", serviceCode: "boarding", customerId: "c1", totalAmount: 100, paidNowAmount: 50, balanceAmount: 50, balanceDueAt: now - 1000 }).run();
  await staySplitScheduleStatement(db, { bookingId: "BK-FUTURE", serviceCode: "pet_sitting", customerId: "c2", totalAmount: 100, paidNowAmount: 50, balanceAmount: 50, balanceDueAt: now + 86400000 }).run();
  await staySplitScheduleStatement(db, { bookingId: "BK-PAIDPAST", serviceCode: "boarding", customerId: "c3", totalAmount: 100, paidNowAmount: 50, balanceAmount: 50, balanceDueAt: now - 1000 }).run();
  await payStayBalance(db, { bookingId: "BK-PAIDPAST", actorId: "x", idempotencyKey: "k3" });
  const sweep = await sweepOverdueStayBalances(db, now);
  assert.equal(sweep.marked, 1);
  assert.deepEqual(sweep.overdue.map((s) => s.bookingId), ["BK-PAST"]);
  const again = await sweepOverdueStayBalances(db, now);
  assert.equal(again.marked, 0, "second sweep must not re-mark");
  // An overdue balance can still be settled (zero cancellation fee policy - it only blocks check-in).
  const late = await payStayBalance(db, { bookingId: "BK-PAST", actorId: "x", idempotencyKey: "k-late" });
  assert.equal(late.schedule.status, "paid");
});

// --- Quote-side integration (real execution of the governance modules) --------------------------

test("createBoardingQuote with split_50_50 halves amountDueNow using the server total", async () => {
  const { ensureBoardingGovernanceTables, createBoardingQuote } = await import("../lib/boarding-governance.ts");
  const db = makeD1(new DatabaseSync(":memory:"));
  await ensureBoardingGovernanceTables(db);
  const start = new Date(Date.now() + 5 * 86400000), end = new Date(start.getTime() + 3 * 86400000);
  const quote = await createBoardingQuote(db, { packageCode: "boarding-24h", petCount: 2, scheduledStart: start.toISOString(), scheduledEnd: end.toISOString(), paymentMode: "split_50_50" });
  assert.equal(quote.totalAmount, 699 * 2 * 3);
  assert.equal(quote.amountDueNow, Math.round((quote.totalAmount / 2) * 100) / 100);
  const prepaid = await createBoardingQuote(db, { packageCode: "boarding-24h", petCount: 2, scheduledStart: start.toISOString(), scheduledEnd: end.toISOString(), paymentMode: "prepaid" });
  assert.equal(prepaid.amountDueNow, prepaid.totalAmount);
});

test("createSittingQuote with split_50_50 halves amountDueNow; sandbox capture validates the due-now amount", async () => {
  const { ensureSittingGovernanceTables, createSittingQuote } = await import("../lib/sitting-governance.ts");
  const { captureSittingQuoteSandbox } = await import("../lib/sitting-payment-governance.ts");
  const db = makeD1(new DatabaseSync(":memory:"));
  await ensureSittingGovernanceTables(db);
  const start = new Date(Date.now() + 6 * 86400000), end = new Date(start.getTime() + 5 * 86400000);
  const quote = await createSittingQuote(db, { packageCode: "sitting-overnight", petCount: 1, scheduledStart: start.toISOString(), scheduledEnd: end.toISOString(), paymentMode: "split_50_50" });
  assert.equal(quote.amountDueNow, Math.round((quote.totalAmount / 2) * 100) / 100);
  // Capture must accept the 50% deposit, and reject the wrong amount.
  const capture = await captureSittingQuoteSandbox(db, { quoteId: quote.quoteId, amount: quote.amountDueNow, paymentKey: "stay-split-payment-test" });
  assert.equal(capture.status, "captured");
  await assert.rejects(() => captureSittingQuoteSandbox(db, { quoteId: quote.quoteId, amount: quote.totalAmount + 1, paymentKey: "stay-split-payment-test" }), (error) => error instanceof Response && error.status === 409);
});

test("live pricing preserves the governed 50/50 deposit for Boarding and Sitting", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  const { ensurePricingControlRuntime } = await import("../lib/pricing-control-runtime.ts");
  const { createLiveBoardingQuote, createLiveSittingQuote } = await import("../lib/live-commercial-quotes.ts");
  await ensurePricingControlRuntime(db);
  sqlite.prepare("UPDATE service_packages SET active=1,base_price=800 WHERE package_code='boarding-24h'").run();
  sqlite.prepare("UPDATE service_packages SET active=1,base_price=900 WHERE package_code='sitting-overnight'").run();
  sqlite.prepare("UPDATE service_packages SET active=1,base_price=300 WHERE package_code='sitting-overnight__extra_pet'").run();
  const boardingStart = new Date(Date.now() + 7 * 86400000), boardingEnd = new Date(boardingStart.getTime() + 2 * 86400000);
  const boarding = await createLiveBoardingQuote(db, { packageCode: "boarding-24h", petCount: 2, scheduledStart: boardingStart.toISOString(), scheduledEnd: boardingEnd.toISOString(), paymentMode: "split_50_50" });
  assert.equal(boarding.totalAmount, 800 * 2 * 2);
  assert.equal(boarding.amountDueNow, boarding.totalAmount / 2);
  assert.equal(sqlite.prepare("SELECT amount_due_now FROM boarding_commercial_quotes WHERE id=?").get(boarding.quoteId).amount_due_now, boarding.totalAmount / 2);
  const sittingStart = new Date(Date.now() + 8 * 86400000), sittingEnd = new Date(sittingStart.getTime() + 2 * 86400000);
  const sitting = await createLiveSittingQuote(db, { packageCode: "sitting-overnight", petCount: 2, scheduledStart: sittingStart.toISOString(), scheduledEnd: sittingEnd.toISOString(), paymentMode: "split_50_50" });
  assert.equal(sitting.totalAmount, (900 + 300) * 2);
  assert.equal(sitting.amountDueNow, sitting.totalAmount / 2);
  assert.equal(sqlite.prepare("SELECT amount_due_now FROM sitting_commercial_quotes WHERE id=?").get(sitting.quoteId).amount_due_now, sitting.totalAmount / 2);
});

test("concurrent quote-table upgrades recheck schema after a duplicate-column race", async () => {
  const boardingSqlite = new DatabaseSync(":memory:"), boardingDb = makeD1(boardingSqlite);
  const boarding = await import("../lib/boarding-governance.ts");
  await boarding.ensureBoardingGovernanceTables(boardingDb);
  boardingSqlite.exec("ALTER TABLE boarding_commercial_quotes DROP COLUMN city_id; ALTER TABLE boarding_commercial_quotes DROP COLUMN zone_id;");
  await Promise.all([boarding.ensureBoardingGovernanceTables(boardingDb), boarding.ensureBoardingGovernanceTables(boardingDb)]);
  assert.deepEqual(boardingSqlite.prepare("PRAGMA table_info(boarding_commercial_quotes)").all().filter(row => ["city_id", "zone_id"].includes(row.name)).map(row => row.name).sort(), ["city_id", "zone_id"]);

  const sittingSqlite = new DatabaseSync(":memory:"), sittingDb = makeD1(sittingSqlite);
  const sitting = await import("../lib/sitting-governance.ts");
  await sitting.ensureSittingGovernanceTables(sittingDb);
  sittingSqlite.exec("ALTER TABLE sitting_commercial_quotes DROP COLUMN city_id; ALTER TABLE sitting_commercial_quotes DROP COLUMN zone_id;");
  await Promise.all([sitting.ensureSittingGovernanceTables(sittingDb), sitting.ensureSittingGovernanceTables(sittingDb)]);
  assert.deepEqual(sittingSqlite.prepare("PRAGMA table_info(sitting_commercial_quotes)").all().filter(row => ["city_id", "zone_id"].includes(row.name)).map(row => row.name).sort(), ["city_id", "zone_id"]);
});

// --- Contracts ---------------------------------------------------------------------------------

test("gateway maps /api/stay-balance to scheduling.book (customer role reaches it; ownership enforced in-route)", () => {
  const gateway = read("lib/api-gateway.ts");
  assert.match(gateway, /if\(url\.pathname==="\/api\/stay-balance"\)return "scheduling\.book";/);
  const route = read("app/api/stay-balance/route.ts");
  assert.match(route, /cloudflare:workers/);
  assert.doesNotMatch(route, /globalThis/);
  assert.match(route, /requireCustomerOwnership/);
  assert.match(route, /payStayBalance/);
  assert.match(route, /sweep_overdue/);
  assert.match(route, /requirePermission\(actor,"bookings\.manage"\)/);
});

test("booking creation persists the split schedule atomically for boarding and sitting", () => {
  const canonical = read("app/api/canonical-bookings/route.ts");
  assert.match(canonical, /boardingCommercial\.paymentMode==="split_50_50"/);
  assert.match(canonical, /serviceCode:"boarding"/);
  assert.match(canonical, /sittingCommercial&&sittingCommercial\.paymentMode==="split_50_50"/);
  assert.match(canonical, /totalAmount:sittingCommercial\.totalAmount,paidNowAmount:sittingCommercial\.amountDueNow/);
  const sitting = read("app/api/sitting-bookings/route.ts");
  assert.match(sitting, /governed\.paymentMode==="split_50_50"/);
  assert.match(sitting, /staySplitScheduleStatement/);
});

test("stay-flow offers the governed 50/50 option for overnight stays longer than 4 nights, both modes", () => {
  const flow = read("app/mobile-app/stay-flow.tsx");
  assert.match(flow, /const splitEligible = careWindow === "24 hours" && nights > 4;/);
  assert.match(flow, /paymentMode:splitEligible&&splitPayment\?"split_50_50":"prepaid"/);
  assert.match(flow, /createSittingQuote\(\{packageCode,petCount:selectedPets\.length,cityId:serviceLocation\.assignment\.cityId,zoneId:serviceLocation\.assignment\.zoneId,scheduledStart:scheduledStart\.toISOString\(\),scheduledEnd:scheduledEnd\.toISOString\(\),paymentMode\}\)/);
  assert.doesNotMatch(flow, /"split"[^_]/, "legacy ungoverned 'split' mode must be gone from the flow");
});
