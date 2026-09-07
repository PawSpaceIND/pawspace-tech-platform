import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";

const repoRoot = new URL("../", import.meta.url);

class BoundStatement {
  constructor(sqlite, sql, values = []) {
    this.sqlite = sqlite;
    this.sql = sql;
    this.values = values;
  }
  bind(...values) {
    return new BoundStatement(this.sqlite, this.sql, values);
  }
  runSync() {
    const result = this.sqlite.prepare(this.sql).run(...this.values);
    return { success: true, meta: { changes: Number(result.changes || 0) } };
  }
  run() {
    return Promise.resolve(this.runSync());
  }
  first() {
    return Promise.resolve(this.sqlite.prepare(this.sql).get(...this.values) || null);
  }
  all() {
    return Promise.resolve({ results: this.sqlite.prepare(this.sql).all(...this.values) });
  }
}

class D1SqliteAdapter {
  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
    this.sqlite.exec("PRAGMA foreign_keys = ON");
  }
  prepare(sql) {
    return new BoundStatement(this.sqlite, sql);
  }
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
  exec(sql) {
    this.sqlite.exec(sql);
  }
  close() {
    this.sqlite.close();
  }
}

async function loadFinanceModule() {
  const tempDir = path.join(os.tmpdir(), `pawspace-pr374-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
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
  const paymentPilotGuardSource = await readFile(new URL("lib/payment-pilot-guard.ts", repoRoot), "utf8");
  await writeFile(path.join(tempDir, "payment-pilot-guard.mjs"), transpile(paymentPilotGuardSource));

  const razorpaySource = (await readFile(new URL("lib/razorpay-client.ts", repoRoot), "utf8"))
    .replaceAll('from"./payment-environment"', 'from"./payment-environment.mjs"')
    .replaceAll('from"./payment-pilot-guard"', 'from"./payment-pilot-guard.mjs"');
  await writeFile(path.join(tempDir, "razorpay-client.mjs"), transpile(razorpaySource));

  const runtimeSchemaSource = await readFile(new URL("lib/financial-runtime-schema.ts", repoRoot), "utf8");
  await writeFile(path.join(tempDir, "financial-runtime-schema.mjs"), transpile(runtimeSchemaSource));

  const financeSource = (await readFile(new URL("lib/financial-lifecycle.ts", repoRoot), "utf8"))
    .replace('from "./financial-runtime-schema"', 'from "./financial-runtime-schema.mjs"')
    .replace('from "./razorpay-client"', 'from "./razorpay-client.mjs"');
  await writeFile(path.join(tempDir, "financial-lifecycle.mjs"), transpile(financeSource));

  const financeModule = await import(`${pathToFileURL(path.join(tempDir, "financial-lifecycle.mjs")).href}?v=${Date.now()}`);
  return { module: financeModule, cleanup: () => rm(tempDir, { recursive: true, force: true }) };
}

async function createFinanceDb() {
  const db = new D1SqliteAdapter();
  db.exec("CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY, status TEXT NOT NULL)");
  db.exec(await readFile(new URL("drizzle/0017_financial_lifecycle_hardening.sql", repoRoot), "utf8"));
  db.exec(await readFile(new URL("drizzle/0018_financial_lifecycle_split_intents.sql", repoRoot), "utf8"));
  return db;
}

async function scalar(db, sql, ...values) {
  const row = await db.prepare(sql).bind(...values).first();
  return Number(row?.value || 0);
}

let loaded;
test.before(async () => { loaded = await loadFinanceModule(); });
test.after(async () => { await loaded?.cleanup(); });

test("PR374 semantic port: D1 intent preserves governed commercial facts and scoped idempotency", async () => {
  const db = await createFinanceDb();
  const { claimPaymentIntent } = loaded.module;
  try {
    const input = {
      bookingId: "BOOK-PR374-1",
      customerId: "CUS-PR374-1",
      paymentId: "PAY-PR374-1",
      idempotencyKey: "checkout-pr374-final",
      amountPaise: 189900,
      currency: "INR",
      grossServiceValuePaise: 189900,
      platformFeePaise: 35000,
      partnerEarningPaise: 154900,
      tdsPaise: 1000,
      gstPaise: 28968,
      commissionRateBps: 1843,
      commissionRateVersion: "pr374-port-v1",
      taxRuleVersion: "gst-v1",
      commercialSnapshot: { source: "pr374", quoteId: "Q-374", grossRupees: 1899 },
      environment: "sandbox",
    };

    const first = await claimPaymentIntent(db, input);
    const duplicate = await claimPaymentIntent(db, { ...input, paymentId: "PAY-PR374-RETRY" });

    assert.equal(duplicate.id, first.id, "same customer/booking/idempotency key must converge on one intent");
    assert.equal(await scalar(db, "SELECT COUNT(*) value FROM payment_intents"), 1);
    assert.equal(await scalar(db, "SELECT COUNT(*) value FROM financial_outbox WHERE event_type='CREATE_RAZORPAY_ORDER'"), 1);

    const row = await db.prepare(`SELECT amount_paise,gross_service_value_paise,platform_fee_paise,partner_earning_paise,
      tds_paise,gst_paise,commission_rate_bps,commission_rate_version,tax_rule_version,commercial_snapshot_json
      FROM payment_intents WHERE id=?`).bind(String(first.id)).first();
    assert.equal(Number(row.amount_paise), 189900);
    assert.equal(Number(row.gross_service_value_paise), 189900);
    assert.equal(Number(row.platform_fee_paise), 35000);
    assert.equal(Number(row.partner_earning_paise), 154900);
    assert.equal(Number(row.tds_paise), 1000);
    assert.equal(Number(row.gst_paise), 28968);
    assert.equal(Number(row.commission_rate_bps), 1843);
    assert.equal(row.commission_rate_version, "pr374-port-v1");
    assert.equal(row.tax_rule_version, "gst-v1");
    assert.deepEqual(JSON.parse(String(row.commercial_snapshot_json)), { source: "pr374", quoteId: "Q-374", grossRupees: 1899 });
  } finally {
    db.close();
  }
});

test("PR374 semantic port: schema rejects invalid commercial facts atomically", async () => {
  const db = await createFinanceDb();
  const { claimPaymentIntent } = loaded.module;
  try {
    await assert.rejects(() => claimPaymentIntent(db, {
      bookingId: "BOOK-PR374-BAD",
      customerId: "CUS-PR374-BAD",
      paymentId: "PAY-PR374-BAD",
      idempotencyKey: "checkout-pr374-invalid",
      amountPaise: 10000,
      currency: "INR",
      commissionRateBps: 10001,
      environment: "sandbox",
    }));
    assert.equal(await scalar(db, "SELECT COUNT(*) value FROM payment_intents"), 0, "invalid finance facts must not persist");
    assert.equal(await scalar(db, "SELECT COUNT(*) value FROM financial_outbox"), 0, "invalid finance facts must not enqueue provider work");
  } finally {
    db.close();
  }
});

test("PR374 semantic port: gateway order creation fails closed without configured sandbox credentials", async () => {
  const db = await createFinanceDb();
  const { claimPaymentIntent, executeRazorpayOrderOutbox } = loaded.module;
  try {
    const intent = await claimPaymentIntent(db, {
      bookingId: "BOOK-PR374-NOCREDS",
      customerId: "CUS-PR374-NOCREDS",
      paymentId: "PAY-PR374-NOCREDS",
      idempotencyKey: "checkout-pr374-nocreds",
      amountPaise: 189900,
      currency: "INR",
      environment: "sandbox",
    });
    const outbox = await db.prepare("SELECT id FROM financial_outbox WHERE aggregate_id=? AND event_type='CREATE_RAZORPAY_ORDER'")
      .bind(String(intent.id)).first();
    assert.ok(outbox?.id);

    const result = await executeRazorpayOrderOutbox(db, { PAWSPACE_PAYMENT_ENV: "sandbox" }, {
      outboxId: String(outbox.id),
      workerId: "pr374-fail-closed-check",
    });
    assert.equal(result.claimed, true);
    assert.equal(result.connected, false);
    assert.match(String(result.reason), /credentials are not configured/i);

    const persistedOutbox = await db.prepare("SELECT status,lease_owner,lease_expires_at,last_error FROM financial_outbox WHERE id=?")
      .bind(String(outbox.id)).first();
    assert.equal(persistedOutbox.status, "RETRY");
    assert.equal(persistedOutbox.lease_owner, null);
    assert.equal(persistedOutbox.lease_expires_at, null);
    assert.match(String(persistedOutbox.last_error), /credentials are not configured/i);

    const persistedIntent = await db.prepare("SELECT order_request_state,gateway_order_id FROM payment_intents WHERE id=?")
      .bind(String(intent.id)).first();
    assert.equal(persistedIntent.order_request_state, "FAILED");
    assert.equal(persistedIntent.gateway_order_id, null);
  } finally {
    db.close();
  }
});

test("PR374 semantic port: exact money conversion and raw-body HMAC remain fail closed", async () => {
  const { rupeesToPaiseExact, verifyRazorpayRawBody } = loaded.module;
  assert.equal(rupeesToPaiseExact("1899"), 189900);
  assert.equal(rupeesToPaiseExact("1899.50"), 189950);
  assert.throws(() => rupeesToPaiseExact("1899.001"));
  assert.throws(() => rupeesToPaiseExact(0));

  const raw = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: "pay_pr374", amount: 189900 } } } });
  const secret = "pr374-webhook-secret";
  const signature = createHmac("sha256", secret).update(raw).digest("hex");
  assert.equal(await verifyRazorpayRawBody(raw, signature, secret), true);
  assert.equal(await verifyRazorpayRawBody(`${raw}x`, signature, secret), false);
  assert.equal(await verifyRazorpayRawBody(raw, `${signature.slice(0, -1)}0`, secret), false);
});
