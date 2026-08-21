import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read=path=>fs.readFileSync(new URL(`../${path}`,import.meta.url),"utf8");
const route=read("app/api/assisted-orders/route.ts");
const page=read("app/assisted-booking/page.tsx");
const crmPage=read("app/crm/page.tsx");
const canonicalBooking=read("app/api/canonical-bookings/route.ts");
const customer360=read("lib/customer-360.ts");
const client=read("lib/assisted-orders-client.ts");
const gateway=read("lib/api-gateway.ts");
const assistedInput=client.match(/export type AssistedOrderInput=\{([\s\S]*?)\};/)?.[1]??"";

test("assisted orders stays staff-only and test-only",()=>{
  assert.match(route,/staffRoles=new Set\(\["founder","superuser","admin","manager","associate"\]\)/);
  assert.match(route,/requirePermission\(await resolveActor\(request\),"scheduling\.book"\)/);
  assert.match(gateway,/url\.pathname==="\/api\/assisted-orders"\)return "scheduling\.book"/);
  assert.match(route,/Assisted Orders is staff-only/);
  assert.match(route,/testOnly:true/);
  assert.match(route,/liveMoney:false/);
  assert.doesNotMatch(route,/status:\s*"captured"/);
  assert.match(route,/mode:"pay_after_service",status:"created"/);
});

test("browser cannot submit a final assisted-order price",()=>{
  assert.ok(assistedInput,"AssistedOrderInput type must remain explicit");
  assert.doesNotMatch(assistedInput,/totalAmount/);
  assert.doesNotMatch(assistedInput,/amountDueNow/);
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

test("CRM lead hands the same customer and pet identity into governed booking and conversion",()=>{
  assert.match(crmPage,/assisted-booking\?customerId=\$\{encodeURIComponent\(selected\.id\)\}/,"selected CRM record must have a booking action");
  assert.match(page,/useQueryParameter\("customerId"\)/,"assisted booking must hydrate the selected CRM identity through the hydration-safe query hook");
  assert.match(page,/\/api\/customer-360\?customerId=\$\{encodeURIComponent\(requested\)\}/,"canonical Customer 360 must be the first selected-customer read");
  assert.match(customer360,/SELECT customer_id,id,source_pet_id,name,species,breed,vaccination_status FROM canonical_pets/,"Customer 360 must read the canonical pet source identity");
  assert.match(customer360,/sourceId:row\.source_pet_id\?String\(row\.source_pet_id\):null/,"Customer 360 must expose the canonical pet source identity");
  assert.match(page,/p\.sourceId\|\|p\.name\|\|p\.id/,"assisted booking must prefer the canonical source identity");
  assert.match(page,/fetch\("\/api\/crm"/,"CRM pet name is used only when a canonical pet does not exist");
  assert.match(page,/Confirm the missing pet species/,"staff must confirm missing pet identity data rather than invent it");
  assert.match(page,/customer:\{id:customer\.id,name:customer\.name,primaryPhone:customer\.primaryPhone/,"the selected CRM customer ID must be submitted unchanged");
  assert.match(route,/customer:input\.customer,pets:input\.pets/,"assisted orders must pass that identity unchanged to canonical booking");
  assert.match(canonicalBooking,/attributeBookingToOpenLead\(db,\{customerId:input\.customer\.id,bookingId\}\)/,"canonical booking must attribute the result back to the open CRM lead");
});
