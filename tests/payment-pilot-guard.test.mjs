import assert from "node:assert/strict";
import test from "node:test";
import{enforcePilotBooking,pilotAllowlistReadiness}from"../lib/payment-pilot-guard.ts";

const ids=Array.from({length:5},(_,i)=>`PILOT-${i+1}`).join(",");
const live={PAWSPACE_PAYMENT_ENV:"live",PAWSPACE_PAYMENT_LIVE_APPROVED:"true",PAWSPACE_PAYMENT_PILOT_BOOKING_IDS:ids};

test("pilot guard is transparent outside live mode",()=>{assert.equal(enforcePilotBooking({},"sandbox","ANY").ok,true);});
test("pilot guard fails closed when live approval is absent",()=>{assert.equal(enforcePilotBooking({...live,PAWSPACE_PAYMENT_LIVE_APPROVED:"false"},"live","PILOT-1").ok,false);});
test("pilot guard requires 5-20 unique valid booking IDs",()=>{
 assert.equal(pilotAllowlistReadiness({...live,PAWSPACE_PAYMENT_PILOT_BOOKING_IDS:"PILOT-1"}).configured,false);
 assert.equal(pilotAllowlistReadiness({...live,PAWSPACE_PAYMENT_PILOT_BOOKING_IDS:"PILOT-1,PILOT-1,PILOT-2,PILOT-3,PILOT-4"}).configured,false);
 assert.equal(pilotAllowlistReadiness(live).count,5);
});
test("pilot guard permits only allowlisted booking traffic",()=>{
 assert.deepEqual(enforcePilotBooking(live,"live","PILOT-1"),{ok:true,bookingId:"PILOT-1"});
 const denied=enforcePilotBooking(live,"live","OUTSIDE-1");assert.equal(denied.ok,false);assert.match(denied.reason,/outside the controlled/);
 assert.equal(enforcePilotBooking(live,"live","").ok,false);
});
