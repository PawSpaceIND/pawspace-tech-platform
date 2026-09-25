import{database}from"../../../../../lib/server-auth";
import{readBoundedRequestText,VoiceFetchRefused}from"../../../../../lib/voice-safe-fetch";
import{assertElevenLabsLlmAuth,responsesSse,runElevenLabsGroundedTurn}from"../../../../../lib/elevenlabs-custom-llm";

async function runtime(){const{env}=await import("cloudflare:workers");return env as unknown as Record<string,unknown>;}
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});

export async function POST(request:Request){
 try{
  const env=await runtime();assertElevenLabsLlmAuth(request,env);
  let raw:string;try{raw=await readBoundedRequestText(request,128*1024);}catch(error){if(error instanceof VoiceFetchRefused)return json({error:"ElevenLabs custom LLM payload is too large"},413);throw error;}
  let body:Record<string,unknown>;try{const parsed:unknown=JSON.parse(raw);if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))return json({error:"ElevenLabs custom LLM request must be a JSON object"},400);body=parsed as Record<string,unknown>;}catch{return json({error:"Malformed ElevenLabs custom LLM request"},400);}
  const result=await runElevenLabsGroundedTurn(await database(),body);
  return new Response(responsesSse(result.output),{status:200,headers:{"content-type":"text/event-stream; charset=utf-8","cache-control":"no-store","x-accel-buffering":"no"}});
 }catch(error){if(error instanceof Response)return json({error:await error.text()},error.status);return json({error:"PawSpace custom LLM failed safely"},503);}
}
