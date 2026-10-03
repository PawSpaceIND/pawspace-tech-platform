type Env = Record<string, unknown> & { AI?: unknown };
type AiBinding = { run(model: string, input: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown> };

export type NativeCarrierTtsProvider = "elevenlabs" | "workers_ai";
export type NativeCarrierTtsOptions = { signal?: AbortSignal };
export type NativeCarrierTtsAudioErrorCode = "http_error" | "empty_audio" | "invalid_audio" | "audio_too_large";
export type NativeCarrierTtsResult = {
  result: ReadableStream<Uint8Array>;
  provider: NativeCarrierTtsProvider;
  model: string;
  fallbackUsed: boolean;
};

export class NativeCarrierTtsAudioError extends Error {
  readonly code: NativeCarrierTtsAudioErrorCode;
  constructor(code: NativeCarrierTtsAudioErrorCode) { super(code); this.code = code; this.name = "NativeCarrierTtsAudioError"; }
}
export class NativeCarrierTtsCancelledError extends Error {
  constructor() { super("Native TTS generation was cancelled"); this.name = "NativeCarrierTtsCancelledError"; }
}
class NativeTtsConfigurationError extends Error {}
class NativeTtsTimeoutError extends Error {}

export const DEFAULT_ELEVENLABS_NATIVE_TTS_MODEL = "eleven_flash_v2_5";
export const DEFAULT_WORKERS_NATIVE_TTS_MODEL = "@cf/deepgram/aura-2-en";
const MAX_NATIVE_AUDIO_BYTES = 8 * 1024 * 1024;
// Hold one full Exotel-minimum carrier chunk before exposing provider audio. Failures before the first
// audible frame remain eligible for provider fallback without sacrificing progressive playback after it.
const NATIVE_TTS_PREFLIGHT_BYTES = 3_200;
const RAW_AUDIO_TYPES = new Set(["application/octet-stream", "audio/pcm", "audio/raw", "audio/x-pcm"]);
const WAV_AUDIO_TYPES = new Set(["audio/wav", "audio/x-wav", "audio/wave"]);
const ALLOWED_ELEVENLABS_BASES = new Set([
  "https://api.elevenlabs.io",
  "https://api.in.residency.elevenlabs.io",
]);

const text = (value: unknown) => String(value ?? "").trim();
const lower = (value: unknown) => text(value).toLowerCase();
const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0; for (const part of parts) { out.set(part, offset); offset += part.byteLength; } return out;
};

function speechTimeoutMs(env: Env) {
  const raw = Number(env.VOICE_SPEECH_TIMEOUT_MS || 12_000);
  return Number.isFinite(raw) ? Math.max(800, Math.min(30_000, Math.round(raw))) : 12_000;
}
function throwIfAborted(signal?: AbortSignal) { if (signal?.aborted) throw new NativeCarrierTtsCancelledError(); }
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
function elevenLabsCredentialsConfigured(env: Env) {
  return Boolean(text(env.ELEVENLABS_API_KEY) && text(env.ELEVENLABS_TTS_VOICE_ID));
}
function elevenLabsConfigured(env: Env) {
  if (!elevenLabsCredentialsConfigured(env)) return false;
  try { elevenLabsBase(env); return true; } catch { return false; }
}
function requestedProvider(env: Env): NativeCarrierTtsProvider {
  const configured = lower(env.PAWSPACE_VOICE_NATIVE_TTS_PROVIDER);
  if (configured === "elevenlabs" || configured === "workers_ai") return configured;
  if (configured && configured !== "auto") throw new NativeTtsConfigurationError("Unsupported native TTS provider");
  if (elevenLabsCredentialsConfigured(env)) { elevenLabsBase(env); return "elevenlabs"; }
  return "workers_ai";
}
function providerConfigured(provider: NativeCarrierTtsProvider, env: Env) {
  return provider === "elevenlabs" ? elevenLabsConfigured(env) : workersAiConfigured(env);
}
function requestedFallback(env: Env, primary: NativeCarrierTtsProvider): NativeCarrierTtsProvider | null {
  const configured = lower(env.PAWSPACE_VOICE_NATIVE_TTS_FALLBACK);
  if (configured === "none") return null;
  if (configured === "elevenlabs" || configured === "workers_ai") {
    if (configured === primary) return null;
    return providerConfigured(configured, env) ? configured : null;
  }
  if (configured) throw new NativeTtsConfigurationError("Unsupported native TTS fallback provider");
  return primary === "elevenlabs" && workersAiConfigured(env) ? "workers_ai" : null;
}

function base64ToBytes(value: string) {
  const binary = atob(value), out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
function tag(bytes: Uint8Array, offset: number, length: number) {
  return String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.byteLength, offset + length)));
}
function rejectsObviousNonPcm(bytes: Uint8Array) {
  const prefix = tag(bytes, 0, Math.min(48, bytes.byteLength));
  if (["RIFF", "OggS", "fLaC"].includes(tag(bytes, 0, 4)) || tag(bytes, 0, 3) === "ID3") return true;
  if (/^\s*<(?:!doctype|html|\?xml)\b/i.test(prefix)) return true;
  if (/^\s*[\[{]/.test(prefix)) {
    try { JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); return true; } catch {}
  }
  return false;
}
function validatedLinear16(bytes: Uint8Array, sampleRate: number): Uint8Array {
  if (!bytes.byteLength) throw new NativeCarrierTtsAudioError("empty_audio");
  if (bytes.byteLength > MAX_NATIVE_AUDIO_BYTES) throw new NativeCarrierTtsAudioError("audio_too_large");
  if (tag(bytes, 0, 4) === "RIFF") {
    if (bytes.byteLength < 44 || tag(bytes, 8, 4) !== "WAVE") throw new NativeCarrierTtsAudioError("invalid_audio");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(4, true) + 8 !== bytes.byteLength) throw new NativeCarrierTtsAudioError("invalid_audio");
    let formatValid = false, pcm: Uint8Array | null = null;
    for (let offset = 12; offset + 8 <= bytes.byteLength;) {
      const size = view.getUint32(offset + 4, true), end = offset + 8 + size;
      if (end > bytes.byteLength) throw new NativeCarrierTtsAudioError("invalid_audio");
      if (tag(bytes, offset, 4) === "fmt ") {
        if (size < 16 || view.getUint16(offset + 8, true) !== 1 || view.getUint16(offset + 10, true) !== 1 ||
          view.getUint32(offset + 12, true) !== sampleRate || view.getUint16(offset + 22, true) !== 16 ||
          view.getUint16(offset + 20, true) !== 2 || view.getUint32(offset + 16, true) !== sampleRate * 2) {
          throw new NativeCarrierTtsAudioError("invalid_audio");
        }
        formatValid = true;
      }
      if (tag(bytes, offset, 4) === "data") pcm = bytes.subarray(offset + 8, end);
      offset = end + (size % 2);
    }
    if (!formatValid || !pcm) throw new NativeCarrierTtsAudioError("invalid_audio");
    bytes = pcm;
  } else if (rejectsObviousNonPcm(bytes)) throw new NativeCarrierTtsAudioError("invalid_audio");
  if (!bytes.byteLength) throw new NativeCarrierTtsAudioError("empty_audio");
  if (bytes.byteLength % 2) throw new NativeCarrierTtsAudioError("invalid_audio");
  return bytes;
}
async function readWithAbort(reader: ReadableStreamDefaultReader<Uint8Array>, signal?: AbortSignal) {
  throwIfAborted(signal);
  if (!signal) return reader.read();
  return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    const abort = () => {
      reject(signal.reason instanceof NativeTtsTimeoutError ? signal.reason : new NativeCarrierTtsCancelledError());
      void reader.cancel().catch(() => undefined);
    };
    signal.addEventListener("abort", abort, { once: true });
    reader.read().then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}
async function collectStream(stream: ReadableStream<Uint8Array>, signal?: AbortSignal) {
  const reader = stream.getReader(), parts: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      throwIfAborted(signal);
      const next = await readWithAbort(reader, signal); if (next.done) break;
      if (!(next.value instanceof Uint8Array)) throw new NativeCarrierTtsAudioError("invalid_audio");
      size += next.value.byteLength;
      if (size > MAX_NATIVE_AUDIO_BYTES) { await reader.cancel(); throw new NativeCarrierTtsAudioError("audio_too_large"); }
      parts.push(next.value);
    }
  } finally { reader.releaseLock(); }
  return concat(parts);
}
async function bufferedProviderPcm(result: unknown, sampleRate: number, signal?: AbortSignal) {
  throwIfAborted(signal);
  let bytes: Uint8Array;
  if (result instanceof Response) {
    if (!result.ok) { try { await result.body?.cancel(); } catch {} throw new NativeCarrierTtsAudioError("http_error"); }
    const mime = text(result.headers.get("content-type")).split(";")[0].toLowerCase();
    if (mime && !RAW_AUDIO_TYPES.has(mime) && !WAV_AUDIO_TYPES.has(mime)) {
      try { await result.body?.cancel(); } catch {} throw new NativeCarrierTtsAudioError("invalid_audio");
    }
    const advertised = Number(result.headers.get("content-length"));
    if (Number.isFinite(advertised) && advertised > MAX_NATIVE_AUDIO_BYTES) {
      try { await result.body?.cancel(); } catch {} throw new NativeCarrierTtsAudioError("audio_too_large");
    }
    bytes = result.body ? await collectStream(result.body, signal) : new Uint8Array();
  } else if (result instanceof Uint8Array) bytes = result;
  else if (result instanceof ArrayBuffer) bytes = new Uint8Array(result);
  else if (result instanceof ReadableStream) bytes = await collectStream(result, signal);
  else if (result && typeof result === "object" && typeof (result as Record<string, unknown>).audio === "string") {
    try { bytes = base64ToBytes(String((result as Record<string, unknown>).audio)); }
    catch { throw new NativeCarrierTtsAudioError("invalid_audio"); }
  } else throw new NativeCarrierTtsAudioError("invalid_audio");
  throwIfAborted(signal);
  return validatedLinear16(bytes, sampleRate);
}
function streamFromBytes(bytes: Uint8Array) {
  return new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
}

async function synthesizeElevenLabs(env: Env, output: string, sampleRate: number, options: NativeCarrierTtsOptions): Promise<NativeCarrierTtsResult> {
  const apiKey = text(env.ELEVENLABS_API_KEY), voiceId = text(env.ELEVENLABS_TTS_VOICE_ID);
  if (!apiKey || !voiceId) throw new Error("ElevenLabs direct TTS is not configured");
  throwIfAborted(options.signal);
  const model = text(env.ELEVENLABS_TTS_MODEL_ID) || DEFAULT_ELEVENLABS_NATIVE_TTS_MODEL;
  const base = elevenLabsBase(env), outputFormat = pcmOutputFormat(sampleRate);
  const controller = new AbortController();
  const externalAbort = () => controller.abort(new NativeCarrierTtsCancelledError());
  if (options.signal?.aborted) throw new NativeCarrierTtsCancelledError();
  options.signal?.addEventListener("abort", externalAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new NativeTtsTimeoutError("ElevenLabs direct TTS timed out")), speechTimeoutMs(env));
  (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
  const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", externalAbort); };
  let response: Response;
  try {
    response = await fetch(`${base}/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=${outputFormat}`, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json", "xi-api-key": apiKey },
      body: JSON.stringify({ text: output, model_id: model }),
    });
  } catch {
    cleanup();
    if (options.signal?.aborted) throw new NativeCarrierTtsCancelledError();
    throw new Error(controller.signal.aborted ? "ElevenLabs direct TTS timed out" : "ElevenLabs direct TTS request failed");
  }
  if (!response.ok) {
    try { await response.body?.cancel(); } catch {} cleanup();
    throw new NativeCarrierTtsAudioError("http_error");
  }
  const contentType = text(response.headers.get("content-type")).split(";")[0].toLowerCase();
  if (contentType && !RAW_AUDIO_TYPES.has(contentType)) {
    try { await response.body?.cancel(); } catch {} cleanup();
    throw new NativeCarrierTtsAudioError("invalid_audio");
  }
  const advertised = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertised) && advertised > MAX_NATIVE_AUDIO_BYTES) {
    try { await response.body?.cancel(); } catch {} cleanup();
    throw new NativeCarrierTtsAudioError("audio_too_large");
  }
  if (!response.body) { cleanup(); throw new NativeCarrierTtsAudioError("empty_audio"); }

  const reader = response.body.getReader(), primed: Uint8Array[] = []; let primedBytes = 0, ended = false;
  try {
    while (primedBytes < NATIVE_TTS_PREFLIGHT_BYTES) {
      throwIfAborted(options.signal);
      const next = await readWithAbort(reader, controller.signal);
      if (next.done) { ended = true; break; }
      if (!(next.value instanceof Uint8Array)) throw new NativeCarrierTtsAudioError("invalid_audio");
      primed.push(next.value); primedBytes += next.value.byteLength;
      if (primedBytes > MAX_NATIVE_AUDIO_BYTES) throw new NativeCarrierTtsAudioError("audio_too_large");
    }
    const preview = concat(primed);
    if (!preview.byteLength) throw new NativeCarrierTtsAudioError("empty_audio");
    if (rejectsObviousNonPcm(preview)) throw new NativeCarrierTtsAudioError("invalid_audio");
    if (ended) validatedLinear16(preview, sampleRate);
  } catch (error) {
    try { await reader.cancel(); } catch {} reader.releaseLock(); cleanup();
    if (options.signal?.aborted) throw new NativeCarrierTtsCancelledError();
    throw error;
  }

  let buffered = concat(primed), total = buffered.byteLength, done = ended;
  const result = new ReadableStream<Uint8Array>({
    async pull(out) {
      try {
        throwIfAborted(options.signal);
        while (!done && buffered.byteLength < 2) {
          const next = await readWithAbort(reader, controller.signal);
          if (next.done) { done = true; break; }
          if (!(next.value instanceof Uint8Array)) throw new NativeCarrierTtsAudioError("invalid_audio");
          total += next.value.byteLength;
          if (total > MAX_NATIVE_AUDIO_BYTES) throw new NativeCarrierTtsAudioError("audio_too_large");
          buffered = concat([buffered, next.value]);
        }
        if (buffered.byteLength >= 2) {
          const even = buffered.byteLength - (buffered.byteLength % 2);
          out.enqueue(buffered.subarray(0, even));
          buffered = buffered.subarray(even);
          return;
        }
        if (done) {
          if (buffered.byteLength) throw new NativeCarrierTtsAudioError("invalid_audio");
          reader.releaseLock(); cleanup(); out.close();
        }
      } catch (error) {
        try { await reader.cancel(); } catch {} try { reader.releaseLock(); } catch {} cleanup();
        out.error(options.signal?.aborted ? new NativeCarrierTtsCancelledError() : error);
      }
    },
    async cancel() {
      controller.abort();
      try { await reader.cancel(); } catch {} try { reader.releaseLock(); } catch {} cleanup();
    },
  });
  return { result, provider: "elevenlabs", model, fallbackUsed: false };
}

async function synthesizeWorkersAi(env: Env, output: string, sampleRate: number, options: NativeCarrierTtsOptions): Promise<NativeCarrierTtsResult> {
  throwIfAborted(options.signal);
  const model = text(env.VOICE_CARRIER_TTS_MODEL) || DEFAULT_WORKERS_NATIVE_TTS_MODEL;
  const raw = await workersAi(env).run(model, {
    text: output,
    encoding: "linear16",
    container: "none",
    sample_rate: sampleRate,
    speaker: text(env.VOICE_CARRIER_TTS_SPEAKER) || "luna",
  }, { returnRawResponse: true });
  const audio = await bufferedProviderPcm(raw, sampleRate, options.signal);
  return { result: streamFromBytes(audio), provider: "workers_ai", model, fallbackUsed: false };
}
async function synthesizeWith(provider: NativeCarrierTtsProvider, env: Env, output: string, sampleRate: number, options: NativeCarrierTtsOptions) {
  return provider === "elevenlabs"
    ? synthesizeElevenLabs(env, output, sampleRate, options)
    : synthesizeWorkersAi(env, output, sampleRate, options);
}

export async function synthesizeNativeCarrierTts(env: Env, output: string, sampleRate: number, options: NativeCarrierTtsOptions = {}): Promise<NativeCarrierTtsResult> {
  if (!text(output)) throw new Error("Native TTS requires text");
  throwIfAborted(options.signal);
  const primary = requestedProvider(env), fallback = requestedFallback(env, primary);
  try { return await synthesizeWith(primary, env, output, sampleRate, options); }
  catch (primaryError) {
    if (primaryError instanceof NativeTtsConfigurationError || primaryError instanceof NativeCarrierTtsCancelledError || !fallback) throw primaryError;
    throwIfAborted(options.signal);
    const result = await synthesizeWith(fallback, env, output, sampleRate, options);
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
