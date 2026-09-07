import test from "node:test";
import assert from "node:assert/strict";

const auth = await import("../lib/voice-agentstream-auth.ts");
const env = { PAWSPACE_VOICE_STREAM_SECRET: "uat-agentstream-secret-123456" };
const asOf = Date.parse("2026-09-07T05:00:00.000Z");

test("signed AgentStream URL verifies for the intended call within the freshness window", async () => {
  const signed = await auth.signedAgentStreamUrl(env, "wss://voice.example.test/voice/exotel/agentstream", "VCALL-123", asOf);
  const url = new URL(signed);
  const params = Object.fromEntries(url.searchParams.entries());
  const result = await auth.verifyAgentStreamStart(env, params, "VCALL-123", asOf + 30_000);
  assert.equal(result.verified, true);
  assert.equal(url.searchParams.get(auth.AGENTSTREAM_AUTH_REF), "VCALL-123");
  assert.ok(url.searchParams.get(auth.AGENTSTREAM_AUTH_SIG));
});

test("AgentStream signature is bound to the governed call reference", async () => {
  const signed = await auth.signedAgentStreamUrl(env, "wss://voice.example.test/voice/exotel/agentstream", "VCALL-123", asOf);
  const params = Object.fromEntries(new URL(signed).searchParams.entries());
  const result = await auth.verifyAgentStreamStart(env, params, "VCALL-OTHER", asOf);
  assert.equal(result.verified, false);
  assert.match(result.reason, /call reference/i);
});

test("tampered and expired AgentStream tokens fail closed", async () => {
  const signed = await auth.signedAgentStreamUrl(env, "wss://voice.example.test/voice/exotel/agentstream", "VCALL-123", asOf);
  const params = Object.fromEntries(new URL(signed).searchParams.entries());
  const tampered = { ...params, ps_sig: `${params.ps_sig.slice(0, -1)}${params.ps_sig.endsWith("0") ? "1" : "0"}` };
  const bad = await auth.verifyAgentStreamStart(env, tampered, "VCALL-123", asOf);
  assert.equal(bad.verified, false);
  assert.match(bad.reason, /signature/i);
  const expired = await auth.verifyAgentStreamStart(env, params, "VCALL-123", asOf + 301_000);
  assert.equal(expired.verified, false);
  assert.match(expired.reason, /freshness/i);
});

test("stream authentication refuses to mint or verify without a configured secret", async () => {
  await assert.rejects(() => auth.signedAgentStreamUrl({}, "wss://voice.example.test/voice/exotel/agentstream", "VCALL-123", asOf), /signing secret/i);
  const result = await auth.verifyAgentStreamStart({}, {}, "VCALL-123", asOf);
  assert.equal(result.verified, false);
});
