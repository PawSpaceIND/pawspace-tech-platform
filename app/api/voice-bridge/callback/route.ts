import{authError,database}from"../../../../lib/server-auth";
import{recordVoiceBridgeCallback}from"../../../../lib/voice-bridge-governance";
import{readBoundedRequestText,VoiceFetchRefused}from"../../../../lib/voice-safe-fetch";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
const MAX_CALLBACK_BYTES=65_536;

/**
 * Exotel status / recording callback for a bridged call. Unauthenticated by session (a carrier has no
 * cookie) and therefore signature-verified inside recordVoiceBridgeCallback: an HMAC over
 * `${timestamp}.${body}` with a freshness window, or HTTP Basic matching EXOTEL_WEBHOOK_SECRET. Neither
 * present or either wrong => 401 with no state change. Redelivery is normal and answered 200 with no
 * duplicate effect (dedup on the provider event id).
 */
export async function POST(request:Request){
 try{
  const{env}=await import("cloudflare:workers");
  const runtime=env as unknown as Record<string,unknown>;
  let raw:string;
  try{raw=await readBoundedRequestText(request,MAX_CALLBACK_BYTES);}
  catch(error){if(error instanceof VoiceFetchRefused)return json({error:"Provider callback payload is too large"},413);throw error;}
  const db=await database();
  const result=await recordVoiceBridgeCallback(db,runtime,{rawBody:raw,headers:request.headers});
  if(!result.accepted)return json({error:result.reason},result.status);
  return json({ok:true,...result},result.status);
 }catch(error){return authError(error,"Unable to process voice bridge callback");}
}
