import{authError,database}from"../../../../../lib/server-auth";
import{readBoundedRequestText,VoiceFetchRefused}from"../../../../../lib/voice-safe-fetch";
import{reconcileElevenLabsPostCall,verifyElevenLabsWebhook}from"../../../../../lib/elevenlabs-post-call";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
async function runtime(){const{env}=await import("cloudflare:workers");return env as unknown as Record<string,unknown>;}

export async function POST(request:Request){
 try{
  const env=await runtime();let raw:string;
  try{raw=await readBoundedRequestText(request,256*1024);}catch(error){if(error instanceof VoiceFetchRefused)return json({error:"ElevenLabs post-call payload is too large"},413);throw error;}
  const signature=request.headers.get("ElevenLabs-Signature")||"";
  const verified=await verifyElevenLabsWebhook(raw,signature,env);if(!verified.verified)return json({error:verified.reason},401);
  let payload:Record<string,unknown>;try{const parsed:unknown=JSON.parse(raw);if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))return json({error:"ElevenLabs post-call payload must be a JSON object"},400);payload=parsed as Record<string,unknown>;}catch{return json({error:"Malformed ElevenLabs post-call payload"},400);}
  const result=await reconcileElevenLabsPostCall(await database(),payload);return json({ok:true,data:result});
 }catch(error){if(error instanceof Response)return json({error:await error.text()},error.status);return authError(error,"Unable to reconcile ElevenLabs post-call event");}
}
