import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const bridge = fs.readFileSync(new URL("../lib/exotel-agentstream.ts", import.meta.url), "utf8");
const provider = fs.readFileSync(new URL("../lib/voice-telephony-provider.ts", import.meta.url), "utf8");
const auth = fs.readFileSync(new URL("../lib/voice-agentstream-auth.ts", import.meta.url), "utf8");
const worker = fs.readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");
const scheduler = fs.readFileSync(new URL("../lib/voice-carrier-uat-scheduler.ts", import.meta.url), "utf8");

test("AgentStream carrier route is outside the PawSpace browser session gateway", () => {
  assert.match(bridge, /EXOTEL_AGENTSTREAM_PATH = "\/voice\/exotel\/agentstream"/);
  assert.match(worker, /url\.pathname===EXOTEL_AGENTSTREAM_PATH/);
  assert.ok(worker.indexOf("url.pathname===EXOTEL_AGENTSTREAM_PATH") < worker.indexOf('url.pathname.startsWith("/api/")'));
});

test("AgentStream validates carrier identity, signed call identity and linear16 media envelopes", () => {
  assert.match(bridge, /accountSid !== text\(env\.EXOTEL_SID\)/);
  assert.match(bridge, /provider_call_id=\?/);
  assert.match(bridge, /verifyAgentStreamStart/);
  assert.match(bridge, /if \(!auth\.verified\) throw/);
  assert.match(auth, /HMAC/);
  assert.match(auth, /FRESHNESS_MS/);
  assert.match(bridge, /encoding: "linear16"/);
  assert.match(bridge, /event: "media"/);
  assert.match(bridge, /event: "clear"/);
  assert.match(bridge, /event: "mark"/);
});

test("carrier speech path keeps Whisper, uses shared deadlines and bounds TTS audio", () => {
  assert.match(bridge, /@cf\/openai\/whisper-large-v3-turbo/);
  assert.match(bridge, /@cf\/deepgram\/aura-2-en/);
  assert.match(bridge, /withSpeechDeadline\("stt"/);
  assert.match(bridge, /withSpeechDeadline\("tts"/);
  assert.match(bridge, /MAX_AGENTSTREAM_TTS_BYTES/);
  assert.match(bridge, /encoding: "linear16"/);
  assert.doesNotMatch(bridge, /@cf\/myshell-ai\/melotts/);
});

test("Exotel dialer signs direct bidirectional streaming per governed call", () => {
  assert.match(provider, /PAWSPACE_VOICE_STREAM_URL/);
  assert.match(provider, /signedAgentStreamUrl\(env, streamUrl, intent\.callRef\)/);
  assert.match(provider, /streamurl: authenticatedStreamUrl/);
  assert.match(provider, /streamtype: "bidirectional"/);
  assert.match(provider, /customfield: intent\.callRef/);
});

test("one-shot carrier UAT remains consent, allowlist, idempotency and time gated", () => {
  assert.match(scheduler, /2026-09-06T02:30:00\.000Z/);
  assert.match(scheduler, /recordVoiceConsent/);
  assert.match(scheduler, /unique\.length !== 1/);
  assert.match(scheduler, /voice-carrier-uat:2026-09-06:controlled-retry-1/);
  assert.match(scheduler, /requestControlledCarrierUatCall/);
});
