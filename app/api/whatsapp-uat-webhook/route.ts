import{authError,database,type AuthenticatedActor}from"../../../lib/server-auth";
import{orchestrateAiTurn}from"../../../lib/ai-conversation-orchestrator";
import{recordWhatsAppUatDelivery,recordWhatsAppUatInbound,whatsappUatProviders,type WhatsAppUatProvider}from"../../../lib/whatsapp-uat-adapter";
import{captureInboundWebhook,runInboundWebhookAttempt}from"../../../lib/gateway-inbound-queue";

type Payload=Record<string,unknown>;
const json=(value:unknown,status=200)=>Response.json(value,{status});
const deliveryEvents=new Set(["accepted","sent","delivered","read","failed"]);
const systemActor:AuthenticatedActor={email:"whatsapp-uat@pawspace.system",name:"WhatsApp UAT Adapter",roleCode:"system_adapter",permissions:["communications.message","customers.manage"],developmentPreview:false,identitySource:"workspace",principalType:"email",principalKey:"whatsapp-uat@pawspace.system"};
const text=(value:unknown)=>String(value??"").trim();
function hex(bytes:ArrayBuffer){return Array.from(new Uint8Array(bytes)).map(byte=>byte.toString(16).padStart(2,"0")).join("");}
function safeEqual(a:string,b:string){if(a.length!==b.length)return false;let result=0;for(let i=0;i<a.length;i++)result|=a.charCodeAt(i)^b.charCodeAt(i);return result===0;}
async function hmac(secret:string,body:string){const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);return hex(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(body)));}
async function sha256(body:string){return hex(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(body)));}

async function processUat(db:D1Database,provider:WhatsAppUatProvider,eventId:string,raw:string){
 const payload=JSON.parse(raw)as Payload,eventType=text(payload.type)||"inbound_message",payloadHash=await sha256(raw);
 if(eventType==="inbound_message"){
  const customerId=text(payload.customerId)||null,providerIdentity=text(payload.phone||payload.providerIdentity)||null,message=text(payload.text||payload.message);if(!message)throw new Response("Inbound WhatsApp text is required",{status:400});
  const result=await recordWhatsAppUatInbound(db,{provider,eventId,payloadHash,customerId,providerIdentity,text:message,receivedAt:payload.receivedAt?Number(payload.receivedAt):undefined,detail:{providerMessageId:payload.providerMessageId??null}});if(result.duplicatePrevented)return{environment:"uat",externalDelivery:false,data:result};
  const ai=await orchestrateAiTurn(db,{actor:systemActor,threadId:result.threadId,customerId:result.customerId,inputMessageId:result.messageId,idempotencyKey:`whatsapp-uat-ai:${provider}:${eventId}`,channel:"whatsapp"});return{environment:"uat",externalDelivery:false,data:result,orchestrator:{outcome:ai.turn?.outcome??null,handoffReason:ai.turn?.handoffReason??null,autonomousExecution:false}};
 }
 if(eventType==="delivery_event"){
  const messageId=text(payload.messageId),status=text(payload.eventType);if(!messageId||!deliveryEvents.has(status))throw new Response("Canonical messageId and valid delivery event are required",{status:400});
  const result=await recordWhatsAppUatDelivery(db,{provider,eventId,messageId,eventType:status as"accepted"|"sent"|"delivered"|"read"|"failed",payloadHash,detail:{providerReference:payload.providerReference??null,reason:payload.reason??null}});return{environment:"uat",externalDelivery:false,data:result};
 }
 throw new Response("Unsupported WhatsApp UAT event type",{status:400});
}

async function publicAttemptError(error:unknown){if(!(error instanceof Response))return"WhatsApp UAT processing failed";const message=await error.text();if(error.status===400&&["Inbound WhatsApp text is required","Canonical messageId and valid delivery event are required","Unsupported WhatsApp UAT event type"].includes(message))return message;return"WhatsApp UAT processing failed";}

export async function POST(request:Request){
 try{
  const{env}=await import("cloudflare:workers");const runtime=env as unknown as Record<string,unknown>,environment=text(runtime.PAWSPACE_WHATSAPP_ENV||"uat").toLowerCase();if(!["uat","sandbox"].includes(environment))return json({error:"WhatsApp Gate 5 webhook is locked to UAT/sandbox until production launch approval"},503);
  const secret=text(runtime.PAWSPACE_WHATSAPP_UAT_WEBHOOK_SECRET);if(!secret)return json({error:"WhatsApp UAT webhook secret is not configured"},503);
  const signature=text(request.headers.get("x-pawspace-signature")).toLowerCase(),eventId=text(request.headers.get("x-pawspace-event-id")),provider=text(request.headers.get("x-pawspace-whatsapp-provider")||"sandbox_simulator") as WhatsAppUatProvider;if(!signature||!eventId)return json({error:"WhatsApp UAT signature and event ID are required"},400);if(!whatsappUatProviders.includes(provider))return json({error:"Unsupported WhatsApp UAT provider"},400);
  const raw=await request.text(),expected=await hmac(secret,raw);if(!safeEqual(expected,signature))return json({error:"Invalid WhatsApp UAT webhook signature"},401);let payload:Payload;try{payload=JSON.parse(raw)as Payload;}catch{return json({error:"Invalid WhatsApp UAT webhook JSON"},400);}
  const eventType=text(payload.type)||"inbound_message",messageId=eventType==="delivery_event"?text(payload.messageId)||null:text(payload.providerMessageId)||null,db=await database();if(eventType==="delivery_event"&&!messageId)return json({error:"Canonical messageId is required"},400);
  const captured=await captureInboundWebhook(db,{provider,routeKey:"whatsapp-uat-webhook",environment:environment==="sandbox"?"sandbox":"uat",eventId,messageId,rawBody:raw,headers:request.headers});const status=text(captured.row.status);if(status==="PROCESSED")return json({ok:true,duplicatePrevented:true,status,environment:"uat",externalDelivery:false});if(status==="DEAD_LETTER")return json({ok:false,duplicatePrevented:true,status,environment:"uat",externalDelivery:false},503);
  const attempt=await runInboundWebhookAttempt(db,{queueId:text(captured.row.id),workerId:`whatsapp-uat:${crypto.randomUUID()}`,handler:async({rawBody})=>processUat(db,provider,eventId,rawBody)});if(!attempt.claimed)return json({ok:true,queued:true,duplicatePrevented:true,status,environment:"uat",externalDelivery:false},202);if(!attempt.ok){const code=attempt.error instanceof Response?attempt.error.status:503,error=await publicAttemptError(attempt.error);return json({ok:false,queued:true,status:attempt.failure.status,error,environment:"uat",externalDelivery:false},code>=400&&code<500?code:503);}
  const result=attempt.result as Record<string,unknown>;return json({ok:true,...result,queued:true,duplicatePrevented:captured.duplicatePrevented},eventType==="inbound_message"?201:200);
 }catch(error){return authError(error,"Unable to process WhatsApp UAT webhook");}
}
