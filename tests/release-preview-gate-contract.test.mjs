import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

// ---------------------------------------------------------------------------
// The post-deploy gate's CONTRACT, and the credential validation that runs before the deploy.
//
// tests/release-preview-bootstrap.test.mjs covers the workflow's shape and the isolation refusals. This
// file covers what has to be true for the gate to produce a real answer once ops dispatches it, because
// two of those things were wrong in a way that no structural test could see:
//
//   1. The gate posted `accessCode` to /api/staging-login. That route reads `body.code`, so every
//      sign-in came back 401 and the entire authorized half of the gate — every pet-identity, city/zone,
//      replay, swarm and reconciliation case — was unreachable.
//   2. It signed in as an email nobody had provisioned. /api/staging-login refuses any address that is
//      not an ACTIVE staff account whose role has a definition, and a freshly created preview database
//      contains no staff at all, so the gate could not have got past sign-in even with the right field.
//
// Both failures would have surfaced as "the release candidate is broken" on the first dispatch. Neither
// is observable without either deploying, or asserting the contract here — so it is asserted here.
//
// A third class is covered too: the gate must not report a check it could not RUN as a check that
// PASSED. That is the difference between evidence and reassurance.
// ---------------------------------------------------------------------------
const repo = new URL("..", import.meta.url).pathname;
const CONFIG_SCRIPT = path.join(repo, "scripts/release-preview-config.mjs");
const read = (file) => fs.readFileSync(path.join(repo, file), "utf8");
const gate = read("tests/e2e/release-preview-gate.mjs");
const workflow = read(".github/workflows/deploy-release-preview.yml");

const UAT_CREDENTIALS = ["PAWSPACE_UAT_ACCESS_CODE", "PAWSPACE_UAT_SIGNING_KEY", "PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT"];

// ---------------------------------------------------------------------------
// 1. The two defects that made the gate unable to run.
// ---------------------------------------------------------------------------
test("the gate signs in with the field the login route actually reads", () => {
  const route = read("app/api/staging-login/route.ts");
  assert.match(route, /uatAccessCodeValid\(env as never,text\(body\.code\)\)/, "the route reads body.code — if this changes, the gate must change with it");
  assert.match(gate, /JSON\.stringify\(\{\s*code:\s*ACCESS_CODE/, "so the gate must post `code`");
  assert.doesNotMatch(gate, /accessCode\s*:/, "posting `accessCode` silently 401s every sign-in");
});

test("the gate provisions the staff identities it signs in as", () => {
  const route = read("app/api/staging-login/route.ts");
  assert.match(route, /uatStaffIdentityAllowed/, "the route requires a provisioned staff account");
  assert.match(gate, /INSERT OR REPLACE INTO app_users/, "so the gate must seed one before it tries to sign in");
  assert.match(gate, /INSERT OR REPLACE INTO role_definitions/, "with a role definition, which is where its permissions come from");
  // And it must prove the refusal still works, or the seeding could be hiding a broken check.
  assert.match(gate, /refuses an email that is not a provisioned staff account/, "an unprovisioned email must still be refused");
});

test("the gate creates the tables it seeds, from the candidate's own DDL", () => {
  // A fresh preview database has no scheduling tables: /api/canonical-bookings creates the tables it
  // owns, but the reservation rows the gate must seed belong to routes it never calls. Seeding without
  // creating them fails on "no such table" before the first booking.
  assert.match(gate, /function ddlFor\(/, "the gate must be able to obtain a table's DDL");
  assert.match(gate, /CANDIDATE_DIR/, "and it must come from the candidate that is actually deployed");
  for (const table of ["app_users", "role_definitions", "scheduling_reservations", "scheduling_assignment_decisions"]) {
    assert.ok(gate.includes(table), `${table} must be part of the gate's setup`);
    assert.ok(!new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\(`).test(gate), `${table}'s DDL must not be copied into the gate, where it would drift from the deployed schema`);
  }
});

// ---------------------------------------------------------------------------
// 2. Coverage: every case the preview environment exists to answer.
// ---------------------------------------------------------------------------
test("the gate covers every case the preview exists to answer", () => {
  const required = [
    [/UAT sign-in establishes a session/, "UAT sign-in"],
    [/hosted version marker carries the deployed sha/, "hosted sha verification, inside the gate"],
    [/sourceId is refused 400 every time/, "pet-identity regression"],
    [/converges on ONE canonical pet/, "identity convergence on real D1 type affinity"],
    [/does not erase the saved profile/, "pet-profile preservation"],
    [/matches its reservation is created/, "city/zone match"],
    [/mismatch is refused 409/, "city/zone mismatch"],
    [/it persists the reserved city and zone/, "city/zone actually stored"],
    [/unauthenticated GET is refused/, "gateway authorization, anonymous"],
    [/GET without bookings\.view is refused/, "gateway authorization by permission"],
    [/POST without scheduling\.book is refused/, "gateway authorization on write"],
    [/cannot book for a customer it does not own/, "canonical customer ownership"],
    [/cannot manufacture authorization/, "forged identity headers"],
    [/replay by idempotency key/, "historical replay"],
    [/replay by schedule group/, "historical replay, second half"],
    [/replays even when the replay payload would now be refused/, "replay ordering against the invariant"],
    [/simultaneous identical submits produce exactly one booking/, "real concurrency"],
    [/duplicate submit is prevented/, "duplicate submit"],
    [/cross-role journey/, "cross-role golden journey"],
    [/synthetic swarm all confirmed/, "synthetic swarm"],
    [/reconciles to exactly one payment/, "D1 reconciliation"],
    [/no stored booking contradicts its reservation/, "reconciliation of the city/zone invariant"],
    [/Worker log shows no unhandled exception/, "Worker log error inspection"],
    [/audited as a failure/, "audit-log error inspection"],
    [/no provider became live in the preview/, "nothing went live"],
  ];
  const missing = required.filter(([pattern]) => !pattern.test(gate)).map(([, name]) => name);
  assert.deepEqual(missing, [], `the gate is missing required coverage: ${missing.join(", ")}`);
});

test("the swarm is the specified size, and concurrency is genuinely concurrent", () => {
  assert.match(gate, /PREVIEW_SWARM_SIZE \|\| 60/, "the swarm defaults to 60 bookings");
  // Sequential requests cannot expose a race. The point of running against real D1 is that eight
  // requests can be in flight at once, which one event loop and a serialised shim cannot reproduce.
  assert.match(gate, /await Promise\.all\(Array\.from\(\{ length: 8 \}/, "the duplicate submits must be issued simultaneously");
});

test("the gate exercises more than one role, so authorization is tested rather than assumed", () => {
  const roles = [...gate.matchAll(/code:\s*"(gate_[a-z]+)"/g)].map((m) => m[1]);
  assert.ok(roles.length >= 3, `expected several distinct roles, found ${roles.join(", ") || "none"}`);
  assert.ok(gate.includes("bookings.view") && gate.includes("scheduling.book"), "the two permissions this route's policy names must both appear");
  // Permissions are seeded explicitly rather than taken from the product's default role list: asserting
  // against that list would make the gate a test of a constant instead of the deployed authorization path.
  assert.doesNotMatch(gate, /defaultRoles|platform-security/, "the gate must not read the product's role definitions to decide what to expect");
});

// ---------------------------------------------------------------------------
// 3. An unrunnable check is not a passing check.
// ---------------------------------------------------------------------------
test("a check the gate could not run is reported as not run, never as a pass", () => {
  assert.match(gate, /function unavailable\(/, "there must be a third outcome");
  assert.match(gate, /ok:\s*null/, "recorded as neither pass nor fail");
  assert.match(gate, /report\.warnings\.push/, "carried into the evidence artifact");
  assert.match(gate, /report\.checks\.filter\(\(c\) => c\.ok === true\)\.length/, "and the pass count must be strict, so a null cannot inflate it");
  assert.match(gate, /not run/, "and the summary must say so out loud");
});

test("the gate still fails the run when a check fails", () => {
  assert.match(gate, /process\.exit\(failures === 0 \? 0 : 1\)/, "a failed check must fail the workflow step");
  assert.match(gate, /if \(!ok\) failures\+\+/, "and failures must actually be counted");
});

test("the gate reports no credential, cookie or database id", () => {
  for (const name of UAT_CREDENTIALS) {
    assert.doesNotMatch(gate, new RegExp(`report[^\\n]*${name}`), `${name} must not reach the evidence artifact`);
  }
  assert.doesNotMatch(gate, /console\.log\([^)]*ACCESS_CODE/, "the access code must never be printed");
  assert.doesNotMatch(gate, /console\.log\([^)]*\bcookie\b/, "nor a session cookie");
  assert.doesNotMatch(gate, /console\.log\([^)]*PREVIEW_D1/, "nor the database id");
  // wrangler's own stderr echoes the arguments it was given, which include the database id.
  assert.doesNotMatch(gate, /detail:\s*String\(error\.stderr/, "wrangler's stderr must not be reported verbatim");
  assert.match(gate, /missing\.join\(", "\)/, "a misconfigured gate reports variable NAMES, not values");
});

// ---------------------------------------------------------------------------
// 4. Credential validation, executed for real.
// ---------------------------------------------------------------------------
const GOOD = {
  RELEASE_PREVIEW_WORKER_NAME: "pawspace-release-preview",
  RELEASE_PREVIEW_D1_ID: "preview-db-0000",
  PRODUCTION_D1_ID: "production-db-9999",
  RELEASE_SHA: "3fbeded29d3a8020b28c1be4dd51e9f11007d439",
  PAWSPACE_UAT_ACCESS_CODE: "not-a-real-access-code-for-tests-only",
  PAWSPACE_UAT_SIGNING_KEY: "not-a-real-signing-key-for-tests-only",
  PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT: "not-a-real-identity-secret-for-tests",
};

/** Run the real configuration tool against a throwaway build artifact, as the workflow does. */
function runConfig(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "preview-cred-"));
  const artifact = path.join(dir, "dist/server/wrangler.json");
  fs.mkdirSync(path.dirname(artifact), { recursive: true });
  fs.writeFileSync(artifact, JSON.stringify({ name: "unset", vars: {} }));
  try {
    const stdout = execFileSync(process.execPath, [CONFIG_SCRIPT, artifact], { cwd: os.tmpdir(), encoding: "utf8", env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    return { status: 0, stdout, stderr: "", config: JSON.parse(fs.readFileSync(artifact, "utf8")) };
  } catch (error) {
    return { status: error.status ?? 1, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? ""), config: JSON.parse(fs.readFileSync(artifact, "utf8")) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("real execution: a missing credential fails the deploy closed", () => {
  for (const name of UAT_CREDENTIALS) {
    const env = { ...GOOD, [name]: "" };
    const result = runConfig(env);
    assert.notEqual(result.status, 0, `${name} must have no default`);
    assert.match(result.stderr, new RegExp(name), "the refusal must name the variable");
    assert.match(result.stderr, /secrets\./, "and say where to supply it");
    assert.equal(result.config.name, "unset", "nothing may be configured");
  }
});

test("real execution: a credential below the 32-character floor is refused", () => {
  for (const name of UAT_CREDENTIALS) {
    assert.notEqual(runConfig({ ...GOOD, [name]: "a".repeat(31) }).status, 0, `31 characters must be refused for ${name}`);
  }
  assert.equal(runConfig(GOOD).status, 0, "and a value that clears the floor is accepted");
});

test("real execution: a hand-written project credential is refused without naming the burned values", () => {
  // Every credential this repository has leaked began with the project's own name. The check refuses
  // that shape rather than a list of literals, so the burned values stay in exactly the two files
  // tests/staging-auth-secrets.test.mjs allows to contain them.
  const result = runConfig({ ...GOOD, PAWSPACE_UAT_SIGNING_KEY: "pawspace-staging-signing-key-long-enough" });
  assert.notEqual(result.status, 0, "a project-shaped credential must be refused");
  assert.match(result.stderr, /public forever/, "and the refusal must explain why");
  assert.match(result.stderr, /openssl rand/, "and say how to make a good one");
  assert.match(read("scripts/release-preview-config.mjs"), /\^pawspace\[-_\]/, "the check is a shape, not a list of leaked values");
});

test("real execution: a credential problem does not pretend the environment is unisolated", () => {
  // The two are different failures and the log has to distinguish them: "isolated=false" means the
  // deploy was pointed at the wrong Worker or database, and that is not what a weak secret means.
  const weak = runConfig({ ...GOOD, PAWSPACE_UAT_ACCESS_CODE: "short" });
  assert.notEqual(weak.status, 0);
  assert.match(weak.stderr, /^isolated=true$/m, "the environment was still the right one");

  const wrongWorker = runConfig({ ...GOOD, RELEASE_PREVIEW_WORKER_NAME: "pawspace-staging" });
  assert.match(wrongWorker.stderr, /^isolated=false$/m, "whereas a shared Worker is not an isolated preview");
});

test("real execution: no credential value reaches the log or the artifact", () => {
  const result = runConfig(GOOD);
  assert.equal(result.status, 0, result.stderr);
  const printed = `${result.stdout}${result.stderr}`;
  for (const name of UAT_CREDENTIALS) {
    assert.ok(!printed.includes(GOOD[name]), `${name}'s value must not be logged`);
    assert.ok(!JSON.stringify(result.config).includes(GOOD[name]), `${name}'s value must not be serialized`);
    assert.ok(!(name in result.config.vars), `${name} must not become a plaintext Worker var`);
  }
});

test("the workflow supplies the credentials it expects the tool to validate", () => {
  const configureStep = workflow.slice(workflow.indexOf("Configure the dedicated preview"), workflow.indexOf("rollback reference"));
  for (const name of UAT_CREDENTIALS) {
    assert.match(configureStep, new RegExp(`${name}:\\s*\\$\\{\\{\\s*secrets\\.${name}\\s*\\}\\}`), `${name} must be passed to the configure step, or the validation has nothing to check`);
  }
  // And the preview Worker name it refuses must include the UAT Worker, in the runner as well as the tool.
  assert.match(workflow, /pawspace-uat\)/, "the runner's own refusal list must match the tool's");
});
