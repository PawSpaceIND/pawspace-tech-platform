import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
installWorkersHooks("__AUTO_OFFER_DB__");
const {loadV2GroomingOffers}=await import("../lib/v2/grooming-offers-client.ts");
const input={customerId:"C1",cityId:"blr",packageCode:"dog-basic",orderValue:1899};
const offer={code:"NORMAL",name:"Normal offer",description:"Save ₹200",savings:200,finalAmount:1699};
const response=()=>({normalCouponsAllowed:true,bookingCount:0,coupons:[{...offer}]});
for(const [name,mutate] of [
 ["missing code",x=>{delete x.coupons[0].code;}],
 ["invalid name",x=>{x.coupons[0].name={};}],
 ["sub-paise saving",x=>{x.coupons[0].savings=100.001;}],
 ["inconsistent total",x=>{x.coupons[0].finalAmount=1;}],
 ["zero discount",x=>{x.coupons[0].savings=0;}],
 ["duplicate codes",x=>{x.coupons.push({...offer});}],
 ["non-best recommendation",x=>{x.coupons.push({...offer,code:"BETTER",savings:300,finalAmount:1599});}],
 ["ineligible offers",x=>{x.normalCouponsAllowed=false;}],
 ["unknown booking history",x=>{delete x.bookingCount;}],
])test(`automatic offers reject ${name} before applying anything`,async t=>{
 const data=response();mutate(data);let calls=0;t.mock.method(globalThis,"fetch",async()=>{calls++;return Response.json({data});});
 await assert.rejects(loadV2GroomingOffers(input),/verified|Reapply/);assert.equal(calls,1);
});
test("automatic offers accept exact server-priced amounts and use a read-only request",async t=>{
 t.mock.method(globalThis,"fetch",async(url,options)=>{assert.ok(String(url).includes("orderValue=1899"));assert.equal(options.method,undefined);return Response.json({data:response()});});
 assert.equal((await loadV2GroomingOffers(input)).coupons[0].code,"NORMAL");
});
