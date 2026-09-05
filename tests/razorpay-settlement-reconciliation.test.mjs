import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
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
  const tempDir = path.join(os.tmpdir(), `pawspace-settlement-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const fs = await import("node:fs/promises");
  await fs.mkdir(tempDir, { recursive: true });
  const transpile = (source) => ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    },
  }).outputText;
  const paymentEnvironmentSource = await readFile(new URL("lib/payment-environment.ts", repoRoot), "utf8");
  await writeFile(path.join(tempDir, "payment-environment.mjs"), transpile(paymentEnvironmentSource));
  const razorSource = (await readFile(new URL("lib/razorpay-client.ts", repoRoot), "utf8"))
    .replace('from"./payment-environment"', 'from"./payment-environment.mjs"')
    .replace('from "./payment-environment"', 'from "./payment-environment.mjs"');
  await writeFile(path.join(tempDir, "razorpay-client.mjs"), transpile(razorSource));
  const financeSource = (await readFile(new URL("lib/financial-lifecycle.ts", repoRoot), "utf8"))
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

async function seedCapturedIntent(db, finance, input) {
  const intent = await finance.claimPaymentIntent(db, {
    bookingId: input.bookingId,
    customerId: input.customerId,
    paymentId: input.paymentId,
    idempotencyKey: input.paymentId,
    amountPaise: input.amountPaise,
    currency: "INR",
    environment: "sandbox",
  });
  const authorized = await finance.advancePaymentState(db, { intentId: String(intent.id), target: "AUTHORIZED", gatewayPaymentId: input.gatewayPaymentId });
  assert.equal(authorized.changed, true);
  const captured = await finance.advancePaymentState(db, { intentId: String(intent.id), target: "CAPTURED", gatewayPaymentId: input.gatewayPaymentId });
  assert.equal(captured.changed, true);
  return String(intent.id);
}

async function scalar(db, sql, ...values) {
  const row = await db.prepare(sql).bind(...values).first();
  return Number(row?.value || 0);
}

async function withReconServer(handler) {
  let calls = 0;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/v1/settlements/recon/combined") {
      calls += 1;
      assert.match(String(request.headers.authorization || ""), /^Basic /);
      const requested = `${url.searchParams.get("year")}-${url.searchParams.get("month")}-${url.searchParams.get("day")}`;
      const items = requested === "2026-08-29" ? [
        {
          entity_id: "pay_settle_shared_1",
          type: "payment",
          settled: true,
          settled_at: 1787932800,
          settlement_id: "setl_shared_batch_1",
          settlement_utr: "UTR-SHARED-1",
          amount: 10000,
          credit: 9764,
          debit: 0,
          fee: 200,
          tax: 36,
          currency: "INR",
        },
        {
          entity_id: "pay_settle_shared_2",
          type: "payment",
          settled: true,
          settled_at: 1787932800,
          settlement_id: "setl_shared_batch_1",
          settlement_utr: "UTR-SHARED-1",
          amount: 20000,
          credit: 19528,
          debit: 0,
          fee: 400,
          tax: 72,
          currency: "INR",
        },
        {
          entity_id: "rfnd_not_a_payment",
          type: "refund",
          settled: true,
          settled_at: 1787932800,
          settlement_id: "setl_shared_batch_1",
          amount: 500,
          currency: "INR",
        },
      ] : [];
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ entity: "collection", count: items.length, items }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { description: "not found" } }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    return await handler({ baseUrl: `http://127.0.0.1:${address.port}`, calls: () => calls });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

let loaded;
test.before(async () => { loaded = await loadModules(); });
test.after(async () => { await loaded?.cleanup(); });

test("Razorpay payment-level recon settles two captured payments sharing one batch settlement id exactly once", async () => {
  const db = await createFinanceDb();
  try {
    await seedCapturedIntent(db, loaded.finance, { bookingId: "BOOK-SETTLE-1", customerId: "CUS-SETTLE-1", paymentId: "LOCAL-PAY-1", gatewayPaymentId: "pay_settle_shared_1", amountPaise: 10000 });
    await seedCapturedIntent(db, loaded.finance, { bookingId: "BOOK-SETTLE-2", customerId: "CUS-SETTLE-2", paymentId: "LOCAL-PAY-2", gatewayPaymentId: "pay_settle_shared_2", amountPaise: 20000 });

    await withReconServer(async ({ baseUrl, calls }) => {
      const env = {
        PAWSPACE_PAYMENT_ENV: "sandbox",
        PAWSPACE_PAYMENT_CONTRACT_TEST: "true",
        PAWSPACE_RAZORPAY_API_BASE_URL: baseUrl,
        RAZORPAY_KEY_ID_SANDBOX: "rzp_test_settlement_contract",
        RAZORPAY_KEY_SECRET_SANDBOX: "settlement-contract-secret",
        PAWSPACE_RAZORPAY_SETTLEMENT_RECON_ENABLED: "true",
      };
      const asOf = Date.parse("2026-08-30T04:00:00.000Z");
      const result = await loaded.settlement.runRazorpaySettlementReconciliationSweep(db, env, { asOf });
      assert.equal(result.settled, 2);
      assert.equal(result.evidenceInserted, 2);
      assert.equal(result.ignoredNonPayment, 1);
      assert.equal(calls(), 3, "daily sweep should query its bounded three-day lookback once");

      assert.equal(await scalar(db, "SELECT COUNT(*) value FROM payment_intents WHERE state='SETTLED' AND gateway_payment_id IN ('pay_settle_shared_1','pay_settle_shared_2')"), 2);
      assert.equal(await scalar(db, "SELECT COUNT(*) value FROM payment_settlement_reconciliations WHERE gateway_settlement_id='setl_shared_batch_1'"), 2, "one batch settlement id must be allowed to map to multiple payment-level evidence rows");
      assert.equal(await scalar(db, "SELECT COUNT(DISTINCT payment_intent_id) value FROM payment_settlement_reconciliations WHERE gateway_settlement_id='setl_shared_batch_1'"), 2);
      assert.equal(await scalar(db, "SELECT COUNT(*) value FROM payment_intents WHERE gateway_settlement_id IS NOT NULL"), 0, "legacy one-to-one settlement column must not be used for batch settlement identity");

      const replay = await loaded.settlement.runRazorpaySettlementReconciliationSweep(db, env, { asOf });
      assert.equal(replay.duplicatePrevented, true);
      assert.equal(calls(), 3, "same daily run must not call Razorpay twice");
      assert.equal(await scalar(db, "SELECT COUNT(*) value FROM payment_settlement_reconciliations"), 2);
    });
  } finally {
    db.close();
  }
});

test("Razorpay settlement recon is disabled by default and fails closed on amount mismatch", async () => {
  const db = await createFinanceDb();
  try {
    const intentId = await seedCapturedIntent(db, loaded.finance, { bookingId: "BOOK-SETTLE-MISMATCH", customerId: "CUS-SETTLE-MISMATCH", paymentId: "LOCAL-PAY-MISMATCH", gatewayPaymentId: "pay_settle_mismatch", amountPaise: 15000 });
    const disabled = await loaded.settlement.runRazorpaySettlementReconciliationSweep(db, {}, { asOf: Date.parse("2026-08-30T04:00:00.000Z") });
    assert.equal(disabled.skipped, true);
    assert.match(disabled.reason, /not true/);

    await assert.rejects(() => loaded.settlement.applyRazorpaySettlementReconItems(db, {
      environment: "sandbox",
      reconDate: "2026-08-29",
      items: [{
        entity_id: "pay_settle_mismatch",
        type: "payment",
        settled: true,
        settled_at: 1787932800,
        settlement_id: "setl_mismatch_batch",
        amount: 14999,
        credit: 14999,
        debit: 0,
        fee: 0,
        tax: 0,
        currency: "INR",
      }],
    }), /amount mismatch/);
    const state = await db.prepare("SELECT state FROM payment_intents WHERE id=?").bind(intentId).first();
    assert.equal(state?.state, "CAPTURED");
    assert.equal(await scalar(db, "SELECT COUNT(*) value FROM payment_settlement_reconciliations WHERE gateway_payment_id='pay_settle_mismatch'"), 0);
  } finally {
    db.close();
  }
});
