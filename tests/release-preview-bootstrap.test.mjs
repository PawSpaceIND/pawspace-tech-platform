import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import yaml from "js-yaml";

// ---------------------------------------------------------------------------
// The release-preview deploy is the one workflow that is allowed to migrate a database and publish a
// Worker outside CI, so the things that keep it safe are not comments — they are assertions.
//
// Two properties matter more than the rest, because both fail silently if they regress:
//
//   ISOLATION. The preview D1 must never be the production D1, and the preview Worker must never be a
//   shared or production Worker. The comparison happens inside the runner and its only output is one
//   word, because a database identifier printed into a build log is readable by anyone with repository
//   read access. A regression here does not throw — it deploys.
//
//   EXACTNESS. The workflow deploys a COMMIT. If it ever checked out a branch instead, a branch that
//   moved between dispatch and checkout would be previewed under the name of the sha someone approved.
//
// The negative cases run the real script as a subprocess against a real temporary build artifact.
// ---------------------------------------------------------------------------

const repo = new URL("..", import.meta.url).pathname;
const CONFIG_SCRIPT = path.join(repo, "scripts/release-preview-config.mjs");
const WORKFLOW_PATH = path.join(repo, ".github/workflows/deploy-release-preview.yml");
const GATE_SCRIPT = path.join(repo, "tests/e2e/release-preview-gate.mjs");

const VALID_SHA = "6452eb06f0ceaab1234ca6cf7fdd94ae73f04598";
const workflowText = fs.readFileSync(WORKFLOW_PATH, "utf8");
const workflow = yaml.load(workflowText);
// `on:` is the YAML boolean true once parsed, which is a trap worth naming rather than rediscovering.
const triggers = workflow.on ?? workflow[true];
const job = workflow.jobs.preview;
const stepsText = JSON.stringify(job.steps);

/** Run the config script in a throwaway directory holding a minimal build artifact. */
function runConfig(env, vars = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "preview-cfg-"));
  fs.mkdirSync(path.join(dir, "dist/server"), { recursive: true });
  fs.writeFileSync(path.join(dir, "dist/server/wrangler.json"), JSON.stringify({ name: "unset", vars }));
  let status = 0, stdout = "", stderr = "";
  try {
    stdout = execFileSync("node", [CONFIG_SCRIPT], { cwd: dir, encoding: "utf8", env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    status = error.status ?? 1;
    stdout = String(error.stdout ?? "");
    stderr = String(error.stderr ?? "");
  }
  let config = null;
  try { config = JSON.parse(fs.readFileSync(path.join(dir, "dist/server/wrangler.json"), "utf8")); } catch { /* unwritten */ }
  fs.rmSync(dir, { recursive: true, force: true });
  return { status, stdout, stderr, config };
}

const GOOD = {
  RELEASE_PREVIEW_WORKER_NAME: "pawspace-release-preview",
  RELEASE_PREVIEW_D1_ID: "preview-db-0000",
  PRODUCTION_D1_ID: "production-db-9999",
  RELEASE_SHA: VALID_SHA,
};

// --- isolation, which is the whole point ------------------------------------------------------

test("a preview D1 that IS the production D1 is refused, and nothing is configured", () => {
  const result = runConfig({ ...GOOD, RELEASE_PREVIEW_D1_ID: "same-db", PRODUCTION_D1_ID: "same-db" });
  assert.notEqual(result.status, 0, "matching ids must exit non-zero");
  assert.match(`${result.stdout}${result.stderr}`, /isolated=false/);
  assert.equal(result.config.name, "unset", "the build artifact must be left untouched");
  assert.equal(result.config.d1_databases, undefined, "no database binding may be written");
});

test("the shared staging and production Worker names are refused", () => {
  for (const name of ["pawspace-staging", "pawspace", "pawspace-production", "pawspace-prod", "PawSpace-Staging"]) {
    const result = runConfig({ ...GOOD, RELEASE_PREVIEW_WORKER_NAME: name });
    assert.notEqual(result.status, 0, `${name} must be refused`);
    assert.match(`${result.stdout}${result.stderr}`, /isolated=false/, name);
    assert.equal(result.config.name, "unset", `${name}: nothing may be configured`);
  }
});

test("isolation cannot be assumed: a missing production id is refused, not treated as different", () => {
  const result = runConfig({ ...GOOD, PRODUCTION_D1_ID: "" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PRODUCTION_D1_ID/);
  assert.equal(result.config.name, "unset");
});

test("a missing preview id or worker name is refused", () => {
  for (const key of ["RELEASE_PREVIEW_D1_ID", "RELEASE_PREVIEW_WORKER_NAME"]) {
    const result = runConfig({ ...GOOD, [key]: "" });
    assert.notEqual(result.status, 0, key);
    assert.equal(result.config.name, "unset", key);
  }
});

test("only a full 40-character sha may be recorded as the version marker", () => {
  for (const sha of ["", "abc", VALID_SHA.slice(0, 39), `${VALID_SHA}0`, "main", "Z".repeat(40)]) {
    const result = runConfig({ ...GOOD, RELEASE_SHA: sha });
    assert.notEqual(result.status, 0, `"${sha}" must be refused`);
  }
  assert.equal(runConfig(GOOD).status, 0, "the valid sha must be accepted");
});

test("neither database id is ever printed, on success or on refusal", () => {
  const ok = runConfig(GOOD);
  const refused = runConfig({ ...GOOD, RELEASE_PREVIEW_D1_ID: "same-db", PRODUCTION_D1_ID: "same-db" });
  for (const [label, result] of [["success", ok], ["refusal", refused]]) {
    const printed = `${result.stdout}${result.stderr}`;
    assert.ok(!printed.includes(GOOD.RELEASE_PREVIEW_D1_ID), `${label}: the preview id must not be logged`);
    assert.ok(!printed.includes(GOOD.PRODUCTION_D1_ID), `${label}: the production id must not be logged`);
    assert.ok(!printed.includes("same-db"), `${label}: no id may be logged`);
  }
  assert.match(ok.stdout, /isolated=true/);
});

// --- what an accepted configuration must contain ----------------------------------------------

test("an isolated configuration binds the preview database and nothing else", () => {
  const { status, config } = runConfig(GOOD);
  assert.equal(status, 0);
  assert.equal(config.name, GOOD.RELEASE_PREVIEW_WORKER_NAME);
  assert.equal(config.topLevelName, GOOD.RELEASE_PREVIEW_WORKER_NAME);
  assert.equal(config.d1_databases.length, 1, "exactly one database may be bound");
  assert.equal(config.d1_databases[0].binding, "DB");
  assert.equal(config.d1_databases[0].database_id, GOOD.RELEASE_PREVIEW_D1_ID);
  assert.equal(config.vars.PAWSPACE_RELEASE_SHA, VALID_SHA);
});

test("money is sandboxed and every live side effect is off", () => {
  const { config } = runConfig(GOOD);
  assert.equal(config.vars.PAWSPACE_PAYMENT_ENV, "sandbox");
  const live = Object.entries(config.vars).filter(([key]) => key.startsWith("PAWSPACE_LIVE_"));
  assert.ok(live.length >= 15, `expected the full live-effect set, saw ${live.length}`);
  for (const [key, value] of live) assert.equal(value, "false", `${key} must be false`);
  // Named individually as well, so deleting one from the script fails here rather than passing on a count.
  for (const key of [
    "PAWSPACE_LIVE_PAYMENTS", "PAWSPACE_LIVE_PAYOUTS", "PAWSPACE_LIVE_REFUNDS", "PAWSPACE_LIVE_BANK_INSTRUCTIONS",
    "PAWSPACE_LIVE_WHATSAPP", "PAWSPACE_LIVE_SMS", "PAWSPACE_LIVE_EMAIL", "PAWSPACE_LIVE_PUSH",
    "PAWSPACE_LIVE_TELEPHONY", "PAWSPACE_LIVE_KYC", "PAWSPACE_LIVE_ESIGN", "PAWSPACE_LIVE_MAPS_BILLING",
    "PAWSPACE_LIVE_EXTERNAL_AI", "PAWSPACE_LIVE_ACCOUNTING", "PAWSPACE_LIVE_TAX_POSTING",
  ]) assert.equal(config.vars[key], "false", `${key} must be present and false`);
});

test("provider activation stays at uat_ready and off the marketplace", () => {
  const { config } = runConfig(GOOD);
  assert.equal(config.vars.PAWSPACE_PROVIDER_ACTIVATION, "uat_ready");
  assert.equal(config.vars.PAWSPACE_PROVIDER_MARKETPLACE_LIVE, "false");
  assert.equal(config.vars.PAWSPACE_PROVIDER_ORDER_ELIGIBLE, "false");
});

test("a credential inherited from the build artifact is stripped, never serialized", () => {
  const { config } = runConfig(GOOD, {
    PAWSPACE_UAT_ACCESS_CODE: "inherited-from-somewhere",
    PAWSPACE_UAT_SIGNING_KEY: "inherited-from-somewhere",
    PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT: "inherited-from-somewhere",
    CLOUDFLARE_API_TOKEN: "inherited-from-somewhere",
  });
  const serialized = JSON.stringify(config);
  assert.ok(!serialized.includes("inherited-from-somewhere"), "no credential may survive into the deploy artifact");
});

// --- the workflow's own guarantees ------------------------------------------------------------

test("the workflow is manual, confirmed, and deploys a sha rather than a branch", () => {
  assert.deepEqual(Object.keys(triggers), ["workflow_dispatch"], "manual dispatch only — never on push");
  assert.deepEqual(Object.keys(triggers.workflow_dispatch.inputs).sort(), ["confirm", "expected_sha"]);
  assert.match(String(job.if), /release-preview/, "the confirm phrase must gate the job");

  const checkout = job.steps.find((step) => String(step.uses || "").startsWith("actions/checkout"));
  assert.ok(checkout, "there must be a checkout step");
  assert.equal(checkout.with.ref, "${{ github.event.inputs.expected_sha }}", "it must check out the sha, not a branch");
  assert.match(stepsText, /rev-parse HEAD/, "and verify what it actually checked out");
  assert.match(stepsText, /git status --porcelain/, "and refuse a dirty tree");
});

test("the workflow runs in its own environment, one at a time", () => {
  assert.equal(job.environment, "pawspace-release-preview");
  assert.equal(workflow.concurrency.group, "pawspace-release-preview");
  assert.notEqual(workflow.concurrency["cancel-in-progress"], true, "a running preview must not be cancelled mid-verification");
});

test("migration and deploy are gated on isolated=true", () => {
  const gated = job.steps.filter((step) => /Migrate|Deploy the dedicated|Configure the dedicated|Build/.test(step.name || ""));
  assert.ok(gated.length >= 4, `expected the build, config, migrate and deploy steps to be gated, saw ${gated.length}`);
  for (const step of gated) {
    assert.match(String(step.if), /steps\.isolation\.outputs\.isolated == 'true'/, `${step.name} must be gated on isolation`);
  }
  const isolation = job.steps.find((step) => step.id === "isolation");
  assert.ok(isolation, "there must be an isolation step");
  assert.match(String(isolation.run), /isolated=false/, "it must be able to answer false");
  assert.match(String(isolation.run), /exit 1/, "and fail the job when it does");
});

test("the workflow never deploys to a shared or production Worker", () => {
  const isolation = job.steps.find((step) => step.id === "isolation");
  for (const name of ["pawspace-staging", "pawspace-production"]) {
    assert.ok(String(isolation.run).includes(name), `the isolation step must name ${name} as forbidden`);
  }
  assert.ok(!/pawspace-staging/.test(String(job.steps.filter((s) => /Deploy|Migrate/.test(s.name || "")).map((s) => s.run).join(""))),
    "no deploy or migrate step may reference the shared staging worker");
});

test("the workflow captures a rollback reference before it deploys", () => {
  const names = job.steps.map((step) => step.name || "");
  const rollback = names.findIndex((name) => /rollback/i.test(name));
  const deploy = names.findIndex((name) => /^Deploy the dedicated/i.test(name));
  assert.ok(rollback >= 0, "there must be a rollback-reference step");
  assert.ok(deploy >= 0, "there must be a deploy step");
  assert.ok(rollback < deploy, "the rollback reference must be captured BEFORE the deploy that would replace it");
});

test("the workflow verifies the hosted sha and runs the post-deploy gate", () => {
  const names = job.steps.map((step) => step.name || "").join("|");
  assert.match(names, /Verify the hosted version marker/);
  assert.match(names, /Post-deploy gate/);
  assert.match(stepsText, /tests\/e2e\/release-preview-gate\.mjs/, "the gate script must be the committed one");
  const upload = job.steps.find((step) => String(step.uses || "").startsWith("actions/upload-artifact"));
  assert.ok(upload, "sanitized evidence must be uploaded");
  assert.match(String(upload.with.path), /release-preview-report\.json/);
});

test("the migration is addressed by database id, not by a name that could resolve elsewhere", () => {
  const migrate = job.steps.find((step) => /Migrate/.test(step.name || ""));
  assert.match(String(migrate.run), /migrations apply "\$PREVIEW_D1"/, "the migration target must be the preview id");
});

// --- nothing sensitive may be committed --------------------------------------------------------

test("no committed preview file carries a credential, a token or a Cloudflare id", () => {
  const files = [WORKFLOW_PATH, CONFIG_SCRIPT, GATE_SCRIPT];
  // A 32-hex-or-longer run, or a uuid, is what an account id, a database id or a generated secret
  // looks like. Placeholders and shas are not: a sha is exactly 40 hex and appears only as an example.
  const SECRET_SHAPES = [
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,          // uuid (D1 ids)
    /\b[A-Za-z0-9_-]{40,}\b/,                                                  // long opaque token
  ];
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    for (const shape of SECRET_SHAPES) {
      const hit = source.match(shape);
      // The one legitimate long run is the example sha in a comment or a default; allow only that.
      if (hit && !/^[0-9a-f]{40}$/i.test(hit[0])) {
        assert.fail(`${path.basename(file)} contains something shaped like a credential: ${hit[0].slice(0, 12)}…`);
      }
    }
    assert.ok(!/CLOUDFLARE_API_TOKEN\s*[:=]\s*["'][^"'$]/.test(source), `${path.basename(file)} must not assign a literal token`);
  }
});

test("the gate script reports statuses and counts, never a credential or an id", () => {
  const source = fs.readFileSync(GATE_SCRIPT, "utf8");
  // The two it genuinely needs come from the environment and are never written into its report.
  for (const name of ["PAWSPACE_UAT_ACCESS_CODE", "PREVIEW_D1"]) {
    assert.ok(source.includes(`process.env.${name}`), `the gate must read ${name} from the environment`);
  }
  // The Cloudflare token is deliberately NOT one of them: wrangler picks it up from the inherited
  // environment, so the gate never holds it in a variable and cannot pass it anywhere. Naming it in a
  // header comment is documentation; READING it would be the regression, so that is what is asserted.
  assert.ok(!/process\.env\.CLOUDFLARE_API_TOKEN/.test(source), "the gate must not read the Cloudflare token into a value");
  assert.ok(!/CLOUDFLARE_API_TOKEN\s*[:=]\s*["'`]/.test(source), "nor assign it a literal");
  const reportWrites = source.match(/report\.[A-Za-z.]+\s*=\s*[^;]+/g) ?? [];
  for (const write of reportWrites) {
    for (const forbidden of ["ACCESS_CODE", "PREVIEW_D1", "CLOUDFLARE_API_TOKEN", "cookie"]) {
      assert.ok(!write.includes(forbidden), `the report must not carry ${forbidden}: ${write}`);
    }
  }
  assert.ok(!/console\.log\([^)]*ACCESS_CODE/.test(source), "the access code must never be logged");
  assert.ok(!/console\.log\([^)]*cookie/.test(source), "the session cookie must never be logged");
});
