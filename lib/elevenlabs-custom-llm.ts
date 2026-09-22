import{ensureCommunicationTables}from"./communication-engine";
import{orchestrateAiTurn}from"./ai-conversation-orchestrator";
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
  const customerId=text(call.customer_id);
  const thread=await db.prepare("SELECT id FROM communication_threads WHERE customer_id=? AND status='open' ORDER BY updated_at DESC LIMIT 1").bind(customerId).first<Row>();
  let threadId=text(thread?.id);
  if(!threadId){
   threadId=`THREAD-${crypto.randomUUID().slice(0,12).toUpperCase()}`;const now=Date.now();
   await db.batch([
    db.prepare("INSERT INTO communication_threads (id,customer_id,booking_id,lead_id,ticket_id,status,assigned_to,sla_due_at,created_at,updated_at) VALUES (?,?,?,?,NULL,'open','ai-orchestrator',NULL,?,?)").bind(threadId,customerId,text(call.booking_id)||null,text(call.lead_id)||null,now,now),
    db.prepare("INSERT OR IGNORE INTO communication_participants (id,thread_id,participant_type,participant_id,display_ref,role,created_at) VALUES (?,?,?,?,?,'customer',?)").bind(crypto.randomUUID(),threadId,"customer",customerId,customerId,now),
   ]);
  }
  return{sessionId:null,customerId,threadId,voiceCallId};
 }
 throw new Response("PawSpace voice identity is missing from ElevenLabs custom LLM request",{status:400});
}

export async function runElevenLabsGroundedTurn(db:D1Database,body:Row){
 await ensureCommunicationTables(db);
 const inputText=extractElevenLabsResponsesInput(body);if(!inputText)throw new Response("ElevenLabs custom LLM request has no user message",{status:400});
 const ctx=await voiceContext(db,body),messageId=`MSG-ELLM-${crypto.randomUUID().slice(0,14).toUpperCase()}`,now=Date.now();
 await db.prepare("INSERT INTO communication_messages (id,thread_id,customer_id,booking_id,lead_id,ticket_id,direction,channel,purpose,template_key,payload_json,status,provider,provider_reference,idempotency_key,policy_json,created_by,created_at,updated_at) VALUES (?,?,?,NULL,NULL,NULL,'inbound','voice','transactional','elevenlabs_custom_llm',?,'received','elevenlabs',NULL,?,'{}',?,?,?)")
  .bind(messageId,ctx.threadId,ctx.customerId,JSON.stringify({text:inputText,source:"elevenlabs_custom_llm"}),`elevenlabs-llm:${ctx.threadId}:${messageId}`,serviceActor.email,now,now).run();
 const provider=await createGroundedAiRuntimeProvider(db,serviceActor,"voice");
 const result=await orchestrateAiTurn(db,{actor:serviceActor,threadId:ctx.threadId,customerId:ctx.customerId,inputMessageId:messageId,idempotencyKey:`elevenlabs-llm:${messageId}`,channel:"voice",provider});
 const turn=(result.turn||{})as Row,output=text(turn.output||turn.output_text);
 if(!output)throw new Response("PawSpace grounded voice turn returned no reply",{status:503});
 return{output,turnId:text(turn.id),sessionId:ctx.sessionId,customerId:ctx.customerId,threadId:ctx.threadId};
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
