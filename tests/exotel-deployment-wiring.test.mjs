import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const staging = read(".github/workflows/deploy-staging.yml");
const production = read(".github/workflows/deploy-production.yml");
const exotelSecrets = [
  "EXOTEL_API_KEY",
  "EXOTEL_API_TOKEN",
  "EXOTEL_SID",
  "EXOTEL_CALLER_ID",
  "EXOTEL_VOICE_APP_ID",
  "EXOTEL_WEBHOOK_SECRET",
];

function deployStep(workflow, name, nextName) {
  const start = workflow.indexOf(`- name: ${name}`);
  const end = workflow.indexOf(`- name: ${nextName}`, start + 1);
  assert.ok(start >= 0 && end > start, `${name} step must be bounded by ${nextName}`);
  return workflow.slice(start, end);
}

test("staging passes every Exotel credential from GitHub Secrets into Wrangler's encrypted secrets file", () => {
  const step = deployStep(staging, "Deploy to staging", "Certify deployed isolation");
  for (const name of exotelSecrets) {
    assert.match(step, new RegExp(`${name}:\\s*\\$\\{\\{\\s*secrets\\.${name}\\s*\\}\\}`));
    assert.match(step, new RegExp(`requiredNames[\\s\\S]*["']${name}["']`));
  }
  assert.match(step, /wrangler deploy[^\n]*--secrets-file "\$SECRETS_FILE"/);
  assert.match(step, /writeFileSync\(process\.env\.SECRETS_FILE, JSON\.stringify\(values\), \{ mode: 0o600 \}\)/);
  assert.match(step, /trap 'rm -f "\$SECRETS_FILE"' EXIT/);
  assert.doesNotMatch(step, /wrangler secret put/);
});

test("production fails closed unless every Exotel credential reaches the same attributed Wrangler deploy", () => {
  const step = deployStep(production, "Deploy to production", "Certify the deployed configuration");
  for (const name of exotelSecrets) {
    assert.match(step, new RegExp(`${name}:\\s*\\$\\{\\{\\s*secrets\\.${name}\\s*\\}\\}`));
    assert.match(step, new RegExp(`requiredNames[\\s\\S]*["']${name}["']`));
  }
  assert.match(step, /wrangler deploy[^\n]*--secrets-file "\$SECRETS_FILE"/);
  assert.match(step, /writeFileSync\(process\.env\.SECRETS_FILE, JSON\.stringify\(values\), \{ mode: 0o600 \}\)/);
  assert.match(step, /trap 'rm -f "\$SECRETS_FILE"' EXIT/);
  assert.doesNotMatch(step, /wrangler secret put/);
});
