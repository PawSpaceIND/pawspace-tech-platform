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
 assert.equal(taxiMoney(fare.bookingFee),"₹337.5");
 assert.equal(taxiMoney(fare.finalBalanceBeforeAdjustments),"₹337.5");
 assert.equal(taxiMoney(1234.56),"₹1,234.56");
});

test("Taxi quote provenance distinguishes fallback test values from Google sandbox routing",()=>{
 assert.match(taxiRouteNotice("sandbox_route_fallback"),/test values, not a measured route/);
 assert.doesNotMatch(taxiRouteNotice("sandbox_route_fallback"),/Google/);
 assert.match(taxiRouteNotice("google_routes_uat"),/Google Routes sandbox estimate/);
 assert.match(taxiRouteNotice("unrecognized"),/not production verified/);
});
