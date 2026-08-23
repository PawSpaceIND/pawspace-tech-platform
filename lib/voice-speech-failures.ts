/**
 * Classified failures for the speech stack, plus the deadline every provider call runs under.
 *
 * Both STT and TTS previously failed as bare `Error`s - or not at all. `resolveVoiceStt` posted to a
 * configured URL with no timeout, so a vendor that accepted the connection and never answered held the
 * request open; and a response body of the wrong shape produced `undefined` treated as a transcript.
 * A caller that has to string-match an error message cannot route a failure to the right call state,
 * which is why every failure here carries a stable code.
 */

export type VoiceSpeechFailureCode =
  | "not_connected"      // no provider is wired at all
  | "timeout"            // the provider did not answer inside the deadline
  | "provider_failure"   // the provider answered with an error
  | "malformed_output"   // the provider answered with something that is not a transcript/audio result
  | "empty_output"       // the provider answered successfully with nothing usable
  | "unsafe_audio";      // the returned audio reference failed the SSRF / media-type guard

export class VoiceSpeechError extends Error {
  readonly code: VoiceSpeechFailureCode;
  readonly stage: "stt" | "tts";
  constructor(stage: "stt" | "tts", code: VoiceSpeechFailureCode, message: string) {
    super(message);
    this.name = "VoiceSpeechError";
    this.code = code;
    this.stage = stage;
  }
}

export const DEFAULT_SPEECH_TIMEOUT_MS = 12_000;

/**
 * Bounds any provider promise. Losing the race does not cancel the underlying work - a Workers AI
 * binding call has no abort - but it does stop the request hanging on it, which is the failure mode
 * that matters to a caller on a live call.
 */
export async function withSpeechDeadline<T>(stage: "stt" | "tts", promise: Promise<T>, timeoutMs = DEFAULT_SPEECH_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new VoiceSpeechError(stage, "timeout", `${stage.toUpperCase()} provider did not respond within ${timeoutMs}ms`)), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

/** Wraps whatever a provider threw into a classified failure, preserving an already-classified one. */
export function asSpeechFailure(stage: "stt" | "tts", error: unknown): VoiceSpeechError {
  if (error instanceof VoiceSpeechError) return error;
  const message = String((error as Error)?.message || error || "unknown error").slice(0, 200);
  return new VoiceSpeechError(stage, "provider_failure", message);
}
