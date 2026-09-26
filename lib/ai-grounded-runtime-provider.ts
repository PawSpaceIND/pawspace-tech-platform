import { specialistSalesPrompt, type VoiceSalesService } from "./voice-sales-specialists";
import{aiProviderConnection,requestAiDraft}from"./ai-provider-adapter";
import{prepareAiToolExecution,type AiToolChannel,type AiToolIntent}from"./ai-tool-registry";
import type{AiActionRequest,AiProviderInput,AiResponseProvider}from"./ai-conversation-orchestrator";
import type{AiToolCode}from"./ai-tool-registry";
import type{AuthenticatedActor}from"./server-auth";
import{latestSalesPromptContext,renderProtectedQuotaDirective}from"./ai-sales-goal-orchestrator";
import{listServiceControls}from"./service-control";

type Row=Record<string,unknown>;
const text=(value:unknown)=>String(value??"").trim();
const CHAT_PROVIDER_TIMEOUT_MS=12_000;
const CHAT_ORCHESTRATOR_DEADLINE_MS=15_000;

const ACTION_TOOLS=new Set<AiToolCode>(["schedule.reserve","booking.create","checkout.payment_order.create","booking.reschedule","booking.cancel","provider.assignment.execute_policy"]);
const BASE_PROMPT=`You are the PawSpace AI concierge for pet parents in India. Use only the canonical context and approved PawSpace knowledge supplied for this turn. Never invent a service, price, discount, availability, policy, booking state, provider state, payment state, or completed action. Prices and service facts must come from the server-owned catalogue snapshot or approved knowledge in the supplied context. If the requested fact is missing or ambiguous, say you are not certain and hand off rather than guessing. Never issue or promise refunds, capture payments, change prices, activate campaigns, merge customers, or send an outbound communication without the required governed authority. You may reserve capacity, create a canonical booking, create a Razorpay payment order, execute a policy-safe reschedule/cancellation, or trigger deterministic provider assignment only through the registered governed action tools and only when the tool confirms success; the policy engine, not the model, chooses provider eligibility and assignment. Pet emergencies, safety concerns, refund or payment disputes, provider no-shows, and complex complaints require immediate human handling. Do not give veterinary diagnosis or treatment advice. When a customer-confirmed operational action is ready, respond ONLY as strict JSON: {"reply":"brief customer-safe reply","actions":[{"toolCode":"registered.tool","arguments":{}}]}. You may request at most 6 actions. Never include providerId, price, amount, payment status, refund amount, or other server-authoritative values. For a booking checkout chain, request schedule.reserve, then booking.create, then checkout.payment_order.create in that order. Use exactly these argument schemas: schedule.reserve={serviceCode:"grooming",petIds:["canonical-pet-id"],serviceAddress:"full address",servicePincode:"6-digit pincode",scheduledStart:"ISO timestamp",scheduledEnd:"ISO timestamp"}; booking.create={petIds:["canonical-pet-id"],packageCode:"catalogue package code",paymentMode:"prepaid"}; checkout.payment_order.create={}. Omit scheduleGroupId and bookingId because the runtime injects them from prior server results. Never claim an action succeeded in reply text; the PawSpace runtime replaces it with canonical execution results. For informational replies with no action, plain text is allowed.`;
/**
 * PawSpace AI on web chat is a sales agent, not a help desk: every conversation should end in a booking.
 * Persuasive, never deceptive - the price, offer and availability rules above still bind every word.
 */
export const WEB_CHAT_SALES_DIRECTIVE=`Sales role: you are PawSpace's sales agent. Your goal is to turn this conversation into a confirmed booking. Recommend the single best-fit package for the customer's pet and need, quote its exact price from the server-owned catalogue, explain in one or two lines why it is the right choice, and always end by asking for the booking (for example: "Shall I book this for you?"). Handle hesitation by addressing the concern and offering the next closest package. Mention subscriptions or multi-session packs from the catalogue when they save the customer money. Stay warm and confident, keep momentum, and never leave a reply without a clear next step. Never invent discounts, offers, limited-time deals, scarcity or availability; use only what the catalogue, approved knowledge or a governed tool supplied.`;
const CHANNEL_PROMPTS:Record<AiToolChannel,string>={
 chat:`Channel: Chat/Web. You may use short paragraphs, bullets, simple rich text, and a payment link only when a governed server tool supplied that exact link. Keep answers clear and action oriented.\n\n${WEB_CHAT_SALES_DIRECTIVE}`,
 whatsapp:`Channel: WhatsApp. You may use compact bullets and simple emphasis. Keep the response scannable and concise. Include payment links only when a governed server tool supplied the exact link.`,
 voice:`Channel: Voice/TTS. Speak naturally in short conversational sentences. No markdown, no bullets, no emojis, no URLs unless the caller explicitly asks for one, no tables, and no long monologues. Prefer one to three short sentences, then ask a brief follow-up when needed.`,
};
export function pawspaceChannelSystemPrompt(channel:AiToolChannel){return`${BASE_PROMPT}\n\n${CHANNEL_PROMPTS[channel]}`;}

const HUMAN_EXCEPTION_PATTERNS=[
 /\b(refund|money back|payment dispute|charged twice|wrong charge)\b/i,
 /\b(emergency|not breathing|collapsed|seizure|bleeding|poisoned|injured|accident)\b/i,
 /\b(provider|trainer|groomer|sitter|walker|driver).{0,24}\b(no[- ]?show|did not come|didn't come|not arrived|never arrived)\b/i,
 /\b(complaint|very unhappy|serious issue|escalate this|service failure)\b/i,
];
export function requiresImmediateHumanHandoff(input:string){return HUMAN_EXCEPTION_PATTERNS.some(pattern=>pattern.test(input));}
export function parseGroundedActionEnvelope(raw:string):{reply:string;actions:AiActionRequest[]}|null{
 let value=raw.trim();const fenced=value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);if(fenced)value=fenced[1].trim();if(!value.startsWith("{")||!value.endsWith("}"))return null;let parsed:unknown;try{parsed=JSON.parse(value)}catch{return null;}if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))return null;const row=parsed as Row,reply=text(row.reply),rawActions=row.actions;if(!Array.isArray(rawActions)||rawActions.length<1||rawActions.length>6)return null;const actions:AiActionRequest[]=[];for(const item of rawActions){if(!item||typeof item!=="object"||Array.isArray(item))return null;const action=item as Row,toolCode=text(action.toolCode) as AiToolCode;if(!ACTION_TOOLS.has(toolCode)||!action.arguments||typeof action.arguments!=="object"||Array.isArray(action.arguments))return null;actions.push({toolCode,arguments:action.arguments as Record<string,unknown>});}return{reply,actions};
}

async function canonicalRows(db:D1Database,sql:string){return(await db.prepare(sql).all<Row>()).results;}
function compact(rows:Row[],fields:string[]){return rows.slice(0,25).map(row=>Object.fromEntries(fields.filter(key=>row[key]!==undefined).map(key=>[key,row[key]])));}
export async function canonicalCatalogueSnapshot(db:D1Database){const[grooming,training,boarding,sitting,walking,taxi]=await Promise.all([
 canonicalRows(db,"SELECT package_code,name,base_price,currency,version FROM service_packages WHERE service_code='grooming' AND active=1 ORDER BY base_price"),
 canonicalRows(db,"SELECT package_code,name,sessions,validity_days,base_price,currency,version FROM training_commercial_packages WHERE active=1 ORDER BY sessions"),
 canonicalRows(db,"SELECT package_code,name,care_kind,max_hours,base_price_per_pet,currency,version FROM boarding_commercial_packages WHERE active=1 ORDER BY max_hours"),
 canonicalRows(db,"SELECT package_code,name,mode,base_price_per_pet,extra_pet_price,currency,version FROM sitting_commercial_packages WHERE active=1 ORDER BY base_price_per_pet"),
 canonicalRows(db,"SELECT package_code,name,duration_minutes,amount_per_walk,currency,version FROM walking_commercial_packages WHERE active=1 ORDER BY duration_minutes"),
 canonicalRows(db,"SELECT route_code,name,synthetic_distance_km,estimated_duration_minutes,amount,currency,version FROM taxi_route_classes WHERE active=1 ORDER BY synthetic_distance_km"),
]);return{
 grooming:compact(grooming,["package_code","name","base_price","currency","version"]),
 dogTraining:compact(training,["package_code","name","sessions","validity_days","base_price","currency","version"]),
 boarding:compact(boarding,["package_code","name","care_kind","max_hours","base_price_per_pet","currency","version"]),
 petSitting:compact(sitting,["package_code","name","mode","base_price_per_pet","extra_pet_price","currency","version"]),
 dogWalking:compact(walking,["package_code","name","duration_minutes","amount_per_walk","currency","version"]),
 petTaxi:compact(taxi,["route_code","name","synthetic_distance_km","estimated_duration_minutes","amount","currency","version"]),
 source:"server_owned_read_only_catalogue_tables"};}
function knowledgeRefs(result:unknown){if(!result||typeof result!=="object")return[]as string[];const value=(result as{result?:unknown}).result;if(!value||typeof value!=="object")return[];const rows=(value as{results?:unknown}).results;return Array.isArray(rows)?rows.map(row=>row&&typeof row==="object"?text((row as Row).id):"").filter(Boolean):[];}

export async function buildGroundedAiTurnContext(db:D1Database,input:{actor:AuthenticatedActor;threadId:string;customerId:string;intent:AiToolIntent;channel:AiToolChannel;query:string;canonicalContext:Record<string,unknown>}){
 const knowledge=await prepareAiToolExecution(db,{actor:input.actor,toolCode:"approved_knowledge.read",threadId:input.threadId,customerId:input.customerId,intent:input.intent,channel:input.channel,arguments:{query:input.query,visibilityScopes:["public"]}});
 const catalogueTool=(input.intent==="service_info"||input.intent==="booking_create")?await prepareAiToolExecution(db,{actor:input.actor,toolCode:"service_catalogue.read",threadId:input.threadId,customerId:input.customerId,intent:input.intent,channel:input.channel,arguments:{}}):null;
 const subscriptionTable=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='grooming_subscription_plans'").first<Row>();
 const today=new Date().toISOString().slice(0,10);const subscriptions=subscriptionTable?(await db.prepare("SELECT plan_code,name,city_id,zone_id,price,currency,session_count,validity_value,validity_unit,eligible_pet_types_json,service_package_code,credits_per_pet,max_pets_per_booking,pause_days,grace_days,terms_json,version FROM grooming_subscription_plans WHERE active=1 AND effective_from<=? AND (effective_to IS NULL OR effective_to>=?) ORDER BY city_id,plan_code LIMIT 30").bind(today,today).all<Row>()).results:[];
 const catalogue={...await canonicalCatalogueSnapshot(db),groomingSubscriptions:subscriptions};
 const serviceDirectory=(await listServiceControls(db)).map(service=>({code:service.code,name:service.name,group:service.group,enabled:service.enabled,disabledReason:service.disabledReason}));
 const operationalFaq={
  payments:"Use only server-confirmed payment information. Approved PawSpace knowledge supports secure Razorpay online payment and mentions UPI/GPay; do not claim additional methods without evidence.",
  cancellations:"Cancellation and reschedule eligibility is service-policy specific. Never promise a refund; refund and payment disputes go to a human reviewer.",
  operatingHours:"Do not invent fixed operating hours. State hours only when approved knowledge or a server scheduling/availability tool supplies them for the requested service/location."
 };
 return{context:{...input.canonicalContext,approvedKnowledge:knowledge,catalogueTool,catalogue,serviceDirectory,operationalFaq,groundingPolicy:{approvedCurrentOnly:true,readOnlyGrounding:true,carrierIndependent:true,mutationsAuthorizedOnlyViaGovernedActionPlane:true},availableActionTools:["schedule.reserve","booking.create","checkout.payment_order.create","booking.reschedule","booking.cancel","provider.assignment.execute_policy"]},groundingRefs:knowledgeRefs(knowledge)};
}

export async function buildRuntimeSystemPrompt(db:D1Database,input:{customerId:string;channel:AiToolChannel;dispatchItemId?:string|null;asOf?:number}){let prompt=pawspaceChannelSystemPrompt(input.channel);if(input.channel!=="voice"&&input.channel!=="whatsapp")return prompt;const sales=input.dispatchItemId?await import("./ai-sales-goal-orchestrator").then(({buildSalesPromptContext})=>buildSalesPromptContext(db,{dispatchItemId:input.dispatchItemId!,customerId:input.customerId,channel:input.channel as "voice"|"whatsapp",asOf:input.asOf})):await latestSalesPromptContext(db,{customerId:input.customerId,channel:input.channel as "voice"|"whatsapp",asOf:input.asOf});if(sales)prompt+=`\n\n${renderProtectedQuotaDirective(sales)}`;return prompt;}

export async function createGroundedAiRuntimeProvider(db:D1Database,actor:AuthenticatedActor,channel:AiToolChannel,options:{dispatchItemId?:string|null;salesService?:VoiceSalesService}={}):Promise<AiResponseProvider>{const connection=await aiProviderConnection(channel),providerTimeoutMs=channel==="chat"?Math.min(connection.timeoutMs,CHAT_PROVIDER_TIMEOUT_MS):connection.timeoutMs,deadlineMs=channel==="chat"?Math.min(connection.timeoutMs,CHAT_ORCHESTRATOR_DEADLINE_MS):connection.timeoutMs;return{salesService:options.salesService,status:connection.connected?"connected":"not_connected",provider:connection.providerRef||"not_connected",modelRef:connection.modelRef,deadlineMs,async generate(input:AiProviderInput){if(requiresImmediateHumanHandoff(input.inputText))return{text:"",provider:connection.providerRef||"not_connected",modelRef:connection.modelRef,latencyMs:0,unsupported:true,highImpactAction:true};const grounded=await buildGroundedAiTurnContext(db,{actor,threadId:input.threadId,customerId:input.customerId,intent:input.intent.intent as AiToolIntent,channel,query:input.inputText,canonicalContext:input.context});let systemPrompt=await buildRuntimeSystemPrompt(db,{customerId:input.customerId,channel,dispatchItemId:options.dispatchItemId});if(options.salesService){systemPrompt+=`\n\n${specialistSalesPrompt(options.salesService)}`;Object.assign(grounded.context,{salesService:options.salesService,conversationHistory:await specialistConversationHistory(db,input.threadId,input.customerId)});if(options.salesService==="dog_training")grounded.context.catalogueTool=null;}const result=await requestAiDraft({systemPrompt,userPrompt:JSON.stringify({channel,customerMessage:input.inputText,intent:input.intent,canonicalContext:grounded.context}),channel,intent:input.intent.intent,maxTokens:channel==="voice"?450:1200,timeoutMs:providerTimeoutMs});if(!result.connected)return{text:"",provider:connection.providerRef||"not_connected",modelRef:connection.modelRef,latencyMs:0,failure:result.failure};const envelope=parseGroundedActionEnvelope(result.text),reply=envelope?.reply||result.text;return{text:reply,provider:result.providerRef,modelRef:result.modelRef,latencyMs:result.latencyMs,referencedCustomerIds:[input.customerId],groundingRefs:grounded.groundingRefs,catalogueVerifiedPrices:pricesMatchCatalogue(reply,grounded.context.catalogue),highImpactAction:false,actionRequests:envelope?.actions};}};}

/**
 * Every rupee amount in a reply is a real price in the server-owned catalogue supplied for this turn.
 *
 * A sales reply has to quote prices. The output safety check used to hand the customer to a person for
 * any mention of price unless an approved knowledge row was cited, which made a price quote impossible
 * even when it came straight from the catalogue. This is the narrower, stronger check: the amounts
 * themselves are compared against the catalogue, so an invented or altered price still fails.
 */
export function pricesMatchCatalogue(reply:string,catalogue:unknown){
 /* An amount counts only against the service it belongs to: it must be a price in a catalogue row whose
  * package, or whose service, the reply actually names. A taxi fare of 499 does not ground "grooming for
  * 499". */
 const lower=reply.toLowerCase(),groups=catalogue&&typeof catalogue==="object"?Object.entries(catalogue as Row):[];
 const rows:Array<{amounts:Set<number>;named:boolean}>=[];
 for(const[group,value]of groups){
  if(!Array.isArray(value))continue;
  const serviceNamed=Object.entries(SERVICE_GROUP_WORDS).some(([key,pattern])=>group===key&&pattern.test(lower));
  for(const item of value){
   if(!item||typeof item!=="object")continue;const row=item as Row,amounts=new Set<number>();
   for(const[key,field]of Object.entries(row))if(/price|amount/i.test(key)&&Number.isFinite(Number(field))&&Number(field)>0)amounts.add(Math.round(Number(field)));
   const name=text(row.name).toLowerCase();
   if(amounts.size)rows.push({amounts,named:serviceNamed||(name.length>2&&lower.includes(name))});
  }
 }
 // Each amount starts at a digit that does not continue a number, so matching stays linear in the reply.
 const amounts=[...reply.slice(0,8000).matchAll(/(?:₹|\brs\.?|\binr)\s*(\d[\d,]*(?:\.\d+)?)|(?<![\d,.])(\d[\d,]*(?:\.\d+)?)\s*(?:rupees|\/-)/gi)].map(match=>Math.round(Number(String(match[1]||match[2]).replace(/,/g,"")))).filter(Number.isFinite);
 return amounts.every(amount=>rows.some(row=>row.named&&row.amounts.has(amount)));
}
/** The words that name each catalogue group's service in a reply. */
const SERVICE_GROUP_WORDS:Record<string,RegExp>={grooming:/groom/,groomingSubscriptions:/groom/,dogTraining:/train/,boarding:/board|stay/,petSitting:/sitt/,dogWalking:/walk/,petTaxi:/taxi|cab|ride/};


/** Only persisted, same-customer turns enter sales memory; caller-supplied chat history is not trusted. */
async function specialistConversationHistory(db:D1Database,threadId:string,customerId:string){
 const rows=await db.prepare("SELECT m.payload_json,t.output_text FROM ai_conversation_turns t JOIN communication_messages m ON m.id=t.input_message_id AND m.thread_id=t.thread_id AND m.customer_id=t.customer_id WHERE t.thread_id=? AND t.customer_id=? ORDER BY t.created_at DESC,t.rowid DESC LIMIT 6").bind(threadId,customerId).all<Row>();
 return rows.results.reverse().flatMap(row=>{let payload:Row={};try{payload=JSON.parse(text(row.payload_json))as Row;}catch{}return[{role:"user",text:text(payload.text).slice(0,600)},{role:"assistant",text:text(row.output_text).slice(0,1000)}];});
}
