import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__FINANCE_BOOTSTRAP_DB__", "__FINANCE_BOOTSTRAP_ENV__");

class BoundStatement {
  constructor(sqlite, sql, values = []) { this.sqlite = sqlite; this.sql = sql; this.values = values; }
  bind(...values) { return new BoundStatement(this.sqlite, this.sql, values); }
  run() {
    const result = this.sqlite.prepare(this.sql).run(...this.values);
    return Promise.resolve({ success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid || 0), rows_written: Number(result.changes) } });
  }
  first(column) {
    const row = this.sqlite.prepare(this.sql).get(...this.values);
    if (!row) return Promise.resolve(null);
    return Promise.resolve(column ? row[column] : row);
  }
  all() { return Promise.resolve({ results: this.sqlite.prepare(this.sql).all(...this.values), success: true, meta: {} }); }
  raw() { return Promise.resolve(this.sqlite.prepare(this.sql).all(...this.values).map((row) => Object.values(row))); }
}

class D1SqliteAdapter {
  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
    this.sqlite.exec("PRAGMA foreign_keys = ON");
  }
  prepare(sql) { return new BoundStatement(this.sqlite, sql); }
  async batch(statements) {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
  async exec(sql) { this.sqlite.exec(sql); return { count: 0, duration: 0 }; }
  close() { this.sqlite.close(); }
}

const requiredTables = [
  "payment_intents",
  "financial_outbox",
  "gateway_webhook_events",
  "gateway_object_identities",
  "journal_transactions",
  "journal_entries",
  "partner_earning_pending",
  "partner_payable_released",
  "payment_settlement_reconciliations",
  "razorpay_settlement_recon_runs",
];

const blankFinanceDb = () => new D1SqliteAdapter();

test("blank D1 runtime bootstrap creates every table required by the critical money path", async () => {
  const db = blankFinanceDb();
  try {
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().n, 0, "fixture must begin with no application tables");
    const bootstrap = await import("../lib/financial-runtime-bootstrap.ts");
    bootstrap.resetFinancialRuntimeSchemaForTests();
    await bootstrap.ensureFinancialRuntimeSchema(db);

    const rows = db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    const names = new Set(rows.map((row) => row.name));
    for (const table of requiredTables) assert.ok(names.has(table), `runtime bootstrap did not create ${table}`);
  } finally {
    db.close();
  }
});

test("blank D1 can post an immutable balanced journal without preloading drizzle migrations", async () => {
  const db = blankFinanceDb();
  try {
    const bootstrap = await import("../lib/financial-runtime-bootstrap.ts");
    bootstrap.resetFinancialRuntimeSchemaForTests();
    await bootstrap.ensureFinancialRuntimeSchema(db);

    const finance = await import("../lib/financial-lifecycle.ts");
    const first = await finance.postBalancedJournal(db, {
      sourceType: "preuat_runtime_bootstrap",
      sourceId: "PAY-BOOTSTRAP-1",
      sourceEventId: "preuat:bootstrap:journal:1",
      narration: "Blank database runtime finance proof",
      currency: "INR",
      entries: [
        { accountCode: "gateway_clearing", direction: "DEBIT", amountPaise: 12500 },
        { accountCode: "customer_collections", direction: "CREDIT", amountPaise: 12500 },
      ],
    });
    assert.equal(first.duplicate, false);

    const header = db.sqlite.prepare("SELECT status FROM journal_transactions WHERE id=?").get(first.transactionId);
    assert.equal(header?.status, "POSTED");
    const sums = db.sqlite.prepare(`SELECT
      SUM(CASE WHEN direction='DEBIT' THEN amount_paise ELSE 0 END) debits,
      SUM(CASE WHEN direction='CREDIT' THEN amount_paise ELSE 0 END) credits,
      COUNT(*) lines
      FROM journal_entries WHERE transaction_id=?`).get(first.transactionId);
    assert.equal(Number(sums?.lines), 2);
    assert.equal(Number(sums?.debits), 12500);
    assert.equal(Number(sums?.credits), 12500);

    const replay = await finance.postBalancedJournal(db, {
      sourceType: "preuat_runtime_bootstrap",
      sourceId: "PAY-BOOTSTRAP-1",
      sourceEventId: "preuat:bootstrap:journal:1",
      narration: "Duplicate delivery",
      currency: "INR",
      entries: [
        { accountCode: "gateway_clearing", direction: "DEBIT", amountPaise: 12500 },
        { accountCode: "customer_collections", direction: "CREDIT", amountPaise: 12500 },
      ],
    });
    assert.equal(replay.duplicate, true);
    assert.equal(replay.transactionId, first.transactionId);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM journal_transactions").get().n, 1);

    assert.throws(
      () => db.sqlite.prepare("UPDATE journal_entries SET amount_paise=13000 WHERE transaction_id=?").run(first.transactionId),
      /posted journal entries are immutable/,
    );
  } finally {
    db.close();
  }
});

test("runtime bootstrap retries after a failed initialization instead of caching rejection", async () => {
  const bootstrap = await import("../lib/financial-runtime-bootstrap.ts");
  bootstrap.resetFinancialRuntimeSchemaForTests();
  let attempts = 0;
  const failingDb = {
    batch: async () => { attempts += 1; throw new Error("transient D1 unavailable"); },
    prepare: () => ({ bind() { return this; }, run: async () => ({ success: true, meta: { changes: 0 } }) }),
  };
  await assert.rejects(() => bootstrap.ensureFinancialRuntimeSchema(failingDb), /transient D1 unavailable/);
  await assert.rejects(() => bootstrap.ensureFinancialRuntimeSchema(failingDb), /transient D1 unavailable/);
  assert.equal(attempts, 2, "a rejected bootstrap promise must be cleared so a later invocation can retry");
});
