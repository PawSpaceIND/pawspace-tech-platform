import { requestAiDraft } from "../ai-provider-adapter";
import { parseMetaWhatsAppWebhook } from "../meta-whatsapp-webhook";
import {
  calculateSurgePricing,
  type SurgePricingInput,
  type SurgePricingQuote,
} from "../policies/surge-pricing-engine";
import {
  extractAndApplyCrmEntities,
  type CrmProfilePatch,
  type ExistingCrmProfile,
} from "./ai-crm-entity-extractor";
import {
  runAutonomousDealCloser,
  type AutonomousDealStage,
  type CanonicalDealQuote,
} from "./autonomous-deal-closer";
import { type ContactSafetyInput } from "./contact-safety-gate";
import { scorePredictiveChurn } from "./predictive-churn-model";
import type { TranscriptMessage } from "./omnichannel-transcript-ingestion";

type Row = Record<string, unknown>;
type RuntimeEnv = Record<string, unknown>;

const text = (value: unknown) => String(value ?? "").trim();
const number = (value: unknown, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const id = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
const DEAL_STAGES = new Set<AutonomousDealStage>([
  "new",
  "qualified",
  "proposal_sent",
  "payment_ready",
  "payment_link_sent",
  "won",
  "lost",
]);

export async function ensureEliteRuntimeTables(db: D1Database) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS elite_runtime_events (id TEXT PRIMARY KEY,module TEXT NOT NULL,event_type TEXT NOT NULL,customer_id TEXT,thread_id TEXT,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS elite_runtime_events_created_idx ON elite_runtime_events(created_at,module)"),
    db.prepare("CREATE TABLE IF NOT EXISTS elite_crm_profile_facts (customer_id TEXT PRIMARY KEY,pet_id TEXT,pet_temperament TEXT,budget_min_paise INTEGER,budget_max_paise INTEGER,service_intent_json TEXT,provenance_json TEXT NOT NULL DEFAULT '[]',model TEXT,request_id TEXT,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS elite_deal_state (deal_id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,thread_id TEXT NOT NULL UNIQUE,stage TEXT NOT NULL DEFAULT 'new',canonical_quote_json TEXT,payment_verified INTEGER NOT NULL DEFAULT 0,payment_link_issued INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS elite_payment_approval_queue (idempotency_key TEXT PRIMARY KEY,deal_id TEXT NOT NULL,customer_id TEXT NOT NULL,quote_id TEXT NOT NULL,amount_paise INTEGER NOT NULL,currency TEXT NOT NULL,requires_approval INTEGER NOT NULL CHECK(requires_approval=1),requested_by TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending_approval',created_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS elite_churn_scores (customer_id TEXT PRIMARY KEY,churn_probability REAL NOT NULL,risk_score INTEGER NOT NULL,engagement_score INTEGER NOT NULL,risk_band TEXT NOT NULL,engagement_state TEXT NOT NULL,win_back_trigger TEXT NOT NULL,contact_eligibility TEXT NOT NULL,reason_codes_json TEXT NOT NULL,model_version TEXT NOT NULL,policy_version TEXT NOT NULL,scored_at INTEGER NOT NULL)"),
  ]);
}

async function tableExists(db: D1Database, table: string) {
  return Boolean(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(table).first<Row>().catch(() => null));
}

async function recordEvent(
  db: D1Database,
  input: { module: string; eventType: string; customerId?: string | null; threadId?: string | null; detail?: Record<string, unknown>; at?: number },
) {
  await db.prepare("INSERT INTO elite_runtime_events (id,module,event_type,customer_id,thread_id,detail_json,created_at) VALUES (?,?,?,?,?,?,?)")
    .bind(
      id("ELITE"),
      input.module,
      input.eventType,
      input.customerId ?? null,
      input.threadId ?? null,
      JSON.stringify(input.detail ?? {}),
      input.at ?? Date.now(),
    )
    .run();
}

async function loadContactSafety(db: D1Database, customerId: string): Promise<ContactSafetyInput> {
  const preferencesAvailable = await tableExists(db, "customer_contact_preferences");
  const preference = preferencesAvailable
    ? await db.prepare("SELECT marketing_consent,whatsapp_consent,opt_out FROM customer_contact_preferences WHERE customer_id=?")
      .bind(customerId)
      .first<Row>()
      .catch(() => null)
    : null;

  let openComplaint = false;
  let unresolvedRefundOrPaymentDispute = false;
  if (await tableExists(db, "customer_experience_tickets")) {
    const ticket = await db.prepare("SELECT SUM(CASE WHEN lower(COALESCE(category,'') || ' ' || COALESCE(subject,'')) LIKE '%complaint%' OR lower(COALESCE(category,'') || ' ' || COALESCE(subject,'')) LIKE '%quality%' OR lower(COALESCE(category,'') || ' ' || COALESCE(subject,'')) LIKE '%safety%' OR lower(COALESCE(category,'') || ' ' || COALESCE(subject,'')) LIKE '%incident%' THEN 1 ELSE 0 END) complaint_count,SUM(CASE WHEN lower(COALESCE(category,'') || ' ' || COALESCE(subject,'')) LIKE '%refund%' OR lower(COALESCE(category,'') || ' ' || COALESCE(subject,'')) LIKE '%payment%' OR lower(COALESCE(category,'') || ' ' || COALESCE(subject,'')) LIKE '%chargeback%' OR lower(COALESCE(category,'') || ' ' || COALESCE(subject,'')) LIKE '%dispute%' THEN 1 ELSE 0 END) payment_count FROM customer_experience_tickets WHERE customer_id=? AND status!='resolved'")
      .bind(customerId)
      .first<Row>()
      .catch(() => null);
    openComplaint = number(ticket?.complaint_count) > 0;
    unresolvedRefundOrPaymentDispute = number(ticket?.payment_count) > 0;
  }

  const consentKnown = Boolean(preference);
  return {
    marketingOptOut: !consentKnown || number(preference?.marketing_consent) !== 1 || number(preference?.opt_out) === 1,
    channelOptOut: !consentKnown || number(preference?.whatsapp_consent) !== 1 || number(preference?.opt_out) === 1,
    openComplaint,
    unresolvedRefundOrPaymentDispute,
    dataQualityReviewRequired: !consentKnown,
    policyVersion: "v2-elite-runtime-2026-09-04",
  };
}

function parseStringArray(value: unknown): string[] | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : null;
  } catch {
    return null;
  }
}

async function loadProfile(db: D1Database, customerId: string): Promise<ExistingCrmProfile> {
  const pet = await (await tableExists(db, "canonical_pets")
    ? db.prepare("SELECT id FROM canonical_pets WHERE customer_id=? ORDER BY updated_at DESC LIMIT 1").bind(customerId).first<Row>().catch(() => null)
    : Promise.resolve(null));
  const facts = await db.prepare("SELECT * FROM elite_crm_profile_facts WHERE customer_id=?").bind(customerId).first<Row>().catch(() => null);
  return {
    customerId,
    petId: text(facts?.pet_id) || text(pet?.id) || null,
    petTemperament: (text(facts?.pet_temperament) || null) as ExistingCrmProfile["petTemperament"],
    budgetMinPaise: facts?.budget_min_paise == null ? null : number(facts.budget_min_paise),
    budgetMaxPaise: facts?.budget_max_paise == null ? null : number(facts.budget_max_paise),
    serviceIntent: parseStringArray(facts?.service_intent_json),
  };
}

function parseProviderJson(value: string): unknown {
  try { return JSON.parse(value); } catch {
    const start = value.indexOf("{");
    const end = value.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try { return JSON.parse(value.slice(start, end + 1)); } catch { return { entities: [] }; }
    }
    return { entities: [] };
  }
}

async function extractCrmFacts(db: D1Database, customerId: string, transcript: TranscriptMessage[]) {
  const profile = await loadProfile(db, customerId);
  return extractAndApplyCrmEntities({
    profile,
    transcript,
    dependencies: {
      generator: {
        async generate(request) {
          const result = await requestAiDraft({
            systemPrompt: `${request.systemInstruction} Respond with JSON only. Required schema: ${JSON.stringify(request.responseSchema)}`,
            userPrompt: JSON.stringify({ transcript: request.transcript }),
            maxTokens: 1_200,
          });
          if (!result.connected) {
            return { json: { entities: [] }, model: `provider_unavailable:${result.failure}`, requestId: null };
          }
          return { json: parseProviderJson(result.text), model: result.modelRef, requestId: null };
        },
      },
      writer: {
        async applyMissingFields(input) {
          const patch: CrmProfilePatch = input.patch;
          await db.prepare("INSERT INTO elite_crm_profile_facts (customer_id,pet_id,pet_temperament,budget_min_paise,budget_max_paise,service_intent_json,provenance_json,model,request_id,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(customer_id) DO UPDATE SET pet_id=CASE WHEN elite_crm_profile_facts.pet_id IS NULL OR elite_crm_profile_facts.pet_id='' THEN excluded.pet_id ELSE elite_crm_profile_facts.pet_id END,pet_temperament=COALESCE(elite_crm_profile_facts.pet_temperament,excluded.pet_temperament),budget_min_paise=COALESCE(elite_crm_profile_facts.budget_min_paise,excluded.budget_min_paise),budget_max_paise=COALESCE(elite_crm_profile_facts.budget_max_paise,excluded.budget_max_paise),service_intent_json=COALESCE(elite_crm_profile_facts.service_intent_json,excluded.service_intent_json),provenance_json=excluded.provenance_json,model=excluded.model,request_id=excluded.request_id,updated_at=excluded.updated_at")
            .bind(
              input.customerId,
              input.petId,
              patch.petTemperament ?? null,
              patch.budgetMinPaise ?? null,
              patch.budgetMaxPaise ?? null,
              patch.serviceIntent ? JSON.stringify(patch.serviceIntent) : null,
              JSON.stringify(input.provenance),
              input.model,
              input.requestId,
              Date.now(),
            )
            .run();
        },
      },
    },
  });
}

function parseCanonicalQuote(value: unknown): CanonicalDealQuote | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const quoteId = text(parsed.quoteId);
    const amountPaise = number(parsed.amountPaise, -1);
    const currency = text(parsed.currency);
    const expiresAt = number(parsed.expiresAt, -1);
    if (!quoteId || amountPaise <= 0 || !currency || expiresAt <= 0) return null;
    return { quoteId, amountPaise, currency, expiresAt };
  } catch {
    return null;
  }
}

async function runDealCloser(db: D1Database, input: { customerId: string; threadId: string; replyText: string; at: number }) {
  const dealId = `elite:${input.threadId}`;
  await db.prepare("INSERT OR IGNORE INTO elite_deal_state (deal_id,customer_id,thread_id,stage,updated_at) VALUES (?,?,?,'new',?)")
    .bind(dealId, input.customerId, input.threadId, input.at)
    .run();
  const state = await db.prepare("SELECT * FROM elite_deal_state WHERE deal_id=?").bind(dealId).first<Row>();
  const candidateStage = text(state?.stage) as AutonomousDealStage;
  const currentStage: AutonomousDealStage = DEAL_STAGES.has(candidateStage) ? candidateStage : "new";
  const contactSafety = await loadContactSafety(db, input.customerId);
  return runAutonomousDealCloser({
    dealId,
    customerId: input.customerId,
    currentStage,
    latestInboundReply: input.replyText,
    paymentVerified: number(state?.payment_verified) === 1,
    paymentLinkAlreadyIssued: number(state?.payment_link_issued) === 1,
    canonicalQuote: parseCanonicalQuote(state?.canonical_quote_json),
    contactSafety,
  }, {
    async advanceStage(change) {
      await db.prepare("UPDATE elite_deal_state SET stage=?,updated_at=? WHERE deal_id=? AND stage=?")
        .bind(change.to, Date.now(), change.dealId, change.from)
        .run();
    },
    async queueGovernedPaymentLink(request) {
      if (request.requiresApproval !== true) throw new Error("Elite financial request must require human approval");
      await db.prepare("INSERT OR IGNORE INTO elite_payment_approval_queue (idempotency_key,deal_id,customer_id,quote_id,amount_paise,currency,requires_approval,requested_by,status,created_at) VALUES (?,?,?,?,?,?,1,?,'pending_approval',?)")
        .bind(request.idempotencyKey, request.dealId, request.customerId, request.quoteId, request.amountPaise, request.currency, request.requestedBy, Date.now())
        .run();
    },
    async recordAudit(audit) {
      await recordEvent(db, {
        module: "autonomous-deal-closer",
        eventType: audit.action,
        customerId: input.customerId,
        threadId: input.threadId,
        at: input.at,
        detail: { dealId: audit.dealId, reasonCode: audit.reasonCode, modelVersion: audit.modelVersion, requiresApproval: audit.action === "payment_link_requested" ? true : null },
      });
    },
  }, input.at);
}

export async function runEliteWebhookHooks(
  db: D1Database,
  _env: RuntimeEnv,
  request: Request,
  routeResponse: Response,
) {
  await ensureEliteRuntimeTables(db);
  if (request.method.toUpperCase() !== "POST" || routeResponse.status !== 200) return { observed: 0, activated: 0, failures: 0 };

  let rawBody = "";
  let responsePayload: { results?: Array<Record<string, unknown>> } = {};
  try {
    rawBody = await request.text();
    responsePayload = await routeResponse.json() as { results?: Array<Record<string, unknown>> };
  } catch {
    await recordEvent(db, { module: "elite-runtime", eventType: "webhook_observation_parse_failed" });
    return { observed: 0, activated: 0, failures: 1 };
  }

  const messages = parseMetaWhatsAppWebhook(parseProviderJson(rawBody)).filter((event) => event.kind === "message");
  const byEventId = new Map(messages.map((event) => [event.eventId, event] as const));
  const results = Array.isArray(responsePayload.results) ? responsePayload.results : [];
  let activated = 0;
  let failures = 0;

  for (const result of results) {
    const event = byEventId.get(text(result.eventId));
    if (!event || !event.body) continue;
    const status = text(result.status);
    if (["duplicate", "ignored", "opted_out", "human_handoff"].includes(status)) continue;
    const customerId = text(result.customerId);
    const threadId = text(result.threadId);
    const messageId = text(result.messageId);
    if (!customerId || !threadId || !messageId) continue;
    activated += 1;

    const transcript: TranscriptMessage[] = [{
      messageId,
      customerExternalId: event.providerIdentity,
      direction: "inbound",
      sender: event.providerIdentity,
      recipient: "pawspace",
      text: event.body,
      occurredAt: event.timestamp,
      subject: null,
      threadId,
      channel: "whatsapp",
      deliveryId: event.eventId,
    }];

    const extraction = await Promise.allSettled([
      extractCrmFacts(db, customerId, transcript),
      runDealCloser(db, { customerId, threadId, replyText: event.body, at: event.timestamp }),
    ]);
    const [crm, deal] = extraction;
    if (crm.status === "fulfilled") {
      await recordEvent(db, {
        module: "ai-crm-entity-extractor",
        eventType: crm.value.status,
        customerId,
        threadId,
        at: event.timestamp,
        detail: { accepted: crm.value.acceptedEntities.length, rejected: crm.value.rejectedEntityCount, model: crm.value.model },
      });
    } else {
      failures += 1;
      await recordEvent(db, { module: "ai-crm-entity-extractor", eventType: "failed_closed", customerId, threadId, at: event.timestamp });
    }
    if (deal.status === "fulfilled") {
      await recordEvent(db, {
        module: "autonomous-deal-closer",
        eventType: "decision_completed",
        customerId,
        threadId,
        at: event.timestamp,
        detail: {
          targetStage: deal.value.targetStage,
          reasonCode: deal.value.stageReasonCode,
          contactEligibility: deal.value.safety.eligibility,
          financialExecution: deal.value.financialExecution,
          requiresApproval: deal.value.paymentLinkRequest?.requiresApproval ?? null,
        },
      });
    } else {
      failures += 1;
      await recordEvent(db, { module: "autonomous-deal-closer", eventType: "failed_closed", customerId, threadId, at: event.timestamp });
    }
  }

  return { observed: results.length, activated, failures };
}

export async function runEliteScheduledHooks(db: D1Database, input: { asOf?: number } = {}) {
  await ensureEliteRuntimeTables(db);
  const asOf = input.asOf ?? Date.now();
  if (!(await tableExists(db, "subscription_customers"))) return { processed: 0, failed: 0, skipped: true };
  const customers = await db.prepare("SELECT customer_key,days_since_last_service FROM subscription_customers ORDER BY updated_at DESC LIMIT 100").all<Row>();
  let processed = 0;
  let failed = 0;
  for (const customer of customers.results) {
    const customerId = text(customer.customer_key);
    if (!customerId) continue;
    try {
      const contactSafety = await loadContactSafety(db, customerId);
      const score = await scorePredictiveChurn({
        customerId,
        telemetry: {
          daysSinceLastCompletedService: Math.max(0, number(customer.days_since_last_service)),
          appSessionsLast30Days: 0,
          appSessionsPrevious30Days: 0,
          averageResponseLatencyHours: 0,
          cancellationRate90Days: 0,
          completedBookings90Days: 0,
          negativeSentimentRate90Days: 0,
          paymentFailureRate90Days: 0,
          supportEscalations90Days: 0,
        },
        contactSafety,
      });
      await db.prepare("INSERT INTO elite_churn_scores (customer_id,churn_probability,risk_score,engagement_score,risk_band,engagement_state,win_back_trigger,contact_eligibility,reason_codes_json,model_version,policy_version,scored_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(customer_id) DO UPDATE SET churn_probability=excluded.churn_probability,risk_score=excluded.risk_score,engagement_score=excluded.engagement_score,risk_band=excluded.risk_band,engagement_state=excluded.engagement_state,win_back_trigger=excluded.win_back_trigger,contact_eligibility=excluded.contact_eligibility,reason_codes_json=excluded.reason_codes_json,model_version=excluded.model_version,policy_version=excluded.policy_version,scored_at=excluded.scored_at")
        .bind(customerId, score.churnProbability, score.riskScore, score.engagementScore, score.riskBand, score.engagementState, score.winBackTrigger, score.contactSafety.eligibility, JSON.stringify(score.reasonCodes), score.modelVersion, score.policyVersion, asOf)
        .run();
      processed += 1;
    } catch {
      failed += 1;
      await recordEvent(db, { module: "predictive-churn", eventType: "failed_closed", customerId, at: asOf }).catch(() => undefined);
    }
  }
  await recordEvent(db, { module: "predictive-churn", eventType: "scheduled_sweep_completed", at: asOf, detail: { processed, failed } });
  return { processed, failed, skipped: false };
}

export function calculateEliteSurgePreview(input: SurgePricingInput): SurgePricingQuote {
  return calculateSurgePricing(input);
}

export async function eliteRuntimeStatus(db: D1Database) {
  await ensureEliteRuntimeTables(db);
  const [lastEvent, churn, approvals] = await Promise.all([
    db.prepare("SELECT module,event_type,created_at FROM elite_runtime_events ORDER BY created_at DESC LIMIT 1").first<Row>(),
    db.prepare("SELECT COUNT(*) count,MAX(scored_at) last_scored_at FROM elite_churn_scores").first<Row>(),
    db.prepare("SELECT COUNT(*) count FROM elite_payment_approval_queue WHERE status='pending_approval' AND requires_approval=1").first<Row>(),
  ]);
  return {
    configured: true,
    runtime: "cloudflare-vinext-worker",
    financialExecution: "governed_queue_only",
    paymentApprovalInvariant: true,
    lastEvent: lastEvent ?? null,
    churnScores: number(churn?.count),
    lastChurnScoredAt: churn?.last_scored_at == null ? null : number(churn.last_scored_at),
    pendingFinancialApprovals: number(approvals?.count),
  };
}
