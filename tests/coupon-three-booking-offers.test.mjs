import test from "node:test";
import assert from "node:assert/strict";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
installWorkersHooks("__THREE_BOOKING_DB__");
const coupons=await import("../lib/coupon-governance.ts");
const offers=await import("../lib/customer-offers.ts");
const now=Date.now();
const campaign=(extra={})=>({id:"normal",code:"NORMAL",name:"Normal care offer",status:"active",serviceCodes:["grooming"],cityIds:["blr"],channels:["website"],customerKinds:["new","existing","subscriber"],packageScope:"selected",packageCodes:["dog-basic"],crossSellFromServices:[],firstOrderOnly:false,minOrder:500,maxOrder:null,subscriptionEligible:false,fullPaymentOnly:false,discountType:"fixed",discountValue:100,maxDiscount:100,perCustomerLimit:10,totalLimit:100,validFrom:now-60000,validUntil:now+3600000,...extra});
const context={serviceCode:"grooming",cityId:"blr",channel:"website",packageCode:"dog-basic",orderValue:1899,paymentMode:"full",isSubscription:false};
const quote=(db,extra={})=>coupons.quoteCoupon(db,{...context,code:"NORMAL",customerId:"C1",...extra});
async function world(t){
  const h=freshCountingD1();t.after(()=>h.sqlite.close());
  await coupons.seedUatCoupons(h.db);await offers.seedWelcomeCoupon(h.db);
  h.sqlite.exec("UPDATE coupon_campaigns SET status='paused'");await coupons.saveCouponCampaign(h.db,campaign());return h;
}
function booking(db,id,{customerId="C1",status="confirmed",service="grooming"}={}){
  return db.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,total_amount,created_by,created_at,updated_at) VALUES (?,?,?,'[\"P1\"]','[\"P1\"]','blr','east',?,'dog-basic','Bath',?,'PRV','2027-01-01T05:30:00Z','2027-01-01T07:30:00Z',?,1799,'test',?,?)").bind(id,`key-${id}`,customerId,service,`schedule-${id}`,status,now,now);
}
const prepared=(db,q,id)=>coupons.prepareCouponBooking(db,{quoteId:q.quoteId,bookingId:id,customerId:"C1",serviceCode:"grooming",cityId:"blr",packageCode:"dog-basic",submittedTotal:1799,submittedDiscount:100,idempotencyKey:`redeem-${id}`,now:Date.now()});
function atomic(sqlite,statements){sqlite.exec("BEGIN IMMEDIATE");try{for(const s of statements)sqlite.prepare(s.sql).run(...s.args);sqlite.exec("COMMIT");}catch(error){sqlite.exec("ROLLBACK");throw error;}}
for(const count of [0,1,2,3,4])test(`normal coupon eligibility with ${count} prior bookings is enforced by the server`,async t=>{
  const {db}=await world(t);for(let i=0;i<count;i++)await booking(db,`old-${i}`,{service:i%2?"boarding":"grooming"}).run();
  const result=await quote(db,{special:true,customerIds:["C1"]});assert.equal(result.valid,count<3);
  if(count>=3)assert.match(result.error,/first three bookings/);
  const listed=await offers.listAvailableCoupons(db,{customerId:"C1",context});
  assert.equal(listed.normalCouponsAllowed,count<3);assert.equal(listed.coupons.length,count<3?1:0);
});
test("failed and cancelled bookings do not consume the cross-service allowance",async t=>{
  const {db}=await world(t);await booking(db,"cancelled",{status:"cancelled"}).run();await booking(db,"failed",{status:"failed"}).run();
  await booking(db,"boarding",{service:"boarding"}).run();await booking(db,"training",{service:"dog_training"}).run();
  assert.equal((await coupons.customerFacts(db,"C1")).orderCount,2);assert.equal((await quote(db)).valid,true);
  await booking(db,"taxi",{service:"pet_taxi"}).run();assert.equal((await quote(db)).valid,false);
});
test("two concurrent quotes cannot both take the third booking; losing transaction rolls back",async t=>{
  const {db,sqlite}=await world(t);await booking(db,"old1").run();await booking(db,"old2").run();
  const qa=await quote(db),qb=await quote(db);assert.ok(qa.valid&&qb.valid);
  const a=await prepared(db,qa,"third"),b=await prepared(db,qb,"fourth");
  atomic(sqlite,[booking(db,"third"),a.redemptionStatement,a.claimStatement]);
  assert.throws(()=>atomic(sqlite,[booking(db,"fourth"),b.redemptionStatement,b.claimStatement]),/NOT NULL/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM canonical_bookings").get().n,3);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM coupon_redemptions").get().n,1);
  assert.equal(sqlite.prepare("SELECT status FROM coupon_quotes WHERE id=?").get(qb.quoteId).status,"open");
  const replay=await quote(db,{bookingKey:"key-third"});assert.equal(replay.valid,true);assert.equal(replay.quoteId,qa.quoteId);assert.equal(replay.replayed,true);
  assert.equal((await quote(db,{bookingKey:"key-nonexistent"})).valid,false);
  assert.equal((await quote(db,{bookingKey:"key-third",orderValue:1898})).valid,false);
});
test("an ordinary quote becomes ineligible when another booking takes the third place",async t=>{
  const {db}=await world(t);await booking(db,"old1").run();await booking(db,"old2").run();const q=await quote(db);await booking(db,"third").run();
  await assert.rejects(prepared(db,q,"fourth"),/first three bookings/);
});
test("only genuinely customer-bound special coupons work after three bookings and never appear in offers",async t=>{
  const {db,sqlite}=await world(t);for(let i=0;i<3;i++)await booking(db,`old-${i}`).run();
  await coupons.saveCouponCampaign(db,campaign({id:"private",code:"PRIVATE",customerIds:["C1"]}));
  const q=await quote(db,{code:"PRIVATE"});assert.equal(q.valid,true);
  assert.equal((await quote(db,{code:"PRIVATE",customerId:"C2"})).valid,false);
  const p=await prepared(db,q,"special-fourth");atomic(sqlite,[booking(db,"special-fourth"),p.redemptionStatement,p.claimStatement]);
  assert.equal((await offers.listAvailableCoupons(db,{customerId:"C1",context})).coupons.length,0);
  assert.equal((await offers.listAvailableCoupons(db,{customerId:"C2",context})).coupons.some(c=>c.code==="PRIVATE"),false);
});
test("contextual offers share quote eligibility and browse without creating any quote rows",async t=>{
  const {db,sqlite}=await world(t);await booking(db,"prior",{service:"boarding",status:"completed"}).run();
  for(const [id,extra] of Object.entries({wrongService:{serviceCodes:["boarding"]},wrongPackage:{packageCodes:["dog-makeover"]},wrongChannel:{channels:["whatsapp"]},expensive:{minOrder:2000},expired:{validUntil:now-1,validFrom:now-60000},private:{customerIds:["C1"]},crosssell:{crossSellFromServices:["dog_training"]}}))await coupons.saveCouponCampaign(db,campaign({id,code:id.toUpperCase(),...extra}));
  await coupons.saveCouponCampaign(db,campaign({id:"best",code:"BEST",discountValue:250,maxDiscount:250}));
  const before=sqlite.prepare("SELECT COUNT(*) n FROM coupon_quotes").get().n;
  const listed=await offers.listAvailableCoupons(db,{customerId:"C1",context});
  assert.deepEqual(listed.coupons.map(c=>c.code),["BEST","NORMAL"]);assert.deepEqual(listed.coupons.map(c=>c.savings),[250,100]);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM coupon_quotes").get().n,before);
  for(const item of listed.coupons){const q=await quote(db,{code:item.code});assert.equal(q.valid,true);assert.equal(q.discount,item.savings);assert.equal(q.finalAmount,item.finalAmount);}
  assert.deepEqual((await offers.listAvailableCoupons(db,{customerId:"C1",context:{...context,isSubscription:true}})).coupons,[]);
});


test("a first-order-only quote cannot be spent on a second booking, including a concurrent commit",async t=>{
  const {db,sqlite}=await world(t);await coupons.saveCouponCampaign(db,campaign({firstOrderOnly:true,customerIds:["C1"]}));
  const q=await quote(db),p=await prepared(db,q,"new");await booking(db,"competitor",{service:"boarding"}).run();
  assert.throws(()=>atomic(sqlite,[booking(db,"new"),p.redemptionStatement,p.claimStatement]),/NOT NULL/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM canonical_bookings").get().n,1);
  await assert.rejects(prepared(db,q,"new"),/first booking only/);
});
test("separate staff consumption also refuses ordinary coupons on booking four",async t=>{
  const {db,sqlite}=await world(t);const q=await quote(db);
  for(let i=0;i<4;i++)await booking(db,`b-${i}`).run();
  await assert.rejects(coupons.consumeCouponQuote(db,{quoteId:q.quoteId,bookingId:"b-3",customerId:"C1",idempotencyKey:"late-staff"}),/first three bookings/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM coupon_redemptions").get().n,0);
});

// Concurrent requests share a barrier so both finish preflight before either commits.
// The database still executes each atomic batch serially, as SQLite/D1 requires.
for (const ids of [["request-a", "request-b"], ["request-b", "request-a"]]) {
  test(`overlapping coupon requests reserve only one third booking: ${ids.join(",")}`, { timeout: 30000 }, async t => {
    const { db, sqlite } = await world(t);
    await booking(db, "prior-one").run(); await booking(db, "prior-two").run();
    let release, active = 0, peak = 0;
    const barrier = new Promise(resolve => { release = resolve; });
    const ready = [], attempted = [];
    const requests = ids.map(async id => {
      active++; peak = Math.max(peak, active);
      try {
        const q = await quote(db);
        assert.equal(q.valid, true); assert.equal(q.policySnapshot.orderCount, 2);
        const p = await prepared(db, q, id);
        ready.push({ id, quoteId: q.quoteId });
        if (ready.length === ids.length) release();
        await barrier;
        assert.equal(ready.length, 2, "both preflights complete before either commit");
        attempted.push(id);
        atomic(sqlite, [booking(db, id), p.redemptionStatement, p.claimStatement]);
        return { id, quoteId: q.quoteId };
      } finally { active--; }
    });
    const outcomes = await Promise.allSettled(requests);
    assert.equal(peak, 2); assert.equal(active, 0); assert.equal(attempted.length, 2);
    const winners = outcomes.filter(result => result.status === "fulfilled");
    const failures = outcomes.filter(result => result.status === "rejected");
    assert.equal(winners.length, 1); assert.equal(failures.length, 1);
    assert.match(String(failures[0].reason), /NOT NULL constraint failed: coupon_redemptions.campaign_id/);
    assert.doesNotMatch(String(failures[0].reason), /busy|locked|within a transaction/i);
    const winner = winners[0].value, loser = ready.find(item => item.id !== winner.id);
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM canonical_bookings").get().n, 3);
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM coupon_redemptions").get().n, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM canonical_bookings WHERE id=?").get(loser.id).n, 0);
    assert.equal(sqlite.prepare("SELECT status FROM coupon_quotes WHERE id=?").get(loser.quoteId).status, "open");
    assert.equal(sqlite.prepare("SELECT status FROM coupon_quotes WHERE id=?").get(winner.quoteId).status, "consumed");
    const replay = await quote(db, { bookingKey: `key-${winner.id}` });
    assert.equal(replay.valid, true); assert.equal(replay.quoteId, winner.quoteId);
    assert.equal((await quote(db, { bookingKey: `key-${loser.id}` })).valid, false);
  });
}
