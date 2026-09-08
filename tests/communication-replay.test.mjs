import test from 'node:test';import assert from 'node:assert/strict';
import {setupJourney,sessionCookie} from './helpers/grooming-journey-harness.mjs';import {d1} from './helpers/execution-harness.mjs';
const engine=await import('../lib/communication-engine.ts'),route=await import('../app/api/communications/route.ts'),{authorizeApiRequest}=await import('../lib/api-gateway.ts');
async function world(t){const ctx=await setupJourney();ctx.db.batch=d1(ctx.sqlite).batch;t.after(ctx.close);await engine.seedCommunicationPolicy(ctx.db);const message=await engine.enqueueCommunication(ctx.db,{customerId:'C-REPLAY',cityId:'blr',channel:'chat',purpose:'transactional',bookingId:'BK-REPLAY',idempotencyKey:'original-send-key',templateKey:'transactional',payload:{},createdBy:'fixture'});await engine.deadLetterOutbox(ctx.db,message.messageId,'unsupported_outbox_channel');const failure=ctx.sqlite.prepare('SELECT * FROM communication_dead_letters WHERE message_id=?').get(message.messageId);return{...ctx,messageId:message.messageId,failure};}
async function call(ctx,overrides={},cookie){const body={action:'replay_dead_letter',messageId:ctx.messageId,requestKey:'replay-request-001',failureCreatedAt:ctx.failure.created_at,reason:'Configured the sandbox chat adapter',...overrides};const request=new Request('https://uat.pawspace.in/api/communications',{method:'POST',headers:{origin:'https://uat.pawspace.in','content-type':'application/json',...(cookie?{cookie}:{'oai-authenticated-user-email':'closure-admin@pawspace.test'})},body:JSON.stringify(body)});const access=await authorizeApiRequest(request,{DB:ctx.db,...globalThis.__GROOM_GOLDEN_ENV__});return access instanceof Response?access:route.POST(request);}

test('admin recovery is atomic and idempotent, preserving the original send key and immutable before/after audit',async t=>{
 const ctx=await world(t);const results=await Promise.all([call(ctx),call(ctx)]);for(const r of results)assert.equal(r.status,200,await r.clone().text());
 assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM security_audit_events WHERE action='communication.replay'").get().n,1);
 const audit=ctx.sqlite.prepare("SELECT * FROM security_audit_events WHERE action='communication.replay'").get(),detail=JSON.parse(audit.detail_json);
 assert.equal(audit.actor_email,'closure-admin@pawspace.test');assert.equal(detail.before.outbox_status,'dead_letter');assert.equal(detail.after.outboxStatus,'queued');
 assert.equal(ctx.sqlite.prepare('SELECT idempotency_key,status FROM communication_messages WHERE id=?').get(ctx.messageId).idempotency_key,'original-send-key');
 assert.equal(ctx.sqlite.prepare('SELECT status,attempt_count FROM communication_outbox WHERE message_id=?').get(ctx.messageId).attempt_count,0);
 assert.ok(ctx.sqlite.prepare('SELECT resolved_at FROM communication_dead_letters WHERE message_id=?').get(ctx.messageId).resolved_at);
 const replay=await (await call(ctx)).json();assert.equal(replay.data.duplicatePrevented,true);
 assert.equal((await call(ctx,{reason:'Different reason with the same key'})).status,409);
 // A later failure must reappear with a new version; the earlier audit remains unchanged.
 await engine.deadLetterOutbox(ctx.db,ctx.messageId,'not_configured');
 const again=ctx.sqlite.prepare('SELECT * FROM communication_dead_letters WHERE message_id=?').get(ctx.messageId);
 assert.equal(again.resolved_at,null);assert.ok(again.created_at>ctx.failure.created_at);
 assert.equal((await call(ctx,{requestKey:'new-request-stale'})).status,409);
 assert.equal((await call(ctx,{requestKey:'new-request-valid',failureCreatedAt:again.created_at})).status,200);
 assert.equal(ctx.sqlite.prepare('SELECT detail_json FROM security_audit_events WHERE id=?').get(audit.id).detail_json,audit.detail_json);
});

test('customer, ambiguous provider failures, receipt-backed records and invalid recovery reasons cannot replay',async t=>{
 const ctx=await world(t),cookie=await sessionCookie(ctx.db,'customer','C-REPLAY','customer:C-REPLAY');
 assert.equal((await call(ctx,{},cookie)).status,403);
 assert.equal((await call(ctx,{reason:'short'})).status,400);
 ctx.sqlite.prepare("UPDATE communication_dead_letters SET reason='provider_timeout' WHERE message_id=?").run(ctx.messageId);
 assert.equal((await call(ctx)).status,409);
 ctx.sqlite.prepare("UPDATE communication_dead_letters SET reason='not_configured' WHERE message_id=?").run(ctx.messageId);
 ctx.sqlite.prepare("INSERT INTO communication_message_delivery_events (id,message_id,provider,event_id,event_type,detail_json,created_at) VALUES ('receipt',?,'limechat','receipt','accepted','{}',?)").run(ctx.messageId,Date.now());
 assert.equal((await call(ctx)).status,409);
 assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM security_audit_events WHERE action='communication.replay'").get().n,0);
});

test('a mid-batch database failure rolls back the audit, message and failure together',async t=>{
 const ctx=await world(t),original=ctx.db.prepare;
 ctx.db.prepare=sql=>{if(sql.startsWith('UPDATE communication_messages SET status=\'queued\''))return original('INSERT INTO missing_replay_failure_table VALUES (1)');return original(sql);};
 const response=await call(ctx);assert.equal(response.status,500);
 ctx.db.prepare=original;
 assert.equal(ctx.sqlite.prepare('SELECT status FROM communication_outbox WHERE message_id=?').get(ctx.messageId).status,'dead_letter');
 assert.equal(ctx.sqlite.prepare('SELECT resolved_at FROM communication_dead_letters WHERE message_id=?').get(ctx.messageId).resolved_at,null);
 assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM security_audit_events WHERE action='communication.replay'").get().n,0);
});

 test('two independent recovery requests cannot both reopen the same failure',async t=>{
 const ctx=await world(t),responses=await Promise.all([call(ctx,{requestKey:'independent-key-1'}),call(ctx,{requestKey:'independent-key-2'})]);
 assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
 assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM security_audit_events WHERE action='communication.replay'").get().n,1);
 const {runCommunicationOutboxDispatcher}=await import('../lib/communication-outbox-dispatcher.ts');
 const dispatched=await runCommunicationOutboxDispatcher(ctx.db,{});assert.equal(dispatched.accepted,0);assert.equal(dispatched.retried,1);
 assert.equal(ctx.sqlite.prepare('SELECT idempotency_key FROM communication_messages WHERE id=?').get(ctx.messageId).idempotency_key,'original-send-key');
 });
