import {ensureRevenueOpportunityTables} from "./revenue-opportunity-governance";
type Row=Record<string,unknown>;
/** One transaction updates the work item, Customer 360 projection and contact suppression. */
export async function recordLeadAttempt(db:D1Database,input:{leadId:string;channel:"call"|"whatsapp";outcome:string;note:string;actor:string;now:number}){
 await ensureRevenueOpportunityTables(db);
 const lead=await db.prepare("SELECT * FROM lead_work_items WHERE id=?").bind(input.leadId).first<Row>();
 if(!lead)throw new Response("Lead not found",{status:404});
 const field=input.channel==="call"?"call_attempts":"whatsapp_attempts",sequence=Number(lead[field]||0)+1;
 if(sequence>4&&input.outcome==="RNR")throw new Response(`Four ${input.channel} attempts are already recorded`,{status:409});
 const prefs=await db.prepare("SELECT opt_out FROM customer_contact_preferences WHERE customer_id=?").bind(lead.customer_id).first<Row>();
 const optOut=Number(lead.opt_out)===1||Number(prefs?.opt_out)===1||input.outcome==="Opt-out"||input.outcome==="Invalid";
 const status=lead.status==="converted"?"converted":optOut?"closed":input.outcome==="Interested"?"qualified":String(lead.status);
 const statements=[
  db.prepare("INSERT INTO lead_attempts (id,lead_id,channel,sequence_number,outcome,note,provider_status,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(`ATT-${crypto.randomUUID().slice(0,8)}`,input.leadId,input.channel,sequence,input.outcome,input.note||null,"uat_queued",input.actor,input.now),
  db.prepare(`UPDATE lead_work_items SET ${field}=?,first_action_at=COALESCE(first_action_at,?),last_outcome=?,status=CASE WHEN status='converted' THEN status WHEN opt_out=1 OR EXISTS (SELECT 1 FROM customer_contact_preferences p WHERE p.customer_id=lead_work_items.customer_id AND p.opt_out=1) THEN 'closed' ELSE ? END,opt_out=MAX(opt_out,?,COALESCE((SELECT p.opt_out FROM customer_contact_preferences p WHERE p.customer_id=lead_work_items.customer_id),0)),next_action_at=CASE WHEN opt_out=1 OR EXISTS (SELECT 1 FROM customer_contact_preferences p WHERE p.customer_id=lead_work_items.customer_id AND p.opt_out=1) THEN NULL ELSE ? END,updated_at=? WHERE id=?`).bind(sequence,input.now,input.outcome,status,optOut?1:0,optOut?null:input.now+4*60*60_000,input.now,input.leadId),
 ];
 if(optOut){
  statements.push(db.prepare("UPDATE crm_contacts SET stage=CASE WHEN ?='converted' THEN stage ELSE 'Closed' END,next_action='Do not contact — opted out',updated_at=? WHERE id=?").bind(status,input.now,lead.customer_id));
  statements.push(db.prepare("INSERT INTO customer_contact_preferences (customer_id,marketing_consent,whatsapp_consent,sms_consent,email_consent,opt_out,source,updated_by,updated_at) VALUES (?,0,0,0,0,1,'lead_attempt',?,?) ON CONFLICT(customer_id) DO UPDATE SET marketing_consent=0,whatsapp_consent=0,sms_consent=0,email_consent=0,opt_out=1,source='lead_attempt',updated_by=excluded.updated_by,updated_at=excluded.updated_at").bind(lead.customer_id,input.actor,input.now));
 }else if(status==="qualified")statements.push(db.prepare("UPDATE crm_contacts SET stage='Qualified',next_action='Follow up on service requirements',updated_at=? WHERE id=? AND NOT EXISTS (SELECT 1 FROM customer_contact_preferences p WHERE p.customer_id=crm_contacts.id AND p.opt_out=1)").bind(input.now,lead.customer_id));
 await db.batch(statements);
 const saved=await db.prepare("SELECT status,opt_out FROM lead_work_items WHERE id=?").bind(input.leadId).first<Row>();
 return{sequence,status:String(saved?.status||status),optOut:Number(saved?.opt_out)===1};
}
