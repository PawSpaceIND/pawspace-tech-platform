/**
 * R3-A8 — the browser E2E harness could not reach the payment path at all.
 *
 * MEASURED: every prepaid vertical (Boarding, Pet Sitting, Dog Training) died at the pay button with
 * a readable 503 "Customer checkout is not enabled for this environment." The refusal was honest, but
 * it came from the ENV-LOCK branch of customerCheckoutEnvironment(), not from the credential branch:
 * scripts/e2e/serve-hardened.sh declared PAWSPACE_PAYMENT_ENV and PAWSPACE_PAYMENT_LIVE_APPROVED and
 * never declared FORBID_PRODUCTION, which that same function requires. The harness therefore stopped
 * one gate BEFORE the one that matters, and no browser audit had ever exercised checkout end to end.
 *
 * These tests run the REAL gate against the environment the REAL script declares — the --var list is
 * parsed out of the script, not retyped — so they fail if the declaration is dropped again, and they
 * state exactly how far a payment now gets. Nothing here supplies a credential.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

// lib/ modules import each other extensionlessly; this resolver is what lets the REAL checkout gate
// be executed here rather than retyped as a fixture.
installWorkersHooks("__R3A_HARNESS_ENV_DB__", "__R3A_HARNESS_ENV_ENV__");

const { customerCheckoutEnvironment, CustomerCheckoutError } = await import("../lib/customer-checkout-server.ts");

const script = readFileSync(new URL("../scripts/e2e/serve-hardened.sh", import.meta.url), "utf8");

/** The Worker bindings the harness actually declares. Process env alone is not a Worker binding. */
function declaredWorkerVars() {
  const env = {};
  for (const match of script.matchAll(/--var\s+([A-Z0-9_]+):([^\s\\]+)/g)) env[match[1]] = match[2];
  return env;
}

const refusalFrom = (env) => {
  try { customerCheckoutEnvironment(env); return null; }
  catch (error) {
    assert.ok(error instanceof CustomerCheckoutError, `unexpected throw: ${error}`);
    return { status: error.status, message: error.message };
  }
};

test("the hardened harness declares every leg of the live-money lock the checkout gate reads", () => {
  const env = declaredWorkerVars();
  assert.equal(env.PAWSPACE_PAYMENT_ENV, "sandbox", "sandbox payments must stay declared");
  assert.equal(env.PAWSPACE_PAYMENT_LIVE_APPROVED, "false", "live money must stay unapproved");
  assert.equal(env.FORBID_PRODUCTION, "true", "the third leg of the lock — the one that was missing");
  // The shell also refuses to start on a live-money posture inherited from the caller.
  assert.match(script, /refusing to start: PAWSPACE_PAYMENT_ENV must be sandbox/);
  assert.match(script, /refusing to start: PAWSPACE_PAYMENT_LIVE_APPROVED must be false/);
  assert.match(script, /refusing to start: FORBID_PRODUCTION must be true/);
});

test("with that declaration the real gate clears the env lock and stops on the missing sandbox secret", () => {
  const env = declaredWorkerVars();

  // Non-vacuity: drop the newly declared leg and the OLD refusal comes straight back.
  const withoutLock = refusalFrom({ ...env, FORBID_PRODUCTION: undefined });
  assert.deepEqual(withoutLock, { status: 503, message: "Customer checkout is not enabled for this environment." },
    "this is the exact 503 every prepaid vertical returned, and it is what the harness used to produce");

  // With it, the gate moves PAST the environment lock and onto the credential the owner must provision.
  const refusal = refusalFrom(env);
  assert.ok(refusal, "no Razorpay sandbox key is declared anywhere in this repository, so checkout must still refuse");
  assert.equal(refusal.status, 503);
  assert.equal(refusal.message, "Razorpay test checkout is not configured. Contact billing support.",
    "the harness now fails on the missing sandbox credential — a provisioning fact — not on its own configuration");
  assert.notEqual(refusal.message, "Customer checkout is not enabled for this environment.");
});

test("the gate still opens only for a real rzp_test key, and the harness supplies none", () => {
  const env = declaredWorkerVars();
  assert.ok(!("RAZORPAY_KEY_ID_SANDBOX" in env) && !("RAZORPAY_KEY_SECRET_SANDBOX" in env),
    "the harness must never carry a gateway credential");
  assert.doesNotMatch(script, /rzp_(test|live)_/, "no key material may be committed in the harness");

  // A placeholder or a live key is still refused; only a real sandbox pair passes, and that pair has
  // to come from the deployment environment, never from this repository.
  for (const key of ["", "placeholder", "rzp_test_placeholder", "rzp_live_abcdef123456"]) {
    const refusal = refusalFrom({ ...env, RAZORPAY_KEY_ID_SANDBOX: key, RAZORPAY_KEY_SECRET_SANDBOX: "secret" });
    assert.equal(refusal?.status, 503, `key ${JSON.stringify(key)} must not open checkout`);
    assert.equal(refusal.message, "Razorpay test checkout is not configured. Contact billing support.");
  }
  assert.equal(refusalFrom({ ...env, RAZORPAY_KEY_ID_SANDBOX: "rzp_test_R3AHarnessProbe", RAZORPAY_KEY_SECRET_SANDBOX: "" })?.status, 503,
    "a key without its secret is not a configured gateway");
  assert.equal(refusalFrom({ ...env, RAZORPAY_KEY_ID_SANDBOX: "rzp_test_R3AHarnessProbe", RAZORPAY_KEY_SECRET_SANDBOX: "sandbox-secret" }), null,
    "and a genuine provisioned sandbox pair is the ONLY thing left between this harness and a real checkout");
});
