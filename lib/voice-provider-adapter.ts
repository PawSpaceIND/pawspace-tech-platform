/**
 * Fail-closed voice-provider adapters (speech-to-text + text-to-speech). These implement the exact
 * VoiceSttProvider / VoiceTtsProvider interfaces the AI voice harness (lib/ai-voice-uat.ts) already
 * consumes, so a real speech engine becomes pluggable the moment its keys are configured - and stays
 * safely disconnected until then.
 *
 * Gating (per environment, isolated staging first):
 *   STT -> VOICE_STT_API_KEY + VOICE_STT_URL
 *   TTS -> VOICE_TTS_API_KEY + VOICE_TTS_URL
 * With either half of a pair missing, resolve* returns the shared `disconnectedStt`/`disconnectedTts`
 * stubs (status "not_connected", throws if actually invoked) - so nothing pretends to transcribe or
 * synthesise audio until a human wires real credentials in a non-production environment first.
 */

import { type VoiceSttProvider, type VoiceTtsProvider, disconnectedStt, disconnectedTts } from "./ai-voice-uat";

type Env = Record<string, unknown>;
const val = (env: Env, key: string) => String(env?.[key] ?? "").trim();

export function sttConfigured(env: Env): boolean { return Boolean(val(env, "VOICE_STT_API_KEY") && val(env, "VOICE_STT_URL")); }
export function ttsConfigured(env: Env): boolean { return Boolean(val(env, "VOICE_TTS_API_KEY") && val(env, "VOICE_TTS_URL")); }

/** Resolve a live STT provider if configured, else the fail-closed disconnected stub. */
export function resolveVoiceStt(env: Env): VoiceSttProvider {
  const key = val(env, "VOICE_STT_API_KEY"), url = val(env, "VOICE_STT_URL");
  if (!key || !url) return disconnectedStt;
  const provider = val(env, "VOICE_STT_PROVIDER") || "voice_stt";
  return {
    provider, status: "connected",
    async transcribe(input: { audioRef: string; language?: string | null }) {
      const startedAt = Date.now();
      const response = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ audioRef: input.audioRef, language: input.language || null }) });
      if (!response.ok) throw new Error(`STT provider request failed (${response.status})`);
      const body = await response.json().catch(() => ({})) as Record<string, unknown>;
      const textOut = String(body.text ?? body.transcript ?? "").trim();
      const confidence = Number(body.confidence);
      return { text: textOut, confidence: Number.isFinite(confidence) ? confidence : 0, latencyMs: Date.now() - startedAt };
    },
  };
}

/** Resolve a live TTS provider if configured, else the fail-closed disconnected stub. */
export function resolveVoiceTts(env: Env): VoiceTtsProvider {
  const key = val(env, "VOICE_TTS_API_KEY"), url = val(env, "VOICE_TTS_URL");
  if (!key || !url) return disconnectedTts;
  const provider = val(env, "VOICE_TTS_PROVIDER") || "voice_tts";
  return {
    provider, status: "connected",
    async synthesize(input: { text: string; language?: string | null }) {
      const startedAt = Date.now();
      const response = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ text: input.text, language: input.language || null }) });
      if (!response.ok) throw new Error(`TTS provider request failed (${response.status})`);
      const body = await response.json().catch(() => ({})) as Record<string, unknown>;
      const audioRef = String(body.audioRef ?? body.audioUrl ?? body.url ?? "").trim();
      if (!audioRef) throw new Error("TTS provider returned no audio reference");
      return { audioRef, latencyMs: Date.now() - startedAt };
    },
  };
}

/** Readiness summary for the ops/integrations dashboard - never returns the keys themselves. */
export function voiceProvidersStatus(env: Env) {
  const stt = sttConfigured(env), tts = ttsConfigured(env);
  return {
    stt: { configured: stt, provider: stt ? (val(env, "VOICE_STT_PROVIDER") || "voice_stt") : null, status: stt ? "connected" : "not_connected" },
    tts: { configured: tts, provider: tts ? (val(env, "VOICE_TTS_PROVIDER") || "voice_tts") : null, status: tts ? "connected" : "not_connected" },
    voiceAutomationReady: stt && tts,
    note: "Speech providers are wired in isolated staging first; both STT and TTS must be connected for end-to-end voice automation.",
  };
}
