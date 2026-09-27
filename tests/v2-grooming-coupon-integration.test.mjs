import test from "node:test";
import assert from "node:assert/strict";
import { setupJourney, sessionCookie } from "./helpers/grooming-journey-harness.mjs";
import { seedOwnedPet } from "./helpers/saved-pet-fixture.mjs";
import { enterWorkersDbScope } from "./helpers/module-hooks.mjs";

// Actual V2 client -> HTTP handlers -> SQLite-backed transactional D1, without an external gateway.
for (const scenario of [
  {name:"percentage with extras",base:1899,extras:["Tick & flea treatment"],rate:10,gross:2398,discount:239.8,final:2158.2},
  {name:"half-paise percentage rounding",base:1899,extras:[],rate:12.5,gross:1899,discount:237.38,final:1661.62},
]) test(`V2 real coupon integration: ${scenario.name}`,async t=>{
  const ctx=await setupJourney();t.after(ctx.close);enterWorkersDbScope(ctx.db);
  const {db,sqlite}=ctx;
  await seedOwnedPet(db,"CUST-V2-COUPON","PET-V2-COUPON","Bruno");
  const cookie=await sessionCookie(db,"customer","CUST-V2-COUPON","customer:CUST-V2-COUPON");
  const routes={
    "/api/v2/grooming-catalogue":"../app/api/v2/grooming-catalogue/route.ts",
    "/api/service-zone":"../app/api/service-zone/route.ts",
    "/api/live-price-quote":"../app/api/live-price-quote/route.ts",
    "/api/uat-scheduling":"../app/api/uat-scheduling/route.ts",
    "/api/canonical-bookings":"../app/api/canonical-bookings/route.ts",
    "/api/grooming-service-location":"../app/api/grooming-service-location/route.ts",
    "/api/coupon-governance":"../app/api/coupon-governance/route.ts",
    "/api/v2/grooming-checkout":"../app/api/v2/grooming-checkout/route.ts",
  };
  t.mock.method(globalThis,"fetch",async(path,init={})=>{
    const url=new URL(String(path),"https://pawspace.test"),modulePath=routes[url.pathname];
    assert.ok(modulePath,`External network is forbidden: ${url.pathname}`);
    const route=await import(modulePath),method=init.method||"GET";
    return route[method](new Request(url,{...init,method,headers:{...init.headers,cookie,origin:url.origin}}));
  });
  const care=await import("../lib/v2/grooming-client.ts");
  const checkout=await import("../lib/v2/grooming-checkout-client.ts");
  await care.loadV2GroomingCatalogue();
  sqlite.prepare("UPDATE service_packages SET active=1,base_price=? WHERE package_code='dog-basic'").run(scenario.base);
  const pkg=(await care.loadV2GroomingCatalogue()).packages[0],bundle=pkg.bundles[0];
  const {saveCouponCampaign}=await import("../lib/coupon-governance.ts");
  const now=Date.now();
  await saveCouponCampaign(db,{id:"v2-coupon",code:"V2EXACT",name:"V2 exact basket test",status:"active",serviceCodes:["grooming"],cityIds:["blr"],channels:["website"],customerKinds:["new","existing"],packageScope:"selected",packageCodes:["dog-basic"],crossSellFromServices:[],firstOrderOnly:false,minOrder:1,maxOrder:null,subscriptionEligible:false,fullPaymentOnly:true,discountType:"percent",discountValue:scenario.rate,maxDiscount:500,perCustomerLimit:5,totalLimit:10,validFrom:now-60000,validUntil:now+3600000,customerIds:["CUST-V2-COUPON"]});
  const coverage=await care.resolveV2GroomingCoverage("560038"),isoDate=new Date(now+7*86400000).toISOString().slice(0,10);
  const priced=await care.quoteV2Grooming({bundle,isoDate,slotIndex:1,cityId:coverage.cityId,zoneId:coverage.zoneId});
  assert.equal(priced.quote.price,scenario.base,"test must use the actual governed package price");
  const address="21 Indiranagar Main Road, Bengaluru";
  const preview=await care.previewV2Groomers({customerId:"CUST-V2-COUPON",petIds:["PET-V2-COUPON"],cityId:coverage.cityId,zoneId:coverage.zoneId,serviceAddress:address,servicePincode:coverage.pincode,scheduledStart:priced.scheduledStart,scheduledEnd:priced.scheduledEnd});
  assert.ok(preview.providers.length);
  const pet={id:"PET-V2-COUPON",sourceId:"PET-V2-COUPON",name:"Bruno",species:"dog",vaccinationStatus:"verified"};
  const input={account:{customerId:"CUST-V2-COUPON",name:"V2 Coupon QA",primaryPhone:"9000000982",pets:[pet]},selectedPets:[pet],pkg,bundle,quote:priced.quote,provider:preview.providers[0],address,pincode:coverage.pincode,cityId:coverage.cityId,zoneId:coverage.zoneId,scheduledStart:priced.scheduledStart,scheduledEnd:priced.scheduledEnd,addOns:scenario.extras,coupon:{quoteId:"requote-before-reserving",code:"V2EXACT",discount:999}};
  const booked=await checkout.createV2GroomingBooking(input);
  const booking=sqlite.prepare("SELECT total_amount,pricing_json FROM canonical_bookings WHERE id=?").get(booked.bookingId);
  const payment=sqlite.prepare("SELECT amount,amount_due_now FROM booking_payments WHERE booking_id=?").get(booked.bookingId);
  assert.equal(booking.total_amount,scenario.final);assert.equal(payment.amount,scenario.final);assert.equal(payment.amount_due_now,scenario.final);
  const pricing=JSON.parse(booking.pricing_json);assert.equal(pricing.discount,scenario.discount);
  const coupon=sqlite.prepare("SELECT order_value,discount_amount,final_amount,status FROM coupon_quotes WHERE id=?").get(pricing.couponQuoteId);
  assert.deepEqual({...coupon},{order_value:scenario.gross,discount_amount:scenario.discount,final_amount:scenario.final,status:"consumed"});
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM coupon_redemptions WHERE booking_id=?").get(booked.bookingId).n,1);
  assert.equal((await checkout.createV2GroomingBooking(input)).bookingId,booked.bookingId);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM canonical_bookings WHERE customer_id='CUST-V2-COUPON'").get().n,1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM coupon_redemptions WHERE customer_id='CUST-V2-COUPON'").get().n,1);
});
