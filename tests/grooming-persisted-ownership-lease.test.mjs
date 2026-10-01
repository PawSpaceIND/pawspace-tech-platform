import test from 'node:test';
import {installRevisionFixture} from './helpers/grooming-authority-harness.mjs';
import assert from 'node:assert/strict';
import {installAiHooks,freshAiDb,seedCustomer,inboundMessage,applyOwnedDdl,staffActor} from './helpers/ai-harness.mjs';
installAiHooks();
const {ensureAiHumanHandoff,requestAiHumanHandoff,manageAiHumanHandoff,staffTakeOverConversation,assertAiMayReply} = await import('../lib/ai-human-handoff.ts');
const {readPersistedGroomingOwnershipLease:read,persistedOwnershipBatchGuard:guard,generateWithPersistedOwnershipLease:generate} = await import('../lib/grooming-persisted-ownership-lease.ts');

async function world() {
  const {db,sqlite}=freshAiDb();let tail=Promise.resolve();
  // SQLite emulation of D1 batch semantics; repository SQL, NOT Cloudflare D1 execution.
  db.batch=items=>{const operation=tail.then(async()=>{sqlite.exec('BEGIN IMMEDIATE');try{
    const out=[];for(const item of items)out.push(await item.run());sqlite.exec('COMMIT');return out;
  }catch(error){sqlite.exec('ROLLBACK');throw error;}});tail=operation.catch(()=>{});return operation;};
  seedCustomer(sqlite,'CUS-G','Grooming','9876500044');
  await inboundMessage(sqlite,db,{threadId:'THREAD-G',customerId:'CUS-G',text:'Groom my dog',idempotencyKey:'grooming'});
  await ensureAiHumanHandoff(db);
  applyOwnedDdl(sqlite,'lib/ai-conversation-orchestrator.ts');
  sqlite.exec("INSERT INTO ai_conversation_sessions (id,thread_id,customer_id,status,created_at,updated_at) VALUES ('SESSION-G','THREAD-G','CUS-G','ai_active',1,1)");
  installRevisionFixture(sqlite);
  const input={threadId:'THREAD-G',customerId:'CUS-G'};
  const lease=actor=>read(db,{...input,actor,employeeEmail:staffActor.email});
  const request=()=>requestAiHumanHandoff(db,{...input,actorEmail:'system@test',reason:'staff_initiated'});
  const take=()=>staffTakeOverConversation(db,{...input,actor:staffActor,reason:'Employee continues Grooming'});
  const resume=()=>manageAiHumanHandoff(db,{...input,actor:staffActor,action:'resume_ai',reason:'Explicit employee release'});
  const commit=lease=>db.batch([guard(db,lease),db.prepare("UPDATE communication_threads SET booking_id='BOOKING-G' WHERE id='THREAD-G'")]);
  return {db,sqlite,lease,request,take,resume,commit,input};
}

test('durable ownership revision catches handoff ABA even when current reply guard allows AI again',async()=>{
  const w=await world(),before=await w.lease('ai');assert.equal(before.ownershipRevision,1);
  await w.take();await w.resume();await assertAiMayReply(w.db,'THREAD-G');
  const after=await w.lease('ai');assert.ok(after.ownershipRevision>before.ownershipRevision);assert.equal(after.assignedTo,before.assignedTo);
  await assert.rejects(()=>w.commit(before),/integer overflow/);
  assert.equal(w.sqlite.prepare('SELECT booking_id FROM communication_threads').get().booking_id,null);
  await w.commit(after);assert.equal(w.sqlite.prepare('SELECT booking_id FROM communication_threads').get().booking_id,'BOOKING-G');w.sqlite.close();
});

test('queued handoff invalidates the lease before employee takeover',async()=>{
  const w=await world(),before=await w.lease('ai');await w.request();
  await assert.rejects(()=>w.lease('ai'),e=>e.status===409);
  await assert.rejects(()=>w.commit(before),/integer overflow/);
  await assert.rejects(()=>w.lease('employee'),e=>e.status===409);w.sqlite.close();
});

test('actual competing takeover calls leave one assigned owner and one valid staff lease',async()=>{
  const w=await world();await w.request();const second={...staffActor,email:'other@pawspace.in',principalKey:'other@pawspace.in'};
  const results=await Promise.allSettled([manageAiHumanHandoff(w.db,{...w.input,actor:staffActor,action:'take_over'}),
    manageAiHumanHandoff(w.db,{...w.input,actor:second,action:'take_over'})]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const assigned=w.sqlite.prepare('SELECT assigned_to FROM communication_threads').get().assigned_to;
  const lease=await read(w.db,{...w.input,actor:'employee',employeeEmail:assigned});await w.commit(lease);
  await assert.rejects(()=>read(w.db,{...w.input,actor:'employee',employeeEmail:assigned===staffActor.email?second.email:staffActor.email}),e=>e.status===409);
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM conversation_assignments WHERE status='active'").get().n,1);w.sqlite.close();
});

test('a failed real takeover transaction leaves epoch and ownership unchanged, then retry invalidates lease',async()=>{
  const w=await world();await w.request();
  const count=()=>w.sqlite.prepare('SELECT COUNT(*) n FROM ai_handoff_events').get().n;
  w.sqlite.exec("CREATE TRIGGER fail_staff_session BEFORE UPDATE ON ai_conversation_sessions WHEN NEW.status='staff_active' BEGIN SELECT RAISE(ABORT,'injected takeover failure'); END");
  const before=count();await assert.rejects(()=>w.take(),/injected takeover failure/);assert.equal(count(),before);
  assert.equal(w.sqlite.prepare('SELECT status FROM ai_handoffs').get().status,'queued');
  w.sqlite.exec('DROP TRIGGER fail_staff_session');await w.take();const staff=await w.lease('employee');
  await w.resume();await assert.rejects(()=>w.commit(staff),/integer overflow/);w.sqlite.close();
});

test('guard aborts entire canonical batch including writes preceding the assertion',async()=>{
  const w=await world(),lease=await w.lease('ai');await w.take();
  await assert.rejects(()=>w.db.batch([
    w.db.prepare("UPDATE communication_threads SET booking_id='MUST-ROLL-BACK' WHERE id='THREAD-G'"),guard(w.db,lease)
  ]),/integer overflow/);
  assert.equal(w.sqlite.prepare('SELECT booking_id FROM communication_threads').get().booking_id,null);w.sqlite.close();
});

test('takeover after a preflight read blocks mutation at the final SQLite-emulated D1 batch',async()=>{
  const w=await world(),lease=await w.lease('ai');await assertAiMayReply(w.db,'THREAD-G');
  await w.take();await assert.rejects(()=>w.commit(lease),/integer overflow/);w.sqlite.close();
});

test('staff lease stays valid with model off but not after owner assignment changes or thread closes',async()=>{
  const w=await world();await w.take();const lease=await w.lease('employee');
  // Existing handoff ownership is independent of model/provider configuration.
  globalThis.__PAWSPACE_TEST_ENV__.PAWSPACE_AI_EXECUTIVE_ACTIVE='false';await w.commit(lease);
  w.sqlite.exec("UPDATE communication_threads SET assigned_to='other@pawspace.in'");
  await assert.rejects(()=>w.commit(lease),/integer overflow/);
  w.sqlite.exec("UPDATE communication_threads SET assigned_to='founder@pawspace.in',status='closed'");
  await assert.rejects(()=>w.commit(lease),/integer overflow/);w.sqlite.close();
});

test('canonical customer mismatch and unavailable persisted state fail closed',async()=>{
  const w=await world();await assert.rejects(()=>read(w.db,{...w.input,customerId:'other',actor:'ai'}),e=>e.status===403);
  w.sqlite.exec('DROP TABLE conversation_ownership_revisions');await assert.rejects(()=>w.lease('ai'),e=>e.status===409);w.sqlite.close();
});

test('real handoff/resume while model reply is in flight invalidates persisted generation lease',async()=>{
  const w=await world(),lease=await w.lease('ai');let started,finish;
  const begun=new Promise(resolve=>{started=resolve;});
  const reply=generate(w.db,lease,()=>{started();return new Promise(resolve=>{finish=resolve;});});
  await begun;await w.take();await w.resume();finish('outdated quote reply');
  await assert.rejects(()=>reply,e=>e.status===409);
  assert.equal(w.sqlite.prepare('SELECT booking_id FROM communication_threads').get().booking_id,null);w.sqlite.close();
});

test('actual delegated tool rejects employee ownership before canonical reservation dispatch',async()=>{
  const w=await world();await w.take();
  const {executeGovernedConversationTool}=await import('../lib/ai-first-control-plane.ts');
  await assert.rejects(()=>executeGovernedConversationTool(w.db,{actor:{...staffActor,
    email:'atlas@system.pawspace',permissions:['communications.manage']},threadId:'THREAD-G',
    customerId:'CUS-G',toolCode:'schedule.reserve',intent:'booking_create',channel:'chat',
    arguments:{serviceCode:'grooming'},idempotencyKey:'grooming-reserve',customerConfirmed:true}),e=>e.status===409);
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='scheduling_reservations'").get().n,0);w.sqlite.close();
});

test('characterization: existing enqueue lookup needs full thread context to retain lead plus booking thread',async()=>{
  const w=await world();
  const {enqueueCommunication}=await import('../lib/communication-engine.ts');
  w.sqlite.exec("UPDATE communication_threads SET lead_id='LEAD-G',booking_id='BOOKING-G'");
  const same=await enqueueCommunication(w.db,{customerId:'CUS-G',cityId:'blr',channel:'whatsapp',
    purpose:'transactional',bookingId:'BOOKING-G',leadId:'LEAD-G',templateKey:'test',payload:{text:'Draft'},
    createdBy:staffActor.email,idempotencyKey:'complete-context'});
  assert.equal(same.threadId,'THREAD-G');
  const missing=await enqueueCommunication(w.db,{customerId:'CUS-G',cityId:'blr',channel:'whatsapp',
    purpose:'transactional',bookingId:'BOOKING-G',templateKey:'test',payload:{text:'Draft'},
    createdBy:staffActor.email,idempotencyKey:'incomplete-context'});
  assert.notEqual(missing.threadId,'THREAD-G');
  assert.equal(w.sqlite.prepare('SELECT COUNT(*) n FROM communication_threads').get().n,2);w.sqlite.close();
});

test('P1 regression: non-handoff assignment ABA rejects old ownership lease',async()=>{
  const w=await world(),lease=await w.lease('ai');
  const {assignConversation}=await import('../lib/conversation-governance.ts');
  await assignConversation(w.db,{threadId:'THREAD-G',assignedTo:'cx@pawspace.in',assignedBy:staffActor.email});
  await assignConversation(w.db,{threadId:'THREAD-G',assignedTo:'ai-orchestrator',assignedBy:staffActor.email});
  assert.ok((await w.lease('ai')).ownershipRevision>lease.ownershipRevision);
  await assert.rejects(()=>w.commit(lease),/integer overflow/);
  assert.equal(w.sqlite.prepare('SELECT booking_id FROM communication_threads').get().booking_id,null);w.sqlite.close();
});

test('P1 regression: status close/reopen rejects old ownership lease',async()=>{
  const w=await world(),lease=await w.lease('ai');
  const {setConversationStatus}=await import('../lib/conversation-governance.ts');
  await setConversationStatus(w.db,{threadId:'THREAD-G',status:'closed',actorEmail:staffActor.email});
  await setConversationStatus(w.db,{threadId:'THREAD-G',status:'open',actorEmail:staffActor.email});
  assert.ok((await w.lease('ai')).ownershipRevision>lease.ownershipRevision);
  await assert.rejects(()=>w.commit(lease),/integer overflow/);
  assert.equal(w.sqlite.prepare('SELECT booking_id FROM communication_threads').get().booking_id,null);w.sqlite.close();
});

test('direct SQL owner/status ABA is covered without calling governance functions',async()=>{
  const w=await world(),lease=await w.lease('ai');
  w.sqlite.exec("UPDATE communication_threads SET assigned_to='cx@pawspace.in',status='closed'; UPDATE communication_threads SET assigned_to='ai-orchestrator',status='open'");
  assert.equal((await w.lease('ai')).ownershipRevision,lease.ownershipRevision+2);
  await assert.rejects(()=>w.commit(lease),/integer overflow/);w.sqlite.close();
});

test('revision tombstone survives thread deletion/recreation with the same canonical ID',async()=>{
  const w=await world(),lease=await w.lease('ai');
  w.sqlite.exec("DELETE FROM communication_threads WHERE id='THREAD-G'");
  await inboundMessage(w.sqlite,w.db,{threadId:'THREAD-G',customerId:'CUS-G',text:'New incarnation',idempotencyKey:'recreated'});
  assert.ok((await w.lease('ai')).ownershipRevision>lease.ownershipRevision);
  await assert.rejects(()=>w.commit(lease),/integer overflow/);w.sqlite.close();
});

test('failed status transaction rolls back both status and durable revision',async()=>{
  const w=await world(),lease=await w.lease('ai');
  await assert.rejects(()=>w.db.batch([
    w.db.prepare("UPDATE communication_threads SET status='closed' WHERE id='THREAD-G'"),
    w.db.prepare('SELECT abs(-9223372036854775808)')
  ]),/integer overflow/);
  assert.equal((await w.lease('ai')).ownershipRevision,lease.ownershipRevision);
  await w.commit(lease);w.sqlite.close();
});

test('missing revision row fails closed and revision saturation blocks owner/status change',async()=>{
  const w=await world();
  w.sqlite.exec("DROP TRIGGER conversation_revision_no_delete; DELETE FROM conversation_ownership_revisions WHERE thread_id='THREAD-G'");
  await assert.rejects(()=>w.lease('ai'),e=>e.status===409);
  w.sqlite.exec("INSERT INTO conversation_ownership_revisions VALUES('THREAD-G',9007199254740991)");
  await assert.rejects(()=>w.db.prepare("UPDATE communication_threads SET status='closed' WHERE id='THREAD-G'").run(),/CHECK constraint failed/);
  assert.equal(w.sqlite.prepare('SELECT status FROM communication_threads').get().status,'open');w.sqlite.close();
});

for(const column of ['customer_id','lead_id','booking_id','ticket_id'])test(`canonical scope ${column} ABA invalidates old lease`,async()=>{
 const w=await world(),lease=await w.lease('ai');
 const original=w.sqlite.prepare(`SELECT ${column} value FROM communication_threads`).get().value;
 w.sqlite.prepare(`UPDATE communication_threads SET ${column}=?`).run('other-scope');
 w.sqlite.prepare(`UPDATE communication_threads SET ${column}=?`).run(original);
 assert.ok((await w.lease('ai')).ownershipRevision>lease.ownershipRevision);
 await assert.rejects(()=>w.commit(lease),/integer overflow/);w.sqlite.close();
});
