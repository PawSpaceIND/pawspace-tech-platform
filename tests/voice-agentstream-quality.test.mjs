import test from "node:test";
import assert from "node:assert/strict";
import {
  carrierAudioMs,
  nativeVoiceTurnDiagnostics,
  resolveCarrierSttLanguage,
  whisperInputLanguage,
} from "../lib/voice-agentstream-quality.ts";

test("carrier STT defaults to auto-detection and accepts Indian language aliases", () => {
  for (const value of [undefined, null, "", "auto", "multilingual"]) assert.equal(resolveCarrierSttLanguage(value), "auto");
  for (const value of ["en", "en-IN", "English"]) assert.equal(resolveCarrierSttLanguage(value), "en");
  for (const value of ["hi", "hi-IN", "Hindi"]) assert.equal(resolveCarrierSttLanguage(value), "hi");
  for (const value of ["kn", "kn-IN", "Kannada"]) assert.equal(resolveCarrierSttLanguage(value), "kn");
  assert.throws(() => resolveCarrierSttLanguage("fr"), /Unsupported AgentStream STT language/);
});

test("Whisper omits a language hint in auto mode instead of hard-locking English", () => {
  assert.equal(whisperInputLanguage("auto"), undefined);
  assert.equal(whisperInputLanguage("en"), "en");
  assert.equal(whisperInputLanguage("hi"), "hi");
  assert.equal(whisperInputLanguage("kn"), "kn");
});

test("carrier audio duration is derived from signed PCM16 byte length", () => {
  assert.equal(carrierAudioMs(16_000, 8_000), 1000);
  assert.equal(carrierAudioMs(32_000, 16_000), 1000);
  assert.equal(carrierAudioMs(-1, 8_000), 0);
  assert.equal(carrierAudioMs(100, 0), 0);
});

test("turn diagnostics are PII-safe, bounded, and keep TTS truth English-only", () => {
  const result = nativeVoiceTurnDiagnostics({
    configuredSttLanguage: "auto",
    detectedSttLanguage: "hi",
    sampleRate: 16_000,
    pcmBytes: 32_000,
    sttMs: 240,
    llmMs: 410,
    ttsMs: 190,
    firstAudioMs: 720,
    totalMs: 840,
    latencyTargetMs: 1500,
    transcriptChars: 42,
    assistantChars: 78,
    sttModel: "@cf/openai/whisper-large-v3-turbo",
    ttsModel: "eleven_flash_v2_5",
    ttsProvider: "elevenlabs",
    ttsFallbackUsed: false,
    outcome: "responded",
  });
  assert.deepEqual(result, {
    configuredSttLanguage: "auto",
    detectedSttLanguage: "hi",
    ttsLanguage: "en",
    sampleRate: 16_000,
    audioMs: 1000,
    sttMs: 240,
    llmMs: 410,
    ttsMs: 190,
    firstAudioMs: 720,
    firstAudioTargetMet: true,
    totalMs: 840,
    latencyTargetMs: 1500,
    targetMet: true,
    transcriptChars: 42,
    assistantChars: 78,
    sttModel: "@cf/openai/whisper-large-v3-turbo",
    ttsModel: "eleven_flash_v2_5",
    ttsProvider: "elevenlabs",
    ttsFallbackUsed: false,
    outcome: "responded",
  });
  assert.ok(!("transcript" in result));
  assert.ok(!("output" in result));
});

test("diagnostics reject unsafe metadata shapes instead of echoing them", () => {
  const result = nativeVoiceTurnDiagnostics({
    configuredSttLanguage: "auto",
    detectedSttLanguage: "not a language; secret=abc",
    sampleRate: 999999,
    pcmBytes: 0,
    sttMs: -1,
    llmMs: Infinity,
    ttsMs: 999999,
    totalMs: 999999,
    latencyTargetMs: 1500,
    transcriptChars: 999999,
    assistantChars: 999999,
    sttModel: "bad model secret=abc",
    ttsModel: "bad model secret=xyz",
    ttsProvider: "bad provider secret=xyz",
    ttsFallbackUsed: true,
    outcome: "x".repeat(200),
  });
  assert.equal(result.detectedSttLanguage, null);
  assert.equal(result.sttModel, "configured");
  assert.equal(result.ttsModel, "configured");
  assert.equal(result.ttsProvider, "configured");
  assert.equal(result.ttsFallbackUsed, true);
  assert.equal(result.sttMs, 0);
  assert.equal(result.llmMs, 0);
  assert.equal(result.ttsMs, 60_000);
  assert.equal(result.totalMs, 60_000);
  assert.equal(result.transcriptChars, 60_000);
  assert.equal(result.assistantChars, 60_000);
  assert.equal(result.outcome.length, 80);
});
