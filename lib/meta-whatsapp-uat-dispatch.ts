import{ensureWhatsAppUatTables}from"./whatsapp-uat-adapter";
import{failOutboxAttempt,recordDeliveryEvent}from"./communication-engine";

type Row=Record<string,unknown>;
type Env=Record<string,unknown>;
type Fetcher=(input:string|URL,init?:RequestInit)=>Promise<Response>;
const text=(value:unknown)=>String(value??"").trim();
const digits=(value:unknown)=>text(value).replace(/\D/g,"");
const list=(value:unknown)=>text(value).split(",").map(item=>item.trim()).filter(Boolean);
const json=<T>(value:unknown,fallback:T):T=>{try{return JSON.parse(String(value??""))as T}catch{return fallback}};

export type MetaTemplateStatus="approved"|"pending_approval"|"rejected"|"paused"|"disabled";
export function normalizeMetaTemplateStatus(value:unknown):MetaTemplateStatus{
 const status=text(value).toUpperCase();
 if(status==="APPROVED")return"approved";
 if(status==="REJECTED")return"rejected";
 if(status==="PAUSED")return"paused";
 if(status==="DISABLED")return"disabled";
 return"pending_approval";
}

function graphVersion(env:Env){const value=text(env.META_WHATSAPP_GRAPH_VERSION)||"v23.0";if(!/^v\d+\.\d+$/.test(value))throw new Error("Meta Graph API version is invalid");return value;}
function graphUrl(env:Env,path:string){return`https://graph.facebook.com/${graphVersion(env)}/${path.replace(/^\/+/,"")}`;}
function uatEnabled(env:Env){return text(env.PAWSPACE_COMMUNICATION_ENV).toLowerCase()==="uat"&&text(env.META_WHATSAPP_UAT_DELIVERY_ENABLED).toLowerCase()==="true";}
function allowlisted(env:Env,phone:string){const normalized=digits(phone);return list(env.META_WHATSAPP_UAT_ALLOWLIST||env.PAWSPACE_COMMUNICATION_UAT_ALLOWLIST).some(item=>digits(item)===normalized);}

async function customerPhoneMatches(db:D1Database,customerId:string,recipient:string){
 const row=await db.prepare("SELECT primary_phone,secondary_phone FROM canonical_customers WHERE id=?").bind(customerId).first<Row>();
 if(!row)return false;const target=digits(recipient);return[row.primary_phone,row.secondary_phone].some(value=>digits(value)===target);
}
async function whatsappAllowed(db:D1Database,customerId:string){
 const row=await db.prepare("SELECT whatsapp_consent,opt_out FROM customer_contact_preferences WHERE customer_id=?").bind(customerId).first<Row>().catch(()=>null);
 return Boolean(row&&Number(row.whatsapp_consent)===1&&Number(row.opt_out||0)!==1);
}

export function buildMetaWhatsAppRequest(input:{recipient:string;templateKey?:string|null;language?:string|null;messageText?:string|null;withinSession:boolean}){
 const to=digits(input.recipient);if(!to)throw new Error("Meta WhatsApp recipient is required");
 if(input.withinSession){const body=text(input.messageText);if(!body)throw new Error("Session reply text is required");return{messaging_product:"whatsapp",recipient_type:"individual",to,type:"text",text:{preview_url:false,body}};}
 const name=text(input.templateKey),language=text(input.language)||"en";if(!name)throw new Error("Approved Meta template is required outside the customer-service window");
 return{messaging_product:"whatsapp",to,type:"template",template:{name,language:{code:language}}};
}

export async function dispatchMetaWhatsAppUat(db:D1Database,env:Env,input:{messageId:string;recipient:string;fetcher?:Fetcher}){
 await ensureWhatsAppUatTables(db);const message=await db.prepare("SELECT m.*,o.status outbox_status,o.next_attempt_at FROM communication_messages m JOIN communication_outbox o ON o.message_id=m.id WHERE m.id=?").bind(input.messageId).first<Row>();
 if(!message||text(message.channel)!=="whatsapp")throw new Error("Queued WhatsApp communication message not found");
 if(!["queued","retry_pending","scheduled"].includes(text(message.outbox_status)))return{status:"already_dispatched",outboxStatus:text(message.outbox_status),externalDelivery:false,productionDelivery:false};
 if(Number(message.next_attempt_at)>Date.now())return{status:"scheduled",nextAttemptAt:Number(message.next_attempt_at),externalDelivery:false,productionDelivery:false};
 const token=text(env.META_WHATSAPP_UAT_ACCESS_TOKEN),phoneNumberId=text(env.META_WHATSAPP_PHONE_NUMBER_ID);
 if(!uatEnabled(env)||!token||!phoneNumberId)return{status:"not_configured",provider:"meta_whatsapp",externalDelivery:false,productionDelivery:false};
 if(!allowlisted(env,input.recipient))return{status:"recipient_not_allowlisted",provider:"meta_whatsapp",externalDelivery:false,productionDelivery:false};
 if(!await customerPhoneMatches(db,text(message.customer_id),input.recipient))return{status:"recipient_customer_mismatch",provider:"meta_whatsapp",externalDelivery:false,productionDelivery:false};
 if(!await whatsappAllowed(db,text(message.customer_id)))return{status:"consent_refused",provider:"meta_whatsapp",externalDelivery:false,productionDelivery:false};
 const session=await db.prepare("SELECT last_inbound_at FROM whatsapp_uat_sessions WHERE customer_id=? AND provider='meta_whatsapp'").bind(text(message.customer_id)).first<Row>(),now=Date.now(),withinSession=Boolean(session&&now-Number(session.last_inbound_at||0)<=24*60*60_000);
 const templateKey=text(message.template_key),payload=json<Record<string,unknown>>(message.payload_json,{}),language=text((payload.language as string)||"en");
 if(!withinSession){const approved=await db.prepare("SELECT status,approved_language FROM whatsapp_uat_templates WHERE template_key=?").bind(templateKey).first<Row>();if(!approved||text(approved.status)!=="approved"||text(approved.approved_language)!==language)return{status:"approved_template_required_outside_session",provider:"meta_whatsapp",externalDelivery:false,productionDelivery:false};}
 const requestBody=buildMetaWhatsAppRequest({recipient:input.recipient,templateKey,language,messageText:text(payload.text),withinSession});
 const locked=await db.prepare("UPDATE communication_outbox SET status='dispatching',locked_at=?,updated_at=? WHERE message_id=? AND status IN ('queued','retry_pending','scheduled')").bind(now,now,input.messageId).run();
 if(Number(locked.meta?.changes||0)!==1)return{status:"dispatch_race_lost",provider:"meta_whatsapp",externalDelivery:false,productionDelivery:false};
 let response:Response;try{response=await(input.fetcher??fetch)(graphUrl(env,`${phoneNumberId}/messages`),{method:"POST",redirect:"error",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify(requestBody)});}catch(error){const retry=await failOutboxAttempt(db,input.messageId,"meta_network_failure");return{...retry,provider:"meta_whatsapp",reason:error instanceof Error?error.message:"meta_network_failure",externalDelivery:false,productionDelivery:false};}
 let result:Record<string,unknown>={};try{result=await response.json()as Record<string,unknown>;}catch{}
 if(!response.ok){const retry=await failOutboxAttempt(db,input.messageId,`meta_http_${response.status}`);return{...retry,provider:"meta_whatsapp",httpStatus:response.status,externalDelivery:false,productionDelivery:false};}
 const messages=Array.isArray(result.messages)?result.messages as Array<Record<string,unknown>>:[],providerReference=text(messages[0]?.id);if(!providerReference){const retry=await failOutboxAttempt(db,input.messageId,"meta_message_id_missing");return{...retry,provider:"meta_whatsapp",externalDelivery:false,productionDelivery:false};}
 await db.prepare("UPDATE communication_messages SET provider='meta_whatsapp',provider_reference=?,updated_at=? WHERE id=?").bind(providerReference,Date.now(),input.messageId).run();
 await recordDeliveryEvent(db,{messageId:input.messageId,provider:"meta_whatsapp",eventId:`accepted:${providerReference}`,eventType:"accepted",detail:{providerReference,environment:"uat",productionDelivery:false}});
 return{status:"provider_accepted",provider:"meta_whatsapp",providerReference,httpStatus:response.status,externalDelivery:true,productionDelivery:false};
}

export async function syncMetaWhatsAppTemplates(db:D1Database,env:Env,input:{actorId:string;fetcher?:Fetcher}){
 await ensureWhatsAppUatTables(db);const token=text(env.META_WHATSAPP_UAT_ACCESS_TOKEN),wabaId=text(env.META_WHATSAPP_WABA_ID);if(text(env.PAWSPACE_COMMUNICATION_ENV).toLowerCase()!=="uat"||!token||!wabaId)return{status:"not_configured",synced:0,externalDelivery:false};
 const allowed=new Set(list(env.META_WHATSAPP_TEMPLATE_ALLOWLIST));if(!allowed.size)return{status:"allowlist_required",synced:0,externalDelivery:false};
 const response=await(input.fetcher??fetch)(`${graphUrl(env,`${wabaId}/message_templates`)}?fields=name,status,category,language&limit=100`,{headers:{authorization:`Bearer ${token}`},redirect:"error"});if(!response.ok)throw new Error(`Meta template sync failed with HTTP ${response.status}`);
 const payload=await response.json()as Record<string,unknown>,rows=Array.isArray(payload.data)?payload.data as Array<Record<string,unknown>>:[],now=Date.now();let synced=0;
 for(const row of rows){const name=text(row.name);if(!name||!allowed.has(name))continue;await db.prepare("INSERT INTO whatsapp_uat_templates (template_key,status,category,approved_language,updated_by,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(template_key) DO UPDATE SET status=excluded.status,category=excluded.category,approved_language=excluded.approved_language,updated_by=excluded.updated_by,updated_at=excluded.updated_at").bind(name,normalizeMetaTemplateStatus(row.status),text(row.category).toLowerCase()||"utility",text(row.language)||"en",input.actorId,now).run();synced++;}
 return{status:"synced",synced,considered:rows.length,externalDelivery:false};
}
