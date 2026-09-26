/*
 * QA finding M4: a customer reschedule never re-priced the booking and only ever tried the groomer
 * already on it.
 *
 *   - Moving a Bath & Basic booking to another slot answered "The assigned provider is no longer
 *     available for that slot" instead of trying the other groomers who serve that zone.
 *   - The reschedule route had no live-price step, so a weekday -8% booking moved into a +15% weekend
 *     slot silently kept the lower price.
 *
 * Owner decision: a new slot that costs the same or less keeps the paid price (the difference is not
 * refunded); a slot that costs more is NOT moved and nothing is charged until the customer approves
 * and pays the difference. When the assigned groomer cannot take the new slot, another eligible
 * groomer in the same zone is tried; the move is refused only when nobody is available.
 *
 * Every test runs the real route handlers on in-memory node:sqlite through the grooming journey
 * harness: real scheduling, booking, signature-verified sandbox capture and the real change route.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {setupJourney,runCompletedJourney,routeCall,sessionCookie} from "./helpers/grooming-journey-harness.mjs";

const IST_MS=330*60_000;
const istDay=iso=>new Date(Date.parse(iso)+IST_MS).getUTCDay();
const istDate=iso=>new Date(Date.parse(iso)+IST_MS).toISOString().slice(0,10);
const CHANGE_ROUTE="../../app/api/grooming-booking-change/route.ts";

/** Publishes Pricing Control for dog-basic: the base price plus percent rules keyed on IST weekdays. */
async function publishPricing(ctx,{basePrice,rules}){
 const {ensurePricingControlRuntime}=await import("../lib/pricing-control-runtime.ts");
 await ensurePricingControlRuntime(ctx.db);
 ctx.sqlite.prepare("UPDATE service_packages SET active=1,base_price=?,effective_from='2020-01-01',effective_to=NULL WHERE package_code='dog-basic'").run(basePrice);
 const insert=ctx.sqlite.prepare("INSERT INTO dynamic_pricing_rules (id,name,service_code,package_code,city_id,zone_id,rule_type,days_json,start_time,end_time,effective_from,effective_to,adjustment_type,adjustment_value,coupon_policy,priority,status,version,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
 for(const rule of rules)insert.run(rule.id,rule.name,"grooming","dog-basic","blr",null,rule.type,JSON.stringify([rule.day]),null,null,"2020-01-01",null,"percent",rule.percent,"stackable",10,"published",1,"reschedule-test",Date.now());
}

function tableExists(sqlite,name){return Boolean(sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));}
function count(sqlite,table,where,...args){return tableExists(sqlite,table)?sqlite.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${where}`).get(...args).n:0;}

async function journey(t,{id,pricing}={}){
 const ctx=await setupJourney();t.after(ctx.close);
 const start=new Date(Date.now()+3*86_400_000);start.setUTCHours(3,30,0,0); // 09:00 IST
 const target=new Date(start.getTime()+86_400_000);                           // 09:00 IST, the next day
 if(pricing)await pricing(ctx,{start:start.toISOString(),target:target.toISOString()});
 const config={customerId:`CUST-M4-${id}`,customerName:"Mira",phone:"+919900000616",petSourceId:`PET-M4-${id}`,petName:"Milo",cityId:"blr",zoneId:"blr-east",pincode:"560038",latitude:12.9716,longitude:77.5946,preferredProviderId:"groom_arun",groupId:`GROOM-M4-${id}`,start:start.toISOString(),stopAfterCapture:true};
 const result=await runCompletedJourney(ctx,config);
 assert.equal(result.booked.status,201,JSON.stringify(result.booked.body));
 assert.ok([200,201].includes(result.captured.status),JSON.stringify(result.captured.body));
 assert.equal(ctx.sqlite.prepare("SELECT status FROM booking_payments WHERE booking_id=?").get(result.bookingId).status,"captured","the booking is paid through the signature-verified sandbox capture");
 assert.equal(result.provider.id,"groom_arun");
 const groupId=config.groupId,bookingId=result.bookingId;
 const input={bookingId,customerId:config.customerId,action:"reschedule",reason:"Customer needs another day",scheduledStart:target.toISOString(),scheduledEnd:new Date(target.getTime()+7_200_000).toISOString()};
 const call=(body=input)=>routeCall(CHANGE_ROUTE,"POST","/api/grooming-booking-change",body,result.customerCookie);
 const {sqlite}=ctx;
 const snapshot=()=>({
  booking:{...sqlite.prepare("SELECT scheduled_start,scheduled_end,status,provider_id,total_amount,pricing_json,updated_at FROM canonical_bookings WHERE id=?").get(bookingId)},
  work:{...sqlite.prepare("SELECT scheduled_start,scheduled_end,status,provider_id,provider_name,provider_model,updated_at FROM provider_work_orders WHERE booking_id=?").get(bookingId)},
  reservations:sqlite.prepare("SELECT provider_id,scheduled_start,scheduled_end,status FROM scheduling_reservations WHERE group_id=? ORDER BY id").all(groupId).map(row=>({...row})),
  decision:{...sqlite.prepare("SELECT selected_provider_id,status FROM scheduling_assignment_decisions WHERE group_id=?").get(groupId)},
  payments:sqlite.prepare("SELECT * FROM booking_payments WHERE booking_id=?").all(bookingId).map(row=>({...row})),
  gatewayLinks:count(sqlite,"payment_gateway_links","booking_id=?",bookingId),
  gatewayEvents:count(sqlite,"payment_gateway_events","booking_id=?",bookingId),
  refundCases:count(sqlite,"booking_refund_cases","booking_id=?",bookingId),
  postServiceRequests:count(sqlite,"post_service_payment_requests","booking_id=?",bookingId),
  offers:tableExists(sqlite,"provider_assignment_offers")?sqlite.prepare("SELECT provider_id,status FROM provider_assignment_offers WHERE group_id=?").all(groupId).map(row=>({...row})):[],
  events:sqlite.prepare("SELECT event_type FROM booking_lifecycle_events WHERE booking_id=? ORDER BY occurred_at,id").all(bookingId).map(row=>row.event_type),
  audits:count(sqlite,"security_audit_events","resource_id=? AND action='grooming.reschedule'",bookingId),
 });
 const rescheduledEvent=()=>{const row=sqlite.prepare("SELECT detail_json FROM booking_lifecycle_events WHERE booking_id=? AND event_type='booking_rescheduled' ORDER BY occurred_at DESC LIMIT 1").get(bookingId);return row?JSON.parse(row.detail_json):null;};
 return {...ctx,result,config,groupId,bookingId,start:start.toISOString(),target:target.toISOString(),input,call,snapshot,rescheduledEvent};
}

/** A competing reservation in another group occupies the provider at the requested slot. */
function occupy(f,providerId,startIso,endIso){
 f.sqlite.prepare("INSERT INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,care_mode,status,explanation_json,created_at) VALUES (?,?,?,'grooming','blr','blr-east','OTHER-CUSTOMER','[]',?,?,1,1,NULL,'assigned','{}',?)").run(`BUSY-${providerId}`,`OTHER-GROUP-${providerId}`,providerId,startIso,endIso,Date.now());
}
/** Active leave covering the requested window. */
function onLeave(f,providerId,startIso,endIso){
 f.sqlite.prepare("INSERT INTO provider_unavailability (id,provider_id,starts_at,ends_at,reason,status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,'active','ops@pawspace.test',?,?)").run(`LEAVE-${providerId}`,providerId,startIso,endIso,"Planned leave",Date.now(),Date.now());
}

test("QA M4: a weekday -8% booking moved into a +15% slot is not moved and nothing is charged",async t=>{
 const f=await journey(t,{id:"UP",pricing:(ctx,{start,target})=>publishPricing(ctx,{basePrice:2064,rules:[
  {id:"M4-WEEKDAY-SAVER",name:"Weekday saver",type:"weekday",day:istDay(start),percent:-8},
  {id:"M4-WEEKEND-SURGE",name:"Weekend surge",type:"weekend",day:istDay(target),percent:15},
 ]})});
 const before=f.snapshot();
 assert.equal(before.booking.total_amount,1899,"booked at the governed weekday price: round(2064 x 0.92)");
 assert.equal(before.payments[0].status,"captured");assert.equal(before.payments[0].amount,1899);

 const response=await f.call();
 assert.equal(response.status,409,JSON.stringify(response.body));
 assert.equal(response.body.code,"reschedule_price_increase");
 assert.equal(response.body.priceDifference,475,"round(2064 x 1.15)=2374, less the 1899 booked price");
 assert.equal(response.body.bookedAmount,1899);
 assert.equal(response.body.newSlotAmount,2374);
 assert.equal(response.body.currency,"INR");
 assert.equal(response.body.bookingUnchanged,true);
 assert.equal(response.body.charged,false);
 assert.match(response.body.error,/₹475 more/);
 assert.match(response.body.error,/has not been moved/);
 assert.match(response.body.error,/nothing has been charged/i);
 assert.deepEqual(f.snapshot(),before,"a price increase moves nothing, charges nothing and records nothing as paid");
});

test("a +15% booking moved into a -8% slot keeps the paid price and records the new quote",async t=>{
 const f=await journey(t,{id:"DOWN",pricing:(ctx,{start,target})=>publishPricing(ctx,{basePrice:1651,rules:[
  {id:"M4-PEAK",name:"Peak day",type:"weekend",day:istDay(start),percent:15},
  {id:"M4-QUIET",name:"Quiet day",type:"weekday",day:istDay(target),percent:-8},
 ]})});
 const before=f.snapshot();
 assert.equal(before.booking.total_amount,1899,"booked at round(1651 x 1.15)");

 const response=await f.call();
 assert.equal(response.status,200,JSON.stringify(response.body));
 const after=f.snapshot();
 assert.equal(after.booking.scheduled_start,f.input.scheduledStart);
 assert.equal(after.work.scheduled_start,f.input.scheduledStart);
 assert.ok(after.reservations.every(row=>row.scheduled_start===f.input.scheduledStart&&row.provider_id==="groom_arun"));
 assert.equal(after.booking.total_amount,1899,"the stored price is kept");
 assert.equal(after.booking.pricing_json,before.booking.pricing_json);
 assert.deepEqual(after.payments,before.payments,"the payment is untouched: no partial refund of the difference");
 assert.equal(after.refundCases,0);
 assert.equal(response.body.data.providerChanged,false);
 assert.equal(response.body.data.pricing.priceDifference,-380);

 const detail=f.rescheduledEvent();
 assert.ok(detail,"the reschedule is recorded");
 assert.equal(detail.pricing.basis,"governed_quote");
 assert.equal(detail.pricing.bookedAmount,1899);
 assert.equal(detail.pricing.newSlotAmount,1519,"round(1651 x 0.92)");
 assert.equal(detail.pricing.priceDifference,-380);
 assert.equal(detail.pricing.storedPriceKept,true);
 assert.equal(detail.pricing.differenceRefunded,false);
 assert.equal(detail.pricing.quote.packageCode,"dog-basic");
 assert.equal(detail.pricing.quote.totalAmount,1519);
 assert.equal(detail.pricing.quote.scheduledStart,f.input.scheduledStart);
 assert.equal(detail.providerId,"groom_arun");
 assert.equal(detail.providerChanged,false);
});

test("a same-price move stays with the assigned groomer and records a zero difference",async t=>{
 const f=await journey(t,{id:"SAME"});
 const before=f.snapshot(),response=await f.call();
 assert.equal(response.status,200,JSON.stringify(response.body));
 const after=f.snapshot(),detail=f.rescheduledEvent();
 assert.equal(after.booking.provider_id,"groom_arun");
 assert.equal(after.booking.total_amount,before.booking.total_amount);
 assert.deepEqual(after.payments,before.payments);
 assert.equal(detail.pricing.priceDifference,0);
 assert.equal(detail.pricing.newSlotAmount,1899);
 assert.equal(detail.pricing.storedPriceKept,true);
});

test("QA M4: when the assigned groomer is busy, another eligible groomer in the zone takes the new slot",async t=>{
 const f=await journey(t,{id:"SWAP"});
 occupy(f,"groom_arun",f.input.scheduledStart,f.input.scheduledEnd);
 onLeave(f,"groom_kiran",`${istDate(f.target)}T00:00:00.000Z`,new Date(Date.parse(f.target)+86_400_000).toISOString());
 const before=f.snapshot();

 const response=await f.call();
 assert.equal(response.status,200,JSON.stringify(response.body));
 assert.equal(response.body.data.providerChanged,true);
 assert.equal(response.body.data.previousProviderId,"groom_arun");
 assert.equal(response.body.data.providerId,"groom_sanjay");
 assert.equal(response.body.data.provider.name,"Sanjay P.");

 const after=f.snapshot();
 assert.deepEqual({provider:after.booking.provider_id,status:after.booking.status,start:after.booking.scheduled_start},{provider:"groom_sanjay",status:"assigned",start:f.input.scheduledStart});
 assert.deepEqual({provider:after.work.provider_id,name:after.work.provider_name,model:after.work.provider_model,status:after.work.status,start:after.work.scheduled_start},{provider:"groom_sanjay",name:"Sanjay P.",model:"full_time",status:"assigned",start:f.input.scheduledStart});
 assert.ok(after.reservations.length>0);
 assert.ok(after.reservations.every(row=>row.provider_id==="groom_sanjay"&&row.scheduled_start===f.input.scheduledStart&&row.status==="assigned"));
 assert.deepEqual(after.decision,{selected_provider_id:"groom_sanjay",status:"assigned"});
 assert.equal(after.booking.total_amount,before.booking.total_amount,"a groomer change does not re-price the booking");
 assert.deepEqual(after.payments,before.payments);
 assert.equal(f.sqlite.prepare("SELECT provider_id FROM provider_lifecycle_records WHERE lifecycle_key=?").get(`grooming:${f.bookingId}`).provider_id,"groom_sanjay","the service lifecycle is handed to the new groomer");
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM scheduling_reservations WHERE id='BUSY-groom_arun' AND status='assigned'").get().n,1,"the other customer's reservation is untouched");

 const detail=f.rescheduledEvent();
 assert.equal(detail.providerChanged,true);
 assert.equal(detail.previousProviderId,"groom_arun");
 assert.equal(detail.providerId,"groom_sanjay");
 assert.equal(detail.pricing.priceDifference,0);
});

test("a commission groomer taking the new slot receives a pending offer and must accept it",async t=>{
 const f=await journey(t,{id:"OFFER"});
 occupy(f,"groom_arun",f.input.scheduledStart,f.input.scheduledEnd);
 onLeave(f,"groom_sanjay",f.input.scheduledStart,f.input.scheduledEnd);

 const response=await f.call();
 assert.equal(response.status,200,JSON.stringify(response.body));
 assert.equal(response.body.data.providerId,"groom_kiran");
 const after=f.snapshot();
 assert.equal(after.booking.provider_id,"groom_kiran");
 assert.equal(after.booking.status,"confirmed");
 assert.equal(after.work.status,"awaiting_acceptance");
 assert.equal(after.work.provider_model,"commission");
 assert.deepEqual(after.offers,[{provider_id:"groom_kiran",status:"pending"}]);
 assert.equal(f.sqlite.prepare("SELECT booking_id FROM provider_assignment_offers WHERE group_id=?").get(f.groupId).booking_id,f.bookingId);

 const cookie=await sessionCookie(f.db,"provider","groom_kiran","provider:groom_kiran");
 const accepted=await routeCall("../../app/api/provider-assignment-recovery/route.ts","POST","/api/provider-assignment-recovery",{bookingId:f.bookingId,providerId:"groom_kiran",action:"accept"},cookie);
 assert.equal(accepted.status,200,JSON.stringify(accepted.body));
 assert.equal(f.snapshot().work.status,"assigned");
 assert.equal(f.snapshot().work.scheduled_start,f.input.scheduledStart);
});

test("QA M4: the move is refused clearly only when no groomer in the zone is available",async t=>{
 const f=await journey(t,{id:"NONE"});
 occupy(f,"groom_arun",f.input.scheduledStart,f.input.scheduledEnd);
 onLeave(f,"groom_kiran",f.input.scheduledStart,f.input.scheduledEnd);
 onLeave(f,"groom_sanjay",f.input.scheduledStart,f.input.scheduledEnd);
 // A free groomer in ANOTHER zone must never be used for this booking.
 const now=Date.now();
 f.sqlite.prepare("INSERT INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES ('groom_west','blr','West Groomer','full_time','[\"grooming\"]','[\"blr-west\"]',1,5,99,1,30,6,3,'active',1,'2026-08-01',NULL,'m4_test',?)").run(now);
 f.sqlite.prepare("INSERT INTO scheduling_availability (id,provider_id,city_id,zone_id,date,windows_json,source,updated_at) VALUES (?,?,?,?,?,?,?,?)").run("M4-WEST-ROSTER","groom_west","blr","blr-west",istDate(f.target),JSON.stringify(["08:00-20:00"]),"operations",now);
 const before=f.snapshot();

 const response=await f.call();
 assert.equal(response.status,409,JSON.stringify(response.body));
 assert.equal(response.body.code,"reschedule_no_provider_available");
 assert.equal(response.body.bookingUnchanged,true);
 assert.match(response.body.error,/No groomer in your area is available at that time/);
 assert.doesNotMatch(response.body.error,/assigned provider/i);
 assert.deepEqual(f.snapshot(),before,"nothing moves when nobody can take the slot");
});

test("the reschedule form tells the customer why a move was refused and who their new groomer is",async()=>{
 const {rescheduleRefusal,rescheduleSuccessMessage}=await import("../lib/grooming-booking-change-client.ts");
 const {ApiError}=await import("../lib/api-fetch.ts");
 const increase=new ApiError("http",409,"This time costs ₹475 more than your booked price.",{error:"This time costs ₹475 more than your booked price.",code:"reschedule_price_increase",priceDifference:475});
 assert.deepEqual(rescheduleRefusal(increase),{message:"This time costs ₹475 more than your booked price.",canChooseAnotherTime:true});
 const nobody=new ApiError("http",409,"No groomer in your area is available at that time.",{error:"No groomer in your area is available at that time.",code:"reschedule_no_provider_available"});
 assert.equal(rescheduleRefusal(nobody).canChooseAnotherTime,true);
 const changed=new ApiError("http",409,"Booking change terms have changed.",{error:"Booking change terms have changed.",code:"booking_change_terms_changed"});
 assert.equal(rescheduleRefusal(changed).canChooseAnotherTime,false,"stale terms still require a refresh");
 assert.equal(rescheduleRefusal(new Error("offline")).canChooseAnotherTime,false);
 assert.match(rescheduleSuccessMessage({bookingId:"B",status:"assigned",providerChanged:true,provider:{id:"groom_sanjay",name:"Sanjay P.",model:"full_time"}}),/Sanjay P\./);
 assert.match(rescheduleSuccessMessage({bookingId:"B",status:"assigned",providerChanged:false}),/Booking rescheduled/);
 assert.match(rescheduleSuccessMessage({bookingId:"B",status:"assigned",providerChanged:false}),/price stays the same/);
});
