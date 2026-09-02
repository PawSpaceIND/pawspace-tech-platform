import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const workflow = read(".github/workflows/deploy-production.yml");
const prodConfig = read("scripts/prod-config.mjs");
const communications = read("app/api/communications/route.ts");
const callback = read("app/api/communication-provider-callback/route.ts");
const adapters = read("lib/communication-adapters.ts");

test("Interakt production credentials are injected only through Wrangler encrypted secrets", () => {
  for (const name of ["INTERAKT_API_KEY", "INTERAKT_WEBHOOK_SECRET"]) {
    assert.match(workflow, new RegExp(`${name}:\\s*\\$\\{\\{\\s*secrets\\.${name}\\s*\\}\\}`));
    assert.match(workflow, new RegExp(`requiredNames[\\s\\S]*["']${name}["']`));
    assert.doesNotMatch(prodConfig, new RegExp(`${name}:\\s*process\\.env`), `${name} must not be serialized into wrangler vars`);
  }
  assert.match(workflow, /writeFileSync\(process\.env\.SECRETS_FILE, JSON\.stringify\(values\), \{ mode: 0o600 \}\)/);
  assert.match(workflow, /wrangler deploy[^\n]*--secrets-file "\$SECRETS_FILE"/);
  assert.match(workflow, /trap 'rm -f "\$SECRETS_FILE"' EXIT/);
});

test("production voice config defaults closed and does not offer live activation", () => {
  assert.match(prodConfig, /PAWSPACE_VOICE_ENV \|\| "disabled"/);
  assert.match(prodConfig, /PAWSPACE_VOICE_UAT_APPROVED \|\| "false"/);
  assert.match(prodConfig, /\["disabled", "uat"\]/);
  assert.match(workflow, /options: \[disabled, uat\]/);
  assert.doesNotMatch(workflow, /options: \[[^\]]*live[^\]]*\][\s\S]{0,120}voice/i);
});

test("production communication surface exposes the Interakt adapter and signed callback path", () => {
  assert.match(adapters, /whatsapp:\["limechat","meta_whatsapp","interakt"\]/);
  assert.match(communications, /dispatchInteraktWhatsApp/);
  assert.match(communications, /action==="dispatch_interakt"/);
  assert.match(callback, /recordInteraktWebhook/);
  assert.match(callback, /provider==="interakt"/);
});

test("D1 backup and restore guard suites are tracked by the normal test glob", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.match(pkg.scripts.test, /tests\/\*\.test\.mjs/);
  assert.doesNotThrow(() => read("scripts/d1-backup.mjs"));
  assert.doesNotThrow(() => read("scripts/d1-restore.mjs"));
  assert.doesNotThrow(() => read("tests/d1-backup-restore-guards.test.mjs"));
});
