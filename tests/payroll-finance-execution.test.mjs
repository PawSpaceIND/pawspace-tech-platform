import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";

// ---------------------------------------------------------------------------
// Payroll → Finance, executed against a real D1-backed database.
//
// tests/people-finance-integration.test.mjs proves most of this by reading the module's source text.
// That cannot show that journal lines are actually written, that they balance, that a retry is absorbed
// rather than double-posting, or that a locked period leaves the ledger untouched. Those are the claims
// a finance reviewer is being asked to trust at UAT sign-off, so they are executed here.
//
// The controlled external handoffs — statutory sandbox export and sandbox bank reconciliation — are
// executed too, and asserted to keep declaring themselves sandbox-only. Neither is a live filing or a
// live bank transmission, and the tests pin that they cannot quietly become one.
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

const ACTOR = "finance@pawspace.in";
const PERIOD = "2026-07";
const RUN = "PAYRUN-2026-07";
const PERIOD_START = Date.UTC(2026, 6, 1);
const PERIOD_END = Date.UTC(2026, 6, 31);

/** Every mapping the poster requires, configured explicitly — no fallback account may be invented. */
const MAPPINGS = [
  ["payroll.salary_expense", "6100-Salary expense"],
  ["payroll.reimbursement_expense", "6110-Reimbursements"],
  ["payroll.employer_cost_expense", "6120-Employer cost"],
  ["payroll.deductions_payable", "2310-Statutory deductions payable"],
  ["payroll.net_pay_payable", "2300-Net pay payable"],
  ["payroll.employer_cost_payable", "2320-Employer cost payable"],
];

const EMPLOYEES = [
  { id: "EMP-1", gross: 60000, deductions: 9000, reimbursements: 2500, employerCost: 4800, net: 53500 },
  { id: "EMP-2", gross: 45000, deductions: 6000, reimbursements: 0, employerCost: 3600, net: 39000 },
];

const totals = EMPLOYEES.reduce((sum, row) => ({
  gross: sum.gross + row.gross, deductions: sum.deductions + row.deductions,
  reimbursements: sum.reimbursements + row.reimbursements, employerCost: sum.employerCost + row.employerCost,
  net: sum.net + row.net,
}), { gross: 0, deductions: 0, reimbursements: 0, employerCost: 0, net: 0 });

async function world({ configureMappings = true, runStatus = "approved" } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PAWSPACE_TEST_ENV = { DB: db };
  const people = await import("../lib/people-finance-integration.ts");
  await people.ensurePeopleFinanceTables(db);
  const payroll = await import("../lib/payroll-engine.ts");
  await payroll.ensurePayrollTables(db);

  sqlite.prepare("INSERT INTO payroll_runs (id,idempotency_key,period_start,period_end,status,input_snapshot_json,created_by,created_at,approved_by,approved_at) VALUES (?,?,?,?,?,'{}',?,?,?,?)")
    .run(RUN, `idem-${RUN}`, PERIOD_START, PERIOD_END, runStatus, ACTOR, Date.now(), "approver@pawspace.in", Date.now());
  for (const employee of EMPLOYEES) {
    sqlite.prepare("INSERT INTO employee_payroll_results (id,run_id,employee_id,structure_id,gross_earnings,total_deductions,reimbursements,employer_cost,net_pay,source_snapshot_json) VALUES (?,?,?,'STRUCT-1',?,?,?,?,?,'{}')")
      .run(`RES-${employee.id}`, RUN, employee.id, employee.gross, employee.deductions, employee.reimbursements, employee.employerCost, employee.net);
  }
  if (configureMappings) {
    for (const [sourceKey, accountCode] of MAPPINGS) {
      await people.configurePayrollAccountMapping(db, { sourceKey, accountCode, approvalReference: "FIN-APPROVAL-2026-07", actorId: ACTOR });
    }
  }
  return { sqlite, db, people };
}

const journalLines = (sqlite) => sqlite.prepare("SELECT * FROM finance_journal_entries WHERE source_type='payroll_run' ORDER BY id").all();
const lockPeriod = (sqlite, periodCode) => sqlite
  .prepare("INSERT INTO finance_close_periods (period_code,status,checklist_json,locked_at,locked_by,updated_at) VALUES (?,'locked','[]',?,?,?) ON CONFLICT(period_code) DO UPDATE SET status='locked'")
  .run(periodCode, Date.now(), ACTOR, Date.now());

// --- payroll journal posting -------------------------------------------------------------------------

test("an approved payroll run posts a balanced journal sourced to that run", async () => {
  const { sqlite, db, people } = await world();
  const result = await people.postPayrollJournal(db, { runId: RUN, periodCode: PERIOD, actorId: ACTOR });

  assert.equal(result.duplicatePrevented, false, "this is the first posting");
  const lines = journalLines(sqlite);
  assert.ok(lines.length > 0, "journal entries are actually persisted, not merely returned");

  const debit = lines.reduce((sum, line) => sum + Number(line.debit), 0);
  const credit = lines.reduce((sum, line) => sum + Number(line.credit), 0);
  assert.equal(Math.round(debit * 100), Math.round(credit * 100), "debits equal credits");
  assert.equal(Math.round(debit * 100), Math.round((totals.gross + totals.reimbursements + totals.employerCost) * 100),
    "and the total is the payroll's own money, not a placeholder");

  for (const line of lines) {
    assert.equal(line.source_type, "payroll_run");
    assert.equal(line.source_id, RUN, "every line is traceable to the payroll run");
    assert.equal(line.period_code, PERIOD);
    assert.equal(Number(line.posted), 1, "payroll postings are posted, so the accounting export can see them");
  }

  const configured = new Set(MAPPINGS.map(([, accountCode]) => accountCode));
  for (const line of lines) {
    assert.ok(configured.has(String(line.account_code)),
      `account ${line.account_code} was never configured — no fallback account may be invented`);
  }

  const post = sqlite.prepare("SELECT * FROM people_payroll_finance_posts WHERE payroll_run_id=?").get(RUN);
  assert.ok(post, "a Finance post record identifies the payroll run");
  assert.equal(post.period_code, PERIOD);
  assert.equal(Math.round(Number(post.total_debit) * 100), Math.round(Number(post.total_credit) * 100));
  assert.equal(post.posted_by, ACTOR);
});

test("NEGATIVE: an unconfigured mapping fails closed and writes no journal", async () => {
  const { sqlite, db, people } = await world({ configureMappings: false });
  await assert.rejects(
    () => people.postPayrollJournal(db, { runId: RUN, periodCode: PERIOD, actorId: ACTOR }),
    /configuration_required/, "a missing account mapping is configuration-required, not a guessed account");
  assert.deepEqual(journalLines(sqlite), [], "nothing is posted");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM people_payroll_finance_posts").get().n, 0);
});

test("NEGATIVE: an unapproved payroll run cannot be posted to Finance", async () => {
  const { sqlite, db, people } = await world({ runStatus: "draft" });
  await assert.rejects(
    () => people.postPayrollJournal(db, { runId: RUN, periodCode: PERIOD, actorId: ACTOR }),
    /Approved payroll is required/);
  assert.deepEqual(journalLines(sqlite), []);
});

// --- idempotency --------------------------------------------------------------------------------------

test("re-posting the same payroll run is absorbed, not duplicated", async () => {
  const { sqlite, db, people } = await world();
  const first = await people.postPayrollJournal(db, { runId: RUN, periodCode: PERIOD, actorId: ACTOR });
  const linesAfterFirst = journalLines(sqlite);
  const groupsAfterFirst = new Set(linesAfterFirst.map((line) => String(line.id).split("-").slice(0, 2).join("-")));

  const second = await people.postPayrollJournal(db, { runId: RUN, periodCode: PERIOD, actorId: ACTOR });
  assert.equal(second.duplicatePrevented, true, "the retry is reported as absorbed");
  assert.equal(second.post.journal_group_id, first.post.journal_group_id, "and returns the existing post");

  const linesAfterSecond = journalLines(sqlite);
  assert.equal(linesAfterSecond.length, linesAfterFirst.length, "the journal line count does not grow");
  assert.deepEqual(linesAfterSecond, linesAfterFirst, "no second journal group is produced");
  const groupsAfterSecond = new Set(linesAfterSecond.map((line) => String(line.id).split("-").slice(0, 2).join("-")));
  assert.equal(groupsAfterSecond.size, groupsAfterFirst.size, "exactly one journal group exists");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM people_payroll_finance_posts WHERE payroll_run_id=?").get(RUN).n, 1);
});

// --- period lock ---------------------------------------------------------------------------------------

test("NEGATIVE: a locked finance period refuses payroll posting and writes nothing", async () => {
  const { sqlite, db, people } = await world();
  lockPeriod(sqlite, PERIOD);
  await assert.rejects(
    () => people.postPayrollJournal(db, { runId: RUN, periodCode: PERIOD, actorId: ACTOR }),
    /period_locked/, "a closed period fails closed");
  assert.deepEqual(journalLines(sqlite), [], "no journal lines are written");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM people_payroll_finance_posts").get().n, 0,
    "and no Finance post record is created");
});

// --- controlled statutory sandbox export ---------------------------------------------------------------

async function statutoryPolicy(db, people) {
  return people.saveStatutoryPolicy(db, {
    policyCode: "IN-PF-ESI", effectiveFrom: PERIOD_START - 86_400_000,
    config: { pfRate: 0.12, esiRate: 0.0075 }, approvalReference: "STAT-APPROVAL-1", actorId: ACTOR,
  });
}

test("the statutory sandbox export carries real payroll totals and stays sandbox-only", async () => {
  const { db, people } = await world();
  const policy = await statutoryPolicy(db, people);
  const result = await people.createSandboxStatutoryExport(db, { runId: RUN, policyVersionId: String(policy.id), periodCode: PERIOD, actorId: ACTOR });

  const payload = JSON.parse(String(result.exportRecord.payload_json));
  assert.equal(payload.sandboxOnly, true);
  assert.equal(payload.externalSubmission, false, "nothing was submitted anywhere");
  assert.equal(payload.submissionReady, false, "and it does not claim to be ready to submit");
  assert.equal(payload.payroll.runId, RUN);
  assert.equal(payload.payroll.employeeCount, EMPLOYEES.length);
  assert.equal(Math.round(payload.payroll.grossEarnings * 100), Math.round(totals.gross * 100),
    "the payload carries the run's actual totals, not a template");
  assert.equal(Math.round(payload.payroll.netPay * 100), Math.round(totals.net * 100));
  assert.equal(result.duplicatePrevented, false);
});

test("NEGATIVE: a statutory export requires an explicit effective policy", async () => {
  const { db, people } = await world();
  await assert.rejects(
    () => people.createSandboxStatutoryExport(db, { runId: RUN, policyVersionId: "STATPOL-does-not-exist", periodCode: PERIOD, actorId: ACTOR }),
    /statutory policy version is required/i, "no policy means no export");
});

test("NEGATIVE: an unapproved run cannot produce a statutory export", async () => {
  const { db, people } = await world({ runStatus: "draft" });
  const policy = await statutoryPolicy(db, people);
  await assert.rejects(
    () => people.createSandboxStatutoryExport(db, { runId: RUN, policyVersionId: String(policy.id), periodCode: PERIOD, actorId: ACTOR }),
    /Approved payroll is required/);
});

test("retrying the same run and policy produces no duplicate export record", async () => {
  const { sqlite, db, people } = await world();
  const policy = await statutoryPolicy(db, people);
  const first = await people.createSandboxStatutoryExport(db, { runId: RUN, policyVersionId: String(policy.id), periodCode: PERIOD, actorId: ACTOR });
  const second = await people.createSandboxStatutoryExport(db, { runId: RUN, policyVersionId: String(policy.id), periodCode: PERIOD, actorId: ACTOR });

  assert.equal(second.duplicatePrevented, true);
  assert.equal(second.exportRecord.id, first.exportRecord.id, "the same record is returned");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM people_statutory_exports WHERE payroll_run_id=?").get(RUN).n, 1,
    "exactly one export record exists");
});

// --- controlled sandbox bank reconciliation --------------------------------------------------------------

function sandboxBatch(sqlite, { total, transmission = 0, status = "sandbox_prepared" }) {
  sqlite.prepare("INSERT INTO payroll_payment_batches (id,run_id,status,instruction_count,total_amount,external_transmission,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run("BATCH-1", RUN, status, EMPLOYEES.length, total, transmission, ACTOR, Date.now());
  return "BATCH-1";
}

test("an exactly matching sandbox reconciliation reconciles against its payroll batch", async () => {
  const { sqlite, db, people } = await world();
  const batchId = sandboxBatch(sqlite, { total: totals.net });
  const result = await people.recordSandboxBankReconciliation(db, {
    payrollBatchId: batchId, periodCode: PERIOD, sandboxReference: "SBX-REF-0001", matchedAmount: totals.net, actorId: ACTOR,
  });

  assert.equal(result.reconciliation.status, "matched_uat", "an exact match reconciles");
  assert.equal(result.reconciliation.payroll_batch_id, batchId, "bound to the expected payroll batch");
  assert.equal(Math.round(Number(result.reconciliation.expected_amount) * 100), Math.round(totals.net * 100));
  assert.equal(Number(result.reconciliation.sandbox_only), 1);
  assert.equal(Number(result.reconciliation.external_transmission), 0, "no live bank transmission occurred");
});

test("NEGATIVE: a mismatched amount records an exception rather than reporting success", async () => {
  const { sqlite, db, people } = await world();
  const batchId = sandboxBatch(sqlite, { total: totals.net });
  const result = await people.recordSandboxBankReconciliation(db, {
    payrollBatchId: batchId, periodCode: PERIOD, sandboxReference: "SBX-REF-0002", matchedAmount: totals.net - 1500, actorId: ACTOR,
  });
  assert.equal(result.reconciliation.status, "exception_uat", "a variance is an exception, not a reconciliation");
  assert.notEqual(Math.round(Number(result.reconciliation.matched_amount) * 100), Math.round(Number(result.reconciliation.expected_amount) * 100));
});

test("repeating the identical reconciliation does not create a second financial truth", async () => {
  const { sqlite, db, people } = await world();
  const batchId = sandboxBatch(sqlite, { total: totals.net });
  const input = { payrollBatchId: batchId, periodCode: PERIOD, sandboxReference: "SBX-REF-0001", matchedAmount: totals.net, actorId: ACTOR };
  const first = await people.recordSandboxBankReconciliation(db, input);
  const second = await people.recordSandboxBankReconciliation(db, input);

  assert.equal(second.duplicatePrevented, true);
  assert.equal(second.reconciliation.id, first.reconciliation.id);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM people_bank_reconciliation_refs WHERE payroll_batch_id=?").get(batchId).n, 1);
});

test("NEGATIVE: a conflicting restatement is refused rather than silently overwriting", async () => {
  const { sqlite, db, people } = await world();
  const batchId = sandboxBatch(sqlite, { total: totals.net });
  await people.recordSandboxBankReconciliation(db, { payrollBatchId: batchId, periodCode: PERIOD, sandboxReference: "SBX-REF-0001", matchedAmount: totals.net, actorId: ACTOR });
  await assert.rejects(
    () => people.recordSandboxBankReconciliation(db, { payrollBatchId: batchId, periodCode: PERIOD, sandboxReference: "SBX-REF-9999", matchedAmount: 1, actorId: ACTOR }),
    /already recorded/, "restating a reconciliation needs an explicit correction workflow");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM people_bank_reconciliation_refs WHERE payroll_batch_id=?").get(batchId).n, 1);
});

test("NEGATIVE: a batch already marked for external transmission is not eligible for sandbox reconciliation", async () => {
  // The gate that keeps this path controlled: sandbox reconciliation only accepts a batch that has NOT
  // been handed to a real bank, so it cannot be used to rubber-stamp a live transfer.
  const { sqlite, db, people } = await world();
  const batchId = sandboxBatch(sqlite, { total: totals.net, transmission: 1 });
  await assert.rejects(
    () => people.recordSandboxBankReconciliation(db, { payrollBatchId: batchId, periodCode: PERIOD, sandboxReference: "SBX-REF-0001", matchedAmount: totals.net, actorId: ACTOR }),
    /Sandbox payroll payment batch is required/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM people_bank_reconciliation_refs").get().n, 0);
});

test("NEGATIVE: a locked period refuses sandbox reconciliation", async () => {
  const { sqlite, db, people } = await world();
  const batchId = sandboxBatch(sqlite, { total: totals.net });
  lockPeriod(sqlite, PERIOD);
  await assert.rejects(
    () => people.recordSandboxBankReconciliation(db, { payrollBatchId: batchId, periodCode: PERIOD, sandboxReference: "SBX-REF-0001", matchedAmount: totals.net, actorId: ACTOR }),
    /period_locked/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM people_bank_reconciliation_refs").get().n, 0);
});
