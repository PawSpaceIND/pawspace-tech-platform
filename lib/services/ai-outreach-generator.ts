import {
  evaluateContactEligibility,
  type ContactSafetyDecision,
  type ContactSafetyInput,
} from "./contact-safety-gate";

export type OutreachChannel = "whatsapp" | "email";
export type OutreachTone = "warm" | "reassuring" | "concise" | "celebratory";

export interface PetBreedTelemetry {
  breed: string | null;
  species: string;
  lifeStage?: "puppy_kitten" | "adult" | "senior" | "unknown";
  coatProfile?: "short" | "medium" | "long" | "double" | "hairless" | "unknown";
  activityProfile?: "low" | "moderate" | "high" | "unknown";
}

export interface LifecycleMilestone {
  code: string;
  label: string;
  occurredAt?: number | null;
  dueAt?: number | null;
  importance?: number;
}

export interface SentimentObservation {
  score: number;
  recordedAt: number;
  source: "whatsapp" | "email" | "call" | "app" | "support";
}

export interface AiOutreachInput {
  channel: OutreachChannel;
  customerName: string;
  petName: string;
  petTelemetry: PetBreedTelemetry;
  lifecycleMilestones: LifecycleMilestone[];
  sentimentHistory: SentimentObservation[];
  recommendedService: string;
  reason: string;
  callToAction: string;
  locale?: string;
  contactSafety: ContactSafetyInput;
  policyVersion?: string;
}

export interface OutreachGenerationRequest {
  channel: OutreachChannel;
  locale: string;
  systemInstruction: string;
  customerContext: string;
  maxCharacters: number;
}

export interface OutreachGenerationResponse {
  text: string;
  subject?: string;
  model: string;
  requestId?: string;
}

export interface OutreachTextGenerator {
  generate(request: OutreachGenerationRequest): Promise<OutreachGenerationResponse>;
}

export interface GeneratedOutreachCopy {
  status: "generated" | "fallback" | "blocked";
  channel: OutreachChannel;
  subject: string | null;
  body: string | null;
  tone: OutreachTone;
  safety: ContactSafetyDecision;
  evidence: {
    breed: string | null;
    lifecycleCodes: string[];
    sentimentScore: number;
  };
  model: string | null;
  requestId: string | null;
  policyVersion: string;
}

const POLICY_VERSION = "v2-ai-outreach-2026-09-04";
const MAX_WHATSAPP_CHARACTERS = 700;
const MAX_EMAIL_CHARACTERS = 1_800;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function clean(value: string, fallback: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized || fallback;
}

function sentimentScore(history: SentimentObservation[]): number {
  const valid = history
    .filter((entry) => Number.isFinite(entry.score) && Number.isFinite(entry.recordedAt))
    .sort((left, right) => right.recordedAt - left.recordedAt)
    .slice(0, 8);
  if (valid.length === 0) return 0;

  let weightedTotal = 0;
  let totalWeight = 0;
  for (let index = 0; index < valid.length; index += 1) {
    const weight = 1 / (index + 1);
    weightedTotal += clamp(valid[index].score, -1, 1) * weight;
    totalWeight += weight;
  }
  return totalWeight === 0 ? 0 : weightedTotal / totalWeight;
}

function chooseTone(score: number, milestones: LifecycleMilestone[]): OutreachTone {
  if (score <= -0.25) return "reassuring";
  if (milestones.some((milestone) => (milestone.importance ?? 0) >= 0.8)) return "celebratory";
  if (score >= 0.35) return "warm";
  return "concise";
}

function rankedMilestones(milestones: LifecycleMilestone[]): LifecycleMilestone[] {
  return [...milestones]
    .filter((milestone) => milestone.code.trim() && milestone.label.trim())
    .sort((left, right) => {
      const importanceDelta = (right.importance ?? 0) - (left.importance ?? 0);
      if (importanceDelta !== 0) return importanceDelta;
      return (right.dueAt ?? right.occurredAt ?? 0) - (left.dueAt ?? left.occurredAt ?? 0);
    })
    .slice(0, 3);
}

function buildContext(input: AiOutreachInput, tone: OutreachTone): string {
  const milestones = rankedMilestones(input.lifecycleMilestones);
  const telemetry = input.petTelemetry;
  const breed = telemetry.breed?.trim() || "breed not recorded";
  const milestoneText = milestones.length
    ? milestones.map((milestone) => `${milestone.code}: ${milestone.label}`).join("; ")
    : "no high-confidence lifecycle milestone";

  return [
    `Customer: ${clean(input.customerName, "Pet parent")}`,
    `Pet: ${clean(input.petName, "their pet")}`,
    `Species: ${clean(telemetry.species, "pet")}`,
    `Breed telemetry: ${breed}`,
    `Life stage: ${telemetry.lifeStage ?? "unknown"}`,
    `Coat profile: ${telemetry.coatProfile ?? "unknown"}`,
    `Activity profile: ${telemetry.activityProfile ?? "unknown"}`,
    `Lifecycle evidence: ${milestoneText}`,
    `Recommended service: ${clean(input.recommendedService, "PawSpace service")}`,
    `Recommendation reason: ${clean(input.reason, "relevant service history")}`,
    `Desired tone: ${tone}`,
    `CTA: ${clean(input.callToAction, "Reply to learn more")}`,
  ].join("\n");
}

export function buildOutreachGenerationRequest(input: AiOutreachInput): OutreachGenerationRequest {
  const score = sentimentScore(input.sentimentHistory);
  const tone = chooseTone(score, input.lifecycleMilestones);
  const maxCharacters = input.channel === "whatsapp"
    ? MAX_WHATSAPP_CHARACTERS
    : MAX_EMAIL_CHARACTERS;

  return {
    channel: input.channel,
    locale: input.locale?.trim() || "en-IN",
    maxCharacters,
    systemInstruction: [
      "Write concise PawSpace customer outreach using only the supplied facts.",
      "Do not invent medical, behavioral, pricing, availability, urgency, discount, or guarantee claims.",
      "Do not reveal internal scores, sentiment labels, telemetry mechanics, or policy names.",
      "Personalize lightly using pet breed/life-stage telemetry and lifecycle milestones without stereotyping.",
      "If the recent sentiment is negative, acknowledge gently without asserting why the customer feels that way.",
      input.channel === "email"
        ? "Return a short subject and body."
        : "Return WhatsApp body copy only; do not include an email subject.",
    ].join(" "),
    customerContext: buildContext(input, tone),
  };
}

function fallbackCopy(input: AiOutreachInput, tone: OutreachTone): { subject: string | null; body: string } {
  const customer = clean(input.customerName, "there");
  const pet = clean(input.petName, "your pet");
  const service = clean(input.recommendedService, "a PawSpace service");
  const cta = clean(input.callToAction, "Reply to learn more");
  const milestone = rankedMilestones(input.lifecycleMilestones)[0]?.label;
  const telemetry = input.petTelemetry.breed?.trim();
  const petDetail = telemetry ? `${pet}, your ${telemetry}` : pet;
  const context = milestone ? ` With ${milestone.toLowerCase()} in mind,` : "";
  const opening = tone === "reassuring"
    ? `Hi ${customer}, just a gentle note about ${petDetail}.`
    : tone === "celebratory"
      ? `Hi ${customer}! A little PawSpace moment for ${petDetail}.`
      : `Hi ${customer}, a quick PawSpace note for ${petDetail}.`;
  const body = `${opening}${context} ${service} may be useful based on ${clean(input.reason, "recent service history")}. ${cta}.`;

  return {
    subject: input.channel === "email" ? `${pet}: a PawSpace recommendation` : null,
    body,
  };
}

function normalizeGeneratedCopy(
  input: AiOutreachInput,
  response: OutreachGenerationResponse,
): { subject: string | null; body: string } | null {
  const maximum = input.channel === "whatsapp" ? MAX_WHATSAPP_CHARACTERS : MAX_EMAIL_CHARACTERS;
  const body = response.text.replace(/\s+/g, " ").trim();
  if (!body || body.length > maximum) return null;
  const subject = input.channel === "email"
    ? response.subject?.replace(/\s+/g, " ").trim().slice(0, 120) || `${clean(input.petName, "Your pet")}: PawSpace recommendation`
    : null;
  return { subject, body };
}

export async function generateAiOutreach(
  input: AiOutreachInput,
  generator?: OutreachTextGenerator,
): Promise<GeneratedOutreachCopy> {
  const safety = evaluateContactEligibility(input.contactSafety);
  const score = sentimentScore(input.sentimentHistory);
  const tone = chooseTone(score, input.lifecycleMilestones);
  const policyVersion = input.policyVersion?.trim() || POLICY_VERSION;
  const evidence = {
    breed: input.petTelemetry.breed?.trim() || null,
    lifecycleCodes: rankedMilestones(input.lifecycleMilestones).map((milestone) => milestone.code),
    sentimentScore: Math.round(score * 1_000) / 1_000,
  };

  if (safety.eligibility !== "Allowed") {
    return {
      status: "blocked",
      channel: input.channel,
      subject: null,
      body: null,
      tone,
      safety,
      evidence,
      model: null,
      requestId: null,
      policyVersion,
    };
  }

  if (generator) {
    try {
      const response = await generator.generate(buildOutreachGenerationRequest(input));
      const normalized = normalizeGeneratedCopy(input, response);
      if (normalized) {
        return {
          status: "generated",
          channel: input.channel,
          ...normalized,
          tone,
          safety,
          evidence,
          model: response.model,
          requestId: response.requestId ?? null,
          policyVersion,
        };
      }
    } catch {
      // Fail soft to deterministic governed copy; delivery still remains safety-gated.
    }
  }

  const fallback = fallbackCopy(input, tone);
  return {
    status: "fallback",
    channel: input.channel,
    ...fallback,
    tone,
    safety,
    evidence,
    model: null,
    requestId: null,
    policyVersion,
  };
}
