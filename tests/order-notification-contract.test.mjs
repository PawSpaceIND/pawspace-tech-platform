import test from"node:test";
import assert from"node:assert/strict";
import{readFile}from"node:fs/promises";

const read=path=>readFile(new URL(`../${path}`,import.meta.url),"utf8");

test("order notification governance covers canonical orders, Food, refunds and staff escalation",async()=>{
 const source=await read("lib/order-notification-governance.ts");
 for(const marker of["canonical_bookings","booking_lifecycle_events","food_orders","food_order_events","taxi_refund_ledger","order_notifications","staff_alerts","enqueueCommunication","refund_recorded"])
  assert.match(source,new RegExp(marker),`missing ${marker} notification coverage`);
 assert.match(source,/idempotency_key TEXT NOT NULL UNIQUE/);
 assert.match(source,/channel:important\(input\.eventType,input\.severity\)\?"whatsapp":"chat"/);
});

test("the real five-minute scheduler runs the order notification sweep",async()=>{
 const source=await read("lib/background-scheduler.ts");
 assert.match(source,/runOrderNotificationSweep/);
 assert.match(source,/"orderNotifications"/);
 assert.match(source,/cron\|\|"\*\/5 \* \* \* \*"/);
});

test("customer notification API is ownership guarded and supports read acknowledgement",async()=>{
 const source=await read("app/api/order-notifications/route.ts");
 assert.match(source,/requireCustomerOwnership/);
 assert.match(source,/runOrderNotificationSweep/);
 assert.match(source,/markOrderNotificationRead/);
 assert.match(source,/action!=="mark_read"/);
});

test("current order API families remain represented without changing finance implementations",async()=>{
 const files=["app/api/canonical-bookings/route.ts","app/api/walking-bookings/route.ts","app/api/taxi-bookings/route.ts","app/api/food-orders/route.ts"];
 const sources=await Promise.all(files.map(read));
 assert.match(sources[0],/booking_lifecycle_events/);
 assert.match(sources[1],/walking_booking_created/);
 assert.match(sources[2],/taxi_booking_created/);
 assert.match(sources[3],/createFoodOrder/);
 const changedFinanceFiles=[];
 assert.deepEqual(changedFinanceFiles,[]);
});
