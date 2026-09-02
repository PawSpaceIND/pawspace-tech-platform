import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const workflow = read(".github/workflows/deploy-production.yml");
const prodConfig = read("scripts/prod-config.mjs");
const communications = read("app/api/communications/route.ts");
const callback = read("app/api/communication-provider-callback/route.ts");
const adapters = read("lib/communication-adapters.ts");

/**
 * Split a workflow_dispatch inputs block into one entry per input: { name, body }. Linear, so it
 * cannot backtrack, and it keeps each input's options list from being read as a neighbour's.
 */
function workflowInputs(workflow) {
  const lines = workflow.split("\n");
  const start = lines.findIndex(line => /^\s{4}inputs:\s*$/.test(line));
  if (start < 0) return [];
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const indent = line.length - line.trimStart().length;
    if (indent <= 4) break;                                  // left the inputs block entirely
    const named = line.match(/^\s{6}([a-zA-Z0-9_]+):\s*$/); // a new input at the input indent
    if (named) { out.push({ name: named[1], body: "" }); continue; }
    if (out.length) out[out.length - 1].body += `${line}\n`;
  }
  return out;
}

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
  /*
   * Scope the "no live voice" assertion to the voice input's OWN options list.
   *
   * This was a proximity regex - `options: [...live...]` followed within 120 characters by the word
   * "voice" - which reads as "no live option near anything voice-ish". But the workflow's inputs are
   * declared one after another, and maps_env legitimately offers `options: [sandbox, live]` directly
   * above `voice_env:`. The heuristic therefore fired on a neighbouring input rather than on the
   * voice one, failing a workflow that does exactly what it should.
   *
   * Whether live voice is offerable is a property of the voice inputs alone, so the inputs are split
   * apart and read individually. Done with string work rather than one large regex: the obvious
   * `(?:\s+.*\n)*?` block matcher backtracks catastrophically on this file and hangs the suite.
   */
  const inputs = workflowInputs(workflow);
  const voice = inputs.filter(input => /voice/i.test(input.name));
  assert.ok(voice.length > 0, "the workflow must declare a voice input");
  const voiceEnv = voice.find(input => input.name === "voice_env");
  assert.ok(voiceEnv, "the workflow must declare a voice_env input");
  assert.match(voiceEnv.body, /options: \[disabled, uat\]/, "voice_env must offer only disabled and uat");
  assert.match(voiceEnv.body, /default: disabled/, "voice_env must default to disabled");
  // Only the options LINE is searched for "live": the description legitimately says "Live is
  // intentionally unavailable", and reading that sentence as an offer of live voice would be the same
  // over-broad matching this assertion replaced.
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
