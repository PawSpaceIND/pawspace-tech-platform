import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ProductionConfigurationError, assertProductionReadiness } from "../lib/production-readiness-enforcement.mjs";

const paymentLock = { PAWSPACE_PAYMENT_ENV: "sandbox", PAWSPACE_PAYMENT_LIVE_APPROVED: "false" };
const healthyRegistry = [{ id: "healthy", driver: "production_http", requiredSecrets: ["SERVICE_SECRET"], requiredConfig: ["SERVICE_URL"], handlers: [{ name: "request", state: "implemented" }] }];

test("direct production-readiness callers require the test policy override to be explicitly false", () => {
  const base = { PAWSPACE_PRODUCTION_ENFORCE: "true", ...paymentLock, SERVICE_SECRET: "s", SERVICE_URL: "https://service.example" };
  for (const override of [undefined, "", "0", "False", "FALSE", "disabled"]) {
    const env = { ...base };
    if (override !== undefined) env.PAWSPACE_TEST_API_POLICY_OVERRIDE = override;
    assert.throws(
      () => assertProductionReadiness(env, healthyRegistry),
      error => error instanceof ProductionConfigurationError && /PAWSPACE_TEST_API_POLICY_OVERRIDE must be explicitly false/.test(error.message),
    );
  }
  assert.doesNotThrow(() => assertProductionReadiness({ ...base, PAWSPACE_TEST_API_POLICY_OVERRIDE: "false" }, healthyRegistry));
});

test("pull-request production audit never receives the GitHub production environment or production secrets", () => {
  const workflow = readFileSync(new URL("../.github/workflows/production-signoff.yml", import.meta.url), "utf8");
  const prJob = workflow.split("  master-production-audit:")[1].split("  production-key-presence-audit:")[0];
  assert.match(prJob, /github\.event_name == 'pull_request'/);
  assert.doesNotMatch(prJob, /environment:\s*production/);
  assert.doesNotMatch(prJob, /secrets\./);
  assert.doesNotMatch(prJob, /vars\./);
  assert.match(prJob, /production-readiness-enforcement\.test\.mjs/);
  assert.match(prJob, /production-readiness-closure\.test\.mjs/);
});

test("real production key-presence audit is manual-only and checks trusted main with install scripts disabled", () => {
  const workflow = readFileSync(new URL("../.github/workflows/production-signoff.yml", import.meta.url), "utf8");
  const keyJob = workflow.split("  production-key-presence-audit:")[1];
  assert.match(keyJob, /github\.event_name == 'workflow_dispatch'/);
  assert.match(keyJob, /environment:\s*production/);
  assert.match(keyJob, /ref:\s*main/);
  assert.match(keyJob, /npm ci --ignore-scripts/);
  for (const name of [
    "IDFY_API_KEY", "IDFY_ACCOUNT_ID", "IDFY_WEBHOOK_SECRET", "IDFY_URL",
    "META_WHATSAPP_ACCESS_TOKEN", "INTERAKT_API_KEY", "INTERAKT_WEBHOOK_SECRET",
    "META_WHATSAPP_WABA_ID", "META_WHATSAPP_PHONE_NUMBER_ID",
  ]) assert.match(keyJob, new RegExp(name));
  assert.match(keyJob, /PAWSPACE_TEST_API_POLICY_OVERRIDE: 'false'/);
  assert.match(keyJob, /PAWSPACE_PAYMENT_ENV: 'sandbox'/);
  assert.match(keyJob, /PAWSPACE_PAYMENT_LIVE_APPROVED: 'false'/);
});
