import{authError,requirePermission,resolveActor}from"../../../lib/server-auth";
import{voiceProvidersStatus}from"../../../lib/voice-provider-adapter";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
async function runtime(){const {env}=await import("cloudflare:workers");return env as unknown as Record<string,unknown>;}

// Read-only voice STT/TTS provider readiness. Never returns the keys - only whether each half is wired.
export async function GET(request:Request){
  try{
    const actor=await resolveActor(request);requirePermission(actor,"settings.manage");
    return json({data:voiceProvidersStatus(await runtime())});
  }catch(error){return authError(error,"Unable to load voice provider status");}
}
