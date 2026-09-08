import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertHumanBetaSandbox } from "./assert-human-beta-sandbox.mjs";

assertHumanBetaSandbox(process.env);
console.log("PAWSPACE_PAYMENT_ENV=sandbox\nFORBID_PRODUCTION=true\nPAWSPACE_PAYMENT_LIVE_APPROVED=false");
console.log("Local regression evidence only: external delivery, deployed D1 and browser certification remain separate gates.");
const suites = [
  "infrastructure-payment-lock", "grooming-golden-journey",
  "conversation-live-refresh", "order-notification-gateway-execution",
  "subscription-scheduled-bootstrap", "trust-safety-engine",
  "grooming-vertical-execution", "training-vertical-execution", "sitting-vertical-execution", "walking-vertical-execution",
  "provider-assignment-execution", "provider-journey-execution", "subscription-billing-lifecycle",
  "financial-lifecycle-executable-concurrency", "transaction-atomicity-chaos",
  "schema-migration-idempotency", "schema-query-plan", "booking-state-integrity",
  "payment-provider-contract", "adversarial-webhook-replay-signature", "payment-webhook-parser-boundary",
  "notifications-outbox-closure", "communication-outbox-hardening", "communication-provider-boundary", "meta-whatsapp-webhook",
  "auth-security-audit", "gps-tracking-audit", "analytics-scale-truth", "analytics-hardening",
  "release-preview-gate-behavior", "refund-cap-collected-funds", "partner-settlement-payout-governance",
];
const result = spawnSync(process.execPath, ["--experimental-strip-types", "--test", "--test-reporter=tap", "--test-concurrency=1",
  ...suites.map(name => `tests/${name}.test.mjs`)], {
  cwd: fileURLToPath(new URL("../", import.meta.url)), stdio: "inherit",
  env: { ...process.env, NODE_ENV: "test", APP_ENV: "staging", PAWSPACE_LOCAL_PREVIEW: "on",
    PAWSPACE_TEST_SERVICE_DISCOVERY_FIXTURE: "on", PAWSPACE_VOICE_TRANSPORT: "local_simulator_non_production" },
});
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
