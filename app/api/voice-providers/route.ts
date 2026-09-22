import{authError,requirePermission,resolveActor}from"../../../lib/server-auth";
import{voiceProvidersStatus}from"../../../lib/voice-provider-adapter";
import{elevenLabsVoiceReadiness}from"../../../lib/elevenlabs-voice-integration";
import{elevenLabsTransferReadiness}from"../../../lib/elevenlabs-post-call";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
async function runtime(){const {env}=await import("cloudflare:workers");return env as unknown as Record<string,unknown>;}

// Read-only voice STT/TTS provider readiness. Never returns the keys - only whether each half is wired.
export async function GET(request:Request){
  try{
    const actor=await resolveActor(request);requirePermission(actor,"settings.manage");
    const env=await runtime(),speech=voiceProvidersStatus(env);
    return json({data:{...speech,elevenlabs:{...elevenLabsVoiceReadiness(env),transfer:elevenLabsTransferReadiness(env)}}});
  }catch(error){return authError(error,"Unable to load voice provider status");}
}
