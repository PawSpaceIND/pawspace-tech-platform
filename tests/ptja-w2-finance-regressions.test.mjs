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

// =====================================================================================================
// PTJA-W2-FIN-02 (ledger W2-08-F02, the journal half) — a closed and locked period still accepts manual
// journal postings
//
// closeMonth writes finance_close_periods.status='locked', but the only code that ever READ that row
// was closeMonth itself (plus gst-accounting and people-finance-integration, which govern other
// modules' tables). lib/finance-accounts.ts postJournal - the chokepoint every accounting entry in the
// platform goes through - never looked at it.
//
// MEASURED: after closeMonth('2026-07') returned {"status":"closed"} and left the period 'locked',
//   postJournal({groupKey:'LATE-1',entryDate:'2026-07-15',periodCode:'2026-07',narration:'late posting
//     into a locked period',lines:[6100 debit 50000, 1010 credit 50000]})
// returned {"journalGroup":"JRN-LATE-1","posted":true,"lines":2}. Both rows carry period_code
// '2026-07' and posted=1. finance_close_periods stayed 'locked' with nothing recording that it had been
// written into. The only thing the lock actually blocked was a SECOND closeMonth.
//
// This makes every figure published from a closed month provisional: GST returns, board-approved
// management accounts and the P&L for any locked period can all be contradicted afterwards, silently.
//
// The correction is the one closeMonth's own refusal already prescribes - "post corrections in the next
// open period". A journal dated into a locked month is refused; nothing is redirected or reinterpreted.
// All four existing callers already derive periodCode from their own entryDate, so the accompanying
// consistency check binds an invariant they already satisfy rather than changing any of them.
// =====================================================================================================

async function journalWorld() {
  const { sqlite, db } = world();
  const accounts = await import("../lib/finance-accounts.ts");
  await accounts.ensureFinanceJournalTable(db);
  sqlite.exec("CREATE TABLE IF NOT EXISTS finance_close_periods (period_code text PRIMARY KEY NOT NULL,status text DEFAULT 'open' NOT NULL,checklist_json text NOT NULL,locked_at integer,locked_by text,updated_at integer NOT NULL)");
  const lock = (period) => sqlite.prepare("INSERT INTO finance_close_periods (period_code,status,checklist_json,locked_at,locked_by,updated_at) VALUES (?,'locked','{}',?,'founder@pawspace.in',?)").run(period, Date.now(), Date.now());
  const post = (groupKey, entryDate, periodCode, amount = 50000) => accounts.postJournal(db, {
    groupKey, entryDate, periodCode, sourceType: "manual", sourceId: "X",
    narration: "late posting into a locked period",
    lines: [{ accountCode: "6100-Other Expenses (1)", debit: amount }, { accountCode: "1010-Bank", credit: amount }],
  }).then((value) => ({ ok: true, value }), (error) => ({ ok: false, message: error instanceof Error ? error.message : String(error) }));
  const rows = () => sqlite.prepare("SELECT id,entry_date,period_code,debit,credit FROM finance_journal_entries ORDER BY id").all();
  return { sqlite, db, lock, post, rows };
}

test("W2-FIN-02: a locked period accepts no journal posting", async () => {
  const { lock, post, rows } = await journalWorld();
  lock("2026-07");

  const late = await post("LATE-1", "2026-07-15", "2026-07");
  assert.equal(late.ok, false, `a journal dated into a locked month must be refused: ${JSON.stringify(late)}`);
  assert.equal(rows().length, 0, "and no line may be written");
});

test("W2-FIN-02: a journal cannot be labelled with a period it is not dated in", async () => {
  // Otherwise the lock is trivially walked round, exactly as W2-08-F05 walked round the payroll lock.
  const { lock, post, rows } = await journalWorld();
  lock("2026-07");

  const relabelled = await post("LATE-2", "2026-07-15", "2026-08");
  assert.equal(relabelled.ok, false, `a July-dated journal must not post as August: ${JSON.stringify(relabelled)}`);
  assert.equal(rows().length, 0, "and nothing is written");
});

test("W2-FIN-02: an open period still posts, and a correction still lands in the next open month", async () => {
  // Non-vacuity, and the remedy closeMonth's own refusal prescribes: "post corrections in the next open
  // period". Refusing everything would satisfy the two cases above and stop the books.
  const { lock, post, rows } = await journalWorld();
  lock("2026-07");

  const openMonth = await post("OK-1", "2026-08-02", "2026-08", 50000);
  assert.equal(openMonth.ok, true, `an open period still posts: ${JSON.stringify(openMonth)}`);
  assert.equal(openMonth.value.posted, true, "the journal is written");
  const written = rows();
  assert.equal(written.length, 2, "both lines land");
  assert.ok(written.every((row) => String(row.period_code) === "2026-08"), `in the open period: ${JSON.stringify(written)}`);

  // and a period nobody has closed at all is unaffected
  const untouched = await post("OK-2", "2026-09-09", "2026-09", 1200);
  assert.equal(untouched.ok, true, `a period that was never closed is unaffected: ${JSON.stringify(untouched)}`);
});

// =====================================================================================================
// PTJA-W2-FIN-04 (ledger W2-08-F04) — GST output tax at monthly close is STRUCTURALLY zero
//
// monthlyCloseView computes output GST from `SELECT SUM(tax_total) FROM finance_invoices`, which only
// the separate B2B module lib/gst-accounting.ts ever writes. All five service invoice modules -
// sitting, boarding, walking, taxi and grooming - write their tax into booking_invoices.tax_amount.
// The two never meet, and safeFirst turns the empty/missing source into 0 rather than an error, so an
// absent source read as a satisfied 'gst_computed' check.
//
// MEASURED: two service invoices carrying 1525.42 + 762.71 = Rs 2,288.13 of output tax in 2026-07.
// monthlyCloseView reported gst {"outputTax":0,"eligibleInputTax":0,"netPayable":0,"invoiceCount":0}
// and a green checklist item {"key":"gst_computed","ok":true,"value":0}. closeMonth then locked the
// month with GSTR-3B net payable published as 0 and that zero frozen into the snapshot.
//
// The correction adds the source that was missing. The two tables are disjoint - B2B invoices in
// finance_invoices, service invoices in booking_invoices - so their output tax sums, and nothing is
// double counted. No tax rule is invented: each invoice's own tax_amount, computed by the module that
// issued it, is simply included in the total the close publishes.
// =====================================================================================================

async function closeWorld() {
  const { sqlite, db } = world();
  const close = await import("../lib/finance-monthly-close.ts");
  sqlite.exec(`
CREATE TABLE IF NOT EXISTS booking_invoices (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,invoice_number TEXT NOT NULL UNIQUE,status TEXT NOT NULL DEFAULT 'draft',currency TEXT NOT NULL DEFAULT 'INR',gross_amount REAL NOT NULL,tax_amount REAL NOT NULL DEFAULT 0,net_amount REAL NOT NULL,issued_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS finance_invoices (id TEXT PRIMARY KEY,invoice_number TEXT,issue_date TEXT,status TEXT,tax_total REAL DEFAULT 0);
`);
  // 2026-07 in the close's own window: it shifts by IST, so a mid-month timestamp is unambiguous.
  const july = Date.UTC(2026, 6, 15);
  const serviceInvoice = (id, number, tax, at = july, status = "issued_uat") =>
    sqlite.prepare("INSERT INTO booking_invoices (id,booking_id,customer_id,invoice_number,status,gross_amount,tax_amount,net_amount,issued_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, `BK-${id}`, "CUS-1", number, status, tax * 6, tax, tax * 6, at, at, at);
  const b2bInvoice = (id, number, tax, date = "2026-07-15") =>
    sqlite.prepare("INSERT INTO finance_invoices (id,invoice_number,issue_date,status,tax_total) VALUES (?,?,?,'issued',?)").run(id, number, date, tax);
  const view = () => close.monthlyCloseView(db, { period: "2026-07" });
  return { sqlite, db, close, serviceInvoice, b2bInvoice, view };
}

test("W2-FIN-04: service invoice tax reaches the monthly close's GST output", async () => {
  const { serviceInvoice, view } = await closeWorld();
  serviceInvoice("A", "SIT-BLR-26-27-000001", 1525.42);
  serviceInvoice("B", "SIT-BLR-26-27-000002", 762.71);

  const result = await view();
  assert.equal(result.gst.outputTax, 2288.13,
    `the month's service invoices carry Rs 2,288.13 of output tax: ${JSON.stringify(result.gst)}`);
  assert.equal(result.gst.invoiceCount, 2, "and both invoices are counted");
  assert.equal(result.gst.netPayable, 2288.13, "so GSTR-3B net payable is not zero");
  const item = result.checklist.find((entry) => entry.key === "gst_computed");
  assert.equal(item.value, 2288.13, `the checklist must publish the same figure: ${JSON.stringify(item)}`);
});

test("W2-FIN-04: B2B and service invoices sum, and neither is double counted", async () => {
  // Non-vacuity in both directions: the pre-existing finance_invoices source must keep working, the two
  // sources are disjoint, and a month with nothing in it is still legitimately zero.
  const { serviceInvoice, b2bInvoice, view } = await closeWorld();
  b2bInvoice("F1", "B2B-0001", 1000);
  serviceInvoice("A", "SIT-BLR-26-27-000001", 250);

  const result = await view();
  assert.equal(result.gst.outputTax, 1250, `both sources contribute exactly once: ${JSON.stringify(result.gst)}`);
  assert.equal(result.gst.invoiceCount, 2, "and each invoice is counted once");

  const empty = await closeWorld();
  const emptyResult = await empty.view();
  assert.equal(emptyResult.gst.outputTax, 0, "a month with no invoices is still zero");
});

test("W2-FIN-04: an invoice outside the month, or cancelled, does not count", async () => {
  const { serviceInvoice, view } = await closeWorld();
  serviceInvoice("A", "SIT-BLR-26-27-000001", 500);
  serviceInvoice("C", "SIT-BLR-26-27-000003", 900, Date.UTC(2026, 7, 15));           // August
  serviceInvoice("D", "SIT-BLR-26-27-000004", 700, Date.UTC(2026, 6, 20), "cancelled");

  const result = await view();
  assert.equal(result.gst.outputTax, 500, `only July's live invoices count: ${JSON.stringify(result.gst)}`);
  assert.equal(result.gst.invoiceCount, 1, "and only that one is counted");
});
