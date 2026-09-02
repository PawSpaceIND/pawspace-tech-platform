import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

// ---------------------------------------------------------------------------
// The bridge between the per-vertical notification queues and the governed
// communication outbox.
//
// What this file has to pin is narrow and specific. Before the bridge existed,
// a walk could complete, a notification row could be written, and NO code path
// in the repository would ever send it: nothing moved a vertical queue row past
// 'queued', and nothing selected communication_outbox.next_attempt_at <= now.
//
// The trap the bridge has to avoid is the opposite failure. template_code on
// these queues is coarse - lib/walking-lifecycle.ts binds the literal
// "walking_update" for walker acceptance, walk START and walk completion alike.
// A bridge that read template_code would message the customer three times and
// call two of them "your walk is complete".
//
// So the contract is: the JOIN to the event row's event_type is what decides,
// intermediate events are ignored, and re-running the sweep does not produce a
// second message.
// ---------------------------------------------------------------------------

installWorkersHooks("__BRIDGE_DB__");

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

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'customer_app',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,city_id TEXT NOT NULL,service_code TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'confirmed')",
  "CREATE TABLE IF NOT EXISTS walking_session_events (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,session_id TEXT,provider_id TEXT NOT NULL,event_type TEXT NOT NULL,actor_id TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS walking_customer_notifications (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,customer_id TEXT,channel TEXT NOT NULL,template_code TEXT NOT NULL,message TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',event_id TEXT NOT NULL,created_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS taxi_trip_events (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,trip_id TEXT,provider_id TEXT NOT NULL,event_type TEXT NOT NULL,actor_id TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS taxi_customer_notifications (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,customer_id TEXT,channel TEXT NOT NULL,template_code TEXT NOT NULL,message TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',event_id TEXT NOT NULL,created_at INTEGER NOT NULL)",
];

async function world() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__BRIDGE_DB__ = db;
  for (const sql of SCHEMA) sqlite.exec(sql);
  sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,email,consent_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run("CUST-1", "blr", "Asha", "+919000000001", "asha@example.com", JSON.stringify({ serviceUpdates: true }), NOW, NOW);
  const bridge = await import("../lib/communication-dispatch-bridge.ts");
  const comms = await import("../lib/communication-engine.ts");
  await comms.ensureCommunicationTables(db);
  return { sqlite, db, bridge, comms };
}

function seedBooking(sqlite, id = "BK-1", service = "dog_walking") {
  sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,city_id,service_code,status) VALUES (?,?,?,?,?,'confirmed')")
    .run(id, `idem-${id}`, "CUST-1", "blr", service);
}

/* Mirrors lib/walking-lifecycle.ts exactly: one event row, then TWO notification rows (push and
 * whatsapp) both carrying the same coarse template_code "walking_update". */
function seedWalkingEvent(sqlite, { eventId, eventType, bookingId = "BK-1", at = NOW }) {
  sqlite.prepare("INSERT INTO walking_session_events (id,booking_id,session_id,provider_id,event_type,actor_id,detail_json,created_at) VALUES (?,?,NULL,'PRV-1',?,'actor','{}',?)")
    .run(eventId, bookingId, eventType, at);
  for (const channel of ["push", "whatsapp"]) {
    sqlite.prepare("INSERT INTO walking_customer_notifications (id,booking_id,customer_id,channel,template_code,message,status,event_id,created_at) VALUES (?,?,?,?,'walking_update',?,'queued',?,?)")
      .run(`${eventId}-${channel}`, bookingId, "CUST-1", channel, `notice for ${eventType}`, eventId, at);
  }
}

/* Ordered by idempotency_key, NOT by created_at,id. Two messages bridged in the same sweep share a
 * created_at millisecond, and communication_messages.id is a random MSG-<uuid> - so ordering on either
 * makes the readback non-deterministic. The idempotency key carries the source row id, which is stable. */
const messages = (sqlite) => sqlite.prepare("SELECT template_key,booking_id,customer_id,idempotency_key,payload_json FROM communication_messages ORDER BY idempotency_key").all();

/* Pins the MAPPING, not just the multiset: which source row produced which template. */
const mapping = (sqlite) => messages(sqlite).map((row) => [row.idempotency_key.split(":").pop(), row.template_key]);

// --- BRIDGE-01 ------------------------------------------------------------
// The whole reason the join exists. Three walking events share one template_code;
// only two of them are pilot events, and they are DIFFERENT pilot events.
test("BRIDGE-01: the event_type decides the template, not the coarse template_code", async () => {
  const { sqlite, db, bridge } = await world();
  seedBooking(sqlite);
  seedWalkingEvent(sqlite, { eventId: "EV-accept", eventType: "walker_accepted", at: NOW });
  seedWalkingEvent(sqlite, { eventId: "EV-start", eventType: "walk_started", at: NOW + 1000 });
  seedWalkingEvent(sqlite, { eventId: "EV-done", eventType: "walk_completed", at: NOW + 2000 });

  const result = await bridge.runCommunicationDispatchBridge(db, {}, { asOf: NOW + 5000 });

  assert.deepEqual(mapping(sqlite), [
    ["EV-accept-whatsapp", "pilot_provider_assigned"],
    ["EV-done-whatsapp", "pilot_service_complete"],
  ]);
  assert.equal(result.bridged, 2);

  // walk_started is an intermediate event with no approved template. It stays queued rather than being
  // mapped to the nearest thing - a "your walk is complete" message sent at walk start is exactly the
  // customer-facing lie this test exists to prevent.
  const started = sqlite.prepare("SELECT status FROM walking_customer_notifications WHERE event_id='EV-start'").all();
  assert.deepEqual(started.map((row) => row.status), ["queued", "queued"]);
});

// --- BRIDGE-02 ------------------------------------------------------------
test("BRIDGE-02: only the whatsapp row is bridged; push is left exactly as it was", async () => {
  const { sqlite, db, bridge } = await world();
  seedBooking(sqlite);
  seedWalkingEvent(sqlite, { eventId: "EV-done", eventType: "walk_completed" });

  await bridge.runCommunicationDispatchBridge(db, {}, { asOf: NOW + 5000 });

  const byChannel = Object.fromEntries(
    sqlite.prepare("SELECT channel,status FROM walking_customer_notifications WHERE event_id='EV-done'").all().map((row) => [row.channel, row.status])
  );
  assert.deepEqual(byChannel, { whatsapp: "bridged", push: "queued" });
  assert.equal(messages(sqlite).length, 1);
});

// --- BRIDGE-03 ------------------------------------------------------------
// A cron that fires every five minutes will re-read anything it did not fully finish.
test("BRIDGE-03: re-running the sweep does not send the customer a second message", async () => {
  const { sqlite, db, bridge } = await world();
  seedBooking(sqlite);
  seedWalkingEvent(sqlite, { eventId: "EV-done", eventType: "walk_completed" });

  await bridge.runCommunicationDispatchBridge(db, {}, { asOf: NOW + 5000 });
  const first = messages(sqlite);
  assert.equal(first.length, 1);

  // The status update is what normally stops a re-read. Undo it, so the second run genuinely re-reads
  // the row - the case where the enqueue committed but the UPDATE was lost.
  sqlite.prepare("UPDATE walking_customer_notifications SET status='queued' WHERE event_id='EV-done'").run();
  const second = await bridge.runCommunicationDispatchBridge(db, {}, { asOf: NOW + 6000 });

  assert.equal(messages(sqlite).length, 1, "the idempotency key must collapse the re-read into the same message");
  assert.equal(second.bridged, 0, "a duplicate-prevented enqueue is not a new bridged message");
});

// --- BRIDGE-04 ------------------------------------------------------------
// The four joined verticals each name their own accept/complete events.
test("BRIDGE-04: taxi maps its own event vocabulary to the same two templates", async () => {
  const { sqlite, db, bridge } = await world();
  seedBooking(sqlite, "BK-T", "pet_taxi");
  for (const [id, type] of [["TX-assign", "vehicle_assigned"], ["TX-accept", "driver_accepted"], ["TX-start", "trip_started"], ["TX-done", "trip_completed"]]) {
    sqlite.prepare("INSERT INTO taxi_trip_events (id,booking_id,trip_id,provider_id,event_type,actor_id,detail_json,created_at) VALUES (?,?,NULL,'PRV-1',?,'actor','{}',?)").run(id, "BK-T", type, NOW);
    sqlite.prepare("INSERT INTO taxi_customer_notifications (id,booking_id,customer_id,channel,template_code,message,status,event_id,created_at) VALUES (?,?,?,'whatsapp','taxi_update',?,'queued',?,?)").run(`${id}-w`, "BK-T", "CUST-1", type, id, NOW);
  }

  await bridge.runCommunicationDispatchBridge(db, {}, { asOf: NOW + 5000 });

  assert.deepEqual(mapping(sqlite), [
    ["TX-accept-w", "pilot_provider_assigned"],
    ["TX-done-w", "pilot_service_complete"],
  ]);
  // vehicle_assigned is a real event that fires alongside driver_accepted. Bridging both would send the
  // customer two "your provider is assigned" messages for one assignment.
  const assigned = sqlite.prepare("SELECT status FROM taxi_customer_notifications WHERE event_id='TX-assign'").get();
  assert.equal(assigned.status, "queued");
});

// --- BRIDGE-05 ------------------------------------------------------------
// policy() throws when a city has no active policy. A default of "blr" would silently apply Bengaluru's
// quiet hours to somebody in another city, so an unresolvable city must be a recorded skip.
test("BRIDGE-05: a booking whose city cannot be resolved is skipped with a reason, not defaulted", async () => {
  const { sqlite, db, bridge } = await world();
  // No canonical_bookings row at all for BK-orphan.
  seedWalkingEvent(sqlite, { eventId: "EV-orphan", eventType: "walk_completed", bookingId: "BK-orphan" });

  const result = await bridge.runCommunicationDispatchBridge(db, {}, { asOf: NOW + 5000 });

  assert.equal(messages(sqlite).length, 0);
  assert.deepEqual(result.skipped.map((row) => row.reason), ["unresolved_city"]);
  const still = sqlite.prepare("SELECT status FROM walking_customer_notifications WHERE id='EV-orphan-whatsapp'").get();
  assert.equal(still.status, "queued", "an un-sendable row stays queued so it can be fixed and retried");
});

// --- BRIDGE-06 ------------------------------------------------------------
// Stage 2. Nothing in the repository selected next_attempt_at <= now for communications before this.
test("BRIDGE-06: the drain considers only outbox rows that are actually due", async () => {
  const { sqlite, db, bridge, comms } = await world();
  seedBooking(sqlite);
  // enqueueCommunication stamps next_attempt_at from the real clock, not from the fixture's NOW, so the
  // drain has to be asked about the real present or nothing is ever due.
  const realNow = Date.now();
  const due = await comms.enqueueCommunication(db, {
    customerId: "CUST-1", cityId: "blr", channel: "whatsapp", purpose: "transactional",
    idempotencyKey: "due-1", templateKey: "pilot_service_complete", payload: {}, createdBy: "test", bookingId: "BK-1",
  });
  const later = await comms.enqueueCommunication(db, {
    customerId: "CUST-1", cityId: "blr", channel: "whatsapp", purpose: "transactional",
    idempotencyKey: "later-1", templateKey: "pilot_service_complete", payload: {}, createdBy: "test", bookingId: "BK-1",
    scheduledAt: realNow + 3_600_000,
  });
  assert.notEqual(due.messageId, later.messageId);

  // asOf is read AFTER the enqueues: the due message's next_attempt_at is stamped during them.
  const result = await bridge.runCommunicationDispatchBridge(db, {}, { asOf: Date.now() });

  assert.equal(result.drained.considered, 1, "the message scheduled an hour out must not be picked up");
});

// --- BRIDGE-07 ------------------------------------------------------------
// The dispatcher runs inside a five-minute cron shared with twenty-two other sweeps. It must report a
// provider it cannot reach, not throw the whole slot away.
test("BRIDGE-07: an unreachable provider is reported, and never thrown out of the cron", async () => {
  const { sqlite, db, bridge } = await world();
  seedBooking(sqlite);
  seedWalkingEvent(sqlite, { eventId: "EV-done", eventType: "walk_completed" });

  const result = await bridge.runCommunicationDispatchBridge(db, {
    // Everything the boundary needs, except a provider that answers.
    PAWSPACE_COMMUNICATION_ENV: "uat",
    PAWSPACE_COMMUNICATION_PROVIDER_URL: "https://127.0.0.1:9/never",
    PAWSPACE_COMMUNICATION_PROVIDER_TOKEN: "token",
    PAWSPACE_COMMUNICATION_UAT_ALLOWLIST: "+919000000001",
  }, { asOf: Date.now() + 1000 });

  assert.equal(result.bridged, 1);
  assert.equal(result.drained.considered, 1);
  assert.equal(result.externalDelivery, false, "nothing was accepted by a provider, so nothing may claim delivery");
});

// --- BRIDGE-08 ------------------------------------------------------------
// The three approved templates with no source event must stay unwired rather than being approximated.
test("BRIDGE-08: only mappings with a real source event are declared", async () => {
  const { bridge } = await world();
  const templates = new Set([
    ...bridge.PILOT_SOURCES.flatMap((source) => Object.values(source.eventTypes)),
    ...Object.values(bridge.TRAINING_TEMPLATE_MAP),
  ]);
  assert.deepEqual([...templates].sort(), ["pilot_provider_assigned", "pilot_service_complete"]);
  for (const unsourced of ["pilot_booking_confirmed", "pilot_provider_en_route", "pilot_payment_due"]) {
    assert.equal(templates.has(unsourced), false, `${unsourced} has no source event and must not be guessed`);
  }
});

// --- BRIDGE-09 ------------------------------------------------------------
// BRIDGE-07 exercises a provider that does not answer, and that failure is absorbed inside
// dispatchExternalCommunication by failOutboxAttempt - it never reaches the sweep. A misconfigured
// provider URL is different: providerUrl() THROWS, and that exception propagates. Without the catch in
// drainOutbox it would leave runBackgroundScheduler's Promise.allSettled as a rejection and take this
// sweep's whole result with it, five minutes at a time, for as long as the typo survives.
test("BRIDGE-09: a misconfigured provider is recorded as a failure, not raised out of the sweep", async () => {
  const { sqlite, db, bridge } = await world();
  seedBooking(sqlite);
  seedWalkingEvent(sqlite, { eventId: "EV-done", eventType: "walk_completed" });

  const result = await bridge.runCommunicationDispatchBridge(db, {
    PAWSPACE_COMMUNICATION_ENV: "uat",
    PAWSPACE_COMMUNICATION_PROVIDER_URL: "not-a-url",
    PAWSPACE_COMMUNICATION_PROVIDER_TOKEN: "token",
    PAWSPACE_COMMUNICATION_UAT_ALLOWLIST: "+919000000001",
  }, { asOf: Date.now() + 1000 });

  assert.equal(result.drained.failures.length, 1);
  assert.match(result.drained.failures[0], /Communication provider URL is invalid/);
  assert.equal(result.externalDelivery, false);
});
