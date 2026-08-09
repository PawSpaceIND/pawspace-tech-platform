import{ensureCommunicationTables,recordDeliveryEvent}from"./communication-engine";

type Row=Record<string,unknown>;
export const whatsappUatProviders=["limechat","meta_whatsapp","sandbox_simulator"]as const;
export type WhatsAppUatProvider=(typeof whatsappUatProviders)[number];

const text=(value:unknown)=>String(value??"").trim();

export async function ensureWhatsAppUatTables(db:D1Database){
 await ensureCommunicationTables(db);
 await db.prepare("CREATE TABLE IF NOT EXISTS whatsapp_uat_events (id TEXT PRIMARY KEY,provider TEXT NOT NULL,event_id TEXT NOT NULL,event_type TEXT NOT NULL,payload_hash TEXT NOT NULL,customer_id TEXT,message_id TEXT,thread_id TEXT,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,UNIQUE(provider,event_id))").run();
}

async function canonicalCustomer(db:D1Database,customerId:string){
 const customer=await db.prepare("SELECT id FROM canonical_customers WHERE id=?").bind(customerId).first<Row>();
 if(!customer)throw new Response("Canonical customer not found",{status:404});
}

async function openCustomerThread(db:D1Database,customerId:string){
 const existing=await db.prepare("SELECT id FROM communication_threads WHERE customer_id=? AND booking_id IS NULL AND lead_id IS NULL AND ticket_id IS NULL AND status='open' ORDER BY updated_at DESC LIMIT 1").bind(customerId).first<Row>();
 if(existing)return text(existing.id);
 const now=Date.now(),threadId=`THREAD-${crypto.randomUUID().slice(0,12).toUpperCase()}`;
 await db.batch([
  db.prepare("INSERT INTO communication_threads (id,customer_id,booking_id,lead_id,ticket_id,status,assigned_to,sla_due_at,created_at,updated_at) VALUES (?,?,NULL,NULL,NULL,'open',NULL,NULL,?,?)").bind(threadId,customerId,now,now),
  db.prepare("INSERT OR IGNORE INTO communication_participants (id,thread_id,participant_type,participant_id,display_ref,role,created_at) VALUES (?,?,?,?,?,'customer',?)").bind(crypto.randomUUID(),threadId,"customer",customerId,customerId,now),
 ]);
 return threadId;
}

export async function recordWhatsAppUatInbound(db:D1Database,input:{provider:WhatsAppUatProvider;eventId:string;payloadHash:string;customerId:string;text:string;receivedAt?:number;detail?:Record<string,unknown>}){
 await ensureWhatsAppUatTables(db);
 if(!whatsappUatProviders.includes(input.provider))throw new Error("Unsupported WhatsApp UAT provider");
 const eventId=text(input.eventId),customerId=text(input.customerId),messageText=text(input.text);
 if(!eventId||!customerId||!messageText)throw new Error("Event ID, canonical customer and message text are required");
 const prior=await db.prepare("SELECT * FROM whatsapp_uat_events WHERE provider=? AND event_id=?").bind(input.provider,eventId).first<Row>();
 if(prior)return{duplicatePrevented:true,event:prior,externalDelivery:false};
 await canonicalCustomer(db,customerId);
 const threadId=await openCustomerThread(db,customerId),now=Number(input.receivedAt||Date.now()),messageId=`MSG-WA-${crypto.randomUUID().slice(0,12).toUpperCase()}`;
 const policy={environment:"uat",provider:input.provider,externalDelivery:false,identitySource:"canonical_customer_id",signatureRequired:true};
 const detail={source:"whatsapp_uat_inbound",provider:input.provider,...(input.detail??{})};
 await db.batch([
  db.prepare("INSERT INTO communication_messages (id,thread_id,customer_id,booking_id,lead_id,ticket_id,direction,channel,purpose,template_key,payload_json,status,provider,provider_reference,idempotency_key,policy_json,created_by,created_at,updated_at) VALUES (?,?,?,NULL,NULL,NULL,'inbound','whatsapp','transactional','whatsapp_uat_inbound',?,'received',?,?,?,?,'whatsapp_uat_webhook',?,?)").bind(messageId,threadId,customerId,JSON.stringify({text:messageText,...detail}),input.provider,eventId,`whatsapp-uat:${input.provider}:${eventId}`,JSON.stringify(policy),now,now),
  db.prepare("INSERT INTO whatsapp_uat_events (id,provider,event_id,event_type,payload_hash,customer_id,message_id,thread_id,detail_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(`WAUAT-${crypto.randomUUID().slice(0,12).toUpperCase()}`,input.provider,eventId,"inbound_message",input.payloadHash,customerId,messageId,threadId,JSON.stringify(detail),now),
  db.prepare("UPDATE communication_threads SET updated_at=? WHERE id=?").bind(now,threadId),
 ]);
 return{duplicatePrevented:false,messageId,threadId,customerId,status:"received",externalDelivery:false};
}

export async function recordWhatsAppUatDelivery(db:D1Database,input:{provider:WhatsAppUatProvider;eventId:string;messageId:string;eventType:"accepted"|"sent"|"delivered"|"read"|"failed";payloadHash:string;detail?:Record<string,unknown>}){
 await ensureWhatsAppUatTables(db);
 if(!whatsappUatProviders.includes(input.provider))throw new Error("Unsupported WhatsApp UAT provider");
 const prior=await db.prepare("SELECT * FROM whatsapp_uat_events WHERE provider=? AND event_id=?").bind(input.provider,input.eventId).first<Row>();
 if(prior)return{duplicatePrevented:true,event:prior,externalDelivery:false};
 const result=await recordDeliveryEvent(db,{messageId:input.messageId,provider:input.provider,eventId:input.eventId,eventType:input.eventType,detail:{environment:"uat",externalDelivery:false,...(input.detail??{})}});
 const now=Date.now();
 await db.prepare("INSERT INTO whatsapp_uat_events (id,provider,event_id,event_type,payload_hash,customer_id,message_id,thread_id,detail_json,created_at) SELECT ?,?,?,?,?,m.customer_id,m.id,m.thread_id,?,? FROM communication_messages m WHERE m.id=?").bind(`WAUAT-${crypto.randomUUID().slice(0,12).toUpperCase()}`,input.provider,input.eventId,`delivery_${input.eventType}`,input.payloadHash,JSON.stringify({environment:"uat",externalDelivery:false,...(input.detail??{})}),now,input.messageId).run();
 return{...result,externalDelivery:false};
}
