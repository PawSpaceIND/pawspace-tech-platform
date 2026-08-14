import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";
import { createD1 } from "./helpers/d1.mjs";

// Test-only resolve hooks: "cloudflare:workers" resolves to a stub whose env.DB is the current
// per-test SQLite-backed D1 shim, and extensionless relative imports fall back to .ts — so the
// REAL route handlers and libs execute unmodified against a real SQL engine.
const CF_STUB = "data:text/javascript,export const env={get DB(){return globalThis.__REV_DB__;},get FOUNDER_EMAIL(){return undefined;},get PAWSPACE_UAT_LOGIN(){return undefined;}};";
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
function freshDb() { sqlite = new DatabaseSync(":memory:"); globalThis.__REV_DB__ = makeD1(sqlite); }

const missionControlRoute = await import("../app/api/revenue-mission-control/route.ts");
const commandCenterRoute = await import("../app/api/revenue-mission-command-center/route.ts");
const leadershipRoute = await import("../app/api/revenue-leadership-reporting/route.ts");
const intelligenceRoute = await import("../app/api/revenue-intelligence/route.ts");
const crmEngineRoute = await import("../app/api/revenue-crm/route.ts");
const { generatePnlReport } = await import("../lib/pnl-reporting.ts");

const call = async (handler, method, bodyOrQuery) => {
  const url = `http://localhost/api/x${method === "GET" && bodyOrQuery ? `?${bodyOrQuery}` : ""}`;
  const request = method === "GET"
    ? new Request(url)
    : new Request(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(bodyOrQuery) });
  const response = await handler(request);
  return { status: response.status, body: await response.json() };
};

const DAY = 86_400_000;
const NOW = Date.now();
const MONTH = new Date(NOW).toISOString().slice(0, 7);

// Exact DDL copied from the owning sources: app/api/walking-bookings/route.ts (canonical_bookings,
// booking_payments), the payment reconciliation lib (payment_reconciliation_records) and
// app/api/finance-control/route.ts (finance_journal_entries). Never guessed.
function seedCanonical() {
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,source_pet_ids_json TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,service_code TEXT NOT NULL,package_code TEXT NOT NULL,package_name TEXT NOT NULL,schedule_group_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'confirmed',channel TEXT NOT NULL DEFAULT 'customer_app',total_amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',pricing_json TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,amount REAL NOT NULL,amount_due_now REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',method TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,gateway TEXT NOT NULL DEFAULT 'uat_sandbox',idempotency_key TEXT NOT NULL UNIQUE,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS payment_reconciliation_records (payment_id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,gateway TEXT NOT NULL,environment TEXT NOT NULL,expected_amount REAL NOT NULL,captured_amount REAL NOT NULL DEFAULT 0,refunded_amount REAL NOT NULL DEFAULT 0,currency TEXT NOT NULL,gateway_status TEXT NOT NULL DEFAULT 'not_started',reconciliation_status TEXT NOT NULL DEFAULT 'pending',variance_amount REAL NOT NULL DEFAULT 0,last_event_id TEXT,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS finance_journal_entries (id text PRIMARY KEY NOT NULL,entry_date text NOT NULL,source_type text NOT NULL,source_id text NOT NULL,account_code text NOT NULL,cost_centre text,vertical text,debit real DEFAULT 0 NOT NULL,credit real DEFAULT 0 NOT NULL,narration text NOT NULL,period_code text NOT NULL,posted integer DEFAULT 0 NOT NULL,created_at integer NOT NULL)");
  const booking = sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES (?,?,?,'[]','[]','blr','blr-east',?,'pkg','Pkg',?,'prov_1',?,?,?,?,?, 'INR','{}','uat',?,?)");
  const startIso = `${MONTH}-15T10:00:00.000Z`, endIso = `${MONTH}-15T12:00:00.000Z`, createdAt = NOW - 3 * DAY;
  // Known amounts: B1 grooming 1000 (confirmed), B2 boarding 2500 (completed),
  // B3 training 1500 (CANCELLED), B4 walking 800 (DRAFT). Canonical revenue truth = 3500.
  booking.run("B1", "k1", "cus_1", "grooming", "g1", startIso, endIso, "confirmed", "customer_app", 1000, createdAt, createdAt);
  booking.run("B2", "k2", "cus_2", "boarding", "g2", startIso, endIso, "completed", "customer_app", 2500, createdAt, createdAt);
  booking.run("B3", "k3", "cus_3", "dog_training", "g3", startIso, endIso, "cancelled", "customer_app", 1500, createdAt, createdAt);
  booking.run("B4", "k4", "cus_4", "dog_walking", "g4", startIso, endIso, "draft", "customer_app", 800, createdAt, createdAt);
  const payment = sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,method,mode,status,idempotency_key,created_at,updated_at) VALUES (?,?,?,?,?, 'upi','prepaid','captured',?,?,?)");
  payment.run("PAY1", "B1", "cus_1", 1000, 1000, "pk1", createdAt, createdAt);
  payment.run("PAY2", "B2", "cus_2", 2500, 2500, "pk2", createdAt, createdAt);
  const recon = sqlite.prepare("INSERT INTO payment_reconciliation_records (payment_id,booking_id,gateway,environment,expected_amount,captured_amount,refunded_amount,currency,updated_at) VALUES (?,?,?,?,?,?,?, 'INR',?)");
  recon.run("PAY1", "B1", "uat_sandbox", "sandbox", 1000, 1000, 200, createdAt);
  recon.run("PAY2", "B2", "uat_sandbox", "sandbox", 2500, 2500, 0, createdAt);
}

async function activeMissionWithBackfill(target = 10_000) {
  const save = await call(missionControlRoute.POST, "POST", { action: "save_mission", name: "UAT Mission", targetAmount: target, currency: "INR", periodStart: NOW - 7 * DAY, periodEnd: NOW + 7 * DAY, scope: { type: "company" }, revenueBasis: "net_collected", reason: "hardening audit mission" });
  assert.equal(save.status, 201, JSON.stringify(save.body));
  const missionId = save.body.data.id;
  const activate = await call(missionControlRoute.POST, "POST", { action: "activate_mission", missionId, approvalReference: "APPR-1", reason: "hardening audit activation" });
  assert.equal(activate.status, 200);
  const backfill = await call(missionControlRoute.POST, "POST", { action: "backfill_canonical_sources", missionId });
  assert.equal(backfill.status, 200, JSON.stringify(backfill.body));
  return missionId;
}

// ---- 1. Mission totals are exactly derivable from seeded canonical data ------------------------

test("real execution: mission booked/collected/refunded derive exactly from seeds — cancelled and draft bookings never count", async () => {
  freshDb(); seedCanonical();
  const missionId = await activeMissionWithBackfill();
  const summary = await call(missionControlRoute.GET, "GET", `missionId=${missionId}`);
  assert.equal(summary.status, 200);
  const metrics = summary.body.summary.metrics;
  assert.equal(metrics.booked, 3500, "1000+2500 only — the cancelled 1500 and draft 800 must not be booked revenue (was 5800 before the backfill status filter)");
  assert.equal(metrics.collected, 3500, "captured 1000+2500 from payment_reconciliation_records");
  assert.equal(metrics.refunded, 200);
  assert.equal(metrics.netCollected, 3300);
  assert.equal(metrics.achieved, 3300, "net_collected basis");
  assert.equal(metrics.gap, 6700);
  assert.equal(metrics.percent, 33, "3300/10000");
  assert.equal(metrics.pipeline, null, "no invented pipeline in mission metrics");
  assert.equal(metrics.forecast, null, "no invented forecast in mission metrics");
});

test("real execution: a live cancellation event removes that booking from 'booked' instead of crediting the target forever", async () => {
  freshDb(); seedCanonical();
  const { recordMissionBookingEvent, recordMissionCancellationEvent, revenueMissionSummary } = await import("../lib/revenue-mission-control.ts");
  const missionId = await activeMissionWithBackfill();
  const db = globalThis.__REV_DB__;
  await recordMissionBookingEvent(db, { bookingId: "B9", customerId: "cus_9", serviceCode: "grooming", cityId: "blr", totalAmount: 900, currency: "INR", sourceAt: NOW, status: "confirmed", actorId: "uat" });
  let summary = await revenueMissionSummary(db, missionId);
  assert.equal(summary.metrics.booked, 4400, "3500 + live 900");
  await recordMissionCancellationEvent(db, { bookingId: "B9", customerId: "cus_9", serviceCode: "grooming", cityId: "blr", currency: "INR", sourceAt: NOW + 1, sourceReference: "cancel-1", actorId: "uat" });
  summary = await revenueMissionSummary(db, missionId);
  assert.equal(summary.metrics.booked, 3500, "the cancelled booking's 900 is no longer counted as booked");
});

// ---- 2. Reconciliation across views (task item 4) ----------------------------------------------

test("reconciliation: mission booked === P&L revenue for the same seeded canonical bookings, counted exactly once", async () => {
  freshDb(); seedCanonical();
  const missionId = await activeMissionWithBackfill();
  const summary = await call(missionControlRoute.GET, "GET", `missionId=${missionId}`);
  const pnl = await generatePnlReport(globalThis.__REV_DB__, { fromMonth: MONTH, toMonth: MONTH });
  // Pre-fix the P&L reported 4500 here: grooming revenue was counted on BOTH grooming chart lines.
  assert.equal(pnl.totalTurnoverAmount, 3500, "P&L revenue = canonical_bookings pricing excluding cancelled/draft, each booking counted once");
  assert.equal(summary.body.summary.metrics.booked, pnl.totalTurnoverAmount, "revenue-mission and the finance P&L view agree on the same seeds");
  // dog_training maps to FIVE chart sub-lines — a confirmed 2000 training booking must add exactly
  // 2000 to both views (pre-fix the P&L added 10000).
  const createdAt = NOW - 2 * DAY;
  sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES ('B5','k5','cus_5','[]','[]','blr','blr-east','dog_training','pkg','Pkg','g5','prov_1',?,?,'confirmed','customer_app',2000,'INR','{}','uat',?,?)").run(`${MONTH}-16T10:00:00.000Z`, `${MONTH}-16T11:00:00.000Z`, createdAt, createdAt);
  await call(missionControlRoute.POST, "POST", { action: "backfill_canonical_sources", missionId });
  const summary2 = await call(missionControlRoute.GET, "GET", `missionId=${missionId}`);
  const pnl2 = await generatePnlReport(globalThis.__REV_DB__, { fromMonth: MONTH, toMonth: MONTH });
  assert.equal(pnl2.totalTurnoverAmount, 5500, "training booking adds exactly 2000, not 5×2000");
  assert.equal(summary2.body.summary.metrics.booked, 5500);
  assert.equal(summary2.body.summary.metrics.booked, pnl2.totalTurnoverAmount, "views still agree after new canonical data");
});

test("reconciliation: revenue-crm team revenue === mission net collected — the fabricated leaderboard array is gone", async () => {
  freshDb(); seedCanonical();
  const missionId = await activeMissionWithBackfill();
  // First GET creates the CRM engine tables and seeds leads (owners exist, zero conversions yet).
  const first = await call(crmEngineRoute.GET, "GET");
  assert.equal(first.status, 200, JSON.stringify(first.body).slice(0, 300));
  // Attribute the two real bookings to owners through the real conversion column.
  const now = Date.now();
  sqlite.prepare("INSERT INTO lead_work_items (id,customer_id,source,service,owner,manager,status,stage,work_day,assigned_at,first_action_due_at,manager_alert_at,call_attempts,whatsapp_attempts,converted_booking_id,recycle_cycle,opt_out,created_at,updated_at) VALUES ('LEAD-C1','cus_1','Website','Grooming','Neha','Sales Manager','qualified','day_1',1,?,?,?,0,0,'B1',0,0,?,?)").run(now, now, now, now, now);
  sqlite.prepare("INSERT INTO lead_work_items (id,customer_id,source,service,owner,manager,status,stage,work_day,assigned_at,first_action_due_at,manager_alert_at,call_attempts,whatsapp_attempts,converted_booking_id,recycle_cycle,opt_out,created_at,updated_at) VALUES ('LEAD-C2','cus_2','Website','Boarding','Priya','Sales Manager','qualified','day_1',1,?,?,?,0,0,'B2',0,0,?,?)").run(now, now, now, now, now);
  // Second GET refreshes the still-provisional leaderboard rows from canonical truth.
  const second = await call(crmEngineRoute.GET, "GET");
  assert.equal(second.status, 200);
  const stats = second.body.stats, leaderboard = second.body.leaderboard;
  assert.equal(stats.teamRevenue, 3300, "team eligible revenue = captured 3500 - refunded 200, straight from payment_reconciliation_records");
  assert.equal(stats.teamIncentive, 0, "no invented 8% incentive formula — incentives stay 0 until a policy exists");
  const mission = await call(missionControlRoute.GET, "GET", `missionId=${missionId}`);
  assert.equal(stats.teamRevenue, mission.body.summary.metrics.netCollected, "revenue-crm and revenue-mission-control agree on the same seeded data");
  const priya = leaderboard.find((row) => row.employee_name === "Priya");
  const neha = leaderboard.find((row) => row.employee_name === "Neha");
  assert.equal(priya.eligible_revenue, 2500);
  assert.equal(priya.collections, 2500);
  assert.equal(priya.conversions, 1);
  assert.equal(priya.rank, 1);
  assert.equal(neha.eligible_revenue, 800, "1000 captured - 200 refunded");
  assert.equal(neha.refunds, 200);
  for (const row of leaderboard) assert.equal(row.incentive_amount, 0);
  // Owners with no conversions report honest zeros, not fabricated 19-25k figures.
  const sanjay = leaderboard.find((row) => row.employee_name === "Sanjay");
  assert.equal(sanjay.eligible_revenue, 0);
});

// ---- 3. Command center + leadership reporting -------------------------------------------------

test("real execution: command center revenue, pace and breakdowns are exactly derivable and internally consistent", async () => {
  freshDb(); seedCanonical();
  const missionId = await activeMissionWithBackfill();
  const asOf = NOW; // periodStart NOW-7d, periodEnd NOW+7d -> elapsed exactly 50%
  const result = await call(commandCenterRoute.GET, "GET", `missionId=${missionId}&asOf=${asOf}`);
  assert.equal(result.status, 200);
  const command = result.body;
  assert.equal(command.revenue.achieved, 3300);
  assert.equal(command.revenue.elapsedPercent, 50);
  assert.equal(command.revenue.paceTarget, 5000, "target 10000 × 50% elapsed");
  assert.equal(command.revenue.paceVariance, -1700, "3300 - 5000");
  assert.equal(command.revenue.aheadOfPace, false);
  const bookedFromServices = command.breakdowns.service.reduce((sum, row) => sum + row.booked, 0);
  assert.equal(bookedFromServices, command.revenue.booked, "service breakdown sums to the headline booked figure (cancelled exclusion applied consistently)");
  assert.ok(!command.breakdowns.service.some((row) => row.serviceCode === "dog_training" && row.booked > 0), "the cancelled training booking contributes no booked revenue to any breakdown");
  assert.equal(command.status, "configuration_required", "missing lead policies surface as critical warnings, not invented health");
  assert.ok(command.warnings.some((w) => w.code === "assignment_policy_missing"));
  assert.equal(command.truth.pipelineIsAchievedRevenue, false);
});

test("real execution: leadership report snapshots the command truth and replays idempotently", async () => {
  freshDb(); seedCanonical();
  const missionId = await activeMissionWithBackfill();
  const generate = await call(leadershipRoute.POST, "POST", { action: "generate_report", missionId, periodType: "mission", idempotencyKey: "run-1" });
  assert.equal(generate.status, 201, JSON.stringify(generate.body).slice(0, 300));
  assert.equal(generate.body.data.snapshot.revenue.achieved, 3300, "report snapshot carries the derived mission truth");
  assert.equal(generate.body.data.duplicatePrevented, false);
  const replay = await call(leadershipRoute.POST, "POST", { action: "generate_report", missionId, periodType: "mission", idempotencyKey: "run-1" });
  assert.equal(replay.body.data.duplicatePrevented, true, "same idempotency key never creates a second run");
  const directory = await call(leadershipRoute.GET, "GET", `missionId=${missionId}`);
  assert.equal(directory.status, 200);
  assert.equal(directory.body.runs.length, 1);
});

// ---- 4. Revenue intelligence worklist (the sales page's interaction contract) -------------------

test("real execution: revenue-intelligence actions are labeled estimates and the claim→complete flow is enforced", async () => {
  freshDb(); seedCanonical();
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'uat_customer_app',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,created_at,updated_at) VALUES ('cus_1','blr','Anita Rao','9876543210',?,?)").run(NOW, NOW);
  // First GET creates the governance tables; the customer has no marketing consent yet, so the
  // derived action is suppressed — grant consent, then the next refresh must surface it as ready.
  const suppressedPass = await call(intelligenceRoute.GET, "GET");
  assert.equal(suppressedPass.status, 200, JSON.stringify(suppressedPass.body).slice(0, 300));
  const suppressed = suppressedPass.body.data.actions.find((row) => String(row.customer_id) === "cus_1");
  assert.equal(String(suppressed.status), "suppressed", "no marketing consent -> suppressed, never silently workable");
  const blocked = await call(intelligenceRoute.POST, "POST", { action: "claim", id: suppressed.id });
  assert.equal(blocked.status, 409, "suppressed actions cannot be claimed");
  sqlite.prepare("INSERT INTO customer_contact_preferences (customer_id,marketing_consent,service_consent,whatsapp_consent,sms_consent,email_consent,source,updated_by,updated_at) VALUES ('cus_1',1,1,1,0,0,'customer','uat',?)").run(NOW);
  const list = await call(intelligenceRoute.GET, "GET");
  assert.equal(list.status, 200, JSON.stringify(list.body).slice(0, 300));
  assert.equal(list.body.data.estimateOnly, true, "the worklist is explicitly labeled as an estimate");
  assert.equal(list.body.data.marginStatus, "configuration_required");
  const action = list.body.data.actions.find((row) => String(row.customer_id) === "cus_1");
  assert.ok(action, "a governed action derives from the seeded canonical customer");
  const signals = JSON.parse(String(action.signals_json));
  assert.equal(signals.estimateOnly, true);
  // Complete before claim must 409 (the sales page only shows Complete once claimed).
  const early = await call(intelligenceRoute.POST, "POST", { action: "complete", id: action.id });
  assert.equal(early.status, 409);
  const claim = await call(intelligenceRoute.POST, "POST", { action: "claim", id: action.id });
  assert.equal(claim.status, 200);
  assert.equal(claim.body.status, "claimed");
  const complete = await call(intelligenceRoute.POST, "POST", { action: "complete", id: action.id, outcome: "staff_completed" });
  assert.equal(complete.status, 200);
  assert.equal(complete.body.status, "completed");
  // Claimed/completed status survives the per-GET refresh (regression: refresh must not reset it).
  const after = await call(intelligenceRoute.GET, "GET");
  const refreshed = after.body.data.actions.find((row) => row.id === action.id);
  assert.equal(String(refreshed.status), "completed");
});

// ---- 5. Contract tests --------------------------------------------------------------------------

const gatewaySource = fs.readFileSync("lib/api-gateway.ts", "utf8");
const routeSources = {
  "revenue-intelligence": fs.readFileSync("app/api/revenue-intelligence/route.ts", "utf8"),
  "revenue-mission-control": fs.readFileSync("app/api/revenue-mission-control/route.ts", "utf8"),
  "revenue-mission-command-center": fs.readFileSync("app/api/revenue-mission-command-center/route.ts", "utf8"),
  "revenue-leadership-reporting": fs.readFileSync("app/api/revenue-leadership-reporting/route.ts", "utf8"),
};

test("permission mapping: every route's authorize() matches the gateway exactly (gateway untouched)", () => {
  // Gateway truth (read-only assertion — this task does not modify api-gateway.ts):
  assert.match(gatewaySource, /if\(url\.pathname==="\/api\/revenue-intelligence"\)return method==="GET"\?"customers\.view":"customers\.manage";/);
  assert.match(gatewaySource, /if\(url\.pathname==="\/api\/revenue-mission-control"\)return method==="GET"\?"reports\.view":"customers\.manage";/);
  assert.match(gatewaySource, /if\(url\.pathname==="\/api\/revenue-mission-command-center"\)return "reports\.view";/);
  assert.match(gatewaySource, /if\(url\.pathname==="\/api\/revenue-leadership-reporting"\)return method==="GET"\?"reports\.view":"customers\.manage";/);
  // Route-side second gate must agree:
  const expectations = [
    ["revenue-intelligence", /export async function GET[\s\S]*?authorize\(request,"customers\.view"\)/, /export async function POST[\s\S]*?authorize\(request,"customers\.manage"\)/],
    ["revenue-mission-control", /export async function GET[\s\S]*?authorize\(request,"reports\.view"\)/, /export async function POST[\s\S]*?authorize\(request,"customers\.manage"\)/],
    ["revenue-mission-command-center", /export async function GET[\s\S]*?authorize\(request,"reports\.view"\)/, null],
    ["revenue-leadership-reporting", /export async function GET[\s\S]*?authorize\(request,"reports\.view"\)/, /export async function POST[\s\S]*?authorize\(request,"customers\.manage"\)/],
  ];
  for (const [name, getPattern, postPattern] of expectations) {
    assert.match(routeSources[name], getPattern, `${name} GET permission`);
    if (postPattern) assert.match(routeSources[name], postPattern, `${name} POST permission`);
    else assert.doesNotMatch(routeSources[name], /export async function POST/, `${name} is read-only`);
  }
});

test("no invented numbers remain: fabricated leaderboard array gone, no Math.random, estimates labeled", () => {
  const crmSource = fs.readFileSync("app/api/revenue-crm/route.ts", "utf8");
  assert.doesNotMatch(crmSource, /28750|27400|19850|23900/, "the fixed demo leaderboard array is removed");
  assert.doesNotMatch(crmSource, /\*\s*\.08\s*\+\s*1250/, "the invented incentive formula is removed");
  assert.match(crmSource, /payment_reconciliation_records/, "collections come from canonical payment truth");
  assert.match(crmSource, /b\.status NOT IN \('cancelled','draft'\)/, "booked value uses the P&L revenue predicate");
  assert.match(crmSource, /currentDailyRevenueTarget/, "targets come from governed configuration, not constants");
  for (const [name, source] of Object.entries(routeSources)) assert.doesNotMatch(source, /Math\.random\(\)\s*\*\s*\d/, `${name} has no fabricated numeric jitter`);
  const intelligence = fs.readFileSync("lib/revenue-intelligence.ts", "utf8");
  assert.match(intelligence, /estimateOnly:true/);
  assert.match(intelligence, /marginStatus:"configuration_required"/);
  const missionControl = fs.readFileSync("lib/revenue-mission-control.ts", "utf8");
  assert.match(missionControl, /status NOT IN \('cancelled','draft'\)/, "mission backfill excludes cancelled/draft bookings");
});

test("team pages render only API data — no residual demo arrays, interactions match the API contract", () => {
  const missionPage = fs.readFileSync("app/team/revenue-mission/page.tsx", "utf8");
  const salesPage = fs.readFileSync("app/team/sales/page.tsx", "utf8");
  const dailyPage = fs.readFileSync("app/team/daily-revenue/page.tsx", "utf8");
  // Every number on the mission page maps to an API field.
  assert.match(missionPage, /fetch\("\/api\/revenue-mission-command-center"/);
  for (const token of ["revenue?.target", "revenue?.achieved", "revenue?.gap", "pipeline?.weightedPipeline", "queue?.slaBreached"]) assert.ok(missionPage.includes(token), `mission page renders ${token} from the API`);
  // Sales page: worklist buttons follow the server state machine (ready→Claim, claimed→Complete).
  assert.match(salesPage, /fetch\("\/api\/revenue-intelligence"/);
  assert.match(salesPage, /String\(a\.status\)==="ready"&&/, "Claim renders only for ready actions");
  assert.match(salesPage, /String\(a\.status\)==="claimed"&&/, "Complete renders only for claimed actions");
  // Daily revenue page: target and progress come from the API, not local constants.
  assert.match(dailyPage, /b\.stats\.dailyTarget/);
  assert.match(dailyPage, /targetProgressPercent/);
  // No demo/mock arrays with fabricated figures in any of the three pages.
  for (const [name, source] of [["mission", missionPage], ["sales", salesPage], ["daily", dailyPage]]) {
    assert.doesNotMatch(source, /const\s+(demo|mock|sample|fake)\w*\s*=/i, `${name} page has no demo fixtures`);
    assert.doesNotMatch(source, /=\s*\[\s*\[\s*["'][A-Z][a-z]+["']\s*,\s*\d{4,}/, `${name} page has no inline name/amount demo matrix`);
  }
});

test("routes reach D1 via cloudflare:workers only — never globalThis", () => {
  for (const [name, source] of Object.entries(routeSources)) {
    assert.doesNotMatch(source, /globalThis/, name);
  }
  const crmSource = fs.readFileSync("app/api/revenue-crm/route.ts", "utf8");
  assert.doesNotMatch(crmSource, /globalThis/);
  assert.match(fs.readFileSync("lib/server-auth.ts", "utf8"), /await import\("cloudflare:workers"\)/);
});
