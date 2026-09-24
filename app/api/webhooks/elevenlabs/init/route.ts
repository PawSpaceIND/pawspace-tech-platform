import{authError,database}from"../../../../../lib/server-auth";
import{assertElevenLabsInitWebhook,assertElevenLabsVoiceConfigured,buildElevenLabsInitiation}from"../../../../../lib/elevenlabs-voice-integration";
import{readBoundedRequestText,VoiceFetchRefused}from"../../../../../lib/voice-safe-fetch";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
const text=(value:unknown)=>String(value??"").trim();
async function runtime(){const{env}=await import("cloudflare:workers");return env as unknown as Record<string,unknown>;}

export async function POST(request:Request){
 try{
  const env=await runtime();assertElevenLabsVoiceConfigured(env);assertElevenLabsInitWebhook(request,env);
  let raw:string;try{raw=await readBoundedRequestText(request,32_768);}catch(error){if(error instanceof VoiceFetchRefused)return json({error:"ElevenLabs initiation payload is too large"},413);throw error;}
  let body:Record<string,unknown>;try{const parsed:unknown=JSON.parse(raw);if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))return json({error:"ElevenLabs initiation payload must be a JSON object"},400);body=parsed as Record<string,unknown>;}catch{return json({error:"Malformed ElevenLabs initiation payload"},400);}
  const agentId=text(body.agent_id);if(text(env.ELEVENLABS_AGENT_ID)&&agentId!==text(env.ELEVENLABS_AGENT_ID))return json({error:"ElevenLabs agent identity refused"},403);
  const data=await buildElevenLabsInitiation(await database(),{
   providerCallId:text(body.call_sid)||text(body.conversation_id),
   callerId:text(body.caller_id),
   conversationId:text(body.conversation_id),
   agentId,
   language:text(body.language)||null,
  },env);
  return json(data);
 }catch(error){if(error instanceof Response)return json({error:await error.text()},error.status);return authError(error,"Unable to initialize ElevenLabs voice conversation");}
}
