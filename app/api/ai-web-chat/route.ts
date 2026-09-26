import{resolvePlatformSession}from"../../../lib/platform-session";
import{authError,database,requireCustomerOwnership,resolveActor,securityAudit}from"../../../lib/server-auth";
import{captureAiWebLead,completeWebChatBotLead,customerWebChatTranscript,loadWebChatBotState,publicAiWebKnowledge,runAuthenticatedAiWebChat,runCustomerWebChatBotTurn,runPublicAiWebChat,saveWebChatBotState,startCustomerWebChatBot}from"../../../lib/ai-web-chat-adapter";
import{flowByCode,initialBotState,menuReply,partialSummary,runBotTurn}from"../../../lib/web-chat-bot";
import{advanceBotSession}from"../../../lib/web-chat-bot-store";
import{POST as submitPublicContact}from"../public-contact/route";
import{withinPublicRateLimit}from"../../../lib/public-abuse-gate";
import{requestAiHumanHandoff,routeLeadToTeamQueue}from"../../../lib/ai-human-handoff";
import{isCustomerCallbackRequest,requestGovernedCustomerCallback}from"../../../lib/ai-first-control-plane";
import{activeCrossSell}from"../../../lib/ai-sales-offers";

type Body={bot?:boolean;start?:boolean;choiceId?:string;mode?:"public"|"authenticated";sessionKey?:string;query?:string;message?:string;history?:Array<{role?:"user"|"assistant";text?:string}>;name?:string;email?:string;phone?:string;customerId?:string;idempotencyKey?:string};
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin AI web chat write blocked",{status:403});}
async function runtime(){const{env}=await import("cloudflare:workers");return env as unknown as Record<string,unknown>;}

/** Anonymous AI turns are paid model calls. Per-origin budget, sized for a real conversation. */
const PUBLIC_AI_CHAT_TURN_LIMIT=30;
const PUBLIC_AI_CHAT_WINDOW_MS=10*60*1000;
/** Guided-bot turns per origin in the same window: a whole flow is about 10 taps, several flows fit. */
const PUBLIC_BOT_TURN_LIMIT=80;

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

export async function POST(request:Request){try{sameOrigin(request);const db=await database(),body=await request.json()as Body,mode=body.mode||"public";if(mode!=="public"&&mode!=="authenticated")return json({error:"Unsupported chat mode"},400);if(mode==="public"&&body.bot===true)return publicBotTurn(db,request,body);if(mode==="public"){if(body.message&&body.sessionKey&&(body.name||body.email||body.phone)){const lead=await captureAiWebLead(db,{sessionKey:body.sessionKey,message:body.message,name:body.name,email:body.email,phone:body.phone});return json({data:{mode:"public",lead,customerDataAccess:false,toolExecution:false,callbackAutomation:false}},201);}if(!(await withinPublicRateLimit(db,request,{table:"ai_web_chat_public_rate",now:Date.now(),limit:PUBLIC_AI_CHAT_TURN_LIMIT,windowMs:PUBLIC_AI_CHAT_WINDOW_MS})))return json({error:"You have sent a lot of messages in a short time. Please wait a few minutes and try again.",code:"public_chat_rate_limited"},429);const data=await runPublicAiWebChat(db,{query:body.query||body.message||"",history:body.history,sessionKey:body.sessionKey});return json({data});}
 let actor;
 try{actor=await resolveActor(request);}
 catch(error){
  // A signed-out visitor on the customer chat: answer in customer terms, never with the staff sign-in copy.
  if(error instanceof Response&&error.status===401)return json({error:"Sign in to your PawSpace account to chat about your bookings.",code:"customer_sign_in_required",signInUrl:"/mobile-app"},401);
  throw error;
 }
 const session=await resolvePlatformSession(db,request);body.customerId=body.customerId||(session?.subjectType==="customer"?session.subjectId:undefined);const customerId=body.customerId;if(!customerId)return json({error:"Customer, message and idempotency key are required"},400);
 // Ownership is settled once, before the request's own fields choose what happens next.
 await requireCustomerOwnership(db,actor,customerId);
 if(body.bot===true){
  /* Every signed-in bot answer carries the conversation back, so the page shows the reply from this one
   * request instead of reading the thread again (each extra request costs the customer seconds). */
  const withTranscript=async()=>customerWebChatTranscript(db,{actor,customerId,ownershipVerified:true}).catch(()=>null);
  if(body.start===true){const bot=await startCustomerWebChatBot(db,{actor,customerId});return json({data:{mode:"authenticated",bot,transcript:await withTranscript()}});}
  if(!(body.message||body.choiceId)||!body.idempotencyKey)return json({error:"Customer, message and idempotency key are required"},400);
  const result=await runCustomerWebChatBotTurn(db,{actor,customerId,text:body.message||"",choiceId:body.choiceId,idempotencyKey:body.idempotencyKey});
  await securityAudit(db,actor,"ai.web_chat.bot_turn","communication_thread",result.threadId,"completed",{path:result.path,duplicatePrevented:result.duplicatePrevented,autonomousExecution:false});
  if(result.path==="call"){
   /* The customer tapped "Request a call": PawSpace's governed callback places it (consent, quiet hours
    * and the voice policy engine decide). When it cannot, the team is asked to call instead. */
   const callback=await requestGovernedCustomerCallback(db,await runtime(),{actor,customerId,message:"Please call me back",idempotencyKey:`${body.idempotencyKey}:call`});
   if(!callback.matched)await requestAiHumanHandoff(db,{actorEmail:actor.email,threadId:result.threadId,customerId,reason:"customer_requested_human",confidence:null});
   await securityAudit(db,actor,"ai.web_chat.callback","voice_call",callback.matched&&"callback"in callback?callback.callback.callId:null,"completed",{customerId,matched:callback.matched,surface:"web_chat_bot"});
   return json({data:{mode:"authenticated",...result,callback,transcript:await withTranscript()}},callback.matched?201:200);
  }
  return json({data:{mode:"authenticated",...result,transcript:await withTranscript()}});
 }
 if(!body.message||!body.idempotencyKey)return json({error:"Customer, message and idempotency key are required"},400);
 // Only an authenticated, customer-owned chat may originate a phone call. Anonymous web leads stay
 // capture-only so an internet user cannot type somebody else's number and cause PawSpace to dial it.
 if(isCustomerCallbackRequest(body.message)){
  const callback=await requestGovernedCustomerCallback(db,await runtime(),{actor,customerId,message:body.message,idempotencyKey:body.idempotencyKey});
  await securityAudit(db,actor,"ai.web_chat.callback","voice_call",callback.matched&&"callback"in callback?callback.callback.callId:null,"completed",{customerId,matched:callback.matched,consentSource:callback.matched?callback.consentSource:null,policyEngine:callback.matched?callback.policyEngine:null});
  return json({data:{mode:"authenticated",callback,autonomousExecution:callback.matched?"governed_customer_requested_callback":false}},callback.matched?201:200);
 }
 const data=await runAuthenticatedAiWebChat(db,{actor,customerId,text:body.message,idempotencyKey:body.idempotencyKey},{acceptWhileWithTeam:true});await securityAudit(db,actor,"ai.web_chat.turn","communication_thread",data.threadId,"completed",{duplicatePrevented:data.duplicatePrevented,withTeam:"withTeam"in data,autonomousExecution:false});return json({data},200);
 }catch(error){if(error instanceof Response)return json({error:await error.text()},error.status);return authError(error,"Unable to process AI web chat");}}

/**
 * A visitor who is not signed in, through the guided bot. State lives against the browser's session key.
 * A question goes to PawSpace AI (rate limited: it is the paid call); a finished enquiry, or a request for
 * a person, becomes a CRM lead through the same governed intake as the website contact form, so it is
 * owned, SLA-timed and followed up like every other lead.
 */
async function publicBotTurn(db:D1Database,request:Request,body:Body){
 const sessionKey=String(body.sessionKey||"").trim().slice(0,120);
 if(!/^[-A-Za-z0-9_]{16,120}$/.test(sessionKey))return json({error:"A chat session is required",code:"chat_session_required"},400);
 /* Every bot turn counts against a per-origin budget: a finished flow writes a CRM lead, so the flow
  * itself - not only the paid AI call - must not be repeatable without limit. */
 if(!(await withinPublicRateLimit(db,request,{table:"web_chat_bot_public_rate",now:Date.now(),limit:PUBLIC_BOT_TURN_LIMIT,windowMs:PUBLIC_AI_CHAT_WINDOW_MS})))return json({error:"You have sent a lot of messages in a short time. Please wait a few minutes and try again.",code:"public_chat_rate_limited"},429);
 const ref=`public:${sessionKey}`;
 if(body.start===true){
  // Reopening the chat restarts the conversation, not the visitor: a lead already created stays theirs.
  const previous=await loadWebChatBotState(db,ref);
  await saveWebChatBotState(db,ref,{...initialBotState(),...(previous.leadId?{leadId:previous.leadId}:{})});
  return json({data:{mode:"public",sessionKey,bot:menuReply()}});
 }
 if(!String(body.message||"").trim()&&!String(body.choiceId||"").trim())return json({error:"Message is required"},400);
 // "Start over" resets the flow, not the visitor: the lead created for their number stays theirs.
 const crossSell=await activeCrossSell(db,{channel:"website"});
 const turn=await advanceBotSession(db,ref,previous=>{const result=runBotTurn(previous,{text:body.message||"",choiceId:body.choiceId,signedIn:false,crossSell});return previous.leadId&&!result.state.leadId?{...result,state:{...result.state,leadId:previous.leadId}}:result;});
 if(!turn.display)return json({error:"Message is required"},400);
 let ai:unknown=null,lead:unknown=null;
 if(turn.event.type==="ai"){
  if(!(await withinPublicRateLimit(db,request,{table:"ai_web_chat_public_rate",now:Date.now(),limit:PUBLIC_AI_CHAT_TURN_LIMIT,windowMs:PUBLIC_AI_CHAT_WINDOW_MS})))return json({error:"You have sent a lot of messages in a short time. Please wait a few minutes and try again.",code:"public_chat_rate_limited"},429);
  ai=(await runPublicAiWebChat(db,{query:turn.event.question,history:body.history,sessionKey})).ai;
 }
 const state=turn.state;
 if(turn.event.type==="completed"){
  // The lead usually exists already (created when the number was given); the answers complete it.
  /* WATI hands some enquiries to a team (relocation to the relocation desk, an existing booking or
   * subscription to sales); those leads go to that team's queue rather than the WhatsApp sales AI. */
  const teamReason=turn.event.followUp==="team"?turn.event.followUpReason??"bot_lead_qualified":null;
  if(state.leadId)lead=await completeWebChatBotLead(db,{leadId:state.leadId,service:turn.event.service,summary:turn.event.summary,whatsappConsent:/^yes/i.test(turn.event.answers.whatsapp||""),teamReason});
  else{const submitted=await submitBotLead(request,sessionKey,{service:turn.event.service,answers:turn.event.answers,summary:turn.event.summary});lead=submitted.captured&&submitted.leadId&&teamReason?{...submitted,routedTo:await routeLeadToTeamQueue(db,{leadId:String(submitted.leadId),reason:teamReason})}:submitted;}
 }else if(state.status==="collecting"&&state.answers.phone&&state.answers.name&&!state.leadId){
  /* The visitor's number is known: the lead is created now, as WATI has it from the first message, so a
   * visitor who stops half way is still followed up by the lead's own response clock. */
  const flow=flowByCode(state.flow),partial=await submitBotLead(request,sessionKey,{service:flow?.service||"Web chat enquiry",answers:state.answers,summary:`${partialSummary(state,false)}\n(Web chat in progress)`,partial:true});
  if(partial.captured&&partial.leadId){const leadId=String(partial.leadId);await advanceBotSession(db,ref,current=>({state:{...current,leadId}}));}
 }
 return json({data:{mode:"public",sessionKey,display:turn.display,bot:turn.reply,event:turn.event.type,ai,lead}});
}

/** The finished enquiry, through the website contact form's own intake (CRM contact, lead, owner, SLA). */
async function submitBotLead(request:Request,sessionKey:string,event:{service:string;answers:Record<string,string>;summary:string;partial?:boolean}){
 const answers=event.answers,headers=new Headers({"content-type":"application/json"});
 for(const name of["origin","cf-connecting-ip","x-forwarded-for","user-agent"]){const value=request.headers.get(name);if(value)headers.set(name,value);}
 const intake=new Request(new URL("/api/public-contact",request.url),{method:"POST",headers,body:JSON.stringify({
  requestId:`webchatbot_${event.partial?"start_":""}${sessionKey}`.replace(/[^-A-Za-z0-9_]/g,"_").slice(0,128),
  name:answers.name,phone:answers.phone,email:answers.email||"",area:answers.area||answers.from||"Bangalore",
  petNames:answers.petType?`${answers.petType}${answers.petCount?` x ${answers.petCount}`:""}`:"Not shared",
  service:event.service,message:event.summary.slice(0,500),whatsappConsent:/^yes/i.test(answers.whatsapp||""),
  utmSource:"pawspace_web_chat",utmMedium:"chatbot",
 })});
 const response=await submitPublicContact(intake),payload=await response.json().catch(()=>null) as Record<string,unknown>|null;
 return response.ok?{captured:true,leadId:payload?.leadId??(payload?.data as Record<string,unknown>|undefined)?.leadId??null}:{captured:false,status:response.status};
}
