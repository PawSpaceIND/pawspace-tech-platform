import{authError,database}from"../../../lib/server-auth";
import{recordVoiceProviderEventFromExotelReconciliation}from"../../../lib/exotel-call-reconciliation";
import{selectTelephonyProvider}from"../../../lib/voice-telephony-provider";
import{startInboundAiVoiceSession,runInboundAiVoiceTurn,endInboundAiVoiceSession}from"../../../lib/inbound-ai-telephony";
import{readBoundedRequestText,VoiceFetchRefused}from"../../../lib/voice-safe-fetch";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
const MAX_CALLBACK_BYTES=65_536;
const text=(value:unknown)=>String(value??"").trim();
function fields(raw:string){const value=raw.trim();if(value.startsWith("{")){try{return JSON.parse(value)as Record<string,unknown>}catch{return{}}}return Object.fromEntries(new URLSearchParams(value));}

/**
 * Single carrier boundary for outbound status callbacks and inbound AI voice sessions.
 *
 * Outbound Exotel callbacks are deliberately trigger-only. The unverified POST contributes only a
 * CallSid; PawSpace first proves that Sid belongs to an existing Exotel call in D1 and then retrieves
 * the current status from Exotel's authenticated Call Details API. Only that server-to-server response
 * can advance the lifecycle, so a forged CallStatus/CustomField in the public POST has no authority.
 *
 * Inbound AI start/turn/end actions are different: they carry live conversational input and therefore
 * still require the existing provider shared-secret verification before any AI session mutation.
 */
export async function POST(request:Request){
 try{
  const{env}=await import("cloudflare:workers");const runtime=env as unknown as Record<string,unknown>;
  let raw:string;try{raw=await readBoundedRequestText(request,MAX_CALLBACK_BYTES);}catch(error){if(error instanceof VoiceFetchRefused)return json({error:"Provider callback payload is too large"},413);throw error;}
  const payload=fields(raw),action=text(payload.pawspace_action||payload.PawSpaceAction).toLowerCase();
  const db=await database();
  if(action.startsWith("inbound_ai_")){
   const provider=selectTelephonyProvider(runtime),verified=await provider.verifyWebhook({rawBody:raw,headers:request.headers});
   if(!verified.verified)return json({error:verified.reason||"Inbound voice callback signature refused"},401);
   if(action==="inbound_ai_start"){
    const providerCallId=text(payload.providerCallId||payload.CallSid||payload.callsid||payload.sid),caller=text(payload.caller||payload.From||payload.from);
    if(!providerCallId||!caller)return json({error:"providerCallId and caller are required"},400);
    return json({ok:true,data:await startInboundAiVoiceSession(db,{providerCallId,caller,language:text(payload.language)||null})},201);
   }
   if(action==="inbound_ai_turn"){
    const sessionId=text(payload.sessionId),audioRef=text(payload.audioRef);if(!sessionId||!audioRef)return json({error:"sessionId and audioRef are required"},400);
    const data=await runInboundAiVoiceTurn(db,runtime,{sessionId,audioRef,bargeIn:String(payload.bargeIn||"").toLowerCase()==="true"});return json({ok:true,data},data.status==="human_handoff"?202:200);
   }
   if(action==="inbound_ai_end"){
    const sessionId=text(payload.sessionId);if(!sessionId)return json({error:"sessionId is required"},400);return json({ok:true,data:await endInboundAiVoiceSession(db,{sessionId,outcome:text(payload.outcome)||undefined})});
   }
   return json({error:"Unsupported inbound AI voice action"},400);
  }
  const result=await recordVoiceProviderEventFromExotelReconciliation(db,runtime,raw);
  if(!result.accepted)return json({error:result.reason},result.status);
  return json({ok:true,...result},result.status);
 }catch(error){return authError(error,"Unable to process voice provider callback");}
}
