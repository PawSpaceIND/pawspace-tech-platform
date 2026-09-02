import{ensureCommunicationTables}from"./communication-engine";
import{ensureHaptikTables}from"./haptik-integration-governance";

type Db=D1Database;
type Env=Record<string,unknown>;
type Row=Record<string,unknown>;
const text=(value:unknown)=>String(value??"").trim();
const phone=(value:unknown)=>text(value).replace(/\D/g,"").slice(-10);
const encoder=new TextEncoder();
const safeEqual=(left:string,right:string)=>{if(left.length!==right.length)return false;let diff=0;for(let i=0;i<left.length;i++)diff|=left.charCodeAt(i)^right.charCodeAt(i);return diff===0;};
const hex=(buffer:ArrayBuffer)=>Array.from(new Uint8Array(buffer)).map(byte=>byte.toString(16).padStart(2,"0")).join("");
const optOutWords=new Set(["stop","unsubscribe","cancel","end","quit"]);

export const INTERAKT_WHATSAPP_PROVIDER="interakt_whatsapp";
export const INTERAKT_SECRET_NAMES=["INTERAKT_WEBHOOK_SECRET","INTERAKT_API_KEY"]as const;

export async function verifyInteraktWebhook(rawBody:string,headers:Headers,env:Env){
 const secret=text(env.INTERAKT_WEBHOOK_SECRET);if(!secret)return{ok:false as const,status:503,reason:"interakt_webhook_not_configured"};
 const signature=text(headers.get("x-interakt-signature")).toLowerCase().replace(/^sha256=/,"");
 if(signature){const key=await crypto.subtle.importKey("raw",encoder.encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);const expected=hex(await crypto.subtle.sign("HMAC",key,encoder.encode(rawBody)));return safeEqual(signature,expected)?{ok:true as const}:{ok:false as const,status:401,reason:"invalid_interakt_signature"};}
 const presented=text(headers.get("x-interakt-webhook-secret")||headers.get("authorization")).replace(/^Bearer\s+/i,"");
 return presented&&safeEqual(presented,secret)?{ok:true as const}:{ok:false as const,status:401,reason:"invalid_interakt_credentials"};
}

async function resolveCanonicalCustomer(db:Db,input:{providerIdentity:string;claimedCustomerId?:string|null}){
 const identity=phone(input.providerIdentity);if(!identity)throw new Response("Interakt sender phone is required",{status:400});
 if(input.claimedCustomerId){const row=await db.prepare("SELECT id,name,primary_phone,secondary_phone FROM canonical_customers WHERE id=?").bind(text(input.claimedCustomerId)).first<Row>();if(!row)throw new Response("Canonical customer not found",{status:404});if(![row.primary_phone,row.secondary_phone].some(value=>phone(value)===identity))throw new Response("Interakt customer ownership mismatch",{status:409});return row;}
 const rows=await db.prepare("SELECT id,name,primary_phone,secondary_phone FROM canonical_customers").all<Row>();const matches=rows.results.filter(row=>[row.primary_phone,row.secondary_phone].some(value=>phone(value)===identity));if(matches.length!==1)throw new Response("Interakt identity requires governed customer resolution",{status:409});return matches[0];
}

async function consentState(db:Db,customerId:string){
 const pref=await db.prepare("SELECT marketing_consent,whatsapp_consent,opt_out FROM customer_contact_preferences WHERE customer_id=?").bind(customerId).first<Row>().catch(()=>null);
 return{marketing:Number(pref?.marketing_consent||0)===1,whatsapp:Number(pref?.whatsapp_consent||0)===1,optOut:Number(pref?.opt_out||0)===1};
}

async function persistOptOut(db:Db,customerId:string,now:number){
 await db.prepare("INSERT INTO customer_contact_preferences (customer_id,marketing_consent,service_consent,whatsapp_consent,sms_consent,email_consent,opt_out,source,updated_by,updated_at) VALUES (?,0,0,0,0,0,1,'interakt_inbound_opt_out','interakt_webhook',?) ON CONFLICT(customer_id) DO UPDATE SET marketing_consent=0,whatsapp_consent=0,opt_out=1,source='interakt_inbound_opt_out',updated_by='interakt_webhook',updated_at=excluded.updated_at").bind(customerId,now).run();
}

async function ensureCrmOwnership(db:Db,customer:Row,input:{providerIdentity:string;service:string}){
 await ensureHaptikTables(db);const customerId=text(customer.id),now=Date.now();
 await db.prepare("INSERT INTO crm_contacts (id,name,primary_phone,stage,owner,source,created_at,updated_at) VALUES (?,?,?,'New lead','Unassigned','interakt_whatsapp',?,?) ON CONFLICT(id) DO UPDATE SET name=COALESCE(NULLIF(excluded.name,''),crm_contacts.name),primary_phone=excluded.primary_phone,source='interakt_whatsapp',updated_at=excluded.updated_at").bind(customerId,text(customer.name)||`Customer ${phone(input.providerIdentity).slice(-4)}`,input.providerIdentity,now,now).run();
 const prior=await db.prepare("SELECT id FROM lead_work_items WHERE customer_id=? AND status IN ('active','sla_breached','qualified') ORDER BY created_at DESC LIMIT 1").bind(customerId).first<Row>();if(prior)return text(prior.id);
 const leadId=`LWI-${crypto.randomUUID().slice(0,12).toUpperCase()}`;await db.prepare("INSERT INTO lead_work_items (id,customer_id,source,service,owner,manager,status,stage,work_day,assigned_at,first_action_due_at,manager_alert_at,created_at,updated_at) VALUES (?,?,?,?,'Unassigned','Unassigned','active','day_1',1,?,?,?,?,?)").bind(leadId,customerId,"interakt_whatsapp",input.service||"general_enquiry",now,now+30*60_000,now+60*60_000,now,now).run();return leadId;
}

async function recordInboundMessage(db:Db,input:{eventId:string;customerId:string;leadId:string;message:string;providerIdentity:string;receivedAt:number}){
 await ensureCommunicationTables(db);const duplicate=await db.prepare("SELECT id,thread_id FROM communication_messages WHERE idempotency_key=?").bind(`interakt:${input.eventId}`).first<Row>();if(duplicate)return{duplicatePrevented:true,messageId:text(duplicate.id),threadId:text(duplicate.thread_id)};
 let thread=await db.prepare("SELECT id FROM communication_threads WHERE customer_id=? AND status='open' ORDER BY updated_at DESC LIMIT 1").bind(input.customerId).first<Row>();if(!thread){const id=`THREAD-${crypto.randomUUID().slice(0,12).toUpperCase()}`;await db.prepare("INSERT INTO communication_threads (id,customer_id,booking_id,lead_id,ticket_id,status,assigned_to,sla_due_at,created_at,updated_at) VALUES (?,?,NULL,?,NULL,'open',NULL,NULL,?,?)").bind(id,input.customerId,input.leadId,input.receivedAt,input.receivedAt).run();thread={id};}
 const threadId=text(thread.id),messageId=`MSG-IA-${crypto.randomUUID().slice(0,12).toUpperCase()}`;await db.prepare("INSERT INTO communication_messages (id,thread_id,customer_id,booking_id,lead_id,ticket_id,direction,channel,purpose,template_key,payload_json,status,provider,provider_reference,idempotency_key,policy_json,created_by,created_at,updated_at) VALUES (?,?,?,NULL,?,NULL,'inbound','whatsapp','transactional','interakt_inbound',?,'received',?,?,?,?,'interakt_webhook',?,?)").bind(messageId,threadId,input.customerId,input.leadId,JSON.stringify({text:input.message,providerIdentity:input.providerIdentity}),INTERAKT_WHATSAPP_PROVIDER,input.eventId,`interakt:${input.eventId}`,JSON.stringify({canonicalCustomerVerified:true,marketingConsentInferred:false}),input.receivedAt,input.receivedAt).run();await db.prepare("UPDATE communication_threads SET lead_id=COALESCE(lead_id,?),updated_at=? WHERE id=?").bind(input.leadId,input.receivedAt,threadId).run();return{duplicatePrevented:false,messageId,threadId};
}

export async function processInteraktInbound(db:Db,env:Env,input:{rawBody:string;headers:Headers}){
 const verified=await verifyInteraktWebhook(input.rawBody,input.headers,env);if(!verified.ok)return{accepted:false,status:verified.status,reason:verified.reason,externalDelivery:false};
 let body:Record<string,unknown>;try{body=JSON.parse(input.rawBody)as Record<string,unknown>}catch{return{accepted:false,status:400,reason:"invalid_interakt_json",externalDelivery:false}};
 const eventId=text(body.event_id||body.eventId||body.id),providerIdentity=text(body.phone||body.from||body.wa_id||body.waId),message=text(body.message||body.text||body.body),claimedCustomerId=text(body.customer_id||body.customerId)||null,service=text(body.service||body.inquiry_category||body.inquiryCategory)||"general_enquiry";
 if(!eventId||!providerIdentity||!message)return{accepted:false,status:400,reason:"interakt_event_phone_and_message_required",externalDelivery:false};
 const customer=await resolveCanonicalCustomer(db,{providerIdentity,claimedCustomerId}),customerId=text(customer.id),now=Number(body.timestamp||Date.now());
 const leadId=await ensureCrmOwnership(db,customer,{providerIdentity,service});const normalized=message.toLowerCase().replace(/[.!?,;:]+$/g,"");if(optOutWords.has(normalized))await persistOptOut(db,customerId,now);
 const recorded=await recordInboundMessage(db,{eventId,customerId,leadId,message,providerIdentity,receivedAt:now});const consent=await consentState(db,customerId);
 return{accepted:true,status:recorded.duplicatePrevented?200:201,eventId,customerId,leadId,...recorded,optedOut:consent.optOut,whatsappConsent:consent.whatsapp,marketingConsent:consent.marketing,marketingConsentInferred:false,externalDelivery:false};
}

export async function interaktOutboundConsentGuard(db:Db,input:{customerId:string;recipient:string;purpose:"transactional"|"marketing"}){
 const customer=await db.prepare("SELECT primary_phone,secondary_phone FROM canonical_customers WHERE id=?").bind(input.customerId).first<Row>();if(!customer)return{allowed:false as const,reason:"canonical_customer_required"};if(![customer.primary_phone,customer.secondary_phone].some(value=>phone(value)===phone(input.recipient)))return{allowed:false as const,reason:"recipient_customer_mismatch"};const consent=await consentState(db,input.customerId);if(consent.optOut)return{allowed:false as const,reason:"customer_opted_out"};if(!consent.whatsapp)return{allowed:false as const,reason:"whatsapp_consent_required"};if(input.purpose==="marketing"&&!consent.marketing)return{allowed:false as const,reason:"marketing_consent_required"};return{allowed:true as const,reason:null};
}
