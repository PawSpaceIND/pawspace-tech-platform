/**
 * PawSpace Total Journey Audit, Wave 2 — permanent behavioural regressions for the confirmed Finance
 * defects.
 *
 * Every case here EXECUTES the real module. That matters more than usual in this domain: the existing
 * tests/people-finance-integration.test.mjs is source_contract only - it reads lib/people-finance-
 * integration.ts and matches regexes - so its case "Finance period locks gate employee expense links
 * payroll journals statutory exports and reconciliations" passed for the whole life of the bypass below.
 * The string it pins really is present. The control it names was still walkable.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__PTJA_W2FIN_DB__", "__PTJA_W2FIN_ENV__");

function makeD1(sqlite) {
  const statement = (sql, args = []) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes || 0) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  let depth = 0;
  return {
    prepare: (sql) => statement(sql),
    batch: async (items) => {
      const outer = depth === 0;
      if (outer) sqlite.exec("BEGIN IMMEDIATE");
      depth += 1;
      try { const out = []; for (const item of items) out.push(await item.run()); if (outer) sqlite.exec("COMMIT"); return out; }
      catch (error) { if (outer) sqlite.exec("ROLLBACK"); throw error; }
      finally { depth -= 1; }
    },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

function world(env = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PTJA_W2FIN_DB__ = db;
  globalThis.__PTJA_W2FIN_ENV__ = env;
  return { sqlite, db };
}

// =====================================================================================================
// PTJA-W2-FIN-01 (ledger W2-08-F05) — the payroll period lock is bypassed by DECLARING a different
// period: the caller supplies period_code, the journal rows' entry_date comes from the payroll run, and
// the P&L buckets by entry_date
//
// MEASURED: finance_close_periods 2026-07 status='locked'; payroll run RUN-JUL with period_end
// 2026-07-31 and Rs 430,000 of approved payroll.
//   postPayrollJournal({runId:'RUN-JUL',periodCode:'2026-07'}) -> Error 'period_locked'. The control
//     fires correctly when the caller is honest.
//   postPayrollJournal({runId:'RUN-JUL',periodCode:'2026-08'}) -> SUCCESS. Six finance_journal_entries
//     rows, ALL entry_date='2026-07-31', ALL period_code='2026-08', total_debit 430000.
//   generatePnlReport('2026-07') -> totalExpenses 430000. generatePnlReport('2026-08') -> 0.
//
// So Rs 430,000 of expense landed in a LOCKED month, and the books split in two: every period_code-keyed
// report (the accounting export, people_payroll_finance_posts) puts it in August while the P&L, which
// buckets by monthKey(entry_date), puts it in July. That is true of EVERY posting whose declared period
// disagrees with its dates, lock or no lock.
//
// The correction invents no policy and picks no side. A payroll journal's period is not a free parameter
// - the entries are dated from the run's own period_end - so a declared period that disagrees with the
// dates is refused rather than silently relabelled, and the lock is then checked against the period the
// money actually lands in. A human decides what to do about a genuine cross-period payroll; the platform
// stops writing two contradictory sets of books on its own.
// =====================================================================================================

async function payrollWorld({ lockedPeriod = null } = {}) {
  const { sqlite, db } = world();
  const people = await import("../lib/people-finance-integration.ts");
  await people.ensurePeopleFinanceTables(db);
  const now = Date.now();
  for (const key of people.requiredPayrollAccountKeys) {
    await db.prepare("INSERT INTO people_finance_account_mappings (source_key,account_code,approval_reference,updated_by,updated_at) VALUES (?,?,?,?,?)")
      .bind(key, key.includes("payable") ? "2300-Statutory Payable" : "6150-Salary and Remuneration (1)", "BOARD-2026-07", "fin@pawspace.in", now).run();
  }
  await db.prepare("INSERT INTO payroll_runs (id,idempotency_key,period_start,period_end,status,input_snapshot_json,created_by,created_at,approved_by,approved_at) VALUES ('RUN-JUL','ptja-w2-fin-run',?,?,'approved','{}','fin@pawspace.in',?,'fin@pawspace.in',?)")
    .bind(Date.UTC(2026, 6, 1), Date.UTC(2026, 6, 31), now, now).run();
  await db.prepare("INSERT INTO employee_payroll_results (id,run_id,employee_id,structure_id,gross_earnings,total_deductions,reimbursements,employer_cost,net_pay,source_snapshot_json) VALUES ('EPR-1','RUN-JUL','EMP-1','STR-1',400000,40000,10000,20000,370000,'{}')").run();
  if (lockedPeriod) {
    await db.prepare("INSERT INTO finance_close_periods (period_code,status,checklist_json,locked_at,locked_by,updated_at) VALUES (?,'locked','{}',?,'founder@pawspace.in',?)")
      .bind(lockedPeriod, now, now).run();
  }
  const post = (periodCode) => people.postPayrollJournal(db, { runId: "RUN-JUL", periodCode, actorId: "fin@pawspace.in" })
    .then((value) => ({ ok: true, value }), (error) => ({ ok: false, message: error instanceof Error ? error.message : String(error) }));
  const journal = () => sqlite.prepare("SELECT entry_date,period_code,debit,credit FROM finance_journal_entries ORDER BY id").all();
  return { sqlite, db, people, post, journal };
}

test("W2-FIN-01: a locked payroll period cannot be written into by declaring an open one", async () => {
  const { post, journal, sqlite } = await payrollWorld({ lockedPeriod: "2026-07" });

  const honest = await post("2026-07");
  assert.equal(honest.ok, false, "the honest declaration is refused - the control works when nobody lies");
  assert.equal(honest.message, "period_locked", `for the right reason: ${JSON.stringify(honest)}`);

  const relabelled = await post("2026-08"); // same run, same dates, a different label
  assert.equal(relabelled.ok, false,
    `relabelling the period must not post the identical journal into the locked month: ${JSON.stringify(relabelled)}`);
  assert.equal(journal().length, 0, "no journal line may be written");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM people_payroll_finance_posts").get().n, 0, "and no posting record");
});

test("W2-FIN-01: a payroll journal's declared period must agree with the dates it posts", async () => {
  // The books-split half, independent of any lock: an entry_date of 2026-07-31 under period_code
  // 2026-08 means the accounting export for a period omits entries the P&L for that period includes.
  const { post, journal } = await payrollWorld();

  const mismatched = await post("2026-08");
  assert.equal(mismatched.ok, false,
    `a declared period that disagrees with the run's own dates must be refused: ${JSON.stringify(mismatched)}`);
  assert.equal(journal().length, 0, "nothing is posted under a period it is not dated in");
});

test("W2-FIN-01: an honest posting into an open period still works, and still balances", async () => {
  // Non-vacuity. Refusing every payroll posting would satisfy the two cases above and break payroll.
  const { post, journal, sqlite } = await payrollWorld();

  const posted = await post("2026-07");
  assert.equal(posted.ok, true, `an honest posting into an open period must succeed: ${JSON.stringify(posted)}`);
  const lines = journal();
  assert.equal(lines.length, 6, "all six payroll lines are written");
  assert.ok(lines.every((line) => String(line.period_code) === "2026-07" && String(line.entry_date).startsWith("2026-07")),
    `every line carries the period it is dated in: ${JSON.stringify(lines)}`);
  const debit = lines.reduce((sum, line) => sum + Number(line.debit || 0), 0);
  const credit = lines.reduce((sum, line) => sum + Number(line.credit || 0), 0);
  assert.equal(debit, 430000, "the debits are the run's full cost");
  assert.equal(debit, credit, "and the journal balances");
  assert.equal(String(sqlite.prepare("SELECT period_code FROM people_payroll_finance_posts WHERE payroll_run_id='RUN-JUL'").get().period_code), "2026-07",
    "the posting record agrees with the journal");
});

test("W2-FIN-01: the sandbox statutory export cannot be labelled with a period the run is not dated in", async () => {
  // Same shape, verified here rather than assumed: createSandboxStatutoryExport also takes a
  // caller-supplied periodCode alongside a runId whose dates the module already knows, and stamps that
  // period into the exported payload.
  const { db, people } = await payrollWorld({ lockedPeriod: "2026-07" });
  const policy = await people.saveStatutoryPolicy(db, {
    policyCode: "pf_esi", effectiveFrom: Date.UTC(2026, 0, 1), config: { pfRate: 0.12 },
    approvalReference: "BOARD-2026-07", actorId: "fin@pawspace.in",
  });
  const attempt = await people.createSandboxStatutoryExport(db, {
    runId: "RUN-JUL", policyVersionId: String(policy.id), periodCode: "2026-08", actorId: "fin@pawspace.in",
  }).then((value) => ({ ok: true, value }), (error) => ({ ok: false, message: error instanceof Error ? error.message : String(error) }));
  assert.equal(attempt.ok, false,
    `a statutory export must not be labelled with a period the payroll run is not dated in: ${JSON.stringify(attempt)}`);
});
