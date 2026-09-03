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
type AiBinding = { run: (model: string, input: Record<string, unknown>) => Promise<unknown> };
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

/** SSRF guard for caller-supplied audio references. */
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

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    const slice = bytes.subarray(offset, Math.min(offset + chunk, bytes.length));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

/**
 * MeloTTS has two valid Workers AI response shapes: JSON containing a base64 `audio` field and raw
 * `audio/mpeg` binary. Normalize both into the in-app data URL contract.
 */
async function workersAiTtsBase64(result: unknown): Promise<string> {
  if (result && typeof result === "object" && !ArrayBuffer.isView(result) && !(result instanceof ArrayBuffer) && !(result instanceof ReadableStream) && !(result instanceof Response)) {
    const audio = (result as Record<string, unknown>).audio;
    if (audio != null && typeof audio !== "string") throw new VoiceSpeechError("tts", "malformed_output", `TTS model returned a ${typeof audio} audio field`);
    if (typeof audio === "string" && audio.trim()) return audio.trim();
  }

  let bytes: Uint8Array | null = null;
  if (result instanceof Response) bytes = new Uint8Array(await result.arrayBuffer());
  else if (result instanceof ReadableStream) bytes = new Uint8Array(await new Response(result).arrayBuffer());
  else if (result instanceof ArrayBuffer) bytes = new Uint8Array(result);
  else if (ArrayBuffer.isView(result)) bytes = new Uint8Array(result.buffer, result.byteOffset, result.byteLength);

  if (!bytes || bytes.byteLength === 0) throw new VoiceSpeechError("tts", "empty_output", "TTS model returned no audio");
  return bytesToBase64(bytes);
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
      let rawResult: unknown;
      try { rawResult = await withSpeechDeadline("stt", ai.run(model, { audio }), timeoutMs); }
      catch (error) { throw asSpeechFailure("stt", error); }
      if (!rawResult || typeof rawResult !== "object" || Array.isArray(rawResult)) throw new VoiceSpeechError("stt", "malformed_output", "STT model returned no result object");
      const result = rawResult as Record<string, unknown>;
      const field = result.text ?? result.transcription;
      if (field == null) throw new VoiceSpeechError("stt", "malformed_output", "STT model returned no transcript field");
      if (typeof field !== "string") throw new VoiceSpeechError("stt", "malformed_output", `STT model returned a ${typeof field} transcript`);
      const textOut = field.trim();
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
      let result: unknown;
      try { result = await withSpeechDeadline("tts", ai.run(model, { prompt: input.text, lang: input.language || "en" }), timeoutMs); }
      catch (error) { throw asSpeechFailure("tts", error); }
      const base64 = await workersAiTtsBase64(result);
      const audioRef = `data:audio/mpeg;base64,${base64}`;
      try { decodeInlineAudio(audioRef); }
      catch (error) { throw new VoiceSpeechError("tts", "unsafe_audio", error instanceof VoiceFetchRefused ? error.message : "TTS model returned unusable audio"); }
      return { audioRef, latencyMs: Date.now() - startedAt };
    },
  };
}
