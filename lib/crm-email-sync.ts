import { ensureCommunicationTables } from "./communication-engine";

type Db = D1Database;
type Row = Record<string, unknown>;
const text = (v: unknown) => String(v ?? "").trim();
const uid = (p: string) => `${p}-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
const lower = (v: unknown) => text(v).toLowerCase();

export async function ensureCrmEmailTables(db: Db) {
  await ensureCommunicationTables(db);
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS crm_email_accounts (id TEXT PRIMARY KEY,provider TEXT NOT NULL,address TEXT NOT NULL UNIQUE,status TEXT NOT NULL DEFAULT 'configuration_required',sync_cursor TEXT,calendar_sync_enabled INTEGER NOT NULL DEFAULT 0,last_synced_at INTEGER,updated_by TEXT NOT NULL,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS crm_email_events (id TEXT PRIMARY KEY,provider TEXT NOT NULL,provider_event_id TEXT NOT NULL,event_type TEXT NOT NULL,message_id TEXT,thread_id TEXT,customer_id TEXT,provider_message_id TEXT,detail_json TEXT NOT NULL DEFAULT '{}',occurred_at INTEGER NOT NULL,created_at INTEGER NOT NULL,UNIQUE(provider,provider_event_id))"),
    db.prepare("CREATE INDEX IF NOT EXISTS crm_email_events_customer_idx ON crm_email_events(customer_id,occurred_at DESC)"),
    db.prepare("CREATE TABLE IF NOT EXISTS crm_calendar_sync_items (id TEXT PRIMARY KEY,provider TEXT NOT NULL,provider_event_id TEXT NOT NULL UNIQUE,customer_id TEXT,lead_id TEXT,opportunity_id TEXT,title TEXT NOT NULL,start_at INTEGER NOT NULL,end_at INTEGER,status TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',updated_at INTEGER NOT NULL)"),
  ]);
}

async function customerByEmail(db: Db, address: string) {
  const normalized = lower(address);
  if (!normalized) return null;
  return (await db.prepare("SELECT id,email,city_id FROM canonical_customers WHERE lower(email)=? LIMIT 1").bind(normalized).first<Row>().catch(() => null))
    || (await db.prepare("SELECT id,email,area city_id FROM crm_contacts WHERE lower(email)=? LIMIT 1").bind(normalized).first<Row>().catch(() => null));
}

async function openThread(db: Db, customerId: string, leadId: string | null, now: number) {
  const prior = await db.prepare("SELECT id FROM communication_threads WHERE customer_id=? AND COALESCE(lead_id,'')=? AND status='open' ORDER BY updated_at DESC LIMIT 1")
    .bind(customerId, leadId || "").first<Row>();
  if (prior) return text(prior.id);
  const id = uid("EMAIL-THREAD");
  await db.prepare("INSERT INTO communication_threads (id,customer_id,lead_id,status,assigned_to,sla_due_at,created_at,updated_at) VALUES (?,?,?,'open',NULL,?,?,?)")
    .bind(id, customerId, leadId, now + 30 * 60_000, now, now).run();
  return id;
}

export async function ingestInboundEmail(db: Db, input: { provider: string; providerEventId: string; providerMessageId: string; from: string; to: string; subject: string; textBody: string; receivedAt?: number }) {
  await ensureCrmEmailTables(db);
  const duplicate = await db.prepare("SELECT id FROM crm_email_events WHERE provider=? AND provider_event_id=?").bind(input.provider, input.providerEventId).first<Row>();
  if (duplicate) return { duplicatePrevented: true, eventId: duplicate.id };
  const customer = await customerByEmail(db, input.from);
  if (!customer) return { accepted: false, reason: "customer_not_resolved", duplicatePrevented: false };
  const lead = await db.prepare("SELECT id FROM lead_work_items WHERE customer_id=? AND status NOT IN ('closed','merged') ORDER BY updated_at DESC LIMIT 1").bind(customer.id).first<Row>().catch(() => null);
  const now = input.receivedAt ?? Date.now(), threadId = await openThread(db, text(customer.id), lead ? text(lead.id) : null, now), messageId = uid("EMAIL-IN");
  await db.batch([
    db.prepare("INSERT INTO communication_messages (id,thread_id,customer_id,lead_id,direction,channel,purpose,template_key,payload_json,status,provider,provider_reference,idempotency_key,policy_json,created_by,created_at,updated_at) VALUES (?,?,?,?,'inbound','email','transactional','inbound_email',?,'delivered',?,?,?,'{}','provider:webhook',?,?)")
      .bind(messageId, threadId, customer.id, lead?.id || null, JSON.stringify({ from: input.from, to: input.to, subject: input.subject, text: input.textBody }), input.provider, input.providerMessageId, `email-in:${input.provider}:${input.providerMessageId}`, now, now),
    db.prepare("INSERT INTO crm_email_events (id,provider,provider_event_id,event_type,message_id,thread_id,customer_id,provider_message_id,detail_json,occurred_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .bind(uid("EMEV"), input.provider, input.providerEventId, "inbound", messageId, threadId, customer.id, input.providerMessageId, JSON.stringify({ from: input.from, to: input.to, subject: input.subject }), now, Date.now()),
    db.prepare("UPDATE communication_threads SET updated_at=? WHERE id=?").bind(now, threadId),
  ]);
  if (lead) await db.prepare("UPDATE lead_work_items SET last_outcome='Inbound email received',next_action_at=?,updated_at=? WHERE id=?").bind(now, now, lead.id).run().catch(() => undefined);
  return { accepted: true, customerId: customer.id, leadId: lead?.id || null, threadId, messageId, duplicatePrevented: false };
}

export async function recordEmailEngagement(db: Db, input: { provider: string; providerEventId: string; providerMessageId: string; eventType: "delivered" | "open" | "click" | "bounce" | "complaint"; occurredAt?: number; detail?: Record<string, unknown> }) {
  await ensureCrmEmailTables(db);
  const prior = await db.prepare("SELECT id FROM crm_email_events WHERE provider=? AND provider_event_id=?").bind(input.provider, input.providerEventId).first<Row>();
  if (prior) return { duplicatePrevented: true };
  const message = await db.prepare("SELECT id,thread_id,customer_id FROM communication_messages WHERE provider_reference=? AND channel='email' ORDER BY created_at DESC LIMIT 1").bind(input.providerMessageId).first<Row>();
  const now = input.occurredAt ?? Date.now();
  await db.prepare("INSERT INTO crm_email_events (id,provider,provider_event_id,event_type,message_id,thread_id,customer_id,provider_message_id,detail_json,occurred_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .bind(uid("EMEV"), input.provider, input.providerEventId, input.eventType, message?.id || null, message?.thread_id || null, message?.customer_id || null, input.providerMessageId, JSON.stringify(input.detail || {}), now, Date.now()).run();
  if (message) {
    const mapped = input.eventType === "delivered" ? "delivered" : input.eventType === "open" || input.eventType === "click" ? "read" : input.eventType === "bounce" || input.eventType === "complaint" ? "dead_letter" : null;
    if (mapped) await db.prepare("UPDATE communication_messages SET status=?,updated_at=? WHERE id=?").bind(mapped, now, message.id).run();
  }
  return { duplicatePrevented: false, messageId: message?.id || null, customerId: message?.customer_id || null };
}

export async function syncCalendarEvents(db: Db, input: { provider: string; events: Array<{ id: string; attendeeEmail?: string; title: string; startAt: number; endAt: number; status?: string; detail?: Record<string, unknown> }> }) {
  await ensureCrmEmailTables(db);
  let processed = 0;
  for (const event of input.events) {
    const customer = event.attendeeEmail ? await customerByEmail(db, event.attendeeEmail) : null;
    const lead = customer ? await db.prepare("SELECT id FROM lead_work_items WHERE customer_id=? AND status NOT IN ('closed','merged') ORDER BY updated_at DESC LIMIT 1").bind(customer.id).first<Row>().catch(() => null) : null;
    const opportunity = lead ? await db.prepare("SELECT id FROM crm_opportunities WHERE lead_id=? LIMIT 1").bind(lead.id).first<Row>().catch(() => null) : null;
    await db.prepare("INSERT INTO crm_calendar_sync_items (id,provider,provider_event_id,customer_id,lead_id,opportunity_id,title,start_at,end_at,status,detail_json,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(provider_event_id) DO UPDATE SET customer_id=excluded.customer_id,lead_id=excluded.lead_id,opportunity_id=excluded.opportunity_id,title=excluded.title,start_at=excluded.start_at,end_at=excluded.end_at,status=excluded.status,detail_json=excluded.detail_json,updated_at=excluded.updated_at")
      .bind(uid("CALEV"), input.provider, event.id, customer?.id || null, lead?.id || null, opportunity?.id || null, event.title, event.startAt, event.endAt, event.status || "confirmed", JSON.stringify(event.detail || {}), Date.now()).run();
    processed++;
  }
  return { processed };
}

export async function dispatchEmailOutbox(db: Db, env: Record<string, unknown>, input: { limit?: number; asOf?: number } = {}) {
  await ensureCrmEmailTables(db);
  const apiUrl = text(env.PAWSPACE_EMAIL_PROVIDER_URL), apiKey = text(env.PAWSPACE_EMAIL_PROVIDER_API_KEY), from = text(env.PAWSPACE_EMAIL_FROM);
  if (!apiUrl || !apiKey || !from) return { processed: 0, sent: 0, configurationRequired: true };
  const asOf = input.asOf ?? Date.now(), limit = Math.max(1, Math.min(100, input.limit ?? 25));
  const queued = (await db.prepare("SELECT m.*,o.status outbox_status,o.attempt_count,o.max_attempts FROM communication_messages m JOIN communication_outbox o ON o.message_id=m.id WHERE m.channel='email' AND o.status IN ('queued','retry_pending','scheduled') AND o.next_attempt_at<=? ORDER BY o.next_attempt_at LIMIT ?").bind(asOf, limit).all<Row>()).results;
  let sent = 0;
  for (const row of queued) {
    const customer = await db.prepare("SELECT email,name FROM canonical_customers WHERE id=?").bind(row.customer_id).first<Row>().catch(() => null);
    const recipient = lower(customer?.email);
    if (!recipient) { await db.prepare("UPDATE communication_outbox SET status='dead_letter',last_error='recipient_email_missing',updated_at=? WHERE message_id=?").bind(asOf, row.id).run(); continue; }
    let payload: Record<string, unknown> = {}; try { payload = JSON.parse(text(row.payload_json) || "{}"); } catch {}
    const subject = text(payload.subject) || text(row.template_key).replace(/_/g, " ");
    const body = text(payload.text || payload.body || payload.message);
    try {
      const response = await fetch(apiUrl, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ from, to: recipient, subject, text: body, metadata: { messageId: row.id, threadId: row.thread_id } }) });
      if (!response.ok) throw new Error(`email_provider_http_${response.status}`);
      const responseBody = await response.json().catch(() => ({})) as Record<string, unknown>;
      const providerMessageId = text(responseBody.id || responseBody.messageId || responseBody.message_id) || uid("EMAIL-PROVIDER");
      await db.batch([
        db.prepare("UPDATE communication_messages SET status='sent',provider='email_provider',provider_reference=?,updated_at=? WHERE id=?").bind(providerMessageId, asOf, row.id),
        db.prepare("UPDATE communication_outbox SET status='sent',attempt_count=attempt_count+1,locked_at=NULL,last_error=NULL,updated_at=? WHERE message_id=?").bind(asOf, row.id),
      ]);
      sent++;
    } catch (error) {
      const attempts = Number(row.attempt_count || 0) + 1, max = Number(row.max_attempts || 5);
      await db.prepare("UPDATE communication_outbox SET status=?,attempt_count=?,next_attempt_at=?,last_error=?,locked_at=NULL,updated_at=? WHERE message_id=?")
        .bind(attempts >= max ? "dead_letter" : "retry_pending", attempts, asOf + Math.min(60, 5 * attempts) * 60_000, error instanceof Error ? error.message : String(error), asOf, row.id).run();
    }
  }
  return { processed: queued.length, sent, configurationRequired: false };
}
