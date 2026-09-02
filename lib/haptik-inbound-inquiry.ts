/**
 * The two inbound endpoints the Haptik LOE puts on our side: create an inquiry, and transfer to a human.
 *
 * These are distinct from the existing capture_lead action, and the difference matters. capture_lead
 * says "this person wants a grooming appointment" - it creates sales pipeline. An INQUIRY is broader:
 * the LOE's bot must be able to log a pricing question, an availability question, a veterinary question
 * or a complaint, none of which are a grooming lead and three of which should never become one.
 *
 * TEN CATEGORIES, ALLOWLISTED. Six are services (grooming, dog_training, boarding, pet_walking,
 * veterinary, pet_taxi) and four are not (pricing, availability, complaints, general). Only the service
 * categories create a sales lead, because filing "why is grooming so expensive" as a grooming lead
 * pollutes the pipeline and gets the customer a sales call they did not ask for.
 *
 * WHY AN UNKNOWN CATEGORY IS ACCEPTED RATHER THAN REFUSED. Everywhere else in this codebase an
 * unrecognised value fails closed, and that is right when the thing at stake is money or access. Here
 * the thing at stake is a customer's question. Refusing an 11th category would make the bot drop the
 * enquiry on the floor - the customer is gone and we never learn why. So an unrecognised category is
 * accepted, stored as `general`, and BOTH the raw value and `categoryRecognised: false` are recorded so
 * ops can see it and the category list can be extended deliberately. Fail-safe for the customer,
 * visible to us; it is never silently rewritten.
 *
 * COMPLAINTS NEVER BECOME A LEAD. A complaint is routed to the human queue via the existing
 * ai_handoffs table, because answering a complaint with a sales call is the worst available outcome.
 *
 * The transfer endpoint deliberately reuses lib/ai-human-handoff.ts rather than building a second
 * queue. There is already a handoff queue with take-over/resume semantics and an ops view; a parallel
 * one would mean agents watching two screens and one of them going unwatched.
 */

import { requestAiHumanHandoff, type AiHandoffReason } from "./ai-human-handoff";
import { recordInboundMessage, ensureConversationGovernance } from "./conversation-governance";

type Db = D1Database;
type Row = Record<string, unknown>;

const uid = (p: string) => `${p}-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
const text = (v: unknown) => String(v ?? "").trim();
const digits = (v: unknown) => text(v).replace(/\D/g, "");

/** The ten categories the LOE names. Order is the LOE's order. */
export const INQUIRY_CATEGORIES = [
  "grooming", "dog_training", "boarding", "pet_walking", "veterinary", "pet_taxi",
  "pricing", "availability", "complaints", "general",
] as const;
export type InquiryCategory = typeof INQUIRY_CATEGORIES[number];

/**
 * Which categories are a real service enquiry, and what service_code each maps to.
 *
 * An allowlist, so a category that is not a service cannot accidentally acquire a service_code and
 * become pipeline. `veterinary` maps to null on purpose: we do not sell veterinary care, so a vet
 * question is a routed enquiry, never a booking lead.
 */
const SERVICE_CODE: Partial<Record<InquiryCategory, string | null>> = {
  grooming: "grooming",
  dog_training: "dog_training",
  boarding: "boarding",
  pet_walking: "dog_walking",
  pet_taxi: "pet_taxi",
  veterinary: null,
};

/** Categories that must reach a human rather than a sales queue. */
const HANDOFF_CATEGORIES: ReadonlySet<string> = new Set(["complaints", "veterinary"]);

const RECOGNISED: ReadonlySet<string> = new Set(INQUIRY_CATEGORIES);

/**
 * Normalise whatever the bot sent into a category.
 *
 * Tolerant of the spellings a conversational layer actually produces ("Dog Training", "dog-training",
 * "pet walking") because the alternative is losing the classification over a hyphen. Anything still
 * unrecognised becomes `general` with `recognised: false`.
 */
export function classifyInquiry(raw: unknown): { category: InquiryCategory; recognised: boolean; raw: string } {
  const original = text(raw);
  const key = original.toLowerCase().replace(/[\s-]+/g, "_");
  const aliases: Record<string, InquiryCategory> = {
    training: "dog_training", dog_train: "dog_training",
    walking: "pet_walking", dog_walking: "pet_walking", walk: "pet_walking",
    taxi: "pet_taxi", transport: "pet_taxi",
    vet: "veterinary", vets: "veterinary",
    sitting: "boarding", daycare: "boarding", board: "boarding",
    price: "pricing", cost: "pricing", rates: "pricing",
    slots: "availability", available: "availability", schedule: "availability",
    complaint: "complaints", issue: "complaints", escalation: "complaints",
    groom: "grooming",
  };
  if (RECOGNISED.has(key)) return { category: key as InquiryCategory, recognised: true, raw: original };
  if (aliases[key]) return { category: aliases[key], recognised: true, raw: original };
  return { category: "general", recognised: false, raw: original };
}

/**
 * Materialise the conversation thread a handoff needs, then queue the handoff.
 *
 * requestAiHumanHandoff attaches to an existing conversation thread - reasonably, since it exists for
 * PawSpace-hosted chats. A Haptik transfer has no such thread: the conversation happened on Haptik's
 * side and arrives as a webhook. Recording the inbound message first is not a workaround for that, it
 * is accurate - the customer really did send us a message through the bot - and it means the agent who
 * picks the handoff up can see what was said instead of an empty thread.
 *
 * Returns null rather than throwing when the queueing fails: a handoff we could not queue must not
 * discard the inquiry we already captured. The caller records handoffId=null, which is visibly
 * different from a successful escalation.
 */
async function queueHandoff(db: Db, input: {
  threadId: string; customerId: string; reason: AiHandoffReason; actorId: string;
  channel: string; payload: Record<string, unknown>; sessionId?: string | null;
}): Promise<{ handoffId: string; queueCode: string | null; status: string } | null> {
  try {
    // The thread must exist before an inbound message or a handoff can attach to it. On the
    // PawSpace-hosted path enqueueCommunication creates it as a side effect of sending; a Haptik
    // transfer never sends anything first, so the thread is created here explicitly. INSERT OR IGNORE
    // keeps a retried webhook idempotent - the same transfer must not open a second thread.
    await ensureConversationGovernance(db).catch(() => {});
    await db.prepare(
      "INSERT OR IGNORE INTO communication_threads (id,customer_id,booking_id,lead_id,ticket_id,status,assigned_to,sla_due_at,created_at,updated_at) VALUES (?,?,NULL,NULL,NULL,'open',NULL,NULL,?,?)",
    ).bind(input.threadId, input.customerId, Date.now(), Date.now()).run().catch(() => {});
    await recordInboundMessage(db, {
      threadId: input.threadId, customerId: input.customerId,
      // The bot's voice/WhatsApp turn arrives as an inbound message on the thread.
      channel: input.channel === "whatsapp" ? "whatsapp" : "sms",
      payload: input.payload, provider: "haptik",
      providerReference: input.threadId, eventId: `${input.threadId}:inbound`,
      createdBy: input.actorId,
    }).catch(() => {});
    // requestAiHumanHandoff returns the stored row nested under `handoff`, in snake_case - reading a
    // top-level `handoffId` silently yields undefined and looks exactly like a failed queueing.
    const result = await requestAiHumanHandoff(db, {
      actorEmail: input.actorId, threadId: input.threadId, customerId: input.customerId,
      sessionId: input.sessionId ?? null, reason: input.reason, confidence: null,
    }) as { handoff?: Row } | null;
    const row = result?.handoff;
    const handoffId = row ? String(row.id ?? "") : "";
    if (!handoffId) return null;
    return {
      handoffId,
      queueCode: row?.queue_code ? String(row.queue_code) : null,
      status: row?.status ? String(row.status) : "queued",
    };
  } catch {
    return null;
  }
}

export async function ensureHaptikInquiryTables(db: Db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS haptik_inquiries (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,contact_id TEXT,phone TEXT NOT NULL,name TEXT,category TEXT NOT NULL,raw_category TEXT NOT NULL DEFAULT '',category_recognised INTEGER NOT NULL DEFAULT 1,service_code TEXT,message TEXT,lead_id TEXT,handoff_id TEXT,channel TEXT NOT NULL DEFAULT 'voice',status TEXT NOT NULL DEFAULT 'logged',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_haptik_inquiries_phone ON haptik_inquiries(phone,created_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_haptik_inquiries_category ON haptik_inquiries(category,created_at)"),
    // Surfaces the unrecognised ones for review without a scan.
    db.prepare("CREATE INDEX IF NOT EXISTS idx_haptik_inquiries_unrecognised ON haptik_inquiries(category_recognised,created_at)"),
  ]);
}

/**
 * Find or create the CRM contact for a phone number.
 *
 * Phone-matched, so a caller who has rung before does not fork into a second contact - the LOE's whole
 * value is that the bot recognises a returning customer, which it cannot do against a duplicate.
 */
async function resolveContact(db: Db, phone: string, name: string, at: number) {
  const normalized = digits(phone);
  const existing = await db.prepare(
    "SELECT id,name FROM crm_contacts WHERE REPLACE(REPLACE(REPLACE(primary_phone,'+',''),'-',''),' ','') LIKE ? OR REPLACE(REPLACE(REPLACE(secondary_phone,'+',''),'-',''),' ','') LIKE ? LIMIT 1",
  ).bind(`%${normalized.slice(-10)}`, `%${normalized.slice(-10)}`).first<Row>().catch(() => null);
  if (existing) return { contactId: String(existing.id), created: false, name: text(existing.name) || name };
  const id = uid("CRM");
  await db.prepare("INSERT INTO crm_contacts (id,name,primary_phone,stage,owner,source,created_at,updated_at) VALUES (?,?,?,'New lead','Unassigned','Haptik voice bot',?,?)")
    .bind(id, name || "Inbound caller", phone, at, at).run().catch(() => {});
  return { contactId: id, created: true, name: name || "Inbound caller" };
}

export type InquiryResult = {
  inquiryId: string; duplicatePrevented: boolean;
  category: InquiryCategory; categoryRecognised: boolean; rawCategory: string;
  serviceCode: string | null; contactId: string; contactCreated: boolean;
  leadId: string | null; handoffId: string | null; routedTo: "sales_lead" | "human_queue" | "logged_only";
};

/**
 * "Create an Inquiry in CRM" — the LOE's inbound endpoint.
 *
 * Idempotent on idempotencyKey: a voice platform retries, and a retry must not create a second
 * inquiry, a second contact or a second lead.
 */
export async function createHaptikInquiry(db: Db, input: {
  idempotencyKey: string; phone: string; name?: string; category: string;
  message?: string; channel?: string; cityId?: string; actorId: string; at?: number;
}): Promise<InquiryResult> {
  await ensureHaptikInquiryTables(db);
  const idempotencyKey = text(input.idempotencyKey);
  if (!idempotencyKey) throw Object.assign(new Error("An idempotency key is required"), { statusCode: 400 });
  const phone = text(input.phone);
  if (digits(phone).length < 10) throw Object.assign(new Error("A full phone number is required"), { statusCode: 400 });
  const at = input.at ?? Date.now();

  const prior = await db.prepare("SELECT * FROM haptik_inquiries WHERE idempotency_key=?").bind(idempotencyKey).first<Row>().catch(() => null);
  if (prior) {
    return {
      inquiryId: String(prior.id), duplicatePrevented: true,
      category: String(prior.category) as InquiryCategory, categoryRecognised: Number(prior.category_recognised) === 1,
      rawCategory: text(prior.raw_category), serviceCode: prior.service_code ? String(prior.service_code) : null,
      contactId: text(prior.contact_id), contactCreated: false,
      leadId: prior.lead_id ? String(prior.lead_id) : null, handoffId: prior.handoff_id ? String(prior.handoff_id) : null,
      routedTo: prior.lead_id ? "sales_lead" : prior.handoff_id ? "human_queue" : "logged_only",
    };
  }

  const { category, recognised, raw } = classifyInquiry(input.category);
  const serviceCode = SERVICE_CODE[category] ?? null;
  const contact = await resolveContact(db, phone, text(input.name), at);
  const id = uid("HINQ");

  let leadId: string | null = null;
  let handoffId: string | null = null;

  // A service category with a real service_code becomes pipeline. Nothing else does.
  if (serviceCode && !HANDOFF_CATEGORIES.has(category)) {
    leadId = uid("LEAD");
    const created = await db.prepare(
      "INSERT OR IGNORE INTO lead_work_items (id,customer_id,source,service,status,assigned_at,first_action_at,opt_out,converted_booking_id) VALUES (?,?,?,?,'active',?,NULL,0,NULL)",
    ).bind(leadId, contact.contactId, "haptik_inquiry", serviceCode, at).run().catch(() => null);
    if (!created || Number(created.meta?.changes || 0) === 0) leadId = null;
  }

  // A complaint or a veterinary question goes to a human, on the queue agents already watch.
  if (HANDOFF_CATEGORIES.has(category)) {
    const reason: AiHandoffReason = category === "complaints" ? "complaint" : "unsupported_request";
    const queued = await queueHandoff(db, {
      threadId: `haptik:${id}`, customerId: contact.contactId, reason, actorId: input.actorId,
      channel: text(input.channel) || "voice",
      payload: { source: "haptik_inquiry", category, rawCategory: raw, message: text(input.message), phone },
    });
    handoffId = queued?.handoffId ?? null;
  }

  await db.prepare(
    "INSERT INTO haptik_inquiries (id,idempotency_key,contact_id,phone,name,category,raw_category,category_recognised,service_code,message,lead_id,handoff_id,channel,status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).bind(
    id, idempotencyKey, contact.contactId, phone, contact.name, category, raw, recognised ? 1 : 0,
    serviceCode, text(input.message) || null, leadId, handoffId,
    text(input.channel) || "voice", leadId ? "lead_created" : handoffId ? "escalated" : "logged",
    input.actorId, at, at,
  ).run();

  return {
    inquiryId: id, duplicatePrevented: false, category, categoryRecognised: recognised, rawCategory: raw,
    serviceCode, contactId: contact.contactId, contactCreated: contact.created, leadId, handoffId,
    routedTo: leadId ? "sales_lead" : handoffId ? "human_queue" : "logged_only",
  };
}

/** The reasons the bot may give for a transfer, mapped onto the existing handoff vocabulary. */
const TRANSFER_REASONS: Record<string, AiHandoffReason> = {
  customer_requested_human: "customer_requested_human",
  complaint: "complaint",
  refund: "refund_payment_dispute",
  payment_dispute: "refund_payment_dispute",
  low_confidence: "low_confidence",
  safety: "safety",
  unsupported: "unsupported_request",
  policy_risk: "policy_risk",
};

/**
 * "Transfer to an agent" — the LOE's human-handoff webhook.
 *
 * An unrecognised reason maps to `customer_requested_human` rather than being refused: the customer has
 * already asked for a person, and losing that request over an unmapped enum string is the one outcome
 * worse than a slightly mislabelled queue entry. The raw value is returned so the mapping gap is
 * visible.
 */
export async function transferHaptikToAgent(db: Db, input: {
  phone: string; reason?: string; name?: string; inquiryId?: string; sessionId?: string; actorId: string; at?: number;
}) {
  await ensureHaptikInquiryTables(db);
  const phone = text(input.phone);
  if (digits(phone).length < 10) throw Object.assign(new Error("A full phone number is required"), { statusCode: 400 });
  const at = input.at ?? Date.now();
  const rawReason = text(input.reason).toLowerCase().replace(/[\s-]+/g, "_");
  const reason = TRANSFER_REASONS[rawReason] ?? "customer_requested_human";

  const contact = await resolveContact(db, phone, text(input.name), at);
  const threadId = text(input.inquiryId) ? `haptik:${text(input.inquiryId)}` : `haptik:transfer:${digits(phone).slice(-10)}`;
  const queued = await queueHandoff(db, {
    threadId, customerId: contact.contactId, reason, actorId: input.actorId, channel: "voice",
    payload: { source: "haptik_transfer", rawReason: rawReason || null, phone },
    sessionId: text(input.sessionId) || null,
  });
  if (!queued) throw Object.assign(new Error("Unable to queue the human handoff"), { statusCode: 502 });
  const handoffId = queued.handoffId;
  if (text(input.inquiryId)) {
    await db.prepare("UPDATE haptik_inquiries SET handoff_id=?,status='escalated',updated_at=? WHERE id=?")
      .bind(handoffId, at, text(input.inquiryId)).run().catch(() => {});
  }
  return {
    handoffId, contactId: contact.contactId, contactCreated: contact.created,
    reason, rawReason: rawReason || null, reasonRecognised: Boolean(TRANSFER_REASONS[rawReason]),
    queueCode: queued.queueCode, status: queued.status,
  };
}

/** Ops view: recent inquiries, with the unrecognised categories surfaced first for review. */
export async function listHaptikInquiries(db: Db, input: { category?: string; limit?: number } = {}) {
  await ensureHaptikInquiryTables(db);
  const limit = Math.max(1, Math.min(Number(input.limit) || 200, 1000));
  const category = text(input.category);
  const rows = await db.prepare(
    `SELECT id,contact_id,phone,name,category,raw_category,category_recognised,service_code,lead_id,handoff_id,channel,status,created_at FROM haptik_inquiries WHERE (?='' OR category=?) ORDER BY category_recognised ASC,created_at DESC LIMIT ${limit}`,
  ).bind(category, category).all<Row>().catch(() => ({ results: [] as Row[] }));
  return rows.results.map((r) => ({
    inquiryId: String(r.id), contactId: text(r.contact_id), phone: String(r.phone), name: text(r.name),
    category: String(r.category), rawCategory: text(r.raw_category), categoryRecognised: Number(r.category_recognised) === 1,
    serviceCode: r.service_code ? String(r.service_code) : null,
    leadId: r.lead_id ? String(r.lead_id) : null, handoffId: r.handoff_id ? String(r.handoff_id) : null,
    channel: String(r.channel), status: String(r.status), createdAt: Number(r.created_at),
  }));
}
