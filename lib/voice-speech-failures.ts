/**
 * Classified failures for the speech stack, plus the deadline every provider call runs under.
 */

export type VoiceSpeechFailureCode =
  | "not_connected"
  | "timeout"
  | "provider_failure"
  | "malformed_output"
  | "empty_output"
  | "unsafe_audio";

export class VoiceSpeechError extends Error {
  readonly code: VoiceSpeechFailureCode;
  readonly stage: "stt" | "tts";
  readonly providerCode: string | null;
  constructor(stage: "stt" | "tts", code: VoiceSpeechFailureCode, message: string, providerCode: string | null = null) {
    super(message);
    this.name = "VoiceSpeechError";
    this.code = code;
    this.stage = stage;
    this.providerCode = providerCode;
  }
}

export const DEFAULT_SPEECH_TIMEOUT_MS = 12_000;

export async function withSpeechDeadline<T>(stage: "stt" | "tts", promise: Promise<T>, timeoutMs = DEFAULT_SPEECH_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new VoiceSpeechError(stage, "timeout", `${stage.toUpperCase()} provider did not respond within ${timeoutMs}ms`)), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

function safeProviderCode(error: unknown, message: string) {
  const raw=(error&&typeof error==="object"?(error as Record<string,unknown>).code:null);
  if(typeof raw==="number"&&Number.isFinite(raw))return String(raw);
  if(typeof raw==="string"&&/^[A-Za-z0-9_.:-]{1,48}$/.test(raw))return raw;
  const match=message.match(/(?:code|error)\s*[:#]?\s*([0-9]{3,6})/i);
  return match?.[1]||null;
}

/** Wraps whatever a provider threw into a classified failure, preserving an already-classified one. */
export function asSpeechFailure(stage: "stt" | "tts", error: unknown): VoiceSpeechError {
  if (error instanceof VoiceSpeechError) return error;
  const message = String((error as Error)?.message || error || "unknown error").slice(0, 200);
  return new VoiceSpeechError(stage, "provider_failure", message, safeProviderCode(error,message));
}
