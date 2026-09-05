import { extractAndApplyCrmEntities, type StructuredJsonGenerationResponse } from "./ai-crm-entity-extractor";
import { runAutonomousDealCloser } from "./autonomous-deal-closer";
import { evaluateContactEligibility, type ContactSafetyInput } from "./contact-safety-gate";
import { scorePredictiveChurn } from "./predictive-churn-model";
import { createSelfHealingCrmWorker, type SelfHealingDealSnapshot } from "./self-healing-crm-loop";
import { calculateSurgePricing, type SurgePricingQuote } from "../policies/surge-pricing-engine";
import type { TranscriptMessage } from "./omnichannel-transcript-ingestion";

type Db = D1Database;
type Row = Record<string, unknown>;
const text = (value: unknown) => String(value ?? "").trim();
const number = (value: unknown, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

async function ensureTables(db: Db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS elite_runtime_audit (id TEXT PRIMARY KEY,component TEXT NOT NULL,entity_id TEXT,action TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS elite_crm_profile_facts (customer_id TEXT PRIMARY KEY,pet_id TEXT,pet_temperament TEXT,budget_min_paise INTEGER,budget_max_paise INTEGER,service_intent_json TEXT,provenance_json TEXT NOT NULL DEFAULT '[]',updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS elite_transcript_events (message_id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,channel TEXT NOT NULL,direction TEXT NOT NULL,text TEXT NOT NULL,occurred_at INTEGER NOT NULL,created_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS elite_churn_scores (customer_id TEXT PRIMARY KEY,risk_score INTEGER NOT NULL,risk_band TEXT NOT NULL,engagement_state TEXT NOT NULL,win_back_trigger TEXT NOT NULL,reason_codes_json TEXT NOT NULL,model_version TEXT NOT NULL,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS elite_realtime_signals (zone_id TEXT PRIMARY KEY,open_demand INTEGER NOT NULL DEFAULT 0,active_providers INTEGER NOT NULL DEFAULT 0,zone_sampled_at INTEGER NOT NULL,weather_severity REAL NOT NULL DEFAULT 0,precipitation_probability REAL NOT NULL DEFAULT 0,weather_sampled_at INTEGER NOT NULL,provider_utilization REAL NOT NULL DEFAULT 0,available_slots INTEGER NOT NULL DEFAULT 0,total_slots INTEGER NOT NULL DEFAULT 0,capacity_sampled_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS elite_payment_link_requests (idempotency_key TEXT PRIMARY KEY,deal_id TEXT NOT NULL,customer_id TEXT NOT NULL,quote_id TEXT NOT NULL,amount_paise INTEGER NOT NULL,currency TEXT NOT NULL,requires_approval INTEGER NOT NULL CHECK(requires_approval=1),requested_by TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'approval_required',created_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS elite_self_healing_claims (idempotency_key TEXT PRIMARY KEY,claimed_at INTEGER NOT NULL)"),
  ]);
}

async function audit(db: Db, component: string, entityId: string | null, action: string, detail: unknown, now = Date.now()) {
  await ensureTables(db);
  await db.prepare("INSERT INTO elite_runtime_audit (id,component,entity_id,action,detail_json,created_at) VALUES (?,?,?,?,?,?)")
    .bind(`ELITE-${crypto.randomUUID()}`, component, entityId, action, JSON.stringify(detail), now).run();
}

function deterministicGenerator(transcript: TranscriptMessage[]) {
  return {
    async generate(): Promise<StructuredJsonGenerationResponse> {
      const entities: Array<Record<string, unknown>> = [];
      for (const message of transcript) {
        const source = message.text;
        const lower = source.toLowerCase();
        for (const temperament of ["calm", "energetic", "anxious", "reactive", "social", "shy"] as const) {
          const index = lower.indexOf(temperament);
          if (index >= 0) entities.push({ field: "petTemperament", value: temperament, confidence: 0.99, messageId: message.messageId, quote: source.slice(Math.max(0, index - 40), Math.min(source.length, index + temperament.length + 40)).trim() });
        }
        const services = ["grooming", "boarding", "training", "sitting", "walking", "taxi"].filter(service => lower.includes(service));
        if (services.length) entities.push({ field: "serviceIntent", value: services, confidence: 0.99, messageId: message.messageId, quote: source.slice(0, 240) });
        const money = [...source.matchAll(/(?:₹|rs\.?|inr)\s*([0-9][0-9,]*)/gi)].map(match => Number(match[1].replace(/,/g, ""))).filter(value => Number.isFinite(value));
        if (money.length) {
          const min = Math.min(...money) * 100, max = Math.max(...money) * 100;
          entities.push({ field: "budgetMinPaise", value: min, confidence: 0.99, messageId: message.messageId, quote: source.slice(0, 240) });
          entities.push({ field: "budgetMaxPaise", value: max, confidence: 0.99, messageId: message.messageId, quote: source.slice(0, 240) });
        }
      }
      return { json: { entities: entities.slice(0, 16) }, model: "deterministic-explicit-facts-v1", requestId: null };
    },
  };
}

async function contactSafety(db: Db, customerId: string): Promise<ContactSafetyInput> {
  try {
    const row = await db.prepare("SELECT marketing_consent,whatsapp_consent,opt_out FROM customer_contact_preferences WHERE customer_id=?").bind(customerId).first<Row>();
    if (!row) return { dataQualityReviewRequired: true };
    return { marketingOptOut: Number(row.opt_out || 0) === 1 || Number(row.marketing_consent || 0) === 0, channelOptOut: Number(row.whatsapp_consent || 0) === 0 };
  } catch {
    return { dataQualityReviewRequired: true };
  }
}

export async function processEliteInboundMessage(db: Db, input: { customerId: string; messageId: string; text: string; occurredAt: number; channel?: "whatsapp" | "email" | "call" }) {
  await ensureTables(db);
  const message: TranscriptMessage = { messageId: input.messageId, customerExternalId: input.customerId, direction: "inbound", sender: input.customerId, recipient: "pawspace", text: input.text, occurredAt: input.occurredAt, channel: input.channel ?? "whatsapp", deliveryId: input.messageId };
  await db.prepare("INSERT OR IGNORE INTO elite_transcript_events (message_id,customer_id,channel,direction,text,occurred_at,created_at) VALUES (?,?,?,?,?,?,?)")
    .bind(message.messageId, input.customerId, message.channel, message.direction, message.text, message.occurredAt, Date.now()).run();
  const existing = await db.prepare("SELECT * FROM elite_crm_profile_facts WHERE customer_id=?").bind(input.customerId).first<Row>();
  const result = await extractAndApplyCrmEntities({
    profile: { customerId: input.customerId, petId: text(existing?.pet_id) || null, petTemperament: (text(existing?.pet_temperament) || null) as never, budgetMinPaise: existing?.budget_min_paise == null ? null : number(existing.budget_min_paise), budgetMaxPaise: existing?.budget_max_paise == null ? null : number(existing.budget_max_paise), serviceIntent: existing?.service_intent_json ? JSON.parse(text(existing.service_intent_json)) : null },
    transcript: [message],
    dependencies: {
      generator: deterministicGenerator([message]),
      writer: { async applyMissingFields(write) {
        const current = await db.prepare("SELECT * FROM elite_crm_profile_facts WHERE customer_id=?").bind(input.customerId).first<Row>();
        const serviceIntent = write.patch.serviceIntent ?? (current?.service_intent_json ? JSON.parse(text(current.service_intent_json)) : null);
        await db.prepare("INSERT INTO elite_crm_profile_facts (customer_id,pet_id,pet_temperament,budget_min_paise,budget_max_paise,service_intent_json,provenance_json,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(customer_id) DO UPDATE SET pet_id=COALESCE(elite_crm_profile_facts.pet_id,excluded.pet_id),pet_temperament=COALESCE(elite_crm_profile_facts.pet_temperament,excluded.pet_temperament),budget_min_paise=COALESCE(elite_crm_profile_facts.budget_min_paise,excluded.budget_min_paise),budget_max_paise=COALESCE(elite_crm_profile_facts.budget_max_paise,excluded.budget_max_paise),service_intent_json=COALESCE(elite_crm_profile_facts.service_intent_json,excluded.service_intent_json),provenance_json=excluded.provenance_json,updated_at=excluded.updated_at")
          .bind(input.customerId, write.petId, write.patch.petTemperament ?? null, write.patch.budgetMinPaise ?? null, write.patch.budgetMaxPaise ?? null, serviceIntent ? JSON.stringify(serviceIntent) : null, JSON.stringify(write.provenance), Date.now()).run();
      } },
    },
  });
  await audit(db, "ai_crm_extractor", input.customerId, result.status, { patch: result.patch, accepted: result.acceptedEntities.length, rejected: result.rejectedEntityCount });
  return result;
}

export async function calculateEliteSurgeOverlay(db: Db, input: { service: "mobile_grooming" | "boarding"; zoneId: string; basePricePaise: number; now?: number }): Promise<SurgePricingQuote> {
  await ensureTables(db);
  const now = input.now ?? Date.now();
  const row = await db.prepare("SELECT * FROM elite_realtime_signals WHERE zone_id=?").bind(input.zoneId).first<Row>();
  const stale = 3600;
  const quote = calculateSurgePricing({ service: input.service, basePricePaise: input.basePricePaise, zone: { zoneId: input.zoneId, openDemand: number(row?.open_demand), activeProviders: number(row?.active_providers), sampleAgeSeconds: row ? Math.max(0, (now - number(row.zone_sampled_at, now - stale * 1000)) / 1000) : stale }, weather: { severity: number(row?.weather_severity), precipitationProbability: number(row?.precipitation_probability), forecastAgeSeconds: row ? Math.max(0, (now - number(row.weather_sampled_at, now - stale * 1000)) / 1000) : stale }, capacity: { utilization: number(row?.provider_utilization), availableSlots: number(row?.available_slots), totalSlots: number(row?.total_slots), sampleAgeSeconds: row ? Math.max(0, (now - number(row.capacity_sampled_at, now - stale * 1000)) / 1000) : stale } });
  await audit(db, "surge_pricing", input.zoneId, "quote_evaluated", { availability: quote.availability, multiplier: quote.multiplier, reasonCodes: quote.reasonCodes });
  return quote;
}

async function scoreCustomerChurn(db: Db, customerId: string, now: number) {
  const activity = await db.prepare("SELECT MAX(updated_at) last_activity FROM lead_work_items WHERE customer_id=?").bind(customerId).first<Row>().catch(() => null);
  const prefs = await contactSafety(db, customerId);
  const days = activity?.last_activity ? Math.max(0, (now - number(activity.last_activity)) / 86_400_000) : 90;
  const result = await scorePredictiveChurn({ customerId, telemetry: { daysSinceLastCompletedService: days, appSessionsLast30Days: 0, appSessionsPrevious30Days: 0, averageResponseLatencyHours: 0, cancellationRate90Days: 0, completedBookings90Days: 0, negativeSentimentRate90Days: 0 }, contactSafety: prefs });
  await db.prepare("INSERT INTO elite_churn_scores (customer_id,risk_score,risk_band,engagement_state,win_back_trigger,reason_codes_json,model_version,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(customer_id) DO UPDATE SET risk_score=excluded.risk_score,risk_band=excluded.risk_band,engagement_state=excluded.engagement_state,win_back_trigger=excluded.win_back_trigger,reason_codes_json=excluded.reason_codes_json,model_version=excluded.model_version,updated_at=excluded.updated_at")
    .bind(customerId, result.riskScore, result.riskBand, result.engagementState, result.winBackTrigger, JSON.stringify(result.reasonCodes), result.modelVersion, now).run();
  await audit(db, "predictive_churn", customerId, "scored", { riskScore: result.riskScore, riskBand: result.riskBand, winBackTrigger: result.winBackTrigger }, now);
  return result;
}

export async function runEliteMaintenanceSweep(db: Db, now = Date.now()) {
  await ensureTables(db);
  const rows = await db.prepare("SELECT id,customer_id,stage,status,last_outcome,updated_at,opt_out FROM lead_work_items WHERE status NOT IN ('closed','converted') ORDER BY updated_at ASC LIMIT 100").all<Row>().catch(() => ({ results: [] as Row[] }));
  const deals: SelfHealingDealSnapshot[] = [];
  for (const row of rows.results) {
    const customerId = text(row.customer_id), dealId = text(row.id);
    if (!customerId || !dealId) continue;
    const transcript = await db.prepare("SELECT 1 ok FROM elite_transcript_events WHERE customer_id=? LIMIT 1").bind(customerId).first<Row>().catch(() => null);
    const facts = await db.prepare("SELECT * FROM elite_crm_profile_facts WHERE customer_id=?").bind(customerId).first<Row>().catch(() => null);
    const safety = await contactSafety(db, customerId);
    await scoreCustomerChurn(db, customerId, now);
    const stageRaw = text(row.stage);
    const stage = (["new", "qualified", "proposal_sent", "payment_ready", "payment_link_sent", "won", "lost"] as const).includes(stageRaw as never) ? stageRaw as SelfHealingDealSnapshot["stage"] : "new";
    deals.push({ dealId, customerId, stage, updatedAt: number(row.updated_at, now), lastActivityAt: number(row.updated_at, now), profile: { serviceIntent: facts?.service_intent_json ? JSON.parse(text(facts.service_intent_json)) : null }, transcriptAvailable: Boolean(transcript), contactSafety: safety });
    const closer = await runAutonomousDealCloser({ dealId, customerId, currentStage: stage, latestInboundReply: text(row.last_outcome), paymentVerified: false, paymentLinkAlreadyIssued: false, canonicalQuote: null, contactSafety: safety }, { advanceStage: async input => audit(db, "autonomous_deal_closer", input.dealId, "stage_recommendation", input, now), queueGovernedPaymentLink: async request => { await db.prepare("INSERT OR IGNORE INTO elite_payment_link_requests (idempotency_key,deal_id,customer_id,quote_id,amount_paise,currency,requires_approval,requested_by,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(request.idempotencyKey, request.dealId, request.customerId, request.quoteId, request.amountPaise, request.currency, 1, request.requestedBy, "approval_required", now).run(); await audit(db, "autonomous_deal_closer", request.dealId, "payment_link_requested", { ...request, requiresApproval: true }, now); }, recordAudit: input => audit(db, "autonomous_deal_closer", input.dealId, input.action, input, now) }, now);
    if (closer.safety.eligibility !== "Allowed") await audit(db, "contact_safety_gate", customerId, "outreach_suppressed", { eligibility: closer.safety.eligibility, reasonCodes: closer.safety.reasonCodes }, now);
  }
  const worker = createSelfHealingCrmWorker({
    listCandidateDeals: () => deals,
    async claimIdempotencyKey(key) { const result = await db.prepare("INSERT OR IGNORE INTO elite_self_healing_claims (idempotency_key,claimed_at) VALUES (?,?)").bind(key, now).run(); return Number(result.meta?.changes ?? 0) > 0; },
    async requestEntityExtraction(input) { const latest = await db.prepare("SELECT message_id,text,occurred_at FROM elite_transcript_events WHERE customer_id=? ORDER BY occurred_at DESC LIMIT 1").bind(input.customerId).first<Row>(); if (latest) await processEliteInboundMessage(db, { customerId: input.customerId, messageId: text(latest.message_id), text: text(latest.text), occurredAt: number(latest.occurred_at, now) }); },
    refreshPredictiveChurn: input => scoreCustomerChurn(db, input.customerId, now).then(() => undefined),
    queueGovernedRecovery: input => audit(db, "self_healing_crm", input.dealId, "governed_recovery_queued", { ...input, requiresApproval: true }, now),
    recordAudit: input => audit(db, "self_healing_crm", input.dealId, input.action, input.detail, now),
  });
  return worker.runScheduled(now);
}
