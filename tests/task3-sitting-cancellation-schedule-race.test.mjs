// New P1-SIT-10 fault boundaries through real client/route/governance and disposable SQLite.
// Captures only same-process /api/sitting-finance dispatch; no gateway/provider/customer transport.
import test from 'node:test';
import assert from 'node:assert/strict';
import {installWorkersHooks} from './helpers/module-hooks.mjs';
import {world,seedActors,asActor} from './helpers/execution-harness.mjs';
import {seedSittingBooking} from './helpers/stay-harness.mjs';
installWorkersHooks('__TASK3_SCHEDULE_RACE_DB__','__TASK3_SCHEDULE_RACE_ENV__');
const client=await import('../lib/sitting-finance-client.ts');
const finance=await import('../lib/sitting-finance-governance.ts');
const commercial=await import('../lib/sitting-governance.ts');
const route=await import('../app/api/sitting-finance/route.ts');
const FINANCE='row.checker@example.test',MAKER='row.maker@example.test',CUSTOMER='row.customer@example.test';
const A='TEST-SIT-POSTCOMMIT-A',B='TEST-SIT-POSTCOMMIT-B';
async function fixture(t,{amount=1000,captured=amount}={}){
 const f=world('__TASK3_SCHEDULE_RACE_DB__','__TASK3_SCHEDULE_RACE_ENV__',{NODE_ENV:'test',APP_ENV:'staging',PAWSPACE_LOCAL_PREVIEW:'off',FORBID_PRODUCTION:'true',PAWSPACE_PAYMENT_ENV:'sandbox',PAWSPACE_PAYMENT_LIVE_APPROVED:'false'});
 t.after(()=>f.sqlite.close());
 const realNow=Date.now;let clock=realNow();Date.now=()=>++clock;t.after(()=>{Date.now=realNow;});
 async function seed(bookingId=A){return seedSittingBooking(f.db,f.sqlite,{bookingId,customerId:'CUS-'+bookingId,groupId:'GRP-'+bookingId,reservationId:'RES-'+bookingId,amount,amountDueNow:captured});}
 await seed();await seedActors(f.sqlite,f.db,[{id:'TEST-ROW-FIN',email:FINANCE,role:'finance'},{id:'TEST-ROW-CUS',email:CUSTOMER,role:'customer'}]);
 f.sqlite.exec("UPDATE canonical_customers SET name='Synthetic contract fixture',primary_phone='synthetic-no-contact'");
 const original=globalThis.fetch,calls=[];let actor=FINANCE,forbidden=0;
 t.after(()=>{globalThis.fetch=original;assert.equal(forbidden,0);});
 globalThis.fetch=async(path,init={})=>{
  const url=new URL(String(path),'https://app.pawspace.in'),method=init.method||'GET';
  if(url.origin!=='https://app.pawspace.in'||url.pathname!=='/api/sitting-finance'||!['GET','POST'].includes(method)){forbidden++;throw new Error('Forbidden fixture transport');}
  const response=await route[method](asActor(actor,url.pathname+url.search,init));
  calls.push({method,actor,body:init.body?JSON.parse(String(init.body)):null,status:response.status,response:await response.clone().json()});return response;
 };
 const send=async(payload,status=200)=>{const request=client.updateSittingFinance({bookingId:A,...payload});if(status===200){const result=await request;assert.equal(calls.at(-1).status,status);return result;}await assert.rejects(request);assert.equal(calls.at(-1).status,status,JSON.stringify(calls.at(-1)));return calls.at(-1).response;};
 const direct=(bookingId,action,key,extra={})=>finance.mutateSittingFinance(f.db,{bookingId,action,actorId:MAKER,idempotencyKey:key,...extra});
 const request=(id,key,requestedBy=MAKER)=>direct(id,'request_cancel',key,{actorId:requestedBy,reason:'Synthetic split cancellation request'});
 const approve=(id,requestId,value,key)=>send({bookingId:id,action:'approve_cancel',cancellationRequestId:requestId,approvedRefundAmount:value,reason:'Synthetic independent Finance approval',idempotencyKey:key});
 async function pending(id=A){const first=await request(id,id+'-REQUEST-OLD'),second=await request(id,id+'-REQUEST-NEW');return {first:first.requestId,second:second.requestId};}
 async function refunds(id=A){const requests=await pending(id),older=await approve(id,requests.first,100,id+'-APPROVE-100'),newer=await approve(id,requests.second,500,id+'-APPROVE-500');return {...requests,older:older.refundId,newer:newer.refundId};}
 const rows=()=>f.sqlite.prepare('SELECT * FROM sitting_refund_ledger ORDER BY id').all();
 const snapshot=()=>({refunds:rows(),cases:f.sqlite.prepare('SELECT * FROM booking_refund_cases ORDER BY id').all(),bookings:f.sqlite.prepare('SELECT * FROM canonical_bookings ORDER BY id').all(),keys:f.sqlite.prepare('SELECT * FROM sitting_finance_action_keys ORDER BY idempotency_key').all()});
 async function dateRequests(){const start=Date.now()+72*3600000;const oldStart=new Date(start).toISOString(),oldEnd=new Date(start+3600000).toISOString(),newStart=new Date(start+24*3600000).toISOString(),newEnd=new Date(start+25*3600000).toISOString();const old=await direct(A,'request_date_change','DATE-OLD',{requestedStart:oldStart,requestedEnd:oldEnd,reason:'Synthetic older window'}),newer=await direct(A,'request_date_change','DATE-NEW',{requestedStart:newStart,requestedEnd:newEnd,reason:'Synthetic newer window'});return {old:old.requestId,newer:newer.requestId,oldStart,oldEnd,newStart,newEnd};}
 async function replacement(d,{group='TEST-REPLACE-GROUP',quoteId}={}){const quote=quoteId?null:await commercial.createSittingQuote(f.db,{packageCode:'sitting-visit-60',petCount:1,scheduledStart:d.oldStart,scheduledEnd:d.oldEnd,paymentMode:'prepaid',cityId:'blr',zoneId:'blr-east'});const provider=f.sqlite.prepare("SELECT id FROM provider_capacity_profiles WHERE city_id='blr' AND status='active' AND EXISTS(SELECT 1 FROM json_each(services_json) WHERE value='pet_sitting') AND EXISTS(SELECT 1 FROM json_each(zones_json) WHERE value='blr-east') ORDER BY id LIMIT 1").get();assert.ok(provider,'Fixture replacement uses an actually configured Sitting provider');const now=Date.now();await f.db.batch([f.db.prepare("INSERT INTO scheduling_assignment_decisions(group_id,strategy,shortlist_json,selected_provider_id,status,actor_id,updated_at)VALUES(?,'best_fit','[]',?,'assigned','synthetic',?)").bind(group,provider.id,now),f.db.prepare("INSERT INTO scheduling_reservations(id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,status,created_at)VALUES(?,?,?,'pet_sitting','blr','blr-east',?,'[]',?,?,'confirmed',?)").bind(group+'-RES',group,provider.id,'CUS-'+A,d.oldStart,d.oldEnd,now)]);return {quoteId:quoteId||quote.quoteId,replacementGroupId:group};}
 return {...f,seed,send,direct,request,approve,pending,refunds,rows,snapshot,dateRequests,replacement,calls,setActor:value=>{actor=value;}};
}


function state(f){return Object.fromEntries(['canonical_bookings','provider_work_orders','scheduling_reservations','sitting_finance_action_keys','sitting_refund_ledger','booking_refund_cases'].map(table=>[table,f.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(r=>({...r}))]));}
test('cancellation after concurrent real date change releases current replacement capacity',{timeout:8000},async t=>{
 const f=await fixture(t,{amount:399});await f.seed(B);const pending=await f.pending(),d=await f.dateRequests(),q=await f.replacement(d);
 const originalBatch=f.db.batch.bind(f.db);let interleaved=0;
 f.db.batch=async statements=>{if(!interleaved&&statements[0].sql.startsWith('UPDATE sitting_cancellation_requests')){interleaved++;f.db.batch=originalBatch;await finance.mutateSittingFinance(f.db,{bookingId:A,action:'apply_date_change',actorId:FINANCE,idempotencyKey:'SCHEDULE-RACE-DATE',dateChangeRequestId:d.old,...q});}return originalBatch(statements);};
 t.after(()=>{f.db.batch=originalBatch;});const siblingBefore=f.sqlite.prepare('SELECT * FROM canonical_bookings WHERE id=?').get(B);
 const input={action:'approve_cancel',cancellationRequestId:pending.first,approvedRefundAmount:100,reason:'Synthetic interleaved schedule cancellation',idempotencyKey:'SCHEDULE-RACE-CANCEL'};
 const out=await f.send(input);assert.equal(interleaved,1);assert.equal(out.capacityReleased,true);
 const booking=f.sqlite.prepare('SELECT status,schedule_group_id FROM canonical_bookings WHERE id=?').get(A);assert.equal(booking.status,'cancelled');assert.equal(booking.schedule_group_id,q.replacementGroupId);
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM scheduling_reservations WHERE group_id=? AND status!='cancelled'").get(booking.schedule_group_id).n,0,'capacityReleased must include the actual current group, not the previously read group');
 assert.equal(f.sqlite.prepare('SELECT status FROM provider_work_orders WHERE booking_id=?').get(A).status,'cancelled');assert.equal(f.rows().length,1);
 assert.deepEqual(f.sqlite.prepare('SELECT * FROM canonical_bookings WHERE id=?').get(B),siblingBefore);
 const before=state(f);assert.equal((await f.send(input)).duplicatePrevented,true);assert.deepEqual(state(f),before);
});
test('cancellation committed first prevents late date change from reopening current capacity',{timeout:8000},async t=>{
 const f=await fixture(t,{amount:399}),pending=await f.pending(),d=await f.dateRequests(),q=await f.replacement(d);
 await f.send({action:'approve_cancel',cancellationRequestId:pending.first,approvedRefundAmount:100,reason:'Synthetic cancellation wins before date change',idempotencyKey:'CANCEL-FIRST'});
 const before=state(f);await f.send({action:'apply_date_change',dateChangeRequestId:d.old,...q,idempotencyKey:'DATE-LOSER'},409);assert.deepEqual(state(f),before);
 const booking=f.sqlite.prepare('SELECT schedule_group_id FROM canonical_bookings WHERE id=?').get(A);
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM scheduling_reservations WHERE group_id=? AND status!='cancelled'").get(booking.schedule_group_id).n,0);
});
