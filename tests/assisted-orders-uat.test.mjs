import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read=path=>fs.readFileSync(new URL(`../${path}`,import.meta.url),"utf8");
const route=read("app/api/assisted-orders/route.ts");
const page=read("app/assisted-booking/page.tsx");
const client=read("lib/assisted-orders-client.ts");

test("assisted orders stays staff-only and test-only",()=>{
  assert.match(route,/staffRoles=new Set\(\["founder","superuser","admin","manager","associate"\]\)/);
  assert.match(route,/requirePermission\(await resolveActor\(request\),"scheduling\.book"\)/);
  assert.match(route,/Assisted Orders is staff-only/);
  assert.match(route,/testOnly:true/);
  assert.match(route,/liveMoney:false/);
  assert.doesNotMatch(route,/status:\s*"captured"/);
  assert.match(route,/mode:"pay_after_service",status:"created"/);
});

test("browser cannot submit a final assisted-order price",()=>{
  assert.doesNotMatch(client,/totalAmount:number/);
  assert.doesNotMatch(client,/amountDueNow:number.*AssistedOrderInput/);
  assert.match(route,/const total=pets\.length===1\?item\.singlePrice:/);
  assert.match(route,/groomingCatalogue\.find/);
  assert.match(page,/Browser does not set final price/);
});

test("assisted order composes canonical scheduler and booking boundaries",()=>{
  assert.match(route,/internalPost\(request,"\/api\/uat-scheduling"/);
  assert.match(route,/serviceCode:"grooming"/);
  assert.match(route,/occurrences:1/);
  assert.match(route,/internalPost\(request,"\/api\/canonical-bookings"/);
  assert.match(route,/provider,totalAmount:total,amountDueNow:0/);
  assert.match(route,/UPDATE canonical_bookings SET channel='assisted_staff'/);
});

test("consent, idempotency and audit are permanent invariants",()=>{
  assert.match(route,/CREATE TABLE IF NOT EXISTS assisted_orders/);
  assert.match(route,/idempotency_key TEXT NOT NULL UNIQUE/);
  assert.match(route,/Customer consent evidence is required/);
  assert.match(route,/consent_reference TEXT NOT NULL/);
  assert.match(route,/assisted_order_created/);
  assert.match(route,/securityAudit\(db,actor,"assisted_order\.create"/);
  assert.match(route,/duplicatePrevented:true/);
});

test("assisted booking page uses the canonical client rather than a fake confirmation",()=>{
  assert.match(page,/loadAssistedOrderConfig/);
  assert.match(page,/createAssistedOrder/);
  assert.match(page,/Create UAT assisted order/);
  assert.match(page,/result\.bookingId/);
  assert.match(page,/No live money/);
  assert.doesNotMatch(page,/PS-GR-8518/);
  assert.doesNotMatch(page,/Booking .* confirmed; customer and provider notified/);
});
