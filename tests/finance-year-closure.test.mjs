import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

function makeD1(sqlite) {
  function statement(sql, args) { return { bind: (...bound) => statement(sql, bound), first: async () => sqlite.prepare(sql).get(...args) ?? null, run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; }, all: async () => ({ results: sqlite.prepare(sql).all(...args) }) }; }
  return { prepare: sql => statement(sql, []), batch: async list => { const out = []; for (const item of list) out.push(await item.run()); return out; }, exec: async sql => sqlite.exec(sql) };
}

const months = ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11", "2026-12", "2027-01", "2027-02", "2027-03"];
const hash = async value => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, "0")).join("");

test("complete 12-period Finance test year contains every required ledger family and balanced journals", async () => {
  const sqlite = new DatabaseSync(":memory:"), db = makeD1(sqlite);
  sqlite.exec(`
    CREATE TABLE e2e100_finance_year_periods (period_code TEXT PRIMARY KEY,status TEXT NOT NULL);
    CREATE TABLE e2e100_finance_year_invoices (id TEXT PRIMARY KEY,period_code TEXT NOT NULL,amount REAL NOT NULL,status TEXT NOT NULL);
    CREATE TABLE e2e100_finance_year_refunds (id TEXT PRIMARY KEY,period_code TEXT NOT NULL,invoice_id TEXT NOT NULL,amount REAL NOT NULL,status TEXT NOT NULL);
    CREATE TABLE e2e100_finance_year_credit_notes (id TEXT PRIMARY KEY,period_code TEXT NOT NULL,invoice_id TEXT NOT NULL,amount REAL NOT NULL,status TEXT NOT NULL);
    CREATE TABLE e2e100_finance_year_gst (id TEXT PRIMARY KEY,period_code TEXT NOT NULL,component TEXT NOT NULL,amount REAL NOT NULL);
    CREATE TABLE e2e100_finance_year_payroll (id TEXT PRIMARY KEY,period_code TEXT NOT NULL,net_amount REAL NOT NULL,status TEXT NOT NULL);
    CREATE TABLE e2e100_finance_year_incentives (id TEXT PRIMARY KEY,period_code TEXT NOT NULL,amount REAL NOT NULL,status TEXT NOT NULL);
    CREATE TABLE e2e100_finance_year_settlements (id TEXT PRIMARY KEY,period_code TEXT NOT NULL,amount REAL NOT NULL,status TEXT NOT NULL);
    CREATE TABLE e2e100_finance_year_expenses (id TEXT PRIMARY KEY,period_code TEXT NOT NULL,amount REAL NOT NULL,status TEXT NOT NULL);
    CREATE TABLE e2e100_finance_year_exports (id TEXT PRIMARY KEY,period_code TEXT NOT NULL,checksum TEXT NOT NULL UNIQUE,status TEXT NOT NULL);
  `);
  const { postJournal } = await import("../lib/finance-accounts.ts");
  for (let index = 0; index < months.length; index += 1) {
    const period = months[index], status = index < 8 ? "locked" : index === 8 ? "closing" : "open", amount = 1000 + index;
    sqlite.prepare("INSERT INTO e2e100_finance_year_periods VALUES (?,?)").run(period, status);
    sqlite.prepare("INSERT INTO e2e100_finance_year_invoices VALUES (?,?,?,'issued')").run(`E2E100-T4-INV-${period}`, period, amount);
    sqlite.prepare("INSERT INTO e2e100_finance_year_gst VALUES (?,?,?,?)").run(`E2E100-T4-GST-${period}`, period, "configured_test_tax", amount / 10);
    await postJournal(db, { groupKey: `E2E100-T4-${period}`, entryDate: `${period}-28`, periodCode: period, sourceType: "e2e100_finance_year", sourceId: period, narration: "T4 configured test-year journal", lines: [{ accountCode: "configured-test-debit", debit: amount }, { accountCode: "configured-test-credit", credit: amount }] });
    const checksum = await hash(JSON.stringify({ period, amount, journal: `E2E100-T4-${period}` }));
    sqlite.prepare("INSERT INTO e2e100_finance_year_exports VALUES (?,?,?,'generated')").run(`E2E100-T4-EXP-${period}`, period, checksum);
  }
  sqlite.prepare("INSERT INTO e2e100_finance_year_refunds VALUES ('E2E100-T4-REF-1','2026-06','E2E100-T4-INV-2026-06',250,'processed')").run();
  sqlite.prepare("INSERT INTO e2e100_finance_year_credit_notes VALUES ('E2E100-T4-CN-1','2026-06','E2E100-T4-INV-2026-06',250,'issued')").run();
  sqlite.prepare("INSERT INTO e2e100_finance_year_payroll VALUES ('E2E100-T4-PAYROLL-1','2026-07',5000,'approved')").run();
  sqlite.prepare("INSERT INTO e2e100_finance_year_incentives VALUES ('E2E100-T4-INC-1','2026-07',500,'approved')").run();
  sqlite.prepare("INSERT INTO e2e100_finance_year_settlements VALUES ('E2E100-T4-SET-1','2026-08',1500,'sandbox_prepared')").run();
  sqlite.prepare("INSERT INTO e2e100_finance_year_expenses VALUES ('E2E100-T4-EX-1','2026-09',750,'approved')").run();

  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM e2e100_finance_year_periods").get().n, 12);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM e2e100_finance_year_periods WHERE status='locked'").get().n, 8);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM e2e100_finance_year_periods WHERE status='closing'").get().n, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM e2e100_finance_year_periods WHERE status='open'").get().n, 3);
  for (const table of ["invoices", "refunds", "credit_notes", "gst", "payroll", "incentives", "settlements", "expenses", "exports"]) assert.ok(sqlite.prepare(`SELECT COUNT(*) n FROM e2e100_finance_year_${table}`).get().n > 0, table);
  const balances = sqlite.prepare("SELECT source_id,ROUND(SUM(debit),2) debit,ROUND(SUM(credit),2) credit FROM finance_journal_entries GROUP BY source_id ORDER BY source_id").all();
  assert.equal(balances.length, 12);
  for (const row of balances) assert.equal(row.debit, row.credit, row.source_id);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM e2e100_finance_year_exports").get().n, 12);
  const replay = sqlite.prepare("INSERT OR IGNORE INTO e2e100_finance_year_exports VALUES (?,?,?,'generated')").run("E2E100-T4-EXP-REPLAY", "2026-04", sqlite.prepare("SELECT checksum FROM e2e100_finance_year_exports WHERE period_code='2026-04'").get().checksum);
  assert.equal(Number(replay.changes), 0, "checksum replay creates no duplicate export truth");
  sqlite.close();
});
