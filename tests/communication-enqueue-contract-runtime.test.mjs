import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

// ---------------------------------------------------------------------------
// enqueueCommunication contract — EXECUTABLE blast-radius cover.
// ---------------------------------------------------------------------------
installWorkersHooks("__ENQUEUE_DB__");

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
  globalThis.__ENQUEUE_DB__ = db;
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
const NEEDS_BOOKING = new Set(["transactional", "service_recovery"]);
const send = (comms, db, purpose, customerId) => comms.enqueueCommunication(db, {
  customerId, cityId: "blr", channel: "whatsapp", purpose,
  bookingId: NEEDS_BOOKING.has(purpose) ? `BK-${customerId}` : undefined,
  idempotencyKey: `contract-${purpose}-${customerId}-${(key += 1)}`,
  templateKey: `${purpose}_template`, payload: {}, createdBy: "system",
});

const EXPLICIT_CASES = [
  { purpose: "transactional", preference: { serviceUpdates: false }, expect: "suppressed", why: "service updates opted out" },
  { purpose: "transactional", preference: { serviceUpdates: true }, expect: "queued", why: "service updates allowed" },
  { purpose: "service_recovery", preference: { serviceUpdates: false }, expect: "suppressed", why: "recovery follows the service-update choice" },
  { purpose: "service_recovery", preference: { serviceUpdates: true }, expect: "queued", why: "recovery allowed" },
  { purpose: "lifecycle", preference: { serviceUpdates: false }, expect: "suppressed", why: "lifecycle follows the service-update choice" },
  { purpose: "lifecycle", preference: { serviceUpdates: true }, expect: "scheduled", why: "lifecycle allowed during quiet hours" },
  { purpose: "marketing", preference: { marketing: true }, expect: "scheduled", why: "marketing explicitly consented during quiet hours" },
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
  setPreference(sqlite, "CU-Q", {});
  assert.equal((await send(comms, db, "lifecycle", "CU-Q")).status, "scheduled");
  assert.equal((await send(comms, db, "marketing", "CU-Q")).status, "suppressed", "marketing needs an explicit yes");
});

test("with no preference row, consent is read from the canonical customer record", async () => {
  const { sqlite, db, comms } = await world();
  seedCustomer(sqlite, "CU-R", { serviceUpdates: false, marketing: true });
  assert.equal((await send(comms, db, "transactional", "CU-R")).status, "suppressed", "the record's opt-out is honoured");
  assert.equal((await send(comms, db, "marketing", "CU-R")).status, "scheduled", "and so is its marketing consent");
});

test("an explicit preference row overrides the canonical customer record", async () => {
  const { sqlite, db, comms } = await world();
  seedCustomer(sqlite, "CU-S", { serviceUpdates: false, marketing: false });
  setPreference(sqlite, "CU-S", { serviceUpdates: true, marketing: true });
  assert.equal((await send(comms, db, "transactional", "CU-S")).status, "queued");
  assert.equal((await send(comms, db, "marketing", "CU-S")).status, "scheduled");
});

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
  for (const purpose of ["transactional", "service_recovery"]) {
    const result = await send(comms, db, purpose, "CU-UNKNOWN");
    assert.equal(result.status, "queued", `${purpose} must still reach a customer who never opted out`);
  }
  const lifecycle = await send(comms, db, "lifecycle", "CU-UNKNOWN");
  assert.equal(lifecycle.status, "scheduled", "lifecycle remains allowed but respects quiet hours");
});

test("R1: the consent source is reported honestly as unknown rather than invented", async () => {
  const { db, comms } = await world({ withCustomers: false });
  const result = await send(comms, db, "lifecycle", "CU-NOSOURCE");
  assert.equal(result.policy.consentSource, "unknown");
  assert.equal(result.policy.serviceUpdates, null, "absence of a record is not a yes");
  assert.equal(result.policy.marketing, null);
});

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
