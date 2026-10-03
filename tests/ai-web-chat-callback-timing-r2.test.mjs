/**
 * Proposal 1 revised. serviceDate is not callback timing.
 * A future DD/MM/YYYY requestedStart is unsupported: no consent and no dial.
 * Fetch throws. No live telephony and no model spend.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks as installProposalHooks } from "./helpers/module-hooks.mjs";
import { uatVoiceEnv, ALLOWLISTED_PHONE } from "./helpers/voice-harness.mjs";

installProposalHooks("__TIMING_DB__", "__TIMING_ENV__");
const fetches = [];
globalThis.fetch = async (input) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : String(input?.url || input);
  fetches.push(url);
  throw new Error(`network denied: ${url}`);
};
const control = await import("../lib/ai-first-control-plane.ts");
const PHONE = `+91${ALLOWLISTED_PHONE}`;

function makeD1(sqlite) {
  const statement = (sql, args) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (items) => { const results = []; for (const item of items) results.push(await item.run()); return results; },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}
async function world(env) {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__TIMING_DB__ = db;
  globalThis.__TIMING_ENV__ = env;
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  const { ensureCustomerAccountTables } = await import("../lib/customer-account.ts");
  await ensureSecurityTables(db);
  await ensureCustomerAccountTables(db);
  return { sqlite, db };
}
function seedCustomer(sqlite, customerId, phone, cityId = "blr") {
  const now = Date.now();
  sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,secondary_phone,email,source,consent_json,created_at,updated_at) VALUES (?,?,?,?,NULL,NULL,'customer_app','{}',?,?)")
    .run(customerId, cityId, `Customer ${customerId}`, phone, now, now);
}
function actor() {
  return { email: "customer.callback@pawspace.test", name: "Callback Customer", roleCode: "customer", permissions: ["customers.manage"], developmentPreview: false, identitySource: "customer_app", principalType: "phone", principalKey: PHONE };
}
function n(sqlite, name) {
  const exists = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
  return exists ? Number(sqlite.prepare(`SELECT COUNT(*) n FROM ${name}`).get().n) : 0;
}
function call(db, env, extra) {
  return control.requestGovernedCustomerCallback(db, env, { actor: actor(), customerId: "CUS-TIME", message: "Please call me back", idempotencyKey: extra.idempotencyKey, ...extra });
}

test("a future DD/MM/YYYY requestedStart never becomes an immediate callback", async () => {
  const env = uatVoiceEnv();
  const ctx = await world(env);
  seedCustomer(ctx.sqlite, "CUS-TIME", PHONE, "blr");
  const before = fetches.length;
  const future = await call(ctx.db, env, { idempotencyKey: "date-dmy", requestedStart: "01/12/2026" });
  assert.equal(future.matched, false);
  assert.equal(future.scheduling, "unsupported");
  assert.equal(future.reason, "unsupported_scheduling");
  assert.equal(future.requestedStart, "01/12/2026");
  assert.equal(future.serviceDate, null);
  assert.equal(future.notice, "Scheduling is not available.");
  assert.equal(n(ctx.sqlite, "voice_call_orders"), 0);
  assert.equal(n(ctx.sqlite, "voice_call_consents"), 0);
  assert.equal(n(ctx.sqlite, "ai_callback_request_context"), 0);
  assert.equal(fetches.length, before);

  const dashed = await world(env);
  seedCustomer(dashed.sqlite, "CUS-TIME", PHONE, "blr");
  const dash = await call(dashed.db, env, { idempotencyKey: "date-dash", requestedStart: "28-09-2027" });
  assert.equal(dash.matched, false);
  assert.equal(dash.scheduling, "unsupported");
  assert.equal(dash.requestedStart, "28/09/2027");
  assert.equal(dash.serviceDate, null);
  assert.equal(n(dashed.sqlite, "voice_call_orders"), 0);
  assert.equal(n(dashed.sqlite, "voice_call_consents"), 0);

  const short = await world(env);
  seedCustomer(short.sqlite, "CUS-TIME", PHONE, "blr");
  await assert.rejects(
    () => call(short.db, env, { idempotencyKey: "date-short", requestedStart: "02/10" }),
    (error) => error instanceof Response && error.status === 400,
  );
  assert.equal(n(short.sqlite, "voice_call_orders"), 0);
  assert.equal(n(short.sqlite, "voice_call_consents"), 0);
});

test("serviceDate is persisted on an immediate callback and is not a schedule", async () => {
  const env = uatVoiceEnv();
  const ctx = await world(env);
  seedCustomer(ctx.sqlite, "CUS-TIME", PHONE, "blr");
  const before = fetches.length;
  const placed = await call(ctx.db, env, { idempotencyKey: "svc-date", serviceDate: "01/12/2026" });
  assert.equal(placed.matched, true);
  assert.equal(placed.scheduling, undefined);
  assert.equal(placed.serviceDate, "01/12/2026");
  assert.equal(placed.requestedStart, null);
  assert.equal(ctx.sqlite.prepare("SELECT service_date, requested_start FROM ai_callback_request_context").get().service_date, "01/12/2026");
  assert.equal(ctx.sqlite.prepare("SELECT requested_start FROM ai_callback_request_context").get().requested_start, null);
  const order = ctx.sqlite.prepare("SELECT requested_at, state FROM voice_call_orders").get();
  assert.ok(Math.abs(order.requested_at - Date.now()) < 20_000);
  assert.ok(order.state === "dialing" || order.state === "blocked_quiet_hours");
  assert.equal(n(ctx.sqlite, "voice_call_consents"), 1);
  assert.equal(fetches.length, before);

  const dashed = await world(env);
  seedCustomer(dashed.sqlite, "CUS-TIME", PHONE, "blr");
  const dash = await call(dashed.db, env, { idempotencyKey: "svc-dash", serviceDate: "28-09-2027" });
  assert.equal(dash.matched, true);
  assert.equal(dash.serviceDate, "28/09/2027");
  assert.equal(dash.requestedStart, null);
  assert.notEqual(dash.scheduling, "unsupported");
});

test("a future callback requestedStart stays unsupported with no consent and no dial", async () => {
  const env = uatVoiceEnv();
  const ctx = await world(env);
  seedCustomer(ctx.sqlite, "CUS-TIME", PHONE, "blr");
  const when = new Date(Date.now() + 3 * 86400000).toISOString();
  const before = fetches.length;
  const rejected = await call(ctx.db, env, { idempotencyKey: "future-iso", requestedStart: when, serviceDate: "01/12/2026" });
  assert.equal(rejected.matched, false);
  assert.equal(rejected.scheduling, "unsupported");
  assert.equal(rejected.reason, "unsupported_scheduling");
  assert.equal(rejected.requestedStart, when);
  assert.equal(rejected.serviceDate, "01/12/2026");
  assert.equal(n(ctx.sqlite, "voice_call_orders"), 0);
  assert.equal(n(ctx.sqlite, "voice_call_consents"), 0);
  assert.equal(n(ctx.sqlite, "ai_callback_request_context"), 0);
  assert.equal(fetches.length, before);

  const dateOnly = await world(env);
  seedCustomer(dateOnly.sqlite, "CUS-TIME", PHONE, "blr");
  const isoDate = await call(dateOnly.db, env, { idempotencyKey: "future-iso-date", requestedStart: "2026-12-01" });
  assert.equal(isoDate.matched, false);
  assert.equal(isoDate.scheduling, "unsupported");
  assert.equal(isoDate.serviceDate, null);
  assert.equal(n(dateOnly.sqlite, "voice_call_orders"), 0);
  assert.equal(n(dateOnly.sqlite, "voice_call_consents"), 0);
});

test("an unparseable or impossible date is still refused before consent", async () => {
  const env = uatVoiceEnv();
  const ctx = await world(env);
  seedCustomer(ctx.sqlite, "CUS-TIME", PHONE, "blr");
  for (const [key, requestedStart] of [["bad-words", "11am-1pm"], ["bad-cal", "31/02/2026"], ["bad-past", new Date(Date.now() - 3 * 86400000).toISOString()], ["bad-past-dmy", "01/01/2020"]]) {
    await assert.rejects(
      () => call(ctx.db, env, { idempotencyKey: key, requestedStart }),
      (error) => error instanceof Response && error.status === 400,
    );
  }
  await assert.rejects(
    () => call(ctx.db, env, { idempotencyKey: "bad-service-date", serviceDate: "31/02/2026" }),
    (error) => error instanceof Response && error.status === 400,
  );
  assert.equal(n(ctx.sqlite, "voice_call_orders"), 0);
  assert.equal(n(ctx.sqlite, "voice_call_consents"), 0);
  const now = await call(ctx.db, env, { idempotencyKey: "word-now", requestedStart: "now" });
  assert.equal(now.matched, true);
  assert.equal(now.requestedStart, null);
  assert.equal(now.serviceDate, null);
  assert.deepEqual(fetches, []);
});
