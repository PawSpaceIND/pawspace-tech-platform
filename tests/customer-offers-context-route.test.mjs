import test from "node:test";
import assert from "node:assert/strict";
import { setupJourney, sessionCookie } from "./helpers/grooming-journey-harness.mjs";
import { seedOwnedPet } from "./helpers/saved-pet-fixture.mjs";
import { enterWorkersDbScope } from "./helpers/module-hooks.mjs";

async function world(t){const ctx=await setupJourney();t.after(ctx.close);enterWorkersDbScope(ctx.db);await seedOwnedPet(ctx.db,"C-OFFER","P-OFFER","Bruno");return{...ctx,cookie:await sessionCookie(ctx.db,"customer","C-OFFER","customer:C-OFFER")};}
const fields={customerId:"C-OFFER",serviceCode:"grooming",cityId:"blr",channel:"website",packageCode:"dog-basic",orderValue:"1899",paymentMode:"full",isSubscription:"false"};
async function read(ctx,params=fields,cookie=ctx.cookie){const {GET}=await import("../app/api/customer-offers/route.ts");const response=await GET(new Request(`https://pawspace.test/api/customer-offers?${new URLSearchParams(params)}`,{headers:{cookie,origin:"https://pawspace.test"}}));return{status:response.status,body:await response.json()};}
test("actual offers endpoint authorizes the customer and returns context-checked savings without coupon quote writes",async t=>{
 const ctx=await world(t),r=await read(ctx);assert.equal(r.status,200,JSON.stringify(r.body));assert.ok(r.body.data.coupons.some(c=>c.code==="WELCOME"));
 assert.equal(r.body.data.coupons.find(c=>c.code==="WELCOME").savings,284.85);
 assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM coupon_quotes").get().n,0);
 assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM canonical_bookings").get().n,0);
});
test("offer browsing cannot inspect another customer's eligibility",async t=>{
 const ctx=await world(t);await seedOwnedPet(ctx.db,"OTHER","OTHER-PET","Pepper");assert.equal((await read(ctx,{...fields,customerId:"OTHER"})).status,403);
 const anonymous=await read(ctx,fields,"");assert.ok([401,403].includes(anonymous.status));
});
for(const changes of [{orderValue:"1.001"},{orderValue:"NaN"},{isSubscription:"yes"},{serviceCode:"unknown"},{channel:"admin"},{paymentMode:"free"},{cityId:""}])test(`malformed offer context cannot broaden the response: ${JSON.stringify(changes)}`,async t=>{
 const ctx=await world(t),r=await read(ctx,{...fields,...changes});assert.equal(r.status,400);assert.equal(r.body.data,undefined);
});
test("a partial context is refused instead of returning unrelated offers",async t=>{const ctx=await world(t);assert.equal((await read(ctx,{customerId:"C-OFFER",serviceCode:"grooming"})).status,400);});
