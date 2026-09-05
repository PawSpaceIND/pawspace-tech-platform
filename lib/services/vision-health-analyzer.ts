import type { HealthFlagSeverity, ServiceHealthFlag } from "../types/pet-report-card";

export type VisionConcernCode =
  | "redness_or_irritation_like_area"
  | "coat_or_skin_change"
  | "wound_or_lesion_like_area"
  | "swelling_like_area"
  | "parasite_like_pattern"
  | "image_quality_insufficient";

export interface VisionMediaAsset {
  assetId: string;
  kind: "image" | "video";
  capturedAt: string;
  contentType: string;
  signedReadUrl: string;
  qualityScore?: number | null;
}

export interface VisionModelFlag {
  code: VisionConcernCode;
  confidence: number;
  evidenceAssetIds: string[];
  note?: string;
}

export interface VisionModelRequest {
  jobId: string;
  petId: string;
  media: VisionMediaAsset[];
  task: "post_service_dermatology_screening";
  instruction: string;
}

export interface VisionModelResponse {
  model: string;
  requestId?: string;
  flags: VisionModelFlag[];
}

export interface VisionHealthModel {
  analyze(request: VisionModelRequest): Promise<VisionModelResponse>;
}

export interface VisionHealthAnalyzerInput {
  jobId: string;
  petId: string;
  media: VisionMediaAsset[];
  analysisConsent: boolean;
  model: VisionHealthModel;
  minimumConfidence?: number;
  policyVersion?: string;
}

export interface VisionHealthScreeningResult {
  status: "screened" | "consent_required" | "insufficient_media" | "model_unavailable";
  jobId: string;
  petId: string;
  flags: ServiceHealthFlag[];
  concernDetails: VisionModelFlag[];
  reviewPriority: "none" | "routine_review" | "priority_review";
  model: string | null;
  requestId: string | null;
  disclaimer: string;
  policyVersion: string;
}

const POLICY_VERSION = "v2-vision-health-2026-09-04";
const DISCLAIMER = "Automated visual screening only; this is not a veterinary diagnosis. Any concern must be reviewed by a qualified human and escalated to a veterinarian when appropriate.";

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function severityFor(flag: VisionModelFlag): HealthFlagSeverity {
  if (["wound_or_lesion_like_area", "swelling_like_area"].includes(flag.code) && flag.confidence >= 0.85) {
    return "urgent";
  }
  if (flag.code === "image_quality_insufficient") return "info";
  return flag.confidence >= 0.65 ? "watch" : "info";
}

function reviewPriority(flags: ServiceHealthFlag[]): VisionHealthScreeningResult["reviewPriority"] {
  if (flags.some((flag) => flag.severity === "urgent")) return "priority_review";
  if (flags.some((flag) => flag.severity === "watch")) return "routine_review";
  return "none";
}

function baseResult(
  input: VisionHealthAnalyzerInput,
  status: VisionHealthScreeningResult["status"],
  policyVersion: string,
): VisionHealthScreeningResult {
  return {
    status,
    jobId: input.jobId,
    petId: input.petId,
    flags: [],
    concernDetails: [],
    reviewPriority: "none",
    model: null,
    requestId: null,
    disclaimer: DISCLAIMER,
    policyVersion,
  };
}

function validMedia(media: VisionMediaAsset[]): VisionMediaAsset[] {
  return media.filter((asset) => {
    const contentTypeAllowed = asset.kind === "image"
      ? asset.contentType.startsWith("image/")
      : asset.contentType.startsWith("video/");
    const quality = asset.qualityScore == null ? 1 : clamp(asset.qualityScore, 0, 1);
    return Boolean(asset.assetId.trim() && asset.signedReadUrl.trim() && contentTypeAllowed && quality >= 0.35);
  });
}

export async function analyzePostServiceHealth(
  input: VisionHealthAnalyzerInput,
): Promise<VisionHealthScreeningResult> {
  const policyVersion = input.policyVersion?.trim() || POLICY_VERSION;
  if (!input.analysisConsent) return baseResult(input, "consent_required", policyVersion);

  const media = validMedia(input.media);
  if (media.length === 0) return baseResult(input, "insufficient_media", policyVersion);

  const minimumConfidence = clamp(input.minimumConfidence ?? 0.55, 0.3, 0.95);
  let response: VisionModelResponse;
  try {
    response = await input.model.analyze({
      jobId: input.jobId,
      petId: input.petId,
      media,
      task: "post_service_dermatology_screening",
      instruction: [
        "Screen checkout media for visible skin/coat concern patterns only.",
        "Do not diagnose disease, infer causes, or claim treatment is required.",
        "Return conservative concern flags with confidence and evidence asset IDs.",
        "Use image_quality_insufficient when visibility is inadequate.",
      ].join(" "),
    });
  } catch {
    return baseResult(input, "model_unavailable", policyVersion);
  }

  const allowedAssetIds = new Set(media.map((asset) => asset.assetId));
  const details = response.flags
    .map((flag): VisionModelFlag => ({
      ...flag,
      confidence: clamp(flag.confidence, 0, 1),
      evidenceAssetIds: flag.evidenceAssetIds.filter((assetId) => allowedAssetIds.has(assetId)),
    }))
    .filter((flag) => flag.confidence >= minimumConfidence && flag.evidenceAssetIds.length > 0)
    .sort((left, right) => right.confidence - left.confidence);

  const flags = details.map((flag): ServiceHealthFlag => ({
    code: `vision:${flag.code}`,
    severity: severityFor(flag),
    observedAt: media.find((asset) => flag.evidenceAssetIds.includes(asset.assetId))?.capturedAt ?? new Date(0).toISOString(),
    notes: `Automated visual concern flag (${Math.round(flag.confidence * 100)}% model confidence). Human review required.${flag.note ? ` ${flag.note}` : ""}`,
  }));

  return {
    status: "screened",
    jobId: input.jobId,
    petId: input.petId,
    flags,
    concernDetails: details,
    reviewPriority: reviewPriority(flags),
    model: response.model,
    requestId: response.requestId ?? null,
    disclaimer: DISCLAIMER,
    policyVersion,
  };
}
