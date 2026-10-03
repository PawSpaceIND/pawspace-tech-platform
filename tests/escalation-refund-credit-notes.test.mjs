/*
 * Refunds after completion (owner decision D, 27 Sept 2026): "any escalation - we will set the percentage on the refund and
 * process the same to the customer account."
 *
 * Everything here EXECUTES the real modules and routes on an in-memory SQLite database: the booking is captured through the
 * real reconciliation path and completed through the real completion finance (owner model: 70/30, 18% on what PawSpace
 * makes); Operations asks through POST /api/escalation-refunds, Finance approves through the same route, the approval runs
 * the EXISTING refund sweep (Razorpay's refund API is answered by a local stub - any other outbound call fails the test), and
 * the gateway's refund.processed arrives as a signed webhook through the real /api/razorpay-webhook route. Then the real
 * payout queue, GSTR-1, GSTR-3B, GSTR-8, monthly close and tax payable reconciliation are read. Completion also issues the
 * customer tax invoice of the seller in the tax policy (TKP/yy-yy/00001, lib/booking-tax-invoice.ts): the credit note is
 * issued against it and reuses what it printed; the booking's own service invoice is the fallback when there is none.
 *
 *   20% of Rs 1,000 at 70/30   refund 200; credit note taxable 50.85, GST 9.15 (CGST 4.58 + SGST 4.57); payout 700 -> 560 before
 *                              release (140), or a 140 recovery from the next payout after release.
 *   own supply, 20%            credit note taxable 169.49, GST 30.51.
 *   funeral                    no GST on the note (Schedule III by default): GSTR-3B 3.1(e) and GSTR-1 Table 8 reduced.
 *   GSTR-3B of the refund month: output tax reduced by exactly the credit notes; GSTR-1 carries them (B2CS reduced for an
 *                              unregistered customer, CDNR for a registered one, CDNUR for a B2C Large invoice).
 *   GSTR-8                     the TCS base is reduced in the refund month for a GSTIN provider; nothing for one without.
 *
 * And the controls: the requester cannot approve; two approvals (or an approval and a rejection) racing resolve to one outcome
 * with no second audit row; a retried request is the same request; the refund never exceeds captured less refunded (capped
 * when asked, re-checked when approved); it is refused on an unpaid, cash-paid or not-completed booking; who may call what
 * (routes and the API gateway); a closed month; the Section 34(2) time limit; and a note that waits for its invoice.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world, seedActors, asActor, attempt } from "./helpers/execution-harness.mjs";
import { installFinancialLifecycleSchema } from "./helpers/financial-lifecycle-schema.mjs";

installWorkersHooks("__ESCALATION_REFUND_DB__", "__ESCALATION_REFUND_ENV__");
process.env.FORBID_PRODUCTION = "true";

const terms = await import("../lib/provider-commercial-terms.ts");
const completion = await import("../lib/service-completion-finance.ts");
const statutoryTcs = await import("../lib/statutory-tcs.ts");
const gstAccounting = await import("../lib/gst-accounting.ts");
const returns = await import("../lib/gst-returns.ts");
const close = await import("../lib/finance-monthly-close.ts");
const supplies = await import("../lib/service-output-tax.ts");
const taxPayments = await import("../lib/gst-tax-payments.ts");
const reconciliation = await import("../lib/grooming-payment-reconciliation.ts");
const refundSweep = await import("../lib/automatic-booking-refund.ts");
const payoutQueue = await import("../lib/provider-payout-queue.ts");
const commission = await import("../lib/provider-commission-governance.ts");
const refundRoute = await import("../app/api/escalation-refunds/route.ts");
const creditNoteRoute = await import("../app/api/credit-notes/route.ts");
const webhookRoute = await import("../app/api/razorpay-webhook/route.ts");
const escalation = await import("../lib/escalation-refunds.ts");
const creditNotes = await import("../lib/credit-notes.ts");
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
  const { sqlite, db } = world("__ESCALATION_REFUND_DB__", "__ESCALATION_REFUND_ENV__", { ...ENV });
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
  // Approved inclusive economics apply only to this disposable fixture.
  const { saveGstSetting } = await import("../lib/gst-setting.ts");
  await saveGstSetting(db, { cityId: "*", ratePercent: 18, method: "extract_inclusive", effectiveFrom: "2024-01-01", reason: "Owner-approved inclusive finance fixture", actorId: "finance.fixture@pawspace.test" });
  await returns.ensureGstReturnTables(db);
  // The seller of record (owner decision B): TK PETCARE, from the entity's active tax policy.
  sqlite.prepare("INSERT INTO finance_entities (id,legal_name,country_code,status,approved_by,approved_at,created_at,updated_at) VALUES (?,?,'IN','active','founder',1,1,1)").run(ENTITY, SELLER.legalName);
  sqlite.prepare("INSERT INTO tax_registrations (id,entity_id,jurisdiction,registration_type,registration_reference,status,effective_from,effective_to,approved_by,approved_at,created_at,updated_at) VALUES (?,?,'Karnataka','gstin',?,'active','2020-01-01',NULL,'founder',1,1,1)").run(REG, ENTITY, SELLER_GSTIN);
  sqlite.prepare("INSERT INTO tax_policy_versions (id,entity_id,version,status,effective_from,policy_json,approval_reference,approved_by,approved_at,created_at,updated_at) VALUES (?,?,1,'active','2024-01-01',?,'APR-SEED','founder',1,1,1)").run(POLICY, ENTITY, JSON.stringify({ seller: SELLER, defaultComponents: [{ code: "CGST", rate: 9 }, { code: "SGST", rate: 9 }] }));
  // The seller's invoice series: with it, every completion issues the customer tax invoice the credit note is written against.
  if (invoiceSeries) addInvoiceSeries(sqlite);
  for (const [service, model] of [["grooming", "commission_groomer"], ["boarding", "commission_standard"], ["funeral_memorial", "commission_standard"]]) {
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
/**
 * A booking the customer paid online (the signed capture recorded by the real reconciliation path), completed through the
 * real completion finance, which issues the seller's customer tax invoice. These completions are back-dated (a refund after
 * completion comes weeks later), so the invoice completion would have issued on the day is issued as of that day (Rule 47's
 * 30-day window is counted from completion). `verticalInvoice` adds the booking's own service invoice instead, for a world
 * whose seller has no invoice series yet.
 */
async function completedBooking(f, id, { service = "grooming", provider = "PRV-G", providerModel = "commission", amount = 1000, completedAt = COMPLETED, city = "blr", customer = `CUS-${id}`, pay = "online", verticalInvoice = false } = {}) {
  const { sqlite, db } = f, created = completedAt - 2 * DAY;
  sqlite.prepare("INSERT OR IGNORE INTO canonical_customers (id,city_id,name,primary_phone,email,consent_json,created_at,updated_at) VALUES (?,?,?,?,?,'{\"serviceUpdates\":true}',?,?)").run(customer, city, `Customer ${id}`, "+919900000001", `${id.toLowerCase()}@example.test`, created, created);
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,city_id,zone_id,service_code,package_code,package_name,provider_id,scheduled_start,scheduled_end,status,total_amount,currency,created_at,updated_at) VALUES (?,?,?,?,?,'pkg','Full groom',?,?,?,'in_service',?,'INR',?,?)")
    .run(id, customer, city, `${city}-east`, service, provider, new Date(completedAt - 2 * 3_600_000).toISOString(), new Date(completedAt).toISOString(), amount, created, created);
  sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,currency,method,mode,status,gateway,idempotency_key,detail_json,created_at,updated_at) VALUES (?,?,?,?,?,'INR',?,'prepaid','created','razorpay',?,'{}',?,?)")
    .run(`PAY-${id}`, id, customer, amount, amount, pay === "cash" ? "cash" : "upi", `idem-${id}`, created, created);
  sqlite.prepare("INSERT INTO provider_work_orders (id,booking_id,provider_id,provider_name,provider_model,service_code,status,created_at,updated_at) VALUES (?,?,?,?,?,?,'in_progress',?,?)").run(`WO-${id}`, id, provider, `Provider ${provider}`, providerModel, service, created, created);
  if (pay === "online") {
    const captured = await reconciliation.processGatewayEvent(db, { provider: "razorpay", environment: "sandbox", eventId: `evt_cap_${id}`, eventType: "payment.captured", bookingId: id, gatewayPaymentId: `pay_${id}`, amountSubunits: Math.round(amount * 100), currency: "INR", signatureVerified: true, payloadHash: `hash-cap-${id}` });
    assert.equal(captured.status, "processed", `capture fixture for ${id}: ${JSON.stringify(captured)}`);
  } else if (pay === "cash") {
    sqlite.prepare("UPDATE booking_payments SET status='captured' WHERE id=?").run(`PAY-${id}`);
  }
  const fact = pay === "none" ? null : await completion.resolveServiceCompletionFinance(db, { bookingId: id, actorId: FINANCE, completedAt });
  if (fact && f.invoiceSeries) {
    const issued = await bookingInvoices.issueBookingInvoice(db, { bookingId: id, actorId: FINANCE, reason: "Customer tax invoice issued at completion", asOf: completedAt });
    assert.ok(["issued", "existing"].includes(issued.status), `the customer tax invoice for ${id}: ${JSON.stringify(issued)}`);
  }
  sqlite.prepare("UPDATE canonical_bookings SET status='completed',updated_at=? WHERE id=?").run(completedAt, id);
  sqlite.prepare("UPDATE provider_work_orders SET status='completed',updated_at=? WHERE booking_id=?").run(completedAt, id);
  sqlite.prepare("INSERT INTO booking_lifecycle_events (id,booking_id,event_type,entity_type,entity_id,actor_id,detail_json,occurred_at) VALUES (?,?,'booking_completed','booking',?,'provider','{}',?)").run(`EV-DONE-${id}`, id, id, completedAt);
  if (fact && verticalInvoice) sqlite.prepare("INSERT INTO booking_invoices (id,booking_id,customer_id,invoice_number,status,currency,gross_amount,tax_amount,net_amount,issued_at,created_at,updated_at) VALUES (?,?,?,?,'issued','INR',?,?,?,?,?,?)")
    .run(`BINV-${id}`, id, customer, `INV/${id}`, amount, fact.gstLiability, r2(amount - fact.gstLiability), completedAt, completedAt, completedAt);
  return fact;
}

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
/** Ask (Operations), approve (Finance), and let the gateway process the refund. */
async function refundAfterCompletion(f, bookingId, percent, { reason = "Customer escalation: groom was incomplete", note = null } = {}) {
  const asked = await callRefunds("POST", OPS, { action: "request", bookingId, percent, reason, customerNote: note, idempotencyKey: `ask-${bookingId}-${percent}` });
  assert.equal(asked.status, 201, JSON.stringify(asked.body));
  const approved = await callRefunds("POST", FINANCE, { action: "approve", requestId: asked.body.data.request.id });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const gatewayRefund = f.refunds.find((refund) => refund.notes?.booking_id === bookingId && !refund.webhookSent);
  assert.ok(gatewayRefund, `a sandbox refund was sent for ${bookingId}: ${JSON.stringify(approved.body.data.execution)}`);
  gatewayRefund.webhookSent = true;
  const hook = await refundProcessedWebhook(f, bookingId, gatewayRefund);
  assert.equal(hook.status, 200, JSON.stringify(hook.body));
  return { request: asked.body.data.request, approved: approved.body.data, gatewayRefund, hook: hook.body };
}
const note = (f, bookingId) => f.row("SELECT * FROM finance_credit_notes WHERE booking_id=?", bookingId);
const ledger = (f, account, bookingId) => r2(f.row("SELECT COALESCE(SUM(credit-debit),0) n FROM finance_journal_entries WHERE account_code=? AND source_id=?", account, bookingId).n);
function assertBooksBalance(f) {
  const totals = f.row("SELECT ROUND(SUM(debit),2) d,ROUND(SUM(credit),2) c FROM finance_journal_entries");
  assert.equal(Number(totals.d), Number(totals.c), "every journal balances");
}
const scope = (periodCode) => ({ entityId: ENTITY, registrationId: REG, periodCode, reason: `${periodCode} filing` });

test("20% of a Rs 1,000 commission booking at 70/30: Rs 200 back, credit note 50.85 + 9.15, provider payout 700 -> 560 before release", async (t) => {
  const f = await refundWorld(t);
  await verifiedProvider(f, "PRV-G");
  const fact = await completedBooking(f, "BK-ESC-1", { provider: "PRV-G" });
  assert.deepEqual([fact.providerPayoutAccrued, fact.platformFee, fact.gstLiability], [700, 300, 45.76], "completion: 700 to the provider, PawSpace's 300 carries 45.76 GST");
  const queued = await payoutQueue.runProviderPayoutQueueSweep(f.db, { force: true });
  assert.deepEqual(queued.errors, []);
  assert.equal(f.row("SELECT amount,status FROM provider_payout_queue_items WHERE booking_id='BK-ESC-1'").amount, 700);

  // Operations sees the amount before asking: 20% of what the customer paid.
  const preview = await callRefunds("GET", OPS, null, "?bookingId=BK-ESC-1&percent=20");
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const position = preview.body.data.position;
  assert.deepEqual([position.payment.amountPaid, position.payment.refundable, position.preview.amount], [1000, 1000, 200]);
  assert.deepEqual([position.preview.creditNote.taxableValue, position.preview.creditNote.tax], [50.85, 9.15], "the credit note it will produce");
  assert.deepEqual([position.preview.providerImpact.stage, position.preview.providerImpact.providerShare], ["before_release", 140]);
  assert.match(position.preview.providerImpact.label, /Rs 140\.00 comes off the provider's queued payout before it is released/);

  const asked = await callRefunds("POST", OPS, { action: "request", bookingId: "BK-ESC-1", percent: 20, reason: "Groomer skipped the nail trim", customerNote: "Sorry about the missed nail trim", idempotencyKey: "ask-BK-ESC-1" });
  assert.equal(asked.status, 201, JSON.stringify(asked.body));
  const request = asked.body.data.request;
  assert.deepEqual([request.status, request.amount, request.percent, request.requested_by], ["requested", 200, 20, OPS]);
  // While Finance has not decided, the provider payout is held.
  const held = await payoutQueue.releaseProviderPayouts(f.db, { bookingIds: ["BK-ESC-1"], actor: FINANCE });
  assert.equal(held.released.length, 0);
  assert.match(held.refused[0].error, /Refund after completion of Rs 200\.00 is waiting for Finance approval/);
  // Finance sees everything the approval needs.
  const queue = await callRefunds("GET", FINANCE, null);
  assert.equal(queue.status, 200, JSON.stringify(queue.body));
  const waiting = queue.body.data.pending.find((row) => row.id === request.id);
  assert.deepEqual([waiting.position.payment.amountPaid, waiting.position.payment.refundedSoFar, waiting.percent, waiting.amount, waiting.reason], [1000, 0, 20, 200, "Groomer skipped the nail trim"]);
  assert.match(waiting.position.preview.providerImpact.label, /Rs 140\.00/);

  const approved = await callRefunds("POST", FINANCE, { action: "approve", requestId: request.id });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.data.refundCaseId, `${request.id}-RF`);
  assert.equal(approved.body.data.execution.initiated, 1, JSON.stringify(approved.body.data.execution));
  assert.equal(f.refunds.length, 1, "the existing refund path sent ONE sandbox refund");
  assert.deepEqual([f.refunds[0].payment_id, f.refunds[0].amount, f.refunds[0].idempotencyKey], ["pay_BK-ESC-1", 20000, `refund-${request.id}-RF`], "to the original payment, Rs 200 in paise, idempotent on the refund case");
  const refundCase = f.row("SELECT * FROM booking_refund_cases WHERE id=?", `${request.id}-RF`);
  assert.deepEqual([refundCase.status, refundCase.purpose, refundCase.amount, refundCase.approved_by, refundCase.gateway_reference], ["processing", "post_completion_escalation", 200, FINANCE, "rfnd_ESC1"]);
  assert.equal(f.row("SELECT status FROM canonical_bookings WHERE id='BK-ESC-1'").status, "completed", "the booking stays completed");
  assert.equal(note(f, "BK-ESC-1"), undefined, "no credit note before the gateway has processed the refund");

  // The gateway processes it: the signed refund.processed webhook settles everything once.
  const f1 = f.refunds[0];
  const hook = await refundProcessedWebhook(f, "BK-ESC-1", f1);
  assert.equal(hook.status, 200, JSON.stringify(hook.body));
  assert.equal(hook.body.escalationRefund.settled, 1, JSON.stringify(hook.body.escalationRefund));
  assert.equal(f.row("SELECT status FROM booking_refund_cases WHERE id=?", `${request.id}-RF`).status, "processed");
  assert.equal(f.row("SELECT status FROM escalation_refund_requests WHERE id=?", request.id).status, "processed");

  // The Rs 60 inclusive fee reduction splits into taxable value 50.85 and GST 9.15.
  const cn = note(f, "BK-ESC-1");
  assert.equal(cn.credit_note_number, `${NOTE_PREFIX}00001`, "its own financial-year series: TKC/yy-yy/ + 5 digits");
  assert.ok(cn.credit_note_number.length <= 16);
  assert.deepEqual([cn.treatment, cn.refund_amount, cn.value_reduced, cn.taxable_value, cn.tax_total, cn.cgst, cn.sgst, cn.igst, cn.gst_rate], ["commission", 200, 60, 50.85, 9.15, 4.58, 4.57, 0, 18]);
  assert.deepEqual([cn.original_invoice_number, cn.original_invoice_kind, cn.original_invoice_date, cn.period_code, cn.issue_date], [invoiceNumber(COMPLETED, 1), "finance_invoice", istDate(COMPLETED), REFUND_PERIOD, istDate(Date.now())], "the IST month the refund was processed, against the seller's customer tax invoice");
  assert.equal(f.row("SELECT source_event_key FROM finance_invoices WHERE id=?", cn.original_invoice_id).source_event_key, "booking-invoice:BK-ESC-1", "the invoice completion issued, untouched by the refund");
  assert.deepEqual([cn.sac, JSON.parse(cn.snapshot_json).seller.legalName], ["998599", SELLER.legalName], "the SAC and the seller the invoice printed");
  assert.deepEqual([cn.place_of_supply, cn.supply_type, cn.gstr1_section, cn.recipient_registered, cn.refund_reference, cn.seller_gstin], ["29", "INTRA", "b2cs", 0, "rfnd_ESC1", SELLER_GSTIN]);
  assert.equal(cn.original_invoice_fy, `20${financialYear(istDate(COMPLETED))}`, "the financial year of the original invoice is recorded (s.34(2) time limit)");
  assert.equal(ledger(f, "2130-GST Payable", "BK-ESC-1"), r2(45.76 - 9.15), "9.15 of the 45.76 GST taken back off 2130");
  assert.equal(f.row("SELECT COALESCE(SUM(amount),0) n FROM finance_tax_ledger WHERE source_type='credit_note' AND source_id=?", cn.id).n, -9.15, "the tax ledger adjustment the statutory package nets");

  // The provider payout: 700 -> 560 before release; the provider is told.
  const item = f.row("SELECT * FROM provider_payout_queue_items WHERE booking_id='BK-ESC-1'");
  assert.deepEqual([item.status, item.amount, item.refund_adjustment], ["awaiting_release", 560, 140]);
  assert.equal(ledger(f, "2110-Provider Payable", "BK-ESC-1"), 560);
  const notice = f.row("SELECT * FROM provider_payout_notices WHERE booking_id='BK-ESC-1'");
  assert.deepEqual([notice.provider_id, notice.kind, notice.amount], ["PRV-G", "payout_reduced", 140]);
  assert.match(notice.message, /^Payout adjusted by Rs 140\.00 for booking BK-ESC-1/);
  // The customer is told through the communication engine: approved, then processed.
  const messages = f.rows("SELECT template_key,payload_json FROM communication_messages WHERE booking_id='BK-ESC-1' ORDER BY created_at");
  assert.deepEqual(messages.map((m) => m.template_key), ["escalation_refund_approved", "escalation_refund_processed"]);
  assert.match(JSON.parse(messages[0].payload_json).body, /refund of Rs 200\.00 for booking BK-ESC-1 has been approved/);
  assert.match(JSON.parse(messages[1].payload_json).body, new RegExp(`processed to your original payment method.*Credit note ${NOTE_PREFIX.replaceAll("/", "\\/")}00001`));
  assert.match(JSON.parse(messages[1].payload_json).body, /Sorry about the missed nail trim/);

  // Net cost: refund 200 less provider reduction 140 and GST reduction 9.15 equals 50.85.
  assert.equal(r2(f.row("SELECT COALESCE(SUM(debit-credit),0) n FROM finance_journal_entries WHERE account_code='4900-Refunds and Cancellations'").n), 50.85);
  assertBooksBalance(f);

  // The release pays 560, once.
  const release = await payoutQueue.releaseProviderPayouts(f.db, { bookingIds: ["BK-ESC-1"], actor: FINANCE });
  assert.deepEqual(release.refused, []);
  assert.equal(release.released[0].amount, 560);
  assert.equal((await payoutQueue.reconcileProviderPayable(f.db)).ok, true);

  // Replays settle nothing twice: the same webhook again, the sweep, and the settlement run.
  const replay = await refundProcessedWebhook(f, "BK-ESC-1", f1);
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  await refundSweep.runAutomaticBookingRefundSweep(f.db, ENV, {});
  await escalation.settleEscalationRefunds(f.db, { refundCaseIds: [`${request.id}-RF`] });
  assert.equal(f.row("SELECT COUNT(*) n FROM finance_credit_notes").n, 1);
  assert.equal(f.row("SELECT COUNT(*) n FROM provider_payout_notices").n, 1);
  assert.equal(f.row("SELECT COUNT(*) n FROM security_audit_events WHERE action='escalation_refund.settle'").n, 1);
  assert.equal(f.refunds.length, 1, "and no second gateway refund");
  assert.equal(ledger(f, "2130-GST Payable", "BK-ESC-1"), 36.61);
  assertBooksBalance(f);
});

test("after the payout was released, the provider's Rs 140 is recovered from their next payout and shown on their statement", async (t) => {
  const f = await refundWorld(t);
  await verifiedProvider(f, "PRV-R");
  await completedBooking(f, "BK-REL-1", { provider: "PRV-R" });
  await payoutQueue.runProviderPayoutQueueSweep(f.db, { force: true });
  const paid = await payoutQueue.releaseProviderPayouts(f.db, { bookingIds: ["BK-REL-1"], actor: FINANCE });
  assert.equal(paid.released[0].amount, 700, "the provider was paid in full before the escalation");
  const position = await escalation.escalationRefundPosition(f.db, { bookingId: "BK-REL-1", percent: 20 });
  assert.equal(position.preview.providerImpact.stage, "after_release");
  assert.match(position.preview.providerImpact.label, /already released: Rs 140\.00 is recovered from the provider's next payout/);

  const { hook } = await refundAfterCompletion(f, "BK-REL-1", 20);
  const settled = hook.escalationRefund.results[0];
  assert.deepEqual([settled.settled, settled.payoutStage, settled.providerShare], [true, "after_release", 140]);
  const recovery = f.row("SELECT * FROM provider_payout_recoveries WHERE booking_id='BK-REL-1'");
  assert.deepEqual([recovery.amount, recovery.status, recovery.provider_id], [140, "open", "PRV-R"], "700 paid, 560 earned after the refund");
  assert.equal(ledger(f, "1310-Provider Recoveries Receivable", "BK-REL-1"), -140, "a receivable from the provider");
  const notice = f.row("SELECT * FROM provider_payout_notices WHERE booking_id='BK-REL-1'");
  assert.deepEqual([notice.kind, notice.amount], ["recovery_from_next_payout", 140]);
  assert.match(notice.message, /^Payout adjusted by Rs 140\.00 for booking BK-REL-1: .*taken off your next payout/);
  // The hourly run does not recover the same refund again.
  const rerun = await payoutQueue.runProviderPayoutQueueSweep(f.db, { asOf: Date.now() + 2 * 60 * 60_000 });
  assert.equal(rerun.recoveries, 0);
  assert.equal(f.row("SELECT COUNT(*) n FROM provider_payout_recoveries").n, 1);

  // The provider sees the adjustment on their payout statement.
  const { providerWorkspace } = await import("../lib/provider-workspace.ts");
  const statement = await providerWorkspace(f.db, { providerId: "PRV-R" });
  assert.deepEqual(statement.earnings.payoutAdjustments.map((row) => [row.bookingId, row.kind, row.amount]), [["BK-REL-1", "recovery_from_next_payout", 140]]);

  // Their next payout carries the deduction.
  await completedBooking(f, "BK-REL-2", { provider: "PRV-R" });
  await payoutQueue.runProviderPayoutQueueSweep(f.db, { force: true });
  assert.equal(f.row("SELECT amount FROM provider_payout_queue_items WHERE booking_id='BK-REL-2'").amount, 560, "the queue shows the deduction before anyone releases it");
  const next = await payoutQueue.releaseProviderPayouts(f.db, { bookingIds: ["BK-REL-2"], actor: FINANCE });
  assert.deepEqual([next.released[0].recoveryDeducted, next.released[0].amount], [140, 560]);
  assert.equal(f.row("SELECT status FROM provider_payout_recoveries WHERE booking_id='BK-REL-1'").status, "recovered");
  assert.equal(r2(f.row("SELECT COALESCE(SUM(debit-credit),0) n FROM finance_journal_entries WHERE account_code='1310-Provider Recoveries Receivable'").n), 0, "the receivable is cleared by the deduction");
  assert.equal((await payoutQueue.reconcileProviderPayable(f.db)).ok, true);
  assertBooksBalance(f);
});

test("the provider's share is worked out from the payout record if the completion journal is not there (a completion cut short)", async (t) => {
  const f = await refundWorld(t);
  await completedBooking(f, "BK-NOJRN", { provider: "PRV-G" });
  const posted = await payoutQueue.providerPayoutRefundImpact(f.db, { bookingId: "BK-NOJRN", refund: 200 });
  assert.deepEqual([posted.stage, posted.payable, posted.providerShare], ["before_queue", 700, 140], "normally from the completion journal");
  f.sqlite.prepare("UPDATE finance_journal_entries SET posted=0 WHERE source_type='service_completion' AND source_id='BK-NOJRN'").run();
  const recorded = await payoutQueue.providerPayoutRefundImpact(f.db, { bookingId: "BK-NOJRN", refund: 200 });
  assert.deepEqual([recorded.stage, recorded.payable, recorded.providerShare], ["before_queue", 700, 140], "else from the payout record completion finalised, never a silent zero");
});

test("own supply: 20% of Rs 1,000 gives a credit note of taxable 169.49 and GST 30.51, and there is no provider payout to adjust", async (t) => {
  const f = await refundWorld(t);
  f.sqlite.prepare("INSERT INTO provider_capacity_profiles VALUES ('PRV-FT','full_time')").run();
  const fact = await completedBooking(f, "BK-OWN", { provider: "PRV-FT", providerModel: "full_time" });
  assert.equal(fact.gstLiability, 152.54, "PawSpace's own supply: GST extracted from the inclusive 1,000");
  const { hook } = await refundAfterCompletion(f, "BK-OWN", 20);
  const cn = note(f, "BK-OWN");
  assert.deepEqual([cn.treatment, cn.refund_amount, cn.value_reduced, cn.taxable_value, cn.tax_total, cn.cgst, cn.sgst, cn.igst], ["own_supply", 200, 200, 169.49, 30.51, 15.26, 15.25, 0]);
  assert.equal(cn.sac, "998612", "the SAC the own supply's invoice line carries (animal husbandry services)");
  assert.equal(ledger(f, "2130-GST Payable", "BK-OWN"), 122.03, "152.54 - 30.51");
  const settlement = f.row("SELECT * FROM escalation_refund_settlements WHERE booking_id='BK-OWN'");
  assert.deepEqual([settlement.status, settlement.payout_stage, settlement.provider_share, settlement.tcs_outcome], ["settled", "no_provider_payout", 0, "not_a_taxable_commission_supply"]);
  assert.equal(f.row("SELECT COUNT(*) n FROM provider_payout_notices").n, 0, "nobody to tell: no provider payout on an own supply");
  assert.equal(hook.escalationRefund.results[0].creditNoteNumber, `${NOTE_PREFIX}00001`);
  // PawSpace carries the refund less extracted GST: 200 - 30.51.
  assert.equal(r2(f.row("SELECT COALESCE(SUM(debit-credit),0) n FROM finance_journal_entries WHERE account_code='4900-Refunds and Cancellations'").n), 169.49);
  assertBooksBalance(f);
});

test("funeral: no GST on the credit note; under Schedule III (the default) it reduces GSTR-3B 3.1(e) and GSTR-1 Table 8", async (t) => {
  const f = await refundWorld(t);
  const fact = await completedBooking(f, "BK-FUN", { service: "funeral_memorial", provider: "PRV-VENDOR" });
  assert.deepEqual([fact.gstLiability, fact.providerPayoutAccrued], [0, 700]);
  await refundAfterCompletion(f, "BK-FUN", 20);
  const cn = note(f, "BK-FUN");
  assert.deepEqual([cn.treatment, cn.tax_total, cn.cgst, cn.sgst, cn.igst, cn.taxable_value, cn.exempt_value, cn.gstr1_section, cn.gst_rate], ["non_gst", 0, 0, 0, 0, 0, 60, "nil", 0]);
  assert.equal(cn.sac, "999731");
  assert.equal(cn.journal_group, null, "no GST, so no GST journal");
  assert.equal(f.row("SELECT COUNT(*) n FROM finance_tax_ledger WHERE source_type='credit_note'").n, 0);
  assert.equal(ledger(f, "2130-GST Payable", "BK-FUN"), 0);
  assert.equal(f.row("SELECT refund_adjustment FROM provider_payout_queue_items WHERE booking_id='BK-FUN'"), undefined, "not queued yet");
  assert.equal(f.row("SELECT provider_share FROM escalation_refund_settlements WHERE booking_id='BK-FUN'").provider_share, 140, "the funeral vendor still carries 70% of the refund");

  const gstr3b = await returns.generateGstr3b(f.db, scope(REFUND_PERIOD), FINANCE);
  assert.deepEqual(gstr3b.payload.sup_details.osup_nongst, { txval: -60 }, "3.1(e): PawSpace's non-GST value reduced by its 60");
  assert.deepEqual(gstr3b.payload.sup_details.osup_det, { txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 }, "no output tax to reduce");
  assert.equal(gstr3b.summary.totalOutputTax, 0);
  assert.equal(gstr3b.summary.creditNotes.taxReduced, 0);
  const gstr1 = await returns.generateGstr1(f.db, scope(REFUND_PERIOD), FINANCE);
  assert.deepEqual(gstr1.payload.nil.inv, [{ sply_ty: "INTRAB2C", expt_amt: 0, nil_amt: 0, ngsup_amt: -60 }], "Table 8, non-GST column");
  assert.deepEqual(gstr1.payload.b2cs, []);
  const printed = creditNotes.renderCreditNoteHtml(await creditNotes.getCreditNote(f.db, cn.id));
  assert.match(printed, /Non-GST supply \(Schedule III\): no GST/);
});

test("GSTR-3B of the refund month shows output tax reduced by exactly the credit note; GSTR-1 carries it; the month's close and payables agree", async (t) => {
  const f = await refundWorld(t);
  await completedBooking(f, "BK-PREV", { provider: "PRV-A" });
  await completedBooking(f, "BK-NOW", { provider: "PRV-B", completedAt: SAME_MONTH_COMPLETED });
  // Each booking's customer tax invoice puts it under the seller's entity and registration: nothing to assign.
  assert.deepEqual(await supplies.serviceSupplyOwnershipSnapshot(f.db), []);
  const before3b = await returns.generateGstr3b(f.db, scope(REFUND_PERIOD), FINANCE);
  const before1 = await returns.generateGstr1(f.db, scope(REFUND_PERIOD), FINANCE);
  const beforePrevious = await returns.generateGstr3b(f.db, scope(COMPLETION_PERIOD), FINANCE);
  assert.deepEqual([before3b.summary.totalOutputTax, beforePrevious.summary.totalOutputTax], [45.76, 45.76]);

  await refundAfterCompletion(f, "BK-PREV", 20);
  const cn = note(f, "BK-PREV");
  assert.deepEqual([cn.period_code, cn.tax_total, cn.gstr1_section], [REFUND_PERIOD, 9.15, "b2cs"], "an unregistered intra-State customer: a negative B2CS adjustment in the month of issue");

  const gstr3b = await returns.generateGstr3b(f.db, scope(REFUND_PERIOD), FINANCE);
  assert.equal(r2(before3b.summary.totalOutputTax - gstr3b.summary.totalOutputTax), cn.tax_total, "reduced by exactly the credit note");
  assert.equal(gstr3b.summary.totalOutputTax, 36.61);
  assert.equal(gstr3b.summary.netTaxPayable, 36.61);
  assert.deepEqual(gstr3b.payload.sup_details.osup_det, { txval: 203.39, iamt: 0, camt: 18.3, samt: 18.31, csamt: 0 }, "3.1(a) nets the issued invoice and its proportionate inclusive credit note");
  assert.deepEqual([gstr3b.summary.creditNotes.count, gstr3b.summary.creditNotes.taxReduced, gstr3b.summary.creditNotes.taxableValueReduced], [1, 9.15, 50.85]);
  const gstr1 = await returns.generateGstr1(f.db, scope(REFUND_PERIOD), FINANCE);
  assert.deepEqual(gstr1.payload.b2cs.find((b) => b.pos === "29" && b.rt === 18), { sply_ty: "INTRA", pos: "29", typ: "OE", rt: 18, txval: 203.39, iamt: 0, camt: 18.3, samt: 18.31, csamt: 0 }, "Table 7 B2CS, net of the note");
  const hsn = gstr1.payload.hsn.data.find((h) => h.hsn_sc === "998599");
  assert.deepEqual([hsn.txval, hsn.camt, hsn.samt], [203.39, 18.3, 18.31]);
  assert.deepEqual([gstr1.payload.cdnr ?? [], gstr1.payload.cdnur ?? []], [[], []], "not CDNR (unregistered) and not CDNUR (not a B2C Large invoice)");
  assert.equal(r2(before1.summary.totalOutputTax - gstr1.summary.totalOutputTax), 9.15);
  assert.deepEqual(gstr1.summary.creditNotes.notes.map((n) => [n.number, n.section, n.originalInvoice, n.taxableValue, n.tax]), [[cn.credit_note_number, "b2cs", cn.original_invoice_number, 50.85, 9.15]]);
  assert.deepEqual([gstr1.summary.bookingInvoices.count, gstr1.summary.invoiceVariances.count], [1, 0], "the month's supply is filed from its invoice, with no variance");
  assert.equal(gstr1.summary.creditNotes.negativeB2cs, false);
  // The completion month is not rewritten.
  const previous = await returns.generateGstr3b(f.db, scope(COMPLETION_PERIOD), FINANCE);
  assert.equal(previous.summary.totalOutputTax, 45.76);
  assert.equal(previous.summary.ledgerCheck.agrees, true, "the completion's own journal still matches what that month filed");

  const view = await close.monthlyCloseView(f.db, { period: REFUND_PERIOD, actorId: FINANCE });
  assert.deepEqual([view.gst.outputTax, view.gst.creditNoteTax], [36.61, 9.15], "the monthly close is net of the note");
  const payables = await taxPayments.taxPayableReconciliation(f.db, { periodCode: REFUND_PERIOD });
  assert.deepEqual([payables.gst.filedServiceGst, payables.gst.accrued, payables.gst.difference, payables.gst.creditNoteGst, payables.gst.creditNotes], [36.61, 36.61, 0, 9.15, 1], "2130 accrued net of the note equals what is filed");
  const untouched = await taxPayments.taxPayableReconciliation(f.db, { periodCode: COMPLETION_PERIOD });
  assert.deepEqual([untouched.gst.filedServiceGst, untouched.gst.accrued, "creditNoteGst" in untouched.gst, "creditNotes" in untouched.gst, "tcsReversedForRefunds" in untouched.tcs], [45.76, 45.76, false, false, false], "a month with no note reads exactly as before");
  const pkg = await gstAccounting.generateStatutoryPackage(f.db, scope(REFUND_PERIOD), MAKER);
  assert.equal(pkg.summary.adjustments, -9.15, "the statutory package carries the note as a tax ledger adjustment, as for any credit note");
  assert.equal(pkg.summary.ledgerCheck.agrees, true);
  assertBooksBalance(f);
});

test("GSTR-1: a registered customer's note is CDNR; CDNUR only against a B2C Large invoice (the invoice's own value above Rs 1 lakh, inter-State); a large booking whose invoice is PawSpace's small fee nets in B2CS", async (t) => {
  const f = await refundWorld(t);
  f.sqlite.prepare("INSERT INTO finance_customer_tax_profiles (customer_id,registration_reference,customer_type,place_of_supply,status,updated_at) VALUES ('CUS-B2B',?,'business','29','active',1)").run(CUSTOMER_GSTIN);
  for (const id of ["CUS-B2CL", "CUS-LARGE"]) f.sqlite.prepare("INSERT INTO finance_customer_tax_profiles (customer_id,registration_reference,customer_type,place_of_supply,status,updated_at) VALUES (?,NULL,'consumer','27','active',1)").run(id);
  f.sqlite.prepare("INSERT INTO provider_capacity_profiles VALUES ('PRV-FT','full_time')").run();
  await completedBooking(f, "BK-B2B", { provider: "PRV-A", customer: "CUS-B2B" });
  // PawSpace's own supply to a Maharashtra customer: its invoice is worth the 1,50,000 paid (IGST included) - a B2C Large invoice.
  const own = await completedBooking(f, "BK-B2CL", { service: "boarding", provider: "PRV-FT", providerModel: "full_time", customer: "CUS-B2CL", amount: 150000 });
  assert.equal(own.gstLiability, 22881.36, "IGST extracted from inclusive own supply 1,50,000 to Maharashtra");
  // A commission booking of the same size: the booking is above Rs 1 lakh, but PawSpace's own line on the invoice is its 45,000 fee.
  const stay = await completedBooking(f, "BK-LARGE", { service: "boarding", provider: "PRV-H", customer: "CUS-LARGE", amount: 150000 });
  assert.equal(stay.gstLiability, 6864.41, "GST extracted from inclusive commission 45,000");
  assert.deepEqual(f.rows("SELECT source_id,subtotal,tax_total,total FROM finance_invoices ORDER BY source_id"), [{ source_id: "BK-B2B", subtotal: 254.24, tax_total: 45.76, total: 1000 }, { source_id: "BK-B2CL", subtotal: 127118.64, tax_total: 22881.36, total: 150000 }, { source_id: "BK-LARGE", subtotal: 38135.59, tax_total: 6864.41, total: 150000 }], "the invoices as the seller issued them: GST included in what the customer paid");
  for (const id of ["BK-B2B", "BK-B2CL", "BK-LARGE"]) await refundAfterCompletion(f, id, 20);
  const b2b = note(f, "BK-B2B"), b2cl = note(f, "BK-B2CL"), large = note(f, "BK-LARGE");
  assert.deepEqual([b2b.gstr1_section, b2b.recipient_gstin, b2b.recipient_registered, b2b.credit_note_number], ["cdnr", CUSTOMER_GSTIN, 1, `${NOTE_PREFIX}00001`]);
  assert.deepEqual([b2cl.gstr1_section, b2cl.place_of_supply, b2cl.supply_type, b2cl.taxable_value, b2cl.igst, b2cl.cgst, b2cl.credit_note_number, JSON.parse(b2cl.snapshot_json).originalInvoice.value], ["cdnur", "27", "INTER", 25423.73, 4576.27, 0, `${NOTE_PREFIX}00002`, 150000], "20% of the inclusive own supply, IGST extracted; numbered in sequence");
  assert.deepEqual([large.gstr1_section, large.place_of_supply, large.supply_type, large.taxable_value, large.igst, JSON.parse(large.snapshot_json).originalInvoice.value], ["b2cs", "27", "INTER", 7627.12, 1372.88, 45000], "the invoice's own value (the 45,000 fee) is under the B2C Large limit, so the note nets Table 7");
  const gstr1 = await returns.generateGstr1(f.db, scope(REFUND_PERIOD), FINANCE);
  assert.deepEqual(gstr1.payload.cdnr, [{ ctin: CUSTOMER_GSTIN, ntty: "C", nt_num: b2b.credit_note_number, nt_dt: b2b.issue_date, pos: "29", rchrg: "N", inv_typ: "R", val: 60, itms: [{ num: 1, itm_det: { rt: 18, txval: 50.85, iamt: 0, camt: 4.58, samt: 4.57, csamt: 0 } }] }], "val is taxable value + tax, as the existing credit note path files it");
  assert.deepEqual(gstr1.payload.cdnur, [{ typ: "B2CL", ntty: "C", nt_num: b2cl.credit_note_number, nt_dt: b2cl.issue_date, pos: "27", rchrg: "N", inv_typ: "R", val: 30000, itms: [{ num: 1, itm_det: { rt: 18, txval: 25423.73, iamt: 4576.27, camt: 0, samt: 0, csamt: 0 } }] }]);
  assert.deepEqual([gstr1.summary.cdnrCount, gstr1.summary.cdnurCount], [1, 1]);
  assert.deepEqual(gstr1.payload.b2cs, [{ sply_ty: "INTER", pos: "27", typ: "OE", rt: 18, txval: -7627.12, iamt: -1372.88, camt: 0, samt: 0, csamt: 0 }], "the large booking's note: a negative Table 7 line for Maharashtra in the month of issue");
  assert.equal(gstr1.summary.creditNotes.negativeB2cs, true);
  const gstr3b = await returns.generateGstr3b(f.db, scope(REFUND_PERIOD), FINANCE);
  assert.deepEqual(gstr3b.payload.sup_details.osup_det, { txval: -33101.7, iamt: -5949.15, camt: -4.58, samt: -4.57, csamt: 0 }, "the net figure flows into 3.1(a)");
});

test("a note still waiting for its invoice when its month closes is issued in the next open month; the request still reaches processed", async (t) => {
  const f = await refundWorld(t, { invoiceSeries: false });
  await completedBooking(f, "BK-WAIT", { completedAt: SAME_MONTH_COMPLETED });
  const { approved, hook } = await refundAfterCompletion(f, "BK-WAIT", 20);
  assert.equal(hook.escalationRefund.pending, 1, "no invoice yet: the note waits");
  const caseId = approved.refundCaseId;
  assert.deepEqual([f.row("SELECT period_code FROM escalation_refund_settlements WHERE refund_case_id=?", caseId).period_code, f.row("SELECT tcs_outcome FROM escalation_refund_settlements WHERE refund_case_id=?", caseId).tcs_outcome], [REFUND_PERIOD, "provider_not_gst_registered"]);
  // The invoice arrives, and Finance closes the month before the sweep gets back to the note.
  addInvoiceSeries(f.sqlite);
  assert.equal((await bookingInvoices.issueBookingInvoice(f.db, { bookingId: "BK-WAIT", actorId: FINANCE })).status, "issued");
  f.sqlite.prepare("INSERT INTO finance_close_periods (period_code,status,checklist_json,locked_at,locked_by,updated_at) VALUES (?,'locked','{}',1,?,1)").run(REFUND_PERIOD, FINANCE);
  const stuck = await escalation.settleEscalationRefunds(f.db, { refundCaseIds: [caseId] });
  assert.equal(stuck.pending, 1, "while today's month is the closed one, there is no open month to issue into");
  assert.match(stuck.errors[0], /period_locked/);
  assert.equal(note(f, "BK-WAIT"), undefined);
  // The next month is open: the note is dated in it, and nothing is written into the closed month.
  const nextMonthDay = Date.parse(`${NEXT_PERIOD}-03T12:00:00+05:30`);
  const run = await escalation.settleEscalationRefunds(f.db, { refundCaseIds: [caseId], asOf: nextMonthDay });
  assert.equal(run.settled, 1, JSON.stringify(run));
  const cn = note(f, "BK-WAIT");
  assert.deepEqual([cn.period_code, cn.issue_date, cn.taxable_value, cn.tax_total], [NEXT_PERIOD, istDate(nextMonthDay), 50.85, 9.15]);
  const settlement = f.row("SELECT status,period_code,issue_date,moved_from_period FROM escalation_refund_settlements WHERE refund_case_id=?", caseId);
  assert.deepEqual(settlement, { status: "settled", period_code: NEXT_PERIOD, issue_date: istDate(nextMonthDay), moved_from_period: REFUND_PERIOD });
  assert.equal(f.row("SELECT COUNT(*) n FROM finance_journal_entries WHERE period_code=? AND source_type='escalation_credit_note'", REFUND_PERIOD).n, 0);
  assert.equal(f.row("SELECT status FROM escalation_refund_requests WHERE booking_id='BK-WAIT'").status, "processed");
  assertBooksBalance(f);
});

test("s.52 net value: a GSTIN provider's TCS base is reduced in the refund month; a provider without a GSTIN has nothing to reduce", async (t) => {
  const f = await refundWorld(t);
  await statutoryTcs.saveProviderTaxProfile(f.db, { providerId: "PRV-GST", gstin: PROVIDER_GSTIN }, FINANCE);
  await verifiedProvider(f, "PRV-GST");
  const sameMonth = await completedBooking(f, "BK-TCS-NOW", { provider: "PRV-GST", completedAt: SAME_MONTH_COMPLETED });
  assert.deepEqual([sameMonth.tcsWithheld, sameMonth.providerPayoutAccrued], [5, 695], "0.5% of 1,000 withheld from the registered provider");
  await completedBooking(f, "BK-TCS-PREV", { provider: "PRV-GST" });
  await completedBooking(f, "BK-NO-GSTIN", { provider: "PRV-PLAIN" });
  await payoutQueue.runProviderPayoutQueueSweep(f.db, { force: true });
  const previousBefore = await statutoryTcs.computeMonthlyTcsStatutory(f.db, { period: COMPLETION_PERIOD, actorId: FINANCE });
  assert.deepEqual([previousBefore.totalNetValue, previousBefore.totalTcs], [1000, 5]);

  for (const id of ["BK-TCS-NOW", "BK-TCS-PREV", "BK-NO-GSTIN"]) await refundAfterCompletion(f, id, 20);
  const adjustments = f.rows("SELECT booking_id,period_code,completion_period,returned_value,cgst,sgst,igst,tcs_total,supplier_gstin FROM finance_tcs_base_adjustments ORDER BY booking_id");
  assert.deepEqual(adjustments, [
    { booking_id: "BK-TCS-NOW", period_code: REFUND_PERIOD, completion_period: REFUND_PERIOD, returned_value: 200, cgst: 0.5, sgst: 0.5, igst: 0, tcs_total: 1, supplier_gstin: PROVIDER_GSTIN },
    { booking_id: "BK-TCS-PREV", period_code: REFUND_PERIOD, completion_period: COMPLETION_PERIOD, returned_value: 200, cgst: 0.5, sgst: 0.5, igst: 0, tcs_total: 1, supplier_gstin: PROVIDER_GSTIN },
  ], "only the GSTIN provider's bookings, in the month of the refund");
  assert.equal(f.row("SELECT tcs_outcome FROM escalation_refund_settlements WHERE booking_id='BK-NO-GSTIN'").tcs_outcome, "provider_not_gst_registered");
  assert.equal(ledger(f, "2140-TCS Payable", "BK-TCS-PREV"), 4, "the 1 withheld on the returned 200 is reversed");

  const gstr8 = await statutoryTcs.computeMonthlyTcsStatutory(f.db, { period: REFUND_PERIOD, actorId: FINANCE });
  const lines = Object.fromEntries(f.rows("SELECT booking_id,gross_supply_value,returned_supply_value,net_taxable_value,tcs_total FROM tcs_collections WHERE period=?", REFUND_PERIOD).map((row) => [row.booking_id, [row.gross_supply_value, row.returned_supply_value, row.net_taxable_value, row.tcs_total]]));
  assert.deepEqual(lines, { "BK-TCS-NOW": [1000, 200, 800, 4], "BK-TCS-PREV": [0, 200, -200, -1] }, "net value in the refund month: same-month supply netted, an earlier month's supply returned");
  assert.deepEqual([gstr8.totalNetValue, gstr8.totalTcs, gstr8.returnedSupplyValue], [600, 3, 400]);
  const previousAfter = await statutoryTcs.computeMonthlyTcsStatutory(f.db, { period: COMPLETION_PERIOD, actorId: FINANCE });
  assert.deepEqual([previousAfter.totalNetValue, previousAfter.totalTcs], [1000, 5], "the completion month's GSTR-8 is not rewritten");
  const payables = await taxPayments.taxPayableReconciliation(f.db, { periodCode: REFUND_PERIOD });
  assert.deepEqual([payables.tcs.accrued, payables.tcs.tcsCollections, payables.tcs.difference, payables.tcs.sameBookings.mismatches], [3, 3, 0, []], "2140 net of the reversals equals GSTR-8");

  // The GSTIN provider's payout (695 after TCS) comes down pro rata: 695 x 800 / 1,000 = 556.
  assert.equal(f.row("SELECT amount FROM provider_payout_queue_items WHERE booking_id='BK-TCS-PREV'").amount, 556);
  assert.equal(f.row("SELECT provider_share FROM escalation_refund_settlements WHERE booking_id='BK-TCS-PREV'").provider_share, 139);
  assertBooksBalance(f);
});

// ------------------------------------------------------------------------------------------------------------------------
// Controls: who may ask and approve, races, idempotency, caps, refusals, closed months and the Section 34 time limit.
// ------------------------------------------------------------------------------------------------------------------------
const actor = (email, roleCode) => ({ email, roleCode });
const refusal = async (promise) => { const outcome = await attempt(() => promise); return { ...outcome, json: outcome.body ? JSON.parse(outcome.body) : null }; };
const auditCount = (f, action, requestId) => f.row("SELECT COUNT(*) n FROM security_audit_events WHERE action=? AND resource_id=?", action, requestId).n;

test("the person who asked cannot approve their own refund; a different Finance approver can", async (t) => {
  const f = await refundWorld(t);
  await completedBooking(f, "BK-SOD");
  // The founder holds both permissions, so only the second-person rule stops them.
  const asked = await callRefunds("POST", FOUNDER, { action: "request", bookingId: "BK-SOD", percent: 25, reason: "Pet came back with matted fur" });
  assert.equal(asked.status, 201, JSON.stringify(asked.body));
  const requestId = asked.body.data.request.id;
  const own = await callRefunds("POST", FOUNDER, { action: "approve", requestId });
  assert.equal(own.status, 409);
  assert.equal(own.body.code, "escalation_refund_self_approval_forbidden");
  assert.equal(f.row("SELECT COUNT(*) n FROM booking_refund_cases").n, 0, "nothing was opened");
  assert.equal(auditCount(f, "escalation_refund.approve", requestId), 0, "and nothing was audited as approved");
  assert.equal(f.refunds.length, 0);
  // Case and spacing do not make the same person someone else.
  const disguised = await refusal(escalation.decideEscalationRefund(f.db, ENV, { requestId, decision: "approve" }, actor(` ${FOUNDER.toUpperCase()} `, "founder")));
  assert.equal(disguised.status, 409);
  const other = await callRefunds("POST", FINANCE, { action: "approve", requestId });
  assert.equal(other.status, 200, JSON.stringify(other.body));
  assert.equal(f.row("SELECT decided_by FROM escalation_refund_requests WHERE id=?", requestId).decided_by, FINANCE);
  assert.equal(f.refunds.length, 1);
});

test("the person who asked cannot reject their own refund either; a different Finance person decides it", async (t) => {
  const f = await refundWorld(t);
  await completedBooking(f, "BK-SOR");
  const asked = await callRefunds("POST", FOUNDER, { action: "request", bookingId: "BK-SOR", percent: 10, reason: "Pet came back with matted fur" });
  assert.equal(asked.status, 201, JSON.stringify(asked.body));
  const requestId = asked.body.data.request.id;
  const own = await callRefunds("POST", FOUNDER, { action: "reject", requestId, reason: "Asked for this by mistake" });
  assert.equal(own.status, 409);
  assert.equal(own.body.code, "escalation_refund_self_decision_forbidden");
  assert.equal(f.row("SELECT status FROM escalation_refund_requests WHERE id=?", requestId).status, "requested", "still waiting");
  assert.equal(auditCount(f, "escalation_refund.reject", requestId), 0);
  const other = await callRefunds("POST", FINANCE, { action: "reject", requestId, reason: "Asked for this by mistake" });
  assert.equal(other.status, 200, JSON.stringify(other.body));
  assert.equal(f.row("SELECT status,decided_by FROM escalation_refund_requests WHERE id=?", requestId).decided_by, FINANCE);
});

/** Holds each decision's write until both decisions have passed every check, so they really race for the same request. */
function racingDb(db, parties = 2) {
  const waiting = [];
  let arrived = 0;
  return new Proxy(db, {
    get(target, key) {
      if (key !== "batch") return target[key];
      return async (statements) => {
        if (statements.some((statement) => /UPDATE escalation_refund_requests SET status='(approved|rejected)'/.test(statement.sql))) {
          arrived += 1;
          if (arrived < parties) await new Promise((resolve) => waiting.push(resolve));
          else waiting.splice(0).forEach((resolve) => resolve());
        }
        return target.batch(statements);
      };
    },
  });
}
async function decideRace(f, requestId, decisions) {
  const db = racingDb(f.db, decisions.length);
  const settled = await Promise.allSettled(decisions.map(([decision, email]) => escalation.decideEscalationRefund(db, ENV, { requestId, decision, reason: decision === "reject" ? "Duplicate of an earlier goodwill refund" : null }, actor(email, "finance"))));
  const won = settled.filter((s) => s.status === "fulfilled").map((s) => s.value);
  const lost = await Promise.all(settled.filter((s) => s.status === "rejected").map(async (s) => ({ status: s.reason.status, body: await s.reason.clone().json() })));
  return { won, lost };
}

test("two approvals racing, and an approval racing a rejection, resolve to exactly one outcome; the loser gets 409 and writes nothing", async (t) => {
  const f = await refundWorld(t);
  await completedBooking(f, "BK-RACE-1");
  await completedBooking(f, "BK-RACE-2");
  const first = await escalation.requestEscalationRefund(f.db, { bookingId: "BK-RACE-1", percent: 20, reason: "Late arrival and rushed groom" }, actor(OPS, "admin"));
  const approvals = await decideRace(f, first.request.id, [["approve", FINANCE], ["approve", FINANCE_2]]);
  assert.equal(approvals.won.length, 1, "exactly one approval");
  assert.deepEqual(approvals.lost.map((l) => [l.status, l.body.code]), [[409, "escalation_refund_already_decided"]]);
  assert.equal(f.row("SELECT COUNT(*) n FROM booking_refund_cases WHERE booking_id='BK-RACE-1'").n, 1, "one refund case");
  assert.equal(auditCount(f, "escalation_refund.approve", first.request.id), 1, "one audit row: the loser wrote none");
  assert.equal(f.row("SELECT COUNT(*) n FROM booking_lifecycle_events WHERE booking_id='BK-RACE-1' AND event_type='escalation_refund.approved'").n, 1);
  assert.equal(f.refunds.length, 1, "one gateway refund");
  assert.equal(f.row("SELECT decided_by FROM escalation_refund_requests WHERE id=?", first.request.id).decided_by, approvals.won[0].request.decided_by);

  const second = await escalation.requestEscalationRefund(f.db, { bookingId: "BK-RACE-2", percent: 20, reason: "Late arrival and rushed groom" }, actor(OPS, "admin"));
  const mixed = await decideRace(f, second.request.id, [["approve", FINANCE], ["reject", FINANCE_2]]);
  assert.equal(mixed.won.length, 1);
  assert.deepEqual(mixed.lost.map((l) => [l.status, l.body.code]), [[409, "escalation_refund_already_decided"]]);
  const outcome = mixed.won[0].status;
  const audits = auditCount(f, "escalation_refund.approve", second.request.id) + auditCount(f, "escalation_refund.reject", second.request.id);
  assert.equal(audits, 1, "one decision audited, whichever won");
  assert.equal(f.row("SELECT status FROM escalation_refund_requests WHERE id=?", second.request.id).status, outcome);
  assert.equal(f.row("SELECT COUNT(*) n FROM booking_refund_cases WHERE booking_id='BK-RACE-2'").n, outcome === "approved" ? 1 : 0);
  assert.equal(f.refunds.length, outcome === "approved" ? 2 : 1);
});

test("the request is idempotent: a retried request is the same request, one waits per booking, and an approved request refunds once", async (t) => {
  const f = await refundWorld(t);
  await completedBooking(f, "BK-IDEM");
  const body = { action: "request", bookingId: "BK-IDEM", percent: 12.5, reason: "Nail trim was skipped", idempotencyKey: "bcc-submit-7f3a" };
  const first = await callRefunds("POST", OPS, body);
  const retried = await callRefunds("POST", OPS, body);
  assert.deepEqual([first.status, retried.status], [201, 200]);
  assert.equal(retried.body.data.request.id, first.body.data.request.id);
  assert.equal(retried.body.data.duplicatePrevented, true);
  assert.equal(first.body.data.request.amount, 125, "12.5% of 1,000");
  // The same request without the key (a double click after a reload) is still the waiting request.
  const again = await escalation.requestEscalationRefund(f.db, { bookingId: "BK-IDEM", percent: 12.5, reason: "Nail trim was skipped" }, actor(OPS, "admin"));
  assert.deepEqual([again.duplicatePrevented, again.request.id], [true, first.body.data.request.id]);
  // A different refund while one waits is refused: two people cannot each queue the same money.
  const different = await callRefunds("POST", OPS, { ...body, percent: 30, idempotencyKey: "bcc-submit-other" });
  assert.equal(different.status, 409);
  assert.equal(different.body.code, "escalation_refund_waiting");
  // The key belongs to its booking.
  await completedBooking(f, "BK-IDEM-2");
  const stolen = await callRefunds("POST", OPS, { ...body, bookingId: "BK-IDEM-2" });
  assert.equal(stolen.status, 409);
  assert.equal(f.row("SELECT COUNT(*) n FROM escalation_refund_requests").n, 1);
  assert.equal(auditCount(f, "escalation_refund.request", first.body.data.request.id), 1, "one request, one audit row");

  const requestId = first.body.data.request.id;
  assert.equal((await callRefunds("POST", FINANCE, { action: "approve", requestId })).status, 200);
  const twice = await callRefunds("POST", FINANCE_2, { action: "approve", requestId });
  assert.deepEqual([twice.status, twice.body.code], [409, "escalation_refund_already_decided"]);
  await refundSweep.runAutomaticBookingRefundSweep(f.db, ENV, {});
  await refundSweep.runAutomaticBookingRefundSweep(f.db, ENV, { refundCaseIds: [`${requestId}-RF`] });
  assert.equal(f.refunds.length, 1, "the case is refunded once, however often the sweep runs");
  assert.equal(f.refunds[0].amount, 12500);
});

test("the refund can never exceed what was captured less what is already refunded: capped when asked, checked again when approved", async (t) => {
  const f = await refundWorld(t);
  await completedBooking(f, "BK-CAP");
  await refundAfterCompletion(f, "BK-CAP", 60);
  const position = await escalation.escalationRefundPosition(f.db, { bookingId: "BK-CAP", percent: 50 });
  assert.deepEqual([position.payment.captured, position.payment.refundedSoFar, position.payment.refundable], [1000, 600, 400]);
  assert.deepEqual([position.preview.asked, position.preview.amount, position.preview.capped], [500, 400, true], "50% asked, capped at the 400 left");
  const capped = await callRefunds("POST", OPS, { action: "request", bookingId: "BK-CAP", percent: 50, reason: "Second complaint on the same visit" });
  assert.equal(capped.status, 201, JSON.stringify(capped.body));
  assert.deepEqual([capped.body.data.request.amount, capped.body.data.request.capped], [400, 1]);
  assert.equal((await callRefunds("POST", FINANCE, { action: "approve", requestId: capped.body.data.request.id })).status, 200);
  assert.deepEqual(f.refunds.map((refund) => refund.amount), [60000, 40000]);
  const none = await callRefunds("POST", OPS, { action: "request", bookingId: "BK-CAP", percent: 1, reason: "One more goodwill gesture" });
  assert.equal(none.status, 409);
  assert.match(none.body.error, /Nothing is left to refund: Rs 1,000\.00 was captured and Rs 1,000\.00 is already refunded or waiting/);

  // A refund made elsewhere (the gateway dashboard) after the request was raised is caught at approval.
  await completedBooking(f, "BK-RECHECK");
  const waiting = await escalation.requestEscalationRefund(f.db, { bookingId: "BK-RECHECK", percent: 50, reason: "Groomer cut the session short" }, actor(OPS, "admin"));
  f.sqlite.prepare("UPDATE payment_reconciliation_records SET refunded_amount=600 WHERE payment_id='PAY-BK-RECHECK'").run();
  const late = await callRefunds("POST", FINANCE, { action: "approve", requestId: waiting.request.id });
  assert.equal(late.status, 409);
  assert.equal(late.body.code, "escalation_refund_exceeds_refundable");
  assert.match(late.body.error, /leave only Rs 400\.00 refundable, less than the Rs 500\.00 asked/);
  assert.equal(f.row("SELECT status FROM escalation_refund_requests WHERE id=?", waiting.request.id).status, "requested");
  assert.equal(f.row("SELECT COUNT(*) n FROM booking_refund_cases WHERE booking_id='BK-RECHECK'").n, 0);
  assert.equal(f.refunds.length, 2);
});

test("refused on a booking that is not completed, unpaid, or not paid online; the percentage and reason are validated", async (t) => {
  const f = await refundWorld(t);
  await completedBooking(f, "BK-OPEN");
  f.sqlite.prepare("UPDATE canonical_bookings SET status='in_service' WHERE id='BK-OPEN'").run();
  await completedBooking(f, "BK-UNPAID", { pay: "none" });
  await completedBooking(f, "BK-CASH", { pay: "cash" });
  const ask = (bookingId, extra = {}) => callRefunds("POST", OPS, { action: "request", bookingId, percent: 20, reason: "Customer escalation after the visit", ...extra });
  const open = await ask("BK-OPEN");
  assert.equal(open.status, 409);
  assert.match(open.body.error, /Only a completed booking can get a refund after completion; this booking is in service/);
  const unpaid = await ask("BK-UNPAID");
  assert.equal(unpaid.status, 409);
  assert.match(unpaid.body.error, /no captured payment/);
  const cash = await ask("BK-CASH");
  assert.equal(cash.status, 409);
  assert.match(cash.body.error, /not captured online/);
  assert.equal((await ask("BK-MISSING")).status, 404);
  await completedBooking(f, "BK-VALID");
  for (const percent of [0, 0.5, 100.01, 12.345, "twenty", null]) assert.equal((await ask("BK-VALID", { percent })).status, 400, `percent ${percent}`);
  assert.equal((await ask("BK-VALID", { reason: "too short" })).status, 400, "a reason of at least 10 characters");
  assert.equal((await ask("BK-VALID", { customerNote: "x".repeat(501) })).status, 400);
  assert.equal((await ask("BK-VALID", { percent: 100 })).status, 201, "100% is allowed");
  assert.equal(f.row("SELECT COUNT(*) n FROM escalation_refund_requests").n, 1);
  assert.equal(f.refunds.length, 0);
});

test("authorization: Operations asks, Finance decides and reads; customers and anonymous callers are refused; the gateway maps the same", async (t) => {
  const f = await refundWorld(t);
  await completedBooking(f, "BK-AUTH");
  const anonymous = await refundRoute.POST(new Request("https://app.pawspace.in/api/escalation-refunds", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "request", bookingId: "BK-AUTH", percent: 20, reason: "Customer escalation after the visit" }) }));
  assert.equal(anonymous.status, 401);
  assert.equal((await refundRoute.GET(new Request("https://app.pawspace.in/api/escalation-refunds"))).status, 401);
  assert.equal((await callRefunds("POST", CUSTOMER, { action: "request", bookingId: "BK-AUTH", percent: 20, reason: "Customer escalation after the visit" })).status, 403);
  assert.equal((await callRefunds("GET", CUSTOMER, null)).status, 403);
  assert.equal((await callRefunds("GET", CUSTOMER, null, "?bookingId=BK-AUTH")).status, 403);
  assert.equal((await callRefunds("POST", FINANCE, { action: "request", bookingId: "BK-AUTH", percent: 20, reason: "Customer escalation after the visit" })).status, 403, "Finance decides; it does not ask");
  assert.equal((await callRefunds("GET", FINANCE, null, "?bookingId=BK-AUTH")).status, 403);
  const asked = await callRefunds("POST", OPS, { action: "request", bookingId: "BK-AUTH", percent: 20, reason: "Customer escalation after the visit" });
  assert.equal(asked.status, 201);
  assert.equal((await callRefunds("POST", OPS, { action: "approve", requestId: asked.body.data.request.id })).status, 403, "Operations asks; it does not approve");
  assert.equal((await callRefunds("POST", OPS, { action: "reject", requestId: asked.body.data.request.id, reason: "Changed my mind about it" })).status, 403);
  assert.equal((await callRefunds("POST", FINANCE, { action: "refund-now", requestId: asked.body.data.request.id })).status, 400);
  const crossSite = await refundRoute.POST(asActor(FINANCE, "/api/escalation-refunds", { method: "POST", headers: { origin: "https://evil.example" }, body: JSON.stringify({ action: "approve", requestId: asked.body.data.request.id }) }));
  assert.equal(crossSite.status, 403);
  assert.equal(f.row("SELECT status FROM escalation_refund_requests").status, "requested", "none of that decided anything");
  assert.equal((await creditNoteRoute.GET(asActor(CUSTOMER, "/api/credit-notes"))).status, 403);
  assert.equal((await creditNoteRoute.GET(new Request("https://app.pawspace.in/api/credit-notes"))).status, 401);
  assert.equal((await creditNoteRoute.GET(asActor(FINANCE, "/api/credit-notes"))).status, 200);

  const { requiredPermission } = await import("../lib/api-gateway.ts");
  const need = (path, init) => requiredPermission(new Request(`https://app.pawspace.in${path}`, init));
  assert.equal(await need("/api/escalation-refunds?bookingId=BK-AUTH"), "bookings.manage");
  assert.equal(await need("/api/escalation-refunds"), "finance.view");
  assert.equal(await need("/api/escalation-refunds", { method: "POST", body: JSON.stringify({ action: "request" }) }), "bookings.manage");
  assert.equal(await need("/api/escalation-refunds", { method: "POST", body: JSON.stringify({ action: "approve" }) }), "finance.manage");
  assert.equal(await need("/api/escalation-refunds", { method: "POST", body: JSON.stringify({ action: "reject" }) }), "finance.manage");
  assert.equal(await need("/api/escalation-refunds", { method: "POST", body: "not json" }), "finance.manage", "anything unreadable needs the stronger permission");
  assert.equal(await need("/api/credit-notes?id=CN-1&format=html"), "finance.view");
});

test("a rejection needs a reason, refunds nothing and lets the held payout go", async (t) => {
  const f = await refundWorld(t);
  await verifiedProvider(f, "PRV-G");
  await completedBooking(f, "BK-REJ");
  await payoutQueue.runProviderPayoutQueueSweep(f.db, { force: true });
  const asked = await callRefunds("POST", OPS, { action: "request", bookingId: "BK-REJ", percent: 40, reason: "Customer says the dog was stressed" });
  const requestId = asked.body.data.request.id;
  assert.equal((await callRefunds("POST", FINANCE, { action: "reject", requestId })).status, 400, "a reason is required");
  assert.equal((await callRefunds("POST", FINANCE, { action: "reject", requestId, reason: "too short" })).status, 400);
  const rejected = await callRefunds("POST", FINANCE, { action: "reject", requestId, reason: "CCTV shows the groom was completed calmly" });
  assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
  const row = f.row("SELECT status,decided_by,decision_reason FROM escalation_refund_requests WHERE id=?", requestId);
  assert.deepEqual(row, { status: "rejected", decided_by: FINANCE, decision_reason: "CCTV shows the groom was completed calmly" });
  assert.equal(auditCount(f, "escalation_refund.reject", requestId), 1);
  assert.equal(f.row("SELECT COUNT(*) n FROM booking_refund_cases").n, 0);
  assert.equal(f.refunds.length, 0);
  assert.equal((await callRefunds("POST", FINANCE_2, { action: "approve", requestId })).status, 409);
  const release = await payoutQueue.releaseProviderPayouts(f.db, { bookingIds: ["BK-REJ"], actor: FINANCE });
  assert.equal(release.released[0].amount, 700, "nothing refunded, nothing taken off the provider");
});

test("the printable credit note carries the Rule 53(1A) particulars and the refund reference", async (t) => {
  const f = await refundWorld(t);
  await completedBooking(f, "BK-PRINT");
  const { approved } = await refundAfterCompletion(f, "BK-PRINT", 20, { note: "Sorry about the wait" });
  const list = await creditNoteRoute.GET(asActor(FINANCE, "/api/credit-notes"));
  const listed = (await list.json()).data.creditNotes;
  assert.equal(listed.length, 1);
  const cn = listed[0];
  assert.equal(cn.snapshot_json, undefined, "the list does not carry the raw snapshot");
  assert.equal(cn.printPath, `/api/credit-notes?id=${encodeURIComponent(cn.id)}&format=html`);
  const printed = await creditNoteRoute.GET(asActor(FINANCE, cn.printPath));
  assert.equal(printed.status, 200);
  assert.match(printed.headers.get("content-type"), /^text\/html/);
  assert.match(printed.headers.get("content-security-policy"), /default-src 'none'/);
  const html = await printed.text();
  const dmy = (iso) => iso.split("-").reverse().join("-");
  for (const expected of [
    "<h1>Credit Note</h1>", "section 34 of the CGST Act, 2017 and Rule 53",
    SELLER.legalName, `GSTIN: <b>${SELLER_GSTIN}</b>`,
    `Credit note number: <b>${cn.credit_note_number}</b>`, `Date of issue: <b>${dmy(cn.issue_date)}</b>`,
    `Original invoice: <b>${invoiceNumber(COMPLETED, 1)}</b> dated ${dmy(istDate(COMPLETED))}`, "Place of supply: <b>Karnataka (29)</b>", "<td>998599</td>",
    "Customer BK-PRINT", "Unregistered recipient", "Taxable value reduced", "CGST @ 9% reduced", "SGST @ 9% reduced", "₹4.58", "₹4.57", "Total tax reduced", "₹9.15", "₹50.85",
    `Refund reference: rfnd_ESC1 / ${approved.refundCaseId}`, "₹140.00 of it was the service provider's charge", "Authorised signatory",
  ]) assert.ok(html.includes(expected), `the printed note shows ${expected}`);
  const json = await (await creditNoteRoute.GET(asActor(FINANCE, `/api/credit-notes?id=${encodeURIComponent(cn.credit_note_number)}`))).json();
  assert.deepEqual([json.data.id, json.data.snapshot.originalInvoice.number, json.data.snapshot_json], [cn.id, invoiceNumber(COMPLETED, 1), undefined]);
  assert.equal((await creditNoteRoute.GET(asActor(FINANCE, "/api/credit-notes?id=CN-NOPE"))).status, 404);
});

test("a closed month: no refund is raised or approved in it, and a note whose month closed meanwhile is issued in the next open month", async (t) => {
  const f = await refundWorld(t);
  await completedBooking(f, "BK-LOCK");
  const waiting = await escalation.requestEscalationRefund(f.db, { bookingId: "BK-LOCK", percent: 20, reason: "Customer escalation after the visit" }, actor(OPS, "admin"));
  f.sqlite.prepare("INSERT INTO finance_close_periods (period_code,status,checklist_json,locked_at,locked_by,updated_at) VALUES (?,'locked','{}',1,?,1)").run(REFUND_PERIOD, FINANCE);
  const approve = await callRefunds("POST", FINANCE, { action: "approve", requestId: waiting.request.id });
  assert.equal(approve.status, 409);
  assert.equal(approve.body.code, "period_locked");
  await completedBooking(f, "BK-LOCK-2");
  const ask = await callRefunds("POST", OPS, { action: "request", bookingId: "BK-LOCK-2", percent: 20, reason: "Customer escalation after the visit" });
  assert.equal(ask.status, 409);
  assert.equal(ask.body.code, "period_locked");
  assert.equal(f.refunds.length, 0);

  // Refund processed in a month that is closed by the time the note is issued: the note goes to the open month.
  f.sqlite.prepare("DELETE FROM finance_close_periods").run();
  const approved = await callRefunds("POST", FINANCE, { action: "approve", requestId: waiting.request.id });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const gatewayRefund = f.refunds[0];
  const processed = await reconciliation.processGatewayEvent(f.db, { provider: "razorpay", environment: "sandbox", eventId: `evt_${gatewayRefund.id}`, eventType: "refund.processed", bookingId: "BK-LOCK", gatewayPaymentId: gatewayRefund.payment_id, gatewayRefundId: gatewayRefund.id, amountSubunits: gatewayRefund.amount, currency: "INR", signatureVerified: true, payloadHash: "hash-refund-lock" });
  assert.equal(processed.status, "processed", JSON.stringify(processed));
  const lastMonth = Date.parse(`${COMPLETION_PERIOD}-28T12:00:00+05:30`);
  f.sqlite.prepare("UPDATE booking_lifecycle_events SET occurred_at=? WHERE booking_id='BK-LOCK' AND event_type='refund_processed'").run(lastMonth);
  f.sqlite.prepare("INSERT INTO finance_close_periods (period_code,status,checklist_json,locked_at,locked_by,updated_at) VALUES (?,'locked','{}',1,?,1)").run(COMPLETION_PERIOD, FINANCE);
  const run = await escalation.settleEscalationRefunds(f.db, { refundCaseIds: [`${waiting.request.id}-RF`] });
  assert.equal(run.settled, 1, JSON.stringify(run));
  const cn = note(f, "BK-LOCK");
  assert.deepEqual([cn.period_code, cn.issue_date], [REFUND_PERIOD, istDate(Date.now())], "never written into the closed month");
  assert.equal(f.row("SELECT moved_from_period FROM escalation_refund_settlements").moved_from_period, COMPLETION_PERIOD);
  assert.equal(f.row("SELECT COUNT(*) n FROM finance_journal_entries WHERE period_code=? AND source_type='escalation_credit_note'", COMPLETION_PERIOD).n, 0);
});

test("Section 34(2): past 30 November after the invoice's financial year no note is issued; the refund and the payout adjustment stand", async (t) => {
  const f = await refundWorld(t);
  await completedBooking(f, "BK-OLD");
  f.sqlite.prepare("UPDATE finance_invoices SET issue_date='2024-06-01' WHERE source_id='BK-OLD'").run();
  const { hook } = await refundAfterCompletion(f, "BK-OLD", 20);
  assert.equal(hook.escalationRefund.settled, 1, "the time limit is final, not a retry");
  const settlement = f.row("SELECT * FROM escalation_refund_settlements WHERE booking_id='BK-OLD'");
  assert.equal(settlement.credit_note_id, null);
  assert.match(settlement.credit_note_error, /^time_barred: a credit note against invoice TKP\/\d\d-\d\d\/00001 \(financial year 2024-25\) had to be declared by 2025-11-30/);
  assert.equal(settlement.provider_share, 140, "the provider's share is still taken off");
  assert.equal(note(f, "BK-OLD"), undefined);
  assert.equal(ledger(f, "2130-GST Payable", "BK-OLD"), 45.76, "PawSpace's output tax is not reduced");
  assert.equal(f.row("SELECT status FROM escalation_refund_requests WHERE booking_id='BK-OLD'").status, "processed");
});

test("no invoice series yet: the note waits, and once Finance issues the missing customer tax invoices the sweep writes it against them", async (t) => {
  // The seller has no invoice series, so completion could not issue the customer tax invoice (Rule 47 allows 30 days).
  const f = await refundWorld(t, { invoiceSeries: false });
  await completedBooking(f, "BK-LATE", { completedAt: SAME_MONTH_COMPLETED });
  assert.equal(f.row("SELECT COUNT(*) n FROM finance_invoices").n, 0, "nothing was invoiced at completion");
  const position = await escalation.escalationRefundPosition(f.db, { bookingId: "BK-LATE", percent: 20 });
  assert.equal(position.preview.creditNote.pendingInvoice, true, "the approver is told the note follows the invoice");
  const { hook } = await refundAfterCompletion(f, "BK-LATE", 20);
  assert.equal(hook.escalationRefund.pending, 1);
  const pending = f.row("SELECT * FROM escalation_refund_settlements WHERE booking_id='BK-LATE'");
  assert.equal(pending.status, "pending");
  assert.match(pending.last_error, /configuration_required:credit_note_original_invoice/);
  assert.equal(pending.payout_stage, "before_queue", "the payout and TCS steps did not wait for the invoice");
  assert.equal(f.row("SELECT status FROM escalation_refund_requests WHERE booking_id='BK-LATE'").status, "approved");

  // Finance sets the series and issues the missing invoices (lib/booking-tax-invoice.ts); the note follows on the next sweep.
  addInvoiceSeries(f.sqlite);
  const backfill = await bookingInvoices.issueMissingBookingInvoices(f.db, { actorId: FINANCE, reason: "Invoice series set up after the month's completions" });
  assert.deepEqual(backfill.issued.map((o) => [o.bookingId, o.invoiceNumber]), [["BK-LATE", invoiceNumber(SAME_MONTH_COMPLETED, 1)]]);
  const early = await refundSweep.runAutomaticBookingRefundSweep(f.db, ENV, {});
  assert.equal(early.escalationSettlements.examined, 0, "retried on its hourly schedule, not on every run");
  const later = await refundSweep.runAutomaticBookingRefundSweep(f.db, ENV, { asOf: Date.now() + 2 * 60 * 60_000 });
  assert.equal(later.escalationSettlements.settled, 1, JSON.stringify(later.escalationSettlements));
  const cn = note(f, "BK-LATE");
  assert.deepEqual([cn.original_invoice_kind, cn.original_invoice_number, cn.original_invoice_date, cn.taxable_value, cn.tax_total, cn.sac], ["finance_invoice", invoiceNumber(SAME_MONTH_COMPLETED, 1), istDate(SAME_MONTH_COMPLETED), 50.85, 9.15, "998599"]);
  const snapshot = JSON.parse(cn.snapshot_json);
  assert.deepEqual([snapshot.customer.name, snapshot.seller.legalName, snapshot.placeOfSupply.code], ["Customer BK-LATE", SELLER.legalName, "29"], "the recipient, seller and place of supply as the invoice printed them");
  assert.equal(f.row("SELECT status FROM escalation_refund_requests WHERE booking_id='BK-LATE'").status, "processed");
  assert.equal(f.row("SELECT COUNT(*) n FROM communication_messages WHERE booking_id='BK-LATE' AND template_key='escalation_refund_processed'").n, 1, "the customer is told once");
});

test("with no customer tax invoice, the booking's own service invoice is the original invoice", async (t) => {
  const f = await refundWorld(t, { invoiceSeries: false });
  await completedBooking(f, "BK-VERT", { verticalInvoice: true });
  await refundAfterCompletion(f, "BK-VERT", 20);
  const cn = note(f, "BK-VERT");
  assert.deepEqual([cn.original_invoice_kind, cn.original_invoice_number, cn.original_invoice_date, cn.taxable_value, cn.tax_total, cn.gstr1_section, cn.sac], ["booking_invoice", "INV/BK-VERT", istDate(COMPLETED), 50.85, 9.15, "b2cs", "998599"], "the vertical's invoice, the SAC the returns file the commission under");
  assert.equal(JSON.parse(cn.snapshot_json).seller.legalName, SELLER.legalName, "the seller from the active tax policy");
});

test("owner decision, 27 Sept 2026: a booking completed before the 26 Sept 2026 model is allowed with a manual note, no credit note", async (t) => {
  const f = await refundWorld(t);
  await completedBooking(f, "BK-LEGACY");
  // The code's own gate is not a date check: it is the presence or absence of a completion tax record
  // (payoutRecordForCreditNote). completedAt here is the suite's usual relative fixture date, not literally
  // before 26 Sept 2026; deleting the record below is what actually puts this booking on the legacy path.
  // Simulate a booking that predates the 26 Sept 2026 model: it has no completion tax record at all.
  f.sqlite.prepare("DELETE FROM provider_payout_computations WHERE booking_id='BK-LEGACY'").run();

  const preview = await callRefunds("GET", OPS, {}, "?bookingId=BK-LEGACY&percent=20");
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.data.position.legacyModel, true);
  assert.equal(preview.body.data.position.preview.creditNote, null);
  assert.equal(preview.body.data.position.refusal, null, "no longer refused outright");

  const withoutNote = await callRefunds("POST", OPS, { action: "request", bookingId: "BK-LEGACY", percent: 20, reason: "Customer escalation after the visit" });
  assert.equal(withoutNote.status, 400);
  assert.match(withoutNote.body.error, /pre-26-Sept-2026 model/);
  assert.match(withoutNote.body.error, /manual note/);

  const tooShortNote = await callRefunds("POST", OPS, { action: "request", bookingId: "BK-LEGACY", percent: 20, reason: "Customer escalation after the visit", manualNote: "too short" });
  assert.equal(tooShortNote.status, 400);

  const asked = await callRefunds("POST", OPS, { action: "request", bookingId: "BK-LEGACY", percent: 20, reason: "Customer escalation after the visit", manualNote: "Approved by hand: no TK Petcare invoice exists for this older booking." });
  assert.equal(asked.status, 201, JSON.stringify(asked.body));
  const approved = await callRefunds("POST", FINANCE, { action: "approve", requestId: asked.body.data.request.id });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const gatewayRefund = f.refunds.find((refund) => refund.notes?.booking_id === "BK-LEGACY");
  assert.ok(gatewayRefund, "a sandbox refund was sent for the legacy booking");
  const hook = await refundProcessedWebhook(f, "BK-LEGACY", gatewayRefund);
  assert.equal(hook.status, 200, JSON.stringify(hook.body));

  assert.equal(note(f, "BK-LEGACY"), undefined, "no credit note is ever issued for this booking");
  const settlement = f.row("SELECT * FROM escalation_refund_settlements WHERE booking_id='BK-LEGACY'");
  assert.equal(settlement.status, "settled");
  assert.equal(settlement.credit_note_id, null);
  assert.match(settlement.credit_note_error, /^legacy_model:/);
  assert.match(settlement.credit_note_error, /manual note/);
  assert.equal(f.row("SELECT status FROM escalation_refund_requests WHERE booking_id='BK-LEGACY'").status, "processed");
  assert.equal(f.row("SELECT legacy_manual_note FROM escalation_refund_requests WHERE booking_id='BK-LEGACY'").legacy_manual_note, "Approved by hand: no TK Petcare invoice exists for this older booking.");
});
