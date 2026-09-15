/*
 * Incentives: EXECUTED, not grepped.
 *
 * The previous version of this file was eight tests of
 * `assert.match(readFileSync("lib/incentive-engine.ts"), /some string/)`. It would have passed in
 * full against an engine that paid on PIPELINE revenue, let the calculator approve their own money,
 * silently edited a finalized result, or fed the same approved incentive into payroll twice - because
 * every one of those defects leaves the matched strings exactly where they are. This is the module
 * that decides variable PAY.
 *
 * Every claim the old file made is kept and proved by running the real engine against a real
 * SQLite-backed D1 (tests/helpers/d1-harness.mjs), loaded with its transitive lib/ graph by
 * tests/helpers/ts-module-loader.mjs. Assertions are on NUMBERS and stored rows:
 *
 *   /sales_productivity_facts/, /pipelineRevenueExcluded:true/ -> two seeded facts, one collected and
 *        one pipeline-only. The collected rep is paid Rs5,000; the rep with Rs50,00,000 of booked
 *        pipeline and nothing collected is paid Rs0. Paying on pipeline would have been Rs2,45,000.
 *   /formula_json/, /quality_rules_json/, /cap\?:number/, /multiplier\?:number/ -> the SAME facts under
 *        five different stored configurations pay 5000, 4000 (cap), 7250 (flat), 2500 (multiplier)
 *        and 0 (zero rule).
 *   /status="held"/, /status='disputed'/, /Only calculated and unheld.../, /cannot approve their own/
 *        -> real approvals refused at 409 through the real authError(), with the row left untouched.
 *   /Finalized incentive cannot be silently adjusted/, /reversal_created/ -> the approved row is
 *        unchanged after a refused adjustment, and a correction is a NEW reversal event.
 *   /approvedIncentiveEntriesForPayroll/, /LEFT JOIN incentive_payroll_links/ -> each approved entry is
 *        offered exactly once and never again after it is linked.
 *   incentive API permissions + securityAudit -> the REAL route handler, real roles, a real audit row.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";
import { importLibModule } from "./helpers/ts-module-loader.mjs";

// Needed only by the route/screen section at the bottom, and it must be registered before any
// `.ts`/`.tsx` import.
installWorkersHooks("__INCENTIVE_ENGINE_ROUTE_DB__", "__INCENTIVE_ENGINE_ROUTE_ENV__");
delete process.env.PAWSPACE_DEPLOYMENT_ENV;

const incentive = await importLibModule("incentive-engine");
const people = await importLibModule("people-foundation");
const productivity = await importLibModule("sales-productivity-governance");
const { authError, ensureSecurityTables } = await importLibModule("server-auth");
const route = await import("../app/api/incentives/route.ts");
const React = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const screen = await import("../app/team/people/incentives/page.tsx");

const NOW = Date.UTC(2026, 1, 2);
const PERIOD_START = Date.UTC(2026, 6, 1);
const PERIOD_END = Date.UTC(2026, 6, 31);
const PAYROLL_END = PERIOD_END + 1;
const MANAGER = "manager@pawspace.in";
const SECOND = "cfo@pawspace.in";
const CALCULATOR = "incentive.calculator@pawspace.in";

const INCENTIVE_FALLBACK = "Incentive update failed";   // the real catch-block fallback of app/api/incentives/route.ts

async function world() {
  const w = freshCountingD1();
  w.sqlite.exec("CREATE TABLE IF NOT EXISTS app_users (id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,name TEXT NOT NULL,role_code TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  await people.ensurePeopleTables(w.db);
  await productivity.ensureSalesProductivityTables(w.db);
  await incentive.ensureIncentiveTables(w.db);
  return w;
}

/**
 * One active salesperson with ONE completed productivity fact for the period.
 *
 * `bookedRevenue` is deliberately separate from `collectedRevenue`/`netCollectedRevenue`: it is the
 * pipeline figure, and no incentive metric may ever read it.
 */
function seedRep(sqlite, { employeeId, email, teamCode = "sales_blr", facts }) {
  sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,'sales_associate','active',?,?)")
    .run(`USR-${employeeId}`, email, `Rep ${employeeId}`, NOW, NOW);
  sqlite.prepare("INSERT INTO employees (id,user_email,employee_code,display_name,work_email,employment_status,joined_at,created_at,updated_at) VALUES (?,?,?,?,?,'active',?,?,?)")
    .run(employeeId, email, `EMP-${employeeId}`, `Rep ${employeeId}`, email, NOW, NOW, NOW);
  sqlite.prepare("INSERT INTO employee_employment_versions (id,employee_id,version,effective_from,effective_until,employment_type,title,team_code,reason,actor_id,created_at) VALUES (?,?,1,?,NULL,'direct_employee','Sales associate',?,?,?,?)")
    .run(`EEV-${employeeId}`, employeeId, NOW, teamCode, "Initial employment record", MANAGER, NOW);
  const runId = `SPR-${employeeId}`;
  sqlite.prepare("INSERT INTO sales_productivity_fact_runs (id,idempotency_key,policy_id,policy_version,period_start,period_end,status,source_contract_version,generated_by,generated_at,detail_json) VALUES (?,?,?,1,?,?,'completed','v1',?,?,'{}')")
    .run(runId, `run-${employeeId}`, "SPP-1", PERIOD_START, PERIOD_END, CALCULATOR, NOW);
  sqlite.prepare("INSERT INTO sales_productivity_facts (id,run_id,employee_email,team_code,period_start,period_end,leads_assigned,assignments_accepted,meaningful_actions,qualified_leads,first_response_clocks,first_response_met,first_response_breached,booking_conversions,booked_revenue,collected_revenue,refunds,net_collected_revenue,cx_escalations,opt_out_or_consent_blocks,data_quality_blocks,source_detail_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'{}',?)")
    .run(`SPF-${employeeId}`, runId, email, teamCode, PERIOD_START, PERIOD_END,
      facts.leadsAssigned ?? 0, facts.assignmentsAccepted ?? 0, facts.meaningfulActions ?? 0, facts.qualifiedLeads ?? 0,
      facts.firstResponseClocks ?? 0, facts.firstResponseMet ?? 0, facts.firstResponseBreached ?? 0,
      facts.bookingConversions ?? 0, facts.bookedRevenue ?? 0, facts.collectedRevenue ?? 0, facts.refunds ?? 0,
      facts.netCollectedRevenue ?? 0, facts.cxEscalations ?? 0, facts.optOutBlocks ?? 0, facts.dataQualityBlocks ?? 0, NOW);
  return employeeId;
}

/** A stored, activated scheme version - the configuration the engine must read instead of guessing. */
async function activeScheme(w, { schemeCode, formula, qualityRules = [] }) {
  const draft = await incentive.saveIncentiveScheme(w.db, {
    schemeCode, roleCode: "sales_associate", teamCode: "sales_blr", effectiveFrom: PERIOD_START,
    formula, qualityRules, actorId: MANAGER,
  });
  await incentive.activateIncentiveScheme(w.db, { schemeId: String(draft.id), approvalReference: "BOARD-2026-07", actorId: MANAGER });
  return String(draft.id);
}

/** Calculate one period over the seeded facts. */
const calculate = (w, schemeId, key) =>
  incentive.calculateIncentivePeriod(w.db, { schemeId, periodStart: PERIOD_START, periodEnd: PERIOD_END, idempotencyKey: key, actorId: CALCULATOR });
const resultFor = (period, employeeId) => period.results.find((r) => String(r.employee_id) === employeeId);

/** Refuse the way the route does: catch it and hand it to the REAL authError(). */
async function surfaced(work, fallback = INCENTIVE_FALLBACK) {
  const thrown = await Promise.resolve().then(work).then(() => null, (error) => error);
  assert.ok(thrown, "the call was expected to be refused but resolved");
  const response = authError(thrown, fallback);
  return { thrown, response, status: response.status, error: (await response.json()).error };
}

const count = (sqlite, table, where = "1=1", ...args) => Number(sqlite.prepare(`SELECT COUNT(*) c FROM ${table} WHERE ${where}`).get(...args).c);
const resultRow = (sqlite, id) => sqlite.prepare("SELECT * FROM employee_incentive_results WHERE id=?").get(id);

// ---------------------------------------------------------------------------------------------
// 1. The calculation reads sales_productivity_facts and EXCLUDES pipeline revenue.
//    Old claims: /sales_productivity_facts/, /net_collected_revenue/, /pipelineRevenueExcluded:true/.
// ---------------------------------------------------------------------------------------------

test("incentive is paid on collected revenue only - a pipeline-only rep earns exactly zero", async () => {
  const w = await world();
  // Collected Rs2,00,000 net, with Rs10,00,000 of pipeline sitting beside it.
  seedRep(w.sqlite, { employeeId: "E-COLLECTED", email: "collected@pawspace.in", facts: { bookedRevenue: 1000000, collectedRevenue: 250000, netCollectedRevenue: 200000 } });
  // Rs50,00,000 booked, nothing collected. Paying on pipeline would owe this rep Rs2,45,000.
  seedRep(w.sqlite, { employeeId: "E-PIPELINE", email: "pipeline@pawspace.in", facts: { bookedRevenue: 5000000, collectedRevenue: 0, netCollectedRevenue: 0 } });

  const schemeId = await activeScheme(w, { schemeCode: "SALES-BLR", formula: { metric: "net_collected_revenue", target: 100000, payoutType: "percent_of_revenue_above_target", payoutValue: 5 } });
  const period = await calculate(w, schemeId, "july-1");
  assert.equal(period.duplicatePrevented, false);
  assert.equal(period.results.length, 2);

  const collected = resultFor(period, "E-COLLECTED");
  assert.equal(Number(collected.metric_value), 200000, "the metric is the collected figure, not the booked one");
  assert.equal(Number(collected.calculated_amount), 5000, "(200000 - 100000) x 5% = 5000");

  const pipeline = resultFor(period, "E-PIPELINE");
  assert.equal(Number(pipeline.metric_value), 0, "Rs50,00,000 of booked pipeline is not revenue");
  assert.equal(Number(pipeline.calculated_amount), 0, "a pipeline-only rep earns nothing; reading booked_revenue would have paid 245000");
  assert.notEqual(Number(pipeline.calculated_amount), 245000);

  const evidence = JSON.parse(String(collected.evidence_json));
  assert.equal(evidence.pipelineRevenueExcluded, true);
  assert.equal(evidence.metric, "net_collected_revenue");
  assert.equal(evidence.metricValue, 200000);
  assert.equal(String(collected.source_fact_run_id), "SPR-E-COLLECTED", "the result names the completed fact run it consumed");

  // Idempotency: the same key never produces a second set of results for the same money.
  const replay = await calculate(w, schemeId, "july-1");
  assert.equal(replay.duplicatePrevented, true);
  assert.equal(count(w.sqlite, "employee_incentive_periods"), 1);
  assert.equal(count(w.sqlite, "employee_incentive_results"), 2);
  assert.equal(count(w.sqlite, "incentive_result_lines"), 2);
});

// ---------------------------------------------------------------------------------------------
// 2. Targets, formulas, caps and multipliers are CONFIGURATION: change it, the payout changes.
//    Old claims: /formula_json TEXT NOT NULL/, /quality_rules_json TEXT NOT NULL/, /target:number/,
//    /payoutValue:number/, /cap\?:number/, /multiplier\?:number/.
// ---------------------------------------------------------------------------------------------

test("the same facts pay a different number under a different stored configuration", async () => {
  const w = await world();
  seedRep(w.sqlite, { employeeId: "E-CFG", email: "cfg@pawspace.in", facts: { bookedRevenue: 1000000, collectedRevenue: 250000, netCollectedRevenue: 200000 } });

  // (a) target 100000, 5% above target -> 5000
  const base = await activeScheme(w, { schemeCode: "CFG-A", formula: { metric: "net_collected_revenue", target: 100000, payoutType: "percent_of_revenue_above_target", payoutValue: 5 } });
  assert.equal(Number(resultFor(await calculate(w, base, "cfg-a"), "E-CFG").calculated_amount), 5000);

  // (b) SAME facts, target moved to 150000 and the rate doubled -> 5000, then capped at 4000
  const capped = await activeScheme(w, { schemeCode: "CFG-B", formula: { metric: "net_collected_revenue", target: 150000, payoutType: "percent_of_revenue_above_target", payoutValue: 10, cap: 4000 } });
  assert.equal(Number(resultFor(await calculate(w, capped, "cfg-b"), "E-CFG").calculated_amount), 4000, "the configured cap is what decides the number, not a constant in the engine");

  // (c) the identical formula with a bigger cap pays the uncapped 5000 - proving (b) was the cap
  const uncapped = await activeScheme(w, { schemeCode: "CFG-C", formula: { metric: "net_collected_revenue", target: 150000, payoutType: "percent_of_revenue_above_target", payoutValue: 10, cap: 10000 } });
  assert.equal(Number(resultFor(await calculate(w, uncapped, "cfg-c"), "E-CFG").calculated_amount), 5000);

  // (d) a flat payout on the same target is a different shape of configuration entirely
  const flat = await activeScheme(w, { schemeCode: "CFG-D", formula: { metric: "net_collected_revenue", target: 150000, payoutType: "flat_on_target", payoutValue: 7250 } });
  assert.equal(Number(resultFor(await calculate(w, flat, "cfg-d"), "E-CFG").calculated_amount), 7250);

  // (e) a target the rep did not reach pays nothing at all
  const unreached = await activeScheme(w, { schemeCode: "CFG-E", formula: { metric: "net_collected_revenue", target: 500000, payoutType: "percent_of_revenue_above_target", payoutValue: 10 } });
  assert.equal(Number(resultFor(await calculate(w, unreached, "cfg-e"), "E-CFG").calculated_amount), 0);

  // The configuration is stored, not inferred: it round-trips through formula_json.
  const stored = JSON.parse(String(w.sqlite.prepare("SELECT formula_json FROM incentive_scheme_versions WHERE scheme_code='CFG-B'").get().formula_json));
  assert.deepEqual(stored, { metric: "net_collected_revenue", target: 150000, payoutType: "percent_of_revenue_above_target", payoutValue: 10, cap: 4000 });
});

test("quality guardrails are configuration too: multiplier halves the payout, zero clears it, hold parks it", async () => {
  const w = await world();
  // One refund, two escalations and one data-quality block against a Rs5,000 payout.
  const facts = { bookedRevenue: 1000000, collectedRevenue: 250000, netCollectedRevenue: 200000, refunds: 1, cxEscalations: 2, dataQualityBlocks: 1 };
  seedRep(w.sqlite, { employeeId: "E-Q", email: "quality@pawspace.in", facts });
  const formula = { metric: "net_collected_revenue", target: 100000, payoutType: "percent_of_revenue_above_target", payoutValue: 5 };

  const clean = await activeScheme(w, { schemeCode: "Q-NONE", formula });
  assert.equal(Number(resultFor(await calculate(w, clean, "q-none"), "E-Q").calculated_amount), 5000, "with no guardrail configured the payout is the formula's");

  const halved = await activeScheme(w, { schemeCode: "Q-MULT", formula, qualityRules: [{ metric: "refunds", operator: "gt", threshold: 0, action: "multiplier", multiplier: 0.5 }] });
  const halvedRow = resultFor(await calculate(w, halved, "q-mult"), "E-Q");
  assert.equal(Number(halvedRow.calculated_amount), 2500, "the CONFIGURED 0.5 multiplier, applied to the configured payout");
  assert.equal(String(halvedRow.status), "calculated");
  const applied = JSON.parse(String(halvedRow.evidence_json)).appliedGuardrails;
  assert.equal(applied.length, 1);
  assert.equal(applied[0].actual, 1, "the guardrail records the actual value that tripped it");

  const zeroed = await activeScheme(w, { schemeCode: "Q-ZERO", formula, qualityRules: [{ metric: "data_quality_blocks", operator: "gte", threshold: 1, action: "zero" }] });
  assert.equal(Number(resultFor(await calculate(w, zeroed, "q-zero"), "E-Q").calculated_amount), 0);

  const held = await activeScheme(w, { schemeCode: "Q-HOLD", formula, qualityRules: [{ metric: "cx_escalations", operator: "gt", threshold: 0, action: "hold" }] });
  const heldRow = resultFor(await calculate(w, held, "q-hold"), "E-Q");
  assert.equal(String(heldRow.status), "held", "a hold parks the money for a human, it does not quietly zero it");
  assert.equal(Number(heldRow.calculated_amount), 5000);

  // A guardrail multiplier outside 0..1, or a percentage formula on a non-revenue metric, is refused
  // as configuration - not silently coerced into a number nobody approved.
  const badMultiplier = await surfaced(() => incentive.saveIncentiveScheme(w.db, {
    schemeCode: "Q-BAD", roleCode: "sales_associate", teamCode: "sales_blr", effectiveFrom: PERIOD_START, formula,
    qualityRules: [{ metric: "refunds", operator: "gt", threshold: 0, action: "multiplier", multiplier: 4 }], actorId: MANAGER,
  }));
  assert.equal(badMultiplier.status, 400);
  assert.equal(badMultiplier.error, "Quality multiplier must be explicitly configured between 0 and 1");

  const badMetric = await surfaced(() => incentive.saveIncentiveScheme(w.db, {
    schemeCode: "Q-BAD2", roleCode: "sales_associate", teamCode: "sales_blr", effectiveFrom: PERIOD_START,
    formula: { metric: "qualified_leads", target: 10, payoutType: "percent_of_revenue_above_target", payoutValue: 5 },
    qualityRules: [], actorId: MANAGER,
  }));
  assert.equal(badMetric.status, 400);
  assert.equal(badMetric.error, "Revenue percentage formula requires a canonical revenue metric");
  assert.equal(count(w.sqlite, "incentive_scheme_versions", "scheme_code IN ('Q-BAD','Q-BAD2')"), 0, "a refused configuration is not stored");
});

test("an activated scheme version is immutable and a period outside its validity is refused", async () => {
  const w = await world();
  seedRep(w.sqlite, { employeeId: "E-IMM", email: "imm@pawspace.in", facts: { netCollectedRevenue: 200000 } });
  const schemeId = await activeScheme(w, { schemeCode: "IMM", formula: { metric: "net_collected_revenue", target: 0, payoutType: "flat_on_target", payoutValue: 1000 } });

  const rewrite = await surfaced(() => incentive.saveIncentiveScheme(w.db, {
    schemeCode: "IMM", roleCode: "sales_associate", teamCode: "sales_blr", effectiveFrom: PERIOD_START,
    formula: { metric: "net_collected_revenue", target: 0, payoutType: "flat_on_target", payoutValue: 99999 },
    qualityRules: [], actorId: MANAGER,
  }));
  assert.equal(rewrite.status, 409);
  assert.equal(rewrite.error, "Active incentive scheme is immutable; create a new scheme version after retiring it");
  assert.equal(count(w.sqlite, "incentive_scheme_versions", "scheme_code='IMM'"), 1);

  const reactivate = await surfaced(() => incentive.activateIncentiveScheme(w.db, { schemeId, approvalReference: "BOARD-2", actorId: MANAGER }));
  assert.equal(reactivate.status, 409);
  assert.equal(reactivate.error, "Only a draft incentive scheme can be activated");

  const outside = await surfaced(() => incentive.calculateIncentivePeriod(w.db, { schemeId, periodStart: Date.UTC(2026, 0, 1), periodEnd: Date.UTC(2026, 0, 31), idempotencyKey: "outside-1", actorId: CALCULATOR }));
  assert.equal(outside.status, 422);
  assert.equal(outside.error, "Incentive period is outside scheme validity");
  assert.equal(count(w.sqlite, "employee_incentive_periods"), 0);
});

// ---------------------------------------------------------------------------------------------
// 3. Held, disputed, and self-approval. Old claims: /status="held"/, /status='disputed'/,
//    /Only calculated and unheld incentive can be approved/,
//    /Incentive calculator cannot approve their own result/.
// ---------------------------------------------------------------------------------------------

test("a held incentive cannot be approved, and neither can a disputed one", async () => {
  const w = await world();
  seedRep(w.sqlite, { employeeId: "E-HOLD", email: "hold@pawspace.in", facts: { netCollectedRevenue: 200000, cxEscalations: 3 } });
  seedRep(w.sqlite, { employeeId: "E-DISP", email: "disp@pawspace.in", facts: { netCollectedRevenue: 200000 } });
  const formula = { metric: "net_collected_revenue", target: 100000, payoutType: "percent_of_revenue_above_target", payoutValue: 5 };
  const schemeId = await activeScheme(w, { schemeCode: "HOLDS", formula, qualityRules: [{ metric: "cx_escalations", operator: "gt", threshold: 0, action: "hold" }] });
  const period = await calculate(w, schemeId, "holds-1");

  const heldId = String(resultFor(period, "E-HOLD").id);
  assert.equal(String(resultRow(w.sqlite, heldId).status), "held");
  const heldApproval = await surfaced(() => incentive.approveIncentiveResult(w.db, { resultId: heldId, actorId: MANAGER }));
  assert.equal(heldApproval.status, 409);
  assert.equal(heldApproval.error, "Only calculated and unheld incentive can be approved");
  assert.notEqual(heldApproval.error, INCENTIVE_FALLBACK, "the operator must read the rule, not a generic 500");
  assert.equal(Number(resultRow(w.sqlite, heldId).approved_amount), 0, "a refused approval approves no money");
  assert.equal(resultRow(w.sqlite, heldId).approved_by, null);

  const dispId = String(resultFor(period, "E-DISP").id);
  await incentive.openIncentiveDispute(w.db, { resultId: dispId, reason: "The rep says two bookings are missing", actorId: "rep@pawspace.in" });
  assert.equal(String(resultRow(w.sqlite, dispId).status), "disputed");
  const disputedApproval = await surfaced(() => incentive.approveIncentiveResult(w.db, { resultId: dispId, actorId: MANAGER }));
  assert.equal(disputedApproval.status, 409);
  assert.equal(disputedApproval.error, "Only calculated and unheld incentive can be approved");
  assert.equal(Number(resultRow(w.sqlite, dispId).approved_amount), 0);
  assert.equal(count(w.sqlite, "incentive_approval_events", "event_type='approved'"), 0);

  // Resolving the dispute WITHOUT releasing holds it; releasing puts it back in reach of approval.
  const dispute = w.sqlite.prepare("SELECT id FROM incentive_disputes WHERE result_id=?").get(dispId);
  await incentive.resolveIncentiveDispute(w.db, { disputeId: String(dispute.id), resolutionNote: "Reviewed the two bookings with the rep", actorId: MANAGER, release: false });
  assert.equal(String(resultRow(w.sqlite, dispId).status), "held");
});

test("the calculator of an incentive period cannot approve the money they calculated", async () => {
  const w = await world();
  seedRep(w.sqlite, { employeeId: "E-SELF", email: "self@pawspace.in", facts: { netCollectedRevenue: 200000 } });
  const schemeId = await activeScheme(w, { schemeCode: "SELF", formula: { metric: "net_collected_revenue", target: 100000, payoutType: "percent_of_revenue_above_target", payoutValue: 5 } });
  const resultId = String(resultFor(await calculate(w, schemeId, "self-1"), "E-SELF").id);

  const selfApproval = await surfaced(() => incentive.approveIncentiveResult(w.db, { resultId, actorId: CALCULATOR }));
  assert.equal(selfApproval.status, 409);
  assert.equal(selfApproval.error, "Incentive calculator cannot approve their own result");
  assert.equal(String(resultRow(w.sqlite, resultId).status), "calculated", "a refused self-approval leaves the result exactly where it was");
  assert.equal(Number(resultRow(w.sqlite, resultId).approved_amount), 0);

  // A second, different person can, and the approved amount is the calculated one.
  const approved = await incentive.approveIncentiveResult(w.db, { resultId, actorId: MANAGER });
  assert.equal(approved.approvedAmount, 5000);
  assert.equal(approved.duplicatePrevented, false);
  assert.equal(String(resultRow(w.sqlite, resultId).approved_by), MANAGER);

  // And approving twice does not pay twice: the second approver is refused on the status.
  const again = await surfaced(() => incentive.approveIncentiveResult(w.db, { resultId, actorId: SECOND }));
  assert.equal(again.status, 409);
  assert.equal(again.error, "Only calculated and unheld incentive can be approved");
  assert.equal(Number(resultRow(w.sqlite, resultId).approved_amount), 5000, "the approved amount is not doubled");
  assert.equal(String(resultRow(w.sqlite, resultId).approved_by), MANAGER, "the first approver keeps the record");
  assert.equal(count(w.sqlite, "incentive_approval_events", "result_id=? AND event_type='approved'", resultId), 1);
});

// ---------------------------------------------------------------------------------------------
// 4. A finalized result is never silently edited: the correction is a new event.
//    Old claims: /Finalized incentive cannot be silently adjusted/, /incentive_reversals/,
//    /reversal_created/, /Payroll-included incentive requires reversal\/correction.../.
// ---------------------------------------------------------------------------------------------

test("an approved incentive cannot be silently adjusted - the row is untouched and a reversal is a new event", async () => {
  const w = await world();
  seedRep(w.sqlite, { employeeId: "E-FIN", email: "fin@pawspace.in", facts: { netCollectedRevenue: 200000 } });
  const schemeId = await activeScheme(w, { schemeCode: "FIN", formula: { metric: "net_collected_revenue", target: 100000, payoutType: "percent_of_revenue_above_target", payoutValue: 5 } });
  const resultId = String(resultFor(await calculate(w, schemeId, "fin-1"), "E-FIN").id);
  await incentive.approveIncentiveResult(w.db, { resultId, actorId: MANAGER });
  const before = resultRow(w.sqlite, resultId);
  assert.equal(Number(before.approved_amount), 5000);

  const silent = await surfaced(() => incentive.addIncentiveAdjustment(w.db, { resultId, amount: -2000, reason: "Quietly correcting an approved payout", actorId: MANAGER }));
  assert.equal(silent.status, 409);
  assert.equal(silent.error, "Finalized incentive cannot be silently adjusted");
  assert.deepEqual(resultRow(w.sqlite, resultId), before, "the finalized row must be identical after a refused adjustment");
  assert.equal(count(w.sqlite, "incentive_adjustments"), 0);

  // The correction that IS allowed is a new, recorded reversal event.
  const reversal = await incentive.reverseIncentiveResult(w.db, { resultId, amount: 2000, reason: "Customer refunded part of the booking", effectiveAt: PERIOD_END, actorId: MANAGER });
  assert.equal(reversal.amount, 2000);
  const after = resultRow(w.sqlite, resultId);
  assert.equal(Number(after.calculated_amount), Number(before.calculated_amount), "the original calculation is never rewritten");
  assert.equal(Number(after.approved_amount), Number(before.approved_amount), "the approved amount is never rewritten - the reversal carries the change");
  assert.equal(String(after.approved_by), String(before.approved_by));
  assert.equal(String(after.status), "approved", "a partial reversal leaves the result approved");

  const stored = w.sqlite.prepare("SELECT * FROM incentive_reversals WHERE result_id=?").get(resultId);
  assert.equal(Number(stored.amount), 2000);
  assert.equal(String(stored.status), "approved");
  assert.equal(String(stored.actor_id), MANAGER);
  assert.equal(count(w.sqlite, "incentive_approval_events", "result_id=? AND event_type='reversal_created'", resultId), 1);

  // Over-reversing the remaining Rs3,000 is refused with the real balance, not a 500.
  const over = await surfaced(() => incentive.reverseIncentiveResult(w.db, { resultId, amount: 999999, reason: "Trying to claw back more than was ever approved", effectiveAt: PERIOD_END, actorId: MANAGER }));
  assert.equal(over.status, 422);
  assert.equal(over.error, "Reversal amount must be positive and cannot exceed the remaining approved incentive");
  assert.equal(count(w.sqlite, "incentive_reversals", "result_id=?", resultId), 1);

  // The directory the screen reads reports the true remaining balance.
  const directory = await incentive.incentiveDirectory(w.db);
  const card = directory.results.find((r) => String(r.id) === resultId);
  assert.equal(card.reversed_amount, 2000);
  assert.equal(card.remaining_reversible, 3000);
  assert.equal(card.reversal_count, 1);
  assert.equal(directory.truth.humanApprovalRequired, true);
  assert.equal(directory.truth.pipelineRevenueEligible, false);
  assert.equal(directory.truth.payrollInclusionOneTime, true);
  assert.equal(directory.truth.productionReady, false);
});

test("a wrong calculated amount is corrected by an adjustment that needs a second approver", async () => {
  const w = await world();
  seedRep(w.sqlite, { employeeId: "E-ADJ", email: "adj@pawspace.in", facts: { netCollectedRevenue: 200000 } });
  const schemeId = await activeScheme(w, { schemeCode: "ADJ", formula: { metric: "net_collected_revenue", target: 100000, payoutType: "percent_of_revenue_above_target", payoutValue: 5 } });
  const resultId = String(resultFor(await calculate(w, schemeId, "adj-1"), "E-ADJ").id);

  const adjustment = await incentive.addIncentiveAdjustment(w.db, { resultId, amount: 1500, reason: "Two collected bookings landed after the fact run", actorId: MANAGER });
  assert.equal(adjustment.status, "pending");

  const selfApprove = await surfaced(() => incentive.approveIncentiveAdjustment(w.db, { adjustmentId: adjustment.id, actorId: MANAGER }));
  assert.equal(selfApprove.status, 409);
  assert.equal(selfApprove.error, "Adjustment requester cannot approve their own change");
  assert.equal(String(w.sqlite.prepare("SELECT status FROM incentive_adjustments WHERE id=?").get(adjustment.id).status), "pending");

  await incentive.approveIncentiveAdjustment(w.db, { adjustmentId: adjustment.id, actorId: SECOND });
  const approved = await incentive.approveIncentiveResult(w.db, { resultId, actorId: SECOND });
  assert.equal(approved.approvedAmount, 6500, "5,000 calculated + the 1,500 adjustment a second person approved");
});

test("a payroll-included incentive is corrected by reversal, never by reopening its history", async () => {
  const w = await world();
  seedRep(w.sqlite, { employeeId: "E-LINKED", email: "linked@pawspace.in", facts: { netCollectedRevenue: 200000 } });
  const schemeId = await activeScheme(w, { schemeCode: "LINKED", formula: { metric: "net_collected_revenue", target: 100000, payoutType: "percent_of_revenue_above_target", payoutValue: 5 } });
  const resultId = String(resultFor(await calculate(w, schemeId, "linked-1"), "E-LINKED").id);
  await incentive.approveIncentiveResult(w.db, { resultId, actorId: MANAGER });

  const entries = await incentive.approvedIncentiveEntriesForPayroll(w.db, { employeeId: "E-LINKED", periodStart: PERIOD_START, periodEnd: PAYROLL_END });
  await incentive.markIncentiveEntriesIncluded(w.db, { entries, payrollRunId: "PAYRUN-1", payrollResultId: "PAYRES-1", employeeId: "E-LINKED" });

  const reopen = await surfaced(() => incentive.openIncentiveDispute(w.db, { resultId, reason: "Wanting to reopen an already paid incentive", actorId: "rep@pawspace.in" }));
  assert.equal(reopen.status, 409);
  assert.equal(reopen.error, "Payroll-included incentive requires reversal/correction rather than reopening history");
  assert.equal(count(w.sqlite, "incentive_disputes"), 0);
  assert.equal(String(resultRow(w.sqlite, resultId).status), "approved", "the paid result stays exactly as it was paid");
});

// ---------------------------------------------------------------------------------------------
// 5. Each approved entry reaches payroll exactly once, and never after it is linked.
//    Old claims: /approvedIncentiveEntriesForPayroll/, /LEFT JOIN incentive_payroll_links/,
//    /sourceType:"incentive_reversal"/, /UNIQUE\(source_type,source_id\)/.
// ---------------------------------------------------------------------------------------------

test("approvedIncentiveEntriesForPayroll offers each approved entry once and never after linking", async () => {
  const w = await world();
  seedRep(w.sqlite, { employeeId: "E-PAYROLL", email: "payroll@pawspace.in", facts: { netCollectedRevenue: 200000 } });
  const schemeId = await activeScheme(w, { schemeCode: "PAYROLL", formula: { metric: "net_collected_revenue", target: 100000, payoutType: "percent_of_revenue_above_target", payoutValue: 5 } });
  const resultId = String(resultFor(await calculate(w, schemeId, "payroll-1"), "E-PAYROLL").id);

  // Unapproved money is never offered to payroll.
  assert.deepEqual(await incentive.approvedIncentiveEntriesForPayroll(w.db, { employeeId: "E-PAYROLL", periodStart: PERIOD_START, periodEnd: PAYROLL_END }), [],
    "human approval is required before anything reaches a payslip");

  await incentive.approveIncentiveResult(w.db, { resultId, actorId: MANAGER });
  const first = await incentive.approvedIncentiveEntriesForPayroll(w.db, { employeeId: "E-PAYROLL", periodStart: PERIOD_START, periodEnd: PAYROLL_END });
  assert.equal(first.length, 1);
  assert.equal(first[0].sourceType, "incentive_result");
  assert.equal(first[0].kind, "earning");
  assert.equal(first[0].amount, 5000);
  assert.equal(first[0].policyVersion, "incentive_scheme:PAYROLL:v1");

  // Asking twice before linking still offers it once - it has not been paid yet.
  assert.equal((await incentive.approvedIncentiveEntriesForPayroll(w.db, { employeeId: "E-PAYROLL", periodStart: PERIOD_START, periodEnd: PAYROLL_END })).length, 1);

  await incentive.markIncentiveEntriesIncluded(w.db, { entries: first, payrollRunId: "PAYRUN-1", payrollResultId: "PAYRES-1", employeeId: "E-PAYROLL" });
  assert.deepEqual(await incentive.approvedIncentiveEntriesForPayroll(w.db, { employeeId: "E-PAYROLL", periodStart: PERIOD_START, periodEnd: PAYROLL_END }), [],
    "an incentive already linked to payroll is never offered again");

  // The link table itself refuses a second link for the same source - the last line of defence.
  await assert.rejects(
    () => incentive.markIncentiveEntriesIncluded(w.db, { entries: first, payrollRunId: "PAYRUN-2", payrollResultId: "PAYRES-2", employeeId: "E-PAYROLL" }),
    /UNIQUE constraint failed: incentive_payroll_links/,
  );
  assert.equal(count(w.sqlite, "incentive_payroll_links"), 1);

  // A reversal of money already paid becomes a DEDUCTION entry, once.
  await incentive.reverseIncentiveResult(w.db, { resultId, amount: 5000, reason: "Customer refunded the booking after payout", effectiveAt: PERIOD_END, actorId: MANAGER });
  const reversalEntries = await incentive.approvedIncentiveEntriesForPayroll(w.db, { employeeId: "E-PAYROLL", periodStart: PERIOD_START, periodEnd: PAYROLL_END });
  assert.equal(reversalEntries.length, 1);
  assert.equal(reversalEntries[0].sourceType, "incentive_reversal");
  assert.equal(reversalEntries[0].kind, "deduction");
  assert.equal(reversalEntries[0].amount, 5000);
  await incentive.markIncentiveEntriesIncluded(w.db, { entries: reversalEntries, payrollRunId: "PAYRUN-3", payrollResultId: "PAYRES-3", employeeId: "E-PAYROLL" });
  assert.deepEqual(await incentive.approvedIncentiveEntriesForPayroll(w.db, { employeeId: "E-PAYROLL", periodStart: PERIOD_START, periodEnd: PAYROLL_END }), []);
  assert.equal(Number(w.sqlite.prepare("SELECT amount FROM incentive_payroll_links WHERE source_type='incentive_reversal'").get().amount), -5000);

  // Every table Gate 4 claims to own carries the row the lifecycle put in it.
  for (const [table, expected] of [
    ["incentive_scheme_versions", 1], ["employee_incentive_periods", 1], ["employee_incentive_results", 1],
    ["incentive_result_lines", 1], ["incentive_reversals", 1], ["incentive_approval_events", 2],
    ["incentive_payroll_links", 2],
  ]) assert.equal(count(w.sqlite, table), expected, table);
});

// ---------------------------------------------------------------------------------------------
// 6. The REAL route and the REAL screen. Old claims: /authorize\(request,"incentives\.view"\)/,
//    /authorize\(request,"incentives\.manage"\)/, /securityAudit/, /incentive\.\$\{action\}/,
//    /productionReady:false/, and four page strings.
// ---------------------------------------------------------------------------------------------

function routeWorld() {
  const harness = freshCountingD1();
  globalThis.__INCENTIVE_ENGINE_ROUTE_DB__ = harness.db;
  globalThis.__INCENTIVE_ENGINE_ROUTE_ENV__ = {};
  return harness;
}
const asRole = (email, body) => route.POST(new Request("https://app.pawspace.in/api/incentives", {
  method: "POST", headers: { "content-type": "application/json", "oai-authenticated-user-email": email }, body: JSON.stringify(body),
}));
const asPreview = (body) => route.POST(new Request("http://localhost/api/incentives", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}));

test("the incentives route requires incentives.manage to mutate and audits what it did", async () => {
  const harness = routeWorld();
  await ensureSecurityTables(harness.db);
  const staff = (email, roleCode) => harness.sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)")
    .run(`U-${roleCode}`, email, roleCode, roleCode, NOW, NOW);
  staff("auditor@pawspace.in", "auditor");     // incentives.view, no incentives.manage
  staff("shopper@pawspace.in", "customer");    // neither

  const readOnly = await asRole("auditor@pawspace.in", { action: "save_scheme", schemeCode: "X", roleCode: "r", teamCode: "t", effectiveFrom: PERIOD_START, formula: {} });
  assert.equal(readOnly.status, 403, "incentives.view must not be allowed to write a scheme");
  assert.equal((await readOnly.json()).error, "Permission denied");
  const stranger = await asRole("shopper@pawspace.in", { action: "save_scheme", schemeCode: "X", roleCode: "r", teamCode: "t", effectiveFrom: PERIOD_START, formula: {} });
  assert.equal(stranger.status, 403);
  const readerGet = await route.GET(new Request("https://app.pawspace.in/api/incentives", { headers: { "oai-authenticated-user-email": "auditor@pawspace.in" } }));
  assert.equal(readerGet.status, 200, "incentives.view is enough to READ the directory");
  assert.equal((await readerGet.json()).productionReady, false);
  assert.equal(count(harness.sqlite, "incentive_scheme_versions"), 0);

  // An authorised mutation succeeds AND is audited under `incentive.<action>`.
  const saved = await asPreview({
    action: "save_scheme", schemeCode: "ROUTE-1", roleCode: "sales_associate", teamCode: "sales_blr", effectiveFrom: PERIOD_START,
    formula: { metric: "net_collected_revenue", target: 100000, payoutType: "percent_of_revenue_above_target", payoutValue: 5 }, qualityRules: [],
  });
  assert.equal(saved.status, 200);
  const savedBody = await saved.json();
  assert.equal(savedBody.productionReady, false);
  assert.equal(String(savedBody.data.status), "draft", "a new scheme is a draft until somebody activates it");
  const audit = harness.sqlite.prepare("SELECT * FROM security_audit_events WHERE action='incentive.save_scheme'").get();
  assert.ok(audit, "every incentive mutation writes a security audit row");
  assert.equal(String(audit.resource_type), "incentive_scheme");
  assert.equal(String(audit.outcome), "completed");

  // And a governed engine refusal reaches the caller as its own 4xx, not a 500.
  const refused = await asPreview({ action: "activate_scheme", schemeId: String(savedBody.data.id), approvalReference: "x" });
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).error, "Incentive scheme approval reference is required");
  assert.equal(count(harness.sqlite, "incentive_scheme_versions", "status='active_uat'"), 0);
});

test("the Incentives screen renders the governance boundaries it claims", async () => {
  const markup = renderToStaticMarkup(React.createElement(screen.default));
  assert.match(markup, /Pipeline revenue never qualifies/);
  assert.match(markup, /Human approval is required/);
  assert.match(markup, /Pipeline revenue eligible:<\/b> NO/);
  assert.match(markup, /Production ready:<\/b> NO/);

  // The screen's own predicates, executed: Reverse only on approved, Adjust only before finalisation.
  assert.equal(screen.canReverseResult("approved"), true);
  for (const status of ["calculated", "held", "disputed", "reversed"]) assert.equal(screen.canReverseResult(status), false, status);
  for (const status of ["calculated", "held", "disputed"]) assert.equal(screen.canAdjustResult(status), true, status);
  for (const status of ["approved", "reversed"]) assert.equal(screen.canAdjustResult(status), false, status);
  assert.equal(screen.resolveFormOpen(null, null), false, "absence is never a match");
});
