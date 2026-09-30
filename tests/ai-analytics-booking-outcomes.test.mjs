import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {register} from 'node:module';
import {installWorkersHooks} from './helpers/module-hooks.mjs';
import {hasPermission} from '../lib/platform-security.ts';

// Hermetic route/SQL execution: identity resolution and cold-schema bootstrapping are external
// boundaries. Use real permission matching, real manager scope resolution and real outcome SQL.
let activeDb,actor;
globalThis.__AI_OUTCOME_BOUNDARY__={
 db:()=>activeDb, actor:()=>actor,hasPermission,
};
const auth=`const b=globalThis.__AI_OUTCOME_BOUNDARY__;
export const database=async()=>b.db();
export function authFailure(message,status=403){return Response.json({error:message},{status});}
export function requirePermission(actor,permission){if(!b.hasPermission(actor.permissions,permission))throw authFailure('Permission denied');return actor;}
export const authorize=async(request,permission)=>requirePermission(b.actor(),permission);
export const authError=(error,message)=>error instanceof Response?error:Response.json({error:message},{status:500});`;
const stubs={
 'server-auth':auth,
 'people-foundation':'export const ensurePeopleTables=async()=>{};',
 'ai-conversation-orchestrator':'export const ensureAiConversationOrchestrator=async()=>{};',
 'ai-human-handoff':'export const ensureAiHumanHandoff=async()=>{};',
 'ai-voice-uat':'export const ensureAiVoiceUatTables=async()=>{};',
 'communication-engine':'export const ensureCommunicationTables=async()=>{};',
};
installWorkersHooks('__AI_OUTCOME_DB__');
// register() works on the older loader path too; stub modules execute in the test thread.
register(`data:text/javascript,${encodeURIComponent(`
 let stubs;
 export function initialize(data){stubs=data;}
 export function resolve(specifier,context,next){
  const key=specifier.split('/').at(-1);
  if(stubs[key])return{url:'data:text/javascript,'+encodeURIComponent(stubs[key]),shortCircuit:true};
  return next(specifier,context);
 }
`)}`,{parentURL:import.meta.url,data:stubs});
const {buildAiBookingOutcomes}=await import('../lib/ai-analytics.ts');
const {GET}=await import('../app/api/ai-analytics/route.ts');
function world(){
 const sqlite=new DatabaseSync(':memory:');
 sqlite.exec(`
 CREATE TABLE ai_conversation_turns(thread_id TEXT,created_at INTEGER,channel TEXT,intent_code TEXT,outcome TEXT,latency_ms INTEGER,input_tokens INTEGER,output_tokens INTEGER,cost_minor INTEGER,policy_decision TEXT);
 CREATE TABLE communication_threads(id TEXT PRIMARY KEY,booking_id TEXT);
 CREATE TABLE canonical_bookings(id TEXT PRIMARY KEY,city_id TEXT,status TEXT,total_amount REAL);
 CREATE TABLE booking_payments(id TEXT PRIMARY KEY,booking_id TEXT UNIQUE,status TEXT,amount REAL,amount_due_now REAL);
 CREATE TABLE payment_reconciliation_records(payment_id TEXT PRIMARY KEY,captured_amount REAL,refunded_amount REAL);
 CREATE TABLE stay_payment_schedules(booking_id TEXT PRIMARY KEY,paid_now_amount REAL,balance_amount REAL,status TEXT);
 CREATE TABLE taxi_payment_schedules(booking_id TEXT PRIMARY KEY,booking_fee_amount REAL,balance_amount REAL,status TEXT);
 CREATE TABLE booking_refund_cases(booking_id TEXT,purpose TEXT,status TEXT,amount REAL);
 CREATE TABLE ai_handoffs(reason TEXT,taken_over_at INTEGER,created_at INTEGER);
 CREATE TABLE ai_voice_calls(status TEXT,outcome TEXT,live_agent_transfer INTEGER,reconnect_count INTEGER);
 CREATE TABLE communication_message_delivery_events(event_type TEXT);
 CREATE TABLE employees(id TEXT,user_email TEXT,work_email TEXT,employment_status TEXT);
 CREATE TABLE employee_employment_versions(employee_id TEXT,location_code TEXT,team_code TEXT,cost_centre_code TEXT,effective_until INTEGER,version INTEGER);
 `);
 const queries=[];
 function statement(sql,args=[]){return{bind:(...values)=>statement(sql,values),first:async()=>{queries.push(sql);return sqlite.prepare(sql).get(...args)??null;},all:async()=>{queries.push(sql);return{results:sqlite.prepare(sql).all(...args)};}};}
 const db={prepare:sql=>statement(sql),exec:async sql=>sqlite.exec(sql),batch:async statements=>Promise.all(statements.map(s=>s.all()))};
 function link(id,{city='blr',status='confirmed',total=100,thread=`T-${id}`,channel='voice',at=100,intent='book'}={}){
  sqlite.prepare('INSERT OR IGNORE INTO canonical_bookings VALUES(?,?,?,?)').run(id,city,status,total);
  sqlite.prepare('INSERT OR IGNORE INTO communication_threads VALUES(?,?)').run(thread,id);
  sqlite.prepare('INSERT INTO ai_conversation_turns VALUES(?,?,?,?,?,?,?,?,?,?)').run(thread,at,channel,intent,'answered',10,1,1,1,'allow');
 }
 function pay(id,status='captured',due=100){sqlite.prepare('INSERT INTO booking_payments VALUES(?,?,?,?,?)').run(`P-${id}`,id,status,100,due);}
 return{sqlite,db,queries,link,pay};
}
const run=w=>buildAiBookingOutcomes(w.db,{}, {allowed:true});

test('distinct booking cohort does not multiply repeated turns or separate linked threads',async()=>{
 const w=world();w.link('A');w.link('A');w.link('A',{thread:'OTHER'});w.pay('A');
 const r=await run(w);assert.equal(r.status,'available');assert.equal(r.counts.linkedBookings,1);assert.equal(r.counts.bookingsWithCollections,1);
});
test('unpaid, completed, collected and their intersection remain distinct',async()=>{
 const w=world();w.link('UNPAID');w.pay('UNPAID','created');w.link('FAILED');w.pay('FAILED','failed');
 w.link('DONE-UNPAID',{status:'completed'});w.link('PAID');w.pay('PAID');w.link('DONE-PAID',{status:'completed'});w.pay('DONE-PAID');
 const r=await run(w);assert.deepEqual(r.counts,{linkedBookings:5,bookingsWithCollections:2,completedBookings:2,completedWithCollections:1,collectionsBelowBookingTotal:0,bookingsWithRefundEvidence:0,cancelledWithCollections:0,bookingsWithoutPaymentRecord:1});
});
test('stay and Taxi schedules preserve partial collections and paid balance evidence',async()=>{
 const w=world();for(const id of ['STAY','TAXI','BALANCE']){w.link(id);w.pay(id);}
 w.sqlite.exec("INSERT INTO stay_payment_schedules VALUES('STAY',50,50,'pending_balance'),('BALANCE',50,50,'paid');INSERT INTO taxi_payment_schedules VALUES('TAXI',20,80,'booking_fee_paid')");
 const r=await run(w);assert.equal(r.counts.bookingsWithCollections,3);assert.equal(r.counts.collectionsBelowBookingTotal,2);
});
test('reconciliation cash wins over commercial amount and reschedule differences are excluded',async()=>{
 const w=world();w.link('A');w.pay('A');w.link('B');w.pay('B');
 w.sqlite.exec("INSERT INTO payment_reconciliation_records VALUES('P-A',40,0),('P-B',20,0);INSERT INTO stay_payment_schedules VALUES('A',50,50,'paid');INSERT INTO booking_refund_cases VALUES('B','reschedule_difference','approved',20)");
 const r=await run(w);assert.equal(r.counts.bookingsWithCollections,1);assert.equal(r.counts.collectionsBelowBookingTotal,1);
});
test('refund and cancellation evidence never erase historical collections or imply net revenue',async()=>{
 const w=world();w.link('REFUND',{status:'cancelled'});w.pay('REFUND','refunded');w.link('PARTIAL');w.pay('PARTIAL','partially_refunded');w.link('CASE');w.pay('CASE');
 w.sqlite.exec("INSERT INTO booking_refund_cases VALUES('CASE','cancellation','completed',10)");
 const r=await run(w);assert.equal(r.counts.bookingsWithCollections,3);assert.equal(r.counts.bookingsWithRefundEvidence,3);assert.equal(r.counts.cancelledWithCollections,1);assert.equal(r.counts.completedWithCollections,0);
});
test('channel intent and inclusive turn window filter the cohort; current outcomes may be later',async()=>{
 const w=world();w.link('A',{at:100});w.pay('A');w.link('B',{channel:'chat'});w.link('C',{at:200});w.link('D',{intent:'care'});
 const r=await buildAiBookingOutcomes(w.db,{from:100,to:100,channel:'voice',intent:'book'},{allowed:true});assert.equal(r.counts.linkedBookings,1);assert.equal(r.counts.bookingsWithCollections,1);
});
test('city-scoped outcome query excludes foreign bookings and orphan links',async()=>{
 const w=world();w.link('LOCAL');w.pay('LOCAL');w.link('FOREIGN',{city:'hyd',status:'completed'});w.pay('FOREIGN');
 w.sqlite.exec("INSERT INTO communication_threads VALUES('ORPHAN','MISSING');INSERT INTO ai_conversation_turns(thread_id,created_at,channel,intent_code) VALUES('ORPHAN',100,'voice','book')");
 const r=await buildAiBookingOutcomes(w.db,{}, {allowed:true,cityId:'BLR'});assert.equal(r.scope,'blr');assert.equal(r.counts.linkedBookings,1);assert.equal(r.counts.completedBookings,0);
});
test('denied or explicitly empty scope performs no outcome query and returns unknown counts',async()=>{
 const w=world();for(const access of [{allowed:false},{allowed:true,cityId:''}]){const r=await buildAiBookingOutcomes(w.db,{},access);assert.equal(r.reason,'permission_or_scope');assert.ok(Object.values(r.counts).every(v=>v===null));}assert.equal(w.queries.length,0);
});
test('any required failed ledger read leaves outcomes unknown; an empty healthy cohort is zero',async()=>{
 const w=world();assert.equal((await run(w)).counts.linkedBookings,0);w.sqlite.exec('DROP TABLE payment_reconciliation_records');
 const r=await run(w);assert.equal(r.reason,'source_unavailable');assert.ok(Object.values(r.counts).every(v=>v===null));
});
async function route(w,permissions=['reports.view','finance.view'],roleCode='founder'){
 activeDb=w.db;actor={email:'staff@test.invalid',roleCode,permissions,developmentPreview:false};
 const response=await GET(new Request('https://test.invalid/api/ai-analytics'));return{response,body:await response.json()};
}
test('report-only actor retains general analytics but receives no financial outcome data',async()=>{
 const w=world();w.link('A');w.pay('A');const r=await route(w,['reports.view']);assert.equal(r.response.status,200);assert.equal(r.body.data.volume.turns,1);assert.equal(r.body.data.bookingOutcomes.reason,'permission_or_scope');assert.equal(r.body.data.conversion.attributedConversionRate,null);assert.ok(!w.queries.some(sql=>sql.includes('WITH linked')));
});
test('financial permission does not bypass reports permission',async()=>{
 const w=world();const r=await route(w,['finance.view']);assert.equal(r.response.status,403);assert.equal(w.queries.length,0);
});
test('real manager scope resolution limits financial outcomes to provisioned city',async()=>{
 const w=world();w.link('LOCAL');w.pay('LOCAL');w.link('FOREIGN',{city:'hyd'});w.pay('FOREIGN');
 w.sqlite.exec("INSERT INTO employees VALUES('E','staff@test.invalid',NULL,'active');INSERT INTO employee_employment_versions VALUES('E','Bengaluru','sales','cc-sales',NULL,1)");
 const r=await route(w,undefined,'Manager');assert.equal(r.body.data.bookingOutcomes.counts.linkedBookings,1);assert.equal(r.body.data.bookingOutcomes.scope,'blr');
});
test('unprovisioned manager cannot fall through to company-wide financial access',async()=>{
 const w=world();w.link('FOREIGN',{city:'hyd'});w.pay('FOREIGN');const r=await route(w,undefined,'manager');assert.equal(r.response.status,200);assert.equal(r.body.data.bookingOutcomes.reason,'permission_or_scope');assert.ok(!w.queries.some(sql=>sql.includes('WITH linked')));
});
test('failed financial read keeps general report available and causal conversion unknown',async()=>{
 const w=world();w.link('A');w.sqlite.exec('DROP TABLE taxi_payment_schedules');const r=await route(w);assert.equal(r.response.status,200);assert.equal(r.body.data.volume.turns,1);assert.equal(r.body.data.bookingOutcomes.reason,'source_unavailable');assert.equal(r.body.data.conversion.attributedConversionRate,null);
});
