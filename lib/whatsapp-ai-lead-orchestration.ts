import{ensureCustomerAccountTables}from"./customer-account";
import{ensureCustomer360Tables}from"./customer-360";
import{ensureWhatsAppUatTables,queueWhatsAppUatOutbound,type WhatsAppUatProvider}from"./whatsapp-uat-adapter";

type Row=Record<string,unknown>;
const text=(value:unknown)=>String(value??"").trim();
const phone=(value:unknown)=>text(value).replace(/\D/g,"").slice(-10);
const uid=(prefix:string)=>`${prefix}-${crypto.randomUUID().slice(0,12).toUpperCase()}`;

export const WHATSAPP_AI_LEAD_TEMPLATE="pawspace_lead_first_response_v1";

export type WhatsAppAiLeadInput={
 leadId:string;
 contactId:string;
 idempotencyKey:string;
 consentGranted:boolean;
 consentSource:string;
 consentEvidenceRef:string;
 actorId:string;
 assignedTo?:string;
 cityId?:string;
 provider?:WhatsAppUatProvider;
};

export async function ensureWhatsAppAiLeadTables(db:D1Database){
 await ensureCustomerAccountTables(db);await ensureCustomer360Tables(db);await ensureWhatsAppUatTables(db);
 await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS whatsapp_ai_lead_triggers (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,owner_token TEXT NOT NULL,lead_id TEXT NOT NULL UNIQUE,contact_id TEXT NOT NULL,customer_id TEXT,thread_id TEXT,message_id TEXT,status TEXT NOT NULL,reason TEXT,template_key TEXT NOT NULL,consent_evidence_id TEXT,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS whatsapp_ai_consent_evidence (id TEXT PRIMARY KEY,lead_id TEXT NOT NULL,contact_id TEXT NOT NULL,customer_id TEXT,channel TEXT NOT NULL,purpose TEXT NOT NULL,granted INTEGER NOT NULL,source TEXT NOT NULL,evidence_ref TEXT NOT NULL,wording_version TEXT NOT NULL,captured_by TEXT NOT NULL,captured_at INTEGER NOT NULL,revoked_at INTEGER,UNIQUE(lead_id,channel,purpose))"),
  db.prepare("CREATE TABLE IF NOT EXISTS whatsapp_ai_identity_reviews (id TEXT PRIMARY KEY,lead_id TEXT NOT NULL,contact_id TEXT NOT NULL,phone_last4 TEXT NOT NULL,candidate_customer_ids_json TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open',reason TEXT NOT NULL,created_at INTEGER NOT NULL,resolved_at INTEGER,resolved_by TEXT)"),
  db.prepare("CREATE INDEX IF NOT EXISTS whatsapp_ai_trigger_status_idx ON whatsapp_ai_lead_triggers(status,updated_at)"),
  // Meta still owns the final category and approval decision. This row is deliberately pending until
  // the exact template is approved in the connected WhatsApp Business Account.
  db.prepare("INSERT OR IGNORE INTO whatsapp_uat_templates (template_key,status,category,approved_language,updated_by,updated_at) VALUES (?,'pending_approval','utility','en','system',?)").bind(WHATSAPP_AI_LEAD_TEMPLATE,Date.now()),
 ]);
}

async function triggerResult(db:D1Database,id:string,duplicatePrevented:boolean){
 const row=await db.prepare("SELECT id,lead_id,contact_id,customer_id,thread_id,message_id,status,reason,template_key,detail_json,created_at,updated_at FROM whatsapp_ai_lead_triggers WHERE id=?").bind(id).first<Row>();
 return{duplicatePrevented,...row,externalDelivery:false,marketing:false};
}

async function stop(db:D1Database,id:string,status:"blocked"|"setup_required"|"identity_review",reason:string,detail:Record<string,unknown>={}){
 await db.prepare("UPDATE whatsapp_ai_lead_triggers SET status=?,reason=?,detail_json=?,updated_at=? WHERE id=?").bind(status,reason,JSON.stringify(detail),Date.now(),id).run();
 return triggerResult(db,id,false);
}

async function canonicalIdentity(db:D1Database,input:{leadId:string;contact:Row;cityId?:string}){
 const contactId=text(input.contact.id),digits=phone(input.contact.primary_phone);
 if(digits.length!==10)throw new Error("A valid ten-digit WhatsApp number is required");
 const customers=(await db.prepare("SELECT id,primary_phone FROM canonical_customers").all<Row>()).results;
 const matches=customers.filter(row=>phone(row.primary_phone)===digits);
 const byId=customers.find(row=>text(row.id)===contactId);
 if(byId&&phone(byId.primary_phone)!==digits)return{customerId:null,candidates:[text(byId.id),...matches.map(row=>text(row.id))],reason:"contact_id_phone_conflict"};
 const unique=[...new Set(matches.map(row=>text(row.id)))];
 if(unique.length>1)return{customerId:null,candidates:unique,reason:"phone_matches_multiple_customers"};
 if(byId)return{customerId:contactId,candidates:[contactId],reason:null};
 if(unique.length===1)return{customerId:unique[0],candidates:unique,reason:null};
 const now=Date.now();
 await db.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,secondary_phone,email,source,consent_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'{}',?,?)")
  .bind(contactId,text(input.cityId)||"blr",text(input.contact.name)||"PawSpace lead",text(input.contact.primary_phone),input.contact.secondary_phone??null,input.contact.email??null,"crm_lead",now,now).run();
 return{customerId:contactId,candidates:[contactId],reason:null};
}

async function leadThread(db:D1Database,input:{leadId:string;customerId:string;assignedTo?:string}){
 const existing=await db.prepare("SELECT id FROM communication_threads WHERE customer_id=? AND lead_id=? AND booking_id IS NULL AND ticket_id IS NULL AND status='open' ORDER BY updated_at DESC LIMIT 1").bind(input.customerId,input.leadId).first<Row>();
 if(existing)return text(existing.id);
 const now=Date.now(),threadId=uid("THREAD");
 await db.batch([
  db.prepare("INSERT INTO communication_threads (id,customer_id,booking_id,lead_id,ticket_id,status,assigned_to,sla_due_at,created_at,updated_at) VALUES (?,?,NULL,?,NULL,'open',?, ?,?,?)").bind(threadId,input.customerId,input.leadId,input.assignedTo??null,now+10*60_000,now,now),
  db.prepare("INSERT OR IGNORE INTO communication_participants (id,thread_id,participant_type,participant_id,display_ref,role,created_at) VALUES (?,?,?,?,?,'customer',?)").bind(crypto.randomUUID(),threadId,"customer",input.customerId,input.customerId,now),
 ]);
 return threadId;
}

/**
 * Starts exactly one non-marketing WhatsApp first-response workflow for a newly captured lead.
 * The lead itself always survives a blocked/misconfigured automation; staff can work the CRM task.
 */
export async function startWhatsAppAiLead(db:D1Database,input:WhatsAppAiLeadInput){
 await ensureWhatsAppAiLeadTables(db);
 const leadId=text(input.leadId),contactId=text(input.contactId),key=text(input.idempotencyKey),ownerToken=crypto.randomUUID(),now=Date.now();
 if(!leadId||!contactId||key.length<8)throw new Error("Lead, contact and idempotency key are required");
 await db.prepare("INSERT OR IGNORE INTO whatsapp_ai_lead_triggers (id,idempotency_key,owner_token,lead_id,contact_id,status,template_key,created_at,updated_at) VALUES (?,?,?,?,?,'processing',?,?,?)")
  .bind(uid("WALT"),key,ownerToken,leadId,contactId,WHATSAPP_AI_LEAD_TEMPLATE,now,now).run();
 let reservation=await db.prepare("SELECT * FROM whatsapp_ai_lead_triggers WHERE idempotency_key=?").bind(key).first<Row>();
 if(!reservation)reservation=await db.prepare("SELECT * FROM whatsapp_ai_lead_triggers WHERE lead_id=?").bind(leadId).first<Row>();
 if(!reservation)throw new Error("WhatsApp lead trigger reservation failed");
 const triggerId=text(reservation.id);
 if(text(reservation.lead_id)!==leadId||text(reservation.contact_id)!==contactId)throw new Error("WhatsApp lead idempotency key was reused for a different lead");
 if(text(reservation.owner_token)!==ownerToken){
  const retryable=text(reservation.status)==="setup_required"||(["explicit_whatsapp_consent_required","consent_evidence_required"].includes(text(reservation.reason))&&text(reservation.status)==="blocked");
  if(!retryable)return triggerResult(db,triggerId,true);
  await db.prepare("UPDATE whatsapp_ai_lead_triggers SET owner_token=?,status='processing',reason=NULL,updated_at=? WHERE id=? AND owner_token=? AND status=?").bind(ownerToken,Date.now(),triggerId,text(reservation.owner_token),text(reservation.status)).run();
  reservation=await db.prepare("SELECT * FROM whatsapp_ai_lead_triggers WHERE id=?").bind(triggerId).first<Row>();
  if(!reservation||text(reservation.owner_token)!==ownerToken)return triggerResult(db,triggerId,true);
 }

 const lead=await db.prepare("SELECT id,customer_id,opt_out,status FROM lead_work_items WHERE id=?").bind(leadId).first<Row>();
 const contact=await db.prepare("SELECT id,name,primary_phone,secondary_phone,email,area,opportunity FROM crm_contacts WHERE id=?").bind(contactId).first<Row>();
 if(!lead||!contact||text(lead.customer_id)!==contactId)return stop(db,triggerId,"blocked","lead_contact_mismatch");
 if(Number(lead.opt_out||0)===1)return stop(db,triggerId,"blocked","lead_opted_out");
 if(!input.consentGranted)return stop(db,triggerId,"blocked","explicit_whatsapp_consent_required");
 const source=text(input.consentSource),evidenceRef=text(input.consentEvidenceRef);
 if(source.length<3||evidenceRef.length<5)return stop(db,triggerId,"blocked","consent_evidence_required");

 const identity=await canonicalIdentity(db,{leadId,contact,cityId:input.cityId});
 if(!identity.customerId){
  const reviewId=uid("WAIR");
  await db.prepare("INSERT INTO whatsapp_ai_identity_reviews (id,lead_id,contact_id,phone_last4,candidate_customer_ids_json,status,reason,created_at) VALUES (?,?,?,?,?,'open',?,?)")
   .bind(reviewId,leadId,contactId,phone(contact.primary_phone).slice(-4),JSON.stringify(identity.candidates),identity.reason,Date.now()).run();
  return stop(db,triggerId,"identity_review",identity.reason||"identity_review_required",{reviewId,candidates:identity.candidates});
 }
 const customerId=identity.customerId,capturedAt=Date.now(),existingEvidence=await db.prepare("SELECT id FROM whatsapp_ai_consent_evidence WHERE lead_id=? AND channel='whatsapp' AND purpose='lead_response'").bind(leadId).first<Row>(),consentId=existingEvidence?text(existingEvidence.id):uid("WACE");
 const priorPreference=await db.prepare("SELECT opt_out FROM customer_contact_preferences WHERE customer_id=?").bind(customerId).first<Row>();
 if(Number(priorPreference?.opt_out||0)===1)return stop(db,triggerId,"blocked","customer_opted_out");
 await db.batch([
  db.prepare("INSERT OR IGNORE INTO whatsapp_ai_consent_evidence (id,lead_id,contact_id,customer_id,channel,purpose,granted,source,evidence_ref,wording_version,captured_by,captured_at) VALUES (?,?,?,?, 'whatsapp','lead_response',1,?,?, 'whatsapp-lead-consent-v1',?,?)").bind(consentId,leadId,contactId,customerId,source,evidenceRef,input.actorId,capturedAt),
  db.prepare("INSERT INTO customer_contact_preferences (customer_id,marketing_consent,service_consent,whatsapp_consent,sms_consent,email_consent,opt_out,source,updated_by,updated_at) VALUES (?,0,0,1,0,0,0,?,?,?) ON CONFLICT(customer_id) DO UPDATE SET whatsapp_consent=1,source=excluded.source,updated_by=excluded.updated_by,updated_at=excluded.updated_at WHERE customer_contact_preferences.opt_out=0").bind(customerId,source,input.actorId,capturedAt),
  db.prepare("UPDATE whatsapp_ai_lead_triggers SET customer_id=?,consent_evidence_id=?,updated_at=? WHERE id=?").bind(customerId,consentId,capturedAt,triggerId),
 ]);
 const threadId=await leadThread(db,{leadId,customerId,assignedTo:input.assignedTo});
 const provider=input.provider??"sandbox_simulator",firstName=text(contact.name).split(/\s+/)[0]||"there",service=text(contact.opportunity)||"your pet-care requirement";
 const queued=await queueWhatsAppUatOutbound(db,{provider,threadId,customerId,text:`Hi ${firstName}, thanks for contacting PawSpace about ${service}. Reply here to continue with our booking assistant, or type STOP to opt out.`,idempotencyKey:`whatsapp-ai-lead:${leadId}:first-response:v1`,createdBy:input.actorId,templateKey:WHATSAPP_AI_LEAD_TEMPLATE,language:"en"});
 if(!queued.queued)return stop(db,triggerId,"setup_required",text(queued.reason)||"whatsapp_setup_required",{threadId,provider});
 await db.prepare("UPDATE whatsapp_ai_lead_triggers SET customer_id=?,thread_id=?,message_id=?,status='queued',reason=NULL,detail_json=?,updated_at=? WHERE id=?")
  .bind(customerId,threadId,queued.messageId,JSON.stringify({provider,externalDelivery:false,marketing:false,templateKey:WHATSAPP_AI_LEAD_TEMPLATE}),Date.now(),triggerId).run();
 return triggerResult(db,triggerId,false);
}
