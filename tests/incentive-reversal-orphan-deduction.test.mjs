import test from "node:test";
import assert from "node:assert/strict";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";
import { importLibModule } from "./helpers/ts-module-loader.mjs";

/*
 * P0: an incentive reversal must never be deducted from a payslip unless the earning it reverses
 * was itself paid.
 *
 * A FULL reversal flips its source result to 'reversed', which drops that result out of the
 * earnings half of approvedIncentiveEntriesForPayroll. The reversals half only checked that the
 * REVERSAL had no payroll link - never that the RESULT had one - so a result approved and then
 * fully reversed before any payroll run contributed a deduction with no matching earning, and the
 * employee was docked money they had never been paid.
 *
 * These tests execute the real engines against a real SQLite-backed D1 (no source-text assertions,
 * no shared/live database) and pin all four corners: reversed-before-payment, reversed-after-payment
 * (including payment in an EARLIER period), partial reversal, and an ordinary unpaid earning.
 */

const incentive = await importLibModule("incentive-engine");
const people = await importLibModule("people-foundation");
const productivity = await importLibModule("sales-productivity-governance");
const payroll = await importLibModule("payroll-engine");

const NOW = 1770000000000;                      // 2026-02-02, before every period below
const JULY_START = Date.UTC(2026, 6, 1);
const JULY_END = Date.UTC(2026, 6, 31);
const JULY_RUN_END = JULY_END + 1;              // payroll's right edge is exclusive for reversals
const AUG_START = Date.UTC(2026, 7, 1);
const AUG_RUN_END = Date.UTC(2026, 7, 31) + 1;
const MANAGER = "manager@pawspace.in";
const CALCULATOR = "finance@pawspace.in";

async function world() {
  const w = freshCountingD1();
  w.sqlite.exec("CREATE TABLE IF NOT EXISTS app_users (id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,name TEXT NOT NULL,role_code TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  await people.ensurePeopleTables(w.db);
  await productivity.ensureSalesProductivityTables(w.db);
  await incentive.ensureIncentiveTables(w.db);
  return w;
}

/** One active salesperson with a completed productivity fact for July. */
function seedRep(sqlite, { employeeId, email, qualifiedLeads }) {
  sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,'sales_associate','active',?,?)")
    .run(`USR-${employeeId}`, email, `Rep ${employeeId}`, NOW, NOW);
  sqlite.prepare("INSERT INTO employees (id,user_email,employee_code,display_name,work_email,employment_status,joined_at,created_at,updated_at) VALUES (?,?,?,?,?,'active',?,?,?)")
    .run(employeeId, email, `EMP-${employeeId}`, `Rep ${employeeId}`, email, NOW, NOW, NOW);
  sqlite.prepare("INSERT INTO employee_employment_versions (id,employee_id,version,effective_from,effective_until,employment_type,title,team_code,reason,actor_id,created_at) VALUES (?,?,1,?,NULL,'direct_employee','Sales associate','sales_blr',?,?,?)")
    .run(`EEV-${employeeId}`, employeeId, NOW, "Initial employment record", MANAGER, NOW);
  const runId = `SPR-${employeeId}`;
  sqlite.prepare("INSERT INTO sales_productivity_fact_runs (id,idempotency_key,policy_id,policy_version,period_start,period_end,status,source_contract_version,generated_by,generated_at,detail_json) VALUES (?,?,?,1,?,?,'completed','v1',?,?,'{}')")
    .run(runId, `run-${employeeId}`, "SPP-1", JULY_START, JULY_END, CALCULATOR, NOW);
  sqlite.prepare("INSERT INTO sales_productivity_facts (id,run_id,employee_email,team_code,period_start,period_end,leads_assigned,assignments_accepted,meaningful_actions,qualified_leads,first_response_clocks,first_response_met,first_response_breached,booking_conversions,booked_revenue,collected_revenue,refunds,net_collected_revenue,cx_escalations,opt_out_or_consent_blocks,data_quality_blocks,source_detail_json,created_at) VALUES (?,?,?,'sales_blr',?,?,0,0,0,?,0,0,0,0,0,0,0,0,0,0,0,'{}',?)")
    .run(`SPF-${employeeId}`, runId, email, JULY_START, JULY_END, qualifiedLeads, NOW);
  return employeeId;
}

/** A scheme paying a configured amount per qualified lead, so the approved amount is exact. */
async function approvedResult(w, { employeeId, email, qualifiedLeads, payoutPerLead, key }) {
  seedRep(w.sqlite, { employeeId, email, qualifiedLeads });
  const draft = await incentive.saveIncentiveScheme(w.db, {
    schemeCode: `SALES-${employeeId}`, roleCode: "sales_associate", teamCode: "sales_blr",
    effectiveFrom: JULY_START,
    formula: { metric: "qualified_leads", target: 0, payoutType: "amount_per_unit_above_target", payoutValue: payoutPerLead },
    qualityRules: [], actorId: MANAGER,
  });
  await incentive.activateIncentiveScheme(w.db, { schemeId: String(draft.id), approvalReference: "BOARD-2026-07", actorId: MANAGER });
  const run = await incentive.calculateIncentivePeriod(w.db, { schemeId: String(draft.id), periodStart: JULY_START, periodEnd: JULY_END, idempotencyKey: key, actorId: CALCULATOR });
  const resultId = String(run.results.find((r) => String(r.employee_id) === employeeId).id);
  const approved = await incentive.approveIncentiveResult(w.db, { resultId, actorId: MANAGER });
  assert.equal(approved.approvedAmount, qualifiedLeads * payoutPerLead, "approved amount is the configured formula, exactly");
  return resultId;
}

const julyEntries = (w, employeeId) => incentive.approvedIncentiveEntriesForPayroll(w.db, { employeeId, periodStart: JULY_START, periodEnd: JULY_RUN_END });
const augustEntries = (w, employeeId) => incentive.approvedIncentiveEntriesForPayroll(w.db, { employeeId, periodStart: AUG_START, periodEnd: AUG_RUN_END });

// ---------------------------------------------------------------------------
// (a) THE DEFECT: reversed before ever being paid -> no earning AND no deduction.
// ---------------------------------------------------------------------------
test("a result fully reversed before any payroll run contributes nothing to payroll, ever", async () => {
  const w = await world();
  const resultId = await approvedResult(w, { employeeId: "E-ORPHAN", email: "orphan@pawspace.in", qualifiedLeads: 1, payoutPerLead: 550, key: "orphan-1" });

  // Reversed in two slices, exactly as UATD-IRES-2 was (200 + 350 against 550), before payroll ran.
  await incentive.reverseIncentiveResult(w.db, { resultId, amount: 200, reason: "Customer refunded part of the booking before payout", effectiveAt: JULY_END, actorId: MANAGER });
  await incentive.reverseIncentiveResult(w.db, { resultId, amount: 350, reason: "Remaining clawback before the incentive was ever paid", effectiveAt: JULY_END, actorId: MANAGER });
  assert.equal(w.sqlite.prepare("SELECT status FROM employee_incentive_results WHERE id=?").get(resultId).status, "reversed");
  assert.equal(Number(w.sqlite.prepare("SELECT COUNT(*) c FROM incentive_reversals WHERE result_id=?").get(resultId).c), 2);

  const entries = await julyEntries(w, "E-ORPHAN");
  assert.deepEqual(entries, [], `nothing was ever paid, so nothing may be clawed back - got ${JSON.stringify(entries)}`);

  // And it must not surface later either: the money was never paid in any period.
  assert.deepEqual(await augustEntries(w, "E-ORPHAN"), [], "an unpaid reversal must not resurface in a later payroll period");
});

test("payroll for an employee whose only incentive was reversed before payment pays exactly the salary", async () => {
  const w = await world();
  const resultId = await approvedResult(w, { employeeId: "E-NETPAY", email: "netpay@pawspace.in", qualifiedLeads: 1, payoutPerLead: 2100, key: "netpay-1" });
  await incentive.reverseIncentiveResult(w.db, { resultId, amount: 2100, reason: "Full reversal before the incentive reached a payslip", effectiveAt: JULY_END, actorId: MANAGER });

  const structure = await payroll.saveSalaryStructure(w.db, { structureCode: "STD", effectiveFrom: NOW, components: [{ code: "BASIC", label: "Basic", kind: "earning", amount: 52200 }], actorId: "hr@pawspace.in" });
  await payroll.assignCompensation(w.db, { employeeId: "E-NETPAY", structureId: String(structure.id), effectiveFrom: NOW, reason: "Initial compensation assignment", actorId: "hr@pawspace.in" });

  const run = await payroll.calculatePayroll(w.db, { periodStart: JULY_START, periodEnd: JULY_RUN_END, idempotencyKey: "netpay-run-1", actorId: "payroll@pawspace.in" });
  const result = run.results.find((r) => String(r.employee_id) === "E-NETPAY");
  assert.equal(Number(result.net_pay), 52200, "an incentive that never reached a payslip may not be deducted from one");
  assert.equal(Number(result.total_deductions), 0);
  const lines = w.sqlite.prepare("SELECT component_code,kind,amount FROM payroll_result_lines WHERE result_id=? ORDER BY component_code").all(String(result.id));
  assert.deepEqual(lines.map((l) => String(l.component_code)), ["BASIC"], "no INCENTIVE_REVERSAL line without a matching INCENTIVE line");
});

// ---------------------------------------------------------------------------
// (b) THE LEGITIMATE CLAWBACK: paid first, reversed after - deduction must still land,
//     including when the payment happened in an EARLIER payroll period.
// ---------------------------------------------------------------------------
test("a result paid in an earlier period and reversed afterwards still produces its clawback deduction", async () => {
  const w = await world();
  const resultId = await approvedResult(w, { employeeId: "E-CLAW", email: "claw@pawspace.in", qualifiedLeads: 4, payoutPerLead: 2500, key: "claw-1" });

  const july = await julyEntries(w, "E-CLAW");
  assert.equal(july.length, 1);
  assert.equal(july[0].kind, "earning");
  assert.equal(july[0].amount, 10000);
  await incentive.markIncentiveEntriesIncluded(w.db, { entries: july, payrollRunId: "PR-JUL", payrollResultId: "PRR-JUL", employeeId: "E-CLAW" });

  // Reversed in full in August, a period after the one that paid it.
  await incentive.reverseIncentiveResult(w.db, { resultId, amount: 10000, reason: "Customer refunded the booking after the incentive was paid", effectiveAt: AUG_START + 86400000, actorId: MANAGER });
  assert.equal(w.sqlite.prepare("SELECT status FROM employee_incentive_results WHERE id=?").get(resultId).status, "reversed");

  const august = await augustEntries(w, "E-CLAW");
  assert.equal(august.length, 1, "a reversal of money actually paid must still be deducted");
  assert.equal(august[0].kind, "deduction");
  assert.equal(august[0].sourceType, "incentive_reversal");
  assert.equal(august[0].amount, 10000);

  // And exactly once.
  await incentive.markIncentiveEntriesIncluded(w.db, { entries: august, payrollRunId: "PR-AUG", payrollResultId: "PRR-AUG", employeeId: "E-CLAW" });
  assert.deepEqual(await augustEntries(w, "E-CLAW"), [], "a clawback already deducted is never offered to payroll again");
});

// ---------------------------------------------------------------------------
// (c) PARTIAL reversal: result stays 'approved', so earning and deduction land in the SAME run.
// ---------------------------------------------------------------------------
test("a partial reversal before payment still emits earning and deduction together and nets correctly", async () => {
  const w = await world();
  const resultId = await approvedResult(w, { employeeId: "E-PARTIAL", email: "partial@pawspace.in", qualifiedLeads: 4, payoutPerLead: 2500, key: "partial-1" });
  await incentive.reverseIncentiveResult(w.db, { resultId, amount: 3000, reason: "Partial refund on one of the bookings", effectiveAt: JULY_END, actorId: MANAGER });
  assert.equal(w.sqlite.prepare("SELECT status FROM employee_incentive_results WHERE id=?").get(resultId).status, "approved", "a partial reversal leaves the result approved");

  const entries = await julyEntries(w, "E-PARTIAL");
  assert.equal(entries.length, 2, `earning and deduction must land in the same run - got ${JSON.stringify(entries)}`);
  const earning = entries.find((e) => e.kind === "earning"), deduction = entries.find((e) => e.kind === "deduction");
  assert.equal(earning.amount, 10000);
  assert.equal(deduction.amount, 3000);
  assert.equal(earning.amount - deduction.amount, 7000, "the payslip nets to the incentive actually owed");

  await incentive.markIncentiveEntriesIncluded(w.db, { entries, payrollRunId: "PR-P", payrollResultId: "PRR-P", employeeId: "E-PARTIAL" });
  assert.deepEqual(await julyEntries(w, "E-PARTIAL"), [], "both sides are linked once and never re-offered");

  // A second partial reversal after payment is a real clawback and must land on the next run.
  await incentive.reverseIncentiveResult(w.db, { resultId, amount: 2000, reason: "Second refund on the same paid incentive", effectiveAt: AUG_START + 86400000, actorId: MANAGER });
  const august = await augustEntries(w, "E-PARTIAL");
  assert.equal(august.length, 1);
  assert.equal(august[0].kind, "deduction");
  assert.equal(august[0].amount, 2000);
});

// ---------------------------------------------------------------------------
// (d) The ordinary case still works: an approved, unreversed, unpaid result is an earning.
// ---------------------------------------------------------------------------
test("a normal approved unpaid incentive is still offered to payroll as an earning, exactly once", async () => {
  const w = await world();
  await approvedResult(w, { employeeId: "E-PLAIN", email: "plain@pawspace.in", qualifiedLeads: 3, payoutPerLead: 1000, key: "plain-1" });

  const entries = await julyEntries(w, "E-PLAIN");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, "earning");
  assert.equal(entries[0].sourceType, "incentive_result");
  assert.equal(entries[0].amount, 3000);
  assert.match(entries[0].policyVersion, /^incentive_scheme:SALES-E-PLAIN:v1$/);

  await incentive.markIncentiveEntriesIncluded(w.db, { entries, payrollRunId: "PR-X", payrollResultId: "PRR-X", employeeId: "E-PLAIN" });
  assert.deepEqual(await julyEntries(w, "E-PLAIN"), [], "an incentive already paid is never offered to payroll again");
});
