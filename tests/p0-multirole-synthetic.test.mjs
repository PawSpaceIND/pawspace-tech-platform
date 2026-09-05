import test from 'node:test';
import assert from 'node:assert/strict';
import { setupJourney, runCompletedJourney, routeCall, sessionCookie } from './helpers/grooming-journey-harness.mjs';

function future(hour = 5) {
  const now = Date.now();
  const start = new Date(now + 3 * 86_400_000);
  start.setUTCHours(hour, 30, 0, 0);
  if (start.getTime() <= now + 2 * 60 * 60_000) start.setUTCDate(start.getUTCDate() + 1);
  return start.toISOString();
}

test('P0-04 customer -> payment -> operations assignment -> provider completion -> RBAC lifecycle', async (t) => {
  const ctx = await setupJourney();
  t.after(ctx.close);
  const config = {
    customerId: 'CUST-P0-SYNTH',
    customerName: 'P0 Synthetic Customer',
    phone: '+919900099001',
    petSourceId: 'PET-P0-SYNTH',
    petName: 'Pilot',
    cityId: 'blr',
    zoneId: 'blr-east',
    pincode: '560038',
    latitude: 12.9716,
    longitude: 77.5946,
    preferredProviderId: 'groom_arun',
    groupId: `P0-SYNTH-${Date.now()}`,
    start: future(),
  };

  const result = await runCompletedJourney(ctx, config);

  // Customer booking and money boundary.
  assert.equal(result.scheduled.status, 200, JSON.stringify(result.scheduled.body));
  assert.equal(result.scheduleReplay.body.data.duplicatePrevented, true, 'scheduling retry must be idempotent');
  assert.equal(result.booked.status, 201, JSON.stringify(result.booked.body));
  assert.equal(result.bookingReplay.body.data.duplicatePrevented, true, 'booking retry must be idempotent');
  assert.equal(result.captured.status, 201, JSON.stringify(result.captured.body));
  assert.equal(result.captureReplay.body.data.result.duplicate, true, 'payment event replay must be idempotent');
  assert.equal(result.persisted.payment.status, 'captured');
  assert.equal(result.persisted.payment.amount, result.persisted.booking.total_amount);

  // Operations dispatch is represented by the authoritative reservation/work-order fanout.
  assert.equal(result.persisted.reservation.provider_id, result.provider.id);
  assert.equal(result.persisted.work.provider_id, result.provider.id);
  assert.equal(result.jobs.status, 200);
  assert.ok(result.jobs.body.jobs.some(job => job.bookingId === result.bookingId), 'assigned provider must see dispatched job');

  // Provider lifecycle and proof gate.
  assert.deepEqual(result.transitions.map(step => step.status), [200, 200, 200, 200]);
  assert.equal(result.invalidEarlyComplete.status, 409, 'completion must fail closed before mandatory proof');
  assert.equal(result.proof.status, 200);
  assert.equal(result.completed.status, 200, JSON.stringify(result.completed.body));
  assert.equal(result.persisted.work.status, 'completed');
  assert.equal(result.persisted.booking.status, 'completed');

  // Cross-provider RBAC: a valid provider identity cannot mutate another provider's completed work.
  const intruder = await sessionCookie(ctx.db, 'provider', 'groom_kiran', 'provider:groom_kiran');
  const forbidden = await routeCall(
    '../../app/api/grooming-lifecycle/route.ts',
    'POST',
    '/api/grooming-lifecycle',
    { bookingId: result.bookingId, action: 'on_the_way' },
    intruder,
    'https://uat.pawspace.in',
  );
  assert.equal(forbidden.status, 403, JSON.stringify(forbidden.body));
  assert.equal(ctx.sqlite.prepare('SELECT status FROM canonical_bookings WHERE id=?').get(result.bookingId).status, 'completed');

  // Persisted single-write invariants after retries.
  assert.equal(result.persisted.counts.bookings, 1);
  assert.equal(result.persisted.counts.payments, 1);
  assert.equal(result.persisted.counts.events, 1);
});
