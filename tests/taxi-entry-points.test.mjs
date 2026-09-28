import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {calculateTaxiFare} from "../lib/taxi-business-rules.ts";
import {checkSchedules,inr2} from "../e2e/master/suites/_60-transactions-audit-helpers.mjs";
const read=(p)=>fs.readFileSync(new URL(`../${p}`,import.meta.url),"utf8");
const assisted=read("app/assisted-booking/assisted-taxi-panel.tsx");
const assistedPage=read("app/assisted-booking/page.tsx");
const rideRoute=read("app/api/taxi-ride-bookings/route.ts");
const taxiFlow=read("app/mobile-app/taxi-flow.tsx");
const mobile=read("app/mobile-app/page.tsx");
const boarding=read("app/mobile-app/boarding-customer-stay-panel.tsx");
const stay=read("app/mobile-app/stay-flow.tsx");

test("staff-assisted Taxi reuses v2 quote scheduler and canonical booking",()=>{
 assert.match(assisted,/createTaxiRideQuote/);assert.match(assisted,/reserveTaxiSchedule/);assert.match(assisted,/createCanonicalTaxiRideBooking/);
 assert.match(assisted,/channel:"assisted_staff"/);assert.match(assisted,/assistedConsent:\{method:consentMethod,reference:consentReference\.trim\(\)\}/);
 assert.match(assisted,/50% booking-fee gate/);assert.match(assisted,/Create payment-pending Taxi/);assert.doesNotMatch(assisted,/status:\s*"confirmed"/);
 assert.match(assisted,/serviceAddress:pickup\.trim\(\),servicePincode:pincode,vehicleClass:vehicle/);
 assert.match(assistedPage,/AssistedTaxiPanel/);
});

test("assisted Taxi requires consent evidence at the server boundary",()=>{
 assert.match(rideRoute,/channel==="assisted_staff"/);assert.match(rideRoute,/Assisted Pet Taxi requires customer consent evidence/);
 assert.match(rideRoute,/assistedConsent:channel==="assisted_staff"\?input\.assistedConsent\|\|null:null/);
});

test("Boarding cross-sell carries a real source booking into the same Taxi flow",()=>{
 assert.match(boarding,/service=pet_taxi&sourceBookingId=/);assert.match(stay,/service=pet_taxi&sourceBookingId=/);
 assert.match(mobile,/useQueryParameter\("service"\)/);assert.match(mobile,/useQueryParameter\("sourceBookingId"\)/);
 assert.match(mobile,/TaxiFlow customer=\{customer\} sourceBookingId=\{sourceBookingId\}/);
 assert.match(taxiFlow,/channel:sourceBookingId\?"boarding_cross_sell":"customer_app"/);assert.match(taxiFlow,/sourceBookingId:sourceBookingId\|\|undefined/);
});

test("Boarding cross-sell source is server-verified, never trusted from the browser",()=>{
 assert.match(rideRoute,/channel==="boarding_cross_sell"/);assert.match(rideRoute,/SELECT customer_id,service_code FROM canonical_bookings WHERE id=\?/);
 assert.match(rideRoute,/String\(source\.customer_id\)!==input\.customer\.id\|\|String\(source\.service_code\)!=="boarding"/);
 assert.match(rideRoute,/Boarding cross-sell source booking is invalid/);
});


test("entry-point coverage executes the same Taxi fare engine used by every channel",()=>{
 const fare=calculateTaxiFare({vehicleClass:"citroen_ec3",tripType:"one_way",ridePurpose:"regular",passengerCount:1,petCount:1,luggageCount:0,distanceKm:5,waitingMinutes:0});
 assert.equal(fare.quotedTotal,500);assert.equal(fare.bookingFee,250);
});


test("cancelled unpaid Taxi is a valid terminal schedule state",()=>{
 const fact={service:"pet_taxi",paymentId:"PAY-SYNTHETIC",b:{payment_amount:868.25,amount_due_now:434.13,payment_mode:"split_50_50",booking_status:"cancelled",payment_status:"cancelled"},taxi:{total_amount:868.25,booking_fee_amount:434.13,balance_amount:434.12,status:"cancelled"},captures:[],capturedSum:0,sandboxCaptured:false,saved:{balancePaid:false}};
 assert.deepEqual(checkSchedules(fact),[]);
});

test("finance assertions preserve paise instead of rounding to whole rupees",()=>{
 assert.equal(inr2(531.85),"₹531.85");
 assert.equal(inr2(265.92),"₹265.92");
});
