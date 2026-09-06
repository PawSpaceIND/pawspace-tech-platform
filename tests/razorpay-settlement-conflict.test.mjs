import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";

const repoRoot = new URL("../", import.meta.url);

class BoundStatement {
  constructor(sqlite, sql, values = []) { this.sqlite = sqlite; this.sql = sql; this.values = values; }
  bind(...values) { return new BoundStatement(this.sqlite, this.sql, values); }
  runSync() {
    const result = this.sqlite.prepare(this.sql).run(...this.values);
    return { success: true, meta: { changes: Number(result.changes || 0) } };
  }
  run() { return Promise.resolve(this.runSync()); }
  first() { return Promise.resolve(this.sqlite.prepare(this.sql).get(...this.values) || null); }
  all() { return Promise.resolve({ results: this.sqlite.prepare(this.sql).all(...this.values) }); }
}

class D1SqliteAdapter {
  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
    this.sqlite.exec("PRAGMA foreign_keys = ON");
  }
  prepare(sql) { return new BoundStatement(this.sqlite, sql); }
  batch(statements) {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement.runSync());
      this.sqlite.exec("COMMIT");
      return Promise.resolve(results);
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      return Promise.reject(error);
    }
  }
  exec(sql) { this.sqlite.exec(sql); }
  close() { this.sqlite.close(); }
}

async function loadModules() {
  const tempDir = path.join(os.tmpdir(), `pawspace-settlement-conflict-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const fs = await import("node:fs/promises");
  await fs.mkdir(tempDir, { recursive: true });
  const transpile = (source) => ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, moduleResolution: ts.ModuleResolutionKind.Bundler },
  }).outputText;
  const paymentEnvironmentSource = await readFile(new URL("lib/payment-environment.ts", repoRoot), "utf8");
  await writeFile(path.join(tempDir, "payment-environment.mjs"), transpile(paymentEnvironmentSource));
  const paymentPilotGuardSource = await readFile(new URL("lib/payment-pilot-guard.ts", repoRoot), "utf8");
  await writeFile(path.join(tempDir, "payment-pilot-guard.mjs"), transpile(paymentPilotGuardSource));
  const razorSource = (await readFile(new URL("lib/razorpay-client.ts", repoRoot), "utf8"))
    .replace('from"./payment-environment"', 'from"./payment-environment.mjs"')
    .replace('from "./payment-environment"', 'from "./payment-environment.mjs"')
    .replace('from"./payment-pilot-guard"', 'from"./payment-pilot-guard.mjs"')
    .replace('from "./payment-pilot-guard"', 'from "./payment-pilot-guard.mjs"');
  await writeFile(path.join(tempDir, "razorpay-client.mjs"), transpile(razorSource));
  const runtimeSchemaSource = await readFile(new URL("lib/financial-runtime-schema.ts", repoRoot), "utf8");
  await writeFile(path.join(tempDir, "financial-runtime-schema.mjs"), transpile(runtimeSchemaSource));
  const financeSource = (await readFile(new URL("lib/financial-lifecycle.ts", repoRoot), "utf8"))
    .replace('from "./financial-runtime-schema"', 'from "./financial-runtime-schema.mjs"')
    .replace('from "./razorpay-client"', 'from "./razorpay-client.mjs"');
  await writeFile(path.join(tempDir, "financial-lifecycle.mjs"), transpile(financeSource));
  const settlementSource = (await readFile(new URL("lib/razorpay-settlement-reconciliation.ts", repoRoot), "utf8"))
    .replace('from "./financial-lifecycle"', 'from "./financial-lifecycle.mjs"')
    .replace('from "./razorpay-client"', 'from "./razorpay-client.mjs"');
  await writeFile(path.join(tempDir, "razorpay-settlement-reconciliation.mjs"), transpile(settlementSource));
  const finance = await import(`${pathToFileURL(path.join(tempDir, "financial-lifecycle.mjs")).href}?v=${Date.now()}`);
  const settlement = await import(`${pathToFileURL(path.join(tempDir, "razorpay-settlement-reconciliation.mjs")).href}?v=${Date.now()}`);
  return { finance, settlement, cleanup: () => rm(tempDir, { recursive: true, force: true }) };
}

async function createFinanceDb() {
  const db = new D1SqliteAdapter();
  db.exec("CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY, status TEXT NOT NULL)");
  db.exec(await readFile(new URL("drizzle/0017_financial_lifecycle_hardening.sql", repoRoot), "utf8"));
  db.exec(await readFile(new URL("drizzle/0018_financial_lifecycle_split_intents.sql", repoRoot), "utf8"));
  db.exec(await readFile(new URL("drizzle/0019_razorpay_settlement_reconciliation.sql", repoRoot), "utf8"));
  return db;
}

let loaded;
test.before(async () => { loaded = await loadModules(); });
test.after(async () => { await loaded?.cleanup(); });

test("Razorpay payment settlement identity is immutable and conflicting settlement ids fail closed", async () => {
  const db = await createFinanceDb();
  try {
    const intent = await loaded.finance.claimPaymentIntent(db, {
      bookingId: "BOOK-SETTLEMENT-CONFLICT",
      customerId: "CUS-SETTLEMENT-CONFLICT",
      paymentId: "LOCAL-SETTLEMENT-CONFLICT",
      idempotencyKey: "settlement-conflict-seed",
      amountPaise: 12500,
      currency: "INR",
      environment: "sandbox",
    });
    await loaded.finance.advancePaymentState(db, { intentId: String(intent.id), target: "AUTHORIZED", gatewayPaymentId: "pay_conflict_1" });
    await loaded.finance.advancePaymentState(db, { intentId: String(intent.id), target: "CAPTURED", gatewayPaymentId: "pay_conflict_1" });

    const base = {
      entity_id: "pay_conflict_1",
      type: "payment",
      settled: true,
      settled_at: 1787932800,
      amount: 12500,
      credit: 12205,
      debit: 0,
      fee: 250,
      tax: 45,
      currency: "INR",
    };
    const first = await loaded.settlement.applyRazorpaySettlementReconItems(db, {
      environment: "sandbox",
      reconDate: "2026-08-29",
      items: [{ ...base, settlement_id: "setl_payment_identity_1" }],
    });
    assert.equal(first.settled, 1);
    assert.equal(first.evidenceInserted, 1);

    const replay = await loaded.settlement.applyRazorpaySettlementReconItems(db, {
      environment: "sandbox",
      reconDate: "2026-08-29",
      items: [{ ...base, settlement_id: "setl_payment_identity_1" }],
    });
    assert.equal(replay.alreadySettled, 1);
    assert.equal(replay.evidenceInserted, 0);

    await assert.rejects(() => loaded.settlement.applyRazorpaySettlementReconItems(db, {
      environment: "sandbox",
      reconDate: "2026-08-29",
      items: [{ ...base, settlement_id: "setl_payment_identity_CONFLICT" }],
    }), /settlement identity conflict/);

    const evidence = db.sqlite.prepare("SELECT gateway_settlement_id FROM payment_settlement_reconciliations WHERE gateway_payment_id='pay_conflict_1'").all();
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0].gateway_settlement_id, "setl_payment_identity_1");
    const state = await db.prepare("SELECT state FROM payment_intents WHERE id=?").bind(String(intent.id)).first();
    assert.equal(state?.state, "SETTLED");

    assert.throws(() => db.sqlite.prepare("UPDATE payment_settlement_reconciliations SET gateway_settlement_id='setl_mutated' WHERE gateway_payment_id='pay_conflict_1'").run(), /immutable/);
    assert.throws(() => db.sqlite.prepare("DELETE FROM payment_settlement_reconciliations WHERE gateway_payment_id='pay_conflict_1'").run(), /cannot be deleted/);
  } finally {
    db.close();
  }
});
