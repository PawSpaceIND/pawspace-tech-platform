import test from"node:test";
import assert from"node:assert/strict";
import{readFile}from"node:fs/promises";

const read=path=>readFile(new URL(`../${path}`,import.meta.url),"utf8");

test("Sitting Gate 1 owns catalogue and quote truth on the server",async()=>{const source=await read("lib/sitting-governance.ts");assert.match(source,/sitting_commercial_packages/);assert.match(source,/sitting_commercial_quotes/);assert.match(source,/Sitting split payment policy is not approved/);assert.match(source,/Sitting coupon policy is not enabled/);assert.match(source,/Sitting amount does not match the server quote/);assert.match(source,/Sitting quote is already linked to a booking/);});

test("Sitting commercial API is same-origin and explicitly sandbox only",async()=>{const source=await read("app/api/sitting-commercial/route.ts");assert.match(source,/Cross-origin Sitting quote blocked/);assert.match(source,/canonical_sitting_governance/);assert.match(source,/liveAvailability:false/);assert.match(source,/liveMoney:false/);});

test("Sitting client consumes canonical quote API instead of inventing prices",async()=>{const source=await read("lib/sitting-commercial-client.ts");assert.match(source,/\/api\/sitting-commercial/);assert.match(source,/createSittingQuote/);assert.match(source,/paymentMode:input\.paymentMode\|\|"prepaid"/);});

test("Sitting UI now renders server-owned quote truth without creating a booking",async()=>{const page=await read("app/sitting/page.tsx");assert.match(page,/createSittingQuote/);assert.match(page,/loadSittingCatalogue/);assert.match(page,/Canonical quote/);assert.match(page,/quote\.totalAmount|quoteAmount/);assert.doesNotMatch(page,/chosen\.price\*3/);assert.match(page,/No booking, live payment or provider assignment is created/);});

test("Sitting booking boundary requires customer ownership and canonical scheduling",async()=>{const source=await read("app/api/sitting-bookings/route.ts");assert.match(source,/Cross-origin Sitting booking blocked/);assert.match(source,/requireCustomerOwnership/);assert.match(source,/scheduling_assignment_decisions/);assert.match(source,/Scheduling must be assigned before Sitting confirmation/);assert.match(source,/The sitter does not match the scheduling decision/);assert.match(source,/Sitting Gate 1 requires exactly one canonical care reservation/);assert.match(source,/Sitting booking window does not match the canonical reservation/);});

test("Sitting booking boundary consumes governed quote into one canonical bundle",async()=>{const source=await read("app/api/sitting-bookings/route.ts");assert.match(source,/governSittingBooking/);assert.match(source,/canonical_bookings/);assert.match(source,/provider_work_orders/);assert.match(source,/booking_payments/);assert.match(source,/"pet_sitting"/);assert.match(source,/sitting_booking_quote_links/);assert.match(source,/status='used'/);assert.match(source,/uat_sandbox/);assert.match(source,/liveMoney:false/);assert.match(source,/idempotency_key=\? OR schedule_group_id=\?/);});