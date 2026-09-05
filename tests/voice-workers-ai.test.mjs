import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const read = (p) => readFile(new URL(p, import.meta.url), "utf8");
const wai = await read("../lib/voice-workers-ai.ts");
const adapter = await read("../lib/voice-provider-adapter.ts");
const route = await read("../app/api/voice-speech/route.ts");
const safeFetch = await read("../lib/voice-safe-fetch.ts");

test("first-party voice runs on Cloudflare Workers AI, fail-closed on the env.AI binding", () => {
  assert.match(wai, /export function workersAiConfigured/);
  assert.match(wai, /typeof ai\.run === "function"/);
  assert.match(wai, /if \(!workersAiConfigured\(env\)\) return disconnectedStt/);
  assert.match(wai, /if \(!workersAiConfigured\(env\)\) return disconnectedTts/);
  assert.match(wai, /@cf\/openai\/whisper/);
  assert.match(wai, /@cf\/myshell-ai\/melotts/);
  assert.match(wai, /ai\.run\(model,/);
  assert.doesNotMatch(wai, /https?:\/\/api\.(deepgram|elevenlabs|openai|assemblyai)\./);
  // The Workers AI path delegates URL safety to the shared guard; assert the delegation here and the
  // link-local/metadata rule where it actually lives rather than pinning an implementation detail.
  assert.match(wai, /assertSafeVoiceUrl/);
  assert.match(wai, /VOICE_AUDIO_ALLOWED_HOSTS/);
  assert.match(safeFetch, /169\.254/);
});

test("Workers AI TTS normalizes both JSON and binary response shapes", () => {
  assert.match(wai, /workersAiTtsBase64/);
  assert.match(wai, /result instanceof Response/);
  assert.match(wai, /result instanceof ReadableStream/);
  assert.match(wai, /result instanceof ArrayBuffer/);
  assert.match(wai, /ArrayBuffer\.isView\(result\)/);
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
