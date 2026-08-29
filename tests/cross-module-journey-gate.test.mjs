import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";

// ---------------------------------------------------------------------------
// Task 24 — cross-module end-to-end journey gate (the release gate).
//
// Each journey walks one service from lead through booking, money, fulfilment,
// invoice/GST, loyalty and review, and then asserts that EVERY reporting surface
// tells the same story about it: the P&L, the company analytics dashboard, the
// customer 360 record and the customer's own ledgers must agree to the rupee.
// Disagreement between two modules about the same booking is a release blocker.
//
// Honest scope, stated rather than implied: bookings and gateway captures are
// written directly here (creating them through the HTTP routes needs the whole
// Worker runtime, which the route-level suites cover). Every step AFTER that -
// attribution, invoicing, loyalty, reviews, split-payment capture, reporting -
// runs the real production module against the same database, which is where
// cross-module disagreements actually live. Payment capture is a SIMULATED
// sandbox webhook, never a live gateway call.
// ---------------------------------------------------------------------------
const WORKERS_SHIM = `export const env = new Proxy({}, { get: (_, key) => globalThis.__PAWSPACE_TEST_ENV?.[key] });`;
const workersUrl = `data:text/javascript,${encodeURIComponent(WORKERS_SHIM)}`;

if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true };
      try { return nextResolve(specifier, context); }
      catch (error) {
        if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context);
        throw error;
      }
    },
  });
} else {
  const hook = `const workersUrl=${JSON.stringify(workersUrl)};
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true };
    try { return await nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(specifier + ".ts", context);
      throw error;
    }
  }`;
  nodeModule.register(new URL(`data:text/javascript,${encodeURIComponent(hook)}`));
}

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function makeD1(sqlite) {
  function statement(sql, args) {
    return {
      bind: (...bound) => statement(sql, bound),
      first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
      // rows_written mirrors D1's meta so modules that check it (e.g. the invoice
      // race guard) behave here exactly as they do in production.
      run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes), rows_written: Number(info.changes) } }; },
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    };
  }
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (list) => { const out = []; for (const item of list) out.push(await item.run()); return out; },
    exec: async (sql) => { sqlite.exec(sql); },
  };
}

function applyOwnedDdl(sqlite, path) {
  const source = read(path);
  for (const match of source.matchAll(/\.prepare\(\s*(["'`])([\s\S]*?)\1/g)) {
    if (/^\s*CREATE (TABLE|INDEX|UNIQUE INDEX)/i.test(match[2])) { try { sqlite.exec(match[2]); } catch { /* index for a table this journey does not touch */ } }
  }
}

const NOW = Date.parse("2026-07-10T04:00:00.000Z");
const OPS = "ops.one@pawspace.in";
const OPS_TWO = "ops.two@pawspace.in";
const PERIOD = { from: "2026-07-01", to: "2026-08-01", month: "2026-07" };

// --- The world every journey shares ------------------------------------------
function world() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PAWSPACE_TEST_ENV = { DB: db };
  sqlite.exec("CREATE TABLE canonical_customers (id TEXT PRIMARY KEY,city_id TEXT,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT,consent_json TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE canonical_pets (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,name TEXT NOT NULL,species TEXT,breed TEXT,vaccination_status TEXT,source_pet_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT UNIQUE,customer_id TEXT NOT NULL,pet_ids_json TEXT,source_pet_ids_json TEXT,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,service_code TEXT NOT NULL,package_code TEXT,package_name TEXT,schedule_group_id TEXT,provider_id TEXT,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL,channel TEXT,total_amount REAL NOT NULL,currency TEXT DEFAULT 'INR',pricing_json TEXT,created_by TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,amount REAL NOT NULL,amount_due_now REAL NOT NULL,currency TEXT DEFAULT 'INR',method TEXT,mode TEXT,status TEXT NOT NULL,gateway TEXT,idempotency_key TEXT UNIQUE,detail_json TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE crm_contacts (id TEXT PRIMARY KEY,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,area TEXT,pet_names TEXT,pet_summary TEXT,stage TEXT NOT NULL DEFAULT 'New lead',owner TEXT DEFAULT 'Unassigned',source TEXT DEFAULT 'Website',lifetime_value REAL DEFAULT 0,next_action TEXT,opportunity TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE provider_capacity_profiles (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,provider_model TEXT NOT NULL,services_json TEXT NOT NULL,zones_json TEXT NOT NULL,live INTEGER NOT NULL DEFAULT 1,rating REAL DEFAULT 0,quality_score REAL DEFAULT 0,capacity INTEGER DEFAULT 1,travel_buffer_minutes INTEGER DEFAULT 30,max_daily_jobs INTEGER DEFAULT 6,acceptance_timeout_minutes INTEGER DEFAULT 3,status TEXT NOT NULL DEFAULT 'active',version INTEGER DEFAULT 1,effective_from TEXT,effective_to TEXT,updated_by TEXT,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE customer_experience_tickets (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,booking_id TEXT,lead_id TEXT,category TEXT NOT NULL,priority TEXT NOT NULL,subject TEXT NOT NULL,detail TEXT NOT NULL,owner TEXT NOT NULL,manager TEXT NOT NULL,sla_due_at INTEGER NOT NULL,status TEXT NOT NULL,escalation_level INTEGER DEFAULT 0,customer_status TEXT NOT NULL,resolution TEXT,resolution_evidence TEXT,root_cause TEXT,reopened_count INTEGER DEFAULT 0,resolved_at INTEGER,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  applyOwnedDdl(sqlite, "lib/people-foundation.ts");
  return { sqlite, db };
}

function seedCustomer(sqlite, { customerId, name, phone, email, area = "Bengaluru East" }) {
  sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,secondary_phone,email,source,consent_json,created_at,updated_at) VALUES (?,?,?,?,NULL,?,'customer_app','{}',?,?)")
    .run(customerId, "blr", name, phone, email, NOW, NOW);
  sqlite.prepare("INSERT INTO crm_contacts (id,name,primary_phone,email,area,stage,owner,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(customerId, name, phone, email, area, "New lead", "Unassigned", "Website", NOW, NOW);
  sqlite.prepare("INSERT INTO canonical_pets (id,customer_id,name,species,breed,vaccination_status,source_pet_id,created_at,updated_at) VALUES (?,?,?,?,?,?,NULL,?,?)")
    .run(`PET-${customerId}`, customerId, "Bruno", "dog", "Indie", "verified", NOW, NOW);
}

// Booking creation: written directly (see the honest-scope note at the top).
function createBooking(sqlite, { bookingId, customerId, serviceCode, amount, start, end, status = "confirmed", providerId = "PROV-1" }) {
  sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(bookingId, `ik-${bookingId}`, customerId, JSON.stringify([`PET-${customerId}`]), "[]", "blr", "blr-east", serviceCode, "pkg", "Package", `grp-${bookingId}`, providerId, start, end, status, "customer_app", amount, "INR", "{}", "customer", NOW, NOW);
}
// SIMULATED sandbox gateway webhook - no live gateway is contacted anywhere in this suite.
function simulateCapture(sqlite, { bookingId, customerId, amount, dueNow = amount, status = "captured" }) {
  sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,currency,method,mode,status,gateway,idempotency_key,detail_json,created_at,updated_at) VALUES (?,?,?,?,?,'INR','upi','prepaid',?,'uat_sandbox',?,?,?,?)")
    .run(`PAY-${bookingId}`, bookingId, customerId, amount, dueNow, status, `pay-${bookingId}`, JSON.stringify({ simulatedWebhook: true, liveMoney: false }), NOW, NOW);
}
function completeBooking(sqlite, bookingId) {
  sqlite.prepare("UPDATE canonical_bookings SET status='completed',updated_at=? WHERE id=?").run(NOW + 3600000, bookingId);
}

// ---------------------------------------------------------------------------
// Journey 1 — Grooming: lead -> booking -> capture -> conversion -> invoice/GST
//             -> loyalty -> review request -> every report agrees.
// ---------------------------------------------------------------------------
test("journey: grooming from lead to reports, with every surface agreeing on the same rupees", async () => {
  const { sqlite, db } = world();
  const attribution = await import("../lib/lead-conversion-attribution.ts");
  const invoices = await import("../lib/grooming-invoice.ts");
  const points = await import("../lib/paw-points-governance.ts");
  const reviewConfig = await import("../lib/review-configuration-governance.ts");
  const reviews = await import("../lib/service-review-governance.ts");
  const analytics = await import("../lib/company-analytics.ts");
  const pnl = await import("../lib/pnl-reporting.ts");
  const customer360 = await import("../lib/customer-360.ts");

  // 1. A real inbound lead exists before any booking.
  seedCustomer(sqlite, { customerId: "CUS-J1", name: "Asha Verma", phone: "9876511001", email: "asha@example.test" });
  await attribution.ensureLeadWorkItemsTable(db);
  sqlite.prepare("INSERT INTO lead_work_items (id,customer_id,source,service,owner,manager,status,stage,work_day,assigned_at,first_action_due_at,manager_alert_at,call_attempts,whatsapp_attempts,recycle_cycle,opt_out,created_at,updated_at) VALUES (?,?,?,?,?,?,'active','day_1',1,?,?,?,0,0,0,0,?,?)")
    .run("LEAD-J1", "CUS-J1", "Website", "grooming", "Unassigned", "Sales Manager", NOW, NOW + 600000, NOW + 1800000, NOW, NOW);

  // 2. Booking, then the SIMULATED sandbox capture.
  createBooking(sqlite, { bookingId: "BK-J1", customerId: "CUS-J1", serviceCode: "grooming", amount: 1349, start: "2026-07-10T05:00:00.000Z", end: "2026-07-10T06:30:00.000Z" });
  const linked = await attribution.attributeBookingToOpenLead(db, { customerId: "CUS-J1", bookingId: "BK-J1" });
  assert.equal(linked.converted, false, "an unpaid booking does not yet convert the lead");
  simulateCapture(sqlite, { bookingId: "BK-J1", customerId: "CUS-J1", amount: 1349 });
  const converted = await attribution.convertLeadOnPaymentCaptured(db, { customerId: "CUS-J1", bookingId: "BK-J1" });
  assert.equal(converted.leadId, "LEAD-J1");
  assert.equal(sqlite.prepare("SELECT status,converted_booking_id FROM lead_work_items WHERE id='LEAD-J1'").get().converted_booking_id, "BK-J1");

  // 3. Fulfilment, then the invoice - which is blocked until a real tax policy exists.
  completeBooking(sqlite, "BK-J1");
  await assert.rejects(() => invoices.issueGroomingInvoice(db, { bookingId: "BK-J1", reason: "Issuing the July grooming invoice" }), (error) => error instanceof Response && error.status === 409);
  await invoices.saveGroomingTaxPolicy(db, { cityId: "blr", taxMode: "inclusive", taxRate: 18, effectiveFrom: "2026-04-01", actorId: OPS, reason: "FY26-27 published GST policy for Bengaluru" });
  const invoice = await invoices.issueGroomingInvoice(db, { bookingId: "BK-J1", reason: "Issuing the July grooming invoice", actorId: OPS });
  // Inclusive 18% of Rs.1,349: taxable 1143.22, GST 205.78, customer still pays 1349.
  assert.equal(invoice.grossAmount, 1349);
  assert.equal(invoice.taxAmount, 205.78);
  assert.equal(invoice.netAmount, 1349, "an inclusive policy never inflates what the customer pays");
  assert.match(invoice.invoiceNumber, /^GRM-BLR-26-27-000001$/);
  assert.equal(invoice.liveTaxFiling, false, "the invoice is honest that nothing was filed with the tax authority");
  const replayInvoice = await invoices.issueGroomingInvoice(db, { bookingId: "BK-J1", reason: "Retrying the same invoice issue", actorId: OPS });
  assert.equal(replayInvoice.duplicatePrevented, true);
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM booking_invoices WHERE booking_id='BK-J1'").get().c, 1, "one booking, one invoice number");

  // 4. Loyalty and the review request both come off the same completed booking.
  const earn = await points.runPawPointsEarnSweep(db, {});
  assert.equal(earn.bookingsCredited, 1);
  assert.equal(await points.pawPointsBalance(db, "CUS-J1"), 134, "1 point per Rs.10 of the real booking value");
  const draft = await reviewConfig.saveReviewConfig(db, { serviceCode: "grooming", questions: [{ text: "How was the groomer?" }], triggerType: "every_service", channels: ["notification"] }, OPS);
  await reviewConfig.approveReviewConfig(db, { id: draft.id, approvalReference: "OPS-2026-07", actor: OPS_TWO });
  const sweep = await reviews.runServiceReviewSweep(db, { asOf: NOW });
  assert.equal(sweep.requested, 1, "the completed booking is asked for a review exactly once");

  // 5. THE GATE: every reporting surface must agree about this one booking.
  const dashboard = await analytics.buildCompanyAnalytics(db, { from: PERIOD.from, to: PERIOD.to });
  const report = await pnl.generatePnlReport(db, { fromMonth: PERIOD.month, toMonth: PERIOD.month });
  const record = (await customer360.buildCustomer360(db, "CUS-J1"))[0];
  assert.equal(dashboard.money.gmv, 1349, "analytics GMV is the booking value");
  assert.equal(dashboard.money.collected, 1349, "collected matches the captured payment");
  assert.equal(report.totalTurnoverAmount, 1349, "the P&L recognizes the same rupees");
  assert.equal(dashboard.money.gmv, report.totalTurnoverAmount, "dashboard and P&L must never disagree");
  assert.equal(record.lifetimeValue, 1349, "the customer's own 360 record agrees too");
  assert.equal(record.bookings.length, 1);
  assert.equal(record.bookings[0].status, "completed");
  assert.equal(dashboard.services.grooming.completed, 1);
  assert.equal(dashboard.bookings.completionRate, 1);
});

// ---------------------------------------------------------------------------
// Journey 2 — Boarding with the founder's 50/50 split: deposit at confirmation,
//             balance 24h before check-in, and reports counting the FULL stay.
// ---------------------------------------------------------------------------
test("journey: boarding 50/50 split pays a deposit then the balance, and reports the full stay once", async () => {
  const { sqlite, db } = world();
  const split = await import("../lib/stay-split-payments.ts");
  const analytics = await import("../lib/company-analytics.ts");
  const pnl = await import("../lib/pnl-reporting.ts");
  const customer360 = await import("../lib/customer-360.ts");

  seedCustomer(sqlite, { customerId: "CUS-J2", name: "Rohit Menon", phone: "9876511002", email: "rohit@example.test" });
  const checkIn = "2026-07-20T06:00:00.000Z", checkOut = "2026-07-25T06:00:00.000Z", total = 6990;

  // A stay starting within 24h cannot be split - it must be paid in full.
  assert.throws(() => split.splitPaymentPlan({ totalAmount: total, scheduledStart: "2026-07-10T10:00:00.000Z", now: NOW }), (error) => error instanceof Response && error.status === 409);

  const plan = split.splitPaymentPlan({ totalAmount: total, scheduledStart: checkIn, now: NOW });
  assert.equal(plan.dueNow, 3495, "half at confirmation");
  assert.equal(plan.balance, 3495);
  assert.equal(plan.dueNow + plan.balance, total, "the split never changes the price");
  assert.equal(plan.balanceDueAt, Date.parse(checkIn) - 24 * 3600000, "the balance falls due 24 hours before check-in");

  createBooking(sqlite, { bookingId: "BK-J2", customerId: "CUS-J2", serviceCode: "boarding", amount: total, start: checkIn, end: checkOut });
  simulateCapture(sqlite, { bookingId: "BK-J2", customerId: "CUS-J2", amount: plan.dueNow, dueNow: plan.dueNow });
  await split.ensureStayPaymentTables(db);
  await split.staySplitScheduleStatement(db, { bookingId: "BK-J2", serviceCode: "boarding", customerId: "CUS-J2", totalAmount: total, paidNowAmount: plan.dueNow, balanceAmount: plan.balance, balanceDueAt: plan.balanceDueAt }).run();

  const pending = await split.getStayPaymentSchedule(db, "BK-J2");
  assert.equal(pending.status, "pending_balance");
  assert.equal(pending.balanceAmount, 3495);

  // The overdue sweep leaves a not-yet-due balance alone, and flags it once past due.
  assert.equal((await split.sweepOverdueStayBalances(db, NOW)).marked, 0);
  const overdue = await split.sweepOverdueStayBalances(db, plan.balanceDueAt + 60000);
  assert.equal(overdue.marked, 1);
  assert.equal((await split.sweepOverdueStayBalances(db, plan.balanceDueAt + 120000)).marked, 0, "an already-overdue balance is not re-flagged every sweep");

  // Capturing the balance is idempotent, and a replay never takes the money twice.
  const paid = await split.payStayBalance(db, { bookingId: "BK-J2", actorId: "CUS-J2", idempotencyKey: "bal-j2" });
  assert.equal(paid.schedule.status, "paid");
  assert.equal(paid.duplicatePrevented, false);
  const replay = await split.payStayBalance(db, { bookingId: "BK-J2", actorId: "CUS-J2", idempotencyKey: "bal-j2" });
  assert.equal(replay.duplicatePrevented, true);
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM stay_payment_events WHERE booking_id='BK-J2' AND event_type='balance_captured'").get().c, 1);

  completeBooking(sqlite, "BK-J2");
  const dashboard = await analytics.buildCompanyAnalytics(db, { from: PERIOD.from, to: PERIOD.to });
  const report = await pnl.generatePnlReport(db, { fromMonth: PERIOD.month, toMonth: PERIOD.month });
  const record = (await customer360.buildCustomer360(db, "CUS-J2"))[0];
  assert.equal(dashboard.money.gmv, total, "the stay is recognized once at its full value, not twice and not half");
  assert.equal(report.totalTurnoverAmount, total);
  assert.equal(record.lifetimeValue, total);
  // The booking_payments row holds the deposit and the governed split schedule proves the balance
  // capture. Analytics must reconcile both sources so the paid stay is not under-reported as half paid.
  assert.equal(dashboard.money.collected, total);
  const schedule = await split.getStayPaymentSchedule(db, "BK-J2");
  assert.equal(schedule.paidNowAmount + schedule.balanceAmount, total, "deposit plus balance is the whole price");
  assert.ok(schedule.paymentRef?.startsWith("SBX-BAL-"), "the capture reference is honestly labelled sandbox");
});

// ---------------------------------------------------------------------------
// Journey 3 — A cancelled booking: visible as a cancellation everywhere, and
//             revenue nowhere. This is the bug class the Task-17 fix closed.
// ---------------------------------------------------------------------------
test("journey: a cancelled booking is counted as a cancellation and as revenue by nobody", async () => {
  const { sqlite, db } = world();
  const analytics = await import("../lib/company-analytics.ts");
  const pnl = await import("../lib/pnl-reporting.ts");
  const customer360 = await import("../lib/customer-360.ts");
  const points = await import("../lib/paw-points-governance.ts");

  seedCustomer(sqlite, { customerId: "CUS-J3", name: "Neha Shah", phone: "9876511003", email: "neha@example.test" });
  createBooking(sqlite, { bookingId: "BK-J3-DONE", customerId: "CUS-J3", serviceCode: "dog_walking", amount: 800, start: "2026-07-12T05:00:00.000Z", end: "2026-07-12T05:45:00.000Z", status: "completed" });
  simulateCapture(sqlite, { bookingId: "BK-J3-DONE", customerId: "CUS-J3", amount: 800 });
  createBooking(sqlite, { bookingId: "BK-J3-CANCELLED", customerId: "CUS-J3", serviceCode: "dog_walking", amount: 2400, start: "2026-07-14T05:00:00.000Z", end: "2026-07-14T05:45:00.000Z", status: "cancelled" });
  simulateCapture(sqlite, { bookingId: "BK-J3-CANCELLED", customerId: "CUS-J3", amount: 2400, status: "refunded" });

  const dashboard = await analytics.buildCompanyAnalytics(db, { from: PERIOD.from, to: PERIOD.to });
  const report = await pnl.generatePnlReport(db, { fromMonth: PERIOD.month, toMonth: PERIOD.month });
  const record = (await customer360.buildCustomer360(db, "CUS-J3"))[0];

  assert.equal(dashboard.bookings.total, 2);
  assert.equal(dashboard.bookings.cancelled, 1, "the cancellation is visible to Ops");
  assert.equal(dashboard.bookings.cancellationRate, 0.5);
  assert.equal(dashboard.money.gmv, 800, "the cancelled Rs.2,400 is not GMV");
  assert.equal(dashboard.money.collected, 800, "a refunded payment is not collected money");
  assert.equal(report.totalTurnoverAmount, 800, "the P&L recognizes only the completed walk");
  assert.equal(dashboard.money.gmv, report.totalTurnoverAmount);
  assert.equal(record.lifetimeValue, 800, "the customer's lifetime value excludes the cancelled booking");
  assert.equal(dashboard.services.dog_walking.cancelled, 1);
  assert.equal(dashboard.services.dog_walking.gmv, 800);

  // Loyalty follows the same rule: no points for work that never happened.
  const earn = await points.runPawPointsEarnSweep(db, {});
  assert.equal(earn.bookingsCredited, 1);
  assert.equal(await points.pawPointsBalance(db, "CUS-J3"), 80, "only the completed Rs.800 walk earned points");
});

// ---------------------------------------------------------------------------
// Journey 4 — The whole book: several services, several customers, one truth.
// ---------------------------------------------------------------------------
test("release gate: across every service, P&L turnover === analytics GMV === the sum of recognized bookings", async () => {
  const { sqlite, db } = world();
  const analytics = await import("../lib/company-analytics.ts");
  const pnl = await import("../lib/pnl-reporting.ts");
  const customer360 = await import("../lib/customer-360.ts");

  // One journey per live service, plus the states that must NOT be revenue.
  const journeys = [
    { id: "BK-M-GROOM", service: "grooming", amount: 1349, status: "completed" },
    { id: "BK-M-BOARD", service: "boarding", amount: 6990, status: "completed" },
    { id: "BK-M-SIT", service: "pet_sitting", amount: 3200, status: "completed" },
    { id: "BK-M-TRAIN", service: "dog_training", amount: 12000, status: "confirmed" },
    { id: "BK-M-WALK", service: "dog_walking", amount: 2400, status: "completed" },
    { id: "BK-M-TAXI", service: "pet_taxi", amount: 899, status: "completed" },
    { id: "BK-M-RELO", service: "relocation", amount: 45000, status: "confirmed" },
    { id: "BK-M-FUNERAL", service: "funeral_memorial", amount: 7500, status: "completed" },
    { id: "BK-M-CANCELLED", service: "grooming", amount: 1349, status: "cancelled" },
    { id: "BK-M-DRAFT", service: "boarding", amount: 5000, status: "draft" },
  ];
  journeys.forEach((journey, index) => {
    const customerId = `CUS-M-${index}`;
    seedCustomer(sqlite, { customerId, name: `Customer ${index}`, phone: `98765220${String(index).padStart(2, "0")}`, email: `m${index}@example.test` });
    const day = String(5 + index).padStart(2, "0");
    createBooking(sqlite, { bookingId: journey.id, customerId, serviceCode: journey.service, amount: journey.amount, start: `2026-07-${day}T05:00:00.000Z`, end: `2026-07-${day}T07:00:00.000Z`, status: journey.status });
    if (journey.status === "completed" || journey.status === "confirmed") simulateCapture(sqlite, { bookingId: journey.id, customerId, amount: journey.amount });
  });

  const recognized = journeys.filter((journey) => !["cancelled", "draft"].includes(journey.status));
  const expectedRevenue = recognized.reduce((sum, journey) => sum + journey.amount, 0);

  const dashboard = await analytics.buildCompanyAnalytics(db, { from: PERIOD.from, to: PERIOD.to });
  const report = await pnl.generatePnlReport(db, { fromMonth: PERIOD.month, toMonth: PERIOD.month });

  assert.equal(dashboard.money.gmv, expectedRevenue, `analytics GMV must equal the recognized book (${expectedRevenue})`);
  assert.equal(report.totalTurnoverAmount, expectedRevenue, "the P&L must equal the same recognized book");
  assert.equal(dashboard.money.gmv, report.totalTurnoverAmount, "RELEASE BLOCKER if these two ever disagree");
  assert.equal(dashboard.bookings.total, journeys.length, "every booking is still counted operationally");
  assert.equal(dashboard.bookings.cancelled, 1);

  // Per-service agreement, not just the total: each vertical's GMV must match its own recognized rows.
  const perService = new Map();
  for (const journey of recognized) perService.set(journey.service, (perService.get(journey.service) || 0) + journey.amount);
  for (const [service, amount] of perService) {
    assert.equal(dashboard.services[service].gmv, amount, `${service} GMV disagrees with its recognized bookings`);
  }
  // Grooming had one completed and one cancelled booking of the same value: exactly the shape that
  // used to double-count.
  assert.equal(dashboard.services.grooming.bookings, 2);
  assert.equal(dashboard.services.grooming.gmv, 1349);

  // Each customer's 360 view agrees with their own slice of the book, using the SAME recognition
  // rule as the money reports: cancelled and draft bookings are not lifetime value.
  let lifetimeValueTotal = 0;
  for (const [index, journey] of journeys.entries()) {
    const record = (await customer360.buildCustomer360(db, `CUS-M-${index}`))[0];
    const expected = ["cancelled", "draft"].includes(journey.status) ? 0 : journey.amount;
    assert.equal(record.lifetimeValue, expected, `${journey.id} disagrees between the book and the customer record`);
    lifetimeValueTotal += record.lifetimeValue;
  }
  assert.equal(lifetimeValueTotal, expectedRevenue, "the sum of every customer record equals the recognized book");

  // Every unconnected source is still declared honestly on the same dashboard.
  assert.equal(dashboard.sourceStatus.marketingSpend, "not_connected");
  assert.equal(dashboard.money.refundsStatus, "booking_refund_cases_processing_processed_completed");
  assert.equal(report.dataSource, "platform_live");
});

// ---------------------------------------------------------------------------
// Journey 5 — Ops truth: a support ticket raised against a booking reaches the
//             dashboard and the customer record without inflating money.
// ---------------------------------------------------------------------------
test("journey: a service complaint shows up in CX metrics and the customer record, and changes no money", async () => {
  const { sqlite, db } = world();
  const analytics = await import("../lib/company-analytics.ts");
  const pnl = await import("../lib/pnl-reporting.ts");
  const customer360 = await import("../lib/customer-360.ts");

  seedCustomer(sqlite, { customerId: "CUS-J5", name: "Kiran Rao", phone: "9876511005", email: "kiran@example.test" });
  createBooking(sqlite, { bookingId: "BK-J5", customerId: "CUS-J5", serviceCode: "grooming", amount: 1800, start: "2026-07-16T05:00:00.000Z", end: "2026-07-16T06:00:00.000Z", status: "completed" });
  simulateCapture(sqlite, { bookingId: "BK-J5", customerId: "CUS-J5", amount: 1800 });
  sqlite.prepare("INSERT INTO customer_experience_tickets (id,customer_id,booking_id,category,priority,subject,detail,owner,manager,sla_due_at,status,customer_status,reopened_count,resolved_at,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("TKT-J5", "CUS-J5", "BK-J5", "Service quality", "high", "Groomer was late", "Arrived 40 minutes late", "CX Desk", "Sales Manager", NOW + 3600000, "open", "We are looking into it", 0, null, OPS, NOW, NOW);

  const dashboard = await analytics.buildCompanyAnalytics(db, { from: PERIOD.from, to: PERIOD.to });
  const report = await pnl.generatePnlReport(db, { fromMonth: PERIOD.month, toMonth: PERIOD.month });
  const record = (await customer360.buildCustomer360(db, "CUS-J5"))[0];

  assert.equal(dashboard.cx.tickets, 1);
  assert.equal(dashboard.cx.open, 1);
  assert.equal(dashboard.cx.averageResolutionMs, null, "an unresolved ticket has no invented resolution time");
  assert.equal(record.openTicketCount, 1);
  assert.equal(record.tickets[0].subject, "Groomer was late");
  assert.equal(dashboard.money.gmv, 1800, "a complaint does not change the money");
  assert.equal(report.totalTurnoverAmount, 1800);
  assert.equal(record.lifetimeValue, 1800);
});

// ---------------------------------------------------------------------------
// Journey 6 — Data-quality honesty: gaps are reported as gaps, not zeros.
// ---------------------------------------------------------------------------
test("journey: missing payment and provider data is reported as a gap rather than silently zeroed", async () => {
  const { sqlite, db } = world();
  const analytics = await import("../lib/company-analytics.ts");

  seedCustomer(sqlite, { customerId: "CUS-J6", name: "Data Gap", phone: "9876511006", email: "gap@example.test" });
  createBooking(sqlite, { bookingId: "BK-J6-NOPAY", customerId: "CUS-J6", serviceCode: "grooming", amount: 1349, start: "2026-07-18T05:00:00.000Z", end: "2026-07-18T06:00:00.000Z", status: "completed" });
  createBooking(sqlite, { bookingId: "BK-J6-NOPROV", customerId: "CUS-J6", serviceCode: "grooming", amount: 1000, start: "2026-07-19T05:00:00.000Z", end: "2026-07-19T06:00:00.000Z", status: "completed", providerId: "" });
  simulateCapture(sqlite, { bookingId: "BK-J6-NOPROV", customerId: "CUS-J6", amount: 1000 });

  const dashboard = await analytics.buildCompanyAnalytics(db, { from: PERIOD.from, to: PERIOD.to });
  assert.equal(dashboard.dataQuality.paymentsMissing, 1, "the booking with no payment row is named as a gap");
  assert.equal(dashboard.dataQuality.bookingsMissingProvider, 1);
  assert.equal(dashboard.money.gmv, 2349, "GMV still reflects the real booked value");
  assert.equal(dashboard.money.collected, 1000, "collected only counts money that actually arrived");
  // Boarding/sitting cost tracking has no settlement rows here, so margin must stay unknown.
  assert.equal(dashboard.services.grooming.costAmount, null);
  assert.equal(dashboard.services.grooming.marginPct, null, "margin is never guessed from a partial cost picture");
  assert.equal(dashboard.services.grooming.costTracked, true, "grooming cost IS trackable - it is simply not known yet here");
});
