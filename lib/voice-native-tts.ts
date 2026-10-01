type Env = Record<string, unknown> & { AI?: unknown };
type AiBinding = { run(model: string, input: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown> };

export type NativeCarrierTtsProvider = "elevenlabs" | "workers_ai";
export type NativeCarrierTtsResult = {
  result: unknown;
  provider: NativeCarrierTtsProvider;
  model: string;
  fallbackUsed: boolean;
};

export const DEFAULT_ELEVENLABS_NATIVE_TTS_MODEL = "eleven_flash_v2_5";
export const DEFAULT_WORKERS_NATIVE_TTS_MODEL = "@cf/deepgram/aura-2-en";
const ALLOWED_ELEVENLABS_BASES = new Set([
  "https://api.elevenlabs.io",
  "https://api.in.residency.elevenlabs.io",
]);

class NativeTtsConfigurationError extends Error {}

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

function elevenLabsBase(env: Env) {
  const value = (text(env.ELEVENLABS_API_BASE) || "https://api.in.residency.elevenlabs.io").replace(/\/$/, "");
  if (!ALLOWED_ELEVENLABS_BASES.has(value)) throw new NativeTtsConfigurationError("ElevenLabs TTS API base is not approved");
  return value;
}

function pcmOutputFormat(sampleRate: number) {
  if (![8000, 16000, 24000].includes(sampleRate)) throw new NativeTtsConfigurationError("Native TTS sample rate is unsupported");
  return `pcm_${sampleRate}`;
}

function elevenLabsConfigured(env: Env) {
  return Boolean(text(env.ELEVENLABS_API_KEY) && text(env.ELEVENLABS_TTS_VOICE_ID));
}

function requestedProvider(env: Env): NativeCarrierTtsProvider {
  const configured = lower(env.PAWSPACE_VOICE_NATIVE_TTS_PROVIDER);
  if (configured === "elevenlabs" || configured === "workers_ai") return configured;
  if (configured && configured !== "auto") throw new NativeTtsConfigurationError("Unsupported native TTS provider");
  return elevenLabsConfigured(env) ? "elevenlabs" : "workers_ai";
}

function requestedFallback(env: Env, primary: NativeCarrierTtsProvider): NativeCarrierTtsProvider | null {
  const configured = lower(env.PAWSPACE_VOICE_NATIVE_TTS_FALLBACK);
  if (configured === "none") return null;
  if (configured === "elevenlabs" || configured === "workers_ai") return configured === primary ? null : configured;
  if (configured) throw new NativeTtsConfigurationError("Unsupported native TTS fallback provider");
  return primary === "elevenlabs" && env.AI ? "workers_ai" : null;
}

async function synthesizeElevenLabs(env: Env, output: string, sampleRate: number): Promise<NativeCarrierTtsResult> {
  const apiKey = text(env.ELEVENLABS_API_KEY), voiceId = text(env.ELEVENLABS_TTS_VOICE_ID);
  if (!apiKey || !voiceId) throw new Error("ElevenLabs direct TTS is not configured");
  const model = text(env.ELEVENLABS_TTS_MODEL_ID) || DEFAULT_ELEVENLABS_NATIVE_TTS_MODEL;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), speechTimeoutMs(env));
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
      throw new Error(controller.signal.aborted ? "ElevenLabs direct TTS timed out" : "ElevenLabs direct TTS request failed");
    }
    if (!response.ok) {
      try { await response.body?.cancel(); } catch {}
      throw new Error(`ElevenLabs direct TTS rejected the request (${response.status})`);
    }
    const contentType = text(response.headers.get("content-type")).split(";")[0].toLowerCase();
    if (contentType && !["audio/pcm", "audio/raw", "audio/x-pcm", "application/octet-stream"].includes(contentType)) {
      try { await response.body?.cancel(); } catch {}
      throw new Error("ElevenLabs direct TTS returned an unexpected audio type");
    }
    const advertised = Number(response.headers.get("content-length"));
    if (Number.isFinite(advertised) && advertised > 8 * 1024 * 1024) throw new Error("ElevenLabs direct TTS audio exceeded the size limit");
    let audio: Uint8Array;
    try { audio = new Uint8Array(await response.arrayBuffer()); }
    catch { throw new Error(controller.signal.aborted ? "ElevenLabs direct TTS timed out" : "ElevenLabs direct TTS audio read failed"); }
    if (!audio.byteLength || audio.byteLength > 8 * 1024 * 1024) throw new Error("ElevenLabs direct TTS returned invalid audio size");
    return { result: audio, provider: "elevenlabs", model, fallbackUsed: false };
  } finally { clearTimeout(timer); }
}

async function synthesizeWorkersAi(env: Env, output: string, sampleRate: number): Promise<NativeCarrierTtsResult> {
  const model = text(env.VOICE_CARRIER_TTS_MODEL) || DEFAULT_WORKERS_NATIVE_TTS_MODEL;
  const result = await workersAi(env).run(model, {
    text: output,
    encoding: "linear16",
    container: "none",
    sample_rate: sampleRate,
    speaker: text(env.VOICE_CARRIER_TTS_SPEAKER) || "luna",
  }, { returnRawResponse: true });
  return { result, provider: "workers_ai", model, fallbackUsed: false };
}

async function synthesizeWith(provider: NativeCarrierTtsProvider, env: Env, output: string, sampleRate: number) {
  return provider === "elevenlabs"
    ? synthesizeElevenLabs(env, output, sampleRate)
    : synthesizeWorkersAi(env, output, sampleRate);
}

export async function synthesizeNativeCarrierTts(env: Env, output: string, sampleRate: number): Promise<NativeCarrierTtsResult> {
  if (!text(output)) throw new Error("Native TTS requires text");
  const primary = requestedProvider(env), fallback = requestedFallback(env, primary);
  try { return await synthesizeWith(primary, env, output, sampleRate); }
  catch (primaryError) {
    if (primaryError instanceof NativeTtsConfigurationError || !fallback) throw primaryError;
    const result = await synthesizeWith(fallback, env, output, sampleRate);
    return { ...result, fallbackUsed: true };
  }
}

export function nativeCarrierTtsReadiness(env: Env) {
  let primary: NativeCarrierTtsProvider, fallback: NativeCarrierTtsProvider | null;
  try {
    primary = requestedProvider(env);
    fallback = requestedFallback(env, primary);
  } catch {
    return { configured: false, primary: null, fallback: null, elevenLabsConfigured: elevenLabsConfigured(env), workersAiConfigured: Boolean(env.AI) };
  }
  const primaryConfigured = primary === "elevenlabs" ? elevenLabsConfigured(env) : Boolean(env.AI);
  return {
    configured: primaryConfigured,
    primary,
    fallback,
    elevenLabsConfigured: elevenLabsConfigured(env),
    workersAiConfigured: Boolean(env.AI),
  };
}
