import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const voice = readFileSync(new URL("../lib/voice-ai-self-test.ts", import.meta.url), "utf8");
const route = readFileSync(new URL("../app/api/voice-outbound/route.ts", import.meta.url), "utf8");
const worker = readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");

// These assertions match the SOURCE, which is prettier-formatted. The previous versions of several of
// them were written against unformatted source (`body.set("record","false")`, `event:"clear"`) and
// stopped matching the moment the file was formatted - so this suite was red on its own branch while
// appearing to guard the contract. Every pattern below tolerates the formatter's whitespace.
const squash = (value) => value.replace(/\s+/g, "");
/** Source with comments removed: an "absence" assertion must judge code, not prose about the code. */
const codeOnly = (value) =>
  value.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
const flatVoice = squash(voice);
const flatVoiceCode = squash(codeOnly(voice));
const flatRoute = squash(route);
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

// The defect this lane actually shipped with: Exotel accepted the dial and rang the phone, but no
// Voicebot applet ever ran, so the AgentStream socket was never opened and the caller heard silence.
// Bidirectional streaming is not a Connect-API parameter - it lives in an Exotel App referenced by Url.
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
  // streamurl / streamtype are not Connect API parameters. Sending them rang the phone and streamed
  // nothing, so their absence from the CODE (comments excluded) is the regression guard.
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
  // The wss URL is rebuilt from the Worker's own origin and re-signed; a caller cannot redirect media.
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
  // Exotel must get its 101 before Workers AI is touched; Flux is initialised after the upgrade.
  assert.ok(flatVoice.includes("voidinitializeFlux()"));
});

// Exotel's PSTN leg is raw/slin 16-bit mono little-endian at 8 kHz. Advertising 16 kHz made the Worker
// synthesise at twice the negotiated rate, which is inaudible even when every frame is delivered.
test("audio is framed for the negotiated Exotel format, not a hardcoded rate", () => {
  has(flatVoice, "EXOTEL_PSTN_SAMPLE_RATE=8000");
  assert.ok(
    flatVoice.includes('url.searchParams.set("sample-rate",String(EXOTEL_PSTN_SAMPLE_RATE))'),
    "the signed URL must not advertise a rate the PSTN leg does not carry",
  );
  assert.ok(flatVoice.includes("constframeMs=100"), "Exotel expects ~100 ms media blocks");
  assert.ok(
    flatVoice.includes("constframeBytes=Math.max(2,Math.round(sampleRate*2*(frameMs/1000)))"),
    "frame size is derived from the negotiated rate: 8 kHz mono 16-bit -> 1600 bytes per 100 ms",
  );
  // Padding to a 320-byte boundary appended up to 318 bytes of silence to every short final frame.
  assert.ok(!flatVoiceCode.includes("%320"), "frames pad to a whole 16-bit sample, not 320 bytes");
  has(flatVoice, "supportedSampleRate(mediaFormat.sample_rate)", "the start event is authoritative");
});

test("outbound media matches Exotel's AgentStream schema", () => {
  // { event: "media", stream_sid, media: { payload } } - confirmed against Exotel's reference
  // serializer. streamSid (camelCase) is Twilio's spelling and is not accepted here.
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
