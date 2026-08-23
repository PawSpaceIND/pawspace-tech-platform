import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

// ---------------------------------------------------------------------------
// Reminders / lifecycle — EXECUTABLE closure.
//
// Before this file the reminder lane had exactly one executable test; everything
// else asserted on source text, which cannot observe a clock bug, a consent
// bypass or a duplicate. Every test below runs the real reminder governance,
// communication engine and sandbox delivery boundary against real SQLite.
//
// Two defects were found by executing this path and are pinned here as
// regressions:
//   R1  enqueueCommunication read canonical_customers unguarded, so a cold or
//       partially-migrated database threw a raw SQL error out of every enqueue
//       and the whole reminder sweep failed.
//   R2  the reminder generators stamped next_attempt_at from Date.now() while
//       the sweep decided due-ness from asOf. next_attempt_at was therefore
//       always > asOf, so runCustomerReminderSweep queued reminders and
//       delivered zero of them — on every single run, not only in tests.
//   R3  enqueueCommunication reads the prior message and inserts outside one
//       transaction, so two concurrent sweeps both passed the read and the
//       loser hit the unique index as a raw SQL error rather than the
//       documented duplicatePrevented result.
// ---------------------------------------------------------------------------

// The shared helper carries both registration paths: module.registerHooks needs Node >=22.15 and
// CI pins 22.13.0, where the inline form throws and takes the whole file down before any test runs.
installWorkersHooks("__REMINDER_DB__");

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

const DAY = 86_400_000;
const NOW = 1770000000000;
const iso = (ms) => new Date(ms).toISOString();

// Tables the reminder engine reads but does not own. Real DDL, taken from the owning modules.
const CANONICAL_BOOKINGS = "CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL DEFAULT '[]',source_pet_ids_json TEXT NOT NULL DEFAULT '[]',city_id TEXT NOT NULL,zone_id TEXT NOT NULL,service_code TEXT NOT NULL,package_code TEXT NOT NULL,package_name TEXT NOT NULL,schedule_group_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'confirmed',channel TEXT NOT NULL DEFAULT 'customer_app',total_amount REAL NOT NULL DEFAULT 0,currency TEXT NOT NULL DEFAULT 'INR',created_at INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL DEFAULT 0)";
const CANONICAL_CUSTOMERS = "CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'customer_app',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)";
const SUBSCRIPTIONS = "CREATE TABLE IF NOT EXISTS customer_grooming_subscriptions (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,plan_code TEXT NOT NULL,service_package_code TEXT NOT NULL,total_sessions INTEGER NOT NULL,sessions_reserved INTEGER NOT NULL DEFAULT 0,sessions_consumed INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'active',started_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,source_booking_id TEXT NOT NULL UNIQUE,catalogue_version TEXT NOT NULL DEFAULT 'v1',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)";

let seq = 0;
async function world({ withCustomers = true, withBookings = true, withSubscriptions = true } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__REMINDER_DB__ = db;
  if (withBookings) sqlite.exec(CANONICAL_BOOKINGS);
  if (withCustomers) sqlite.exec(CANONICAL_CUSTOMERS);
  if (withSubscriptions) sqlite.exec(SUBSCRIPTIONS);
  const reminders = await import("../lib/customer-reminder-governance.ts");
  const comms = await import("../lib/communication-engine.ts");
  await reminders.ensureReminderGovernanceTables(db);
  await comms.ensureCommunicationTables(db);
  return { sqlite, db, reminders, comms };
}

function seedCustomer(sqlite, id, consent = {}) {
  sqlite.prepare("INSERT OR REPLACE INTO canonical_customers (id,city_id,name,primary_phone,consent_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(id, "blr", `Customer ${id}`, "9999900000", JSON.stringify(consent), NOW, NOW);
}
function seedBooking(sqlite, { id, customerId, status, startMs, endMs, service = "grooming", city = "blr" }) {
  seq += 1;
  sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,total_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, `idem-${id}-${seq}`, customerId, city, `${city}-east`, service, `${service}-basic`, `${service} basic`, `grp-${id}-${seq}`, "PROV-1", iso(startMs), iso(endMs), status, 1499, NOW, NOW);
}
function setPreference(sqlite, customerId, { serviceUpdates = null, marketing = null, channel = "whatsapp" } = {}) {
  sqlite.prepare("INSERT OR REPLACE INTO communication_preferences (customer_id,service_updates,marketing,preferred_channel,timezone,source,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(customerId, serviceUpdates === null ? null : serviceUpdates ? 1 : 0, marketing === null ? null : marketing ? 1 : 0, channel, "Asia/Kolkata", "customer_choice", NOW);
}
const messages = (sqlite) => sqlite.prepare("SELECT id,status,template_key,idempotency_key,channel FROM communication_messages ORDER BY created_at,id").all();
const outbox = (sqlite) => sqlite.prepare("SELECT message_id,status,next_attempt_at,attempt_count FROM communication_outbox").all();
const events = (sqlite) => sqlite.prepare("SELECT reminder_type,cycle_key,created_at FROM reminder_governance_events").all();

// --- due-ness and cadence -------------------------------------------------

test("a completed grooming booking past the cadence queues exactly one lifecycle reminder", async () => {
  const { sqlite, db, reminders } = await world();
  seedCustomer(sqlite, "CU-1");
  seedBooking(sqlite, { id: "BK-1", customerId: "CU-1", status: "completed", startMs: NOW - 20 * DAY, endMs: NOW - 20 * DAY + 3600000 });
  const result = await reminders.generateGroomingRebookingReminders(db, { actorId: "system", asOf: NOW });
  assert.equal(result.queued, 1);
  assert.equal(result.cadenceDays, 15, "cadence is a governed policy value, not a constant");
  const [message] = messages(sqlite);
  assert.equal(message.template_key, "grooming_rebooking_reminder");
  assert.equal(message.status, "queued");
  assert.equal(message.idempotency_key, "grooming_rebooking:CU-1:1", "keyed to the cadence cycle, not just the customer");
});

test("a booking inside the cadence window is not due yet", async () => {
  const { sqlite, db, reminders } = await world();
  seedCustomer(sqlite, "CU-2");
  seedBooking(sqlite, { id: "BK-2", customerId: "CU-2", status: "completed", startMs: NOW - 9 * DAY, endMs: NOW - 9 * DAY + 3600000 });
  const result = await reminders.generateGroomingRebookingReminders(db, { actorId: "system", asOf: NOW });
  assert.equal(result.queued, 0);
  assert.equal(messages(sqlite).length, 0);
});

test("a governed cadence change moves the due date, it is not hardcoded", async () => {
  const { sqlite, db, reminders } = await world();
  seedCustomer(sqlite, "CU-3");
  seedBooking(sqlite, { id: "BK-3", customerId: "CU-3", status: "completed", startMs: NOW - 9 * DAY, endMs: NOW - 9 * DAY + 3600000 });
  assert.equal((await reminders.generateGroomingRebookingReminders(db, { actorId: "system", asOf: NOW })).queued, 0);
  await reminders.saveReminderCadencePolicy(db, { groomingRebookingDays: 7, subscriptionInactivityDays: 10, subscriptionRenewalDays: 7, reason: "Shorter grooming cadence for the executable closure", actorId: "founder@pawspace.in" });
  const after = await reminders.generateGroomingRebookingReminders(db, { actorId: "system", asOf: NOW });
  assert.equal(after.queued, 1, "the same booking becomes due once the governed cadence shortens");
  assert.equal(after.cadenceDays, 7);
});

test("cadence policy refuses nonsense values and unexplained changes", async () => {
  const { db, reminders } = await world();
  await assert.rejects(() => reminders.saveReminderCadencePolicy(db, { groomingRebookingDays: 0, subscriptionInactivityDays: 10, subscriptionRenewalDays: 7, reason: "a clear enough reason", actorId: "x" }), /positive whole number/);
  await assert.rejects(() => reminders.saveReminderCadencePolicy(db, { groomingRebookingDays: 15, subscriptionInactivityDays: 10, subscriptionRenewalDays: 7, reason: "short", actorId: "x" }), /reason is required/);
});

// --- duplication and repeated sweeps -------------------------------------

test("repeating the sweep on the same clock never queues a second reminder", async () => {
  const { sqlite, db, reminders } = await world();
  seedCustomer(sqlite, "CU-4");
  seedBooking(sqlite, { id: "BK-4", customerId: "CU-4", status: "completed", startMs: NOW - 20 * DAY, endMs: NOW - 20 * DAY + 3600000 });
  const first = await reminders.generateGroomingRebookingReminders(db, { actorId: "system", asOf: NOW });
  const second = await reminders.generateGroomingRebookingReminders(db, { actorId: "system", asOf: NOW });
  const third = await reminders.generateGroomingRebookingReminders(db, { actorId: "system", asOf: NOW });
  assert.equal(first.queued, 1);
  assert.equal(second.queued, 0);
  assert.equal(third.queued, 0);
  assert.equal(messages(sqlite).length, 1, "one reminder survives three sweeps");
  assert.equal(events(sqlite).length, 1, "and exactly one governance event was recorded");
});

test("a customer who still has not rebooked is reminded again at the next cadence cycle", async () => {
  const { sqlite, db, reminders } = await world();
  seedCustomer(sqlite, "CU-5");
  // scheduled_end lands exactly on the day boundary so each sweep is a whole number of days later.
  seedBooking(sqlite, { id: "BK-5", customerId: "CU-5", status: "completed", startMs: NOW - 45 * DAY, endMs: NOW - 45 * DAY });
  await reminders.generateGroomingRebookingReminders(db, { actorId: "system", asOf: NOW - 30 * DAY }); // day 15 → cycle 1
  await reminders.generateGroomingRebookingReminders(db, { actorId: "system", asOf: NOW - 15 * DAY }); // day 30 → cycle 2
  await reminders.generateGroomingRebookingReminders(db, { actorId: "system", asOf: NOW });            // day 45 → cycle 3
  // Sorted, not insertion-ordered: communication_messages.created_at is a wall-clock millisecond, so
  // three rapid enqueues can share one and the ORDER BY falls through to a random UUID. The claim
  // here is that all three cadence cycles produced a reminder, not the order the rows landed in.
  assert.deepEqual(messages(sqlite).map((m) => m.idempotency_key).sort(), [
    "grooming_rebooking:CU-5:1", "grooming_rebooking:CU-5:2", "grooming_rebooking:CU-5:3",
  ], "day 15/30/45 are distinct cycles — dedup must not silence the whole lifecycle");
});

test("concurrent sweeps of the same cycle still produce one reminder", async () => {
  const { sqlite, db, reminders } = await world();
  seedCustomer(sqlite, "CU-6");
  seedBooking(sqlite, { id: "BK-6", customerId: "CU-6", status: "completed", startMs: NOW - 20 * DAY, endMs: NOW - 20 * DAY + 3600000 });
  // R3: the prior-message read and the insert are not one transaction, so a concurrent sweep used
  // to lose the unique-index race with a raw SQL error instead of the documented duplicate result.
  const [a, b] = await Promise.all([
    reminders.generateGroomingRebookingReminders(db, { actorId: "system", asOf: NOW }),
    reminders.generateGroomingRebookingReminders(db, { actorId: "system", asOf: NOW }),
  ]);
  assert.equal(messages(sqlite).length, 1, "one reminder survives the race");
  assert.equal([a, b].filter((r) => r.queued === 1).length, 1, "exactly one sweep takes credit for queueing it");
  assert.equal(outbox(sqlite).length, 1, "and it is queued for delivery exactly once");
});

// --- future / cancelled booking interaction ------------------------------

test("a real upcoming booking suppresses the rebooking nudge", async () => {
  const { sqlite, db, reminders } = await world();
  seedCustomer(sqlite, "CU-7");
  seedBooking(sqlite, { id: "BK-7a", customerId: "CU-7", status: "completed", startMs: NOW - 20 * DAY, endMs: NOW - 20 * DAY + 3600000 });
  seedBooking(sqlite, { id: "BK-7b", customerId: "CU-7", status: "confirmed", startMs: NOW + 3 * DAY, endMs: NOW + 3 * DAY + 3600000 });
  const result = await reminders.generateGroomingRebookingReminders(db, { actorId: "system", asOf: NOW });
  assert.equal(result.skippedFutureBooking, 1);
  assert.equal(messages(sqlite).length, 0, "do not nag a customer who is already booked in");
});

test("a CANCELLED upcoming booking does not count as being booked in", async () => {
  const { sqlite, db, reminders } = await world();
  seedCustomer(sqlite, "CU-8");
  seedBooking(sqlite, { id: "BK-8a", customerId: "CU-8", status: "completed", startMs: NOW - 20 * DAY, endMs: NOW - 20 * DAY + 3600000 });
  seedBooking(sqlite, { id: "BK-8b", customerId: "CU-8", status: "cancelled", startMs: NOW + 3 * DAY, endMs: NOW + 3 * DAY + 3600000 });
  const result = await reminders.generateGroomingRebookingReminders(db, { actorId: "system", asOf: NOW });
  assert.equal(result.skippedFutureBooking, 0);
  assert.equal(result.queued, 1, "a cancelled booking must not silence the reminder");
});

test("a cancelled past booking is not a completed service and drives no cadence", async () => {
  const { sqlite, db, reminders } = await world();
  seedCustomer(sqlite, "CU-9");
  seedBooking(sqlite, { id: "BK-9", customerId: "CU-9", status: "cancelled", startMs: NOW - 40 * DAY, endMs: NOW - 40 * DAY + 3600000 });
  assert.equal((await reminders.generateGroomingRebookingReminders(db, { actorId: "system", asOf: NOW })).queued, 0);
});

// --- consent / suppression ----------------------------------------------

test("an opted-out customer is suppressed and never enters the delivery outbox", async () => {
  const { sqlite, db, reminders } = await world();
  seedCustomer(sqlite, "CU-10");
  setPreference(sqlite, "CU-10", { serviceUpdates: false });
  seedBooking(sqlite, { id: "BK-10", customerId: "CU-10", status: "completed", startMs: NOW - 20 * DAY, endMs: NOW - 20 * DAY + 3600000 });
  const result = await reminders.generateGroomingRebookingReminders(db, { actorId: "system", asOf: NOW });
  assert.equal(result.suppressed, 1);
  assert.equal(result.queued, 0);
  assert.equal(messages(sqlite)[0].status, "suppressed");
  assert.equal(outbox(sqlite).length, 0, "a suppressed reminder is never queued for delivery");
});

test("suppression is sticky for the cycle — a later sweep does not retry an opted-out customer", async () => {
  const { sqlite, db, reminders } = await world();
  seedCustomer(sqlite, "CU-11");
  setPreference(sqlite, "CU-11", { serviceUpdates: false });
  seedBooking(sqlite, { id: "BK-11", customerId: "CU-11", status: "completed", startMs: NOW - 20 * DAY, endMs: NOW - 20 * DAY + 3600000 });
  await reminders.generateGroomingRebookingReminders(db, { actorId: "system", asOf: NOW });
  await reminders.generateGroomingRebookingReminders(db, { actorId: "system", asOf: NOW });
  assert.equal(messages(sqlite).length, 1);
  assert.equal(outbox(sqlite).length, 0);
});

test("consent falls back to the canonical customer record when no explicit preference exists", async () => {
  const { sqlite, db, reminders } = await world();
  seedCustomer(sqlite, "CU-12", { serviceUpdates: false });
  seedBooking(sqlite, { id: "BK-12", customerId: "CU-12", status: "completed", startMs: NOW - 20 * DAY, endMs: NOW - 20 * DAY + 3600000 });
  const result = await reminders.generateGroomingRebookingReminders(db, { actorId: "system", asOf: NOW });
  assert.equal(result.suppressed, 1, "an opt-out recorded on the customer record is honoured too");
});

test("the customer's chosen channel is used rather than a default", async () => {
  const { sqlite, db, reminders } = await world();
  seedCustomer(sqlite, "CU-13");
  setPreference(sqlite, "CU-13", { serviceUpdates: true, channel: "sms" });
  seedBooking(sqlite, { id: "BK-13", customerId: "CU-13", status: "completed", startMs: NOW - 20 * DAY, endMs: NOW - 20 * DAY + 3600000 });
  await reminders.generateGroomingRebookingReminders(db, { actorId: "system", asOf: NOW });
  assert.equal(messages(sqlite)[0].channel, "sms");
});

// --- R1: cold / partially-migrated database -----------------------------

test("R1 regression: a reminder sweep survives a database with no canonical_customers table", async () => {
  const { sqlite, db, reminders } = await world({ withCustomers: false });
  seedBooking(sqlite, { id: "BK-14", customerId: "CU-14", status: "completed", startMs: NOW - 20 * DAY, endMs: NOW - 20 * DAY + 3600000 });
  const result = await reminders.generateGroomingRebookingReminders(db, { actorId: "system", asOf: NOW });
  assert.equal(result.queued, 1, "a missing consent-fallback table must not fail the sweep");
});

test("R1 regression: unknown consent still blocks marketing — the guard did not loosen consent", async () => {
  const { db, comms } = await world({ withCustomers: false });
  const lifecycle = await comms.enqueueCommunication(db, { customerId: "CU-15", cityId: "blr", channel: "whatsapp", purpose: "lifecycle", idempotencyKey: "cold-lifecycle", templateKey: "grooming_rebooking_reminder", payload: {}, createdBy: "system" });
  assert.equal(lifecycle.status, "queued", "a service-lifecycle message proceeds on unknown consent");
  const marketing = await comms.enqueueCommunication(db, { customerId: "CU-15", cityId: "blr", channel: "whatsapp", purpose: "marketing", idempotencyKey: "cold-marketing", templateKey: "promo", payload: {}, createdBy: "system" });
  assert.equal(marketing.status, "suppressed", "marketing still requires explicit consent");
  assert.ok(marketing.policy.reasons.includes("marketing_consent_unknown"));
});

test("a sweep with no canonical_bookings table reports skipped rather than throwing", async () => {
  const { db, reminders } = await world({ withBookings: false });
  const result = await reminders.generateGroomingRebookingReminders(db, { actorId: "system", asOf: NOW });
  assert.equal(result.skipped, true);
  assert.equal(result.queued, 0);
});

// --- R2: the sweep must actually deliver what it queues ------------------

test("R2 regression: the sweep delivers the reminder it queued, on its own clock", async () => {
  const { sqlite, db, reminders } = await world();
  seedCustomer(sqlite, "CU-16");
  seedBooking(sqlite, { id: "BK-16", customerId: "CU-16", status: "completed", startMs: NOW - 20 * DAY, endMs: NOW - 20 * DAY + 3600000 });
  const sweep = await reminders.runCustomerReminderSweep(db, { actorId: "system", asOf: NOW });
  assert.equal(sweep.grooming.queued, 1);
  assert.equal(sweep.delivery.scanned, 1, "the queued reminder must be visible to the sweep's own delivery pass");
  assert.equal(sweep.delivery.sandboxDelivered, 1);
  assert.equal(outbox(sqlite)[0].status, "sandbox_delivered");
});

test("R2 regression: queue timestamps are stamped from the sweep clock, not the wall clock", async () => {
  const { sqlite, db, reminders } = await world();
  seedCustomer(sqlite, "CU-17");
  seedBooking(sqlite, { id: "BK-17", customerId: "CU-17", status: "completed", startMs: NOW - 20 * DAY, endMs: NOW - 20 * DAY + 3600000 });
  await reminders.generateGroomingRebookingReminders(db, { actorId: "system", asOf: NOW });
  assert.equal(outbox(sqlite)[0].next_attempt_at, NOW, "a replayed or backfilled sweep must be deterministic");
  assert.equal(events(sqlite)[0].created_at, NOW, "the audit row is on the same clock");
});

test("delivery is idempotent — a second delivery pass reports duplicates, not double sends", async () => {
  const { sqlite, db, reminders } = await world();
  seedCustomer(sqlite, "CU-18");
  seedBooking(sqlite, { id: "BK-18", customerId: "CU-18", status: "completed", startMs: NOW - 20 * DAY, endMs: NOW - 20 * DAY + 3600000 });
  await reminders.generateGroomingRebookingReminders(db, { actorId: "system", asOf: NOW });
  const first = await reminders.consumeCustomerReminderSandboxOutbox(db, { asOf: NOW });
  const second = await reminders.consumeCustomerReminderSandboxOutbox(db, { asOf: NOW });
  assert.equal(first.sandboxDelivered, 1);
  assert.equal(second.sandboxDelivered, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM reminder_sandbox_deliveries").get().c, 1);
});

test("the delivery boundary never claims an external send", async () => {
  const { sqlite, db, reminders } = await world();
  seedCustomer(sqlite, "CU-19");
  seedBooking(sqlite, { id: "BK-19", customerId: "CU-19", status: "completed", startMs: NOW - 20 * DAY, endMs: NOW - 20 * DAY + 3600000 });
  const sweep = await reminders.runCustomerReminderSweep(db, { actorId: "system", asOf: NOW });
  assert.equal(sweep.delivery.externalDelivery, false);
  assert.equal(sweep.delivery.connectorsEnabled, false);
  assert.equal(sweep.delivery.adapter, "governed_uat_sink");
  const row = sqlite.prepare("SELECT external_delivery,adapter FROM reminder_sandbox_deliveries").get();
  assert.equal(row.external_delivery, 0);
  assert.equal(row.adapter, "governed_uat_sink");
});

// --- failed reminder, retry and dead-letter -----------------------------

test("a failed reminder retries with backoff and does not duplicate the message", async () => {
  const { sqlite, db, reminders, comms } = await world();
  seedCustomer(sqlite, "CU-20");
  seedBooking(sqlite, { id: "BK-20", customerId: "CU-20", status: "completed", startMs: NOW - 20 * DAY, endMs: NOW - 20 * DAY + 3600000 });
  await reminders.generateGroomingRebookingReminders(db, { actorId: "system", asOf: NOW });
  const messageId = messages(sqlite)[0].id;
  const failure = await comms.failOutboxAttempt(db, messageId, "provider_timeout");
  assert.equal(failure.status, "retry_pending");
  assert.equal(failure.attempts, 1);
  assert.ok(failure.nextAttemptAt > NOW, "a retry is scheduled into the future");
  assert.equal(messages(sqlite).length, 1, "retrying must not create a second reminder");
});

test("a reminder that keeps failing lands in the dead-letter queue instead of retrying forever", async () => {
  const { sqlite, db, reminders, comms } = await world();
  seedCustomer(sqlite, "CU-21");
  seedBooking(sqlite, { id: "BK-21", customerId: "CU-21", status: "completed", startMs: NOW - 20 * DAY, endMs: NOW - 20 * DAY + 3600000 });
  await reminders.generateGroomingRebookingReminders(db, { actorId: "system", asOf: NOW });
  const messageId = messages(sqlite)[0].id;
  const max = Number(outbox(sqlite)[0].attempt_count) + Number(sqlite.prepare("SELECT max_attempts FROM communication_outbox WHERE message_id=?").get(messageId).max_attempts);
  let last;
  for (let attempt = 0; attempt < max + 1; attempt += 1) {
    last = await comms.failOutboxAttempt(db, messageId, "provider_down");
    if (last.status === "dead_letter") break;
  }
  assert.equal(last.status, "dead_letter");
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM communication_dead_letters").get().c, 1);
  assert.equal(messages(sqlite).length, 1);
});

test("a dead-lettered reminder is not picked up again by the delivery pass", async () => {
  const { sqlite, db, reminders, comms } = await world();
  seedCustomer(sqlite, "CU-22");
  seedBooking(sqlite, { id: "BK-22", customerId: "CU-22", status: "completed", startMs: NOW - 20 * DAY, endMs: NOW - 20 * DAY + 3600000 });
  await reminders.generateGroomingRebookingReminders(db, { actorId: "system", asOf: NOW });
  const messageId = messages(sqlite)[0].id;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const result = await comms.failOutboxAttempt(db, messageId, "provider_down");
    if (result.status === "dead_letter") break;
  }
  const delivery = await reminders.consumeCustomerReminderSandboxOutbox(db, { asOf: NOW });
  assert.equal(delivery.scanned, 0, "dead letters are not deliverable");
});

// --- subscription / session reminders -----------------------------------

function seedSubscription(sqlite, { id, customerId, total, consumed, reserved = 0, startedMs, expiresMs, status = "active" }) {
  sqlite.prepare("INSERT INTO customer_grooming_subscriptions (id,customer_id,plan_code,service_package_code,total_sessions,sessions_reserved,sessions_consumed,status,started_at,expires_at,source_booking_id,catalogue_version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, customerId, "grooming-6", "grooming-full", total, reserved, consumed, status, startedMs, expiresMs, `SRC-${id}`, "v1", NOW, NOW);
}

test("an under-used subscription with stale activity produces a session reminder", async () => {
  const { sqlite, db, reminders } = await world();
  seedCustomer(sqlite, "CU-23");
  // Inactivity is measured from real grooming activity, so the subscription needs a stale booking.
  seedBooking(sqlite, { id: "BK-23", customerId: "CU-23", status: "completed", startMs: NOW - 40 * DAY, endMs: NOW - 40 * DAY });
  seedSubscription(sqlite, { id: "SUB-1", customerId: "CU-23", total: 6, consumed: 1, startedMs: NOW - 60 * DAY, expiresMs: NOW + 120 * DAY });
  const result = await reminders.generateSubscriptionReminders(db, { actorId: "system", asOf: NOW });
  assert.equal(result.subscriptionsScanned, 1);
  assert.equal(result.sessionReminders, 1, `expected a session reminder, got ${JSON.stringify(result)}`);
  assert.ok(messages(sqlite).some((m) => m.idempotency_key.startsWith("subscription_sessions:SUB-1:")));
});

test("subscription reminders do not duplicate across repeated sweeps", async () => {
  const { sqlite, db, reminders } = await world();
  seedCustomer(sqlite, "CU-24");
  seedBooking(sqlite, { id: "BK-24", customerId: "CU-24", status: "completed", startMs: NOW - 40 * DAY, endMs: NOW - 40 * DAY });
  seedSubscription(sqlite, { id: "SUB-2", customerId: "CU-24", total: 6, consumed: 1, startedMs: NOW - 60 * DAY, expiresMs: NOW + 120 * DAY });
  await reminders.generateSubscriptionReminders(db, { actorId: "system", asOf: NOW });
  const afterFirst = messages(sqlite).length;
  await reminders.generateSubscriptionReminders(db, { actorId: "system", asOf: NOW });
  assert.equal(messages(sqlite).length, afterFirst, "a repeated sweep queues nothing new");
});

test("an expiring subscription produces a renewal reminder exactly once", async () => {
  const { sqlite, db, reminders } = await world();
  seedCustomer(sqlite, "CU-25");
  seedSubscription(sqlite, { id: "SUB-3", customerId: "CU-25", total: 6, consumed: 6, startedMs: NOW - 100 * DAY, expiresMs: NOW + 3 * DAY });
  await reminders.generateSubscriptionReminders(db, { actorId: "system", asOf: NOW });
  const renewal = messages(sqlite).filter((m) => m.idempotency_key.startsWith("subscription_renewal:"));
  assert.equal(renewal.length, 1, `expected one renewal reminder, saw ${JSON.stringify(messages(sqlite).map((m) => m.idempotency_key))}`);
  await reminders.generateSubscriptionReminders(db, { actorId: "system", asOf: NOW });
  assert.equal(messages(sqlite).filter((m) => m.idempotency_key.startsWith("subscription_renewal:")).length, 1);
});

test("an opted-out customer is not chased about their subscription either", async () => {
  const { sqlite, db, reminders } = await world();
  seedCustomer(sqlite, "CU-26");
  setPreference(sqlite, "CU-26", { serviceUpdates: false });
  seedSubscription(sqlite, { id: "SUB-4", customerId: "CU-26", total: 6, consumed: 1, startedMs: NOW - 60 * DAY, expiresMs: NOW + 3 * DAY });
  await reminders.generateSubscriptionReminders(db, { actorId: "system", asOf: NOW });
  assert.equal(outbox(sqlite).length, 0, "every subscription reminder for this customer was suppressed");
  assert.ok(messages(sqlite).every((m) => m.status === "suppressed"));
});

// --- whole-sweep behaviour ----------------------------------------------

test("the full sweep is replay-safe: three identical runs leave one of each reminder", async () => {
  const { sqlite, db, reminders } = await world();
  seedCustomer(sqlite, "CU-27");
  seedBooking(sqlite, { id: "BK-27", customerId: "CU-27", status: "completed", startMs: NOW - 20 * DAY, endMs: NOW - 20 * DAY + 3600000 });
  seedSubscription(sqlite, { id: "SUB-5", customerId: "CU-27", total: 6, consumed: 1, startedMs: NOW - 60 * DAY, expiresMs: NOW + 3 * DAY });
  await reminders.runCustomerReminderSweep(db, { actorId: "system", asOf: NOW });
  const after = messages(sqlite).map((m) => m.idempotency_key).sort();
  await reminders.runCustomerReminderSweep(db, { actorId: "system", asOf: NOW });
  await reminders.runCustomerReminderSweep(db, { actorId: "system", asOf: NOW });
  assert.deepEqual(messages(sqlite).map((m) => m.idempotency_key).sort(), after, "replaying the sweep is a no-op");
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM reminder_sandbox_deliveries").get().c, after.length, "and each reminder was delivered exactly once");
});

test("two cities are reminded independently on the same sweep", async () => {
  const { sqlite, db, reminders } = await world();
  seedCustomer(sqlite, "CU-BLR");
  seedCustomer(sqlite, "CU-HYD");
  seedBooking(sqlite, { id: "BK-BLR", customerId: "CU-BLR", status: "completed", startMs: NOW - 20 * DAY, endMs: NOW - 20 * DAY + 3600000, city: "blr" });
  seedBooking(sqlite, { id: "BK-HYD", customerId: "CU-HYD", status: "completed", startMs: NOW - 20 * DAY, endMs: NOW - 20 * DAY + 3600000, city: "hyd" });
  const result = await reminders.generateGroomingRebookingReminders(db, { actorId: "system", asOf: NOW });
  assert.equal(result.queued, 2);
  assert.deepEqual(messages(sqlite).map((m) => m.idempotency_key).sort(), ["grooming_rebooking:CU-BLR:1", "grooming_rebooking:CU-HYD:1"]);
});
