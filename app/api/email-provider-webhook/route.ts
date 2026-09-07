import { ingestInboundEmail, recordEmailEngagement, syncCalendarEvents } from "../../../lib/crm-email-sync";
import { authError } from "../../../lib/server-auth";
import { captureInboundWebhook, runInboundWebhookAttempt } from "../../../lib/gateway-inbound-queue";

type Env = { DB: D1Database; PAWSPACE_EMAIL_WEBHOOK_SECRET?: string; PAWSPACE_PAYMENT_ENV?: string };
const text = (v: unknown) => String(v ?? "").trim();
const encoder = new TextEncoder();

async function runtimeEnv(): Promise<Env> { const { env } = await import("cloudflare:workers"); return env as unknown as Env; }
function hex(bytes: ArrayBuffer) { return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, "0")).join(""); }
function constantTimeEqual(a: string, b: string) { if (a.length !== b.length) return false; let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i); return diff === 0; }
async function verifySignature(raw: string, secret: string, supplied: string) { const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); const expected = hex(await crypto.subtle.sign("HMAC", key, encoder.encode(raw))); const normalized = supplied.toLowerCase().replace(/^sha256=/, ""); return constantTimeEqual(expected, normalized); }

async function processEmailWebhook(db:D1Database,raw:string){
 const body=JSON.parse(raw) as Record<string,unknown>,provider=text(body.provider)||"email_provider",eventType=text(body.eventType||body.type),eventId=text(body.eventId),messageId=text(body.messageId);
 if(!eventId)throw new Response("Email webhook event ID is required",{status:400});
 if(eventType==="inbound"){
  if(!messageId)throw new Response("Email webhook message ID is required",{status:400});
  return ingestInboundEmail(db,{provider,providerEventId:eventId,providerMessageId:messageId,from:text(body.from),to:text(body.to),subject:text(body.subject),textBody:text(body.text||body.body),receivedAt:body.occurredAt==null?undefined:Number(body.occurredAt)});
 }
 if(["delivered","open","click","bounce","complaint"].includes(eventType)){
  if(!messageId)throw new Response("Email webhook message ID is required",{status:400});
  return recordEmailEngagement(db,{provider,providerEventId:eventId,providerMessageId:messageId,eventType:eventType as "delivered"|"open"|"click"|"bounce"|"complaint",occurredAt:body.occurredAt==null?undefined:Number(body.occurredAt),detail:(body.detail||{}) as Record<string,unknown>});
 }
 if(eventType==="calendar_sync"){
  const events=Array.isArray(body.events)?body.events as Array<{id:string;attendeeEmail?:string;title:string;startAt:number;endAt:number;status?:string;detail?:Record<string,unknown>}>:[];
  return syncCalendarEvents(db,{provider,events});
 }
 throw new Response("Unsupported email webhook event",{status:400});
}

export async function POST(request: Request) {
 try{
  const env=await runtimeEnv(),secret=text(env.PAWSPACE_EMAIL_WEBHOOK_SECRET);if(!secret)return Response.json({ok:false,error:"email_webhook_not_configured"},{status:503});
  const raw=await request.text(),signature=text(request.headers.get("x-pawspace-email-signature")||request.headers.get("x-signature"));if(!signature||!(await verifySignature(raw,secret,signature)))return Response.json({ok:false,error:"invalid_signature"},{status:401});
  let body:Record<string,unknown>;try{body=JSON.parse(raw) as Record<string,unknown>;}catch{return Response.json({ok:false,error:"invalid_json"},{status:400});}
  const provider=text(body.provider)||"email_provider",eventType=text(body.eventType||body.type),eventId=text(body.eventId),messageId=text(body.messageId);if(!eventId)return Response.json({ok:false,error:"event_id_required"},{status:400});if((eventType==="inbound"||["delivered","open","click","bounce","complaint"].includes(eventType))&&!messageId)return Response.json({ok:false,error:"message_id_required"},{status:400});
  const captured=await captureInboundWebhook(env.DB,{provider,routeKey:"email-provider-webhook",environment:"sandbox",eventId,messageId:messageId||null,rawBody:raw,headers:request.headers,requireMessageId:eventType!=="calendar_sync"});
  const status=text(captured.row.status);if(status==="PROCESSED")return Response.json({ok:true,duplicatePrevented:true,status});if(status==="DEAD_LETTER")return Response.json({ok:false,duplicatePrevented:true,status},{status:503});
  const workerId=`email-webhook:${crypto.randomUUID()}`,attempt=await runInboundWebhookAttempt(env.DB,{queueId:text(captured.row.id),workerId,handler:async({rawBody})=>processEmailWebhook(env.DB,rawBody)});
  if(!attempt.claimed)return Response.json({ok:true,queued:true,duplicatePrevented:true,status:text(captured.row.status)},{status:202});
  if(!attempt.ok){const code=attempt.error instanceof Response?attempt.error.status:503;return Response.json({ok:false,queued:true,status:attempt.failure.status,error:attempt.error instanceof Response?await attempt.error.text():"email_webhook_processing_failed"},{status:code>=400&&code<500?code:503});}
  return Response.json({ok:true,result:attempt.result,queued:true,duplicatePrevented:captured.duplicatePrevented});
 }catch(error){return authError(error,"Email webhook failed");}
}
