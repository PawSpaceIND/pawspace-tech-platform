/**
 * First-party voice engine on Cloudflare Workers AI - speech-to-text (Whisper) and text-to-speech,
 * running inside PawSpace's own Cloudflare stack. No external voice vendor: the audio is converted by
 * models on the `env.AI` binding, data stays in-stack.
 */

import { type VoiceSttProvider, type VoiceTtsProvider, disconnectedStt, disconnectedTts } from "./ai-voice-uat";
import { assertSafeVoiceUrl, decodeInlineAudio, isInlineAudioReference, safeVoiceFetch, VoiceFetchRefused } from "./voice-safe-fetch";
import { asSpeechFailure, DEFAULT_SPEECH_TIMEOUT_MS, VoiceSpeechError, withSpeechDeadline } from "./voice-speech-failures";

type Env = Record<string, unknown>;
type AiBinding = { run: (model: string, input: Record<string, unknown>, options?: Record<string, unknown>) => Promise<unknown> };
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

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    const slice = bytes.subarray(offset, Math.min(offset + chunk, bytes.length));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function sttPayload(model:string,audio:number[],language?:string|null):Record<string,unknown>{
  if(model.includes("whisper-large-v3-turbo")){
    const payload:Record<string,unknown>={audio:bytesToBase64(Uint8Array.from(audio))};
    if(language)payload.language=language;
    return payload;
  }
  return{audio};
}

async function normalizeSttResult(raw:unknown):Promise<Record<string,unknown>>{
  if(raw instanceof Response){
    if(!raw.ok)throw new VoiceSpeechError("stt","provider_failure",`STT provider returned HTTP ${raw.status}`,String(raw.status));
    const parsed=await raw.json().catch(()=>null);
    if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))throw new VoiceSpeechError("stt","malformed_output","STT raw response was not a JSON object");
    return parsed as Record<string,unknown>;
  }
  if(!raw||typeof raw!=="object"||Array.isArray(raw))throw new VoiceSpeechError("stt","malformed_output","STT model returned no result object");
  return raw as Record<string,unknown>;
}

function audioFieldFromObject(value:unknown):string|null{
  if(!value||typeof value!=="object"||Array.isArray(value))return null;
  const audio=(value as Record<string,unknown>).audio;
  if(audio==null)return null;
  if(typeof audio!=="string")throw new VoiceSpeechError("tts","malformed_output",`TTS model returned a ${typeof audio} audio field`);
  return audio.trim()||null;
}

async function workersAiTtsBase64(result: unknown): Promise<string> {
  const objectAudio=audioFieldFromObject(result);
  if(objectAudio)return objectAudio;
  let bytes: Uint8Array | null = null;
  if (result instanceof Response) {
    if (!result.ok) throw new VoiceSpeechError("tts", "provider_failure", `TTS provider returned HTTP ${result.status}`,String(result.status));
    const contentType=String(result.headers.get("content-type")||"").toLowerCase();
    if(contentType.includes("application/json")){
      const parsed=await result.json().catch(()=>null);
      const audio=audioFieldFromObject(parsed);
      if(!audio)throw new VoiceSpeechError("tts","malformed_output","TTS JSON response contained no audio field");
      return audio;
    }
    bytes = new Uint8Array(await result.arrayBuffer());
  } else if (result instanceof ReadableStream) bytes = new Uint8Array(await new Response(result).arrayBuffer());
  else if (result instanceof ArrayBuffer) bytes = new Uint8Array(result);
  else if (ArrayBuffer.isView(result)) bytes = new Uint8Array(result.buffer, result.byteOffset, result.byteLength);
  if (!bytes || bytes.byteLength === 0) throw new VoiceSpeechError("tts", "empty_output", "TTS model returned no audio");
  return bytesToBase64(bytes);
}

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
      try {
        rawResult = await withSpeechDeadline(
          "stt",
          ai.run(model, sttPayload(model,audio,input.language), { returnRawResponse: true }),
          timeoutMs,
        );
      } catch (error) { throw asSpeechFailure("stt", error); }
      const result=await normalizeSttResult(rawResult);
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
      try {
        result = await withSpeechDeadline(
          "tts",
          ai.run(model, { prompt: input.text, lang: input.language || "en" }, { returnRawResponse: true }),
          timeoutMs,
        );
      } catch (error) { throw asSpeechFailure("tts", error); }
      const base64 = await workersAiTtsBase64(result);
      const audioRef = `data:audio/mpeg;base64,${base64}`;
      try { decodeInlineAudio(audioRef); }
      catch (error) { throw new VoiceSpeechError("tts", "unsafe_audio", error instanceof VoiceFetchRefused ? error.message : "TTS model returned unusable audio"); }
      return { audioRef, latencyMs: Date.now() - startedAt };
    },
  };
}
