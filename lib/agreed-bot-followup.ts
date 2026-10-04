import{scheduleLeadCallback,cancelLeadCallback,ensureLeadCallbackTables}from"./lead-callback-governance";
type Row=Record<string,unknown>;
export async function recordAgreedBotFollowup(db:D1Database,input:{customerId:string;leadId:string;agreed:boolean|null;requestedAt?:number;callbackId?:string;reason:string;idempotencyKey:string;actorId:string}){
 const lead=await db.prepare("SELECT customer_id FROM lead_work_items WHERE id=?").bind(input.leadId).first<Row>();
 if(!lead||String(lead.customer_id)!==input.customerId)throw new Response("Followup lead ownership denied",{status:403});
 if(input.agreed===false){if(!input.callbackId)return{status:"declined",scheduled:false,externalDelivery:false};const callback=await cancelLeadCallback(db,{callbackId:input.callbackId,leadId:input.leadId,actorId:input.actorId});return{status:callback.status,scheduled:false,callback,externalDelivery:false};}
 if(input.agreed!==true)return{status:"agreement_required",scheduled:false,externalDelivery:false};
 if(input.requestedAt==null)return{status:"date_required",question:"When would you like the team to follow up?",scheduled:false,externalDelivery:false};
 if(!input.idempotencyKey.trim())throw new Response("Followup idempotency key required",{status:400});
 await ensureLeadCallbackTables(db);
 const prior=await db.prepare("SELECT c.lead_id,c.requested_at,c.reason FROM lead_callback_events e JOIN lead_callbacks c ON c.id=e.callback_id WHERE e.idempotency_key=? AND e.event_type='scheduled'").bind(input.idempotencyKey).first<Row>();
 if(prior&&(String(prior.lead_id)!==input.leadId||Number(prior.requested_at)!==input.requestedAt||String(prior.reason)!==input.reason.trim()))throw new Response("Followup idempotency key belongs to a different agreement",{status:409});
 const callback=await scheduleLeadCallback(db,{leadId:input.leadId,requestedAt:input.requestedAt,reason:input.reason,actorId:input.actorId,idempotencyKey:input.idempotencyKey});
 return{status:callback.status,scheduled:callback.status==="scheduled",callback,externalDelivery:false,executionObserved:false};
}
