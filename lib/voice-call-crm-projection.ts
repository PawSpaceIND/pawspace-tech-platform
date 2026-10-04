import{assertNativeDemoBusinessAllowed}from"./native-attended-demo";
import{BOT_CALL_TAGS,recordBotCallDisposition}from"./bot-call-disposition";
import{requirePermission,type AuthenticatedActor}from"./server-auth";
type Row=Record<string,unknown>;const text=(v:unknown)=>String(v??"").trim();
export function voiceCrmTag(disposition:string){const tag=BOT_CALL_TAGS.find(t=>t.code===disposition);if(tag&&(tag.requiresCallbackAt||tag.requiresServices||tag.escalates))throw new Response("Use the owned conversation followup or handoff action for this disposition",{status:409});return tag||null;}
export async function validateVoiceCrmContext(db:D1Database,input:{actor:AuthenticatedActor;call:Row;disposition:string}){
 const tag=voiceCrmTag(input.disposition);if(!tag)return null;
 await assertNativeDemoBusinessAllowed(db,text(input.call.thread_id));
 requirePermission(input.actor,"customers.manage");
 const thread=await db.prepare("SELECT customer_id,lead_id FROM communication_threads WHERE id=?").bind(input.call.thread_id).first<Row>();
 if(!thread||text(thread.customer_id)!==text(input.call.customer_id))throw new Response("Voice CRM conversation ownership denied",{status:403});
 const leadId=text(thread.lead_id);if(!leadId)throw new Response("An owned canonical lead is required before recording a typed call outcome",{status:409});
 const lead=await db.prepare("SELECT customer_id FROM lead_work_items WHERE id=?").bind(leadId).first<Row>();if(!lead||text(lead.customer_id)!==text(input.call.customer_id))throw new Response("Voice CRM lead ownership denied",{status:403});
 return{leadId,tag:tag.code};
}
export async function projectVoiceCallToCrm(db:D1Database,input:{actor:AuthenticatedActor;call:Row;leadId:string;tag:string}){
 if(input.call.status!=="completed"||text(input.call.disposition)!==input.tag)throw new Response("Only the matching terminal call can emit its typed CRM outcome",{status:409});
 return recordBotCallDisposition(db,{idempotencyKey:`canonical-voice-disposition:${text(input.call.id)}`,leadId:input.leadId,botProvider:"pawspace_voice_uat",callRef:text(input.call.id),primaryTag:input.tag,notes:`Canonical voice call terminal outcome: ${text(input.call.outcome)}`,transcriptRef:`voice:${text(input.call.id)}`,actorId:input.actor.email});
}
