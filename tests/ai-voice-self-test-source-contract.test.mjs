import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const voice = readFileSync(new URL("../lib/voice-ai-self-test.ts", import.meta.url), "utf8");
const browserHarness = readFileSync(new URL("../lib/voice-ai-browser-harness.ts", import.meta.url), "utf8");
const route = readFileSync(new URL("../app/api/voice-outbound/route.ts", import.meta.url), "utf8");
const page = readFileSync(new URL("../app/team/voice/ai-test/page.tsx", import.meta.url), "utf8");
const worker = readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");

const squash = (value) => value.replace(/\s+/g, "");
const codeOnly = (value) =>
  value.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
const flatVoice = squash(voice);
const flatVoiceCode = squash(codeOnly(voice));
const flatBrowser = squash(browserHarness);
const flatBrowserCode = squash(codeOnly(browserHarness));
const flatRoute = squash(route);
const flatPage = squash(page);
const flatWorker = squash(worker);
const has = (haystack, needle, message) => assert.ok(haystack.includes(needle), message);

test("AI voice self-test is UAT-only, one-recipient, non-recording and audited", () => {
  has(flatVoice, 'mode!=="uat"', "UAT mode is required");
  has(flatVoice, "allowlistSize!==1", "exactly one allow-listed recipient");
  assert.match(voice, /PAWSPACE_VOICE_UAT_AI_SELF_TEST_APPROVED/);
  assert.match(voice, /requestQuietHoursOverride/);
  has(flatVoice, "contactCount:1");
  has(flatVoice, 'reasonCode:"customer_requested_callback"', "quiet-hours override stays audited");
  has(flatVoice, 'Record:"false"', "the dial must never request carrier recording");
  has(flatVoice, "MAX_CALL_SECONDS=300");
  has(flatVoice, "DAILY_CAP_DEFAULT=3");
  has(flatVoice, "canonicalDialNumber(env,phoneKey)", "destination comes from server allowlist only");
});

test("browser cannot choose the destination and staff action requires privileged permissions", () => {
  has(flatRoute, 'action==="uat_ai_self_test"');
  has(flatRoute, 'requirePermission(actor,"settings.manage")');
  has(flatRoute, 'requirePermission(actor,"communications.call")');
  assert.doesNotMatch(route, /requestAiVoiceSelfTest\([^\n]+body\.phone/);
});

test("the dial uses Exotel's documented Connect API and points at a Voicebot App", () => {
  assert.ok(
    flatVoice.includes("/v1/Accounts/${encodeURIComponent(sid)}/Calls/connect.json"),
    "Connect API path is capitalised and .json, matching lib/voice-telephony-provider.ts",
  );
  assert.ok(
    flatVoice.includes('"content-type":"application/x-www-form-urlencoded"'),
    "Connect API takes form-urlencoded, not multipart",
  );
  assert.ok(
    flatVoice.includes("Url:`http://my.exotel.com/${sid}/exoml/start_voice/${appId}`"),
    "the call must be pointed at the Exotel App whose Voicebot applet opens the stream",
  );
  assert.match(voice, /EXOTEL_VOICE_APP_ID/, "the App id must be read from configuration");
  assert.ok(!flatVoiceCode.includes('"streamtype"'), "streamtype is not a Connect API parameter");
  assert.ok(!flatVoiceCode.includes('"streamurl"'), "streamurl is not a Connect API parameter");
  assert.ok(
    !flatVoiceCode.includes("/v1/accounts/"),
    "the lowercase path is not the documented endpoint",
  );
});

test("a missing Voicebot App id fails closed instead of placing a silent call", () => {
  assert.ok(
    flatVoice.includes("if(!appId){"),
    "no App id must refuse the dial rather than ring a number that can never stream",
  );
});

test("the Voicebot applet can negotiate a per-call signed wss URL", () => {
  has(flatVoice, 'SELF_TEST_NEGOTIATE_PATH="/voice/ai-self-test/negotiate"');
  assert.match(voice, /export async function handleAiVoiceSelfTestNegotiate/);
  assert.ok(
    flatVoice.includes("fields.customfield"),
    "the applet callback identifies the call through CustomField",
  );
  assert.ok(flatVoice.includes("signedStreamUrl(env,callId,url.origin)"));
  has(flatWorker, 'url.pathname==="/voice/ai-self-test/negotiate"');
  assert.match(worker, /handleAiVoiceSelfTestNegotiate/);
});

test("AgentStream websocket is signed, upgrades before AI init, and Q&A is mutation-free", () => {
  assert.match(voice, /ai-self-test:\$\{callId\}:\$\{exp\}/);
  assert.match(voice, /@cf\/deepgram\/flux/);
  assert.match(voice, /@cf\/deepgram\/aura-1/);
  assert.match(voice, /@cf\/openai\/gpt-oss-20b/);
  assert.match(voice, /do not execute bookings, payments, refunds/);
  assert.ok(flatVoice.includes('event:"clear"'), "barge-in clears the carrier's playback buffer");
  has(flatWorker, 'url.pathname==="/voice/ai-self-test"');
  assert.match(worker, /handleAiVoiceSelfTestStream/);
  assert.ok(flatVoice.includes("voidinitializeFlux()"));
});

test("audio is framed for the negotiated Exotel format, not a hardcoded rate", () => {
  has(flatVoice, "EXOTEL_PSTN_SAMPLE_RATE=8000");
  assert.ok(
    flatVoice.includes('url.searchParams.set("sample-rate",String(EXOTEL_PSTN_SAMPLE_RATE))'),
    "the signed URL must not advertise a rate the PSTN leg does not carry",
  );
  assert.ok(flatVoice.includes("constframeMs=100"), "Exotel expects ~100 ms media blocks");
  assert.ok(
    flatVoice.includes("constframeBytes=Math.max(2,Math.round(sampleRate*2*(frameMs/1000)))"),
    "frame size is derived from the negotiated rate",
  );
  assert.ok(!flatVoiceCode.includes("%320"), "frames pad to a whole 16-bit sample, not 320 bytes");
  has(flatVoice, "supportedSampleRate(mediaFormat.sample_rate)", "the start event is authoritative");
});

test("outbound media matches Exotel's AgentStream schema", () => {
  assert.ok(flatVoice.includes('event:"media",stream_sid:streamSid,media:{payload:toBase64(chunk)}'));
  assert.ok(flatVoice.includes('event:"mark",stream_sid:streamSid'));
  assert.ok(flatVoice.includes('event:"clear",stream_sid:streamSid'));
  assert.ok(!flatVoiceCode.includes('"streamSid":'), "the wire field is stream_sid, not streamSid");
  has(flatVoice, "payload.stream_sid||start.stream_sid");
});

test("only provider-accepted dials count toward the daily UAT cap", () => {
  assert.match(voice, /provider_call_id IS NOT NULL/);
  has(flatVoice, "MAX_CALL_SECONDS", "the 5-minute limit is sent to the carrier");
});

test("browser harness is carrier-free, UAT-only and uses an authenticated short-lived ticket", () => {
  has(flatBrowser, 'DIRECT_PATH="/voice/ai-self-test"');
  has(flatBrowser, "DIRECT_SAMPLE_RATE=16000");
  has(flatBrowser, 'mode!=="uat"');
  assert.match(browserHarness, /PAWSPACE_VOICE_UAT_AI_SELF_TEST_APPROVED/);
  assert.match(browserHarness, /PAWSPACE_UAT_SIGNING_KEY/);
  assert.match(browserHarness, /DIRECT_TICKET_TTL_MS = 2 \* 60_000/);
  has(flatBrowser, '`ai-browser:${ticketId}:${expiresAt}:${DIRECT_SAMPLE_RATE}`');
  has(flatBrowser, 'wsUrl.searchParams.set("mode","direct")');
  assert.doesNotMatch(browserHarness, /EXOTEL_API_KEY|EXOTEL_API_TOKEN|EXOTEL_CALLER_ID/);
});

test("authenticated operator API mints the direct browser ticket", () => {
  has(flatRoute, 'scope==="ai_browser_test"');
  has(flatRoute, 'action==="uat_ai_browser_ticket"');
  has(flatRoute, 'issueDirectBrowserVoiceTicket(env,newURL(request.url).origin)');
  has(flatRoute, 'requirePermission(actor,"settings.manage")');
  assert.match(route, /voice\.ai_browser_test\.ticket/);
});

test("worker routes direct mode before the Exotel socket handler", () => {
  has(flatWorker, 'url.pathname==="/voice/ai-self-test"&&url.searchParams.get("mode")==="direct"');
  assert.match(worker, /handleDirectBrowserVoiceHarnessStream/);
  const directIndex = flatWorker.indexOf('url.searchParams.get("mode")==="direct"');
  const carrierIndex = flatWorker.indexOf('returnhandleAiVoiceSelfTestStream');
  assert.ok(directIndex >= 0 && carrierIndex > directIndex, "direct browser route must be selected before carrier route");
});

test("browser direct pipeline exercises Flux, LLM and Aura at 16 kHz Linear16", () => {
  assert.match(browserHarness, /@cf\/deepgram\/flux/);
  assert.match(browserHarness, /@cf\/openai\/gpt-oss-20b/);
  assert.match(browserHarness, /@cf\/deepgram\/aura-1/);
  has(flatBrowser, 'encoding:"linear16"');
  has(flatBrowser, 'sample_rate:DIRECT_SAMPLE_RATE');
  has(flatBrowser, '"Hello,thisisthePawSpacevoiceUATtest."');
  assert.ok(flatBrowserCode.includes("sendFluxAudio(socket,audio)"), "browser PCM must be routed through the Flux sender");
  assert.ok(flatBrowserCode.includes("socket.send(audio)"), "browser PCM must reach the Flux WebSocket");
  assert.ok(flatBrowserCode.includes("server.send(payload)"), "Aura PCM must return as binary WebSocket audio");
});

test("browser STT startup is serialized and preserves early microphone audio", () => {
  assert.ok(flatBrowserCode.includes("if(fluxInit)returnfluxInit"), "only one Flux initialization may be active");
  assert.ok(flatBrowserCode.includes("bufferAudio(audio)"), "mic frames must be buffered before Flux is ready");
  assert.ok(flatBrowserCode.includes("flushPendingAudio(socket)"), "buffered mic frames must flush after Flux connects");
  assert.ok(flatBrowser.includes('stage:"stt_audio_flowing"'), "browser diagnostics must prove PCM reaches Flux");
  assert.ok(flatBrowser.includes('stage:"end_of_turn"'), "browser diagnostics must expose Flux turn completion");
});

test("browser page captures mic PCM, resamples to 16-bit and plays raw PCM replies", () => {
  assert.match(page, /Test via Browser Mic/);
  assert.match(page, /navigator\.mediaDevices\.getUserMedia/);
  assert.match(page, /createScriptProcessor/);
  assert.match(page, /resampleToLinear16/);
  assert.match(page, /new Int16Array/);
  assert.match(page, /socket\.send\(pcm\)/);
  assert.match(page, /context\.createBuffer/);
  assert.match(page, /new Int16Array\(buffer\)/);
  assert.match(page, /Audio clarity/);
  assert.match(page, /totalLatencyMs/);
});
