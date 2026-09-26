/**
 * Staging trace (B5): a paid, confirmed booking had no order notification 18 minutes later. The 5-minute sweep
 * re-read every booking and event oldest first, so on a large history it never reached new bookings. Each run
 * now reads only rows with no notification yet, newest first, in bounded batches.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { d1 } from "./helpers/execution-harness.mjs";

installWorkersHooks("__ORDER_SWEEP_DB__", "__ORDER_SWEEP_ENV__");
const { runOrderNotificationSweep } = await import("../lib/order-notification-governance.ts");

function world() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`CREATE TABLE canonical_customers (id TEXT PRIMARY KEY, city_id TEXT, name TEXT, primary_phone TEXT);
    CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY, customer_id TEXT, service_code TEXT, status TEXT, created_at INTEGER);
    CREATE TABLE booking_lifecycle_events (id TEXT PRIMARY KEY, booking_id TEXT, event_type TEXT, occurred_at INTEGER);
    INSERT INTO canonical_customers VALUES ('C1','blr','Old Customer','+919000000001');`);
  const booking = sqlite.prepare("INSERT INTO canonical_bookings VALUES (?, 'C1', 'grooming', 'confirmed', ?)");
  const event = sqlite.prepare("INSERT INTO booking_lifecycle_events VALUES (?, ?, ?, ?)");
  for (let i = 0; i < 250; i++) { booking.run(`OLD-${i}`, 1_000 + i); event.run(`EV-OLD-${i}`, `OLD-${i}`, "pricing_recomputed", 1_000 + i); }
  booking.run("NEW-PAID", 9_000_000);
  event.run("EV-NEW-PAID", "NEW-PAID", "payment_captured", 9_000_001);
  return { sqlite, db: d1(sqlite) };
}
const notified = (sqlite, key) => Boolean(sqlite.prepare("SELECT 1 FROM order_notifications WHERE idempotency_key=?").get(key));

test("the newest paid booking is notified on the first run even behind a large backlog", async () => {
  const { sqlite, db } = world();
  await runOrderNotificationSweep(db, { actorId: "test" });
  assert.ok(notified(sqlite, "booking:NEW-PAID:created"), "the new booking is notified first");
  assert.ok(notified(sqlite, "booking-event:EV-NEW-PAID"), "its payment event is notified even behind 250 internal events");
  assert.ok(sqlite.prepare("SELECT COUNT(*) n FROM order_notifications WHERE idempotency_key LIKE 'booking:%:created'").get().n <= 200, "each run is bounded");
});

test("later runs work through the backlog without repeating notifications", async () => {
  const { sqlite, db } = world();
  await runOrderNotificationSweep(db, { actorId: "test" });
  await runOrderNotificationSweep(db, { actorId: "test" });
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM order_notifications WHERE idempotency_key LIKE 'booking:%:created'").get().n, 251);
  await runOrderNotificationSweep(db, { actorId: "test" });
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM order_notifications WHERE idempotency_key LIKE 'booking:%:created'").get().n, 251);
});
