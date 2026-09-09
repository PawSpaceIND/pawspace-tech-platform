import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// Deliberately invalid fixture credentials; every case exits before the network boundary.
const sandboxProbeDefaults = { PAWSPACE_PAYMENT_ENV: "sandbox", PAWSPACE_PAYMENT_LIVE_APPROVED: "false", FORBID_PRODUCTION: "true",
  RAZORPAY_KEY_ID_SANDBOX: "rzp_test_fixtureOnly", RAZORPAY_KEY_SECRET_SANDBOX: "fixture-not-a-secret",
  RAZORPAY_WEBHOOK_SECRET_SANDBOX: "fixture-not-a-webhook-secret" };
function runSandboxProbe(patch) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(PAWSPACE_|RAZORPAY_)/.test(key)) delete env[key];
  Object.assign(env, sandboxProbeDefaults, patch);
  const result = spawnSync(process.execPath, ["scripts/e2e/razorpay-sandbox.mjs"], { env, encoding: "utf8", timeout: 5000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /BLOCKED Razorpay sandbox/);
  assert.match(result.stderr, /No order, capture, refund or webhook verification was executed/);
  assert.doesNotMatch(result.stdout, /PASS|SKIP/);
  assert.doesNotMatch(result.stderr, /fixture-not-a-secret|fixture-not-a-webhook-secret/);
  return result.stderr;
}
for (const name of ["RAZORPAY_KEY_ID_SANDBOX", "RAZORPAY_KEY_SECRET_SANDBOX", "RAZORPAY_WEBHOOK_SECRET_SANDBOX"]) {
  test(`sandbox probe fails closed when ${name} is absent`, () => assert.match(runSandboxProbe({ [name]: "" }), new RegExp(name)));
}
for (const [name, value] of Object.entries({ PAWSPACE_PAYMENT_ENV: "live", PAWSPACE_PAYMENT_LIVE_APPROVED: "true", FORBID_PRODUCTION: "false" })) {
  test(`sandbox probe refuses unsafe ${name}`, () => assert.match(runSandboxProbe({ [name]: value }), new RegExp(name)));
}
for (const key of ["rzp_live_example", "rzp_test_placeholder"]) {
  test(`sandbox probe refuses ${key}`, () => assert.match(runSandboxProbe({ RAZORPAY_KEY_ID_SANDBOX: key }), /live and placeholder keys are refused/));
}
for (const amount of ["0", "1.5", "9007199254740992"]) {
  test(`sandbox probe refuses invalid paise ${amount}`, () => assert.match(runSandboxProbe({ RAZORPAY_SANDBOX_AMOUNT_PAISE: amount }), /positive safe integer/));
}
