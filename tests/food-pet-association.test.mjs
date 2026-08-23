import assert from"node:assert/strict";
import test from"node:test";
import{readFile}from"node:fs/promises";
import{createFoodQuote,quoteFoodCart}from"../lib/food-client.ts";

const read=path=>readFile(new URL(`../${path}`,import.meta.url),"utf8");

test("Fresh Food quote client sends canonical customer and selected pet identity",async()=>{
 const originalFetch=globalThis.fetch,calls=[];
 globalThis.fetch=async(url,init={})=>{calls.push({url:String(url),init});const input=JSON.parse(String(init.body));return Response.json({data:{quoteId:"FQ-1",sku:input.sku,name:"Dog Food",version:1,petType:"dog",petIds:input.petIds,packSize:"2 kg",quantity:input.quantity,unitPrice:799,deliveryFee:0,totalAmount:799,amountDueNow:0,currency:"INR",zoneId:input.zoneId,paymentMode:"sandbox_deferred",expiresAt:Date.now()+900000,inventoryMode:"uat_seed",productionInventoryVerified:false,liveMoney:false}},{status:201});};
 try{
  const quote=await createFoodQuote({sku:"food-uat-dog-adult-2kg",quantity:1,customerId:"CUS-1",petIds:["PET-2","PET-1"],zoneId:"blr-east"});
  assert.deepEqual(quote.petIds,["PET-2","PET-1"]);
  const body=JSON.parse(String(calls[0].init.body));
  assert.equal(body.customerId,"CUS-1");
  assert.deepEqual(body.petIds,["PET-2","PET-1"]);
 }finally{globalThis.fetch=originalFetch;}
});

test("cart quoting requires a pet association on every SKU",async()=>{
 await assert.rejects(()=>quoteFoodCart([{sku:"food-uat-dog-adult-2kg",quantity:1}],"blr-east","CUS-1"),/matching pet/i);
 await assert.rejects(()=>quoteFoodCart([{sku:"food-uat-dog-adult-2kg",quantity:1,petIds:["PET-1"]}],"blr-east",""),/customer identity/i);
});

test("server persists and validates quote to order pet lineage",async()=>{
 const governance=await read("lib/food-governance.ts");
 assert.match(governance,/CREATE TABLE IF NOT EXISTS food_quote_pets/);
 assert.match(governance,/CREATE TABLE IF NOT EXISTS food_order_pets/);
 assert.match(governance,/SELECT id,customer_id,species FROM canonical_pets WHERE id=\?/);
 assert.match(governance,/Selected Fresh Food pet is not owned by this customer/);
 assert.match(governance,/Selected pet is not eligible for/);
 assert.match(governance,/Food quote belongs to a different customer/);
 assert.match(governance,/INSERT INTO food_order_pets/);
 assert.match(governance,/source_quote_id/);
});

test("mobile Food selection becomes per-SKU quote identity rather than cosmetic recommendation context",async()=>{
 const flow=await read("app/mobile-app/food-flow.tsx");
 const review=flow.slice(flow.indexOf("const reviewOrder"),flow.indexOf("const confirm"));
 assert.match(review,/selectedPets\.includes\(pet\.id\) && pet\.species === item\.pet_type/);
 assert.match(review,/return \{ \.\.\.line, petIds \}/);
 assert.match(review,/quoteFoodCart\(petBoundCart, resolved\.zoneId, customer\.customerId\)/);
});

test("repeat subscriptions copy source-order pet identity and expose it on snapshots",async()=>{
 const helper=await read("lib/food-pet-association.ts"),route=await read("app/api/food-subscriptions/route.ts");
 assert.match(helper,/CREATE TABLE IF NOT EXISTS food_subscription_pets/);
 assert.match(helper,/SELECT pet_id,customer_id,pet_type FROM food_order_pets WHERE order_id=\?/);
 assert.match(helper,/Food subscription requires pet-associated source order/);
 assert.match(route,/bindFoodSubscriptionPetsFromOrder/);
 assert.match(route,/foodSubscriptionPetIds/);
 assert.match(route,/snapshot\?\{\.\.\.snapshot,petIds\}:snapshot/);
});
