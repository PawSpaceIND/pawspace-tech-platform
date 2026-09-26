import test from 'node:test';
import assert from 'node:assert/strict';
import {installAiHooks,freshAiDb,seedCustomer,inboundMessage,applyOwnedDdl,staffActor} from './helpers/ai-harness.mjs';
installAiHooks();
const {requestAiHumanHandoff,manageAiHumanHandoff,assertAiMayReply}=await import('../lib/ai-human-handoff.ts');
async function world(){
 const {sqlite,db}=freshAiDb();
 let tail=Promise.resolve();
 db.batch=items=>{const operation=tail.then(async()=>{sqlite.exec('BEGIN');try{const results=[];for(const item of items)results.push(await item.run());sqlite.exec('COMMIT');return results;}catch(error){sqlite.exec('ROLLBACK');throw error;}});tail=operation.catch(()=>{});return operation;};
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
});
test('an attached lead is escalated in the same transaction as its handoff, so a failed escalation leaves nothing queued and a retry repairs both',async()=>{
 const w=await world(),{ensureAiHumanHandoff}=await import('../lib/ai-human-handoff.ts'),{ensureConversationAccessTables}=await import('../lib/conversation-access.ts');
 applyOwnedDdl(w.sqlite,'lib/lead-owner-identity.ts');await ensureAiHumanHandoff(w.db);await ensureConversationAccessTables(w.db);
 w.sqlite.exec("INSERT INTO lead_work_items (id,customer_id,source,service,owner,manager,status,assigned_at,first_action_due_at,manager_alert_at,created_at,updated_at) VALUES ('LEAD-H','CRM-H','website','grooming','AI Orchestrator','AI Sales','active',1,1,1,1,1)");
 w.sqlite.exec("INSERT INTO ai_lead_ownership (lead_id,contact_id,status,created_at,updated_at) VALUES ('LEAD-H','CRM-H','ai_owned',1,1)");
 w.sqlite.exec("INSERT INTO crm_contacts (id,name,primary_phone,owner,created_at,updated_at) VALUES ('CRM-H','Handoff','9876500044','AI Orchestrator',1,1)");
 w.sqlite.exec("UPDATE communication_threads SET lead_id='LEAD-H' WHERE id='THREAD-H'");
 const lead=()=>({work:{...w.sqlite.prepare("SELECT owner,manager FROM lead_work_items WHERE id='LEAD-H'").get()},ownership:{...w.sqlite.prepare("SELECT status,human_owner,customer_requested_human FROM ai_lead_ownership WHERE lead_id='LEAD-H'").get()},contact:w.sqlite.prepare("SELECT owner FROM crm_contacts WHERE id='CRM-H'").get().owner,tasks:w.sqlite.prepare("SELECT id,owner FROM crm_tasks WHERE contact_id='CRM-H'").all().map(row=>({...row}))});
 w.sqlite.exec("CREATE TRIGGER fail_lead BEFORE UPDATE ON lead_work_items BEGIN SELECT RAISE(ABORT,'injected lead failure'); END");
 await assert.rejects(w.request,/injected lead failure/);
 const failed=w.state();
 assert.equal(failed.handoffs.length,0,'a handoff committed without its lead escalation would short-circuit every retry as a duplicate');
 assert.equal(failed.events.length,0);assert.equal(failed.thread.assigned_to,'ai-orchestrator');assert.equal(failed.session,'ai_active');
 assert.equal(lead().ownership.status,'ai_owned');assert.equal(lead().work.owner,'AI Orchestrator');assert.equal(lead().tasks.length,0);
 await assertAiMayReply(w.db,'THREAD-H');
 w.sqlite.exec('DROP TRIGGER fail_lead');
 const created=await w.request();
 assert.equal(created.duplicatePrevented,false);assert.equal(created.handoff.queue_code,'cx-ai-handoff');
 assert.deepEqual(lead(),{work:{owner:'cx-ai-handoff',manager:'Human Sales Manager'},ownership:{status:'human_escalated',human_owner:'cx-ai-handoff',customer_requested_human:1},contact:'cx-ai-handoff',tasks:[{id:'AI-ESC-LEAD-H',owner:'cx-ai-handoff'}]});
 const again=await w.request();
 assert.equal(again.duplicatePrevented,true);assert.equal(again.handoff.id,created.handoff.id);
 assert.deepEqual(Object.keys(again.handoff).sort(),Object.keys(w.state().handoffs[0]).sort(),'the duplicate answer is the ai_handoffs row, not the thread columns its lookup joined');
 assert.equal(lead().tasks.length,1);
});
