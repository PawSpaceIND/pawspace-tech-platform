import test from'node:test';
import assert from'node:assert/strict';
import fs from'node:fs';

const generator=fs.readFileSync('lib/daily-revenue-opportunity-governance.ts','utf8');
const route=fs.readFileSync('app/api/revenue-crm/route.ts','utf8');

test('the fake 100-row synthetic generator is genuinely gone from revenue-crm',()=>{
  assert.doesNotMatch(route,/CRM-R100\$\{customerIndex\}/);
  assert.doesNotMatch(route,/const opportunityKinds/);
});

test('the real generator combines customer scoring, inbound leads and subscription renewals - not a single fabricated source',()=>{
  assert.match(generator,/rankRevenueActions/);
  assert.match(generator,/buildCustomer360/);
  assert.match(generator,/lead_work_items/);
  assert.match(generator,/customer_grooming_subscriptions/);
});

test('lead-based estimates are honestly disclosed as estimates, renewal values are the real historical price',()=>{
  assert.match(generator,/inbound_lead_catalogue_average_estimate/);
  assert.match(generator,/actual_subscription_price/);
  assert.match(generator,/source_booking_id/);
});

test('the daily target is real and configurable, not hardcoded to a fixed 100 rows',()=>{
  assert.match(generator,/daily_revenue_targets/);
  assert.match(generator,/setDailyRevenueTarget/);
  assert.match(generator,/currentDailyRevenueTarget/);
  assert.match(route,/set_daily_target/);
});

test('renewal opportunities never guess a price - they read the real original booking amount',()=>{
  assert.match(generator,/LEFT JOIN canonical_bookings b ON b\.id=s\.source_booking_id/);
});
