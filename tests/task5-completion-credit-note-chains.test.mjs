/* Task5 current-main hermetic completion → invoice → refund → credit-note execution.
 * Fresh SQLite/D1 adapter; actual app modules; narrowly answered synthetic refund POST only.
 * Starts from seeded canonical assigned work. This is not hosted customer/UI acceptance.
 * No payout release, delivery worker, live gateway, contacts or credentials are used.
 * Finance fixture scaffolding adapted from escalation-refund-credit-notes.test.mjs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world, seedActors, asActor } from "./helpers/execution-harness.mjs";
import { installFinancialLifecycleSchema } from "./helpers/financial-lifecycle-schema.mjs";

installWorkersHooks("__TASK5_COMPLETION_DB__", "__TASK5_COMPLETION_ENV__");
process.env.FORBID_PRODUCTION = "true";

const terms = await import("../lib/provider-commercial-terms.ts");
const completion = await import("../lib/service-completion-finance.ts");
const gstAccounting = await import("../lib/gst-accounting.ts");
const returns = await import("../lib/gst-returns.ts");
const reconciliation = await import("../lib/grooming-payment-reconciliation.ts");
const refundSweep = await import("../lib/automatic-booking-refund.ts");
const payoutQueue = await import("../lib/provider-payout-queue.ts");
const commission = await import("../lib/provider-commission-governance.ts");
const refundRoute = await import("../app/api/escalation-refunds/route.ts");
const webhookRoute = await import("../app/api/razorpay-webhook/route.ts");
const escalation = await import("../lib/escalation-refunds.ts");
const bookingInvoices = await import("../lib/booking-tax-invoice.ts");

const WEBHOOK_SECRET = "escalation_refund_webhook_secret";
const ENV = {
  NODE_ENV: "production", PAWSPACE_LOCAL_PREVIEW: "off", FORBID_PRODUCTION: "true",
  PAWSPACE_PAYMENT_ENV: "sandbox", PAWSPACE_PAYMENT_LIVE_APPROVED: "false",
  RAZORPAY_KEY_ID_SANDBOX: "rzp_test_esc", RAZORPAY_KEY_SECRET_SANDBOX: "escalation_key_secret", RAZORPAY_WEBHOOK_SECRET_SANDBOX: WEBHOOK_SECRET,
};
const ENTITY = "SEEDFE-TKPET", REG = "SEEDTR-TKPET-KA", POLICY = "SEEDTP-TKPET-1", SELLER_GSTIN = "29AAICT7352F1Z0";
const SELLER = { legalName: "TK PETCARE SOLUTIONS PRIVATE LIMITED", gstin: SELLER_GSTIN, stateCode: "29", state: "Karnataka", address: "Jayanagar 9th Block, Bengaluru, Karnataka 560041" };
const OPS = "ops.lead@pawspace.test", FINANCE = "finance.approver@pawspace.test", FINANCE_2 = "second.finance@pawspace.test", FOUNDER = "founder.both@pawspace.test", CUSTOMER = "customer.only@pawspace.test";
const MAKER = "terms.maker@pawspace.test", CHECKER = "terms.checker@pawspace.test";
const PROVIDER_GSTIN = "29AACCP9876B1Z2", CUSTOMER_GSTIN = "29AABCB1234C1Z5";

const IST = 330 * 60_000, DAY = 86_400_000;
const istDate = (ms) => new Date(ms + IST).toISOString().slice(0, 10);
const previousMonth = (period) => { const [y, m] = period.split("-").map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`; };
/** The refund is processed now, so its credit note falls in this IST month; the bookings were completed before it. */
const REFUND_PERIOD = istDate(Date.now()).slice(0, 7);
const COMPLETION_PERIOD = previousMonth(REFUND_PERIOD);
const nextMonth = (period) => { const [y, m] = period.split("-").map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`; };
const NEXT_PERIOD = nextMonth(REFUND_PERIOD);
const COMPLETED = Date.parse(`${COMPLETION_PERIOD}-15T12:00:00+05:30`);
const SAME_MONTH_COMPLETED = Date.parse(`${REFUND_PERIOD}-01T12:00:00+05:30`);
const financialYear = (date) => { const y = Number(date.slice(0, 4)), start = Number(date.slice(5, 7)) >= 4 ? y : y - 1; return `${String(start).slice(2)}-${String(start + 1).slice(2)}`; };
const NOTE_PREFIX = `TKC/${financialYear(istDate(Date.now()))}/`;
/** The seller's invoice series (TKP/{FY}/ + 5 digits) rolls over by financial year; completions here fall in one of two months. */
const invoiceNumber = (completedAt, serial) => `TKP/${financialYear(istDate(completedAt))}/${String(serial).padStart(5, "0")}`;
const r2 = (value) => Math.round(Number(value) * 100) / 100;

/** Razorpay's refund endpoint, answered locally. Any other outbound call fails the test. */
function stubRazorpayRefunds(t) {
  const refunds = [], original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const match = /^https:\/\/api\.razorpay\.com\/v1\/payments\/([^/]+)\/refund$/.exec(String(url));
    if (!match || init.method !== "POST") throw new Error(`Unexpected network call in a local test: ${init.method || "GET"} ${url}`);
    const body = JSON.parse(String(init.body));
    const refund = { id: `rfnd_ESC${refunds.length + 1}`, entity: "refund", payment_id: decodeURIComponent(match[1]), amount: body.amount, currency: "INR", notes: body.notes, idempotencyKey: init.headers?.["X-Refund-Idempotency"] };
    refunds.push(refund);
    return new Response(JSON.stringify(refund), { status: 200, headers: { "content-type": "application/json" } });
  };
  t.after(() => { globalThis.fetch = original; });
  return refunds;
}

async function refundWorld(t, { invoiceSeries = true } = {}) {
  const { sqlite, db } = world("__TASK5_COMPLETION_DB__", "__TASK5_COMPLETION_ENV__", { ...ENV });
  installFinancialLifecycleSchema(sqlite);
  sqlite.exec(`
    CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,city_id TEXT,zone_id TEXT,service_code TEXT,package_code TEXT,package_name TEXT,provider_id TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT,total_amount REAL,currency TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE canonical_customers (id TEXT PRIMARY KEY NOT NULL,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT DEFAULT 'uat_customer_app' NOT NULL,consent_json TEXT DEFAULT '{}' NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE provider_capacity_profiles (id TEXT PRIMARY KEY,provider_model TEXT NOT NULL);
    CREATE TABLE booking_payments (id TEXT PRIMARY KEY,booking_id TEXT UNIQUE,customer_id TEXT,amount REAL,amount_due_now REAL,currency TEXT,method TEXT,mode TEXT,status TEXT,gateway TEXT,idempotency_key TEXT,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER,updated_at INTEGER);
    CREATE TABLE provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,provider_name TEXT,provider_model TEXT NOT NULL,service_code TEXT,status TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE unified_cases (id TEXT PRIMARY KEY,case_type TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open',title TEXT NOT NULL,booking_id TEXT,created_at INTEGER NOT NULL);
    CREATE TABLE provider_onboarding_applications (id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,status TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE provider_verifications (id TEXT PRIMARY KEY,application_id TEXT NOT NULL,verification_type TEXT NOT NULL,status TEXT NOT NULL,verified_at INTEGER,expires_at INTEGER,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE payroll_runs (id TEXT PRIMARY KEY,period_start INTEGER,period_end INTEGER,status TEXT);
    CREATE TABLE employee_payroll_results (id TEXT PRIMARY KEY,run_id TEXT,employee_id TEXT,gross_earnings REAL);
    CREATE TABLE boarding_host_settlement_ledger (booking_id TEXT,provider_id TEXT,payout_amount REAL,eligible_at INTEGER,payout_status TEXT,payout_reference TEXT,updated_at INTEGER);
    CREATE TABLE booking_invoices (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,invoice_number TEXT NOT NULL UNIQUE,status TEXT NOT NULL DEFAULT 'draft',currency TEXT NOT NULL DEFAULT 'INR',gross_amount REAL NOT NULL,tax_amount REAL NOT NULL DEFAULT 0,net_amount REAL NOT NULL,issued_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
  `);
  await gstAccounting.ensureGstAccountingTables(db);
  await returns.ensureGstReturnTables(db);
  // Owner-approved inclusive allocation applies only to this disposable local world.
  const {saveGstSetting}=await import("../lib/gst-setting.ts");
  await saveGstSetting(db,{cityId:"*",ratePercent:18,method:"extract_inclusive",effectiveFrom:"2024-01-01",reason:"Owner-approved inclusive completion-to-note fixture",actorId:FINANCE});
  // The seller of record (owner decision B): TK PETCARE, from the entity's active tax policy.
  sqlite.prepare("INSERT INTO finance_entities (id,legal_name,country_code,status,approved_by,approved_at,created_at,updated_at) VALUES (?,?,'IN','active','founder',1,1,1)").run(ENTITY, SELLER.legalName);
  sqlite.prepare("INSERT INTO tax_registrations (id,entity_id,jurisdiction,registration_type,registration_reference,status,effective_from,effective_to,approved_by,approved_at,created_at,updated_at) VALUES (?,?,'Karnataka','gstin',?,'active','2020-01-01',NULL,'founder',1,1,1)").run(REG, ENTITY, SELLER_GSTIN);
  sqlite.prepare("INSERT INTO tax_policy_versions (id,entity_id,version,status,effective_from,policy_json,approval_reference,approved_by,approved_at,created_at,updated_at) VALUES (?,?,1,'active','2024-01-01',?,'APR-SEED','founder',1,1,1)").run(POLICY, ENTITY, JSON.stringify({ seller: SELLER, defaultComponents: [{ code: "CGST", rate: 9 }, { code: "SGST", rate: 9 }] }));
  // The seller's invoice series: with it, every completion issues the customer tax invoice the credit note is written against.
  if (invoiceSeries) addInvoiceSeries(sqlite);
  for (const [service, model] of [["grooming", "commission_groomer"], ["pet_sitting", "commission_standard"], ["dog_training", "commission_standard"]]) {
    const draft = await terms.saveCommercialTerm(db, { serviceCode: service, engagementModel: model, providerSharePct: 0.70, effectiveFrom: "2026-01-01", reason: `${service} owner model terms`, actorId: MAKER });
    await terms.activateCommercialTerm(db, { termId: draft.id, approvalReference: `APR-${service}`, actorId: CHECKER });
  }
  await seedActors(sqlite, db, [
    { id: "USR-OPS", email: OPS, role: "admin" },
    { id: "USR-FIN", email: FINANCE, role: "finance" },
    { id: "USR-FIN-2", email: FINANCE_2, role: "finance" },
    { id: "USR-FOUNDER", email: FOUNDER, role: "founder" },
    { id: "USR-CUSTOMER", email: CUSTOMER, role: "customer" },
  ]);
  const refunds = stubRazorpayRefunds(t);
  const row = (sql, ...args) => { const value = sqlite.prepare(sql).get(...args); return value ? { ...value } : value; };
  const rows = (sql, ...args) => sqlite.prepare(sql).all(...args).map((value) => ({ ...value }));
  return { sqlite, db, refunds, row, rows, deliveredBodies: new Map(), invoiceSeries };
}

const addInvoiceSeries = (sqlite) => sqlite.prepare("INSERT INTO finance_document_series (id,entity_id,document_type,prefix,next_number,padding,policy_id,status,updated_at) VALUES ('SERIES-TKP',?,'invoice','TKP/{FY}/',1,5,?,'active',1)").run(ENTITY, POLICY);
/** A provider with RazorpayX TEST bindings and verified bank KYC, so the payout queue can release to them. */
async function verifiedProvider(f, providerId) {
  const { sqlite, db } = f, now = Date.now();
  await commission.ensureProviderCommissionTables(db);
  sqlite.prepare("INSERT OR REPLACE INTO provider_compensation_profiles (provider_id,engagement_model,default_commission_mode,default_commission_value,razorpayx_contact_id,razorpayx_fund_account_id,status,reason,updated_by,created_at,updated_at) VALUES (?,'commission','percent',70,?,?,'active','escalation refund fixture','finance',?,?)")
    .run(providerId, `cont_${providerId.replace(/[^A-Za-z0-9]/g, "")}`, `fa_${providerId.replace(/[^A-Za-z0-9]/g, "")}`, now, now);
  sqlite.prepare("INSERT OR REPLACE INTO provider_onboarding_applications (id,provider_id,status,created_at,updated_at) VALUES (?,?,'approved',?,?)").run(`APP-${providerId}`, providerId, now, now);
  sqlite.prepare("INSERT OR REPLACE INTO provider_verifications (id,application_id,verification_type,status,verified_at,expires_at,created_at,updated_at) VALUES (?,?,'bank_kyc','verified',?,NULL,?,?)").run(`VER-${providerId}`, `APP-${providerId}`, now, now, now);
}

async function callRefunds(method, email, body, query = "") {
  const request = asActor(email, `/api/escalation-refunds${query}`, method === "GET" ? {} : { method, body: JSON.stringify(body) });
  const response = await refundRoute[method](request);
  return { status: response.status, body: await response.json() };
}
/** Razorpay's refund.processed, signed with the sandbox webhook secret, through the real webhook route. A redelivery of the same
 * event carries the identical body, as Razorpay's own retries do. */
async function refundProcessedWebhook(f, bookingId, gatewayRefund) {
  const eventId = `evt_${gatewayRefund.id}`;
  const raw = f.deliveredBodies.get(eventId) ?? JSON.stringify({ entity: "event", event: "refund.processed", created_at: Math.floor(Date.now() / 1000), payload: {
    refund: { entity: { id: gatewayRefund.id, entity: "refund", payment_id: gatewayRefund.payment_id, amount: gatewayRefund.amount, currency: "INR", status: "processed", notes: gatewayRefund.notes } },
    payment: { entity: { id: gatewayRefund.payment_id, entity: "payment", amount: Number(f.row("SELECT amount FROM booking_payments WHERE booking_id=?", bookingId).amount) * 100, currency: "INR", status: "refunded", notes: { booking_id: bookingId, payment_id: `PAY-${bookingId}` } } },
  } });
  f.deliveredBodies.set(eventId, raw);
  const signature = createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex");
  const response = await webhookRoute.POST(new Request("https://app.pawspace.in/api/razorpay-webhook", { method: "POST", headers: { "content-type": "application/json", "x-razorpay-signature": signature, "x-razorpay-event-id": eventId }, body: raw }));
  return { status: response.status, body: await response.json() };
}
const note = (f, bookingId) => f.row("SELECT * FROM finance_credit_notes WHERE booking_id=?", bookingId);
const ledger = (f, account, bookingId) => r2(f.row("SELECT COALESCE(SUM(credit-debit),0) n FROM finance_journal_entries WHERE account_code=? AND source_id=?", account, bookingId).n);
function assertBooksBalance(f) {
  const totals = f.row("SELECT ROUND(SUM(debit),2) d,ROUND(SUM(credit),2) c FROM finance_journal_entries");
  assert.equal(Number(totals.d), Number(totals.c), "every journal balances");
}


async function activeCanonical(f, id, service, amount, pets = ["PET-A", "PET-B"]) {
  const now = Date.now(), start = new Date(now - 3600000).toISOString(), end = new Date(now + 3600000).toISOString();
  for (const definition of ["schedule_group_id TEXT", "pet_ids_json TEXT", "pricing_json TEXT"]) f.sqlite.exec(`ALTER TABLE canonical_bookings ADD COLUMN ${definition}`);
  f.sqlite.exec(`CREATE TABLE booking_service_locations (booking_id TEXT PRIMARY KEY,customer_id TEXT,provider_id TEXT,address_text TEXT,latitude REAL,longitude REAL,source TEXT,status TEXT,created_at INTEGER,updated_at INTEGER);
  CREATE TABLE scheduling_reservations (id TEXT PRIMARY KEY,group_id TEXT,provider_id TEXT,service_code TEXT,city_id TEXT,zone_id TEXT,customer_id TEXT,pet_ids_json TEXT,scheduled_start TEXT,scheduled_end TEXT,capacity_units INTEGER,occurrence_number INTEGER,care_mode TEXT,status TEXT,explanation_json TEXT,created_at INTEGER);
  CREATE TABLE canonical_pets (id TEXT PRIMARY KEY,customer_id TEXT,name TEXT,species TEXT,breed TEXT,vaccination_status TEXT);`);
  const provider = `PRV-${id}`, customer = `CUS-${id}`, group = `SG-${id}`;
  const { saveProviderTaxProfile } = await import("../lib/statutory-tcs.ts");
  await saveProviderTaxProfile(f.db, { providerId: provider, gstin: PROVIDER_GSTIN }, FINANCE);
  f.sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,email,created_at,updated_at) VALUES (?,'blr',?,'synthetic-no-contact',?,?,?)").run(customer, customer, `${id}@example.test`, now, now);
  f.sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,city_id,zone_id,service_code,provider_id,scheduled_start,scheduled_end,status,total_amount,currency,created_at,updated_at,schedule_group_id,pet_ids_json,pricing_json,package_code,package_name) VALUES (?,?,'blr','blr-east',?,?,?,?, 'in_progress',?,'INR',?,?,?,?,'{}',?,?)").run(id, customer, service, provider, start, end, amount, now, now, group, JSON.stringify(pets), service === "dog_training" ? "training-4-puppy" : "sitting-visit-60", "Task5 governed service");
  f.sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,currency,method,mode,status,gateway,idempotency_key,detail_json,created_at,updated_at) VALUES (?,?,?,?,?,'INR','upi','prepaid','created','razorpay',?,'{}',?,?)").run(`PAY-${id}`,id,customer,amount,amount,`idem-${id}`,now,now);
  f.sqlite.prepare("INSERT INTO provider_work_orders (id,booking_id,provider_id,provider_name,provider_model,service_code,status,created_at,updated_at) VALUES (?,?,?,?,'commission',?,'in_progress',?,?)").run(`WO-${id}`,id,provider,provider,service,now,now);
  f.sqlite.prepare("INSERT INTO booking_service_locations VALUES (?,?,?,'Synthetic doorstep',12.9784,77.6408,'customer_booking','active',?,?)").run(id,customer,provider,now,now);
  pets.forEach(p => f.sqlite.prepare("INSERT INTO canonical_pets VALUES (?,?,?,'dog','Mixed','verified')").run(p,customer,p));
  const cap = await reconciliation.processGatewayEvent(f.db,{provider:"razorpay",environment:"sandbox",eventId:`evt_cap_${id}`,eventType:"payment.captured",bookingId:id,gatewayPaymentId:`pay_${id}`,amountSubunits:Math.round(amount*100),currency:"INR",signatureVerified:true,payloadHash:`hash-cap-${id}`});
  assert.equal(cap.status,"processed",JSON.stringify(cap));
  return {provider,customer,group,start,end,now,pets};
}
async function assertRefundChain(f,id,percent) {
  const queued = await payoutQueue.runProviderPayoutQueueSweep(f.db, {force:true,asOf:Date.now()+30*DAY});
  assert.deepEqual(queued.errors,[]);
  const sibling=`SIB-${id}`;
  f.sqlite.prepare("INSERT INTO canonical_bookings SELECT ?,customer_id,city_id,zone_id,service_code,package_code,package_name,provider_id,scheduled_start,scheduled_end,status,total_amount,currency,created_at,updated_at,?,pet_ids_json,pricing_json FROM canonical_bookings WHERE id=?").run(sibling,`SG-${sibling}`,id);
  f.sqlite.prepare("INSERT INTO booking_payments SELECT ?,?,customer_id,amount,amount_due_now,currency,method,mode,status,gateway,?,detail_json,created_at,updated_at FROM booking_payments WHERE booking_id=?").run(`PAY-${sibling}`,sibling,`idem-${sibling}`,id);
  f.sqlite.prepare("INSERT INTO provider_work_orders SELECT ?,?,provider_id,provider_name,provider_model,service_code,status,created_at,updated_at FROM provider_work_orders WHERE booking_id=?").run(`WO-${sibling}`,sibling,id);
  f.sqlite.prepare("INSERT INTO scheduling_reservations SELECT ?,?,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,care_mode,status,explanation_json,created_at FROM scheduling_reservations WHERE group_id=(SELECT schedule_group_id FROM canonical_bookings WHERE id=?) ORDER BY occurrence_number LIMIT 1").run(`RES-${sibling}`,`SG-${sibling}`,id);
  const siblingSnapshot=()=>({booking:f.row("SELECT * FROM canonical_bookings WHERE id=?",sibling),payment:f.row("SELECT * FROM booking_payments WHERE booking_id=?",sibling),work:f.row("SELECT * FROM provider_work_orders WHERE booking_id=?",sibling),reservation:f.row("SELECT * FROM scheduling_reservations WHERE group_id=?",`SG-${sibling}`)});
  const siblingBefore=siblingSnapshot();
  const original = f.row("SELECT * FROM finance_invoices WHERE source_event_key=?", `booking-invoice:${id}`);
  assert.ok(original, "real issued original invoice required");
  const payout = f.row("SELECT * FROM provider_payout_computations WHERE booking_id=?", id);
  const { tcsRateS52For } = await import("../lib/tcs-rate.ts");
  const rate = tcsRateS52For(payout.computed_at);
  assert.equal(payout.tcs_base, payout.order_value, "recorded owner-policy base is the provider supply/customer total");
  assert.equal(payout.tcs_withheld, r2(payout.tcs_base * rate.total));
  assert.equal(payout.tcs_rate_version, rate.version);
  const askedBody = {action:"request",bookingId:id,percent,reason:"Task5 completed service quality escalation",idempotencyKey:`task5-ask-${id}`};
  const asked = await callRefunds("POST",OPS,askedBody);
  assert.equal(asked.status,201,JSON.stringify(asked.body));
  const rid=asked.body.data.request.id;
  const retry=await callRefunds("POST",OPS,askedBody);
  assert.equal(retry.body.data.request.id,rid);
  const maker=await callRefunds("POST",OPS,{action:"approve",requestId:rid});
  assert.equal(maker.status,403,"Operations cannot approve");
  const customer=await callRefunds("POST",CUSTOMER,{action:"approve",requestId:rid});
  assert.equal(customer.status,403,"customer cannot approve");
  const approved=await callRefunds("POST",FINANCE,{action:"approve",requestId:rid});
  assert.equal(approved.status,200,JSON.stringify(approved.body));
  assert.equal(f.refunds.length,1);
  assert.equal(note(f,id),undefined,"no note before processed webhook");
  const hook=await refundProcessedWebhook(f,id,f.refunds[0]);
  assert.equal(hook.status,200,JSON.stringify(hook.body));
  const cn=note(f,id), amount=Number(f.row("SELECT amount FROM booking_payments WHERE booking_id=?",id).amount), refunded=r2(amount*percent/100);
  assert.ok(cn, "real credit note must be issued");
  assert.equal(cn.original_invoice_id,original.id);
  assert.equal(cn.refund_amount,refunded);
  const originalFee=r2(amount*0.3), originalGst=r2(originalFee*18/118);
  assert.equal(original.subtotal,r2(originalFee-originalGst));
  assert.equal(original.tax_total,originalGst);
  assert.equal(r2(original.subtotal+original.tax_total+amount*0.7),amount,"original invoice reconciles to the approved total including provider collection");
  assert.equal(cn.taxable_value,r2(original.subtotal*percent/100));
  assert.equal(cn.tax_total,r2(original.tax_total*percent/100));
  assert.equal(r2(cn.cgst+cn.sgst+cn.igst),cn.tax_total,"credit-note tax components preserve paise reconciliation");
  assert.equal(r2(cn.taxable_value+cn.tax_total+refunded*0.7),refunded,"refund allocations reconcile to the customer refund");
  assert.deepEqual(f.row("SELECT * FROM finance_invoices WHERE id=?",original.id),original,"refund preserves the issued original invoice");
  const settledPosition=await escalation.escalationRefundPosition(f.db,{bookingId:id,percent:20});
  assert.equal(settledPosition.payment.refundedSoFar,refunded);
  assert.equal(settledPosition.payment.refundable,r2(amount-refunded));
  assert.equal(f.row("SELECT status FROM canonical_bookings WHERE id=?",id).status,"completed");
  const adjustment = f.row("SELECT * FROM finance_tcs_base_adjustments WHERE booking_id=?", id);
  assert.ok(adjustment, "registered-provider refund must reverse recorded TCS");
  assert.equal(adjustment.returned_value, r2(payout.tcs_base * percent / 100));
  assert.equal(adjustment.tcs_total, r2(adjustment.returned_value * rate.total));
  assert.equal(adjustment.rate_version, payout.tcs_rate_version);
  assert.equal(adjustment.rate_total, rate.total);
  assert.equal(adjustment.credit_note_id, cn.id);
  assert.equal(adjustment.cgst, r2(adjustment.returned_value * rate.cgst));
  assert.equal(adjustment.sgst, r2(adjustment.returned_value * rate.sgst));
  assert.equal(adjustment.igst, 0);
  assert.equal(ledger(f,"2140-TCS Payable",id), r2(payout.tcs_withheld-adjustment.tcs_total));
  const reversal = f.row("SELECT ROUND(SUM(debit),2) debit,ROUND(SUM(credit),2) credit FROM finance_journal_entries WHERE id IN (?,?)", `${adjustment.journal_group}-1`, `${adjustment.journal_group}-2`);
  assert.deepEqual(reversal, { debit: adjustment.tcs_total, credit: adjustment.tcs_total });
  assert.equal(ledger(f,"2110-Provider Payable",id),r2((r2(amount*0.7)-payout.tcs_withheld)*(1-percent/100)));
  assertBooksBalance(f);
  const counts=()=>f.row("SELECT (SELECT COUNT(*) FROM finance_credit_notes) notes,(SELECT COUNT(*) FROM finance_journal_entries) entries,(SELECT COUNT(*) FROM booking_refund_cases) refunds,(SELECT COUNT(*) FROM finance_tcs_base_adjustments) tcs");
  const before=counts();
  await refundProcessedWebhook(f,id,f.refunds[0]);
  await refundSweep.runAutomaticBookingRefundSweep(f.db,ENV,{});
  await escalation.settleEscalationRefunds(f.db,{refundCaseIds:[`${rid}-RF`]});
  assert.deepEqual(counts(),before,"replays cannot duplicate note, refund or journals");
  assert.equal(f.refunds.length,1);
  assert.deepEqual(f.row("SELECT * FROM finance_tcs_base_adjustments WHERE booking_id=?", id), adjustment, "replay preserves exact TCS reversal");
  assert.deepEqual(siblingSnapshot(),siblingBefore,"financial actions cannot change a sibling booking/payment/work/reservation");
  assertBooksBalance(f);
  console.log(JSON.stringify({service:f.row("SELECT service_code FROM canonical_bookings WHERE id=?",id).service_code,booking:id,refund:refunded,remaining:r2(amount-refunded),creditNote:cn.credit_note_number,invoice:original.invoice_number,gstReduction:cn.tax_total,providerPayable:ledger(f,"2110-Provider Payable",id),network:"hermetic refund stub only",replay:"idempotent"}));
}
test("T5-CN-SIT: real two-pet Sitting check-out, issued invoice, independent refund approval, signed processed webhook, balanced credit note and replay", async t=>{
  const f=await refundWorld(t), id="BK-T5-SITTING";
  const s=await activeCanonical(f,id,"pet_sitting",548);
  await verifiedProvider(f,s.provider);
  f.sqlite.prepare("INSERT INTO scheduling_reservations VALUES (?,?,?,?, 'blr','blr-east',?,?,?,?,1,1,'visit','in_progress','{}',?)").run(`RES-${id}`,s.group,s.provider,"pet_sitting",s.customer,JSON.stringify(s.pets),s.start,s.end,s.now);
  const life=await import("../lib/sitting-lifecycle.ts");
  const out=await life.mutateSittingBooking(f.db,{bookingId:id,action:"check_out",actorId:s.provider,providerId:s.provider,idempotencyKey:`checkout-${id}`});
  assert.equal(out.status,"completed");
  assert.equal(f.row("SELECT COUNT(*) n FROM provider_payout_computations WHERE booking_id=?",id).n,1);
  const issued=await bookingInvoices.issueBookingInvoice(f.db,{bookingId:id,actorId:FINANCE,reason:"Task5 invoice after Sitting completion",asOf:Date.now()});
  assert.ok(["issued","existing"].includes(issued.status),JSON.stringify(issued));
  await assertRefundChain(f,id,20);
});

async function executeTrainingProgramme(f,id) {
  const commercial=await import("../lib/training-commercial-governance.ts"), life=await import("../lib/training-session-lifecycle.ts"), programme=await import("../lib/training-programme.ts"), media=await import("../lib/service-media-security.ts");
  const quote=await commercial.createTrainingQuote(f.db,{packageCode:"training-4-puppy",petCount:2,scheduledStart:new Date(Date.now()+7*DAY).toISOString(),paymentMode:"prepaid"});
  const s=await activeCanonical(f,id,"dog_training",quote.totalAmount);
  await commercial.captureTrainingQuoteSandbox(f.db,{quoteId:quote.quoteId,amount:quote.amountDueNow,paymentKey:`quote-${id}`});
  await commercial.trainingQuoteLinkStatement(f.db,quote.quoteId,id).run();
  for(let n=1;n<=4;n++) f.sqlite.prepare("INSERT INTO scheduling_reservations VALUES (?,?,?,?, 'blr','blr-east',?,?,?,?,2,?,'training','assigned','{}',?)").run(`RES-${id}-${n}`,s.group,s.provider,"dog_training",s.customer,JSON.stringify(s.pets),new Date(s.now-(5-n)*DAY).toISOString(),new Date(s.now-(5-n)*DAY+7200000).toISOString(),n,s.now);
  const materialized=await programme.materializeTrainingProgramme(f.db,{bookingId:id,actorId:OPS});
  assert.equal(materialized.sessions.length,4);
  await life.ensureTrainingSessionLifecycleTables(f.db);
  await media.ensureServiceMediaTable(f.db);
  for(const session of materialized.sessions) {
    const act=(action,extra={})=>life.mutateTrainingSession(f.db,{sessionId:session.id,action,actorId:s.provider,idempotencyKey:`${session.id}-${action}`,...extra});
    for(const action of ["accept","on_the_way","arrive","start"]) await act(action,{latitude:12.9784,longitude:77.6408});
    const refs=[];
    for(const purpose of ["before_service","after_service"]) {
      const mid=`MED-${session.id}-${purpose}`;
      f.sqlite.prepare("INSERT INTO service_media_assets (id,booking_id,provider_id,purpose,storage_key,mime_type,size_bytes,sha256,scan_status,access_status,retention_status,synthetic,created_by,created_at,updated_at,review_status,release_basis) VALUES (?,?,?,?,'fixture','image/jpeg',2048,'fixture-hash','clean','ready','active',0,?,?,?,'approved','scanner_clean')").run(mid,id,s.provider,purpose,s.provider,s.now,s.now);
      f.sqlite.prepare("INSERT INTO training_session_media_links (media_id,session_id,programme_id,booking_id,provider_id,created_at) VALUES (?,?,?,?,?,?)").run(mid,session.id,materialized.programme.id,id,s.provider,s.now);
      refs.push(`media://asset/${mid}`);
    }
    await act("owner_handover",{ownerHandoverMinutes:20});
    const done=await act("complete",{report:{attendance:{mode:"parent",safeAreaConfirmed:true,parentOrCaretakerConfirmed:true},homework:"Practise approved recall exercises with each enrolled dog.",progress:{recall:7},evidenceRefs:refs}});
    assert.equal(done.status,"completed");
  }
  assert.equal(f.row("SELECT completed_sessions FROM training_programmes WHERE booking_id=?",id).completed_sessions,4);
  assert.equal(f.row("SELECT status FROM training_programmes WHERE booking_id=?",id).status,"completed");
  return {quote,s};
}
test("T5-CN-TRN: four delivered two-pet Training sessions close canonical booking and produce original invoice then partial credit note",async t=>{
  const f=await refundWorld(t),id="BK-T5-TRAINING";
  const {s}=await executeTrainingProgramme(f,id);
  await verifiedProvider(f,s.provider);
  assert.equal(f.row("SELECT status FROM provider_work_orders WHERE booking_id=?",id).status,"completed","programme completion closes assigned work");
  assert.equal(f.row("SELECT status FROM canonical_bookings WHERE id=?",id).status,"completed","all delivered programme sessions must close the canonical booking for post-completion refund");
  const fact=await completion.resolveServiceCompletionFinance(f.db,{bookingId:id,actorId:FINANCE,completedAt:Date.now()});
  assert.ok(fact.providerPayoutAccrued>0);
  const issued=await bookingInvoices.issueBookingInvoice(f.db,{bookingId:id,actorId:FINANCE,reason:"Task5 invoice after Training completion",asOf:Date.now()});
  assert.ok(["issued","existing"].includes(issued.status),JSON.stringify(issued));
  await assertRefundChain(f,id,25);
});
