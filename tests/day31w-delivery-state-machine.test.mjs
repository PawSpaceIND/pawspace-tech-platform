/*
 * Day-31 wave 3: the communication delivery state machine.
 *
 * provider webhook -> monotonic status -> retry backoff -> dead letter.
 *
 * lib/communication-delivery-state.ts had no test importing it. It is the single place that
 * decides what a message's delivery status IS, from webhooks that WhatsApp and Interakt do not
 * promise to deliver in order. Every "did the customer get it?" answer in the product resolves
 * through it, and so does the retry ladder, so two failures matter:
 *
 *   REGRESSION - a late "sent" arriving after "read" rewriting a message back to sent, which turns
 *   a delivered reminder into one Ops thinks never landed and re-sends.
 *
 *   RETRY INFLATION - a duplicate failure webhook counting twice, burning the attempt budget and
 *   dead-lettering a message that had one real failure.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world } from "./helpers/execution-harness.mjs";

installWorkersHooks("__D31W_DLV_DB__", "__D31W_DLV_ENV__");

const MESSAGE = "MSG-DLV-001";
const PROVIDER = "interakt";
const MAX_ATTEMPTS = 3;

async function seedMessage({ status = "dispatching", maxAttempts = MAX_ATTEMPTS } = {}) {
  const { sqlite, db } = world("__D31W_DLV_DB__", "__D31W_DLV_ENV__");
  const state = await import("../lib/communication-delivery-state.ts");
  const now = Date.now();
  sqlite.exec("CREATE TABLE IF NOT EXISTS communication_messages (id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,customer_id TEXT NOT NULL,booking_id TEXT,lead_id TEXT,ticket_id TEXT,direction TEXT NOT NULL,channel TEXT NOT NULL,purpose TEXT NOT NULL,template_key TEXT NOT NULL,payload_json TEXT NOT NULL,status TEXT NOT NULL,provider TEXT,provider_reference TEXT,idempotency_key TEXT NOT NULL UNIQUE,policy_json TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS communication_outbox (message_id TEXT PRIMARY KEY,status TEXT NOT NULL,next_attempt_at INTEGER NOT NULL,attempt_count INTEGER NOT NULL DEFAULT 0,max_attempts INTEGER NOT NULL,last_error TEXT,locked_at INTEGER,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS communication_message_delivery_events (id TEXT PRIMARY KEY,message_id TEXT NOT NULL,provider TEXT NOT NULL,event_id TEXT NOT NULL,event_type TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,UNIQUE(provider,event_id))");
  sqlite.exec("CREATE TABLE IF NOT EXISTS communication_dead_letters (id TEXT PRIMARY KEY,message_id TEXT NOT NULL,reason TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,resolved_at INTEGER,resolved_by TEXT)");
  sqlite.prepare("INSERT INTO communication_messages (id,thread_id,customer_id,direction,channel,purpose,template_key,payload_json,status,idempotency_key,policy_json,created_by,created_at,updated_at) VALUES (?,?,?,'outbound','whatsapp','transactional','booking_reminder','{}',?,?,?,'system',?,?)")
    .run(MESSAGE, "THR-1", "CUS-1", status, `idem-${MESSAGE}`, JSON.stringify({ retryBaseMinutes: 5 }), now, now);
  sqlite.prepare("INSERT INTO communication_outbox (message_id,status,next_attempt_at,attempt_count,max_attempts,updated_at) VALUES (?,?,?,0,?,?)")
    .run(MESSAGE, status, now, maxAttempts, now);
  return { sqlite, db, state, now };
}

let eventSeq = 0;
const event = (state, db, eventType, extra = {}) => state.recordAtomicDeliveryEvent(db, {
  messageId: MESSAGE, provider: PROVIDER, eventId: `evt-${++eventSeq}`, eventType, ...extra,
});
const messageStatus = (sqlite) => sqlite.prepare("SELECT status FROM communication_messages WHERE id=?").get(MESSAGE).status;

test("the happy path walks accepted -> sent -> delivered -> read", async () => {
  const { sqlite, db, state } = await seedMessage();
  for (const [eventType, expected] of [["accepted", "provider_accepted"], ["sent", "sent"], ["delivered", "delivered"], ["read", "read"]]) {
    const result = await event(state, db, eventType);
    assert.equal(result.applied, true, `${eventType} must advance the message`);
    assert.equal(messageStatus(sqlite), expected);
  }
});

test("a late webhook can never walk the status backwards", async () => {
  /*
   * Providers do not promise ordering. A "sent" callback overtaken by "delivered" arrives after
   * it, and if applied it turns a message the customer has already received into one Ops believes
   * never landed - so it gets sent again.
   */
  const { sqlite, db, state } = await seedMessage();
  await event(state, db, "delivered");
  assert.equal(messageStatus(sqlite), "delivered");

  for (const stale of ["accepted", "sent"]) {
    const result = await event(state, db, stale);
    assert.equal(result.applied, false, `a late "${stale}" must not be applied after delivered`);
    assert.equal(result.regressionPrevented, true);
    assert.equal(messageStatus(sqlite), "delivered", "the customer already has the message");
  }

  await event(state, db, "read");
  assert.equal(messageStatus(sqlite), "read");
  const afterRead = await event(state, db, "delivered");
  assert.equal(afterRead.applied, false, "read is further along than delivered");
  assert.equal(messageStatus(sqlite), "read");
});

test("a failure that arrives after the message was delivered is ignored", async () => {
  /*
   * The most damaging regression of all: a stale failure webhook on a delivered message would
   * both rewrite its status and burn a retry, re-sending something the customer already read.
   */
  const { sqlite, db, state } = await seedMessage();
  await event(state, db, "delivered");
  const late = await event(state, db, "failed", { detail: { reason: "stale_provider_failure" } });
  assert.equal(late.applied, false);
  assert.equal(messageStatus(sqlite), "delivered");
  assert.equal(
    sqlite.prepare("SELECT attempt_count FROM communication_outbox WHERE message_id=?").get(MESSAGE).attempt_count, 0,
    "a delivered message must not consume a retry",
  );
});

test("every webhook is recorded even when it changes nothing", async () => {
  const { sqlite, db, state } = await seedMessage();
  await event(state, db, "delivered");
  await event(state, db, "sent");
  const events = sqlite.prepare("SELECT event_type,detail_json FROM communication_message_delivery_events WHERE message_id=? ORDER BY created_at").all(MESSAGE);
  assert.equal(events.length, 2, "a refused transition is still evidence and must be kept");
  const refused = JSON.parse(events.find((e) => e.event_type === "sent").detail_json);
  assert.equal(refused.applied, false);
  assert.equal(refused.regressionPrevented, true);
  assert.equal(refused.previousStatus, "delivered", "the record must say what it was refused against");
});

test("the same provider event id delivered twice counts once", async () => {
  const { sqlite, db, state } = await seedMessage();
  const args = { messageId: MESSAGE, provider: PROVIDER, eventId: "evt-repeat", eventType: "failed", detail: { reason: "provider_timeout" } };
  const first = await state.recordAtomicDeliveryEvent(db, args);
  const second = await state.recordAtomicDeliveryEvent(db, args);
  assert.equal(first.duplicatePrevented, false);
  assert.equal(second.duplicatePrevented, true, "a retried webhook is one event");
  assert.equal(
    sqlite.prepare("SELECT attempt_count FROM communication_outbox WHERE message_id=?").get(MESSAGE).attempt_count, 1,
    "a duplicate failure must not burn a second retry",
  );
});

test("the same event id from a DIFFERENT provider is a different event", async () => {
  const { db, state } = await seedMessage();
  const first = await state.recordAtomicDeliveryEvent(db, { messageId: MESSAGE, provider: "interakt", eventId: "shared-1", eventType: "sent" });
  const second = await state.recordAtomicDeliveryEvent(db, { messageId: MESSAGE, provider: "meta", eventId: "shared-1", eventType: "delivered" });
  assert.equal(first.duplicatePrevented, false);
  assert.equal(second.duplicatePrevented, false, "providers do not share an id space");
});

test("retries back off exponentially and are capped", async () => {
  const { db, state } = await seedMessage({ maxAttempts: 10 });
  const delays = [];
  for (let i = 1; i <= 8; i++) {
    const now = Date.now();
    const result = await state.recordAtomicDeliveryEvent(db, {
      messageId: MESSAGE, provider: PROVIDER, eventId: `evt-backoff-${i}`, eventType: "failed",
      detail: { reason: "provider_5xx" }, now,
    });
    assert.equal(result.status, "retry_pending");
    delays.push(Math.round((result.nextAttemptAt - now) / 60_000));
  }
  assert.deepEqual(delays.slice(0, 6), [5, 10, 20, 40, 80, 160], "5 minutes, doubling each attempt");
  assert.ok(delays.every((d) => d <= 240), `no wait may exceed the 4-hour cap: ${delays}`);
  assert.deepEqual(delays.slice(-2), [240, 240],
    "the 7th would be 320 minutes uncapped - it must hold at 240 rather than growing without bound");
});

test("a message dead-letters at its attempt ceiling and stops retrying", async () => {
  const { sqlite, db, state } = await seedMessage({ maxAttempts: 3 });
  let last;
  for (let i = 1; i <= 3; i++) {
    last = await state.recordAtomicDeliveryEvent(db, {
      messageId: MESSAGE, provider: PROVIDER, eventId: `evt-dl-${i}`, eventType: "failed",
      detail: { reason: "invalid_number" },
    });
  }
  assert.equal(last.deadLettered, true);
  assert.equal(last.status, "dead_letter");
  assert.equal(messageStatus(sqlite), "dead_letter");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM communication_dead_letters WHERE message_id=?").get(MESSAGE).n, 1,
    "a give-up must be visible to an operator, not just a status");
  assert.equal(sqlite.prepare("SELECT next_attempt_at FROM communication_outbox WHERE message_id=?").get(MESSAGE) !== null, true);
  assert.equal(sqlite.prepare("SELECT status FROM communication_outbox WHERE message_id=?").get(MESSAGE).status, "dead_letter");
});

test("the ranking itself is monotonic - no status can be reached from a later one", async () => {
  const { state } = await seedMessage();
  const ordered = ["queued", "dispatching", "provider_accepted", "sent", "delivered", "read"];
  for (let i = 1; i < ordered.length; i++) {
    assert.ok(state.deliveryRank(ordered[i]) > state.deliveryRank(ordered[i - 1]),
      `${ordered[i]} must rank above ${ordered[i - 1]}`);
  }
  assert.equal(state.shouldApplyDeliveryTransition("read", "failed"), false);
  assert.equal(state.shouldApplyDeliveryTransition("delivered", "failed"), false);
  assert.equal(state.shouldApplyDeliveryTransition("sent", "failed"), true);
  assert.equal(state.shouldApplyDeliveryTransition("queued", "delivered"), true);
  assert.equal(state.deliveryRank("something-we-have-never-seen"), 0,
    "an unknown status must rank lowest so a real event can still move it");
});

test("an event for a message that does not exist is refused", async () => {
  const { db, state } = await seedMessage();
  await assert.rejects(
    () => state.recordAtomicDeliveryEvent(db, { messageId: "MSG-NOT-REAL", provider: PROVIDER, eventId: "evt-ghost", eventType: "delivered" }),
    /not found/,
    "a webhook must not create a message record out of nothing",
  );
});
