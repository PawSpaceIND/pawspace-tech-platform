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

const payloadOf=(sqlite,messageId)=>JSON.parse(sqlite.prepare("SELECT payload_json FROM communication_messages WHERE id=?").get(messageId).payload_json);

test("WhatsApp runs the same guided flows as web chat, with reply buttons and lists, and is idempotent",async()=>{
 const{sqlite,db}=await world();
 let seq=0;const say=async text=>{const id=await inbound(sqlite,db,`bot-in-${++seq}`,text);return{id,result:await chatbot.runWhatsAppChatbotTurn(db,{threadId:"THREAD-BOT",inputMessageId:id,actorEmail:"whatsapp-chatbot"})};};
 const firstId=await inbound(sqlite,db,"bot-in-0","hi");
 await control.setWhatsAppConversationMode(db,{threadId:"THREAD-BOT",mode:"chatbot_only",actorEmail:staffActor.email,reason:"Enable certified deterministic chatbot"});
 const menu=await chatbot.runWhatsAppChatbotTurn(db,{threadId:"THREAD-BOT",inputMessageId:firstId,actorEmail:"whatsapp-chatbot"});
 assert.equal(menu.routingMode,"chatbot_only");
 assert.equal(menu.externalDelivery,false);
 const menuPayload=payloadOf(sqlite,menu.turn.output_message_id);
 assert.equal(menuPayload.interactive.kind,"list","the service menu is a WhatsApp list");
 assert.ok(menuPayload.interactive.sections[0].rows.some(row=>row.title==="Pet Relocation"));
 const replay=await chatbot.runWhatsAppChatbotTurn(db,{threadId:"THREAD-BOT",inputMessageId:firstId,actorEmail:"whatsapp-chatbot"});
 assert.equal(replay.duplicatePrevented,true);
 assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM whatsapp_chatbot_turns WHERE input_message_id=?").get(firstId).n,1);

 // The customer taps "Grooming" in the list: WhatsApp sends the row title back as the message text.
 const service=(await say("Grooming")).result;
 assert.equal(service.session.service_code,"grooming");
 // The WATI grooming flow: subscription first, then pet, count, breed (a list) and package.
 assert.deepEqual(payloadOf(sqlite,service.turn.output_message_id).interactive.buttons.map(button=>button.title),["Yes","No","Start over"]);
 const petButtons=payloadOf(sqlite,(await say("No")).result.turn.output_message_id).interactive;
 assert.equal(petButtons.kind,"reply_buttons");
 assert.deepEqual(petButtons.buttons.map(button=>button.title),["Dog","Cat","Start over"]);
 await say("Dog");
 const breeds=payloadOf(sqlite,(await say("1")).result.turn.output_message_id).interactive;
 assert.equal(breeds.kind,"list");
 assert.equal(breeds.sections[0].rows.length,10,"WhatsApp lists hold ten rows: nine breeds and Show more breeds");
 await say("Labrador");await say("Bath & Basic");
 const invalidDate=(await say("next week")).result;
 assert.equal(invalidDate.session.state,"collecting","an invalid date is asked again");
 await say("28/09");await say("11am-1pm");
 const confirm=payloadOf(sqlite,(await say("Indiranagar Bengaluru")).result.turn.output_message_id);
 assert.match(confirm.text,/Please confirm the following details[\s\S]*Package: Bath & Basic/);
 const done=(await say("OK")).result;
 assert.equal(done.session.state,"qualified");
 assert.equal(done.session.status,"qualified");
 assert.equal(done.session.pet_type,"dog");
 assert.equal(done.session.city,"Indiranagar Bengaluru");
 assert.equal(done.routingMode,"human_only","a finished enquiry goes to the sales team");
 const handoff=sqlite.prepare("SELECT reason,queue_code FROM ai_handoffs WHERE thread_id=?").get("THREAD-BOT");
 assert.deepEqual({...handoff},{reason:"bot_lead_qualified",queue_code:"sales-web-chat"});
});

test("a free question in the bot goes to the AI instead of selecting a service",async()=>{
 const{sqlite,db}=await world();
 const inputId=await inbound(sqlite,db,"bot-negated-service","not grooming, how is boarding priced?");
 await control.setWhatsAppConversationMode(db,{threadId:"THREAD-BOT",mode:"chatbot_only",actorEmail:staffActor.email,reason:"Enable chatbot for question routing"});
 const result=await chatbot.runWhatsAppChatbotTurn(db,{threadId:"THREAD-BOT",inputMessageId:inputId,actorEmail:"whatsapp-chatbot"});
 assert.equal(result.aiRequested,true);
 assert.equal(result.turn.action,"ai_answer");
 assert.equal(result.routingMode,"chatbot_only");
 assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM communication_messages WHERE idempotency_key LIKE 'whatsapp-chatbot:%'").get().n,0,"the bot must not also send its own reply over the AI's answer");
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

test("bot buttons and lists reach Meta as interactive messages inside the service window only",async()=>{
 const dispatch=await import("../lib/meta-whatsapp-uat-dispatch.ts");
 const buttons=chatbot.whatsAppChoicesContract({text:"Please select the travel type",choices:[{id:"domestic",label:"Domestic"},{id:"international",label:"International"}],inputHint:null});
 const sent=dispatch.buildMetaWhatsAppRequest({recipient:"+91 98765 00011",messageText:"Please select the travel type",withinSession:true,interactive:buttons});
 assert.equal(sent.type,"interactive");
 assert.equal(sent.interactive.type,"button");
 assert.deepEqual(sent.interactive.action.buttons.map(button=>button.reply.title),["Domestic","International"]);
 const list=chatbot.whatsAppChoicesContract({text:"Please select the stay you need",choices:[{id:"standard",label:"Standard Stay (up to 4 hours)"},{id:"premium",label:"Premium Stay (up to 10 hours)"},{id:"luxury",label:"Luxury Stay (overnight)"}],inputHint:null});
 const listed=dispatch.buildMetaWhatsAppRequest({recipient:"919876500011",messageText:"Please select the stay you need",withinSession:true,interactive:list});
 assert.equal(listed.interactive.type,"list","labels longer than a button title become a list");
 assert.ok(listed.interactive.action.sections[0].rows.every(row=>row.title.length<=24));
 const outside=dispatch.buildMetaWhatsAppRequest({recipient:"919876500011",templateKey:"lead_first_response",withinSession:false,interactive:buttons});
 assert.equal(outside.type,"template","outside the 24-hour window only an approved template may be sent");
});

test("every WATI button and list row fits WhatsApp's limits",async()=>{
 const bot=await import("../lib/web-chat-bot.ts");
 for(const flow of bot.WEB_CHAT_FLOWS)for(const step of flow.steps){
  const labels=(step.choices||[]).map(choice=>choice.label);
  assert.ok(labels.length<=10,`${flow.code}.${step.key} has ${labels.length} options; a WhatsApp list holds ten`);
  for(const label of labels)assert.ok(label.length<=24,`${flow.code}.${step.key}: "${label}" is longer than a WhatsApp list row title`);
  if(labels.length<=2)for(const label of labels)assert.ok(label.length<=20,`${flow.code}.${step.key}: "${label}" is longer than a WhatsApp button title`);
 }
});

test("a WhatsApp customer who stops mid-flow is reminded at 10 minutes, PawSpace AI takes over at 20, then a person",async()=>{
 const{sqlite,db}=await world();
 const first=await inbound(sqlite,db,"stall-0","hi");
 await control.setWhatsAppConversationMode(db,{threadId:"THREAD-BOT",mode:"chatbot_only",actorEmail:staffActor.email,reason:"Enable certified deterministic chatbot"});
 await chatbot.runWhatsAppChatbotTurn(db,{threadId:"THREAD-BOT",inputMessageId:first,actorEmail:"whatsapp-chatbot"});
 const pick=await inbound(sqlite,db,"stall-1","Grooming");
 await chatbot.runWhatsAppChatbotTurn(db,{threadId:"THREAD-BOT",inputMessageId:pick,actorEmail:"whatsapp-chatbot"});
 const now=Date.now(),min=60_000,sweep=asOf=>chatbot.runWhatsAppChatbotFollowUpSweep(db,{asOf});
 assert.equal((await sweep(now+5*min)).nudged,0,"not yet stalled");
 assert.equal((await sweep(now+11*min)).nudged,1,"first reminder at 10 minutes");
 assert.equal((await sweep(now+22*min)).takenOver,1,"PawSpace AI takes over at 20 minutes");
 const sent=sqlite.prepare("SELECT payload_json FROM communication_messages WHERE direction='outbound' AND (idempotency_key LIKE '%whatsapp-chatbot-remind:%' OR idempotency_key LIKE '%whatsapp-chatbot-takeover:%') ORDER BY created_at").all().map(row=>JSON.parse(row.payload_json));
 assert.equal(sent.length,2);assert.match(sent[0].text,/^Still there\?/);assert.match(sent[1].text,/^PawSpace AI here\./);
 assert.ok(sent[1].interactive,"the question's buttons are sent again");
 const offScript=await inbound(sqlite,db,"stall-2","which is best for a shih tzu?");
 const answered=await chatbot.runWhatsAppChatbotTurn(db,{threadId:"THREAD-BOT",inputMessageId:offScript,actorEmail:"whatsapp-chatbot"});
 assert.equal(answered.aiRequested,true,"after the takeover an answer that is not an option goes to the AI");
 await control.setWhatsAppConversationMode(db,{threadId:"THREAD-BOT",mode:"human_only",actorEmail:staffActor.email,reason:"Team took over"});
 assert.equal((await sweep(now+4*60*min)).escalated,0,"a conversation a person owns is never followed up by the bot");
});
