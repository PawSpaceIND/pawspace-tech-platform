import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";

// ---------------------------------------------------------------------------
// enqueueCommunication contract — EXECUTABLE blast-radius cover.
//
// Two fixes in this change set touch enqueueCommunication, which is shared well
// beyond reminders: staff alerts, food subscriptions, /api/communications and
// /api/customer-contact all go through it.
//
//   R1  the canonical_customers consent fallback is now guarded, so a cold or
//       partially-migrated database degrades to "consent unknown" instead of
//       throwing out of every enqueue.
//   R3  losing the idempotency-key race now returns the documented
//       duplicatePrevented result instead of a raw unique-constraint error.
//
// Neither fix may change what any purpose is allowed to send. This file pins the
// consent decision for every purpose, on both a warm and a cold database, and
// proves the race handler does not swallow a genuine error.
// ---------------------------------------------------------------------------

const WORKERS_SHIM = `export const env = new Proxy({}, { get: (_, key) => globalThis.__PAWSPACE_TEST_ENV?.[key] });`;
const workersUrl = `data:text/javascript,${encodeURIComponent(WORKERS_SHIM)}`;
if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true };
      try { return nextResolve(specifier, context); }
      catch (error) {
        if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context);
        throw error;
      }
    },
  });
} else {
  const hook = `const workersUrl=${JSON.stringify(workersUrl)};
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true };
    try { return await nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(specifier + ".ts", context);
      throw error;
    }
  }`;
  nodeModule.register(new URL(`data:text/javascript,${encodeURIComponent(hook)}`));
}

function makeD1(sqlite) {
  function statement(sql, args) {
    return {
      bind: (...bound) => statement(sql, bound),
      first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
      run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    };
  }
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (list) => { const out = []; for (const item of list) out.push(await item.run()); return out; },
    exec: async (sql) => { sqlite.exec(sql); },
  };
}

const NOW = 1770000000000;
const CANONICAL_CUSTOMERS = "CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'customer_app',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)";

async function world({ withCustomers = true } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PAWSPACE_TEST_ENV = { DB: db };
  if (withCustomers) sqlite.exec(CANONICAL_CUSTOMERS);
  const comms = await import("../lib/communication-engine.ts");
  await comms.ensureCommunicationTables(db);
  return { sqlite, db, comms };
}
function setPreference(sqlite, customerId, { serviceUpdates = null, marketing = null } = {}) {
  sqlite.prepare("INSERT OR REPLACE INTO communication_preferences (customer_id,service_updates,marketing,preferred_channel,timezone,source,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(customerId, serviceUpdates === null ? null : serviceUpdates ? 1 : 0, marketing === null ? null : marketing ? 1 : 0, "whatsapp", "Asia/Kolkata", "customer_choice", NOW);
}
function seedCustomer(sqlite, id, consent = {}) {
  sqlite.prepare("INSERT OR REPLACE INTO canonical_customers (id,city_id,name,primary_phone,consent_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(id, "blr", `Customer ${id}`, "9999900000", JSON.stringify(consent), NOW, NOW);
}
let key = 0;
// transactional and service_recovery are hard-suppressed without a linked booking
// ("booking_link_required"), which is a separate governance rule. Link one so these cases exercise
// the consent decision rather than that rule.
const NEEDS_BOOKING = new Set(["transactional", "service_recovery"]);
const send = (comms, db, purpose, customerId) => comms.enqueueCommunication(db, {
  customerId, cityId: "blr", channel: "whatsapp", purpose,
  bookingId: NEEDS_BOOKING.has(purpose) ? `BK-${customerId}` : undefined,
  idempotencyKey: `contract-${purpose}-${customerId}-${(key += 1)}`,
  templateKey: `${purpose}_template`, payload: {}, createdBy: "system",
});

// --- consent decision per purpose, with an explicit preference on file ----
// An explicit preference row short-circuits the canonical_customers fallback, so these cases prove
// the guard changed nothing for any customer who has ever expressed a preference.

const EXPLICIT_CASES = [
  { purpose: "transactional", preference: { serviceUpdates: false }, expect: "suppressed", why: "service updates opted out" },
  { purpose: "transactional", preference: { serviceUpdates: true }, expect: "queued", why: "service updates allowed" },
  { purpose: "service_recovery", preference: { serviceUpdates: false }, expect: "suppressed", why: "recovery follows the service-update choice" },
  { purpose: "service_recovery", preference: { serviceUpdates: true }, expect: "queued", why: "recovery allowed" },
  { purpose: "lifecycle", preference: { serviceUpdates: false }, expect: "suppressed", why: "lifecycle follows the service-update choice" },
  { purpose: "lifecycle", preference: { serviceUpdates: true }, expect: "queued", why: "lifecycle allowed" },
  { purpose: "marketing", preference: { marketing: true }, expect: "queued", why: "marketing explicitly consented" },
  { purpose: "marketing", preference: { marketing: false }, expect: "suppressed", why: "marketing opted out" },
  { purpose: "marketing", preference: { serviceUpdates: true }, expect: "suppressed", why: "service consent is not marketing consent" },
];

for (const item of EXPLICIT_CASES) {
  test(`${item.purpose} with ${JSON.stringify(item.preference)} → ${item.expect} (${item.why})`, async () => {
    const { sqlite, db, comms } = await world();
    seedCustomer(sqlite, "CU-P");
    setPreference(sqlite, "CU-P", item.preference);
    const result = await send(comms, db, item.purpose, "CU-P");
    assert.equal(result.status, item.expect);
  });
}

test("lifecycle with no stated service-update choice is allowed, marketing is not", async () => {
  const { sqlite, db, comms } = await world();
  seedCustomer(sqlite, "CU-Q");
  setPreference(sqlite, "CU-Q", {}); // a row exists but says nothing either way
  assert.equal((await send(comms, db, "lifecycle", "CU-Q")).status, "queued");
  assert.equal((await send(comms, db, "marketing", "CU-Q")).status, "suppressed", "marketing needs an explicit yes");
});

// --- the canonical_customers fallback itself ------------------------------

test("with no preference row, consent is read from the canonical customer record", async () => {
  const { sqlite, db, comms } = await world();
  seedCustomer(sqlite, "CU-R", { serviceUpdates: false, marketing: true });
  assert.equal((await send(comms, db, "transactional", "CU-R")).status, "suppressed", "the record's opt-out is honoured");
  assert.equal((await send(comms, db, "marketing", "CU-R")).status, "queued", "and so is its marketing consent");
});

test("an explicit preference row overrides the canonical customer record", async () => {
  const { sqlite, db, comms } = await world();
  seedCustomer(sqlite, "CU-S", { serviceUpdates: false, marketing: false });
  setPreference(sqlite, "CU-S", { serviceUpdates: true, marketing: true });
  assert.equal((await send(comms, db, "transactional", "CU-S")).status, "queued");
  assert.equal((await send(comms, db, "marketing", "CU-S")).status, "queued");
});

// --- R1: the same decisions on a cold database ---------------------------

test("R1: a cold database does not change the decision for a customer who has a preference", async () => {
  for (const item of EXPLICIT_CASES) {
    const { sqlite, db, comms } = await world({ withCustomers: false });
    setPreference(sqlite, "CU-COLD", item.preference);
    const result = await send(comms, db, item.purpose, "CU-COLD");
    assert.equal(result.status, item.expect, `${item.purpose} ${JSON.stringify(item.preference)} must behave identically without canonical_customers`);
  }
});

test("R1: a cold database fails safe for a customer with no preference at all", async () => {
  const { db, comms } = await world({ withCustomers: false });
  const marketing = await send(comms, db, "marketing", "CU-UNKNOWN");
  assert.equal(marketing.status, "suppressed", "unknown consent must never permit marketing");
  assert.ok(marketing.policy.reasons.includes("marketing_consent_unknown"));
  for (const purpose of ["transactional", "service_recovery", "lifecycle"]) {
    const result = await send(comms, db, purpose, "CU-UNKNOWN");
    assert.equal(result.status, "queued", `${purpose} must still reach a customer who never opted out`);
  }
});

test("R1: the consent source is reported honestly as unknown rather than invented", async () => {
  const { db, comms } = await world({ withCustomers: false });
  const result = await send(comms, db, "lifecycle", "CU-NOSOURCE");
  assert.equal(result.policy.consentSource, "unknown");
  assert.equal(result.policy.serviceUpdates, null, "absence of a record is not a yes");
  assert.equal(result.policy.marketing, null);
});

// --- R3: the idempotency race, for every purpose -------------------------

for (const purpose of ["transactional", "service_recovery", "lifecycle", "marketing"]) {
  test(`R3: a concurrent ${purpose} enqueue yields one message and one duplicate result`, async () => {
    const { sqlite, db, comms } = await world();
    seedCustomer(sqlite, "CU-RACE");
    setPreference(sqlite, "CU-RACE", { serviceUpdates: true, marketing: true });
    const input = { customerId: "CU-RACE", cityId: "blr", channel: "whatsapp", purpose, bookingId: NEEDS_BOOKING.has(purpose) ? "BK-RACE" : undefined, idempotencyKey: `race-${purpose}`, templateKey: "t", payload: {}, createdBy: "system" };
    const results = await Promise.all([comms.enqueueCommunication(db, input), comms.enqueueCommunication(db, input)]);
    assert.equal(results.filter((r) => r.duplicatePrevented).length, 1, "exactly one caller is told it lost the race");
    assert.equal(results.filter((r) => !r.duplicatePrevented).length, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM communication_messages").get().c, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM communication_outbox").get().c, 1, "and it is queued for delivery once");
  });
}

test("R3: a sequential duplicate still short-circuits before doing any work", async () => {
  const { sqlite, db, comms } = await world();
  seedCustomer(sqlite, "CU-SEQ");
  const input = { customerId: "CU-SEQ", cityId: "blr", channel: "whatsapp", purpose: "lifecycle", idempotencyKey: "seq-1", templateKey: "t", payload: {}, createdBy: "system" };
  const first = await comms.enqueueCommunication(db, input);
  const second = await comms.enqueueCommunication(db, input);
  assert.equal(first.duplicatePrevented, false);
  assert.equal(second.duplicatePrevented, true);
  assert.equal(String(second.message.id), first.messageId, "the duplicate result points at the surviving message");
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM communication_messages").get().c, 1);
});

test("R3: the race handler does not swallow a genuine failure", async () => {
  // A constraint failure that is NOT a lost idempotency race must still surface. Induce one by
  // making template_key unique, then enqueue a second message with a fresh idempotency key and the
  // same template: the insert fails, and no row exists for that key, so it must rethrow rather than
  // report a duplicate. (Dropping a table would not work - ensureCommunicationTables recreates it.)
  const { sqlite, db, comms } = await world();
  seedCustomer(sqlite, "CU-BOOM");
  const base = { customerId: "CU-BOOM", cityId: "blr", channel: "whatsapp", purpose: "lifecycle", templateKey: "only_once", payload: {}, createdBy: "system" };
  await comms.enqueueCommunication(db, { ...base, idempotencyKey: "boom-first" });
  sqlite.exec("CREATE UNIQUE INDEX one_template_only ON communication_messages(template_key)");
  await assert.rejects(
    () => comms.enqueueCommunication(db, { ...base, idempotencyKey: "boom-second" }),
    /UNIQUE|constraint/i,
    "a genuine constraint error must propagate, not be disguised as duplicatePrevented",
  );
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM communication_messages").get().c, 1);
});

// --- suppressed messages never become deliverable, for any purpose -------

test("a suppressed message of any purpose never enters the outbox", async () => {
  for (const [purpose, preference] of [["transactional", { serviceUpdates: false }], ["lifecycle", { serviceUpdates: false }], ["service_recovery", { serviceUpdates: false }], ["marketing", { marketing: false }]]) {
    const { sqlite, db, comms } = await world();
    seedCustomer(sqlite, "CU-SUP");
    setPreference(sqlite, "CU-SUP", preference);
    const result = await send(comms, db, purpose, "CU-SUP");
    assert.equal(result.status, "suppressed", purpose);
    assert.ok(result.policy.reasons.length > 0, `${purpose} suppression must state a reason`);
    assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM communication_outbox").get().c, 0, `${purpose} suppression must not be deliverable`);
  }
});
