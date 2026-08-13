import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { classifyAuditEntries, SENSITIVE_PATTERNS, TOKEN_DELETION } from "../scripts/cloudflare-audit-check.mjs";

// ---------------------------------------------------------------------------
// scripts/cloudflare-audit-check.mjs finishes an API-token rotation by reading the Cloudflare audit
// log. The classification is pure, so it is tested here without credentials or a network call.
//
// The property that matters most is the one a naive version gets wrong: a token DELETION is the
// expected outcome of a rotation and must not be reported as a finding, while a token CREATION in
// the same window is exactly the finding you are looking for — an attacker's way to keep access
// after you rotate. Both strings contain "token".
// ---------------------------------------------------------------------------
const entry = (type, actor = "ops@pawspace.in", when = "2026-08-12T10:00:00Z") => ({ action: { type }, actor: { email: actor }, when });

test("a token deletion is the rotation succeeding, not a finding", () => {
  const report = classifyAuditEntries([entry("api_token_delete")]);
  assert.equal(report.tokenDeletions, 1, "the deletion must be counted — a rotation is not done without it");
  assert.equal(report.sensitive.length, 0, "deleting the exposed token is the point of the exercise");
});

test("a token creation in the same window IS a finding", () => {
  const report = classifyAuditEntries([entry("api_token_create")]);
  assert.equal(report.sensitive.length, 1, "a new token is how access survives a rotation");
  assert.match(report.sensitive[0].why, /keep access/);
  assert.equal(report.tokenDeletions, 0);
});

test("a rotation that created a replacement and deleted the old one reports both, separately", () => {
  const report = classifyAuditEntries([entry("api_token_create"), entry("api_token_delete")]);
  assert.equal(report.tokenDeletions, 1);
  assert.equal(report.sensitive.length, 1, "the creation still needs confirming by name, even during a legitimate rotation");
});

test("every persistence and exfiltration route is classified as sensitive", () => {
  const cases = [
    ["account_member_invite", /member/i],
    ["logpush_job_create", /moving data out/i],
    ["r2_bucket_create", /exfiltrated/i],
    ["d1_database_delete", /D1 database/i],
    ["worker_script_deploy", /arbitrary code/i],
    ["dns_record_update", /DNS/i],
    ["account_role_update", /permissions/i],
    ["user_password_change", /security setting/i],
  ];
  for (const [action, expected] of cases) {
    const report = classifyAuditEntries([entry(action)]);
    assert.equal(report.sensitive.length, 1, `'${action}' must be flagged for a human look`);
    assert.match(report.sensitive[0].why, expected, `'${action}' must explain why it matters`);
  }
});

test("routine rotation traffic is not flagged, so the signal stays readable", () => {
  const routine = ["secret_put", "d1_query", "account_settings_view", "login"].map((type) => entry(type));
  const report = classifyAuditEntries(routine);
  assert.equal(report.sensitive.length, 0, "a check that flags everything gets ignored");
  assert.equal(report.routine.length, 4);
});

test("entries are counted and grouped even when the action shape is unfamiliar", () => {
  // The audit-log API has more than one generation; an unrecognised shape must still be surfaced
  // rather than silently dropped, or the report would under-count what happened.
  const odd = [{ actor: { id: "abc" }, timestamp: "2026-08-12T10:00:00Z" }, { action: "string_form_action", actor: { type: "system" } }];
  const report = classifyAuditEntries(odd);
  assert.equal(report.total, 2, "nothing may be dropped for having an unexpected shape");
  assert.equal(report.byAction.reduce((sum, [, count]) => sum + count, 0), 2);
  assert.ok(report.byAction.some(([action]) => action.includes("unlabelled")), "an unreadable action is labelled, not hidden");
});

test("the script fails loudly rather than reporting clean when it cannot look", () => {
  const source = fs.readFileSync(new URL("../scripts/cloudflare-audit-check.mjs", import.meta.url), "utf8");
  assert.match(source, /Never report "clean" when the check could not run/, "the intent is documented where it is enforced");
  assert.match(source, /throw new Error\(`Audit log request failed/, "a failed request must throw, not return an empty list");
  assert.match(source, /process\.exit\(2\)/, "an error must exit non-zero so a checklist cannot tick");
  // The honest limitation must travel with the tool, not just live in a chat message.
  assert.match(source, /does NOT record every data-plane request/);
  assert.match(source, /Last used/, "the one signal for data access must be named");
  assert.ok(!/console\.log\([^)]*token[^)]*\$\{token\}/.test(source), "the token itself is never printed");
});

test("the exposure window is required and must predate the leak, not default to today", () => {
  const source = fs.readFileSync(new URL("../scripts/cloudflare-audit-check.mjs", import.meta.url), "utf8");
  assert.match(source, /start it BEFORE the token was first exposed, not today/);
  assert.ok(SENSITIVE_PATTERNS.length >= 8, "the sensitive set must cover persistence, exfiltration and privilege change");
  assert.ok(TOKEN_DELETION.test("api_token_revoke"), "revoke counts as deletion");
  assert.ok(TOKEN_DELETION.test("api_token_roll"), "roll counts as deletion");
});
