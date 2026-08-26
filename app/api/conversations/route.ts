import{authError,authorize,database,securityAudit}from"../../../lib/server-auth";
import{maskName}from"../../../lib/platform-security";
import{customerDataAccessResolver}from"../../../lib/purpose-based-access";
import{assignConversation,getConversation,listConversationThreads,recordInboundMessage,setConversationStatus}from"../../../lib/conversation-governance";

type Body={action?:string;threadId?:string;customerId?:string;channel?:"whatsapp"|"sms"|"email"|"push"|"chat"|"voice";payload?:Record<string,unknown>;provider?:string;providerReference?:string;eventId?:string;assignedTo?:string;reason?:string;slaMinutes?:number;status?:"open"|"pending_customer"|"resolved"|"closed"};
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin conversation write blocked",{status:403});}
/*
 * Customer contact data is masked for an actor without customers.view_full_phone, the convention
 * app/api/subscription-customers/route.ts already applies (PTJA W2-B3-C07). Measured: the same
 * associate identity - which holds communications.manage but NOT customers.view_full_phone - was served
 * the thread list carrying "+919845012345" verbatim, and the thread view's message payload carried
 * customerPhone as well.
 *
 * The payload's `internalNote` is deliberately left alone. Who may read a staff-authored internal note
 * is a product decision, not a masking rule, and it is carried in the audit ledger rather than decided
 * here.
 */
export async function GET(request:Request){try{const convActor=await authorize(request,"communications.manage");const db=await database();
  /*
   * Purpose-based access. [PTJA-W2-B2-C01]
   *
   * What this replaced: `hasPermission(convActor.permissions,"customers.view_full_phone")` short-
   * circuiting the whole masking pass, so any actor holding that permission read every thread's raw
   * number and every message payload's customerPhone in one listing, with no reason asked and no record
   * kept. A conversation listing is not a reveal - app/api/customer-data-reveal is.
   *
   * The policy is resolved ONCE for the request. The thread's assignee is passed through, so a thread
   * genuinely assigned to this actor is decided on assignment rather than on seniority.
   */
  const access=await customerDataAccessResolver(db);
  const convSubject={email:convActor.email,roleCode:convActor.roleCode,permissions:convActor.permissions};
  const threadView=(row:Record<string,unknown>)=>access.view({actor:convSubject,purpose:"operations",
    subject:{customerId:String(row.customer_id||""),name:String(row.customer_name||""),phone:row.primary_phone?String(row.primary_phone):null,email:null},
    assignment:{type:"booking",id:String(row.booking_id||row.id||""),assignedTo:row.assigned_to?String(row.assigned_to):null,status:String(row.status||"")}});
  const maskThread=(row:Record<string,unknown>)=>{const view=threadView(row);return{...row,customer_name:row.customer_name?maskName(String(row.customer_name)):row.customer_name,primary_phone:view.contact.phone,revealed:view.revealed};};
  const notesReadable=access.mayReadUncategorisedNote(convSubject,"operations");
  const maskPayload=(value:unknown,view:{contact:{phone:string|null}}):unknown=>{if(!value||typeof value!=="object")return value;const record={...value as Record<string,unknown>};if(record.customerPhone)record.customerPhone=view.contact.phone;
    // An internal note on a message payload carries no category, so nothing can prove it is benign. It
    // is withheld unless the reader holds the restricted-note grant. The measured case was an associate
    // reading a complaint note off a thread. [PTJA-W2-B3-C07]
    if(record.internalNote&&!notesReadable)record.internalNote="[internal note withheld]";
    return record;};
  const url=new URL(request.url),threadId=url.searchParams.get("threadId");if(threadId){const data=await getConversation(db,threadId,"staff");if(data){const shaped=data as Record<string,unknown>;const threadRow=shaped.thread as Record<string,unknown>|undefined;const view=threadRow?threadView(threadRow):{contact:{phone:null}};const thread=threadRow?maskThread(threadRow):shaped.thread;const messages=Array.isArray(shaped.messages)?(shaped.messages as Record<string,unknown>[]).map(message=>({...message,payload:maskPayload(message.payload,view)})):shaped.messages;return json({data:{...shaped,thread,messages}});}return json({error:"Conversation not found"},404);}const data=await listConversationThreads(db,{customerId:url.searchParams.get("customerId")||undefined,status:url.searchParams.get("status")||undefined,limit:Number(url.searchParams.get("limit")||100)});return json({data:{threads:(data as Record<string,unknown>[]).map(maskThread),source:"canonical_conversation_threads",liveDelivery:false}});}catch(error){return authError(error,"Unable to load conversations");}}
export async function POST(request:Request){try{sameOrigin(request);const actor=await authorize(request,"communications.manage"),body=await request.json() as Body,db=await database();if(body.action==="record_inbound"){if(!body.threadId||!body.customerId||!body.channel||!body.provider||!body.providerReference||!body.eventId)return json({error:"Complete inbound message identity is required"},400);const data=await recordInboundMessage(db,{threadId:body.threadId,customerId:body.customerId,channel:body.channel,payload:body.payload||{},provider:body.provider,providerReference:body.providerReference,eventId:body.eventId,createdBy:actor.email});await securityAudit(db,actor,"conversation.inbound","conversation",body.threadId,"completed",{messageId:data.id,provider:body.provider});return json({data},data.duplicatePrevented?200:201);}
 if(body.action==="assign"){if(!body.threadId||!body.assignedTo)return json({error:"Thread and assignee are required"},400);const data=await assignConversation(db,{threadId:body.threadId,assignedTo:body.assignedTo,assignedBy:actor.email,reason:body.reason,slaMinutes:body.slaMinutes});await securityAudit(db,actor,"conversation.assign","conversation",body.threadId,"completed",{assignedTo:body.assignedTo});return json({data});}
 if(body.action==="status"){if(!body.threadId||!body.status)return json({error:"Thread and status are required"},400);const data=await setConversationStatus(db,{threadId:body.threadId,status:body.status,actorEmail:actor.email,reason:body.reason});await securityAudit(db,actor,"conversation.status","conversation",body.threadId,"completed",{status:body.status});return json({data});}
 return json({error:"Unsupported conversation action"},400);
}catch(error){if(error instanceof Response)return json({error:await error.text()},error.status);return authError(error,"Unable to update conversation");}}
