import test from 'node:test';
import assert from 'node:assert/strict';
import {installAiHooks,freshAiDb,seedCustomer,customerActor,staffActor,inboundMessage} from './helpers/ai-harness.mjs';
installAiHooks();
const adapter=await import('../lib/customer-refund-request.ts');
const cases=await import('../lib/unified-case-center.ts');
const orchestrator=await import('../lib/ai-conversation-orchestrator.ts');
async function world(t,channel='chat'){
 const w=freshAiDb();t.after(()=>w.sqlite.close());
 // Mirror D1 atomic batches: a binding-event collision must roll back its case insert.
 const simpleBatch=w.db.batch;let tail=Promise.resolve();
 w.db.batch=async items=>{const prior=tail;let release;tail=new Promise(resolve=>release=resolve);await prior;w.sqlite.exec('BEGIN');try{const result=await simpleBatch(items);w.sqlite.exec('COMMIT');return result;}catch(error){w.sqlite.exec('ROLLBACK');throw error;}finally{release();}};

 seedCustomer(w.sqlite,'CUS-REFUND','Synthetic customer','9876500081');seedCustomer(w.sqlite,'CUS-OTHER','Other customer','9876500082');
 const messageId=await inboundMessage(w.sqlite,w.db,{threadId:'THREAD-REFUND',customerId:'CUS-REFUND',text:'I want a refund for booking BKG-REFUND because the service was incomplete.',channel,idempotencyKey:`refund-${channel}`});
 for(const [id,owner] of [['BKG-REFUND','CUS-REFUND'],['BKG-OTHER','CUS-OTHER']])w.sqlite.prepare("INSERT INTO canonical_bookings(id,customer_id,service_code,package_name,status,scheduled_start,scheduled_end,total_amount,created_at,updated_at) VALUES (?,?,'grooming','Synthetic package','completed','2026-10-01T10:00:00Z','2026-10-01T11:00:00Z',1000,?,?)").run(id,owner,Date.now(),Date.now());
 const actor=customerActor(w.sqlite,'CUS-REFUND');await cases.ensureUnifiedCaseTables(w.db);
 return{...w,messageId,actor,input:{actor,customerId:'CUS-REFUND',threadId:'THREAD-REFUND',bookingId:'BKG-REFUND',reason:'The service was incomplete.',channel,idempotencyKey:'refund-request-key'}};
}
test('explicit request classifier rejects policy questions and negated requests',()=>{
 for(const text of ['I want a refund.','Please request a refund for my booking.','Refund this booking BKG-REFUND.'])assert.equal(adapter.isCustomerRefundRequest(text),true,text);
 for(const text of ['What is your refund policy?','Can I get a refund?','I do not want a refund.','How much is the refund?','I want to know the refund policy for booking BKG-REFUND.','I want a refund if the service fails.','My friend said I want a refund.','I want a refund but do not create a request.','I want a refund for booking BKG-REFUND, but do not submit a request yet.','I want a refund, just asking, do not take action.','I want a refund for booking BKG-REFUND, but do not submit it yet.','I want a refund, but don’t record it.','"I want a refund" is an example.'])assert.equal(adapter.isCustomerRefundRequest(text),false,text);
});
test('created Finance review receipt is typed and distinct from approval, money, or cancellation',async t=>{
 const w=await world(t);const before=w.sqlite.prepare('SELECT * FROM canonical_bookings ORDER BY id').all();
 const result=await adapter.recordCustomerRefundRequest(w.db,w.input);
 const receipt=w.sqlite.prepare('SELECT * FROM unified_cases WHERE id=?').get(result.requestId);
 assert.equal(receipt.case_type,'refund');assert.equal(receipt.owner_team,'finance');assert.equal(receipt.status,'open');assert.equal(receipt.booking_id,'BKG-REFUND');assert.equal(receipt.customer_id,'CUS-REFUND');
 assert.equal(result.refundApproved,false);assert.equal(result.refundProcessed,false);assert.match(adapter.customerRefundRequestReply(result),/Finance review is pending/);
 assert.deepEqual(w.sqlite.prepare('SELECT * FROM canonical_bookings ORDER BY id').all(),before);
 assert.equal(w.sqlite.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name IN ('escalation_refund_requests','booking_refund_cases','payment_intents','finance_journal_entries')").get().n,0);
 assert.equal(w.sqlite.prepare("SELECT count(*) n FROM communication_messages WHERE direction='outbound'").get().n,0);
});
test('wrong customer, booking and thread ownership cannot create a refund review',async t=>{
 const w=await world(t);
 for(const changes of [{bookingId:'BKG-OTHER'},{customerId:'CUS-OTHER'},{threadId:'MISSING'}])await assert.rejects(()=>adapter.recordCustomerRefundRequest(w.db,{...w.input,...changes}),error=>error instanceof Response&&error.status===403);
 assert.equal(w.sqlite.prepare('SELECT count(*) n FROM unified_cases').get().n,0);
});
test('replay and repeated requests use one receipt; changed key binding is refused',async t=>{
 const w=await world(t);const first=await adapter.recordCustomerRefundRequest(w.db,w.input);
 const replay=await adapter.recordCustomerRefundRequest(w.db,w.input);assert.equal(replay.requestId,first.requestId);assert.equal(replay.duplicatePrevented,true);
 const another=await adapter.recordCustomerRefundRequest(w.db,{...w.input,idempotencyKey:'second-turn',reason:'Please check the incomplete service again.'});assert.equal(another.requestId,first.requestId);assert.equal(another.duplicatePrevented,true);
 await assert.rejects(()=>adapter.recordCustomerRefundRequest(w.db,{...w.input,reason:'A changed request using the same key.'}),error=>error instanceof Response&&error.status===409);
 assert.equal(w.sqlite.prepare('SELECT count(*) n FROM unified_cases').get().n,1);
 assert.equal(w.sqlite.prepare("SELECT count(*) n FROM unified_case_events WHERE event_type='customer_refund_requested'").get().n,2);
 w.sqlite.prepare("UPDATE unified_cases SET status='closed' WHERE id=?").run(first.requestId);
 const oldReplay=await adapter.recordCustomerRefundRequest(w.db,w.input);assert.equal(oldReplay.requestId,first.requestId);assert.match(adapter.customerRefundRequestReply(oldReplay),/already closed/);
 const newEpisode=await adapter.recordCustomerRefundRequest(w.db,{...w.input,idempotencyKey:'new-episode'});assert.notEqual(newEpisode.requestId,first.requestId);
});
test('simultaneous duplicate request turns produce one review episode',async t=>{
 const w=await world(t);const results=await Promise.all([adapter.recordCustomerRefundRequest(w.db,w.input),adapter.recordCustomerRefundRequest(w.db,{...w.input,idempotencyKey:'concurrent-other'})]);
 assert.equal(results[0].requestId,results[1].requestId);assert.equal(w.sqlite.prepare('SELECT count(*) n FROM unified_cases').get().n,1);
});
test('case-engine error cannot claim success; same request can retry successfully',async t=>{
 const w=await world(t);let fail=true;
 const failingDb={...w.db,prepare(sql){const stmt=w.db.prepare(sql);if(!/^INSERT INTO unified_cases /i.test(sql))return stmt;return{...stmt,bind(...args){const bound=stmt.bind(...args);return{...bound,async run(){if(fail){fail=false;throw new Error('Synthetic case engine failure');}return bound.run();}};}};}};
 await assert.rejects(()=>adapter.recordCustomerRefundRequest(failingDb,w.input),/Synthetic case engine failure/);
 assert.equal(w.sqlite.prepare('SELECT count(*) n FROM unified_cases').get().n,0);
 assert.doesNotMatch(adapter.CUSTOMER_REFUND_REQUEST_FAILURE,/request has been recorded|refund processed|Synthetic/);
 const result=await adapter.recordCustomerRefundRequest(w.db,w.input);assert.ok(result.requestId);assert.equal(result.refundProcessed,false);
});
for(const channel of ['chat','voice'])test(`${channel}: actual orchestrator persists request receipt and handoff without invoking a model`,async t=>{
 const w=await world(t,channel);globalThis.__PAWSPACE_TEST_ENV__={PAWSPACE_DEPLOYMENT_ENV:'staging'};await orchestrator.ensureAiConversationOrchestrator(w.db);
 await(await import('../lib/ai-audience-rollout.ts')).setAiRolloutStage(w.db,{stage:'customers',reason:'Synthetic refund intake test',actorEmail:staffActor.email});
 let calls=0;const provider={status:'connected',provider:'synthetic',modelRef:'no-inference',async generate(){calls++;throw new Error('Refund request must not invoke model');}};
 const input={actor:w.actor,threadId:'THREAD-REFUND',customerId:'CUS-REFUND',inputMessageId:w.messageId,idempotencyKey:`orchestrator-refund-${channel}`,channel,provider};
 const result=await orchestrator.orchestrateAiTurn(w.db,input);
 assert.equal(calls,0);assert.equal(result.turn.policyDecision,'refund_request_recorded');assert.equal(result.turn.outcome,'handoff');assert.match(result.turn.output,/recorded.*Finance review is pending/);
 const request=w.sqlite.prepare('SELECT * FROM unified_cases').get();assert.equal(request.customer_id,'CUS-REFUND');assert.equal(request.booking_id,'BKG-REFUND');assert.equal(request.owner_team,'finance');
 assert.equal(w.sqlite.prepare("SELECT status FROM ai_handoffs WHERE thread_id='THREAD-REFUND'").get().status,'queued');
 const replay=await orchestrator.orchestrateAiTurn(w.db,input);assert.equal(replay.duplicatePrevented,true);assert.equal(w.sqlite.prepare('SELECT count(*) n FROM unified_cases').get().n,1);
 assert.equal(w.sqlite.prepare("SELECT status FROM canonical_bookings WHERE id='BKG-REFUND'").get().status,'completed');
});

test('concurrent same key for different owned bookings rolls back the losing case',async t=>{
 const w=await world(t);w.sqlite.prepare("UPDATE canonical_bookings SET customer_id='CUS-REFUND' WHERE id='BKG-OTHER'").run();
 const results=await Promise.allSettled([adapter.recordCustomerRefundRequest(w.db,w.input),adapter.recordCustomerRefundRequest(w.db,{...w.input,bookingId:'BKG-OTHER'})]);
 assert.equal(results.filter(result=>result.status==='fulfilled').length,1);const rejected=results.find(result=>result.status==='rejected');assert.equal(rejected.reason.status,409);
 assert.equal(w.sqlite.prepare('SELECT count(*) n FROM unified_cases').get().n,1);
});

test('concurrent same key changed reason or channel is refused without a second case',async t=>{
 for(const change of [{reason:'A different refund reason.'},{channel:'voice'}]){
  const w=await world(t);const results=await Promise.allSettled([adapter.recordCustomerRefundRequest(w.db,w.input),adapter.recordCustomerRefundRequest(w.db,{...w.input,...change})]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal(results.find(result=>result.status==='rejected').reason.status,409);
  assert.equal(w.sqlite.prepare('SELECT count(*) n FROM unified_cases').get().n,1);
 }
});
test('native demo thread cannot create a refund review',async t=>{
 const w=await world(t);w.sqlite.prepare("UPDATE communication_threads SET id='THREAD-VOICE-NDEMO-REFUND' WHERE id='THREAD-REFUND'").run();
 await assert.rejects(()=>adapter.recordCustomerRefundRequest(w.db,{...w.input,threadId:'THREAD-VOICE-NDEMO-REFUND'}),error=>error instanceof Response&&error.status===403);
 assert.equal(w.sqlite.prepare('SELECT count(*) n FROM unified_cases').get().n,0);
});
test('actual custom voice adapter records a Finance review receipt without inference',async t=>{
 const w=await world(t,'voice');globalThis.__AI_DB__=w.db;globalThis.__PAWSPACE_TEST_ENV__={PAWSPACE_DEPLOYMENT_ENV:'staging'};
 await orchestrator.ensureAiConversationOrchestrator(w.db);await(await import('../lib/ai-audience-rollout.ts')).setAiRolloutStage(w.db,{stage:'customers',reason:'Synthetic voice refund adapter',actorEmail:staffActor.email});
 const oldFetch=globalThis.fetch;t.after(()=>globalThis.fetch=oldFetch);globalThis.fetch=async()=>{throw new Error('No network allowed for deterministic refund intake');};
 const {runElevenLabsGroundedTurn}=await import('../lib/elevenlabs-custom-llm.ts');
 const result=await runElevenLabsGroundedTurn(w.db,{model:'pawspace-service-sales',input:[{role:'user',content:'I want a refund for booking BKG-REFUND because the service was incomplete.'}],elevenlabs_extra_body:{pawspace_customer_id:'CUS-REFUND',pawspace_thread_id:'THREAD-REFUND'}});
 assert.match(result.output,/recorded.*Finance review is pending/);assert.equal(w.sqlite.prepare('SELECT count(*) n FROM unified_cases').get().n,1);
});

test('missing booking asks once and bounded owned booking follow-up records the request',async t=>{
 const w=await world(t);globalThis.__PAWSPACE_TEST_ENV__={PAWSPACE_DEPLOYMENT_ENV:'staging'};await orchestrator.ensureAiConversationOrchestrator(w.db);
 await(await import('../lib/ai-audience-rollout.ts')).setAiRolloutStage(w.db,{stage:'customers',reason:'Synthetic missing booking intake',actorEmail:staffActor.email});
 w.sqlite.prepare('UPDATE communication_messages SET payload_json=? WHERE id=?').run(JSON.stringify({text:'I want a refund because the service was incomplete.'}),w.messageId);
 const provider={status:'connected',provider:'synthetic',modelRef:'no-inference',async generate(){throw new Error('No model needed');}};
 const first=await orchestrator.orchestrateAiTurn(w.db,{actor:w.actor,threadId:'THREAD-REFUND',customerId:'CUS-REFUND',inputMessageId:w.messageId,idempotencyKey:'missing-booking',channel:'chat',provider});
 assert.equal(first.turn.policyDecision,'refund_request_booking_required');assert.equal(w.sqlite.prepare('SELECT count(*) n FROM unified_cases').get().n,0);
 const replyId=await inboundMessage(w.sqlite,w.db,{threadId:'THREAD-REFUND',customerId:'CUS-REFUND',text:'BKG-REFUND',channel:'chat',idempotencyKey:'booking-answer'});
 const second=await orchestrator.orchestrateAiTurn(w.db,{actor:w.actor,threadId:'THREAD-REFUND',customerId:'CUS-REFUND',inputMessageId:replyId,idempotencyKey:'refund-booking-answer',channel:'chat',provider});
 assert.equal(second.turn.policyDecision,'refund_request_recorded');assert.equal(w.sqlite.prepare('SELECT count(*) n FROM unified_cases').get().n,1);
 assert.match(w.sqlite.prepare('SELECT description FROM unified_cases').get().description,/service was incomplete/);
});

test('actual orchestrator engine error and foreign booking return truthful pending/failure dialogue',async t=>{
 for(const mode of ['engine_error','foreign_booking']){
  const w=await world(t);globalThis.__PAWSPACE_TEST_ENV__={PAWSPACE_DEPLOYMENT_ENV:'staging'};await orchestrator.ensureAiConversationOrchestrator(w.db);
  await(await import('../lib/ai-audience-rollout.ts')).setAiRolloutStage(w.db,{stage:'customers',reason:'Synthetic refund failure speech',actorEmail:staffActor.email});
  if(mode==='engine_error')w.sqlite.exec("CREATE TRIGGER reject_refund_intake BEFORE INSERT ON unified_cases BEGIN SELECT RAISE(ABORT,'Synthetic private engine error'); END");
  else w.sqlite.prepare('UPDATE communication_messages SET payload_json=? WHERE id=?').run(JSON.stringify({text:'I want a refund for booking BKG-OTHER.'}),w.messageId);
  const result=await orchestrator.orchestrateAiTurn(w.db,{actor:w.actor,threadId:'THREAD-REFUND',customerId:'CUS-REFUND',inputMessageId:w.messageId,idempotencyKey:`failure-${mode}`,channel:'chat',provider:{status:'connected',provider:'synthetic',modelRef:'no-inference',async generate(){throw new Error('No model needed');}}});
  assert.equal(result.turn.policyDecision,'refund_request_failed');assert.doesNotMatch(result.turn.output,/(?:^Your.*request has been recorded)|(?:Synthetic private engine error)|(?:refund has been processed)/);
  assert.equal(w.sqlite.prepare('SELECT count(*) n FROM unified_cases').get().n,0);assert.equal(w.sqlite.prepare("SELECT status FROM ai_handoffs WHERE thread_id='THREAD-REFUND'").get().status,'queued');
 }
});

test('standalone booking without refund intent and an intervening withdrawal cannot create intake',async t=>{
 for(const mode of ['no_intent','withdrawal']){
  const w=await world(t);globalThis.__PAWSPACE_TEST_ENV__={PAWSPACE_DEPLOYMENT_ENV:'staging'};await orchestrator.ensureAiConversationOrchestrator(w.db);
  await(await import('../lib/ai-audience-rollout.ts')).setAiRolloutStage(w.db,{stage:'customers',reason:'Synthetic refund followup safety',actorEmail:staffActor.email});
  const provider={status:'connected',provider:'synthetic',modelRef:'no-inference',async generate(){return{text:'Please clarify your request.',provider:'synthetic',modelRef:'no-inference',confidence:1,latencyMs:0};}};
  if(mode==='withdrawal'){
   w.sqlite.prepare('UPDATE communication_messages SET payload_json=? WHERE id=?').run(JSON.stringify({text:'I want a refund because the service was incomplete.'}),w.messageId);
   await orchestrator.orchestrateAiTurn(w.db,{actor:w.actor,threadId:'THREAD-REFUND',customerId:'CUS-REFUND',inputMessageId:w.messageId,idempotencyKey:'ask-refund-booking',channel:'chat',provider});
   // Withdrawal is canonical, even if its model turn has not yet completed.
   await inboundMessage(w.sqlite,w.db,{threadId:'THREAD-REFUND',customerId:'CUS-REFUND',text:'Do not record a refund request.',channel:'chat',idempotencyKey:'withdraw-refund'});
  }
  const replyId=await inboundMessage(w.sqlite,w.db,{threadId:'THREAD-REFUND',customerId:'CUS-REFUND',text:'BKG-REFUND',channel:'chat',idempotencyKey:'bare-booking'});
  const result=await orchestrator.orchestrateAiTurn(w.db,{actor:w.actor,threadId:'THREAD-REFUND',customerId:'CUS-REFUND',inputMessageId:replyId,idempotencyKey:`bare-${mode}`,channel:'chat',provider});
  assert.notEqual(result.turn.policyDecision,'refund_request_recorded');assert.equal(w.sqlite.prepare("SELECT count(*) n FROM unified_cases WHERE source_type='ai_customer_refund_request' OR case_type='refund'").get().n,0);
 }
});
test('actual authenticated chat adapter mirrors the recorded request into owned transcript',async t=>{
 const w=await world(t);globalThis.__AI_DB__=w.db;globalThis.__PAWSPACE_TEST_ENV__={PAWSPACE_DEPLOYMENT_ENV:'staging'};
 await orchestrator.ensureAiConversationOrchestrator(w.db);await(await import('../lib/ai-audience-rollout.ts')).setAiRolloutStage(w.db,{stage:'customers',reason:'Synthetic chat refund adapter',actorEmail:staffActor.email});
 const oldFetch=globalThis.fetch;t.after(()=>globalThis.fetch=oldFetch);globalThis.fetch=async()=>{throw new Error('No network allowed for deterministic refund intake');};
 const chat=await import('../lib/ai-web-chat-adapter.ts');
 const result=await chat.runAuthenticatedAiWebChat(w.db,{actor:w.actor,customerId:'CUS-REFUND',text:'I want a refund for booking BKG-REFUND because the service was incomplete.',idempotencyKey:'actual-chat-refund'});
 assert.match(result.ai.turn.output,/recorded.*Finance review is pending/);assert.equal(w.sqlite.prepare('SELECT count(*) n FROM unified_cases').get().n,1);
 const transcript=await chat.customerWebChatTranscript(w.db,{actor:w.actor,customerId:'CUS-REFUND',threadId:result.threadId});
 assert.ok(transcript.messages.some(message=>/Finance review is pending/.test(message.text)));
});
