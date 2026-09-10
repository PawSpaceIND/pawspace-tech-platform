import { enforceCommunicationDispatchPolicy, ensureCommunicationTables } from "./communication-engine";

type Row = Record<string, unknown>;
const templates = ["case_first_response_overdue", "case_resolution_overdue"];
function parseRecord(value: unknown): Row {
  try { const parsed = JSON.parse(String(value || "{}")); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}; }
  catch { return {}; }
}

export function isCustomerSupportNotice(channel: unknown, purpose: unknown, template: unknown) {
  return channel === "chat" && purpose === "service_recovery" && templates.includes(String(template));
}

// Delivery means available in the authenticated in-app inbox, never external delivery or a read receipt.
export async function deliverCustomerSupportNotice(db: D1Database, messageId: string) {
  const now = Date.now();
  const message = await db.prepare("SELECT * FROM communication_messages WHERE id=?").bind(messageId).first<Row>();
  if (!message || !isCustomerSupportNotice(message.channel, message.purpose, message.template_key)) return { status: "unsupported", externalDelivery: false };
  const claim = await db.prepare("UPDATE communication_outbox SET status='dispatching',locked_at=?,updated_at=? WHERE message_id=? AND status IN ('queued','retry_pending','scheduled') AND next_attempt_at<=?").bind(now, now, messageId, now).run();
  if (!Number(claim.meta?.changes || 0)) return { status: "dispatch_claim_lost", externalDelivery: false };
  const gate = await enforceCommunicationDispatchPolicy(db, messageId, now);
  if (!gate.allowed) return { ...gate, externalDelivery: false };
  const preference = await db.prepare("SELECT service_updates FROM communication_preferences WHERE customer_id=?").bind(message.customer_id).first<Row>();
  const customer = await db.prepare("SELECT consent_json FROM canonical_customers WHERE id=?").bind(message.customer_id).first<Row>();
  const consent = parseRecord(customer?.consent_json);
  const revoked = preference?.service_updates != null ? Number(preference.service_updates) === 0 : consent.serviceUpdates === false;
  const payload = parseRecord(message.payload_json);
  const caseId = String(message.ticket_id || payload.caseId || "");
  const supportCase = await db.prepare("SELECT status,first_responded_at,first_response_due_at,resolution_due_at FROM unified_cases WHERE id=? AND customer_id=? AND booking_id=?").bind(caseId, message.customer_id, message.booking_id).first<Row>();
  const firstResponse = message.template_key === templates[0];
  const dueAt = firstResponse ? supportCase?.first_response_due_at : supportCase?.resolution_due_at;
  const actionable = supportCase && !["resolved", "closed"].includes(String(supportCase.status)) && dueAt != null && Number(dueAt) <= now && (!firstResponse || supportCase.first_responded_at == null);
  if (!customer || revoked || !actionable) {
    await db.batch([
      db.prepare("UPDATE communication_outbox SET status='suppressed',locked_at=NULL,last_error=?,updated_at=? WHERE message_id=? AND status='dispatching'").bind(!customer ? "canonical_customer_missing" : revoked ? "service_updates_opt_out" : "case_notice_no_longer_actionable", now, messageId),
      db.prepare("UPDATE communication_messages SET status='suppressed',updated_at=? WHERE id=? AND status IN ('queued','retry_pending','scheduled')").bind(now, messageId),
    ]);
    return { status: "suppressed", externalDelivery: false };
  }
  // One transaction prevents a recorded delivery event from hiding a failed inbox/outbox update on retry.
  await db.batch([
    db.prepare("UPDATE communication_messages SET status='delivered',provider='internal_chat',updated_at=? WHERE id=? AND status IN ('queued','retry_pending','scheduled') AND EXISTS (SELECT 1 FROM communication_outbox WHERE message_id=? AND status='dispatching')").bind(now, messageId, messageId),
    db.prepare("INSERT OR IGNORE INTO communication_message_delivery_events (id,message_id,provider,event_id,event_type,detail_json,created_at) SELECT ?,?,'internal_chat',?,'delivered',?,? WHERE EXISTS (SELECT 1 FROM communication_messages WHERE id=? AND provider='internal_chat' AND status='delivered')").bind(`INBOX-${messageId}`, messageId, `inbox:${messageId}`, JSON.stringify({ transport: "customer_in_app_inbox", externalDelivery: false }), now, messageId),
    db.prepare("UPDATE communication_outbox SET status='delivered',locked_at=NULL,last_error=NULL,updated_at=? WHERE message_id=? AND status='dispatching' AND EXISTS (SELECT 1 FROM communication_messages WHERE id=? AND provider='internal_chat' AND status='delivered')").bind(now, messageId, messageId),
  ]);
  const final = await db.prepare("SELECT status FROM communication_outbox WHERE message_id=?").bind(messageId).first<Row>();
  return { status: final?.status === "delivered" ? "internal_delivered" : "dispatch_claim_lost", externalDelivery: false };
}

export async function listCustomerSupportNotifications(db: D1Database, customerId: string, before?: { at: number; id: string }) {
  await ensureCommunicationTables(db);
  const rows = await db.prepare(`SELECT id,booking_id,template_key,payload_json,updated_at FROM communication_messages WHERE customer_id=? AND direction='outbound' AND channel='chat' AND purpose='service_recovery' AND template_key IN (?,?) AND provider='internal_chat' AND status IN ('delivered','read') ${before ? "AND (updated_at<? OR (updated_at=? AND id<?))" : ""} ORDER BY updated_at DESC,id DESC LIMIT 51`).bind(customerId, ...templates, ...(before ? [before.at, before.at, before.id] : [])).all<Row>();
  const visible = rows.results.slice(0, 50);
  const items = visible.map(row => {
    const payload = parseRecord(row.payload_json);
    return { id: String(row.id), bookingId: String(row.booking_id || ""), title: "Support update", message: row.template_key === templates[0] ? "Your support case has passed its first-response target and is being escalated to our team." : "Your support case has passed its resolution target and remains escalated to our team.", caseId: typeof payload.caseId === "string" ? payload.caseId : null, deliveredAt: Number(row.updated_at) };
  });
  const last = visible.at(-1);
  return { items, nextCursor: rows.results.length > 50 && last ? { at: Number(last.updated_at), id: String(last.id) } : null };
}
