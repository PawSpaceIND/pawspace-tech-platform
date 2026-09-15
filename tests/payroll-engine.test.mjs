/*
 * Payroll: EXECUTED, not grepped.
 *
 * Every assertion in the previous version of this file was
 * `assert.match(readFileSync("lib/payroll-engine.ts"), /some string/)`. Six tests, twenty-eight
 * assertions, zero lines of payroll executed. The whole file passes against an engine that pays the
 * wrong number, pays the same incentive twice, or lets the person who created a run approve it - as
 * long as the strings are still in the source. This is the module that computes what people are PAID.
 *
 * Every claim the old file made is kept and proved by running the real engine against a real
 * SQLite-backed D1 (tests/helpers/d1-harness.mjs), loaded with its whole transitive lib/ graph by
 * tests/helpers/ts-module-loader.mjs. The old claim is named above each section and the new
 * assertion is on a NUMBER or a stored row, never on the presence of a token:
 *
 *   "idempotency_key ... UNIQUE" / "duplicatePrevented:true" -> run the same key twice: ONE run, ONE
 *                                                               result, ONE payslip, ONE set of lines.
 *   "configuration_required: compensation assignment missing" -> the refusal reaches the operator as a
 *                                                               409 carrying its own reason through the
 *                                                               real authError(), and writes nothing.
 *   "Negative net pay requires explicit exception policy"    -> a structure that nets below zero is
 *                                                               refused at 422, with no run row.
 *   "Maker/reviewer cannot approve their own payroll run"    -> a real run by real, distinct actors:
 *                                                               maker refused, reviewer refused, a third
 *                                                               approver succeeds, events match.
 *   "external_transmission ... DEFAULT 0" / "sandbox_prepared" -> the batch row is 0, and a fetch spy
 *                                                               records that NOTHING left the process.
 *   no "0.12"/"0.18"/"professionalTaxRate"                   -> a BASIC-only structure deducts exactly
 *                                                               0.00: no invented statutory number.
 *   payroll API permission separation                        -> the REAL route handler, driven as four
 *                                                               real roles, refuses and allows per action.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";
import { importLibModule } from "./helpers/ts-module-loader.mjs";

// Only the route section at the bottom needs the Worker shim; the engine sections run the transpiled
// module graph directly. Registered before any `.ts` import, which is what the hook requires.
installWorkersHooks("__PAYROLL_ENGINE_ROUTE_DB__", "__PAYROLL_ENGINE_ROUTE_ENV__");
delete process.env.PAWSPACE_DEPLOYMENT_ENV;

const payroll = await importLibModule("payroll-engine");
const incentive = await importLibModule("incentive-engine");
const people = await importLibModule("people-foundation");
const productivity = await importLibModule("sales-productivity-governance");
const { authError, ensureSecurityTables } = await importLibModule("server-auth");
const route = await import("../app/api/payroll/route.ts");

const NOW = Date.UTC(2026, 1, 2);
const JULY_START = Date.UTC(2026, 6, 1);
const JULY_END = Date.UTC(2026, 6, 31);
const JULY_RUN_END = JULY_END + 1;              // payroll's right edge is exclusive
const AUG_START = Date.UTC(2026, 7, 1);
const AUG_RUN_END = Date.UTC(2026, 7, 31) + 1;

const HR = "hr@pawspace.in";
const MAKER = "payroll.maker@pawspace.in";
const REVIEWER = "payroll.reviewer@pawspace.in";
const APPROVER = "cfo@pawspace.in";
const MANAGER = "manager@pawspace.in";
const CALCULATOR = "incentive.calculator@pawspace.in";

const PAYROLL_FALLBACK = "Payroll update failed";   // the real catch-block fallback of app/api/payroll/route.ts

async function world() {
  const w = freshCountingD1();
  w.sqlite.exec("CREATE TABLE IF NOT EXISTS app_users (id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,name TEXT NOT NULL,role_code TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  await people.ensurePeopleTables(w.db);
  await productivity.ensureSalesProductivityTables(w.db);
  await incentive.ensureIncentiveTables(w.db);
  await payroll.ensurePayrollTables(w.db);
  return w;
}

/** One active employee, optionally with a completed July productivity fact. */
function seedEmployee(sqlite, { employeeId, email, teamCode = "sales_blr", qualifiedLeads = null }) {
  sqlite.prepare("INSERT OR IGNORE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,'sales_associate','active',?,?)")
    .run(`USR-${employeeId}`, email, `Rep ${employeeId}`, NOW, NOW);
  sqlite.prepare("INSERT INTO employees (id,user_email,employee_code,display_name,work_email,employment_status,joined_at,created_at,updated_at) VALUES (?,?,?,?,?,'active',?,?,?)")
    .run(employeeId, email, `EMP-${employeeId}`, `Rep ${employeeId}`, email, NOW, NOW, NOW);
  sqlite.prepare("INSERT INTO employee_employment_versions (id,employee_id,version,effective_from,effective_until,employment_type,title,team_code,reason,actor_id,created_at) VALUES (?,?,1,?,NULL,'direct_employee','Sales associate',?,?,?,?)")
    .run(`EEV-${employeeId}`, employeeId, NOW, teamCode, "Initial employment record", MANAGER, NOW);
  if (qualifiedLeads !== null) {
    const runId = `SPR-${employeeId}`;
    sqlite.prepare("INSERT INTO sales_productivity_fact_runs (id,idempotency_key,policy_id,policy_version,period_start,period_end,status,source_contract_version,generated_by,generated_at,detail_json) VALUES (?,?,?,1,?,?,'completed','v1',?,?,'{}')")
      .run(runId, `run-${employeeId}`, "SPP-1", JULY_START, JULY_END, CALCULATOR, NOW);
    sqlite.prepare("INSERT INTO sales_productivity_facts (id,run_id,employee_email,team_code,period_start,period_end,leads_assigned,assignments_accepted,meaningful_actions,qualified_leads,first_response_clocks,first_response_met,first_response_breached,booking_conversions,booked_revenue,collected_revenue,refunds,net_collected_revenue,cx_escalations,opt_out_or_consent_blocks,data_quality_blocks,source_detail_json,created_at) VALUES (?,?,?,?,?,?,0,0,0,?,0,0,0,0,0,0,0,0,0,0,0,'{}',?)")
      .run(`SPF-${employeeId}`, runId, email, teamCode, JULY_START, JULY_END, qualifiedLeads, NOW);
  }
  return employeeId;
}

/** Give an employee a salary structure and a compensation assignment. Returns the structure row. */
async function compensate(w, { employeeId, structureCode, components, effectiveFrom = NOW }) {
  const structure = await payroll.saveSalaryStructure(w.db, { structureCode, effectiveFrom, components, actorId: HR });
  await payroll.assignCompensation(w.db, { employeeId, structureId: String(structure.id), effectiveFrom, reason: "Initial compensation assignment", actorId: HR });
  return structure;
}

/** Refuse the way the route does: catch it and hand it to the REAL authError(). */
async function surfaced(work, fallback = PAYROLL_FALLBACK) {
  const thrown = await Promise.resolve().then(work).then(() => null, (error) => error);
  assert.ok(thrown, "the call was expected to be refused but resolved");
  const response = authError(thrown, fallback);
  return { thrown, response, status: response.status, error: (await response.json()).error };
}

const count = (sqlite, table, where = "1=1", ...args) => Number(sqlite.prepare(`SELECT COUNT(*) c FROM ${table} WHERE ${where}`).get(...args).c);
const rows = (sqlite, sql, ...args) => sqlite.prepare(sql).all(...args);

// ---------------------------------------------------------------------------------------------
// 1. Idempotency, the snapshot, and the absence of any invented statutory number.
//    Old claims: /idempotency_key TEXT NOT NULL UNIQUE/, /input_snapshot_json/, /duplicatePrevented:true/,
//    /source_snapshot_json/, /policy_version/, and !src.includes("0.12"|"0.18"|"professionalTaxRate").
// ---------------------------------------------------------------------------------------------

test("the same payroll idempotency key run twice produces ONE result and reports duplicatePrevented", async () => {
  const w = await world();
  seedEmployee(w.sqlite, { employeeId: "E-IDEM", email: "idem@pawspace.in" });
  await compensate(w, { employeeId: "E-IDEM", structureCode: "STD-IDEM", components: [{ code: "BASIC", label: "Basic", kind: "earning", amount: 60000 }] });

  const first = await payroll.calculatePayroll(w.db, { periodStart: JULY_START, periodEnd: JULY_RUN_END, idempotencyKey: "july-2026", actorId: MAKER });
  assert.equal(first.duplicatePrevented, false);
  assert.equal(first.results.length, 1);
  assert.equal(Number(first.results[0].net_pay), 60000);

  const second = await payroll.calculatePayroll(w.db, { periodStart: JULY_START, periodEnd: JULY_RUN_END, idempotencyKey: "july-2026", actorId: MAKER });
  assert.equal(second.duplicatePrevented, true, "a repeated key must report that it prevented a duplicate");
  assert.equal(String(second.run.id), String(first.run.id), "the same key must return the SAME run, not a new one");
  assert.equal(second.results.length, 1);
  assert.equal(Number(second.results[0].net_pay), 60000);

  // The thing that actually matters: nobody is paid twice.
  assert.equal(count(w.sqlite, "payroll_runs"), 1);
  assert.equal(count(w.sqlite, "employee_payroll_results"), 1);
  assert.equal(count(w.sqlite, "payslips"), 1);
  assert.equal(count(w.sqlite, "payroll_result_lines"), 1);
  assert.equal(Number(w.sqlite.prepare("SELECT COALESCE(SUM(net_pay),0) t FROM employee_payroll_results").get().t), 60000);
});

test("a payroll run snapshots the configuration it used and invents no statutory deduction", async () => {
  const w = await world();
  seedEmployee(w.sqlite, { employeeId: "E-SNAP", email: "snap@pawspace.in" });
  const structure = await compensate(w, { employeeId: "E-SNAP", structureCode: "STD-SNAP", components: [{ code: "BASIC", label: "Basic", kind: "earning", amount: 50000 }] });

  const run = await payroll.calculatePayroll(w.db, { periodStart: JULY_START, periodEnd: JULY_RUN_END, idempotencyKey: "snap-1", actorId: MAKER });
  const snapshot = JSON.parse(String(run.run.input_snapshot_json));
  assert.equal(snapshot.statutoryPolicy, "configuration_required", "the run records that statutory policy is NOT configured, rather than inventing one");
  assert.equal(snapshot.incentivePolicy, "approved_source_entries_only");
  assert.equal(snapshot.bankTransmission, false);
  assert.equal(snapshot.periodStart, JULY_START);
  assert.equal(snapshot.employees.length, 1);

  const result = run.results[0];
  const source = JSON.parse(String(result.source_snapshot_json));
  assert.equal(source.structureId, String(structure.id), "the result carries the exact structure it was computed from");
  assert.equal(Number(source.structureVersion), 1);
  assert.equal(source.components[0].amount, 50000);

  const lines = rows(w.sqlite, "SELECT * FROM payroll_result_lines WHERE result_id=?", String(result.id));
  assert.equal(lines.length, 1);
  assert.equal(String(lines[0].policy_version), "salary_structure:1", "every line names the policy version that produced it");
  assert.equal(String(lines[0].source_type), "salary_structure");

  // The real test of "no invented statutory fallback": the number.
  assert.equal(Number(result.gross_earnings), 50000);
  assert.equal(Number(result.total_deductions), 0, "no PF, PT or TDS may be conjured from a rate nobody configured");
  assert.equal(Number(result.employer_cost), 0);
  assert.equal(Number(result.net_pay), 50000);

  const payslip = w.sqlite.prepare("SELECT * FROM payslips WHERE run_id=?").get(String(run.run.id));
  assert.equal(String(payslip.employee_id), "E-SNAP");
  assert.equal(String(payslip.status), "available_uat");
});

test("compensation is versioned and payroll pays the version effective in the period", async () => {
  const w = await world();
  seedEmployee(w.sqlite, { employeeId: "E-VER", email: "ver@pawspace.in" });
  const v1 = await payroll.saveSalaryStructure(w.db, { structureCode: "STD-VER", effectiveFrom: NOW, components: [{ code: "BASIC", label: "Basic", kind: "earning", amount: 40000 }], actorId: HR });
  const v2 = await payroll.saveSalaryStructure(w.db, { structureCode: "STD-VER", effectiveFrom: JULY_START, components: [{ code: "BASIC", label: "Basic", kind: "earning", amount: 60000 }], actorId: HR });
  assert.equal(Number(v1.version), 1);
  assert.equal(Number(v2.version), 2);
  assert.equal(Number(w.sqlite.prepare("SELECT effective_until FROM salary_structure_versions WHERE id=?").get(String(v1.id)).effective_until), JULY_START - 1,
    "the prior version is closed the day before the new one begins");

  await payroll.assignCompensation(w.db, { employeeId: "E-VER", structureId: String(v1.id), effectiveFrom: NOW, reason: "Initial compensation assignment", actorId: HR });
  await payroll.assignCompensation(w.db, { employeeId: "E-VER", structureId: String(v2.id), effectiveFrom: JULY_START, reason: "Annual revision effective July", actorId: HR });
  assert.equal(count(w.sqlite, "employee_compensation_assignments", "employee_id='E-VER'"), 2);

  const run = await payroll.calculatePayroll(w.db, { periodStart: JULY_START, periodEnd: JULY_RUN_END, idempotencyKey: "ver-1", actorId: MAKER });
  assert.equal(Number(run.results[0].net_pay), 60000, "July must be paid on the version effective in July, not the superseded one");
  assert.equal(String(w.sqlite.prepare("SELECT policy_version FROM payroll_result_lines WHERE result_id=?").get(String(run.results[0].id)).policy_version), "salary_structure:2");

  const directory = await payroll.payrollDirectory(w.db);
  assert.equal(directory.structures.length, 2);
  assert.equal(directory.runs.length, 1);
  assert.equal(directory.truth.statutoryPolicyConfigured, false);
  assert.equal(directory.truth.bankTransmissionEnabled, false);
  assert.equal(directory.truth.approvedRunImmutable, true);
  assert.equal(directory.truth.productionReady, false);
});

// ---------------------------------------------------------------------------------------------
// 2. Configuration gaps refuse, and the refusal is a governed 4xx the operator can act on.
//    Old claim: /configuration_required: compensation assignment missing/.
// ---------------------------------------------------------------------------------------------

test("a missing compensation assignment refuses with configuration_required as a governed 409, not a 500", async () => {
  const w = await world();
  seedEmployee(w.sqlite, { employeeId: "E-NOCOMP", email: "nocomp@pawspace.in" });

  const { thrown, status, error, response } = await surfaced(() =>
    payroll.calculatePayroll(w.db, { periodStart: JULY_START, periodEnd: JULY_RUN_END, idempotencyKey: "nocomp-1", actorId: MAKER }));

  // Still an Error, so `assert.rejects(fn,/regex/)` in the pre-existing suites keeps matching.
  assert.ok(thrown instanceof Error, "a refusal pinned by assert.rejects must stay an Error object");
  assert.match(String(thrown), /configuration_required: compensation assignment missing for E-NOCOMP/);
  // And a governed client error, so the operator reads the gap instead of a redacted server fault.
  assert.equal(status, 409, `a configuration gap is the operator's answer, not a 500 - got ${status}`);
  assert.equal(error, "configuration_required: compensation assignment missing for E-NOCOMP");
  assert.notEqual(error, PAYROLL_FALLBACK, "the generic fallback would tell the operator nothing they can fix");
  assert.equal(response.headers.get("cache-control"), "no-store");

  assert.equal(count(w.sqlite, "payroll_runs"), 0, "a refused calculation must leave no run behind");
  assert.equal(count(w.sqlite, "employee_payroll_results"), 0);
  assert.equal(count(w.sqlite, "payslips"), 0);
});

test("an assignment pointing at a structure that is not effective in the period refuses the same way", async () => {
  const w = await world();
  seedEmployee(w.sqlite, { employeeId: "E-NOSTRUCT", email: "nostruct@pawspace.in" });
  const future = await payroll.saveSalaryStructure(w.db, { structureCode: "STD-FUTURE", effectiveFrom: Date.UTC(2027, 0, 1), components: [{ code: "BASIC", label: "Basic", kind: "earning", amount: 70000 }], actorId: HR });
  await payroll.assignCompensation(w.db, { employeeId: "E-NOSTRUCT", structureId: String(future.id), effectiveFrom: NOW, reason: "Assignment ahead of the structure window", actorId: HR });

  const { status, error } = await surfaced(() =>
    payroll.calculatePayroll(w.db, { periodStart: JULY_START, periodEnd: JULY_RUN_END, idempotencyKey: "nostruct-1", actorId: MAKER }));
  assert.equal(status, 409);
  assert.equal(error, "configuration_required: salary structure missing for E-NOSTRUCT");
  assert.equal(count(w.sqlite, "payroll_runs"), 0);
});

test("negative net pay refuses at 422 without an explicit exception policy, and writes no run", async () => {
  const w = await world();
  seedEmployee(w.sqlite, { employeeId: "E-NEG", email: "neg@pawspace.in" });
  await compensate(w, {
    employeeId: "E-NEG", structureCode: "STD-NEG",
    components: [
      { code: "BASIC", label: "Basic", kind: "earning", amount: 1000 },
      { code: "LOAN", label: "Loan recovery", kind: "deduction", amount: 5000 },
    ],
  });

  const { thrown, status, error } = await surfaced(() =>
    payroll.calculatePayroll(w.db, { periodStart: JULY_START, periodEnd: JULY_RUN_END, idempotencyKey: "neg-1", actorId: MAKER }));
  assert.ok(thrown instanceof Error);
  assert.equal(status, 422, "a payslip that would owe the company money is refused, not silently paid");
  assert.equal(error, "Negative net pay requires explicit exception policy for E-NEG");
  assert.equal(count(w.sqlite, "payroll_runs"), 0);
  assert.equal(count(w.sqlite, "employee_payroll_results"), 0);
});

// ---------------------------------------------------------------------------------------------
// 3. Maker/checker, on a real run, with three real actor identities.
//    Old claim: /Maker\/reviewer cannot approve their own payroll run/ plus /created_by/, /reviewed_by/.
// ---------------------------------------------------------------------------------------------

test("neither the payroll maker nor the reviewer can approve the run they touched", async () => {
  const w = await world();
  seedEmployee(w.sqlite, { employeeId: "E-MC", email: "mc@pawspace.in" });
  await compensate(w, { employeeId: "E-MC", structureCode: "STD-MC", components: [{ code: "BASIC", label: "Basic", kind: "earning", amount: 55000 }] });

  const run = await payroll.calculatePayroll(w.db, { periodStart: JULY_START, periodEnd: JULY_RUN_END, idempotencyKey: "mc-1", actorId: MAKER });
  const runId = String(run.run.id);
  assert.equal(String(run.run.created_by), MAKER);
  assert.equal(String(run.run.status), "calculated");

  // The maker cannot review their own run.
  const selfReview = await surfaced(() => payroll.reviewPayroll(w.db, { runId, actorId: MAKER }));
  assert.equal(selfReview.status, 409);
  assert.equal(selfReview.error, "Payroll maker cannot review their own run");
  assert.equal(String(w.sqlite.prepare("SELECT status FROM payroll_runs WHERE id=?").get(runId).status), "calculated", "a refused review must not move the run");

  // An approval before any review is refused too.
  const early = await surfaced(() => payroll.approvePayroll(w.db, { runId, actorId: APPROVER }));
  assert.equal(early.status, 409);
  assert.equal(early.error, "Only reviewed payroll can be approved");

  await payroll.reviewPayroll(w.db, { runId, actorId: REVIEWER });
  const reviewed = w.sqlite.prepare("SELECT * FROM payroll_runs WHERE id=?").get(runId);
  assert.equal(String(reviewed.status), "reviewed");
  assert.equal(String(reviewed.reviewed_by), REVIEWER);

  // Maker refused, reviewer refused - the two identities recorded on the run.
  const makerApproves = await surfaced(() => payroll.approvePayroll(w.db, { runId, actorId: MAKER }));
  assert.equal(makerApproves.status, 409);
  assert.equal(makerApproves.error, "Maker/reviewer cannot approve their own payroll run");
  const reviewerApproves = await surfaced(() => payroll.approvePayroll(w.db, { runId, actorId: REVIEWER }));
  assert.equal(reviewerApproves.status, 409);
  assert.equal(reviewerApproves.error, "Maker/reviewer cannot approve their own payroll run");
  assert.equal(String(w.sqlite.prepare("SELECT status FROM payroll_runs WHERE id=?").get(runId).status), "reviewed", "two refused approvals leave the run unapproved");

  // A third, independent identity can.
  await payroll.approvePayroll(w.db, { runId, actorId: APPROVER });
  const approved = w.sqlite.prepare("SELECT * FROM payroll_runs WHERE id=?").get(runId);
  assert.equal(String(approved.status), "approved");
  assert.equal(String(approved.approved_by), APPROVER);

  // The audit trail holds exactly the two events that really happened.
  const events = rows(w.sqlite, "SELECT event_type,actor_id FROM payroll_approval_events WHERE run_id=? ORDER BY created_at,event_type", runId);
  assert.deepEqual(events.map((e) => [String(e.event_type), String(e.actor_id)]), [["reviewed", REVIEWER], ["approved", APPROVER]]);
});

// ---------------------------------------------------------------------------------------------
// 4. The sandbox payment batch, and the claim that nothing leaves the process.
//    Old claims: /external_transmission INTEGER NOT NULL DEFAULT 0/, /sandbox_prepared/,
//    /externalTransmission:false/.
// ---------------------------------------------------------------------------------------------

test("the sandbox payment batch records external_transmission=0 and transmits nothing", async () => {
  const w = await world();
  seedEmployee(w.sqlite, { employeeId: "E-PAY", email: "pay@pawspace.in" });
  await compensate(w, { employeeId: "E-PAY", structureCode: "STD-PAY", components: [{ code: "BASIC", label: "Basic", kind: "earning", amount: 48250.5 }] });
  const run = await payroll.calculatePayroll(w.db, { periodStart: JULY_START, periodEnd: JULY_RUN_END, idempotencyKey: "pay-1", actorId: MAKER });
  const runId = String(run.run.id);

  // Payment preparation before approval is refused - the batch cannot outrun maker/checker.
  const early = await surfaced(() => payroll.prepareSandboxPaymentBatch(w.db, { runId, actorId: APPROVER }));
  assert.equal(early.status, 409);
  assert.equal(early.error, "Approved payroll is required before payment preparation");
  assert.equal(count(w.sqlite, "payroll_payment_batches"), 0);

  await payroll.reviewPayroll(w.db, { runId, actorId: REVIEWER });
  await payroll.approvePayroll(w.db, { runId, actorId: APPROVER });

  // Nothing may leave this process while a "payment" is prepared.
  const originalFetch = globalThis.fetch;
  const attempts = [];
  globalThis.fetch = (...args) => { attempts.push(args[0]); throw new Error("payroll must not transmit to a bank"); };
  let batch;
  try {
    batch = await payroll.prepareSandboxPaymentBatch(w.db, { runId, actorId: APPROVER });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(attempts, [], "sandbox payment preparation made an outbound request");

  assert.equal(batch.status, "sandbox_prepared");
  assert.equal(batch.externalTransmission, false);
  const row = w.sqlite.prepare("SELECT * FROM payroll_payment_batches WHERE id=?").get(String(batch.id));
  assert.equal(Number(row.external_transmission), 0, "a batch row that could transmit is the defect this column exists to prevent");
  assert.equal(String(row.status), "sandbox_prepared");
  assert.equal(Number(row.instruction_count), 1);
  assert.equal(Number(row.total_amount), 48250.5, "the batch totals the net pay it prepared, to the paisa");
  assert.equal(String(w.sqlite.prepare("SELECT status FROM payroll_runs WHERE id=?").get(runId).status), "payment_prepared");

  const event = w.sqlite.prepare("SELECT * FROM payroll_approval_events WHERE run_id=? AND event_type='payment_prepared'").get(runId);
  assert.equal(JSON.parse(String(event.detail_json)).totalAmount, 48250.5);
  assert.equal((await payroll.payrollDirectory(w.db)).truth.bankTransmissionEnabled, false);
});

// ---------------------------------------------------------------------------------------------
// 5. Approved incentives enter payroll exactly once; a reversal is an explicit deduction.
//    Old claims: /approvedIncentiveEntriesForPayroll/, /markIncentiveEntriesIncluded/,
//    /entry\.kind==="earning"/, /INCENTIVE_REVERSAL/, /incentivePolicy:"approved_source_entries_only"/.
// ---------------------------------------------------------------------------------------------

/** An approved incentive worth exactly `leads * payoutPerLead` for one employee. */
async function approvedIncentive(w, { employeeId, email, leads, payoutPerLead }) {
  seedEmployee(w.sqlite, { employeeId, email, qualifiedLeads: leads });
  const draft = await incentive.saveIncentiveScheme(w.db, {
    schemeCode: `SCHEME-${employeeId}`, roleCode: "sales_associate", teamCode: "sales_blr", effectiveFrom: JULY_START,
    formula: { metric: "qualified_leads", target: 0, payoutType: "amount_per_unit_above_target", payoutValue: payoutPerLead },
    qualityRules: [], actorId: MANAGER,
  });
  await incentive.activateIncentiveScheme(w.db, { schemeId: String(draft.id), approvalReference: "BOARD-2026-07", actorId: MANAGER });
  const period = await incentive.calculateIncentivePeriod(w.db, { schemeId: String(draft.id), periodStart: JULY_START, periodEnd: JULY_END, idempotencyKey: `inc-${employeeId}`, actorId: CALCULATOR });
  const resultId = String(period.results.find((r) => String(r.employee_id) === employeeId).id);
  const approved = await incentive.approveIncentiveResult(w.db, { resultId, actorId: MANAGER });
  assert.equal(approved.approvedAmount, leads * payoutPerLead);
  return resultId;
}

test("an approved incentive enters payroll exactly once, however many runs are calculated", async () => {
  const w = await world();
  await approvedIncentive(w, { employeeId: "E-ONCE", email: "once@pawspace.in", leads: 4, payoutPerLead: 2500 });
  await compensate(w, { employeeId: "E-ONCE", structureCode: "STD-ONCE", components: [{ code: "BASIC", label: "Basic", kind: "earning", amount: 50000 }] });

  const first = await payroll.calculatePayroll(w.db, { periodStart: JULY_START, periodEnd: JULY_RUN_END, idempotencyKey: "once-a", actorId: MAKER });
  assert.equal(Number(first.results[0].gross_earnings), 60000, "50,000 salary + the 10,000 approved incentive");
  assert.equal(Number(first.results[0].net_pay), 60000);

  // A second run over the NEXT period - a new key, a genuinely new run, not the idempotent replay.
  const second = await payroll.calculatePayroll(w.db, { periodStart: AUG_START, periodEnd: AUG_RUN_END, idempotencyKey: "once-b", actorId: MAKER });
  assert.equal(second.duplicatePrevented, false, "this must be a real second run, or the test proves nothing");
  assert.equal(Number(second.results[0].net_pay), 50000, "the incentive was already paid; the second run pays salary only");

  assert.equal(count(w.sqlite, "payroll_result_lines", "component_code='INCENTIVE'"), 1, "the earning line must exist exactly once across every run");
  const line = w.sqlite.prepare("SELECT * FROM payroll_result_lines WHERE component_code='INCENTIVE'").get();
  assert.equal(String(line.kind), "earning");
  assert.equal(Number(line.amount), 10000);
  assert.match(String(line.policy_version), /^incentive_scheme:SCHEME-E-ONCE:v1$/);

  const links = rows(w.sqlite, "SELECT * FROM incentive_payroll_links WHERE employee_id='E-ONCE'");
  assert.equal(links.length, 1);
  assert.equal(String(links[0].source_type), "incentive_result");
  assert.equal(Number(links[0].amount), 10000, "an earning is linked with a positive amount");
});

test("a reversal of a paid incentive becomes an explicit DEDUCTION line with the right sign and amount", async () => {
  const w = await world();
  const resultId = await approvedIncentive(w, { employeeId: "E-REV", email: "rev@pawspace.in", leads: 4, payoutPerLead: 2500 });
  await compensate(w, { employeeId: "E-REV", structureCode: "STD-REV", components: [{ code: "BASIC", label: "Basic", kind: "earning", amount: 50000 }] });

  const july = await payroll.calculatePayroll(w.db, { periodStart: JULY_START, periodEnd: JULY_RUN_END, idempotencyKey: "rev-july", actorId: MAKER });
  assert.equal(Number(july.results[0].net_pay), 60000, "the incentive is paid first - there is nothing to claw back otherwise");

  await incentive.reverseIncentiveResult(w.db, { resultId, amount: 10000, reason: "Customer refunded the booking after the incentive was paid", effectiveAt: AUG_START + 86400000, actorId: MANAGER });

  const august = await payroll.calculatePayroll(w.db, { periodStart: AUG_START, periodEnd: AUG_RUN_END, idempotencyKey: "rev-aug", actorId: MAKER });
  const result = august.results[0];
  assert.equal(Number(result.total_deductions), 10000);
  assert.equal(Number(result.gross_earnings), 50000);
  assert.equal(Number(result.net_pay), 40000, "the clawback lands on the payslip as 50,000 - 10,000");

  const reversalLines = rows(w.sqlite, "SELECT * FROM payroll_result_lines WHERE component_code='INCENTIVE_REVERSAL'");
  assert.equal(reversalLines.length, 1, "exactly one clawback line, ever");
  assert.equal(String(reversalLines[0].kind), "deduction", "a clawback is a deduction line, not a negative earning");
  assert.equal(Number(reversalLines[0].amount), 10000, "deduction lines carry the amount positively and are subtracted");
  assert.equal(String(reversalLines[0].source_type), "incentive_reversal");

  const link = w.sqlite.prepare("SELECT * FROM incentive_payroll_links WHERE source_type='incentive_reversal'").get();
  assert.equal(Number(link.amount), -10000, "the payroll link records a clawback with a NEGATIVE sign");

  // And it is never deducted twice.
  const again = await payroll.calculatePayroll(w.db, { periodStart: AUG_RUN_END, periodEnd: AUG_RUN_END + 30 * 86_400_000, idempotencyKey: "rev-aug-2", actorId: MAKER });
  assert.equal(Number(again.results[0].net_pay), 50000, "a clawback already deducted must never be deducted again");
  assert.equal(count(w.sqlite, "payroll_result_lines", "component_code='INCENTIVE_REVERSAL'"), 1);
});

// ---------------------------------------------------------------------------------------------
// 6. The REAL route, driven as four real roles: view, manage, approve and compensation.manage are
//    genuinely separate. Old claim: four /authorize\(request, ?"..."\)/ regexes plus a permission list.
// ---------------------------------------------------------------------------------------------

function routeWorld() {
  const harness = freshCountingD1();
  globalThis.__PAYROLL_ENGINE_ROUTE_DB__ = harness.db;
  globalThis.__PAYROLL_ENGINE_ROUTE_ENV__ = {};
  return harness;
}

/* A workspace-identity staff request: the hostname is NOT a preview host, so lib/development-preview.ts
 * refuses the wildcard preview actor and the real role permissions decide. */
const asRole = (email, body) => route.POST(new Request("https://app.pawspace.in/api/payroll", {
  method: "POST",
  headers: { "content-type": "application/json", "oai-authenticated-user-email": email },
  body: JSON.stringify(body),
}));

test("the payroll route separates view, manage, approve and compensation.manage by real role", async () => {
  const harness = routeWorld();
  await ensureSecurityTables(harness.db);      // creates app_users and seeds role_definitions
  await payroll.ensurePayrollTables(harness.db);
  const staff = (email, roleCode) => harness.sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)")
    .run(`U-${roleCode}`, email, roleCode, roleCode, NOW, NOW);
  staff("auditor@pawspace.in", "auditor");     // payroll.view only
  staff("admin@pawspace.in", "admin");         // payroll.view + payroll.approve, no payroll.manage
  staff("finance@pawspace.in", "finance");     // payroll.view + manage + approve, no compensation.manage
  staff("shopper@pawspace.in", "customer");    // no payroll permission at all

  const denied = async (response, label) => {
    assert.equal(response.status, 403, `${label}: expected 403, got ${response.status}`);
    assert.equal((await response.json()).error, "Permission denied", label);
  };

  // The perimeter: no payroll.view, no entry, whatever the action.
  await denied(await asRole("shopper@pawspace.in", { action: "calculate", periodStart: JULY_START, periodEnd: JULY_RUN_END, idempotencyKey: "k" }), "customer calculate");

  // payroll.view alone runs nothing.
  await denied(await asRole("auditor@pawspace.in", { action: "calculate", periodStart: JULY_START, periodEnd: JULY_RUN_END, idempotencyKey: "k" }), "auditor calculate");
  await denied(await asRole("auditor@pawspace.in", { action: "approve", runId: "PAYRUN-X" }), "auditor approve");
  await denied(await asRole("auditor@pawspace.in", { action: "save_structure", structureCode: "S", effectiveFrom: NOW, components: [] }), "auditor save_structure");

  // approve is NOT payroll.manage: admin holds approve without manage.
  await denied(await asRole("admin@pawspace.in", { action: "calculate", periodStart: JULY_START, periodEnd: JULY_RUN_END, idempotencyKey: "k" }), "admin calculate");
  const adminApprove = await asRole("admin@pawspace.in", { action: "approve", runId: "PAYRUN-MISSING" });
  assert.notEqual(adminApprove.status, 403, "payroll.approve must let admin past the permission gate");
  assert.equal(adminApprove.status, 409, "and land on the engine's own rule instead");
  assert.equal((await adminApprove.json()).error, "Only reviewed payroll can be approved");

  // compensation.manage is still its OWN permission, separate from payroll.manage - but it used to be
  // held by no role at all, which left salary structures unversionable by anyone the product could
  // create. The owner granted it to finance, so finance now passes this gate and `admin` - which
  // holds payroll.approve but NOT compensation.manage - is the case that proves the gate still bites.
  const financeStructure = await asRole("finance@pawspace.in", { action: "save_structure", structureCode: "STD", effectiveFrom: NOW, components: [] });
  assert.notEqual(financeStructure.status, 403, "compensation.manage must let finance past the permission gate");
  await denied(await asRole("admin@pawspace.in", { action: "save_structure", structureCode: "STD", effectiveFrom: NOW, components: [{ code: "BASIC", label: "Basic", kind: "earning", amount: 1 }] }), "admin save_structure");
  await denied(await asRole("admin@pawspace.in", { action: "assign_compensation", employeeId: "E", structureId: "S", effectiveFrom: NOW, reason: "A clear reason" }), "admin assign_compensation");
  const financeCalculate = await asRole("finance@pawspace.in", { action: "calculate", periodStart: JULY_RUN_END, periodEnd: JULY_START, idempotencyKey: "" });
  assert.notEqual(financeCalculate.status, 403, "payroll.manage must let finance past the permission gate");
  assert.equal(financeCalculate.status, 400);
  assert.equal((await financeCalculate.json()).error, "Valid payroll period and idempotency key are required");

  assert.equal(count(harness.sqlite, "salary_structure_versions"), 0, "no refused request may have written compensation");
  assert.equal(count(harness.sqlite, "payroll_runs"), 0);
});
