import {
  evaluateContactEligibility,
  type ContactSafetyDecision,
  type ContactSafetyInput,
} from "./contact-safety-gate";

export interface ChurnTelemetry {
  daysSinceLastCompletedService: number;
  appSessionsLast30Days: number;
  appSessionsPrevious30Days: number;
  averageResponseLatencyHours: number;
  cancellationRate90Days: number;
  completedBookings90Days: number;
  negativeSentimentRate90Days: number;
  paymentFailureRate90Days?: number;
  supportEscalations90Days?: number;
}

export interface ChurnFeatureVector {
  recencyRisk: number;
  engagementDrop: number;
  responseLatencyRisk: number;
  cancellationRisk: number;
  negativeSentimentRisk: number;
  paymentFrictionRisk: number;
  supportEscalationRisk: number;
  recentValueSignal: number;
}

export interface ChurnModelScore {
  probability: number;
  modelVersion: string;
  featureContributions?: Partial<Record<keyof ChurnFeatureVector, number>>;
}

export interface ChurnModelAdapter {
  score(features: ChurnFeatureVector): Promise<ChurnModelScore> | ChurnModelScore;
}

export interface PredictiveChurnInput {
  customerId: string;
  telemetry: ChurnTelemetry;
  contactSafety: ContactSafetyInput;
  model?: ChurnModelAdapter;
  policyVersion?: string;
}

export interface PredictiveChurnResult {
  customerId: string;
  churnProbability: number;
  riskScore: number;
  engagementScore: number;
  riskBand: "low" | "medium" | "high" | "critical";
  engagementState: "healthy" | "watch" | "intervene" | "critical";
  recommendedRecheckMinutes: number;
  featureVector: ChurnFeatureVector;
  reasonCodes: string[];
  contactSafety: ContactSafetyDecision;
  winBackTrigger: "none" | "queue_for_review" | "eligible_for_proactive_winback";
  modelVersion: string;
  policyVersion: string;
}

const POLICY_VERSION = "v2-predictive-churn-2026-09-04";
const FALLBACK_MODEL_VERSION = "v2-logistic-churn-baseline-1";

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-value));
}

export function buildChurnFeatureVector(telemetry: ChurnTelemetry): ChurnFeatureVector {
  const currentSessions = finiteNonNegative(telemetry.appSessionsLast30Days);
  const previousSessions = finiteNonNegative(telemetry.appSessionsPrevious30Days);
  const engagementDrop = previousSessions <= 0
    ? 0
    : clamp((previousSessions - currentSessions) / previousSessions, 0, 1);
  const recencyDays = finiteNonNegative(telemetry.daysSinceLastCompletedService);
  const recencyRisk = 1 - Math.exp(-recencyDays / 45);
  const completedBookings = finiteNonNegative(telemetry.completedBookings90Days);

  return {
    recencyRisk: clamp(recencyRisk, 0, 1),
    engagementDrop,
    responseLatencyRisk: clamp(finiteNonNegative(telemetry.averageResponseLatencyHours) / 72, 0, 1),
    cancellationRisk: clamp(finiteNonNegative(telemetry.cancellationRate90Days), 0, 1),
    negativeSentimentRisk: clamp(finiteNonNegative(telemetry.negativeSentimentRate90Days), 0, 1),
    paymentFrictionRisk: clamp(finiteNonNegative(telemetry.paymentFailureRate90Days ?? 0), 0, 1),
    supportEscalationRisk: clamp(finiteNonNegative(telemetry.supportEscalations90Days ?? 0) / 3, 0, 1),
    recentValueSignal: clamp(completedBookings / 6, 0, 1),
  };
}

export const DEFAULT_CHURN_MODEL: ChurnModelAdapter = {
  score(features) {
    const contributions: Record<keyof ChurnFeatureVector, number> = {
      recencyRisk: features.recencyRisk * 1.2,
      engagementDrop: features.engagementDrop * 1.1,
      responseLatencyRisk: features.responseLatencyRisk * 0.65,
      cancellationRisk: features.cancellationRisk * 1.4,
      negativeSentimentRisk: features.negativeSentimentRisk * 1.05,
      paymentFrictionRisk: features.paymentFrictionRisk * 0.8,
      supportEscalationRisk: features.supportEscalationRisk * 0.7,
      recentValueSignal: features.recentValueSignal * -0.9,
    };
    const linear = -1.35 + Object.values(contributions).reduce((total, value) => total + value, 0);
    return {
      probability: sigmoid(linear),
      modelVersion: FALLBACK_MODEL_VERSION,
      featureContributions: contributions,
    };
  },
};

function reasons(features: ChurnFeatureVector): string[] {
  const reasonCodes: string[] = [];
  if (features.recencyRisk >= 0.65) reasonCodes.push("service_recency_risk");
  if (features.engagementDrop >= 0.4) reasonCodes.push("app_engagement_drop");
  if (features.responseLatencyRisk >= 0.5) reasonCodes.push("slow_customer_response_pattern");
  if (features.cancellationRisk >= 0.3) reasonCodes.push("elevated_cancellation_pattern");
  if (features.negativeSentimentRisk >= 0.25) reasonCodes.push("negative_sentiment_pattern");
  if (features.paymentFrictionRisk >= 0.25) reasonCodes.push("payment_friction_pattern");
  if (features.supportEscalationRisk >= 0.34) reasonCodes.push("support_escalation_pattern");
  if (features.recentValueSignal >= 0.5) reasonCodes.push("recent_repeat_value_signal");
  return reasonCodes;
}

function riskBand(probability: number): PredictiveChurnResult["riskBand"] {
  if (probability >= 0.8) return "critical";
  if (probability >= 0.6) return "high";
  if (probability >= 0.35) return "medium";
  return "low";
}

function continuousEngagementPolicy(band: PredictiveChurnResult["riskBand"]): {
  engagementState: PredictiveChurnResult["engagementState"];
  recommendedRecheckMinutes: number;
} {
  if (band === "critical") return { engagementState: "critical", recommendedRecheckMinutes: 60 };
  if (band === "high") return { engagementState: "intervene", recommendedRecheckMinutes: 180 };
  if (band === "medium") return { engagementState: "watch", recommendedRecheckMinutes: 720 };
  return { engagementState: "healthy", recommendedRecheckMinutes: 1_440 };
}

export async function scorePredictiveChurn(input: PredictiveChurnInput): Promise<PredictiveChurnResult> {
  const features = buildChurnFeatureVector(input.telemetry);
  const modelScore = await (input.model ?? DEFAULT_CHURN_MODEL).score(features);
  const probability = clamp(modelScore.probability, 0, 1);
  const contactSafety = evaluateContactEligibility(input.contactSafety);
  const band = riskBand(probability);
  const engagement = continuousEngagementPolicy(band);
  const highRisk = probability >= 0.6;
  const winBackTrigger = !highRisk
    ? "none"
    : contactSafety.eligibility === "Allowed"
      ? "eligible_for_proactive_winback"
      : "queue_for_review";
  const riskScore = Math.round(probability * 100);

  return {
    customerId: input.customerId,
    churnProbability: Math.round(probability * 10_000) / 10_000,
    riskScore,
    engagementScore: 100 - riskScore,
    riskBand: band,
    engagementState: engagement.engagementState,
    recommendedRecheckMinutes: engagement.recommendedRecheckMinutes,
    featureVector: features,
    reasonCodes: reasons(features),
    contactSafety,
    winBackTrigger,
    modelVersion: modelScore.modelVersion,
    policyVersion: input.policyVersion?.trim() || POLICY_VERSION,
  };
}
