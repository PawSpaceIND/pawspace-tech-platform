import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__SETTLEMENT_BOUNDARY_DB__", "__SETTLEMENT_BOUNDARY_ENV__");

function makeD1(sqlite) {
  function statement(sql, args = []) {
    return {
      bind: (...bound) => statement(sql, bound),
      first: async () => sqlite.prepare(sql).get(...args) ?? null,
      run: async () => {
        const info = sqlite.prepare(sql).run(...args);
        return { success: true, meta: { changes: Number(info.changes || 0) } };
      },
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    };
  }
  return {
    prepare: (sql) => statement(sql),
    batch: async (items) => {
      const results = [];
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        for (const item of items) results.push(await item.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

const SECRET = "settlement-boundary-sandbox-secret";
const route = await import("../app/api/razorpay-webhook/route.ts");

async function createDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.exec("CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY, status TEXT NOT NULL)");
  sqlite.exec(await readFile(new URL("../drizzle/0017_financial_lifecycle_hardening.sql", import.meta.url), "utf8"));
  sqlite.exec(await readFile(new URL("../drizzle/0018_financial_lifecycle_split_intents.sql", import.meta.url), "utf8"));
  return { sqlite, db: makeD1(sqlite) };
}

test("aggregate settlement.processed cannot advance a single payment intent to SETTLED", async () => {
  const { sqlite, db } = await createDb();
  globalThis.__SETTLEMENT_BOUNDARY_DB__ = db;
  globalThis.__SETTLEMENT_BOUNDARY_ENV__ = {
    PAWSPACE_PAYMENT_ENV: "sandbox",
    RAZORPAY_WEBHOOK_SECRET_SANDBOX: SECRET,
  };
  try {
    const now = Date.now();
    sqlite.prepare(`INSERT INTO payment_intents
      (id,booking_id,customer_id,payment_id,provider,environment,idempotency_key,amount_paise,currency,state,order_request_state,gateway_order_id,created_at,updated_at)
      VALUES (?,?,?,?, 'razorpay','sandbox',?,?,?,'CAPTURED','ORDER_CREATED',?,?,?)`)
      .run("PI-SETTLEMENT-1", "BOOK-SETTLEMENT-1", "CUS-SETTLEMENT-1", "PAY-SETTLEMENT-1", "settlement-boundary", 25000, "INR", "order_settlement_boundary", now, now);

    const payload = {
      event: "settlement.processed",
      created_at: Math.floor(now / 1000),
      payload: {
        payment: {
          entity: {
            id: "pay_settlement_boundary",
            order_id: "order_settlement_boundary",
            amount: 25000,
            currency: "INR",
          },
        },
        settlement: { entity: { id: "setl_aggregate_boundary" } },
      },
    };
    const raw = JSON.stringify(payload);
    const signature = createHmac("sha256", SECRET).update(raw).digest("hex");
    const response = await route.POST(new Request("http://localhost/api/razorpay-webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-razorpay-signature": signature,
        "x-razorpay-event-id": "evt_settlement_boundary",
      },
      body: raw,
    }));

    assert.ok([200, 409].includes(response.status), `unexpected settlement response ${response.status}`);
    const intent = sqlite.prepare("SELECT state,gateway_settlement_id FROM payment_intents WHERE id='PI-SETTLEMENT-1'").get();
    assert.equal(intent?.state, "CAPTURED", "aggregate settlement must not advance one intent to SETTLED");
    assert.equal(intent?.gateway_settlement_id ?? null, null, "aggregate settlement must not bind itself to one payment intent");
  } finally {
    sqlite.close();
    delete globalThis.__SETTLEMENT_BOUNDARY_DB__;
    delete globalThis.__SETTLEMENT_BOUNDARY_ENV__;
  }
});
