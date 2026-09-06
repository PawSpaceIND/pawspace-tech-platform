import test from"node:test";
import assert from"node:assert/strict";
import{installAiHooks,freshAiDb,seedCustomer,staffActor,inboundMessage}from"./helpers/ai-harness.mjs";

installAiHooks();
const control=await import("../lib/whatsapp-conversation-control.ts");
const customer360=await import("../lib/customer-360.ts");

async function world(){
 const{sqlite,db}=freshAiDb();
 seedCustomer(sqlite,"CUS-1","Asha","9876500001");
 await control.ensureWhatsAppConversationControl(db);
 await customer360.ensureCustomer360Tables(db);
 const messageId=await inboundMessage(sqlite,db,{threadId:"THREAD-WA-1",customerId:"CUS-1",text:"Hello PawSpace",channel:"whatsapp",idempotencyKey:"wa-control-inbound"});
 return{sqlite,db,messageId};
}

test("WhatsApp routing is fail-closed to human only and AI requires explicit mode",async()=>{
 const{sqlite,db}=await world();
 const initial=await control.getWhatsAppConversationMode(db,"THREAD-WA-1");
 assert.equal(initial.mode,"human_only");
 assert.equal(initial.explicit,false);
 await assert.rejects(control.assertWhatsAppAiRoutingAllowsReply(db,"THREAD-WA-1"),error=>error instanceof Response&&error.status===409);
 await assert.rejects(control.setWhatsAppConversationMode(db,{threadId:"THREAD-WA-1",mode:"ai_assistant",actorEmail:staffActor.email,reason:"short"}),error=>error instanceof Response&&error.status===400);
 const changed=await control.openAiModeForWhatsAppConversation(db,{actor:staffActor,threadId:"THREAD-WA-1",reason:"Enable AI for certified UAT conversation"});
 assert.equal(changed.routing.mode,"ai_assistant");
 await assert.doesNotReject(control.assertWhatsAppAiRoutingAllowsReply(db,"THREAD-WA-1"));
 const events=sqlite.prepare("SELECT from_mode,to_mode,actor_email FROM whatsapp_conversation_routing_events WHERE thread_id=?").all("THREAD-WA-1");
 assert.equal(events.length,1);
 assert.equal(events[0].from_mode,"human_only");
 assert.equal(events[0].to_mode,"ai_assistant");
 assert.equal(events[0].actor_email,staffActor.email);
});

test("human reply is governed by routing, consent, 24-hour window and idempotency",async()=>{
 const{sqlite,db}=await world();
 sqlite.prepare("INSERT INTO customer_contact_preferences (customer_id,marketing_consent,service_consent,whatsapp_consent,sms_consent,email_consent,opt_out,source,updated_by,updated_at) VALUES (?,0,1,1,0,0,0,'uat','test',?)").run("CUS-1",Date.now());
 sqlite.prepare("INSERT INTO whatsapp_uat_sessions (customer_id,provider,last_inbound_at,last_outbound_at) VALUES (?,'sandbox_simulator',?,NULL)").run("CUS-1",Date.now());
 const first=await control.queueWhatsAppHumanReply(db,{actor:staffActor,threadId:"THREAD-WA-1",message:"Hi Asha, how can we help?",clientRequestId:"reply-0001"});
 assert.equal(first.queued,true);
 assert.equal(first.duplicatePrevented,false);
 assert.equal(first.environment,"uat");
 assert.equal(first.productionDelivery,false);
 const replay=await control.queueWhatsAppHumanReply(db,{actor:staffActor,threadId:"THREAD-WA-1",message:"Hi Asha, how can we help?",clientRequestId:"reply-0001"});
 assert.equal(replay.duplicatePrevented,true);
 assert.equal(replay.messageId,first.messageId);
 const count=sqlite.prepare("SELECT COUNT(*) n FROM communication_messages WHERE idempotency_key LIKE 'whatsapp-human-reply:%'").get().n;
 assert.equal(count,1);
 await control.openAiModeForWhatsAppConversation(db,{actor:staffActor,threadId:"THREAD-WA-1",reason:"Enable AI after operator reply test"});
 await assert.rejects(control.queueWhatsAppHumanReply(db,{actor:staffActor,threadId:"THREAD-WA-1",message:"This must not bypass AI ownership",clientRequestId:"reply-0002"}),error=>error instanceof Response&&error.status===409);
});

test("operator takeover pauses AI and explicit governed resume reopens AI mode",async()=>{
 const{sqlite,db}=await world();
 await control.openAiModeForWhatsAppConversation(db,{actor:staffActor,threadId:"THREAD-WA-1",reason:"Enable AI for takeover cycle test"});
 const takeover=await control.takeOverWhatsAppConversation(db,{actor:staffActor,threadId:"THREAD-WA-1",reason:"Operator taking ownership for customer request"});
 assert.equal(takeover.routing.mode,"human_only");
 assert.equal(takeover.aiPaused,true);
 assert.equal(takeover.handoff.current.status,"staff_active");
 assert.equal(sqlite.prepare("SELECT assigned_to FROM communication_threads WHERE id=?").get("THREAD-WA-1").assigned_to,staffActor.email);
 await assert.rejects(control.openAiModeForWhatsAppConversation(db,{actor:staffActor,threadId:"THREAD-WA-1",reason:"Attempt bypass while human owns it"}),error=>error instanceof Response&&error.status===409);
 await assert.rejects(control.resumeAiForWhatsAppConversation(db,{actor:staffActor,threadId:"THREAD-WA-1",reason:"tiny"}),error=>error instanceof Response&&error.status===400);
 const resumed=await control.resumeAiForWhatsAppConversation(db,{actor:staffActor,threadId:"THREAD-WA-1",reason:"Customer request resolved; resume certified AI"});
 assert.equal(resumed.routing.mode,"ai_assistant");
 assert.equal(resumed.aiPaused,false);
 assert.equal(resumed.handoff.current.status,"resumed");
 assert.equal(sqlite.prepare("SELECT assigned_to FROM communication_threads WHERE id=?").get("THREAD-WA-1").assigned_to,"ai-orchestrator");
});
