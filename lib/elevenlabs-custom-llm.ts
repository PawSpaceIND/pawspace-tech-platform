import{ensureCommunicationTables}from"./communication-engine";
import{classifyAiIntent,isExplicitCustomerActionConfirmation,orchestrateAiTurn}from"./ai-conversation-orchestrator";
import{createGroundedAiRuntimeProvider}from"./ai-grounded-runtime-provider";
import type{AuthenticatedActor}from"./server-auth";

type Row=Record<string,unknown>;type Env=Record<string,unknown>;
const text=(value:unknown)=>String(value??"").trim();
const serviceActor:AuthenticatedActor={email:"elevenlabs-voice@system.pawspace",name:"ElevenLabs Voice",roleCode:"service_elevenlabs_voice",permissions:["communications.manage","customers.manage","bookings.manage","scheduling.book"],developmentPreview:false,identitySource:"workspace",principalType:"identity_subject",principalKey:"service:elevenlabs-voice"};

export function assertElevenLabsLlmAuth(request:Request,env:Env){
 const secret=text(env.ELEVENLABS_LLM_SECRET);if(!secret)throw new Response("ElevenLabs custom LLM is not configured",{status:503});
 const supplied=text(request.headers.get("authorization")).replace(/^Bearer\s+/i,"");
 if(!supplied||supplied.length!==secret.length)throw new Response("ElevenLabs custom LLM authorization refused",{status:401});
 let diff=0;for(let i=0;i<secret.length;i++)diff|=secret.charCodeAt(i)^supplied.charCodeAt(i);
 if(diff!==0)throw new Response("ElevenLabs custom LLM authorization refused",{status:401});
}

function stringContent(value:unknown){
 if(typeof value==="string")return value.trim();
 if(!Array.isArray(value))return"";
 return value.flatMap(item=>{
  if(typeof item==="string")return[item];
  if(!item||typeof item!=="object")return[];
  const row=item as Row;const candidate=row.text??row.content??row.input_text;
  return typeof candidate==="string"?[candidate]:[];
 }).join(" ").trim();
}

export function extractElevenLabsResponsesInput(body:Row){
 if(typeof body.input==="string"&&text(body.input))return text(body.input);
 if(Array.isArray(body.input)){
  const items=body.input as unknown[];
  for(let i=items.length-1;i>=0;i--){const item=items[i];if(!item||typeof item!=="object")continue;const row=item as Row;if(text(row.role).toLowerCase()!=="user")continue;const content=stringContent(row.content??row.input);if(content)return content;}
 }
 const messages=Array.isArray(body.messages)?body.messages as unknown[]:[];
 for(let i=messages.length-1;i>=0;i--){const item=messages[i];if(!item||typeof item!=="object")continue;const row=item as Row;if(text(row.role).toLowerCase()!=="user")continue;const content=stringContent(row.content);if(content)return content;}
 return"";
}

function extra(body:Row){return((body.elevenlabs_extra_body||body.metadata||{})as Row);}
export function voiceThreadIdForCall(voiceCallId:string){
 const normalized=text(voiceCallId).replace(/[^A-Za-z0-9_-]/g,"").slice(0,96);
 if(!normalized)throw new Error("invalid_voice_call_id");
 return `THREAD-VOICE-${normalized}`;
}
async function voiceContext(db:D1Database,body:Row){
 const data=extra(body),sessionId=text(data.pawspace_voice_session_id),customerIdHint=text(data.pawspace_customer_id),threadIdHint=text(data.pawspace_thread_id),voiceCallId=text(data.pawspace_voice_call_id);
 if(sessionId){
  const session=await db.prepare("SELECT id,customer_id,thread_id,status FROM inbound_ai_voice_sessions WHERE id=?").bind(sessionId).first<Row>();
  if(!session)throw new Response("PawSpace voice session not found",{status:409});
  if(!["active","human_handoff"].includes(text(session.status)))throw new Response("PawSpace voice session is not active",{status:409});
  return{sessionId,customerId:text(session.customer_id),threadId:text(session.thread_id)};
 }
 if(customerIdHint&&threadIdHint){
  const thread=await db.prepare("SELECT id,customer_id,status FROM communication_threads WHERE id=?").bind(threadIdHint).first<Row>();
  if(!thread||text(thread.customer_id)!==customerIdHint)throw new Response("PawSpace voice thread/customer mismatch",{status:409});
  if(text(thread.status)==="closed")throw new Response("PawSpace voice thread is closed",{status:409});
  return{sessionId:null,customerId:customerIdHint,threadId:threadIdHint};
 }
 if(voiceCallId){
  const call=await db.prepare("SELECT id,customer_id,lead_id,booking_id FROM voice_call_orders WHERE id=?").bind(voiceCallId).first<Row>();
  if(!call||!text(call.customer_id))throw new Response("PawSpace outbound voice call context was not found",{status:409});
  const customerId=text(call.customer_id),threadId=voiceThreadIdForCall(voiceCallId);
  const existing=await db.prepare("SELECT id,customer_id,status FROM communication_threads WHERE id=?").bind(threadId).first<Row>();
  if(existing){
   if(text(existing.customer_id)!==customerId)throw new Response("PawSpace voice thread/customer mismatch",{status:409});
   if(text(existing.status)==="closed")throw new Response("PawSpace outbound voice thread is closed",{status:409});
  }else{
   const now=Date.now();
   await db.batch([
    db.prepare("INSERT INTO communication_threads (id,customer_id,booking_id,lead_id,ticket_id,status,assigned_to,sla_due_at,created_at,updated_at) VALUES (?,?,?,?,NULL,'open','ai-orchestrator',NULL,?,?)").bind(threadId,customerId,text(call.booking_id)||null,text(call.lead_id)||null,now,now),
    db.prepare("INSERT OR IGNORE INTO communication_participants (id,thread_id,participant_type,participant_id,display_ref,role,created_at) VALUES (?,?,?,?,?,'customer',?)").bind(crypto.randomUUID(),threadId,"customer",customerId,customerId,now),
   ]);
  }
  return{sessionId:null,customerId,threadId,voiceCallId};
 }
 throw new Response("PawSpace voice identity is missing from ElevenLabs custom LLM request",{status:400});
}

/**
 * Stage stopwatch for one voice turn, surfaced as a `Server-Timing` header.
 *
 * A live caller hears nothing until this whole function resolves, so "which stage owns the wait" is
 * the only question that matters for phone latency, and it cannot be answered from the outside: the
 * caller sees one number. Each mark is milliseconds from the start of the turn, so a stage's own cost
 * is the difference between consecutive marks. Durations only — no customer, thread or reply content.
 */
export type TurnStopwatch={mark:(name:string)=>void;marks:Record<string,number>};
export function turnStopwatch():TurnStopwatch{
 const started=Date.now(),marks:Record<string,number>={};
 return{mark:(name:string)=>{marks[name]=Date.now()-started;},marks};
}

/**
 * The clock is started by the caller, not here: request decode, auth and acquiring the D1 binding all
 * happen before this function and were previously outside every mark, leaving ~2.25s of a measured
 * 8.3s turn attributed to nothing at all.
 */
/**
 * Decides, from the first characters the model emits, whether this turn is safe to speak as it
 * arrives. A grounded turn may answer with prose OR with a governed action envelope
 * ({"reply":...,"actions":[...]}), and streaming the latter straight to TTS would have the agent read
 * JSON aloud down the phone. Anything opening with `{` or a code fence is therefore withheld and the
 * caller speaks only the parsed `reply` once the turn resolves; prose starts speaking immediately.
 * The cost of the distinction is one delta, not one generation.
 */
export function speechGate(emit:(text:string)=>void){
 let decided:"speak"|"withhold"|null=null,buffered="";
 return{
  push(delta:string){
   if(decided==="withhold")return;
   if(decided==="speak"){emit(delta);return;}
   buffered+=delta;
   const first=buffered.replace(/^\s+/,"").charAt(0);
   if(!first)return;
   if(first==="{"||first==="`"){decided="withhold";return;}
   decided="speak";emit(buffered);buffered="";
  },
  /** True when nothing has been spoken, so the resolved reply still has to be sent in full. */
  get unspoken(){return decided!=="speak";},
 };
}

export async function runElevenLabsGroundedTurn(db:D1Database,body:Row,clock:TurnStopwatch=turnStopwatch(),onDelta?:(delta:string)=>void){
 await ensureCommunicationTables(db);clock.mark("schema");
 const inputText=extractElevenLabsResponsesInput(body);if(!inputText)throw new Response("ElevenLabs custom LLM request has no user message",{status:400});
 const ctx=await voiceContext(db,body),messageId=`MSG-ELLM-${crypto.randomUUID().slice(0,14).toUpperCase()}`,now=Date.now();clock.mark("context");
 // Started, not awaited: the inbound transcript has to be recorded, but nothing about the reply
 // depends on it having landed, so it overlaps the model call instead of preceding it. Both writes
 // are settled before this function resolves, so the turn still cannot report success on a lost row.
 // The rejection is captured rather than left floating, so a failed write surfaces at the await.
 let inboundFailure:unknown=null;
 const inboundWrite=db.prepare("INSERT INTO communication_messages (id,thread_id,customer_id,booking_id,lead_id,ticket_id,direction,channel,purpose,template_key,payload_json,status,provider,provider_reference,idempotency_key,policy_json,created_by,created_at,updated_at) VALUES (?,?,?,NULL,NULL,NULL,'inbound','voice','transactional','elevenlabs_custom_llm',?,'received','elevenlabs',NULL,?,'{}',?,?,?)")
  .bind(messageId,ctx.threadId,ctx.customerId,JSON.stringify({text:inputText,source:"elevenlabs_custom_llm"}),`elevenlabs-llm:${ctx.threadId}:${messageId}`,serviceActor.email,now,now).run()
  .then(()=>{},(error:unknown)=>{inboundFailure=error;});
 const settleInbound=async()=>{await inboundWrite;if(inboundFailure)throw inboundFailure;};
 clock.mark("inboundWriteStarted");
 const provider=await createGroundedAiRuntimeProvider(db,serviceActor,"voice",{fastVoice:true});clock.mark("provider");
 const intent=classifyAiIntent(inputText);
 const fastEligible=!intent.policyRisk&&!["human_handoff","refund_review","unknown"].includes(intent.intent);
 if(fastEligible){
  const generated=await provider.generate({threadId:ctx.threadId,customerId:ctx.customerId,channel:"voice",inputText,intent,context:{voiceFastPath:true},...(onDelta?{onDelta}:{})});clock.mark("model");
  const confirmedAction=isExplicitCustomerActionConfirmation(inputText)&&Boolean(generated.actionRequests?.length);
  if(!generated.failure&&!generated.unsupported&&text(generated.text)&&!confirmedAction){
   const output=text(generated.text),replyId=`MSG-ELLM-AI-${crypto.randomUUID().slice(0,12).toUpperCase()}`,done=Date.now();
   // Both writes are settled here, after the reply has already been streamed to the caller. They are
   // still guaranteed before the turn resolves; they just no longer sit between question and audio.
   await Promise.all([
    settleInbound(),
    db.prepare("INSERT INTO communication_messages (id,thread_id,customer_id,booking_id,lead_id,ticket_id,direction,channel,purpose,template_key,payload_json,status,provider,provider_reference,idempotency_key,policy_json,created_by,created_at,updated_at) VALUES (?,?,?,NULL,NULL,NULL,'outbound','voice','transactional','elevenlabs_custom_llm_reply',?,'sent',?,?,?,'{}',?,?,?)")
     .bind(replyId,ctx.threadId,ctx.customerId,JSON.stringify({text:output,source:"elevenlabs_custom_llm_fast"}),generated.provider,generated.modelRef||null,`elevenlabs-llm-reply:${replyId}`,serviceActor.email,done,done).run(),
   ]);clock.mark("replyWrite");
   // `latencyMs` brackets only the provider round trip, so the "model" stage minus this is the runtime
   // control cost (reservation sweep, circuit read, its own schema guard) that precedes every call.
   // The resolved model ref is reported because the reasoning-effort shortcut applies to exactly one
   // model id: if an override resolves to anything else, the shortcut silently stops applying.
   return{output,turnId:replyId,sessionId:ctx.sessionId,customerId:ctx.customerId,threadId:ctx.threadId,path:"fast",timings:clock.marks,modelRef:generated.modelRef||null,providerRef:generated.provider||null,upstreamMs:generated.latencyMs??null};
  }
 }
 // The orchestrator reads the inbound row by id, so on this path the write must have landed first.
 await settleInbound();
 const result=await orchestrateAiTurn(db,{actor:serviceActor,threadId:ctx.threadId,customerId:ctx.customerId,inputMessageId:messageId,idempotencyKey:`elevenlabs-llm:${messageId}`,channel:"voice",provider});clock.mark("orchestrator");
 const turn=(result.turn||{})as Row,output=text(turn.output||turn.output_text);
 if(!output)throw new Response("PawSpace grounded voice turn returned no reply",{status:503});
 return{output,turnId:text(turn.id),sessionId:ctx.sessionId,customerId:ctx.customerId,threadId:ctx.threadId,path:"orchestrator",timings:clock.marks,modelRef:provider.modelRef??null,providerRef:provider.provider??null,upstreamMs:null as number|null};
}

export function responsesSse(output:string){
 const id=`resp_${crypto.randomUUID().replaceAll("-","").slice(0,24)}`,created=Math.floor(Date.now()/1000);
 const events=[
  {type:"response.created",response:{id,object:"response",created_at:created,status:"in_progress",model:"pawspace-grounded-openai",output:[]}},
  {type:"response.output_text.delta",item_id:`${id}_msg`,output_index:0,content_index:0,delta:output},
  {type:"response.output_text.done",item_id:`${id}_msg`,output_index:0,content_index:0,text:output},
  {type:"response.completed",response:{id,object:"response",created_at:created,status:"completed",model:"pawspace-grounded-openai",output:[{id:`${id}_msg`,type:"message",role:"assistant",content:[{type:"output_text",text:output,annotations:[]}]}]}},
 ];
 return events.map(event=>`data: ${JSON.stringify(event)}\n\n`).join("")+"data: [DONE]\n\n";
}
