/**
 * First-party voice engine on Cloudflare Workers AI - speech-to-text and text-to-speech inside the
 * PawSpace Cloudflare stack. The default STT model is whisper-large-v3-turbo because its current
 * Workers AI schema exposes an explicit language hint; operators can still override VOICE_STT_MODEL.
 */

import { type VoiceSttProvider, type VoiceTtsProvider, disconnectedStt, disconnectedTts } from "./ai-voice-uat";
import { canonicalVoiceLocale, speechLanguageCode } from "./voice-locale";
import { assertSafeVoiceUrl, decodeInlineAudio, isInlineAudioReference, safeVoiceFetch, VoiceFetchRefused } from "./voice-safe-fetch";
import { asSpeechFailure, DEFAULT_SPEECH_TIMEOUT_MS, VoiceSpeechError, withSpeechDeadline } from "./voice-speech-failures";

type Env = Record<string, unknown>;
type AiBinding = { run: (model: string, input: Record<string, unknown>) => Promise<Record<string, unknown>> };
const val = (env: Env, key: string) => String(env?.[key] ?? "").trim();

export function speechTimeoutMs(env: Env): number {
  const configured = Number(val(env, "VOICE_SPEECH_TIMEOUT_MS"));
  return Number.isFinite(configured) && configured >= 1000 && configured <= 60_000 ? configured : DEFAULT_SPEECH_TIMEOUT_MS;
}

export function workersAiConfigured(env: Env): boolean {
  const ai = env?.AI as AiBinding | undefined;
  return Boolean(ai && typeof ai.run === "function");
}

function assertFetchableAudioUrl(ref: string, allowedHosts: string[]) {
  return assertSafeVoiceUrl(ref, { allowedHosts });
}

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

function sttSupportsLanguageHint(model:string){return /whisper-large-v3(?:-turbo)?/i.test(model);}

/** Cloudflare Workers AI STT. Bengaluru locales are canonicalised before provider routing. */
export function resolveWorkersAiStt(env: Env): VoiceSttProvider {
  if (!workersAiConfigured(env)) return disconnectedStt;
  const ai = env.AI as AiBinding, model = val(env, "VOICE_STT_MODEL") || "@cf/openai/whisper-large-v3-turbo";
  const timeoutMs = speechTimeoutMs(env);
  const allowedHosts = val(env, "VOICE_AUDIO_ALLOWED_HOSTS").split(",").map(h => h.trim().toLowerCase()).filter(Boolean);
  return {
    provider: "workers_ai", status: "connected",
    async transcribe(input: { audioRef: string; language?: string | null }) {
      const startedAt = Date.now();
      const audio = await audioBytes(input.audioRef, allowedHosts, timeoutMs);
      const locale=canonicalVoiceLocale(input.language),language=speechLanguageCode(locale);
      const request:Record<string,unknown>={audio};
      if(sttSupportsLanguageHint(model))request.language=language;
      else if(locale!=="en-IN")throw new VoiceSpeechError("stt","malformed_output",`Configured STT model ${model} cannot enforce the requested ${locale} language hint`);
      let result: Record<string, unknown>;
      try { result = await withSpeechDeadline("stt", ai.run(model, request), timeoutMs); }
      catch (error) { throw asSpeechFailure("stt", error); }
      if (!result || typeof result !== "object") throw new VoiceSpeechError("stt", "malformed_output", "STT model returned no result object");
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

/** Cloudflare Workers AI TTS. BCP-47 app locales are reduced to the provider's short lang code. */
export function resolveWorkersAiTts(env: Env): VoiceTtsProvider {
  if (!workersAiConfigured(env)) return disconnectedTts;
  const ai = env.AI as AiBinding, model = val(env, "VOICE_TTS_MODEL") || "@cf/myshell-ai/melotts";
  const timeoutMs = speechTimeoutMs(env);
  return {
    provider: "workers_ai", status: "connected",
    async synthesize(input: { text: string; language?: string | null }) {
      const startedAt = Date.now();
      if (!String(input.text ?? "").trim()) throw new VoiceSpeechError("tts", "malformed_output", "Nothing to synthesise");
      const locale=canonicalVoiceLocale(input.language),lang=speechLanguageCode(locale);
      let result: Record<string, unknown>;
      try { result = await withSpeechDeadline("tts", ai.run(model, { prompt: input.text, lang }), timeoutMs); }
      catch (error) { throw asSpeechFailure("tts", error); }
      if (!result || typeof result !== "object") throw new VoiceSpeechError("tts", "malformed_output", "TTS model returned no result object");
      if (result.audio != null && typeof result.audio !== "string") throw new VoiceSpeechError("tts", "malformed_output", `TTS model returned a ${typeof result.audio} audio field`);
      const base64 = String(result.audio ?? "").trim();
      if (!base64) throw new VoiceSpeechError("tts", "empty_output", "TTS model returned no audio");
      const audioRef = `data:audio/mpeg;base64,${base64}`;
      try { decodeInlineAudio(audioRef); }
      catch (error) { throw new VoiceSpeechError("tts", "unsafe_audio", error instanceof VoiceFetchRefused ? error.message : "TTS model returned unusable audio"); }
      return { audioRef, latencyMs: Date.now() - startedAt };
    },
  };
}
