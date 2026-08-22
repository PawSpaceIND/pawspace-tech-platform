import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

function makeD1(sqlite) {
  const statement = (sql, args) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => {
      const row = sqlite.prepare(sql).get(...args);
      return row === undefined ? null : row;
    },
    run: async () => {
      const info = sqlite.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(info.changes) } };
    },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (list) => {
      const out = [];
      for (const item of list) out.push(await item.run());
      return out;
    },
    exec: async (sql) => {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
  };
}

function seedQuote(sqlite, quoteId = "SQ-D10", amount = 1200) {
  sqlite.exec("CREATE TABLE sitting_commercial_quotes (id TEXT PRIMARY KEY,total_amount REAL NOT NULL,amount_due_now REAL NOT NULL,status TEXT NOT NULL,expires_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT INTO sitting_commercial_quotes VALUES (?,?,?,?,?)").run(quoteId, amount, amount, "open", Date.now() + 86_400_000);
}

async function moduleUnderTest() {
  return import("../lib/sitting-payment-governance.ts");
}

async function responseText(error) {
  assert.ok(error instanceof Response, `expected Response, got ${error}`);
  return { status: error.status, body: await error.text() };
}

test("D10: first capture durably binds the payment key and same-key retry reuses the canonical reference", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  seedQuote(sqlite);
  const { captureSittingQuoteSandbox } = await moduleUnderTest();

  const first = await captureSittingQuoteSandbox(db, { quoteId: "SQ-D10", amount: 1200, paymentKey: "capture-key-1" });
  const retry = await captureSittingQuoteSandbox(db, { quoteId: "SQ-D10", amount: 1200, paymentKey: "capture-key-1" });
  const stored = sqlite.prepare("SELECT reference,bound_payment_key FROM sitting_quote_payment_attestations WHERE quote_id='SQ-D10'").get();

  assert.equal(stored.bound_payment_key, "capture-key-1");
  assert.equal(first.reference, stored.reference);
  assert.equal(retry.reference, stored.reference);
  assert.equal(first.duplicatePrevented, false);
  assert.equal(retry.duplicatePrevented, true);
});

test("D10: a different payment key is rejected before the captured reference is disclosed or changed", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  seedQuote(sqlite);
  const { captureSittingQuoteSandbox } = await moduleUnderTest();

  const first = await captureSittingQuoteSandbox(db, { quoteId: "SQ-D10", amount: 1200, paymentKey: "owner-key" });
  let caught;
  try {
    await captureSittingQuoteSandbox(db, { quoteId: "SQ-D10", amount: 1200, paymentKey: "replay-key" });
  } catch (error) {
    caught = error;
  }
  const failure = await responseText(caught);
  const stored = sqlite.prepare("SELECT reference,bound_payment_key FROM sitting_quote_payment_attestations WHERE quote_id='SQ-D10'").get();

  assert.equal(failure.status, 403);
  assert.equal(failure.body, "PAYMENT_CAPTURE_REPLAY");
  assert.equal(stored.bound_payment_key, "owner-key");
  assert.equal(stored.reference, first.reference);
});

test("D10: concurrent competing first captures produce exactly one owner and one replay rejection", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  seedQuote(sqlite);
  const { captureSittingQuoteSandbox } = await moduleUnderTest();

  const results = await Promise.allSettled([
    captureSittingQuoteSandbox(db, { quoteId: "SQ-D10", amount: 1200, paymentKey: "race-a" }),
    captureSittingQuoteSandbox(db, { quoteId: "SQ-D10", amount: 1200, paymentKey: "race-b" }),
  ]);
  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);

  const failure = await responseText(rejected[0].reason);
  const stored = sqlite.prepare("SELECT reference,bound_payment_key FROM sitting_quote_payment_attestations WHERE quote_id='SQ-D10'").get();
  assert.equal(failure.status, 403);
  assert.equal(failure.body, "PAYMENT_CAPTURE_REPLAY");
  assert.equal(fulfilled[0].value.reference, stored.reference);
  assert.ok(["race-a", "race-b"].includes(stored.bound_payment_key));
});

test("D10: legacy attestation schema is migrated and only the first retry may claim an unbound captured row", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  seedQuote(sqlite);
  const now = Date.now();
  sqlite.exec("CREATE TABLE sitting_quote_payment_attestations (quote_id TEXT PRIMARY KEY,status TEXT NOT NULL,amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',environment TEXT NOT NULL DEFAULT 'sandbox',reference TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT INTO sitting_quote_payment_attestations VALUES (?,?,?,?,?,?,?,?)").run("SQ-D10", "captured", 1200, "INR", "sandbox", "SIT-UAT-PAY-LEGACY", now, now);
  const { captureSittingQuoteSandbox } = await moduleUnderTest();

  const claimed = await captureSittingQuoteSandbox(db, { quoteId: "SQ-D10", amount: 1200, paymentKey: "legacy-owner" });
  assert.equal(claimed.reference, "SIT-UAT-PAY-LEGACY");
  assert.equal(claimed.duplicatePrevented, true);
  const columns = sqlite.prepare("PRAGMA table_info(sitting_quote_payment_attestations)").all().map((row) => row.name);
  assert.ok(columns.includes("bound_payment_key"));
  assert.equal(sqlite.prepare("SELECT bound_payment_key FROM sitting_quote_payment_attestations WHERE quote_id='SQ-D10'").get().bound_payment_key, "legacy-owner");

  let caught;
  try {
    await captureSittingQuoteSandbox(db, { quoteId: "SQ-D10", amount: 1200, paymentKey: "legacy-replay" });
  } catch (error) {
    caught = error;
  }
  const failure = await responseText(caught);
  assert.equal(failure.status, 403);
  assert.equal(failure.body, "PAYMENT_CAPTURE_REPLAY");
});

test("D10 route requires a capture key and passes it into governance", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../app/api/sitting-payment-sandbox/route.ts", import.meta.url), "utf8");
  assert.match(source, /x-payment-capture-key/);
  assert.match(source, /MISSING_CAPTURE_KEY/);
  assert.match(source, /captureSittingQuoteSandbox\(await database\(\),\{quoteId,amount,paymentKey\}\)/);
});

test("D10 client sends one retained random capture key per quote", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../lib/sitting-payment-client.ts", import.meta.url), "utf8");
  assert.match(source, /x-payment-capture-key/);
  assert.match(source, /crypto\.randomUUID\(\)/);
  assert.match(source, /captureKeys/);
  assert.match(source, /captureKeyForQuote\(input\.quoteId\)/);
  assert.match(source, /input:\{quoteId:string;amount:number\}/);
});
