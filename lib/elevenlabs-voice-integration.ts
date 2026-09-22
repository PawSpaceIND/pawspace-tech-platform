import {buildCustomer360} from "./customer-360";
import {startInboundAiVoiceSession} from "./inbound-ai-telephony";
import {aiModelRef,aiProviderRef} from "./ai-provider-adapter";

type Env=Record<string,unknown>;
type Row=Record<string,unknown>;
const text=(value:unknown)=>String(value??"").trim();
export const ELEVENLABS_EXOTEL_INDIA_WS="wss://api.in.residency.elevenlabs.io/v1/convai/conversation/exotel";
export const DEFAULT_ELEVENLABS_OPENAI_MODEL="gpt-5.6-luna";

export function elevenLabsVoiceConfigured(env:Env){
 return Boolean(text(env.ELEVENLABS_API_KEY)&&text(env.ELEVENLABS_AGENT_ID)&&text(env.ELEVENLABS_INIT_WEBHOOK_SECRET));
}

export function elevenLabsVoiceReadiness(env:Env){
 const missing=["ELEVENLABS_API_KEY","ELEVENLABS_AGENT_ID","ELEVENLABS_INIT_WEBHOOK_SECRET"].filter(key=>!text(env[key]));
 const enabled=text(env.PAWSPACE_VOICE_RUNTIME).toLowerCase()==="elevenlabs";
 const residency=text(env.ELEVENLABS_RESIDENCY).toLowerCase();
 const provider=aiProviderRef(env),model=aiModelRef(env,"voice").modelRef;
 return{
  runtime:"elevenlabs" as const,
  enabled,
  configured:missing.length===0,
  missing,
  agentIdConfigured:Boolean(text(env.ELEVENLABS_AGENT_ID)),
  indiaResidency:["in","india","in-residency"].includes(residency),
  residency:residency||null,
  exotelWebSocket:text(env.ELEVENLABS_EXOTEL_WS)||ELEVENLABS_EXOTEL_INDIA_WS,
  intelligenceProvider:provider,
  intelligenceModel:model,
  productionReady:false,
  reason:!enabled?"ElevenLabs runtime is not selected":missing.length?"ElevenLabs credentials are incomplete":"Configuration present; live carrier proof is still required",
 };
}

export function assertElevenLabsVoiceConfigured(env:Env){
 if(!elevenLabsVoiceConfigured(env))throw new Response("ElevenLabs voice integration is not fully configured",{status:503});
}

export function assertElevenLabsInitWebhook(request:Request,env:Env){
 const configured=text(env.ELEVENLABS_INIT_WEBHOOK_SECRET);
 if(!configured)throw new Response("ElevenLabs initiation webhook is not configured",{status:503});
 const supplied=text(request.headers.get("authorization")).replace(/^Bearer\s+/i,"");
 if(!supplied||supplied.length!==configured.length)throw new Response("ElevenLabs initiation webhook authorization refused",{status:401});
 let diff=0;for(let i=0;i<configured.length;i++)diff|=configured.charCodeAt(i)^supplied.charCodeAt(i);
 if(diff!==0)throw new Response("ElevenLabs initiation webhook authorization refused",{status:401});
}

function recentOpenCase(customer:Row){
 const support=Array.isArray(customer.supportCases)?customer.supportCases as Row[]:[];
 const tickets=Array.isArray(customer.tickets)?customer.tickets as Row[]:[];
 return [...support,...tickets].filter(item=>!["resolved","closed"].includes(text(item.status).toLowerCase())).sort((a,b)=>Number(b.updatedAt||0)-Number(a.updatedAt||0))[0]||null;
}

export async function buildElevenLabsInitiation(db:D1Database,input:{providerCallId:string;callerId:string;conversationId:string;agentId:string;language?:string|null},env:Env={}){
 if(!text(input.providerCallId)||!text(input.callerId)||!text(input.conversationId))throw new Response("ElevenLabs call identity is incomplete",{status:400});
 const session=await startInboundAiVoiceSession(db,{providerCallId:input.providerCallId,caller:input.callerId,language:input.language||null});
 const records=await buildCustomer360(db,session.customerId),customer=(records[0]||{}) as Row;
 const pets=Array.isArray(customer.pets)?customer.pets as Row[]:[];
 const bookings=Array.isArray(customer.bookings)?customer.bookings as Row[]:[];
 const recent=(bookings[0]||{}) as Row,openCase=recentOpenCase(customer);
 return{
  type:"conversation_initiation_client_data" as const,
  dynamic_variables:{
   pawspace_customer_id:session.customerId,
   pawspace_voice_session_id:session.sessionId,
   pawspace_thread_id:session.threadId,
   customer_name:text(customer.name)||"Customer",
   pet_names:pets.slice(0,5).map(p=>text(p.name)).filter(Boolean).join(", "),
   recent_service:text(recent.serviceCode),
   recent_booking_status:text(recent.status),
   open_case:Boolean(openCase),
   open_case_type:text(openCase?.caseType||openCase?.category),
   preferred_language:text(input.language)||"auto",
   elevenlabs_conversation_id:input.conversationId,
  },
  environment:text(env.PAWSPACE_DEPLOYMENT_ENV)||"unknown",
  user_id:session.customerId,
 };
}
