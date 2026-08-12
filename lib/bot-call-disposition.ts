/**
 * Bot-call disposition capture — what happened on an AI voice/bot call, landed in the real CRM.
 *
 * Before this, a bot call ended and nothing was recorded: ai_voice_calls.disposition was free text
 * with no taxonomy, the Haptik layer captured leads/callbacks/booking-requests but never a call
 * OUTCOME, and lead_attempts (the table the 3-RNR auto-reassignment rule actually counts) was only
 * ever written by human reps through /api/revenue-crm. So a bot could dial a lead fifty times and
 * the CRM would show no attempts, no outcome and no escalation.
 *
 * Every disposition writes to the SAME canonical surfaces a human rep's call writes to, so one
 * vocabulary drives assignment, SLA, escalation and reporting:
 *   - bot_call_dispositions  : the bot's own governed record (tags, notes, transcript ref)
 *   - lead_attempts          : mapped to the CRM's existing outcome vocabulary, so the RNR rule fires
 *   - crm_activities         : the human-readable CRM timeline
 *   - lead_work_items        : last_outcome, attempt counters, next action, status, opt-out
 *   - crm_contacts           : stage + next action the sales team sees
 *   - lead_callbacks         : a real governed callback when the customer asked to be called back
 *   - unified_cases          : a real escalation when the call needs a human
 *
 * Honesty boundary: a bot claiming "paid" is a CLAIM, not money. Money truth stays in
 * booking_payments/canonical bookings, so a 'paid' tag is recorded as claimed and flagged for
 * reconciliation - it never marks anything as collected, and it never converts a lead on its own.
 */

import { scheduleLeadCallback } from "./lead-callback-governance";
import { checkRnrAutoReassignment } from "./lead-assignment-governance";
import { createUnifiedCase } from "./unified-case-center";

type Db = D1Database;
type Row = Record<string, unknown>;

const uid = (p: string) => `${p}-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
const text = (v: unknown) => String(v ?? "").trim();
const digits = (v: unknown) => text(v).replace(/[^0-9]/g, "");

/** The CRM's existing lead_attempts vocabulary (app/api/revenue-crm/route.ts) - bot tags map onto it. */
export type CrmAttemptOutcome = "RNR" | "Connected" | "Interested" | "Not interested" | "Invalid" | "Opt-out";

export type BotCallTagDefinition = {
  code: string;
  label: string;
  /** How this tag is recorded in the CRM's canonical attempt vocabulary. */
  crmOutcome: CrmAttemptOutcome;
  /** Did a human actually speak with the customer? Drives first_action_at and contact-rate reporting. */
  contacted: boolean;
  /** A positive buying signal (moves the lead to qualified). */
  positiveIntent: boolean;
  /** Closes the lead: no further outbound work. */
  terminal: boolean;
  /** Requires a real future callback time. */
  requiresCallbackAt: boolean;
  /** Requires at least one named service (an unqualified "cross-sell" tag means nothing). */
  requiresServices: boolean;
  /** Needs a human to pick this conversation up. */
  escalates: boolean;
  /** Suppresses all future outbound contact. */
  optsOut: boolean;
  /** A money/booking claim the bot cannot itself verify - flagged for reconciliation. */
  claimsOnly: boolean;
};

export const BOT_CALL_TAGS: BotCallTagDefinition[] = [
  { code: "rnr", label: "Ring no response", crmOutcome: "RNR", contacted: false, positiveIntent: false, terminal: false, requiresCallbackAt: false, requiresServices: false, escalates: false, optsOut: false, claimsOnly: false },
  { code: "busy", label: "Line busy", crmOutcome: "RNR", contacted: false, positiveIntent: false, terminal: false, requiresCallbackAt: false, requiresServices: false, escalates: false, optsOut: false, claimsOnly: false },
  { code: "voicemail", label: "Voicemail / no pickup", crmOutcome: "RNR", contacted: false, positiveIntent: false, terminal: false, requiresCallbackAt: false, requiresServices: false, escalates: false, optsOut: false, claimsOnly: false },
  { code: "callback_requested", label: "Callback requested", crmOutcome: "Connected", contacted: true, positiveIntent: false, terminal: false, requiresCallbackAt: true, requiresServices: false, escalates: false, optsOut: false, claimsOnly: false },
  { code: "interested", label: "Interested", crmOutcome: "Interested", contacted: true, positiveIntent: true, terminal: false, requiresCallbackAt: false, requiresServices: false, escalates: false, optsOut: false, claimsOnly: false },
  { code: "not_interested", label: "Not interested", crmOutcome: "Not interested", contacted: true, positiveIntent: false, terminal: true, requiresCallbackAt: false, requiresServices: false, escalates: false, optsOut: false, claimsOnly: false },
  { code: "converted", label: "Converted (booking made on the call)", crmOutcome: "Interested", contacted: true, positiveIntent: true, terminal: false, requiresCallbackAt: false, requiresServices: false, escalates: false, optsOut: false, claimsOnly: true },
  { code: "paid", label: "Customer says they have paid", crmOutcome: "Interested", contacted: true, positiveIntent: true, terminal: false, requiresCallbackAt: false, requiresServices: false, escalates: false, optsOut: false, claimsOnly: true },
  { code: "cross_sell_potential", label: "Cross-sell potential", crmOutcome: "Connected", contacted: true, positiveIntent: true, terminal: false, requiresCallbackAt: false, requiresServices: true, escalates: false, optsOut: false, claimsOnly: false },
  { code: "human_intervention_needed", label: "Needs a human", crmOutcome: "Connected", contacted: true, positiveIntent: false, terminal: false, requiresCallbackAt: false, requiresServices: false, escalates: true, optsOut: false, claimsOnly: false },
  { code: "language_barrier", label: "Language barrier", crmOutcome: "Connected", contacted: true, positiveIntent: false, terminal: false, requiresCallbackAt: false, requiresServices: false, escalates: true, optsOut: false, claimsOnly: false },
  { code: "complaint", label: "Complaint raised on the call", crmOutcome: "Connected", contacted: true, positiveIntent: false, terminal: false, requiresCallbackAt: false, requiresServices: false, escalates: true, optsOut: false, claimsOnly: false },
  { code: "info_shared", label: "Information shared, no intent yet", crmOutcome: "Connected", contacted: true, positiveIntent: false, terminal: false, requiresCallbackAt: false, requiresServices: false, escalates: false, optsOut: false, claimsOnly: false },
  { code: "wrong_number", label: "Wrong number", crmOutcome: "Invalid", contacted: false, positiveIntent: false, terminal: true, requiresCallbackAt: false, requiresServices: false, escalates: false, optsOut: false, claimsOnly: false },
  { code: "do_not_call", label: "Do not call again (opt-out)", crmOutcome: "Opt-out", contacted: true, positiveIntent: false, terminal: true, requiresCallbackAt: false, requiresServices: false, escalates: false, optsOut: true, claimsOnly: false },
];

const tagByCode = (code: string) => BOT_CALL_TAGS.find(tag => tag.code === code) || null;
export const BOT_CALL_TAG_CODES = BOT_CALL_TAGS.map(tag => tag.code);

// Tag pairs that cannot both be true of one call. Recording both would make the CRM incoherent
// (a lead simultaneously dead and interested), so the call is rejected rather than guessed at.
const CONFLICTS: Array<[string, string]> = [
  ["interested", "not_interested"],
  ["do_not_call", "callback_requested"],
  ["do_not_call", "interested"],
  ["do_not_call", "cross_sell_potential"],
  ["not_interested", "cross_sell_potential"],
  ["wrong_number", "interested"],
  ["wrong_number", "callback_requested"],
  ["wrong_number", "converted"],
  ["not_interested", "converted"],
];

export async function ensureBotCallDispositionTables(db: Db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS bot_call_dispositions (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,lead_id TEXT NOT NULL,contact_id TEXT NOT NULL,phone TEXT NOT NULL,channel TEXT NOT NULL,bot_provider TEXT NOT NULL,call_ref TEXT,primary_tag TEXT NOT NULL,tags_json TEXT NOT NULL,crm_outcome TEXT NOT NULL,contacted INTEGER NOT NULL DEFAULT 0,escalated INTEGER NOT NULL DEFAULT 0,opted_out INTEGER NOT NULL DEFAULT 0,cross_sell_services_json TEXT NOT NULL DEFAULT '[]',claim_tags_json TEXT NOT NULL DEFAULT '[]',reconciliation_status TEXT NOT NULL DEFAULT 'not_required',callback_at INTEGER,callback_id TEXT,case_id TEXT,attempt_id TEXT,talk_time_seconds INTEGER,sentiment TEXT,notes TEXT,transcript_ref TEXT,recorded_by TEXT NOT NULL,created_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_bot_call_disposition_lead ON bot_call_dispositions(lead_id,created_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_bot_call_disposition_tag ON bot_call_dispositions(primary_tag,created_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_bot_call_disposition_reconcile ON bot_call_dispositions(reconciliation_status,created_at)"),
    db.prepare("CREATE TABLE IF NOT EXISTS lead_attempts (id TEXT PRIMARY KEY, lead_id TEXT NOT NULL, channel TEXT NOT NULL, sequence_number INTEGER NOT NULL, outcome TEXT NOT NULL, note TEXT, provider_status TEXT NOT NULL DEFAULT 'uat_queued', created_by TEXT NOT NULL, created_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS crm_activities (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, type TEXT NOT NULL, summary TEXT NOT NULL, detail TEXT, created_at INTEGER NOT NULL)"),
  ]);
}

export type BotCallDispositionInput = {
  idempotencyKey: string;
  /** Either the lead this call belongs to, or the phone number the bot dialled. */
  leadId?: string | null;
  phone?: string | null;
  channel?: "voice" | "whatsapp";
  botProvider: string;
  callRef?: string | null;
  primaryTag: string;
  secondaryTags?: string[];
  crossSellServices?: string[];
  callbackAt?: number | null;
  talkTimeSeconds?: number | null;
  sentiment?: string | null;
  notes?: string | null;
  transcriptRef?: string | null;
  actorId: string;
  asOf?: number;
};

async function resolveLead(db: Db, input: BotCallDispositionInput) {
  const leadId = text(input.leadId);
  if (leadId) {
    const row = await db.prepare("SELECT l.id,l.customer_id,c.primary_phone FROM lead_work_items l LEFT JOIN crm_contacts c ON c.id=l.customer_id WHERE l.id=?").bind(leadId).first<Row>();
    if (!row) throw new Error("Lead not found for this bot call");
    return { leadId: text(row.id), contactId: text(row.customer_id), phone: text(row.primary_phone) || digits(input.phone) };
  }
  const phone = digits(input.phone);
  if (phone.length < 8) throw new Error("A lead id or a valid dialled phone number is required");
  // Match the contact by real phone number, not by a bot-specific id convention, so a bot call on a
  // number the CRM already knows attaches to that existing lead instead of forking a duplicate.
  const contact = await db.prepare("SELECT id FROM crm_contacts WHERE replace(replace(replace(primary_phone,' ',''),'-',''),'+','') LIKE ? ORDER BY updated_at DESC LIMIT 1").bind(`%${phone.slice(-10)}`).first<Row>();
  if (!contact) throw new Error("No CRM contact matches this number - capture the lead before recording a call outcome");
  const contactId = text(contact.id);
  const lead = await db.prepare("SELECT id FROM lead_work_items WHERE customer_id=? AND status NOT IN ('closed','converted') ORDER BY assigned_at DESC LIMIT 1").bind(contactId).first<Row>();
  if (!lead) throw new Error("This contact has no open lead to record a call outcome against");
  return { leadId: text(lead.id), contactId, phone };
}

function validateTags(input: BotCallDispositionInput) {
  const primary = tagByCode(text(input.primaryTag));
  if (!primary) throw new Error(`Unsupported bot call tag (use one of: ${BOT_CALL_TAG_CODES.join(", ")})`);
  const secondary = [...new Set((input.secondaryTags || []).map(text).filter(Boolean))].filter(code => code !== primary.code);
  const unknown = secondary.filter(code => !tagByCode(code));
  if (unknown.length) throw new Error(`Unsupported bot call tag(s): ${unknown.join(", ")}`);
  const all = [primary.code, ...secondary];
  for (const [a, b] of CONFLICTS) {
    if (all.includes(a) && all.includes(b)) throw new Error(`Contradictory bot call tags: ${a} and ${b} cannot both describe one call`);
  }
  const definitions = all.map(code => tagByCode(code)!);
  const services = [...new Set((input.crossSellServices || []).map(text).filter(Boolean))];
  if (definitions.some(tag => tag.requiresServices) && !services.length) throw new Error("Cross-sell potential requires at least one named service");
  const callbackAt = input.callbackAt == null ? null : Number(input.callbackAt);
  if (definitions.some(tag => tag.requiresCallbackAt)) {
    const now = input.asOf ?? Date.now();
    if (!callbackAt || !Number.isFinite(callbackAt) || callbackAt <= now) throw new Error("A callback tag requires the real future time the customer asked to be called back");
  }
  return { primary, definitions, tags: all, services, callbackAt };
}

/**
 * Record what happened on a bot call. Idempotent per idempotencyKey (bots retry), and every side
 * effect is a real governed write - the callback goes through the callback ledger, the escalation
 * through the unified case system, the attempt through the same table a human rep's call uses.
 */
export async function recordBotCallDisposition(db: Db, input: BotCallDispositionInput) {
  await ensureBotCallDispositionTables(db);
  const idempotencyKey = text(input.idempotencyKey);
  if (!idempotencyKey) throw new Error("An idempotency key is required");
  const prior = await db.prepare("SELECT * FROM bot_call_dispositions WHERE idempotency_key=?").bind(idempotencyKey).first<Row>();
  if (prior) return { duplicatePrevented: true, id: text(prior.id), leadId: text(prior.lead_id), primaryTag: text(prior.primary_tag), tags: JSON.parse(text(prior.tags_json) || "[]") as string[], crmOutcome: text(prior.crm_outcome), callbackId: prior.callback_id ? text(prior.callback_id) : null, caseId: prior.case_id ? text(prior.case_id) : null, reconciliationStatus: text(prior.reconciliation_status) };

  const { primary, definitions, tags, services, callbackAt } = validateTags(input);
  const { leadId, contactId, phone } = await resolveLead(db, input);
  const now = input.asOf ?? Date.now();
  const channel = input.channel === "whatsapp" ? "whatsapp" : "voice";
  const contacted = definitions.some(tag => tag.contacted);
  const escalates = definitions.some(tag => tag.escalates);
  const optsOut = definitions.some(tag => tag.optsOut);
  const positive = definitions.some(tag => tag.positiveIntent);
  const terminal = definitions.some(tag => tag.terminal);
  const claimTags = definitions.filter(tag => tag.claimsOnly).map(tag => tag.code);
  const notes = text(input.notes) || null;

  // 1. The canonical attempt, in the CRM's own vocabulary. channel='call' for voice so the existing
  //    3-RNR-in-48h auto-reassignment rule counts bot attempts exactly like human ones.
  const attemptChannel = channel === "voice" ? "call" : "whatsapp";
  const sequenceRow = await db.prepare("SELECT COALESCE(MAX(sequence_number),0) n FROM lead_attempts WHERE lead_id=? AND channel=?").bind(leadId, attemptChannel).first<Row>();
  const attemptId = uid("ATT");
  await db.prepare("INSERT INTO lead_attempts (id,lead_id,channel,sequence_number,outcome,note,provider_status,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .bind(attemptId, leadId, attemptChannel, Number(sequenceRow?.n || 0) + 1, primary.crmOutcome, notes || `${input.botProvider} bot call: ${tags.join(", ")}`, "bot_completed", input.actorId, now).run();

  // 2. A callback the customer actually asked for goes through the governed callback ledger, which
  //    supersedes any earlier open promise and keeps the worklist and callback queue in agreement.
  let callbackId: string | null = null;
  if (callbackAt && definitions.some(tag => tag.requiresCallbackAt)) {
    const scheduled = await scheduleLeadCallback(db, {
      leadId, requestedAt: callbackAt,
      reason: notes ? `Bot call: customer asked to be called back - ${notes}` : `Bot call: customer asked to be called back (${input.botProvider})`,
      actorId: input.actorId, idempotencyKey: `bot-callback:${idempotencyKey}`,
    });
    callbackId = scheduled.id;
  }

  // 3. A call that needs a human becomes a real case in the queue Ops already works, not a tag
  //    nobody sees.
  let caseId: string | null = null;
  if (escalates) {
    const escalationTag = definitions.find(tag => tag.escalates)!;
    const created = await createUnifiedCase(db, {
      idempotencyKey: `bot-call-escalation:${idempotencyKey}`,
      caseType: escalationTag.code === "complaint" ? "customer_complaint" : "lead_escalation",
      severity: escalationTag.code === "complaint" ? "high" : "medium",
      title: `Bot call needs a human: ${escalationTag.label}`,
      description: notes || `${input.botProvider} bot call on ${phone} tagged ${tags.join(", ")} - a human needs to take this conversation.`,
      customerId: contactId,
      sourceType: "bot_call_disposition",
      sourceId: attemptId,
      ownerTeam: escalationTag.code === "complaint" ? "customer_experience" : "sales",
      actorId: input.actorId,
    }).catch(() => null) as { case?: Row } | null;
    caseId = created?.case?.id ? String(created.case.id) : null;
  }

  // 4. A bot cannot verify money or a confirmed booking, so those tags are recorded as CLAIMS that
  //    Ops reconciles against booking_payments / canonical_bookings.
  const reconciliationStatus = claimTags.length ? "pending_reconciliation" : "not_required";

  // 5. The lead and the contact the sales team actually looks at.
  const nextActionAt = callbackAt ?? (terminal ? null : now + 24 * 3600_000);
  const leadStatus = optsOut || terminal ? "closed" : positive ? "qualified" : null;
  await db.prepare(
    `UPDATE lead_work_items SET last_outcome=?,${channel === "voice" ? "call_attempts=call_attempts+1" : "whatsapp_attempts=whatsapp_attempts+1"},first_action_at=COALESCE(first_action_at,?),next_action_at=?,opt_out=?,status=COALESCE(?,status),updated_at=? WHERE id=?`
  ).bind(primary.code, contacted ? now : null, nextActionAt, optsOut ? 1 : 0, leadStatus, now, leadId).run();
  await db.prepare("UPDATE crm_contacts SET stage=?,next_action=?,updated_at=? WHERE id=?")
    .bind(optsOut ? "Do not contact" : terminal ? "Closed" : positive ? "Qualified" : "Contacted", escalates ? "Human follow-up required" : callbackAt ? "Callback scheduled" : terminal ? "No further action" : "Follow up", now, contactId).run();
  await db.prepare("INSERT INTO crm_activities (id,customer_id,type,summary,detail,created_at) VALUES (?,?,?,?,?,?)")
    .bind(uid("ACT"), contactId, "bot_call", `${input.botProvider} bot call · ${primary.label}`, JSON.stringify({ tags, crmOutcome: primary.crmOutcome, callbackAt, crossSellServices: services, claimTags, notes, transcriptRef: text(input.transcriptRef) || null, talkTimeSeconds: input.talkTimeSeconds ?? null, sentiment: text(input.sentiment) || null }), now).run();

  // 6. The bot's own governed record.
  const id = uid("BCD");
  await db.prepare("INSERT INTO bot_call_dispositions (id,idempotency_key,lead_id,contact_id,phone,channel,bot_provider,call_ref,primary_tag,tags_json,crm_outcome,contacted,escalated,opted_out,cross_sell_services_json,claim_tags_json,reconciliation_status,callback_at,callback_id,case_id,attempt_id,talk_time_seconds,sentiment,notes,transcript_ref,recorded_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(id, idempotencyKey, leadId, contactId, phone, channel, text(input.botProvider) || "unknown_bot", text(input.callRef) || null, primary.code, JSON.stringify(tags), primary.crmOutcome, contacted ? 1 : 0, escalates ? 1 : 0, optsOut ? 1 : 0, JSON.stringify(services), JSON.stringify(claimTags), reconciliationStatus, callbackAt, callbackId, caseId, attemptId, input.talkTimeSeconds == null ? null : Number(input.talkTimeSeconds), text(input.sentiment) || null, notes, text(input.transcriptRef) || null, input.actorId, now).run();

  // 7. A no-contact attempt feeds the real escalation rule: 3 RNRs within 48h of assignment moves
  //    the lead to another rep. Wrapped so a missing assignment policy cannot fail the capture.
  let autoReassignment: unknown = null;
  if (primary.crmOutcome === "RNR") {
    autoReassignment = await checkRnrAutoReassignment(db, { leadId, actorId: input.actorId, asOf: now }).catch(() => null);
  }

  return { duplicatePrevented: false, id, leadId, contactId, primaryTag: primary.code, tags, crmOutcome: primary.crmOutcome, contacted, escalated: escalates, optedOut: optsOut, crossSellServices: services, claimTags, reconciliationStatus, callbackId, caseId, attemptId, autoReassignment, moneyVerified: false };
}

/** Ops reconciles a bot's converted/paid CLAIM against the real booking/payment record. */
export async function reconcileBotCallClaim(db: Db, input: { dispositionId: string; outcome: "confirmed" | "not_found"; note: string; actorId: string }) {
  await ensureBotCallDispositionTables(db);
  if (!["confirmed", "not_found"].includes(input.outcome)) throw new Error("Reconciliation outcome must be 'confirmed' or 'not_found'");
  if (text(input.note).length < 5) throw new Error("A reconciliation note is required");
  const row = await db.prepare("SELECT id,reconciliation_status,notes FROM bot_call_dispositions WHERE id=?").bind(input.dispositionId).first<Row>();
  if (!row) throw new Error("Bot call disposition not found");
  if (text(row.reconciliation_status) !== "pending_reconciliation") throw new Error("This bot call has no pending money/booking claim to reconcile");
  const status = input.outcome === "confirmed" ? "reconciled_confirmed" : "reconciled_not_found";
  const claim = await db.prepare("UPDATE bot_call_dispositions SET reconciliation_status=?,notes=? WHERE id=? AND reconciliation_status='pending_reconciliation'")
    .bind(status, `${text(row.notes)}${text(row.notes) ? " | " : ""}Reconciliation (${input.actorId}): ${text(input.note)}`, input.dispositionId).run();
  if (!Number(claim.meta.changes)) throw new Error("This bot call has no pending money/booking claim to reconcile");
  return { dispositionId: input.dispositionId, reconciliationStatus: status };
}

/** Bot-call outcome mix for the CRM dashboard, computed from real dispositions only. */
export async function botCallDispositionSummary(db: Db, input: { since?: number; leadId?: string } = {}) {
  await ensureBotCallDispositionTables(db);
  const since = input.since ?? 0;
  const rows = input.leadId
    ? await db.prepare("SELECT * FROM bot_call_dispositions WHERE lead_id=? AND created_at>=? ORDER BY created_at DESC LIMIT 200").bind(input.leadId, since).all<Row>()
    : await db.prepare("SELECT * FROM bot_call_dispositions WHERE created_at>=? ORDER BY created_at DESC LIMIT 500").bind(since).all<Row>();
  const byTag: Record<string, number> = {};
  let contacted = 0, escalated = 0, optedOut = 0, pendingReconciliation = 0;
  const crossSell: Record<string, number> = {};
  for (const row of rows.results) {
    for (const tag of JSON.parse(text(row.tags_json) || "[]") as string[]) byTag[tag] = (byTag[tag] || 0) + 1;
    if (Number(row.contacted) === 1) contacted++;
    if (Number(row.escalated) === 1) escalated++;
    if (Number(row.opted_out) === 1) optedOut++;
    if (text(row.reconciliation_status) === "pending_reconciliation") pendingReconciliation++;
    for (const service of JSON.parse(text(row.cross_sell_services_json) || "[]") as string[]) crossSell[service] = (crossSell[service] || 0) + 1;
  }
  const total = rows.results.length;
  return {
    calls: total, contacted, contactRate: total ? Math.round((contacted / total) * 1000) / 1000 : null,
    escalatedToHuman: escalated, optedOut, pendingReconciliation, byTag, crossSellInterest: crossSell,
    tagVocabulary: BOT_CALL_TAGS.map(tag => ({ code: tag.code, label: tag.label, crmOutcome: tag.crmOutcome })),
    truth: { moneyVerifiedByBot: false, claimsRequireReconciliation: true, attemptsFeedTheSameCrmRules: true },
  };
}

/** The dispositions Ops still has to reconcile against real bookings/payments. */
export async function pendingBotCallClaims(db: Db, limit = 100) {
  await ensureBotCallDispositionTables(db);
  const rows = await db.prepare("SELECT id,lead_id,contact_id,phone,primary_tag,claim_tags_json,notes,created_at FROM bot_call_dispositions WHERE reconciliation_status='pending_reconciliation' ORDER BY created_at DESC LIMIT ?").bind(Math.max(1, Math.min(limit, 200))).all<Row>();
  return rows.results.map((row: Row) => ({ dispositionId: text(row.id), leadId: text(row.lead_id), contactId: text(row.contact_id), phone: text(row.phone), primaryTag: text(row.primary_tag), claimTags: JSON.parse(text(row.claim_tags_json) || "[]") as string[], notes: row.notes ? text(row.notes) : null, createdAt: Number(row.created_at) }));
}
