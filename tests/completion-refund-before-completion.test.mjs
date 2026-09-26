/*
 * A refund recorded BEFORE completion no longer blocks completion finance for good.
 *
 * resolveServiceCompletionFinance (and the Pet Taxi fleet completion) threw 409 whenever any refund existed for the
 * booking, with no way to re-adjudicate it - so a groomer who finished a job after a Rs 200 goodwill refund could never
 * be paid, and the booking never reached the ledger or the returns. Completion now computes on the amount the customer
 * finally paid, with the same GST rules: Rs 1,000 less a Rs 200 refund at 70/30 -> provider 560, commission 240, GST
 * 43.20 (18% of 240), PawSpace keeps 196.80, and TCS 0.5% of 800 from a GST-registered provider. GSTR-8 does not take the
 * same refund off twice. A refund recorded AFTER completion is still refused on a re-run (the owner has not decided the
 * recovery rule), and a booking refunded in full has nothing to settle.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world, attempt } from "./helpers/execution-harness.mjs";

installWorkersHooks("__REFUND_BEFORE_DB__", "__REFUND_BEFORE_ENV__");
const terms = await import("../lib/provider-commercial-terms.ts");
const completion = await import("../lib/service-completion-finance.ts");
const statutoryTcs = await import("../lib/statutory-tcs.ts");
const payoutStatutory = await import("../lib/provider-payout-statutory.ts");
const taxiFinance = await import("../lib/taxi-completion-finance.ts");
const taxiFleet = await import("../lib/taxi-fleet-governance.ts");
const supplies = await import("../lib/service-output-tax.ts");
const payoutQueue = await import("../lib/provider-payout-queue.ts");

const PROD_ENV = { NODE_ENV: "production", PAWSPACE_LOCAL_PREVIEW: "off" };
const FINANCE = "finance@pawspace.in", PROVIDER_GSTIN = "29AACCP9876B1Z2";
const COMPLETED = Date.parse("2026-09-15T12:00:00+05:30");
const SEPTEMBER = [Date.UTC(2026, 7, 31, 18, 30), Date.UTC(2026, 8, 30, 18, 30)];
const r2 = (value) => Math.round(Number(value) * 100) / 100;

async function refundWorld() {
  const { sqlite, db } = world("__REFUND_BEFORE_DB__", "__REFUND_BEFORE_ENV__", PROD_ENV);
  sqlite.exec(`
    CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,city_id TEXT,zone_id TEXT,service_code TEXT,package_code TEXT,package_name TEXT,provider_id TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT,total_amount REAL,currency TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE tax_registrations (id TEXT,entity_id TEXT,registration_reference TEXT,status TEXT,effective_from TEXT,effective_to TEXT,approved_at INTEGER);
    CREATE TABLE booking_payments (id TEXT PRIMARY KEY,booking_id TEXT UNIQUE,customer_id TEXT,amount REAL,amount_due_now REAL,currency TEXT,method TEXT,mode TEXT,status TEXT,gateway TEXT,idempotency_key TEXT,detail_json TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE grooming_refund_ledger (id TEXT PRIMARY KEY,booking_id TEXT,amount REAL,status TEXT);
    CREATE TABLE taxi_refund_ledger (id TEXT PRIMARY KEY,booking_id TEXT,amount REAL,status TEXT);
  `);
  sqlite.prepare("INSERT INTO tax_registrations VALUES ('REG-1','pawspace_india','29AABCP1234A1Z5','active','2020-01-01',NULL,1)").run();
  const draft = await terms.saveCommercialTerm(db, { serviceCode: "grooming", engagementModel: "commission_groomer", providerSharePct: 0.70, effectiveFrom: "2026-01-01", reason: "grooming owner model terms", actorId: "maker@pawspace.in" });
  await terms.activateCommercialTerm(db, { termId: draft.id, approvalReference: "APR-GROOM", actorId: "checker@pawspace.in" });
  await statutoryTcs.saveProviderTaxProfile(db, { providerId: "PRV-G", gstin: PROVIDER_GSTIN }, FINANCE);
  return { sqlite, db };
}
function booking(sqlite, id, { service = "grooming", provider = "PRV-G", amount = 1000, refund = 0, table = "grooming_refund_ledger" } = {}) {
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,city_id,zone_id,service_code,package_code,package_name,provider_id,scheduled_start,scheduled_end,status,total_amount,currency,created_at,updated_at) VALUES (?,?,'blr','blr-east',?,'pkg','Package',?,'2026-09-15T05:00:00.000Z','2026-09-15T06:00:00.000Z','in_service',?,'INR',1,1)").run(id, `CUS-${id}`, service, provider, amount);
  sqlite.prepare("INSERT INTO booking_payments VALUES (?,?,?,?,?,'INR','upi','prepaid',?,'razorpay',?,'{}',1,1)").run(`PAY-${id}`, id, `CUS-${id}`, amount, amount, refund ? "partially_refunded" : "captured", `idem-${id}`);
  if (refund) sqlite.prepare(`INSERT INTO ${table} VALUES (?,?,?,'approved')`).run(`REF-${id}`, id, refund);
}
const ledger = (sqlite, bookingId) => Object.fromEntries(sqlite.prepare("SELECT account_code,SUM(credit) credit,SUM(debit) debit FROM finance_journal_entries WHERE source_type='service_completion' AND source_id=? GROUP BY account_code").all(bookingId).map((row) => [row.account_code, r2(row.credit || row.debit)]));
const complete = (db, bookingId) => completion.resolveServiceCompletionFinance(db, { bookingId, actorId: FINANCE, completedAt: COMPLETED });

test("a Rs 200 refund before completion: completion runs on the Rs 800 paid - 560 / 240 / GST 43.20 / TCS 4 - and files on it", async () => {
  const { sqlite, db } = await refundWorld();
  booking(sqlite, "BK-REF", { refund: 200 });
  const outcome = await attempt(() => complete(db, "BK-REF"));
  assert.equal(outcome.ok, true, `a refund recorded before completion must not block it: ${outcome.body ?? ""}`);
  const fact = outcome.value;
  assert.equal(fact.orderValue, 800, "the amount the customer finally paid");
  assert.equal(fact.providerGrossPayout, 560, "70% of 800");
  assert.equal(fact.platformFee, 240);
  assert.equal(fact.gstLiability, 43.2, "18% of the 240 commission");
  assert.equal(fact.platformRevenueNetOfGst, 196.8);
  assert.equal(fact.tcsWithheld, 4, "0.5% of the 800 paid");
  assert.equal(fact.providerPayoutAccrued, 556);
  assert.deepEqual(ledger(sqlite, "BK-REF"), { "2110-Provider Payable": 556, "2130-GST Payable": 43.2, "2140-TCS Payable": 4, "2230-Customer Collections": 800, "4000-Service Revenue": 196.8 });
  const row = { ...sqlite.prepare("SELECT order_value,refunded_before_completion,platform_gst,taxable_commission FROM provider_payout_computations WHERE booking_id='BK-REF'").get() };
  assert.deepEqual(row, { order_value: 800, refunded_before_completion: 200, platform_gst: 43.2, taxable_commission: 240 });
  const parity = { ...sqlite.prepare("SELECT customer_gross_collection,refunds_adjustments,status FROM booking_settlement_reconciliations WHERE booking_id='BK-REF'").get() };
  assert.deepEqual(parity, { customer_gross_collection: 1000, refunds_adjustments: 200, status: "reconciled" }, "1,000 collected = 196.80 + 47.20 + 556 + the 200 refunded");

  // GSTR-8 files TCS on the 800 - the refund is not taken off a second time.
  const tcs = await statutoryTcs.computeMonthlyTcsStatutory(db, { period: "2026-09", actorId: FINANCE });
  assert.equal(tcs.totalNetValue, 800);
  assert.equal(tcs.totalTcs, 4);
  // The Finance payout preview agrees with what completion posted.
  const preview = await payoutStatutory.computeOrderPayoutStatutory(db, { bookingId: "BK-REF", actorId: FINANCE });
  assert.deepEqual([preview.orderValue, preview.tcsWithheld, preview.providerSettlement], [800, 4, 556]);
  // And the returns file 43.20 on 240, like the ledger.
  const filed = await supplies.serviceVerticalOutputTax(db, ...SEPTEMBER);
  assert.deepEqual([filed.pawspaceOwnOutputTax, filed.pawspaceOwnTaxableValue, filed.ledgerCheck.agrees], [43.2, 240, true]);

  // The 7-day payout queue pays the 556 completion posted - it does not take the same refund off again.
  sqlite.exec("CREATE TABLE provider_work_orders (booking_id TEXT PRIMARY KEY,provider_id TEXT,provider_model TEXT)");
  sqlite.prepare("INSERT INTO provider_work_orders VALUES ('BK-REF','PRV-G','commission')").run();
  sqlite.prepare("UPDATE canonical_bookings SET status='completed' WHERE id='BK-REF'").run();
  const due = COMPLETED + 8 * 86_400_000;
  const queued = await payoutQueue.assessProviderPayout(db, { bookingId: "BK-REF", payable: 556, postedAt: COMPLETED, asOf: due });
  assert.deepEqual([queued.orderAmount, queued.refunded, queued.grossAmount], [800, 0, 556], "the refund before completion is already in the 556");
  // A refund AFTER completion still scales the payout down, against the same 800.
  sqlite.prepare("INSERT INTO grooming_refund_ledger VALUES ('REF-AFTER','BK-REF',80,'approved')").run();
  const later = await payoutQueue.assessProviderPayout(db, { bookingId: "BK-REF", payable: 556, postedAt: COMPLETED, asOf: due });
  assert.deepEqual([later.refunded, later.grossAmount], [80, 500.4], "556 x 720 / 800");
});

test("a refund recorded after completion is still refused on a re-run, and a booking refunded in full has nothing to settle", async () => {
  const { sqlite, db } = await refundWorld();
  booking(sqlite, "BK-LATER");
  const first = await complete(db, "BK-LATER");
  assert.equal(first.orderValue, 1000);
  sqlite.prepare("INSERT INTO grooming_refund_ledger VALUES ('REF-LATE','BK-LATER',100,'approved')").run();
  const rerun = await attempt(() => complete(db, "BK-LATER"));
  assert.equal(rerun.status, 409);
  assert.match(rerun.body, /recorded after its completion; completion accrual must be re-adjudicated/);
  assert.equal(sqlite.prepare("SELECT order_value FROM provider_payout_computations WHERE booking_id='BK-LATER'").get().order_value, 1000, "the completed record is not rewritten");

  booking(sqlite, "BK-FULL", { refund: 1000 });
  const full = await attempt(() => complete(db, "BK-FULL"));
  assert.equal(full.status, 409);
  assert.match(full.body, /was refunded in full \(1000\); there is no completion accrual to settle/);
});

test("Pet Taxi owner vehicle with a Rs 200 refund before completion is split on the Rs 800 paid", async () => {
  const { sqlite, db } = await refundWorld();
  await taxiFleet.ensureTaxiFleetTables(db);
  sqlite.prepare("INSERT INTO taxi_fleet_vehicles (id,vehicle_class,label,registration_suffix,ownership_model,pawspace_share_percent,owner_commission_percent,gst_rate,gst_base,inspection_status,active,features_json,created_at,updated_at,city_id,owner_provider_id,commercial_mode) VALUES ('TXF-1','citroen_ec3','eC3','T001','owner_vehicle',30,70,18,'pawspace_share','uat_verified',1,'[]',1,1,'blr','PRV-OWNER','fixed')").run();
  sqlite.prepare("INSERT INTO taxi_fleet_reservations (id,vehicle_id,provider_id,quote_id,booking_id,scheduled_start,scheduled_end,status,created_at,updated_at) VALUES ('TXR-1','TXF-1','DRV-1','Q-1','BK-TAXI','2026-09-15T05:00:00.000Z','2026-09-15T08:00:00.000Z','confirmed',1,1)").run();
  booking(sqlite, "BK-TAXI", { service: "pet_taxi", provider: "DRV-1", refund: 200, table: "taxi_refund_ledger" });
  const outcome = await attempt(() => taxiFinance.resolveTaxiCompletionFinance(db, { bookingId: "BK-TAXI", actorId: FINANCE, completedAt: COMPLETED }));
  assert.equal(outcome.ok, true, outcome.body ?? "");
  assert.deepEqual([outcome.value.orderValue, outcome.value.ownerCommissionAccrued, outcome.value.pawspaceGrossShare, outcome.value.gstLiability, outcome.value.platformRevenueNetOfGst], [800, 560, 240, 43.2, 196.8]);
  const replay = await taxiFinance.resolveTaxiCompletionFinance(db, { bookingId: "BK-TAXI", actorId: FINANCE, completedAt: COMPLETED });
  assert.equal(replay.gstLiability, 43.2, "a re-run with no new refund replays the posted completion");
});
