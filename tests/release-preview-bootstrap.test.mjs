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

/** Run the config script in a throwaway directory holding a minimal build artifact. */
function runConfig(env, vars = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "preview-cfg-"));
  fs.mkdirSync(path.join(dir, "dist/server"), { recursive: true });
  fs.writeFileSync(path.join(dir, "dist/server/wrangler.json"), JSON.stringify({ name: "unset", vars }));
  let status = 0, stdout = "", stderr = "";
  // The path is passed EXPLICITLY, exactly as the workflow passes the candidate's artifact — the tool
  // and the artifact no longer share a checkout, so an implicit relative path would be a lie.
  const artifact = path.join(dir, "dist/server/wrangler.json");
  try {
    stdout = execFileSync("node", [CONFIG_SCRIPT, artifact], { cwd: os.tmpdir(), encoding: "utf8", env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
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
  SHARED_STAGING_D1_ID: "staging-db-5555",
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

test("a preview D1 that IS the shared staging D1 is refused", () => {
  // A preview that lands on the shared staging database corrupts other testers' data just as surely
  // as one that lands on production. Nothing in this repository was comparing against it.
  const result = runConfig({ ...GOOD, RELEASE_PREVIEW_D1_ID: "staging-db-5555" });
  assert.notEqual(result.status, 0, "matching the staging id must exit non-zero");
  assert.match(`${result.stdout}${result.stderr}`, /isolated=false/);
  assert.match(result.stderr, /SHARED_STAGING_D1_ID/);
  assert.equal(result.config.name, "unset", "the build artifact must be left untouched");
  assert.equal(result.config.d1_databases, undefined, "no database binding may be written");
});

test("isolation cannot be ASSUMED: every missing comparator is a refusal, not a pass", () => {
  // The dangerous shape is treating an absent id as "different". Each of these must fail closed.
  for (const key of ["RELEASE_PREVIEW_D1_ID", "PRODUCTION_D1_ID", "SHARED_STAGING_D1_ID", "RELEASE_PREVIEW_WORKER_NAME"]) {
    const result = runConfig({ ...GOOD, [key]: "" });
    assert.notEqual(result.status, 0, `${key} missing must be refused`);
    assert.match(`${result.stdout}${result.stderr}`, /isolated=false/, key);
    assert.match(result.stderr, new RegExp(key), `${key} must be named in the refusal`);
    assert.equal(result.config.name, "unset", `${key}: nothing may be configured`);
    assert.equal(result.config.d1_databases, undefined, `${key}: no database binding may be written`);
  }
});

test("nothing can be built, migrated or deployed after any refusal", () => {
  // The refusal is only half the guarantee; the other half is that every later step is gated on it.
  // Proved two ways: the artifact is untouched, and the workflow gates on the isolation output.
  const refusals = [
    ["preview equals production", { RELEASE_PREVIEW_D1_ID: "production-db-9999" }],
    ["preview equals shared staging", { RELEASE_PREVIEW_D1_ID: "staging-db-5555" }],
    ["preview id missing", { RELEASE_PREVIEW_D1_ID: "" }],
    ["production id missing", { PRODUCTION_D1_ID: "" }],
    ["staging id missing", { SHARED_STAGING_D1_ID: "" }],
    ["shared worker name", { RELEASE_PREVIEW_WORKER_NAME: "pawspace-staging" }],
  ];
  for (const [label, over] of refusals) {
    const result = runConfig({ ...GOOD, ...over });
    assert.notEqual(result.status, 0, label);
    // Nothing usable was written, so a deploy step that ran anyway would have no preview binding.
    assert.equal(result.config.d1_databases, undefined, `${label}: no binding`);
    assert.equal(result.config.vars.PAWSPACE_PAYMENT_ENV, undefined, `${label}: not configured`);
  }
  // And in the workflow, build/config/migrate/deploy each require isolated=true.
  for (const name of [/Build the candidate/, /Configure the dedicated/, /Migrate ONLY/, /Deploy the dedicated preview Worker/]) {
    const step = job.steps.find((s) => name.test(s.name || ""));
    assert.ok(step, `missing step ${name}`);
    assert.match(String(step.if), /steps\.isolation\.outputs\.isolated == 'true'/, `${step.name} must be gated`);
  }
});

test("only a full 40-character sha may be recorded as the version marker", () => {
  for (const sha of ["", "abc", VALID_SHA.slice(0, 39), `${VALID_SHA}0`, "main", "Z".repeat(40)]) {
    const result = runConfig({ ...GOOD, RELEASE_SHA: sha });
    assert.notEqual(result.status, 0, `"${sha}" must be refused`);
  }
  assert.equal(runConfig(GOOD).status, 0, "the valid sha must be accepted");
});

test("no database id is ever printed, on success or on any refusal", () => {
  const scenarios = [
    ["success", runConfig(GOOD)],
    ["equals production", runConfig({ ...GOOD, RELEASE_PREVIEW_D1_ID: "production-db-9999" })],
    ["equals staging", runConfig({ ...GOOD, RELEASE_PREVIEW_D1_ID: "staging-db-5555" })],
    ["missing staging", runConfig({ ...GOOD, SHARED_STAGING_D1_ID: "" })],
  ];
  for (const [label, result] of scenarios) {
    const printed = `${result.stdout}${result.stderr}`;
    for (const id of [GOOD.RELEASE_PREVIEW_D1_ID, GOOD.PRODUCTION_D1_ID, GOOD.SHARED_STAGING_D1_ID]) {
      assert.ok(!printed.includes(id), `${label}: no identifier may reach the log`);
    }
    assert.match(printed, /isolated=(true|false)/, `${label}: the only isolation output is the boolean`);
  }
  assert.match(scenarios[0][1].stdout, /isolated=true/);
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

// --- two checkouts, and the separation between tool and candidate ------------------------------

/** Every `node <script>` the workflow runs, with the script path it names. */
const nodeInvocations = job.steps
  .flatMap((step) => String(step.run || "").split("\n"))
  .map((line) => line.match(/\bnode\b[^|&;]*?\s(\S*(?:scripts|tests)\/\S+\.mjs)/))
  .filter(Boolean)
  .map((match) => match[1]);

const checkouts = job.steps.filter((step) => String(step.uses || "").startsWith("actions/checkout"));
const infraCheckout = checkouts.find((step) => step.with.path === "infra");
const candidateCheckout = checkouts.find((step) => step.with.path === "candidate");

test("there are two checkouts, at two different paths", () => {
  assert.equal(checkouts.length, 2, "one checkout cannot hold both the tools and the candidate");
  assert.ok(infraCheckout, "there must be an infra/ checkout");
  assert.ok(candidateCheckout, "there must be a candidate/ checkout");
  assert.notEqual(infraCheckout.with.path, candidateCheckout.with.path, "the two must not share a directory");
});

test("the candidate checkout is the supplied sha; the infra checkout is this workflow's own commit", () => {
  assert.equal(candidateCheckout.with.ref, "${{ github.event.inputs.expected_sha }}",
    "the candidate must be checked out by the sha the caller approved, never by a branch");
  assert.equal(infraCheckout.with.ref, "${{ github.sha }}",
    "the tools must come from the commit carrying this workflow — the default-branch commit once bootstrapped");
});

test("the candidate is verified to BE the requested sha, and refused if dirty", () => {
  const verify = job.steps.find((step) => /Record the three shas/.test(step.name || ""));
  assert.ok(verify, "there must be a step that records and checks the shas");
  assert.match(String(verify.run), /git -C candidate rev-parse HEAD/, "the candidate's own HEAD must be read");
  assert.match(String(verify.run), /!= "\$EXPECTED_SHA"/, "and compared to the requested sha");
  assert.match(String(verify.run), /git -C candidate status --porcelain/, "the candidate tree must be checked");
  assert.match(String(verify.run), /refusing to deploy/i);
  // Both refusals must actually stop the job.
  assert.equal((String(verify.run).match(/exit 1/g) || []).length >= 2, true, "each refusal must exit non-zero");
});

test("all three shas are recorded independently", () => {
  const step = job.steps.find((s) => s.id === "shas");
  assert.ok(step, "the sha-recording step must be addressable");
  for (const key of ["workflow_bootstrap_sha", "candidate_sha", "requested_sha"]) {
    assert.match(String(step.run), new RegExp(`${key}=`), `${key} must be recorded`);
  }
  const deployed = job.steps.find((s) => /Verify the DEPLOYED sha/.test(s.name || ""));
  assert.ok(deployed, "the deployed sha must be verified in its own step");
  assert.match(String(deployed.run), /deployed_sha=\$EXPECTED_SHA/, "and must equal the requested candidate sha");
});

test("infrastructure tools are executed ONLY from infra/", () => {
  assert.ok(nodeInvocations.length >= 2, `expected the config tool and the gate, saw ${nodeInvocations.length}`);
  for (const script of nodeInvocations) {
    assert.match(script, /(^|\/)infra\//, `${script} must be run out of the infrastructure checkout`);
    assert.ok(!script.startsWith("candidate/"), `${script} must never be run out of the candidate`);
  }
  // Named explicitly, because these are the two the first version of this workflow got wrong.
  assert.ok(!/candidate\/scripts\/release-preview-config\.mjs/.test(workflowText), "the config tool must never be taken from the candidate");
  assert.ok(!/candidate\/tests\/e2e\/release-preview-gate\.mjs/.test(workflowText), "the gate must never be taken from the candidate");
});

test("the config tool is pointed at the CANDIDATE artifact by an explicit path", () => {
  const configure = job.steps.find((step) => /Configure the dedicated preview/.test(step.name || ""));
  assert.ok(configure, "there must be a configure step");
  assert.match(String(configure.run), /infra\/scripts\/release-preview-config\.mjs\s+candidate\/dist\/server\/wrangler\.json/,
    "the tool comes from infra/, the artifact it edits comes from candidate/");
});

test("build, migration and deploy run against candidate/, never infra/", () => {
  for (const name of [/Build the candidate/, /Migrate ONLY/, /Deploy the dedicated preview Worker/, /Install the candidate's dependencies/]) {
    const step = job.steps.find((s) => name.test(s.name || ""));
    assert.ok(step, `missing step ${name}`);
    assert.equal(step["working-directory"], "candidate", `${step.name} must run in candidate/`);
  }
  // Nothing may build or deploy out of the tools checkout.
  for (const step of job.steps) {
    if (step["working-directory"] === "infra") assert.fail(`${step.name} must not run in infra/`);
  }
  assert.ok(!/working-directory:\s*infra\b/.test(workflowText), "no step may use infra/ as its working directory");
});

test("no product source is copied out of the infrastructure checkout", () => {
  // A copy from infra/ into candidate/ would reintroduce exactly the coupling the split removes.
  assert.ok(!/\b(cp|rsync|mv)\b[^\n]*infra\/[^\n]*candidate\//.test(workflowText),
    "product source must never be copied from infra/ into candidate/");
});

test("a candidate that carries NO preview tooling still satisfies the workflow's structure", () => {
  // The real PR-202-shaped case: a product candidate with route and tests and nothing else. The
  // workflow must not require a single file from it beyond the product itself.
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "candidate-fixture-"));
  fs.mkdirSync(path.join(fixture, "app/api/canonical-bookings"), { recursive: true });
  fs.mkdirSync(path.join(fixture, "tests"), { recursive: true });
  fs.writeFileSync(path.join(fixture, "app/api/canonical-bookings/route.ts"), "export async function POST(){}\n");
  fs.writeFileSync(path.join(fixture, "tests/canonical-pet-identity.test.mjs"), "// product test\n");
  fs.writeFileSync(path.join(fixture, "package.json"), JSON.stringify({ scripts: { build: "vinext build" } }));

  // Deliberately absent, and that must be fine.
  for (const absent of ["scripts/release-preview-config.mjs", "tests/e2e/release-preview-gate.mjs", ".github/workflows/deploy-release-preview.yml"]) {
    assert.ok(!fs.existsSync(path.join(fixture, absent)), `the fixture must not carry ${absent}`);
  }
  // Every tool the workflow executes resolves under infra/, so none of them is looked for here.
  for (const script of nodeInvocations) {
    const candidateRelative = script.replace(/^.*?infra\//, "");
    assert.ok(!fs.existsSync(path.join(fixture, candidateRelative)),
      `${candidateRelative} is absent from the candidate — the workflow must not expect it there`);
  }
  fs.rmSync(fixture, { recursive: true, force: true });
});

// --- the workflow's own guarantees ------------------------------------------------------------

test("the workflow is manual and confirmed", () => {
  assert.deepEqual(Object.keys(triggers), ["workflow_dispatch"], "manual dispatch only — never on push");
  assert.deepEqual(Object.keys(triggers.workflow_dispatch.inputs).sort(), ["confirm", "expected_sha"]);
  assert.match(String(job.if), /release-preview/, "the confirm phrase must gate the job");
});

test("the workflow runs in its own environment, one at a time", () => {
  assert.equal(job.environment, "pawspace-release-preview");
  assert.equal(workflow.concurrency.group, "pawspace-release-preview");
  assert.notEqual(workflow.concurrency["cancel-in-progress"], true, "a running preview must not be cancelled mid-verification");
});

test("migration and deploy are gated on isolated=true", () => {
  const gated = job.steps.filter((step) => /Migrate|Deploy the dedicated|Configure the dedicated|Build the candidate/.test(step.name || ""));
  assert.ok(gated.length >= 4, `expected the build, config, migrate and deploy steps to be gated, saw ${gated.length}`);
  for (const step of gated) {
    assert.match(String(step.if), /steps\.isolation\.outputs\.isolated == 'true'/, `${step.name} must be gated on isolation`);
  }
  const isolation = job.steps.find((step) => step.id === "isolation");
  assert.ok(isolation, "there must be an isolation step");
  assert.match(String(isolation.run), /isolated=false/, "it must be able to answer false");
  assert.match(String(isolation.run), /exit 1/, "and fail the job when it does");
});

test("the workflow compares against BOTH production and shared staging, printing neither", () => {
  const isolation = job.steps.find((step) => step.id === "isolation");
  const run = String(isolation.run);
  assert.match(run, /PRODUCTION_D1_ID/, "production must be compared");
  assert.match(run, /SHARED_STAGING_D1_ID/, "shared staging must be compared");
  assert.match(run, /-z "\$\{RELEASE_PREVIEW_D1_ID:-\}"/, "a missing preview id must fail closed");
  assert.match(run, /-z "\$\{SHARED_STAGING_D1_ID:-\}"/, "a missing staging id must fail closed");
  // Only the boolean is emitted; no step may echo an identifier.
  assert.ok(!/echo[^\n]*\$RELEASE_PREVIEW_D1_ID/.test(run), "the preview id must never be echoed");
  assert.ok(!/echo[^\n]*\$PRODUCTION_D1_ID/.test(run), "the production id must never be echoed");
  assert.ok(!/echo[^\n]*\$SHARED_STAGING_D1_ID/.test(run), "the staging id must never be echoed");
  assert.equal((run.match(/isolated=false/g) || []).length >= 4, true, "each refusal path must report isolated=false");
  const configure = job.steps.find((s) => /Configure the dedicated/.test(s.name || ""));
  assert.match(JSON.stringify(configure.env), /SHARED_STAGING_D1_ID/, "the config tool must receive it too");
});

test("the workflow never deploys to a shared or production Worker", () => {
  const isolation = job.steps.find((step) => step.id === "isolation");
  for (const name of ["pawspace-staging", "pawspace-production"]) {
    assert.ok(String(isolation.run).includes(name), `the isolation step must name ${name} as forbidden`);
  }
  const mutating = job.steps.filter((s) => /Deploy|Migrate/.test(s.name || "")).map((s) => s.run).join("");
  assert.ok(!/pawspace-staging/.test(mutating), "no deploy or migrate step may reference the shared staging worker");
});

test("the workflow captures a rollback reference before it deploys", () => {
  const names = job.steps.map((step) => step.name || "");
  const rollback = names.findIndex((name) => /rollback/i.test(name));
  const deploy = names.findIndex((name) => /^Deploy the dedicated/i.test(name));
  assert.ok(rollback >= 0, "there must be a rollback-reference step");
  assert.ok(deploy >= 0, "there must be a deploy step");
  assert.ok(rollback < deploy, "the rollback reference must be captured BEFORE the deploy that would replace it");
});

test("the post-deploy gate runs from infra/ against the HOSTED candidate", () => {
  const gate = job.steps.find((step) => /Post-deploy gate/.test(step.name || ""));
  assert.ok(gate, "there must be a post-deploy gate step");
  assert.match(String(gate.run), /infra\/tests\/e2e\/release-preview-gate\.mjs/, "the gate script must come from infra/");
  assert.equal(gate["working-directory"], "candidate", "but it must run against the candidate's install and hosted deploy");
  assert.match(JSON.stringify(gate.env), /EXPECTED_SHA/, "and be told which candidate is hosted");
  const names = job.steps.map((s) => s.name || "");
  assert.ok(names.findIndex((n) => /Verify the DEPLOYED sha/.test(n)) < names.findIndex((n) => /Post-deploy gate/.test(n)),
    "the hosted sha must be verified before the gate reports on it");
  const upload = job.steps.find((step) => String(step.uses || "").startsWith("actions/upload-artifact"));
  assert.ok(upload, "sanitized evidence must be uploaded");
  assert.match(String(upload.with.path), /release-preview-report\.json/);
});

test("the workflow gives the gate a per-attempt run tag, not a constant", () => {
  const gate = job.steps.find((step) => /Post-deploy gate/.test(step.name || ""));
  const tag = String(gate.env?.PREVIEW_RUN_TAG ?? "");
  assert.ok(tag, "the gate must be given PREVIEW_RUN_TAG");
  assert.match(tag, /github\.run_id/, "it must vary per run");
  // run_id alone is not enough: a re-ATTEMPT reuses it, and the second attempt would replay the
  // first attempt's bookings instead of creating its own.
  assert.match(tag, /github\.run_attempt/, "and per attempt");
  assert.ok(!/['"]gate['"]/.test(tag), "no constant fallback may appear in the hosted tag");
});

test("the workflow points the fresh-D1 bootstrap at the CANDIDATE checkout", () => {
  // The preview database is empty and this candidate has no migrations, so the gate creates the tables
  // itself — from the candidate's own CREATE TABLE text. Aimed at infra/ it would find no product
  // source at all; aimed at nothing it would refuse to start.
  const gate = job.steps.find((step) => /Post-deploy gate/.test(step.name || ""));
  const dir = String(gate.env?.CANDIDATE_DIR ?? "");
  assert.ok(dir, "the gate must be told where the candidate checkout is");
  assert.match(dir, /\/candidate$/, "it must be the candidate checkout");
  assert.ok(!/\/infra/.test(dir), "the schema must never be read out of the infrastructure checkout");
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
