/*
 * Review fixes on top of work package B (GST filing, owner decisions of 26 Sept 2026). Each test drives the REAL code.
 *
 *   G22, late supplies: a closed month never gains a line. A manual funeral order dated into a closed month, a completion
 *     finalized after its month was locked, or a food order delivered after the close is filed in the month it was
 *     recorded or delivered - before this fix it landed in the locked month, where it could not be assigned and every
 *     return for that month refused for ever (the deadlock G22 was meant to end).
 *   G22, months closed before the register existed: a line left unassigned there is disclosed, not a permanent refusal.
 *   G9: a refused TCS payment leaves nothing behind (it used to post the 2140 debit and the payment row, then fail), a
 *     payment already deposited on the TCS screen can never be recorded twice over, and no payment may be dated in the future.
 *   Double counts: a food subscription renewal's delivery order is not reported beside its subscription invoice, and a
 *     booking that also has a canonical tax invoice is flagged for review in every return.
 *   Governance: assigning supplies (one, or a whole month) writes an audit event with the reason.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world, attempt } from "./helpers/execution-harness.mjs";

installWorkersHooks("__GST_REVIEW_DB__", "__GST_REVIEW_ENV__");
const terms = await import("../lib/provider-commercial-terms.ts");
const completion = await import("../lib/service-completion-finance.ts");
const statutoryTcs = await import("../lib/statutory-tcs.ts");
const tcsGovernance = await import("../lib/tcs-governance.ts");
const gstAccounting = await import("../lib/gst-accounting.ts");
const returns = await import("../lib/gst-returns.ts");
const close = await import("../lib/finance-monthly-close.ts");
const supplies = await import("../lib/service-output-tax.ts");
const payments = await import("../lib/gst-tax-payments.ts");
const statutory = await import("../lib/statutory-compliance.ts");
const funeralOrders = await import("../lib/funeral-manual-order.ts");

const PROD_ENV = { NODE_ENV: "production", PAWSPACE_LOCAL_PREVIEW: "off" };
const ENTITY = "pawspace_india", REG = "REG-KA", MAKER = "maker@pawspace.in", CHECKER = "checker@pawspace.in", FINANCE = "finance@pawspace.in";
const IST = 330 * 60_000;
const istPeriod = (ms) => new Date(ms + IST).toISOString().slice(0, 7);
const scope = (periodCode) => ({ entityId: ENTITY, registrationId: REG, periodCode, reason: `${periodCode} filing` });
const window = (period) => { const [y, m] = period.split("-").map(Number); return [Date.UTC(y, m - 1, 1) - IST, Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1) - IST]; };
const register = async (db, period, keep) => supplies.serviceSupplyRegister(db, ...window(period), keep);

async function reviewWorld() {
  const { sqlite, db } = world("__GST_REVIEW_DB__", "__GST_REVIEW_ENV__", PROD_ENV);
  sqlite.exec(`
    CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,city_id TEXT,zone_id TEXT,service_code TEXT,package_code TEXT,package_name TEXT,provider_id TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT,total_amount REAL,currency TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE booking_payments (id TEXT PRIMARY KEY,booking_id TEXT UNIQUE,customer_id TEXT,amount REAL,amount_due_now REAL,currency TEXT,method TEXT,mode TEXT,status TEXT,gateway TEXT,idempotency_key TEXT,detail_json TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE payroll_runs (id TEXT PRIMARY KEY,period_start INTEGER,period_end INTEGER,status TEXT);
    CREATE TABLE employee_payroll_results (id TEXT PRIMARY KEY,run_id TEXT,employee_id TEXT,gross_earnings REAL);
  `);
  await gstAccounting.ensureGstAccountingTables(db);
  await returns.ensureGstReturnTables(db);
  sqlite.prepare("INSERT INTO finance_entities (id,legal_name,country_code,status,approved_by,approved_at,created_at,updated_at) VALUES (?,?,?,'active','founder',1,1,1)").run(ENTITY, "PawSpace Pvt Ltd", "IN");
  sqlite.prepare("INSERT INTO tax_registrations (id,entity_id,jurisdiction,registration_type,registration_reference,status,effective_from,effective_to,approved_by,approved_at,created_at,updated_at) VALUES (?,?,'Karnataka','gstin','29AABCP1234A1Z5','active','2020-01-01',NULL,'founder',1,1,1)").run(REG, ENTITY);
  const draft = await terms.saveCommercialTerm(db, { serviceCode: "grooming", engagementModel: "commission_groomer", providerSharePct: 0.70, effectiveFrom: "2026-01-01", reason: "grooming owner model terms", actorId: MAKER });
  await terms.activateCommercialTerm(db, { termId: draft.id, approvalReference: "APR-GROOM-REVIEW", actorId: CHECKER });
  return { sqlite, db };
}
async function completedGrooming(sqlite, db, id, completedAt) {
  const day = new Date(completedAt + IST).toISOString().slice(0, 10);
  sqlite.prepare("INSERT INTO canonical_bookings VALUES (?,?,'blr','blr-east','grooming','pkg','Package','PRV-G',?,?,'completed',1000,'INR',1,1)").run(id, `CUS-${id}`, `${day}T05:00:00.000Z`, `${day}T06:00:00.000Z`);
  sqlite.prepare("INSERT INTO booking_payments VALUES (?,?,?,1000,1000,'INR','upi','prepaid','captured','razorpay',?,'{}',1,1)").run(`PAY-${id}`, id, `CUS-${id}`, `idem-${id}`);
  return completion.resolveServiceCompletionFinance(db, { bookingId: id, actorId: FINANCE, completedAt });
}
async function closeAugust(db) {
  await statutory.recordBoardApproval(db, { period: "2026-08", approvedBy: "founder@pawspace.in", approverRole: "founder" });
  await close.closeMonth(db, { period: "2026-08", actorId: FINANCE, asOf: Date.parse("2026-09-05T10:00:00+05:30") });
}

test("G22: a manual funeral order dated into a closed month is filed in the month it was recorded, so August's returns still work", async () => {
  const { sqlite, db } = await reviewWorld();
  await closeAugust(db);
  const order = await funeralOrders.recordFuneralConvertedOrder(db, { customerName: "Asha", phone: "9000000000", paymentMethod: "upi", orderValue: 5000, orderDate: "2026-08-20", actorId: FINANCE });
  const recordedIn = istPeriod(sqlite.prepare("SELECT created_at FROM funeral_manual_orders WHERE id=?").get(order.id).created_at);
  assert.deepEqual(await register(db, "2026-08"), [], "the closed month does not gain the late order");
  const august = await attempt(() => returns.generateGstr3b(db, scope("2026-08"), MAKER));
  assert.equal(august.ok, true, `August's GSTR-3B used to refuse for ever: ${august.body}`);
  const [late] = await register(db, recordedIn);
  assert.deepEqual([late.supplyKey, late.period, late.exemptValue, late.periodClosed], [`funeral_order:${order.id}`, recordedIn, 5000, false]);
  await supplies.assignPeriodServiceOwnership(db, { periodCode: recordedIn, entityId: ENTITY, registrationId: REG, reason: "Late funeral order filed in the month it was recorded" }, FINANCE);
  const gstr1 = await returns.generateGstr1(db, scope(recordedIn), MAKER);
  assert.deepEqual(gstr1.payload.nil.inv, [{ sply_ty: "INTRAB2C", expt_amt: 5000, nil_amt: 0, ngsup_amt: 0 }], "filed as exempt in the open month");
});

test("G22: a completion finalized after its month was locked is filed in the month it was finalized", async () => {
  const { sqlite, db } = await reviewWorld();
  const fact = await completedGrooming(sqlite, db, "BK-LATE", Date.parse("2026-08-14T12:00:00+05:30"));
  assert.equal(fact.gstLiability, 54);
  // August was locked after the service was done but before its payout record was finalized (a completion adopted late).
  sqlite.prepare("INSERT INTO finance_close_periods (period_code,status,checklist_json,locked_at,locked_by,updated_at) VALUES ('2026-08','locked','[]',?,?,?)").run(Date.parse("2026-09-01T10:00:00+05:30"), FINANCE, 1);
  const finalizedIn = istPeriod(sqlite.prepare("SELECT finalized_at FROM provider_payout_computations WHERE booking_id='BK-LATE'").get().finalized_at);
  assert.deepEqual(await register(db, "2026-08"), [], "not in the locked month");
  const [line] = await register(db, finalizedIn);
  assert.deepEqual([line.bookingId, line.period, line.taxableValue, line.gst], ["BK-LATE", finalizedIn, 300, 54]);
});

test("G22: a food order placed before the close and delivered after it is filed on delivery; a renewal's delivery order is not counted twice", async () => {
  const { sqlite, db } = await reviewWorld();
  sqlite.exec(`
    CREATE TABLE food_orders (id TEXT PRIMARY KEY,customer_id TEXT,city_id TEXT,status TEXT,total_amount REAL,created_at INTEGER);
    CREATE TABLE food_delivery_handover_events (order_id TEXT PRIMARY KEY,method TEXT,status TEXT,otp_status TEXT,confirmed_by TEXT,confirmed_at INTEGER);
    CREATE TABLE food_subscription_renewals (id TEXT PRIMARY KEY,delivery_order_id TEXT);
    CREATE TABLE food_subscription_invoices (id TEXT PRIMARY KEY,renewal_id TEXT,gross_amount REAL,tax_amount REAL,status TEXT,issued_at INTEGER);
  `);
  const placed = Date.parse("2026-08-30T18:00:00+05:30"), delivered = Date.parse("2026-09-02T11:00:00+05:30");
  sqlite.prepare("INSERT INTO food_orders VALUES ('FO-1','C1','blr','delivered',799,?)").run(placed);
  sqlite.prepare("INSERT INTO food_delivery_handover_events VALUES ('FO-1','customer','uat_confirmed','not_connected','ops',?)").run(delivered);
  // A subscription renewal: invoiced once, and its delivery order is the same supply.
  sqlite.prepare("INSERT INTO food_subscription_invoices VALUES ('FSI-1','REN-1',1200,0,'issued',?)").run(Date.parse("2026-09-01T09:00:00+05:30"));
  sqlite.prepare("INSERT INTO food_subscription_renewals VALUES ('REN-1','FO-REN')").run();
  sqlite.prepare("INSERT INTO food_orders VALUES ('FO-REN','C2','blr','delivered',1200,?)").run(Date.parse("2026-09-01T09:05:00+05:30"));
  sqlite.prepare("INSERT INTO food_delivery_handover_events VALUES ('FO-REN','customer','uat_confirmed','not_connected','ops',?)").run(Date.parse("2026-09-03T09:00:00+05:30"));
  assert.deepEqual(await register(db, "2026-08"), [], "an order is not a supply until it is delivered");
  const september = await register(db, "2026-09");
  assert.deepEqual(september.map((l) => [l.supplyKey, l.orderValue]), [["food_invoice:FSI-1", 1200], ["food_order:FO-1", 799]], "the renewal is reported once, from its invoice");
});

test("G22: a line left unassigned in a month closed before the register listed it is disclosed, never a permanent refusal", async () => {
  const { sqlite, db } = await reviewWorld();
  sqlite.exec("CREATE TABLE food_orders (id TEXT PRIMARY KEY,customer_id TEXT,city_id TEXT,status TEXT,total_amount REAL,created_at INTEGER)");
  sqlite.prepare("INSERT INTO food_orders VALUES ('FO-OLD','C1','blr','delivered',799,?)").run(Date.parse("2026-08-10T12:00:00+05:30"));
  // August was closed before this order was part of any return (the register did not read food orders then).
  sqlite.prepare("INSERT INTO finance_close_periods (period_code,status,checklist_json,locked_at,locked_by,updated_at) VALUES ('2026-08','locked','[]',?,?,?)").run(Date.parse("2026-09-05T10:00:00+05:30"), FINANCE, 1);
  const gstr3b = await attempt(() => returns.generateGstr3b(db, scope("2026-08"), MAKER));
  assert.equal(gstr3b.ok, true, `returns for a closed month must not refuse for ever: ${gstr3b.body}`);
  const pkg = await gstAccounting.generateStatutoryPackage(db, scope("2026-08"), MAKER);
  assert.deepEqual([pkg.summary.unassignedInClosedMonths.count, pkg.summary.unassignedInClosedMonths.supplies], [1, ["food_order:FO-OLD"]]);
  assert.ok(pkg.variance.some((v) => v.type === "service_supplies_unassigned_in_closed_month"), "the package flags it for the CA");
  assert.deepEqual((await supplies.serviceSupplyOwnershipSnapshot(db)).map((row) => row.id), [], "not offered for an assignment that would be refused");
  const refused = await attempt(() => supplies.assignServiceSupplyOwnership(db, { supplyKey: "food_order:FO-OLD", entityId: ENTITY, registrationId: REG, reason: "Try to assign into a closed month" }, FINANCE));
  assert.equal(refused.status, 409);
});

test("G9: a refused TCS payment leaves nothing behind; a deposit already on file is brought into the ledger once; no future dates", async () => {
  const { sqlite, db } = await reviewWorld();
  await statutoryTcs.saveProviderTaxProfile(db, { providerId: "PRV-G", gstin: "29AACCP9876B1Z2" }, FINANCE);
  await completedGrooming(sqlite, db, "BK-TCS", Date.parse("2026-08-14T12:00:00+05:30"));
  await statutoryTcs.computeMonthlyTcsStatutory(db, { period: "2026-08", actorId: FINANCE });
  const tcsBalance = () => Math.round(sqlite.prepare("SELECT COALESCE(SUM(credit-debit),0) b FROM finance_journal_entries WHERE account_code='2140-TCS Payable'").get().b * 100) / 100;
  const paymentRows = () => sqlite.prepare("SELECT COUNT(*) n FROM statutory_tax_payments").get().n;
  assert.equal(tcsBalance(), 5);
  // Finance recorded the GSTR-8 deposit on the TCS screen first (no ledger entry).
  await tcsGovernance.recordTcsDeposit(db, { period: "2026-08", challanReference: "CIN-TCS-AUG", amount: 5, actorId: FINANCE });

  const part = await attempt(() => payments.recordTaxPayment(db, { taxKind: "tcs", periodCode: "2026-08", amount: 3, challanReference: "CIN-TCS-AUG-2", paidOn: "2026-09-09", reason: "Part of the August TCS deposit" }, FINANCE));
  assert.equal(part.ok, true, `before this fix this returned 409 AFTER posting the 2140 debit and the payment row: ${part.body}`);
  assert.deepEqual([tcsBalance(), paymentRows()], [2, 1]);
  assert.deepEqual([part.value.tcsDeposit.amount, part.value.tcsDeposit.challanReference, part.value.tcsDeposit.duplicatePrevented], [5, "CIN-TCS-AUG", true], "the deposit on file is kept, never rewritten");
  // Another August job completes after the deposit: the books now owe more than the deposit on file.
  await completedGrooming(sqlite, db, "BK-TCS-2", Date.parse("2026-08-20T12:00:00+05:30"));
  assert.equal(tcsBalance(), 7);
  const over = await attempt(() => payments.recordTaxPayment(db, { taxKind: "tcs", periodCode: "2026-08", amount: 3, challanReference: "CIN-TCS-AUG-3", paidOn: "2026-09-09", reason: "More TCS than was deposited" }, FINANCE));
  assert.equal(over.status, 409);
  assert.match(over.body, /deposit on file for 2026-08 is 5 \(challan CIN-TCS-AUG\) and 3 of it is already recorded against the bank; a payment of 3 is more than the 2 left/);
  assert.deepEqual([tcsBalance(), paymentRows()], [7, 1], "a refused payment posts nothing");
  await payments.recordTaxPayment(db, { taxKind: "tcs", periodCode: "2026-08", amount: 2, challanReference: "CIN-TCS-AUG-4", paidOn: "2026-09-09", reason: "Rest of the August TCS deposit" }, FINANCE);
  assert.deepEqual([tcsBalance(), paymentRows()], [5, 2]);

  const future = new Date(Date.now() + IST + 3 * 86_400_000).toISOString().slice(0, 10);
  const early = await attempt(() => payments.recordTaxPayment(db, { taxKind: "gst", periodCode: "2026-08", amount: 54, challanReference: "CPIN-FUTURE-1", paidOn: future, reason: "August GSTR-3B paid in advance" }, FINANCE));
  assert.equal(early.status, 400, "a payment cannot be recorded before the day it was made");
  assert.match(early.body, /not in the future/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM finance_journal_entries WHERE source_type='gst_payment'").get().n, 0);
});

test("a booking also on a canonical tax invoice is flagged as a possible double count in the package and the returns", async () => {
  const { sqlite, db } = await reviewWorld();
  await completedGrooming(sqlite, db, "BK-TWICE", Date.parse("2026-08-14T12:00:00+05:30"));
  sqlite.prepare("INSERT INTO finance_invoices (id,invoice_number,entity_id,customer_id,source_type,source_id,source_event_key,policy_id,registration_id,issue_date,currency,subtotal,tax_total,total,status,tax_snapshot_json,created_by,created_at) VALUES ('FINV-1','PS-1',?,'CUS-BK-TWICE','booking','BK-TWICE','evt-1','POL-1',?,'2026-08-14','INR',847.46,152.54,1000,'issued','{}',?,1)").run(ENTITY, REG, FINANCE);
  await supplies.assignPeriodServiceOwnership(db, { periodCode: "2026-08", entityId: ENTITY, registrationId: REG, reason: "PawSpace India files Karnataka supplies" }, FINANCE);
  const pkg = await gstAccounting.generateStatutoryPackage(db, scope("2026-08"), MAKER);
  assert.deepEqual(pkg.summary.alsoOnCanonicalInvoice, { count: 1, gst: 54, bookings: [{ bookingId: "BK-TWICE", invoiceId: "FINV-1", gst: 54 }] });
  assert.ok(pkg.variance.some((v) => v.type === "service_supply_also_on_canonical_invoice"));
  const gstr3b = await returns.generateGstr3b(db, scope("2026-08"), MAKER);
  assert.equal(gstr3b.summary.alsoOnCanonicalInvoice.count, 1);
});

test("assigning supplies, one at a time or a whole month, is audited with the reason", async () => {
  const { sqlite, db } = await reviewWorld();
  await completedGrooming(sqlite, db, "BK-A", Date.parse("2026-08-14T12:00:00+05:30"));
  await completedGrooming(sqlite, db, "BK-B", Date.parse("2026-08-15T12:00:00+05:30"));
  await supplies.assignServiceSupplyOwnership(db, { supplyKey: "booking:BK-A", entityId: ENTITY, registrationId: REG, reason: "Karnataka stay filed by PawSpace India" }, FINANCE);
  await supplies.assignServiceSupplyOwnership(db, { supplyKey: "booking:BK-A", entityId: ENTITY, registrationId: REG, reason: "Karnataka stay filed by PawSpace India" }, FINANCE);
  const month = await supplies.assignPeriodServiceOwnership(db, { periodCode: "2026-08", entityId: ENTITY, registrationId: REG, reason: "Every August supply is PawSpace India's" }, FINANCE);
  assert.deepEqual(month.supplies, ["booking:BK-B"]);
  const events = sqlite.prepare("SELECT entity_id,action,actor_id,reason FROM gst_accounting_audit_events WHERE entity_type='service_supply_ownership' ORDER BY created_at,rowid").all().map((e) => [e.entity_id, e.action, e.actor_id, e.reason]);
  assert.deepEqual(events, [["booking:BK-A", "assigned", FINANCE, "Karnataka stay filed by PawSpace India"], ["period:2026-08", "period_assigned", FINANCE, "Every August supply is PawSpace India's"]], "one event per real assignment; a repeat is not a new decision");
});
