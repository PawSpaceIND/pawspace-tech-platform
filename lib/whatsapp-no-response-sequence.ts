import { getWhatsAppConversationMode } from "./whatsapp-conversation-control";
import { ensureWhatsAppTemplateLifecycle } from "./whatsapp-template-lifecycle";
import { ensureWhatsAppUatTables, queueWhatsAppUatOutbound, whatsappUatProviders, type WhatsAppUatProvider } from "./whatsapp-uat-adapter";

type Row = Record<string, unknown>;
export const whatsappRecoveryDelaysMinutes = [10, 30, 180] as const;
export type WhatsAppRecoveryRoutingMode = "chatbot_only" | "ai_assistant";

const text = (value: unknown) => String(value ?? "").trim();
const uid = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
const validKey = (value: string) => /^[a-z0-9_]{3,64}$/.test(value);
const parse = <T>(value: unknown, fallback: T): T => {
  try { return JSON.parse(String(value ?? "")) as T; } catch { return fallback; }
};

export async function ensureWhatsAppNoResponseSequenceTables(db: D1Database) {
  await ensureWhatsAppUatTables(db);
  await ensureWhatsAppTemplateLifecycle(db);
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS whatsapp_no_response_config (id TEXT PRIMARY KEY,enabled INTEGER NOT NULL DEFAULT 1,template_10m TEXT NOT NULL DEFAULT 'booking_recovery_10m',template_30m TEXT NOT NULL DEFAULT 'booking_recovery_30m',template_180m TEXT NOT NULL DEFAULT 'booking_recovery_180m',offer_type TEXT NOT NULL DEFAULT 'special_booking_recovery',offer_reference TEXT NOT NULL DEFAULT '',updated_by TEXT NOT NULL,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS whatsapp_no_response_sequences (id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,customer_id TEXT NOT NULL,provider TEXT NOT NULL,routing_mode TEXT NOT NULL,anchor_message_id TEXT NOT NULL UNIQUE,anchor_created_at INTEGER NOT NULL,status TEXT NOT NULL,cancel_reason TEXT,offer_type TEXT NOT NULL,offer_reference TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS whatsapp_no_response_sequence_thread_idx ON whatsapp_no_response_sequences(thread_id,status,updated_at)"),
    db.prepare("CREATE TABLE IF NOT EXISTS whatsapp_no_response_steps (id TEXT PRIMARY KEY,sequence_id TEXT NOT NULL,step_index INTEGER NOT NULL,delay_minutes INTEGER NOT NULL,due_at INTEGER NOT NULL,template_key TEXT NOT NULL,status TEXT NOT NULL,message_id TEXT,reason TEXT,idempotency_key TEXT NOT NULL UNIQUE,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(sequence_id,step_index))"),
    db.prepare("CREATE INDEX IF NOT EXISTS whatsapp_no_response_due_idx ON whatsapp_no_response_steps(status,due_at)"),
    db.prepare("INSERT OR IGNORE INTO whatsapp_no_response_config (id,enabled,template_10m,template_30m,template_180m,offer_type,offer_reference,updated_by,updated_at) VALUES ('default',1,'booking_recovery_10m','booking_recovery_30m','booking_recovery_180m','special_booking_recovery','','system',?)").bind(Date.now()),
  ]);
}

export async function getWhatsAppNoResponseConfig(db: D1Database) {
  await ensureWhatsAppNoResponseSequenceTables(db);
  const row = await db.prepare("SELECT * FROM whatsapp_no_response_config WHERE id='default'").first<Row>();
  return {
    enabled: Number(row?.enabled || 0) === 1,
    delaysMinutes: [...whatsappRecoveryDelaysMinutes],
    templateKeys: [text(row?.template_10m), text(row?.template_30m), text(row?.template_180m)],
    offerType: text(row?.offer_type),
    offerReference: text(row?.offer_reference),
    updatedBy: text(row?.updated_by),
    updatedAt: Number(row?.updated_at || 0),
    productionDelivery: false,
    environment: "uat",
  };
}

async function cancelSequence(db: D1Database, sequenceId: string, reason: string, now: number) {
  await db.batch([
    db.prepare("UPDATE whatsapp_no_response_sequences SET status='cancelled',cancel_reason=?,updated_at=? WHERE id=? AND status='active'").bind(reason, now, sequenceId),
    db.prepare("UPDATE whatsapp_no_response_steps SET status='cancelled',reason=?,updated_at=? WHERE sequence_id=? AND status IN ('pending','processing')").bind(reason, now, sequenceId),
  ]);
}

async function cancelAllActive(db: D1Database, reason: string, now: number) {
  const rows = await db.prepare("SELECT id FROM whatsapp_no_response_sequences WHERE status='active'").all<Row>();
  for (const row of rows.results || []) await cancelSequence(db, text(row.id), reason, now);
}

export async function saveWhatsAppNoResponseConfig(db: D1Database, input: { enabled: boolean; templateKeys: string[]; offerType: string; offerReference: string; actorEmail: string }) {
  await ensureWhatsAppNoResponseSequenceTables(db);
  const keys = Array.isArray(input.templateKeys) ? input.templateKeys.map((value) => text(value).toLowerCase()) : [];
  const offerType = text(input.offerType).toLowerCase();
  const offerReference = text(input.offerReference);
  if (keys.length !== 3 || keys.some((key) => !validKey(key))) throw new Response("Exactly three valid recovery template keys are required", { status: 400 });
  if (!validKey(offerType)) throw new Response("Offer type must be a stable lowercase business identifier", { status: 400 });
  if (offerReference.length > 120) throw new Response("Offer reference must be at most 120 characters", { status: 400 });
  if (input.enabled && offerReference.length < 2) throw new Response("An approved business offer reference is required before recovery automation can be enabled", { status: 409 });
  const now = Date.now();
  await db.prepare("UPDATE whatsapp_no_response_config SET enabled=?,template_10m=?,template_30m=?,template_180m=?,offer_type=?,offer_reference=?,updated_by=?,updated_at=? WHERE id='default'")
    .bind(input.enabled ? 1 : 0, keys[0], keys[1], keys[2], offerType, offerReference, input.actorEmail, now).run();
  if (!input.enabled) await cancelAllActive(db, "automation_disabled", now);
  return getWhatsAppNoResponseConfig(db);
}

export async function cancelWhatsAppNoResponseSequences(db: D1Database, input: { threadId: string; reason: string; now?: number }) {
  await ensureWhatsAppNoResponseSequenceTables(db);
  const now = input.now ?? Date.now();
  const reason = text(input.reason) || "cancelled";
  const active = await db.prepare("SELECT id FROM whatsapp_no_response_sequences WHERE thread_id=? AND status='active'").bind(input.threadId).all<Row>();
  for (const row of active.results || []) await cancelSequence(db, text(row.id), reason, now);
  return { cancelled: (active.results || []).length, threadId: input.threadId, reason, externalDelivery: false };
}

export async function armWhatsAppNoResponseSequence(db: D1Database, input: { threadId: string; customerId: string; anchorMessageId: string; routingMode: WhatsAppRecoveryRoutingMode; now?: number }) {
  await ensureWhatsAppNoResponseSequenceTables(db);
  const config = await getWhatsAppNoResponseConfig(db);
  if (!config.enabled) return { armed: false, reason: "automation_disabled", externalDelivery: false };
  if (!config.offerReference) return { armed: false, reason: "approved_offer_reference_required", externalDelivery: false };
  if (!input.anchorMessageId) return { armed: false, reason: "automated_outbound_anchor_required", externalDelivery: false };

  const anchor = await db.prepare("SELECT id,thread_id,customer_id,direction,channel,provider,created_at FROM communication_messages WHERE id=?").bind(input.anchorMessageId).first<Row>();
  if (!anchor || text(anchor.thread_id) !== input.threadId || text(anchor.customer_id) !== input.customerId || text(anchor.direction) !== "outbound" || text(anchor.channel) !== "whatsapp") {
    return { armed: false, reason: "canonical_whatsapp_outbound_anchor_required", externalDelivery: false };
  }
  const providerValue = text(anchor.provider);
  if (!whatsappUatProviders.includes(providerValue as WhatsAppUatProvider)) return { armed: false, reason: "unsupported_provider", externalDelivery: false };
  const existing = await db.prepare("SELECT id,status FROM whatsapp_no_response_sequences WHERE anchor_message_id=?").bind(input.anchorMessageId).first<Row>();
  if (existing) return { armed: text(existing.status) === "active", duplicatePrevented: true, sequenceId: text(existing.id), externalDelivery: false };

  const now = input.now ?? Date.now();
  const anchorCreatedAt = Number(anchor.created_at || now);
  await cancelWhatsAppNoResponseSequences(db, { threadId: input.threadId, reason: "superseded_by_new_automated_outbound", now });
  const sequenceId = uid("WAREC");
  const steps = whatsappRecoveryDelaysMinutes.map((delay, index) => ({
    id: uid("WARECSTEP"),
    index: index + 1,
    delay,
    dueAt: anchorCreatedAt + delay * 60_000,
    templateKey: config.templateKeys[index],
    idempotencyKey: `whatsapp-recovery:${sequenceId}:${index + 1}`,
  }));
  await db.batch([
    db.prepare("INSERT INTO whatsapp_no_response_sequences (id,thread_id,customer_id,provider,routing_mode,anchor_message_id,anchor_created_at,status,cancel_reason,offer_type,offer_reference,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'active',NULL,?,?,?,?)")
      .bind(sequenceId, input.threadId, input.customerId, providerValue, input.routingMode, input.anchorMessageId, anchorCreatedAt, config.offerType, config.offerReference, now, now),
    ...steps.map((step) => db.prepare("INSERT INTO whatsapp_no_response_steps (id,sequence_id,step_index,delay_minutes,due_at,template_key,status,message_id,reason,idempotency_key,created_at,updated_at) VALUES (?,?,?,?,?,?,'pending',NULL,NULL,?,?,?)")
      .bind(step.id, sequenceId, step.index, step.delay, step.dueAt, step.templateKey, step.idempotencyKey, now, now)),
  ]);
  return { armed: true, duplicatePrevented: false, sequenceId, dueAt: steps.map((step) => step.dueAt), delaysMinutes: [...whatsappRecoveryDelaysMinutes], externalDelivery: false };
}

async function customerAllowsRecovery(db: D1Database, customerId: string) {
  const row = await db.prepare("SELECT marketing_consent,whatsapp_consent,opt_out FROM customer_contact_preferences WHERE customer_id=?").bind(customerId).first<Row>().catch(() => null);
  if (!row) return { allowed: false, reason: "contact_preferences_missing" };
  if (Number(row.opt_out || 0) === 1) return { allowed: false, reason: "customer_opted_out" };
  if (Number(row.whatsapp_consent || 0) !== 1) return { allowed: false, reason: "whatsapp_consent_required" };
  if (Number(row.marketing_consent || 0) !== 1) return { allowed: false, reason: "marketing_consent_required_for_discount_offer" };
  return { allowed: true, reason: null };
}

async function approvedRecoveryTemplate(db: D1Database, templateKey: string, offerReference: string) {
  const row = await db.prepare("SELECT t.status,t.category,t.approved_language,l.body,l.variables_json FROM whatsapp_uat_templates t LEFT JOIN whatsapp_template_lifecycle l ON l.template_key=t.template_key WHERE t.template_key=?").bind(templateKey).first<Row>();
  if (!row || text(row.status) !== "approved") return { ok: false as const, reason: "approved_template_required" };
  if (text(row.category) !== "marketing") return { ok: false as const, reason: "recovery_discount_template_must_be_marketing" };
  const body = text(row.body);
  if (!body) return { ok: false as const, reason: "template_body_required" };
  const variables = parse<string[]>(row.variables_json, []);
  if (variables.length > 1 || (variables.length === 1 && variables[0] !== "{{1}}")) return { ok: false as const, reason: "recovery_template_supports_only_offer_reference_variable" };
  const rendered = variables.length === 1 ? body.replaceAll("{{1}}", offerReference) : body;
  if (/\{\{\d+\}\}/.test(rendered)) return { ok: false as const, reason: "unresolved_template_variable" };
  return { ok: true as const, body: rendered, language: text(row.approved_language) || "en" };
}

export async function processDueWhatsAppNoResponseSequences(db: D1Database, input: { now?: number; limit?: number; actorEmail?: string } = {}) {
  await ensureWhatsAppNoResponseSequenceTables(db);
  const now = input.now ?? Date.now();
  const limit = Math.max(1, Math.min(100, Number(input.limit || 50)));
  const actorEmail = text(input.actorEmail) || "system:whatsapp-recovery-sweep";
  const config = await getWhatsAppNoResponseConfig(db);
  if (!config.enabled) {
    await cancelAllActive(db, "automation_disabled", now);
    return { processed: 0, queued: 0, cancelled: 0, blocked: 0, externalDelivery: false, environment: "uat" };
  }

  const due = await db.prepare("SELECT s.*,q.thread_id,q.customer_id,q.provider,q.routing_mode,q.anchor_created_at,q.offer_reference FROM whatsapp_no_response_steps s JOIN whatsapp_no_response_sequences q ON q.id=s.sequence_id WHERE q.status='active' AND s.due_at<=? AND (s.status='pending' OR (s.status='processing' AND s.updated_at<=?)) ORDER BY s.due_at ASC LIMIT ?")
    .bind(now, now - 5 * 60_000, limit).all<Row>();
  const results: Row[] = [];

  for (const step of due.results || []) {
    const stepId = text(step.id);
    const sequenceId = text(step.sequence_id);
    const threadId = text(step.thread_id);
    const customerId = text(step.customer_id);
    const claimed = await db.prepare("UPDATE whatsapp_no_response_steps SET status='processing',reason=NULL,updated_at=? WHERE id=? AND (status='pending' OR (status='processing' AND updated_at<=?))")
      .bind(now, stepId, now - 5 * 60_000).run();
    if (Number(claimed.meta?.changes || 0) !== 1) { results.push({ stepId, status: "duplicate_claim_prevented" }); continue; }

    const newerInbound = await db.prepare("SELECT id FROM communication_messages WHERE thread_id=? AND direction='inbound' AND channel='whatsapp' AND created_at>? ORDER BY created_at ASC LIMIT 1")
      .bind(threadId, Number(step.anchor_created_at || 0)).first<Row>();
    if (newerInbound) { await cancelSequence(db, sequenceId, "customer_replied", now); results.push({ stepId, status: "cancelled", reason: "customer_replied" }); continue; }

    const thread = await db.prepare("SELECT status,booking_id FROM communication_threads WHERE id=? AND customer_id=?").bind(threadId, customerId).first<Row>();
    if (!thread || text(thread.status) !== "open") { await cancelSequence(db, sequenceId, "conversation_not_open", now); results.push({ stepId, status: "cancelled", reason: "conversation_not_open" }); continue; }
    if (text(thread.booking_id)) { await cancelSequence(db, sequenceId, "booking_already_linked", now); results.push({ stepId, status: "cancelled", reason: "booking_already_linked" }); continue; }

    const routing = await getWhatsAppConversationMode(db, threadId).catch(() => ({ mode: "human_only" as const }));
    if (routing.mode !== text(step.routing_mode)) {
      const reason = routing.mode === "human_only" ? "human_takeover" : "routing_changed";
      await cancelSequence(db, sequenceId, reason, now);
      results.push({ stepId, status: "cancelled", reason });
      continue;
    }

    const preference = await customerAllowsRecovery(db, customerId);
    if (!preference.allowed) { await cancelSequence(db, sequenceId, preference.reason || "send_policy_failed", now); results.push({ stepId, status: "cancelled", reason: preference.reason }); continue; }

    const template = await approvedRecoveryTemplate(db, text(step.template_key), text(step.offer_reference));
    if (!template.ok) { await cancelSequence(db, sequenceId, template.reason, now); results.push({ stepId, status: "blocked", reason: template.reason }); continue; }

    const provider = text(step.provider) as WhatsAppUatProvider;
    if (!whatsappUatProviders.includes(provider)) { await cancelSequence(db, sequenceId, "unsupported_provider", now); results.push({ stepId, status: "blocked", reason: "unsupported_provider" }); continue; }
    const queued = await queueWhatsAppUatOutbound(db, {
      provider,
      threadId,
      customerId,
      text: template.body,
      idempotencyKey: text(step.idempotency_key),
      createdBy: actorEmail,
      templateKey: text(step.template_key),
      language: template.language,
    });
    if (!queued.queued) {
      const reason = text(queued.reason) || "governed_send_policy_failed";
      await cancelSequence(db, sequenceId, reason, now);
      results.push({ stepId, status: "blocked", reason });
      continue;
    }
    await db.prepare("UPDATE whatsapp_no_response_steps SET status='queued',message_id=?,reason=NULL,updated_at=? WHERE id=?").bind(queued.messageId, now, stepId).run();
    if (Number(step.step_index || 0) === whatsappRecoveryDelaysMinutes.length) {
      await db.prepare("UPDATE whatsapp_no_response_sequences SET status='completed',updated_at=? WHERE id=? AND status='active'").bind(now, sequenceId).run();
    }
    results.push({ stepId, status: "queued", messageId: queued.messageId, duplicatePrevented: Boolean(queued.duplicatePrevented), templateKey: text(step.template_key) });
  }

  return {
    processed: results.length,
    queued: results.filter((row) => row.status === "queued").length,
    cancelled: results.filter((row) => row.status === "cancelled").length,
    blocked: results.filter((row) => row.status === "blocked").length,
    results,
    externalDelivery: false,
    environment: "uat",
  };
}

export async function listWhatsAppNoResponseAutomation(db: D1Database) {
  await ensureWhatsAppNoResponseSequenceTables(db);
  const config = await getWhatsAppNoResponseConfig(db);
  const sequences = await db.prepare("SELECT q.*,SUM(CASE WHEN s.status='queued' THEN 1 ELSE 0 END) AS queued_steps,SUM(CASE WHEN s.status IN ('pending','processing') THEN 1 ELSE 0 END) AS pending_steps FROM whatsapp_no_response_sequences q LEFT JOIN whatsapp_no_response_steps s ON s.sequence_id=q.id GROUP BY q.id ORDER BY q.created_at DESC LIMIT 100").all<Row>();
  return {
    config,
    sequences: sequences.results || [],
    productionDelivery: false,
    environment: "uat",
    aiArmingPolicy: "ai_assistant arms only after a real governed AI outbound message exists; ai_pending alone never arms recovery",
  };
}
