/**
 * customerReminders dedupe — running the same due sweep twice dispatches exactly once.
 *
 * Each reminder is keyed by a per-cycle idempotency key (grooming_rebooking:<customer>:<cycle>) passed to
 * enqueueCommunication, which is backed by communication_messages.idempotency_key UNIQUE. A second sweep
 * over the same due state finds the prior message and returns duplicatePrevented — no second dispatch.
 *
 * Runs the REAL sweep over a real node:sqlite D1 (transactional shim). The dedupe is proven by counting
 * the actual outbound messages, not by inspecting source.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { createD1 } from "./helpers/d1.mjs";

installWorkersHooks("__NBREM_DB__", "__NBREM_ENV__");

const rem = await import("../lib/customer-reminder-governance.ts");

const DAY = 86_400_000;
const AS_OF = Date.UTC(2026, 9, 1, 6, 0, 0); // fixed IST-morning instant, well outside quiet hours
const CUSTOMER = "CUS-REMIND-1";

function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  const db = createD1(sqlite);
  globalThis.__NBREM_DB__ = db;
  globalThis.__NBREM_ENV__ = {};
  // A customer who has opted in to service updates (so a lifecycle reminder queues, not suppressed).
  sqlite.exec("CREATE TABLE canonical_customers (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,primary_phone TEXT NOT NULL,secondary_phone TEXT,email TEXT,source TEXT NOT NULL DEFAULT 'customer_app',consent_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,email,consent_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(CUSTOMER, "blr", "Remind Me", "+919000020001", "remind@pawspace.test", JSON.stringify({ serviceUpdates: true, whatsapp: true }), 0, 0);
  // A grooming booking completed 20 days before asOf (past the 15-day rebooking cadence), no future one.
  sqlite.exec("CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,service_code TEXT NOT NULL,status TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL)");
  const start = new Date(AS_OF - 20 * DAY).toISOString(), end = new Date(AS_OF - 20 * DAY + 3_600_000).toISOString();
  sqlite.prepare("INSERT INTO canonical_bookings VALUES ('BK-G1',?, 'grooming','completed',?,?)").run(CUSTOMER, start, end);
  return { sqlite, db };
}

const messageCount = (sqlite) => sqlite.prepare("SELECT COUNT(*) c FROM communication_messages WHERE customer_id=?").get(CUSTOMER).c;
const dupEvents = (sqlite) => sqlite.prepare("SELECT COUNT(*) c FROM reminder_governance_events WHERE customer_id=? AND duplicate_prevented=1").get(CUSTOMER).c;

test("the same due reminder sweep run twice dispatches exactly one message (idempotent)", async () => {
  const { sqlite, db } = freshDb();

  const first = await rem.runCustomerReminderSweep(db, { actorId: "ops@pawspace.in", asOf: AS_OF });
  assert.equal(first.grooming.queued, 1, `first sweep queues the reminder: ${JSON.stringify(first.grooming)}`);
  assert.equal(messageCount(sqlite), 1, "exactly one outbound message after the first sweep");

  const second = await rem.runCustomerReminderSweep(db, { actorId: "ops@pawspace.in", asOf: AS_OF });
  assert.equal(second.grooming.queued, 0, "the second sweep queues nothing new");
  assert.equal(messageCount(sqlite), 1, "still exactly one message — no duplicate dispatch");
  assert.ok(dupEvents(sqlite) >= 1, "the second sweep recorded a duplicate-prevented event");
});

test("a third identical sweep still dispatches nothing further (stable idempotency)", async () => {
  const { sqlite, db } = freshDb();
  for (let i = 0; i < 3; i++) await rem.runCustomerReminderSweep(db, { actorId: "ops@pawspace.in", asOf: AS_OF });
  assert.equal(messageCount(sqlite), 1, "three sweeps, one message");
});
