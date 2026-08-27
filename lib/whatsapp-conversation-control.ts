import{aiHumanHandoffSnapshot,manageAiHumanHandoff,requestAiHumanHandoff}from"./ai-human-handoff";
import{ensureConversationGovernance}from"./conversation-governance";
import{ensureWhatsAppUatTables,queueWhatsAppUatOutbound,whatsappUatProviders,type WhatsAppUatProvider}from"./whatsapp-uat-adapter";
import type{AuthenticatedActor}from"./server-auth";

type Row=Record<string,unknown>;
export const whatsappConversationModes=["human_only","chatbot_only","ai_assistant"]as const;
export type WhatsAppConversationMode=(typeof whatsappConversationModes)[number];

const text=(value:unknown)=>String(value??"").trim();
const handoffStatus=(value:unknown)=>text((value as Row|null|undefined)?.status);
const uid=(prefix:string)=>`${prefix}-${crypto.randomUUID().slice(0,12).toUpperCase()}`;

export async function ensureWhatsAppConversationControl(db:D1Database){
 await ensureConversationGovernance(db);await ensureWhatsAppUatTables(db);
 await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS whatsapp_conversation_routing_modes (thread_id TEXT PRIMARY KEY,mode TEXT NOT NULL,updated_by TEXT NOT NULL,reason TEXT NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS whatsapp_conversation_routing_events (id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,from_mode TEXT NOT NULL,to_mode TEXT NOT NULL,actor_email TEXT NOT NULL,reason TEXT NOT NULL,created_at INTEGER NOT NULL)"),
  db.prepare("CREATE INDEX IF NOT EXISTS whatsapp_conversation_routing_event_idx ON whatsapp_conversation_routing_events(thread_id,created_at)"),
 ]);
}

async function threadContext(db:D1Database,threadId:string){
 await ensureWhatsAppConversationControl(db);
 const thread=await db.prepare("SELECT id,customer_id,status,assigned_to,sla_due_at FROM communication_threads WHERE id=?").bind(threadId).first<Row>();
 if(!thread)throw new Response("Conversation not found",{status:404});
 if(text(thread.status)==="closed")throw new Response("Closed conversation cannot be controlled",{status:409});
 const message=await db.prepare("SELECT id,provider,direction,created_at FROM communication_messages WHERE thread_id=? AND channel='whatsapp' ORDER BY created_at DESC LIMIT 1").bind(threadId).first<Row>();
 if(!message)throw new Response("Conversation is not a WhatsApp thread",{status:409});
 const providerValue=text(message.provider);
 const provider=whatsappUatProviders.includes(providerValue as WhatsAppUatProvider)?providerValue as WhatsAppUatProvider:"sandbox_simulator";
 return{thread,customerId:text(thread.customer_id),provider,lastWhatsAppMessage:message};
}

export async function getWhatsAppConversationMode(db:D1Database,threadId:string){
 await ensureWhatsAppConversationControl(db);
 const row=await db.prepare("SELECT mode,updated_by,reason,updated_at FROM whatsapp_conversation_routing_modes WHERE thread_id=?").bind(threadId).first<Row>();
 const mode=whatsappConversationModes.includes(text(row?.mode)as WhatsAppConversationMode)?text(row?.mode)as WhatsAppConversationMode:"human_only";
 return{mode,explicit:Boolean(row),updatedBy:row?text(row.updated_by):null,reason:row?text(row.reason):"fail_closed_default",updatedAt:row?Number(row.updated_at||0):null};
}

export async function setWhatsAppConversationMode(db:D1Database,input:{threadId:string;mode:WhatsAppConversationMode;actorEmail:string;reason:string}){
 await threadContext(db,input.threadId);
 if(!whatsappConversationModes.includes(input.mode))throw new Response("Unsupported WhatsApp conversation mode",{status:400});
 const reason=text(input.reason);if(reason.length<8)throw new Response("A routing-change reason of at least 8 characters is required",{status:400});
 const before=await getWhatsAppConversationMode(db,input.threadId),now=Date.now();
 let changed=0;
 if(before.explicit){
  const result=await db.prepare("UPDATE whatsapp_conversation_routing_modes SET mode=?,updated_by=?,reason=?,updated_at=? WHERE thread_id=? AND mode=? AND updated_at=?").bind(input.mode,input.actorEmail,reason,now,input.threadId,before.mode,before.updatedAt).run();
  changed=Number(result.meta?.changes||0);
 }else{
  const result=await db.prepare("INSERT OR IGNORE INTO whatsapp_conversation_routing_modes (thread_id,mode,updated_by,reason,updated_at) VALUES (?,?,?,?,?)").bind(input.threadId,input.mode,input.actorEmail,reason,now).run();
  changed=Number(result.meta?.changes||0);
 }
 if(changed!==1)throw new Response("WhatsApp routing changed concurrently; reload before retrying",{status:409});
 await db.prepare("INSERT INTO whatsapp_conversation_routing_events (id,thread_id,from_mode,to_mode,actor_email,reason,created_at) VALUES (?,?,?,?,?,?,?)").bind(uid("WAMODE"),input.threadId,before.mode,input.mode,input.actorEmail,reason,now).run();
 return{...(await getWhatsAppConversationMode(db,input.threadId)),previousMode:before.mode};
}

export async function assertWhatsAppAiRoutingAllowsReply(db:D1Database,threadId:string){
 const state=await getWhatsAppConversationMode(db,threadId);
 if(state.mode!=="ai_assistant")throw new Response(`WhatsApp AI replies are disabled while routing mode is ${state.mode}`,{status:409});
 return state;
}

export async function whatsappConversationControlSnapshot(db:D1Database,input:{actor:AuthenticatedActor;threadId:string}){
 const context=await threadContext(db,input.threadId),routing=await getWhatsAppConversationMode(db,input.threadId),handoff=await aiHumanHandoffSnapshot(db,{actor:input.actor,threadId:input.threadId,customerId:context.customerId});
 const chatbot=await db.prepare("SELECT state,service_code,city,pet_type,status,updated_at FROM whatsapp_chatbot_sessions WHERE thread_id=?").bind(input.threadId).first<Row>().catch(()=>null);
 return{threadId:input.threadId,customerId:context.customerId,provider:context.provider,routing,handoff,canHumanReply:routing.mode==="human_only",chatbotReady:true,chatbotSession:chatbot||null,productionDelivery:false,environment:"uat"};
}

export async function takeOverWhatsAppConversation(db:D1Database,input:{actor:AuthenticatedActor;threadId:string;reason:string}){
 const context=await threadContext(db,input.threadId),reason=text(input.reason)||"Staff requested WhatsApp takeover";
 let snapshot=await aiHumanHandoffSnapshot(db,{actor:input.actor,threadId:input.threadId,customerId:context.customerId});
 if(!snapshot.current||!["queued","staff_active"].includes(handoffStatus(snapshot.current))){
  await requestAiHumanHandoff(db,{actorEmail:input.actor.email,threadId:input.threadId,customerId:context.customerId,reason:"customer_requested_human"});
  snapshot=await aiHumanHandoffSnapshot(db,{actor:input.actor,threadId:input.threadId,customerId:context.customerId});
 }
 if(handoffStatus(snapshot.current)==="queued")await manageAiHumanHandoff(db,{actor:input.actor,threadId:input.threadId,customerId:context.customerId,action:"take_over",reason});
 const routing=await setWhatsAppConversationMode(db,{threadId:input.threadId,mode:"human_only",actorEmail:input.actor.email,reason});
 return{routing,handoff:await aiHumanHandoffSnapshot(db,{actor:input.actor,threadId:input.threadId,customerId:context.customerId}),aiPaused:true};
}

export async function resumeAiForWhatsAppConversation(db:D1Database,input:{actor:AuthenticatedActor;threadId:string;reason:string}){
 const context=await threadContext(db,input.threadId),reason=text(input.reason);if(reason.length<8)throw new Response("A clear AI-resume reason of at least 8 characters is required",{status:400});
 await manageAiHumanHandoff(db,{actor:input.actor,threadId:input.threadId,customerId:context.customerId,action:"resume_ai",reason});
 const routing=await setWhatsAppConversationMode(db,{threadId:input.threadId,mode:"ai_assistant",actorEmail:input.actor.email,reason:`AI resumed: ${reason}`});
 return{routing,handoff:await aiHumanHandoffSnapshot(db,{actor:input.actor,threadId:input.threadId,customerId:context.customerId}),aiPaused:false};
}

export async function openAiModeForWhatsAppConversation(db:D1Database,input:{actor:AuthenticatedActor;threadId:string;reason:string}){
 const context=await threadContext(db,input.threadId),handoff=await aiHumanHandoffSnapshot(db,{actor:input.actor,threadId:input.threadId,customerId:context.customerId});
 if(handoff.aiPaused)throw new Response("Active human handoff must be explicitly resumed before AI mode can be enabled",{status:409});
 const routing=await setWhatsAppConversationMode(db,{threadId:input.threadId,mode:"ai_assistant",actorEmail:input.actor.email,reason:input.reason});
 return{routing,handoff,aiPaused:false};
}

export async function queueWhatsAppHumanReply(db:D1Database,input:{actor:AuthenticatedActor;threadId:string;message:string;clientRequestId:string}){
 const context=await threadContext(db,input.threadId),routing=await getWhatsAppConversationMode(db,input.threadId),message=text(input.message),clientRequestId=text(input.clientRequestId);
 if(routing.mode!=="human_only")throw new Response("Take over the conversation before sending a human reply",{status:409});
 if(!message||message.length>4096)throw new Response("Reply text must contain 1 to 4096 characters",{status:400});
 if(clientRequestId.length<8||clientRequestId.length>120)throw new Response("A stable client request ID is required",{status:400});
 const result=await queueWhatsAppUatOutbound(db,{provider:context.provider,threadId:input.threadId,customerId:context.customerId,text:message,idempotencyKey:`whatsapp-human-reply:${input.threadId}:${input.actor.email}:${clientRequestId}`,createdBy:input.actor.email});
 if(!result.queued)throw new Response(`WhatsApp reply blocked: ${text(result.reason)||"governed outbound policy"}`,{status:409});
 return{...result,provider:context.provider,threadId:input.threadId,customerId:context.customerId,productionDelivery:false,environment:"uat"};
}
