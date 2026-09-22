import{aiHumanHandoffSnapshot,listAiHandoffQueue,manageAiHumanHandoff,type AiHandoffAction}from"../../../lib/ai-human-handoff";
import{askWhatsAppMoveConsent}from"../../../lib/chat-human-reply";
import{authError,authorize,database,securityAudit}from"../../../lib/server-auth";

type Body={action?:AiHandoffAction;threadId?:string;customerId?:string;reason?:string};
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin AI handoff write blocked",{status:403});}

export async function GET(request:Request){try{const actor=await authorize(request,"communications.manage"),db=await database(),url=new URL(request.url),threadId=url.searchParams.get("threadId")||"",customerId=url.searchParams.get("customerId")||"";if(url.searchParams.get("mode")==="queue")return json({data:await listAiHandoffQueue(db,{actor,limit:Number(url.searchParams.get("limit")||50)})});if(!threadId||!customerId)return json({error:"Thread and customer are required"},400);return json({data:await aiHumanHandoffSnapshot(db,{actor,threadId,customerId})});}catch(error){if(error instanceof Response)return error;return authError(error,"Unable to load AI human handoff state");}}

export async function POST(request:Request){try{sameOrigin(request);const actor=await authorize(request,"communications.manage"),db=await database(),body=await request.json()as Body;if(!body.threadId||!body.customerId||!body.action)return json({error:"Thread, customer and handoff action are required"},400);const data=await manageAiHumanHandoff(db,{actor,threadId:body.threadId,customerId:body.customerId,action:body.action,reason:body.reason});
 /* Owner decision 2026-09-22 (decision 4 of 10): after a staff takeover on WEB CHAT, the customer is
  * asked IN THE THREAD whether to move to WhatsApp - and where no move is possible (no number, CRM
  * opt-out, WhatsApp not connected here) they are told, in that same thread, that a human will reply
  * there. Before this the takeover said "I'm routing this to a PawSpace team member", paused the AI,
  * answered every further turn 409 "AI replies are paused", and left staff with no reply path at all on
  * a chat thread: the conversation simply stopped. Doing it here rather than behind a separate button
  * means it happens on every takeover, which is what makes it testable on staging.
  *
  * Best-effort on purpose: the takeover has already committed, and failing to post a message must not
  * turn a successful takeover into an error. `whatsappConsent` is null when it could not run, never a
  * claim that the customer was asked. */
 const whatsappConsent=body.action==="take_over"?await askWhatsAppMoveConsent(db,{actor,threadId:body.threadId}).catch(()=>null):null;
 await securityAudit(db,actor,body.action==="take_over"?"ai.handoff.takeover":"ai.handoff.resume","communication_thread",body.threadId,"completed",{customerId:body.customerId,reason:body.reason||null,aiPaused:data.aiPaused,whatsappConsentAsked:whatsappConsent?.asked??null,whatsappMoveBlockedBy:whatsappConsent?.blockedBy??null});
 return json({data:{...data,...(whatsappConsent?{whatsappConsent}:{})}});}catch(error){if(error instanceof Response)return json({error:await error.text()},error.status);return authError(error,"Unable to manage AI human handoff");}}
