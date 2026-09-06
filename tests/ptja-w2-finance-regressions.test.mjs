/** PawSpace Total Journey Audit, Wave 2 — executable finance regressions. */
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
  if (lockedPeriod) await db.prepare("INSERT INTO finance_close_periods (period_code,status,checklist_json,locked_at,locked_by,updated_at) VALUES (?,'locked','{}',?,'founder@pawspace.in',?)").bind(lockedPeriod, now, now).run();
  const post = (periodCode) => people.postPayrollJournal(db, { runId: "RUN-JUL", periodCode, actorId: "fin@pawspace.in" }).then((value) => ({ ok: true, value }), (error) => ({ ok: false, message: error instanceof Error ? error.message : String(error) }));
  const journal = () => sqlite.prepare("SELECT entry_date,period_code,debit,credit FROM finance_journal_entries ORDER BY id").all();
  return { sqlite, db, people, post, journal };
}

test("W2-FIN-01: a locked payroll period cannot be written into by declaring an open one", async () => {
  const { post, journal, sqlite } = await payrollWorld({ lockedPeriod: "2026-07" });
  const honest = await post("2026-07");
  assert.equal(honest.ok, false);
  assert.equal(honest.message, "period_locked");
  const relabelled = await post("2026-08");
  assert.equal(relabelled.ok, false);
  assert.equal(journal().length, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM people_payroll_finance_posts").get().n, 0);
});

test("W2-FIN-01: a payroll journal's declared period must agree with the dates it posts", async () => {
  const { post, journal } = await payrollWorld();
  const mismatched = await post("2026-08");
  assert.equal(mismatched.ok, false);
  assert.equal(journal().length, 0);
});

test("W2-FIN-01: an honest posting into an open period still works, and still balances", async () => {
  const { post, journal, sqlite } = await payrollWorld();
  const posted = await post("2026-07");
  assert.equal(posted.ok, true, JSON.stringify(posted));
  const lines = journal();
  assert.equal(lines.length, 6);
  assert.ok(lines.every((line) => String(line.period_code) === "2026-07" && String(line.entry_date).startsWith("2026-07")));
  const debit = lines.reduce((sum, line) => sum + Number(line.debit || 0), 0);
  const credit = lines.reduce((sum, line) => sum + Number(line.credit || 0), 0);
  assert.equal(debit, 430000);
  assert.equal(debit, credit);
  assert.equal(String(sqlite.prepare("SELECT period_code FROM people_payroll_finance_posts WHERE payroll_run_id='RUN-JUL'").get().period_code), "2026-07");
});

test("W2-FIN-01: the sandbox statutory export cannot be labelled with a period the run is not dated in", async () => {
  const { db, people } = await payrollWorld();
  const policy = await people.saveStatutoryPolicy(db, { policyCode: "pf_esi", effectiveFrom: Date.UTC(2026, 0, 1), config: { pfRate: 0.12 }, approvalReference: "BOARD-2026-07", actorId: "fin@pawspace.in" });
  const attempt = await people.createSandboxStatutoryExport(db, { runId: "RUN-JUL", policyVersionId: String(policy.id), periodCode: "2026-08", actorId: "fin@pawspace.in" }).then((value) => ({ ok: true, value }), (error) => ({ ok: false, message: error instanceof Error ? error.message : String(error) }));
  assert.equal(attempt.ok, false);
  assert.match(String(attempt.message ?? ""), /period_mismatch/);
  const honest = await people.createSandboxStatutoryExport(db, { runId: "RUN-JUL", policyVersionId: String(policy.id), periodCode: "2026-07", actorId: "fin@pawspace.in" }).then((value) => ({ ok: true, value }), (error) => ({ ok: false, message: error instanceof Error ? error.message : String(error) }));
  assert.equal(honest.ok, true, JSON.stringify(honest));
});

async function journalWorld() {
  const { sqlite, db } = world();
  const accounts = await import("../lib/finance-accounts.ts");
  await accounts.ensureFinanceJournalTable(db);
  sqlite.exec("CREATE TABLE IF NOT EXISTS finance_close_periods (period_code text PRIMARY KEY NOT NULL,status text DEFAULT 'open' NOT NULL,checklist_json text NOT NULL,locked_at integer,locked_by text,updated_at integer NOT NULL)");
  const lock = (period) => sqlite.prepare("INSERT INTO finance_close_periods (period_code,status,checklist_json,locked_at,locked_by,updated_at) VALUES (?,'locked','{}',?,'founder@pawspace.in',?)").run(period, Date.now(), Date.now());
  const post = (groupKey, entryDate, periodCode, amount = 50000) => accounts.postJournal(db, { groupKey, entryDate, periodCode, sourceType: "manual", sourceId: "X", narration: "late posting into a locked period", lines: [{ accountCode: "6100-Other Expenses (1)", debit: amount }, { accountCode: "1010-Bank", credit: amount }] }).then((value) => ({ ok: true, value }), (error) => ({ ok: false, message: error instanceof Error ? error.message : String(error) }));
  const rows = () => sqlite.prepare("SELECT id,entry_date,period_code,debit,credit FROM finance_journal_entries ORDER BY id").all();
  return { sqlite, db, lock, post, rows };
}

test("W2-FIN-02: a locked period accepts no journal posting", async () => {
  const { lock, post, rows } = await journalWorld();
  lock("2026-07");
  const late = await post("LATE-1", "2026-07-15", "2026-07");
  assert.equal(late.ok, false);
  assert.equal(rows().length, 0);
});

test("W2-FIN-02: a journal cannot be labelled with a period it is not dated in", async () => {
  const { lock, post, rows } = await journalWorld();
  lock("2026-07");
  const relabelled = await post("LATE-2", "2026-07-15", "2026-08");
  assert.equal(relabelled.ok, false);
  assert.equal(rows().length, 0);
});

test("W2-FIN-02: an open period still posts, and a correction still lands in the next open month", async () => {
  const { lock, post, rows } = await journalWorld();
  lock("2026-07");
  const openMonth = await post("OK-1", "2026-08-02", "2026-08", 50000);
  assert.equal(openMonth.ok, true, JSON.stringify(openMonth));
  assert.equal(openMonth.value.posted, true);
  assert.equal(rows().length, 2);
  assert.ok(rows().every((row) => String(row.period_code) === "2026-08"));
  const untouched = await post("OK-2", "2026-09-09", "2026-09", 1200);
  assert.equal(untouched.ok, true, JSON.stringify(untouched));
});

async function closeWorld() {
  const { sqlite, db } = world();
  const close = await import("../lib/finance-monthly-close.ts");
  sqlite.exec(`
CREATE TABLE IF NOT EXISTS booking_invoices (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,invoice_number TEXT NOT NULL UNIQUE,status TEXT NOT NULL DEFAULT 'draft',currency TEXT NOT NULL DEFAULT 'INR',gross_amount REAL NOT NULL,tax_amount REAL NOT NULL DEFAULT 0,net_amount REAL NOT NULL,issued_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS finance_invoices (id TEXT PRIMARY KEY,invoice_number TEXT,issue_date TEXT,status TEXT,tax_total REAL DEFAULT 0);
CREATE TABLE IF NOT EXISTS payroll_runs (id TEXT PRIMARY KEY,period_start INTEGER,period_end INTEGER,status TEXT);
CREATE TABLE IF NOT EXISTS employee_payroll_results (id TEXT PRIMARY KEY,run_id TEXT,employee_id TEXT,gross_earnings REAL);
CREATE TABLE IF NOT EXISTS provider_commercial_terms (id TEXT PRIMARY KEY,engagement_model TEXT);
CREATE TABLE IF NOT EXISTS provider_payout_computations (booking_id TEXT,provider_id TEXT,provider_net_payout REAL,computed_at INTEGER,term_id TEXT);
CREATE TABLE IF NOT EXISTS boarding_host_settlement_ledger (booking_id TEXT,provider_id TEXT,payout_amount REAL,eligible_at INTEGER);
`);
  const july = Date.UTC(2026, 6, 15);
  const serviceInvoice = (id, number, tax, at = july, status = "issued_uat") => sqlite.prepare("INSERT INTO booking_invoices (id,booking_id,customer_id,invoice_number,status,gross_amount,tax_amount,net_amount,issued_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(id, `BK-${id}`, "CUS-1", number, status, tax * 6, tax, tax * 6, at, at, at);
  const b2bInvoice = (id, number, tax, date = "2026-07-15") => sqlite.prepare("INSERT INTO finance_invoices (id,invoice_number,issue_date,status,tax_total) VALUES (?,?,?,'issued',?)").run(id, number, date, tax);
  const view = () => close.monthlyCloseView(db, { period: "2026-07", actorId: "finance@test" });
  return { sqlite, db, close, serviceInvoice, b2bInvoice, view };
}

test("W2-FIN-04: service invoice tax reaches the monthly close's GST output", async () => {
  const { serviceInvoice, view } = await closeWorld();
  serviceInvoice("A", "SIT-BLR-26-27-000001", 1525.42);
  serviceInvoice("B", "SIT-BLR-26-27-000002", 762.71);
  const result = await view();
  assert.equal(result.gst.outputTax, 2288.13);
  assert.equal(result.gst.invoiceCount, 2);
  assert.equal(result.gst.netPayable, 2288.13);
  assert.equal(result.checklist.find((entry) => entry.key === "gst_computed").value, 2288.13);
});

test("W2-FIN-04: B2B and service invoices sum, and neither is double counted", async () => {
  const { serviceInvoice, b2bInvoice, view } = await closeWorld();
  b2bInvoice("F1", "B2B-0001", 1000);
  serviceInvoice("A", "SIT-BLR-26-27-000001", 250);
  const result = await view();
  assert.equal(result.gst.outputTax, 1250);
  assert.equal(result.gst.invoiceCount, 2);
  const empty = await closeWorld();
  const emptyResult = await empty.view();
  assert.equal(emptyResult.gst.outputTax, 0);
});

test("W2-FIN-04: an invoice outside the month, or cancelled, does not count", async () => {
  const { serviceInvoice, view } = await closeWorld();
  serviceInvoice("A", "SIT-BLR-26-27-000001", 500);
  serviceInvoice("C", "SIT-BLR-26-27-000003", 900, Date.UTC(2026, 7, 15));
  serviceInvoice("D", "SIT-BLR-26-27-000004", 700, Date.UTC(2026, 6, 20), "cancelled");
  const result = await view();
  assert.equal(result.gst.outputTax, 500);
  assert.equal(result.gst.invoiceCount, 1);
});

test("W2-FIN-05: operational finance records cannot be dated into a closed month", async () => {
  const sitting = await import("../lib/sitting-finance-governance.ts");
  await import("../lib/sitting-invoice.ts");
  const accounts = await import("../lib/finance-accounts.ts");
  assert.equal(sitting.mutateSittingFinance.length >= 2, true);
  const invoiceSource = (await import("node:fs")).readFileSync("lib/sitting-invoice.ts", "utf8");
  assert.match(invoiceSource, /export async function issueSittingInvoice\(db:D1Database,input:\{bookingId:string;reason:string;actorId:string\}\)/);
  assert.doesNotMatch(invoiceSource, /input\.issuedAt|input\.issueDate|input\.periodCode/);
  const financeSource = (await import("node:fs")).readFileSync("lib/sitting-finance-governance.ts", "utf8");
  assert.doesNotMatch(financeSource, /input\.entryDate|input\.periodCode|input\.refundDate/);
  const { sqlite, db } = world();
  await accounts.ensureFinanceJournalTable(db);
  sqlite.exec("CREATE TABLE IF NOT EXISTS finance_close_periods (period_code text PRIMARY KEY NOT NULL,status text DEFAULT 'open' NOT NULL,checklist_json text NOT NULL,locked_at integer,locked_by text,updated_at integer NOT NULL)");
  sqlite.prepare("INSERT INTO finance_close_periods (period_code,status,checklist_json,locked_at,locked_by,updated_at) VALUES ('2026-07','locked','{}',?,'founder@pawspace.in',?)").run(Date.now(), Date.now());
  const backdated = await accounts.postJournal(db, { groupKey: "BACKDATED-1", entryDate: "2026-07-31", periodCode: "2026-07", sourceType: "manual", sourceId: "X", narration: "an operational correction, backdated into the locked month", lines: [{ accountCode: "6100-Other Expenses (1)", debit: 1000 }, { accountCode: "1010-Bank", credit: 1000 }] }).then(() => ({ ok: true }), (error) => ({ ok: false, message: String(error?.message ?? error) }));
  assert.equal(backdated.ok, false);
  assert.match(backdated.message, /period_locked/);
});

test("W2-FIN-06: the P&L publishes the frozen close figure alongside its own for a locked month", async () => {
  const { sqlite, db } = world();
  const pnl = await import("../lib/pnl-reporting.ts");
  sqlite.exec("CREATE TABLE IF NOT EXISTS finance_monthly_closes (period TEXT PRIMARY KEY,status TEXT NOT NULL DEFAULT 'open',snapshot_json TEXT NOT NULL DEFAULT '{}',closed_by TEXT,closed_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,service_code TEXT,status TEXT,total_amount REAL,scheduled_start TEXT,created_at INTEGER,updated_at INTEGER)");
  const now = Date.now();
  sqlite.prepare("INSERT INTO finance_monthly_closes (period,status,snapshot_json,closed_by,closed_at,created_at,updated_at) VALUES ('2026-07','closed',?,'founder@pawspace.in',?,?,?)").run(JSON.stringify({ revenue: { bookings: 15000, bookingCount: 2, foodOrders: 0, foodOrderCount: 0, total: 15000 } }), now, now, now);
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,service_code,status,total_amount,scheduled_start,created_at,updated_at) VALUES ('BK-A','CUS-1','grooming','cancelled',10000,'2026-07-10T09:00:00.000Z',?,?)").run(now, now);
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,service_code,status,total_amount,scheduled_start,created_at,updated_at) VALUES ('BK-B','CUS-2','grooming','completed',5000,'2026-07-12T09:00:00.000Z',?,?)").run(now, now);
  const report = await pnl.generatePnlReport(db, { fromMonth: "2026-07", toMonth: "2026-07" });
  const locked = (report.closedPeriods || []).find((entry) => entry.month === "2026-07");
  assert.ok(locked);
  assert.equal(locked.snapshotTurnoverAmount, 15000);
  assert.equal(locked.liveTurnoverAmount, report.totalTurnoverAmount);
  assert.notEqual(locked.divergenceAmount, 0);
  assert.equal(report.dataSource, "platform_live_with_closed_periods");
});

test("W2-FIN-06: a range with no closed month is unchanged", async () => {
  const { sqlite, db } = world();
  const pnl = await import("../lib/pnl-reporting.ts");
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,service_code TEXT,status TEXT,total_amount REAL,scheduled_start TEXT,created_at INTEGER,updated_at INTEGER)");
  const now = Date.now();
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,service_code,status,total_amount,scheduled_start,created_at,updated_at) VALUES ('BK-C','CUS-3','grooming','completed',5000,'2026-09-12T09:00:00.000Z',?,?)").run(now, now);
  const report = await pnl.generatePnlReport(db, { fromMonth: "2026-09", toMonth: "2026-09" });
  assert.deepEqual(report.closedPeriods, []);
  assert.equal(report.dataSource, "platform_live");
});
