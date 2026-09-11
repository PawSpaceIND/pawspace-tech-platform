import{parseMetaWhatsAppWebhook,verifyMetaWebhookChallenge,verifyMetaWhatsAppSignature}from"../../../../lib/meta-whatsapp-webhook";
import{captureInboundWebhook,runInboundWebhookAttempt}from"../../../../lib/gateway-inbound-queue";
import{readBoundedRequestText,VoiceFetchRefused}from"../../../../lib/voice-safe-fetch";
import{processMetaEnvelope}from"../../../../lib/meta-whatsapp-inbound-processing";

async function bindings(){const{env}=await import("cloudflare:workers");return env as unknown as{DB:D1Database;META_WHATSAPP_APP_SECRET?:string;META_WHATSAPP_VERIFY_TOKEN?:string;META_WHATSAPP_ACCESS_TOKEN?:string;META_WHATSAPP_UAT_ACCESS_TOKEN?:string;META_WHATSAPP_GRAPH_VERSION?:string;PAWSPACE_MEDIA_BUCKET?:unknown};}
const noStore={"cache-control":"no-store"};
const text=(value:unknown)=>String(value??"").trim();
const MAX_WEBHOOK_BYTES=262_144;

export async function GET(request:Request){const env=await bindings(),challenge=verifyMetaWebhookChallenge(new URL(request.url),String(env.META_WHATSAPP_VERIFY_TOKEN||""));if(!challenge)return new Response("Webhook verification rejected",{status:403,headers:noStore});return new Response(challenge,{status:200,headers:{...noStore,"content-type":"text/plain; charset=utf-8"}});}

export async function POST(request:Request){
 const env=await bindings();
 let rawBody:string;
 try{rawBody=await readBoundedRequestText(request,MAX_WEBHOOK_BYTES);}catch(error){
  if(error instanceof VoiceFetchRefused)return Response.json({ok:false,error:"Meta webhook payload is too large",externalDelivery:false},{status:413,headers:noStore});
  throw error;
 }
 const signature=request.headers.get("x-hub-signature-256"),secret=String(env.META_WHATSAPP_APP_SECRET||"");if(!secret)return Response.json({ok:false,error:"Meta WhatsApp webhook is not configured",externalDelivery:false},{status:503,headers:noStore});if(!await verifyMetaWhatsAppSignature(rawBody,signature,secret))return Response.json({ok:false,error:"Invalid Meta webhook signature",externalDelivery:false},{status:401,headers:noStore});
 let payload:unknown;try{payload=JSON.parse(rawBody);}catch{return Response.json({ok:false,error:"Invalid webhook JSON",externalDelivery:false},{status:400,headers:noStore});}
 const parsed=parseMetaWhatsAppWebhook(payload);if(parsed.length===0)return Response.json({ok:true,accepted:0,results:[],externalDelivery:false},{status:200,headers:noStore});
 const eventId=parsed.map(event=>event.eventId).filter(Boolean).join("|").slice(0,512),messageId=parsed.find(event=>event.kind==="message")?.eventId||null;if(!eventId)return Response.json({ok:false,error:"Meta webhook event ID is required",externalDelivery:false},{status:400,headers:noStore});
 try{
  const captured=await captureInboundWebhook(env.DB,{provider:"meta_whatsapp",routeKey:"meta-whatsapp-webhook",environment:"sandbox",eventId,messageId,rawBody,headers:request.headers});const status=text(captured.row.status);if(status==="PROCESSED")return Response.json({ok:true,duplicatePrevented:true,status,externalDelivery:false},{status:200,headers:noStore});if(status==="DEAD_LETTER")return Response.json({ok:false,duplicatePrevented:true,status,externalDelivery:false},{status:503,headers:noStore});
  const attempt=await runInboundWebhookAttempt(env.DB,{queueId:text(captured.row.id),workerId:`meta-webhook:${crypto.randomUUID()}`,handler:async({rawBody})=>processMetaEnvelope(env as unknown as Record<string,unknown>&{DB:D1Database},rawBody)});if(!attempt.claimed)return Response.json({ok:true,queued:true,duplicatePrevented:true,status,externalDelivery:false},{status:202,headers:noStore});if(!attempt.ok){const code=attempt.error instanceof Response?attempt.error.status:503;return Response.json({ok:false,queued:true,status:attempt.failure.status,error:attempt.error instanceof Response?await attempt.error.text():"Meta WhatsApp webhook processing failed",externalDelivery:false},{status:code>=400&&code<500?code:503,headers:noStore});}
  const result=attempt.result as Record<string,unknown>;return Response.json({ok:true,...result,queued:true,duplicatePrevented:captured.duplicatePrevented},{status:200,headers:noStore});
 }catch(error){if(error instanceof Response)return Response.json({ok:false,error:await error.text(),externalDelivery:false},{status:error.status,headers:noStore});return Response.json({ok:false,error:"Meta WhatsApp webhook processing failed",externalDelivery:false},{status:500,headers:noStore});}
}
