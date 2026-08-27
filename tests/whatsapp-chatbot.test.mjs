import test from"node:test";
import assert from"node:assert/strict";
import{installAiHooks,freshAiDb,seedCustomer,staffActor,inboundMessage}from"./helpers/ai-harness.mjs";

installAiHooks();
const control=await import("../lib/whatsapp-conversation-control.ts");
const chatbot=await import("../lib/whatsapp-chatbot.ts");
const customer360=await import("../lib/customer-360.ts");

async function world(){
 const{sqlite,db}=freshAiDb();
 seedCustomer(sqlite,"CUS-BOT","Asha","9876500011");
 await control.ensureWhatsAppConversationControl(db);
 await chatbot.ensureWhatsAppChatbotTables(db);
 await customer360.ensureCustomer360Tables(db);
 sqlite.prepare("INSERT INTO customer_contact_preferences (customer_id,marketing_consent,service_consent,whatsapp_consent,sms_consent,email_consent,opt_out,source,updated_by,updated_at) VALUES (?,0,1,1,0,0,0,'uat','test',?)").run("CUS-BOT",Date.now());
 sqlite.prepare("INSERT INTO whatsapp_uat_sessions (customer_id,provider,last_inbound_at,last_outbound_at) VALUES (?,'sandbox_simulator',?,NULL)").run("CUS-BOT",Date.now());
 return{sqlite,db};
}

async function inbound(sqlite,db,id,text){return inboundMessage(sqlite,db,{threadId:"THREAD-BOT",customerId:"CUS-BOT",text,channel:"whatsapp",idempotencyKey:id});}

test("chatbot mode runs deterministic qualification and is idempotent",async()=>{
 const{sqlite,db}=await world();
 const firstId=await inbound(sqlite,db,"bot-in-1","1");
 await control.setWhatsAppConversationMode(db,{threadId:"THREAD-BOT",mode:"chatbot_only",actorEmail:staffActor.email,reason:"Enable certified deterministic chatbot"});
 const first=await chatbot.runWhatsAppChatbotTurn(db,{threadId:"THREAD-BOT",inputMessageId:firstId,actorEmail:"whatsapp-chatbot"});
 assert.equal(first.routingMode,"chatbot_only");
 assert.equal(first.session.state,"city");
 assert.equal(first.session.service_code,"grooming");
 assert.equal(first.externalDelivery,false);
 const replay=await chatbot.runWhatsAppChatbotTurn(db,{threadId:"THREAD-BOT",inputMessageId:firstId,actorEmail:"whatsapp-chatbot"});
 assert.equal(replay.duplicatePrevented,true);
 assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM whatsapp_chatbot_turns WHERE input_message_id=?").get(firstId).n,1);
 const cityId=await inbound(sqlite,db,"bot-in-2","Indiranagar Bengaluru");
 const city=await chatbot.runWhatsAppChatbotTurn(db,{threadId:"THREAD-BOT",inputMessageId:cityId,actorEmail:"whatsapp-chatbot"});
 assert.equal(city.session.state,"pet");
 assert.equal(city.session.city,"Indiranagar Bengaluru");
 const petId=await inbound(sqlite,db,"bot-in-3","Dog");
 const pet=await chatbot.runWhatsAppChatbotTurn(db,{threadId:"THREAD-BOT",inputMessageId:petId,actorEmail:"whatsapp-chatbot"});
 assert.equal(pet.session.state,"qualified");
 assert.equal(pet.session.pet_type,"dog");
 assert.equal(pet.session.status,"qualified");
 const outbound=sqlite.prepare("SELECT COUNT(*) n FROM communication_messages WHERE idempotency_key LIKE 'whatsapp-chatbot:%'").get().n;
 assert.equal(outbound,3);
});

test("negated service mentions do not select a service",async()=>{
 const{sqlite,db}=await world();
 const inputId=await inbound(sqlite,db,"bot-negated-service","not grooming");
 await control.setWhatsAppConversationMode(db,{threadId:"THREAD-BOT",mode:"chatbot_only",actorEmail:staffActor.email,reason:"Enable chatbot for negation regression"});
 const result=await chatbot.runWhatsAppChatbotTurn(db,{threadId:"THREAD-BOT",inputMessageId:inputId,actorEmail:"whatsapp-chatbot"});
 assert.equal(result.session.state,"service");
 assert.equal(result.session.service_code,null);
 assert.equal(result.turn.intent,"service_prompt");
});

test("customer human request immediately hands off and disables chatbot",async()=>{
 const{sqlite,db}=await world();
 const inputId=await inbound(sqlite,db,"bot-human-1","I want to speak to a human");
 await control.setWhatsAppConversationMode(db,{threadId:"THREAD-BOT",mode:"chatbot_only",actorEmail:staffActor.email,reason:"Enable chatbot for escalation test"});
 const result=await chatbot.runWhatsAppChatbotTurn(db,{threadId:"THREAD-BOT",inputMessageId:inputId,actorEmail:"whatsapp-chatbot"});
 assert.equal(result.turn.action,"human_handoff");
 assert.equal(result.turn.reason,"customer_requested_human");
 assert.equal(result.routingMode,"human_only");
 assert.equal((await control.getWhatsAppConversationMode(db,"THREAD-BOT")).mode,"human_only");
 const handoff=sqlite.prepare("SELECT reason,status,queue_code FROM ai_handoffs WHERE thread_id=?").get("THREAD-BOT");
 assert.equal(handoff.reason,"customer_requested_human");
 assert.equal(handoff.status,"queued");
 assert.equal(handoff.queue_code,"cx-ai-handoff");
});

test("refund and safety language never stays in deterministic bot",async()=>{
 for(const [message,reason] of [["I need a refund for this payment","refund_payment_dispute"],["My dog is bleeding, medical emergency","safety"]]){
  const{sqlite,db}=await world();
  const inputId=await inbound(sqlite,db,`bot-risk-${reason}`,message);
  await control.setWhatsAppConversationMode(db,{threadId:"THREAD-BOT",mode:"chatbot_only",actorEmail:staffActor.email,reason:"Enable chatbot for mandatory handoff"});
  const result=await chatbot.runWhatsAppChatbotTurn(db,{threadId:"THREAD-BOT",inputMessageId:inputId,actorEmail:"whatsapp-chatbot"});
  assert.equal(result.turn.reason,reason);
  assert.equal(result.routingMode,"human_only");
 }
});

test("chatbot fails closed to human handoff when outbound policy blocks",async()=>{
 const{sqlite,db}=await world();
 sqlite.prepare("UPDATE customer_contact_preferences SET whatsapp_consent=0 WHERE customer_id='CUS-BOT'").run();
 const inputId=await inbound(sqlite,db,"bot-policy-1","1");
 await control.setWhatsAppConversationMode(db,{threadId:"THREAD-BOT",mode:"chatbot_only",actorEmail:staffActor.email,reason:"Enable chatbot for outbound policy test"});
 const result=await chatbot.runWhatsAppChatbotTurn(db,{threadId:"THREAD-BOT",inputMessageId:inputId,actorEmail:"whatsapp-chatbot"});
 assert.equal(result.turn.action,"human_handoff");
 assert.equal(result.turn.reason,"whatsapp_consent_required");
 assert.equal(result.routingMode,"human_only");
 assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM communication_messages WHERE idempotency_key LIKE 'whatsapp-chatbot:%'").get().n,0);
});
