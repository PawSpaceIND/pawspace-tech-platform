import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { installFinancialLifecycleSchema } from "./helpers/financial-lifecycle-schema.mjs";

// PAY-001 runtime coverage only. The canonical LIVE capture-demotion boundary now executes the actual
// booking POST in live-payment-canonical-route-runtime.test.mjs. This file keeps the second defect's
// real order-creation coverage: the provider order must use amount_due_now, and provider refusal must
// leave the payment awaiting verified capture without a gateway link.
installWorkersHooks("__PAY001_DB__", "__PAY001_ENV__");

const intent = await import("../lib/payment-order-intent.ts");

function makeD1(sqlite) {
  const statement = (sql, args = []) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => {
      const info = sqlite.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(info.changes || 0) } };
    },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return {
    prepare: (sql) => statement(sql),
    batch: async (list) => {
      const out = [];
      for (const item of list) out.push(await item.run());
      return out;
    },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

function paymentsDb({ amount, amountDueNow, status = "created" }) {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PAY001_DB__ = db;
  sqlite.exec("CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL)");
  sqlite.exec("CREATE TABLE booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,amount REAL NOT NULL,amount_due_now REAL NOT NULL,currency TEXT NOT NULL,status TEXT NOT NULL)");
  installFinancialLifecycleSchema(sqlite);
  sqlite.prepare("INSERT INTO canonical_bookings VALUES (?,?)").run("BK-1", "CUS-1");
  sqlite.prepare("INSERT INTO booking_payments VALUES (?,?,?,?,?,?,?)").run("PAY-1", "BK-1", "CUS-1", amount, amountDueNow, "INR", status);
  return { sqlite, db };
}

function sandboxGatewayEnv() {
  return {
    RAZORPAY_KEY_ID_SANDBOX: "rzp_test_stub",
    RAZORPAY_KEY_SECRET_SANDBOX: "stub-secret",
    PAWSPACE_PAYMENT_ENV: "sandbox",
  };
}

function persistedGatewayLinkCount(sqlite) {
  try {
    return Number(sqlite.prepare("SELECT COUNT(*) c FROM payment_gateway_links").get()?.c || 0);
  } catch (error) {
    if (/no such table:\s*payment_gateway_links/i.test(String(error?.message || error))) return 0;
    throw error;
  }
}

test("real execution: a split booking creates a gateway order for amount_due_now, not the total", async () => {
  const { sqlite, db } = paymentsDb({ amount: 3600, amountDueNow: 1800 });
  const realFetch = globalThis.fetch;
  let requestedSubunits = null;
  globalThis.fetch = async (_url, init) => {
    requestedSubunits = JSON.parse(String(init?.body || "{}")).amount;
    return new Response(JSON.stringify({ id: "order_stub_split" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await intent.createBookingPaymentOrder(db, sandboxGatewayEnv(), { bookingId: "BK-1", customerId: "CUS-1", actorId: "test" });
    assert.equal(result.connected, true, `expected a connected order, got ${JSON.stringify(result)}`);
    assert.equal(result.amount, 1800);
    assert.equal(result.bookingTotal, 3600);
    assert.equal(requestedSubunits, 180000);
    const payment = sqlite.prepare("SELECT status FROM booking_payments WHERE id='PAY-1'").get();
    assert.equal(payment.status, "created", "creating checkout must not self-capture the payment");
  } finally {
    globalThis.fetch = realFetch;
    sqlite.close();
  }
});

test("real execution: a full-payment booking creates a gateway order for the full amount", async () => {
  const { sqlite, db } = paymentsDb({ amount: 1299, amountDueNow: 1299 });
  const realFetch = globalThis.fetch;
  let requestedSubunits = null;
  globalThis.fetch = async (_url, init) => {
    requestedSubunits = JSON.parse(String(init?.body || "{}")).amount;
    return new Response(JSON.stringify({ id: "order_stub_full" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await intent.createBookingPaymentOrder(db, sandboxGatewayEnv(), { bookingId: "BK-1", customerId: "CUS-1", actorId: "test" });
    assert.equal(result.connected, true);
    assert.equal(result.amount, 1299);
    assert.equal(requestedSubunits, 129900);
  } finally {
    globalThis.fetch = realFetch;
    sqlite.close();
  }
});

test("real execution: missing provider credentials fail closed without persisting a gateway link or capture", async () => {
  const { sqlite, db } = paymentsDb({ amount: 1299, amountDueNow: 1299 });
  try {
    const result = await intent.createBookingPaymentOrder(
      db,
      { PAWSPACE_PAYMENT_ENV: "sandbox" },
      { bookingId: "BK-1", customerId: "CUS-1", actorId: "test" },
    );
    assert.equal(result.connected, false);
    assert.equal(result.environment, "sandbox");
    assert.match(String(result.reason || ""), /credential|key/i);
    assert.equal(sqlite.prepare("SELECT status FROM booking_payments WHERE id='PAY-1'").get().status, "created");
    assert.equal(persistedGatewayLinkCount(sqlite), 0);
  } finally {
    sqlite.close();
  }
});
