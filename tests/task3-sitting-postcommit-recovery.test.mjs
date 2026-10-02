import {writeFileSync} from 'node:fs';
// New P1-SIT-10 fault boundaries through real client/route/governance and disposable SQLite.
// Captures only same-process /api/sitting-finance dispatch; no gateway/provider/customer transport.
import test from 'node:test';
import assert from 'node:assert/strict';
import {installWorkersHooks} from './helpers/module-hooks.mjs';
import {world,seedActors,asActor} from './helpers/execution-harness.mjs';
import {seedSittingBooking} from './helpers/stay-harness.mjs';
installWorkersHooks('__TASK3_POSTCOMMIT_DB__','__TASK3_POSTCOMMIT_ENV__');
const client=await import('../lib/sitting-finance-client.ts');
const finance=await import('../lib/sitting-finance-governance.ts');
const commercial=await import('../lib/sitting-governance.ts');
const route=await import('../app/api/sitting-finance/route.ts');
const FINANCE='row.checker@example.test',MAKER='row.maker@example.test',CUSTOMER='row.customer@example.test';
const A='TEST-SIT-POSTCOMMIT-A',B='TEST-SIT-POSTCOMMIT-B';
async function fixture(t,{amount=1000,captured=amount}={}){
 const f=world('__TASK3_POSTCOMMIT_DB__','__TASK3_POSTCOMMIT_ENV__',{NODE_ENV:'test',APP_ENV:'staging',PAWSPACE_LOCAL_PREVIEW:'off',FORBID_PRODUCTION:'true',PAWSPACE_PAYMENT_ENV:'sandbox',PAWSPACE_PAYMENT_LIVE_APPROVED:'false'});
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

const observations=[];
if(process.env.TASK3_SITTING_OBSERVATIONS_FILE)process.on('exit',()=>writeFileSync(process.env.TASK3_SITTING_OBSERVATIONS_FILE,JSON.stringify({scope:'Local real route/client/governance with disposable SQLite; no hosted acceptance',observations},null,2)+'\n'));
function snapshot(f){return Object.fromEntries(['sitting_cancellation_requests','sitting_refund_ledger','booking_refund_cases','canonical_bookings','provider_work_orders','scheduling_reservations','sitting_finance_action_keys'].map(table=>[table,f.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row=>({...row}))]));}
function failOnce(f,t,predicate){
 const prepare=f.db.prepare.bind(f.db);let failures=0;
 f.db.prepare=sql=>{const st=prepare(sql);if(!predicate(sql))return st;
  const wrap=value=>({...value,bind:(...args)=>wrap(value.bind(...args)),run:async()=>{if(failures++===0)throw new Error('Synthetic one-shot post-commit boundary failure');return value.run();}});return wrap(st);};
 t.after(()=>{f.db.prepare=prepare;});return ()=>failures;
}
async function raw(f,payload){try{const data=await client.updateSittingFinance({bookingId:A,...payload});return {status:f.calls.at(-1).status,data};}catch(error){return {status:f.calls.at(-1)?.status,error:String(error.message),response:f.calls.at(-1)?.response};}}
async function approvals(f){await f.seed(B);const ids=await f.pending();return {ids,payload:{action:'approve_cancel',cancellationRequestId:ids.first,approvedRefundAmount:100,reason:'Synthetic independent Finance fault approval',idempotencyKey:'POSTCOMMIT-APPROVE'}};}
for(const action of ['approve_cancel','record_refund','apply_date_change'])test(`P1-SIT-10 ${action}: audit failure after commit then exact retry preserves canonical effects`,{timeout:8000},async t=>{
 const f=await fixture(t,{amount:399}),setup=await approvals(f);let payload=setup.payload;
 if(action==='record_refund'){const approved=await f.send(payload);payload={action,refundId:approved.refundId,refundReference:'TEST-POSTCOMMIT-REF',idempotencyKey:'POSTCOMMIT-RECORD'};}
 if(action==='apply_date_change'){const d=await f.dateRequests(),q=await f.replacement(d);payload={action,dateChangeRequestId:d.old,...q,idempotencyKey:'POSTCOMMIT-DATE'};}
 const siblingBefore=f.sqlite.prepare('SELECT * FROM canonical_bookings WHERE id=?').get(B);
 const failures=failOnce(f,t,sql=>sql.startsWith('INSERT INTO security_audit_events '));
 const first=await raw(f,payload),committed=snapshot(f),retry=await raw(f,payload),after=snapshot(f);
 observations.push({case:`${action}-audit-after-commit`,first,retry,faultExecutions:failures(),canonicalStateIdenticalAfterRetry:JSON.stringify(committed)===JSON.stringify(after),state:after});
 assert.equal(first.status,500);assert.equal(retry.status,200);assert.equal(retry.data.duplicatePrevented,true);assert.deepEqual(after,committed);
 assert.deepEqual(f.sqlite.prepare('SELECT * FROM canonical_bookings WHERE id=?').get(B),siblingBefore);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM security_audit_events WHERE action=? AND resource_id=?').get(`sitting.finance.${action}`,A).n,1);
});
test('P1-SIT-10 approve_cancel: idempotency insert failure leaves retryable complete state or rolls back',{timeout:8000},async t=>{
 const f=await fixture(t),{payload}=await approvals(f),before=snapshot(f);
 failOnce(f,t,sql=>sql.startsWith('INSERT INTO sitting_finance_action_keys '));
 const first=await raw(f,payload),afterFailure=snapshot(f),retry=await raw(f,payload),afterRetry=snapshot(f);
 observations.push({case:'approve_cancel-cache-write-failure',first,retry,unchangedAfterFailure:JSON.stringify(before)===JSON.stringify(afterFailure),before,afterFailure,afterRetry});
 assert.equal(first.status,500);assert.equal(retry.status,200,'The same request must recover after a one-shot failure, without stranded approval or duplicate refund');
 assert.equal(afterRetry.sitting_refund_ledger.length,1);assert.equal(afterRetry.booking_refund_cases.length,1);assert.equal(afterRetry.sitting_finance_action_keys.filter(r=>r.idempotency_key===payload.idempotencyKey).length,1);
});
test('P1-SIT-10 approve_cancel: refund obligation insert failure rolls back the earlier claim',{timeout:8000},async t=>{
 const f=await fixture(t),{payload}=await approvals(f),before=snapshot(f);
 failOnce(f,t,sql=>sql.startsWith('INSERT INTO sitting_refund_ledger '));
 const first=await raw(f,payload),afterFailure=snapshot(f),retry=await raw(f,payload),afterRetry=snapshot(f);
 observations.push({case:'approve_cancel-obligation-batch-failure',first,retry,unchangedAfterFailure:JSON.stringify(before)===JSON.stringify(afterFailure),before,afterFailure,afterRetry});
 assert.equal(first.status,500);assert.deepEqual(afterFailure,before,'An aborted refund batch must not strand a claimed approval without its obligation');assert.equal(retry.status,200);
});
