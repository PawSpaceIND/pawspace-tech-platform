import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";

// ---------------------------------------------------------------------------
// Task 22 audit — incentives (employee schemes, groomer brackets, PawPoints).
// The existing incentive tests are static source assertions; this suite runs the
// real engines over real SQLite with exact numbers. What matters: tier maths at
// the boundaries, cancelled work never accruing, nobody approving their own
// money, one-time payroll inclusion, and no double approval or over-reversal.
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
      run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
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
    if (/^\s*CREATE (TABLE|INDEX|UNIQUE INDEX)/i.test(match[2])) { try { sqlite.exec(match[2]); } catch { /* index for a table this harness does not need */ } }
  }
}

const NOW = 1770000000000;
const MONTH_START = Date.UTC(2026, 6, 1);   // 2026-07-01
const MONTH_END = Date.UTC(2026, 6, 31);    // 2026-07-31
const MANAGER = "manager@pawspace.in";
const CALCULATOR = "finance@pawspace.in";

function fresh() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PAWSPACE_TEST_ENV = { DB: db };
  sqlite.exec("CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,service_code TEXT NOT NULL,package_name TEXT,provider_id TEXT,status TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT,total_amount REAL NOT NULL,currency TEXT DEFAULT 'INR',created_at INTEGER,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE app_users (id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,name TEXT NOT NULL,role_code TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  applyOwnedDdl(sqlite, "lib/people-foundation.ts");
  applyOwnedDdl(sqlite, "lib/sales-productivity-governance.ts");
  return { sqlite, db };
}

function seedSalesperson(sqlite, { employeeId, email, teamCode = "sales_blr", facts }) {
  sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)")
    .run(`USR-${employeeId}`, email, `Rep ${employeeId}`, "sales_associate", NOW, NOW);
  sqlite.prepare("INSERT INTO employees (id,user_email,employee_code,display_name,work_email,employment_status,joined_at,created_at,updated_at) VALUES (?,?,?,?,?,'active',?,?,?)")
    .run(employeeId, email, `EMP-${employeeId}`, `Rep ${employeeId}`, email, NOW, NOW, NOW);
  sqlite.prepare("INSERT INTO employee_employment_versions (id,employee_id,version,effective_from,effective_until,employment_type,title,team_code,reason,actor_id,created_at) VALUES (?,?,1,?,NULL,'direct_employee','Sales associate',?,?,?,?)")
    .run(`EEV-${employeeId}`, employeeId, NOW, teamCode, "Initial employment record", MANAGER, NOW);
  const runId = `SPR-${employeeId}`;
  sqlite.prepare("INSERT INTO sales_productivity_fact_runs (id,idempotency_key,policy_id,policy_version,period_start,period_end,status,source_contract_version,generated_by,generated_at,detail_json) VALUES (?,?,?,1,?,?,'completed','v1',?,?,'{}')")
    .run(runId, `run-${employeeId}`, "SPP-1", MONTH_START, MONTH_END, CALCULATOR, NOW);
  sqlite.prepare("INSERT INTO sales_productivity_facts (id,run_id,employee_email,team_code,period_start,period_end,leads_assigned,assignments_accepted,meaningful_actions,qualified_leads,first_response_clocks,first_response_met,first_response_breached,booking_conversions,booked_revenue,collected_revenue,refunds,net_collected_revenue,cx_escalations,opt_out_or_consent_blocks,data_quality_blocks,source_detail_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'{}',?)")
    .run(`SPF-${employeeId}`, runId, email, teamCode, MONTH_START, MONTH_END,
      facts.leadsAssigned ?? 0, facts.assignmentsAccepted ?? 0, facts.meaningfulActions ?? 0, facts.qualifiedLeads ?? 0,
      facts.firstResponseClocks ?? 0, facts.firstResponseMet ?? 0, facts.firstResponseBreached ?? 0,
      facts.bookingConversions ?? 0, facts.bookedRevenue ?? 0, facts.collectedRevenue ?? 0, facts.refunds ?? 0,
      facts.netCollectedRevenue ?? 0, facts.cxEscalations ?? 0, facts.optOutBlocks ?? 0, facts.dataQualityBlocks ?? 0, NOW);
  return { employeeId, email };
}

async function activeScheme(db, formula, qualityRules = []) {
  const engine = await import("../lib/incentive-engine.ts");
  const scheme = await engine.saveIncentiveScheme(db, {
    schemeCode: "SALES-BLR", roleCode: "sales_associate", teamCode: "sales_blr",
    effectiveFrom: MONTH_START, formula, qualityRules, actorId: MANAGER,
  });
  await engine.activateIncentiveScheme(db, { schemeId: String(scheme.id), approvalReference: "BOARD-2026-07", actorId: MANAGER });
  return { engine, schemeId: String(scheme.id) };
}

// ---------------------------------------------------------------------------
// 1. Employee incentive maths: exact values at the target boundary.
// ---------------------------------------------------------------------------
test("incentive payout is exact at, below and above the configured target, and respects the cap", async () => {
  const { sqlite, db } = fresh();
  seedSalesperson(sqlite, { employeeId: "E-BELOW", email: "below@pawspace.in", facts: { netCollectedRevenue: 99999 } });
  seedSalesperson(sqlite, { employeeId: "E-EXACT", email: "exact@pawspace.in", facts: { netCollectedRevenue: 100000 } });
  seedSalesperson(sqlite, { employeeId: "E-ABOVE", email: "above@pawspace.in", facts: { netCollectedRevenue: 250000 } });
  seedSalesperson(sqlite, { employeeId: "E-CAPPED", email: "capped@pawspace.in", facts: { netCollectedRevenue: 900000 } });

  const { engine, schemeId } = await activeScheme(db, {
    metric: "net_collected_revenue", target: 100000,
    payoutType: "percent_of_revenue_above_target", payoutValue: 5, cap: 20000,
  });
  const run = await engine.calculateIncentivePeriod(db, { schemeId, periodStart: MONTH_START, periodEnd: MONTH_END, idempotencyKey: "period-1", actorId: CALCULATOR });
  const byEmployee = new Map(run.results.map((row) => [row.employee_id, row]));

  // Below target: nothing. At target: nothing above it either (5% of 0).
  assert.equal(Number(byEmployee.get("E-BELOW").calculated_amount), 0);
  assert.equal(Number(byEmployee.get("E-EXACT").calculated_amount), 0);
  // 5% of (250000 - 100000) = 7500.
  assert.equal(Number(byEmployee.get("E-ABOVE").calculated_amount), 7500);
  // 5% of 800000 = 40000, capped at the configured 20000.
  assert.equal(Number(byEmployee.get("E-CAPPED").calculated_amount), 20000);

  const replay = await engine.calculateIncentivePeriod(db, { schemeId, periodStart: MONTH_START, periodEnd: MONTH_END, idempotencyKey: "period-1", actorId: CALCULATOR });
  assert.equal(replay.duplicatePrevented, true, "recalculating the same period does not create a second set of results");
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM employee_incentive_results").get().c, 4);
});

test("flat-on-target and per-unit formulas compute exactly, and pipeline revenue is never the metric", async () => {
  const { sqlite, db } = fresh();
  seedSalesperson(sqlite, { employeeId: "E-FLAT", email: "flat@pawspace.in", facts: { bookingConversions: 12, bookedRevenue: 500000, collectedRevenue: 10000 } });
  const flat = await activeScheme(db, { metric: "booking_conversions", target: 12, payoutType: "flat_on_target", payoutValue: 3000 });
  const flatRun = await flat.engine.calculateIncentivePeriod(db, { schemeId: flat.schemeId, periodStart: MONTH_START, periodEnd: MONTH_END, idempotencyKey: "flat-1", actorId: CALCULATOR });
  assert.equal(Number(flatRun.results[0].calculated_amount), 3000, "hitting the target exactly earns the flat payout");
  const evidence = JSON.parse(flatRun.results[0].evidence_json);
  assert.equal(evidence.pipelineRevenueExcluded, true);
  assert.equal(evidence.metric, "booking_conversions");
  assert.equal(evidence.metricValue, 12);
  assert.ok(evidence.sourceFactRunId, "the payout cites the productivity fact run it was computed from");

  // A revenue-percentage formula on a non-revenue metric is rejected outright.
  const engine = await import("../lib/incentive-engine.ts");
  await assert.rejects(
    () => engine.saveIncentiveScheme(db, { schemeCode: "BAD-1", roleCode: "sales_associate", teamCode: "sales_blr", effectiveFrom: MONTH_START, formula: { metric: "qualified_leads", target: 10, payoutType: "percent_of_revenue_above_target", payoutValue: 5 }, qualityRules: [], actorId: MANAGER }),
    /requires a canonical revenue metric/,
  );
  await assert.rejects(
    () => engine.saveIncentiveScheme(db, { schemeCode: "BAD-2", roleCode: "sales_associate", teamCode: "sales_blr", effectiveFrom: MONTH_START, formula: { metric: "net_collected_revenue", target: -1, payoutType: "flat_on_target", payoutValue: 100 }, qualityRules: [], actorId: MANAGER }),
    /non-negative numbers/,
  );
});

test("quality guardrails hold, zero or scale a payout using real fact values", async () => {
  const { sqlite, db } = fresh();
  seedSalesperson(sqlite, { employeeId: "E-CLEAN", email: "clean@pawspace.in", facts: { netCollectedRevenue: 200000, refunds: 0, cx_escalations: 0 } });
  seedSalesperson(sqlite, { employeeId: "E-REFUNDS", email: "refunds@pawspace.in", facts: { netCollectedRevenue: 200000, refunds: 5000 } });
  seedSalesperson(sqlite, { employeeId: "E-ESCALATED", email: "escalated@pawspace.in", facts: { netCollectedRevenue: 200000, cxEscalations: 3 } });
  seedSalesperson(sqlite, { employeeId: "E-DATAGAPS", email: "datagaps@pawspace.in", facts: { netCollectedRevenue: 200000, dataQualityBlocks: 2 } });

  const { engine, schemeId } = await activeScheme(db, {
    metric: "net_collected_revenue", target: 100000, payoutType: "percent_of_revenue_above_target", payoutValue: 10,
  }, [
    { metric: "refunds", operator: "gt", threshold: 1000, action: "hold" },
    { metric: "cx_escalations", operator: "gte", threshold: 3, action: "zero" },
    { metric: "data_quality_blocks", operator: "gte", threshold: 1, action: "multiplier", multiplier: 0.5 },
  ]);
  const run = await engine.calculateIncentivePeriod(db, { schemeId, periodStart: MONTH_START, periodEnd: MONTH_END, idempotencyKey: "guard-1", actorId: CALCULATOR });
  const byEmployee = new Map(run.results.map((row) => [row.employee_id, row]));

  assert.equal(Number(byEmployee.get("E-CLEAN").calculated_amount), 10000);
  assert.equal(byEmployee.get("E-CLEAN").status, "calculated");
  assert.equal(byEmployee.get("E-REFUNDS").status, "held", "refunds over the threshold hold the payout for review");
  assert.equal(Number(byEmployee.get("E-ESCALATED").calculated_amount), 0, "escalations zero the payout");
  assert.equal(Number(byEmployee.get("E-DATAGAPS").calculated_amount), 5000, "data-quality gaps halve it");
  const guardEvidence = JSON.parse(byEmployee.get("E-DATAGAPS").evidence_json);
  assert.equal(guardEvidence.appliedGuardrails.length, 1, "the applied guardrail is recorded on the result, not silently applied");

  // A held result cannot be approved into payroll.
  await assert.rejects(
    () => engine.approveIncentiveResult(db, { resultId: String(byEmployee.get("E-REFUNDS").id), actorId: MANAGER }),
    /Only calculated and unheld incentive can be approved/,
  );
});

// ---------------------------------------------------------------------------
// 2. Approval governance: no self-approval, no double approval.
// ---------------------------------------------------------------------------
test("incentive approval: calculator cannot self-approve and concurrent approvals settle once", async () => {
  const { sqlite, db } = fresh();
  seedSalesperson(sqlite, { employeeId: "E-APP", email: "app@pawspace.in", facts: { netCollectedRevenue: 200000 } });
  const { engine, schemeId } = await activeScheme(db, { metric: "net_collected_revenue", target: 100000, payoutType: "percent_of_revenue_above_target", payoutValue: 10 });
  const run = await engine.calculateIncentivePeriod(db, { schemeId, periodStart: MONTH_START, periodEnd: MONTH_END, idempotencyKey: "approve-1", actorId: CALCULATOR });
  const resultId = String(run.results[0].id);

  await assert.rejects(() => engine.approveIncentiveResult(db, { resultId, actorId: CALCULATOR }), /cannot approve their own result/);

  const [first, second] = await Promise.all([
    engine.approveIncentiveResult(db, { resultId, actorId: MANAGER }),
    engine.approveIncentiveResult(db, { resultId, actorId: "manager.two@pawspace.in" }),
  ]);
  assert.equal([first, second].filter((r) => r.duplicatePrevented).length, 1, "exactly one approval is real");
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM incentive_approval_events WHERE result_id=? AND event_type='approved'").get(resultId).c, 1, "one approval event, not two");
  assert.equal(Number(sqlite.prepare("SELECT approved_amount FROM employee_incentive_results WHERE id=?").get(resultId).approved_amount), 10000);
});

test("adjustments need a second pair of eyes and are included in the approved amount", async () => {
  const { sqlite, db } = fresh();
  seedSalesperson(sqlite, { employeeId: "E-ADJ", email: "adj@pawspace.in", facts: { netCollectedRevenue: 200000 } });
  const { engine, schemeId } = await activeScheme(db, { metric: "net_collected_revenue", target: 100000, payoutType: "percent_of_revenue_above_target", payoutValue: 10 });
  const run = await engine.calculateIncentivePeriod(db, { schemeId, periodStart: MONTH_START, periodEnd: MONTH_END, idempotencyKey: "adj-1", actorId: CALCULATOR });
  const resultId = String(run.results[0].id);

  await assert.rejects(() => engine.addIncentiveAdjustment(db, { resultId, amount: 500, reason: "short", actorId: MANAGER }), /clear reason are required/);
  await assert.rejects(() => engine.addIncentiveAdjustment(db, { resultId, amount: 0, reason: "A zero adjustment makes no sense", actorId: MANAGER }), /Non-zero adjustment/);

  const adjustment = await engine.addIncentiveAdjustment(db, { resultId, amount: 1500, reason: "Agreed correction for a mis-attributed booking", actorId: MANAGER });
  await assert.rejects(() => engine.approveIncentiveAdjustment(db, { adjustmentId: adjustment.id, actorId: MANAGER }), /cannot approve their own change/);
  // A pending (unapproved) adjustment does not change the money.
  const pendingApproval = await engine.approveIncentiveResult(db, { resultId, actorId: "manager.two@pawspace.in" });
  assert.equal(pendingApproval.approvedAmount, 10000, "an unapproved adjustment is not paid");

  // On a fresh result, an APPROVED adjustment is included.
  seedSalesperson(sqlite, { employeeId: "E-ADJ2", email: "adj2@pawspace.in", facts: { netCollectedRevenue: 200000 } });
  const run2 = await engine.calculateIncentivePeriod(db, { schemeId, periodStart: MONTH_START, periodEnd: MONTH_END, idempotencyKey: "adj-2", actorId: CALCULATOR });
  const secondResult = run2.results.find((row) => row.employee_id === "E-ADJ2");
  const adj2 = await engine.addIncentiveAdjustment(db, { resultId: String(secondResult.id), amount: 1500, reason: "Agreed correction for a mis-attributed booking", actorId: MANAGER });
  await engine.approveIncentiveAdjustment(db, { adjustmentId: adj2.id, actorId: "manager.two@pawspace.in" });
  const approved = await engine.approveIncentiveResult(db, { resultId: String(secondResult.id), actorId: MANAGER });
  assert.equal(approved.approvedAmount, 11500);
});

// ---------------------------------------------------------------------------
// 3. Payroll integration: one-time inclusion, reversal as a deduction.
// ---------------------------------------------------------------------------
test("approved incentives reach payroll exactly once and reversals become deductions", async () => {
  const { sqlite, db } = fresh();
  seedSalesperson(sqlite, { employeeId: "E-PAY", email: "pay@pawspace.in", facts: { netCollectedRevenue: 300000 } });
  const { engine, schemeId } = await activeScheme(db, { metric: "net_collected_revenue", target: 100000, payoutType: "percent_of_revenue_above_target", payoutValue: 10 });
  const run = await engine.calculateIncentivePeriod(db, { schemeId, periodStart: MONTH_START, periodEnd: MONTH_END, idempotencyKey: "pay-1", actorId: CALCULATOR });
  const resultId = String(run.results[0].id);
  await engine.approveIncentiveResult(db, { resultId, actorId: MANAGER });

  const entries = await engine.approvedIncentiveEntriesForPayroll(db, { employeeId: "E-PAY", periodStart: MONTH_START, periodEnd: MONTH_END + 1 });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, "earning");
  assert.equal(entries[0].amount, 20000);
  assert.match(entries[0].policyVersion, /incentive_scheme:SALES-BLR:v1/);

  await engine.markIncentiveEntriesIncluded(db, { entries, payrollRunId: "PR-1", payrollResultId: "PRR-1", employeeId: "E-PAY" });
  const second = await engine.approvedIncentiveEntriesForPayroll(db, { employeeId: "E-PAY", periodStart: MONTH_START, periodEnd: MONTH_END + 1 });
  assert.equal(second.length, 0, "an incentive already paid is never offered to payroll again");

  // Disputing payroll-included history is refused; a reversal is the only route.
  await assert.rejects(() => engine.openIncentiveDispute(db, { resultId, reason: "Customer refunded after payout", actorId: MANAGER }), /requires reversal\/correction/);

  const reversal = await engine.reverseIncentiveResult(db, { resultId, amount: 5000, reason: "Customer refunded part of the booking after payout", effectiveAt: MONTH_END, actorId: MANAGER });
  assert.equal(reversal.amount, 5000);
  const withReversal = await engine.approvedIncentiveEntriesForPayroll(db, { employeeId: "E-PAY", periodStart: MONTH_START, periodEnd: MONTH_END + 1 });
  assert.equal(withReversal.length, 1);
  assert.equal(withReversal[0].kind, "deduction");
  assert.equal(withReversal[0].amount, 5000);
  assert.equal(sqlite.prepare("SELECT status FROM employee_incentive_results WHERE id=?").get(resultId).status, "approved", "a partial reversal leaves the result approved");
});

test("reversals can never claw back more than was approved, even concurrently", async () => {
  const { sqlite, db } = fresh();
  seedSalesperson(sqlite, { employeeId: "E-REV", email: "rev@pawspace.in", facts: { netCollectedRevenue: 200000 } });
  const { engine, schemeId } = await activeScheme(db, { metric: "net_collected_revenue", target: 100000, payoutType: "percent_of_revenue_above_target", payoutValue: 10 });
  const run = await engine.calculateIncentivePeriod(db, { schemeId, periodStart: MONTH_START, periodEnd: MONTH_END, idempotencyKey: "rev-1", actorId: CALCULATOR });
  const resultId = String(run.results[0].id);
  await engine.approveIncentiveResult(db, { resultId, actorId: MANAGER });
  const approvedAmount = Number(sqlite.prepare("SELECT approved_amount FROM employee_incentive_results WHERE id=?").get(resultId).approved_amount);
  assert.equal(approvedAmount, 10000);

  await assert.rejects(() => engine.reverseIncentiveResult(db, { resultId, amount: 10001, reason: "Trying to over-reverse the payout", effectiveAt: MONTH_END, actorId: MANAGER }), /cannot exceed the remaining/);

  // Two reversals of 6000 each would be 12000 against a 10000 payout.
  const results = await Promise.allSettled([
    engine.reverseIncentiveResult(db, { resultId, amount: 6000, reason: "First clawback for a refunded booking", effectiveAt: MONTH_END, actorId: MANAGER }),
    engine.reverseIncentiveResult(db, { resultId, amount: 6000, reason: "Second clawback for the same refunded booking", effectiveAt: MONTH_END, actorId: "manager.two@pawspace.in" }),
  ]);
  const total = Number(sqlite.prepare("SELECT COALESCE(SUM(amount),0) total FROM incentive_reversals WHERE result_id=? AND status='approved'").get(resultId).total);
  assert.ok(total <= approvedAmount, `reversals (${total}) must never exceed the approved payout (${approvedAmount})`);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, "the second concurrent clawback is refused");

  // Reversing the remainder closes the result out.
  await engine.reverseIncentiveResult(db, { resultId, amount: 4000, reason: "Remaining clawback after the refund settled", effectiveAt: MONTH_END, actorId: MANAGER });
  assert.equal(sqlite.prepare("SELECT status FROM employee_incentive_results WHERE id=?").get(resultId).status, "reversed");
});

test("an active incentive scheme is immutable and activation needs an approval reference", async () => {
  const { db } = fresh();
  const engine = await import("../lib/incentive-engine.ts");
  const draft = await engine.saveIncentiveScheme(db, { schemeCode: "SALES-BLR", roleCode: "sales_associate", teamCode: "sales_blr", effectiveFrom: MONTH_START, formula: { metric: "qualified_leads", target: 20, payoutType: "amount_per_unit_above_target", payoutValue: 100 }, qualityRules: [], actorId: MANAGER });
  await assert.rejects(() => engine.activateIncentiveScheme(db, { schemeId: String(draft.id), approvalReference: "x", actorId: MANAGER }), /approval reference is required/);
  await engine.activateIncentiveScheme(db, { schemeId: String(draft.id), approvalReference: "BOARD-2026-07", actorId: MANAGER });
  await assert.rejects(
    () => engine.saveIncentiveScheme(db, { schemeCode: "SALES-BLR", roleCode: "sales_associate", teamCode: "sales_blr", effectiveFrom: MONTH_START, formula: { metric: "qualified_leads", target: 1, payoutType: "amount_per_unit_above_target", payoutValue: 9999 }, qualityRules: [], actorId: MANAGER }),
    /immutable/,
  );
  await assert.rejects(
    () => engine.calculateIncentivePeriod(db, { schemeId: String(draft.id), periodStart: MONTH_START - 86400000 * 40, periodEnd: MONTH_START - 86400000, idempotencyKey: "outside-1", actorId: CALCULATOR }),
    /outside scheme validity/,
  );
});

// ---------------------------------------------------------------------------
// 4. Groomer incentive brackets: tier boundaries and cancelled work.
// ---------------------------------------------------------------------------
async function groomerWorld() {
  const { sqlite, db } = fresh();
  const grooming = await import("../lib/grooming-incentive-engine.ts");
  await grooming.ensureGroomingIncentiveTables(db);
  return { sqlite, db, grooming };
}
function groomingBooking(sqlite, { id, providerId, day, amount, status = "completed" }) {
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,service_code,package_name,provider_id,status,scheduled_start,scheduled_end,total_amount,currency,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, `CUS-${id}`, "grooming", "Dog bath", providerId, status, `${day}T05:00:00.000Z`, `${day}T06:00:00.000Z`, amount, "INR", NOW, NOW);
}

// A month only becomes incentive-eligible above Rs.1,00,000 of real order value, so each groomer
// test adds one big single-order day (a day with fewer than 4 orders earns no daily bonus itself)
// to lift the month over the threshold without disturbing the day under test.
function fillerDay(sqlite, providerId, day = "2026-07-05", amount = 100000) {
  groomingBooking(sqlite, { id: `BK-FILL-${providerId}`, providerId, day, amount });
}

test("a month below the eligibility threshold pays nothing at all", async () => {
  const { sqlite, db, grooming } = await groomerWorld();
  await grooming.saveGroomerBracket(db, { headGroomerId: "GRM-LOW", bracket: "single", effectiveFrom: "2026-07-01", reason: "Single groomer, quiet month", actorId: MANAGER });
  for (let index = 1; index <= 5; index++) groomingBooking(sqlite, { id: `BK-LOW-${index}`, providerId: "GRM-LOW", day: "2026-07-10", amount: 1000 });
  const result = await grooming.computeGroomerMonthlyIncentive(db, { headGroomerId: "GRM-LOW", monthStart: "2026-07-01", actorId: MANAGER });
  assert.equal(result.monthTotal, 5000);
  assert.equal(result.eligible, false, "a Rs.5,000 month is below the configured eligibility floor");
  assert.equal(result.headTotal, 0);
  assert.equal(result.helperTotal, 0);
  assert.deepEqual(result.components, {}, "no bonus components are computed for an ineligible month");
});

test("groomer daily bonus needs 4 real completed orders: 3 completed + a cancelled one does not qualify", async () => {
  const { sqlite, db, grooming } = await groomerWorld();
  await grooming.saveGroomerBracket(db, { headGroomerId: "GRM-1", bracket: "single", effectiveFrom: "2026-07-01", reason: "Single groomer for the July cycle", actorId: MANAGER });
  fillerDay(sqlite, "GRM-1");
  for (let index = 1; index <= 3; index++) groomingBooking(sqlite, { id: `BK-OK-${index}`, providerId: "GRM-1", day: "2026-07-10", amount: 1000 });
  groomingBooking(sqlite, { id: "BK-CANCELLED", providerId: "GRM-1", day: "2026-07-10", amount: 1000, status: "cancelled" });

  const three = await grooming.computeGroomerMonthlyIncentive(db, { headGroomerId: "GRM-1", monthStart: "2026-07-01", actorId: MANAGER });
  assert.equal(three.eligible, true);
  assert.equal(three.orderValueTotal, 103000, "the cancelled Rs.1,000 booking is not revenue either");
  const threeDay = three.components.dailyOrderResults.find((row) => row.day === "2026-07-10");
  assert.equal(threeDay.orderCount, 3, "a cancelled booking is not a completed order");
  assert.equal(threeDay.headBonus, 0, "three orders is below the 4-order tier");

  groomingBooking(sqlite, { id: "BK-OK-4", providerId: "GRM-1", day: "2026-07-10", amount: 1000 });
  const four = await grooming.computeGroomerMonthlyIncentive(db, { headGroomerId: "GRM-1", monthStart: "2026-07-01", actorId: MANAGER });
  const fourDay = four.components.dailyOrderResults.find((row) => row.day === "2026-07-10");
  assert.equal(fourDay.orderCount, 4);
  assert.equal(fourDay.tier, 4);
  // Tier 4 single: 30% of the day's Rs.4,000 = Rs.1,200, capped at Rs.500.
  assert.equal(fourDay.headBonus, 500);
  assert.equal(fourDay.helperBonus, 0, "a single-bracket groomer has no helper share");

  groomingBooking(sqlite, { id: "BK-OK-5", providerId: "GRM-1", day: "2026-07-10", amount: 1000 });
  const five = await grooming.computeGroomerMonthlyIncentive(db, { headGroomerId: "GRM-1", monthStart: "2026-07-01", actorId: MANAGER });
  const fiveDay = five.components.dailyOrderResults.find((row) => row.day === "2026-07-10");
  assert.equal(fiveDay.tier, 5, "the fifth order moves the day to the higher tier");
  // Tier 5 single: 40% of Rs.5,000 = Rs.2,000, capped at Rs.1,000.
  assert.equal(fiveDay.headBonus, 1000);
});

test("a team bracket splits the same daily pool 60/40 between head and helper", async () => {
  const { sqlite, db, grooming } = await groomerWorld();
  await grooming.saveGroomerBracket(db, { headGroomerId: "GRM-T", bracket: "team", helperId: "HLP-1", effectiveFrom: "2026-07-01", reason: "Team bracket with a dedicated helper", actorId: MANAGER });
  fillerDay(sqlite, "GRM-T");
  for (let index = 1; index <= 4; index++) groomingBooking(sqlite, { id: `BK-T-${index}`, providerId: "GRM-T", day: "2026-07-12", amount: 500 });
  const result = await grooming.computeGroomerMonthlyIncentive(db, { headGroomerId: "GRM-T", monthStart: "2026-07-01", actorId: MANAGER });
  const day = result.components.dailyOrderResults.find((row) => row.day === "2026-07-12");
  // 30% of Rs.2,000 is Rs.600, capped at Rs.500 => a Rs.500 pool split 60% head / 40% helper.
  assert.equal(day.headBonus, 300);
  assert.equal(day.helperBonus, 200);
  assert.equal(day.headBonus + day.helperBonus, 500, "the split never creates money that was not in the capped pool");

  await assert.rejects(
    () => grooming.saveGroomerBracket(db, { headGroomerId: "GRM-X", bracket: "team", effectiveFrom: "2026-07-01", reason: "Team bracket with nobody in it", actorId: MANAGER }),
    /team bracket requires a real helper/,
  );
  await assert.rejects(
    () => grooming.saveGroomerBracket(db, { headGroomerId: "GRM-X", bracket: "single", effectiveFrom: "2026-07-01", reason: "short", actorId: MANAGER }),
    /real reason is required/,
  );
});

test("a groomer with no configured bracket is never paid a guessed incentive", async () => {
  const { sqlite, db, grooming } = await groomerWorld();
  for (let index = 1; index <= 5; index++) groomingBooking(sqlite, { id: `BK-NB-${index}`, providerId: "GRM-NOBRACKET", day: "2026-07-15", amount: 30000 });
  await assert.rejects(
    () => grooming.computeGroomerMonthlyIncentive(db, { headGroomerId: "GRM-NOBRACKET", monthStart: "2026-07-01", actorId: MANAGER }),
    /no bracket configured/,
  );
  await assert.rejects(
    () => grooming.computeGroomerMonthlyIncentive(db, { headGroomerId: "GRM-NOBRACKET", monthStart: "2026-07-15", actorId: MANAGER }),
    /first day of a month/,
  );
});

test("the incentive month window includes the last day of the month in any timezone", async () => {
  const { sqlite, db, grooming } = await groomerWorld();
  await grooming.saveGroomerBracket(db, { headGroomerId: "GRM-EOM", bracket: "single", effectiveFrom: "2026-07-01", reason: "Single groomer for the month-end check", actorId: MANAGER });
  fillerDay(sqlite, "GRM-EOM");
  for (let index = 1; index <= 4; index++) groomingBooking(sqlite, { id: `BK-EOM-${index}`, providerId: "GRM-EOM", day: "2026-07-31", amount: 1000 });
  // A booking on 1 August must not leak into the July window either.
  groomingBooking(sqlite, { id: "BK-AUG", providerId: "GRM-EOM", day: "2026-08-01", amount: 50000 });
  const result = await grooming.computeGroomerMonthlyIncentive(db, { headGroomerId: "GRM-EOM", monthStart: "2026-07-01", actorId: MANAGER });
  const lastDay = result.components.dailyOrderResults.find((row) => row.day === "2026-07-31");
  assert.ok(lastDay, "work done on 31 July belongs to the July incentive month");
  assert.equal(lastDay.orderCount, 4);
  assert.equal(lastDay.headBonus, 500);
  assert.equal(result.orderValueTotal, 104000, "August work is outside the July window");
});

// ---------------------------------------------------------------------------
// 5. PawPoints: earn/redeem maths, caps, and no negative balances.
// ---------------------------------------------------------------------------
test("PawPoints earn once per completed booking and never for unfinished work", async () => {
  const { sqlite, db } = fresh();
  const points = await import("../lib/paw-points-governance.ts");
  const booking = (id, status, amount) => sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,service_code,package_name,provider_id,status,scheduled_start,scheduled_end,total_amount,currency,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, "CUS-PP", "grooming", "Dog bath", "GRM-1", status, "2026-07-10T05:00:00.000Z", "2026-07-10T06:00:00.000Z", amount, "INR", NOW, NOW);
  booking("BK-DONE", "completed", 1349);
  booking("BK-OPEN", "confirmed", 5000);
  booking("BK-GONE", "cancelled", 5000);

  await assert.rejects(() => points.earnPointsForBooking(db, { bookingId: "BK-OPEN" }), /only on completed bookings/);
  await assert.rejects(() => points.earnPointsForBooking(db, { bookingId: "BK-GONE" }), /only on completed bookings/);
  const earned = await points.earnPointsForBooking(db, { bookingId: "BK-DONE" });
  assert.equal(earned.pointsEarned, 134, "1 point per Rs.10, floored");
  const again = await points.earnPointsForBooking(db, { bookingId: "BK-DONE" });
  assert.equal(again.alreadyCredited, true);
  assert.equal(await points.pawPointsBalance(db, "CUS-PP"), 134, "a booking is credited once, whatever runs");

  const sweep = await points.runPawPointsEarnSweep(db, {});
  assert.equal(sweep.bookingsCredited, 0, "the sweep finds nothing new to credit");
  assert.equal(await points.pawPointsBalance(db, "CUS-PP"), 134);
});

test("PawPoints redemption is capped at 20% of the booking and cannot go negative", async () => {
  const { sqlite, db } = fresh();
  const points = await import("../lib/paw-points-governance.ts");
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,service_code,package_name,provider_id,status,scheduled_start,scheduled_end,total_amount,currency,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("BK-REDEEM", "CUS-R", "grooming", "Dog bath", "GRM-1", "confirmed", "2026-07-20T05:00:00.000Z", "2026-07-20T06:00:00.000Z", 2000, "INR", NOW, NOW);
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,service_code,package_name,provider_id,status,scheduled_start,scheduled_end,total_amount,currency,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("BK-OTHER-CUSTOMER", "CUS-OTHER", "grooming", "Dog bath", "GRM-1", "confirmed", "2026-07-20T05:00:00.000Z", "2026-07-20T06:00:00.000Z", 2000, "INR", NOW, NOW);

  await points.grantGoodwillPoints(db, { customerId: "CUS-R", points: 2000, reason: "Service recovery after a late groomer", actorId: MANAGER });
  await assert.rejects(() => points.grantGoodwillPoints(db, { customerId: "CUS-R", points: 999999, reason: "Way too generous", actorId: MANAGER }), /must be between 1 and 5000/);
  await assert.rejects(() => points.grantGoodwillPoints(db, { customerId: "CUS-R", points: 100, reason: "x", actorId: MANAGER }), /reason for the goodwill grant/);

  await assert.rejects(() => points.redeemPoints(db, { customerId: "CUS-R", points: 100, bookingId: "BK-OTHER-CUSTOMER", actorId: "CUS-R" }), /your own booking/);

  // 2000 points would be Rs.1000, but 20% of a Rs.2000 booking is Rs.400 => 800 points.
  const redeemed = await points.redeemPoints(db, { customerId: "CUS-R", points: 2000, bookingId: "BK-REDEEM", actorId: "CUS-R" });
  assert.equal(redeemed.discountApplied, 400);
  assert.equal(redeemed.pointsRedeemed, 800);
  assert.equal(redeemed.balance, 1200);
  await assert.rejects(() => points.redeemPoints(db, { customerId: "CUS-R", points: 100, bookingId: "BK-REDEEM", actorId: "CUS-R" }), /already been redeemed on this booking/);

  // Two concurrent redemptions on two different bookings cannot overdraw the balance.
  for (const id of ["BK-A", "BK-B"]) {
    sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,service_code,package_name,provider_id,status,scheduled_start,scheduled_end,total_amount,currency,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, "CUS-R", "grooming", "Deluxe spa", "GRM-1", "confirmed", "2026-07-21T05:00:00.000Z", "2026-07-21T06:00:00.000Z", 20000, "INR", NOW, NOW);
  }
  await Promise.allSettled([
    points.redeemPoints(db, { customerId: "CUS-R", points: 1200, bookingId: "BK-A", actorId: "CUS-R" }),
    points.redeemPoints(db, { customerId: "CUS-R", points: 1200, bookingId: "BK-B", actorId: "CUS-R" }),
  ]);
  const finalBalance = await points.pawPointsBalance(db, "CUS-R");
  assert.ok(finalBalance >= 0, `PawPoints balance must never go negative (was ${finalBalance})`);
});

test("win-back grants are once per campaign per customer", async () => {
  const { db } = fresh();
  const points = await import("../lib/paw-points-governance.ts");
  const first = await points.grantWinbackPoints(db, { customerId: "CUS-W", points: 500, campaignKey: "monsoon-2026", actorId: MANAGER });
  assert.equal(first.pointsGranted, 500);
  const replay = await points.grantWinbackPoints(db, { customerId: "CUS-W", points: 500, campaignKey: "monsoon-2026", actorId: MANAGER });
  assert.equal(replay.alreadyGranted, true);
  assert.equal(replay.balance, 500, "re-running a win-back campaign does not stack grants");
  const other = await points.grantWinbackPoints(db, { customerId: "CUS-W", points: 300, campaignKey: "diwali-2026", actorId: MANAGER });
  assert.equal(other.balance, 800, "a genuinely different campaign can grant again");
});

test("incentive modules do not fabricate values or use banned DB access", () => {
  for (const path of [
    "lib/incentive-engine.ts", "lib/grooming-incentive-engine.ts", "lib/paw-points-governance.ts",
    "lib/daily-incentive-accrual.ts", "lib/sales-incentive-engine.ts", "lib/trainer-incentive-engine.ts",
    "lib/live-leaderboard.ts", "lib/referral-governance.ts",
  ]) {
    const source = read(path);
    assert.ok(!/Math\.random/.test(source), `${path} must not fabricate values with Math.random`);
    assert.ok(!/globalThis\.__D1__/.test(source), `${path} must not use the banned globalThis D1 pattern`);
  }
});
