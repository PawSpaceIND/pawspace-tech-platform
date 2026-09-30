import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const bridge = fs.readFileSync(new URL("../lib/exotel-agentstream.ts", import.meta.url), "utf8");
const provider = fs.readFileSync(new URL("../lib/voice-telephony-provider.ts", import.meta.url), "utf8");
const worker = fs.readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");
const scheduler = fs.readFileSync(new URL("../lib/voice-carrier-uat-scheduler.ts", import.meta.url), "utf8");

test("AgentStream carrier route is outside the PawSpace browser session gateway", () => {
  assert.match(bridge, /EXOTEL_AGENTSTREAM_PATH = "\/voice\/exotel\/agentstream"/);
  assert.match(worker, /url\.pathname===EXOTEL_AGENTSTREAM_PATH/);
  assert.ok(worker.indexOf("url.pathname===EXOTEL_AGENTSTREAM_PATH") < worker.indexOf('url.pathname.startsWith("/api/")'));
});

test("AgentStream validates carrier identity and uses linear16 media envelopes", () => {
  assert.match(bridge, /accountSid !== text\(env\.EXOTEL_SID\)/);
  assert.match(bridge, /provider_call_id=\?/);
  assert.match(bridge, /encoding: "linear16"/);
  assert.match(bridge, /event: "media"/);
  assert.match(bridge, /event: "clear"/);
  assert.match(bridge, /event: "mark"/);
});

test("carrier speech path keeps Whisper and avoids piping MeloTTS MP3 into Exotel PCM", () => {
  assert.match(bridge, /@cf\/openai\/whisper-large-v3-turbo/);
  assert.match(bridge, /@cf\/deepgram\/aura-2-en/);
  assert.match(bridge, /encoding: "linear16"/);
  assert.doesNotMatch(bridge, /@cf\/myshell-ai\/melotts/);
});

test("Exotel dialer selects direct bidirectional streaming when a governed wss endpoint is configured", () => {
  assert.match(provider, /PAWSPACE_VOICE_STREAM_URL/);
  assert.match(provider, /StreamUrl: streamUrl/);
  assert.match(provider, /StreamType: "bidirectional"/);
  assert.match(provider, /CustomField: intent\.callRef/);
});

test("one-shot carrier UAT remains consent, allowlist, idempotency and time gated", () => {
  assert.match(scheduler, /2026-09-11T04:30:00\.000Z/);
  assert.match(scheduler, /recordVoiceConsent/);
  assert.match(scheduler, /unique\.length !== 1/);
  assert.match(scheduler, /voice-carrier-uat:2026-09-11:controlled-retry-7/);
  assert.match(scheduler, /requestControlledCarrierUatCall/);
});

test("native AgentStream isolates each call conversation and preserves business context", () => {
  assert.match(bridge, /nativeVoiceThreadId\(order\.id\)/);
  assert.match(bridge, /THREAD-VOICE-/);
  assert.doesNotMatch(bridge, /WHERE customer_id=\? AND status='open' ORDER BY updated_at DESC LIMIT 1/);
  assert.match(bridge, /order\.booking_id/);
  assert.match(bridge, /order\.lead_id/);
});

test("native AgentStream uses PawSpace specialist sales profiles with scheduling authority", () => {
  assert.match(bridge, /value === "grooming_sales".*"grooming"/s);
  assert.match(bridge, /value === "training_sales".*"dog_training"/s);
  assert.match(bridge, /salesService:active\.salesService/);
  assert.match(bridge, /"scheduling\.book"/);
});

test("native AgentStream speaks the governed opening disclosure before normal turns", () => {
  assert.match(bridge, /SELECT opening_disclosure,active FROM voice_call_scripts WHERE use_case=\?/);
  assert.match(bridge, /synthesizeLinear16\(env, session\.openingDisclosure, session\.sampleRate\)/);
  assert.match(bridge, /recordSegment\(env, session, "assistant", session\.openingDisclosure/);
  assert.match(bridge, /sendAudio\(server, session, greeting\.audio/);
});

test("native AgentStream preserves bounded canonical voice follow-up history", () => {
  assert.match(bridge, /channel='voice' ORDER BY created_at DESC LIMIT 32/);
  assert.match(bridge, /bind\(threadId, customerId\)/);
  assert.match(bridge, /classifyVoiceFollowup\(transcript, conversationHistory\)/);
  assert.match(bridge, /context: \{ \.\.\.input\.context, conversationHistory, asOf: now \}/);
  assert.match(bridge, /voiceFollowupIntent,/);
});

test("native AgentStream canonicalizes connection evidence and is reconnect-idempotent", () => {
  assert.match(bridge, /AGENTSTREAM_ACTIVE_STATES = new Set\(\["connected", "speaking", "listening"\]\)/);
  assert.match(bridge, /state !== "dialing" && state !== "ringing"/);
  assert.match(bridge, /to: "connected"/);
  assert.match(bridge, /reason: "authenticated_agentstream_start"/);
  assert.match(bridge, /INSERT OR IGNORE INTO communication_threads/);
  assert.match(bridge, /nativeVoiceParticipantId\(order\.id\)/);
  assert.match(bridge, /nativeVoiceAiCallId\(order\.id\)/);
  assert.match(bridge, /INSERT OR IGNORE INTO ai_voice_calls/);
  assert.match(bridge, /reconnect_count=reconnect_count\+1/);
  assert.match(bridge, /MAX\(segment_index\)/);
  assert.match(bridge, /created \? "agentstream_started" : "agentstream_reconnected"/);
  assert.match(bridge, /if \(!session\.reconnected\)/);
});

test("native AgentStream transport interruption stays reconnectable until explicit stop", () => {
  assert.match(bridge, /agentstream_transport_interrupted/);
  assert.match(bridge, /recordTransportInterruption\(env, active, "socket_closed"\)/);
  assert.match(bridge, /recordTransportInterruption\(env, session, "socket_error"\)/);
  assert.match(bridge, /kind === "stop".*closeSession\(env, active/s);
  assert.doesNotMatch(bridge, /addEventListener\("close".*closeSession/s);
});
