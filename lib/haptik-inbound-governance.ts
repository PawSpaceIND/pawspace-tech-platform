/**
 * The INBOUND voice agent - the half of Haptik's solution document that answers PawSpace's phone
 * rather than dialling out. Three things it needs from us, none of which existed:
 *
 *   1. "Create an Inquiry CRM": classify why someone called into one of ten categories and file a real
 *      CRM inquiry. Not a new inbox - the same crm_contacts + lead_work_items rows a website form or a
 *      rep creates, so the SLA clock, assignment and reporting all treat a bot-captured enquiry exactly
 *      like every other one. A complaint additionally opens a real case, because a complaint sitting in
 *      a lead queue is a complaint nobody owns.
 *   2. "Transfer to an agent": hand the call to a human. The transfer TARGET is operator-configured and
 *      fail-closed - with no queue configured the bot is told so and offers a callback, rather than
 *      transferring a customer into silence.
 *   3. "FAQ Knowledge Base": answer routine questions. Served from ai_knowledge_source_versions through
 *      retrieveApprovedKnowledge, so the bot can only ever repeat text that is approved AND currently
 *      active, and it gets nothing at all rather than something stale.
 *
 * Every write is idempotent on the caller's key: an inbound webhook that retries must not turn one
 * phone call into three inquiries.
 */

import { captureHaptikLead } from "./haptik-integration-governance";
import { retrieveApprovedKnowledge } from "./ai-business-configuration";
import { createUnifiedCase } from "./unified-case-center";

type Db = D1Database;
type Row = Record<string, unknown>;
const text = (value: unknown) => String(value ?? "").trim();
const lower = (value: unknown) => text(value).toLowerCase();
const digits = (value: unknown) => text(value).replace(/\D/g, "");
const uid = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
const empty = () => ({ results: [] as Row[] });

/**
 * The ten inbound categories the solution document names, each mapped onto the service vocabulary the
 * CRM already works. `opensCase` marks the categories that are not sales enquiries at all: a complaint
 * and a veterinary/emergency call both need an owner and a clock, not a lead-queue slot.
 */
export type InquiryCategory = { code: string; label: string; service: string; opensCase: boolean; caseType: "customer_complaint" | "operations"; severity: "high" | "medium" };
export const HAPTIK_INQUIRY_CATEGORIES: InquiryCategory[] = [
  { code: "grooming", label: "Grooming", service: "grooming", opensCase: false, caseType: "operations", severity: "medium" },
  { code: "dog_training", label: "Dog training", service: "dog_training", opensCase: false, caseType: "operations", severity: "medium" },
  { code: "boarding", label: "Boarding / daycare / pet sitting", service: "boarding", opensCase: false, caseType: "operations", severity: "medium" },
  { code: "pet_walking", label: "Pet walking", service: "dog_walking", opensCase: false, caseType: "operations", severity: "medium" },
  { code: "veterinary_assistance", label: "Veterinary assistance", service: "veterinary", opensCase: true, caseType: "operations", severity: "high" },
  { code: "pet_taxi", label: "Pet taxi", service: "pet_taxi", opensCase: false, caseType: "operations", severity: "medium" },
  { code: "pricing_packages", label: "Pricing & packages", service: "grooming", opensCase: false, caseType: "operations", severity: "medium" },
  { code: "service_availability", label: "Service availability", service: "grooming", opensCase: false, caseType: "operations", severity: "medium" },
  { code: "complaint", label: "Complaint", service: "support", opensCase: true, caseType: "customer_complaint", severity: "high" },
  { code: "general_enquiry", label: "General enquiry", service: "general", opensCase: false, caseType: "operations", severity: "medium" },
];
export const HAPTIK_INQUIRY_CATEGORY_CODES = HAPTIK_INQUIRY_CATEGORIES.map(c => c.code);
const categoryByCode = (code: string) => HAPTIK_INQUIRY_CATEGORIES.find(c => c.code === lower(code)) || null;

export async function ensureHaptikInboundTables(db: Db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS haptik_inquiries (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,category TEXT NOT NULL,lead_id TEXT NOT NULL,contact_id TEXT NOT NULL,case_id TEXT,phone TEXT NOT NULL,name TEXT,preferred_location TEXT,requirement TEXT,call_ref TEXT,detail_json TEXT NOT NULL DEFAULT '{}',recorded_by TEXT NOT NULL,created_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_haptik_inquiries_category ON haptik_inquiries(category,created_at)"),
    db.prepare("CREATE TABLE IF NOT EXISTS haptik_transfer_targets (queue_code TEXT PRIMARY KEY,label TEXT NOT NULL,destination TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,updated_by TEXT NOT NULL,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS haptik_agent_transfers (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,queue_code TEXT NOT NULL,reason TEXT NOT NULL,lead_id TEXT,contact_id TEXT,case_id TEXT,phone TEXT NOT NULL,call_ref TEXT,status TEXT NOT NULL,destination TEXT,recorded_by TEXT NOT NULL,created_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS haptik_faq_lookups (id TEXT PRIMARY KEY,question TEXT NOT NULL,answered INTEGER NOT NULL,source_key TEXT,call_ref TEXT,created_at INTEGER NOT NULL)"),
  ]);
}

/** Operator-configured human queues the bot may transfer a live call to. */
export async function setHaptikTransferTarget(db: Db, input: { queueCode: string; label: string; destination: string; active?: boolean; actorId: string }) {
  await ensureHaptikInboundTables(db);
  const queueCode = lower(input.queueCode).replace(/[^a-z0-9_]/g, "");
  const destination = digits(input.destination);
  if (!queueCode) throw new Error("A queue code is required");
  // A transfer destination is a phone number staff answer, never a customer's. Ten digits minimum so a
  // truncated paste cannot silently become a live transfer target.
  if (destination.length < 10) throw new Error("A transfer destination must be a valid phone number");
  const now = Date.now();
  await db.prepare("INSERT INTO haptik_transfer_targets (queue_code,label,destination,active,updated_by,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(queue_code) DO UPDATE SET label=excluded.label,destination=excluded.destination,active=excluded.active,updated_by=excluded.updated_by,updated_at=excluded.updated_at")
    .bind(queueCode, text(input.label) || queueCode, destination, input.active === false ? 0 : 1, input.actorId, now).run();
  return { queueCode, label: text(input.label) || queueCode, destinationLast4: destination.slice(-4), active: input.active !== false, updatedAt: now };
}

export async function listHaptikTransferTargets(db: Db) {
  await ensureHaptikInboundTables(db);
  const rows = await db.prepare("SELECT queue_code,label,destination,active,updated_by,updated_at FROM haptik_transfer_targets ORDER BY queue_code").all<Row>().catch(empty);
  return rows.results.map(r => ({ queueCode: text(r.queue_code), label: text(r.label), destinationLast4: digits(r.destination).slice(-4), active: Number(r.active) === 1, updatedBy: text(r.updated_by), updatedAt: Number(r.updated_at) }));
}

export type HaptikInquiryInput = {
  idempotencyKey: string; category: string; phone: string; name?: string;
  preferredLocation?: string; requirement?: string; callRef?: string;
  detail?: Record<string, unknown>; actorId: string;
};

/**
 * File an inbound enquiry as a real CRM inquiry. An unknown category is refused rather than filed as
 * "general": the category drives which team picks the lead up, and quietly widening it is how a
 * training enquiry ends up in the grooming queue.
 */
export async function createHaptikInquiry(db: Db, input: HaptikInquiryInput) {
  await ensureHaptikInboundTables(db);
  const idempotencyKey = text(input.idempotencyKey);
  if (!idempotencyKey) throw new Error("An idempotency key is required");
  const category = categoryByCode(input.category);
  if (!category) throw new Error(`Unknown inquiry category. Use one of ${HAPTIK_INQUIRY_CATEGORY_CODES.join(" | ")}`);
  const prior = await db.prepare("SELECT id,lead_id,contact_id,case_id,category FROM haptik_inquiries WHERE idempotency_key=?").bind(idempotencyKey).first<Row>();
  if (prior) return { duplicatePrevented: true, inquiryId: text(prior.id), leadId: text(prior.lead_id), contactId: text(prior.contact_id), caseId: text(prior.case_id) || null, category: text(prior.category) };

  // The contact + governed lead work item come from the same helper the outbound journeys use, so an
  // inbound caller who is already a known lead joins that lead rather than forking a second one.
  const captured = await captureHaptikLead(db, {
    idempotencyKey: `haptik-inquiry:${idempotencyKey}`, phone: input.phone, name: input.name,
    service: category.service, city: input.preferredLocation, source: "haptik_voice_inbound",
    qualification: { inquiryCategory: category.code, requirement: text(input.requirement) || null, callRef: text(input.callRef) || null, ...(input.detail || {}) },
    actorId: input.actorId,
  });

  let caseId: string | null = null;
  if (category.opensCase) {
    const created = await createUnifiedCase(db, {
      idempotencyKey: `haptik-inquiry-case:${idempotencyKey}`,
      caseType: category.caseType, severity: category.severity,
      title: `${category.label} raised on an inbound AI voice call`,
      description: text(input.requirement) || `${category.label} captured by the inbound voice agent. Call ref: ${text(input.callRef) || "not supplied"}.`,
      customerId: captured.contactId, leadId: captured.leadId,
      sourceType: "haptik_voice_inbound", sourceId: text(input.callRef) || idempotencyKey,
      ownerTeam: category.code === "complaint" ? "customer_experience" : "operations",
      actorId: input.actorId,
    });
    caseId = text((created.case as Row | undefined)?.id) || null;
  }

  const id = uid("HIQ"), now = Date.now();
  await db.prepare("INSERT OR IGNORE INTO haptik_inquiries (id,idempotency_key,category,lead_id,contact_id,case_id,phone,name,preferred_location,requirement,call_ref,detail_json,recorded_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(id, idempotencyKey, category.code, captured.leadId, captured.contactId, caseId, text(input.phone), text(input.name) || null, text(input.preferredLocation) || null, text(input.requirement) || null, text(input.callRef) || null, JSON.stringify(input.detail || {}), input.actorId, now).run();
  const stored = await db.prepare("SELECT id FROM haptik_inquiries WHERE idempotency_key=?").bind(idempotencyKey).first<Row>();
  return { duplicatePrevented: false, inquiryId: text(stored?.id) || id, leadId: captured.leadId, contactId: captured.contactId, caseId, category: category.code };
}

/**
 * Ask for a live transfer to a human. Fail-closed on configuration: with no active queue the answer is
 * status "no_queue_configured" and the bot must fall back to a callback, because a transfer to nowhere
 * drops the customer. The case is opened either way so the request is never lost.
 */
export async function requestHaptikAgentTransfer(db: Db, input: { idempotencyKey: string; queueCode?: string; reason: string; phone: string; leadId?: string; callRef?: string; actorId: string }) {
  await ensureHaptikInboundTables(db);
  const idempotencyKey = text(input.idempotencyKey);
  if (!idempotencyKey) throw new Error("An idempotency key is required");
  const reason = text(input.reason) || "customer_requested_human";
  const prior = await db.prepare("SELECT id,status,queue_code,destination,case_id FROM haptik_agent_transfers WHERE idempotency_key=?").bind(idempotencyKey).first<Row>();
  if (prior) return { duplicatePrevented: true, transferId: text(prior.id), status: text(prior.status), queueCode: text(prior.queue_code), destination: text(prior.destination) || null, caseId: text(prior.case_id) || null };

  const wanted = lower(input.queueCode);
  const target = wanted
    ? await db.prepare("SELECT queue_code,destination FROM haptik_transfer_targets WHERE queue_code=? AND active=1").bind(wanted).first<Row>().catch(() => null)
    : await db.prepare("SELECT queue_code,destination FROM haptik_transfer_targets WHERE active=1 ORDER BY queue_code LIMIT 1").first<Row>().catch(() => null);

  let contactId: string | null = null, leadId = text(input.leadId);
  if (leadId) {
    const lead = await db.prepare("SELECT id,customer_id FROM lead_work_items WHERE id=?").bind(leadId).first<Row>().catch(() => null);
    if (lead) contactId = text(lead.customer_id); else leadId = "";
  }
  if (!contactId) {
    const key = digits(input.phone).slice(-10);
    const contact = key.length === 10 ? await db.prepare("SELECT id FROM crm_contacts WHERE replace(replace(replace(primary_phone,' ',''),'-',''),'+','') LIKE ? ORDER BY updated_at DESC LIMIT 1").bind(`%${key}`).first<Row>().catch(() => null) : null;
    contactId = contact ? text(contact.id) : null;
  }

  const created = await createUnifiedCase(db, {
    idempotencyKey: `haptik-transfer:${idempotencyKey}`, caseType: "lead_escalation", severity: "high",
    title: "AI voice call asked for a human agent",
    description: `The inbound voice agent could not resolve the call (${reason}). Call ref: ${text(input.callRef) || "not supplied"}.`,
    customerId: contactId, leadId: leadId || null,
    sourceType: "haptik_voice_transfer", sourceId: text(input.callRef) || idempotencyKey,
    ownerTeam: "customer_experience", actorId: input.actorId,
  });
  const caseId = text((created.case as Row | undefined)?.id) || null;

  const status = target ? "ready" : "no_queue_configured", id = uid("HTR"), now = Date.now();
  await db.prepare("INSERT OR IGNORE INTO haptik_agent_transfers (id,idempotency_key,queue_code,reason,lead_id,contact_id,case_id,phone,call_ref,status,destination,recorded_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(id, idempotencyKey, target ? text(target.queue_code) : wanted || "default", reason, leadId || null, contactId, caseId, text(input.phone), text(input.callRef) || null, status, target ? digits(target.destination) : null, input.actorId, now).run();
  const stored = await db.prepare("SELECT id FROM haptik_agent_transfers WHERE idempotency_key=?").bind(idempotencyKey).first<Row>();
  return {
    duplicatePrevented: false, transferId: text(stored?.id) || id, status,
    queueCode: target ? text(target.queue_code) : null,
    destination: target ? digits(target.destination) : null,
    caseId,
    fallback: target ? null : "Offer a callback - no human transfer queue is configured",
  };
}

/**
 * Answer a caller's routine question from the approved knowledge base. answered:false is a real answer
 * here: it tells the bot to stop guessing and either transfer or take a callback.
 */
export async function haptikFaqAnswer(db: Db, input: { question: string; callRef?: string; limit?: number }) {
  await ensureHaptikInboundTables(db);
  const question = text(input.question);
  if (question.length < 3) throw new Error("A question is required");
  const retrieved = await retrieveApprovedKnowledge(db, { query: question, visibilityScopes: ["public", "voice_bot", "customer"], limit: Math.max(1, Math.min(Number(input.limit) || 3, 5)) }).catch(() => null);
  const results = retrieved?.results || [];
  const answered = results.length > 0;
  await db.prepare("INSERT INTO haptik_faq_lookups (id,question,answered,source_key,call_ref,created_at) VALUES (?,?,?,?,?,?)")
    .bind(uid("HFQ"), question.slice(0, 400), answered ? 1 : 0, answered ? results[0].sourceKey : null, text(input.callRef) || null, Date.now()).run().catch(() => null);
  return {
    question, answered,
    // approvedCurrentOnly is carried through deliberately: it is the assurance that nothing here is a
    // draft or a retired version of a policy.
    approvedCurrentOnly: true,
    answers: results.map(r => ({ sourceKey: r.sourceKey, version: r.version, title: r.title, content: r.content, immutableHash: r.immutableHash })),
    fallback: answered ? null : "No approved answer is available - transfer to a human or take a callback",
  };
}

/** Ops view of what the inbound agent captured. */
export async function haptikInboundSummary(db: Db, input: { since?: number; limit?: number } = {}) {
  await ensureHaptikInboundTables(db);
  const since = Number.isFinite(Number(input.since)) ? Number(input.since) : 0;
  const limit = Math.max(1, Math.min(Number(input.limit) || 100, 500));
  const [byCategory, transfers, faq, recent] = await Promise.all([
    db.prepare("SELECT category,COUNT(*) count,SUM(CASE WHEN case_id IS NOT NULL THEN 1 ELSE 0 END) cases FROM haptik_inquiries WHERE created_at>=? GROUP BY category ORDER BY count DESC").bind(since).all<Row>().catch(empty),
    db.prepare("SELECT status,COUNT(*) count FROM haptik_agent_transfers WHERE created_at>=? GROUP BY status").bind(since).all<Row>().catch(empty),
    db.prepare("SELECT answered,COUNT(*) count FROM haptik_faq_lookups WHERE created_at>=? GROUP BY answered").bind(since).all<Row>().catch(empty),
    db.prepare("SELECT id,category,lead_id,case_id,phone,preferred_location,call_ref,created_at FROM haptik_inquiries WHERE created_at>=? ORDER BY created_at DESC LIMIT ?").bind(since, limit).all<Row>().catch(empty),
  ]);
  return {
    since,
    categories: HAPTIK_INQUIRY_CATEGORIES.map(c => {
      const row = byCategory.results.find(r => text(r.category) === c.code);
      return { category: c.code, label: c.label, service: c.service, opensCase: c.opensCase, count: Number(row?.count || 0), cases: Number(row?.cases || 0) };
    }),
    transfers: transfers.results.map(r => ({ status: text(r.status), count: Number(r.count) })),
    faq: {
      answered: Number(faq.results.find(r => Number(r.answered) === 1)?.count || 0),
      unanswered: Number(faq.results.find(r => Number(r.answered) === 0)?.count || 0),
    },
    recent: recent.results.map(r => ({ inquiryId: text(r.id), category: text(r.category), leadId: text(r.lead_id), caseId: text(r.case_id) || null, phoneLast4: digits(r.phone).slice(-4), preferredLocation: text(r.preferred_location) || null, callRef: text(r.call_ref) || null, createdAt: Number(r.created_at) })),
  };
}
