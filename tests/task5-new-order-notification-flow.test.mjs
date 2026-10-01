// Exclusive Task5 QA for the owner-frozen notification candidate. No source edits/outbound.
// Actual route/auth/gateway and SQLite SQL; latest canonical projections, not persisted event history.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {setupJourney,sessionCookie,routeCall} from './helpers/grooming-journey-harness.mjs';
import {seedActors,asActor} from './helpers/execution-harness.mjs';
import {seedOwnedPet} from './helpers/saved-pet-fixture.mjs';
import {enterWorkersDbScope} from './helpers/module-hooks.mjs';

const ADMIN='t5.inbox.admin@example.test', MANAGER='t5.inbox.manager@example.test', SECOND='t5.inbox.second@example.test';
async function fixture(t,{migrate=true}={}) {
 const w=await setupJourney();t.after(w.close);enterWorkersDbScope(w.db);
 Object.assign(globalThis.__GROOM_GOLDEN_ENV__,{NODE_ENV:'production',PAWSPACE_LOCAL_PREVIEW:'off',FORBID_PRODUCTION:'true'});
 await seedActors(w.sqlite,w.db,[{id:'T5-INBOX-ADMIN',email:ADMIN,role:'admin'},{id:'T5-INBOX-MANAGER',email:MANAGER,role:'manager'},{id:'T5-INBOX-SECOND',email:SECOND,role:'admin'}]);
 const now=Date.now(),people=await import('../lib/people-foundation.ts');await people.ensurePeopleTables(w.db);
 w.sqlite.prepare("INSERT INTO employees (id,user_email,employee_code,display_name,work_email,phone,employment_status,joined_at,created_at,updated_at) VALUES ('T5-INBOX-EMP',?,'T5-INBOX-EMP','Synthetic inbox manager',?,'synthetic-no-contact','active',?,?,?)").run(MANAGER,MANAGER,now-86400000,now,now);
 w.sqlite.prepare("INSERT INTO employee_employment_versions (id,employee_id,version,effective_from,employment_type,probation_status,title,team_code,cost_centre_code,location_code,reason,actor_id,created_at) VALUES ('T5-INBOX-VER','T5-INBOX-EMP',1,?,'full_time','confirmed','Operations Manager','operations','CC-OPS','BLR','Synthetic city scope','task5:qa',?)").run(now-86400000,now);
 // These are the canonical feed projection columns; seeded assigned work is explicit.
 w.sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings(id TEXT PRIMARY KEY,customer_id TEXT,city_id TEXT,service_code TEXT,package_code TEXT,package_name TEXT,schedule_group_id TEXT,provider_id TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT,pet_ids_json TEXT,pricing_json TEXT,updated_at INTEGER,created_at INTEGER);CREATE TABLE IF NOT EXISTS canonical_customers(id TEXT PRIMARY KEY,city_id TEXT,name TEXT,primary_phone TEXT,consent_json TEXT,created_at INTEGER,updated_at INTEGER);CREATE TABLE food_orders(id TEXT PRIMARY KEY,status TEXT,updated_at INTEGER,created_at INTEGER,city_id TEXT);");
 if(migrate){const sql=readFileSync(new URL('../drizzle/0046_workspace_order_reads.sql',import.meta.url),'utf8');w.sqlite.exec(sql);w.sqlite.exec(sql);}
 const original=globalThis.fetch;let attempts=0;globalThis.fetch=async()=>{attempts++;throw new Error('Task5 notification transport forbidden');};t.after(()=>{globalThis.fetch=original;assert.equal(attempts,0);});
 return w;
}
function booking(w,id,{status='confirmed',city='blr',provider='groom_kiran',at=Date.now(),service='grooming'}={}){
 const start=new Date(Date.now()+86400000).toISOString(),end=new Date(Date.now()+86400000+7200000).toISOString();
 w.sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,city_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,pet_ids_json,pricing_json,updated_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,'[]','{}',?,?)").run(id,'T5-CUSTOMER',city,service,service+'-basic','Synthetic package','G-'+id,provider,start,end,status,at,at);
}
async function call(request,method='GET') {const route=await import('../app/api/workspace-order-updates/route.ts');const response=await route[method](request);return{status:response.status,body:await response.json()};}
const get=(email,path='/api/workspace-order-updates')=>call(asActor(email,path));
const ack=(email,eventId,extra={})=>call(asActor(email,'/api/workspace-order-updates',{method:'POST',body:JSON.stringify({eventId}),...extra}),'POST');
function providerRequest(cookie,init={}){return new Request('https://app.pawspace.in/api/workspace-order-updates',{...init,headers:{cookie,'content-type':'application/json',...(init.headers??{})}});}

test('N-E01 gateway: authenticated assigned provider can reach GET and POST notification routes under bookings.view',async t=>{
 const w=await fixture(t),cookie=await sessionCookie(w.db,'provider','groom_kiran','provider:groom_kiran');
 const gateway=await import('../lib/api-gateway.ts'),results=[];
 for(const method of ['GET','POST']){
  const request=providerRequest(cookie,{method,...(method==='POST'?{body:JSON.stringify({eventId:'booking:T5:confirmed'})}:{})});
  const access=await gateway.authorizeApiRequest(request,{DB:w.db});
  results.push({method,status:access instanceof Response?access.status:200,permission:access instanceof Response?null:access.permission});
 }
 assert.deepEqual(results,[{method:'GET',status:200,permission:'bookings.view'},{method:'POST',status:200,permission:'bookings.view'}]);
});
test('N-E02 role/city/actor: actual staff route keeps pending truthful, scopes city, isolates acknowledgements and rejects stale or foreign writes',async t=>{
 const w=await fixture(t);booking(w,'BLR-PENDING',{status:'payment_pending',at:100});booking(w,'MAA-PRIVATE',{city:'maa',at:101});
 w.sqlite.prepare("INSERT INTO food_orders VALUES ('BLR-FOOD','uat_reserved',102,102,'blr')").run();
 let feed=await get(MANAGER);assert.equal(feed.status,200,JSON.stringify(feed.body));assert.equal(feed.body.data.unread,2);assert.deepEqual(feed.body.data.items.map(i=>i.recordId),['BLR-FOOD','BLR-PENDING']);assert.match(feed.body.data.items[1].title,/payment pending/);
 const before=w.sqlite.prepare('SELECT * FROM canonical_bookings ORDER BY id').all();
 const id='booking:BLR-PENDING:payment_pending';const writes=await Promise.all([ack(MANAGER,id),ack(MANAGER,id),ack(MANAGER,id)]);for(const r of writes)assert.equal(r.status,200);
 assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM workspace_order_reads').get().n,1);assert.deepEqual(w.sqlite.prepare('SELECT * FROM canonical_bookings ORDER BY id').all(),before);
 feed=await get(MANAGER);assert.equal(feed.body.data.unread,1);assert.equal((await get(SECOND)).body.data.unread,3);assert.notEqual(feed.body.data.owner,(await get(SECOND)).body.data.owner);
 assert.equal((await ack(MANAGER,'booking:MAA-PRIVATE:confirmed')).status,403);
 assert.equal((await ack(MANAGER,id,{headers:{origin:'https://untrusted.example.test'}})).status,403);
 w.sqlite.prepare("UPDATE canonical_bookings SET status='confirmed',updated_at=103 WHERE id='BLR-PENDING'").run();assert.equal((await ack(MANAGER,id)).status,403);feed=await get(MANAGER);assert.equal(feed.body.data.unread,2);assert.equal(feed.body.data.items[0].title,'Booking confirmed');
 w.sqlite.prepare("UPDATE employee_employment_versions SET location_code='MAA' WHERE employee_id='T5-INBOX-EMP'").run();const switched=await get(MANAGER);assert.equal(switched.status,200);assert.notEqual(switched.body.data.owner,feed.body.data.owner);assert.deepEqual(switched.body.data.items.map(i=>i.recordId),['MAA-PRIVATE']);assert.equal((await ack(MANAGER,'booking:BLR-PENDING:confirmed')).status,403);
 w.sqlite.prepare("UPDATE employees SET employment_status='inactive' WHERE id='T5-INBOX-EMP'").run();assert.equal((await get(MANAGER)).status,403);
});
test('N-E03 provider: current own assignment/read identity only; pending/food/customer/overrides and revoked assignment are denied',async t=>{
 const w=await fixture(t);booking(w,'OWN-CONFIRMED');booking(w,'OWN-PENDING',{status:'payment_pending'});booking(w,'OTHER-PRIVATE',{provider:'groom_arun'});w.sqlite.exec("INSERT INTO food_orders VALUES('FOOD-PRIVATE','uat_reserved',1,1,'blr')");
 const cookie=await sessionCookie(w.db,'provider','groom_kiran','provider:groom_kiran'),other=await sessionCookie(w.db,'provider','groom_arun','provider:groom_arun'),customer=await sessionCookie(w.db,'customer','T5-CUSTOMER','customer:T5-CUSTOMER');
 let feed=await call(providerRequest(cookie));assert.equal(feed.status,200,JSON.stringify(feed.body));assert.deepEqual(feed.body.data.items.map(i=>i.recordId),['OWN-CONFIRMED']);assert.equal(feed.body.data.sourceStatus.food,'not_in_provider_feed');
 const id='booking:OWN-CONFIRMED:confirmed';let read=await call(providerRequest(cookie,{method:'POST',body:JSON.stringify({eventId:id})}),'POST');assert.equal(read.status,200);assert.equal((await call(providerRequest(cookie))).body.data.unread,0);
 for(const invalid of ['booking:OTHER-PRIVATE:confirmed','booking:OWN-PENDING:payment_pending','food:FOOD-PRIVATE:uat_reserved']){read=await call(providerRequest(cookie,{method:'POST',body:JSON.stringify({eventId:invalid})}),'POST');assert.equal(read.status,403);}
 assert.equal((await call(providerRequest(customer))).status,403);
 assert.equal((await call(new Request('https://app.pawspace.in/api/workspace-order-updates?providerId=groom_arun',{headers:{cookie}}))).status,400);
 w.sqlite.prepare("UPDATE canonical_bookings SET provider_id='groom_arun' WHERE id='OWN-CONFIRMED'").run();feed=await call(providerRequest(cookie));assert.equal(feed.status,200);assert.deepEqual(feed.body.data.items,[]);assert.equal((await call(providerRequest(cookie,{method:'POST',body:JSON.stringify({eventId:id})}),'POST')).status,403);
 const transferred=await call(providerRequest(other));assert.equal(transferred.status,200);assert.equal(transferred.body.data.items.find(i=>i.id===id).readAt,null,'prior provider read cannot acknowledge the new recipient');
});
test('N-E04 cursor/reconnect: tied timestamps and same booking/food IDs paginate without loss or duplicate; newer status becomes unread',async t=>{
 const w=await fixture(t);for(let n=0;n<105;n++)booking(w,'TIED-'+String(n).padStart(3,'0'),{at:500});w.sqlite.exec("INSERT INTO food_orders VALUES('TIED-001','uat_reserved',500,500,'blr')");
 const first=await get(ADMIN);assert.equal(first.status,200);assert.equal(first.body.data.items.length,100);assert.equal(first.body.data.unread,106);
 const cursor=first.body.data.nextCursor;const last=await get(ADMIN,'/api/workspace-order-updates?cursor='+encodeURIComponent(JSON.stringify(cursor)));assert.equal(last.status,200);assert.equal(last.body.data.items.length,6);
 const all=[...first.body.data.items,...last.body.data.items];assert.equal(new Set(all.map(i=>i.id)).size,106);
 const snapshot=await get(ADMIN);assert.deepEqual(snapshot.body.data.items,first.body.data.items,'repeated snapshot is stable');
 await ack(ADMIN,'booking:TIED-001:confirmed');w.sqlite.exec("UPDATE canonical_bookings SET status='in_progress',updated_at=501 WHERE id='TIED-001'");const caught=await get(ADMIN);assert.equal(caught.body.data.unread,106);assert.equal(caught.body.data.items[0].id,'booking:TIED-001:in_progress');
 assert.equal((await get(ADMIN,'/api/workspace-order-updates?cursor=bad')).status,400);
});
test('N-E05 cold schema: a read initializes empty acknowledgement storage without changing bookings',async t=>{
 const w=await fixture(t,{migrate:false});booking(w,'MIGRATION-BOOKING');const before=w.sqlite.prepare('SELECT * FROM canonical_bookings').all();const read=await get(ADMIN);assert.equal(read.status,200);assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM workspace_order_reads').get().n,0);assert.equal(read.body.data.unread,1);assert.deepEqual(w.sqlite.prepare('SELECT * FROM canonical_bookings').all(),before);
});

test('N-E06 booking-to-inbox: actual saved-pet reserve/canonical POST stays pending until trusted synthetic capture, with status-specific read identity',async t=>{
 const w=await fixture(t);w.sqlite.exec('DROP TABLE canonical_bookings; DROP TABLE canonical_customers;');
 const customer='T5-PIPE-CUSTOMER',pet='T5-PIPE-PET',group='T5-PIPE-GROUP';await seedOwnedPet(w.db,customer,pet,'Synthetic inbox pet');
 const startDate=new Date(Date.now()+3*86400000);startDate.setUTCHours(4,30,0,0);
 const cookie=await sessionCookie(w.db,'customer',customer,`customer:${customer}`),start=startDate.toISOString(),end=new Date(startDate.getTime()+7200000).toISOString();
 const reserved=await routeCall('../../app/api/uat-scheduling/route.ts','POST','/api/uat-scheduling',{clientRequestId:group,customerId:customer,petIds:[pet],serviceCode:'grooming',cityId:'blr',zoneId:'blr-east',serviceAddress:'Synthetic inbox booking address',servicePincode:'560038',scheduledStart:start,scheduledEnd:end,preferredProviderId:'groom_kiran'},cookie);
 assert.equal(reserved.status,200,JSON.stringify(reserved.body));
 const payload={idempotencyKey:group,scheduleGroupId:group,customer:{id:customer,name:'Synthetic inbox customer',primaryPhone:'synthetic-no-contact'},pets:[{sourceId:pet,name:'Synthetic inbox pet',species:'dog',vaccinationStatus:'verified'}],cityId:'blr',zoneId:'blr-east',serviceCode:'grooming',packageCode:'dog-basic',packageName:'Synthetic input',scheduledStart:start,scheduledEnd:end,provider:reserved.body.data.provider,totalAmount:1899,amountDueNow:1899,payment:{method:'upi',mode:'prepaid',status:'created',detail:'Synthetic boundary'},pricing:{discount:0}};
 const booked=await routeCall('../../app/api/canonical-bookings/route.ts','POST','/api/canonical-bookings',payload,cookie);assert.equal(booked.status,201,JSON.stringify(booked.body));const id=booked.body.data.bookingId;
 let feed=await get(MANAGER);assert.equal(feed.status,200);const pending=feed.body.data.items.find(i=>i.recordId===id);assert.equal(pending.status,'payment_pending');assert.match(pending.title,/payment pending/);assert.equal((await ack(MANAGER,pending.id)).status,200);
 const partner=await sessionCookie(w.db,'provider','groom_kiran','provider:groom_kiran');assert.ok(!(await call(providerRequest(partner))).body.data.items.some(i=>i.recordId===id));
 const gateway=await import('../lib/grooming-payment-reconciliation.ts');const event={provider:'razorpay',environment:'sandbox',eventId:'evt_T5_INBOX_CAPTURE',eventType:'payment.captured',bookingId:id,gatewayPaymentId:'pay_T5_INBOX_CAPTURE',amountSubunits:189900,currency:'INR',signatureVerified:true,payloadHash:'synthetic-trusted-event'};
 const captured=await gateway.processGatewayEvent(w.db,event);assert.equal(captured.status,'processed',JSON.stringify(captured));
 feed=await get(MANAGER);const confirmed=feed.body.data.items.find(i=>i.recordId===id);assert.equal(confirmed.status,'confirmed');assert.equal(confirmed.title,'Booking confirmed');assert.equal(confirmed.readAt,null);assert.notEqual(confirmed.id,pending.id);
 assert.equal((await call(providerRequest(partner))).body.data.items.filter(i=>i.recordId===id).length,1);
 const bookSnapshot=w.sqlite.prepare('SELECT * FROM canonical_bookings WHERE id=?').get(id);const replay=await routeCall('../../app/api/canonical-bookings/route.ts','POST','/api/canonical-bookings',payload,cookie);assert.equal(replay.status,200);assert.deepEqual(w.sqlite.prepare('SELECT * FROM canonical_bookings WHERE id=?').get(id),bookSnapshot);
 await gateway.processGatewayEvent(w.db,event);assert.equal((await get(MANAGER)).body.data.items.filter(i=>i.recordId===id).length,1,'replayed booking and capture cannot create duplicate visible updates');
});

test('N-E07 cold schema: failed initialization stays unavailable and retries, while foreign acknowledgements cannot provision storage',async t=>{
 const w=await fixture(t,{migrate:false});booking(w,'COLD-OWN');booking(w,'COLD-FOREIGN',{city:'maa'});
 assert.equal((await ack(MANAGER,'booking:COLD-FOREIGN:confirmed')).status,403);
 assert.equal(w.sqlite.prepare("SELECT name FROM sqlite_master WHERE name='workspace_order_reads'").get(),undefined);
 const original=w.db.prepare.bind(w.db);let fail=true,ddlAttempts=0;
 w.db.prepare=sql=>{if(sql.startsWith('CREATE TABLE IF NOT EXISTS workspace_order_reads')){ddlAttempts++;if(fail)throw new Error('Synthetic acknowledgement storage failure');}return original(sql);};
 try{
  const failed=await get(ADMIN);assert.equal(failed.status,500);assert.equal(failed.body.data,undefined,'failure is never an empty successful feed');
  assert.equal(w.sqlite.prepare("SELECT name FROM sqlite_master WHERE name='workspace_order_reads'").get(),undefined);
  fail=false;assert.equal((await ack(ADMIN,'booking:COLD-OWN:confirmed')).status,200);
  assert.equal(ddlAttempts,2,'failed initialization must remain retryable');
  assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM workspace_order_reads').get().n,1);
  assert.equal((await get(ADMIN)).body.data.unread,1);
 }finally{w.db.prepare=original;}
});

test('N-E08 cursor validation: authentication is unconditional, malformed input remains400 and cannot change scope or create storage',async t=>{
 const w=await fixture(t,{migrate:false});booking(w,'CURSOR-OWN');
 for(const cursor of ['bad','null','[]',JSON.stringify({at:-1,id:'booking:A'}),JSON.stringify({at:1.5,id:'booking:A'}),JSON.stringify({at:1,id:''}),JSON.stringify({at:1,id:'A'.repeat(201)})]){
  const path='/api/workspace-order-updates?cursor='+encodeURIComponent(cursor);
  assert.equal((await call(new Request('https://app.pawspace.in'+path))).status,401,'invalid cursor cannot bypass identity');
  const response=await get(ADMIN,path);assert.equal(response.status,400);assert.equal(response.body.error,'Invalid update cursor');
 }
 assert.equal((await get(ADMIN,'/api/workspace-order-updates?cityId=maa')).status,400);
 assert.equal(w.sqlite.prepare("SELECT name FROM sqlite_master WHERE name='workspace_order_reads'").get(),undefined);
 assert.equal((await get(ADMIN)).status,200);
});


test('N-E09 provider cold schema: assigned identity creates only acknowledgement storage and malformed cursor still refuses',async t=>{
 const w=await fixture(t,{migrate:false});booking(w,'COLD-PROVIDER');const before=w.sqlite.prepare('SELECT * FROM canonical_bookings').all();
 const cookie=await sessionCookie(w.db,'provider','groom_kiran','provider:groom_kiran');
 const malformed=await call(new Request('https://app.pawspace.in/api/workspace-order-updates?cursor=bad',{headers:{cookie}}));assert.equal(malformed.status,400);
 assert.equal(w.sqlite.prepare("SELECT name FROM sqlite_master WHERE name='workspace_order_reads'").get(),undefined);
 const result=await call(providerRequest(cookie));assert.equal(result.status,200,JSON.stringify(result.body));assert.deepEqual(result.body.data.items.map(i=>i.recordId),['COLD-PROVIDER']);assert.equal(result.body.data.unread,1);
 assert.deepEqual(w.sqlite.prepare('SELECT * FROM canonical_bookings').all(),before);
});
