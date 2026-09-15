/*
 * Money actions the API supported that NO SCREEN POSTED.
 *
 * Ten actions across three routes were reachable only with curl. Nothing was broken about them -
 * they simply had no control, which for the first three means the whole incentive engine was dark:
 *
 *   /api/incentives          save_scheme, activate_scheme, calculate
 *        No .tsx posted any of them, so there was no incentive_scheme_versions row, and without an
 *        ACTIVE scheme calculateIncentivePeriod refuses with "Active incentive scheme is required".
 *        With no period there is no result, so approve_result, dispute, resolve_dispute, adjust,
 *        approve_adjustment and reverse - every control the Incentives screen already had - had
 *        nothing to act on either. The screen said so: "Use the incentives API directly."
 *
 *   /api/people-finance      configure_account, link_expense, post_payroll_journal,
 *                            save_statutory_policy, create_statutory_export,
 *                            record_bank_reconciliation
 *        ALL SIX unposted. The Finance screen rendered the RESULTS of these actions and offered no
 *        way to perform one, so an approved payroll run could not be posted to Finance from the
 *        product at all.
 *
 *   /api/service-incentives  rank_groomers
 *        A read-only computation (rankGroomersForMonth writes nothing) that decides which head
 *        groomer won the month and what the winner bonus is at that rank.
 *
 * TRIAGE: every one of the ten is a HUMAN action. worker/index.ts's `scheduled()` handler calls none
 * of these functions - that is asserted below against the real source - and each one carries
 * something only a person supplies: an approval reference, a written reason, a business formula, or
 * the choice of which people to compare.
 *
 * Everything here EXECUTES: the real route handlers run against a real SQLite-backed D1, and each
 * request body is built by the exported builder the button on the screen uses, so what is proven is
 * the payload the control actually posts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";

installWorkersHooks("__W2B_CONTROLS_DB__", "__W2B_CONTROLS_ENV__");
delete process.env.PAWSPACE_DEPLOYMENT_ENV;

const incentiveRoute = await import("../app/api/incentives/route.ts");
const financeRoute = await import("../app/api/people-finance/route.ts");
const serviceRoute = await import("../app/api/service-incentives/route.ts");
const incentiveScreen = await import("../app/team/people/incentives/page.tsx");
const financeScreen = await import("../app/team/people/finance/page.tsx");
const serviceScreen = await import("../app/team/people/service-incentives/page.tsx");
const payroll = await import("../lib/payroll-engine.ts");
const people = await import("../lib/people-foundation.ts");
const productivity = await import("../lib/sales-productivity-governance.ts");
const financeIntegration = await import("../lib/people-finance-integration.ts");
const incentiveEngine = await import("../lib/incentive-engine.ts");
const { ensureSecurityTables } = await import("../lib/server-auth.ts");
const React = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");

const NOW = Date.UTC(2026, 1, 2);
const JULY_START = Date.UTC(2026, 6, 1);
const JULY_END = Date.UTC(2026, 6, 31);
const JULY_RUN_END = JULY_END + 1;
const HR = "hr@pawspace.in";
const MANAGER = "manager@pawspace.in";
const MAKER = "payroll.maker@pawspace.in";
const REVIEWER = "payroll.reviewer@pawspace.in";
const APPROVER = "cfo@pawspace.in";

function world() {
  const harness = freshCountingD1();
  globalThis.__W2B_CONTROLS_DB__ = harness.db;
  globalThis.__W2B_CONTROLS_ENV__ = {};
  return harness;
}
/* The preview operator: a local preview host, which lib/development-preview.ts triple-gates. */
const preview = (path, body) => new Request(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
/* A real workspace staff identity, so a role's real permissions decide. */
const asRole = (path, email, body) => new Request(`https://app.pawspace.in${path}`, { method: "POST", headers: { "content-type": "application/json", "oai-authenticated-user-email": email }, body: JSON.stringify(body) });

const postIncentive = (body) => incentiveRoute.POST(preview("/api/incentives", body));
const postFinance = (body) => financeRoute.POST(preview("/api/people-finance", body));
const postService = (body) => serviceRoute.POST(preview("/api/service-incentives", body));
const financeDirectory = async () => (await (await financeRoute.GET(new Request("http://localhost/api/people-finance"))).json()).data;

/** Post a builder's output, asserting it is postable at all, and return the parsed response. */
async function submit(poster, built, label) {
  assert.equal(built.ok, true, `${label}: the screen refused its own draft - ${built.ok ? "" : built.error}`);
  const response = await poster(built.body);
  const body = await response.json();
  return { status: response.status, body, error: body.error };
}
const count = (sqlite, table, where = "1=1", ...args) => Number(sqlite.prepare(`SELECT COUNT(*) c FROM ${table} WHERE ${where}`).get(...args).c);

// =============================================================================================
// TRIAGE: none of the ten is machine-driven.
// =============================================================================================

test("no scheduled worker performs any of these ten actions - a human operator is the actor", () => {
  const scheduler = readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");
  const scheduled = scheduler.slice(scheduler.indexOf("async scheduled("));
  assert.ok(scheduled.length > 500, "the scheduled() handler must actually be found, or this proves nothing");
  for (const fn of [
    "saveIncentiveScheme", "activateIncentiveScheme", "calculateIncentivePeriod",
    "configurePayrollAccountMapping", "linkExpenseToEmployee", "postPayrollJournal",
    "saveStatutoryPolicy", "createSandboxStatutoryExport", "recordSandboxBankReconciliation",
    "rankGroomersForMonth",
  ]) assert.ok(!scheduled.includes(fn), `${fn} is called from the cron handler - it would not need a screen control`);
  // And the control belongs on the screen that owns the money: each is posted by exactly one page.
  const incentivePage = readFileSync(new URL("../app/team/people/incentives/page.tsx", import.meta.url), "utf8");
  const financePage = readFileSync(new URL("../app/team/people/finance/page.tsx", import.meta.url), "utf8");
  const servicePage = readFileSync(new URL("../app/team/people/service-incentives/page.tsx", import.meta.url), "utf8");
  for (const action of ["save_scheme", "activate_scheme", "calculate"]) assert.ok(incentivePage.includes(action), action);
  for (const action of ["configure_account", "link_expense", "post_payroll_journal", "save_statutory_policy", "create_statutory_export", "record_bank_reconciliation"]) assert.ok(financePage.includes(action), action);
  assert.ok(servicePage.includes("rank_groomers"), "rank_groomers");
});

// =============================================================================================
// 1. INCENTIVES - the blocked one. Scheme -> activation -> calculation -> an approvable result.
// =============================================================================================

function seedRep(sqlite, { employeeId, email, netCollectedRevenue, bookedRevenue = 0 }) {
  sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,'sales_associate','active',?,?)")
    .run(`USR-${employeeId}`, email, `Rep ${employeeId}`, NOW, NOW);
  sqlite.prepare("INSERT INTO employees (id,user_email,employee_code,display_name,work_email,employment_status,joined_at,created_at,updated_at) VALUES (?,?,?,?,?,'active',?,?,?)")
    .run(employeeId, email, `EMP-${employeeId}`, `Rep ${employeeId}`, email, NOW, NOW, NOW);
  sqlite.prepare("INSERT INTO employee_employment_versions (id,employee_id,version,effective_from,effective_until,employment_type,title,team_code,reason,actor_id,created_at) VALUES (?,?,1,?,NULL,'direct_employee','Sales associate','sales_blr',?,?,?)")
    .run(`EEV-${employeeId}`, employeeId, NOW, "Initial employment record", MANAGER, NOW);
  sqlite.prepare("INSERT INTO sales_productivity_fact_runs (id,idempotency_key,policy_id,policy_version,period_start,period_end,status,source_contract_version,generated_by,generated_at,detail_json) VALUES (?,?,?,1,?,?,'completed','v1',?,?,'{}')")
    .run(`SPR-${employeeId}`, `run-${employeeId}`, "SPP-1", JULY_START, JULY_END, "facts@pawspace.in", NOW);
  sqlite.prepare("INSERT INTO sales_productivity_facts (id,run_id,employee_email,team_code,period_start,period_end,leads_assigned,assignments_accepted,meaningful_actions,qualified_leads,first_response_clocks,first_response_met,first_response_breached,booking_conversions,booked_revenue,collected_revenue,refunds,net_collected_revenue,cx_escalations,opt_out_or_consent_blocks,data_quality_blocks,source_detail_json,created_at) VALUES (?,?,?,'sales_blr',?,?,0,0,0,0,0,0,0,0,?,?,0,?,0,0,0,'{}',?)")
    .run(`SPF-${employeeId}`, `SPR-${employeeId}`, email, JULY_START, JULY_END, bookedRevenue, netCollectedRevenue, netCollectedRevenue, NOW);
}

async function incentiveWorld() {
  const w = world();
  w.sqlite.exec("CREATE TABLE IF NOT EXISTS app_users (id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,name TEXT NOT NULL,role_code TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  await people.ensurePeopleTables(w.db);
  await productivity.ensureSalesProductivityTables(w.db);
  await incentiveEngine.ensureIncentiveTables(w.db);
  await ensureSecurityTables(w.db);
  seedRep(w.sqlite, { employeeId: "E-REP", email: "rep@pawspace.in", netCollectedRevenue: 200000, bookedRevenue: 1500000 });
  // A SECOND human identity, because the engine refuses the calculator's own approval - and through
  // the route the calculator is whoever pressed Calculate.
  w.sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('U-APPROVER','approver@pawspace.in','Approver','founder','active',?,?)").run(NOW, NOW);
  return w;
}

/** The exact draft an operator types into the new Create-scheme form. */
const SCHEME_DRAFT = {
  ...incentiveScreen.EMPTY_SCHEME_DRAFT,
  schemeCode: "SALES-BLR", roleCode: "sales_associate", teamCode: "sales_blr",
  effectiveFrom: "2026-07-01", effectiveUntil: "2026-12-31",
  metric: "net_collected_revenue", payoutType: "percent_of_revenue_above_target",
  target: "100000", payoutValue: "5", cap: "8000",
  guardrails: [{ metric: "refunds", operator: "gt", threshold: "0", action: "multiplier", multiplier: "0.5" }],
};

test("the Incentives screen can now create, activate and calculate a scheme - end to end, real route", async () => {
  const w = await incentiveWorld();

  // (a) Create. The whole engine was unreachable without this row.
  const saved = await submit(postIncentive, incentiveScreen.schemeDraftPayload(SCHEME_DRAFT), "save_scheme");
  assert.equal(saved.status, 200, `save_scheme: ${saved.error}`);
  const schemeId = String(saved.body.data.id);
  assert.equal(String(saved.body.data.status), "draft");
  assert.equal(Number(saved.body.data.version), 1);
  const storedFormula = JSON.parse(String(w.sqlite.prepare("SELECT formula_json FROM incentive_scheme_versions WHERE id=?").get(schemeId).formula_json));
  assert.deepEqual(storedFormula, { metric: "net_collected_revenue", target: 100000, payoutType: "percent_of_revenue_above_target", payoutValue: 5, cap: 8000 },
    "the configuration the operator typed is the configuration the engine stores");
  assert.deepEqual(JSON.parse(String(w.sqlite.prepare("SELECT quality_rules_json FROM incentive_scheme_versions WHERE id=?").get(schemeId).quality_rules_json)),
    [{ metric: "refunds", operator: "gt", threshold: 0, action: "multiplier", multiplier: 0.5 }]);

  // A draft cannot be calculated - which is exactly why activation needed a control too.
  const tooEarly = await submit(postIncentive, incentiveScreen.calculatePeriodPayload({ schemeId, schemeCode: "SALES-BLR", periodStart: "2026-07-01", periodEnd: "2026-07-31" }), "calculate before activation");
  assert.equal(tooEarly.status, 409);
  assert.equal(tooEarly.error, "Active incentive scheme is required");

  // (b) Activate, with the approval reference that authorised it.
  const activated = await submit(postIncentive, incentiveScreen.activateSchemePayload({ schemeId, approvalReference: "BOARD-2026-07" }), "activate_scheme");
  assert.equal(activated.status, 200, `activate_scheme: ${activated.error}`);
  assert.equal(String(activated.body.data.status), "active_uat");
  assert.equal(String(activated.body.data.approval_reference), "BOARD-2026-07");

  // (c) Calculate. The number is the operator's configuration, applied to the collected facts.
  const calculated = await submit(postIncentive, incentiveScreen.calculatePeriodPayload({ schemeId, schemeCode: "SALES-BLR", periodStart: "2026-07-01", periodEnd: "2026-07-31" }), "calculate");
  assert.equal(calculated.status, 200, `calculate: ${calculated.error}`);
  assert.equal(calculated.body.data.duplicatePrevented, false);
  assert.equal(calculated.body.data.results.length, 1);
  const result = calculated.body.data.results[0];
  assert.equal(Number(result.metric_value), 200000, "Rs15,00,000 of booked pipeline is not part of the metric");
  assert.equal(Number(result.calculated_amount), 5000, "(200000 - 100000) x 5%, under the configured cap of 8000");

  // The derived idempotency key means a double-clicked Calculate returns the SAME period.
  const again = await submit(postIncentive, incentiveScreen.calculatePeriodPayload({ schemeId, schemeCode: "SALES-BLR", periodStart: "2026-07-01", periodEnd: "2026-07-31" }), "calculate twice");
  assert.equal(again.body.data.duplicatePrevented, true, "a second click must not create a second period against the same money");
  assert.equal(count(w.sqlite, "employee_incentive_periods"), 1);
  assert.equal(count(w.sqlite, "employee_incentive_results"), 1);

  // (d) And the controls that already existed now have something to act on - still governed: the
  // operator who pressed Calculate is the `calculated_by` the engine refuses to let approve it.
  const selfApproval = await postIncentive({ action: "approve_result", resultId: String(result.id) });
  assert.equal(selfApproval.status, 409);
  assert.equal((await selfApproval.json()).error, "Incentive calculator cannot approve their own result");
  assert.equal(Number(w.sqlite.prepare("SELECT approved_amount FROM employee_incentive_results WHERE id=?").get(String(result.id)).approved_amount), 0);

  const approved = await incentiveRoute.POST(asRole("/api/incentives", "approver@pawspace.in", { action: "approve_result", resultId: String(result.id) }));
  assert.equal(approved.status, 200, "the screen's existing Approve control was unreachable until a scheme existed");
  assert.equal(Number(w.sqlite.prepare("SELECT approved_amount FROM employee_incentive_results WHERE id=?").get(String(result.id)).approved_amount), 5000);

  // Every mutation is audited under its own action name - including the second Calculate, which is a
  // real request that was answered, and the refused one before activation, which was not.
  for (const [action, times] of [["incentive.save_scheme", 1], ["incentive.activate_scheme", 1], ["incentive.calculate", 2], ["incentive.approve_result", 1]])
    assert.equal(count(w.sqlite, "security_audit_events", "action=?", action), times, action);
});

test("the create-scheme control refuses an incomplete draft itself, and the engine's refusal reaches the operator verbatim", async () => {
  const w = await incentiveWorld();

  // Nothing is pre-filled, so an untouched form is refused rather than posting invented defaults.
  const empty = incentiveScreen.schemeDraftPayload(incentiveScreen.EMPTY_SCHEME_DRAFT);
  assert.equal(empty.ok, false);
  assert.equal(empty.error, "Scheme code, role code and team code are required");
  for (const [patch, expected] of [
    [{ schemeCode: "S", roleCode: "r", teamCode: "t" }, "An effective-from date is required"],
    [{ schemeCode: "S", roleCode: "r", teamCode: "t", effectiveFrom: "2026-07-01" }, "Choose the metric this scheme pays on"],
    [{ schemeCode: "S", roleCode: "r", teamCode: "t", effectiveFrom: "2026-07-01", metric: "qualified_leads" }, "Choose how the payout is calculated"],
    [{ schemeCode: "S", roleCode: "r", teamCode: "t", effectiveFrom: "2026-07-01", metric: "qualified_leads", payoutType: "percent_of_revenue_above_target" }, "Revenue percentage formula requires a canonical revenue metric"],
    [{ schemeCode: "S", roleCode: "r", teamCode: "t", effectiveFrom: "2026-07-01", metric: "qualified_leads", payoutType: "flat_on_target" }, "An explicit non-negative target is required"],
    [{ schemeCode: "S", roleCode: "r", teamCode: "t", effectiveFrom: "2026-07-01", metric: "qualified_leads", payoutType: "flat_on_target", target: "0" }, "An explicit non-negative payout value is required"],
    [{ schemeCode: "S", roleCode: "r", teamCode: "t", effectiveFrom: "2026-07-01", effectiveUntil: "2026-06-01", metric: "qualified_leads", payoutType: "flat_on_target", target: "0", payoutValue: "1" }, "Scheme end date must follow start date"],
  ]) {
    const built = incentiveScreen.schemeDraftPayload({ ...incentiveScreen.EMPTY_SCHEME_DRAFT, ...patch });
    assert.equal(built.ok, false, JSON.stringify(patch));
    assert.equal(built.error, expected);
  }
  assert.equal(count(w.sqlite, "incentive_scheme_versions"), 0, "a refused draft posts nothing");

  // A guardrail multiplier the engine would refuse is refused by the control in the same words.
  const badGuardrail = incentiveScreen.schemeDraftPayload({ ...SCHEME_DRAFT, guardrails: [{ metric: "refunds", operator: "gt", threshold: "0", action: "multiplier", multiplier: "4" }] });
  assert.equal(badGuardrail.ok, false);
  assert.equal(badGuardrail.error, "Quality multiplier must be explicitly configured between 0 and 1");

  // And an engine refusal the control cannot predict arrives with its own text and its own status.
  const saved = await submit(postIncentive, incentiveScreen.schemeDraftPayload(SCHEME_DRAFT), "save_scheme");
  const schemeId = String(saved.body.data.id);
  await submit(postIncentive, incentiveScreen.activateSchemePayload({ schemeId, approvalReference: "BOARD-2026-07" }), "activate_scheme");
  const immutable = await submit(postIncentive, incentiveScreen.schemeDraftPayload(SCHEME_DRAFT), "save an active scheme again");
  assert.equal(immutable.status, 409);
  assert.equal(immutable.error, "Active incentive scheme is immutable; create a new scheme version after retiring it");
  assert.notEqual(immutable.error, "Incentive update failed");

  const shortReference = incentiveScreen.activateSchemePayload({ schemeId, approvalReference: "x" });
  assert.equal(shortReference.ok, false);
  assert.equal(shortReference.error, "Incentive scheme approval reference is required");

  // Outside the scheme's validity window the engine refuses at 422, verbatim.
  const outside = await submit(postIncentive, incentiveScreen.calculatePeriodPayload({ schemeId, schemeCode: "SALES-BLR", periodStart: "2026-01-01", periodEnd: "2026-01-31" }), "calculate outside validity");
  assert.equal(outside.status, 422);
  assert.equal(outside.error, "Incentive period is outside scheme validity");
});

test("scheme creation is gated on incentives.manage, not on being able to read the screen", async () => {
  const w = await incentiveWorld();
  w.sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('U-AUD','auditor@pawspace.in','auditor','auditor','active',?,?)").run(NOW, NOW);
  const built = incentiveScreen.schemeDraftPayload(SCHEME_DRAFT);
  assert.equal(built.ok, true);
  const denied = await incentiveRoute.POST(asRole("/api/incentives", "auditor@pawspace.in", built.body));
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error, "Permission denied");
  assert.equal(count(w.sqlite, "incentive_scheme_versions"), 0);
});

// =============================================================================================
// 2. PEOPLE FINANCE - all six actions, none of which any screen posted.
// =============================================================================================

async function financeWorld() {
  const w = world();
  w.sqlite.exec("CREATE TABLE IF NOT EXISTS app_users (id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,name TEXT NOT NULL,role_code TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  await financeIntegration.ensurePeopleFinanceTables(w.db);
  await ensureSecurityTables(w.db);
  // One active employee on a Rs60,000 structure, one approved July payroll run, one sandbox batch.
  w.sqlite.prepare("INSERT INTO employees (id,user_email,employee_code,display_name,work_email,employment_status,joined_at,created_at,updated_at) VALUES ('E-1','one@pawspace.in','EMP-001','Asha','one@pawspace.in','active',?,?,?)").run(NOW, NOW, NOW);
  w.sqlite.prepare("INSERT INTO employee_employment_versions (id,employee_id,version,effective_from,effective_until,employment_type,title,team_code,cost_centre_code,reason,actor_id,created_at) VALUES ('EEV-1','E-1',1,?,NULL,'direct_employee','Groomer','ops_blr','CC-OPS','Initial employment record',?,?)").run(NOW, MANAGER, NOW);
  const structure = await payroll.saveSalaryStructure(w.db, { structureCode: "STD", effectiveFrom: NOW, components: [{ code: "BASIC", label: "Basic", kind: "earning", amount: 60000 }], actorId: HR });
  await payroll.assignCompensation(w.db, { employeeId: "E-1", structureId: String(structure.id), effectiveFrom: NOW, reason: "Initial compensation assignment", actorId: HR });
  const run = await payroll.calculatePayroll(w.db, { periodStart: JULY_START, periodEnd: JULY_RUN_END, idempotencyKey: "july", actorId: MAKER });
  const runId = String(run.run.id);
  await payroll.reviewPayroll(w.db, { runId, actorId: REVIEWER });
  await payroll.approvePayroll(w.db, { runId, actorId: APPROVER });
  const batch = await payroll.prepareSandboxPaymentBatch(w.db, { runId, actorId: APPROVER });
  // One unlinked Finance expense in the same month.
  w.sqlite.prepare("INSERT INTO finance_expenses (id,expense_date,claimant,merchant,category,cost_centre,vertical,amount,gst_amount,payment_mode,status,duplicate_risk,created_at,updated_at) VALUES ('EXP-1','2026-07-14','one@pawspace.in','Petrol Bunk','travel','CC-OPS','grooming',1250,0,'upi','submitted',0,?,?)").run(NOW, NOW);
  return { w, runId, batchId: String(batch.id) };
}

const MAPPING_APPROVAL = "FIN-2026-07-APPROVAL";

test("every required payroll account mapping can be configured from the Finance screen", async () => {
  const { w } = await financeWorld();
  const before = await financeDirectory();
  assert.equal(before.truth.payrollJournalConfigured, false);
  assert.equal(before.truth.missingPayrollAccountMappings.length, 6);

  let code = 5000;
  for (const key of before.requiredPayrollAccountKeys) {
    const built = financeScreen.configureAccountPayload({ sourceKey: key, accountCode: `${code++}-${key}`, approvalReference: MAPPING_APPROVAL }, before.requiredPayrollAccountKeys);
    const saved = await submit(postFinance, built, `configure_account ${key}`);
    assert.equal(saved.status, 200, `${key}: ${saved.error}`);
    assert.equal(String(saved.body.data.approval_reference), MAPPING_APPROVAL);
  }
  const after = await financeDirectory();
  assert.equal(after.truth.payrollJournalConfigured, true, "Finance posting is unblocked by the control, not by curl");
  assert.deepEqual(after.truth.missingPayrollAccountMappings, []);
  assert.equal(count(w.sqlite, "people_finance_account_mappings"), 6);
  assert.equal(count(w.sqlite, "security_audit_events", "action='people_finance.configure_account'"), 6);

  // The control refuses a key the engine does not accept, before anything is posted.
  const wrongKey = financeScreen.configureAccountPayload({ sourceKey: "payroll.imaginary", accountCode: "9999", approvalReference: MAPPING_APPROVAL }, after.requiredPayrollAccountKeys);
  assert.equal(wrongKey.ok, false);
  assert.equal(wrongKey.error, "Choose one of the required payroll account keys");
  const shortApproval = financeScreen.configureAccountPayload({ sourceKey: "payroll.net_pay_payable", accountCode: "9999", approvalReference: "ab" }, after.requiredPayrollAccountKeys);
  assert.equal(shortApproval.ok, false);
  assert.equal(shortApproval.error, "Finance approval reference is required");
});

test("an expense can be linked to an employee from the screen, with the reason the engine demands", async () => {
  const { w } = await financeWorld();
  const directory = await financeDirectory();
  assert.deepEqual(directory.unlinkedExpenses.map((x) => String(x.id)), ["EXP-1"], "the control can only offer an expense the directory returns");
  assert.deepEqual(directory.linkableEmployees.map((e) => String(e.id)), ["E-1"]);

  const short = financeScreen.linkExpensePayload({ expenseId: "EXP-1", employeeId: "E-1", reason: "typo" });
  assert.equal(short.ok, false);
  assert.equal(short.error, "A clear expense linkage reason is required");

  const linked = await submit(postFinance, financeScreen.linkExpensePayload({ expenseId: "EXP-1", employeeId: "E-1", reason: "Fuel claim for the July grooming route" }), "link_expense");
  assert.equal(linked.status, 200, linked.error);
  assert.equal(linked.body.data.duplicatePrevented, false);
  const link = w.sqlite.prepare("SELECT * FROM people_expense_links WHERE expense_id='EXP-1'").get();
  assert.equal(String(link.employee_id), "E-1");
  assert.equal(String(link.linkage_status), "linked_uat");
  assert.equal(JSON.parse(String(link.detail_json)).employeeCostCentre, "CC-OPS");
  assert.equal((await financeDirectory()).unlinkedExpenses.length, 0, "a linked expense drops out of the control");

  // Linking somebody else to the same expense is a governed 409, not a redacted 500.
  w.sqlite.prepare("INSERT INTO employees (id,user_email,employee_code,display_name,work_email,employment_status,joined_at,created_at,updated_at) VALUES ('E-2','two@pawspace.in','EMP-002','Bala','two@pawspace.in','active',?,?,?)").run(NOW, NOW, NOW);
  const stolen = await submit(postFinance, financeScreen.linkExpensePayload({ expenseId: "EXP-1", employeeId: "E-2", reason: "Trying to move somebody else's claim" }), "relink");
  assert.equal(stolen.status, 409);
  assert.equal(stolen.error, "Expense already linked; use an explicit correction workflow");
  assert.notEqual(stolen.error, "People Finance update failed");
  assert.equal(String(w.sqlite.prepare("SELECT employee_id FROM people_expense_links WHERE expense_id='EXP-1'").get().employee_id), "E-1");
});

test("an approved payroll run posts to Finance from the screen, and the missing-mapping refusal names the mapping", async () => {
  const { w, runId } = await financeWorld();

  // Before any mapping exists, the refusal must tell the operator WHICH mapping to configure.
  const directoryBefore = await financeDirectory();
  const run = directoryBefore.postableRuns.find((r) => String(r.id) === runId);
  assert.ok(run, "an approved, unposted run must be offered to the control");
  assert.equal(String(run.period_code), "2026-07", "the period is derived from the run, so period_mismatch cannot be produced by hand");
  const unmapped = await submit(postFinance, financeScreen.postPayrollJournalPayload({ runId, periodCode: run.period_code }), "post before mapping");
  assert.equal(unmapped.status, 409);
  assert.match(String(unmapped.error), /^configuration_required: finance account mapping missing for /);
  assert.match(String(unmapped.error), /payroll\.net_pay_payable/);
  assert.notEqual(unmapped.error, "People Finance update failed");
  assert.equal(count(w.sqlite, "finance_journal_entries"), 0);

  let code = 5000;
  for (const key of directoryBefore.requiredPayrollAccountKeys)
    await submit(postFinance, financeScreen.configureAccountPayload({ sourceKey: key, accountCode: `${code++}`, approvalReference: MAPPING_APPROVAL }, directoryBefore.requiredPayrollAccountKeys), key);

  const posted = await submit(postFinance, financeScreen.postPayrollJournalPayload({ runId, periodCode: run.period_code }), "post_payroll_journal");
  assert.equal(posted.status, 200, posted.error);
  assert.equal(posted.body.data.duplicatePrevented, false);
  const post = w.sqlite.prepare("SELECT * FROM people_payroll_finance_posts WHERE payroll_run_id=?").get(runId);
  assert.equal(Number(post.total_debit), 60000);
  assert.equal(Number(post.total_credit), 60000, "the journal balances, to the rupee");
  assert.equal(String(post.period_code), "2026-07");
  const entries = w.sqlite.prepare("SELECT account_code,debit,credit,period_code FROM finance_journal_entries WHERE source_id=? ORDER BY account_code").all(runId);
  assert.equal(entries.length, 2, "one salary expense debit and one net-pay-payable credit");
  assert.equal(entries.reduce((sum, e) => sum + Number(e.debit), 0), 60000);
  assert.equal(entries.reduce((sum, e) => sum + Number(e.credit), 0), 60000);

  // The posted run leaves the control's list, so it cannot be posted twice by hand.
  assert.deepEqual((await financeDirectory()).postableRuns.map((r) => String(r.id)), []);
  const twice = await submit(postFinance, financeScreen.postPayrollJournalPayload({ runId, periodCode: "2026-07" }), "post twice");
  assert.equal(twice.body.data.duplicatePrevented, true, "and the engine refuses to post it twice anyway");
  assert.equal(count(w.sqlite, "finance_journal_entries"), 2);
});

test("a locked Finance period refuses the posting control with period_locked, verbatim", async () => {
  const { w, runId } = await financeWorld();
  const directory = await financeDirectory();
  let code = 5000;
  for (const key of directory.requiredPayrollAccountKeys)
    await submit(postFinance, financeScreen.configureAccountPayload({ sourceKey: key, accountCode: `${code++}`, approvalReference: MAPPING_APPROVAL }, directory.requiredPayrollAccountKeys), key);
  w.sqlite.prepare("INSERT INTO finance_close_periods (period_code,status,checklist_json,locked_at,locked_by,updated_at) VALUES ('2026-07','locked','[]',?,?,?)").run(NOW, APPROVER, NOW);

  const locked = await submit(postFinance, financeScreen.postPayrollJournalPayload({ runId, periodCode: "2026-07" }), "post into a locked period");
  assert.equal(locked.status, 409);
  assert.equal(locked.error, "period_locked", "the operator reads the lock, not a server fault");
  assert.equal(count(w.sqlite, "finance_journal_entries"), 0);
  assert.equal(count(w.sqlite, "people_payroll_finance_posts"), 0);
});

test("a statutory policy version and its sandbox export are both reachable from the screen", async () => {
  const { w, runId } = await financeWorld();

  const notJson = financeScreen.saveStatutoryPolicyPayload({ policyCode: "PT-KA", effectiveFrom: "2026-07-01", config: "not json", approvalReference: "FIN-STAT-1" });
  assert.equal(notJson.ok, false);
  assert.equal(notJson.error, "Statutory configuration must be a JSON object");
  const emptyConfig = financeScreen.saveStatutoryPolicyPayload({ policyCode: "PT-KA", effectiveFrom: "2026-07-01", config: "{}", approvalReference: "FIN-STAT-1" });
  assert.equal(emptyConfig.ok, false);
  assert.equal(emptyConfig.error, "Explicit statutory configuration is required");

  const config = { professionalTax: { monthlySlabs: [{ upTo: 15000, amount: 0 }, { upTo: null, amount: 200 }] } };
  const saved = await submit(postFinance, financeScreen.saveStatutoryPolicyPayload({ policyCode: "PT-KA", effectiveFrom: "2026-07-01", config: JSON.stringify(config), approvalReference: "FIN-STAT-1" }), "save_statutory_policy");
  assert.equal(saved.status, 200, saved.error);
  const policyId = String(saved.body.data.id);
  assert.equal(Number(saved.body.data.version), 1);
  assert.equal(String(saved.body.data.status), "active_uat");
  assert.deepEqual(JSON.parse(String(w.sqlite.prepare("SELECT config_json FROM people_statutory_policy_versions WHERE id=?").get(policyId).config_json)), config,
    "the configuration the operator typed is the configuration that is stored - nothing is defaulted");

  const directory = await financeDirectory();
  const run = directory.postableRuns.find((r) => String(r.id) === runId);
  const exported = await submit(postFinance, financeScreen.createStatutoryExportPayload({ runId, policyVersionId: policyId, periodCode: run.period_code }), "create_statutory_export");
  assert.equal(exported.status, 200, exported.error);
  const record = w.sqlite.prepare("SELECT * FROM people_statutory_exports WHERE payroll_run_id=?").get(runId);
  assert.equal(Number(record.sandbox_only), 1);
  assert.equal(Number(record.external_submission), 0, "a sandbox export must never be submittable");
  const payload = JSON.parse(String(record.payload_json));
  assert.equal(payload.externalSubmission, false);
  assert.equal(payload.submissionReady, false);
  assert.equal(payload.payroll.netPay, 60000);
  assert.equal(payload.policy.approvalReference, "FIN-STAT-1");
  assert.equal((await financeDirectory()).truth.statutoryExternalSubmissionEnabled, false);
});

test("a sandbox bank reconciliation is recorded from the screen and transmits nothing", async () => {
  const { w, batchId } = await financeWorld();
  const directory = await financeDirectory();
  const batch = directory.reconcilableBatches.find((b) => String(b.id) === batchId);
  assert.ok(batch, "an unreconciled sandbox batch must be offered to the control");
  assert.equal(Number(batch.total_amount), 60000);
  assert.equal(String(batch.period_code), "2026-07");

  const shortReference = financeScreen.recordBankReconciliationPayload({ payrollBatchId: batchId, periodCode: "2026-07", sandboxReference: "ab", matchedAmount: "60000" });
  assert.equal(shortReference.ok, false);
  assert.equal(shortReference.error, "Sandbox reconciliation reference is required");
  const negative = financeScreen.recordBankReconciliationPayload({ payrollBatchId: batchId, periodCode: "2026-07", sandboxReference: "SBX-REF-0001", matchedAmount: "-5" });
  assert.equal(negative.ok, false);
  assert.equal(negative.error, "Matched amount must be zero or positive");

  const originalFetch = globalThis.fetch;
  const attempts = [];
  globalThis.fetch = (...args) => { attempts.push(args[0]); throw new Error("reconciliation must not transmit"); };
  let recorded;
  try {
    recorded = await submit(postFinance, financeScreen.recordBankReconciliationPayload({ payrollBatchId: batchId, periodCode: batch.period_code, sandboxReference: "SBX-REF-0001", matchedAmount: "60000" }), "record_bank_reconciliation");
  } finally { globalThis.fetch = originalFetch; }
  assert.deepEqual(attempts, [], "recording a reconciliation made an outbound request");
  assert.equal(recorded.status, 200, recorded.error);
  const row = w.sqlite.prepare("SELECT * FROM people_bank_reconciliation_refs WHERE payroll_batch_id=?").get(batchId);
  assert.equal(String(row.status), "matched_uat");
  assert.equal(Number(row.expected_amount), 60000);
  assert.equal(Number(row.matched_amount), 60000);
  assert.equal(Number(row.external_transmission), 0);
  assert.equal(Number(row.sandbox_only), 1);
  assert.deepEqual((await financeDirectory()).reconcilableBatches.map((b) => String(b.id)), [], "a reconciled batch drops out of the control");

  // A variance is an exception, not a reconciliation - and it is refused as a correction, not silently overwritten.
  const changed = await submit(postFinance, financeScreen.recordBankReconciliationPayload({ payrollBatchId: batchId, periodCode: "2026-07", sandboxReference: "SBX-REF-0002", matchedAmount: "55000" }), "re-record");
  assert.equal(changed.status, 409);
  assert.equal(changed.error, "Reconciliation already recorded; use an explicit correction workflow");
});

test("all six People Finance controls are gated on finance.manage, not on finance.view", async () => {
  const { w } = await financeWorld();
  w.sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('U-ADM','admin@pawspace.in','admin','admin','active',?,?)").run(NOW, NOW);
  const readable = await financeRoute.GET(new Request("https://app.pawspace.in/api/people-finance", { headers: { "oai-authenticated-user-email": "admin@pawspace.in" } }));
  assert.equal(readable.status, 200, "admin holds finance.view and may read the screen");

  for (const body of [
    { action: "configure_account", sourceKey: "payroll.net_pay_payable", accountCode: "1", approvalReference: "FIN-1234" },
    { action: "link_expense", expenseId: "EXP-1", employeeId: "E-1", reason: "A clear enough reason" },
    { action: "post_payroll_journal", runId: "PAYRUN-1", periodCode: "2026-07" },
    { action: "save_statutory_policy", policyCode: "PT-KA", effectiveFrom: JULY_START, config: { a: 1 }, approvalReference: "FIN-1234" },
    { action: "create_statutory_export", runId: "PAYRUN-1", policyVersionId: "STATPOL-1", periodCode: "2026-07" },
    { action: "record_bank_reconciliation", payrollBatchId: "BATCH-1", periodCode: "2026-07", sandboxReference: "SBX-0001", matchedAmount: 1 },
  ]) {
    const denied = await financeRoute.POST(asRole("/api/people-finance", "admin@pawspace.in", body));
    assert.equal(denied.status, 403, `${body.action}: expected 403, got ${denied.status}`);
    assert.equal((await denied.json()).error, "Permission denied", body.action);
  }
  assert.equal(count(w.sqlite, "people_finance_account_mappings"), 0);
  assert.equal(count(w.sqlite, "people_expense_links"), 0);
  assert.equal(count(w.sqlite, "people_statutory_policy_versions"), 0);
});

// =============================================================================================
// 3. SERVICE INCENTIVES - rank_groomers.
// =============================================================================================

test("the month's groomer ranking and its winner bonuses are reachable from the screen", async () => {
  const w = world();
  w.sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,service_code TEXT NOT NULL,package_name TEXT,provider_id TEXT,status TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT,total_amount REAL NOT NULL,currency TEXT DEFAULT 'INR',created_at INTEGER,updated_at INTEGER)");
  const booking = (id, groomer, amount, day) => w.sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,service_code,provider_id,status,scheduled_start,total_amount,created_at,updated_at) VALUES (?,?, 'grooming',?,'completed',?,?,?,?)")
    .run(id, `CUS-${id}`, groomer, `2026-08-${day}T09:00:00.000Z`, amount, NOW, NOW);
  // GRM-A finishes Rs1,50,000 against a Rs1,00,000 target (150%); GRM-B Rs2,00,000 against Rs2,00,000 (100%).
  booking("BK-A", "GRM-A", 150000, "05");
  booking("BK-B", "GRM-B", 200000, "06");

  for (const id of ["GRM-A", "GRM-B"]) {
    const bracket = await postService({ action: "save_groomer_bracket", headGroomerId: id, bracket: "single", effectiveFrom: "2026-08-01", reason: "Single-groomer bracket for August" });
    assert.equal(bracket.status, 200, `bracket ${id}: ${JSON.stringify(await bracket.json())}`);
  }
  for (const [id, target] of [["GRM-A", 100000], ["GRM-B", 200000]]) {
    const saved = await postService({ action: "save_groomer_target", headGroomerId: id, monthStart: "2026-08-01", targetAmount: target, reason: "Monthly target published" });
    assert.equal(saved.status, 200, `target ${id}: ${JSON.stringify(await saved.json())}`);
  }

  // The list the operator types, trailing comma and all: blank entries are dropped by the control,
  // so the route's "Head groomer is required" guard is never reached by a formatting slip.
  const form = { monthStart: "2026-08-01", headGroomerIds: "GRM-A,\n GRM-B ,\n" };
  assert.deepEqual(serviceScreen.rankIds(form.headGroomerIds), ["GRM-A", "GRM-B"]);
  assert.deepEqual(serviceScreen.missingRanking(form), []);
  assert.deepEqual(serviceScreen.missingRanking({ monthStart: "2026-08-01", headGroomerIds: " , \n " }), ["at least one head groomer ID"]);
  assert.deepEqual(serviceScreen.missingRanking({ monthStart: "", headGroomerIds: "GRM-A" }), ["Month"]);

  const response = await postService({ action: "rank_groomers", ...serviceScreen.rankBody(form) });
  assert.equal(response.status, 200);
  const { ranking } = await response.json();
  assert.equal(ranking.length, 2);
  assert.equal(ranking[0].headGroomerId, "GRM-A");
  assert.equal(ranking[0].rank, 1);
  assert.equal(ranking[0].achievementPercent, 150);
  assert.equal(ranking[0].winnerHeadBonus, 8000, "rank 1 in the single bracket pays the configured Rs8,000");
  assert.equal(ranking[0].winnerHelperBonus, 0);
  assert.equal(ranking[1].headGroomerId, "GRM-B");
  assert.equal(ranking[1].rank, 2);
  assert.equal(ranking[1].achievementPercent, 100);
  assert.equal(ranking[1].winnerHeadBonus, 6500);

  // It is a READ: ranking the month writes no incentive result and finalizes nothing.
  assert.equal(count(w.sqlite, "groomer_incentive_results"), 0, "rank_groomers must not create a payable result");
  assert.equal(count(w.sqlite, "groomer_special_incentives"), 0, "and must pay nobody a bonus on its own");
});

// =============================================================================================
// 4. The controls are actually on the screens.
// =============================================================================================

test("each screen renders the control its unposted action needed", () => {
  const incentives = renderToStaticMarkup(React.createElement(incentiveScreen.default));
  assert.match(incentives, /New scheme version/, "the Incentives screen offers scheme creation");
  assert.doesNotMatch(incentives, /Use the incentives API directly/, "the screen must no longer send operators to curl");

  const finance = renderToStaticMarkup(React.createElement(financeScreen.default));
  for (const control of ["Save mapping", "Link expense", "Post payroll journal", "Save statutory policy", "Create sandbox export", "Record reconciliation"])
    assert.ok(finance.includes(control), `the Finance screen must offer "${control}"`);
  assert.match(finance, /Live bank transmission:<\/b> NO/, "and must stay truthful about what it never does");

  const service = renderToStaticMarkup(React.createElement(serviceScreen.default));
  assert.match(service, /Rank the month/, "the Service incentives screen offers the monthly ranking");
  assert.match(service, /writes no row, pays nothing/, "and says that ranking is a read");
});
