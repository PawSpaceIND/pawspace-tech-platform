import{aiProviderConnection,requestAiDraft}from"./ai-provider-adapter";
import{prepareAiToolExecution,type AiToolChannel,type AiToolIntent}from"./ai-tool-registry";
import type{AiActionRequest,AiProviderInput,AiResponseProvider}from"./ai-conversation-orchestrator";
import type{AiToolCode}from"./ai-tool-registry";
import type{AuthenticatedActor}from"./server-auth";
import{latestSalesPromptContext,renderProtectedQuotaDirective}from"./ai-sales-goal-orchestrator";

type Row=Record<string,unknown>;
const text=(value:unknown)=>String(value??"").trim();

const ACTION_TOOLS=new Set<AiToolCode>(["schedule.reserve","booking.create","checkout.payment_order.create","booking.reschedule","booking.cancel","provider.assignment.execute_policy"]);
const BASE_PROMPT=`You are the PawSpace AI concierge for pet parents in India. Use only the canonical context and approved PawSpace knowledge supplied for this turn. Never invent a service, price, discount, availability, policy, booking state, provider state, payment state, or completed action. Prices and service facts must come from the server-owned catalogue snapshot or approved knowledge in the supplied context. If the requested fact is missing or ambiguous, say you are not certain and hand off rather than guessing. Never issue or promise refunds, capture payments, change prices, activate campaigns, merge customers, or send an outbound communication without the required governed authority. You may reserve capacity, create a canonical booking, create a Razorpay payment order, execute a policy-safe reschedule/cancellation, or trigger deterministic provider assignment only through the registered governed action tools and only when the tool confirms success; the policy engine, not the model, chooses provider eligibility and assignment. Pet emergencies, safety concerns, refund or payment disputes, provider no-shows, and complex complaints require immediate human handling. Do not give veterinary diagnosis or treatment advice. When a customer-confirmed operational action is ready, respond ONLY as strict JSON: {"reply":"brief customer-safe reply","actions":[{"toolCode":"registered.tool","arguments":{}}]}. You may request at most 6 actions. Never include providerId, price, amount, payment status, refund amount, or other server-authoritative values. For a booking checkout chain, request schedule.reserve, then booking.create, then checkout.payment_order.create in that order; omit scheduleGroupId and bookingId when they must come from the prior server result. Never claim an action succeeded in reply text; the PawSpace runtime replaces it with canonical execution results. For informational replies with no action, plain text is allowed.`;
const CHANNEL_PROMPTS:Record<AiToolChannel,string>={
 chat:`Channel: Chat/Web. You may use short paragraphs, bullets, simple rich text, and a payment link only when a governed server tool supplied that exact link. Keep answers clear and action oriented.`,
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
 const value=raw.trim();if(!value.startsWith("{")||!value.endsWith("}"))return null;let parsed:unknown;try{parsed=JSON.parse(value)}catch{return null;}if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))return null;const row=parsed as Row,reply=text(row.reply),rawActions=row.actions;if(!Array.isArray(rawActions)||rawActions.length<1||rawActions.length>6)return null;const actions:AiActionRequest[]=[];for(const item of rawActions){if(!item||typeof item!=="object"||Array.isArray(item))return null;const action=item as Row,toolCode=text(action.toolCode) as AiToolCode;if(!ACTION_TOOLS.has(toolCode)||!action.arguments||typeof action.arguments!=="object"||Array.isArray(action.arguments))return null;actions.push({toolCode,arguments:action.arguments as Record<string,unknown>});}return{reply,actions};
}

async function canonicalRows(db:D1Database,sql:string){return(await db.prepare(sql).all<Row>()).results;}
function compact(rows:Row[],fields:string[]){return rows.slice(0,25).map(row=>Object.fromEntries(fields.filter(key=>row[key]!==undefined).map(key=>[key,row[key]])));}
async function canonicalCatalogueSnapshot(db:D1Database){const[grooming,training,boarding,sitting,walking,taxi]=await Promise.all([
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
 const catalogue=await canonicalCatalogueSnapshot(db);
 const operationalFaq={
  payments:"Use only server-confirmed payment information. Approved PawSpace knowledge supports secure Razorpay online payment and mentions UPI/GPay; do not claim additional methods without evidence.",
  cancellations:"Cancellation and reschedule eligibility is service-policy specific. Never promise a refund; refund and payment disputes go to a human reviewer.",
  operatingHours:"Do not invent fixed operating hours. State hours only when approved knowledge or a server scheduling/availability tool supplies them for the requested service/location."
 };
 return{context:{...input.canonicalContext,approvedKnowledge:knowledge,catalogueTool,catalogue,operationalFaq,groundingPolicy:{approvedCurrentOnly:true,readOnlyGrounding:true,carrierIndependent:true,mutationsAuthorizedOnlyViaGovernedActionPlane:true},availableActionTools:["schedule.reserve","booking.create","checkout.payment_order.create","booking.reschedule","booking.cancel","provider.assignment.execute_policy"]},groundingRefs:knowledgeRefs(knowledge)};
}

export async function buildRuntimeSystemPrompt(db:D1Database,input:{customerId:string;channel:AiToolChannel;dispatchItemId?:string|null;asOf?:number}){let prompt=pawspaceChannelSystemPrompt(input.channel);if(input.channel!=="voice"&&input.channel!=="whatsapp")return prompt;const salesChannel=input.channel;const sales=input.dispatchItemId?await import("./ai-sales-goal-orchestrator").then(({buildSalesPromptContext})=>buildSalesPromptContext(db,{dispatchItemId:input.dispatchItemId!,customerId:input.customerId,channel:salesChannel,asOf:input.asOf})):await latestSalesPromptContext(db,{customerId:input.customerId,channel:salesChannel,asOf:input.asOf});if(sales)prompt+=`\n\n${renderProtectedQuotaDirective(sales)}`;return prompt;}

export async function createGroundedAiRuntimeProvider(db:D1Database,actor:AuthenticatedActor,channel:AiToolChannel,options:{dispatchItemId?:string|null}={}):Promise<AiResponseProvider>{const connection=await aiProviderConnection();return{status:connection.connected?"connected":"not_connected",provider:connection.providerRef||"not_connected",modelRef:connection.modelRef,deadlineMs:connection.timeoutMs,async generate(input:AiProviderInput){if(requiresImmediateHumanHandoff(input.inputText))return{text:"",provider:connection.providerRef||"not_connected",modelRef:connection.modelRef,latencyMs:0,unsupported:true,highImpactAction:true};const grounded=await buildGroundedAiTurnContext(db,{actor,threadId:input.threadId,customerId:input.customerId,intent:input.intent.intent as AiToolIntent,channel,query:input.inputText,canonicalContext:input.context});const systemPrompt=await buildRuntimeSystemPrompt(db,{customerId:input.customerId,channel,dispatchItemId:options.dispatchItemId});const result=await requestAiDraft({systemPrompt,userPrompt:JSON.stringify({channel,customerMessage:input.inputText,intent:input.intent,canonicalContext:grounded.context}),maxTokens:channel==="voice"?450:1200});if(!result.connected)return{text:"",provider:connection.providerRef||"not_connected",modelRef:connection.modelRef,latencyMs:0,unsupported:true};const envelope=parseGroundedActionEnvelope(result.text);return{text:envelope?.reply||result.text,provider:result.providerRef,modelRef:result.modelRef,latencyMs:result.latencyMs,referencedCustomerIds:[input.customerId],groundingRefs:grounded.groundingRefs,highImpactAction:false,actionRequests:envelope?.actions};}};}
