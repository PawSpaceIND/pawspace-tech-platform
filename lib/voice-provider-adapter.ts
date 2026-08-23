/**
 * Fail-closed voice-provider adapters (speech-to-text + text-to-speech). These implement the exact
 * VoiceSttProvider / VoiceTtsProvider interfaces the AI voice harness (lib/ai-voice-uat.ts) already
 * consumes, so a real speech engine becomes pluggable the moment its keys are configured - and stays
 * safely disconnected until then.
 *
 * Gating (per environment, isolated staging first):
 *   STT -> VOICE_STT_API_KEY + VOICE_STT_URL
 *   TTS -> VOICE_TTS_API_KEY + VOICE_TTS_URL
 * With either half of a pair missing, resolve* returns the shared `disconnectedStt`/`disconnectedTts`
 * stubs (status "not_connected", throws if actually invoked) - so nothing pretends to transcribe or
 * synthesise audio until a human wires real credentials in a non-production environment first.
 */

import { type VoiceSttProvider, type VoiceTtsProvider, disconnectedStt, disconnectedTts } from "./ai-voice-uat";
import { workersAiConfigured, resolveWorkersAiStt, resolveWorkersAiTts, speechTimeoutMs } from "./voice-workers-ai";
import { assertSafeVoiceUrl, isInlineAudioReference, decodeInlineAudio, VoiceFetchRefused } from "./voice-safe-fetch";
import { asSpeechFailure, VoiceSpeechError } from "./voice-speech-failures";

type Env = Record<string, unknown>;
const val = (env: Env, key: string) => String(env?.[key] ?? "").trim();
const audioAllowedHosts = (env: Env) => val(env, "VOICE_AUDIO_ALLOWED_HOSTS").split(",").map(host => host.trim().toLowerCase()).filter(Boolean);

/**
 * One bounded POST to a self-hosted speech endpoint. Previously this was a bare fetch(): no timeout, so
 * an endpoint that accepted the connection and never answered held the request open for the life of the
 * isolate, and any JSON shape at all was accepted as a result.
 */
async function speechPost(stage: "stt" | "tts", url: string, key: string, payload: unknown, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, { method: "POST", signal: controller.signal, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(payload) });
  } catch (error) {
    if (controller.signal.aborted) throw new VoiceSpeechError(stage, "timeout", `${stage.toUpperCase()} provider did not respond within ${timeoutMs}ms`);
    throw asSpeechFailure(stage, error);
  } finally { clearTimeout(timer); }
  if (!response.ok) throw new VoiceSpeechError(stage, "provider_failure", `${stage.toUpperCase()} provider request failed (${response.status})`);
  const raw = await response.text();
  let body: unknown;
  try { body = JSON.parse(raw); } catch { throw new VoiceSpeechError(stage, "malformed_output", `${stage.toUpperCase()} provider returned a non-JSON body`); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new VoiceSpeechError(stage, "malformed_output", `${stage.toUpperCase()} provider returned ${Array.isArray(body) ? "an array" : typeof body}, not a result object`);
  return body as Record<string, unknown>;
}

export function sttConfigured(env: Env): boolean { return Boolean(val(env, "VOICE_STT_API_KEY") && val(env, "VOICE_STT_URL")); }
export function ttsConfigured(env: Env): boolean { return Boolean(val(env, "VOICE_TTS_API_KEY") && val(env, "VOICE_TTS_URL")); }

/** Which speech engine is active: our own Cloudflare Workers AI (preferred, first-party), a self-hosted
 * HTTP endpoint, or none. Workers AI wins when its binding is present unless explicitly overridden. */
export function voiceEngine(env: Env): "workers_ai" | "http_endpoint" | "none" {
  const override = val(env, "VOICE_ENGINE").toLowerCase();
  if (override === "http_endpoint") return sttConfigured(env) || ttsConfigured(env) ? "http_endpoint" : "none";
  if (workersAiConfigured(env)) return "workers_ai";
  if (sttConfigured(env) || ttsConfigured(env)) return "http_endpoint";
  return "none";
}

/** Resolve the active STT provider across engines (Workers AI first-party, else HTTP, else disconnected). */
export function selectVoiceStt(env: Env): VoiceSttProvider {
  return voiceEngine(env) === "workers_ai" ? resolveWorkersAiStt(env) : resolveVoiceStt(env);
}
/** Resolve the active TTS provider across engines (Workers AI first-party, else HTTP, else disconnected). */
export function selectVoiceTts(env: Env): VoiceTtsProvider {
  return voiceEngine(env) === "workers_ai" ? resolveWorkersAiTts(env) : resolveVoiceTts(env);
}

/**
 * An audio reference is usable only if it is inline audio we can decode, or an https URL that passes the
 * shared SSRF guard. Applied on the way IN (a caller's audioRef) and on the way OUT (a provider's).
 */
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

/** Resolve a live STT provider if configured, else the fail-closed disconnected stub. */
export function resolveVoiceStt(env: Env): VoiceSttProvider {
  const key = val(env, "VOICE_STT_API_KEY"), url = val(env, "VOICE_STT_URL");
  if (!key || !url) return disconnectedStt;
  const provider = val(env, "VOICE_STT_PROVIDER") || "voice_stt";
  const timeoutMs = speechTimeoutMs(env), allowedHosts = audioAllowedHosts(env);
  return {
    provider, status: "connected",
    async transcribe(input: { audioRef: string; language?: string | null }) {
      const startedAt = Date.now();
      // The audioRef reaches this route from a caller (POST /api/voice-speech). Validate it against the
      // same SSRF guard the first-party engine uses BEFORE handing it to a provider - a self-hosted
      // endpoint told to fetch http://169.254.169.254/ is the same attack one hop further out.
      assertUsableAudioReference("stt", input.audioRef, allowedHosts);
      const body = await speechPost("stt", url, key, { audioRef: input.audioRef, language: input.language || null }, timeoutMs);
      const field = body.text ?? body.transcript;
      if (field == null) throw new VoiceSpeechError("stt", "malformed_output", "STT provider returned no transcript field");
      if (typeof field !== "string") throw new VoiceSpeechError("stt", "malformed_output", `STT provider returned a ${typeof field} transcript`);
      const textOut = field.trim();
      const confidence = Number(body.confidence);
      return { text: textOut, confidence: Number.isFinite(confidence) ? confidence : 0, latencyMs: Date.now() - startedAt, empty: textOut.length === 0 };
    },
  };
}

/** Resolve a live TTS provider if configured, else the fail-closed disconnected stub. */
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
      const body = await speechPost("tts", url, key, { text: input.text, language: input.language || null }, timeoutMs);
      const raw = body.audioRef ?? body.audioUrl ?? body.url;
      if (raw != null && typeof raw !== "string") throw new VoiceSpeechError("tts", "malformed_output", `TTS provider returned a ${typeof raw} audio reference`);
      const audioRef = String(raw ?? "").trim();
      if (!audioRef) throw new VoiceSpeechError("tts", "empty_output", "TTS provider returned no audio reference");
      // A provider is not trusted to hand back a safe reference: an audioRef pointing at loopback or a
      // metadata endpoint would be played, forwarded or re-fetched downstream.
      assertUsableAudioReference("tts", audioRef, allowedHosts);
      return { audioRef, latencyMs: Date.now() - startedAt };
    },
  };
}

/** Readiness summary for the ops/integrations dashboard - never returns the keys themselves. */
export function voiceProvidersStatus(env: Env) {
  const engine = voiceEngine(env), workersAi = workersAiConfigured(env);
  // Under Workers AI (our own stack), one binding powers both STT and TTS - so both are ready together.
  const sttReady = engine === "workers_ai" ? true : sttConfigured(env);
  const ttsReady = engine === "workers_ai" ? true : ttsConfigured(env);
  const providerName = engine === "workers_ai" ? "workers_ai" : null;
  return {
    engine,
    firstParty: engine === "workers_ai",
    workersAiBindingPresent: workersAi,
    stt: { configured: sttReady, provider: engine === "workers_ai" ? providerName : (sttConfigured(env) ? (val(env, "VOICE_STT_PROVIDER") || "voice_stt") : null), status: sttReady ? "connected" : "not_connected" },
    tts: { configured: ttsReady, provider: engine === "workers_ai" ? providerName : (ttsConfigured(env) ? (val(env, "VOICE_TTS_PROVIDER") || "voice_tts") : null), status: ttsReady ? "connected" : "not_connected" },
    voiceAutomationReady: sttReady && ttsReady,
    note: engine === "workers_ai" ? "First-party voice on Cloudflare Workers AI - speech runs in your own stack, no external voice vendor." : "No first-party engine active; bind Cloudflare Workers AI (env.AI) or configure a self-hosted STT/TTS endpoint.",
  };
}
