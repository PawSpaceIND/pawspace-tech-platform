import test from 'node:test';
import assert from 'node:assert/strict';
import {installAiHooks,freshAiDb,seedCustomer,inboundMessage,applyOwnedDdl,staffActor} from './helpers/ai-harness.mjs';
installAiHooks();
const {requestAiHumanHandoff,manageAiHumanHandoff,assertAiMayReply}=await import('../lib/ai-human-handoff.ts');
async function world(){
 const {sqlite,db}=freshAiDb();
 // D1 serializes standalone operations with an atomic batch. A standalone UPDATE cannot
 // run inside another request's transaction and then be undone by that request's rollback.
 let tail=Promise.resolve();const nativePrepare=db.prepare;
 const enqueue=operation=>{const result=tail.then(operation);tail=result.catch(()=>{});return result;};
 const wrap=(statement,sql)=>({native:statement,sql,bind:(...args)=>wrap(statement.bind(...args),sql),first:(...args)=>enqueue(()=>statement.first(...args)),run:()=>enqueue(()=>statement.run()),all:()=>enqueue(()=>statement.all()),raw:()=>enqueue(()=>statement.raw())});
 db.prepare=sql=>wrap(nativePrepare(sql),sql);
 db.batch=items=>enqueue(async()=>{sqlite.exec('BEGIN');try{const results=[];for(const item of items)results.push(await (item.native||item).run());sqlite.exec('COMMIT');return results;}catch(error){sqlite.exec('ROLLBACK');throw error;}});
 seedCustomer(sqlite,'CUS-H','Handoff','9876500044');
 await inboundMessage(sqlite,db,{threadId:'THREAD-H',customerId:'CUS-H',text:'Human please',idempotencyKey:'handoff'});
 applyOwnedDdl(sqlite,'lib/ai-conversation-orchestrator.ts');
 sqlite.exec("INSERT INTO ai_conversation_sessions (id,thread_id,customer_id,status,created_at,updated_at) VALUES ('SESSION-H','THREAD-H','CUS-H','ai_active',1,1)");
 const request=()=>requestAiHumanHandoff(db,{actorEmail:'system@test',threadId:'THREAD-H',customerId:'CUS-H',reason:'customer_requested_human'});
 const manage=(action,actor=staffActor)=>manageAiHumanHandoff(db,{actor,threadId:'THREAD-H',customerId:'CUS-H',action,reason:'Customer issue resolved'});
 const state=()=>({thread:sqlite.prepare("SELECT assigned_to,sla_due_at FROM communication_threads WHERE id='THREAD-H'").get(),session:sqlite.prepare("SELECT status FROM ai_conversation_sessions WHERE id='SESSION-H'").get().status,handoffs:sqlite.prepare('SELECT * FROM ai_handoffs').all(),assignments:sqlite.prepare('SELECT * FROM conversation_assignments').all(),events:sqlite.prepare('SELECT * FROM ai_handoff_events').all(),audit:sqlite.prepare('SELECT * FROM conversation_audit_events').all()});
 const fail=status=>sqlite.exec(`CREATE TRIGGER fail_session BEFORE UPDATE ON ai_conversation_sessions WHEN NEW.status='${status}' BEGIN SELECT RAISE(ABORT,'injected session failure'); END`);
 return {sqlite,db,request,manage,state,fail};
}
test('request rolls back ownership, SLA and events when session pause fails; retry succeeds',async()=>{
 const w=await world();w.fail('human_handoff');
 await assert.rejects(w.request,/injected session failure/);
 const failed=w.state();assert.equal(failed.session,'ai_active');assert.equal(failed.thread.assigned_to,'ai-orchestrator');assert.equal(failed.handoffs.length,0);assert.equal(failed.assignments.length,0);assert.equal(failed.events.length,0);assert.equal(failed.audit.length,0);
 w.sqlite.exec('DROP TRIGGER fail_session');await w.request();await assert.rejects(()=>assertAiMayReply(w.db,'THREAD-H'),e=>e.status===409);
 assert.equal(w.state().session,'human_handoff');assert.equal((await w.request()).duplicatePrevented,true);
 await assert.rejects(()=>requestAiHumanHandoff(w.db,{actorEmail:'system@test',threadId:'THREAD-H',customerId:'WRONG',reason:'complaint'}),e=>e.status===403);
});
for(const action of ['take_over','resume_ai'])test(`${action} rollback preserves the complete ownership state and allows retry`,async()=>{
 const w=await world();await w.request();if(action==='resume_ai')await w.manage('take_over');
 const before=w.state();w.fail(action==='take_over'?'staff_active':'ai_active');
 await assert.rejects(()=>w.manage(action),/injected session failure/);assert.deepEqual(w.state(),before);
 await assert.rejects(()=>assertAiMayReply(w.db,'THREAD-H'),e=>e.status===409);
 w.sqlite.exec('DROP TRIGGER fail_session');await w.manage(action);
 assert.equal(w.state().session,action==='take_over'?'staff_active':'ai_active');
 if(action==='resume_ai')await assertAiMayReply(w.db,'THREAD-H');
});
for(const action of ['take_over','resume_ai'])test(`concurrent ${action} has exactly one winner and one active assignment`,async()=>{
 const w=await world();await w.request();if(action==='resume_ai')await w.manage('take_over');
 const second={...staffActor,email:'second@pawspace.in',principalKey:'second@pawspace.in'};
 const results=await Promise.allSettled([w.manage(action),w.manage(action,second)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.status,409);
 const state=w.state(),event=action==='take_over'?'staff_takeover':'ai_resumed';
 assert.equal(state.events.filter(e=>e.event_type===event).length,1);assert.equal(state.assignments.filter(a=>a.status==='active').length,1);
 assert.equal(state.thread.assigned_to,action==='take_over'?state.handoffs[0].taken_over_by:'ai-orchestrator');
});
test('concurrent handoff requests return the same canonical active handoff',async()=>{
 const w=await world();const results=await Promise.all([w.request(),w.request()]);
 assert.equal(results[0].handoff.id,results[1].handoff.id);assert.equal(results.filter(r=>r.duplicatePrevented).length,1);
 assert.equal(w.state().handoffs.length,1);assert.equal(w.state().assignments.filter(a=>a.status==='active').length,1);
 assert.equal(results[0].ticketReceipt.caseId,results[1].ticketReceipt.caseId);assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM unified_cases').get().n,1);assert.equal(w.sqlite.prepare('SELECT ticket_id FROM communication_threads').get().ticket_id,results[0].ticketReceipt.caseId);
});

for(const failure of ['unrelated case storage failure','UNIQUE constraint failed: unified_case_events.idempotency_key','UNIQUE constraint failed: unified_cases.idempotency_key'])test('ticket repair does not swallow unrelated errors or a collision without a persisted winner: '+failure,async()=>{const w=await world();await(await import('../lib/unified-case-center.ts')).ensureUnifiedCaseTables(w.db);w.sqlite.exec(`CREATE TRIGGER fail_case BEFORE INSERT ON unified_cases BEGIN SELECT RAISE(ABORT,'${failure}'); END`);await assert.rejects(w.request,error=>error instanceof Error&&error.message.includes(failure));assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM unified_cases').get().n,0);assert.equal(w.sqlite.prepare('SELECT ticket_id FROM communication_threads').get().ticket_id,null);w.sqlite.exec('DROP TRIGGER fail_case');const retry=await w.request();assert.equal(retry.duplicatePrevented,true);assert.ok(retry.ticketReceipt.caseId);assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM unified_cases').get().n,1);});
for(const [column,value] of [['customer_id','WRONG'],['source_type','wrong'],['source_id','wrong'],['case_type','refund'],['owner_team','finance'],['booking_id','foreign-booking'],['lead_id','foreign-lead'],['status','closed']])test('collision readback refuses mismatched persisted winner '+column,async()=>{const w=await world(),batch=w.db.batch;let injected=false;w.db.batch=async items=>{if(!injected&&items.some(item=>String(item.sql).startsWith('INSERT INTO unified_cases '))){injected=true;await batch(items);w.sqlite.prepare(`UPDATE unified_cases SET ${column}=?`).run(value);throw new Error('UNIQUE constraint failed: unified_cases.idempotency_key');}return batch(items);};await assert.rejects(w.request,/UNIQUE constraint failed: unified_cases\.idempotency_key/);assert.equal(w.sqlite.prepare('SELECT ticket_id FROM communication_threads').get().ticket_id,null);assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM unified_cases').get().n,1);});
