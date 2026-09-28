import test from "node:test";
import assert from "node:assert/strict";
import { setupJourney, runCompletedJourney, routeCall, sessionCookie } from "./helpers/grooming-journey-harness.mjs";
import { fixtureChecklist } from "./helpers/partner-checklist-fixture.mjs";
function config(label) {
  const start = new Date(Date.now() + 3 * 86400000); start.setUTCHours(4, 30, 0, 0);
  return { customerId: `R03-REC-${label}`, customerName: "Recovery test", phone: "+919900000101",
    petSourceId: `R03-PET-${label}`, petName: "Test dog", cityId: "blr", zoneId: "blr-east",
    pincode: "560038", latitude: 12.9716, longitude: 77.5946, preferredProviderId: "groom_arun",
    groupId: `R03-REC-GRP-${label}`, start: start.toISOString() };
}
async function retry(ctx, result, providerId = result.provider.id) {
  const cookie = await sessionCookie(ctx.db, "provider", providerId, `provider:${providerId}`);
  return routeCall("../../app/api/grooming-lifecycle/route.ts", "POST", "/api/grooming-lifecycle",
    { bookingId: result.bookingId, action: "complete", checklist: fixtureChecklist("complete") }, cookie);
}
test("R03 completion-history failure is recoverable without repeating money or service completion", async t => {
  const ctx = await setupJourney(); t.after(ctx.close); const prepare = ctx.db.prepare; let fault = true;
  ctx.db.prepare = sql => { const stmt = prepare(sql), bind = stmt.bind;
    stmt.bind = (...args) => { const bound = bind(...args), run = bound.run;
      bound.run = async () => {
        if (fault && sql.includes("INSERT INTO booking_lifecycle_events") && args.includes("service_completed")) {
          fault = false; throw new Error("R03 recoverable history-write fault");
        }
        return run();
      }; return bound;
    }; return stmt;
  };
  const result = await runCompletedJourney(ctx, config("HISTORY"));
  assert.ok(result.completed.status >= 400);
  assert.equal(ctx.sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(result.bookingId).status, "completed");
  const journal = ctx.sqlite.prepare("SELECT * FROM finance_journal_entries WHERE source_id=? ORDER BY id").all(result.bookingId);
  const invoices = ctx.sqlite.prepare("SELECT * FROM booking_invoices WHERE booking_id=?").all(result.bookingId);
  const recovered = await retry(ctx, result);
  assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
  const replayed = await retry(ctx, result);
  assert.equal(replayed.status, 200, JSON.stringify(replayed.body));
  const events = ctx.sqlite.prepare("SELECT * FROM booking_lifecycle_events WHERE booking_id=? AND event_type='service_completed'").all(result.bookingId);
  assert.equal(events.length, 1, "recovery must record exactly one completion event");
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM provider_lifecycle_events WHERE booking_id=? AND to_status='completed'").get(result.bookingId).n, 1);
  assert.deepEqual(ctx.sqlite.prepare("SELECT * FROM finance_journal_entries WHERE source_id=? ORDER BY id").all(result.bookingId), journal);
  assert.deepEqual(ctx.sqlite.prepare("SELECT * FROM booking_invoices WHERE booking_id=?").all(result.bookingId), invoices);
});
