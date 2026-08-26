import{requestAiHumanHandoff,type AiHandoffReason}from"./ai-human-handoff";
import{ensureConversationGovernance}from"./conversation-governance";
import{getWhatsAppConversationMode,setWhatsAppConversationMode}from"./whatsapp-conversation-control";
import{ensureWhatsAppUatTables,queueWhatsAppUatOutbound,whatsappUatProviders,type WhatsAppUatProvider}from"./whatsapp-uat-adapter";

type Row=Record<string,unknown>;
type ChatbotState="service"|"city"|"pet"|"qualified";
export type WhatsAppChatbotSession={thread_id:string;customer_id:string;state:ChatbotState;service_code:string|null;city:string|null;pet_type:string|null;status:string;created_at:number;updated_at:number};

const text=(value:unknown)=>String(value??"").trim();
const lower=(value:unknown)=>text(value).toLowerCase();
const uid=(prefix:string)=>`${prefix}-${crypto.randomUUID().slice(0,12).toUpperCase()}`;
const parse=<T>(value:unknown,fallback:T):T=>{try{return JSON.parse(String(value??""))as T}catch{return fallback}};

const serviceChoices=[
 {code:"grooming",labels:["1","grooming","groom"]},
 {code:"training",labels:["2","training","trainer"]},
 {code:"boarding",labels:["3","boarding","home boarding"]},
 {code:"pet_sitting",labels:["4","pet sitting","sitting","sitter"]},
 {code:"dog_walking",labels:["5","dog walking","walking","walker"]},
 {code:"pet_taxi",labels:["6","pet taxi","taxi"]},
 {code:"fresh_food",labels:["7","fresh food","food"]},
 {code:"relocation",labels:["8","relocation","pet relocation"]},
]as const;

const humanPhrases=["human","agent","person","representative","talk to someone","speak to someone","call me","support person"];
const complaintPhrases=["complaint","bad service","poor service","not happy","unhappy"];
const paymentPhrases=["refund","payment dispute","charged twice","wrong charge","money back","payment issue"];
const safetyPhrases=["medical emergency","emergency","injured","injury","bleeding","poison","unsafe","safety issue"];
const funeralPhrases=["funeral","memorial","cremation","passed away","died","death"];

function containsAny(value:string,phrases:string[]){return phrases.some(phrase=>value.includes(phrase));}
function serviceFrom(value:string){const normalized=value.trim().toLowerCase();return serviceChoices.find(choice=>choice.labels.some(label=>normalized===label||normalized.includes(label)))?.code||null;}
function petFrom(value:string){const normalized=value.trim().toLowerCase();if(/\bdog\b|\bpuppy\b/.test(normalized))return"dog";if(/\bcat\b|\bkitten\b/.test(normalized))return"cat";return null;}
function serviceLabel(code:string){return code.replaceAll("_"," ").replace(/\b\w/g,match=>match.toUpperCase());}

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

export async function runWhatsAppChatbotTurn(db:D1Database,input:{threadId:string;inputMessageId:string;actorEmail:string}){
 const routing=await getWhatsAppConversationMode(db,input.threadId);
 if(routing.mode!=="chatbot_only")throw new Response(`WhatsApp chatbot replies are disabled while routing mode is ${routing.mode}`,{status:409});
 const existing=await db.prepare("SELECT id,output_message_id,from_state,to_state,intent,action,detail_json,created_at FROM whatsapp_chatbot_turns WHERE input_message_id=?").bind(input.inputMessageId).first<Row>().catch(()=>null);
 if(existing)return{duplicatePrevented:true,turn:{...existing,detail:parse(existing.detail_json,{})},routingMode:routing.mode,externalDelivery:false,environment:"uat"};
 const context=await inputContext(db,input.threadId,input.inputMessageId),now=Date.now(),prior=await getWhatsAppChatbotSession(db,input.threadId),fromState=(text(prior?.state)||"service")as ChatbotState,normalized=lower(context.body);
 const forced=escalationReason(normalized);
 if(forced){
  const transfer=await handoff(db,{threadId:input.threadId,customerId:context.customerId,actorEmail:input.actorEmail,reason:forced});
  const turnId=uid("WABOT");
  await db.prepare("INSERT OR IGNORE INTO whatsapp_chatbot_turns (id,thread_id,input_message_id,output_message_id,from_state,to_state,intent,action,detail_json,created_at) VALUES (?,?,?,NULL,?,?,'handoff','human_handoff',?,?)").bind(turnId,input.threadId,input.inputMessageId,fromState,fromState,JSON.stringify({reason:forced}),now).run();
  return{duplicatePrevented:false,turn:{id:turnId,fromState,toState:fromState,intent:"handoff",action:"human_handoff",reason:forced},handoff:transfer,routingMode:"human_only",externalDelivery:false,environment:"uat"};
 }

 let nextState:ChatbotState=fromState,service=text(prior?.service_code),city=text(prior?.city),petType=text(prior?.pet_type),intent="qualification",reply="",sessionStatus=text(prior?.status)||"active";
 if(normalized==="restart"||normalized==="start over"){
  nextState="service";service="";city="";petType="";sessionStatus="active";
  reply="Welcome to PawSpace. Choose a service: 1 Grooming, 2 Training, 3 Boarding, 4 Pet Sitting, 5 Dog Walking, 6 Pet Taxi, 7 Fresh Food, 8 Relocation. Reply HUMAN any time for our team.";
  intent="restart";
 }else if(fromState==="service"){
  const selected=serviceFrom(normalized);
  if(!selected){reply="Please choose a PawSpace service: 1 Grooming, 2 Training, 3 Boarding, 4 Pet Sitting, 5 Dog Walking, 6 Pet Taxi, 7 Fresh Food, 8 Relocation. Reply HUMAN for our team.";intent="service_prompt";}
  else{service=selected;nextState="city";reply=`Thanks. You selected ${serviceLabel(selected)}. Which city or area do you need the service in?`;intent="service_selected";}
 }else if(fromState==="city"){
  if(normalized.length<2||normalized.length>80){reply="Please share the city or area where you need the PawSpace service, or reply HUMAN for our team.";intent="city_prompt";}
  else{city=text(context.body).slice(0,80);nextState="pet";reply="Got it. Is the pet a dog or a cat? Reply HUMAN if you need our team.";intent="city_captured";}
 }else if(fromState==="pet"){
  const selectedPet=petFrom(normalized);
  if(!selectedPet){
   const transfer=await handoff(db,{threadId:input.threadId,customerId:context.customerId,actorEmail:input.actorEmail,reason:"unsupported_request"});
   const turnId=uid("WABOT");
   await db.prepare("INSERT OR IGNORE INTO whatsapp_chatbot_turns (id,thread_id,input_message_id,output_message_id,from_state,to_state,intent,action,detail_json,created_at) VALUES (?,?,?,NULL,?,?,'unsupported_pet','human_handoff',?,?)").bind(turnId,input.threadId,input.inputMessageId,fromState,fromState,JSON.stringify({reason:"unsupported_request",input:text(context.body).slice(0,120)}),now).run();
   return{duplicatePrevented:false,turn:{id:turnId,fromState,toState:fromState,intent:"unsupported_pet",action:"human_handoff",reason:"unsupported_request"},handoff:transfer,routingMode:"human_only",externalDelivery:false,environment:"uat"};
  }
  petType=selectedPet;nextState="qualified";sessionStatus="qualified";reply=`Thanks. I have captured ${serviceLabel(service)} in ${city} for your ${selectedPet}. Your request is qualified for the next governed PawSpace step. Reply HUMAN any time for our team, or RESTART to change these answers.`;intent="qualification_complete";
 }else{
  reply=`Your PawSpace qualification is already captured${service?` for ${serviceLabel(service)}`:""}${city?` in ${city}`:""}${petType?` for your ${petType}`:""}. Reply RESTART to change it or HUMAN for our team.`;intent="already_qualified";
 }

 const queued=await queueWhatsAppUatOutbound(db,{provider:context.provider,threadId:input.threadId,customerId:context.customerId,text:reply,idempotencyKey:`whatsapp-chatbot:${input.threadId}:${input.inputMessageId}:v1`,createdBy:input.actorEmail});
 if(!queued.queued){
  const transfer=await handoff(db,{threadId:input.threadId,customerId:context.customerId,actorEmail:input.actorEmail,reason:"provider_error"});
  const turnId=uid("WABOT");
  await db.prepare("INSERT OR IGNORE INTO whatsapp_chatbot_turns (id,thread_id,input_message_id,output_message_id,from_state,to_state,intent,action,detail_json,created_at) VALUES (?,?,?,NULL,?,?,'outbound_blocked','human_handoff',?,?)").bind(turnId,input.threadId,input.inputMessageId,fromState,fromState,JSON.stringify({reason:text(queued.reason)||"governed_outbound_policy"}),now).run();
  return{duplicatePrevented:false,turn:{id:turnId,fromState,toState:fromState,intent:"outbound_blocked",action:"human_handoff",reason:text(queued.reason)||"governed_outbound_policy"},handoff:transfer,routingMode:"human_only",externalDelivery:false,environment:"uat"};
 }

 await db.batch([
  db.prepare("INSERT INTO whatsapp_chatbot_sessions (thread_id,customer_id,state,service_code,city,pet_type,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(thread_id) DO UPDATE SET state=excluded.state,service_code=excluded.service_code,city=excluded.city,pet_type=excluded.pet_type,status=excluded.status,updated_at=excluded.updated_at").bind(input.threadId,context.customerId,nextState,service||null,city||null,petType||null,sessionStatus,prior?prior.created_at||now:now,now),
  db.prepare("INSERT OR IGNORE INTO whatsapp_chatbot_turns (id,thread_id,input_message_id,output_message_id,from_state,to_state,intent,action,detail_json,created_at) VALUES (?,?,?,?,?,?,?,'reply',?,?)").bind(uid("WABOT"),input.threadId,input.inputMessageId,queued.messageId,fromState,nextState,intent,JSON.stringify({service:service||null,city:city||null,petType:petType||null,provider:context.provider,externalDelivery:false}),now),
 ]);
 const turn=await db.prepare("SELECT id,output_message_id,from_state,to_state,intent,action,detail_json,created_at FROM whatsapp_chatbot_turns WHERE input_message_id=?").bind(input.inputMessageId).first<Row>();
 const duplicatePrevented="duplicatePrevented"in queued?Boolean(queued.duplicatePrevented):false;
 return{duplicatePrevented,turn:turn?{...turn,detail:parse(turn.detail_json,{})}:null,session:await getWhatsAppChatbotSession(db,input.threadId),routingMode:"chatbot_only",externalDelivery:false,environment:"uat"};
}
