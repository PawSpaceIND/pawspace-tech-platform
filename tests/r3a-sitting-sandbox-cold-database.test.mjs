/*
 * R3-A (suspected, now REPRODUCED) — POST /api/sitting-payment-sandbox answered 500 "Sitting sandbox
 * payment failed" on the auditor's first-ever call to that endpoint, while every later identical call
 * answered the correct 404 "Sitting quote not found".
 *
 * It was suspected to be a race in ensureSittingPaymentTables. It is not a race, and it is fully
 * deterministic: captureSittingQuoteSandbox ensures the ATTESTATION table it owns and then READS
 * sitting_commercial_quotes, which belongs to lib/sitting-governance.ts. On a genuinely cold database
 * — before any Sitting quote has ever been created — that read throws "no such table", which is not a
 * Response, so the route's authError answered 500 with a generic message. Once any other request had
 * created the table, the same call answered the correct 404. First-call-only, exactly as observed.
 *
 * The fix is an existence check, not an ensure: a quote table that does not exist holds no quotes, so
 * the honest answer is the same 404, and a payment capture has no business creating another module's
 * tables. Same shape as the cold-database guard already in lib/boarding-host-discovery.ts.
 *
 * The tests drive the real route against a real cold D1. They fail on the FIRST call, which is the one
 * that was broken, and keep the honest 404 for a quote that genuinely does not exist.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { makeD1, freshSqlite } from "./helpers/taxi-harness.mjs";

installWorkersHooks("__R3A_SIT_COLD_DB__", "__R3A_SIT_COLD_ENV__");

const route = await import("../app/api/sitting-payment-sandbox/route.ts");
const sitting = await import("../lib/sitting-governance.ts");
const payments = await import("../lib/sitting-payment-governance.ts");

/** A database on which nothing has ever run. No ensure*Tables, no seed, no prior request. */
function coldWorld() {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__R3A_SIT_COLD_DB__ = db;
  globalThis.__R3A_SIT_COLD_ENV__ = { PAWSPACE_PAYMENT_ENV: "sandbox", PAWSPACE_PAYMENT_LIVE_APPROVED: "false", FORBID_PRODUCTION: "true" };
  return { sqlite, db };
}

const post = async (body) => {
  const response = await route.POST(new Request("http://localhost/api/sitting-payment-sandbox", {
    method: "POST",
    headers: { "content-type": "application/json", "x-payment-capture-key": "R3A-COLD-KEY" },
    body: JSON.stringify(body),
  }));
  return { status: response.status, body: await response.json().catch(() => null) };
};

test("the FIRST call against a cold database refuses honestly instead of reporting a server fault", async () => {
  const { sqlite } = coldWorld();
  assert.equal(
    sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sitting_commercial_quotes'").get(),
    undefined,
    "the fixture must genuinely start with no Sitting quote table, or this proves nothing",
  );

  const first = await post({ quoteId: "SQ-NEVER-EXISTED", amount: 100 });

  assert.equal(first.status, 404, `the first call answered ${first.status}: ${JSON.stringify(first.body)}`);
  assert.equal(first.body?.error, "Sitting quote not found");
  assert.notEqual(first.body?.error, "Sitting sandbox payment failed",
    "a missing quote is the caller's problem and must never be reported as a server fault");
});

test("the second and third calls answer identically — the first call was the only broken one", async () => {
  coldWorld();
  const answers = [await post({ quoteId: "SQ-NEVER-EXISTED", amount: 100 }), await post({ quoteId: "SQ-NEVER-EXISTED", amount: 100 }), await post({ quoteId: "SQ-NEVER-EXISTED", amount: 100 })];
  assert.deepEqual(answers.map((item) => item.status), [404, 404, 404]);
  assert.equal(new Set(answers.map((item) => item.body?.error)).size, 1, "identical calls must produce identical answers");
});

test("a real open quote on a cold database still captures, so the ensure is not masking the read", async () => {
  const { sqlite, db } = coldWorld();
  await sitting.ensureSittingGovernanceTables(db);
  const now = Date.now();
  sqlite.prepare("INSERT INTO sitting_commercial_quotes (id,package_code,package_version,mode,pet_count,city_id,zone_id,scheduled_start,scheduled_end,billable_units,payment_mode,total_amount,amount_due_now,expires_at,status,created_at) VALUES ('SQ-R3A-COLD','sitting-visit-60',1,'visit',1,'blr','blr-east',?,?,1,'prepaid',1200,1200,?,'open',?)")
    .run(new Date(now + 86_400_000).toISOString(), new Date(now + 90_000_000).toISOString(), now + 900_000, now);

  const captured = await post({ quoteId: "SQ-R3A-COLD", amount: 1200 });
  assert.equal(captured.status, 201, `a genuine open quote must still capture: ${JSON.stringify(captured.body)}`);
  assert.equal(captured.body?.data?.status, "captured");
  assert.equal(captured.body?.data?.liveMoney, false);
  const row = sqlite.prepare("SELECT status,amount FROM sitting_quote_payment_attestations WHERE quote_id='SQ-R3A-COLD'").get();
  assert.equal(row.status, "captured");
  assert.equal(Number(row.amount), 1200);
});

test("the capture path answers for a quote table that does not exist yet, instead of throwing through it", async () => {
  // Called directly, off the route, so the refusal is the library's own and not authError's.
  const { db } = coldWorld();
  let thrown = null;
  try { await payments.captureSittingQuoteSandbox(db, { quoteId: "SQ-NEVER-EXISTED", amount: 1, paymentKey: "K" }); }
  catch (error) { thrown = error; }
  assert.ok(thrown instanceof Response, `the library must refuse with a Response, got: ${thrown}`);
  assert.equal(thrown.status, 404);
  assert.equal(await thrown.text(), "Sitting quote not found");
});
