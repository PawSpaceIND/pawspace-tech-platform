import{reserveWebChatCallbackRequest}from"../../../lib/customer-callback-context";
import{requestReplayableWebChatHandoff}from"../../../lib/web-chat-handoff-replay";
import {ensureCommunicationTables} from "../../../lib/communication-engine";
import {atlasCareContext} from '../../../lib/v2/atlas-assistance-policy';
import{needsImmediateVetGuidance,emergencyChatResponse}from"../../../lib/ai-emergency-guidance";
import{resolvePlatformSession}from"../../../lib/platform-session";
import{authError,database,requireCustomerOwnership,resolveActor,securityAudit}from"../../../lib/server-auth";
import{captureAiWebLead,completeWebChatBotLead,customerWebChatTranscript,loadWebChatBotState,publicAiWebKnowledge,recordCustomerCallbackNotice,runAuthenticatedAiWebChat,runCustomerWebChatBotTurn,runPublicAiWebChat,saveWebChatBotState,startCustomerWebChatBot}from"../../../lib/ai-web-chat-adapter";
import{flowByCode,initialBotState,menuReply,partialSummary,runBotTurn}from"../../../lib/web-chat-bot";
import{advanceBotSession}from"../../../lib/web-chat-bot-store";
import{POST as submitPublicContact}from"../public-contact/route";
import{withinPublicRateLimit}from"../../../lib/public-abuse-gate";
import{routeLeadToTeamQueue}from"../../../lib/ai-human-handoff";
import{UNSUPPORTED_SCHEDULING_NOTICE,cancelGovernedCustomerCallback,isCustomerCallbackRequest,requestGovernedCustomerCallback}from"../../../lib/ai-first-control-plane";
import{activeCrossSell}from"../../../lib/ai-sales-offers";
import{CustomerOtpUnavailableError,CustomerOtpVerificationError,exchangeCustomerOtp,startCustomerOtp}from"../../../lib/customer-otp-exchange";
import{PLATFORM_SESSION_COOKIE}from"../../../lib/platform-session";

type Body={careContext?:unknown;bot?:boolean;start?:boolean;choiceId?:string;mode?:"public"|"authenticated";sessionKey?:string;query?:string;message?:string;history?:Array<{role?:"user"|"assistant";text?:string}>;name?:string;email?:string;phone?:string;customerId?:string;idempotencyKey?:string;requestedStart?:string|number|null;serviceDate?:string|null;cityId?:string|null;zoneId?:string|null;bookingId?:string|null;petId?:string|null;serviceCode?:string|null;leadId?:string|null;cancelCallId?:string};
const json=(value:unknown,status=200,headers?:Headers)=>{const merged=new Headers(headers);merged.set("cache-control","no-store");return Response.json(value,{status,headers:merged});};
type CallbackFollowUp={outcome:"accepted"|"not_placed"|"not_matched"|"unsupported_scheduling";handoff:boolean;reason:"customer_requested_human"|"policy_risk"|"provider_unavailable"|"provider_error"|null;notice:string};
/** Read only fields requestGovernedCustomerCallback already returns. Accepted means the voice engine dialled or left the call queued, scheduled or dialing. A future requestedStart is unsupported scheduling, not a queued call. */
function callbackFollowUp(callback:{matched:boolean;callback?:unknown;scheduling?:string;reason?:string}):CallbackFollowUp{
 if(callback.scheduling==="unsupported"||callback.reason==="unsupported_scheduling")return{outcome:"unsupported_scheduling",handoff:true,reason:"customer_requested_human",notice:UNSUPPORTED_SCHEDULING_NOTICE};
 if(!callback.matched)return{outcome:"not_matched",handoff:true,reason:"customer_requested_human",notice:"No callback was matched. The PawSpace team has been asked to call you."};
 const detail=callback.callback&&typeof callback.callback==="object"?callback.callback as {dialled?:boolean;dialed?:boolean;state?:string;blockedBy?:string|null}:{};
 const state=typeof detail.state==="string"?detail.state:"";
 const dialled=detail.dialled===true||detail.dialed===true;
 if(dialled||state==="queued"||state==="scheduled"||state==="dialing")return{outcome:"accepted",handoff:false,reason:null,notice:"The callback was accepted."};
 const blockedBy=detail.blockedBy==null?"":String(detail.blockedBy);
 const failed=detail.dialled===false||detail.dialed===false||state.startsWith("blocked_")||state==="provider_unavailable"||state==="provider_error"||state==="dial_failed"||blockedBy!=="";
 if(!failed)return{outcome:"not_placed",handoff:false,reason:null,notice:"The callback was not placed."};
 const provider=blockedBy==="provider_configured"||blockedBy==="provider_unavailable"||state==="provider_unavailable"||state==="provider_error";
 const reason=state==="provider_error"?"provider_error":provider?"provider_unavailable":"policy_risk";
 const why=blockedBy||state||"policy_or_provider";
 return{outcome:"not_placed",handoff:true,reason,notice:`The callback was not placed (${why}). The PawSpace team has been asked to call you.`};
}
async function handoffUndialledCallback(db:D1Database,actor:{email:string},customerId:string,threadId:string|null,callback:{matched:boolean;callback?:unknown;scheduling?:string;reason?:string},requestKey:string){
 const followUp=callbackFollowUp(callback);
 if(!followUp.handoff||!followUp.reason)return{...followUp,handedOff:false};
 let thread=threadId;
 if(!thread){await ensureCommunicationTables(db);try{const row=await db.prepare("SELECT id FROM communication_threads WHERE customer_id=? ORDER BY updated_at DESC LIMIT 1").bind(customerId).first<{id?:string}>();thread=row?.id?String(row.id):null;}catch{thread=null;}}
 if(!thread)return{...followUp,handedOff:false,notice:followUp.outcome==="unsupported_scheduling"?"Scheduling is not available. Open the customer app to contact the PawSpace team.":"The callback was not placed."};
 await requestReplayableWebChatHandoff(db,{actorEmail:actor.email,threadId:thread,customerId,reason:followUp.reason,requestKey});
 return{...followUp,handedOff:true,notice:followUp.outcome==="unsupported_scheduling"?`${UNSUPPORTED_SCHEDULING_NOTICE} The PawSpace team has been asked to follow up.`:followUp.notice};
}
function callbackRequestFields(body:Body){return{requestedStart:body.requestedStart??null,serviceDate:body.serviceDate??null,cityId:body.cityId??undefined,bookingId:body.bookingId??null,petId:body.petId??null,serviceCode:body.serviceCode??null,leadId:body.leadId??null};}
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

export async function POST(request:Request){try{sameOrigin(request);const db=await database(),body=await request.json()as Body,mode=body.mode||"public";if(mode!=="public"&&mode!=="authenticated")return json({error:"Unsupported chat mode"},400);if(mode==="public"&&needsImmediateVetGuidance(body.message||body.query||"")){if(!(await withinPublicRateLimit(db,request,{table:"ai_web_chat_public_rate",now:Date.now(),limit:PUBLIC_AI_CHAT_TURN_LIMIT,windowMs:PUBLIC_AI_CHAT_WINDOW_MS})))return json({error:"Please contact your nearest emergency vet immediately. Chat rate limit reached."},429);return json({data:{mode,...emergencyChatResponse(body.sessionKey)}});}if(mode==="public"&&body.bot===true)return publicBotTurn(db,request,body);if(mode==="public"){if(body.message&&body.sessionKey&&(body.name||body.email||body.phone)){const lead=await captureAiWebLead(db,{sessionKey:body.sessionKey,message:body.message,name:body.name,email:body.email,phone:body.phone});return json({data:{mode:"public",lead,customerDataAccess:false,toolExecution:false,callbackAutomation:false}},201);}if(!(await withinPublicRateLimit(db,request,{table:"ai_web_chat_public_rate",now:Date.now(),limit:PUBLIC_AI_CHAT_TURN_LIMIT,windowMs:PUBLIC_AI_CHAT_WINDOW_MS})))return json({error:"You have sent a lot of messages in a short time. Please wait a few minutes and try again.",code:"public_chat_rate_limited"},429);const data=await runPublicAiWebChat(db,{query:body.query||body.message||"",history:body.history,sessionKey:body.sessionKey,careContext:atlasCareContext(body.careContext),cityId:body.cityId,zoneId:body.zoneId});return json({data});}
 let actor;
 try{actor=await resolveActor(request);}
 catch(error){
  // A signed-out visitor on the customer chat: answer in customer terms, never with the staff sign-in copy.
  if(error instanceof Response&&error.status===401)return json({error:"Sign in to your PawSpace account to chat about your bookings.",code:"customer_sign_in_required",signInUrl:"/mobile-app"},401);
  throw error;
 }
 const session=await resolvePlatformSession(db,request),customerId=session?.subjectType==="customer"?session.subjectId:undefined;
 if(!customerId)return json({error:"Customer session required"},403);
 if(body.customerId&&body.customerId!==customerId)return json({error:"Client customer identity is not accepted"},403);
 // Ownership is settled once, before the request's own fields choose what happens next.
 await requireCustomerOwnership(db,actor,customerId);
 if(body.cancelCallId){
  const cancelled=await cancelGovernedCustomerCallback(db,{actor,customerId,callId:String(body.cancelCallId),reason:"customer_cancelled_in_chat"});
  await securityAudit(db,actor,"ai.web_chat.callback_cancel","voice_call",String(body.cancelCallId),"completed",{customerId});
  return json({data:{mode:"authenticated",cancelled,callbackOutcome:"cancelled",autonomousExecution:false}});
 }
 if(needsImmediateVetGuidance(body.message||body.query||""))return json({data:{mode,...emergencyChatResponse(body.sessionKey)}});
 if(body.bot===true){
  /* Every signed-in bot answer carries the conversation back, so the page shows the reply from this one
   * request instead of reading the thread again (each extra request costs the customer seconds). */
  // The turn itself is stored; if reading it back fails, the page reads the thread instead (transcript null).
  // known: the thread this request just wrote to, and its handoff state when the turn established it, so the transcript skips those reads.
  const withTranscript=async(known:{threadId?:string|null;handoff?:{active:boolean;status:"queued"|"staff_active"|null}}={})=>customerWebChatTranscript(db,{actor,customerId,ownershipVerified:true,...(known.threadId?{threadId:known.threadId,threadVerified:true}:{}),...(known.handoff?{handoff:known.handoff}:{})}).catch((error:unknown)=>{console.error("ai-web-chat: reply transcript read failed",error instanceof Error?error.message:String(error));return null;});
  if(body.start===true){const bot=await startCustomerWebChatBot(db,{actor,customerId});return json({data:{mode:"authenticated",bot,transcript:await withTranscript()}});}
  if(!(body.message||body.choiceId)||!body.idempotencyKey)return json({error:"Customer, message and idempotency key are required"},400);
  const result=await runCustomerWebChatBotTurn(db,{actor,customerId,text:body.message||"",choiceId:body.choiceId,idempotencyKey:body.idempotencyKey,ownershipVerified:true,callbackFields:callbackRequestFields(body),callbackMessage:body.message&& !/^request a call$/i.test(body.message.trim())?body.message:"Please call me back"});
  if(result.path==="call"){
   await securityAudit(db,actor,"ai.web_chat.bot_turn","communication_thread",result.threadId,"completed",{path:result.path,duplicatePrevented:result.duplicatePrevented,autonomousExecution:false});
   /* The customer tapped "Request a call": PawSpace's governed callback places it (consent, quiet hours
    * and the voice policy engine decide). When it cannot, the team is asked to call instead. */
   // Includes null slots: the first effective request is authoritative even before an intent exists.
   const fields=result.callbackContext?{requestedStart:result.callbackContext.requestedStart,serviceDate:result.callbackContext.serviceDate,cityId:result.callbackContext.cityId||undefined,bookingId:result.callbackContext.bookingId,petId:result.callbackContext.petId,serviceCode:result.callbackContext.serviceCode,leadId:result.callbackContext.leadId}:callbackRequestFields(body);
   const callbackMessage=result.callbackContext?.message||"Please call me back";
   if(!isCustomerCallbackRequest(callbackMessage))throw new Response("Explicit callback consent is required",{status:400});
   const callback=await requestGovernedCustomerCallback(db,await runtime(),{actor,customerId,message:callbackMessage,idempotencyKey:`${body.idempotencyKey}:call`,...fields});
   const followUp=await handoffUndialledCallback(db,actor,customerId,result.threadId,callback,`callback:${body.idempotencyKey}:call`);
   await recordCustomerCallbackNotice(db,{actor,customerId,threadId:result.threadId,idempotencyKey:body.idempotencyKey,notice:followUp.notice});
   await securityAudit(db,actor,"ai.web_chat.callback","voice_call",callback.matched&&"callback"in callback?callback.callback.callId:null,"completed",{customerId,matched:callback.matched,dialled:callback.matched&&"callback"in callback?Boolean((callback.callback as {dialled?:boolean;dialed?:boolean}).dialled||(callback.callback as {dialed?:boolean}).dialed):false,callbackOutcome:followUp.outcome,surface:"web_chat_bot"});
   return json({data:{mode:"authenticated",...result,callback,callbackOutcome:followUp.outcome,callbackNotice:followUp.notice,transcript:await withTranscript()}},callback.matched?201:200);
  }
  const{handoff,...shown}="handoff"in result?result:{...result,handoff:undefined};
  // The audit write and the transcript read are independent: one round trip.
  const[transcript]=await Promise.all([withTranscript({threadId:result.threadId,handoff}),securityAudit(db,actor,"ai.web_chat.bot_turn","communication_thread",result.threadId,"completed",{path:result.path,duplicatePrevented:result.duplicatePrevented,autonomousExecution:false})]);
  return json({data:{mode:"authenticated",...shown,transcript}});
 }
 if(!body.message||!body.idempotencyKey)return json({error:"Customer, message and idempotency key are required"},400);
 // Only an authenticated, customer-owned chat may originate a phone call. Anonymous web leads stay
 // capture-only so an internet user cannot type somebody else's number and cause PawSpace to dial it.
 if(isCustomerCallbackRequest(body.message)){
  const original=await reserveWebChatCallbackRequest(db,customerId,body.idempotencyKey,{message:body.message,...callbackRequestFields(body)});
  const callback=await requestGovernedCustomerCallback(db,await runtime(),{actor,customerId,idempotencyKey:body.idempotencyKey,...original});
  const followUp=await handoffUndialledCallback(db,actor,customerId,null,callback,`callback:${body.idempotencyKey}`);
  await securityAudit(db,actor,"ai.web_chat.callback","voice_call",callback.matched&&"callback"in callback?callback.callback.callId:null,"completed",{customerId,matched:callback.matched,dialled:callback.matched&&"callback"in callback?Boolean((callback.callback as {dialled?:boolean;dialed?:boolean}).dialled||(callback.callback as {dialed?:boolean}).dialed):false,callbackOutcome:followUp.outcome,consentSource:callback.matched?callback.consentSource:null,policyEngine:callback.matched?callback.policyEngine:null});
  return json({data:{mode:"authenticated",callback,callbackOutcome:followUp.outcome,callbackNotice:followUp.notice,autonomousExecution:callback.matched&&followUp.outcome==="accepted"?"governed_customer_requested_callback":false}},callback.matched?201:200);
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
 // A visitor confirming their number: the code they typed is exchanged for a signed-in session, and the AI books.
 const pending=await loadWebChatBotState(db,ref);
 if(pending.verify)return verifyVisitor(db,request,ref,pending,{message:String(body.message||"").trim(),tapped:String(body.choiceId||"").trim()});
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
  /* WATI parity ends at the lead; here the enquiry can be booked in the same conversation. The visitor
   * confirms the number they gave with a code sent to it; verified, they are the signed-in customer and
   * PawSpace AI recommends, prices and books exactly as it does for a customer in the app. Where no OTP
   * can be sent (or the enquiry is a team's), the lead stands and the team follows up as before. */
  if(!teamReason&&turn.event.answers.phone){
   const offered=await offerVisitorVerification(db,request,ref,{phone:turn.event.answers.phone,service:turn.event.service,summary:turn.event.summary});
   if(offered)return json({data:{mode:"public",sessionKey,display:turn.display,bot:{...turn.reply,text:`${turn.reply.text}\n\n${offered.text}`,inputHint:VERIFY_HINT},event:turn.event.type,ai,lead,verify:offered.verify}});
  }
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

const VERIFY_HINT="Enter the 6-digit code";
const verifyText=(phone:string)=>`To book this for you right now, I just need to confirm your number. I've sent a 6-digit code to ${phone} - type it here. (Or reply with anything else, and the team will contact you.)`;
/** Sends the code and remembers the enquiry it unlocks. Returns null where no OTP can be sent, so the lead stands alone. */
async function offerVisitorVerification(db:D1Database,request:Request,ref:string,input:{phone:string;service:string;summary:string}){
 const{env}=await import("cloudflare:workers");
 let started;try{started=await startCustomerOtp(db,request,env as unknown as Record<string,unknown>,input.phone);}catch(error){if(error instanceof CustomerOtpUnavailableError||error instanceof Error)return null;throw error;}
 await advanceBotSession(db,ref,current=>({state:{...current,verify:{challengeId:started.challengeId,phone:started.phone,service:input.service,summary:input.summary}}}));
 // The sandbox code is returned only where the sign-in route returns it (never when an SMS was sent).
 return{text:verifyText(started.phone),verify:{phone:started.phone,expiresInSeconds:started.expiresInSeconds,...(started.sandboxCode?{sandboxCode:started.sandboxCode}:{})}};
}
/**
 * The visitor's next message while a code is pending. A 6-digit code is exchanged for a signed-in customer
 * session; the response carries the session cookie and the AI's booking turn, and the page continues as
 * the customer. A code that no longer works gets a fresh one; anything else steps out of verification.
 */
async function verifyVisitor(db:D1Database,request:Request,ref:string,state:Awaited<ReturnType<typeof loadWebChatBotState>>,reply:{message:string;tapped:string}){
 const verify=state.verify!,sessionKey=ref.slice("public:".length),message=reply.message||reply.tapped;
 const leave=async(text:string)=>{await advanceBotSession(db,ref,current=>({state:{...current,verify:undefined}}));return json({data:{mode:"public",sessionKey,display:message,bot:{text,choices:[{id:"start_over",label:"Start over"}],inputHint:"Type a message"},event:"none",ai:null,lead:null}});};
 if(!message)return json({error:"Message is required"},400);
 // A button tap (Start over, a service) is never a code: it steps out of verification.
 const code=reply.tapped?"":reply.message.replace(/\s+/g,"");
 if(!/^\d{6}$/.test(code)){
  // Anything but a code steps out; a new code is sent only when the server finds the last one expired or used.
  return leave("No problem - your enquiry is with the PawSpace team, who will contact you shortly. Ask me anything else, or start over.");
 }
 const{env}=await import("cloudflare:workers");
 let exchanged;
 try{exchanged=await exchangeCustomerOtp(db,request,env as unknown as Record<string,unknown>,{challengeId:verify.challengeId,code,name:state.answers.name});}
 catch(error){
  if(error instanceof CustomerOtpVerificationError&&error.status===401)return json({data:{mode:"public",sessionKey,display:message,bot:{text:"That code didn't match. Please check the SMS and type the 6-digit code again.",choices:[],inputHint:VERIFY_HINT},event:"none",ai:null,lead:null}});
  if(error instanceof CustomerOtpVerificationError){const offered=await offerVisitorVerification(db,request,ref,verify);if(offered)return json({data:{mode:"public",sessionKey,display:message,bot:{text:`That code is no longer valid. ${verifyText(offered.verify.phone)}`,choices:[],inputHint:VERIFY_HINT},event:"none",ai:null,lead:null,verify:offered.verify}});}
  return leave("I couldn't confirm your number just now. Your enquiry is with the PawSpace team, who will contact you shortly.");
 }
 await advanceBotSession(db,ref,current=>({state:{...current,verify:undefined}}));
 // The freshly issued session is this request's identity from here on.
 const signedIn=new Request(request.url,{headers:{cookie:`${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(exchanged.token)}`,origin:request.headers.get("origin")||new URL(request.url).origin}});
 const actor=await resolveActor(signedIn),customerId=exchanged.customerId;
 await requireCustomerOwnership(db,actor,customerId);
 const booking=await runAuthenticatedAiWebChat(db,{actor,customerId,text:`I'd like to book ${verify.service}. My details:\n${verify.summary}\nPlease recommend the right package with its price and book it for me.`,idempotencyKey:`web-chat-verify:${verify.challengeId}`},{acceptWhileWithTeam:true});
 await securityAudit(db,actor,"ai.web_chat.visitor_verified","communication_thread",booking.threadId,"completed",{customerId,autonomousExecution:false});
 const transcript=await customerWebChatTranscript(db,{actor,customerId,ownershipVerified:true,threadId:booking.threadId,threadVerified:true,...("handoff"in booking&&booking.handoff?{handoff:booking.handoff}:{})}).catch(()=>null);
 return json({data:{mode:"authenticated",verified:true,customerId,threadId:booking.threadId,display:message,transcript}},200,exchanged.headers);
}
