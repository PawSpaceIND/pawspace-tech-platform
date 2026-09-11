/*
 * Day-31 cross-module test 10: does the founder BI layer ever show a number it does not have?
 *
 * canonical bookings + payments + provider payout ledgers -> per-vertical GMV, collections, direct
 * cost, margin and repeat rate.
 *
 * The failure mode being hunted is not a crash. It is a dashboard that looks healthy. If cost is
 * summed over the bookings whose payout happens to be on file and the ones without are quietly
 * skipped, margin comes out TOO HIGH and nothing anywhere says so - and that number is what a
 * pricing or a hiring decision gets made on. The honest answer to partial data is "not tracked",
 * and it has to survive the case where 9 of 10 bookings do have a payout.
 *
 * The opposite error matters too: a genuinely computed zero is a real answer, not a data gap, and
 * collapsing it to "not tracked" would hide a vertical that is actually running at zero cost.
 *
 * Modules executed: company-analytics, grooming-cost-attribution.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world } from "./helpers/execution-harness.mjs";

installWorkersHooks("__D31_BI_DB__", "__D31_BI_ENV__");

const FROM = "2026-09-01";
const TO = "2026-09-30";
const PRICE = 4000;
const PAYOUT = 2400;   // 60% to the host -> 40% margin when every booking is covered

async function seedBookings({ bookings = 10, payouts = 10 } = {}) {
  const { sqlite, db } = world("__D31_BI_DB__", "__D31_BI_ENV__");
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,service_code TEXT NOT NULL,package_code TEXT,zone_id TEXT,provider_id TEXT,status TEXT,total_amount REAL,currency TEXT,scheduled_start TEXT,scheduled_end TEXT)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT,amount REAL,amount_due_now REAL,currency TEXT,method TEXT,mode TEXT,status TEXT,gateway TEXT,idempotency_key TEXT UNIQUE,detail_json TEXT DEFAULT '{}',created_at INTEGER,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS boarding_host_settlement_ledger (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,payout_amount REAL)");

  for (let i = 1; i <= bookings; i++) {
    const id = `BK-BI-${String(i).padStart(3, "0")}`;
    // Two bookings belong to one customer, so repeat rate has something real to find.
    const customer = i <= 2 ? "CUS-BI-REPEAT" : `CUS-BI-${i}`;
    sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,service_code,zone_id,provider_id,status,total_amount,currency,scheduled_start,scheduled_end) VALUES (?,?,'boarding','blr-east','HOST-1','completed',?, 'INR',?,?)")
      .run(id, customer, PRICE, `2026-09-${String((i % 28) + 1).padStart(2, "0")}T04:00:00.000Z`, `2026-09-${String((i % 28) + 1).padStart(2, "0")}T06:00:00.000Z`);
    sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,currency,method,mode,status,gateway,idempotency_key,created_at,updated_at) VALUES (?,?,?,?,?,'INR','razorpay','full','captured','razorpay_sandbox',?,?,?)")
      .run(`PAY-${id}`, id, customer, PRICE, PRICE, `idem-${id}`, Date.now(), Date.now());
    if (i <= payouts) {
      sqlite.prepare("INSERT INTO boarding_host_settlement_ledger (id,booking_id,payout_amount) VALUES (?,?,?)")
        .run(`SET-${id}`, id, PAYOUT);
    }
  }
  const { buildCompanyAnalytics } = await import("../lib/company-analytics.ts");
  return { sqlite, db, buildCompanyAnalytics };
}

const boardingOf = (analytics) => analytics.services?.boarding;

test("with complete payout coverage the real cost and margin are reported", async () => {
  const { db, buildCompanyAnalytics } = await seedBookings({ bookings: 10, payouts: 10 });
  const analytics = await buildCompanyAnalytics(db, { from: FROM, to: TO });
  const boarding = boardingOf(analytics);
  assert.ok(boarding, `boarding must appear in the breakdown: ${Object.keys(analytics.services ?? {}).join(",")}`);

  assert.equal(boarding.gmv, PRICE * 10);
  assert.equal(boarding.costAmount, PAYOUT * 10, "every booking's real payout, summed");
  assert.equal(boarding.marginAmount, (PRICE - PAYOUT) * 10);
  assert.equal(boarding.marginPct, 40);
  assert.equal(boarding.costTracked, true);
  assert.equal(boarding.costCoverage, 1, "coverage must report the truth: every booking accounted for");
});

test("ONE booking without a payout collapses cost and margin to not-tracked", async () => {
  /*
   * The load-bearing case. Nine of ten bookings have a real payout on file. Summing those nine
   * would report a cost of 21,600 against a GMV of 40,000 - a 46% margin instead of the real 40% -
   * and every downstream pricing decision would inherit the error, with no indication anywhere
   * that a tenth of the data was missing.
   */
  const { db, buildCompanyAnalytics } = await seedBookings({ bookings: 10, payouts: 9 });
  const boarding = boardingOf(await buildCompanyAnalytics(db, { from: FROM, to: TO }));

  assert.equal(boarding.gmv, PRICE * 10, "GMV is fully known and must still be reported");
  assert.equal(boarding.costAmount, null,
    `partial payout coverage must report no cost at all, not the part it happens to have (got ${boarding.costAmount})`);
  assert.equal(boarding.marginAmount, null, "no cost means no margin");
  assert.equal(boarding.marginPct, null, "and certainly no margin percentage");
  /*
   * NOTE ON costTracked, which is easy to misread. It means "this vertical is one we can attribute
   * cost for at all", NOT "cost is known for this period" - so here it is true while costAmount is
   * null. The field that carries the truth about THIS period is costCoverage, and the safe test for
   * a renderer is costAmount != null. app/control/business-intelligence-panel.tsx reads costAmount,
   * which is correct; this case pins that pairing so a future consumer that reaches for the
   * friendlier-sounding flag instead has a test telling it what the flag actually means.
   */
  assert.equal(boarding.costTracked, true, "boarding remains a cost-trackable vertical");
  assert.equal(boarding.costCoverage, 0.9, "coverage carries the truth about this period");
  assert.ok(boarding.costTracked && boarding.costAmount == null,
    "costTracked true with a null costAmount is the documented shape - render on costAmount, not on the flag");
});

test("no payout data at all is also not-tracked, never a margin of 100%", async () => {
  const { db, buildCompanyAnalytics } = await seedBookings({ bookings: 10, payouts: 0 });
  const boarding = boardingOf(await buildCompanyAnalytics(db, { from: FROM, to: TO }));
  assert.equal(boarding.costAmount, null,
    "zero rows found is missing data, not a cost of zero - otherwise margin reads as 100%");
  assert.equal(boarding.marginPct, null);
});

test("a genuinely computed zero cost is reported as zero, not hidden as not-tracked", async () => {
  /*
   * The opposite error. A host who genuinely earned nothing on a booking has a real payout row of
   * 0. Treating that as absent would hide a vertical actually running at full margin.
   */
  const { sqlite, db, buildCompanyAnalytics } = await seedBookings({ bookings: 3, payouts: 0 });
  for (let i = 1; i <= 3; i++) {
    const id = `BK-BI-${String(i).padStart(3, "0")}`;
    sqlite.prepare("INSERT INTO boarding_host_settlement_ledger (id,booking_id,payout_amount) VALUES (?,?,0)").run(`SET0-${id}`, id);
  }
  const boarding = boardingOf(await buildCompanyAnalytics(db, { from: FROM, to: TO }));
  assert.equal(boarding.costAmount, 0, "a real zero is a real answer");
  assert.equal(boarding.marginPct, 100);
});

test("a NULL payout amount is missing data, not zero", async () => {
  const { sqlite, db, buildCompanyAnalytics } = await seedBookings({ bookings: 5, payouts: 4 });
  sqlite.prepare("INSERT INTO boarding_host_settlement_ledger (id,booking_id,payout_amount) VALUES (?,?,NULL)")
    .run("SET-NULL", "BK-BI-005");
  const boarding = boardingOf(await buildCompanyAnalytics(db, { from: FROM, to: TO }));
  assert.equal(boarding.costAmount, null,
    "a settlement row that exists but carries no amount is not a zero-cost booking");
});

test("repeat rate is derived from real bookings and does not depend on cost coverage", async () => {
  /*
   * Repeat rate is fully computable from canonical_bookings alone, so it must survive the same
   * partial payout data that correctly suppresses margin. One customer of nine has two bookings.
   */
  for (const payouts of [10, 0]) {
    const { db, buildCompanyAnalytics } = await seedBookings({ bookings: 10, payouts });
    const boarding = boardingOf(await buildCompanyAnalytics(db, { from: FROM, to: TO }));
    assert.equal(boarding.bookings, 10);
    assert.ok(boarding.repeatRate != null,
      `repeat rate needs no payout data and must always be reported (payouts=${payouts})`);
  }
});

test("a missing cost table degrades honestly instead of reporting a healthy margin", async () => {
  const { sqlite, db, buildCompanyAnalytics } = await seedBookings({ bookings: 4, payouts: 4 });
  sqlite.exec("DROP TABLE boarding_host_settlement_ledger");
  const analytics = await buildCompanyAnalytics(db, { from: FROM, to: TO });
  const boarding = boardingOf(analytics);
  assert.equal(boarding.gmv, PRICE * 4, "what is still knowable must still be reported");
  assert.equal(boarding.costAmount, null,
    "a cost source that is not there at all must never produce a margin");
  assert.equal(boarding.marginPct, null);
});
