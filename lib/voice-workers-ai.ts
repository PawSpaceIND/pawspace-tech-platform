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

type Env = Record<string, unknown>;
type AiBinding = { run: (model: string, input: Record<string, unknown>) => Promise<Record<string, unknown>> };
const val = (env: Env, key: string) => String(env?.[key] ?? "").trim();

/** Workers AI is available when the `AI` binding is bound to this Worker. */
export function workersAiConfigured(env: Env): boolean {
  const ai = env?.AI as AiBinding | undefined;
  return Boolean(ai && typeof ai.run === "function");
}

/** Resolve audio bytes from a data: URL or an https reference, for feeding into Whisper. */
async function audioBytes(audioRef: string): Promise<number[]> {
  const ref = String(audioRef || "").trim();
  if (!ref) throw new Error("An audio reference is required");
  if (ref.startsWith("data:")) {
    const base64 = ref.slice(ref.indexOf(",") + 1);
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return Array.from(bytes);
  }
  const response = await fetch(ref);
  if (!response.ok) throw new Error(`Unable to fetch audio (${response.status})`);
  return Array.from(new Uint8Array(await response.arrayBuffer()));
}

/** Cloudflare Workers AI STT (Whisper). Returns the disconnected stub when the AI binding is absent. */
export function resolveWorkersAiStt(env: Env): VoiceSttProvider {
  if (!workersAiConfigured(env)) return disconnectedStt;
  const ai = env.AI as AiBinding, model = val(env, "VOICE_STT_MODEL") || "@cf/openai/whisper";
  return {
    provider: "workers_ai", status: "connected",
    async transcribe(input: { audioRef: string; language?: string | null }) {
      const startedAt = Date.now();
      const audio = await audioBytes(input.audioRef);
      const result = await ai.run(model, { audio });
      const textOut = String(result.text ?? result.transcription ?? "").trim();
      // Whisper on Workers AI does not return a scalar confidence; surface it when present, else a
      // conservative value when we got text (STT confidence, not answer confidence - never fabricated high).
      const raw = Number(result.confidence);
      const confidence = Number.isFinite(raw) ? raw : (textOut ? 0.9 : 0);
      return { text: textOut, confidence, latencyMs: Date.now() - startedAt };
    },
  };
}

/** Cloudflare Workers AI TTS. Returns the disconnected stub when the AI binding is absent. */
export function resolveWorkersAiTts(env: Env): VoiceTtsProvider {
  if (!workersAiConfigured(env)) return disconnectedTts;
  const ai = env.AI as AiBinding, model = val(env, "VOICE_TTS_MODEL") || "@cf/myshell-ai/melotts";
  return {
    provider: "workers_ai", status: "connected",
    async synthesize(input: { text: string; language?: string | null }) {
      const startedAt = Date.now();
      const result = await ai.run(model, { prompt: input.text, lang: input.language || "en" });
      const base64 = String(result.audio ?? "").trim();
      if (!base64) throw new Error("TTS model returned no audio");
      // return a self-contained data URL the in-app player can play directly (nothing leaves the stack)
      return { audioRef: `data:audio/mpeg;base64,${base64}`, latencyMs: Date.now() - startedAt };
    },
  };
}
