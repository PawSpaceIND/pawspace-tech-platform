/**
 * Shared address callers, group 4: Food's displayed delivery address reaches the canonical order as an immutable,
 * coverage-validated snapshot. Real client helpers (stubbed fetch for the payload), the real /api/food-orders route
 * with a platform customer session, and the real governance and renewal engines run against SQLite.
 *
 * The snapshot is customer-supplied, coverage-validated evidence. It is not a geocoded doorstep and these tests do not
 * claim any delivery, dispatch or notification happened.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {setupJourney,routeCall,sessionCookie} from "./helpers/grooming-journey-harness.mjs";
import {seedOwnedPet} from "./helpers/saved-pet-fixture.mjs";

const governance=await import("../lib/food-governance.ts");
const ORDERS="../../app/api/food-orders/route.ts";
const A={address:"12 Rest House Road, Indiranagar, Bengaluru",pincode:"560038"};// blr-east
const SKU="food-uat-dog-adult-2kg";

async function foodWorld(t){
 const ctx=await setupJourney();t.after(ctx.close);
 await governance.ensureFoodGovernanceTables(ctx.db);
 await seedOwnedPet(ctx.db,"FOOD-A","FOOD-A-DOG","Bruno");await seedOwnedPet(ctx.db,"FOOD-B","FOOD-B-DOG","Rex");
 const cookies={A:await sessionCookie(ctx.db,"customer","FOOD-A","customer:FOOD-A"),B:await sessionCookie(ctx.db,"customer","FOOD-B","customer:FOOD-B")};
 const quote=(customerId="FOOD-A",petId="FOOD-A-DOG",zoneId="blr-east")=>governance.createFoodQuote(ctx.db,{sku:SKU,quantity:2,zoneId,paymentMode:"sandbox_deferred",customerId,petIds:[petId]});
 const order=(body,who="A")=>routeCall(ORDERS,"POST","/api/food-orders",{customer:{id:`FOOD-${who}`,name:`Customer ${who}`,primaryPhone:who==="A"?"9000000991":"9000000992"},cityId:"blr",zoneId:"blr-east",...body},cookies[who]);
 const one=sql=>ctx.sqlite.prepare(sql).get();
 const state=()=>({orders:one("SELECT COUNT(*) n FROM food_orders").n,snapshots:one("SELECT COUNT(*) n FROM food_order_delivery_snapshots").n,payments:one("SELECT COUNT(*) n FROM food_order_payments").n,reserved:one(`SELECT reserved_units n FROM food_inventory_uat WHERE sku='${SKU}' AND zone_id='blr-east'`).n,openQuotes:one("SELECT COUNT(*) n FROM food_commercial_quotes WHERE status='open'").n,customers:one("SELECT COUNT(*) n FROM sqlite_master WHERE name='canonical_customers'").n?one("SELECT COUNT(*) n FROM canonical_customers WHERE id LIKE 'FOOD-%'").n:0});
 return {...ctx,quote,order,state,one};
}

test("client: placeQuotedFoodOrders POSTs the exact reviewed delivery selection with each quote",async()=>{
 const {placeQuotedFoodOrders}=await import("../lib/food-client.ts");
 const prior=globalThis.fetch,bodies=[];
 globalThis.fetch=async(url,init)=>{bodies.push(JSON.parse(String(init.body)));return Response.json({data:{orderId:"O1",deliverySnapshot:{...A,cityId:"blr",zoneId:"blr-east",evidence:"customer_supplied_coverage_validated",sourceOrderId:null,capturedAt:1}}},{status:201});};
 try{
  const orders=await placeQuotedFoodOrders({quotes:[{quoteId:"Q1"},{quoteId:"Q2"}],customer:{id:"FOOD-A",name:"A",primaryPhone:"9"},cityId:"blr",zoneId:"blr-east",delivery:A});
  assert.equal(bodies.length,2);
  for(const body of bodies)assert.deepEqual([body.delivery,body.cityId,body.zoneId],[A,"blr","blr-east"]);
  assert.deepEqual(orders[0].deliverySnapshot.address,A.address);
 }finally{globalThis.fetch=prior;}
});

test("route: the order stores and returns the immutable snapshot; a same-address retry returns the original snapshot and amount",async t=>{
 const w=await foodWorld(t),q=await w.quote();
 const first=await w.order({idempotencyKey:"FOOD-K1",quoteId:q.quoteId,delivery:A});
 assert.equal(first.status,201,JSON.stringify(first.body));
 const snap=first.body.data.deliverySnapshot;
 assert.deepEqual([snap.address,snap.pincode,snap.cityId,snap.zoneId,snap.evidence,snap.sourceOrderId],[A.address,A.pincode,"blr","blr-east","customer_supplied_coverage_validated",null]);
 const stored=w.one(`SELECT * FROM food_order_delivery_snapshots WHERE order_id='${first.body.data.orderId}'`);
 assert.deepEqual([stored.customer_id,stored.address_text,stored.pincode,stored.zone_id],["FOOD-A",A.address,A.pincode,"blr-east"]);
 const retry=await w.order({idempotencyKey:"FOOD-K1",quoteId:q.quoteId,delivery:{address:` ${A.address} `,pincode:` ${A.pincode}`}});
 assert.equal(retry.status,200,JSON.stringify(retry.body));
 assert.deepEqual([retry.body.data.orderId,retry.body.data.totalAmount,retry.body.data.duplicatePrevented],[first.body.data.orderId,first.body.data.totalAmount,true]);
 assert.deepEqual(retry.body.data.deliverySnapshot,snap,"the replay answers with the stored snapshot");
 const {listFoodOrders}=await import("../lib/food-fulfilment-governance.ts");
 const [fulfilment]=await listFoodOrders(w.db,{orderId:first.body.data.orderId});
 assert.deepEqual(fulfilment.deliverySnapshot,snap,"fulfilment reads the stored snapshot, not mutable client state");
});

test("route: a changed address under the same idempotency key fails with no order, inventory, payment or quote change",async t=>{
 const w=await foodWorld(t),q=await w.quote();
 await w.order({idempotencyKey:"FOOD-K2",quoteId:q.quoteId,delivery:A});
 const before=w.state();
 const changed=await w.order({idempotencyKey:"FOOD-K2",quoteId:q.quoteId,delivery:{address:"9 Other Lane, Indiranagar, Bengaluru",pincode:"560038"}});
 assert.equal(changed.status,409,JSON.stringify(changed.body));assert.equal(changed.body.code,"food_order_delivery_conflict");
 assert.deepEqual(w.state(),before);
});

for(const [label,delivery,status,code] of [
 ["malformed PIN (embedded space)",{address:A.address,pincode:"5600 38"},400,"food_delivery_pin_invalid"],
 ["malformed PIN (overlong)",{address:A.address,pincode:"5600389"},400,"food_delivery_pin_invalid"],
 ["malformed PIN (letters)",{address:A.address,pincode:"56003A"},400,"food_delivery_pin_invalid"],
 ["missing PIN",{address:A.address,pincode:""},400,"food_delivery_pin_invalid"],
 ["incomplete address",{address:"short",pincode:"560038"},400,"food_delivery_address_incomplete"],
 ["delivery PIN in another zone than the quote (Koramangala vs Indiranagar)",{address:"5 Koramangala 4th Block, Bengaluru",pincode:"560034"},409,"food_delivery_zone_mismatch"],
 ["uncovered PIN",{address:"1 Connaught Place, New Delhi",pincode:"110001"},409,"food_delivery_not_covered"],
]){
 test(`route: ${label} refused before ANY write (customer, order, inventory, payment, quote)`,async t=>{
  const w=await foodWorld(t),q=await w.quote(),before=w.state();
  const answer=await w.order({idempotencyKey:`FOOD-BAD-${code}`,quoteId:q.quoteId,delivery});
  assert.equal(answer.status,status,JSON.stringify(answer.body));assert.equal(answer.body.code,code);
  assert.deepEqual(w.state(),before);
 });
}

test("route: a foreign customer cannot order on another customer's quote or reuse their key; nothing changes",async t=>{
 const w=await foodWorld(t),q=await w.quote();
 const before=w.state();
 const foreign=await w.order({idempotencyKey:"FOOD-K3",quoteId:q.quoteId,delivery:A},"B");
 assert.equal(foreign.status,403,JSON.stringify(foreign.body));
 const {orders,snapshots,payments,reserved,openQuotes}=w.state();
 assert.deepEqual({orders,snapshots,payments,reserved,openQuotes},{orders:before.orders,snapshots:before.snapshots,payments:before.payments,reserved:before.reserved,openQuotes:before.openQuotes});
 await w.order({idempotencyKey:"FOOD-K4",quoteId:q.quoteId,delivery:A});
 const qb=await w.quote("FOOD-B","FOOD-B-DOG");
 const reused=await w.order({idempotencyKey:"FOOD-K4",quoteId:qb.quoteId,delivery:A},"B");
 assert.equal(reused.status,403,"an idempotency key owned by another customer is refused");
});

test("rollback: a failed order insert leaves no snapshot, restores inventory and reopens the quote",async t=>{
 const w=await foodWorld(t),q=await w.quote(),before=w.state();
 w.sqlite.exec("CREATE TRIGGER fail_food_event BEFORE INSERT ON food_order_events BEGIN SELECT RAISE(ABORT,'forced failure'); END;");
 const failed=await w.order({idempotencyKey:"FOOD-K5",quoteId:q.quoteId,delivery:A});
 assert.ok(failed.status>=400,JSON.stringify(failed.body));
 assert.deepEqual(w.state(),{...before,customers:w.state().customers},"no order, snapshot or payment; inventory and quote restored");
});

test("legacy order without a snapshot replays honestly with deliverySnapshot null (never fabricated)",async t=>{
 const w=await foodWorld(t),q=await w.quote();
 const legacy=await governance.createFoodOrder(w.db,{idempotencyKey:"FOOD-LEGACY",quoteId:q.quoteId,customerId:"FOOD-A",cityId:"blr",zoneId:"blr-east",actorId:"legacy"});
 assert.equal(legacy.deliverySnapshot,null);
 const replay=await w.order({idempotencyKey:"FOOD-LEGACY",quoteId:q.quoteId,delivery:A});
 assert.equal(replay.status,200,JSON.stringify(replay.body));
 assert.equal(replay.body.data.deliverySnapshot,null);
 assert.equal(w.one("SELECT COUNT(*) n FROM food_order_delivery_snapshots").n,0);
});

async function renewOnce(w,sourceOrderId){
 const subs=await import("../lib/food-subscription-governance.ts");
 const lineage=await import("../lib/food-pet-association.ts");
 // The same two steps app/api/food-subscriptions/route.ts runs: validate the source order's pet lineage, create, bind it.
 const pets=await lineage.validateFoodSubscriptionPetsFromOrder(w.db,{sourceOrderId,customerId:"FOOD-A"});
 const created=await subs.createFoodSubscription(w.db,{sourceOrderId,customerId:"FOOD-A",renewalIntervalDays:7,firstRenewalAt:Date.now()+86_400_000,communicationChannel:"whatsapp",actorId:"FOOD-A"});
 await lineage.bindFoodSubscriptionPetsFromOrder(w.db,{subscriptionId:created.subscriptionId,sourceOrderId,customerId:"FOOD-A",pets});
 w.sqlite.prepare("UPDATE food_subscriptions SET next_renewal_at=? WHERE id=?").run(Date.now()-1000,created.subscriptionId);
 await subs.processDueFoodSubscriptionRenewals(w.db,{actorId:"scheduler",subscriptionId:created.subscriptionId});
 const renewal=w.one(`SELECT id FROM food_subscription_renewals WHERE subscription_id='${created.subscriptionId}'`);
 await subs.recordFoodSubscriptionRenewalPayment(w.db,{renewalId:renewal.id,paymentReference:"UAT-REF-1",actorId:"ops"});
 return w.one(`SELECT delivery_order_id FROM food_subscription_renewals WHERE id='${renewal.id}'`).delivery_order_id;
}
test("renewal inherits the owned source order's snapshot; a legacy source keeps fulfilment review with no invented address",async t=>{
 const w=await foodWorld(t);
 const source=await w.order({idempotencyKey:"FOOD-SRC",quoteId:(await w.quote()).quoteId,delivery:A});
 const renewedOrder=await renewOnce(w,source.body.data.orderId);
 const inherited=await governance.foodOrderDeliverySnapshot(w.db,renewedOrder);
 assert.deepEqual([inherited.address,inherited.pincode,inherited.evidence,inherited.sourceOrderId],[A.address,A.pincode,"inherited_from_source_order",source.body.data.orderId]);
 const w2=await foodWorld(t);
 const legacy=await governance.createFoodOrder(w2.db,{idempotencyKey:"FOOD-SRC-LEGACY",quoteId:(await w2.quote()).quoteId,customerId:"FOOD-A",cityId:"blr",zoneId:"blr-east",actorId:"legacy"});
 const legacyRenewal=await renewOnce(w2,legacy.orderId);
 assert.equal(await governance.foodOrderDeliverySnapshot(w2.db,legacyRenewal),null);
 assert.equal(w2.one(`SELECT delivery_status FROM food_orders WHERE id='${legacyRenewal}'`).delivery_status,"fulfilment_review_required");
});

test("callers: mobile, canonical and V2 Food pass the reviewed/saved selection and show the stored snapshot (no default Bengaluru)",()=>{
 const read=file=>fs.readFileSync(new URL(`../${file}`,import.meta.url),"utf8");
 const mobile=read("app/mobile-app/food-flow.tsx"),canonical=read("app/food/canonical-food-page.tsx"),v2=read("app/v2/food-experience.tsx");
 assert.match(mobile,/setReviewedDelivery\(\{ address: address\.trim\(\), pincode: resolved\.pincode \}\)/);
 assert.match(mobile,/zoneId: resolved\.zoneId,\n\s+delivery,\n/);
 assert.match(mobile,/order\.deliverySnapshot \?/);
 assert.doesNotMatch(mobile,/pincode \|\| "Bengaluru"/);
 for(const page of [canonical,v2]){
  assert.match(page,/foodDeliveryFromAccount\(/);
  assert.match(page,/delivery:\{address:quotedDelivery\.address,pincode:quotedDelivery\.pincode\}/);
  assert.match(page,/cityId:quotedDelivery\.cityId,zoneId:quotedDelivery\.zoneId/);
  assert.match(page,/order\.deliverySnapshot\?/);
 }
});
test("saved-address Food selection refuses a malformed saved PIN without fetching or falling back",async t=>{
 await foodWorld(t);// installs the Workers module hooks the helper's extensionless imports need
 const {foodDeliveryFromAccount}=await import("../lib/food-delivery-selection.ts");
 assert.equal(typeof foodDeliveryFromAccount,"function");
 const prior=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({});};
 try{
  await assert.rejects(foodDeliveryFromAccount({addresses:[{id:"x",label:"Home",line1:"12 Rest House Road",area:"Indiranagar",city:"Bengaluru",postalCode:"5600 38",isDefault:true},{id:"y",label:"Work",line1:"5 Valid Lane",area:"Indiranagar",city:"Bengaluru",postalCode:"560038",isDefault:false}]}),/invalid PIN/,"the malformed default is refused; the other saved address is NOT silently chosen");
  await assert.rejects(foodDeliveryFromAccount({addresses:[]}),/Add a delivery address/);
  assert.equal(calls,0);
 }finally{globalThis.fetch=prior;}
});
