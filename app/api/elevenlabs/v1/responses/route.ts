import{database}from"../../../../../lib/server-auth";
import{readBoundedRequestText,VoiceFetchRefused}from"../../../../../lib/voice-safe-fetch";
import{assertElevenLabsLlmAuth,runElevenLabsGroundedTurn,speechGate,turnStopwatch}from"../../../../../lib/elevenlabs-custom-llm";

async function runtime(){const{env}=await import("cloudflare:workers");return env as unknown as Record<string,unknown>;}
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
const encoder=new TextEncoder();
const sse=(event:unknown)=>encoder.encode(`data: ${JSON.stringify(event)}\n\n`);

export async function POST(request:Request){
 // Started before anything else the request touches. Acquiring the runtime binding, checking auth,
 // reading the body and opening D1 all precede the turn, and while they went unmarked roughly a
 // quarter of the caller's wait belonged to no stage and so could not be argued about.
 const clock=turnStopwatch();
 let db:D1Database,body:Record<string,unknown>;
 try{
  const env=await runtime();clock.mark("runtimeEnv");assertElevenLabsLlmAuth(request,env);clock.mark("auth");
  let raw:string;try{raw=await readBoundedRequestText(request,128*1024);}catch(error){if(error instanceof VoiceFetchRefused)return json({error:"ElevenLabs custom LLM payload is too large"},413);throw error;}
  clock.mark("bodyRead");
  try{const parsed:unknown=JSON.parse(raw);if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))return json({error:"ElevenLabs custom LLM request must be a JSON object"},400);body=parsed as Record<string,unknown>;}catch{return json({error:"Malformed ElevenLabs custom LLM request"},400);}
  clock.mark("bodyParse");
  db=await database();clock.mark("database");
 }catch(error){if(error instanceof Response)return json({error:await error.text()},error.status);return json({error:"PawSpace custom LLM failed safely"},503);}

 const id=`resp_${crypto.randomUUID().replaceAll("-","").slice(0,24)}`,created=Math.floor(Date.now()/1000);
 const model="pawspace-grounded-openai";
 const stream=new ReadableStream<Uint8Array>({
  async start(controller){
   const send=(event:unknown)=>{try{controller.enqueue(sse(event));}catch{/* caller hung up */}};
   send({type:"response.created",response:{id,object:"response",created_at:created,status:"in_progress",model,output:[]}});
   // Speech is released as the model produces it, except for a governed action envelope, which is
   // withheld so the phone never hears JSON; see speechGate.
   const gate=speechGate(text=>send({type:"response.output_text.delta",item_id:`${id}_msg`,output_index:0,content_index:0,delta:text}));
   try{
    const result=await runElevenLabsGroundedTurn(db,body,clock,delta=>gate.push(delta));
    // Nothing spoken yet means the turn was withheld as an envelope, or served by a path that does
    // not stream; either way the resolved reply is the first and only thing the caller hears.
    if(gate.unspoken)send({type:"response.output_text.delta",item_id:`${id}_msg`,output_index:0,content_index:0,delta:result.output});
    send({type:"response.output_text.done",item_id:`${id}_msg`,output_index:0,content_index:0,text:result.output});
    send({type:"response.completed",response:{id,object:"response",created_at:created,status:"completed",model,output:[{id:`${id}_msg`,type:"message",role:"assistant",content:[{type:"output_text",text:result.output,annotations:[]}]}],
     // Durations only, carried here rather than in Server-Timing because response headers are already
     // on the wire by the time the model stages finish. Consumers ignore unknown response fields.
     pawspace_timing:{path:result.path,modelRef:result.modelRef,providerRef:result.providerRef,upstreamMs:result.upstreamMs,spoken:!gate.unspoken,...result.timings}}});
   }catch(error){
    // The status line is already sent, so a failure here can only be reported inside the stream. The
    // turn is ended without speech rather than inventing a reply the governance layer never produced.
    const reason=error instanceof Response?await error.text().catch(()=>"refused"):"PawSpace custom LLM failed safely";
    send({type:"response.failed",response:{id,object:"response",created_at:created,status:"failed",model,error:{message:reason}}});
   }
   try{controller.enqueue(encoder.encode("data: [DONE]\n\n"));}catch{/* caller hung up */}
   try{controller.close();}catch{/* already closed */}
  },
 });

 return new Response(stream,{status:200,headers:{
  "content-type":"text/event-stream; charset=utf-8","cache-control":"no-store","x-accel-buffering":"no",
  // Only the stages that are already known when headers are written; the rest ride the final event.
  "server-timing":Object.entries(clock.marks).map(([stage,ms])=>`${stage};dur=${ms}`).join(", "),
 }});
}
