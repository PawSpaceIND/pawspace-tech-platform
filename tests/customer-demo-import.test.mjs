import assert from"node:assert/strict";
import test from"node:test";
import{readFile}from"node:fs/promises";
const source=async path=>readFile(new URL("../"+path,import.meta.url),"utf8");

test("protected customer demo tracks repeat activity without inventing legacy subscription balances",async()=>{
  const[api,panel]=await Promise.all([source("app/api/subscription-customers/route.ts"),source("app/control/customer-data-panel.tsx")]);
  assert.match(api,/customer_demo_enrichment/);
  assert.match(api,/current_customer_type/);
  assert.match(api,/current_last_service_date/);
  assert.match(api,/july_grooming_orders/);
  assert.match(api,/historical_subscription_customer/);
  assert.match(api,/legacy_balance_pending_migration/);
  assert.match(api,/subscription_candidate/);
  assert.match(api,/daysSince\(lastService\)/);
  assert.match(api,/dormancy\(days\)/);
  assert.match(api,/Latest Grooming Payment Status/);
  assert.match(api,/Latest Pet Breed/);
  assert.match(api,/Latest \/ Best Service Address/);
  assert.match(panel,/Repeat customers/);
  assert.match(panel,/Historical subscribers/);
  assert.match(panel,/Subscription candidates/);
  assert.match(panel,/Active ≤30 days/);
  assert.match(panel,/July matched/);
  assert.match(panel,/Legacy balance pending migration/);
  assert.match(panel,/Customer 360/);
  assert.doesNotMatch(panel,/sessions remaining/i);
});
