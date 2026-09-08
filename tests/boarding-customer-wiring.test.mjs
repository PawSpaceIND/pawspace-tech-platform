import test from"node:test";
import assert from"node:assert/strict";
import{readFile}from"node:fs/promises";
const read=path=>readFile(new URL(`../${path}`,import.meta.url),"utf8");

test("real Boarding entry delegates to owned shared commercial, scheduling and care flow",async()=>{const page=await read("app/boarding/page.tsx"),entry=await read("app/mobile-app/stay-booking-page.tsx"),flow=await read("app/mobile-app/stay-flow.tsx");assert.match(page,/<StayBookingPage mode="boarding"/);assert.match(entry,/loadCustomerAccount\(undefined/);assert.match(entry,/<StayFlow/);for(const token of["loadBoardingCommercial","quoteBoarding","reserveUatSchedule","createCanonicalLifecycle","saveCustomerBoardingCare","preferredProviderId:mode===\"boarding\"?governedHost?.providerId"])assert.equal(flow.includes(token),true,token);for(const stale of["PSB-1048","const hosts: Host[]","Payment protected","Happy update","UAT secondary contact"])assert.equal(page.includes(stale),false,stale)});

test("Boarding customer booking consumes the server quote with the server quote payment mode and UAT-only payment truth",async()=>{const client=await read("lib/boarding-booking-client.ts");for(const token of["createCanonicalLifecycle","serviceCode:\"boarding\"","boardingQuoteId:quote.quoteId","mode:quote.paymentMode","status:\"captured\"","live money disabled","liveMoney:false"])assert.equal(client.includes(token),true,token)});

test("Boarding customer surface exposes recorded care state and preserves host acceptance",async()=>{const panel=await read("app/mobile-app/boarding-customer-stay-panel.tsx"),client=await read("lib/boarding-customer-care.ts");assert.match(panel,/care_plan_status/);assert.match(panel,/awaiting_host_acceptance/);assert.match(panel,/saveCustomerBoardingCare/);assert.match(client,/submit_care_plan/);});
