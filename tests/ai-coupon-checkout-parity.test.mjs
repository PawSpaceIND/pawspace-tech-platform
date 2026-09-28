import test from "node:test";
import assert from "node:assert/strict";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
installWorkersHooks("__AI_COUPON_PARITY_DB__", "__AI_COUPON_PARITY_ENV__");
const engine=await import("../lib/coupon-governance.ts");
const ai=await import("../lib/ai-sales-offers.ts");
const context={serviceCode:"grooming",cityId:"blr",channel:"website",packageCode:"dog-basic",orderValue:2246,paymentMode:"full",isSubscription:false};
async function world(t){
 const h=freshCountingD1();t.after(()=>h.sqlite.close());await engine.seedUatCoupons(h.db);
 h.sqlite.exec("CREATE TABLE canonical_customers (id TEXT PRIMARY KEY, city_id TEXT); INSERT INTO canonical_customers VALUES ('C1','blr'),('C2','blr')");
 return h;
}
function booking(sqlite,id,status="confirmed"){
 sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,total_amount,created_by,created_at,updated_at) VALUES (?,?,'C1','[\"P1\"]','[\"P1\"]','blr','east','boarding','stay','Stay',?,'PRV','2026-10-10T05:30:00Z','2026-10-10T07:30:00Z',?,1000,'test',1,1)").run(id,id,id,status);
}
const approved=(db,extra={})=>ai.approvedSalesOffers(db,{customerId:"C1",channel:"website",context,...extra});
test("AI never promises account eligibility to an anonymous visitor",async t=>{const {db}=await world(t);assert.deepEqual(await ai.approvedSalesOffers(db,{channel:"website"}),[]);});
for(const count of [0,1,2,3])test(`AI and checkout agree with ${count} prior cross-service bookings`,async t=>{
 const {db,sqlite}=await world(t);for(let i=0;i<count;i++)booking(sqlite,"old"+i);
 const list=await approved(db);assert.equal(list.length>0,count<3);
 for(const offer of list){const quote=await engine.quoteCoupon(db,{...context,code:offer.code,customerId:"C1"});assert.equal(quote.valid,true);assert.equal(quote.discount,offer.discount_amount);assert.equal(quote.finalAmount,offer.offer_price);assert.equal(offer.regular_price,context.orderValue);}
});
test("AI never leaks an intended-customer campaign to a different customer",async t=>{
 const {db,sqlite}=await world(t);sqlite.exec(`UPDATE coupon_campaigns SET customer_ids_json='["C2"]' WHERE code='GROOM200'`);
 assert.equal((await approved(db)).some(x=>x.code==="GROOM200"),false);
 assert.equal((await approved(db,{customerId:"C2"})).some(x=>x.code==="GROOM200"),true);
});
test("a private approved sales campaign can remain eligible after three but a generic unlisted code cannot",async t=>{
 const {db,sqlite}=await world(t);for(let i=0;i<3;i++)booking(sqlite,"old"+i);
 sqlite.exec(`UPDATE coupon_campaigns SET customer_ids_json='["C1"]' WHERE code='GROOM200'`);
 assert.deepEqual((await approved(db)).map(x=>x.code),["GROOM200"]);
});
test("AI applies package, subscription, spend and payment gates before suggesting an offer",async t=>{
 const {db,sqlite}=await world(t);
 for(const changes of [{packageCode:"dog-basic__2_pets"},{isSubscription:true},{orderValue:500}])assert.deepEqual(await approved(db,{context:{...context,...changes}}),[]);
 sqlite.exec("UPDATE coupon_campaigns SET full_payment_only=1");assert.deepEqual(await approved(db,{context:{...context,paymentMode:"partial"}}),[]);
 sqlite.exec("UPDATE coupon_campaigns SET first_order_only=1");booking(sqlite,"old");assert.deepEqual(await approved(db),[]);
});
test("AI cannot advertise live coupons without the environment's live approval",async t=>{
 const {db,sqlite}=await world(t);sqlite.exec("UPDATE coupon_campaigns SET test_only=0");assert.deepEqual(await approved(db),[]);
});
test("AI recommendation never mints coupons and cancelled attempts do not consume eligibility",async t=>{
 const {db,sqlite}=await world(t);for(const [id,status] of [["cancel","cancelled"],["fail","failed"]])booking(sqlite,id,status);
 assert.ok((await approved(db)).length>0);assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM coupon_quotes").get().n,0);
});
test("failed redemption reads cannot turn exhausted campaigns into approved AI offers",async t=>{
 const {db}=await world(t);const original=db.prepare.bind(db);
 db.prepare=sql=>sql.includes("SUM(CASE WHEN customer_id")?{bind:()=>({all:async()=>{throw new Error("simulated D1 outage");}})}:original(sql);
 await assert.rejects(approved(db),/unavailable|outage/i);
});
