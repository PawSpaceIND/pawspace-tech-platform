import { enforceCommunicationDispatchPolicy } from "./communication-engine";

type Row=Record<string,unknown>;
function record(value:unknown):Row{try{const parsed=JSON.parse(String(value||"{}"));return parsed&&typeof parsed==="object"&&!Array.isArray(parsed)?parsed:{};}catch{return{};}}

// Only an existing, customer-owned order notification can use this internal transport.
export async function deliverOrderNotification(db:D1Database,messageId:string){
 const exists=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='order_notifications'").first<Row>();
 if(!exists)return null;
 const row=await db.prepare("SELECT m.*,n.id notification_id FROM communication_messages m JOIN order_notifications n ON m.idempotency_key=n.idempotency_key||':customer' AND m.customer_id=n.customer_id AND COALESCE(m.booking_id,'')=COALESCE(n.booking_id,n.order_id,'') WHERE m.id=? AND m.channel='chat' AND m.direction='outbound' AND m.purpose='transactional'").bind(messageId).first<Row>();
 if(!row)return null;
 const now=Date.now();
 const claim=await db.prepare("UPDATE communication_outbox SET status='dispatching',locked_at=?,updated_at=? WHERE message_id=? AND status IN ('queued','retry_pending','scheduled') AND next_attempt_at<=?").bind(now,now,messageId,now).run();
 if(!Number(claim.meta?.changes||0))return{status:"dispatch_claim_lost",externalDelivery:false};
 const gate=await enforceCommunicationDispatchPolicy(db,messageId,now);if(!gate.allowed)return{...gate,externalDelivery:false};
 const preference=await db.prepare("SELECT service_updates FROM communication_preferences WHERE customer_id=?").bind(row.customer_id).first<Row>();
 const customer=await db.prepare("SELECT consent_json FROM canonical_customers WHERE id=?").bind(row.customer_id).first<Row>();
 const revoked=preference?.service_updates!=null?Number(preference.service_updates)===0:record(customer?.consent_json).serviceUpdates===false;
 if(!customer||revoked){await db.batch([
  db.prepare("UPDATE communication_outbox SET status='suppressed',locked_at=NULL,last_error='service_updates_unavailable',updated_at=? WHERE message_id=? AND status='dispatching'").bind(now,messageId),
  db.prepare("UPDATE communication_messages SET status='suppressed',updated_at=? WHERE id=? AND status IN ('queued','retry_pending','scheduled')").bind(now,messageId),
  db.prepare("UPDATE order_notifications SET delivery_status='suppressed',delivery_error='service_updates_unavailable' WHERE id=?").bind(row.notification_id),
 ]);return{status:"suppressed",externalDelivery:false};}
 await db.batch([
  db.prepare("UPDATE communication_messages SET status='delivered',provider='internal_chat',updated_at=? WHERE id=? AND status IN ('queued','retry_pending','scheduled') AND EXISTS (SELECT 1 FROM communication_outbox WHERE message_id=? AND status='dispatching')").bind(now,messageId,messageId),
  db.prepare("INSERT OR IGNORE INTO communication_message_delivery_events (id,message_id,provider,event_id,event_type,detail_json,created_at) SELECT ?,?,'internal_chat',?,'delivered',?,? WHERE EXISTS (SELECT 1 FROM communication_messages WHERE id=? AND provider='internal_chat' AND status='delivered')").bind(`ORDER-INBOX-${messageId}`,messageId,`order-inbox:${messageId}`,JSON.stringify({transport:"order_in_app_inbox",externalDelivery:false}),now,messageId),
  db.prepare("UPDATE communication_outbox SET status='delivered',locked_at=NULL,last_error=NULL,updated_at=? WHERE message_id=? AND status='dispatching' AND EXISTS (SELECT 1 FROM communication_messages WHERE id=? AND provider='internal_chat' AND status='delivered')").bind(now,messageId,messageId),
  db.prepare("UPDATE order_notifications SET delivery_status='delivered',delivery_error=NULL WHERE id=? AND EXISTS (SELECT 1 FROM communication_outbox WHERE message_id=? AND status='delivered')").bind(row.notification_id,messageId),
 ]);
 const saved=await db.prepare("SELECT status FROM communication_outbox WHERE message_id=?").bind(messageId).first<Row>();
 return{status:saved?.status==="delivered"?"internal_delivered":"dispatch_claim_lost",externalDelivery:false};
}

export async function reconcileOrderNotificationDelivery(db:D1Database){
 const tables=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('order_notifications','communication_messages')").all<Row>();if(tables.results.length!==2)return;
 await db.prepare("UPDATE order_notifications SET delivery_status=(SELECT m.status FROM communication_messages m WHERE m.idempotency_key=order_notifications.idempotency_key||':customer' AND m.customer_id=order_notifications.customer_id),delivery_error=CASE WHEN (SELECT m.status FROM communication_messages m WHERE m.idempotency_key=order_notifications.idempotency_key||':customer') IN ('delivered','read','sent','provider_accepted') THEN NULL ELSE delivery_error END WHERE EXISTS (SELECT 1 FROM communication_messages m WHERE m.idempotency_key=order_notifications.idempotency_key||':customer' AND m.customer_id=order_notifications.customer_id AND m.status<>order_notifications.delivery_status)").run();
}
