import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const controls = await import("../lib/ai-provider-runtime-control.ts");
const vadModule = await import("../lib/voice-adaptive-vad.ts");
const adapterSource = fs.readFileSync(new URL("../lib/ai-provider-adapter.ts", import.meta.url), "utf8");
const workerSource = fs.readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");
const governanceSource = fs.readFileSync(new URL("../lib/ai-governance.ts", import.meta.url), "utf8");

test("AI token reservation includes estimated input plus bounded output", () => {
  const reserved = controls.estimateAiTokenReservation("a".repeat(400), "b".repeat(400), 200);
  assert.equal(reserved, 400);
});

test("provider boundary contains request/token/spend limits and circuit failures", () => {
  assert.match(adapterSource, /reserveAiProviderRequest/);
  assert.match(adapterSource, /quota_exceeded/);
  assert.match(adapterSource, /circuit_open/);
  assert.match(adapterSource, /runtime_control_unavailable/);
});

test("adaptive VAD learns quiet background without raising threshold from speech", () => {
  const vad = vadModule.createAdaptiveVoiceActivityDetector();
  for (let i = 0; i < 20; i++) assert.equal(vad.observe(60).speech, false);
  const before = vad.snapshot();
  assert.equal(vad.observe(350).speech, true);
  const after = vad.snapshot();
  assert.equal(after.noiseFloorRms, before.noiseFloorRms);
  assert.ok(after.thresholdRms >= 160);
});

test("configured VAD threshold is deterministic for carrier calibration", () => {
  const vad = vadModule.createAdaptiveVoiceActivityDetector("300");
  assert.equal(vad.observe(299).speech, false);
  assert.equal(vad.observe(300).speech, true);
  assert.equal(vad.snapshot().configured, true);
});

test("expired AI context purge is physically scheduled", () => {
  assert.match(governanceSource, /DELETE FROM ai_context_snapshots WHERE expires_at<=\?/);
  assert.match(workerSource, /purgeExpiredAiContexts\(env\.DB,controller\.scheduledTime\)/);
});
