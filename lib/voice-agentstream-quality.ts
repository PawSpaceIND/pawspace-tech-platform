export type CarrierSttLanguage = "auto" | "en" | "hi" | "kn";

const LANGUAGE_ALIASES: Readonly<Record<string, CarrierSttLanguage>> = Object.freeze({
  "": "auto",
  auto: "auto",
  multilingual: "auto",
  en: "en",
  "en-in": "en",
  english: "en",
  hi: "hi",
  "hi-in": "hi",
  hindi: "hi",
  kn: "kn",
  "kn-in": "kn",
  kannada: "kn",
});

const boundedInt = (value: unknown) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.min(Math.round(number), 60_000);
};

const safeLanguage = (value: unknown): string | null => {
  const language = String(value ?? "").trim().toLowerCase();
  return /^[a-z]{2,3}(?:-[a-z]{2,3})?$/.test(language) ? language : null;
};

const safeModelRef = (value: unknown) => {
  const ref = String(value ?? "").trim().slice(0, 160);
  return /^[A-Za-z0-9@/._:-]+$/.test(ref) ? ref : "configured";
};
const safeTtsProvider = (value: unknown) => {
  const provider = String(value ?? "").trim().toLowerCase();
  return provider === "elevenlabs" || provider === "workers_ai" ? provider : "configured";
};

export function resolveCarrierSttLanguage(value: unknown): CarrierSttLanguage {
  const normalized = String(value ?? "").trim().toLowerCase();
  const language = LANGUAGE_ALIASES[normalized];
  if (!language) throw new Error("Unsupported AgentStream STT language");
  return language;
}

export function whisperInputLanguage(language: CarrierSttLanguage): string | undefined {
  return language === "auto" ? undefined : language;
}

export function carrierAudioMs(pcmBytes: unknown, sampleRate: unknown) {
  const bytes = Number(pcmBytes), rate = Number(sampleRate);
  if (!Number.isFinite(bytes) || bytes < 0 || !Number.isFinite(rate) || rate <= 0) return 0;
  return Math.round((bytes / 2 / rate) * 1000);
}

export function nativeVoiceTurnDiagnostics(input: {
  configuredSttLanguage: CarrierSttLanguage;
  detectedSttLanguage?: unknown;
  sampleRate: unknown;
  pcmBytes: unknown;
  sttMs: unknown;
  llmMs: unknown;
  ttsMs: unknown;
  firstAudioMs?: unknown;
  totalMs: unknown;
  latencyTargetMs: unknown;
  transcriptChars: unknown;
  assistantChars: unknown;
  sttModel: unknown;
  ttsModel: unknown;
  ttsProvider?: unknown;
  ttsFallbackUsed?: unknown;
  outcome: unknown;
}) {
  const totalMs = boundedInt(input.totalMs), target = boundedInt(input.latencyTargetMs), firstAudioMs = boundedInt(input.firstAudioMs);
  return Object.freeze({
    configuredSttLanguage: input.configuredSttLanguage,
    detectedSttLanguage: safeLanguage(input.detectedSttLanguage),
    ttsLanguage: "en",
    sampleRate: boundedInt(input.sampleRate),
    audioMs: boundedInt(carrierAudioMs(input.pcmBytes, input.sampleRate)),
    sttMs: boundedInt(input.sttMs),
    llmMs: boundedInt(input.llmMs),
    ttsMs: boundedInt(input.ttsMs),
    firstAudioMs,
    firstAudioTargetMet: target > 0 && firstAudioMs > 0 && firstAudioMs <= target,
    totalMs,
    latencyTargetMs: target,
    targetMet: target > 0 && totalMs <= target,
    transcriptChars: boundedInt(input.transcriptChars),
    assistantChars: boundedInt(input.assistantChars),
    sttModel: safeModelRef(input.sttModel),
    ttsModel: safeModelRef(input.ttsModel),
    ttsProvider: safeTtsProvider(input.ttsProvider),
    ttsFallbackUsed: input.ttsFallbackUsed === true,
    outcome: String(input.outcome ?? "").trim().slice(0, 80),
  });
}
