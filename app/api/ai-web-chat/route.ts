import{resolvePlatformSession}from"../../../lib/platform-session";
import{authError,database,resolveActor,securityAudit}from"../../../lib/server-auth";
import{captureAiWebLead,customerWebChatTranscript,publicAiWebKnowledge,runAuthenticatedAiWebChat,runPublicAiWebChat}from"../../../lib/ai-web-chat-adapter";
import{withinPublicRateLimit}from"../../../lib/public-abuse-gate";
import{isCustomerCallbackRequest,requestGovernedCustomerCallback}from"../../../lib/ai-first-control-plane";

type Body={mode?:"public"|"authenticated";sessionKey?:string;query?:string;message?:string;history?:Array<{role?:"user"|"assistant";text?:string}>;name?:string;email?:string;phone?:string;customerId?:string;idempotencyKey?:string};
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin AI web chat write blocked",{status:403});}
async function runtime(){const{env}=await import("cloudflare:workers");return env as unknown as Record<string,unknown>;}

/** Anonymous AI turns are paid model calls. Per-origin budget, sized for a real conversation. */
const PUBLIC_AI_CHAT_TURN_LIMIT=30;
const PUBLIC_AI_CHAT_WINDOW_MS=10*60*1000;

export async function GET(request:Request){try{const db=await database(),url=new URL(request.url);
 /* The signed-in customer's own conversation, including replies from the PawSpace team. Without this a
  * staff reply was stored as delivered and no customer screen could ever show it. */
 if(url.searchParams.get("mode")==="thread"){
  let actor;
  try{actor=await resolveActor(request);}
  catch(error){if(error instanceof Response&&error.status===401)return json({error:"Sign in to your PawSpace account to see your conversation.",code:"customer_sign_in_required",signInUrl:"/mobile-app"},401);throw error;}
  const session=await resolvePlatformSession(db,request),customerId=session?.subjectType==="customer"?session.subjectId:"";
  if(!customerId)return json({error:"Customer session required",code:"customer_session_required"},403);
  return json({data:await customerWebChatTranscript(db,{actor,customerId,threadId:url.searchParams.get("threadId"),limit:Number(url.searchParams.get("limit")||100)})});
 }
 const query=url.searchParams.get("q")||"";const data=await publicAiWebKnowledge(db,{query});return json({data});}catch(error){if(error instanceof Response)return json({error:await error.text()},error.status);return authError(error,"Unable to load public AI chat knowledge");}}

export async function POST(request:Request){try{sameOrigin(request);const db=await database(),body=await request.json()as Body,mode=body.mode||"public";if(mode!=="public"&&mode!=="authenticated")return json({error:"Unsupported chat mode"},400);if(mode==="public"){if(body.message&&body.sessionKey&&(body.name||body.email||body.phone)){const lead=await captureAiWebLead(db,{sessionKey:body.sessionKey,message:body.message,name:body.name,email:body.email,phone:body.phone});return json({data:{mode:"public",lead,customerDataAccess:false,toolExecution:false,callbackAutomation:false}},201);}if(!(await withinPublicRateLimit(db,request,{table:"ai_web_chat_public_rate",now:Date.now(),limit:PUBLIC_AI_CHAT_TURN_LIMIT,windowMs:PUBLIC_AI_CHAT_WINDOW_MS})))return json({error:"You have sent a lot of messages in a short time. Please wait a few minutes and try again.",code:"public_chat_rate_limited"},429);const data=await runPublicAiWebChat(db,{query:body.query||body.message||"",history:body.history,sessionKey:body.sessionKey});return json({data});}
 let actor;
 try{actor=await resolveActor(request);}
 catch(error){
  // A signed-out visitor on the customer chat: answer in customer terms, never with the staff sign-in copy.
  if(error instanceof Response&&error.status===401)return json({error:"Sign in to your PawSpace account to chat about your bookings.",code:"customer_sign_in_required",signInUrl:"/mobile-app"},401);
  throw error;
 }
 const session=await resolvePlatformSession(db,request);body.customerId=body.customerId||(session?.subjectType==="customer"?session.subjectId:undefined);if(!body.customerId||!body.message||!body.idempotencyKey)return json({error:"Customer, message and idempotency key are required"},400);
 // Only an authenticated, customer-owned chat may originate a phone call. Anonymous web leads stay
 // capture-only so an internet user cannot type somebody else's number and cause PawSpace to dial it.
 if(isCustomerCallbackRequest(body.message)){
  const callback=await requestGovernedCustomerCallback(db,await runtime(),{actor,customerId:body.customerId,message:body.message,idempotencyKey:body.idempotencyKey});
  await securityAudit(db,actor,"ai.web_chat.callback","voice_call",callback.matched&&"callback"in callback?callback.callback.callId:null,"completed",{customerId:body.customerId,matched:callback.matched,consentSource:callback.matched?callback.consentSource:null,policyEngine:callback.matched?callback.policyEngine:null});
  return json({data:{mode:"authenticated",callback,autonomousExecution:callback.matched?"governed_customer_requested_callback":false}},callback.matched?201:200);
 }
 const data=await runAuthenticatedAiWebChat(db,{actor,customerId:body.customerId,text:body.message,idempotencyKey:body.idempotencyKey},{acceptWhileWithTeam:true});await securityAudit(db,actor,"ai.web_chat.turn","communication_thread",data.threadId,"completed",{duplicatePrevented:data.duplicatePrevented,withTeam:"withTeam"in data,autonomousExecution:false});return json({data},200);
 }catch(error){if(error instanceof Response)return json({error:await error.text()},error.status);return authError(error,"Unable to process AI web chat");}}
