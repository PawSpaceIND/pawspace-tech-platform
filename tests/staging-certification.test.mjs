/**
 * Executed evidence for the staging certification gate.
 *
 * The gate's whole purpose is to refuse, so every case here is a way a deploy could look fine and not
 * be. The adapters are injected, so each check is driven against a world constructed to fail exactly
 * one thing - which is the only way to know a green result means what it says rather than meaning the
 * check never ran.
 *
 * The isolation cases come first because they are the only ones that must THROW. Every other check
 * records a failure and lets the report continue; pointing the gate at the wrong database and then
 * continuing would do the damage the gate exists to prevent.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  runStagingCertification, assertStagingIsolation, stagingEvidenceArtifact, StagingIsolationRefused,
  STAGING_SECRET_NAMES, SMOKE_ROUTES, REQUIRED_STAFF_IDENTITIES, activeVersionId,
  deployedConfigFromVersion, versionMessage, runStagingIsolationPreflight, isMainModule,
} from "./e2e/staging-certification.mjs";
import { pathToFileURL } from "node:url";

const SHA = "a95ed7adbbf513ed78e4b88b22afa38ce3b5c940";
const ACCESS_CODE = "a-32-character-uat-access-code!!";
const STAGING_D1_ID = "11111111-2222-4333-8444-555555555555";
const PRODUCTION_D1_ID = "99999999-8888-4777-8666-555555555555";

const goodConfig = () => ({
  name: "pawspace-staging",
  d1_databases: [{ binding: "DB", database_name: "pawspace-staging", database_id: STAGING_D1_ID }],
  vars: { PAWSPACE_PAYMENT_ENV: "sandbox", PAWSPACE_UAT_LOGIN: "on" },
});
const goodEnv = () => ({ EXPECTED_SHA: SHA, WORKER_NAME: "pawspace-staging", STAGING_D1_ID, PRODUCTION_D1_ID, PRODUCTION_WORKER_NAME: "pawspace-production", ACCESS_CODE });

/** A world where everything is right. Each test breaks exactly one thing. */
function world(over = {}) {
  const seeded = new Map(REQUIRED_STAFF_IDENTITIES.map(identity => [identity.email, { email: identity.email, status: "active", role_code: identity.role }]));
  const calls = { http: [], d1: [] };
  const base = {
    calls,
    env: goodEnv(),
    log: () => {},
    deployedConfig: async () => goodConfig(),
    liveVersionMessage: async () => `staging ${SHA}`,
    rollbackReference: async () => "version 0f1e2d3c",
    d1: async (sql) => {
      calls.d1.push(sql);
      const email = /email='([^']+)'/.exec(sql)?.[1];
      const row = email ? seeded.get(email) : undefined;
      return row ? [row] : [];
    },
    http: async (method, path, options = {}) => {
      calls.http.push({ method, path, options });
      if (path === "/api/staging-login") {
        const ok = options.body?.code === ACCESS_CODE && seeded.has(options.body?.email);
        return ok
          ? { status: 200, headers: { "set-cookie": "pawspace_session=signed-value; Path=/; HttpOnly" } }
          : { status: 403, headers: {} };
      }
      if (options.headers?.cookie) return { status: 200, headers: {} };
      return { status: 401, headers: {} };
    },
    seeded,
  };
  return { ...base, ...over };
}
const failed = (report, fragment) => report.checks.filter(check => !check.ok && check.name.includes(fragment));

// ---------------------------------------------------------------------------
// Isolation refuses rather than reports
// ---------------------------------------------------------------------------
test("a correctly isolated staging target passes isolation", () => {
  assert.doesNotThrow(() => assertStagingIsolation({ workerName: "pawspace-staging", deployedConfig: goodConfig(), env: goodEnv() }));
});

test("every way of pointing at something that is not isolated staging is refused", () => {
  const cases = [
    ["a different worker name", { workerName: "pawspace-production" }, /not the isolated pawspace-staging/],
    ["the production worker", { workerName: "pawspace-staging", env: { ...goodEnv(), PRODUCTION_WORKER_NAME: "pawspace-staging" } }, /is the production worker/],
    ["the production database id", { deployedConfig: { ...goodConfig(), d1_databases: [{ binding: "DB", database_name: "pawspace-staging", database_id: PRODUCTION_D1_ID }] } }, /is the production database/],
    ["a database that is not the configured staging one", { deployedConfig: { ...goodConfig(), d1_databases: [{ binding: "DB", database_name: "pawspace-staging", database_id: "77777777-6666-4555-8444-333333333333" }] } }, /not the configured staging database id/],
    ["a differently named database", { deployedConfig: { ...goodConfig(), d1_databases: [{ binding: "DB", database_name: "pawspace-shared", database_id: STAGING_D1_ID }] } }, /not pawspace-staging/],
    ["a second D1 binding", { deployedConfig: { ...goodConfig(), d1_databases: [{ binding: "DB", database_name: "pawspace-staging", database_id: STAGING_D1_ID }, { binding: "OTHER", database_name: "pawspace-shared", database_id: PRODUCTION_D1_ID }] } }, /declares 2 D1 bindings/],
    ["no D1 binding at all", { deployedConfig: { ...goodConfig(), d1_databases: [] } }, /declares 0 D1 bindings/],
    ["a binding under another name", { deployedConfig: { ...goodConfig(), d1_databases: [{ binding: "SHARED_DB", database_name: "pawspace-staging", database_id: STAGING_D1_ID }] } }, /not DB/],
  ];
  for (const [label, over, expected] of cases) {
    assert.throws(
      () => assertStagingIsolation({ workerName: "pawspace-staging", deployedConfig: goodConfig(), env: goodEnv(), ...over }),
      expected, `${label} was accepted as isolated staging`);
  }
});

test("the gate throws before running a single check when isolation fails, so nothing touches the wrong database", async () => {
  const state = world({ env: { ...goodEnv(), WORKER_NAME: "pawspace-production" } });
  await assert.rejects(runStagingCertification(state), StagingIsolationRefused);
  assert.deepEqual(state.calls.d1, [], "no statement may be executed against a target that failed isolation");
  assert.deepEqual(state.calls.http, [], "no request may be sent to a target that failed isolation");
});

test("an unreadable deployed configuration is a refusal, not an assumption of isolation", async () => {
  const state = world({ deployedConfig: async () => { throw new Error("wrangler could not read the deployment"); } });
  await assert.rejects(runStagingCertification(state), StagingIsolationRefused);
  assert.deepEqual(state.calls.d1, []);
});

test("mixed or partial active deployments are refused before a version can be certified", () => {
  assert.equal(activeVersionId({ versions: [{ version_id: "v1", percentage: 100 }] }), "v1");
  for (const status of [
    { versions: [{ version_id: "v1", percentage: 50 }, { version_id: "v2", percentage: 50 }] },
    { versions: [{ version_id: "v1", percentage: 99 }] },
    { versions: [] },
  ]) assert.throws(() => activeVersionId(status), StagingIsolationRefused);
});

test("the deployed config and SHA come from the same active version resource", async () => {
  const version = {
    id: "v1", annotations: { "workers/message": `staging ${SHA}` },
    resources: { bindings: [
      { type: "d1", name: "DB", id: STAGING_D1_ID },
      { type: "plain_text", name: "PAWSPACE_PAYMENT_ENV", text: "sandbox" },
      { type: "plain_text", name: "PAWSPACE_UAT_LOGIN", text: "on" },
    ] },
  };
  const config = deployedConfigFromVersion(version);
  assert.equal(config.d1_databases[0].database_id, STAGING_D1_ID);
  assert.equal(versionMessage(version), `staging ${SHA}`);
  await assert.doesNotReject(runStagingIsolationPreflight({ deployedConfig: async () => config, liveVersionMessage: async () => versionMessage(version), env: goodEnv() }));
});

// ---------------------------------------------------------------------------
// The happy path, so the negatives below are not passing for the wrong reason
// ---------------------------------------------------------------------------
test("a correct staging deploy certifies, and the report names the sha and the smoke coverage", async () => {
  const report = await runStagingCertification(world());
  assert.equal(report.ok, true, JSON.stringify(report.checks.filter(check => !check.ok), null, 2));
  assert.equal(report.failures, 0);
  assert.equal(report.sha, SHA);
  assert.equal(report.counts.smokeRoutesAnswered, SMOKE_ROUTES.length);
  assert.equal(report.rollbackReferenceRecorded, true);
  assert.deepEqual(report.unavailable, []);
});

// ---------------------------------------------------------------------------
// Exact SHA
// ---------------------------------------------------------------------------
test("a branch name or short sha is not an identified build", async () => {
  for (const sha of ["main", "a95ed7a", "", "A95ED7ADBBF513ED78E4B88B22AFA38CE3B5C940x"]) {
    const report = await runStagingCertification(world({ env: { ...goodEnv(), EXPECTED_SHA: sha } }));
    assert.equal(report.ok, false, `EXPECTED_SHA=${JSON.stringify(sha)} was accepted`);
    assert.equal(failed(report, "exact commit sha").length, 1);
  }
});

test("a deploy whose live version was published for a different sha fails", async () => {
  const other = "b".repeat(40);
  const report = await runStagingCertification(world({ liveVersionMessage: async () => `staging ${other}` }));
  assert.equal(report.ok, false);
  assert.equal(failed(report, "published for exactly this sha").length, 1);
});

test("a version message that merely contains the sha does not satisfy the exact match", async () => {
  const report = await runStagingCertification(world({ liveVersionMessage: async () => `redeploy of staging ${SHA} (retry)` }));
  assert.equal(report.ok, false);
  assert.equal(failed(report, "published for exactly this sha").length, 1);
});

test("the requested sha existing SOMEWHERE in deployment history does not certify it", async () => {
  // The gate used to search the whole `versions list` output, so a version deployed for this sha and
  // then superseded still satisfied it - certifying a build that is no longer serving requests. Only
  // the ACTIVE version's message counts.
  const superseded = "c".repeat(40);
  const report = await runStagingCertification(world({ liveVersionMessage: async () => `staging ${superseded}` }));
  assert.equal(report.ok, false);
  const failure = failed(report, "published for exactly this sha")[0];
  assert.match(failure.detail, /deployment drift/);
});

test("an empty live version message is a failure, not a pass", async () => {
  for (const live of [async () => "", async () => "   ", async () => null]) {
    const report = await runStagingCertification(world({ liveVersionMessage: live }));
    assert.equal(report.ok, false);
    assert.equal(failed(report, "published for exactly this sha").length, 1);
  }
});

test("a live version that cannot be read FAILS rather than being skipped", async () => {
  const report = await runStagingCertification(world({ liveVersionMessage: async () => { throw new Error("api unavailable"); } }));
  assert.equal(report.ok, false);
  assert.ok(report.unavailable.includes("the LIVE version was published for exactly this sha"));
});

// ---------------------------------------------------------------------------
// Environment mode
// ---------------------------------------------------------------------------
test("staging must be in sandbox payment mode with UAT sign-in on", async () => {
  for (const [name, bad] of [["PAWSPACE_PAYMENT_ENV", "live"], ["PAWSPACE_UAT_LOGIN", "off"], ["PAWSPACE_PAYMENT_ENV", ""]]) {
    const vars = { ...goodConfig().vars, [name]: bad };
    const report = await runStagingCertification(world({ deployedConfig: async () => ({ ...goodConfig(), vars }) }));
    assert.equal(report.ok, false, `${name}=${bad} certified`);
    assert.ok(failed(report, `environment mode: ${name}`).length > 0 || failed(report, "live-approval flag").length > 0);
  }
});

test("any live or approval flag riding along on staging fails certification", async () => {
  const flags = [
    { PAWSPACE_VOICE_ENV: "live" },
    { PAWSPACE_VOICE_LIVE_APPROVED: "true" },
    { PAWSPACE_VOICE_RECORDING_APPROVED: "1" },
    { PAWSPACE_VOICE_SALES_OUTBOUND_APPROVED: "yes" },
    { PAWSPACE_VOICE_ENV: "PRODUCTION" },
  ];
  for (const flag of flags) {
    const report = await runStagingCertification(world({ deployedConfig: async () => ({ ...goodConfig(), vars: { ...goodConfig().vars, ...flag } }) }));
    assert.equal(report.ok, false, `${JSON.stringify(flag)} certified`);
    assert.equal(failed(report, "live-approval flag").length, 1);
  }
});

test("a UAT credential serialized into the deployed configuration fails certification", async () => {
  // wrangler.json is a generated artifact and anything under vars is a plaintext Worker variable
  // readable in the dashboard. This is the exact defect the deploy script was fixed for; the gate
  // now proves the fix held at the DEPLOYED artifact rather than in the script that wrote it.
  for (const name of STAGING_SECRET_NAMES) {
    const report = await runStagingCertification(world({ deployedConfig: async () => ({ ...goodConfig(), vars: { ...goodConfig().vars, [name]: "a-real-looking-credential-value" } }) }));
    assert.equal(report.ok, false, `${name} in vars certified`);
    assert.equal(failed(report, "no UAT credential is serialized").length, 1);
  }
});

// ---------------------------------------------------------------------------
// Seeds and staff sign-in are two different facts
// ---------------------------------------------------------------------------
test("an unseeded staff identity fails, and its sign-in check is not silently skipped", async () => {
  const state = world();
  state.seeded.delete("manager@pawspace.in");
  const report = await runStagingCertification(state);
  assert.equal(report.ok, false);
  assert.equal(failed(report, "seed: manager").length, 1);
  assert.equal(failed(report, "sign-in: manager").length, 1, "a missing seed must not make the sign-in check disappear");
});

test("a staff row whose role has no definition fails, because UAT sign-in refuses it", async () => {
  const state = world();
  state.seeded.set("admin@pawspace.in", { email: "admin@pawspace.in", status: "active", role_code: "" });
  const report = await runStagingCertification(state);
  assert.equal(report.ok, false);
  assert.equal(failed(report, "seed: admin").length, 1);
});

test("an inactive staff row fails, because UAT sign-in refuses any email that is not active", async () => {
  const state = world();
  state.seeded.set("founder@pawspace.in", { email: "founder@pawspace.in", status: "suspended", role_code: "founder" });
  const report = await runStagingCertification(state);
  assert.equal(report.ok, false);
  assert.equal(failed(report, "seed: founder").length, 1);
});

test("a seeded identity that cannot actually sign in fails - the row existing is not the claim", async () => {
  const state = world({
    http: async (method, path, options = {}) => {
      if (path === "/api/staging-login") return { status: 500, headers: {} };
      return options.headers?.cookie ? { status: 200, headers: {} } : { status: 401, headers: {} };
    },
  });
  const report = await runStagingCertification(state);
  assert.equal(report.ok, false);
  assert.equal(failed(report, "sign-in:").length, REQUIRED_STAFF_IDENTITIES.length);
});

test("a sign-in that returns success with no session cookie is not a sign-in", async () => {
  const report = await runStagingCertification(world({
    http: async (method, path, options = {}) => {
      if (path === "/api/staging-login") return { status: 200, headers: {} };
      return options.headers?.cookie ? { status: 200, headers: {} } : { status: 401, headers: {} };
    },
  }));
  assert.equal(report.ok, false);
  assert.ok(failed(report, "sign-in:").length > 0);
});

test("the gate reads set-cookie from a Headers object as well as a plain record", async () => {
  const report = await runStagingCertification(world({
    http: async (method, path, options = {}) => {
      if (path === "/api/staging-login") return { status: 200, headers: new Headers({ "set-cookie": "pawspace_session=abc; Path=/" }) };
      return options.headers?.cookie ? { status: 200, headers: new Headers() } : { status: 401, headers: new Headers() };
    },
  }));
  assert.equal(report.ok, true, JSON.stringify(report.checks.filter(check => !check.ok)));
});

// ---------------------------------------------------------------------------
// Hosted smoke pack
// ---------------------------------------------------------------------------
test("a route that does not answer for a real staff session fails, and is named", async () => {
  const broken = SMOKE_ROUTES[2];
  const report = await runStagingCertification(world({
    http: async (method, path, options = {}) => {
      if (path === "/api/staging-login") return { status: 200, headers: { "set-cookie": "pawspace_session=v" } };
      if (path === broken && options.headers?.cookie) return { status: 500, headers: {} };
      return options.headers?.cookie ? { status: 200, headers: {} } : { status: 401, headers: {} };
    },
  }));
  assert.equal(report.ok, false);
  const failure = failed(report, "answers for a real staff session")[0];
  assert.ok(failure.detail.includes(broken), failure.detail);
});

test("a route that answers WITHOUT a session fails certification", async () => {
  // A staging route open to the world is worse than one that is down: staging carries real-shaped
  // customer data and is reachable from the internet.
  const open = SMOKE_ROUTES[1];
  const report = await runStagingCertification(world({
    http: async (method, path, options = {}) => {
      if (path === "/api/staging-login") return { status: 200, headers: { "set-cookie": "pawspace_session=v" } };
      if (path === open) return { status: 200, headers: {} };
      return options.headers?.cookie ? { status: 200, headers: {} } : { status: 401, headers: {} };
    },
  }));
  assert.equal(report.ok, false);
  const failure = failed(report, "refuses an anonymous caller")[0];
  assert.ok(failure.detail.includes(open), failure.detail);
});

test("with no founder session the smoke pack is reported as not run rather than as passing", async () => {
  const state = world();
  state.seeded.delete("founder@pawspace.in");
  const report = await runStagingCertification(state);
  assert.equal(report.ok, false);
  assert.ok(report.unavailable.includes("hosted smoke pack answers for a real staff session"));
  assert.ok(report.unavailable.includes("hosted smoke pack refuses an anonymous caller"));
});

test("the smoke pack is read-only: certification never posts to a business route", async () => {
  const state = world();
  await runStagingCertification(state);
  const writes = state.calls.http.filter(call => call.method !== "GET" && call.path !== "/api/staging-login");
  assert.deepEqual(writes, [], "certification must not create records in a database testers are about to use");
});

// ---------------------------------------------------------------------------
// Rollback reference
// ---------------------------------------------------------------------------
test("a deploy with no recorded predecessor is not certified", async () => {
  for (const reference of [async () => "", async () => "   ", async () => null]) {
    const report = await runStagingCertification(world({ rollbackReference: reference }));
    assert.equal(report.ok, false);
    assert.equal(failed(report, "rollback reference").length, 1);
    assert.equal(report.rollbackReferenceRecorded, false);
  }
});

test("a rollback reference that cannot be read FAILS rather than being assumed present", async () => {
  const report = await runStagingCertification(world({ rollbackReference: async () => { throw new Error("no such worker"); } }));
  assert.equal(report.ok, false);
  assert.ok(report.unavailable.includes("a rollback reference was recorded before this deploy"));
});

// ---------------------------------------------------------------------------
// The artifact
// ---------------------------------------------------------------------------
test("the evidence artifact carries the decision trail and no sensitive value", async () => {
  const report = await runStagingCertification(world());
  const artifact = stagingEvidenceArtifact(report, [ACCESS_CODE, STAGING_D1_ID, PRODUCTION_D1_ID]);
  assert.ok(artifact.includes("the deploy target is the isolated staging worker"));
  assert.ok(!artifact.includes(ACCESS_CODE));
  assert.ok(!artifact.includes(STAGING_D1_ID));
});

test("a report that somehow carries a sensitive value is refused rather than scrubbed on the way out", async () => {
  const report = await runStagingCertification(world());
  report.checks.push({ name: "hand-added", ok: true, detail: ACCESS_CODE });
  assert.throws(() => stagingEvidenceArtifact(report, [ACCESS_CODE]), /contains a sensitive value/);
});

test("a JSON-escaped sensitive value is refused too", async () => {
  const secret = 'uat-secret-with-"quote"-and-\\slash';
  const report = { ok: false, detail: secret };
  assert.throws(() => stagingEvidenceArtifact(report, [secret]), /contains a sensitive value/);
});

test("CLI entrypoint detection handles paths containing hash, question mark and percent", () => {
  for (const path of ["/tmp/staging#gate.mjs", "/tmp/staging?gate.mjs", "/tmp/staging%gate.mjs"]) {
    assert.equal(isMainModule(path, pathToFileURL(path).href), true);
  }
});

test("a failure detail mentioning the database id is redacted before it reaches the artifact", async () => {
  const report = await runStagingCertification(world({
    rollbackReference: async () => { throw new Error(`no deployment history for ${STAGING_D1_ID}`); },
  }));
  const artifact = stagingEvidenceArtifact(report, [ACCESS_CODE, STAGING_D1_ID]);
  assert.ok(!artifact.includes(STAGING_D1_ID), "a raw identifier reached the artifact");
});

// ---------------------------------------------------------------------------
// The workflow actually runs this gate
// ---------------------------------------------------------------------------
test("the staging workflow deploys an exact sha, records a rollback target and runs certification", async () => {
  // The gate above is only worth anything if the deploy pipeline invokes it, and if the two agree on
  // the deploy-message format the exact-sha check matches on. Both are contracts between this suite's
  // module and a YAML file, so they are checked here rather than assumed.
  const fs = await import("node:fs");
  const workflow = fs.readFileSync(new URL("../.github/workflows/deploy-staging.yml", import.meta.url), "utf8");

  assert.match(workflow, /expected_sha:/, "the deploy must take the sha to deploy as an input");
  assert.match(workflow, /ref: \$\{\{ github\.event\.inputs\.expected_sha \}\}/, "the checkout must be at the requested sha, not at the default branch");
  assert.match(workflow, /git rev-parse HEAD/, "the checkout must be verified against the requested sha");
  assert.match(workflow, /git status --porcelain/, "a dirty tree must not be deployed");
  assert.match(workflow, /wrangler deploy --message "staging \$\{\{ github\.event\.inputs\.expected_sha \}\}"/,
    "the deploy message is what makes the deployed version attributable to a sha, and certification matches it exactly");
  assert.match(workflow, /id: deploy[\s\S]*wrangler deploy[\s\S]*tee deployment\.txt/,
    "the authoritative workers.dev URL must be captured from the successful deploy output");
  assert.match(workflow, /STAGING_URL: \$\{\{ steps\.deploy\.outputs\.staging_url \}\}/,
    "hosted certification must receive the URL captured by the deploy step");
  assert.doesNotMatch(workflow, /wrangler deployments status --name pawspace-staging/,
    "deployment status does not report the workers.dev URL and must not be used to resolve it");
  assert.match(workflow, /deployments list --name pawspace-staging/, "a rollback reference must be captured before the deploy");
  assert.match(workflow, /node tests\/e2e\/staging-certification\.mjs/, "the deploy must run certification");
  assert.match(workflow, /upload-artifact/, "the sanitized evidence must be uploaded");
  assert.match(workflow, /employee-seed\.sql/, "the staff directory must be loaded, or no advertised identity can sign in");
  assert.match(workflow, /wrangler d1 execute DB --config dist\/server\/wrangler\.json --remote --file=scripts\/employee-seed\.sql/,
    "the seed must resolve the isolation-verified DB binding from the generated staging config");
  assert.doesNotMatch(workflow, /wrangler d1 execute "\$STAGING_D1_ID"/,
    "wrangler d1 execute does not resolve a raw database identifier as its positional database");

  const preflight = workflow.indexOf("Certify deployed isolation before any D1 write");
  const seed = workflow.indexOf("Load the staff directory into the staging D1");
  assert.ok(preflight >= 0 && preflight < seed, "live isolation must be certified before the employee seed writes D1");
  assert.match(workflow.slice(preflight, seed), /--isolation-only/, "the pre-seed check must run the read-only isolation mode");
  assert.match(workflow.slice(workflow.indexOf("Certify the staging deploy")), /timeout-minutes: 10/, "hosted certification must have a job timeout");

  const gate = fs.readFileSync(new URL("./e2e/staging-certification.mjs", import.meta.url), "utf8");
  assert.match(gate, /timeout: 60_000/, "Wrangler subprocesses must be bounded");
  assert.match(gate, /AbortSignal\.timeout\(15_000\)/, "hosted requests must be bounded");
  assert.doesNotMatch(gate, /readFileSync\("dist\/server\/wrangler\.json"/, "certification must never fall back to the local build config");
  assert.match(gate, /"d1", "execute", "DB", "--config", "dist\/server\/wrangler\.json"/,
    "certification reads must resolve the isolation-verified DB binding from the generated staging config");
  assert.doesNotMatch(gate, /"d1", "execute", env\.STAGING_D1_ID/,
    "certification must not pass a raw database identifier to wrangler d1 execute");

  // The rollback capture is allowed to fail (a first deploy has no predecessor), but the certification
  // step is not - a gate that cannot fail the job is decoration.
  const certifyStep = workflow.slice(workflow.indexOf("Certify the staging deploy"));
  assert.doesNotMatch(certifyStep.slice(0, 400), /continue-on-error/, "certification must be able to fail the job");
});

test("nothing in the staging pipeline addresses production", async () => {
  const fs = await import("node:fs");
  for (const file of [".github/workflows/deploy-staging.yml", "scripts/stage-config.mjs", "tests/e2e/staging-certification.mjs"]) {
    const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    // PRODUCTION_D1_ID / PRODUCTION_WORKER_NAME appear only as things to refuse, never as a target.
    for (const match of source.matchAll(/(pawspace-production|PRODUCTION_D1_ID|PRODUCTION_WORKER_NAME)/g)) {
      const line = source.slice(source.lastIndexOf("\n", match.index) + 1, source.indexOf("\n", match.index));
      assert.doesNotMatch(line, /wrangler (deploy|d1 execute|secret put)/,
        `${file} appears to address production: ${line.trim()}`);
    }
  }
});
