import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const isolated = read(".github/workflows/deploy-whatsapp-uat-staging.yml");
const full = read(".github/workflows/deploy-staging.yml");

const exotel = [
  "EXOTEL_API_KEY",
  "EXOTEL_API_TOKEN",
  "EXOTEL_SID",
  "EXOTEL_CALLER_ID",
  "EXOTEL_VOICE_APP_ID",
  "EXOTEL_WEBHOOK_SECRET",
];

test("WhatsApp-only staging deploy has no Exotel dependency", () => {
  for (const name of exotel) assert.doesNotMatch(isolated, new RegExp(name), `${name} must not block WhatsApp-only UAT`);
  assert.match(isolated, /META_WHATSAPP_UAT_ACCESS_TOKEN:\s*\$\{\{\s*secrets\.META_WHATSAPP_UAT_ACCESS_TOKEN\s*\}\}/);
  assert.match(isolated, /Wrangler preserves encrypted Worker secrets absent from --secrets-file/);
});

test("WhatsApp-only workflow deploys one exact application SHA to isolated staging only", () => {
  assert.match(isolated, /TARGET_SHA:/);
  assert.match(isolated, /git rev-parse HEAD/);
  assert.match(isolated, /npx wrangler deploy --message "staging \$TARGET_SHA"/);
  assert.match(isolated, /EXPECTED_STAGING_ORIGIN: https:\/\/pawspace-staging\.karthik-fce\.workers\.dev/);
  assert.match(isolated, /node tests\/e2e\/staging-certification\.mjs --isolation-only/);
  assert.match(isolated, /PRODUCTION_D1_ID/);
  assert.match(isolated, /PRODUCTION_WORKER_NAME/);
  assert.doesNotMatch(isolated, /deploy-production|pawspace-prod-bengaluru|PAWSPACE_PAYMENT_LIVE_APPROVED\s*:\s*['"]?true/i);
});

test("WhatsApp-only staging configuration stays UAT/sandbox and proves public webhook boundary", () => {
  assert.match(isolated, /node scripts\/stage-config\.mjs/);
  assert.match(isolated, /PAWSPACE_STAGING_LIVE_CUSTOMER_OTP:\s*"false"/);
  assert.match(isolated, /healthz failed/);
  assert.match(isolated, /Meta webhook did not reach its own GET verifier/);
  assert.match(isolated, /invalid Meta signature was not rejected/);
  assert.match(isolated, /meta\?\.configuredForExternalTest === true/);
  assert.match(isolated, /action: "sync_templates"/);
  assert.match(isolated, /approved\.length < 1/);
});

test("full staging voice mode remains fail-closed on every Exotel credential", () => {
  const requiredBlock = full.match(/const requiredNames = \[([\s\S]*?)\];/)?.[1] || "";
  for (const name of exotel) {
    assert.match(full, new RegExp(`${name}:\\s*\\$\\{\\{\\s*secrets\\.${name}\\s*\\}\\}`), `${name} must still be sourced from GitHub Secrets`);
    assert.match(requiredBlock, new RegExp(`["']${name}["']`), `${name} must remain required by full staging`);
  }
  assert.match(full, /if \(Object\.values\(required\)\.some\(value => !value\)\) throw new Error\("a required staging secret is missing"\)/);
});
