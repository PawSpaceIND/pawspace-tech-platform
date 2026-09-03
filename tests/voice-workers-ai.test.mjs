import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__VOICE_AI_DB__", "__VOICE_AI_ENV__");

const read = (p) => readFile(new URL(p, import.meta.url), "utf8");
const wai = await read("../lib/voice-workers-ai.ts");
const adapter = await read("../lib/voice-provider-adapter.ts");
const route = await read("../app/api/voice-speech/route.ts");
const voiceAdapter = await import("../lib/voice-provider-adapter.ts");

test("first-party voice runs on Cloudflare Workers AI, fail-closed on the env.AI binding", () => {
  assert.match(wai, /export function workersAiConfigured/);
  assert.match(wai, /typeof ai\.run === "function"/);
  // resolves the shared disconnected stubs when the binding is absent (no fabricated speech)
  assert.match(wai, /if \(!workersAiConfigured\(env\)\) return disconnectedStt/);
  assert.match(wai, /if \(!workersAiConfigured\(env\)\) return disconnectedTts/);
  // uses in-stack models (overridable), not an external voice vendor
  assert.match(wai, /@cf\/openai\/whisper/);
  assert.match(wai, /@cf\/myshell-ai\/melotts/);
  assert.match(wai, /ai\.run\(model,/);
  // no external voice-vendor endpoints hard-coded in the first-party engine
  assert.doesNotMatch(wai, /https?:\/\/api\.(deepgram|elevenlabs|openai|assemblyai)\./);
  // SSRF guard: caller-supplied audioRef URLs are host-allowlisted and private/link-local blocked
  assert.match(wai, /assertFetchableAudioUrl/);
  assert.match(wai, /169\\\.254\\\.|169\.254\./);
  assert.match(wai, /VOICE_AUDIO_ALLOWED_HOSTS/);
});

test("the unified selector prefers our own Workers AI engine, with self-hosted fallback", () => {
  assert.match(adapter, /export function voiceEngine/);
  assert.match(adapter, /if \(workersAiConfigured\(env\)\) return "workers_ai"/);
  assert.match(adapter, /export function selectVoiceStt/);
  assert.match(adapter, /export function selectVoiceTts/);
  assert.match(adapter, /firstParty: engine === "workers_ai"/);
});

test("the AI binding alone connects STT and TTS with the default in-stack models", async () => {
  const calls = [];
  const env = { AI: { run: async (model) => {
    calls.push(model);
    return model === "@cf/openai/whisper" ? { text: "PawSpace" } : { audio: "AAECAw==" };
  } } };
  assert.ok(!("VOICE_STT_API_KEY" in env));
  assert.ok(!("VOICE_TTS_API_KEY" in env));
  assert.deepEqual(voiceAdapter.voiceProvidersStatus(env), {
    engine: "workers_ai",
    firstParty: true,
    workersAiBindingPresent: true,
    stt: { configured: true, provider: "workers_ai", status: "connected" },
    tts: { configured: true, provider: "workers_ai", status: "connected" },
    voiceAutomationReady: true,
    note: "First-party voice on Cloudflare Workers AI - speech runs in your own stack, no external voice vendor.",
  });
  const transcript = await voiceAdapter.selectVoiceStt(env).transcribe({ audioRef: "data:audio/mpeg;base64,AAECAw==", language: "en-IN" });
  const speech = await voiceAdapter.selectVoiceTts(env).synthesize({ text: "PawSpace audio bot UAT", language: "en" });
  assert.equal(transcript.text, "PawSpace");
  assert.match(speech.audioRef, /^data:audio\/mpeg;base64,/);
  assert.deepEqual(calls, ["@cf/openai/whisper", "@cf/myshell-ai/melotts"]);
});

test("the in-app voice-speech route is fail-closed and permission-gated", () => {
  assert.match(route, /voiceEngine\(env\)==="none"/);
  assert.match(route, /requirePermission\(actor,"communications\.call"\)/);
  assert.match(route, /action==="transcribe"/);
  assert.match(route, /action==="synthesize"/);
  assert.match(route, /sameOrigin\(request\)/);
});
