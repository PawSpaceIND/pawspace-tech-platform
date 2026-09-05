import { assertAiActionAllowed } from "../ai-governance";
import {
  evaluateContactEligibility,
  type ContactSafetyDecision,
  type ContactSafetyInput,
} from "./contact-safety-gate";

export type AutonomousDealStage =
  | "new"
  | "qualified"
  | "proposal_sent"
  | "payment_ready"
  | "payment_link_sent"
  | "won"
  | "lost";

export type ReplyIntent = "buy" | "question" | "objection" | "decline" | "unknown";

export interface DealReplyInsight {
  sentiment: number;
  intent: ReplyIntent;
  confidence: number;
  modelVersion: string;
}

export interface DealReplyAnalyzer {
  analyze(replyText: string): DealReplyInsight | Promise<DealReplyInsight>;
}

export interface CanonicalDealQuote {
  quoteId: string;
  amountPaise: number;
  currency: string;
  expiresAt: number;
}

export interface AutonomousDealSnapshot {
  dealId: string;
  customerId: string;
  currentStage: AutonomousDealStage;
  latestInboundReply: string;
  paymentVerified: boolean;
  paymentLinkAlreadyIssued: boolean;
  canonicalQuote: CanonicalDealQuote | null;
  contactSafety: ContactSafetyInput;
}

export interface GovernedPaymentLinkRequest {
  dealId: string;
  customerId: string;
  quoteId: string;
  amountPaise: number;
  currency: string;
  idempotencyKey: string;
  requiresApproval: true;
  requestedBy: "autonomous_ai_crm";
}

export interface AutonomousDealCloserDependencies {
  replyAnalyzer?: DealReplyAnalyzer;
  advanceStage(input: {
    dealId: string;
    from: AutonomousDealStage;
    to: AutonomousDealStage;
    reasonCode: string;
  }): void | Promise<void>;
  queueGovernedPaymentLink(request: GovernedPaymentLinkRequest): void | Promise<void>;
  recordAudit?(input: {
    dealId: string;
    action: string;
    reasonCode: string;
    modelVersion: string;
  }): void | Promise<void>;
}

export interface AutonomousDealCloserDecision {
  dealId: string;
  insight: DealReplyInsight;
  safety: ContactSafetyDecision;
  targetStage: AutonomousDealStage;
  stageReasonCode: string;
  paymentLinkRequest: GovernedPaymentLinkRequest | null;
  financialExecution: "governed_queue_only";
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function fallbackAnalyze(replyText: string): DealReplyInsight {
  const text = replyText.toLowerCase();
  const hasBuyIntent = /\b(book|buy|pay|proceed|confirm|go ahead|send (the )?link)\b/.test(text);
  const hasDecline = /\b(no thanks|not interested|cancel|stop|do not contact|don't contact)\b/.test(text);
  const hasObjection = /\b(expensive|costly|too much|later|not now|think about)\b/.test(text);
  const hasQuestion = text.includes("?") || /\b(what|when|where|how|which|can you|could you)\b/.test(text);
  const intent: ReplyIntent = hasDecline
    ? "decline"
    : hasBuyIntent
      ? "buy"
      : hasObjection
        ? "objection"
        : hasQuestion
          ? "question"
          : "unknown";
  const sentiment = hasDecline ? -0.8 : hasObjection ? -0.25 : hasBuyIntent ? 0.7 : 0;
  const confidence = intent === "unknown" ? 0.45 : 0.82;
  return { sentiment, intent, confidence, modelVersion: "deterministic-intent-fallback-1" };
}

function validateInsight(insight: DealReplyInsight): DealReplyInsight {
  return {
    sentiment: clamp(Number.isFinite(insight.sentiment) ? insight.sentiment : 0, -1, 1),
    intent: insight.intent,
    confidence: clamp(Number.isFinite(insight.confidence) ? insight.confidence : 0, 0, 1),
    modelVersion: insight.modelVersion.trim() || "unknown",
  };
}

function nextCommercialStage(current: AutonomousDealStage): AutonomousDealStage {
  if (current === "new") return "qualified";
  if (current === "qualified") return "proposal_sent";
  return current;
}

export async function evaluateAutonomousDealCloser(
  snapshot: AutonomousDealSnapshot,
  analyzer?: DealReplyAnalyzer,
  now = Date.now(),
): Promise<AutonomousDealCloserDecision> {
  assertAiActionAllowed("next_best_action");
  const insight = validateInsight(await (analyzer?.analyze(snapshot.latestInboundReply) ?? fallbackAnalyze(snapshot.latestInboundReply)));
  const safety = evaluateContactEligibility(snapshot.contactSafety);
  let targetStage = snapshot.currentStage;
  let stageReasonCode = "no_material_change";
  let paymentLinkRequest: GovernedPaymentLinkRequest | null = null;

  if (snapshot.paymentVerified) {
    targetStage = "won";
    stageReasonCode = "canonical_payment_verified";
  } else if (insight.intent === "decline" && insight.confidence >= 0.9) {
    targetStage = "lost";
    stageReasonCode = "explicit_customer_decline";
  } else if (insight.intent === "buy" && insight.confidence >= 0.75) {
    const quote = snapshot.canonicalQuote;
    if (quote && quote.expiresAt > now && quote.amountPaise > 0 && safety.eligibility === "Allowed") {
      targetStage = snapshot.paymentLinkAlreadyIssued ? "payment_link_sent" : "payment_ready";
      stageReasonCode = snapshot.paymentLinkAlreadyIssued ? "governed_payment_link_already_issued" : "explicit_buy_intent_with_valid_quote";
      if (!snapshot.paymentLinkAlreadyIssued) {
        paymentLinkRequest = {
          dealId: snapshot.dealId,
          customerId: snapshot.customerId,
          quoteId: quote.quoteId,
          amountPaise: Math.round(quote.amountPaise),
          currency: quote.currency,
          idempotencyKey: `ai-deal:${snapshot.dealId}:${quote.quoteId}`,
          requiresApproval: true,
          requestedBy: "autonomous_ai_crm",
        };
      }
    } else {
      targetStage = nextCommercialStage(snapshot.currentStage);
      stageReasonCode = safety.eligibility === "Allowed" ? "buy_intent_missing_valid_quote" : "contact_safety_blocks_payment_outreach";
    }
  } else if (insight.sentiment >= 0.25 && insight.confidence >= 0.65) {
    targetStage = nextCommercialStage(snapshot.currentStage);
    stageReasonCode = "positive_engagement_progression";
  }

  return {
    dealId: snapshot.dealId,
    insight,
    safety,
    targetStage,
    stageReasonCode,
    paymentLinkRequest,
    financialExecution: "governed_queue_only",
  };
}

export async function runAutonomousDealCloser(
  snapshot: AutonomousDealSnapshot,
  dependencies: AutonomousDealCloserDependencies,
  now = Date.now(),
): Promise<AutonomousDealCloserDecision> {
  const decision = await evaluateAutonomousDealCloser(snapshot, dependencies.replyAnalyzer, now);
  if (decision.targetStage !== snapshot.currentStage) {
    await dependencies.advanceStage({
      dealId: snapshot.dealId,
      from: snapshot.currentStage,
      to: decision.targetStage,
      reasonCode: decision.stageReasonCode,
    });
  }
  if (decision.paymentLinkRequest) {
    await dependencies.queueGovernedPaymentLink(decision.paymentLinkRequest);
  }
  await dependencies.recordAudit?.({
    dealId: snapshot.dealId,
    action: decision.paymentLinkRequest ? "payment_link_requested" : "pipeline_evaluated",
    reasonCode: decision.stageReasonCode,
    modelVersion: decision.insight.modelVersion,
  });
  return decision;
}
