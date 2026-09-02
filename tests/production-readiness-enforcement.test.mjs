import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateProductionReadiness,
  assertProductionReadiness,
  detectProductionProfile,
  ProductionReadinessError,
  FORBIDDEN_IN_PRODUCTION,
  DEV_AND_UAT_ONLY_ENV,
} from "../lib/production-readiness-enforcement.mjs";

// A production environment that is fully on live, non-mock drivers and passes every blocking check.
// Each sabotage test starts from a FRESH copy and breaks exactly one thing, so a red assertion names the
// single guard that fired. NODE_ENV is deliberately absent: the functions take an explicit env, so the
// harness's ambient NODE_ENV=test can never leak into these cases.
function base() {
  return {
    PAWSPACE_DEPLOYMENT_ENV: "production",
    PAWSPACE_IDENTITY_ENV: "live",
    PAWSPACE_PAYMENT_ENV: "live",
    RAZORPAY_KEY_ID: "rzp_live_ABC123realkey",
    RAZORPAY_KEY_SECRET: "live_secret_XYZ789_real_value",
    RAZORPAY_WEBHOOK_SECRET_LIVE: "whsec_live_real_value_9876",
    PAWSPACE_PAYMENT_LIVE_APPROVED: "true",
    IDFY_API_KEY: "idfy_live_api_key_real",
    IDFY_ACCOUNT_ID: "idfy_acct_real_123",
    IDFY_URL: "https://eve.idfy.com/v3/tasks",
    IDFY_WEBHOOK_SECRET: "idfy_whsec_real_value",
    PRODUCTION_R2_BUCKET_NAME: "pawspace-prod-media",
    PAWSPACE_COMMUNICATION_ENV: "live",
  };
}

const hasViolation = (report, code) => report.violations.some((v) => v.code === code);
const violationCodes = (report) => report.violations.map((v) => v.code);

test("a fully-live production environment passes and does not throw", () => {
  const report = evaluateProductionReadiness(base());
  assert.equal(report.enforced, true);
  assert.equal(report.profile, "production");
  assert.equal(report.ok, true, `unexpected violations: ${violationCodes(report).join(", ")}`);
  assert.equal(report.violations.length, 0);
  assert.doesNotThrow(() => assertProductionReadiness(base()));
});

test("outside a production profile the gate is a no-op pass, never throwing", () => {
  // An env riddled with what would be production violations, but NOT a production profile.
  const env = { PAWSPACE_LOCAL_PREVIEW: "on", PAWSPACE_PAYMENT_ENV: "", NODE_ENV: "development" };
  const report = evaluateProductionReadiness(env);
  assert.equal(report.enforced, false);
  assert.equal(report.ok, true);
  assert.equal(report.checks.length, 0);
  assert.deepEqual(assertProductionReadiness(env), report);
});

test("detectProductionProfile recognises each signal independently", () => {
  assert.equal(detectProductionProfile({ PAWSPACE_DEPLOYMENT_ENV: "production" }).isProduction, true);
  assert.equal(detectProductionProfile({ NODE_ENV: "production" }).isProduction, true);
  assert.equal(detectProductionProfile({ DEPLOYMENT_PROFILE: "production" }).isProduction, true);
  assert.equal(detectProductionProfile({ PAWSPACE_DEPLOYMENT_ENV: "staging", NODE_ENV: "test" }).isProduction, false);
  assert.equal(detectProductionProfile({}).isProduction, false);
});

// ---- Payments -------------------------------------------------------------------------------------

test("payments: an UNSET payment env (silent sandbox default) is refused", () => {
  const env = base();
  delete env.PAWSPACE_PAYMENT_ENV;
  const report = evaluateProductionReadiness(env);
  assert.equal(report.ok, false);
  assert.ok(hasViolation(report, "payment_env_explicit"));
});

test("payments: EXPLICIT sandbox in production is allowed (a warning, not a violation)", () => {
  const env = base();
  env.PAWSPACE_PAYMENT_ENV = "sandbox";
  const report = evaluateProductionReadiness(env);
  assert.equal(report.ok, true, `unexpected: ${violationCodes(report).join(", ")}`);
  assert.ok(report.warnings.some((w) => w.code === "payment_sandbox_declared"));
});

test("payments: live mode missing a live credential is a required violation", () => {
  const env = base();
  delete env.RAZORPAY_KEY_SECRET;
  assert.ok(hasViolation(evaluateProductionReadiness(env), "razorpay_live:RAZORPAY_KEY_SECRET"));
});

test("payments: a rzp_test_ key in the live slot is a critical violation", () => {
  const env = base();
  env.RAZORPAY_KEY_ID = "rzp_test_sandboxkey";
  assert.ok(hasViolation(evaluateProductionReadiness(env), "razorpay_key_live_shaped"));
});

test("payments: a live secret identical to its sandbox counterpart is refused", () => {
  const env = base();
  env.RAZORPAY_KEY_SECRET = "collision_secret";
  env.RAZORPAY_KEY_SECRET_SANDBOX = "collision_secret";
  assert.ok(hasViolation(evaluateProductionReadiness(env), "razorpay_live_not_sandbox:RAZORPAY_KEY_SECRET"));
});

test("payments: live mode without the double-gate approval flag is refused", () => {
  const env = base();
  delete env.PAWSPACE_PAYMENT_LIVE_APPROVED;
  assert.ok(hasViolation(evaluateProductionReadiness(env), "razorpay_live_approved"));
});

test("payments: a placeholder value in a live secret is refused", () => {
  const env = base();
  env.RAZORPAY_KEY_SECRET = "uat_local_dev_signing_key_do_not_ship";
  assert.ok(hasViolation(evaluateProductionReadiness(env), "razorpay_no_placeholder:RAZORPAY_KEY_SECRET"));
});

// ---- Identity / IDfy ------------------------------------------------------------------------------

test("identity: a missing IDfy credential is a required violation", () => {
  const env = base();
  delete env.IDFY_WEBHOOK_SECRET;
  assert.ok(hasViolation(evaluateProductionReadiness(env), "idfy:IDFY_WEBHOOK_SECRET"));
});

test("identity: a loopback IDFY_URL is refused", () => {
  const env = base();
  env.IDFY_URL = "http://localhost:9000/mock-idfy";
  assert.ok(hasViolation(evaluateProductionReadiness(env), "idfy_url_https"));
});

test("identity: PAWSPACE_IDENTITY_ENV not live is a warning, not a hard block (already host-gated off)", () => {
  const env = base();
  env.PAWSPACE_IDENTITY_ENV = "sandbox";
  const report = evaluateProductionReadiness(env);
  assert.equal(hasViolation(report, "identity_env_live"), false);
  assert.ok(report.warnings.some((w) => w.code === "identity_env_live"));
  assert.equal(report.ok, true);
});

// ---- Storage / R2 ---------------------------------------------------------------------------------

test("storage: no R2 media bucket (neither binding nor name) is a required violation", () => {
  const env = base();
  delete env.PRODUCTION_R2_BUCKET_NAME;
  assert.ok(hasViolation(evaluateProductionReadiness(env), "media_bucket_bound"));
});

test("storage: a real R2 binding object satisfies the bucket requirement", () => {
  const env = base();
  delete env.PRODUCTION_R2_BUCKET_NAME;
  env.PAWSPACE_MEDIA_BUCKET = { head: async () => null };
  const report = evaluateProductionReadiness(env);
  assert.equal(report.ok, true, `unexpected: ${violationCodes(report).join(", ")}`);
});

// ---- Messaging ------------------------------------------------------------------------------------

test("messaging: an UNSET communication env (silent sandbox simulator) is refused", () => {
  const env = base();
  delete env.PAWSPACE_COMMUNICATION_ENV;
  assert.ok(hasViolation(evaluateProductionReadiness(env), "communication_env_explicit"));
});

test('messaging: communication env "uat" in production is refused', () => {
  const env = base();
  env.PAWSPACE_COMMUNICATION_ENV = "uat";
  assert.ok(hasViolation(evaluateProductionReadiness(env), "communication_env_not_uat"));
});

test("messaging: a half-configured Meta webhook (secret without verify token) is refused", () => {
  const env = base();
  env.META_WHATSAPP_APP_SECRET = "meta_app_secret_real";
  const report = evaluateProductionReadiness(env);
  assert.ok(hasViolation(report, "meta_webhook_complete"));
});

test("messaging: a fully-configured Meta webhook passes", () => {
  const env = base();
  env.META_WHATSAPP_APP_SECRET = "meta_app_secret_real";
  env.META_WHATSAPP_VERIFY_TOKEN = "meta_verify_token_real";
  assert.equal(evaluateProductionReadiness(env).ok, true);
});

// ---- RBAC / dev bypasses --------------------------------------------------------------------------

test("rbac: every FORBIDDEN_IN_PRODUCTION var, present, is a critical violation", () => {
  for (const name of FORBIDDEN_IN_PRODUCTION) {
    const env = base();
    env[name] = "on";
    assert.ok(hasViolation(evaluateProductionReadiness(env), `forbidden_var:${name}`), `${name} was not caught`);
  }
});

test("rbac: every DEV_AND_UAT_ONLY_ENV secret, present, is a critical violation", () => {
  for (const name of DEV_AND_UAT_ONLY_ENV) {
    const env = base();
    env[name] = "some_value";
    assert.ok(hasViolation(evaluateProductionReadiness(env), `dev_only_secret:${name}`), `${name} was not caught`);
  }
});

test("rbac: a development/test NODE_ENV inside a production profile is refused", () => {
  const env = base();
  env.NODE_ENV = "test";
  assert.ok(hasViolation(evaluateProductionReadiness(env), "node_env_not_dev"));
});

// ---- Voice ----------------------------------------------------------------------------------------

test("voice: the local simulator transport in production is refused", () => {
  const env = base();
  env.PAWSPACE_VOICE_TRANSPORT = "local_simulator_non_production";
  assert.ok(hasViolation(evaluateProductionReadiness(env), "voice_transport_not_simulator"));
});

test("voice: live voice without Exotel credentials is a required violation", () => {
  const env = base();
  env.PAWSPACE_VOICE_ENV = "live";
  const report = evaluateProductionReadiness(env);
  assert.ok(hasViolation(report, "exotel_live:EXOTEL_API_KEY"));
  assert.ok(hasViolation(report, "voice_live_approved"));
});

// ---- Aggregation & the error type -----------------------------------------------------------------

test("assertProductionReadiness throws ProductionReadinessError listing every violation", () => {
  const env = base();
  delete env.PAWSPACE_PAYMENT_ENV;
  env.PAWSPACE_LOCAL_PREVIEW = "on";
  env.IDFY_URL = "http://localhost/mock";
  let thrown = null;
  try {
    assertProductionReadiness(env);
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof ProductionReadinessError);
  assert.ok(thrown instanceof Error);
  assert.equal(thrown.name, "ProductionReadinessError");
  const codes = thrown.violations.map((v) => v.code);
  assert.ok(codes.includes("payment_env_explicit"));
  assert.ok(codes.includes("forbidden_var:PAWSPACE_LOCAL_PREVIEW"));
  assert.ok(codes.includes("idfy_url_https"));
  assert.ok(thrown.violations.length >= 3);
  // The message must actually name the failures, not just count them.
  assert.match(thrown.message, /payment_env_explicit/);
  assert.match(thrown.message, /PAWSPACE_LOCAL_PREVIEW/);
});

test("warnings alone never make the gate throw", () => {
  const env = base();
  env.PAWSPACE_PAYMENT_ENV = "sandbox"; // warning
  // no media scan provider -> warning; live comms -> warning
  const report = assertProductionReadiness(env);
  assert.equal(report.ok, true);
  assert.ok(report.warnings.length >= 1);
});
