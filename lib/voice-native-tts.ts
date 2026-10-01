type Env = Record<string, unknown> & { AI?: unknown };
type AiBinding = { run(model: string, input: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown> };

export type NativeCarrierTtsProvider = "elevenlabs" | "workers_ai";
export type NativeCarrierTtsResult = {
  audio: ReadableStream<Uint8Array>;
  provider: NativeCarrierTtsProvider;
  model: string;
  fallbackUsed: boolean;
};
export type NativeCarrierTtsOptions = { signal?: AbortSignal };

export const DEFAULT_ELEVENLABS_NATIVE_TTS_MODEL = "eleven_flash_v2_5";
export const DEFAULT_WORKERS_NATIVE_TTS_MODEL = "@cf/deepgram/aura-2-en";
const MAX_NATIVE_TTS_BYTES = 8 * 1024 * 1024;
const PCM_PROBE_BYTES = 128;
const ALLOWED_ELEVENLABS_BASES = new Set([
  "https://api.elevenlabs.io",
  "https://api.in.residency.elevenlabs.io",
]);

export class NativeTtsConfigurationError extends Error {}
export class NativeTtsCancelledError extends Error {}
export class NativeTtsAudioError extends Error {
  readonly code: "http_error" | "empty_audio" | "invalid_audio" | "audio_too_large";
  constructor(code: NativeTtsAudioError["code"]) { super(code); this.code = code; }
}

const text = (value: unknown) => String(value ?? "").trim();
const lower = (value: unknown) => text(value).toLowerCase();

function speechTimeoutMs(env: Env) {
  const raw = Number(env.VOICE_SPEECH_TIMEOUT_MS || 12_000);
  return Number.isFinite(raw) ? Math.max(800, Math.min(30_000, Math.round(raw))) : 12_000;
}

function workersAi(env: Env): AiBinding {
  const binding = env.AI as AiBinding | undefined;
  if (!binding || typeof binding.run !== "function") throw new Error("Workers AI TTS is unavailable");
  return binding;
}

function workersAiConfigured(env: Env) {
  const binding = env.AI as AiBinding | undefined;
  return Boolean(binding && typeof binding.run === "function");
}

function elevenLabsBase(env: Env) {
  const value = (text(env.ELEVENLABS_API_BASE) || "https://api.in.residency.elevenlabs.io").replace(/\/$/, "");
  if (!ALLOWED_ELEVENLABS_BASES.has(value)) throw new NativeTtsConfigurationError("ElevenLabs TTS API base is not approved");
  return value;
}

function pcmOutputFormat(sampleRate: number) {
  if (![8000, 16000, 24000].includes(sampleRate)) throw new NativeTtsConfigurationError("Native TTS sample rate is unsupported");
  return `pcm_${sampleRate}`;
}

function elevenLabsCredentialsPresent(env: Env) {
  return Boolean(text(env.ELEVENLABS_API_KEY) && text(env.ELEVENLABS_TTS_VOICE_ID));
}

function elevenLabsConfigured(env: Env) {
  if (!elevenLabsCredentialsPresent(env)) return false;
  try { elevenLabsBase(env); return true; } catch { return false; }
}

function requestedProvider(env: Env): NativeCarrierTtsProvider {
  const configured = lower(env.PAWSPACE_VOICE_NATIVE_TTS_PROVIDER);
  if (configured === "elevenlabs" || configured === "workers_ai") return configured;
  if (configured && configured !== "auto") throw new NativeTtsConfigurationError("Unsupported native TTS provider");
  return elevenLabsCredentialsPresent(env) ? "elevenlabs" : "workers_ai";
}

function requestedFallback(env: Env, primary: NativeCarrierTtsProvider): NativeCarrierTtsProvider | null {
  const configured = lower(env.PAWSPACE_VOICE_NATIVE_TTS_FALLBACK);
  if (configured === "none") return null;
  if (configured === "elevenlabs" || configured === "workers_ai") return configured === primary ? null : configured;
  if (configured) throw new NativeTtsConfigurationError("Unsupported native TTS fallback provider");
  return primary === "elevenlabs" && workersAiConfigured(env) ? "workers_ai" : null;
}

function throwIfCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new NativeTtsCancelledError("Native TTS generation was cancelled");
}

function concat(parts: Uint8Array[]) {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.byteLength; }
  return out;
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function bytesStream(bytes: Uint8Array) {
  return new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(bytes); controller.close(); },
  });
}

function validatedLinear16Bytes(input: Uint8Array, sampleRate: number) {
  let bytes = input;
  if (!bytes.byteLength) throw new NativeTtsAudioError("empty_audio");
  if (bytes.byteLength > MAX_NATIVE_TTS_BYTES) throw new NativeTtsAudioError("audio_too_large");
  const tag = (offset: number, length: number) => String.fromCharCode(...bytes.subarray(offset, offset + length));
  if (tag(0, 4) === "RIFF") {
    if (bytes.byteLength < 44 || tag(8, 4) !== "WAVE") throw new NativeTtsAudioError("invalid_audio");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(4, true) + 8 !== bytes.byteLength) throw new NativeTtsAudioError("invalid_audio");
    let formatValid = false, pcm: Uint8Array | null = null;
    for (let offset = 12; offset + 8 <= bytes.byteLength;) {
      const size = view.getUint32(offset + 4, true), end = offset + 8 + size;
      if (end > bytes.byteLength) throw new NativeTtsAudioError("invalid_audio");
      if (tag(offset, 4) === "fmt ") {
        if (size < 16 || view.getUint16(offset + 8, true) !== 1 || view.getUint16(offset + 10, true) !== 1 || view.getUint32(offset + 12, true) !== sampleRate || view.getUint16(offset + 22, true) !== 16 || view.getUint16(offset + 20, true) !== 2 || view.getUint32(offset + 16, true) !== sampleRate * 2) throw new NativeTtsAudioError("invalid_audio");
        formatValid = true;
      }
      if (tag(offset, 4) === "data") pcm = bytes.subarray(offset + 8, end);
      offset = end + (size % 2);
    }
    if (!formatValid || !pcm) throw new NativeTtsAudioError("invalid_audio");
    bytes = pcm;
  } else if (["OggS", "fLaC"].includes(tag(0, 4)) || tag(0, 3) === "ID3" || /^\s*<(?:!doctype|html|\?xml)\b/i.test(tag(0, Math.min(24, bytes.byteLength)))) {
    throw new NativeTtsAudioError("invalid_audio");
  }
  if (/^\s*[\[{]/.test(tag(0, Math.min(24, bytes.byteLength)))) {
    let json = false;
    try { JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); json = true; } catch {}
    if (json) throw new NativeTtsAudioError("invalid_audio");
  }
  if (!bytes.byteLength) throw new NativeTtsAudioError("empty_audio");
  if (bytes.byteLength % 2) throw new NativeTtsAudioError("invalid_audio");
  return bytes;
}

async function cancelStream(stream: ReadableStream<Uint8Array> | null | undefined) {
  try { await stream?.cancel(); } catch {}
}

async function readAll(reader: ReadableStreamDefaultReader<Uint8Array>, initial: Uint8Array[], initialSize: number, signal?: AbortSignal) {
  const parts = [...initial];
  let size = initialSize;
  while (true) {
    throwIfCancelled(signal);
    const chunk = await reader.read();
    if (chunk.done) break;
    if (!(chunk.value instanceof Uint8Array)) throw new NativeTtsAudioError("invalid_audio");
    size += chunk.value.byteLength;
    if (size > MAX_NATIVE_TTS_BYTES) { try { await reader.cancel(); } catch {} throw new NativeTtsAudioError("audio_too_large"); }
    parts.push(chunk.value);
  }
  return concat(parts);
}

function progressivePcmStream(head: Uint8Array, reader: ReadableStreamDefaultReader<Uint8Array>, initialSize: number, signal?: AbortSignal) {
  let pending = head, size = initialSize, released = false;
  const release = () => { if (!released) { released = true; try { reader.releaseLock(); } catch {} } };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        throwIfCancelled(signal);
        if (pending.byteLength >= 2) {
          const even = pending.byteLength - (pending.byteLength % 2);
          if (even) {
            controller.enqueue(pending.subarray(0, even));
            pending = pending.subarray(even);
            return;
          }
        }
        const chunk = await reader.read();
        if (chunk.done) {
          if (pending.byteLength) throw new NativeTtsAudioError("invalid_audio");
          controller.close(); release(); return;
        }
        if (!(chunk.value instanceof Uint8Array)) throw new NativeTtsAudioError("invalid_audio");
        size += chunk.value.byteLength;
        if (size > MAX_NATIVE_TTS_BYTES) throw new NativeTtsAudioError("audio_too_large");
        pending = pending.byteLength ? concat([pending, chunk.value]) : chunk.value;
      } catch (error) {
        try { await reader.cancel(); } catch {}
        release();
        controller.error(error);
      }
    },
    async cancel(reason) { try { await reader.cancel(reason); } finally { release(); } },
  });
}

async function validatePcmStream(stream: ReadableStream<Uint8Array>, sampleRate: number, signal?: AbortSignal) {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let size = 0, done = false;
  try {
    while (size < PCM_PROBE_BYTES) {
      throwIfCancelled(signal);
      const chunk = await reader.read();
      if (chunk.done) { done = true; break; }
      if (!(chunk.value instanceof Uint8Array)) throw new NativeTtsAudioError("invalid_audio");
      size += chunk.value.byteLength;
      if (size > MAX_NATIVE_TTS_BYTES) { try { await reader.cancel(); } catch {} throw new NativeTtsAudioError("audio_too_large"); }
      parts.push(chunk.value);
    }
    if (!size) throw new NativeTtsAudioError("empty_audio");
    const head = concat(parts);
    const tag = (offset: number, length: number) => String.fromCharCode(...head.subarray(offset, offset + length));
    const obviousNonPcm = ["OggS", "fLaC"].includes(tag(0, 4)) || tag(0, 3) === "ID3" || /^\s*<(?:!doctype|html|\?xml)\b/i.test(tag(0, Math.min(24, head.byteLength)));
    if (obviousNonPcm) throw new NativeTtsAudioError("invalid_audio");
    if (done || tag(0, 4) === "RIFF") {
      const all = done ? head : await readAll(reader, parts, size, signal);
      const pcm = validatedLinear16Bytes(all, sampleRate);
      try { reader.releaseLock(); } catch {}
      return bytesStream(pcm);
    }
    return progressivePcmStream(head, reader, size, signal);
  } catch (error) {
    try { await reader.cancel(); } catch {}
    try { reader.releaseLock(); } catch {}
    throw error;
  }
}

async function prepareNativePcmAudio(result: unknown, sampleRate: number, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
  throwIfCancelled(signal);
  if (result instanceof Response) {
    if (!result.ok) { await cancelStream(result.body); throw new NativeTtsAudioError("http_error"); }
    const mime = text(result.headers.get("content-type")).split(";")[0].toLowerCase();
    if (mime && !["application/octet-stream", "audio/pcm", "audio/raw", "audio/x-pcm", "audio/wav", "audio/x-wav", "audio/wave"].includes(mime)) {
      await cancelStream(result.body); throw new NativeTtsAudioError("invalid_audio");
    }
    const advertised = Number(result.headers.get("content-length"));
    if (Number.isFinite(advertised) && advertised > MAX_NATIVE_TTS_BYTES) {
      await cancelStream(result.body); throw new NativeTtsAudioError("audio_too_large");
    }
    if (!result.body) throw new NativeTtsAudioError("empty_audio");
    return validatePcmStream(result.body, sampleRate, signal);
  }
  if (result instanceof Uint8Array) return bytesStream(validatedLinear16Bytes(result, sampleRate));
  if (result instanceof ArrayBuffer) return bytesStream(validatedLinear16Bytes(new Uint8Array(result), sampleRate));
  if (result instanceof ReadableStream) return validatePcmStream(result as ReadableStream<Uint8Array>, sampleRate, signal);
  if (result && typeof result === "object") {
    const audio = (result as Record<string, unknown>).audio;
    if (typeof audio === "string" && audio.trim()) {
      try { return bytesStream(validatedLinear16Bytes(base64ToBytes(audio), sampleRate)); }
      catch (error) { if (error instanceof NativeTtsAudioError) throw error; throw new NativeTtsAudioError("invalid_audio"); }
    }
  }
  throw new NativeTtsAudioError("invalid_audio");
}

async function synthesizeElevenLabs(env: Env, output: string, sampleRate: number, signal?: AbortSignal) {
  const apiKey = text(env.ELEVENLABS_API_KEY), voiceId = text(env.ELEVENLABS_TTS_VOICE_ID);
  if (!apiKey || !voiceId) throw new Error("ElevenLabs direct TTS is not configured");
  const model = text(env.ELEVENLABS_TTS_MODEL_ID) || DEFAULT_ELEVENLABS_NATIVE_TTS_MODEL;
  elevenLabsBase(env);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (signal?.aborted) cancel(); else signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(cancel, speechTimeoutMs(env));
  try {
    const endpoint = `${elevenLabsBase(env)}/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=${pcmOutputFormat(sampleRate)}`;
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json", "xi-api-key": apiKey },
        body: JSON.stringify({ text: output, model_id: model }),
      });
    } catch {
      if (signal?.aborted) throw new NativeTtsCancelledError("Native TTS generation was cancelled");
      throw new Error(controller.signal.aborted ? "ElevenLabs direct TTS timed out" : "ElevenLabs direct TTS request failed");
    }
    const audio = await prepareNativePcmAudio(response, sampleRate, signal);
    return { audio, provider: "elevenlabs" as const, model, fallbackUsed: false };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}

async function synthesizeWorkersAi(env: Env, output: string, sampleRate: number, signal?: AbortSignal) {
  throwIfCancelled(signal);
  const model = text(env.VOICE_CARRIER_TTS_MODEL) || DEFAULT_WORKERS_NATIVE_TTS_MODEL;
  const result = await workersAi(env).run(model, {
    text: output,
    encoding: "linear16",
    container: "none",
    sample_rate: sampleRate,
    speaker: text(env.VOICE_CARRIER_TTS_SPEAKER) || "luna",
  }, { returnRawResponse: true });
  throwIfCancelled(signal);
  const audio = await prepareNativePcmAudio(result, sampleRate, signal);
  return { audio, provider: "workers_ai" as const, model, fallbackUsed: false };
}

async function synthesizeWith(provider: NativeCarrierTtsProvider, env: Env, output: string, sampleRate: number, signal?: AbortSignal) {
  return provider === "elevenlabs"
    ? synthesizeElevenLabs(env, output, sampleRate, signal)
    : synthesizeWorkersAi(env, output, sampleRate, signal);
}

export async function synthesizeNativeCarrierTts(env: Env, output: string, sampleRate: number, options: NativeCarrierTtsOptions = {}): Promise<NativeCarrierTtsResult> {
  if (!text(output)) throw new Error("Native TTS requires text");
  const primary = requestedProvider(env), fallback = requestedFallback(env, primary);
  try { return await synthesizeWith(primary, env, output, sampleRate, options.signal); }
  catch (primaryError) {
    if (primaryError instanceof NativeTtsConfigurationError || primaryError instanceof NativeTtsCancelledError || !fallback) throw primaryError;
    throwIfCancelled(options.signal);
    const result = await synthesizeWith(fallback, env, output, sampleRate, options.signal);
    return { ...result, fallbackUsed: true };
  }
}

export function nativeCarrierTtsReadiness(env: Env) {
  let primary: NativeCarrierTtsProvider, fallback: NativeCarrierTtsProvider | null;
  try {
    primary = requestedProvider(env);
    fallback = requestedFallback(env, primary);
  } catch {
    return { configured: false, primary: null, fallback: null, elevenLabsConfigured: elevenLabsConfigured(env), workersAiConfigured: workersAiConfigured(env) };
  }
  const primaryConfigured = primary === "elevenlabs" ? elevenLabsConfigured(env) : workersAiConfigured(env);
  return {
    configured: primaryConfigured,
    primary,
    fallback,
    elevenLabsConfigured: elevenLabsConfigured(env),
    workersAiConfigured: workersAiConfigured(env),
  };
}
