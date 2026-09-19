import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const overlay = read("scripts/stage-voice-uat-config.mjs");
const checkoutDeploy = read("scripts/deploy-checkout-sandbox.mjs");
const relayVerify = read("scripts/verify-razorpay-sandbox-relay-target.mjs");
const paymentWorkflow = read(".github/workflows/current-main-strict-payment-closure.yml");
const voiceWorkflow = read(".github/workflows/voice-uat-one-shot-self-test.yml");
const playwright = read("playwright.config.ts");

test("voice UAT activation enables the guarded browser/carrier self-test but not production voice", () => {
  assert.match(overlay, /PAWSPACE_VOICE_ENV: "uat"/);
  assert.match(overlay, /PAWSPACE_VOICE_UAT_AI_SELF_TEST_APPROVED: "true"/);
  assert.doesNotMatch(overlay, /PAWSPACE_VOICE_LIVE_APPROVED:\s*"true"/);
});

test("current-main checkout proof revalidates protected main instead of borrowing PR736 identity", () => {
  assert.match(checkoutDeploy, /targetMode === "current_main"/);
  assert.match(checkoutDeploy, /repos\/\$\{CHECKOUT_REPOSITORY\}\/commits\/main/);
  assert.match(relayVerify, /targetMode==="current_main"/);
  assert.match(relayVerify, /pawspace-tech-platform\/commits\/main/);
  assert.match(paymentWorkflow, /CHECKOUT_TARGET_MODE: current_main/);
  assert.match(paymentWorkflow, /commits\/main --jq \.sha/);
  assert.match(paymentWorkflow, /Exactly one product-native one-rupee Razorpay TEST capture and signed-webhook proof/);
  assert.match(paymentWorkflow, /PAWSPACE_PAYMENT_ENV: sandbox/);
  for (const name of ["PAWSPACE_PAYMENT_LIVE_APPROVED", "PAWSPACE_LIVE_PAYMENTS", "PAWSPACE_LIVE_REFUNDS", "PAWSPACE_LIVE_PAYOUTS"]) {
    assert.match(paymentWorkflow, new RegExp(name + ": 'false'"));
  }
});

test("one-shot voice workflow uses real staging auth and server-selected allowlist without exposing a number", () => {
  assert.match(voiceWorkflow, /workflow_dispatch:/);
  assert.match(voiceWorkflow, /voice-self-test-call/);
  assert.match(voiceWorkflow, /commits\/main --jq \.sha/);
  assert.match(voiceWorkflow, /\/api\/staging-login/);
  assert.match(voiceWorkflow, /founder@pawspace\.in/);
  assert.match(voiceWorkflow, /scope=ai_self_test/);
  assert.match(voiceWorkflow, /action: "uat_ai_self_test"/);
  assert.match(voiceWorkflow, /providerAccepted=yes/);
  assert.match(voiceWorkflow, /production voice mode enabled: no/);
  assert.doesNotMatch(voiceWorkflow, /\+91[0-9]{10}|900000[0-9]{4}/);
});

test("desktop and mobile browser inventories include the voice console human-readiness journey", () => {
  assert.match(playwright, /e2e\/voice-console-human-readiness\.spec\.ts/);
});
