import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const workers = fs.readFileSync(new URL("../lib/voice-workers-ai.ts", import.meta.url), "utf8");
const route = fs.readFileSync(new URL("../app/api/ai-voice-uat/route.ts", import.meta.url), "utf8");
const page = fs.readFileSync(new URL("../app/team/voice/page.tsx", import.meta.url), "utf8");
const overlay = fs.readFileSync(new URL("../scripts/stage-voice-uat-config.mjs", import.meta.url), "utf8");
const workflow = fs.readFileSync(new URL("../.github/workflows/voice-uat-staging.yml", import.meta.url), "utf8");

test("Workers AI defaults to the approved UAT STT and TTS models", () => {
  assert.match(workers, /DEFAULT_VOICE_STT_MODEL = "@cf\/openai\/whisper-large-v3-turbo"/);
  assert.match(workers, /DEFAULT_VOICE_TTS_MODEL = "@cf\/myshell-ai\/melotts"/);
  assert.match(workers, /if \(!workersAiConfigured\(env\)\) return disconnectedStt/);
  assert.match(workers, /if \(!workersAiConfigured\(env\)\) return disconnectedTts/);
});

test("operator audit exposes governed transcript segments and voice events", () => {
  assert.match(route, /export async function GET\(request:Request\)/);
  assert.match(route, /ai_voice_segments/);
  assert.match(route, /ai_voice_events/);
  assert.match(route, /requireCustomerOwnership/);
  assert.match(page, /No transcript segments recorded/);
  assert.match(page, /barge-in/);
  assert.match(page, /live_agent_transfer/);
  assert.match(page, /callAction\(row\.callId, "handoff"/);
});

test("voice staging overlay is explicit, isolated and keeps recipient/provider data secret", () => {
  assert.match(overlay, /cfg\.name !== "pawspace-staging"/);
  assert.match(overlay, /PAWSPACE_VOICE_ENV: "uat"/);
  assert.match(overlay, /cfg\.ai = \{ binding: "AI" \}/);
  assert.match(overlay, /PAWSPACE_VOICE_STATUS_CALLBACK_URL_UAT/);
  for (const name of ["PAWSPACE_VOICE_UAT_ALLOWLIST", "EXOTEL_API_KEY", "EXOTEL_API_TOKEN", "EXOTEL_SID", "EXOTEL_CALLER_ID", "EXOTEL_VOICE_APP_ID", "EXOTEL_WEBHOOK_SECRET"]) {
    assert.match(overlay, new RegExp(`delete cfg\\.vars\\[secretName\\]`));
    assert.match(workflow, new RegExp(`secrets\\.${name}`));
  }
  assert.doesNotMatch(workflow, /request_call|action:\s*["']request_call["']/);
  assert.match(workflow, /real call placed by this workflow: no/);
});
