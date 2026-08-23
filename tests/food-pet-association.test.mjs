import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import { createFoodQuote as createClientFoodQuote, quoteFoodCart } from "../lib/food-client.ts";
import { createFoodOrder as createServerFoodOrder, createFoodQuote as createServerFoodQuote } from "../lib/food-governance.ts";
import { validateFoodSubscriptionPetsFromOrder } from "../lib/food-pet-association.ts";

class Statement{constructor(db,sql){this.db=db;this.sql=sql;this.args=[]}bind(...args){this.args=args;return this}run(){return this.db.run(this.sql,this.args)}first(){return this.db.first(this.sql,this.args)}async all(){return{results:await this.db.all(this.sql,this.args)}}}
class FoodD1{
 constructor(){this.catalogue=new Map();this.inventory=new Map();this.pets=new Map();this.quotes=new Map();this.quotePets=[];this.orders=new Map();this.orderPets=[];this.failOrderInsert=false;this.failQuotePetInsert=false}
 prepare(sql){return new Statement(this,sql)}
 snapshot(){return{catalogue:new Map([...this.catalogue].map(([key,value])=>[key,{...value}])),inventory:new Map([...this.inventory].map(([key,value])=>[key,{...value}])),quotes:new Map([...this.quotes].map(([key,value])=>[key,{...value}])),quotePets:this.quotePets.map(row=>({...row})),orders:new Map([...this.orders].map(([key,value])=>[key,{...value}])),orderPets:this.orderPets.map(row=>({...row}))}}
 restore(snapshot){this.catalogue=snapshot.catalogue;this.inventory=snapshot.inventory;this.quotes=snapshot.quotes;this.quotePets=snapshot.quotePets;this.orders=snapshot.orders;this.orderPets=snapshot.orderPets}
 async batch(statements){const snapshot=this.snapshot();try{const results=[];for(const statement of statements)results.push(await statement.run());return results}catch(error){this.restore(snapshot);throw error}}
 async run(sql,args){
  if(sql.startsWith("CREATE "))return{meta:{changes:0}};
  if(sql.includes("INSERT OR IGNORE INTO food_catalogue_items")){const[sku,name,pet_type,pack_size,unit_price,max_qty_per_order,updated_at]=args;if(!this.catalogue.has(String(sku)))this.catalogue.set(String(sku),{sku,name,pet_type,pack_size,unit_price,currency:"INR",max_qty_per_order,active:1,version:1,effective_from:"2026-08-01",effective_to:null,updated_at});return{meta:{changes:1}}}
  if(sql.includes("INSERT OR IGNORE INTO food_inventory_uat")){const[sku,available_units,updated_at]=args,key=`${sku}|blr-east`;if(!this.inventory.has(key))this.inventory.set(key,{sku,zone_id:"blr-east",available_units,reserved_units:0,status:"uat_seed",updated_at});return{meta:{changes:1}}}
  if(sql.includes("INSERT INTO food_commercial_quotes")){const[id,sku,item_version,quantity,zone_id,unit_price,total_amount,payment_mode,expires_at,created_at]=args;this.quotes.set(String(id),{id,sku,item_version,quantity,zone_id,unit_price,delivery_fee:0,total_amount,amount_due_now:0,payment_mode,expires_at,status:"open",created_at,used_at:null,used_order_id:null});return{meta:{changes:1}}}
  if(sql.includes("INSERT INTO food_quote_pets")){if(this.failQuotePetInsert)throw new Error("simulated quote-pet batch failure");const[quote_id,pet_id,customer_id,pet_type,created_at]=args;this.quotePets.push({quote_id,pet_id,customer_id,pet_type,created_at});return{meta:{changes:1}}}
  if(sql.includes("UPDATE food_commercial_quotes SET status='open'")){const[quoteId,orderId]=args,quote=this.quotes.get(String(quoteId));if(quote&&quote.used_order_id===orderId){quote.status="open";quote.used_at=null;quote.used_order_id=null;return{meta:{changes:1}}}return{meta:{changes:0}}}
  if(sql.includes("UPDATE food_commercial_quotes SET status='used'")){const[used_at,orderId,quoteId]=args,quote=this.quotes.get(String(quoteId));if(quote?.status==="open"){quote.status="used";quote.used_at=used_at;quote.used_order_id=orderId;return{meta:{changes:1}}}return{meta:{changes:0}}}
  if(sql.includes("UPDATE food_inventory_uat SET reserved_units=reserved_units+")){const[quantity,updated_at,sku,zoneId,required=quantity]=args,row=this.inventory.get(`${sku}|${zoneId}`);if(!row||Number(row.reserved_units)+Number(required)>Number(row.available_units))return{meta:{changes:0}};row.reserved_units=Number(row.reserved_units)+Number(quantity);row.updated_at=updated_at;return{meta:{changes:1}}}
  if(sql.includes("UPDATE food_inventory_uat SET reserved_units=reserved_units-")){const[quantity,updated_at,sku,zoneId,required=quantity]=args,row=this.inventory.get(`${sku}|${zoneId}`);if(!row||Number(row.reserved_units)<Number(required))return{meta:{changes:0}};row.reserved_units=Number(row.reserved_units)-Number(quantity);row.updated_at=updated_at;return{meta:{changes:1}}}
  if(sql.includes("INSERT INTO food_orders")){if(this.failOrderInsert)throw new Error("simulated order batch failure");const[orderId,idempotencyKey,customerId,cityId,zoneId,totalAmount,createdBy,createdAt,updatedAt]=args;this.orders.set(String(orderId),{id:orderId,idempotency_key:idempotencyKey,customer_id:customerId,city_id:cityId,zone_id:zoneId,status:"uat_reserved",total_amount:totalAmount,created_by:createdBy,created_at:createdAt,updated_at:updatedAt});return{meta:{changes:1}}}
  if(sql.includes("INSERT INTO food_order_pets")){const[order_id,pet_id,customer_id,pet_type,source_quote_id,created_at]=args;this.orderPets.push({order_id,pet_id,customer_id,pet_type,source_quote_id,created_at});return{meta:{changes:1}}}
  if(sql.includes("INSERT OR IGNORE INTO food_subscription_pets"))return{meta:{changes:1}};
  if(sql.startsWith("INSERT INTO ")||sql.startsWith("INSERT OR IGNORE INTO ")||sql.startsWith("DELETE FROM "))return{meta:{changes:1}};
  throw new Error(`Unhandled D1 run: ${sql}`)
 }
 async first(sql,args){
  if(sql.includes("FROM canonical_pets WHERE id=?"))return this.pets.get(String(args[0]))??null;
  if(sql.includes("FROM food_catalogue_items c JOIN food_inventory_uat i")){const[zoneId,sku]=args,item=this.catalogue.get(String(sku)),inventory=this.inventory.get(`${sku}|${zoneId}`);return item&&inventory?{...item,...inventory}:null}
  if(sql.includes("FROM food_orders WHERE idempotency_key=?"))return[...this.orders.values()].find(row=>row.idempotency_key===args[0])??null;
  if(sql.includes("FROM food_commercial_quotes q JOIN food_catalogue_items c")){const quote=this.quotes.get(String(args[0]));if(!quote)return null;const item=this.catalogue.get(String(quote.sku));return item?{...quote,name:item.name,pet_type:item.pet_type}:null}
  if(sql.includes("used_order_id IS NOT NULL")){const quote=this.quotes.get(String(args[0]));return quote?.used_order_id?{used_order_id:quote.used_order_id}:null}
  if(sql.includes("SELECT used_order_id FROM food_commercial_quotes")){const quote=this.quotes.get(String(args[0]));return quote?{used_order_id:quote.used_order_id}:null}
  if(sql.includes("FROM food_inventory_uat WHERE sku=? AND zone_id=?"))return this.inventory.get(`${args[0]}|${args[1]}`)??null;
  return null
 }
 async all(sql,args){
  if(sql.includes("FROM food_quote_pets WHERE quote_id=?"))return this.quotePets.filter(row=>row.quote_id===args[0]).sort((a,b)=>String(a.pet_id).localeCompare(String(b.pet_id)));
  if(sql.includes("FROM food_order_pets WHERE order_id=?"))return this.orderPets.filter(row=>row.order_id===args[0]).sort((a,b)=>String(a.pet_id).localeCompare(String(b.pet_id)));
  return[]
 }
}

const seedDog=db=>db.pets.set("pet-dog",{id:"pet-dog",customer_id:"customer-1",species:"dog"});
const quoteInput={sku:"food-uat-dog-adult-2kg",quantity:1,zoneId:"blr-east",paymentMode:"sandbox_deferred",customerId:"customer-1",petIds:["pet-dog"]};
const orderInput=quoteId=>({idempotencyKey:`food-lineage:${quoteId}`,quoteId,customerId:"customer-1",cityId:"blr",zoneId:"blr-east",actorId:"test-suite"});

test("Food quote client submits customer and pet association",async()=>{const originalFetch=global.fetch;let captured;global.fetch=async(_url,init)=>{captured=JSON.parse(String(init?.body||"{}"));return new Response(JSON.stringify({data:{quoteId:"q1"}}),{status:200,headers:{"Content-Type":"application/json"}})};try{await createClientFoodQuote({sku:"sku-1",quantity:2,zoneId:"z1",customerId:"customer-1",petIds:["pet-dog"]});assert.equal(captured.customerId,"customer-1");assert.deepEqual(captured.petIds,["pet-dog"])}finally{global.fetch=originalFetch}});

test("Food cart quoting rejects missing item pet association and requires customer identity",async()=>{await assert.rejects(()=>quoteFoodCart([{sku:"sku-1",quantity:1,petIds:[]}],"z1","customer-1"),/Select at least one matching pet/);await assert.rejects(()=>quoteFoodCart([{sku:"sku-1",quantity:1,petIds:["pet-1"]}],"z1",""),/customer identity/)});

test("Food governance executes quote-to-order pet lineage against a controlled D1",async()=>{const db=new FoodD1();seedDog(db);const quote=await createServerFoodQuote(db,quoteInput),order=await createServerFoodOrder(db,orderInput(quote.quoteId));assert.deepEqual(quote.petIds,["pet-dog"]);assert.deepEqual(order.petIds,["pet-dog"]);assert.deepEqual(db.orderPets.map(row=>({orderId:row.order_id,petId:row.pet_id,customerId:row.customer_id,petType:row.pet_type,quoteId:row.source_quote_id})),[{orderId:order.orderId,petId:"pet-dog",customerId:"customer-1",petType:"dog",quoteId:quote.quoteId}]);const subscriptionPets=await validateFoodSubscriptionPetsFromOrder(db,{sourceOrderId:order.orderId,customerId:"customer-1"});assert.deepEqual(subscriptionPets,[{petId:"pet-dog",customerId:"customer-1",petType:"dog"}])});

test("Food inventory reservation is atomic across concurrent quotes",async()=>{const db=new FoodD1();seedDog(db);const firstQuote=await createServerFoodQuote(db,quoteInput),secondQuote=await createServerFoodQuote(db,quoteInput);db.inventory.get("food-uat-dog-adult-2kg|blr-east").available_units=1;const results=await Promise.allSettled([createServerFoodOrder(db,orderInput(firstQuote.quoteId)),createServerFoodOrder(db,orderInput(secondQuote.quoteId))]);assert.equal(results.filter(result=>result.status==="fulfilled").length,1);const rejected=results.filter(result=>result.status==="rejected");assert.equal(rejected.length,1);assert.equal(rejected[0].reason?.status,409);assert.equal(db.orders.size,1,"only the capacity-winning order is persisted");assert.equal(db.inventory.get("food-uat-dog-adult-2kg|blr-east").reserved_units,1,"reserved units never exceed available units");assert.deepEqual([...db.quotes.values()].map(quote=>quote.status).sort(),["open","used"])});

test("Food quote and pet association persist atomically",async()=>{const db=new FoodD1();seedDog(db);db.failQuotePetInsert=true;await assert.rejects(()=>createServerFoodQuote(db,quoteInput),/simulated quote-pet batch failure/);assert.equal(db.quotes.size,0,"failed pet persistence leaves no orphan quote");assert.equal(db.quotePets.length,0)});

test("Food idempotent replay is bound to the original customer",async()=>{const db=new FoodD1();seedDog(db);const quote=await createServerFoodQuote(db,quoteInput);await createServerFoodOrder(db,orderInput(quote.quoteId));await assert.rejects(()=>createServerFoodOrder(db,{...orderInput(quote.quoteId),customerId:"customer-2"}),error=>error instanceof Response&&error.status===403);assert.equal(db.orders.size,1)});

test("Food governance rejects pet ownership and species mismatches at runtime",async()=>{const wrongOwner=new FoodD1();wrongOwner.pets.set("pet-dog",{id:"pet-dog",customer_id:"customer-2",species:"dog"});await assert.rejects(()=>createServerFoodQuote(wrongOwner,quoteInput),error=>error instanceof Response&&error.status===403);const wrongSpecies=new FoodD1();wrongSpecies.pets.set("pet-dog",{id:"pet-dog",customer_id:"customer-1",species:"cat"});await assert.rejects(()=>createServerFoodQuote(wrongSpecies,quoteInput),error=>error instanceof Response&&error.status===409)});

test("Food order restores the quote when its transactional batch fails",async()=>{const db=new FoodD1();seedDog(db);const quote=await createServerFoodQuote(db,quoteInput);db.failOrderInsert=true;await assert.rejects(()=>createServerFoodOrder(db,orderInput(quote.quoteId)),/simulated order batch failure/);assert.equal(db.quotes.get(quote.quoteId).status,"open");assert.equal(db.quotes.get(quote.quoteId).used_order_id,null);assert.equal(db.inventory.get("food-uat-dog-adult-2kg|blr-east").reserved_units,0);db.failOrderInsert=false;const retry=await createServerFoodOrder(db,orderInput(quote.quoteId));assert.deepEqual(retry.petIds,["pet-dog"])});

test("Food subscription create prevalidates pet lineage before persistence",async()=>{const source=await fs.readFile(new URL("../app/api/food-subscriptions/route.ts",import.meta.url),"utf8"),validateIndex=source.indexOf("validateFoodSubscriptionPetsFromOrder(db"),createIndex=source.indexOf("createFoodSubscription(db");assert.ok(validateIndex>=0&&createIndex>validateIndex);assert.match(source,/pets:sourcePets/);assert.match(source,/DELETE FROM food_subscriptions WHERE id=\?/)});

test("Canonical Food UAT exposes explicit pet selection and keeps catalogue recovery independent",async()=>{const source=await fs.readFile(new URL("../app/food/canonical-food-page.tsx",import.meta.url),"utf8");assert.match(source,/selectedPetId/);assert.match(source,/eligible\.find\(candidate=>candidate\.id===selectedPetId\)/);assert.match(source,/setItems\(catalogue\.items\)/);assert.match(source,/Select the pet for this canonical Food order/)});
