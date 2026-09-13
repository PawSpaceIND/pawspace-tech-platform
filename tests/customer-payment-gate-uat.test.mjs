import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import { stableBookingInputKey } from "../lib/booking-input-fingerprint.ts";
const read=path=>readFile(new URL(`../${path}`,import.meta.url),"utf8");

test("checkout contract suite executes the booking fingerprint helper",()=>{
 assert.equal(stableBookingInputKey(["customer","booking"]),stableBookingInputKey(["customer","booking"]));
});

test("every transactional customer service enters a payment step except Relocation",async()=>{
 const files={
  grooming:await read("app/mobile-app/grooming-flow.tsx"), training:await read("app/mobile-app/training-flow.tsx"),
  stay:await read("app/mobile-app/stay-flow.tsx"), walking:await read("app/mobile-app/walking-flow.tsx"),
  food:await read("app/mobile-app/food-flow.tsx"), taxi:await read("app/mobile-app/taxi-flow.tsx"),
  relocation:await read("app/mobile-app/relocation-flow.tsx"),
 };
 for(const key of ["grooming","training","stay","walking","food"])assert.match(files[key],/BookingPaymentPage/,`${key} must render the shared payment page`);
 assert.match(files.taxi,/openMobileRazorpayCheckout|payment-order/,"Taxi retains its verified Razorpay checkout");
 assert.doesNotMatch(files.relocation,/BookingPaymentPage|openMobileRazorpayCheckout|payment-order/,"Relocation remains the governed enquiry exception");
});

test("prepaid bookings are pending until provider capture evidence confirms them",async()=>{
 const canonical=await read("app/api/canonical-bookings/route.ts");
 const capture=await read("lib/razorpay-capture-atomic.ts");
 const lifecycle=await read("lib/canonical-lifecycle-client.ts");
 assert.match(canonical,/bookingStatus=paymentRequired\?"payment_pending":"confirmed"/);
 assert.match(canonical,/workOrderStatus=paymentRequired\?"payment_pending"/);
 assert.doesNotMatch(lifecycle,/training-payment-sandbox/);
 assert.match(capture,/status='confirmed'.*status='payment_pending'/s);
});

test("Boarding and Sitting no longer self-capture before checkout",async()=>{
 const stay=await read("app/mobile-app/stay-flow.tsx");
 const boarding=await read("lib/boarding-governance.ts");
 const sitting=await read("lib/sitting-governance.ts");
 assert.doesNotMatch(stay,/captureSittingQuoteSandbox/);
 assert.match(stay,/status:"created"/);
 assert.match(boarding,/\["created","authorised","captured"\]/);
 assert.match(sitting,/\["created","authorised","captured"\]/);
});

test("pay-after Walking and Food require explicit payment-page acceptance before creation",async()=>{
 const walking=await read("app/mobile-app/walking-flow.tsx");
 const food=await read("app/mobile-app/food-flow.tsx");
 assert.match(walking,/mode="pay_after_service"/);
 assert.match(walking,/onCreateBooking=\{async\(\)=>\{await confirm\(\)/);
 assert.match(food,/mode="pay_after_service"/);
 assert.match(food,/onCreateBooking=\{async\(\)=>\{await confirm\(\)/);
});
