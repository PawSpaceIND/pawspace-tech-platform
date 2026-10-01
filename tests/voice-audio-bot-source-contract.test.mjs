import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__VOICE_AUDIO_CONTRACT_DB__", "__VOICE_AUDIO_CONTRACT_ENV__");
const speech = await import("../lib/voice-workers-ai.ts");

const workers = fs.readFileSync(new URL("../lib/voice-workers-ai.ts", import.meta.url), "utf8");
const route = fs.readFileSync(new URL("../app/api/ai-voice-uat/route.ts", import.meta.url), "utf8");
const page = fs.readFileSync(new URL("../app/team/voice/page.tsx", import.meta.url), "utf8");
const overlay = fs.readFileSync(new URL("../scripts/stage-voice-uat-config.mjs", import.meta.url), "utf8");
const workflow = fs.readFileSync(new URL("../.github/workflows/voice-uat-staging.yml", import.meta.url), "utf8");

test("Workers AI defaults to the approved UAT STT and TTS models", async () => {
  assert.match(workers, /DEFAULT_VOICE_STT_MODEL = "@cf\/openai\/whisper-large-v3-turbo"/);
  assert.match(workers, /DEFAULT_VOICE_TTS_MODEL = "@cf\/myshell-ai\/melotts"/);
  assert.match(workers, /if \(!workersAiConfigured\(env\)\) return disconnectedStt/);
  assert.match(workers, /if \(!workersAiConfigured\(env\)\) return disconnectedTts/);
  const calls = [];
  const env = { AI: { async run(model, input) {
    calls.push({ model, input });
    return model.includes("whisper") ? { text: "I need boarding for my pet." } : { audio: "AAECAw==" };
  } } };
  const heard = await speech.resolveWorkersAiStt(env).transcribe({ audioRef: "data:audio/mpeg;base64,AAECAw==" });
  assert.equal(heard.text, "I need boarding for my pet.");
  assert.equal(calls[0].model, "@cf/openai/whisper-large-v3-turbo");
  assert.deepEqual(calls[0].input.audio, [0, 1, 2, 3]);
  const spoken = await speech.resolveWorkersAiTts(env).synthesize({ text: "Let me help with boarding.", language: "en" });
  assert.equal(calls[1].model, "@cf/myshell-ai/melotts");
  assert.equal(calls[1].input.prompt, "Let me help with boarding.");
  assert.equal(spoken.audioRef, "data:audio/mpeg;base64,AAECAw==");
  for (const absent of [{}, { AI: {} }]) {
    assert.equal(speech.resolveWorkersAiStt(absent).status, "not_connected");
    assert.equal(speech.resolveWorkersAiTts(absent).status, "not_connected");
  }
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
  assert.match(overlay, /PAWSPACE_VOICE_RUNTIME: "elevenlabs"/);
  assert.match(overlay, /PAWSPACE_VOICE_NATIVE_UAT_APPROVED: "true"/);
  assert.match(overlay, /VOICE_AGENTSTREAM_STT_LANGUAGE: "auto"/);
  assert.match(overlay, /PAWSPACE_VOICE_NATIVE_TTS_PROVIDER/);
  assert.match(overlay, /PAWSPACE_VOICE_NATIVE_TTS_FALLBACK/);
  assert.match(overlay, /ELEVENLABS_TTS_MODEL_ID/);
  assert.match(overlay, /cfg\.ai = \{ binding: "AI" \}/);
  assert.match(overlay, /PAWSPACE_VOICE_STATUS_CALLBACK_URL_UAT/);
  for (const name of ["PAWSPACE_VOICE_UAT_ALLOWLIST", "EXOTEL_API_KEY", "EXOTEL_API_TOKEN", "EXOTEL_SID", "EXOTEL_CALLER_ID", "EXOTEL_VOICE_APP_ID", "EXOTEL_WEBHOOK_SECRET", "ELEVENLABS_API_KEY", "ELEVENLABS_TTS_VOICE_ID"]) {
    assert.match(overlay, new RegExp(`delete cfg\\.vars\\[secretName\\]`));
    assert.match(workflow, new RegExp(`secrets\\.${name}`));
  }
  assert.match(workflow, /tests\/voice-agentstream-quality\.test\.mjs/);
  assert.match(workflow, /tests\/voice-native-tts\.test\.mjs/);
  assert.match(workflow, /tests\/voice-native-agentstream-uat\.test\.mjs/);
  assert.match(workflow, /native carrier TTS: direct ElevenLabs TTS when configured; Workers AI linear16 fallback otherwise/);
  assert.match(workflow, /ElevenLabs role on native path: speech generation only/);
  assert.match(workflow, /Deploy voice-enabled isolated staging[\s\S]*ELEVENLABS_API_KEY: \$\{\{ secrets\.ELEVENLABS_API_KEY \}\}[\s\S]*ELEVENLABS_TTS_VOICE_ID: \$\{\{ secrets\.ELEVENLABS_TTS_VOICE_ID \}\}/);
  assert.match(workflow, /ordinary voice runtime: ElevenLabs \(unchanged\)/);
  assert.match(workflow, /controlled native AgentStream UAT override: enabled for explicit staff UAT only/);
  assert.match(workflow, /AgentStream STT language mode: auto-detect/);
  assert.doesNotMatch(workflow, /request_call|action:\s*["']request_call["']/);
  assert.match(workflow, /real call placed by this workflow: no/);
});
