import type { TranscriptMessage } from "./omnichannel-transcript-ingestion";

export type PetTemperament = "calm" | "energetic" | "anxious" | "reactive" | "social" | "shy";
export type AiCrmEntityField =
  | "petTemperament"
  | "budgetMinPaise"
  | "budgetMaxPaise"
  | "serviceIntent";

export interface ExistingCrmProfile {
  customerId: string;
  petId?: string | null;
  petTemperament?: PetTemperament | null;
  budgetMinPaise?: number | null;
  budgetMaxPaise?: number | null;
  serviceIntent?: string[] | null;
}

export interface StructuredJsonGenerationRequest {
  schemaName: "pawspace_ai_crm_entity_extraction_v1";
  systemInstruction: string;
  transcript: Array<{
    messageId: string;
    channel: "whatsapp" | "email" | "call";
    occurredAt: number;
    text: string;
  }>;
  responseSchema: typeof AI_CRM_EXTRACTION_SCHEMA;
}

export interface StructuredJsonGenerationResponse {
  json: unknown;
  model: string;
  requestId?: string | null;
}

export interface StructuredJsonGenerator {
  generate(request: StructuredJsonGenerationRequest): Promise<StructuredJsonGenerationResponse>;
}

export interface CrmProfilePatch {
  petTemperament?: PetTemperament;
  budgetMinPaise?: number;
  budgetMaxPaise?: number;
  serviceIntent?: string[];
}

export interface CrmProfilePatchWriter {
  applyMissingFields(input: {
    customerId: string;
    petId: string | null;
    patch: CrmProfilePatch;
    provenance: Array<{ field: AiCrmEntityField; messageId: string; quote: string; confidence: number }>;
    model: string;
    requestId: string | null;
  }): void | Promise<void>;
}

export interface AiCrmEntityExtractorDependencies {
  generator: StructuredJsonGenerator;
  writer?: CrmProfilePatchWriter;
}

interface ValidEntity {
  field: AiCrmEntityField;
  value: PetTemperament | number | string[];
  confidence: number;
  messageId: string;
  quote: string;
}

export interface AiCrmExtractionResult {
  status: "applied" | "no_change" | "review_required";
  patch: CrmProfilePatch;
  acceptedEntities: ValidEntity[];
  rejectedEntityCount: number;
  model: string;
  requestId: string | null;
}

export const AI_CRM_EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["entities"],
  properties: {
    entities: {
      type: "array",
      maxItems: 16,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["field", "value", "confidence", "messageId", "quote"],
        properties: {
          field: { enum: ["petTemperament", "budgetMinPaise", "budgetMaxPaise", "serviceIntent"] },
          value: {},
          confidence: { type: "number", minimum: 0, maximum: 1 },
          messageId: { type: "string" },
          quote: { type: "string", maxLength: 240 },
        },
      },
    },
  },
} as const;

const SYSTEM_INSTRUCTION = [
  "Extract only facts explicitly stated by the customer in the supplied transcript.",
  "Never infer health diagnoses, protected/sensitive traits, income, or affordability from proxies.",
  "Budget fields are allowed only when a concrete customer-stated amount or range exists.",
  "Pet temperament must use the supplied enum and must be supported by a direct quote.",
  "Every entity requires messageId, verbatim evidence quote, and calibrated confidence.",
  "Return schema-valid JSON only. Omit uncertain facts instead of guessing.",
].join(" ");

const TEMPERAMENTS = new Set<PetTemperament>(["calm", "energetic", "anxious", "reactive", "social", "shy"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeQuote(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const quote = value.replace(/\s+/g, " ").trim().slice(0, 240);
  return quote || null;
}

function normalizeServiceIntent(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const services = [...new Set(value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_"))
    .filter(Boolean))]
    .slice(0, 8);
  return services.length ? services : null;
}

function normalizeEntity(raw: unknown, transcriptById: Map<string, TranscriptMessage>): ValidEntity | null {
  if (!isRecord(raw)) return null;
  const field = raw.field;
  const messageId = typeof raw.messageId === "string" ? raw.messageId.trim() : "";
  const confidence = typeof raw.confidence === "number" && Number.isFinite(raw.confidence)
    ? Math.min(1, Math.max(0, raw.confidence))
    : -1;
  const quote = normalizeQuote(raw.quote);
  const source = transcriptById.get(messageId);
  if (!source || !quote || confidence < 0) return null;
  const normalizedSource = source.text.replace(/\s+/g, " ").toLowerCase();
  if (!normalizedSource.includes(quote.toLowerCase())) return null;

  if (field === "petTemperament" && typeof raw.value === "string" && TEMPERAMENTS.has(raw.value as PetTemperament)) {
    return { field, value: raw.value as PetTemperament, confidence, messageId, quote };
  }
  if ((field === "budgetMinPaise" || field === "budgetMaxPaise") && typeof raw.value === "number" && Number.isFinite(raw.value) && raw.value >= 0) {
    return { field, value: Math.round(raw.value), confidence, messageId, quote };
  }
  if (field === "serviceIntent") {
    const services = normalizeServiceIntent(raw.value);
    if (services) return { field, value: services, confidence, messageId, quote };
  }
  return null;
}

function isMissingScalar(value: unknown): boolean {
  return value == null || value === "";
}

function buildPatch(profile: ExistingCrmProfile, entities: ValidEntity[], threshold: number): CrmProfilePatch {
  const patch: CrmProfilePatch = {};
  for (const entity of entities) {
    if (entity.confidence < threshold) continue;
    if (entity.field === "petTemperament" && isMissingScalar(profile.petTemperament) && patch.petTemperament == null) {
      patch.petTemperament = entity.value as PetTemperament;
    } else if (entity.field === "budgetMinPaise" && profile.budgetMinPaise == null && patch.budgetMinPaise == null) {
      patch.budgetMinPaise = entity.value as number;
    } else if (entity.field === "budgetMaxPaise" && profile.budgetMaxPaise == null && patch.budgetMaxPaise == null) {
      patch.budgetMaxPaise = entity.value as number;
    } else if (entity.field === "serviceIntent" && (!profile.serviceIntent || profile.serviceIntent.length === 0) && patch.serviceIntent == null) {
      patch.serviceIntent = entity.value as string[];
    }
  }
  if (patch.budgetMinPaise != null && patch.budgetMaxPaise != null && patch.budgetMinPaise > patch.budgetMaxPaise) {
    delete patch.budgetMinPaise;
    delete patch.budgetMaxPaise;
  }
  return patch;
}

function hasPatch(patch: CrmProfilePatch): boolean {
  return Object.keys(patch).length > 0;
}

export async function extractAndApplyCrmEntities(input: {
  profile: ExistingCrmProfile;
  transcript: TranscriptMessage[];
  dependencies: AiCrmEntityExtractorDependencies;
  confidenceThreshold?: number;
}): Promise<AiCrmExtractionResult> {
  const transcript = input.transcript
    .filter((message) => message.direction === "inbound" || message.direction === "summary")
    .slice(-40);
  const response = await input.dependencies.generator.generate({
    schemaName: "pawspace_ai_crm_entity_extraction_v1",
    systemInstruction: SYSTEM_INSTRUCTION,
    transcript: transcript.map((message) => ({
      messageId: message.messageId,
      channel: message.channel,
      occurredAt: message.occurredAt,
      text: message.text,
    })),
    responseSchema: AI_CRM_EXTRACTION_SCHEMA,
  });

  const root = isRecord(response.json) ? response.json : {};
  const rawEntities = Array.isArray(root.entities) ? root.entities.slice(0, 16) : [];
  const transcriptById = new Map(transcript.map((message) => [message.messageId, message] as const));
  const acceptedEntities = rawEntities
    .map((entity) => normalizeEntity(entity, transcriptById))
    .filter((entity): entity is ValidEntity => entity !== null);
  const threshold = Math.min(1, Math.max(0.5, input.confidenceThreshold ?? 0.86));
  const patch = buildPatch(input.profile, acceptedEntities, threshold);
  const requestId = response.requestId?.trim() || null;

  if (!hasPatch(patch)) {
    const hasBorderlineEvidence = acceptedEntities.some((entity) => entity.confidence < threshold);
    return {
      status: hasBorderlineEvidence ? "review_required" : "no_change",
      patch,
      acceptedEntities,
      rejectedEntityCount: rawEntities.length - acceptedEntities.length,
      model: response.model,
      requestId,
    };
  }

  if (input.dependencies.writer) {
    const patchedFields = new Set(Object.keys(patch));
    await input.dependencies.writer.applyMissingFields({
      customerId: input.profile.customerId,
      petId: input.profile.petId ?? null,
      patch,
      provenance: acceptedEntities
        .filter((entity) => entity.confidence >= threshold && patchedFields.has(entity.field))
        .map((entity) => ({
          field: entity.field,
          messageId: entity.messageId,
          quote: entity.quote,
          confidence: entity.confidence,
        })),
      model: response.model,
      requestId,
    });
  }

  return {
    status: input.dependencies.writer ? "applied" : "review_required",
    patch,
    acceptedEntities,
    rejectedEntityCount: rawEntities.length - acceptedEntities.length,
    model: response.model,
    requestId,
  };
}
