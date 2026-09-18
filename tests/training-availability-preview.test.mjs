import test from 'node:test';
import assert from 'node:assert/strict';
import {setupJourney,sessionCookie} from './helpers/grooming-journey-harness.mjs';

async function fixture(t){
 const ctx=await setupJourney();t.after(ctx.close);
 ctx.sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,name TEXT,primary_phone TEXT,email TEXT,city_id TEXT,status TEXT,created_at INTEGER,updated_at INTEGER);CREATE TABLE IF NOT EXISTS canonical_pets (id TEXT PRIMARY KEY,customer_id TEXT,name TEXT,species TEXT,breed TEXT,vaccination_status TEXT,created_at INTEGER,updated_at INTEGER)");
 ctx.sqlite.prepare("INSERT OR REPLACE INTO canonical_customers(id,name,primary_phone,city_id,status,created_at,updated_at) VALUES ('TRAIN-SEARCH-C','Training Search','9000800942','blr','active',?,?)").run(Date.now(),Date.now());
 ctx.sqlite.prepare("INSERT OR REPLACE INTO canonical_pets(id,customer_id,name,species,vaccination_status,created_at,updated_at) VALUES ('TRAIN-SEARCH-P','TRAIN-SEARCH-C','Bruno','dog','verified',?,?)").run(Date.now(),Date.now());
 const cookie=await sessionCookie(ctx.db,'customer','TRAIN-SEARCH-C','customer:TRAIN-SEARCH-C');
 const start=new Date(Date.now()+6*86400000);start.setUTCHours(4,30,0,0);
 const input={action:'preview',clientRequestId:'TRAIN-SEARCH-ONLY',customerId:'TRAIN-SEARCH-C',petIds:['TRAIN-SEARCH-P'],serviceCode:'dog_training',serviceAddress:'42 Indiranagar Double Road, Bengaluru',servicePincode:'560038',scheduledStart:start.toISOString(),scheduledEnd:new Date(start.getTime()+3600000).toISOString(),occurrences:2,cadenceDays:7};
 const {POST}=await import('../app/api/uat-scheduling/route.ts');
 const call=async(over={},session=cookie)=>{const r=await POST(new Request('https://uat.pawspace.in/api/uat-scheduling',{method:'POST',headers:{'content-type':'application/json',...(session?{cookie:session}:{})},body:JSON.stringify({...input,...over})}));return{status:r.status,body:await r.json()};};
 return{...ctx,input,call};
}
function counts(sqlite){return Object.fromEntries(['scheduling_reservations','scheduling_assignment_decisions','provider_assignment_offers','canonical_bookings'].map(table=>[table,sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)?sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n:0]));}

test('Training preview uses the canonical scheduler without creating holds or bookings',async t=>{
 const f=await fixture(t),before=counts(f.sqlite),r=await f.call();
 assert.equal(r.status,200,JSON.stringify(r.body));assert.ok(r.body.data.providers.length>0);
 assert.equal(r.body.data.availabilityChecked,true);assert.equal(r.body.data.reserved,false);
 assert.deepEqual(counts(f.sqlite),before);
});

test('Training preview checks later weekly sessions; reserve still refuses a newly conflicting chosen trainer',async t=>{
 const f=await fixture(t),first=await f.call();assert.equal(first.status,200,JSON.stringify(first.body));
 const chosen=first.body.data.providers[0].id;
 const later=value=>new Date(Date.parse(value)+7*86400000).toISOString();
 const occupied=await f.call({action:'reserve',clientRequestId:'TRAIN-LATER-HOLD',occurrences:1,scheduledStart:later(f.input.scheduledStart),scheduledEnd:later(f.input.scheduledEnd),preferredProviderId:chosen});
 assert.equal(occupied.status,200,JSON.stringify(occupied.body));
 const before=counts(f.sqlite),next=await f.call();assert.equal(next.status,200,JSON.stringify(next.body));
 assert.ok(!next.body.data.providers.some(p=>p.id===chosen),'a trainer busy only on session two must not be offered');
 assert.deepEqual(counts(f.sqlite),before,'preview must not reserve alternatives');
 const refused=await f.call({action:'reserve',clientRequestId:'TRAIN-CHOSEN-TAKEN',preferredProviderId:chosen});
 assert.equal(refused.status,409);assert.equal(refused.body.error,'SELECTED_PROVIDER_UNAVAILABLE');
 assert.deepEqual(counts(f.sqlite),before,'strict refusal must not substitute or create another hold');
 assert.ok(next.body.data.providers.length>0,'fixture has another eligible trainer');
 const accepted=await f.call({action:'reserve',clientRequestId:'TRAIN-ALTERNATIVE',preferredProviderId:next.body.data.providers[0].id});
 assert.equal(accepted.status,200,JSON.stringify(accepted.body));assert.equal(accepted.body.data.occurrences.length,2);
});

test('Training preview refuses anonymous, foreign-customer and foreign-pet requests',async t=>{
 const f=await fixture(t);assert.equal((await f.call({},'')).status,401);
 assert.equal((await f.call({customerId:'FOREIGN'})).status,403);
 f.sqlite.prepare("UPDATE canonical_pets SET customer_id='FOREIGN' WHERE id='TRAIN-SEARCH-P'").run();
 assert.equal((await f.call()).status,403);
 assert.equal(counts(f.sqlite).scheduling_reservations,0);
});
