import{ensureCustomerAccountTables}from"./customer-account";
import{ensureCustomer360Tables}from"./customer-360";
import{ensureOutboundOrchestratorTables}from"./outbound-schema";

type Db=D1Database;type Row=Record<string,unknown>;
const text=(value:unknown)=>String(value??"").trim();
const phoneKey=(value:unknown)=>text(value).replace(/\D/g,"").slice(-10);

export type PublicLeadIdentityPlan={customerId:string;newCanonicalCustomer:boolean;identityReview:boolean;candidateCustomerIds:string[];serviceContactAllowed:boolean};

export async function ensurePublicLeadOutboundTables(db:Db){
 await Promise.all([ensureCustomerAccountTables(db),ensureCustomer360Tables(db),ensureOutboundOrchestratorTables(db)]);
 await db.prepare("CREATE TABLE IF NOT EXISTS public_contact_identity_reviews (id TEXT PRIMARY KEY,contact_id TEXT NOT NULL,lead_id TEXT NOT NULL,phone_last4 TEXT NOT NULL,candidate_customer_ids_json TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open',reason TEXT NOT NULL,created_at INTEGER NOT NULL,resolved_at INTEGER,resolved_by TEXT)").run();
}

/** Resolve an enquiry to one canonical recipient. Ambiguity is recorded for staff review, never guessed. */
export async function planPublicLeadIdentity(db:Db,input:{proposedCustomerId:string;phone:string}) : Promise<PublicLeadIdentityPlan>{
 await ensurePublicLeadOutboundTables(db);
 const key=phoneKey(input.phone);if(key.length!==10)throw new Error("A valid ten-digit service contact number is required");
 const rows=await db.prepare("SELECT id,primary_phone,secondary_phone FROM canonical_customers").all<Row>();
 const matches=rows.results.filter(row=>[row.primary_phone,row.secondary_phone].some(value=>phoneKey(value)===key)).map(row=>text(row.id));
 const unique=[...new Set(matches)];
 if(unique.length>1)return{customerId:input.proposedCustomerId,newCanonicalCustomer:false,identityReview:true,candidateCustomerIds:unique,serviceContactAllowed:false};
 const customerId=unique[0]||input.proposedCustomerId;
 const pref=unique.length?await db.prepare("SELECT service_consent,opt_out FROM customer_contact_preferences WHERE customer_id=?").bind(customerId).first<Row>():null;
 const serviceContactAllowed=!pref||(Number(pref.opt_out||0)!==1&&Number(pref.service_consent??1)===1);
 return{customerId,newCanonicalCustomer:unique.length===0,identityReview:false,candidateCustomerIds:unique,serviceContactAllowed};
}

export function publicLeadIdentityStatements(db:Db,input:{plan:PublicLeadIdentityPlan;contactId:string;leadId:string;name:string;phone:string;email:string|null;cityId:string;owner:string;service:string;whatsappConsent:boolean;now:number;routingMode?:"human"|"ai_first"}){
 const statements:D1PreparedStatement[]=[];
 if(input.plan.identityReview){statements.push(db.prepare("INSERT INTO public_contact_identity_reviews (id,contact_id,lead_id,phone_last4,candidate_customer_ids_json,status,reason,created_at) VALUES (?,?,?,?,?,'open','phone_matches_multiple_canonical_customers',?)").bind(`PCIR-${crypto.randomUUID().slice(0,12).toUpperCase()}`,input.contactId,input.leadId,phoneKey(input.phone).slice(-4),JSON.stringify(input.plan.candidateCustomerIds),input.now));return{statements,outboundStatus:"identity_review" as const};}
 if(input.plan.newCanonicalCustomer)statements.push(db.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,secondary_phone,email,source,consent_json,created_at,updated_at) VALUES (?,?,?,?,NULL,?,'public_contact','{}',?,?)").bind(input.plan.customerId,input.cityId,input.name,input.phone,input.email,input.now,input.now));
 // A submitted service enquiry explicitly asks PawSpace to respond about this requirement. It is not
 // marketing consent and it never grants WhatsApp. Existing opt-outs/preferences are never overwritten.
 statements.push(db.prepare("INSERT OR IGNORE INTO customer_contact_preferences (customer_id,marketing_consent,service_consent,whatsapp_consent,sms_consent,email_consent,opt_out,source,updated_by,updated_at) VALUES (?,0,1,0,0,0,0,'public_contact','public-contact',?)").bind(input.plan.customerId,input.now));
 if(input.routingMode==="ai_first")return{statements,outboundStatus:"ai_owned" as const};
 const queueStatus=input.plan.serviceContactAllowed?"queued":"suppressed";
 statements.push(db.prepare("INSERT INTO outbound_routing_queue (id,source_key,customer_id,lead_id,source_type,lane,priority_score,high_intent,lifecycle_code,target_offer,next_best_service,expected_revenue,ltv,callback_at,status,context_json,created_at,updated_at) VALUES (?,?,?,?,?,'human',100,1,'requested_callback',?,NULL,NULL,0,?,?,?, ?,?) ON CONFLICT(source_key) DO NOTHING").bind(`ORQ-${crypto.randomUUID().slice(0,12).toUpperCase()}`,`public-contact:${input.leadId}:first-response`,input.plan.customerId,input.leadId,"public_contact",`New ${input.service} enquiry`,input.now,queueStatus,JSON.stringify({leadOwner:input.owner,service:input.service,origin:"public_contact",marketing:false,whatsappConsent:input.whatsappConsent}),input.now,input.now));
 return{statements,outboundStatus:queueStatus as "queued"|"suppressed"};
}
