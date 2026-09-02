import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks();

const bridge = await import("../lib/lifecycle-communications.ts");
const engine = await import("../lib/communication-engine.ts");

// ---------------------------------------------------------------------------
// D1-over-node:sqlite shim, same shape the other lifecycle suites use.
// ---------------------------------------------------------------------------
function makeD1(sqlite) {
  function statement(sql, args) {
    return {
      bind: (...boundArgs) => statement(sql, boundArgs),
      first: async () => {
        const row = sqlite.prepare(sql).get(...args);
        return row === undefined ? null : row;
      },
      run: async () => {
        const info = sqlite.prepare(sql).run(...args);
        return { success: true, meta: { changes: Number(info.changes) } };
      },
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    };
  }
  return { prepare: (sql) => statement(sql, []), batch: async (statements) => {
    const results = [];
    for (const stmt of statements) results.push(await stmt.run());
    return results;
  } };
}

function statementsOf(source) {
  const out = [];
  const pattern = /\.prepare\(\s*(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
  let match;
  while ((match = pattern.exec(source))) out.push(match[2].replace(/\\(["'`\\])/g, "$1"));
  return out;
}

const canonicalDDL = statementsOf(fs.readFileSync("app/api/walking-bookings/route.ts", "utf8"))
  .filter((sql) => /^CREATE (TABLE|INDEX|UNIQUE INDEX)/i.test(sql.trim()));

const NOTIFICATION_DDL =
  "CREATE TABLE IF NOT EXISTS walking_customer_notifications (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,customer_id TEXT,channel TEXT NOT NULL,template_code TEXT NOT NULL,message TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',event_id TEXT NOT NULL,created_at INTEGER NOT NULL)";

/** A booking, a customer who has consented, and one queued notification row per channel. */
async function world({ cityId = "blr", channels = ["push", "whatsapp"], templateCode = "walking_update" } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  for (const sql of canonicalDDL) sqlite.prepare(sql).run();
  sqlite.prepare(NOTIFICATION_DDL).run();
  await engine.ensureCommunicationTables(db);
  await bridge.ensureLifecycleCommunicationTables(db);

  const now = Date.now();
  sqlite.prepare(
    "INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES ('BK-1','idem-1','CUST-1','[]','[]',?,'z1','walking','WALK-DAILY','Daily','GRP-1','PROV-1',?,?, 'confirmed','customer_app',1000,'INR','{}','test',?,?)",
  ).run(cityId, new Date(now).toISOString(), new Date(now + 3_600_000).toISOString(), now, now);
  // Consent is recorded explicitly so a suppression in these tests is never just "unknown".
  await engine.setCommunicationPreference(db, { customerId: "CUST-1", serviceUpdates: true, marketing: false, source: "test" });

  const ids = [];
  for (const channel of channels) {
    const id = `NOTIF-${channel}`;
    ids.push(id);
    sqlite.prepare(
      "INSERT INTO walking_customer_notifications (id,booking_id,customer_id,channel,template_code,message,status,event_id,created_at) VALUES (?,?,?,?,?,?, 'queued',?,?)",
    ).run(id, "BK-1", "CUST-1", channel, templateCode, "Your walk has started.", "EVT-1", now);
  }
  return { sqlite, db, ids };
}

const rows = (sqlite, sql) => sqlite.prepare(sql).all();

test("a committed lifecycle notification reaches the canonical outbox on WhatsApp", async () => {
  const { sqlite, db } = await world();

  const report = await bridge.bridgeLifecycleCommunications(db, {
    bookingId: "BK-1",
    source: "walking_customer_notifications",
    actorId: "walker@pawspace.in",
  });

  assert.equal(report.enqueued, 1, "exactly the whatsapp row should enqueue");
  assert.equal(report.failed, 0);

  const messages = rows(sqlite, "SELECT * FROM communication_messages");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].channel, "whatsapp");
  assert.equal(messages[0].booking_id, "BK-1");
  assert.equal(messages[0].template_key, "walking_update");
  assert.equal(messages[0].purpose, "transactional");
  assert.equal(messages[0].idempotency_key, "LIFECYCLE-NOTIF-whatsapp");

  // The outbox row is what actually makes it deliverable, with retry/backoff attached.
  const outbox = rows(sqlite, "SELECT * FROM communication_outbox");
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].status, "queued");
  assert.ok(Number(outbox[0].max_attempts) > 0, "retry budget must come from the policy");
});

test("push rows are not bridged, because no push provider is connected", async () => {
  const { sqlite, db } = await world();
  const report = await bridge.bridgeLifecycleCommunications(db, { bookingId: "BK-1", source: "walking_customer_notifications" });

  assert.equal(report.skipped, 1, "the push row is skipped rather than queued against a provider that does not exist");
  const channels = rows(sqlite, "SELECT channel FROM communication_messages").map((r) => r.channel);
  assert.deepEqual(channels, ["whatsapp"]);
});

// ---------------------------------------------------------------------------
// The isolation guarantee. This is the whole reason the bridge exists.
// ---------------------------------------------------------------------------
test("REGRESSION an unseeded city cannot turn a committed lifecycle event into a thrown error", async () => {
  // Only 'blr' has a seeded communication policy (seedCommunicationPolicy), so policy() throws
  // "No active communication policy for city" for anything else. Before the bridge, calling
  // enqueueCommunication straight from a lifecycle path would have raised that at the caller.
  const { sqlite, db } = await world({ cityId: "hyd" });

  // Prove the underlying call really does throw for this city, so this test is not vacuous.
  await assert.rejects(
    engine.enqueueCommunication(db, {
      customerId: "CUST-1", cityId: "hyd", channel: "whatsapp", purpose: "transactional",
      idempotencyKey: "control-probe", templateKey: "walking_update", payload: {}, createdBy: "test", bookingId: "BK-1",
    }),
    /No active communication policy for city/,
  );

  // The bridge absorbs it.
  const report = await bridge.bridgeLifecycleCommunications(db, { bookingId: "BK-1", source: "walking_customer_notifications" });
  assert.equal(report.enqueued, 0);
  assert.equal(report.failed, 1, "the failure is counted, not raised");

  // The lifecycle's own record is untouched: nothing was rolled back.
  const notifications = rows(sqlite, "SELECT * FROM walking_customer_notifications");
  assert.equal(notifications.length, 2, "the vertical's notification rows survive a messaging failure");
  assert.ok(notifications.every((r) => r.status === "queued"), "and keep the status the vertical wrote");

  // The detail that a bare failure count would have thrown away is durable and diagnosable.
  const failures = rows(sqlite, "SELECT * FROM lifecycle_communication_failures");
  assert.equal(failures.length, 1);
  assert.equal(failures[0].booking_id, "BK-1");
  assert.equal(failures[0].channel, "whatsapp");
  assert.match(String(failures[0].error_message), /No active communication policy for city/);
  assert.ok(String(failures[0].error_stack || "").length > 0, "the stack is captured, not discarded");
});

test("bridging twice enqueues once", async () => {
  const { sqlite, db } = await world();
  const first = await bridge.bridgeLifecycleCommunications(db, { bookingId: "BK-1", source: "walking_customer_notifications" });
  const second = await bridge.bridgeLifecycleCommunications(db, { bookingId: "BK-1", source: "walking_customer_notifications" });

  assert.equal(first.enqueued, 1);
  assert.equal(second.enqueued, 0, "the link ledger stops a second hand-off");
  assert.equal(rows(sqlite, "SELECT * FROM communication_messages").length, 1);
});

test("a customer who opted out of service updates is suppressed, not enqueued", async () => {
  const { sqlite, db } = await world();
  await engine.setCommunicationPreference(db, { customerId: "CUST-1", serviceUpdates: false, source: "test" });

  const report = await bridge.bridgeLifecycleCommunications(db, { bookingId: "BK-1", source: "walking_customer_notifications" });
  assert.equal(report.enqueued, 0);
  assert.equal(report.suppressed, 1);
  assert.equal(rows(sqlite, "SELECT * FROM communication_outbox").length, 0, "a suppressed message is never deliverable");
});

test("recovery templates are classified as service_recovery, ordinary updates as transactional", () => {
  assert.equal(bridge.lifecycleCommunicationPurpose("walking_update"), "transactional");
  assert.equal(bridge.lifecycleCommunicationPurpose("walking_no_show"), "service_recovery");
  assert.equal(bridge.lifecycleCommunicationPurpose("provider_recovery"), "service_recovery");
  assert.equal(bridge.lifecycleCommunicationPurpose("running_late"), "service_recovery");
});

// ---------------------------------------------------------------------------
// SMS fallback
// ---------------------------------------------------------------------------
test("a dead-lettered recovery message falls back to SMS; a delivered one does not", async () => {
  const { sqlite, db } = await world({ channels: ["whatsapp"], templateCode: "walking_no_show" });
  await bridge.bridgeLifecycleCommunications(db, { bookingId: "BK-1", source: "walking_customer_notifications" });
  const [message] = rows(sqlite, "SELECT * FROM communication_messages");

  // Nothing has failed yet, so there is nothing to fall back from.
  const early = await bridge.escalateDeadLetteredLifecycleCommunications(db, { bookingId: "BK-1" });
  assert.equal(early.enqueued, 0, "a healthy WhatsApp message must not be duplicated onto SMS");

  // Drive the outbox to its terminal state the way failOutboxAttempt does.
  sqlite.prepare("UPDATE communication_outbox SET status='dead_letter' WHERE message_id=?").run(message.id);

  const escalated = await bridge.escalateDeadLetteredLifecycleCommunications(db, { bookingId: "BK-1" });
  assert.equal(escalated.enqueued, 1, "an undelivered no-show warning still needs to reach the customer");
  assert.equal(escalated.failed, 0);

  const sms = rows(sqlite, "SELECT * FROM communication_messages WHERE channel='sms'");
  assert.equal(sms.length, 1);
  assert.equal(sms[0].idempotency_key, "LIFECYCLE-SMS-FALLBACK-NOTIF-whatsapp");
  assert.match(String(sms[0].payload_json), /whatsapp_dead_letter/);

  // Running the sweep again must not send a second SMS.
  const again = await bridge.escalateDeadLetteredLifecycleCommunications(db, { bookingId: "BK-1" });
  assert.equal(again.enqueued, 0);
  assert.equal(rows(sqlite, "SELECT * FROM communication_messages WHERE channel='sms'").length, 1);
});

test("a dead-lettered ordinary update is history and is not re-sent over SMS", async () => {
  const { sqlite, db } = await world({ channels: ["whatsapp"], templateCode: "walking_update" });
  await bridge.bridgeLifecycleCommunications(db, { bookingId: "BK-1", source: "walking_customer_notifications" });
  const [message] = rows(sqlite, "SELECT * FROM communication_messages");
  sqlite.prepare("UPDATE communication_outbox SET status='dead_letter' WHERE message_id=?").run(message.id);

  const report = await bridge.escalateDeadLetteredLifecycleCommunications(db, { bookingId: "BK-1" });
  assert.equal(report.skipped, 1);
  assert.equal(rows(sqlite, "SELECT * FROM communication_messages WHERE channel='sms'").length, 0);
});

// ---------------------------------------------------------------------------
// Source contract: the wiring itself. A bridge nothing calls delivers nothing.
// ---------------------------------------------------------------------------
test("every service vertical hands its committed notifications to the outbox", () => {
  const wired = {
    "lib/walking-lifecycle.ts": "walking_customer_notifications",
    "lib/sitting-lifecycle.ts": "sitting_customer_notifications",
    "lib/taxi-lifecycle.ts": "taxi_customer_notifications",
    "lib/training-session-lifecycle.ts": "training_customer_notifications",
    "lib/boarding-stay-lifecycle.ts": "booking_customer_notifications",
    "app/api/booking-operations/route.ts": "booking_customer_notifications",
    "app/api/provider-assignment-recovery/route.ts": "booking_customer_notifications",
  };
  for (const [file, source] of Object.entries(wired)) {
    const src = fs.readFileSync(file, "utf8");
    assert.match(src, /bridgeLifecycleCommunications/, `${file} must hand its notifications to the canonical outbox`);
    assert.ok(src.includes(source), `${file} must bridge from ${source}`);
  }
});

test("the bridge is called after the lifecycle commits, never inside the batch", () => {
  // enqueueCommunication performs its own writes and cannot be composed into a caller's
  // db.batch([...]). A lifecycle module that passed it into one would be queuing a statement that
  // does not exist, so pin that no vertical ever does.
  for (const file of [
    "lib/walking-lifecycle.ts", "lib/sitting-lifecycle.ts", "lib/taxi-lifecycle.ts",
    "lib/training-session-lifecycle.ts", "lib/boarding-stay-lifecycle.ts",
  ]) {
    const src = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(src, /db\.batch\(\[[^\]]*bridgeLifecycleCommunications/s, `${file} must not bridge inside a batch`);
    assert.doesNotMatch(src, /enqueueCommunication/, `${file} must go through the bridge, which cannot throw, not straight to the engine`);
  }
});

test("the prelaunch live-delivery gate is not tripped by an internal hand-off", () => {
  // app/api/prelaunch-booking-swarm counts any vertical notification whose status is outside
  // ('queued','sandbox','suppressed') as evidence of live customer delivery. The bridge must
  // therefore never write status back onto those rows.
  const src = fs.readFileSync("lib/lifecycle-communications.ts", "utf8");
  for (const table of [
    "booking_customer_notifications", "walking_customer_notifications", "sitting_customer_notifications",
    "taxi_customer_notifications", "training_customer_notifications",
  ]) {
    assert.doesNotMatch(src, new RegExp(`UPDATE ${table}`), `the bridge must not rewrite ${table}`);
  }
  const guard = fs.readFileSync("app/api/prelaunch-booking-swarm/route.ts", "utf8");
  assert.match(guard, /status NOT IN \('queued','sandbox','suppressed'\)/, "the gate this constraint protects still exists");
});
