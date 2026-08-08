import test from"node:test";
import assert from"node:assert/strict";
import{readFile}from"node:fs/promises";
const read=path=>readFile(new URL(`../${path}`,import.meta.url),"utf8");

test("Walking Gate 1 owns package and quote truth on the server",async()=>{const source=await read("lib/walking-governance.ts");assert.match(source,/walking_commercial_packages/);assert.match(source,/walking_commercial_quotes/);assert.match(source,/Recurring Walking billing and cadence policy is not approved/);assert.match(source,/Walking post-service charging is not approved/);assert.match(source,/Walking coupon policy is not enabled/);assert.match(source,/exact future/);});

test("Walking commercial API is same-origin and explicitly UAT only",async()=>{const source=await read("app/api/walking-commercial/route.ts");assert.match(source,/Cross-origin Walking quote blocked/);assert.match(source,/canonical_walking_governance/);assert.match(source,/availabilityVerified:false/);assert.match(source,/liveAvailability:false/);assert.match(source,/liveMoney:false/);});

test("Walking client consumes canonical quote API",async()=>{const source=await read("lib/walking-commercial-client.ts");assert.match(source,/\/api\/walking-commercial/);assert.match(source,/createWalkingQuote/);assert.match(source,/paymentMode:input\.paymentMode\|\|"prepaid"/);});

test("Walking UI renders canonical quote truth and removes fake booking confirmation",async()=>{const page=await read("app/walking/page.tsx");assert.match(page,/createWalkingQuote/);assert.match(page,/loadWalkingCatalogue/);assert.match(page,/Canonical Walking quote/);assert.match(page,/Recurring schedule · policy pending/);assert.doesNotMatch(page,/PSW-4912/);assert.doesNotMatch(page,/selected\.price/);assert.doesNotMatch(page,/pay after each completed walk/i);});

test("Walking scheduler remains the next Gate 1 boundary",async()=>{const scheduling=await read("backend/src/scheduling.ts");assert.doesNotMatch(scheduling,/dog_walking/);const page=await read("app/walking/page.tsx");assert.match(page,/Scheduler \+ canonical booking wiring next/);});
