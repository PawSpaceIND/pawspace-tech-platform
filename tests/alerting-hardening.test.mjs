import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";
import { createD1 } from "./helpers/d1.mjs";

// Test-only resolve hooks: "cloudflare:workers" resolves to a stub whose env.DB is the current
// per-test SQLite-backed D1 shim; extensionless relative imports fall back to .ts. The REAL route
// handlers, scheduler and libs execute unmodified against a real SQL engine.
const CF_STUB = "data:text/javascript,export const env={get DB(){return globalThis.__ALERT_DB__;},get FOUNDER_EMAIL(){return undefined;},get PAWSPACE_UAT_LOGIN(){return undefined;}};";
if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "cloudflare:workers") return { url: CF_STUB, shortCircuit: true };
      try { return nextResolve(specifier, context); }
      catch (error) {
        if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context);
        throw error;
      }
    },
  });
} else {
  const hook = `export async function resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { url: ${JSON.stringify(CF_STUB)}, shortCircuit: true };
    try { return await nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(specifier + ".ts", context);
      throw error;
    }
  }`;
  nodeModule.register(new URL(`data:text/javascript,${encodeURIComponent(hook)}`));
}

// batch() is one transaction in D1: see tests/helpers/d1.mjs. The loop this replaced committed
// each statement as it went, so any atomicity claim below was measured against the wrong machine.
const makeD1 = (sqlite, options) => createD1(sqlite, options);

let sqlite;
function freshDb() { sqlite = new DatabaseSync(":memory:"); globalThis.__ALERT_DB__ = makeD1(sqlite); return globalThis.__ALERT_DB__; }

const staffAlertsRoute = await import("../app/api/staff-alerts/route.ts");
const runnerRoute = await import("../app/api/staff-alert-runner/route.ts");
const crmAutomationRoute = await import("../app/api/crm-automation/route.ts");
const { runBackgroundScheduler } = await import("../lib/background-scheduler.ts");
const { runDailyIncentiveAccrualSweep } = await import("../lib/daily-incentive-accrual.ts");
const { automationDecision } = await import("../lib/crm-automation-governance.ts");

const call = async (handler, method, body) => {
  const request = method === "GET"
    ? new Request("http://localhost/api/x")
    : new Request("http://localhost/api/x", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const response = await handler(request);
  return { status: response.status, body: await response.json() };
};

const NOW = Date.now();
const MIN = 60_000, DAY = 86_400_000;

// ---- Seed helpers (DDL copied verbatim from each table's owning source) ------------------------

function seedLeadSlaTables() {
  // lib/lead-sla-governance.ts + lib/lead-assignment-governance.ts
  sqlite.exec("CREATE TABLE IF NOT EXISTS lead_sla_clocks (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,lead_id TEXT NOT NULL,assignment_id TEXT NOT NULL,policy_id TEXT NOT NULL,policy_version INTEGER NOT NULL,clock_type TEXT NOT NULL,cycle INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'running',started_at INTEGER NOT NULL,due_at INTEGER NOT NULL,manager_escalation_due_at INTEGER NOT NULL,reassignment_due_at INTEGER NOT NULL,met_at INTEGER,breached_at INTEGER,paused_at INTEGER,pause_reason TEXT,paused_remaining_minutes INTEGER,last_action_at INTEGER,next_action_at INTEGER,detail_json TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(lead_id,clock_type,cycle))");
  sqlite.exec("CREATE TABLE IF NOT EXISTS lead_assignments (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,lead_id TEXT NOT NULL,employee_email TEXT,team_code TEXT NOT NULL,policy_id TEXT NOT NULL,policy_version INTEGER NOT NULL,assignment_reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'current',fallback_queue TEXT,assigned_at INTEGER NOT NULL,accepted_at INTEGER,ended_at INTEGER,ended_reason TEXT,previous_assignment_id TEXT,detail_json TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL,created_at INTEGER NOT NULL)");
}
function seedBreachedClock(clockId = "CLK-1") {
  seedLeadSlaTables();
  // lead_work_items DDL from app/api/revenue-crm/route.ts — the alert query joins it for customer_id.
  sqlite.exec("CREATE TABLE IF NOT EXISTS lead_work_items (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, source TEXT NOT NULL, service TEXT NOT NULL, owner TEXT NOT NULL, manager TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', stage TEXT NOT NULL DEFAULT 'day_1', work_day INTEGER NOT NULL DEFAULT 1, assigned_at INTEGER NOT NULL, first_action_due_at INTEGER NOT NULL, manager_alert_at INTEGER NOT NULL, first_action_at INTEGER, call_attempts INTEGER NOT NULL DEFAULT 0, whatsapp_attempts INTEGER NOT NULL DEFAULT 0, last_outcome TEXT, next_action_at INTEGER, recycle_at INTEGER, recycle_cycle INTEGER NOT NULL DEFAULT 0, opt_out INTEGER NOT NULL DEFAULT 0, converted_booking_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT INTO lead_work_items (id,customer_id,source,service,owner,manager,status,stage,work_day,assigned_at,first_action_due_at,manager_alert_at,first_action_at,recycle_cycle,opt_out,created_at,updated_at) VALUES ('LEAD-1','cus_l1','Website','Grooming','Neha','Sales Manager','active','day_1',1,?,?,?,?,0,0,?,?)").run(NOW - 60 * MIN, NOW - 50 * MIN, NOW + DAY, NOW - 55 * MIN, NOW - 60 * MIN, NOW - 60 * MIN);
  sqlite.prepare("INSERT INTO lead_assignments (id,idempotency_key,lead_id,employee_email,team_code,policy_id,policy_version,assignment_reason,status,assigned_at,created_by,created_at) VALUES ('ASG-1','asg-1','LEAD-1','neha@pawspace.in','sales','POL-1',1,'round_robin','current',?,?,?)").run(NOW - 3 * MIN, "t", NOW - 3 * MIN);
  // due in the past; manager/reassignment thresholds far in the future so only the SLA alert fires
  sqlite.prepare("INSERT INTO lead_sla_clocks (id,idempotency_key,lead_id,assignment_id,policy_id,policy_version,clock_type,cycle,status,started_at,due_at,manager_escalation_due_at,reassignment_due_at,created_by,created_at,updated_at) VALUES (?,?,'LEAD-1','ASG-1','POL-1',1,'first_response',1,'running',?,?,?,?,?,?,?)").run(clockId, `clk-${clockId}`, NOW - 60 * MIN, NOW - 30 * MIN, NOW + DAY, NOW + 2 * DAY, "t", NOW - 60 * MIN, NOW - 60 * MIN);
}
function seedBoardingTimeout() {
  // lib/boarding-governance.ts (boarding_stays), canonical booking routes (canonical_bookings),
  // lib/provider-capacity-governance.ts (provider_assignment_offers)
  sqlite.exec("CREATE TABLE IF NOT EXISTS boarding_stays (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,host_provider_id TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,package_code TEXT NOT NULL,check_in_at TEXT NOT NULL,check_out_at TEXT NOT NULL,billed_units INTEGER NOT NULL,pet_count INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'awaiting_host_acceptance',care_plan_status TEXT NOT NULL DEFAULT 'required',check_in_status TEXT NOT NULL DEFAULT 'pending',check_out_status TEXT NOT NULL DEFAULT 'pending',extension_status TEXT NOT NULL DEFAULT 'none',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,source_pet_ids_json TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,service_code TEXT NOT NULL,package_code TEXT NOT NULL,package_name TEXT NOT NULL,schedule_group_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'confirmed',channel TEXT NOT NULL DEFAULT 'customer_app',total_amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',pricing_json TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_assignment_offers (group_id TEXT PRIMARY KEY,booking_id TEXT,provider_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',offered_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,responded_at INTEGER,response_reason TEXT,attempt_no INTEGER NOT NULL DEFAULT 1,updated_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,total_amount,created_by,created_at,updated_at) VALUES ('BK-1','bk-1','cus_1','[]','[]','blr','blr-east','boarding','pkg','Pkg','GRP-1','host_maya_rohan','2026-08-20','2026-08-22','confirmed',2500,'t',?,?)").run(NOW, NOW);
  sqlite.prepare("INSERT INTO boarding_stays (id,booking_id,customer_id,host_provider_id,city_id,zone_id,package_code,check_in_at,check_out_at,billed_units,pet_count,status,created_at,updated_at) VALUES ('STAY-1','BK-1','cus_1','host_maya_rohan','blr','blr-east','pkg','2026-08-20','2026-08-22',2,1,'awaiting_host_acceptance',?,?)").run(NOW, NOW);
  sqlite.prepare("INSERT INTO provider_assignment_offers (group_id,booking_id,provider_id,status,offered_at,expires_at,attempt_no,updated_at) VALUES ('GRP-1','BK-1','host_maya_rohan','pending',?,?,1,?)").run(NOW - 10 * MIN, NOW - 5 * MIN, NOW - 10 * MIN);
}
function seedFailedPayment() {
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,amount REAL NOT NULL,amount_due_now REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',method TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,gateway TEXT NOT NULL DEFAULT 'uat_sandbox',idempotency_key TEXT NOT NULL UNIQUE,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,method,mode,status,idempotency_key,created_at,updated_at) VALUES ('PAY-9','BK-9','cus_9',1200,1200,'upi','prepaid','failed','pk-9',?,?)").run(NOW, NOW);
}
const alertRows = (type) => sqlite.prepare("SELECT id,status FROM staff_alerts WHERE alert_type=?").all(type);

// ---- 1. Cron job inventory (contract) -----------------------------------------------------------

test("inventory: every background job is wired into the scheduled worker; none are defined-but-unscheduled", () => {
  const scheduler = fs.readFileSync("lib/background-scheduler.ts", "utf8");
  const workerSource = fs.readFileSync("worker/index.ts", "utf8");
  assert.match(workerSource, /async scheduled\(/);
  assert.match(workerSource, /runBackgroundScheduler\(env\.DB/);
  const jobNames = ["staffAlerts", "callbacks", "leadReopening", "legacyLeadSla", "opsEscalation", "commandReports", "customerReminders", "petBirthdayRewards", "vaccinationReminders", "pawPointsEarn", "serviceReviews", "revenueRecognition", "riskAnomaly", "customerTargeting", "haptikOutbound", "appToRevenueFunnel", "dailyIncentiveAccrual", "statutoryReminders", "opsWorkQueue", "foodBatchExpiry", "overdueStayBalances"];
  for (const name of jobNames) assert.ok(scheduler.includes(`"${name}"`), `job ${name} is named in the scheduler result`);
  // Every exported run*Sweep in lib/ must be reachable from the scheduler (directly or transitively).
  const sweepExports = [];
  for (const file of fs.readdirSync("lib")) {
    if (!file.endsWith(".ts")) continue;
    const source = fs.readFileSync(`lib/${file}`, "utf8");
    for (const match of source.matchAll(/export async function (run\w*Sweep|sweep[A-Z]\w*)/g)) sweepExports.push(match[1]);
  }
  const funnel = fs.readFileSync("lib/app-to-revenue-funnel.ts", "utf8");
  for (const sweep of sweepExports) {
    const wired = scheduler.includes(`${sweep}(`) || funnel.includes(`${sweep}(`); // recovery-expiry runs inside the funnel sweep
    assert.ok(wired, `${sweep} is exported but never reachable from the scheduled worker`);
  }
  assert.match(scheduler, /"\*\/5 \* \* \* \*"/, "the scheduler contract is the 5-minute cron");
});

// ---- 2. Scheduler real-execution: idempotency at slot and job level ------------------------------

test("real execution: the full scheduled run is slot-idempotent and inline jobs never double their effects", async () => {
  freshDb();
  // Seed the legacy inline-job conditions (DDL from app/api/revenue-crm/route.ts).
  sqlite.exec("CREATE TABLE IF NOT EXISTS lead_work_items (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, source TEXT NOT NULL, service TEXT NOT NULL, owner TEXT NOT NULL, manager TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', stage TEXT NOT NULL DEFAULT 'day_1', work_day INTEGER NOT NULL DEFAULT 1, assigned_at INTEGER NOT NULL, first_action_due_at INTEGER NOT NULL, manager_alert_at INTEGER NOT NULL, first_action_at INTEGER, call_attempts INTEGER NOT NULL DEFAULT 0, whatsapp_attempts INTEGER NOT NULL DEFAULT 0, last_outcome TEXT, next_action_at INTEGER, recycle_at INTEGER, recycle_cycle INTEGER NOT NULL DEFAULT 0, opt_out INTEGER NOT NULL DEFAULT 0, converted_booking_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS lead_reopen_events (id TEXT PRIMARY KEY, lead_id TEXT NOT NULL, cycle INTEGER NOT NULL, reopened_at INTEGER NOT NULL, assigned_owner TEXT NOT NULL, previous_status TEXT NOT NULL, outcome TEXT NOT NULL DEFAULT 'reopened', created_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS customer_experience_tickets (id TEXT PRIMARY KEY, customer_id TEXT, booking_id TEXT, lead_id TEXT, category TEXT NOT NULL, priority TEXT NOT NULL, subject TEXT NOT NULL, detail TEXT NOT NULL, owner TEXT NOT NULL, manager TEXT NOT NULL, sla_due_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open', escalation_level INTEGER NOT NULL DEFAULT 0, customer_status TEXT NOT NULL DEFAULT 'We received your request', resolution TEXT, root_cause TEXT, resolution_evidence TEXT, reopened_count INTEGER NOT NULL DEFAULT 0, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, resolved_at INTEGER)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS ops_completion_controls (id TEXT PRIMARY KEY, booking_id TEXT NOT NULL, vertical TEXT NOT NULL, owner TEXT NOT NULL, scheduled_end_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'in_progress', service_evidence TEXT, customer_update_at INTEGER, payment_confirmed INTEGER NOT NULL DEFAULT 0, provider_settlement_ready INTEGER NOT NULL DEFAULT 0, exception_reason TEXT, escalation_level INTEGER NOT NULL DEFAULT 0, completed_at INTEGER, updated_at INTEGER NOT NULL)");
  // Pin asOf to the MIDDLE of a 5-minute slot: with raw Date.now(), a run starting within 1s of a
  // slot boundary made the +1000ms replay land in the NEXT slot and legitimately re-run — a
  // 1-in-300 CI flake (reproduced at 18:39:59Z). Mid-slot keeps the replay in-slot and asOf+5min
  // still lands in the next slot, so both assertions stay meaningful.
  const asOf = NOW - (NOW % (5 * MIN)) + 2 * MIN;
  sqlite.prepare("INSERT INTO lead_work_items (id,customer_id,source,service,owner,manager,status,stage,work_day,assigned_at,first_action_due_at,manager_alert_at,recycle_at,recycle_cycle,opt_out,created_at,updated_at) VALUES ('LEAD-COLD','c1','Website','Grooming','Neha','Sales Manager','cold','waiting_30_day_reopen',3,?,?,?,?,0,0,?,?)").run(asOf - DAY, asOf - DAY, asOf - DAY, asOf - MIN, asOf - DAY, asOf - DAY);
  sqlite.prepare("INSERT INTO lead_work_items (id,customer_id,source,service,owner,manager,status,stage,work_day,assigned_at,first_action_due_at,manager_alert_at,recycle_cycle,opt_out,created_at,updated_at) VALUES ('LEAD-SLA','c2','Website','Training','Rahul','Sales Manager','active','day_1',1,?,?,?,0,0,?,?)").run(asOf - 60 * MIN, asOf - 50 * MIN, asOf - 30 * MIN, asOf - 60 * MIN, asOf - 60 * MIN);
  sqlite.prepare("INSERT INTO ops_completion_controls (id,booking_id,vertical,owner,scheduled_end_at,status,updated_at) VALUES ('OPS-1','BK-OPS','Grooming','Grooming Ops',?, 'in_progress',?)").run(asOf - 30 * MIN, asOf - 30 * MIN);

  const first = await runBackgroundScheduler(globalThis.__ALERT_DB__, { actorId: "test", asOf });
  assert.deepEqual(first.errors, [], `every wired job must run clean on a cold DB: ${JSON.stringify(first.errors)}`);
  assert.equal(first.ok, true);
  assert.equal(first.duplicatePrevented, false);
  // effects happened exactly once
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM lead_reopen_events WHERE lead_id='LEAD-COLD'").get().c, 1, "cold lead reopened once");
  assert.equal(sqlite.prepare("SELECT status FROM lead_work_items WHERE id='LEAD-SLA'").get().status, "sla_breached");
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM customer_experience_tickets WHERE id='SLA-LEAD-SLA'").get().c, 1);
  assert.equal(sqlite.prepare("SELECT escalation_level FROM ops_completion_controls WHERE id='OPS-1'").get().escalation_level, 1);

  // Same slot again -> pure duplicatePrevented, nothing re-runs.
  const replay = await runBackgroundScheduler(globalThis.__ALERT_DB__, { actorId: "test", asOf: asOf + 1000 });
  assert.equal(replay.duplicatePrevented, true, "a completed 5-minute slot never re-runs");
  // Next slot -> jobs run again but guarded effects never double.
  const next = await runBackgroundScheduler(globalThis.__ALERT_DB__, { actorId: "test", asOf: asOf + 5 * MIN });
  assert.deepEqual(next.errors, []);
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM lead_reopen_events WHERE lead_id='LEAD-COLD'").get().c, 1, "no double reopen");
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM customer_experience_tickets WHERE id='SLA-LEAD-SLA'").get().c, 1, "no duplicate SLA ticket");
  assert.equal(sqlite.prepare("SELECT escalation_level FROM ops_completion_controls WHERE id='OPS-1'").get().escalation_level, 1, "no double escalation");
});

test("real execution: 7pm command reports generate exactly once per day/period", async () => {
  freshDb();
  sqlite.exec("CREATE TABLE IF NOT EXISTS command_report_runs (id TEXT PRIMARY KEY, report_date TEXT NOT NULL, period_type TEXT NOT NULL, scheduled_for INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'uat_queued', metrics_json TEXT NOT NULL, recipients_json TEXT NOT NULL, delivery_channels_json TEXT NOT NULL, generated_at INTEGER NOT NULL)");
  // 14:30 UTC == 20:00 IST — inside the 7pm gate.
  const evening = new Date(new Date(NOW).toISOString().slice(0, 10) + "T14:30:00.000Z").getTime();
  await runBackgroundScheduler(globalThis.__ALERT_DB__, { actorId: "test", asOf: evening });
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM command_report_runs").get().c, 3, "daily/weekly/monthly generated");
  await runBackgroundScheduler(globalThis.__ALERT_DB__, { actorId: "test", asOf: evening + 5 * MIN });
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM command_report_runs").get().c, 3, "INSERT OR IGNORE keeps it at one per day/period");
});

// ---- 3. staff-alert-runner: real conditions fire once and resolve when cleared -------------------

test("real execution: a lead SLA breach fires one alert via the runner and auto-resolves when the clock clears", async () => {
  freshDb(); seedBreachedClock();
  const first = await call(runnerRoute.POST, "POST", { asOf: NOW });
  assert.equal(first.status, 200, JSON.stringify(first.body).slice(0, 300));
  let rows = alertRows("lead_sla_breach");
  assert.equal(rows.length, 1, "the breach alert fired");
  assert.equal(rows[0].status, "open");
  const again = await call(runnerRoute.POST, "POST", { asOf: NOW + MIN });
  assert.equal(again.status, 200);
  assert.equal(alertRows("lead_sla_breach").length, 1, "re-running the sweep never duplicates the alert");
  // Condition clears: the clock is met.
  sqlite.prepare("UPDATE lead_sla_clocks SET status='met',met_at=? WHERE id='CLK-1'").run(NOW + 2 * MIN);
  const resolvePass = await call(runnerRoute.POST, "POST", { asOf: NOW + 3 * MIN });
  assert.equal(resolvePass.status, 200);
  rows = alertRows("lead_sla_breach");
  assert.equal(rows[0].status, "resolved", "the alert auto-resolves once the SLA clock is no longer running/breached");
  const event = sqlite.prepare("SELECT COUNT(*) c FROM staff_alert_events WHERE alert_id=? AND event_type='auto_resolved'").get(rows[0].id);
  assert.equal(event.c, 1, "auto-resolution leaves exactly one event");
});

test("real execution: an unaccepted boarding stay past the offer timeout alerts once and resolves on acceptance", async () => {
  freshDb(); seedBoardingTimeout();
  const first = await call(runnerRoute.POST, "POST", { asOf: NOW });
  assert.equal(first.status, 200, JSON.stringify(first.body).slice(0, 300));
  assert.equal(first.body.data.boarding.created, 1);
  let rows = alertRows("boarding_acceptance_timeout");
  assert.equal(rows.length, 1, "the boarding acceptance-timeout alert fired");
  await call(runnerRoute.POST, "POST", { asOf: NOW + MIN });
  assert.equal(alertRows("boarding_acceptance_timeout").length, 1, "idempotent across sweeps");
  // Condition clears: the host accepts.
  sqlite.prepare("UPDATE boarding_stays SET status='confirmed' WHERE id='STAY-1'").run();
  await call(runnerRoute.POST, "POST", { asOf: NOW + 2 * MIN });
  rows = alertRows("boarding_acceptance_timeout");
  assert.equal(rows[0].status, "resolved", "the alert auto-resolves once the stay leaves awaiting_host_acceptance");
});

test("real execution: a failed payment alerts once (critical, finance) and resolves when the payment recovers", async () => {
  freshDb(); seedFailedPayment();
  const first = await call(runnerRoute.POST, "POST", { asOf: NOW });
  assert.equal(first.status, 200);
  assert.equal(first.body.data.payments.created, 1);
  const alert = sqlite.prepare("SELECT * FROM staff_alerts WHERE alert_type='payment_failure'").get();
  assert.ok(alert);
  assert.equal(alert.severity, "critical");
  assert.equal(alert.team_code, "finance");
  assert.equal(alert.booking_id, "BK-9");
  await call(runnerRoute.POST, "POST", { asOf: NOW + MIN });
  assert.equal(alertRows("payment_failure").length, 1, "idempotent across sweeps");
  sqlite.prepare("UPDATE booking_payments SET status='captured' WHERE id='PAY-9'").run();
  await call(runnerRoute.POST, "POST", { asOf: NOW + 2 * MIN });
  assert.equal(alertRows("payment_failure")[0].status, "resolved", "the alert auto-resolves once the payment is no longer failed");
});

test("regression: a non-numeric asOf is rejected instead of silently sweeping nothing", async () => {
  freshDb(); seedFailedPayment();
  const garbage = await call(runnerRoute.POST, "POST", { asOf: "yesterday" });
  assert.equal(garbage.status, 400, "NaN asOf previously made every due_at<=NaN comparison false and reported success");
  const alertsTable = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='staff_alerts'").get();
  assert.ok(!alertsTable || alertRows("payment_failure").length === 0, "nothing swept under the rejected input");
  const sweepAction = await call(staffAlertsRoute.POST, "POST", { action: "sweep", asOf: "yesterday" });
  assert.equal(sweepAction.status, 400, "the staff-alerts sweep action rejects it too");
});

// ---- 4. crm-automation: seed, fire, assert, idempotency ------------------------------------------

function seedConsent(customerId, overrides = {}) {
  // DDL from lib/customer-360.ts
  sqlite.exec("CREATE TABLE IF NOT EXISTS customer_contact_preferences (customer_id TEXT PRIMARY KEY, marketing_consent INTEGER NOT NULL DEFAULT 0, service_consent INTEGER NOT NULL DEFAULT 1, whatsapp_consent INTEGER NOT NULL DEFAULT 0, sms_consent INTEGER NOT NULL DEFAULT 0, email_consent INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'customer', updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  const consent = { marketing: 1, service: 1, whatsapp: 1, sms: 0, email: 0, ...overrides };
  sqlite.prepare("INSERT OR REPLACE INTO customer_contact_preferences (customer_id,marketing_consent,service_consent,whatsapp_consent,sms_consent,email_consent,source,updated_by,updated_at) VALUES (?,?,?,?,?,?, 'customer','t',?)").run(customerId, consent.marketing, consent.service, consent.whatsapp, consent.sms, consent.email, NOW);
}

test("real execution: automation policies gate consent -> approval -> frequency, and queueing is idempotent", async () => {
  freshDb();
  // No consent row: marketing is blocked outright.
  const noConsent = await call(crmAutomationRoute.POST, "POST", { action: "decision", customerId: "cus_a", channel: "whatsapp", purpose: "marketing" });
  assert.equal(noConsent.body.data.reason, "marketing_consent_missing");
  seedConsent("cus_a");
  // Consent granted but no approved policy: still blocked, explicitly configuration_required.
  const noPolicy = await call(crmAutomationRoute.POST, "POST", { action: "decision", customerId: "cus_a", channel: "whatsapp", purpose: "marketing" });
  assert.equal(noPolicy.body.data.reason, "automation_policy_not_approved");
  assert.equal(noPolicy.body.data.policyStatus, "configuration_required");
  // Approve the policy with a frequency cap of 1 per 24h.
  const save = await call(crmAutomationRoute.POST, "POST", { action: "save_policy", policyKey: "marketing:whatsapp", enabled: true, maxContacts: 1, windowHours: 24, maxAttempts: 2, retryMinutes: 5 });
  assert.equal(save.status, 200);
  const allowed = await call(crmAutomationRoute.POST, "POST", { action: "decision", customerId: "cus_a", channel: "whatsapp", purpose: "marketing" });
  assert.equal(allowed.body.data.allowed, true);
  // Queue once, replay the same idempotency key -> one dispatch row.
  const q1 = await call(crmAutomationRoute.POST, "POST", { action: "queue", customerId: "cus_a", journeyCode: "winback", channel: "whatsapp", purpose: "marketing", idempotencyKey: "J-1" });
  assert.equal(q1.status, 201);
  const q1replay = await call(crmAutomationRoute.POST, "POST", { action: "queue", customerId: "cus_a", journeyCode: "winback", channel: "whatsapp", purpose: "marketing", idempotencyKey: "J-1" });
  assert.equal(q1replay.body.data.duplicatePrevented, true);
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM crm_automation_dispatches").get().c, 1);
  // A second journey for the same customer hits the frequency cap.
  const q2 = await call(crmAutomationRoute.POST, "POST", { action: "queue", customerId: "cus_a", journeyCode: "winback2", channel: "whatsapp", purpose: "marketing", idempotencyKey: "J-2" });
  assert.equal(q2.status, 409);
  assert.equal(q2.body.data.decision.reason, "frequency_cap");
});

test("real execution: failure retries follow the policy ladder into an idempotent dead letter", async () => {
  freshDb(); seedConsent("cus_b");
  await call(crmAutomationRoute.POST, "POST", { action: "save_policy", policyKey: "marketing:whatsapp", enabled: true, maxAttempts: 2, retryMinutes: 5 });
  const queued = await call(crmAutomationRoute.POST, "POST", { action: "queue", customerId: "cus_b", journeyCode: "welcome", channel: "whatsapp", purpose: "marketing", idempotencyKey: "J-B" });
  const dispatchId = queued.body.data.id;
  const fail1 = await call(crmAutomationRoute.POST, "POST", { action: "failure", dispatchId, error: "provider timeout" });
  assert.equal(fail1.body.data.status, "retry");
  assert.equal(fail1.body.data.attempts, 1);
  assert.ok(fail1.body.data.nextAttemptAt > NOW, "retry is scheduled from the policy's retry_minutes");
  const fail2 = await call(crmAutomationRoute.POST, "POST", { action: "failure", dispatchId, error: "provider timeout again" });
  assert.equal(fail2.body.data.status, "dead_letter");
  assert.equal(fail2.body.data.reason, "retry_exhausted");
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM crm_automation_dead_letters WHERE dispatch_id=?").get(dispatchId).c, 1, "dead letter is unique per dispatch");
  // Regression: acknowledging delivery of a dispatch that does not exist must not report success.
  const ghost = await call(crmAutomationRoute.POST, "POST", { action: "delivered", dispatchId: "AUTO-DOES-NOT-EXIST" });
  assert.equal(ghost.status, 404, "previously returned ok:true for a no-op UPDATE");
  const real = await call(crmAutomationRoute.POST, "POST", { action: "delivered", dispatchId, providerReference: "prov-1" });
  assert.equal(real.status, 200);
  assert.equal(sqlite.prepare("SELECT status FROM crm_automation_dispatches WHERE id=?").get(dispatchId).status, "delivered");
});

test("real execution: quiet hours block automation deterministically", async () => {
  freshDb(); seedConsent("cus_q");
  const istHour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", hour12: false }).format(new Date(NOW)));
  const quietStart = istHour, quietEnd = (istHour + 1) % 24; // a window guaranteed to cover "now"
  await call(crmAutomationRoute.POST, "POST", { action: "save_policy", policyKey: "marketing:whatsapp", enabled: true, quietStartHour: quietStart, quietEndHour: quietEnd });
  const decision = await automationDecision(globalThis.__ALERT_DB__, { customerId: "cus_q", purpose: "marketing", channel: "whatsapp", now: NOW });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "quiet_hours");
});

// ---- 5. Daily incentive auto-accrual --------------------------------------------------------------

test("real execution: the daily incentive accrual accrues once per employee per day, idempotently at both layers", async () => {
  freshDb();
  // DDL from lib/sales-incentive-engine.ts + canonical booking routes.
  sqlite.exec("CREATE TABLE IF NOT EXISTS sales_employee_base (id TEXT PRIMARY KEY,employee_id TEXT NOT NULL,base_vertical TEXT NOT NULL,effective_from TEXT NOT NULL,effective_until TEXT,reason TEXT NOT NULL,actor_id TEXT NOT NULL,created_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS sales_attributed_bookings (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,employee_id TEXT NOT NULL,recorded_by TEXT NOT NULL,recorded_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,source_pet_ids_json TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,service_code TEXT NOT NULL,package_code TEXT NOT NULL,package_name TEXT NOT NULL,schedule_group_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'confirmed',channel TEXT NOT NULL DEFAULT 'customer_app',total_amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',pricing_json TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  const date = "2026-08-11";
  sqlite.prepare("INSERT INTO sales_employee_base (id,employee_id,base_vertical,effective_from,reason,actor_id,created_at) VALUES ('SB-1','emp_neha','training','2026-08-01','initial allocation','t',?)").run(NOW);
  sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,total_amount,created_by,created_at,updated_at) VALUES ('BK-T1','bk-t1','cus_t','[]','[]','blr','blr-east','dog_training','pkg','Pkg','GRP-T1','train_kiran',?,?,'confirmed',30000,'t',?,?)").run(`${date}T10:00:00.000Z`, `${date}T11:00:00.000Z`, NOW, NOW);
  sqlite.prepare("INSERT INTO sales_attributed_bookings (id,booking_id,employee_id,recorded_by,recorded_at) VALUES ('SAB-1','BK-T1','emp_neha','t',?)").run(NOW);

  const first = await runDailyIncentiveAccrualSweep(globalThis.__ALERT_DB__, { asOf: NOW, date });
  assert.equal(first.skipped, false, JSON.stringify(first));
  assert.equal(first.processed, 1, "one employee accrued");
  const accrual = sqlite.prepare("SELECT * FROM daily_incentive_accruals WHERE employee_id='emp_neha' AND accrual_date=?").get(date);
  assert.equal(accrual.achieved_value, 30000, "achieved value = attributed canonical booking total");
  assert.equal(accrual.incentive, 500, "training ladder: 30000 clears the 25000 tier -> 500, no blitz");
  assert.equal(accrual.status, "accrued");
  assert.equal(accrual.source, "auto_daily_sweep");
  // Layer 1: the per-day sweep marker makes the next tick a no-op.
  const replay = await runDailyIncentiveAccrualSweep(globalThis.__ALERT_DB__, { asOf: NOW + 5 * MIN, date });
  assert.equal(replay.skipped, true);
  assert.equal(replay.reason, "already_processed");
  // Layer 2: even with the marker gone, the UNIQUE(employee,date) accrual never doubles.
  sqlite.prepare("DELETE FROM daily_incentive_sweep_runs WHERE accrual_date=?").run(date);
  const rerun = await runDailyIncentiveAccrualSweep(globalThis.__ALERT_DB__, { asOf: NOW + 10 * MIN, date });
  assert.equal(rerun.processed, 0, "ON CONFLICT DO NOTHING blocks double accrual");
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM daily_incentive_accruals WHERE employee_id='emp_neha'").get().c, 1);
});

// ---- 6. Team surface + wiring contracts -----------------------------------------------------------

test("contract: the alerts team surface is API-driven and the new alert conditions flow through it", () => {
  const page = fs.readFileSync("app/team/alerts/page.tsx", "utf8");
  assert.match(page, /\/api\/staff-alerts/);
  assert.match(page, /Acknowledge/);
  assert.match(page, /Resolve alert/);
  assert.doesNotMatch(page, /globalThis|setInterval/);
  const lib = fs.readFileSync("lib/staff-alert-center.ts", "utf8");
  for (const token of ["boarding_acceptance_timeout", "payment_failure", "autoResolveClearedAlerts", "condition_cleared"]) assert.ok(lib.includes(token), token);
  // routes reach D1 via cloudflare:workers only
  for (const path of ["app/api/staff-alerts/route.ts", "app/api/staff-alert-runner/route.ts", "app/api/crm-automation/route.ts"]) {
    assert.doesNotMatch(fs.readFileSync(path, "utf8"), /globalThis/, path);
  }
});
