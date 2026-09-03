import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const read = (p) => readFile(new URL(p, import.meta.url), "utf8");
const voice = await read("../lib/voice-provider-adapter.ts");
const rollout = await read("../lib/ai-audience-rollout.ts");
const orchestrator = await read("../lib/ai-conversation-orchestrator.ts");
const gate = await read("../lib/payment-webhook-gate.ts");
const webhook = await read("../app/api/razorpay-webhook/route.ts");
const voiceRoute = await read("../app/api/voice-providers/route.ts");
const rolloutRoute = await read("../app/api/ai-rollout/route.ts");
const payRoute = await read("../app/api/payment-readiness/route.ts");

test("voice STT/TTS adapter is fail-closed and returns the disconnected stubs until keys are set", () => {
  assert.match(voice, /VOICE_STT_API_KEY/); assert.match(voice, /VOICE_STT_URL/);
  assert.match(voice, /VOICE_TTS_API_KEY/); assert.match(voice, /VOICE_TTS_URL/);
  assert.match(voice, /if \(!key \|\| !url\) return disconnectedStt/);
  assert.match(voice, /if \(!key \|\| !url\) return disconnectedTts/);
  // readiness helper must not echo the raw key names as values
  assert.match(voice, /export function voiceProvidersStatus/);
  assert.match(voiceRoute, /requirePermission\(actor,"settings\.manage"\)/);
});

test("AI staff-first rollout: off -> staff_only -> customers, gate integrated into the orchestrator", () => {
  for (const s of ["off", "staff_only", "customers"]) assert.match(rollout, new RegExp(`"${s}"`));
  assert.match(rollout, /export async function resolveAiAudienceGate/);
  assert.match(rollout, /stage === "customers" \|\| \(stage === "staff_only" && input\.audience === "staff"\)/);
  // the orchestrator consults the gate and hands off when the audience isn't enabled yet
  assert.match(orchestrator, /resolveAiAudienceGate/);
  assert.match(orchestrator, /rolloutGated/);
  assert.match(orchestrator, /rollout_gated/);
  assert.match(rolloutRoute, /requirePermission\(actor,"settings\.manage"\)/);
  assert.match(rolloutRoute, /setAiRolloutStage/);
});

test("payment webhook unlock is double-gated (approval flag + distinct live secret), fail-closed", () => {
  assert.match(gate, /PAWSPACE_PAYMENT_LIVE_APPROVED/);
  assert.match(gate, /RAZORPAY_WEBHOOK_SECRET_LIVE/);
  assert.match(gate, /RAZORPAY_WEBHOOK_SECRET_SANDBOX/);
  // live requires BOTH: approval AND a live secret; either missing => not ok
  assert.match(gate, /const liveApproved = \(env: Env\) => env\?\.PAWSPACE_PAYMENT_LIVE_APPROVED === "true"/);
  assert.match(gate, /if \(!liveApproved\(env\)\) return \{ ok: false/);
  assert.match(gate, /if \(!secret\) return \{ ok: false, status: 503, reason: "Razorpay LIVE webhook secret/);
  // the route uses the gate (no more hard sandbox-only lock) and stamps the resolved environment
  assert.match(webhook, /resolvePaymentWebhookGate/);
  assert.match(webhook, /gate\.environment/);
  assert.doesNotMatch(webhook, /locked to sandbox until production launch approval/);
  assert.match(payRoute, /requirePermission\(actor,"payments\.view"\)/);
});