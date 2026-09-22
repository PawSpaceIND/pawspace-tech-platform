import{ensureConversationGovernance}from"./conversation-governance";
import{ensureCustomer360Tables}from"./customer-360";
import{governedJsonError}from"./governed-http-error";
import type{AuthenticatedActor}from"./server-auth";

/**
 * What happens on a WEB CHAT thread once a human takes it over.
 *
 * Owner decision 2026-09-22 (decision 4 of 10): after staff takeover on web chat, ask in-thread for
 * WhatsApp consent before moving the conversation. If there is no number, the contact is opted out of
 * CRM messaging, or consent is not given, stay in the thread and tell the customer a human will reply
 * there. Never claim a WhatsApp message was sent when the WhatsApp keys are unset.
 *
 * The gap this closes is larger than the consent question. There was NO staff reply path for a thread
 * on channel 'chat' at all: queueWhatsAppHumanReply calls threadContext, which refuses any thread
 * without a WhatsApp message with "Conversation is not a WhatsApp thread". So after a takeover on web
 * chat the customer was told "I'm routing this conversation to a PawSpace team member", the AI was
 * paused, every further turn answered 409 "AI replies are paused while the conversation is owned by
 * staff" - and the member of staff had no way to say anything back. The conversation simply stopped.
 *
 * So this module gives web chat its own reply path, and makes moving to WhatsApp a thing the customer
 * agrees to in the thread they are already in, rather than something done to them.
 */

type Db=D1Database;
type Row=Record<string,unknown>;
const text=(value:unknown)=>String(value??"").trim();
const uid=(prefix:string)=>`${prefix}-${crypto.randomUUID().slice(0,12).toUpperCase()}`;

/** Why a conversation may not be moved to WhatsApp. Each one has a sentence the customer is told. */
export type WhatsAppMoveBlock="no_phone_number"|"crm_opt_out"|"whatsapp_not_connected"|"consent_not_asked"|"consent_declined";

/** What the customer reads in the thread. Never a promise the platform cannot keep. */
export const STAY_IN_THREAD_MESSAGE="A member of the PawSpace team will reply to you here in this chat.";
export const CONSENT_QUESTION="Would you like us to continue this conversation on WhatsApp? Reply here to let us know - either way, a member of the PawSpace team will keep replying to you in this chat.";

const BLOCK_EXPLANATION:Record<WhatsAppMoveBlock,string>={
 no_phone_number:"We do not have a mobile number on your account, so we cannot move this to WhatsApp.",
 crm_opt_out:"Your account is opted out of PawSpace messaging, so we will not send you anything on WhatsApp.",
 whatsapp_not_connected:"WhatsApp is not available on this environment.",
 consent_not_asked:"We have not asked whether you would like to move to WhatsApp.",
 consent_declined:"You asked us not to move this conversation to WhatsApp.",
};

export async function ensureChatHumanReplyTables(db:Db){
 await ensureConversationGovernance(db);
 await db.prepare("CREATE TABLE IF NOT EXISTS chat_whatsapp_move_consents (thread_id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'asked',asked_by TEXT NOT NULL,asked_at INTEGER NOT NULL,answered_at INTEGER,detail_json TEXT NOT NULL DEFAULT '{}')").run();
}

async function chatThread(db:Db,threadId:string){
 await ensureChatHumanReplyTables(db);
 const thread=await db.prepare("SELECT id,customer_id,status,assigned_to FROM communication_threads WHERE id=?").bind(threadId).first<Row>();
 if(!thread)throw governedJsonError({error:"Conversation not found",code:"thread_not_found"},404);
 if(text(thread.status)==="closed")throw governedJsonError({error:"Closed conversation cannot be replied to",code:"thread_closed"},409);
 return thread;
}

/**
 * Is the customer already reading this conversation on WhatsApp?
 *
 * The mirror of the check in lib/whatsapp-conversation-control.ts, and the reason it is here: a thread
 * that HAS WhatsApp messages belongs to that module's reply path, and asking someone on WhatsApp
 * whether they would like to move to WhatsApp is nonsense. A thread with none is a web chat thread.
 */
async function onWhatsApp(db:Db,threadId:string){
 const message=await db.prepare("SELECT id FROM communication_messages WHERE thread_id=? AND channel='whatsapp' LIMIT 1").bind(threadId).first<Row>().catch(()=>null);
 return Boolean(message);
}

/** Is a WhatsApp provider actually connected here? Unset keys must never look like a delivery. */
async function whatsappConnected(){
 try{
  const{env}=await import("cloudflare:workers");
  const runtime=env as unknown as Record<string,unknown>;
  const haptik=Boolean(text(runtime.HAPTIK_OUTBOUND_API_KEY||runtime.HAPTIK_API_KEY)&&text(runtime.HAPTIK_OUTBOUND_URL));
  const meta=Boolean(text(runtime.META_WHATSAPP_UAT_ACCESS_TOKEN||runtime.META_WHATSAPP_ACCESS_TOKEN)&&text(runtime.META_WHATSAPP_PHONE_NUMBER_ID));
  return haptik||meta;
 }catch{return false;}
}

export type WhatsAppMoveEligibility={
 eligible:boolean;blockedBy:WhatsAppMoveBlock|null;customerMessage:string;
 phoneOnFile:boolean;optedOut:boolean;crmWhatsAppConsent:boolean;providerConnected:boolean;
 inThreadConsent:"granted"|"declined"|"asked"|"not_asked";
};

/**
 * May this conversation be moved to WhatsApp, and if not, what is the customer told?
 *
 * The order of the checks is the order of the decision: a number, then CRM opt-out, then whether
 * WhatsApp is connected at all, then the customer's own answer in the thread. The customer is never
 * asked a question the platform could not act on anyway.
 */
export async function whatsAppMoveEligibility(db:Db,input:{threadId:string;customerId:string}):Promise<WhatsAppMoveEligibility>{
 await ensureChatHumanReplyTables(db);
 await ensureCustomer360Tables(db).catch(()=>{});
 const customer=await db.prepare("SELECT primary_phone FROM canonical_customers WHERE id=?").bind(input.customerId).first<Row>().catch(()=>null);
 const preference=await db.prepare("SELECT whatsapp_consent,opt_out FROM customer_contact_preferences WHERE customer_id=?").bind(input.customerId).first<Row>().catch(()=>null);
 const consentRow=await db.prepare("SELECT status FROM chat_whatsapp_move_consents WHERE thread_id=?").bind(input.threadId).first<Row>().catch(()=>null);

 const phoneOnFile=Boolean(text(customer?.primary_phone));
 const optedOut=Number(preference?.opt_out||0)===1;
 const crmWhatsAppConsent=Number(preference?.whatsapp_consent||0)===1;
 const providerConnected=await whatsappConnected();
 const stored=text(consentRow?.status);
 const inThreadConsent=stored==="granted"||stored==="declined"||stored==="asked"?stored as "granted"|"declined"|"asked":"not_asked";

 const blockedBy:WhatsAppMoveBlock|null=
  !phoneOnFile?"no_phone_number"
  :optedOut?"crm_opt_out"
  :!providerConnected?"whatsapp_not_connected"
  :inThreadConsent==="declined"?"consent_declined"
  :inThreadConsent!=="granted"?"consent_not_asked"
  :null;

 return{
  eligible:blockedBy===null,blockedBy,
  customerMessage:blockedBy?`${BLOCK_EXPLANATION[blockedBy]} ${STAY_IN_THREAD_MESSAGE}`:STAY_IN_THREAD_MESSAGE,
  phoneOnFile,optedOut,crmWhatsAppConsent,providerConnected,inThreadConsent,
 };
}

/** Writes one outbound message into the web chat thread the customer is already reading. */
async function postToThread(db:Db,input:{threadId:string;customerId:string;body:string;templateKey:string;createdBy:string;idempotencyKey:string;policy?:Record<string,unknown>}){
 const id=uid("CMSG"),now=Date.now();
 const existing=await db.prepare("SELECT id FROM communication_messages WHERE idempotency_key=?").bind(input.idempotencyKey).first<Row>().catch(()=>null);
 if(existing)return{messageId:text(existing.id),duplicatePrevented:true as const,text:input.body};
 await db.prepare("INSERT INTO communication_messages (id,thread_id,customer_id,booking_id,lead_id,ticket_id,direction,channel,purpose,template_key,payload_json,status,provider,provider_reference,idempotency_key,policy_json,created_by,created_at,updated_at) VALUES (?,?,?,NULL,NULL,NULL,'outbound','chat','service',?,?,'delivered','pawspace_web_chat',NULL,?,?,?,?,?)")
  .bind(id,input.threadId,input.customerId,input.templateKey,JSON.stringify({text:input.body}),input.idempotencyKey,JSON.stringify({channel:"chat",externalDelivery:false,productionDelivery:false,...(input.policy??{})}),input.createdBy,now,now).run();
 await db.prepare("UPDATE communication_threads SET updated_at=? WHERE id=?").bind(now,input.threadId).run().catch(()=>{});
 return{messageId:id,duplicatePrevented:false as const,text:input.body};
}

/**
 * The staff reply path web chat never had.
 *
 * Status is 'delivered' and the provider is the web chat itself, because that is literally true: the
 * message is in the thread the customer has open. Nothing external is contacted, and the policy record
 * says so, so this can never be mistaken for a WhatsApp send.
 */
export async function queueChatHumanReply(db:Db,input:{actor:AuthenticatedActor;threadId:string;message:string;clientRequestId:string}){
 const thread=await chatThread(db,input.threadId);
 // A thread the customer reads on WhatsApp is replied to through lib/whatsapp-conversation-control.ts,
 // which carries the consent, template and frequency controls that a WhatsApp send has to pass. Writing
 // a 'chat' message onto it would put the reply somewhere the customer is not looking.
 if(await onWhatsApp(db,input.threadId))throw governedJsonError({error:"This conversation is on WhatsApp. Reply through the WhatsApp conversation controls so the message reaches the customer where they are reading it.",code:"thread_is_whatsapp"},409);
 const message=text(input.message),clientRequestId=text(input.clientRequestId);
 if(!message||message.length>4096)throw governedJsonError({error:"Reply text must contain 1 to 4096 characters",code:"reply_text_required"},400);
 if(clientRequestId.length<8||clientRequestId.length>120)throw governedJsonError({error:"A stable client request ID is required",code:"client_request_id_required"},400);
 const posted=await postToThread(db,{threadId:input.threadId,customerId:text(thread.customer_id),body:message,templateKey:"chat_human_reply",createdBy:input.actor.email,idempotencyKey:`chat-human-reply:${input.threadId}:${input.actor.email}:${clientRequestId}`});
 return{...posted,threadId:input.threadId,customerId:text(thread.customer_id),channel:"chat" as const,externalDelivery:false as const,productionDelivery:false as const};
}

/**
 * Asks the customer, in the thread, whether they want to move to WhatsApp.
 *
 * Where the move could not happen anyway - no number, opted out, or WhatsApp simply not connected here -
 * the question is NOT asked. Asking would be offering something that cannot be delivered. The customer
 * is told the real reason and that a human will reply in this chat, which is what will actually happen.
 */
export async function askWhatsAppMoveConsent(db:Db,input:{actor:AuthenticatedActor;threadId:string}){
 const thread=await chatThread(db,input.threadId),customerId=text(thread.customer_id);
 if(await onWhatsApp(db,input.threadId))return{asked:false as const,alreadyOnWhatsApp:true as const,...await whatsAppMoveEligibility(db,{threadId:input.threadId,customerId}),messageId:null,duplicatePrevented:false as const,text:""};
 const eligibility=await whatsAppMoveEligibility(db,{threadId:input.threadId,customerId});
 const askable=eligibility.blockedBy===null||eligibility.blockedBy==="consent_not_asked";
 const now=Date.now();

 if(!askable){
  const posted=await postToThread(db,{threadId:input.threadId,customerId,body:eligibility.customerMessage,templateKey:"chat_stay_in_thread",createdBy:input.actor.email,idempotencyKey:`chat-stay-in-thread:${input.threadId}:${eligibility.blockedBy}`,policy:{whatsappMove:"blocked",blockedBy:eligibility.blockedBy}});
  return{asked:false as const,alreadyOnWhatsApp:false as const,...eligibility,...posted};
 }

 await db.prepare("INSERT INTO chat_whatsapp_move_consents (thread_id,customer_id,status,asked_by,asked_at,detail_json) VALUES (?,?,'asked',?,?,?) ON CONFLICT(thread_id) DO UPDATE SET status=CASE WHEN chat_whatsapp_move_consents.status IN ('granted','declined') THEN chat_whatsapp_move_consents.status ELSE 'asked' END,asked_by=excluded.asked_by,asked_at=excluded.asked_at")
  .bind(input.threadId,customerId,input.actor.email,now,JSON.stringify({crmWhatsAppConsent:eligibility.crmWhatsAppConsent})).run();
 const posted=await postToThread(db,{threadId:input.threadId,customerId,body:CONSENT_QUESTION,templateKey:"chat_whatsapp_move_consent_request",createdBy:input.actor.email,idempotencyKey:`chat-whatsapp-consent-ask:${input.threadId}`,policy:{whatsappMove:"consent_requested"}});
 return{asked:true as const,alreadyOnWhatsApp:false as const,...await whatsAppMoveEligibility(db,{threadId:input.threadId,customerId}),...posted};
}

/** The customer's answer, recorded against the thread it was given in. */
export async function recordWhatsAppMoveConsent(db:Db,input:{threadId:string;granted:boolean;actorId:string}){
 const thread=await chatThread(db,input.threadId),customerId=text(thread.customer_id);
 const asked=await db.prepare("SELECT status FROM chat_whatsapp_move_consents WHERE thread_id=?").bind(input.threadId).first<Row>();
 if(!asked)throw governedJsonError({error:"The customer has not been asked about moving to WhatsApp yet",code:"consent_not_asked"},409);
 const now=Date.now(),status=input.granted?"granted":"declined";
 await db.prepare("UPDATE chat_whatsapp_move_consents SET status=?,answered_at=? WHERE thread_id=?").bind(status,now,input.threadId).run();
 if(!input.granted)await postToThread(db,{threadId:input.threadId,customerId,body:STAY_IN_THREAD_MESSAGE,templateKey:"chat_stay_in_thread",createdBy:input.actorId,idempotencyKey:`chat-stay-in-thread:${input.threadId}:consent_declined`,policy:{whatsappMove:"declined_by_customer"}});
 return{threadId:input.threadId,customerId,status,answeredAt:now,...await whatsAppMoveEligibility(db,{threadId:input.threadId,customerId})};
}

/**
 * Moves the conversation to WhatsApp, or refuses honestly.
 *
 * 503 when WhatsApp is not connected, because the alternative - reporting a queued or sent message that
 * no provider will ever carry - is the exact thing the decision forbids. 409 when the customer has not
 * agreed, because that is a decision only they can make.
 */
export async function moveChatThreadToWhatsApp(db:Db,input:{actor:AuthenticatedActor;threadId:string}){
 const thread=await chatThread(db,input.threadId),customerId=text(thread.customer_id);
 const eligibility=await whatsAppMoveEligibility(db,{threadId:input.threadId,customerId});
 if(eligibility.blockedBy==="whatsapp_not_connected")throw governedJsonError({error:"WhatsApp is not connected on this environment, so this conversation cannot be moved there and no message has been sent. Reply to the customer in this chat instead.",code:"whatsapp_not_connected",blockedBy:eligibility.blockedBy,staffGuidance:STAY_IN_THREAD_MESSAGE},503);
 if(!eligibility.eligible)throw governedJsonError({error:`This conversation stays in the web chat. ${BLOCK_EXPLANATION[eligibility.blockedBy!]}`,code:eligibility.blockedBy!,blockedBy:eligibility.blockedBy,staffGuidance:STAY_IN_THREAD_MESSAGE},409);
 const now=Date.now();
 await db.prepare("UPDATE chat_whatsapp_move_consents SET detail_json=? WHERE thread_id=?").bind(JSON.stringify({movedAt:now,movedBy:input.actor.email}),input.threadId).run();
 return{threadId:input.threadId,customerId,moved:true as const,movedAt:now,...eligibility};
}
