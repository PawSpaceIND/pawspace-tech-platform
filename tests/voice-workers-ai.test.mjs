import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const read = (p) => readFile(new URL(p, import.meta.url), "utf8");
const wai = await read("../lib/voice-workers-ai.ts");
const safeFetch = await read("../lib/voice-safe-fetch.ts");
const adapter = await read("../lib/voice-provider-adapter.ts");
const route = await read("../app/api/voice-speech/route.ts");

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
  // SSRF guard: Workers AI delegates caller-supplied audio URLs to the shared safe fetcher,
  // where private/link-local hosts (including cloud metadata ranges) are blocked.
  assert.match(wai, /assertFetchableAudioUrl/);
  assert.match(wai, /safeVoiceFetch/);
  assert.match(safeFetch, /a === 169 && b === 254/);
  assert.match(safeFetch, /169\.254\.169\.254/);
  assert.match(wai, /VOICE_AUDIO_ALLOWED_HOSTS/);
});

test("the unified selector prefers our own Workers AI engine, with self-hosted fallback", () => {
  assert.match(adapter, /export function voiceEngine/);
  assert.match(adapter, /if \(workersAiConfigured\(env\)\) return "workers_ai"/);
  assert.match(adapter, /export function selectVoiceStt/);
  assert.match(adapter, /export function selectVoiceTts/);
  assert.match(adapter, /firstParty: engine === "workers_ai"/);
});

test("the in-app voice-speech route is fail-closed and permission-gated", () => {
  assert.match(route, /voiceEngine\(env\)==="none"/);
  assert.match(route, /requirePermission\(actor,"communications\.call"\)/);
  assert.match(route, /action==="transcribe"/);
  assert.match(route, /action==="synthesize"/);
  assert.match(route, /sameOrigin\(request\)/);
});
