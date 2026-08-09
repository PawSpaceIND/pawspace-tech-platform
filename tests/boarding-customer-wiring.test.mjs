import test from"node:test";
import assert from"node:assert/strict";
import{readFile}from"node:fs/promises";
const read=path=>readFile(new URL(`../${path}`,import.meta.url),"utf8");

test("real Boarding customer route uses canonical commercial host scheduling booking and stay ledgers",async()=>{const page=await read("app/boarding/page.tsx");for(const token of["loadBoardingCommercial","quoteBoarding","reserveUatSchedule","createCanonicalBoardingBooking","loadCustomerBoardingStay","updateBoardingStay","serviceCode:\"boarding\"","preferredProviderId:selectedHost.providerId"])assert.equal(page.includes(token),true,token);for(const stale of["PSB-1048","const hosts: Host[]","Payment protected","Happy update"])assert.equal(page.includes(stale),false,stale)});

test("Boarding customer booking consumes the server quote with prepaid UAT-only payment truth",async()=>{const client=await read("lib/boarding-booking-client.ts");for(const token of["createCanonicalLifecycle","serviceCode:\"boarding\"","boardingQuoteId:quote.quoteId","mode:\"prepaid\"","status:\"captured\"","live money disabled","liveMoney:false"])assert.equal(client.includes(token),true,token)});

test("Boarding customer surface exposes canonical care-plan state without simulating host acceptance",async()=>{const page=await read("app/boarding/page.tsx");for(const token of["care_plan_status","submit_care_plan","Host acceptance is a separate governed provider action","existing Boarding lifecycle APIs"])assert.equal(page.includes(token),true,token)});
