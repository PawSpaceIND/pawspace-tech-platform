import{authError,requirePermission,resolveActor}from"../../../lib/server-auth";
import{voiceEngine,selectVoiceStt,selectVoiceTts,voiceProvidersStatus}from"../../../lib/voice-provider-adapter";
import{canonicalVoiceLocale}from"../../../lib/voice-locale";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin voice write blocked",{status:403});}
async function runtime(){const {env}=await import("cloudflare:workers");return env as unknown as Record<string,unknown>;}

// In-app voice speech: transcribe (speech->text) and synthesize (text->speech) via the active engine.
// The public contract is a Bengaluru BCP-47 locale; provider adapters reduce it to the short code their
// speech engine expects. Unknown/blank values fail safely to en-IN rather than leaking arbitrary strings.
export async function GET(request:Request){
  try{
    const actor=await resolveActor(request);requirePermission(actor,"communications.call");
    return json({data:{...voiceProvidersStatus(await runtime()),supportedLocales:["en-IN","hi-IN","kn-IN"]}});
  }catch(error){return authError(error,"Unable to load voice engine status");}
}

export async function POST(request:Request){
  try{
    sameOrigin(request);
    const env=await runtime(),actor=await resolveActor(request);requirePermission(actor,"communications.call");
    if(voiceEngine(env)==="none")return json({error:"No voice engine is active. Bind Cloudflare Workers AI (env.AI) to enable first-party voice."},503);
    const body=await request.json().catch(()=>({})) as {action?:string;audioRef?:string;text?:string;language?:string;locale?:string};
    const action=String(body.action||"").trim(),locale=canonicalVoiceLocale(body.locale||body.language);
    if(action==="transcribe"){const ref=String(body.audioRef||"").trim();if(!ref)return json({error:"audioRef is required"},400);const stt=selectVoiceStt(env);if(stt.status!=="connected")return json({error:"STT is not connected"},503);return json({data:{...(await stt.transcribe({audioRef:ref,language:locale})),locale}});}
    if(action==="synthesize"){const t=String(body.text||"").trim();if(!t)return json({error:"text is required"},400);const tts=selectVoiceTts(env);if(tts.status!=="connected")return json({error:"TTS is not connected"},503);return json({data:{...(await tts.synthesize({text:t,language:locale})),locale}});}
    return json({error:"Unsupported action. Use transcribe | synthesize"},400);
  }catch(error){return authError(error,"Unable to process voice speech request");}
}
