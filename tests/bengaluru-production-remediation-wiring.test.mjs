import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const workflow = read(".github/workflows/deploy-production.yml");
const prodConfig = read("scripts/prod-config.mjs");
const communications = read("app/api/communications/route.ts");
const callback = read("app/api/communication-provider-callback/route.ts");
const adapters = read("lib/communication-adapters.ts");

function workflowInputs(workflow) {
  const lines = workflow.split("\n");
  const start = lines.findIndex(line => /^\s{4}inputs:\s*$/.test(line));
  if (start < 0) return [];
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const indent = line.length - line.trimStart().length;
    if (indent <= 4) break;
    const named = line.match(/^\s{6}([a-zA-Z0-9_]+):\s*$/);
    if (named) { out.push({ name: named[1], body: "" }); continue; }
    if (out.length) out[out.length - 1].body += `${line}\n`;
  }
  return out;
}

test("canonical production provider credentials are injected only through Wrangler encrypted secrets", () => {
  const secretNames = [
    "IDFY_API_KEY", "IDFY_ACCOUNT_ID", "IDFY_WEBHOOK_SECRET",
    "PROVIDER_AGREEMENT_ESIGN_PRIVATE_KEY_PKCS8_B64", "PROVIDER_AGREEMENT_ESIGN_PUBLIC_KEY_SPKI_B64",
    "META_WHATSAPP_ACCESS_TOKEN", "META_WHATSAPP_APP_SECRET", "META_WHATSAPP_VERIFY_TOKEN",
    "INTERAKT_API_KEY", "INTERAKT_WEBHOOK_SECRET",
  ];
  for (const name of secretNames) {
    assert.match(workflow, new RegExp(`${name}:\\s*\\$\\{\\{\\s*secrets\\.${name}\\s*\\}\\}`));
    assert.match(workflow, new RegExp(`requiredNames[\\s\\S]*["']${name}["']`));
    assert.doesNotMatch(prodConfig, new RegExp(`${name}:\\s*process\\.env`), `${name} must not be serialized into wrangler vars`);
  }
  assert.match(workflow, /writeFileSync\(process\.env\.SECRETS_FILE, JSON\.stringify\(values\), \{ mode: 0o600 \}\)/);
  assert.match(workflow, /wrangler deploy[^\n]*--secrets-file "\$SECRETS_FILE"/);
  assert.match(workflow, /trap 'rm -f "\$SECRETS_FILE"' EXIT/);
});

test("canonical production provider identifiers are required and written as non-secret Worker vars", () => {
  const variableConfigNames = ["IDFY_URL", "PROVIDER_AGREEMENT_ESIGN_KEY_ID"];
  const protectedIdentifierNames = ["META_WHATSAPP_WABA_ID", "META_WHATSAPP_PHONE_NUMBER_ID"];
  const configNames = [...variableConfigNames, ...protectedIdentifierNames];
  for (const name of configNames) {
    assert.match(prodConfig, new RegExp(`REQUIRED_PRODUCTION_CONFIG[\\s\\S]*["']${name}["']`));
    assert.match(workflow, new RegExp(`cfg\\.vars[\\s\\S]*${name}`));
  }
  for (const name of variableConfigNames)
    assert.match(workflow, new RegExp(`${name}:\\s*\\$\\{\\{\\s*vars\\.${name}\\s*\\}\\}`));
  for (const name of protectedIdentifierNames) {
    assert.match(workflow, new RegExp(`${name}:\\s*\\$\\{\\{\\s*secrets\\.${name}\\s*\\}\\}`));
    assert.doesNotMatch(workflow, new RegExp(`${name}:\\s*\\$\\{\\{\\s*vars\\.${name}\\s*\\}\\}`));
  }
});

test("production voice config defaults closed and does not offer live activation", () => {
  assert.match(prodConfig, /PAWSPACE_VOICE_ENV \|\| "disabled"/);
  assert.match(prodConfig, /PAWSPACE_VOICE_UAT_APPROVED \|\| "false"/);
  assert.match(prodConfig, /\["disabled", "uat"\]/);
  assert.match(workflow, /options: \[disabled, uat\]/);
  const inputs = workflowInputs(workflow);
  const voice = inputs.filter(input => /voice/i.test(input.name));
  assert.ok(voice.length > 0, "the workflow must declare a voice input");
  const voiceEnv = voice.find(input => input.name === "voice_env");
  assert.ok(voiceEnv, "the workflow must declare a voice_env input");
  assert.match(voiceEnv.body, /options: \[disabled, uat\]/, "voice_env must offer only disabled and uat");
  assert.match(voiceEnv.body, /default: disabled/, "voice_env must default to disabled");
  for (const input of voice) {
    const options = input.body.match(/^\s*options: \[.*\]$/m);
    if (!options) continue;
    assert.doesNotMatch(options[0], /\blive\b/i, `${input.name} must not offer a live option`);
  }
});

test("production communication surface exposes the Interakt adapter and signed callback path", () => {
  assert.match(adapters, /whatsapp:\["limechat","meta_whatsapp","interakt"\]/);
  assert.match(communications, /dispatchInteraktWhatsApp/);
  assert.match(communications, /action==="dispatch_interakt"/);
  assert.match(callback, /recordInteraktDeliveryWebhookAtomic/);
  assert.match(callback, /provider==="interakt"/);
});

test("D1 backup and restore guard suites are tracked by the normal test glob", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.match(pkg.scripts.test, /tests\/\*\.test\.mjs/);
  assert.doesNotThrow(() => read("scripts/d1-backup.mjs"));
  assert.doesNotThrow(() => read("scripts/d1-restore.mjs"));
  assert.doesNotThrow(() => read("tests/d1-backup-restore-guards.test.mjs"));
});

test("production deploy reads the production D1 identifier from the protected secret source", () => {
  const secretRefs = workflow.match(/PRODUCTION_D1_ID:\s*\$\{\{\s*secrets\.PRODUCTION_D1_ID\s*\}\}/g) || [];
  assert.ok(secretRefs.length >= 2, "configuration and post-deploy certification must both use secrets.PRODUCTION_D1_ID");
  assert.doesNotMatch(
    workflow,
    /PRODUCTION_D1_ID:\s*\$\{\{\s*vars\.PRODUCTION_D1_ID\s*\}\}/,
    "production deployment must not read PRODUCTION_D1_ID from repository/environment variables",
  );
});
