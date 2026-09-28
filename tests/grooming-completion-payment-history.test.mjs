import test from "node:test";
import assert from "node:assert/strict";
import { setupJourney, runCompletedJourney, routeCall } from "./helpers/grooming-journey-harness.mjs";

/** A local synthetic journey; no hosted credentials, gateway or handset calls. */
function configuration() {
  const start = new Date(Date.now() + 3 * 86400000);
  start.setUTCHours(4, 30, 0, 0);
  return { customerId: "R03-CUSTOMER", customerName: "R03 test customer",
    phone: "+919900000101", petSourceId: "R03-PET", petName: "Test dog",
    cityId: "blr", zoneId: "blr-east", pincode: "560038", latitude: 12.9716,
    longitude: 77.5946, preferredProviderId: "groom_arun", groupId: "R03-GROUP",
    start: start.toISOString() };
}

test("R03: a refund processed during completion is reflected in the persisted payment history", async (t) => {
  const ctx = await setupJourney(); t.after(ctx.close);
  const prepare = ctx.db.prepare;
  let injected = false;
  ctx.db.prepare = (sql) => {
    const statement = prepare(sql);
    if (!sql.includes("INSERT INTO booking_lifecycle_events")) return statement;
    const bind = statement.bind;
    statement.bind = (...args) => {
      const bound = bind(...args);
      if (injected || !args.includes("service_completed")) return bound;
      const run = bound.run;
      bound.run = async () => {
        injected = true;
        const booking = ctx.sqlite.prepare("SELECT id FROM canonical_bookings WHERE customer_id='R03-CUSTOMER'").get();
        const payment = ctx.sqlite.prepare("SELECT id,status FROM booking_payments WHERE booking_id=?").get(booking.id);
        assert.equal(payment.status, "captured", "the normal fixture really captured first");
        // Approved refund-case fixture; the real local simulator performs the state transition.
        ctx.sqlite.exec("CREATE TABLE IF NOT EXISTS booking_refund_cases (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,payment_id TEXT,amount REAL NOT NULL,reason TEXT NOT NULL,status TEXT NOT NULL,requested_by TEXT NOT NULL,approved_by TEXT,gateway_reference TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
        ctx.sqlite.prepare("INSERT INTO booking_refund_cases (id,booking_id,payment_id,amount,reason,status,requested_by,approved_by,created_at,updated_at) VALUES ('R03-REFUND',?,?,1,'Synthetic R03 refund race','approved','test-maker','test-checker',?,?)")
          .run(booking.id, payment.id, Date.now(), Date.now());
        const refund = await routeCall("../../app/api/grooming-payment-sandbox/route.ts", "POST", "/api/grooming-payment-sandbox",
          { action: "simulate_event", bookingId: booking.id, eventType: "refund.processed",
            eventId: "evt_r03_refund", gatewayRefundId: "rfnd_r03", amount: 1, currency: "INR" });
        assert.equal(refund.status, 201, JSON.stringify(refund.body));
        assert.equal(refund.body.data.result.status, "processed", JSON.stringify(refund.body));
        assert.equal(ctx.sqlite.prepare("SELECT status FROM booking_payments WHERE id=?").get(payment.id).status, "partially_refunded");
        return run();
      };
      return bound;
    };
    return statement;
  };
  const result = await runCompletedJourney(ctx, configuration());
  assert.ok(injected, "the race must reach the actual event-write boundary");
  assert.equal(result.completed.status, 200, JSON.stringify(result.completed.body));
  const stored = ctx.sqlite.prepare("SELECT detail_json FROM booking_lifecycle_events WHERE booking_id=? AND event_type='service_completed'").get(result.bookingId);
  const detail = JSON.parse(stored.detail_json);
  assert.equal(detail.paymentStatus, "partially_refunded", "history must describe payment state when recorded, not the earlier snapshot");
  assert.equal(result.completed.body.data.booking.paymentStatus, detail.paymentStatus);
  const projected = result.completed.body.data.events.find(event => event.eventType === "service_completed");
  assert.equal(projected.detail.paymentStatus, detail.paymentStatus);
  assert.equal(projected.actorId, "provider_or_system");
  assert.equal(detail.invoiceNumber, result.completed.body.data.invoice.invoiceNumber);
});

/** Minimal database for the real event writer; amounts and payments are read-only. */
async function eventWorld(t, status = "created") {
  const { DatabaseSync } = await import("node:sqlite");
  const { makePlatformScaleD1 } = await import("./helpers/platform-scale-d1.mjs");
  const { recordGroomingCompletionEvent } = await import("../lib/grooming-completion-event.ts");
  const sqlite = new DatabaseSync(":memory:"); t.after(() => sqlite.close());
  sqlite.exec(`
    CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,provider_id TEXT,service_code TEXT,status TEXT);
    CREATE TABLE booking_payments (booking_id TEXT PRIMARY KEY,customer_id TEXT,status TEXT NOT NULL,amount REAL);
    CREATE TABLE booking_lifecycle_events (id TEXT PRIMARY KEY,booking_id TEXT,event_type TEXT,entity_type TEXT,entity_id TEXT,actor_id TEXT,detail_json TEXT,occurred_at INTEGER);
    INSERT INTO canonical_bookings VALUES ('R03-OWN','R03-CUSTOMER','R03-PROVIDER','grooming','completed');
    INSERT INTO canonical_bookings VALUES ('R03-OTHER','OTHER-CUSTOMER','OTHER-PROVIDER','grooming','completed');
    INSERT INTO booking_payments VALUES ('R03-OTHER','OTHER-CUSTOMER','refunded',999);
  `);
  sqlite.prepare("INSERT INTO booking_payments VALUES ('R03-OWN','R03-CUSTOMER',?,100)").run(status);
  const db = makePlatformScaleD1(sqlite);
  const input = { bookingId: "R03-OWN", providerId: "R03-PROVIDER", actorId: "test-provider",
    occurredAt: Date.now(), detail: { paymentStatus: "invented_capture", invoiceNumber: "R03-INVOICE", untouched: "retained" } };
  return { sqlite, db, input, record: () => recordGroomingCompletionEvent(db, input) };
}

for (const status of ["created", "authorized", "captured", "partially_refunded", "refunded", "failed"]) {
  test(`R03 event writer preserves canonical ${status} without asserting a capture`, async (t) => {
    const world = await eventWorld(t, status);
    const before = world.sqlite.prepare("SELECT * FROM booking_payments ORDER BY booking_id").all();
    const result = await world.record();
    const rows = world.sqlite.prepare("SELECT * FROM booking_lifecycle_events").all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, result.eventId);
    assert.equal(rows[0].booking_id, "R03-OWN");
    assert.equal(rows[0].event_type, "service_completed");
    assert.deepEqual(JSON.parse(rows[0].detail_json), { paymentStatus: status, invoiceNumber: "R03-INVOICE", untouched: "retained" });
    assert.deepEqual(world.sqlite.prepare("SELECT * FROM booking_payments ORDER BY booking_id").all(), before);
  });
}

for (const scenario of ["missing_payment", "different_customer", "different_provider", "not_completed", "different_service"]) {
  test(`R03 event writer refuses ${scenario} without creating history`, async (t) => {
    const world = await eventWorld(t);
    const sql = {
      missing_payment: "DELETE FROM booking_payments WHERE booking_id='R03-OWN'",
      different_customer: "UPDATE booking_payments SET customer_id='OTHER-CUSTOMER' WHERE booking_id='R03-OWN'",
      different_provider: "UPDATE canonical_bookings SET provider_id='OTHER-PROVIDER' WHERE id='R03-OWN'",
      not_completed: "UPDATE canonical_bookings SET status='in_service' WHERE id='R03-OWN'",
      different_service: "UPDATE canonical_bookings SET service_code='pet_taxi' WHERE id='R03-OWN'",
    }[scenario];
    world.sqlite.exec(sql);
    const refusal = await world.record().catch(error => error);
    assert.ok(refusal instanceof Response);
    assert.equal(refusal.status, 409);
    assert.equal((await refusal.json()).code, "completion_payment_history_unavailable");
    assert.equal(world.sqlite.prepare("SELECT COUNT(*) n FROM booking_lifecycle_events").get().n, 0);
  });
}

test("R03 event writer reads a capture arriving after statement preparation", async (t) => {
  const world = await eventWorld(t, "authorized");
  const prepare = world.db.prepare;
  world.db.prepare = (sql) => {
    const stmt = prepare(sql), bind = stmt.bind;
    stmt.bind = (...args) => {
      const bound = bind(...args), run = bound.run;
      bound.run = async () => {
        world.sqlite.prepare("UPDATE booking_payments SET status='captured' WHERE booking_id='R03-OWN'").run();
        return run();
      };
      return bound;
    };
    return stmt;
  };
  await world.record();
  assert.equal(JSON.parse(world.sqlite.prepare("SELECT detail_json FROM booking_lifecycle_events").get().detail_json).paymentStatus, "captured");
});

test("R03 event writer propagates a failed database write instead of reporting success", async (t) => {
  const world = await eventWorld(t, "captured");
  const prepare = world.db.prepare;
  world.db.prepare = (sql) => {
    const stmt = prepare(sql), bind = stmt.bind;
    stmt.bind = (...args) => {
      const bound = bind(...args);
      bound.run = async () => { throw new Error("R03 deliberate database write failure"); };
      return bound;
    };
    return stmt;
  };
  await assert.rejects(world.record, /R03 deliberate database write failure/);
  assert.equal(world.sqlite.prepare("SELECT COUNT(*) n FROM booking_lifecycle_events").get().n, 0);
  assert.equal(world.sqlite.prepare("SELECT status FROM booking_payments WHERE booking_id='R03-OWN'").get().status, "captured");
});
