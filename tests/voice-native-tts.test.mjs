import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_ELEVENLABS_NATIVE_TTS_MODEL,
  nativeCarrierTtsReadiness,
  synthesizeNativeCarrierTts,
} from "../lib/voice-native-tts.ts";

const pcm = new Uint8Array([1, 0, 2, 0, 3, 0, 4, 0]);

test("native TTS auto mode uses ElevenLabs only as direct speech generation", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(pcm, { status: 200, headers: { "content-type": "audio/pcm" } });
  };
  const result = await synthesizeNativeCarrierTts({
    ELEVENLABS_API_KEY: "test-key",
    ELEVENLABS_TTS_VOICE_ID: "voice-premium",
    ELEVENLABS_API_BASE: "https://api.in.residency.elevenlabs.io",
  }, "Welcome to PawSpace.", 8000);
  assert.equal(result.provider, "elevenlabs");
  assert.equal(result.model, DEFAULT_ELEVENLABS_NATIVE_TTS_MODEL);
  assert.equal(result.fallbackUsed, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.in.residency.elevenlabs.io/v1/text-to-speech/voice-premium/stream?output_format=pcm_8000");
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body, { text: "Welcome to PawSpace.", model_id: DEFAULT_ELEVENLABS_NATIVE_TTS_MODEL });
  assert.equal(calls[0].init.headers["xi-api-key"], "test-key");
});

test("native TTS stays on Workers AI when direct ElevenLabs TTS is not configured", async () => {
  const calls = [];
  const env = {
    AI: { run: async (model, input, options) => { calls.push({ model, input, options }); return pcm; } },
  };
  const result = await synthesizeNativeCarrierTts(env, "How can I help?", 16000);
  assert.equal(result.provider, "workers_ai");
  assert.equal(result.fallbackUsed, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.encoding, "linear16");
  assert.equal(calls[0].input.sample_rate, 16000);
  assert.deepEqual(calls[0].options, { returnRawResponse: true });
});

test("ElevenLabs speech failure falls back to Workers AI without moving the conversation brain", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => new Response("unavailable", { status: 503 });
  const aiCalls = [];
  const result = await synthesizeNativeCarrierTts({
    ELEVENLABS_API_KEY: "test-key",
    ELEVENLABS_TTS_VOICE_ID: "voice-premium",
    PAWSPACE_VOICE_NATIVE_TTS_PROVIDER: "elevenlabs",
    PAWSPACE_VOICE_NATIVE_TTS_FALLBACK: "workers_ai",
    AI: { run: async (model, input) => { aiCalls.push({ model, input }); return pcm; } },
  }, "Fallback speech.", 24000);
  assert.equal(result.provider, "workers_ai");
  assert.equal(result.fallbackUsed, true);
  assert.equal(aiCalls.length, 1);
  assert.equal(aiCalls[0].input.sample_rate, 24000);
});

test("native TTS selection fails closed on unknown providers and unapproved API bases", async () => {
  await assert.rejects(
    () => synthesizeNativeCarrierTts({ PAWSPACE_VOICE_NATIVE_TTS_PROVIDER: "mystery" }, "hello", 8000),
    /Unsupported native TTS provider/,
  );
  await assert.rejects(
    () => synthesizeNativeCarrierTts({
      PAWSPACE_VOICE_NATIVE_TTS_PROVIDER: "elevenlabs",
      PAWSPACE_VOICE_NATIVE_TTS_FALLBACK: "workers_ai",
      ELEVENLABS_API_KEY: "key",
      ELEVENLABS_TTS_VOICE_ID: "voice",
      ELEVENLABS_API_BASE: "https://example.invalid",
      AI: { run: async () => pcm },
    }, "hello", 8000),
    /API base is not approved/,
  );
});

test("native TTS readiness exposes configuration state without secret values", () => {
  const ready = nativeCarrierTtsReadiness({
    ELEVENLABS_API_KEY: "test-key",
    ELEVENLABS_TTS_VOICE_ID: "voice-premium",
    AI: { run: async () => pcm },
  });
  assert.deepEqual(ready, {
    configured: true,
    primary: "elevenlabs",
    fallback: "workers_ai",
    elevenLabsConfigured: true,
    workersAiConfigured: true,
  });
  assert.ok(!JSON.stringify(ready).includes("test-key"));
});

test("native TTS readiness uses the same approved-origin validation as execution", () => {
  const ready = nativeCarrierTtsReadiness({
    ELEVENLABS_API_KEY: "test-key",
    ELEVENLABS_TTS_VOICE_ID: "voice-premium",
    ELEVENLABS_API_BASE: "https://example.invalid",
    AI: { run: async () => pcm },
  });
  assert.equal(ready.configured, false);
  assert.equal(ready.primary, null);
  assert.equal(ready.elevenLabsConfigured, false);
  assert.equal(ready.workersAiConfigured, true);
});

test("native TTS readiness does not advertise an unavailable explicit fallback", () => {
  const ready = nativeCarrierTtsReadiness({
    ELEVENLABS_API_KEY: "test-key",
    ELEVENLABS_TTS_VOICE_ID: "voice-premium",
    PAWSPACE_VOICE_NATIVE_TTS_PROVIDER: "elevenlabs",
    PAWSPACE_VOICE_NATIVE_TTS_FALLBACK: "workers_ai",
  });
  assert.equal(ready.configured, true);
  assert.equal(ready.primary, "elevenlabs");
  assert.equal(ready.fallback, null);
  assert.equal(ready.workersAiConfigured, false);
});

test("malformed ElevenLabs PCM is rejected inside the provider attempt and falls back", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => new Response("<html>not audio</html>", {
    status: 200,
    headers: { "content-type": "audio/pcm" },
  });
  const result = await synthesizeNativeCarrierTts({
    ELEVENLABS_API_KEY: "test-key",
    ELEVENLABS_TTS_VOICE_ID: "voice-premium",
    PAWSPACE_VOICE_NATIVE_TTS_PROVIDER: "elevenlabs",
    PAWSPACE_VOICE_NATIVE_TTS_FALLBACK: "workers_ai",
    AI: { run: async () => pcm },
  }, "Fallback after invalid audio.", 8000);
  assert.equal(result.provider, "workers_ai");
  assert.equal(result.fallbackUsed, true);
});

test("ElevenLabs PCM is exposed progressively after one carrier-safe preflight chunk", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let source;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      source = controller;
      controller.enqueue(new Uint8Array(3200));
    },
  }), { status: 200, headers: { "content-type": "audio/pcm" } });

  const result = await synthesizeNativeCarrierTts({
    ELEVENLABS_API_KEY: "test-key",
    ELEVENLABS_TTS_VOICE_ID: "voice-premium",
  }, "Stream this.", 8000);
  const reader = result.result.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  assert.equal(first.value.byteLength, 3200);
  source.enqueue(new Uint8Array(64));
  source.close();
  const second = await reader.read();
  assert.equal(second.done, false);
  assert.equal(second.value.byteLength, 64);
  assert.equal((await reader.read()).done, true);
});

test("ElevenLabs read failure before the first carrier frame falls back safely", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(64)); },
    pull(controller) { controller.error(new Error("synthetic provider stream failure")); },
  }), { status: 200, headers: { "content-type": "audio/pcm" } });
  const result = await synthesizeNativeCarrierTts({
    ELEVENLABS_API_KEY: "test-key",
    ELEVENLABS_TTS_VOICE_ID: "voice-premium",
    PAWSPACE_VOICE_NATIVE_TTS_PROVIDER: "elevenlabs",
    PAWSPACE_VOICE_NATIVE_TTS_FALLBACK: "workers_ai",
    AI: { run: async () => pcm },
  }, "Recover before playback.", 8000);
  assert.equal(result.provider, "workers_ai");
  assert.equal(result.fallbackUsed, true);
});

test("oversized ElevenLabs responses cancel the provider body before returning", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({
    pull() {},
    cancel() { cancelled = true; },
  }), {
    status: 200,
    headers: { "content-type": "audio/pcm", "content-length": String(8 * 1024 * 1024 + 1) },
  });
  await assert.rejects(() => synthesizeNativeCarrierTts({
    ELEVENLABS_API_KEY: "test-key",
    ELEVENLABS_TTS_VOICE_ID: "voice-premium",
    PAWSPACE_VOICE_NATIVE_TTS_PROVIDER: "elevenlabs",
    PAWSPACE_VOICE_NATIVE_TTS_FALLBACK: "none",
  }, "Too much audio.", 8000), /audio_too_large/);
  assert.equal(cancelled, true);
});

test("Workers AI stalled body wakes on caller cancellation", async () => {
  const abort = new AbortController(); let cancelled = false;
  const env = { PAWSPACE_VOICE_NATIVE_TTS_PROVIDER: "workers_ai", AI: { run: async () => new ReadableStream({ cancel() { cancelled = true; } }) } };
  const pending = synthesizeNativeCarrierTts(env, "Synthetic speech", 8000, { signal: abort.signal });
  setTimeout(() => abort.abort(), 20);
  await assert.rejects(Promise.race([pending, new Promise((_, reject) => setTimeout(() => reject(new Error("stalled read did not wake")), 200))]), /cancel/i);
  assert.equal(cancelled, true);
});

test("ElevenLabs stalled preflight wakes on caller cancellation without fetch abort assistance", async (t) => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  const abort = new AbortController(); let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-type": "audio/pcm" } });
  const pending = synthesizeNativeCarrierTts({ ELEVENLABS_API_KEY: "test-key", ELEVENLABS_TTS_VOICE_ID: "synthetic", PAWSPACE_VOICE_NATIVE_TTS_FALLBACK: "none" }, "Synthetic speech", 8000, { signal: abort.signal });
  setTimeout(() => abort.abort(), 20);
  await assert.rejects(Promise.race([pending, new Promise((_, reject) => setTimeout(() => reject(new Error("stalled read did not wake")), 200))]), /cancel/i);
  assert.equal(cancelled, true);
});

test("ElevenLabs stalled progressive tail wakes at the speech deadline", async (t) => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(3200)); }, cancel() { cancelled = true; } }), { headers: { "content-type": "audio/pcm" } });
  const speech = await synthesizeNativeCarrierTts({ ELEVENLABS_API_KEY: "test-key", ELEVENLABS_TTS_VOICE_ID: "synthetic", PAWSPACE_VOICE_NATIVE_TTS_FALLBACK: "none", VOICE_SPEECH_TIMEOUT_MS: 800 }, "Synthetic speech", 8000);
  const reader = speech.result.getReader(); assert.equal((await reader.read()).value.byteLength,3200);
  let watchdog;
  try { await assert.rejects(Promise.race([reader.read(), new Promise((_, reject) => { watchdog=setTimeout(() => reject(new Error("deadline did not wake read")), 1600); })]), /timed out/); }
  finally { clearTimeout(watchdog); reader.releaseLock(); }
  assert.equal(cancelled, true);
});
