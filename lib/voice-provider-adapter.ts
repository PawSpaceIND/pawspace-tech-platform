/**
 * Fail-closed voice-provider adapters (speech-to-text + text-to-speech). These implement the exact
 * VoiceSttProvider / VoiceTtsProvider interfaces the AI voice harness (lib/ai-voice-uat.ts) already
 * consumes, so a real speech engine becomes pluggable the moment its keys are configured - and stays
 * safely disconnected until then.
 */

import { type VoiceSttProvider, type VoiceTtsProvider, disconnectedStt, disconnectedTts } from "./ai-voice-uat";
import { workersAiConfigured, resolveWorkersAiStt, resolveWorkersAiTts, speechTimeoutMs } from "./voice-workers-ai";
import { canonicalVoiceLocale, speechLanguageCode } from "./voice-locale";
import { assertSafeVoiceUrl, isInlineAudioReference, decodeInlineAudio, VoiceFetchRefused } from "./voice-safe-fetch";
import { asSpeechFailure, VoiceSpeechError } from "./voice-speech-failures";

type Env = Record<string, unknown>;
const val = (env: Env, key: string) => String(env?.[key] ?? "").trim();
const audioAllowedHosts = (env: Env) => val(env, "VOICE_AUDIO_ALLOWED_HOSTS").split(",").map(host => host.trim().toLowerCase()).filter(Boolean);

async function speechPost(stage: "stt" | "tts", url: string, key: string, payload: unknown, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    let raw: string;
    try {
      response = await fetch(url, { method: "POST", signal: controller.signal, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(payload) });
      raw = await response.text();
    } catch (error) {
      if (controller.signal.aborted) throw new VoiceSpeechError(stage, "timeout", `${stage.toUpperCase()} provider did not respond within ${timeoutMs}ms`);
      throw asSpeechFailure(stage, error);
    }
    if (!response.ok) throw new VoiceSpeechError(stage, "provider_failure", `${stage.toUpperCase()} provider request failed (${response.status})`);
    let body: unknown;
    try { body = JSON.parse(raw); } catch { throw new VoiceSpeechError(stage, "malformed_output", `${stage.toUpperCase()} provider returned a non-JSON body`); }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new VoiceSpeechError(stage, "malformed_output", `${stage.toUpperCase()} provider returned ${Array.isArray(body) ? "an array" : typeof body}, not a result object`);
    return body as Record<string, unknown>;
  } finally { clearTimeout(timer); }
}

export function sttConfigured(env: Env): boolean { return Boolean(val(env, "VOICE_STT_API_KEY") && val(env, "VOICE_STT_URL")); }
export function ttsConfigured(env: Env): boolean { return Boolean(val(env, "VOICE_TTS_API_KEY") && val(env, "VOICE_TTS_URL")); }

export function voiceEngine(env: Env): "workers_ai" | "http_endpoint" | "none" {
  const override = val(env, "VOICE_ENGINE").toLowerCase();
  if (override === "http_endpoint") return sttConfigured(env) || ttsConfigured(env) ? "http_endpoint" : "none";
  if (workersAiConfigured(env)) return "workers_ai";
  if (sttConfigured(env) || ttsConfigured(env)) return "http_endpoint";
  return "none";
}

export function selectVoiceStt(env: Env): VoiceSttProvider {
  return voiceEngine(env) === "workers_ai" ? resolveWorkersAiStt(env) : resolveVoiceStt(env);
}
export function selectVoiceTts(env: Env): VoiceTtsProvider {
  return voiceEngine(env) === "workers_ai" ? resolveWorkersAiTts(env) : resolveVoiceTts(env);
}

function assertUsableAudioReference(stage: "stt" | "tts", reference: unknown, allowedHosts: string[]) {
  const ref = String(reference ?? "").trim();
  if (!ref) throw new VoiceSpeechError(stage, "malformed_output", "An audio reference is required");
  try {
    if (isInlineAudioReference(ref)) { decodeInlineAudio(ref); return ref; }
    assertSafeVoiceUrl(ref, { allowedHosts });
    return ref;
  } catch (error) {
    throw new VoiceSpeechError(stage, "unsafe_audio", error instanceof VoiceFetchRefused ? error.message : "Unusable audio reference");
  }
}

export function resolveVoiceStt(env: Env): VoiceSttProvider {
  const key = val(env, "VOICE_STT_API_KEY"), url = val(env, "VOICE_STT_URL");
  if (!key || !url) return disconnectedStt;
  const provider = val(env, "VOICE_STT_PROVIDER") || "voice_stt";
  const timeoutMs = speechTimeoutMs(env), allowedHosts = audioAllowedHosts(env);
  return {
    provider, status: "connected",
    async transcribe(input: { audioRef: string; language?: string | null }) {
      const startedAt = Date.now();
      assertUsableAudioReference("stt", input.audioRef, allowedHosts);
      const locale=canonicalVoiceLocale(input.language),language=speechLanguageCode(locale);
      const body = await speechPost("stt", url, key, { audioRef: input.audioRef, locale, language }, timeoutMs);
      const field = body.text ?? body.transcript;
      if (field == null) throw new VoiceSpeechError("stt", "malformed_output", "STT provider returned no transcript field");
      if (typeof field !== "string") throw new VoiceSpeechError("stt", "malformed_output", `STT provider returned a ${typeof field} transcript`);
      const textOut = field.trim();
      const confidence = Number(body.confidence);
      return { text: textOut, confidence: Number.isFinite(confidence) ? confidence : 0, latencyMs: Date.now() - startedAt, empty: textOut.length === 0 };
    },
  };
}

export function resolveVoiceTts(env: Env): VoiceTtsProvider {
  const key = val(env, "VOICE_TTS_API_KEY"), url = val(env, "VOICE_TTS_URL");
  if (!key || !url) return disconnectedTts;
  const provider = val(env, "VOICE_TTS_PROVIDER") || "voice_tts";
  const timeoutMs = speechTimeoutMs(env), allowedHosts = audioAllowedHosts(env);
  return {
    provider, status: "connected",
    async synthesize(input: { text: string; language?: string | null }) {
      const startedAt = Date.now();
      if (!String(input.text ?? "").trim()) throw new VoiceSpeechError("tts", "malformed_output", "Nothing to synthesise");
      const locale=canonicalVoiceLocale(input.language),language=speechLanguageCode(locale);
      const body = await speechPost("tts", url, key, { text: input.text, locale, language }, timeoutMs);
      const raw = body.audioRef ?? body.audioUrl ?? body.url;
      if (raw != null && typeof raw !== "string") throw new VoiceSpeechError("tts", "malformed_output", `TTS provider returned a ${typeof raw} audio reference`);
      const audioRef = String(raw ?? "").trim();
      if (!audioRef) throw new VoiceSpeechError("tts", "empty_output", "TTS provider returned no audio reference");
      assertUsableAudioReference("tts", audioRef, allowedHosts);
      return { audioRef, latencyMs: Date.now() - startedAt };
    },
  };
}

export function voiceProvidersStatus(env: Env) {
  const engine = voiceEngine(env), workersAi = workersAiConfigured(env);
  const sttReady = engine === "workers_ai" ? true : sttConfigured(env);
  const ttsReady = engine === "workers_ai" ? true : ttsConfigured(env);
  const providerName = engine === "workers_ai" ? "workers_ai" : null;
  return {
    engine,
    firstParty: engine === "workers_ai",
    workersAiBindingPresent: workersAi,
    supportedLocales:["en-IN","hi-IN","kn-IN"],
    stt: { configured: sttReady, provider: engine === "workers_ai" ? providerName : (sttConfigured(env) ? (val(env, "VOICE_STT_PROVIDER") || "voice_stt") : null), status: sttReady ? "connected" : "not_connected" },
    tts: { configured: ttsReady, provider: engine === "workers_ai" ? providerName : (ttsConfigured(env) ? (val(env, "VOICE_TTS_PROVIDER") || "voice_tts") : null), status: ttsReady ? "connected" : "not_connected" },
    voiceAutomationReady: sttReady && ttsReady,
    note: engine === "workers_ai" ? "First-party voice on Cloudflare Workers AI - speech runs in your own stack, no external voice vendor." : "No first-party engine active; bind Cloudflare Workers AI (env.AI) or configure a self-hosted STT/TTS endpoint.",
  };
}
