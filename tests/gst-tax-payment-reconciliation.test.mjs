/*
 * G9: paying the GST and TCS the books owe, and reconciling the payables with what is filed.
 *
 * Completion credits 2130-GST Payable (PawSpace's own GST) and 2140-TCS Payable (s.52 TCS withheld from a GST-registered
 * provider). Before this change nothing ever debited them: the TCS deposit was a row in tcs_deposits only, GST payment was
 * not recorded at all, and nothing compared either account with the returns. Now the "return filed / tax paid" step
 * debits the payable against 1010-Bank with the challan reference (finance.manage, a reason, an audit event), and a
 * read-only view shows each account's balance next to the returns and tcs_collections for the month.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world, attempt, ORIGIN } from "./helpers/execution-harness.mjs";

installWorkersHooks("__TAX_PAYMENT_DB__", "__TAX_PAYMENT_ENV__");
const terms = await import("../lib/provider-commercial-terms.ts");
const completion = await import("../lib/service-completion-finance.ts");
const statutoryTcs = await import("../lib/statutory-tcs.ts");
const gstAccounting = await import("../lib/gst-accounting.ts");
const returns = await import("../lib/gst-returns.ts");
const supplies = await import("../lib/service-output-tax.ts");
const payments = await import("../lib/gst-tax-payments.ts");
const gstRoute = await import("../app/api/gst-accounting/route.ts");

const ENTITY = "pawspace_india", REG = "REG-KA", PROVIDER_GSTIN = "29AACCP9876B1Z2";
const MAKER = "maker@pawspace.in", CHECKER = "checker@pawspace.in";
const FINANCE = "finance.payments@pawspace.test", MANAGER = "ops.manager@pawspace.test";
const PERIOD = "2026-09", COMPLETED = Date.parse("2026-09-15T12:00:00+05:30");
const r2 = (value) => Math.round(Number(value) * 100) / 100;

async function paymentWorld() {
  const { sqlite, db } = world("__TAX_PAYMENT_DB__", "__TAX_PAYMENT_ENV__");
  sqlite.exec(`
    CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,city_id TEXT,zone_id TEXT,service_code TEXT,package_code TEXT,package_name TEXT,provider_id TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT,total_amount REAL,currency TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE booking_payments (id TEXT PRIMARY KEY,booking_id TEXT UNIQUE,customer_id TEXT,amount REAL,amount_due_now REAL,currency TEXT,method TEXT,mode TEXT,status TEXT,gateway TEXT,idempotency_key TEXT,detail_json TEXT,created_at INTEGER,updated_at INTEGER);
  `);
  await gstAccounting.ensureGstAccountingTables(db);
  await returns.ensureGstReturnTables(db);
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db);
  sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('U-FIN',?,'Finance','finance','active',1,1)").run(FINANCE);
  sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('U-MGR',?,'Manager','manager','active',1,1)").run(MANAGER);
  sqlite.prepare("INSERT INTO finance_entities (id,legal_name,country_code,status,approved_by,approved_at,created_at,updated_at) VALUES (?,?,?,'active','founder',1,1,1)").run(ENTITY, "PawSpace Pvt Ltd", "IN");
  sqlite.prepare("INSERT INTO tax_registrations (id,entity_id,jurisdiction,registration_type,registration_reference,status,effective_from,effective_to,approved_by,approved_at,created_at,updated_at) VALUES (?,?,'Karnataka','gstin','29AABCP1234A1Z5','active','2020-01-01',NULL,'founder',1,1,1)").run(REG, ENTITY);
  // One Rs 1,000 grooming commission job by a GST-registered groomer: 2130 gets 54, 2140 gets 5.
  const draft = await terms.saveCommercialTerm(db, { serviceCode: "grooming", engagementModel: "commission_groomer", providerSharePct: 0.70, effectiveFrom: "2026-01-01", reason: "grooming owner model terms", actorId: MAKER });
  await terms.activateCommercialTerm(db, { termId: draft.id, approvalReference: "APR-GROOM", actorId: CHECKER });
  await statutoryTcs.saveProviderTaxProfile(db, { providerId: "PRV-G", gstin: PROVIDER_GSTIN }, FINANCE);
  sqlite.prepare("INSERT INTO canonical_bookings VALUES ('BK-G','CUS-G','blr','blr-east','grooming','pkg','Package','PRV-G','2026-09-15T05:00:00.000Z','2026-09-15T06:00:00.000Z','completed',1000,'INR',1,1)").run();
  sqlite.prepare("INSERT INTO booking_payments VALUES ('PAY-G','BK-G','CUS-G',1000,1000,'INR','upi','prepaid','captured','razorpay','idem-g','{}',1,1)").run();
  await completion.resolveServiceCompletionFinance(db, { bookingId: "BK-G", actorId: FINANCE, completedAt: COMPLETED });
  await statutoryTcs.computeMonthlyTcsStatutory(db, { period: PERIOD, actorId: FINANCE });
  await supplies.assignPeriodServiceOwnership(db, { periodCode: PERIOD, entityId: ENTITY, registrationId: REG, reason: "PawSpace India files Karnataka supplies" }, FINANCE);
  await returns.generateGstr3b(db, { entityId: ENTITY, registrationId: REG, periodCode: PERIOD }, MAKER);
  return { sqlite, db };
}
const balance = (sqlite, account) => r2(sqlite.prepare("SELECT COALESCE(SUM(credit-debit),0) b FROM finance_journal_entries WHERE account_code=?").get(account).b);
const post = async (actorEmail, body) => {
  const response = await gstRoute.POST(new Request(`${ORIGIN}/api/gst-accounting`, { method: "POST", headers: { "content-type": "application/json", "oai-authenticated-user-email": actorEmail }, body: JSON.stringify(body) }));
  return { status: response.status, body: await response.json().catch(() => null) };
};

test("the reconciliation view shows 2130 and 2140 against GSTR-3B and tcs_collections for the month", async () => {
  const { db } = await paymentWorld();
  const view = await payments.taxPayableReconciliation(db, { periodCode: PERIOD });
  assert.deepEqual([view.gst.account, view.gst.opening, view.gst.accrued, view.gst.paid, view.gst.closing], ["2130-GST Payable", 0, 54, 0, 54]);
  assert.equal(view.gst.filedServiceGst, 54, "the service GST the returns file for the month");
  assert.equal(view.gst.latestGstr3bServiceGst, 54, "the drafted GSTR-3B carries the same 54");
  assert.equal(view.gst.sameBookings.agrees, true);
  assert.equal(view.gst.difference, 0);
  assert.deepEqual([view.tcs.account, view.tcs.accrued, view.tcs.closing, view.tcs.tcsCollections], ["2140-TCS Payable", 5, 5, 5]);
  assert.deepEqual(view.tcs.sameBookings.mismatches, [], "the TCS withheld at completion equals the TCS GSTR-8 files for the booking");
  assert.equal(view.status, "reconciled");
});

test("recording the GST and TCS paid debits 2130 and 2140 against Bank with the challan, audited, and never for more than is owed", async () => {
  const { sqlite, db } = await paymentWorld();
  assert.equal(balance(sqlite, "2130-GST Payable"), 54);
  assert.equal(balance(sqlite, "2140-TCS Payable"), 5);

  const noReason = await attempt(() => payments.recordTaxPayment(db, { taxKind: "gst", periodCode: PERIOD, amount: 54, challanReference: "CPIN-26100001", paidOn: "2026-10-18", reason: "" }, FINANCE));
  assert.equal(noReason.status, 400, "a reason is required");
  const tooMuch = await attempt(() => payments.recordTaxPayment(db, { taxKind: "gst", periodCode: PERIOD, amount: 60, challanReference: "CPIN-26100001", paidOn: "2026-10-18", reason: "September GSTR-3B paid" }, FINANCE));
  assert.equal(tooMuch.status, 409);
  assert.match(tooMuch.body, /GST payable up to 2026-09 is 54; a payment of 60 is more than the books owe/);

  const gst = await payments.recordTaxPayment(db, { taxKind: "gst", periodCode: PERIOD, amount: 54, challanReference: "CPIN-26100001", paidOn: "2026-10-18", reason: "September GSTR-3B paid", returnReference: "ARN-AA2909260001" }, FINANCE);
  assert.deepEqual([gst.account, gst.outstandingBefore, gst.outstandingAfter], ["2130-GST Payable", 54, 0]);
  const lines = sqlite.prepare("SELECT account_code,debit,credit,period_code,source_type FROM finance_journal_entries WHERE id LIKE ? ORDER BY id").all(`${gst.journalGroup}-%`);
  assert.deepEqual(lines.map((l) => [l.account_code, l.debit, l.credit, l.period_code, l.source_type]), [["2130-GST Payable", 54, 0, "2026-10", "gst_payment"], ["1010-Bank", 0, 54, "2026-10", "gst_payment"]]);
  assert.equal(balance(sqlite, "2130-GST Payable"), 0);
  const audit = sqlite.prepare("SELECT action,actor_id,reason FROM gst_accounting_audit_events WHERE entity_type='tax_payment'").get();
  assert.deepEqual([audit.action, audit.actor_id, audit.reason], ["gst_paid", FINANCE, "September GSTR-3B paid"]);
  const again = await payments.recordTaxPayment(db, { taxKind: "gst", periodCode: PERIOD, amount: 54, challanReference: "CPIN-26100001", paidOn: "2026-10-18", reason: "September GSTR-3B paid" }, FINANCE);
  assert.equal(again.duplicatePrevented, true, "the same challan is recorded once");
  assert.equal(balance(sqlite, "2130-GST Payable"), 0);

  const wrongTcs = await attempt(() => payments.recordTaxPayment(db, { taxKind: "tcs", periodCode: PERIOD, amount: 4, challanReference: "CPIN-TCS-0001", paidOn: "2026-10-09", reason: "September GSTR-8 TCS paid" }, FINANCE));
  assert.equal(wrongTcs.status, 409, "a TCS deposit must equal the TCS computed for GSTR-8");
  const tcs = await payments.recordTaxPayment(db, { taxKind: "tcs", periodCode: PERIOD, amount: 5, challanReference: "CPIN-TCS-0001", paidOn: "2026-10-09", reason: "September GSTR-8 TCS paid" }, FINANCE);
  assert.equal(tcs.account, "2140-TCS Payable");
  assert.equal(balance(sqlite, "2140-TCS Payable"), 0);
  assert.equal(balance(sqlite, "1010-Bank"), 59, "59 left the bank (credited to it)");
  assert.deepEqual({ ...sqlite.prepare("SELECT amount,challan_reference FROM tcs_deposits WHERE period=?").get(PERIOD) }, { amount: 5, challan_reference: "CPIN-TCS-0001" }, "the GSTR-8 deposit is recorded too");

  const september = await payments.taxPayableReconciliation(db, { periodCode: PERIOD });
  assert.deepEqual([september.gst.paymentsRecordedForPeriod, september.gst.unpaidForPeriod, september.tcs.paymentsRecordedForPeriod], [54, 0, 5]);
  const october = await payments.taxPayableReconciliation(db, { periodCode: "2026-10" });
  assert.deepEqual([october.gst.opening, october.gst.paid, october.gst.closing, october.tcs.opening, october.tcs.paid, october.tcs.closing], [54, 54, 0, 5, 5, 0]);
});

test("the route records a tax payment only for finance.manage, and serves the reconciliation view", async () => {
  const { sqlite } = await paymentWorld();
  const body = { action: "record_tax_payment", taxKind: "gst", periodCode: PERIOD, amount: 54, challanReference: "CPIN-ROUTE-01", paidOn: "2026-10-18", reason: "September GSTR-3B paid" };
  const refused = await post(MANAGER, body);
  assert.equal(refused.status, 403, "an operations manager cannot record a tax payment");
  assert.equal(balance(sqlite, "2130-GST Payable"), 54);
  const paid = await post(FINANCE, body);
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  assert.equal(paid.body.data.outstandingAfter, 0);
  assert.equal(balance(sqlite, "2130-GST Payable"), 0);
  const view = await gstRoute.GET(new Request(`${ORIGIN}/api/gst-accounting?view=tax_reconciliation&period=${PERIOD}`, { headers: { "oai-authenticated-user-email": FINANCE } }));
  assert.equal(view.status, 200);
  const data = (await view.json()).data;
  assert.deepEqual([data.gst.accrued, data.gst.filedServiceGst, data.gst.paymentsRecordedForPeriod], [54, 54, 54]);
});
