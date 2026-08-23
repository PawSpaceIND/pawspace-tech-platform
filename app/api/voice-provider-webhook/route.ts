import{authError,database}from"../../../lib/server-auth";
import{recordVoiceProviderEvent}from"../../../lib/voice-outbound-governance";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});

/**
 * Telephony provider callbacks (call progress, DTMF, completion, recording availability).
 *
 * Unauthenticated by session on purpose - a carrier has no cookie - and therefore verified by shared
 * secret instead: an HMAC-SHA256 signature over `${timestamp}.${body}` with a freshness window, or HTTP
 * Basic whose password matches EXOTEL_WEBHOOK_SECRET (which is what Exotel's callback configuration can
 * actually produce). Neither present, or either wrong, and the payload is rejected 401 with no state
 * change of any kind. There is no unverified path in.
 *
 * Redelivery is normal, not exceptional: providers retry on any non-2xx. A duplicate is answered 200 so
 * the provider stops retrying, and it changes nothing - deduplication is on (provider, provider_event_id)
 * with a unique index, so the state machine cannot be advanced twice by the same event.
 */
export async function POST(request:Request){
  try{
    const{env}=await import("cloudflare:workers");
    const runtime=env as unknown as Record<string,unknown>;
    const raw=await request.text();
    if(raw.length>65_536)return json({error:"Provider callback payload is too large"},413);
    const db=await database();
    const result=await recordVoiceProviderEvent(db,runtime,{rawBody:raw,headers:request.headers});
    if(!result.accepted)return json({error:result.reason},result.status);
    return json({ok:true,...result},result.status);
  }catch(error){return authError(error,"Unable to process voice provider callback");}
}
