import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

// Workbook "Final testing 27th Sep", Taxi rows 1-6 (sheet rows 61-66). Source contracts on the owned Pet Taxi customer
// flow; rendered behaviour is exercised by tests/service-fix-ui.browser.cjs. Pricing, governance, service-area and
// scheduling libraries are untouched; where the backend has no policy (hourly packages, tolls) the flow says so.
import {installWorkersHooks} from "./helpers/module-hooks.mjs";
installWorkersHooks("__SERVICE_FIX_TAXI_DB__");
const read=path=>readFileSync(new URL("../"+path,import.meta.url),"utf8");
const flow=read("app/mobile-app/taxi-flow.tsx"),css=read("app/mobile-app/taxi-flow.module.css");

test("row 1: no City/Regular or Airport flat-fare choice; every fare is the actual-kilometre fare",()=>{
 assert.doesNotMatch(flow,/Airport flat fare|City \/ regular|setPurpose/);
 assert.match(flow,/const purpose:TaxiRidePurpose="regular";/);
 assert.match(flow,/All fares are calculated on the actual route kilometres\. There is no separate airport or city tariff\./);
 assert.match(flow,/ridePurpose:purpose/,"the quote request keeps the server contract");
 assert.doesNotMatch(flow,/<div><span>Purpose<\/span>/);
});

test("row 2: a round trip states that hourly packages are not configured instead of inventing package prices",()=>{
 assert.match(flow,/Round trips are priced on the actual route to your drop and return points, plus any planned waiting\. Fixed-hour packages are not offered yet\./);
 assert.doesNotMatch(flow,/admin|policy|internal/i,"no internal implementation language in customer copy");
 assert.doesNotMatch(flow,/200\/hour|25\/km|Rs\.\s?200|Rs\.\s?25/,"the workbook's example extra-hour and extra-km rates are not written into the flow");
 assert.match(flow,/tripType==="round_trip"&&<><span className=\{styles\.label\}>Return drop \/ Point 2<\/span>/,"drop and return points stay until a package policy exists");
});

test("rows 3 and 6: pickup address and PIN are chosen together at the trip step and checked early with the same consistency rule the server applies",()=>{
 assert.match(flow,/import \{loadCustomerAccount,type CustomerPet\} from "\.\.\/\.\.\/lib\/customer-account-client";/);
 assert.match(flow,/import \{serviceAddressConflict\} from "\.\.\/\.\.\/lib\/service-address-consistency";/);
 assert.match(flow,/<select aria-label="Saved pickup address"/);
 assert.match(flow,/setPickup\(serviceAddressText\(\{\.\.\.saved,postalCode:undefined\}\)\);setPincode\(String\(saved\.postalCode\|\|""\)\.replace\(\/\\D\/g,""\)\.slice\(0,6\)\);/,"one saved address fills both the label and the PIN");
 assert.match(flow,/resolveServiceCoverage\(pincode\)\.then\(coverage=>\{if\(!active\)return;const conflict=serviceAddressConflict\(pickup,coverage\.city,coverage\.pincode\);/);
 assert.match(flow,/disabled=\{!addressesValid\|\|!scheduledStart\|\|pincode\.length!==6\|\|!pickupVerified\}/,"Next waits for a completed, successful pickup check: checking, failed or unchecked cannot advance");
 assert.match(flow,/const pickupVerified=pickupCheck\?\.key===pickupKey&&pickupCheck\.status==="ok";/);
 // Validation is not removed: the reserve path still resolves coverage and sends the address and PIN to the scheduler.
 assert.match(flow,/const coverage=await resolveServiceCoverage\(pincode\);/);
 assert.match(flow,/serviceAddress:pickup\.trim\(\),servicePincode:pincode,vehicleClass:vehicle/);
 assert.doesNotMatch(flow,/<input aria-label="Pickup PIN code"[^>]*\/>[\s\S]*Choose your car/,"the PIN is no longer first asked on the car page");
});

test("row 4: parking is disclosed at actuals and no toll handling is claimed without a toll adjustment type",()=>{
 assert.match(flow,/Parking is added only if incurred, at the actual amount, to the final balance\./);
 assert.doesNotMatch(flow,/toll/i);
 const rules=read("lib/taxi-business-rules.ts");
 assert.doesNotMatch(rules,/"toll"/,"the business rules carry no toll adjustment, so the customer flow must not promise one");
});

test("row 5: the reserve call to action states the 50% payment explicitly",()=>{
 assert.match(flow,/`Reserve · then pay 50% booking fee \(\$\{money\(Number\(option\?\.bookingFee\|\|0\)\)\}\)`/);
 assert.match(flow,/<span>Pay now to confirm · 50% of the fare<\/span>/);
 assert.match(flow,/Pay 50% booking fee · \$\{money\(booking\.amountDueNow\)\}/);
});

test("back navigation sits at the top of every step and reuses the stage machine",()=>{
 assert.match(flow,/\{visibleStage>1&&visibleStage<5&&<button type="button" className=\{styles\.backTop\} onClick=\{\(\)=>\{if\(visibleStage===4\)setQuote\(null\);setStage\(visibleStage-1\);\}\}>← Back to/);
 assert.doesNotMatch(flow,/className=\{styles\.back\}/,"the small bottom back buttons are replaced, not duplicated");
 assert.match(css,/\.backTop\{display:inline-flex;align-items:center;min-height:44px;/);
 assert.match(flow,/useFlowHistory\("taxi",stage,setStage\)/,"browser back keeps working");
});

test("executes the consistency rule the flow applies early and the business rules it must not overstate",async()=>{
 const {serviceAddressConflict}=await import("../lib/service-address-consistency.ts");
 assert.equal(serviceAddressConflict("12, 5th Cross, HSR Layout, Bengaluru","Bengaluru","560102"),null,"a consistent pickup passes");
 assert.match(String(serviceAddressConflict("7, Marine Drive, Mumbai","Bengaluru","560102")),/names a different city from Bengaluru/);
 assert.match(String(serviceAddressConflict("12, 5th Cross, HSR Layout 560034","Bengaluru","560102")),/address and selected PIN code do not match/);
 const rules=await import("../lib/taxi-business-rules.ts");
 assert.deepEqual(Object.keys(rules.TAXI_VEHICLES),["citroen_ec3","xuv"]);
 for(const vehicle of Object.values(rules.TAXI_VEHICLES))assert.ok(!Object.keys(vehicle).some(key=>/toll|package|hourly/i.test(key)),"no toll, package or hourly tariff exists to disclose: "+vehicle.code);
 assert.throws(()=>rules.calculateTaxiAdjustment({vehicleClass:"xuv",type:"toll",amount:120}),"a toll adjustment is not a recognised adjustment type");
 assert.equal(rules.calculateTaxiAdjustment({vehicleClass:"xuv",type:"parking",amount:120}).amount,120,"parking is recorded at the actual amount");
});
