import{actorCanAccessConversation}from"../../../lib/conversation-access";
import{askWhatsAppMoveConsent,moveChatThreadToWhatsApp,queueChatHumanReply,recordWhatsAppMoveConsent,whatsAppMoveEligibility}from"../../../lib/chat-human-reply";
import{authError,authorize,database,securityAudit}from"../../../lib/server-auth";

/**
 * Staff replies on a WEB CHAT thread, and the in-thread WhatsApp consent that must come before any move.
 *
 * Owner decision 2026-09-22 (decision 4 of 10). /api/whatsapp/conversation-control cannot serve this:
 * its threadContext refuses any thread with no WhatsApp message, which is every web chat thread, so
 * after a takeover on web chat there was nowhere for staff to reply at all.
 */
type Body={action?:string;threadId?:string;message?:string;clientRequestId?:string;granted?:boolean};
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin chat reply write blocked",{status:403});}

export async function GET(request:Request){
 try{
  const actor=await authorize(request,"communications.manage"),db=await database(),url=new URL(request.url);
  const threadId=url.searchParams.get("threadId")||"",customerId=url.searchParams.get("customerId")||"";
  if(!threadId||!customerId)return json({error:"Thread and customer are required"},400);
  if(!(await actorCanAccessConversation(db,actor,threadId)))return json({error:"Conversation access denied"},403);
  return json({data:await whatsAppMoveEligibility(db,{threadId,customerId})});
 }catch(error){if(error instanceof Response)return error;return authError(error,"Unable to load chat reply state");}
}

export async function POST(request:Request){
 try{
  sameOrigin(request);
  const actor=await authorize(request,"communications.manage"),db=await database(),body=await request.json().catch(()=>({})) as Body;
  const action=String(body.action||"").trim(),threadId=String(body.threadId||"").trim();
  if(!threadId)return json({error:"Thread ID is required"},400);
  if(!(await actorCanAccessConversation(db,actor,threadId))){
   await securityAudit(db,actor,`chat.conversation.${action||"unknown"}`,"communication_thread",threadId,"denied",{reason:"row_scope",productionDelivery:false});
   return json({error:"Conversation access denied"},403);
  }
  if(action==="human_reply"){
   const data=await queueChatHumanReply(db,{actor,threadId,message:String(body.message||""),clientRequestId:String(body.clientRequestId||"")});
   await securityAudit(db,actor,"chat.conversation.human_reply","communication_thread",threadId,"completed",{messageId:data.messageId,duplicatePrevented:data.duplicatePrevented,externalDelivery:false,productionDelivery:false});
   return json({data},data.duplicatePrevented?200:201);
  }
  if(action==="ask_whatsapp_consent"){
   const data=await askWhatsAppMoveConsent(db,{actor,threadId});
   await securityAudit(db,actor,"chat.conversation.ask_whatsapp_consent","communication_thread",threadId,"completed",{asked:data.asked,blockedBy:data.blockedBy,productionDelivery:false});
   return json({data},201);
  }
  if(action==="record_whatsapp_consent"){
   const data=await recordWhatsAppMoveConsent(db,{threadId,granted:body.granted===true,actorId:actor.email});
   await securityAudit(db,actor,"chat.conversation.record_whatsapp_consent","communication_thread",threadId,"completed",{status:data.status,productionDelivery:false});
   return json({data});
  }
  if(action==="move_to_whatsapp"){
   const data=await moveChatThreadToWhatsApp(db,{actor,threadId});
   await securityAudit(db,actor,"chat.conversation.move_to_whatsapp","communication_thread",threadId,"completed",{movedAt:data.movedAt,productionDelivery:false});
   return json({data});
  }
  return json({error:"Supported actions are human_reply, ask_whatsapp_consent, record_whatsapp_consent or move_to_whatsapp"},400);
 }catch(error){if(error instanceof Response)return error;return authError(error,"Unable to update the chat conversation");}
}
