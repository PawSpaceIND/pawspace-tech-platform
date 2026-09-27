import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { installWorkersHooks } from './helpers/module-hooks.mjs';
import { operationThresholds, REQUIRED_OPERATIONS } from '../scripts/ops/performance-thresholds.mjs';
installWorkersHooks('__PERFORMANCE_AUDIT_DB__');
const { chunkedIn } = await import('../lib/d1-chunked-in.ts');
const { bootstrapHome } = await import('../lib/v2/home-bootstrap.ts');
const { buildAiAnalytics, ensureAiAnalytics } = await import('../lib/ai-analytics.ts');
const { buildCompanyAnalytics } = await import('../lib/company-analytics.ts');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject};};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function home(session,availability){const state={};const task=bootstrapHome({session:()=>session.promise,availability:()=>availability.promise,account:async()=>{state.accountStarted=true;return 'family';},onAccount:x=>state.account=x,onAvailability:x=>state.availability=x,onAccountError:x=>state.accountError=x,onAvailabilityError:x=>state.availabilityError=x,onAccountSettled:()=>state.settled=true});return {state,task};}
test('available services publish while identity is still pending',async()=>{const s=deferred(),a=deferred(),h=home(s,a);a.resolve(['grooming']);await flush();assert.deepEqual(h.state.availability,['grooming']);assert.equal(h.state.accountStarted,undefined);s.resolve(false);await h.task;assert.equal(h.state.account,null);});
test('account begins and settles without waiting for availability; availability errors stay separate',async()=>{const s=deferred(),a=deferred(),h=home(s,a);s.resolve(true);await flush();assert.equal(h.state.account,'family');assert.equal(h.state.settled,true);a.reject(new Error('unavailable'));await h.task;assert.equal(h.state.account,'family');assert.match(h.state.availabilityError.message,/unavailable/);});
test('identity failures cannot hide public availability or trigger account reads',async()=>{const s=deferred(),a=deferred(),h=home(s,a);s.reject(new Error('identity'));a.resolve(['grooming']);await h.task;assert.equal(h.state.accountStarted,undefined);assert.deepEqual(h.state.availability,['grooming']);assert.equal(h.state.settled,true);});
test('large IN reads keep at most four requests in flight and preserve every row in order',async()=>{let active=0,max=0;const ids=Array.from({length:1050},(_,i)=>i);const result=await chunkedIn(ids,async(chunk,marks)=>{active++;max=Math.max(max,active);assert.equal(marks.split(',').length,chunk.length);assert.ok(chunk.length<=80);await flush();active--;return chunk;});assert.equal(max,4);assert.deepEqual(result,ids);});
test('IN read failures remain errors, and invalid chunk sizes cannot hang',async()=>{await assert.rejects(chunkedIn([1],async()=>{throw Error('D1 down')}),/D1 down/);await assert.rejects(chunkedIn([1],async x=>x,NaN),/Chunk size/);});
test('fast ledger volume never hides slow bookings and missing operations fail closed',()=>{const values=Object.fromEntries(REQUIRED_OPERATIONS.map(n=>[n,{count:n==='ledger-query'?10000:100,p95Ms:100}]));values.booking.p95Ms=1800;assert.equal(operationThresholds(values).booking,false);assert.equal(operationThresholds(values)['ledger-query'],true);delete values.assignment;assert.equal(operationThresholds(values).assignment,false);values.booking.p95Ms=NaN;assert.equal(operationThresholds(values).booking,false);});
function world(){const sql=new DatabaseSync(':memory:');let batches=0,ddl=0;const selects=[];function stmt(query,args=[]){function run(){if(/^\s*(CREATE|ALTER)/i.test(query))ddl++;if(/^\s*SELECT/i.test(query)){selects.push({query,args});return {results:sql.prepare(query).all(...args),success:true};}const result=sql.prepare(query).run(...args);return {results:[],success:true,meta:{changes:Number(result.changes)}};}return {bind:(...v)=>stmt(query,v),run:async()=>run(),all:async()=>run(),first:async()=>run().results[0]??null};}const db={prepare:q=>stmt(q),batch:async xs=>{batches++;return Promise.all(xs.map(x=>x.all()));},exec:async q=>{ddl++;sql.exec(q);return {count:1,duration:0};}};return {sql,db,selects,reset(){batches=0;ddl=0;selects.length=0;},stats:()=>({batches,ddl})};}
test('AI report batches reads, filters linked threads, handles epoch zero and counts latency samples',async()=>{const w=world();await ensureAiAnalytics(w.db);w.sql.exec(`
INSERT INTO communication_threads (id,customer_id,booking_id,status,created_at,updated_at) VALUES ('chat','c','b','open',0,0),('voice','v','v-b','open',0,0);
INSERT INTO ai_conversation_turns (id,session_id,thread_id,customer_id,channel,input_message_id,idempotency_key,intent_code,intent_confidence,context_id,provider,output_text,policy_decision,outcome,latency_ms,created_at,completed_at) VALUES
('t1','s1','chat','c','chat','m1','i1','booking',1,'ctx','test','reply','allow','reply',100,0,1),
('t2','s1','chat','c','chat','m2','i2','booking',1,'ctx','test','reply','allow','reply',200,1,2),
('t3','s2','voice','v','voice','m3','i3','booking',1,'ctx','test','reply','allow','reply',900,0,1);
INSERT INTO ai_explicit_csat VALUES ('r','voice','v',5,'voice',0);
`);w.reset();const r=await buildAiAnalytics(w.db,{channel:'chat',from:0,to:0});assert.equal(r.volume.turns,1);assert.equal(r.conversion.canonicalBookingLinkedThreads,1);assert.equal(r.performance.latencySamples,1);assert.equal(r.performance.avgLatencyMs,100);assert.equal(r.csat.responses,1);assert.match(r.definitions.scope,/all-time across all channels/);assert.deepEqual(w.stats(),{batches:1,ddl:0});const empty=await buildAiAnalytics(w.db,{channel:'whatsapp'});assert.equal(empty.conversion.canonicalBookingLinkedThreads,0);assert.equal(empty.performance.avgLatencyMs,null);w.sql.close();});
test('company report includes closing-day timestamps and uses indexed raw date bounds',async()=>{const w=world();w.sql.exec(`CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,service_code TEXT,package_code TEXT,zone_id TEXT,provider_id TEXT,status TEXT,total_amount REAL,currency TEXT,scheduled_start TEXT,scheduled_end TEXT);CREATE INDEX scheduled ON canonical_bookings(scheduled_start);`);for(const [id,date] of [['before','2026-06-30T23:59:59Z'],['first','2026-07-01T00:00:00Z'],['last','2026-07-31T23:59:59.999+05:30'],['after','2026-08-01T00:00:00Z']])w.sql.prepare("INSERT INTO canonical_bookings VALUES (?,?,'dog_walking','p','z','provider','completed',100,'INR',?,?)").run(id,id,date,date);const r=await buildCompanyAnalytics(w.db,{from:'2026-07-01',to:'2026-07-31'});assert.equal(r.bookings.total,2);assert.equal(r.money.gmv,200);const q=w.selects.find(x=>x.query.includes('FROM canonical_bookings WHERE'));const plan=w.sql.prepare('EXPLAIN QUERY PLAN '+q.query).all(...q.args);assert.ok(plan.some(x=>/SEARCH.*USING INDEX scheduled/.test(x.detail)),JSON.stringify(plan));w.sql.close();});

// The isolated staging measurement runner belongs to this performance regression suite.
import {runStagingReadPerformance} from '../scripts/ops/staging-read-performance.mjs';
const sha='a'.repeat(40);
async function run({origin='https://pawspace-staging.karthik-fce.workers.dev',certificateSha=sha,fail=false}={}) {
 let output='',saved='',requests=0;
 const report=await runStagingReadPerformance({env:{STAGING_URL:origin,EXPECTED_SHA:sha,PAWSPACE_UAT_ACCESS_CODE:'ACCESS_DO_NOT_LOG'},read:async()=>JSON.stringify({sha:certificateSha,checks:[{ok:true}]}),write:async(_,s)=>{saved=s;},log:s=>{output=s;},fetcher:async(url,options)=>{
 requests++;
 if(url.endsWith('/api/staging-login'))return Response.json({},{headers:{'set-cookie':'session=DO_NOT_LOG; HttpOnly'}});
 assert.equal(options.method,'GET');
 if(fail)return Response.json({error:'PRIVATE_DATA_DO_NOT_LOG'},{status:500});
 const headers={'server-timing':'app;dur=120, d1;dur=90;desc="9 calls"'};
 if(url.includes('company-analytics'))return Response.json({data:{source:'canonical_company_metric_layer',degraded:null}},{headers});
 if(url.includes('ai-analytics'))return Response.json({data:{conversion:{canonicalBookingLinkedThreads:1},volume:{threads:2},performance:{latencySamples:2}}},{headers});
 if(url.includes('grooming-finance'))return Response.json({scope:{limit:200,dateFiltered:false},items:[]},{headers});
 return Response.json({services:[]},{headers});
 }});
 return {report,output,saved,requests};
}
test('performance probe refuses production and mismatched certified builds',async()=>{for(const input of [{origin:'https://pawspace.in'},{certificateSha:'b'.repeat(40)}])await assert.rejects(run(input),/staging/i);});
test('performance probe records bounded read samples and numeric server timing without credentials',async()=>{const r=await run();assert.equal(r.requests,41);assert.equal(Object.keys(r.report.operations).length,4);assert.ok(Object.values(r.report.operations).every(x=>x.samplesMs.length===10));assert.deepEqual(r.report.operations['grooming-finance'].serverTiming[0],{appMs:120,d1TotalMs:90,d1Calls:9});assert.deepEqual(r.report.failures,[]);assert.doesNotMatch(r.output+r.saved,/DO_NOT_LOG|set-cookie/);});
test('API failure is visible but private response text is never in the report',async()=>{const r=await run({fail:true});assert.equal(r.report.failures.length,40);assert.doesNotMatch(r.output+r.saved,/PRIVATE_DATA|DO_NOT_LOG/);});

const {createTranscriptPoll}=await import('../lib/v2/transcript-poll.ts');
test('slow transcript polling remains single-flight and restarts after completion',async()=>{let calls=0;const pending=deferred();const poll=createTranscriptPoll(async()=>{calls++;await pending.promise;});const first=poll.tick();await poll.tick();await poll.tick();assert.equal(calls,1);pending.resolve();await first;await poll.tick();assert.equal(calls,2);poll.stop();await poll.tick();assert.equal(calls,2);});
test('transcript timeout and unmount abort reads; timeout permits a later retry',async()=>{let calls=0,aborts=0;const poll=createTranscriptPoll(signal=>{calls++;return new Promise((_,reject)=>signal.addEventListener('abort',()=>{aborts++;reject(Error('aborted'));},{once:true}));},5);await poll.tick();assert.equal(aborts,1);const next=poll.tick();poll.stop();await next;assert.equal(calls,2);assert.equal(aborts,2);await poll.tick();assert.equal(calls,2);});

test('a thousand-booking report reads each money/CX ledger once, preserving all collected funds',async()=>{
 const w=world();w.sql.exec(`CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,service_code TEXT,package_code TEXT,zone_id TEXT,provider_id TEXT,status TEXT,total_amount REAL,currency TEXT,scheduled_start TEXT,scheduled_end TEXT);CREATE INDEX scheduled ON canonical_bookings(scheduled_start);
 CREATE TABLE booking_payments(booking_id TEXT,amount REAL,amount_due_now REAL,status TEXT,gateway TEXT);
 CREATE TABLE customer_experience_tickets(booking_id TEXT,category TEXT,priority TEXT,status TEXT,created_at INTEGER,resolved_at INTEGER,reopened_count INTEGER);
 CREATE TABLE stay_payment_schedules(booking_id TEXT,paid_now_amount REAL,balance_amount REAL,status TEXT);
 CREATE TABLE booking_refund_cases(booking_id TEXT,amount REAL,status TEXT);`);
 for(let i=0;i<1000;i++){w.sql.prepare("INSERT INTO canonical_bookings VALUES (?,?,'dog_walking','p','z','provider','completed',100,'INR','2026-07-15','2026-07-15')").run('b'+i,'c'+i);w.sql.prepare("INSERT INTO booking_payments VALUES (?,100,100,'captured','sandbox')").run('b'+i);}
 const r=await buildCompanyAnalytics(w.db,{from:'2026-07-01',to:'2026-07-31'});assert.equal(r.bookings.total,1000);assert.equal(r.money.collected,100000);
 for(const table of ['booking_payments','stay_payment_schedules','booking_refund_cases']){const reads=w.selects.filter(x=>x.query.includes('FROM '+table+' WHERE'));assert.equal(reads.length,1,table);assert.deepEqual(reads[0].args,['2026-07-01','2026-07-31\uffff']);}
 w.sql.close();
});

test('an obsolete home bootstrap cannot publish account, availability, errors or loading completion',async()=>{
 const account=deferred(),availability=deferred();let current=true;const published=[];
 const task=bootstrapHome({session:async()=>true,account:()=>account.promise,availability:()=>availability.promise,isCurrent:()=>current,onAccount:x=>published.push(x),onAvailability:x=>published.push(x),onAccountError:x=>published.push(x),onAvailabilityError:x=>published.push(x),onAccountSettled:()=>published.push('settled')});
 await flush();current=false;account.resolve('old family');availability.reject(Error('old failure'));await task;assert.deepEqual(published,[]);
});
test('poll failures surface status, a successful retry clears it, cleanup emits no late status',async()=>{
 const messages=[];let fail=true;const poll=createTranscriptPoll(async()=>{if(fail)throw Error('offline');},10000,x=>messages.push(x));await poll.tick();assert.match(messages[0],/Retrying/);fail=false;await poll.tick();assert.equal(messages[1],'');poll.stop();await poll.tick();assert.equal(messages.length,2);
});
