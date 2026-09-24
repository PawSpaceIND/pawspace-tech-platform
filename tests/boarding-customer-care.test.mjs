import test from 'node:test';
import assert from 'node:assert/strict';
import {installWorkersHooks} from './helpers/module-hooks.mjs';
import {freshSqlite,makeD1,seedBoardingStay,customerSessionCookie} from './helpers/stay-harness.mjs';
import {loadOwnedBoardingStay,saveCustomerBoardingCare,boardingCareDraft} from '../lib/boarding-customer-care.ts';
installWorkersHooks('__BOARD_CARE_DB__','__BOARD_CARE_ENV__');
test('Boarding draft contains only owner instructions and requested extras, never home access or sample contacts',()=>{
 const empty=boardingCareDraft({},[],[],'');assert.deepEqual(empty,{feeding:'',medication:'',vet:'',emergencyContact:'',specialInstructions:''});
 const plan=boardingCareDraft({feeding:'Owner meal plan',homeAccess:'PRIVATE CODE',specialInstructions:'Quiet room'},['Senior care'],['Three walks'],'Pet food from home');assert.equal(plan.feeding,'Owner meal plan');assert.equal('homeAccess' in plan,false);assert.match(plan.specialInstructions,/Quiet room/);assert.match(plan.specialInstructions,/subject to host agreement/);assert.doesNotMatch(JSON.stringify(plan),/PRIVATE CODE/);
});
test('owned Boarding read rejects wrong, ambiguous and incomplete responses',async t=>{const old=globalThis.fetch;t.after(()=>{globalThis.fetch=old;});for(const data of [{},[{id:'S',booking_id:'OTHER',status:'confirmed'}],[{id:'S',booking_id:'B',status:'confirmed'},{id:'S2',booking_id:'B',status:'confirmed'}]]){globalThis.fetch=async()=>Response.json({data});await assert.rejects(loadOwnedBoardingStay('B'),/incomplete|ambiguous|another booking/);}globalThis.fetch=async()=>Response.json({data:[]});assert.equal(await loadOwnedBoardingStay('B'),null);});
test('care save only acknowledges the matching canonical stay and booking',async t=>{const old=globalThis.fetch;t.after(()=>{globalThis.fetch=old;});let body;globalThis.fetch=async(_url,init)=>{if(!init.method)return Response.json({data:[{id:'S',booking_id:'B',status:'confirmed'}]});body=JSON.parse(init.body);return Response.json({data:{stayId:'OTHER',bookingId:'B',status:'care_plan_ready'}});};await assert.rejects(saveCustomerBoardingCare('B',{vet:'Owner vet',emergencyContact:'Owner contact'},'RETRY'),/not confirmed/);assert.equal(body.idempotencyKey,'RETRY');assert.equal(body.stayId,'S');});
test('owned Boarding care persists and replays once without changing the booked stay or price',async t=>{
 const sqlite=freshSqlite(),db=makeD1(sqlite);t.after(()=>sqlite.close());globalThis.__BOARD_CARE_DB__=db;globalThis.__BOARD_CARE_ENV__={PAWSPACE_PAYMENT_ENV:'sandbox',PAWSPACE_PAYMENT_LIVE_APPROVED:'false'};const seed=await seedBoardingStay(db,sqlite),route=await import('../app/api/boarding-stays/route.ts');let cookie=(await customerSessionCookie(db,{principalKey:'customer:boarding-care',customerId:seed.customerId})).cookie;
 const old=globalThis.fetch;t.after(()=>{globalThis.fetch=old;});globalThis.fetch=async(path,init={})=>route[init.method||'GET'](new Request(new URL(path,'https://uat.pawspace.test'),{...init,headers:{...init.headers,cookie}}));
 const before=sqlite.prepare('SELECT status,scheduled_start,scheduled_end,total_amount FROM canonical_bookings WHERE id=?').get(seed.bookingId),plan=boardingCareDraft({vet:'Owner vet',emergencyContact:'Owner emergency contact',feeding:'Owner meal routine'},['Senior care'],[],'');
 await saveCustomerBoardingCare(seed.bookingId,plan,'BOARD-CARE-RETRY');await saveCustomerBoardingCare(seed.bookingId,plan,'BOARD-CARE-RETRY');const stay=await loadOwnedBoardingStay(seed.bookingId);assert.deepEqual(stay.carePlan.plan,plan);assert.equal(stay.events.filter(e=>e.event_type==='care_plan_ready').length,1);assert.deepEqual(sqlite.prepare('SELECT status,scheduled_start,scheduled_end,total_amount FROM canonical_bookings WHERE id=?').get(seed.bookingId),before);
 await assert.rejects(saveCustomerBoardingCare(seed.bookingId,{feeding:'Missing contacts'},'INVALID-PLAN'),/emergency contact|vet/);assert.deepEqual((await loadOwnedBoardingStay(seed.bookingId)).carePlan.plan,plan,'failed replacement preserves the saved owner plan');
 cookie=(await customerSessionCookie(db,{principalKey:'customer:foreign-board',customerId:'FOREIGN'})).cookie;await assert.rejects(loadOwnedBoardingStay(seed.bookingId),/ownership/i);await assert.rejects(saveCustomerBoardingCare(seed.bookingId,plan,'FOREIGN'),/ownership/i);
});
test('timed-out and malformed Boarding reads fail visibly',async t=>{const oldFetch=globalThis.fetch,oldTimer=globalThis.setTimeout;t.after(()=>{globalThis.fetch=oldFetch;globalThis.setTimeout=oldTimer;});globalThis.fetch=async()=>new Response('<html>Unavailable</html>',{status:502});await assert.rejects(loadOwnedBoardingStay('B'),/could not be read/);globalThis.setTimeout=fn=>oldTimer(fn,1);globalThis.fetch=async(_url,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError'))));await assert.rejects(loadOwnedBoardingStay('B'),/timed out/);});

test('care snapshot, ready status, event and retry receipt roll back together on a late write failure',async t=>{
 const sqlite=freshSqlite(),db=makeD1(sqlite);t.after(()=>sqlite.close());
 globalThis.__BOARD_CARE_DB__=db;globalThis.__BOARD_CARE_ENV__={PAWSPACE_PAYMENT_ENV:'sandbox',PAWSPACE_PAYMENT_LIVE_APPROVED:'false'};
 const seed=await seedBoardingStay(db,sqlite),{mutateBoardingStay}=await import('../lib/boarding-stay-lifecycle.ts');
 const input={stayId:seed.stayId,action:'submit_care_plan',actorId:'synthetic-test-customer',idempotencyKey:'atomic-care-retry',carePlan:{vet:'Synthetic vet',emergencyContact:'Synthetic caretaker',feeding:'Owner feeding instructions'}};
 for(const statement of ['INSERT INTO boarding_stay_events','INSERT INTO boarding_stay_action_keys']){
   db.onSql(statement,()=>{throw new Error('injected care-write outage');});
   await assert.rejects(()=>mutateBoardingStay(db,input),/injected care-write outage/);
   assert.equal(sqlite.prepare('SELECT care_plan_status FROM boarding_stays WHERE id=?').get(seed.stayId).care_plan_status,'required');
   assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM boarding_care_plan_snapshots').get().n,0);
   assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM boarding_stay_events').get().n,0);
   assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM boarding_stay_action_keys').get().n,0);
 }
 await mutateBoardingStay(db,input);assert.equal((await mutateBoardingStay(db,input)).duplicatePrevented,true);
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM boarding_stay_events').get().n,1);
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM canonical_bookings').get().n,1);
 assert.equal(sqlite.prepare('SELECT care_plan_status FROM boarding_stays').get().care_plan_status,'ready');
});
