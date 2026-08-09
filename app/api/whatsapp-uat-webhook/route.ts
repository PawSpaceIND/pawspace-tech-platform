import{database}from"../../../lib/server-auth";
import{recordWhatsAppUatDelivery,recordWhatsAppUatInbound,whatsappUatProviders,type WhatsAppUatProvider}from"../../../lib/whatsapp-uat-adapter";

type Payload=Record<string,unknown>;
const json=(value:unknown,status=200)=>Response.json(value,{status});
const deliveryEvents=new Set(["accepted","sent","delivered","read","failed"]);

function hex(bytes:ArrayBuffer){return Array.from(new Uint8Array(bytes)).map(byte=>byte.toString(16).padStart(2,"0")).join("");}
function safeEqual(a:string,b:string){if(a.length!==b.length)return false;let result=0;for(let i=0;i<a.length;i++)result|=a.charCodeAt(i)^b.charCodeAt(i);return result===0;}
async function hmac(secret:string,body:string){const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);return hex(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(body)));}
async function sha256(body:string){return hex(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(body)));}

export async function POST(request:Request){
 try{
  const{env}=await import("cloudflare:workers");const runtime=env as unknown as Record<string,unknown>,environment=String(runtime.PAWSPACE_WHATSAPP_ENV||"uat").toLowerCase();
  if(!["uat","sandbox"].includes(environment))return json({error:"WhatsApp Gate 5 webhook is locked to UAT/sandbox until production launch approval"},503);
  const secret=String(runtime.PAWSPACE_WHATSAPP_UAT_WEBHOOK_SECRET||"");
  if(!secret)return json({error:"WhatsApp UAT webhook secret is not configured"},503);
  const signature=(request.headers.get("x-pawspace-signature")||"").trim().toLowerCase(),eventId=(request.headers.get("x-pawspace-event-id")||"").trim(),provider=(request.headers.get("x-pawspace-whatsapp-provider")||"sandbox_simulator").trim() as WhatsAppUatProvider;
  if(!signature||!eventId)return json({error:"WhatsApp UAT signature and event ID are required"},400);
  if(!whatsappUatProviders.includes(provider))return json({error:"Unsupported WhatsApp UAT provider"},400);
  const raw=await request.text(),expected=await hmac(secret,raw);
  if(!safeEqual(expected,signature))return json({error:"Invalid WhatsApp UAT webhook signature"},401);
  let payload:Payload;try{payload=JSON.parse(raw)as Payload;}catch{return json({error:"Invalid WhatsApp UAT webhook JSON"},400);}
  const eventType=String(payload.type||"inbound_message"),payloadHash=await sha256(raw),db=await database();
  if(eventType==="inbound_message"){
   const customerId=String(payload.customerId||"").trim(),message=String(payload.text||payload.message||"").trim();
   if(!customerId||!message)return json({error:"Canonical customerId and inbound text are required"},400);
   const result=await recordWhatsAppUatInbound(db,{provider,eventId,payloadHash,customerId,text:message,receivedAt:payload.receivedAt?Number(payload.receivedAt):undefined,detail:{providerMessageId:payload.providerMessageId??null}});
   return json({ok:true,environment:"uat",externalDelivery:false,data:result},result.duplicatePrevented?200:201);
  }
  if(eventType==="delivery_event"){
   const messageId=String(payload.messageId||"").trim(),status=String(payload.eventType||"");
   if(!messageId||!deliveryEvents.has(status))return json({error:"Canonical messageId and valid delivery event are required"},400);
   const result=await recordWhatsAppUatDelivery(db,{provider,eventId,messageId,eventType:status as"accepted"|"sent"|"delivered"|"read"|"failed",payloadHash,detail:{providerReference:payload.providerReference??null,reason:payload.reason??null}});
   return json({ok:true,environment:"uat",externalDelivery:false,data:result});
  }
  return json({error:"Unsupported WhatsApp UAT event type"},400);
 }catch(error){if(error instanceof Response)return error;return json({error:error instanceof Error?error.message:"Unable to process WhatsApp UAT webhook"},500);}
}
