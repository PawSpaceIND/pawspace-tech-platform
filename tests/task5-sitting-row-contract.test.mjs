// Exact row contract through the real client/route/governance and transactional SQLite adapter.
// Captures only same-process /api/sitting-finance dispatch; no gateway/provider/customer transport.
import test from 'node:test';
import assert from 'node:assert/strict';
import {installWorkersHooks} from './helpers/module-hooks.mjs';
import {world,seedActors,asActor} from './helpers/execution-harness.mjs';
import {seedSittingBooking} from './helpers/stay-harness.mjs';
installWorkersHooks('__TASK5_ROW_CONTRACT_DB__','__TASK5_ROW_CONTRACT_ENV__');
const client=await import('../lib/sitting-finance-client.ts');
const finance=await import('../lib/sitting-finance-governance.ts');
const commercial=await import('../lib/sitting-governance.ts');
const route=await import('../app/api/sitting-finance/route.ts');
const FINANCE='row.checker@example.test',MAKER='row.maker@example.test',CUSTOMER='row.customer@example.test';
const A='TEST-SIT-CONTRACT-A',B='TEST-SIT-CONTRACT-B';
async function fixture(t,{amount=1000,captured=amount}={}){
 const f=world('__TASK5_ROW_CONTRACT_DB__','__TASK5_ROW_CONTRACT_ENV__',{NODE_ENV:'test',APP_ENV:'staging',PAWSPACE_LOCAL_PREVIEW:'off',FORBID_PRODUCTION:'true',PAWSPACE_PAYMENT_ENV:'sandbox',PAWSPACE_PAYMENT_LIVE_APPROVED:'false'});
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
const record=(refundId,key='TEST-RECORD-OLD',extra={})=>({action:'record_refund',refundId,refundReference:'TEST-REF-100',idempotencyKey:key,...extra});

test('older INR100 selection records only that row and preserves newer INR500 obligation',async t=>{
 const f=await fixture(t),ids=await f.refunds(),result=await f.send(record(ids.older));
 assert.equal(result.refundId,ids.older);assert.equal(result.amount,100);assert.equal(f.rows().find(r=>r.id===ids.newer).status,'sandbox_pending');
 assert.equal(f.sqlite.prepare('SELECT amount,status FROM booking_refund_cases WHERE id=?').get(ids.older).amount,100);assert.equal(f.sqlite.prepare('SELECT status FROM booking_refund_cases WHERE id=?').get(ids.older).status,'processed');
 assert.equal(f.calls.at(-1).body.refundId,ids.older);
});
test('new INR500 obligation inserted after GET cannot retarget previously selected INR100',async t=>{
 const f=await fixture(t),requests=await f.pending(),old=await f.approve(A,requests.first,100,'APPROVE-OLD');
 const view=await client.loadSittingFinance(A);assert.equal(view.refunds.length,1);
 const newer=await f.approve(A,requests.second,500,'APPROVE-AFTER-GET'),out=await f.send(record(old.refundId));assert.equal(out.amount,100);assert.equal(out.refundId,view.refunds[0].id);assert.equal(f.rows().find(r=>r.id===newer.refundId).status,'sandbox_pending');
});
test('foreign-booking refund ID fails closed with no financial mutation',async t=>{
 const f=await fixture(t);await f.refunds();await f.seed(B);const foreign=await f.refunds(B),before=f.snapshot();await f.send(record(foreign.older),409);assert.deepEqual(f.snapshot(),before);
});
test('processed selected row under a new key cannot fall back to another pending row',async t=>{
 const f=await fixture(t),ids=await f.refunds();await f.send(record(ids.older));const before=f.snapshot();await f.send(record(ids.older,'NEW-KEY',{refundReference:'TEST-OTHER-REF'}),409);assert.deepEqual(f.snapshot(),before);
});
test('same row and exact key replay preserves one canonical posting',async t=>{
 const f=await fixture(t),ids=await f.refunds(),input=record(ids.older),first=await f.send(input),before=f.snapshot();const retry=await f.send(input);assert.equal(retry.duplicatePrevented,true);assert.equal(retry.refundId,first.refundId);assert.equal(retry.amount,100);assert.deepEqual(f.snapshot(),before);
});
test('a successful row key cannot be reused for another row',async t=>{
 const f=await fixture(t),ids=await f.refunds();await f.send(record(ids.older));const before=f.snapshot();await f.send(record(ids.newer),409);assert.deepEqual(f.snapshot(),before);
});
test('a successful key cannot cross booking or action authority',async t=>{
 const f=await fixture(t),ids=await f.refunds();await f.send(record(ids.older));await f.seed(B);const foreign=await f.refunds(B),before=f.snapshot();await f.send(record(foreign.older,'TEST-RECORD-OLD',{bookingId:B}),409);await f.send({action:'reconcile',idempotencyKey:'TEST-RECORD-OLD'},409);assert.deepEqual(f.snapshot(),before);
});
for(const [action,field] of [['approve_cancel','cancellationRequestId'],['record_refund','refundId'],['apply_date_change','dateChangeRequestId']])test(`${action} rejects missing, blank and non-string ${field}`,async t=>{
 const f=await fixture(t);await finance.ensureSittingFinanceTables(f.db);const before=f.snapshot();for(const value of [undefined,'  ',42])await f.send({action,idempotencyKey:'MISSING-'+String(value),[field]:value,approvedRefundAmount:0,reason:'Synthetic reason',refundReference:'TEST-REF'},400);assert.deepEqual(f.snapshot(),before);
});
test('selected older cancellation is approved while newer request stays pending',async t=>{
 const f=await fixture(t),ids=await f.pending(),out=await f.approve(A,ids.first,100,'CANCEL-OLD');assert.equal(out.cancellationRequestId,ids.first);assert.equal(f.sqlite.prepare('SELECT status FROM sitting_cancellation_requests WHERE id=?').get(ids.first).status,'approved');assert.equal(f.sqlite.prepare('SELECT status FROM sitting_cancellation_requests WHERE id=?').get(ids.second).status,'policy_review_required');assert.equal(f.rows()[0].cancellation_request_id,ids.first);
});
test('foreign or already-approved cancellation cannot select another pending request',async t=>{
 const f=await fixture(t),ids=await f.pending();await f.approve(A,ids.first,100,'CANCEL-OLD');await f.seed(B);const foreign=await f.pending(B),before=f.snapshot();for(const id of [ids.first,foreign.first])await f.send({action:'approve_cancel',cancellationRequestId:id,approvedRefundAmount:100,reason:'Synthetic approval',idempotencyKey:'STALE-'+id},409);assert.deepEqual(f.snapshot(),before);
});
test('cancellation replay is bound to the selected row and creates one obligation',async t=>{
 const f=await fixture(t),ids=await f.pending();await f.approve(A,ids.first,100,'CANCEL-REPLAY');const before=f.snapshot();const replay=await f.approve(A,ids.first,100,'CANCEL-REPLAY');assert.equal(replay.duplicatePrevented,true);await f.send({action:'approve_cancel',cancellationRequestId:ids.second,approvedRefundAmount:100,reason:'Synthetic approval',idempotencyKey:'CANCEL-REPLAY'},409);assert.deepEqual(f.snapshot(),before);
});
test('selected cancellation preserves maker/checker and captured-funds ceiling',async t=>{
 const f=await fixture(t,{captured:200}),own=await f.request(A,'MAKER-IS-FINANCE',FINANCE),other=await f.request(A,'OTHER-MAKER');await f.send({action:'approve_cancel',cancellationRequestId:own.requestId,approvedRefundAmount:100,reason:'Synthetic approval',idempotencyKey:'SELF-APPROVAL'},409);await f.send({action:'approve_cancel',cancellationRequestId:other.requestId,approvedRefundAmount:201,reason:'Synthetic approval',idempotencyKey:'OVER-CAPTURE'},409);assert.equal(f.rows().length,0);const allowed=await f.approve(A,other.requestId,200,'EXACT-CAPTURE');assert.equal(allowed.approvedRefundAmount,200);
});
test('older selected date request applies its own quote/window despite newer pending row',async t=>{
 const f=await fixture(t,{amount:399}),d=await f.dateRequests();await client.loadSittingFinance(A);const q=await f.replacement(d),input={action:'apply_date_change',dateChangeRequestId:d.old,...q,idempotencyKey:'DATE-APPLY-OLD'},out=await f.send(input);assert.equal(out.dateChangeRequestId,d.old);assert.equal(out.scheduledStart,d.oldStart);assert.equal(out.amountDelta,0);assert.equal(f.sqlite.prepare('SELECT status FROM sitting_date_change_requests WHERE id=?').get(d.newer).status,'commercial_quote_required');const before=f.snapshot();const replay=await f.send(input);assert.equal(replay.duplicatePrevented,true);assert.deepEqual(f.snapshot(),before);
});
test('foreign, applied and key-mismatched date rows fail closed',async t=>{
 const f=await fixture(t,{amount:399}),d=await f.dateRequests(),q=await f.replacement(d),input={action:'apply_date_change',dateChangeRequestId:d.old,...q,idempotencyKey:'DATE-APPLY-OLD'};await f.send(input);await f.seed(B);const foreign=await f.direct(B,'request_date_change','B-DATE',{requestedStart:d.oldStart,requestedEnd:d.oldEnd,reason:'Synthetic foreign window'}),before=f.snapshot();for(const [id,key] of [[d.old,'STALE-DATE'],[foreign.requestId,'FOREIGN-DATE'],[d.newer,'DATE-APPLY-OLD']])await f.send({...input,dateChangeRequestId:id,idempotencyKey:key},409);assert.deepEqual(f.snapshot(),before);
});
test('customer cannot use Finance row operation or cached Finance replay',async t=>{
 const f=await fixture(t),ids=await f.refunds(),input=record(ids.older);await f.send(input);const before=f.snapshot();f.setActor(CUSTOMER);await f.send(input,403);await f.send(record(ids.newer,'CUSTOMER-NEW'),403);assert.deepEqual(f.snapshot(),before);
});
test('different selected cancellation approvals reserve the shared captured ceiling atomically',{timeout:4000},async t=>{
 const f=await fixture(t),ids=await f.pending();
 // Real SQL reads, held before either claim so both requests observe the same balance.
 const prepare=f.db.prepare.bind(f.db);let arrived=0,release;
 const bothRead=new Promise(resolve=>{release=resolve;});
 f.db.prepare=sql=>{const statement=prepare(sql);if(!sql.startsWith('SELECT COALESCE(SUM(amount),0) total FROM sitting_refund_ledger'))return statement;
  const wrap=st=>({...st,bind:(...args)=>wrap(st.bind(...args)),first:async(...args)=>{const result=await st.first(...args);if(++arrived===2)release();await bothRead;return result;}});return wrap(statement);};
 t.after(()=>{release();f.db.prepare=prepare;});
 const results=await Promise.allSettled([ids.first,ids.second].map((id,i)=>client.updateSittingFinance({bookingId:A,action:'approve_cancel',cancellationRequestId:id,approvedRefundAmount:1000,reason:'Synthetic concurrent refund ceiling',idempotencyKey:'CEILING-RACE-'+i})));
 const amounts=f.rows().map(row=>Number(row.amount));
 t.diagnostic(JSON.stringify({fulfilled:results.filter(r=>r.status==='fulfilled').length,refundAmounts:amounts,totalApproved:amounts.reduce((a,b)=>a+b,0),captured:1000}));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);assert.equal(amounts.reduce((a,b)=>a+b,0),1000);
});
test('same selected cancellation with competing keys keeps one atomic approval',async t=>{
 const f=await fixture(t),ids=await f.pending();
 const results=await Promise.allSettled([0,1].map(i=>client.updateSittingFinance({bookingId:A,action:'approve_cancel',cancellationRequestId:ids.first,approvedRefundAmount:100,reason:'Synthetic same row race',idempotencyKey:'SAME-ROW-RACE-'+i})));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);assert.equal(f.rows().length,1);assert.equal(f.rows()[0].amount,100);
});
test('atomic ceiling preserves exact two-decimal split approvals',async t=>{
 const f=await fixture(t,{captured:300}),ids=await f.pending();await f.approve(A,ids.first,199.99,'DECIMAL-FIRST');const last=await f.approve(A,ids.second,100.01,'DECIMAL-LAST');assert.equal(last.approvedRefundAmount,100.01);assert.equal(Math.round(f.rows().reduce((sum,r)=>sum+Number(r.amount),0)*100),30000);
});

function dateSnapshot(f){return Object.fromEntries(['sitting_date_change_requests','sitting_date_change_quote_links','sitting_commercial_quotes','canonical_bookings','provider_work_orders','booking_payments','scheduling_reservations','sitting_finance_action_keys'].map(table=>[table,f.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row=>({...row}))]));}
function holdDateReads(f,t){
 const prepare=f.db.prepare.bind(f.db);let arrived=0,release;const bothRead=new Promise(resolve=>{release=resolve;});
 f.db.prepare=sql=>{const statement=prepare(sql);if(!sql.startsWith('SELECT * FROM sitting_date_change_requests WHERE booking_id='))return statement;
  const wrap=st=>({...st,bind:(...args)=>wrap(st.bind(...args)),first:async(...args)=>{const result=await st.first(...args);if(++arrived===2)release();await bothRead;return result;}});return wrap(statement);};
 t.after(()=>{release();f.db.prepare=prepare;});
}
const applyDate=(d,q,key)=>({bookingId:A,action:'apply_date_change',dateChangeRequestId:d.old,...q,idempotencyKey:key});
test('date atomic claim admits one distinct quote/group contender and gates every losing effect',{timeout:4000},async t=>{
 const f=await fixture(t,{amount:399}),d=await f.dateRequests(),qs=await Promise.all(['TEST-DATE-GROUP-ONE','TEST-DATE-GROUP-TWO'].map(group=>f.replacement(d,{group})));holdDateReads(f,t);
 const inputs=qs.map((q,i)=>applyDate(d,q,'DATE-DISTINCT-RACE-'+i)),results=await Promise.allSettled(inputs.map(input=>client.updateSittingFinance(input)));
 const request=f.sqlite.prepare('SELECT * FROM sitting_date_change_requests WHERE id=?').get(d.old),booking=f.sqlite.prepare('SELECT * FROM canonical_bookings WHERE id=?').get(A),links=f.sqlite.prepare('SELECT * FROM sitting_date_change_quote_links').all();
 t.diagnostic(JSON.stringify({fulfilled:results.filter(r=>r.status==='fulfilled').length,requestGroup:request.replacement_group_id,bookingGroup:booking.schedule_group_id,links:links.map(l=>({quote:l.quote_id,request:l.request_id})),statuses:f.calls.filter(c=>c.body?.action==='apply_date_change').map(c=>c.status)}));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);assert.deepEqual(f.calls.filter(c=>c.body?.action==='apply_date_change').map(c=>c.status).sort(),[200,409]);
 const winner=results.findIndex(r=>r.status==='fulfilled'),loser=1-winner;assert.equal(request.replacement_group_id,qs[winner].replacementGroupId);assert.equal(booking.schedule_group_id,request.replacement_group_id);assert.equal(f.sqlite.prepare('SELECT schedule_group_id FROM provider_work_orders WHERE booking_id=?').get(A).schedule_group_id,request.replacement_group_id);assert.equal(links.length,1);assert.equal(links[0].quote_id,qs[winner].quoteId);assert.equal(f.sqlite.prepare('SELECT status FROM sitting_commercial_quotes WHERE id=?').get(qs[loser].quoteId).status,'open');assert.equal(f.sqlite.prepare('SELECT status FROM scheduling_reservations WHERE group_id=?').get(qs[loser].replacementGroupId).status,'confirmed');assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM sitting_finance_action_keys WHERE action=\'apply_date_change\'').get().n,1);
});
test('date exact same-quote/key concurrent retry replays one committed transaction',{timeout:4000},async t=>{
 const f=await fixture(t,{amount:399}),d=await f.dateRequests(),q=await f.replacement(d),input=applyDate(d,q,'DATE-EXACT-RACE');holdDateReads(f,t);
 const results=await Promise.allSettled([client.updateSittingFinance(input),client.updateSittingFinance(input)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,2,JSON.stringify(results));assert.equal(results.filter(r=>r.value?.duplicatePrevented).length,1);const before=dateSnapshot(f);assert.equal((await f.send(input)).duplicatePrevented,true);assert.deepEqual(dateSnapshot(f),before);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM sitting_date_change_quote_links').get().n,1);
});
test('date same-quote contenders with different keys refuse the loser without a second result',{timeout:4000},async t=>{
 const f=await fixture(t,{amount:399}),d=await f.dateRequests(),q=await f.replacement(d);holdDateReads(f,t);const results=await Promise.allSettled([0,1].map(i=>client.updateSittingFinance(applyDate(d,q,'DATE-SAME-QUOTE-'+i))));assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.deepEqual(f.calls.filter(c=>c.body?.action==='apply_date_change').map(c=>c.status).sort(),[200,409]);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM sitting_finance_action_keys WHERE action=\'apply_date_change\'').get().n,1);
});
for(const [table,event] of [['sitting_finance_action_keys','INSERT'],['sitting_date_change_quote_links','INSERT'],['scheduling_reservations','UPDATE'],['canonical_bookings','UPDATE'],['provider_work_orders','UPDATE'],['booking_payments','UPDATE']])test(`date transaction failure at ${table} rolls back claim and every canonical effect`,async t=>{
 const f=await fixture(t,{amount:300}),d=await f.dateRequests(),q=await f.replacement(d),input={...applyDate(d,q,'DATE-ROLLBACK-'+table),paymentAdjustmentReference:'TEST-DATE-ADJUSTMENT-99'},before=dateSnapshot(f);
 const filter=table==='sitting_finance_action_keys'?"WHEN NEW.action='apply_date_change'":'';
 f.sqlite.exec(`CREATE TEMP TRIGGER task5_date_fault BEFORE ${event} ON ${table} ${filter} BEGIN SELECT RAISE(ABORT,'task5 synthetic date effect failure'); END`);
 await f.send(input,500);assert.deepEqual(dateSnapshot(f),before,'Failed transaction leaves no applied request, consumed quote, cancelled reservation, canonical overwrite, link or success cache');f.sqlite.exec('DROP TRIGGER task5_date_fault');
 const success=await f.send(input);assert.equal(success.dateChangeRequestId,d.old);assert.equal(success.amountDelta,99);const after=dateSnapshot(f);assert.equal((await f.send(input)).duplicatePrevented,true);assert.deepEqual(dateSnapshot(f),after);
});
test('date replacement profile missing fails before any committed canonical change',async t=>{
 const f=await fixture(t,{amount:399}),d=await f.dateRequests(),q=await f.replacement(d);f.sqlite.prepare("UPDATE scheduling_assignment_decisions SET selected_provider_id='TEST-NO-SUCH-PROVIDER' WHERE group_id=?").run(q.replacementGroupId);f.sqlite.prepare("UPDATE scheduling_reservations SET provider_id='TEST-NO-SUCH-PROVIDER' WHERE group_id=?").run(q.replacementGroupId);const before=dateSnapshot(f);await f.send(applyDate(d,q,'DATE-MISSING-PROFILE'),409);assert.deepEqual(dateSnapshot(f),before);
});
for(const [name,sql] of [
 ['quote consumed',"UPDATE sitting_commercial_quotes SET status='used',used_booking_id='TEST-OTHER-CLAIM' WHERE id=?"],
 ['booking checked in',"UPDATE canonical_bookings SET status='in_progress' WHERE id=?"],
])test(`date ${name} after validation aborts the transaction without partial applied state`,async t=>{
 const f=await fixture(t,{amount:399}),d=await f.dateRequests(),q=await f.replacement(d),batch=f.db.batch.bind(f.db);let before,interleaved=0;
 f.db.batch=async statements=>{if(!interleaved&&statements[0]?.sql.startsWith('UPDATE sitting_date_change_requests SET')){interleaved++;f.sqlite.prepare(sql).run(name==='quote consumed'?q.quoteId:A);before=dateSnapshot(f);}return batch(statements);};
 t.after(()=>{f.db.batch=batch;});await f.send(applyDate(d,q,'DATE-STALE-'+name),409);assert.equal(interleaved,1);assert.deepEqual(dateSnapshot(f),before,'Only the independently committed competing change remains');assert.equal(f.sqlite.prepare('SELECT status FROM sitting_date_change_requests WHERE id=?').get(d.old).status,'commercial_quote_required');
});
