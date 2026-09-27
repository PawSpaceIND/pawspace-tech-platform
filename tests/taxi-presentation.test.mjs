import test from "node:test";
import assert from "node:assert/strict";
import {taxiMoney,taxiRouteNotice} from "../lib/taxi-presentation.ts";
import {calculateTaxiFare} from "../lib/taxi-business-rules.ts";

test("odd-rupee Taxi fares display the two exact half payments",()=>{
 const fare=calculateTaxiFare({vehicleClass:"citroen_ec3",tripType:"one_way",ridePurpose:"regular",passengerCount:1,petCount:1,luggageCount:0,distanceKm:10,waitingMinutes:0});
 assert.equal(fare.quotedTotal,675);
 assert.equal(fare.bookingFee,337.5);
 assert.equal(fare.finalBalanceBeforeAdjustments,337.5);
 assert.equal(taxiMoney(fare.quotedTotal),"₹675");
 // Paise are always shown to two places (round 2: "₹722.8", "₹1,561.2").
 assert.equal(taxiMoney(fare.bookingFee),"₹337.50");
 assert.equal(taxiMoney(fare.finalBalanceBeforeAdjustments),"₹337.50");
 assert.equal(taxiMoney(1234.56),"₹1,234.56");
});

test("round 2: Taxi prices show paise to two places, whole rupees without, and never ₹NaN",()=>{
 assert.equal(taxiMoney(722.8),"₹722.80");
 assert.equal(taxiMoney(1561.2),"₹1,561.20");
 assert.equal(taxiMoney(633.02),"₹633.02");
 assert.equal(taxiMoney(600),"₹600");
 assert.equal(taxiMoney(0),"₹0");
 // The ride manage page reads amounts from D1; it rounded them to whole rupees (₹607 · ₹304 · ₹304).
 assert.deepEqual([607.45,303.73,303.72].map(taxiMoney),["₹607.45","₹303.73","₹303.72"]);
 assert.equal(taxiMoney("303.73"),"₹303.73","a numeric string from a row is still an amount");
 // A missing amount is a dash, not "₹NaN" (the replayed Reserve answer carried no balance) or a made-up ₹0.
 for(const missing of [undefined,null,"",Number.NaN,"abc"])assert.equal(taxiMoney(missing),"—");
});

test("Taxi quote provenance distinguishes fallback test values from Google sandbox routing",()=>{
 assert.match(taxiRouteNotice("sandbox_route_fallback"),/test values, not a measured route/);
 assert.doesNotMatch(taxiRouteNotice("sandbox_route_fallback"),/Google/);
 assert.match(taxiRouteNotice("google_routes_uat"),/Google Routes sandbox estimate/);
 assert.match(taxiRouteNotice("unrecognized"),/not production verified/);
});
