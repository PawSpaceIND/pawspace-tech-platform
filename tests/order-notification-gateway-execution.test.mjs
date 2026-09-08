import test from 'node:test';
import assert from 'node:assert/strict';
import { d1 } from './helpers/execution-harness.mjs';
import { setupJourney, runCompletedJourney, sessionCookie } from './helpers/grooming-journey-harness.mjs';
const { authorizeApiRequest } = await import('../lib/api-gateway.ts');
const route = await import('../app/api/order-notifications/route.ts');
const origin = 'https://uat.pawspace.in';

test('completed booking notifications reach their customer through the real gateway and remain ownership guarded', async (t) => {
  const ctx = await setupJourney(); t.after(ctx.close);
  // The sweep runs independent branches concurrently; D1 serializes their atomic batches.
  ctx.db.batch = d1(ctx.sqlite).batch;
  const start = new Date(Date.now() + 3 * 86400000); start.setUTCHours(4, 30, 0, 0);
  const customerId = 'CUST-NOTIFY-GATE';
  const result = await runCompletedJourney(ctx, { customerId, customerName: 'Demo Customer', phone: '+919900000909',
    petSourceId: 'PET-NOTIFY', petName: 'Bruno', cityId: 'blr', zoneId: 'blr-east', pincode: '560038',
    latitude: 12.9716, longitude: 77.5946, preferredProviderId: 'groom_arun', groupId: 'NOTIFY-GATE', start: start.toISOString() });
  const other = await runCompletedJourney(ctx, { customerId:'CUST-OTHER-NOTIFY', customerName:'Other Customer', phone:'+919900000910',
    petSourceId:'PET-OTHER-NOTIFY', petName:'Max', cityId:'blr', zoneId:'blr-east', pincode:'560038',
    latitude:12.9716, longitude:77.5946, preferredProviderId:'groom_arun', groupId:'NOTIFY-OTHER',
    start:new Date(start.getTime()+86400000).toISOString() });
  const { ensureOrderNotificationTables, runOrderNotificationSweep } = await import('../lib/order-notification-governance.ts');
  await ensureOrderNotificationTables(ctx.db);
  const otherBefore = ctx.sqlite.prepare('SELECT COUNT(*) count FROM order_notifications WHERE booking_id=?').get(other.bookingId).count;
  const customerCookie = await sessionCookie(ctx.db, 'customer', customerId, `customer:${customerId}`);
  async function call(method, cookie, body, queryCustomer = customerId) {
    const req = new Request(`${origin}/api/order-notifications?customerId=${queryCustomer}`, {method,
      headers:{origin, cookie, 'content-type':'application/json'}, ...(body ? {body:JSON.stringify(body)} : {})});
    const access = await authorizeApiRequest(req, {DB: ctx.db, ...globalThis.__GROOM_GOLDEN_ENV__});
    if (access instanceof Response) return access;
    return route[method](req);
  }
  const [response, parallelResponse] = await Promise.all([call('GET', customerCookie),call('GET', customerCookie)]);
  const parallelPayload = await parallelResponse.json();
  assert.equal(parallelPayload.data?.sweep?.ok, true, JSON.stringify(parallelPayload));
  assert.equal(response.status, 200, await response.clone().text());
  const payload = await response.json();
  assert.equal(payload.data.sweep.ok, true, JSON.stringify(payload));
  assert.equal(payload.data.sweep.canonicalOrders.scanned, 1, 'customer reads must not scan all bookings');
  assert.equal(ctx.sqlite.prepare('SELECT COUNT(*) count FROM order_notifications WHERE booking_id=?').get(other.bookingId).count, otherBefore,
    'customer reads must not create notifications for another customer');
  const items = payload.data.items.filter(item => item.booking_id === result.bookingId);
  assert.ok(items.some(item => item.event_type === 'payment_captured'), JSON.stringify(payload));
  assert.ok(items.some(item => /completed/.test(item.event_type)));
  const again = await (await call('GET', customerCookie)).json();
  assert.deepEqual(again.data.items.map(item => item.id).sort(), payload.data.items.map(item => item.id).sort());
  const communication = ctx.sqlite.prepare("SELECT m.id FROM communication_messages m JOIN order_notifications n ON m.idempotency_key=n.idempotency_key||':customer' WHERE n.id=?").get(items[0].id);
  const { deadLetterOutbox } = await import('../lib/communication-engine.ts');
  await deadLetterOutbox(ctx.db, communication.id, 'unsupported_outbox_channel');
  const afterDispatch = await (await call('GET', customerCookie)).json();
  const failedDelivery = afterDispatch.data.items.find(item => item.id === items[0].id);
  assert.equal(failedDelivery.delivery_status, 'dead_letter');
  assert.equal(failedDelivery.delivery_error, 'unsupported_outbox_channel');
  assert.equal(failedDelivery.status, 'unread', 'external dispatch does not mark the in-app notice read');
  const globalSweep = await runOrderNotificationSweep(ctx.db);
  assert.equal(globalSweep.ok, true, JSON.stringify(globalSweep));
  assert.equal(globalSweep.canonicalOrders.scanned, 2, 'cron retains global generation');
  assert.ok(ctx.sqlite.prepare('SELECT COUNT(*) count FROM order_notifications WHERE booking_id=?').get(other.bookingId).count > otherBefore);
  await assert.rejects(runOrderNotificationSweep(ctx.db, {customerId:'  '}), /scope cannot be empty/);
  const notificationId = items[0].id;
  assert.equal((await call('POST', customerCookie, {customerId, notificationId, action:'mark_read'})).status, 200);
  const stranger = await sessionCookie(ctx.db, 'customer', 'CUST-STRANGER', 'customer:CUST-STRANGER');
  assert.equal((await call('GET', stranger)).status, 403);
  assert.equal((await call('POST', stranger, {customerId, notificationId, action:'mark_read'})).status, 403);
  assert.equal((await call('GET', '')).status, 401);
  assert.equal(ctx.sqlite.prepare('SELECT status FROM order_notifications WHERE id=?').get(notificationId).status, 'read');
});
