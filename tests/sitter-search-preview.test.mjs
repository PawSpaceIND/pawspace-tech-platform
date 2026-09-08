import test from 'node:test';
import assert from 'node:assert/strict';
import {setupJourney,sessionCookie} from './helpers/grooming-journey-harness.mjs';
async function fixture(t){
 const ctx=await setupJourney();t.after(ctx.close);
 ctx.sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,name TEXT,primary_phone TEXT,email TEXT,city_id TEXT,status TEXT,created_at INTEGER,updated_at INTEGER);CREATE TABLE IF NOT EXISTS canonical_pets (id TEXT PRIMARY KEY,customer_id TEXT,name TEXT,species TEXT,breed TEXT,vaccination_status TEXT,created_at INTEGER,updated_at INTEGER)");
 ctx.sqlite.prepare("INSERT OR REPLACE INTO canonical_customers(id,name,primary_phone,city_id,status,created_at,updated_at) VALUES ('SEARCH-C','Search Customer','9000800941','blr','active',?,?)").run(Date.now(),Date.now());
 ctx.sqlite.prepare("INSERT OR REPLACE INTO canonical_pets(id,customer_id,name,species,vaccination_status,created_at,updated_at) VALUES ('SEARCH-P','SEARCH-C','Milo','dog','verified',?,?)").run(Date.now(),Date.now());
 const cookie=await sessionCookie(ctx.db,'customer','SEARCH-C','customer:SEARCH-C');
 const start=new Date(Date.now()+7*86400000);start.setUTCHours(3,30,0,0);
 const input={action:'preview',clientRequestId:'SEARCH-ONLY',customerId:'SEARCH-C',petIds:['SEARCH-P'],serviceCode:'pet_sitting',serviceAddress:'100 Feet Road, Indiranagar, Bengaluru',servicePincode:'560038',scheduledStart:start.toISOString(),scheduledEnd:new Date(start.getTime()+86400000).toISOString(),careMode:'overnight'};
 const {POST}=await import('../app/api/uat-scheduling/route.ts');
 return {...ctx,input,call:async(over={})=>{const response=await POST(new Request('https://uat.pawspace.in/api/uat-scheduling',{method:'POST',headers:{'content-type':'application/json',cookie},body:JSON.stringify({...input,...over})}));return {status:response.status,body:await response.json()};}};
}
function count(sqlite,table){return sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)?sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n:0;}
test('sitter preview returns governed choices without reservation, decision or provider offer',async t=>{
 const c=await fixture(t),result=await c.call();assert.equal(result.status,200,JSON.stringify(result.body));
 assert.ok(result.body.data.providers.length>0,JSON.stringify(result.body));assert.equal(result.body.data.reserved,false);
 assert.deepEqual(Object.keys(result.body.data.providers[0]).sort(),['id','model','name']);
 for(const table of ['scheduling_reservations','scheduling_assignment_decisions','provider_assignment_offers'])assert.equal(count(c.sqlite,table),0,table);
});
test('sitter preview excludes leave, inactive and wrong-zone providers',async t=>{
 const c=await fixture(t);
 c.sqlite.prepare("UPDATE provider_capacity_profiles SET status='inactive' WHERE id='sit_sana'").run();
 c.sqlite.prepare("UPDATE provider_capacity_profiles SET zones_json='[\"blr-west\"]' WHERE id='sit_neha'").run();
 c.sqlite.prepare("INSERT INTO provider_unavailability(id,provider_id,starts_at,ends_at,reason,status,created_by,created_at,updated_at) VALUES ('SEARCH-LEAVE','sit_asha',?,?,'Leave','active','fixture',?,?)").run(c.input.scheduledStart,c.input.scheduledEnd,Date.now(),Date.now());
 const r=await c.call();assert.equal(r.status,200,JSON.stringify(r.body));assert.deepEqual(r.body.data.providers,[]);
});
test('sitter preview rejects foreign customer and foreign pet',async t=>{
 const c=await fixture(t);assert.equal((await c.call({customerId:'FOREIGN'})).status,403);
 c.sqlite.prepare("UPDATE canonical_pets SET customer_id='FOREIGN' WHERE id='SEARCH-P'").run();assert.equal((await c.call()).status,403);
});

test('a no-longer-available selected sitter is not silently substituted',async t=>{
 const c=await fixture(t);c.sqlite.prepare("UPDATE provider_capacity_profiles SET status='inactive' WHERE id='sit_sana'").run();
 const r=await c.call({action:'reserve',preferredProviderId:'sit_sana'});assert.equal(r.status,409,JSON.stringify(r.body));assert.equal(r.body.error,'SELECTED_SITTER_UNAVAILABLE');assert.equal(count(c.sqlite,'scheduling_reservations'),0);
});


test('scheduling gives safe address guidance before creating any reservation',async t=>{
 const c=await fixture(t),invalid=await c.call({action:'reserve',serviceCode:'dog_walking',serviceAddress:'short'});
 assert.equal(invalid.status,400);assert.equal(invalid.body.code,'SERVICE_ADDRESS_UNVERIFIED');assert.match(invalid.body.error,/Check the address and PIN/);
 const prior=globalThis.__GROOM_GOLDEN_ENV__.PAWSPACE_TEST_SERVICE_DISCOVERY_FIXTURE;
 try{globalThis.__GROOM_GOLDEN_ENV__.PAWSPACE_TEST_SERVICE_DISCOVERY_FIXTURE='off';
 const missing=await c.call({action:'reserve',serviceCode:'dog_walking',serviceAddress:'',servicePincode:''});
 assert.equal(missing.status,409);assert.equal(missing.body.code,'SERVICE_ADDRESS_REQUIRED');assert.match(missing.body.error,/Save and verify/);
 assert.equal(count(c.sqlite,'scheduling_reservations'),0);
 }finally{globalThis.__GROOM_GOLDEN_ENV__.PAWSPACE_TEST_SERVICE_DISCOVERY_FIXTURE=prior;}
});
