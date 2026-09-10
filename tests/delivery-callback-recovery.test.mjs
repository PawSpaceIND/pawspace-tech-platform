import test from 'node:test';
import assert from 'node:assert/strict';
import { installAiHooks, freshAiDb } from './helpers/ai-harness.mjs';
import { makeD1 } from './helpers/taxi-harness.mjs';
installAiHooks();
const { ensureCommunicationTables, recordDeliveryEvent }=await import('../lib/communication-engine.ts');
async function world(t,max=5){
 const {sqlite}=freshAiDb();t.after(()=>sqlite.close());const db=makeD1(sqlite);globalThis.__AI_DB__=db;
 await ensureCommunicationTables(db);const now=Date.now();
 sqlite.prepare("INSERT INTO communication_threads (id,customer_id,status,created_at,updated_at) VALUES ('TH-DELIVERY','CUS-DELIVERY','open',?,?)").run(now,now);
 sqlite.prepare("INSERT INTO communication_messages (id,thread_id,customer_id,direction,channel,purpose,template_key,payload_json,status,provider,idempotency_key,policy_json,created_by,created_at,updated_at) VALUES ('MSG-DELIVERY','TH-DELIVERY','CUS-DELIVERY','outbound','whatsapp','transactional','test','{}','sent','meta_whatsapp','delivery-repro','{}','test',?,?)").run(now,now);
 sqlite.prepare("INSERT INTO communication_outbox (message_id,status,next_attempt_at,attempt_count,max_attempts,updated_at) VALUES ('MSG-DELIVERY','sent',?,1,?,?)").run(now,max,now);
 return {sqlite,db};
}
const callback=(eventType,eventId='delivery-event-1')=>({messageId:'MSG-DELIVERY',provider:'meta_whatsapp',eventId,eventType});
for(const [kind,max,expected] of [['read',5,'read'],['delivered',5,'delivered'],['failed',5,'retry_pending'],['failed',2,'dead_letter']]){
 for(const fault of ['UPDATE communication_messages SET status=','UPDATE communication_outbox SET status=','INSERT INTO communication_message_delivery_events']){
  test(`${kind}/${expected}: interrupted ${fault} rolls back and retry completes once`,async t=>{
   const{sqlite,db}=await world(t,max),event=callback(kind);
   db.onSql(fault,()=>{throw new Error('callback projection unavailable');});
   await assert.rejects(recordDeliveryEvent(db,event),/callback projection unavailable/);
   assert.equal(sqlite.prepare("SELECT status FROM communication_messages WHERE id='MSG-DELIVERY'").get().status,'sent');
   assert.equal(sqlite.prepare("SELECT status FROM communication_outbox WHERE message_id='MSG-DELIVERY'").get().status,'sent');
   assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM communication_message_delivery_events').get().n,0);
   assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM communication_dead_letters').get().n,0);
   await recordDeliveryEvent(db,event);
   assert.equal(sqlite.prepare("SELECT status FROM communication_messages WHERE id='MSG-DELIVERY'").get().status,expected);
   assert.equal(sqlite.prepare("SELECT status FROM communication_outbox WHERE message_id='MSG-DELIVERY'").get().status,expected);
   assert.equal((await recordDeliveryEvent(db,event)).duplicatePrevented,true);
   assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM communication_message_delivery_events').get().n,1);
   assert.equal(sqlite.prepare('SELECT attempt_count FROM communication_outbox').get().attempt_count,kind==='failed'?2:1);
   const{getConversation}=await import('../lib/conversation-governance.ts');
   assert.equal((await getConversation(db,'TH-DELIVERY','staff')).messages[0].status,expected);
  });
 }
}
test('delivered advances to read in both views and late success/failure cannot regress it',async t=>{
 const{sqlite,db}=await world(t);
 await recordDeliveryEvent(db,callback('delivered','evt-delivered'));
 await recordDeliveryEvent(db,callback('read','evt-read'));
 for(const state of ['sent','accepted','failed','delivered'])await recordDeliveryEvent(db,callback(state,`late-${state}`));
 assert.equal(sqlite.prepare('SELECT status FROM communication_messages').get().status,'read');
 assert.equal(sqlite.prepare('SELECT status FROM communication_outbox').get().status,'read');
 assert.equal(sqlite.prepare('SELECT attempt_count FROM communication_outbox').get().attempt_count,1);
 await assert.rejects(recordDeliveryEvent(db,callback('sent','evt-read')),error=>error instanceof Response&&error.status===409);
});
test('competing copies of a failure callback increment retry attempts only once',async t=>{
 const{sqlite,db}=await world(t),event=callback('failed');
 const attempts=await Promise.allSettled([recordDeliveryEvent(db,event),recordDeliveryEvent(db,event)]);
 assert.ok(attempts.some(result=>result.status==='fulfilled'));
 await recordDeliveryEvent(db,event);
 assert.equal(sqlite.prepare('SELECT attempt_count FROM communication_outbox').get().attempt_count,2);
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM communication_message_delivery_events').get().n,1);
});

test('legacy read callback already saved before a failed projection repairs both views on replay',async t=>{
 const{sqlite,db}=await world(t);
 sqlite.prepare("INSERT INTO communication_message_delivery_events (id,message_id,provider,event_id,event_type,detail_json,created_at) VALUES ('LEGACY','MSG-DELIVERY','meta_whatsapp','legacy-read','read','{}',?)").run(Date.now());
 const result=await recordDeliveryEvent(db,callback('read','legacy-read'));
 assert.equal(result.duplicatePrevented,true);
 assert.equal(sqlite.prepare('SELECT status FROM communication_messages').get().status,'read');
 assert.equal(sqlite.prepare('SELECT status FROM communication_outbox').get().status,'read');
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM communication_message_delivery_events').get().n,1);
});

test('signed read webhook retries an interrupted transaction and reaches the CRM transcript',async t=>{
 const{sqlite,db}=await world(t),secret='delivery-callback-test-secret';
 globalThis.__PAWSPACE_TEST_ENV__={PAWSPACE_COMMUNICATION_ENV:'uat',PAWSPACE_COMMUNICATION_WEBHOOK_SECRET:secret};
 sqlite.prepare("UPDATE communication_messages SET provider_reference='ref-delivery' WHERE id='MSG-DELIVERY'").run();
 const{POST}=await import('../app/api/communication-provider-callback/route.ts');
 const{signCommunicationProviderCallback}=await import('../lib/communication-provider-boundary.ts');
 const raw=JSON.stringify({event_id:'signed-read',provider_reference:'ref-delivery',status:'read'}),timestamp=Date.now();
 const signature=await signCommunicationProviderCallback(secret,timestamp,raw);
 const request=sign=>new Request('https://pawspace.test/api/communication-provider-callback?provider=meta_whatsapp',{method:'POST',headers:{'content-type':'application/json','x-pawspace-communication-timestamp':String(timestamp),'x-pawspace-communication-signature':sign},body:raw});
 assert.equal((await POST(request('invalid'))).status,401);
 db.onSql('UPDATE communication_outbox SET status=',()=>{throw new Error('outbox status temporarily unavailable');});
 const interrupted=await POST(request(signature));
 assert.equal(interrupted.status,503,await interrupted.text());
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM communication_message_delivery_events').get().n,0);
 assert.equal(sqlite.prepare('SELECT status FROM communication_messages').get().status,'sent');
 sqlite.prepare('UPDATE gateway_inbound_queue SET next_attempt_at=0').run();
 const replay=await POST(request(signature));assert.equal(replay.status,200,await replay.text());
 assert.equal((await POST(request(signature))).status,200);
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM communication_message_delivery_events').get().n,1);
 assert.equal(sqlite.prepare('SELECT status FROM communication_outbox').get().status,'read');
 const{ensureSecurityTables}=await import('../lib/server-auth.ts');await ensureSecurityTables(db);
 sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('DELIVERY-ADMIN','delivery-admin@pawspace.test','Audit operator','admin','active',?,?)").run(timestamp,timestamp);
 const{GET}=await import('../app/api/crm/chat/route.ts');
 const response=await GET(new Request('https://pawspace.test/api/crm/chat?threadId=TH-DELIVERY',{headers:{'oai-authenticated-user-email':'delivery-admin@pawspace.test'}}));
 assert.equal(response.status,200);assert.equal((await response.json()).data.messages[0].status,'read');
});
