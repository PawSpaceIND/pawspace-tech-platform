import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
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
  const tempDir = path.join(os.tmpdir(), `pawspace-finance-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await writeFile(path.join(os.tmpdir(), ".pawspace-finance-placeholder"), "").catch(() => {});
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
    .replaceAll('from"./payment-environment"', 'from"./payment-environment.mjs"');
  await writeFile(path.join(tempDir, "razorpay-client.mjs"), transpile(razorSource));
  const financeSource = (await readFile(new URL("lib/financial-lifecycle.ts", repoRoot), "utf8"))
    .replace('from "./razorpay-client"', 'from "./razorpay-client.mjs"');
  await writeFile(path.join(tempDir, "financial-lifecycle.mjs"), transpile(financeSource));
  const loadedModule = await import(`${pathToFileURL(path.join(tempDir, "financial-lifecycle.mjs")).href}?v=${Date.now()}`);
  return { module: loadedModule, cleanup: () => rm(tempDir, { recursive: true, force: true }) };
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

async function withLoopbackRazorpay(handler) {
  let calls = 0;
  const server = http.createServer((request, response) => {
    if (request.method === "POST" && request.url === "/v1/orders") {
      calls += 1;
      request.resume();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "order_finance_exactly_once", status: "created" }));
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
    return await handler({ baseUrl: `http://127.0.0.1:${address.port}`, providerCalls: () => calls });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const twenty = () => Array.from({ length: 20 }, (_, index) => index);

let loaded;
test.before(async () => { loaded = await loadFinanceModule(); });
test.after(async () => { await loaded?.cleanup(); });

test("executable finance acceptance: 20 concurrent checkout requests create one durable intent/outbox and exactly one provider order", async () => {
  const db = await createFinanceDb();
  const { claimPaymentIntent, executeRazorpayOrderOutbox } = loaded.module;
  try {
    const claims = await Promise.all(twenty().map((index) => claimPaymentIntent(db, {
      bookingId: "BOOK-EXACT-1",
      customerId: "CUS-EXACT-1",
      paymentId: `PAY-REQUEST-${index}`,
      idempotencyKey: "checkout-stage-final-10000",
      amountPaise: 10000,
      currency: "INR",
      environment: "sandbox",
    })));
    assert.equal(new Set(claims.map((row) => row.id)).size, 1);
    assert.equal(await scalar(db, "SELECT COUNT(*) value FROM payment_intents"), 1);
    assert.equal(await scalar(db, "SELECT COUNT(*) value FROM financial_outbox WHERE event_type='CREATE_RAZORPAY_ORDER'"), 1);
    const outbox = await db.prepare("SELECT id FROM financial_outbox WHERE event_type='CREATE_RAZORPAY_ORDER'").first();
    assert.ok(outbox?.id);

    await withLoopbackRazorpay(async ({ baseUrl, providerCalls }) => {
      const env = {
        PAWSPACE_PAYMENT_ENV: "sandbox",
        PAWSPACE_PAYMENT_CONTRACT_TEST: "true",
        PAWSPACE_RAZORPAY_API_BASE_URL: baseUrl,
        RAZORPAY_KEY_ID_SANDBOX: "rzp_test_contract",
        RAZORPAY_KEY_SECRET_SANDBOX: "contract-secret",
      };
      const results = await Promise.all(twenty().map((index) => executeRazorpayOrderOutbox(db, env, {
        outboxId: String(outbox.id),
        workerId: `checkout-worker-${index}`,
      })));
      assert.equal(providerCalls(), 1, "only one contender may invoke Razorpay order creation");
      assert.equal(results.filter((result) => result.claimed && result.connected && result.replay === false).length, 1);
      assert.equal(await scalar(db, "SELECT COUNT(*) value FROM payment_intents WHERE gateway_order_id='order_finance_exactly_once'"), 1);
      assert.equal(await scalar(db, "SELECT COUNT(*) value FROM gateway_object_identities WHERE object_type='order' AND external_id='order_finance_exactly_once'"), 1);

      await Promise.all(twenty().map((index) => executeRazorpayOrderOutbox(db, env, {
        outboxId: String(outbox.id),
        workerId: `replay-worker-${index}`,
      })));
      assert.equal(providerCalls(), 1, "replays after success must not invoke Razorpay again");
    });
  } finally {
    db.close();
  }
});

test("executable finance acceptance: an expired PROCESSING lease enters reconciliation and never calls Razorpay", async () => {
  const db = await createFinanceDb();
  const { claimPaymentIntent, executeRazorpayOrderOutbox } = loaded.module;
  try {
    const intent = await claimPaymentIntent(db, {
      bookingId: "BOOK-STALE-1",
      customerId: "CUS-STALE-1",
      paymentId: "PAY-STALE-1",
      idempotencyKey: "stale-provider-attempt",
      amountPaise: 15000,
      currency: "INR",
      environment: "sandbox",
    });
    const outbox = await db.prepare("SELECT id FROM financial_outbox WHERE aggregate_id=? AND event_type='CREATE_RAZORPAY_ORDER'")
      .bind(String(intent.id)).first();
    assert.ok(outbox?.id);
    await db.prepare("UPDATE financial_outbox SET status='PROCESSING',lease_owner='crashed-worker',lease_expires_at=?,attempts=1 WHERE id=?")
      .bind(Date.now() - 60_000, String(outbox.id)).run();

    await withLoopbackRazorpay(async ({ baseUrl, providerCalls }) => {
      const result = await executeRazorpayOrderOutbox(db, {
        PAWSPACE_PAYMENT_ENV: "sandbox",
        PAWSPACE_PAYMENT_CONTRACT_TEST: "true",
        PAWSPACE_RAZORPAY_API_BASE_URL: baseUrl,
        RAZORPAY_KEY_ID_SANDBOX: "rzp_test_contract",
        RAZORPAY_KEY_SECRET_SANDBOX: "contract-secret",
      }, { outboxId: String(outbox.id), workerId: "replacement-worker" });
      assert.equal(providerCalls(), 0, "an expired ambiguous provider lease must not create a second Razorpay order");
      assert.equal(result.claimed, true);
      assert.equal(result.connected, false);
      assert.equal(result.reconciliationRequired, true);
    });

    const row = await db.prepare("SELECT status,lease_owner,lease_expires_at,last_error FROM financial_outbox WHERE id=?")
      .bind(String(outbox.id)).first();
    assert.equal(row?.status, "RECONCILIATION_REQUIRED");
    assert.equal(row?.lease_owner, null);
    assert.equal(row?.lease_expires_at, null);
    assert.match(String(row?.last_error || ""), /stale_processing_lease_requires_reconciliation/);
    const persistedIntent = await db.prepare("SELECT order_request_state,gateway_order_id FROM payment_intents WHERE id=?")
      .bind(String(intent.id)).first();
    assert.equal(persistedIntent?.order_request_state, "RECONCILIATION_REQUIRED");
    assert.equal(persistedIntent?.gateway_order_id, null);
  } finally {
    db.close();
  }
});

test("executable finance acceptance: 20 duplicate Razorpay webhooks produce one inbox claimant and exactly one journal effect", async () => {
  const db = await createFinanceDb();
  const { acceptRazorpayWebhook, postBalancedJournal } = loaded.module;
  try {
    const rawBody = JSON.stringify({
      event: "payment.captured",
      payload: { payment: { entity: { id: "pay_exact_once", order_id: "order_exact_once", amount: 12500, currency: "INR" } } },
    });
    const webhookSecret = "webhook-contract-secret";
    const signature = createHmac("sha256", webhookSecret).update(rawBody).digest("hex");
    const accepted = await Promise.all(twenty().map(() => acceptRazorpayWebhook(db, {
      rawBody,
      signature,
      webhookSecret,
      eventId: "evt_exact_once_capture",
      environment: "sandbox",
    })));
    assert.equal(await scalar(db, "SELECT COUNT(*) value FROM gateway_webhook_events WHERE provider='razorpay' AND event_id='evt_exact_once_capture'"), 1);
    assert.equal(accepted.filter((result) => result.duplicate === false).length, 1);

    const effects = await Promise.all(accepted.map(async (result) => {
      const claimed = await db.prepare("UPDATE gateway_webhook_events SET processing_status='PROCESSING',event_type='payment.captured' WHERE id=? AND processing_status IN ('RECEIVED','DEFERRED','FAILED')")
        .bind(String(result.row.id)).run();
      if (Number(claimed.meta?.changes || 0) !== 1) return false;
      await postBalancedJournal(db, {
        sourceType: "razorpay_capture",
        sourceId: "PI-WEBHOOK-EXACT-1",
        sourceEventId: "razorpay:evt_exact_once_capture:capture",
        narration: "Executable duplicate webhook acceptance",
        currency: "INR",
        entries: [
          { accountCode: "gateway_clearing", direction: "DEBIT", amountPaise: 12500, bookingId: "BOOK-WEBHOOK-1" },
          { accountCode: "customer_collections", direction: "CREDIT", amountPaise: 12500, bookingId: "BOOK-WEBHOOK-1" },
        ],
      });
      await db.prepare("UPDATE gateway_webhook_events SET processing_status='PROCESSED',processed_at=? WHERE id=? AND processing_status='PROCESSING'")
        .bind(Date.now(), String(result.row.id)).run();
      return true;
    }));
    assert.equal(effects.filter(Boolean).length, 1, "only one duplicate delivery may own domain processing");
    assert.equal(await scalar(db, "SELECT COUNT(*) value FROM journal_transactions WHERE source_event_id='razorpay:evt_exact_once_capture:capture' AND status='POSTED'"), 1);
    assert.equal(await scalar(db, "SELECT COUNT(*) value FROM journal_entries WHERE transaction_id=(SELECT id FROM journal_transactions WHERE source_event_id='razorpay:evt_exact_once_capture:capture')"), 2);
    const inbox = await db.prepare("SELECT processing_status FROM gateway_webhook_events WHERE event_id='evt_exact_once_capture'").first();
    assert.equal(inbox?.processing_status, "PROCESSED");
  } finally {
    db.close();
  }
});

test("executable finance acceptance: 20 partner-release attempts create one release and leave the source earning RELEASED", async () => {
  const db = await createFinanceDb();
  const { claimPaymentIntent, releasePartnerEarning } = loaded.module;
  try {
    db.exec("INSERT INTO canonical_bookings (id,status) VALUES ('BOOK-RELEASE-1','completed')");
    const intent = await claimPaymentIntent(db, {
      bookingId: "BOOK-RELEASE-1",
      customerId: "CUS-RELEASE-1",
      paymentId: "PAY-RELEASE-1",
      idempotencyKey: "release-seed",
      amountPaise: 20000,
      currency: "INR",
      environment: "sandbox",
    });
    await db.prepare(`INSERT INTO partner_earning_pending
      (id,booking_id,partner_id,payment_intent_id,gross_service_value_paise,platform_fee_paise,tds_paise,gst_paise,earning_paise,currency,status,created_at,updated_at)
      VALUES ('PEP-RELEASE-1','BOOK-RELEASE-1','PARTNER-1',?,20000,3000,0,0,17000,'INR','PENDING',?,?)`)
      .bind(String(intent.id), Date.now(), Date.now()).run();

    const results = await Promise.all(twenty().map(() => releasePartnerEarning(db, {
      bookingId: "BOOK-RELEASE-1",
      releaseType: "completion",
    })));
    assert.equal(results.filter((result) => result.duplicate === false).length, 1);
    assert.equal(await scalar(db, "SELECT COUNT(*) value FROM partner_payable_released WHERE booking_id='BOOK-RELEASE-1' AND release_type='completion'"), 1);
    const source = await db.prepare("SELECT status FROM partner_earning_pending WHERE id='PEP-RELEASE-1'").first();
    assert.equal(source?.status, "RELEASED");

    db.exec("INSERT INTO canonical_bookings (id,status) VALUES ('BOOK-RELEASE-NOT-DONE','confirmed')");
    const blockedIntent = await claimPaymentIntent(db, {
      bookingId: "BOOK-RELEASE-NOT-DONE",
      customerId: "CUS-RELEASE-2",
      paymentId: "PAY-RELEASE-2",
      idempotencyKey: "release-blocked-seed",
      amountPaise: 10000,
      currency: "INR",
      environment: "sandbox",
    });
    await db.prepare(`INSERT INTO partner_earning_pending
      (id,booking_id,partner_id,payment_intent_id,gross_service_value_paise,platform_fee_paise,tds_paise,gst_paise,earning_paise,currency,status,created_at,updated_at)
      VALUES ('PEP-RELEASE-2','BOOK-RELEASE-NOT-DONE','PARTNER-2',?,10000,1500,0,0,8500,'INR','PENDING',?,?)`)
      .bind(String(blockedIntent.id), Date.now(), Date.now()).run();
    await assert.rejects(() => releasePartnerEarning(db, { bookingId: "BOOK-RELEASE-NOT-DONE", releaseType: "completion" }), /before booking completion/);
    assert.equal(await scalar(db, "SELECT COUNT(*) value FROM partner_payable_released WHERE booking_id='BOOK-RELEASE-NOT-DONE'"), 0);
  } finally {
    db.close();
  }
});
