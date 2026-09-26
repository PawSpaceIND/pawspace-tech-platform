import{requestAiHumanHandoff,type AiHandoffReason}from"./ai-human-handoff";
import{ensureConversationGovernance}from"./conversation-governance";
import{getWhatsAppConversationMode,setWhatsAppConversationMode}from"./whatsapp-conversation-control";
import{ensureWhatsAppUatTables,queueWhatsAppUatOutbound,whatsappUatProviders,type WhatsAppUatProvider}from"./whatsapp-uat-adapter";
import{buildWhatsAppInteractiveContract}from"./whatsapp-interactive-capture";
import{ASK_AI,runBotTurn,type BotReply,type BotState}from"./web-chat-bot";
import{advanceBotSession,loadBotSession}from"./web-chat-bot-store";

type Row=Record<string,unknown>;
type ChatbotState="service"|"collecting"|"city"|"pet"|"qualified";
export type WhatsAppChatbotSession={thread_id:string;customer_id:string;state:ChatbotState;service_code:string|null;city:string|null;pet_type:string|null;status:string;created_at:number;updated_at:number};

const text=(value:unknown)=>String(value??"").trim();
const lower=(value:unknown)=>text(value).toLowerCase();
const uid=(prefix:string)=>`${prefix}-${crypto.randomUUID().slice(0,12).toUpperCase()}`;
const parse=<T>(value:unknown,fallback:T):T=>{try{return JSON.parse(String(value??""))as T}catch{return fallback}};


const humanPhrases=["human","agent","person","representative","talk to someone","speak to someone","call me","support person"];
const complaintPhrases=["complaint","bad service","poor service","not happy","unhappy"];
const paymentPhrases=["refund","payment dispute","charged twice","wrong charge","money back","payment issue"];
const safetyPhrases=["medical emergency","emergency","injured","injury","bleeding","poison","unsafe","safety issue"];
const funeralPhrases=["funeral","memorial","cremation","passed away","died","death"];

function containsAny(value:string,phrases:string[]){return phrases.some(phrase=>value.includes(phrase));}

export async function ensureWhatsAppChatbotTables(db:D1Database){
 await ensureConversationGovernance(db);await ensureWhatsAppUatTables(db);
 await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS whatsapp_chatbot_sessions (thread_id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,state TEXT NOT NULL,service_code TEXT,city TEXT,pet_type TEXT,status TEXT NOT NULL DEFAULT 'active',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS whatsapp_chatbot_turns (id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,input_message_id TEXT NOT NULL UNIQUE,output_message_id TEXT,from_state TEXT NOT NULL,to_state TEXT NOT NULL,intent TEXT NOT NULL,action TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL)"),
  db.prepare("CREATE INDEX IF NOT EXISTS whatsapp_chatbot_turn_thread_idx ON whatsapp_chatbot_turns(thread_id,created_at)"),
 ]);
}

async function inputContext(db:D1Database,threadId:string,inputMessageId:string){
 await ensureWhatsAppChatbotTables(db);
 const thread=await db.prepare("SELECT id,customer_id,status FROM communication_threads WHERE id=?").bind(threadId).first<Row>();
 if(!thread)throw new Response("Conversation not found",{status:404});
 if(text(thread.status)!=="open")throw new Response("Chatbot requires an open conversation",{status:409});
 const message=await db.prepare("SELECT id,customer_id,direction,channel,payload_json,provider,created_at FROM communication_messages WHERE id=? AND thread_id=?").bind(inputMessageId,threadId).first<Row>();
 if(!message||text(message.direction)!=="inbound"||text(message.channel)!=="whatsapp")throw new Response("Canonical inbound WhatsApp message is required",{status:409});
 if(text(message.customer_id)!==text(thread.customer_id))throw new Response("Conversation message/customer mismatch",{status:403});
 const payload=parse<Record<string,unknown>>(message.payload_json,{}),body=text(payload.text||payload.message||payload.body||payload.content),providerValue=text(message.provider),provider=whatsappUatProviders.includes(providerValue as WhatsAppUatProvider)?providerValue as WhatsAppUatProvider:"sandbox_simulator";
 if(!body)throw new Response("Chatbot input text is required",{status:400});
 return{thread,customerId:text(thread.customer_id),body,provider,inputCreatedAt:Number(message.created_at||0)};
}

async function handoff(db:D1Database,input:{threadId:string;customerId:string;actorEmail:string;reason:AiHandoffReason;confidence?:number|null}){
 const requested=await requestAiHumanHandoff(db,{actorEmail:input.actorEmail,threadId:input.threadId,customerId:input.customerId,reason:input.reason,confidence:input.confidence??null});
 await setWhatsAppConversationMode(db,{threadId:input.threadId,mode:"human_only",actorEmail:input.actorEmail,reason:`Chatbot handoff: ${input.reason}`});
 return requested;
}

function escalationReason(message:string):AiHandoffReason|null{
 const normalized=lower(message);
 if(containsAny(normalized,humanPhrases))return"customer_requested_human";
 if(containsAny(normalized,paymentPhrases))return"refund_payment_dispute";
 if(containsAny(normalized,complaintPhrases))return"complaint";
 if(containsAny(normalized,safetyPhrases))return"safety";
 if(containsAny(normalized,funeralPhrases))return"urgent_funeral_memorial";
 return null;
}

export async function getWhatsAppChatbotSession(db:D1Database,threadId:string):Promise<WhatsAppChatbotSession|null>{
 await ensureWhatsAppChatbotTables(db);
 const row=await db.prepare("SELECT thread_id,customer_id,state,service_code,city,pet_type,status,created_at,updated_at FROM whatsapp_chatbot_sessions WHERE thread_id=?").bind(threadId).first<Row>();
 if(!row)return null;
 return{thread_id:text(row.thread_id),customer_id:text(row.customer_id),state:text(row.state)as ChatbotState,service_code:row.service_code==null?null:text(row.service_code),city:row.city==null?null:text(row.city),pet_type:row.pet_type==null?null:text(row.pet_type),status:text(row.status),created_at:Number(row.created_at||0),updated_at:Number(row.updated_at||0)};
}

/** The bot's buttons as WhatsApp sees them: up to 3 short reply buttons, otherwise a list of up to 10. */
export function whatsAppChoicesContract(reply:BotReply){
 const choices=reply.choices.filter(choice=>choice.id!==ASK_AI.id);if(!choices.length)return null;
 if(choices.length<=3&&choices.every(choice=>choice.label.length<=20))return buildWhatsAppInteractiveContract({kind:"reply_buttons",body:reply.text,buttons:choices.map(choice=>({id:choice.id,title:choice.label}))});
 const rows=(choices.length>10?choices.filter(choice=>choice.id!=="start_over"):choices).slice(0,10);
 return{...buildWhatsAppInteractiveContract({kind:"list",body:reply.text,sections:[{title:"Choose an option",rows:rows.map(choice=>({id:choice.id,title:choice.label.slice(0,24),description:choice.label.length>24?choice.label:undefined}))}]}),button:"Choose"};
}

function legacySession(state:BotState):{state:ChatbotState;status:string}{return state.status==="done"?{state:"qualified",status:"qualified"}:state.status==="collecting"?{state:"collecting",status:"active"}:{state:"service",status:"active"};}

/**
 * One WhatsApp message through the guided bot - the same flows, questions and buttons as web chat
 * (lib/web-chat-bot.ts), sent as WhatsApp reply buttons or a list. The customer's number is already known,
 * so contact questions are skipped. A free question goes to the governed WhatsApp AI (`aiRequested`); a
 * request for a person, a refund, an emergency or a finished enquiry goes to the team.
 */
export async function runWhatsAppChatbotTurn(db:D1Database,input:{threadId:string;inputMessageId:string;actorEmail:string}){
 const routing=await getWhatsAppConversationMode(db,input.threadId);
 if(routing.mode!=="chatbot_only")throw new Response(`WhatsApp chatbot replies are disabled while routing mode is ${routing.mode}`,{status:409});
 const existing=await db.prepare("SELECT id,output_message_id,from_state,to_state,intent,action,detail_json,created_at FROM whatsapp_chatbot_turns WHERE input_message_id=?").bind(input.inputMessageId).first<Row>().catch(()=>null);
 if(existing)return{duplicatePrevented:true,turn:{...existing,detail:parse(existing.detail_json,{})},routingMode:routing.mode,externalDelivery:false,environment:"uat"};
 const context=await inputContext(db,input.threadId,input.inputMessageId),ref=`whatsapp:${input.threadId}`,prior=await loadBotSession(db,ref),fromState=legacySession(prior).state;
 const recordHandoff=async(reason:AiHandoffReason,intent:string,detail:Record<string,unknown>={})=>{
  const transfer=await handoff(db,{threadId:input.threadId,customerId:context.customerId,actorEmail:input.actorEmail,reason});
  const turnId=uid("WABOT");
  await db.prepare("INSERT OR IGNORE INTO whatsapp_chatbot_turns (id,thread_id,input_message_id,output_message_id,from_state,to_state,intent,action,detail_json,created_at) VALUES (?,?,?,NULL,?,?,?,'human_handoff',?,?)").bind(turnId,input.threadId,input.inputMessageId,fromState,fromState,intent,JSON.stringify({reason,...detail}),Date.now()).run();
  return{duplicatePrevented:false,turn:{id:turnId,fromState,toState:fromState,intent,action:"human_handoff",reason},handoff:transfer,routingMode:"human_only" as const,externalDelivery:false,environment:"uat"};
 };
 // The certified mandatory-handoff phrases still win before any flow logic.
 const forced=escalationReason(lower(context.body));
 if(forced)return recordHandoff(forced,"handoff");

 // Claimed before anything is sent: two messages arriving together cannot both answer the same question.
 const turn=await advanceBotSession(db,ref,state=>runBotTurn(state,{text:context.body,signedIn:true}));
 if(turn.event.type==="human")return recordHandoff(turn.event.reason,"handoff");
 if(turn.event.type==="call")return recordHandoff("customer_requested_human","callback_requested",{callback:true});
 if(turn.event.type==="ai"){
  // A question the flows do not answer: the governed WhatsApp AI answers it; the bot keeps the thread.
  const turnId=uid("WABOT");
  await db.prepare("INSERT OR IGNORE INTO whatsapp_chatbot_turns (id,thread_id,input_message_id,output_message_id,from_state,to_state,intent,action,detail_json,created_at) VALUES (?,?,?,NULL,?,?,'question','ai_answer',?,?)").bind(turnId,input.threadId,input.inputMessageId,fromState,"service",JSON.stringify({question:turn.event.question.slice(0,200)}),Date.now()).run();
  return{duplicatePrevented:false,aiRequested:true,turn:{id:turnId,fromState,toState:"service",intent:"question",action:"ai_answer"},routingMode:"chatbot_only" as const,externalDelivery:false,environment:"uat"};
 }

 const interactive=whatsAppChoicesContract(turn.reply);
 const queued=await queueWhatsAppUatOutbound(db,{provider:context.provider,threadId:input.threadId,customerId:context.customerId,text:turn.reply.text,interactive,idempotencyKey:`whatsapp-chatbot:${input.threadId}:${input.inputMessageId}:v2`,createdBy:input.actorEmail});
 if(!queued.queued)return recordHandoff("provider_error","outbound_blocked",{reason:text(queued.reason)||"governed_outbound_policy"}).then(result=>({...result,turn:{...result.turn,reason:text(queued.reason)||"governed_outbound_policy"}}));

 const next=legacySession(turn.state),now=Date.now(),answers=turn.state.answers;
 await db.batch([
  db.prepare("INSERT INTO whatsapp_chatbot_sessions (thread_id,customer_id,state,service_code,city,pet_type,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(thread_id) DO UPDATE SET state=excluded.state,service_code=excluded.service_code,city=excluded.city,pet_type=excluded.pet_type,status=excluded.status,updated_at=excluded.updated_at").bind(input.threadId,context.customerId,next.state,turn.state.flow,answers.city||answers.area||answers.from||answers.address?.slice(0,120)||null,answers.petType?answers.petType.toLowerCase():null,next.status,now,now),
  db.prepare("INSERT OR IGNORE INTO whatsapp_chatbot_turns (id,thread_id,input_message_id,output_message_id,from_state,to_state,intent,action,detail_json,created_at) VALUES (?,?,?,?,?,?,?,'reply',?,?)").bind(uid("WABOT"),input.threadId,input.inputMessageId,queued.messageId,fromState,next.state,turn.event.type==="completed"?"qualified":turn.state.status==="collecting"?"question_answered":"menu",JSON.stringify({flow:turn.state.flow,step:turn.state.step,interactive:interactive?.kind??null}),now),
 ]);
 // A finished WhatsApp enquiry goes to the sales queue with the whole flow above it, as in WATI.
 const completed=turn.event.type==="completed"?await handoff(db,{threadId:input.threadId,customerId:context.customerId,actorEmail:input.actorEmail,reason:"bot_lead_qualified"}):null;
 const recorded=await db.prepare("SELECT id,output_message_id,from_state,to_state,intent,action,detail_json,created_at FROM whatsapp_chatbot_turns WHERE input_message_id=?").bind(input.inputMessageId).first<Row>();
 return{duplicatePrevented:"duplicatePrevented"in queued?Boolean(queued.duplicatePrevented):false,turn:recorded?{...recorded,detail:parse(recorded.detail_json,{})}:null,session:await getWhatsAppChatbotSession(db,input.threadId),...(completed?{handoff:completed}:{}),routingMode:completed?"human_only" as const:"chatbot_only" as const,externalDelivery:false,environment:"uat"};
}
