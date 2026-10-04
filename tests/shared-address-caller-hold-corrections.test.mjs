/**
 * Shared-caller HOLD corrections (review of b14282016): three reproduced counterexamples, now required behaviour.
 *
 *  1. A present but corrupt or unreadable reservation binding is NOT a legacy absence: the doorstep save refuses
 *     with zero doorstep, account-address or geocode writes. Genuine legacy absence keeps its behaviour.
 *  2. A Food order refusal never mutates the canonical customer row: full-row value equality on every refusal,
 *     and a post-validation failure restores the row.
 *  3. A later explicit account-save choice on the same, already-recorded doorstep is honoured (deduplicated, never
 *     replacing the booking doorstep or the default address) and the response reports the actual saved state.
 *
 * Real routes and SQLite through the journey harness; every row comparison is a full SELECT * value comparison.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {setupJourney,runCompletedJourney,routeCall,sessionCookie} from "./helpers/grooming-journey-harness.mjs";
import {seedOwnedPet} from "./helpers/saved-pet-fixture.mjs";

const LOCATION="../../app/api/grooming-service-location/route.ts";
const rows=(sqlite,sql,...args)=>sqlite.prepare(sql).all(...args).map(row=>({...row}));
const tableExists=(sqlite,name)=>Boolean(sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(name));
function journeyConfig(id){
 const start=new Date(Date.now()+3*86_400_000);start.setUTCHours(3,30,0,0);
 return {customerId:`LOCAL-${id}`,customerName:"Anita",phone:`+9199000${String(Math.abs([...id].reduce((a,c)=>a*31+c.charCodeAt(0),7))%100000).padStart(5,"0")}`,petSourceId:`PET-${id}`,petName:"Milo",cityId:"blr",zoneId:"blr-east",pincode:"560038",latitude:12.9716,longitude:77.5946,preferredProviderId:"groom_arun",groupId:`GROOM-${id}`,start:start.toISOString(),stopAfterCapture:true};
}
/** A completed journey whose doorstep and saved addresses are removed locally, so the next POST is a first save. */
async function firstSaveWorld(t,id){
 const ctx=await setupJourney();t.after(ctx.close);
 const config=journeyConfig(id),journey=await runCompletedJourney(ctx,config);
 assert.equal(journey.location.status,201,JSON.stringify(journey.location.body));
 const original=ctx.sqlite.prepare("SELECT address_id FROM booking_service_locations WHERE booking_id=?").get(journey.bookingId).address_id;
 ctx.sqlite.prepare("DELETE FROM booking_service_locations WHERE booking_id=?").run(journey.bookingId);
 ctx.sqlite.prepare("DELETE FROM customer_addresses WHERE customer_id=?").run(config.customerId);
 const post=body=>routeCall(LOCATION,"POST","/api/grooming-service-location",{bookingId:journey.bookingId,customerId:config.customerId,...body},journey.customerCookie);
 const snapshot=()=>({doorstep:rows(ctx.sqlite,"SELECT * FROM booking_service_locations WHERE booking_id=?",journey.bookingId),addresses:rows(ctx.sqlite,"SELECT * FROM customer_addresses WHERE customer_id=?",config.customerId),geocodes:rows(ctx.sqlite,"SELECT * FROM customer_service_address_geocodes ORDER BY address_id"),provenance:tableExists(ctx.sqlite,"customer_service_address_geocode_provenance")?rows(ctx.sqlite,"SELECT * FROM customer_service_address_geocode_provenance ORDER BY address_id"):[]});
 return {...ctx,config,journey,original,post,snapshot,reservedAddress:`${config.customerName} service address`};
}
const setDecision=(w,json)=>w.sqlite.prepare("UPDATE scheduling_assignment_decisions SET shortlist_json=? WHERE group_id=?").run(json,w.config.groupId);
const decisionJson=w=>JSON.parse(w.sqlite.prepare("SELECT shortlist_json FROM scheduling_assignment_decisions WHERE group_id=?").get(w.config.groupId).shortlist_json);

// ------------------------------------------------------------------ 1. corrupt authority fails CLOSED
for(const [label,corrupt] of [
 ["unparseable JSON (the reproduced canary)",()=>"{corrupt binding"],
 ["a JSON primitive",()=>"42"],
 ["a request that is not an object",w=>{const d=decisionJson(w);d.request="tampered";return JSON.stringify(d);}],
 ["a null request",w=>{const d=decisionJson(w);d.request=null;return JSON.stringify(d);}],
 ["request whose serviceAddressId is not a string",w=>{const d=decisionJson(w);d.request.serviceAddressId=42;return JSON.stringify(d);}],
 ["request whose serviceAddressId is an empty string",w=>{const d=decisionJson(w);d.request.serviceAddressId="";return JSON.stringify(d);}],
]){
 test(`corrupt reservation binding (${label}): refused with zero doorstep, account-address or geocode writes`,async t=>{
  const w=await firstSaveWorld(t,`CORRUPT-${label.length}`);
  setDecision(w,corrupt(w));
  const before=w.snapshot();
  for(const body of [{address:"Different flat 9, Indiranagar",pincode:"560038",saveAddress:false},{address:w.reservedAddress,pincode:"560038",saveAddress:true}]){
   const answer=await w.post(body);
   assert.equal(answer.status,409,JSON.stringify(answer.body));
   assert.equal(answer.body.code,"booking_doorstep_unverifiable");
   assert.deepEqual(w.snapshot(),before,"no doorstep, account address, geocode or provenance row changed");
  }
 });
}
test("unreadable reservation binding (database read error): refused with zero writes",async t=>{
 const w=await firstSaveWorld(t,"UNREADABLE");
 // The decisions table becomes a view over a missing table: present, but every read errors.
 w.sqlite.exec("ALTER TABLE scheduling_assignment_decisions RENAME TO scheduling_assignment_decisions_hidden;CREATE VIEW scheduling_assignment_decisions AS SELECT * FROM scheduling_assignment_decisions_missing;");
 const before=w.snapshot();
 const answer=await w.post({address:"Different flat 9, Indiranagar",pincode:"560038",saveAddress:false});
 assert.equal(answer.status,409,JSON.stringify(answer.body));assert.equal(answer.body.code,"booking_doorstep_unverifiable");
 assert.deepEqual(w.snapshot(),before);
});
test("genuine legacy absence keeps legacy behaviour: no decisions table, no decision row, or a readable decision that recorded no doorstep",async t=>{
 for(const [label,make] of [
  ["decision recorded no doorstep",w=>{const d=decisionJson(w);delete d.request.serviceAddressId;setDecision(w,JSON.stringify(d));}],
  ["older array-shaped shortlist (the shared Stay harness legacy shape)",w=>setDecision(w,JSON.stringify(["groom_arun"]))],
  ["object shortlist without a request",w=>setDecision(w,JSON.stringify({choices:[{provider:"groom_arun"}]}))],
  ["no decision row for the group",w=>w.sqlite.prepare("DELETE FROM scheduling_assignment_decisions WHERE group_id=?").run(w.config.groupId)],
  ["no decisions table at all",w=>w.sqlite.exec("DROP TABLE scheduling_assignment_decisions")],
 ]){
  const w=await firstSaveWorld(t,`LEGACY-${label.length}`);
  make(w);
  const answer=await w.post({address:w.reservedAddress,pincode:"560038",saveAddress:false});
  assert.equal(answer.status,201,`${label}: ${JSON.stringify(answer.body)}`);
  assert.equal(w.snapshot().doorstep.length,1,label);
 }
});
test("ordinary bound save and idempotent repeat are unchanged",async t=>{
 const w=await firstSaveWorld(t,"ORDINARY");
 const first=await w.post({address:w.reservedAddress,pincode:"560038",saveAddress:false});
 assert.equal(first.status,201,JSON.stringify(first.body));assert.equal(w.snapshot().doorstep[0].address_id,w.original);
 const after=w.snapshot();
 const again=await w.post({address:w.reservedAddress,pincode:"560038",saveAddress:false});
 assert.equal(again.status,200,JSON.stringify(again.body));assert.equal(again.body.data.duplicatePrevented,true);
 assert.deepEqual(w.snapshot(),after,"an idempotent repeat writes nothing");
 const other=await w.post({address:"Different flat 9, Indiranagar",pincode:"560038",saveAddress:false});
 assert.equal(other.status,409);assert.equal(other.body.code,"booking_doorstep_mismatch");
});

// ------------------------------------------------------------------ 3. a later explicit account-save choice is honoured
test("same doorstep: saveAddress:false then saveAddress:true saves it once, keeps the default, and reports the real state",async t=>{
 const w=await firstSaveWorld(t,"LATERSAVE");
 // An existing default address that must stay the default.
 w.sqlite.prepare("INSERT INTO customer_addresses (id,customer_id,label,line1,line2,area,city,postal_code,is_default,created_at,updated_at) VALUES ('ADDR-DEFAULT-LOCAL',?,'Home','99 Default Road',NULL,'Indiranagar','Bengaluru','560038',1,1,1)").run(w.config.customerId);
 const first=await w.post({address:w.reservedAddress,pincode:"560038",saveAddress:false});
 assert.equal(first.status,201,JSON.stringify(first.body));
 assert.equal(first.body.data.accountAddressSaved,false,"first save did not keep the address");
 assert.deepEqual(w.snapshot().addresses.map(a=>a.id),["ADDR-DEFAULT-LOCAL"]);
 const doorstep=w.snapshot().doorstep;
 const later=await w.post({address:w.reservedAddress,pincode:"560038",saveAddress:true});
 assert.equal(later.status,200,JSON.stringify(later.body));
 assert.equal(later.body.data.accountAddressSaved,true,"the response reports the actual saved state");
 const saved=w.snapshot().addresses;
 assert.equal(saved.length,2,"the doorstep address is now saved");
 const added=saved.find(a=>a.id!=="ADDR-DEFAULT-LOCAL");
 assert.equal(added.id,doorstep[0].address_id,"the saved address is exactly the booking doorstep");
 assert.equal(added.is_default,0,"it does not replace the default");
 assert.equal(saved.find(a=>a.id==="ADDR-DEFAULT-LOCAL").is_default,1);
 assert.deepEqual(w.snapshot().doorstep,doorstep,"the booking doorstep is not rewritten");
 const before=w.snapshot();
 const repeat=await w.post({address:w.reservedAddress,pincode:"560038",saveAddress:true});
 assert.equal(repeat.status,200);assert.equal(repeat.body.data.accountAddressSaved,true);
 assert.deepEqual(w.snapshot(),before,"a repeated true deduplicates");
 const unchanged=await w.post({address:w.reservedAddress,pincode:"560038",saveAddress:false});
 assert.equal(unchanged.body.data.accountAddressSaved,true,"false never deletes a saved address; the response still reports it");
 assert.deepEqual(w.snapshot(),before);
});

// ------------------------------------------------------------------ 2. Food refusals never write the canonical customer
const ORDERS="../../app/api/food-orders/route.ts";
const SKU="food-uat-dog-adult-2kg";
const A={address:"12 Rest House Road, Indiranagar, Bengaluru",pincode:"560038"};
async function foodWorld(t){
 const ctx=await setupJourney();t.after(ctx.close);
 const governance=await import("../lib/food-governance.ts");
 await governance.ensureFoodGovernanceTables(ctx.db);
 await seedOwnedPet(ctx.db,"LOCAL-FOOD","LOCAL-FOOD-DOG","Bruno");await seedOwnedPet(ctx.db,"LOCAL-OTHER","LOCAL-OTHER-DOG","Rex");
 const cookies={"LOCAL-FOOD":await sessionCookie(ctx.db,"customer","LOCAL-FOOD","customer:LOCAL-FOOD"),"LOCAL-OTHER":await sessionCookie(ctx.db,"customer","LOCAL-OTHER","customer:LOCAL-OTHER")};
 const quote=(customerId="LOCAL-FOOD",petId="LOCAL-FOOD-DOG",zoneId="blr-east")=>governance.createFoodQuote(ctx.db,{sku:SKU,quantity:1,zoneId,paymentMode:"sandbox_deferred",customerId,petIds:[petId]});
 const order=(body,customerId="LOCAL-FOOD",name="Original local name")=>routeCall(ORDERS,"POST","/api/food-orders",{customer:{id:customerId,name,primaryPhone:customerId==="LOCAL-FOOD"?"9000000881":"9000000882"},cityId:"blr",zoneId:"blr-east",...body},cookies[customerId]);
 const customerRow=id=>tableExists(ctx.sqlite,"canonical_customers")?rows(ctx.sqlite,"SELECT * FROM canonical_customers WHERE id=?",id):[];
 const commerce=()=>({orders:rows(ctx.sqlite,"SELECT * FROM food_orders ORDER BY id"),snapshots:rows(ctx.sqlite,"SELECT * FROM food_order_delivery_snapshots ORDER BY order_id"),payments:rows(ctx.sqlite,"SELECT * FROM food_order_payments ORDER BY id"),inventory:rows(ctx.sqlite,"SELECT * FROM food_inventory_uat ORDER BY sku,zone_id"),quotes:rows(ctx.sqlite,"SELECT * FROM food_commercial_quotes ORDER BY id")});
 /** Records every INSERT/UPDATE/DELETE on canonical_customers, so "nothing was written" is distinguishable from "written then restored". */
 const watchCustomerWrites=()=>{
  ctx.sqlite.exec("CREATE TABLE IF NOT EXISTS local_customer_writes (op TEXT NOT NULL,id TEXT);CREATE TRIGGER IF NOT EXISTS local_cw_i AFTER INSERT ON canonical_customers BEGIN INSERT INTO local_customer_writes VALUES ('insert',NEW.id); END;CREATE TRIGGER IF NOT EXISTS local_cw_u AFTER UPDATE ON canonical_customers BEGIN INSERT INTO local_customer_writes VALUES ('update',NEW.id); END;CREATE TRIGGER IF NOT EXISTS local_cw_d AFTER DELETE ON canonical_customers BEGIN INSERT INTO local_customer_writes VALUES ('delete',OLD.id); END;DELETE FROM local_customer_writes;");
  return ()=>rows(ctx.sqlite,"SELECT * FROM local_customer_writes");
 };
 return {...ctx,governance,quote,order,customerRow,commerce,watchCustomerWrites};
}
test("Food: the reproduced canary - same key, different delivery address: 409 and the canonical customer row is byte-for-byte unchanged",async t=>{
 const w=await foodWorld(t),q=await w.quote();
 const first=await w.order({idempotencyKey:"LOCAL-FOOD-KEY",quoteId:q.quoteId,delivery:A});
 assert.equal(first.status,201,JSON.stringify(first.body));
 const customer=w.customerRow("LOCAL-FOOD"),commerce=w.commerce();
 assert.equal(customer.length,1);assert.equal(customer[0].name,"Original local name");
 const writes=w.watchCustomerWrites();
 const replay=await w.order({idempotencyKey:"LOCAL-FOOD-KEY",quoteId:q.quoteId,delivery:{address:"9 Other Lane, Indiranagar, Bengaluru",pincode:"560038"}},"LOCAL-FOOD","Unexpected overwritten local name");
 assert.equal(replay.status,409,JSON.stringify(replay.body));assert.equal(replay.body.code,"food_order_delivery_conflict");
 assert.deepEqual(w.customerRow("LOCAL-FOOD"),customer,"full canonical_customers row unchanged");
 assert.deepEqual(writes(),[],"the refusal never wrote the customer row at all (not written-then-restored)");
 assert.deepEqual(w.commerce(),commerce,"no order, snapshot, payment, inventory or quote change");
});
test("Food: every refusal leaves the canonical customer rows (both customers) and all commerce rows exactly as they were",async t=>{
 const w=await foodWorld(t);
 const used=await w.quote(),open=await w.quote(),otherQuote=await w.quote("LOCAL-OTHER","LOCAL-OTHER-DOG");
 assert.equal((await w.order({idempotencyKey:"LOCAL-USED",quoteId:used.quoteId,delivery:A})).status,201);
 const southQuote=await w.quote("LOCAL-FOOD","LOCAL-FOOD-DOG","blr-south");
 const cases=[
  ["delivery conflict on the same key",{idempotencyKey:"LOCAL-USED",quoteId:used.quoteId,delivery:{address:"9 Other Lane, Indiranagar, Bengaluru",pincode:"560038"}}],
  ["different quote on the same key",{idempotencyKey:"LOCAL-USED",quoteId:open.quoteId,delivery:A}],
  ["malformed PIN",{idempotencyKey:"LOCAL-K1",quoteId:open.quoteId,delivery:{address:A.address,pincode:"5600 38"}}],
  ["missing PIN",{idempotencyKey:"LOCAL-K2",quoteId:open.quoteId,delivery:{address:A.address,pincode:""}}],
  ["incomplete address",{idempotencyKey:"LOCAL-K3",quoteId:open.quoteId,delivery:{address:"short",pincode:"560038"}}],
  ["delivery zone differs from the quote",{idempotencyKey:"LOCAL-K4",quoteId:open.quoteId,delivery:{address:"5 Koramangala 4th Block, Bengaluru",pincode:"560034"}}],
  ["uncovered PIN",{idempotencyKey:"LOCAL-K5",quoteId:open.quoteId,delivery:{address:"1 Connaught Place, New Delhi",pincode:"110001"}}],
  ["quote already linked to an order",{idempotencyKey:"LOCAL-K6",quoteId:used.quoteId,delivery:A}],
  ["quote priced for another zone",{idempotencyKey:"LOCAL-K7",quoteId:southQuote.quoteId,delivery:A}],
  ["another customer's quote",{idempotencyKey:"LOCAL-K8",quoteId:otherQuote.quoteId,delivery:A}],
  ["unknown quote",{idempotencyKey:"LOCAL-K9",quoteId:"FQ-DOES-NOT-EXIST",delivery:A}],
 ];
 const writes=w.watchCustomerWrites();
 for(const [label,body] of cases){
  const before={food:w.customerRow("LOCAL-FOOD"),other:w.customerRow("LOCAL-OTHER"),commerce:w.commerce()};
  const answer=await w.order(body,"LOCAL-FOOD","Unexpected overwritten local name");
  assert.ok(answer.status>=400&&answer.status<500,`${label}: ${answer.status} ${JSON.stringify(answer.body)}`);
  assert.deepEqual({food:w.customerRow("LOCAL-FOOD"),other:w.customerRow("LOCAL-OTHER"),commerce:w.commerce()},before,`${label}: nothing changed`);
  assert.deepEqual(writes(),[],`${label}: no customer write happened at any point`);
 }
 const beforeForeign={food:w.customerRow("LOCAL-FOOD"),other:w.customerRow("LOCAL-OTHER"),commerce:w.commerce()};
 const foreignKey=await w.order({idempotencyKey:"LOCAL-USED",quoteId:otherQuote.quoteId,delivery:A},"LOCAL-OTHER","Intruder name");
 assert.equal(foreignKey.status,403,JSON.stringify(foreignKey.body));
 assert.deepEqual({food:w.customerRow("LOCAL-FOOD"),other:w.customerRow("LOCAL-OTHER"),commerce:w.commerce()},beforeForeign,"a key owned by another customer changes nobody's row");
 assert.deepEqual(writes(),[],"and writes nothing");
});
test("Food: successful orders and same-address replays keep updating the customer profile as before",async t=>{
 const w=await foodWorld(t),q=await w.quote();
 assert.equal((await w.order({idempotencyKey:"LOCAL-OK",quoteId:q.quoteId,delivery:A},"LOCAL-FOOD","First name")).status,201);
 assert.equal(w.customerRow("LOCAL-FOOD")[0].name,"First name");
 const replay=await w.order({idempotencyKey:"LOCAL-OK",quoteId:q.quoteId,delivery:A},"LOCAL-FOOD","Updated name");
 assert.equal(replay.status,200,JSON.stringify(replay.body));
 assert.equal(w.customerRow("LOCAL-FOOD")[0].name,"Updated name","an accepted replay still refreshes the profile, as before");
});
test("Food: a failure after validation restores the canonical customer row exactly",async t=>{
 const w=await foodWorld(t),q1=await w.quote(),q2=await w.quote();
 assert.equal((await w.order({idempotencyKey:"LOCAL-SEED",quoteId:q1.quoteId,delivery:A},"LOCAL-FOOD","Original local name")).status,201);
 const customer=w.customerRow("LOCAL-FOOD"),commerce=w.commerce();
 w.sqlite.exec("CREATE TRIGGER fail_local_food_event BEFORE INSERT ON food_order_events BEGIN SELECT RAISE(ABORT,'forced failure'); END;");
 const failed=await w.order({idempotencyKey:"LOCAL-FAIL",quoteId:q2.quoteId,delivery:A},"LOCAL-FOOD","Unexpected overwritten local name");
 assert.ok(failed.status>=400,JSON.stringify(failed.body));
 assert.deepEqual(w.customerRow("LOCAL-FOOD"),customer,"the canonical customer row is restored");
 // The existing order rollback releases reserved units with `updated_at=now`; every other value must match exactly.
 const withoutInventoryClock=state=>({...state,inventory:state.inventory.map(({updated_at,...row})=>row)});
 assert.deepEqual(withoutInventoryClock(w.commerce()),withoutInventoryClock(commerce),"and the order rolls back as before");
});

// ------------------------------------------------------------------ 2b. Food: a failed order never clobbers a committed concurrent customer edit
// Reproduces the independent review's race (b14282016 -> 91e2a222a): the order validates, its profile write is pending,
// a competing profile update commits outside the order's transaction (harness beforeBatch), and the order's atomic batch
// then aborts. Required: the competitor's committed row survives exactly, and the failed order leaves no trace.
async function raceWorld(t,customerId){
 const w=await foodWorld(t);
 await seedOwnedPet(w.db,customerId,`${customerId}-PET`,"Local dog");
 const cookie=await sessionCookie(w.db,"customer",customerId,`customer:${customerId}`);
 const quote=()=>w.governance.createFoodQuote(w.db,{sku:SKU,quantity:1,zoneId:"blr-east",paymentMode:"sandbox_deferred",customerId,petIds:[`${customerId}-PET`]});
 const order=(body,name)=>routeCall(ORDERS,"POST","/api/food-orders",{customer:{id:customerId,name,primaryPhone:"9000000991"},cityId:"blr",zoneId:"blr-east",delivery:A,...body},cookie);
 const failNextOrderBatch=competitor=>{
  w.sqlite.exec("CREATE TRIGGER IF NOT EXISTS local_order_failure BEFORE INSERT ON food_order_events BEGIN SELECT RAISE(ABORT,'local forced order failure'); END;");
  let committed=false;
  w.db.beforeBatch=async items=>{if(!committed&&items.some(item=>String(item._sql).startsWith("INSERT INTO food_orders "))){competitor?.();committed=true;}};
  return ()=>committed;
 };
 return {...w,quote,order,failNextOrderBatch,row:()=>w.customerRow(customerId)};
}
test("Food race: a failed order never restores stale bytes over a committed concurrent edit (existing customer)",async t=>{
 const w=await raceWorld(t,"LOCAL-RACE");
 assert.equal((await w.order({idempotencyKey:"LOCAL-RACE-FIRST",quoteId:(await w.quote()).quoteId},"Original local profile")).status,201);
 const q=await w.quote(),commerce=w.commerce();
 const committed=w.failNextOrderBatch(()=>w.sqlite.prepare("UPDATE canonical_customers SET name=?,email=?,updated_at=? WHERE id=?").run("Successful concurrent profile","local-concurrent@example.test",1700000001234,"LOCAL-RACE"));
 const competitorRow=()=>({...w.row()[0]});
 const result=await w.order({idempotencyKey:"LOCAL-RACE-FAIL",quoteId:q.quoteId},"Failing order profile");
 assert.ok(result.status>=400,JSON.stringify(result.body));assert.equal(committed(),true);
 const after=competitorRow();
 assert.deepEqual([after.name,after.email,after.updated_at],["Successful concurrent profile","local-concurrent@example.test",1700000001234],"the competitor's committed edit survives exactly");
 assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM food_orders WHERE idempotency_key=?").get("LOCAL-RACE-FAIL").n,0,"the failed order is absent");
 const withoutInventoryClock=state=>({...state,inventory:state.inventory.map(({updated_at:_clock,...row})=>row)});
 assert.deepEqual(withoutInventoryClock(w.commerce()),withoutInventoryClock(commerce),"commerce rolls back as before");
});
test("Food race: a failed first order never deletes a customer row a concurrent writer created (previously missing customer)",async t=>{
 const w=await raceWorld(t,"LOCAL-RACE-NEW");
 assert.deepEqual(w.row(),[],"no canonical customer row yet");
 const q=await w.quote();
 const committed=w.failNextOrderBatch(()=>w.sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,email,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run("LOCAL-RACE-NEW","blr","Concurrent signup profile","9000000777","local-signup@example.test",1700000005678,1700000005678));
 const result=await w.order({idempotencyKey:"LOCAL-RACE-NEW-FAIL",quoteId:q.quoteId},"Failing order profile");
 assert.ok(result.status>=400,JSON.stringify(result.body));assert.equal(committed(),true);
 const rows=w.row();
 assert.equal(rows.length,1,"the concurrently created row is not deleted");
 assert.deepEqual([rows[0].name,rows[0].email,rows[0].updated_at],["Concurrent signup profile","local-signup@example.test",1700000005678]);
});
test("Food race control: a failed first order with no competitor leaves no customer row behind",async t=>{
 const w=await raceWorld(t,"LOCAL-RACE-NONE");
 const q=await w.quote();
 const committed=w.failNextOrderBatch(null);
 const result=await w.order({idempotencyKey:"LOCAL-RACE-NONE-FAIL",quoteId:q.quoteId},"Failing order profile");
 assert.ok(result.status>=400,JSON.stringify(result.body));assert.equal(committed(),true);
 assert.deepEqual(w.row(),[],"the failed order's profile write did not persist");
});
