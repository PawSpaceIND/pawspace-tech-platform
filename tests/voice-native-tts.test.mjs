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
