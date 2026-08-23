/**
 * First-party voice engine on Cloudflare Workers AI - speech-to-text (Whisper) and text-to-speech,
 * running inside PawSpace's own Cloudflare stack. No external voice vendor: the audio is converted by
 * models on the `env.AI` binding, data stays in-stack.
 *
 * These implement the same VoiceSttProvider / VoiceTtsProvider interfaces the AI voice harness already
 * consumes (lib/ai-voice-uat.ts), so the rest of the bot - orchestrator, knowledge, guardrails, staff-
 * first rollout - is unchanged. Fail-closed: if the `env.AI` binding isn't present, resolve* returns the
 * shared disconnected stubs and nothing pretends to transcribe or synthesise.
 *
 * Channel note: this is the in-app voice path (device mic/speaker carry the audio - zero telecom). The
 * transport stays pluggable (VoiceTransportProvider), so real phone calls can be added later by wiring a
 * carrier for the LINE only, with this speech engine and the whole brain untouched.
 */

import { type VoiceSttProvider, type VoiceTtsProvider, disconnectedStt, disconnectedTts } from "./ai-voice-uat";
import { assertSafeVoiceUrl, decodeInlineAudio, isInlineAudioReference, safeVoiceFetch, VoiceFetchRefused } from "./voice-safe-fetch";
import { asSpeechFailure, DEFAULT_SPEECH_TIMEOUT_MS, VoiceSpeechError, withSpeechDeadline } from "./voice-speech-failures";

type Env = Record<string, unknown>;
type AiBinding = { run: (model: string, input: Record<string, unknown>) => Promise<Record<string, unknown>> };
const val = (env: Env, key: string) => String(env?.[key] ?? "").trim();

/** One deadline for both halves of the speech stack, overridable per deployment. */
export function speechTimeoutMs(env: Env): number {
  const configured = Number(val(env, "VOICE_SPEECH_TIMEOUT_MS"));
  return Number.isFinite(configured) && configured >= 1000 && configured <= 60_000 ? configured : DEFAULT_SPEECH_TIMEOUT_MS;
}

/** Workers AI is available when the `AI` binding is bound to this Worker. */
export function workersAiConfigured(env: Env): boolean {
  const ai = env?.AI as AiBinding | undefined;
  return Boolean(ai && typeof ai.run === "function");
}

/**
 * SSRF guard for caller-supplied audio references.
 *
 * The rules now live in lib/voice-safe-fetch.ts and are shared with every other voice path, because the
 * version that lived here covered only this one. It matched private ranges as string prefixes (so
 * "10." also rejected the public 100.x, and 172.16/12 was the only correctly-bounded range), and it
 * then called plain fetch() - which follows redirects, so an allowlisted host answering
 * 302 -> http://169.254.169.254/ walked straight past it. There was also no timeout, no size bound and
 * no media-type check.
 *
 * Kept as a named function because it is the guard this module's contract is about: an https audio
 * reference is fetched only when its host is on VOICE_AUDIO_ALLOWED_HOSTS and is not loopback,
 * RFC1918, link-local, carrier-NAT, an internal suffix or a cloud metadata endpoint (169.254.169.254 /
 * IMDS and friends) - at the original URL and at every redirect hop.
 */
function assertFetchableAudioUrl(ref: string, allowedHosts: string[]) {
  return assertSafeVoiceUrl(ref, { allowedHosts });
}

/** Resolve audio bytes from an inline data: URL or an allowlisted https reference, for Whisper. */
async function audioBytes(audioRef: string, allowedHosts: string[] = [], timeoutMs?: number): Promise<number[]> {
  const ref = String(audioRef || "").trim();
  if (!ref) throw new VoiceSpeechError("stt", "malformed_output", "An audio reference is required");
  try {
    if (isInlineAudioReference(ref)) return Array.from(decodeInlineAudio(ref).bytes);
    assertFetchableAudioUrl(ref, allowedHosts);
    const fetched = await safeVoiceFetch(ref, { allowedHosts, ...(timeoutMs ? { timeoutMs } : {}) });
    return Array.from(fetched.bytes);
  } catch (error) {
    if (error instanceof VoiceFetchRefused) throw new VoiceSpeechError("stt", error.code === "timeout" ? "timeout" : "unsafe_audio", error.message);
    throw error;
  }
}

/** Cloudflare Workers AI STT (Whisper). Returns the disconnected stub when the AI binding is absent. */
export function resolveWorkersAiStt(env: Env): VoiceSttProvider {
  if (!workersAiConfigured(env)) return disconnectedStt;
  const ai = env.AI as AiBinding, model = val(env, "VOICE_STT_MODEL") || "@cf/openai/whisper";
  const timeoutMs = speechTimeoutMs(env);
  const allowedHosts = val(env, "VOICE_AUDIO_ALLOWED_HOSTS").split(",").map(h => h.trim().toLowerCase()).filter(Boolean);
  return {
    provider: "workers_ai", status: "connected",
    async transcribe(input: { audioRef: string; language?: string | null }) {
      const startedAt = Date.now();
      const audio = await audioBytes(input.audioRef, allowedHosts, timeoutMs);
      let result: Record<string, unknown>;
      try { result = await withSpeechDeadline("stt", ai.run(model, { audio }), timeoutMs); }
      catch (error) { throw asSpeechFailure("stt", error); }
      // A result with no transcript FIELD is a broken contract; a transcript field that is empty is a
      // legitimate answer about silence. Conflating them either hides a broken model or turns a quiet
      // caller into an error, so they are separated.
      if (!result || typeof result !== "object") throw new VoiceSpeechError("stt", "malformed_output", "STT model returned no result object");
      const field = result.text ?? result.transcription;
      if (field == null) throw new VoiceSpeechError("stt", "malformed_output", "STT model returned no transcript field");
      if (typeof field !== "string") throw new VoiceSpeechError("stt", "malformed_output", `STT model returned a ${typeof field} transcript`);
      const textOut = field.trim();
      // Whisper on Workers AI does not return a scalar confidence; surface it when present, else a
      // conservative value when we got text (STT confidence, not answer confidence - never fabricated high).
      const raw = Number(result.confidence);
      const confidence = Number.isFinite(raw) ? raw : (textOut ? 0.9 : 0);
      return { text: textOut, confidence, latencyMs: Date.now() - startedAt, empty: textOut.length === 0 };
    },
  };
}

/** Cloudflare Workers AI TTS. Returns the disconnected stub when the AI binding is absent. */
export function resolveWorkersAiTts(env: Env): VoiceTtsProvider {
  if (!workersAiConfigured(env)) return disconnectedTts;
  const ai = env.AI as AiBinding, model = val(env, "VOICE_TTS_MODEL") || "@cf/myshell-ai/melotts";
  const timeoutMs = speechTimeoutMs(env);
  return {
    provider: "workers_ai", status: "connected",
    async synthesize(input: { text: string; language?: string | null }) {
      const startedAt = Date.now();
      if (!String(input.text ?? "").trim()) throw new VoiceSpeechError("tts", "malformed_output", "Nothing to synthesise");
      let result: Record<string, unknown>;
      try { result = await withSpeechDeadline("tts", ai.run(model, { prompt: input.text, lang: input.language || "en" }), timeoutMs); }
      catch (error) { throw asSpeechFailure("tts", error); }
      if (!result || typeof result !== "object") throw new VoiceSpeechError("tts", "malformed_output", "TTS model returned no result object");
      if (result.audio != null && typeof result.audio !== "string") throw new VoiceSpeechError("tts", "malformed_output", `TTS model returned a ${typeof result.audio} audio field`);
      const base64 = String(result.audio ?? "").trim();
      if (!base64) throw new VoiceSpeechError("tts", "empty_output", "TTS model returned no audio");
      // A self-contained data URL the in-app player can play directly (nothing leaves the stack), and
      // it is decoded once here so a model returning something that is not base64 audio is caught now
      // rather than handed onward as a playable reference.
      const audioRef = `data:audio/mpeg;base64,${base64}`;
      try { decodeInlineAudio(audioRef); }
      catch (error) { throw new VoiceSpeechError("tts", "unsafe_audio", error instanceof VoiceFetchRefused ? error.message : "TTS model returned unusable audio"); }
      return { audioRef, latencyMs: Date.now() - startedAt };
    },
  };
}
