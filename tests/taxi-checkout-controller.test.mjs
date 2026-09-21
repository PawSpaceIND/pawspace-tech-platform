import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {installWorkersHooks} from "./helpers/module-hooks.mjs";
installWorkersHooks("__TAXI_CHECKOUT_DB__");
const {CustomerCheckoutController}=await import("../lib/customer-checkout-client.ts");
const {openMobileRazorpayCheckout}=await import("../lib/mobile/razorpay.ts");
const locks={PAWSPACE_PAYMENT_ENV:"sandbox",FORBID_PRODUCTION:"true",PAWSPACE_PAYMENT_LIVE_APPROVED:"false"};

test("Taxi uses the common checkout contract rather than calling the SDK without verified locks",()=>{
 const source=fs.readFileSync(new URL("../app/mobile-app/taxi-flow.tsx",import.meta.url),"utf8");
 assert.match(source,/new CustomerCheckoutController\(paymentBookingId/);
 assert.match(source,/await controller.start\(\)/);
 assert.doesNotMatch(source,/openMobileRazorpayCheckout|\/api\/payment-order/);
 assert.match(source,/state.phase==="captured"&&state.confirmation\?\.bookingId===paymentBookingId&&state.confirmation.status==="confirmed"/);
});

test("Taxi half-payment reaches the actual SDK with server locks and dismissal cannot create another order",async t=>{
 const oldWindow=globalThis.window;let opened=0,amount;const calls=[],states=[];
 globalThis.window={location:{origin:"https://qa.pawspace.test",pathname:"/v2/taxi"},Razorpay:class{
  constructor(options){this.options=options;amount=options.amount;}on(){}open(){opened++;this.options.modal.ondismiss();}
 }};
 t.after(()=>{if(oldWindow===undefined)delete globalThis.window;else globalThis.window=oldWindow;});
 const controller=new CustomerCheckoutController("TAXI-QA",state=>states.push(state),{
  open:openMobileRazorpayCheckout,
  fetch:async(url,options)=>{
   assert.equal(url,"/api/customer-checkout");const body=JSON.parse(options.body);calls.push(body);
   assert.equal(body.bookingId,"TAXI-QA");
   return Response.json({data:body.action==="start"?{connected:true,environment:"sandbox",bookingId:"TAXI-QA",orderId:"order_taxiFixture",keyId:"rzp_test_taxiFixture",amountPaise:33750,currency:"INR",locks}:{bookingId:"TAXI-QA",environment:"sandbox",status:"awaiting_confirmation"}});
  }
 });
 await controller.start();assert.equal(opened,1);assert.equal(amount,33750);assert.equal(states.at(-1).phase,"pending");
 await controller.start();assert.equal(opened,1);assert.deepEqual(calls.map(c=>c.action),["start","status"]);
 assert.equal(states.at(-1).phase,"pending");assert.ok(!states.some(s=>s.phase==="captured"));
});

test("Taxi checkout still refuses a response without explicit sandbox locks",async()=>{
 let opened=false;const states=[];
 const controller=new CustomerCheckoutController("TAXI-QA",state=>states.push(state),{open:async()=>{opened=true;throw Error("must not open");},fetch:async()=>Response.json({data:{connected:true,environment:"sandbox",bookingId:"TAXI-QA",orderId:"order_taxiFixture",keyId:"rzp_test_taxiFixture",amountPaise:33750,currency:"INR"}})});
 await controller.start();assert.equal(opened,false);assert.equal(states.at(-1).phase,"error");
});
