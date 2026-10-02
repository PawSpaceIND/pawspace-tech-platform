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
import { DatabaseSync } from "node:sqlite";
import {
  runStagingCertification, assertStagingIsolation, stagingEvidenceArtifact, StagingIsolationRefused,
  STAGING_SECRET_NAMES, SMOKE_ROUTES, REQUIRED_STAFF_IDENTITIES, activeVersionId,
  deployedConfigFromVersion, versionMessage, runStagingIsolationPreflight, staffIdentityQuery, isMainModule,
  SYNTHETIC_CUSTOMER_PERSONA, HUMAN_UAT_SERVICES, HUMAN_UAT_ZONES,
} from "./e2e/staging-certification.mjs";
import { pathToFileURL } from "node:url";

const SHA = "a95ed7adbbf513ed78e4b88b22afa38ce3b5c940";
const ACCESS_CODE = "a-32-character-uat-access-code!!";
const STAGING_D1_ID = "11111111-2222-4333-8444-555555555555";
const PRODUCTION_D1_ID = "99999999-8888-4777-8666-555555555555";

const goodConfig = () => ({
  name: "pawspace-staging",
  d1_databases: [{ binding: "DB", database_name: "pawspace-staging", database_id: STAGING_D1_ID }],
  vars: { PAWSPACE_PAYMENT_ENV: "sandbox", FORBID_PRODUCTION: "true", PAWSPACE_PAYMENT_LIVE_APPROVED: "false", PAWSPACE_UAT_LOGIN: "on" },
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
      if (sql.includes("has_home_base")) return [
        { id: "uatcap_groom_south", updated_by: "founder_seed", seeded: 1, radius_gated: 1, has_home_base: 1 },
        { id: "uatcap_host_cm", updated_by: "founder_seed", seeded: 1, radius_gated: 0, has_home_base: 0 },
        { id: "PROV-REAL-1", updated_by: "ops@pawspace.in", seeded: 0, radius_gated: 1, has_home_base: 0 },
      ];
      if (sql.includes("provider_capacity_profiles")) return HUMAN_UAT_SERVICES.flatMap(service => HUMAN_UAT_ZONES.map(zone => ({ service_code: service, zone_id: zone, provider_count: 1 })));
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
      if (path === "/api/customer-otp" && options.body?.action === "request") {
        return { status: 200, headers: {}, body: { data: { challengeId: "OTP-UAT", sandboxCode: "654321", sandboxDelivery: true, liveSmsDelivered: false } } };
      }
      if (path === "/api/customer-otp" && options.body?.action === "verify") {
        const ok = options.body?.challengeId === "OTP-UAT" && options.body?.code === "654321";
        return ok ? { status: 200, headers: { "set-cookie": "pawspace_session=customer-value; Path=/; HttpOnly" } } : { status: 403, headers: {} };
      }
      if (path === "/api/identity-session") {
        if (options.headers?.cookie === "pawspace_session=customer-value") return { status: 200, headers: {}, body: { data: { subjectType: "customer", subjectId: "CUS-UAT", roleCode: "customer" } } };
        return { status: 401, headers: {}, body: { error: "Identity session required" } };
      }
      if (path === "/api/integration-readiness" && options.headers?.cookie) return { status: 200, headers: {}, body: { uatSandbox: { modules: [
        { code: "razorpay", configuredForExternalTest: true }, { code: "maps_gps", configuredForExternalTest: true },
      ] } } };
      if (options.headers?.cookie) return { status: 200, headers: {} };
      return { status: 401, headers: {} };
    },
    seeded,
  };
  return { ...base, ...over };
}
const failed = (report, fragment) => report.checks.filter(check => !check.ok && check.name.includes(fragment));

test("the hosted staff verification query executes against the canonical role schema", () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE app_users (email TEXT PRIMARY KEY, status TEXT NOT NULL, role_code TEXT NOT NULL)");
  sqlite.exec("CREATE TABLE role_definitions (code TEXT PRIMARY KEY, permissions_json TEXT NOT NULL)");
  sqlite.prepare("INSERT INTO app_users VALUES (?,?,?)").run("founder@pawspace.in", "active", "founder");
  sqlite.prepare("INSERT INTO role_definitions VALUES (?,?)").run("founder", "[\"*\"]");

  assert.deepEqual(
    { ...sqlite.prepare(staffIdentityQuery("founder@pawspace.in")).get() },
    { email: "founder@pawspace.in", status: "active", role_code: "founder" },
  );
});

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
      { type: "plain_text", name: "FORBID_PRODUCTION", text: "true" },
      { type: "plain_text", name: "PAWSPACE_PAYMENT_LIVE_APPROVED", text: "false" },
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
  assert.equal(report.counts.personasCertified, 6);
  assert.equal(report.counts.personasTotal, 6);
  assert.equal(report.rollbackReferenceRecorded, true);
  assert.deepEqual(report.unavailable, []);
});

test("certification fails before handoff when any human-UAT service-zone provider pair is missing", async () => {
  const base = world();
  const report = await runStagingCertification(world({ d1: async sql => {
    if (sql.includes("provider_capacity_profiles")) return HUMAN_UAT_SERVICES.flatMap(service => HUMAN_UAT_ZONES
      .filter(zone => !(service === "grooming" && zone === "blr-south"))
      .map(zone => ({ service_code: service, zone_id: zone, provider_count: 1 })));
    return base.d1(sql);
  } }));
  assert.equal(report.ok, false);
  assert.equal(failed(report, "provider roster").length, 1);
  assert.match(failed(report, "provider roster")[0].detail, /grooming:blr-south/);
});

test("certification fails when a seeded roster row carries a provenance the scheduler drops before evaluation", async () => {
  const base = world();
  const report = await runStagingCertification(world({ d1: async sql => {
    if (sql.includes("has_home_base")) return [
      { id: "uatcap_groom_south", updated_by: "uat_staging_seed", seeded: 1, radius_gated: 1, has_home_base: 1 },
    ];
    return base.d1(sql);
  } }));
  assert.equal(report.ok, false);
  assert.equal(failed(report, "founder_seed provenance").length, 1);
  assert.match(failed(report, "founder_seed provenance")[0].detail, /uatcap_groom_south \(uat_staging_seed\)/);
});

test("certification fails when a seeded grooming or training provider has no current home base", async () => {
  const base = world();
  const report = await runStagingCertification(world({ d1: async sql => {
    if (sql.includes("has_home_base")) return [
      { id: "uatcap_groom_south", updated_by: "founder_seed", seeded: 1, radius_gated: 1, has_home_base: 0 },
      { id: "uatcap_host_cm", updated_by: "founder_seed", seeded: 1, radius_gated: 0, has_home_base: 0 },
    ];
    return base.d1(sql);
  } }));
  assert.equal(report.ok, false);
  assert.equal(failed(report, "home base").length, 1);
  assert.match(failed(report, "home base")[0].detail, /uatcap_groom_south/);
  assert.doesNotMatch(failed(report, "home base")[0].detail, /uatcap_host_cm/);
});

test("certification fails before handoff when Razorpay TEST or Maps UAT is not configured", async () => {
  const base = world();
  const report = await runStagingCertification(world({ http: async (method, path, options = {}) => {
    if (path === "/api/integration-readiness" && options.headers?.cookie) return { status: 200, headers: {}, body: { uatSandbox: { modules: [
      { code: "razorpay", configuredForExternalTest: false }, { code: "maps_gps", configuredForExternalTest: true },
    ] } } };
    return base.http(method, path, options);
  } }));
  assert.equal(report.ok, false);
  assert.equal(failed(report, "checkout dependencies").length, 1);
  assert.match(failed(report, "checkout dependencies")[0].detail, /razorpay/);
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
  for (const [name, bad] of [["PAWSPACE_PAYMENT_ENV", "live"], ["PAWSPACE_UAT_LOGIN", "off"], ["PAWSPACE_PAYMENT_ENV", ""],
    ["FORBID_PRODUCTION", ""], ["FORBID_PRODUCTION", "false"], ["PAWSPACE_PAYMENT_LIVE_APPROVED", ""], ["PAWSPACE_PAYMENT_LIVE_APPROVED", "true"]]) {
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

test("sales approval certifies only inside the explicit voice-UAT overlay", async () => {
  const vars = { ...goodConfig().vars,
    PAWSPACE_VOICE_ENV: "uat",
    PAWSPACE_VOICE_UAT_APPROVED: "true",
    PAWSPACE_VOICE_UAT_AUTORUN: "true",
    PAWSPACE_VOICE_UAT_CONSENT_CONFIRMED: "true",
    PAWSPACE_VOICE_SALES_OUTBOUND_APPROVED: "true",
  };
  const report = await runStagingCertification(world({ deployedConfig: async () => ({ ...goodConfig(), vars }) }));
  assert.equal(failed(report, "live-approval flag").length, 0, JSON.stringify(report.checks.filter(check => !check.ok), null, 2));
});

test("sales approval without the full voice-UAT overlay remains forbidden", async () => {
  const vars = { ...goodConfig().vars, PAWSPACE_VOICE_ENV: "uat", PAWSPACE_VOICE_SALES_OUTBOUND_APPROVED: "true" };
  const report = await runStagingCertification(world({ deployedConfig: async () => ({ ...goodConfig(), vars }) }));
  assert.equal(report.ok, false);
  assert.equal(failed(report, "live-approval flag").length, 1);
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
  state.seeded.delete("jyoti.manager39@tkpetcare.in");
  const report = await runStagingCertification(state);
  assert.equal(report.ok, false);
  assert.equal(failed(report, "seed: manager").length, 1);
  assert.equal(failed(report, "sign-in: manager").length, 1, "a missing seed must not make the sign-in check disappear");
});

test("a staff row whose role has no definition fails, because UAT sign-in refuses it", async () => {
  const state = world();
  state.seeded.set("anjali.finance33@tkpetcare.in", { email: "anjali.finance33@tkpetcare.in", status: "active", role_code: "" });
  const report = await runStagingCertification(state);
  assert.equal(report.ok, false);
  assert.equal(failed(report, "seed: finance").length, 1);
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
  assert.equal(failed(report, "at /api/staging-login").length, REQUIRED_STAFF_IDENTITIES.length);
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
  const base = world();
  const report = await runStagingCertification(world({
    http: async (method, path, options = {}) => {
      if (path === "/api/staging-login") return { status: 200, headers: new Headers({ "set-cookie": "pawspace_session=abc; Path=/" }) };
      return base.http(method, path, options);
    },
  }));
  assert.equal(report.ok, true, JSON.stringify(report.checks.filter(check => !check.ok)));
});

// ---------------------------------------------------------------------------
// Hosted smoke pack
// ---------------------------------------------------------------------------
test("the hosted smoke pack refreshes Founder after later persona sign-ins", async () => {
  const state = world();
  let founderLogins = 0;
  const baseHttp = state.http;
  state.http = async (method, path, options = {}) => {
    if (path === "/api/staging-login" && options.body?.email === "founder@pawspace.in") {
      founderLogins += 1;
      return { status: 200, headers: { "set-cookie": `pawspace_session=founder-${founderLogins}; Path=/; HttpOnly` } };
    }
    if (SMOKE_ROUTES.includes(path) && path !== "/api/integration-readiness" && options.headers?.cookie) {
      return options.headers.cookie === "pawspace_session=founder-2"
        ? { status: 200, headers: {} }
        : { status: 401, headers: {} };
    }
    return baseHttp(method, path, options);
  };
  const report = await runStagingCertification(state);
  assert.equal(founderLogins, 2);
  assert.equal(report.ok, true, JSON.stringify(report.checks.filter(check => !check.ok), null, 2));
});

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

test("certification only writes disposable authentication records, never business records", async () => {
  const state = world();
  await runStagingCertification(state);
  const writes = state.calls.http.filter(call => call.method !== "GET" && !["/api/staging-login", "/api/customer-otp"].includes(call.path));
  assert.deepEqual(writes, [], "certification must not create business records in a database testers are about to use");
});

test("the customer persona fails when OTP is not explicitly sandbox-only", async () => {
  const base = world();
  const report = await runStagingCertification(world({ http: async (method, path, options = {}) => {
    if (path === "/api/customer-otp" && options.body?.action === "request") return { status: 200, headers: {}, body: { data: { challengeId: "OTP", sandboxCode: "123456", sandboxDelivery: false, liveSmsDelivered: true } } };
    return base.http(method, path, options);
  } }));
  assert.equal(report.ok, false);
  assert.equal(failed(report, "sign-in: customer").length, 1);
  assert.equal(report.counts.personasCertified, 5);
});

test("the customer persona fails when OTP verification issues no session", async () => {
  const base = world();
  const report = await runStagingCertification(world({ http: async (method, path, options = {}) => {
    if (path === "/api/customer-otp" && options.body?.action === "verify") return { status: 200, headers: {} };
    return base.http(method, path, options);
  } }));
  assert.equal(report.ok, false);
  assert.equal(failed(report, "sign-in: customer").length, 1);
});

test("the customer persona fails if its session is not customer-scoped or anonymous identity is open", async () => {
  for (const identityResponse of [
    { status: 200, headers: {}, body: { data: { subjectType: "staff", roleCode: "founder" } } },
    { status: 200, headers: {}, body: { data: { subjectType: "customer", roleCode: "customer" } } },
  ]) {
    const base = world();
    let identityCalls = 0;
    const report = await runStagingCertification(world({ http: async (method, path, options = {}) => {
      if (path === "/api/identity-session") {
        identityCalls += 1;
        if (identityCalls === 1) return identityResponse;
        return identityResponse.body?.data?.subjectType === "customer" ? { status: 200, headers: {}, body: identityResponse.body } : { status: 401, headers: {} };
      }
      return base.http(method, path, options);
    } }));
    assert.equal(report.ok, false);
    assert.equal(failed(report, "sign-in: customer").length, 1);
  }
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
  assert.match(workflow, /wrangler deploy[^\n]*--secrets-file "\$SECRETS_FILE"/,
    "code and UAT secrets must be uploaded in one attributed Worker version");
  assert.doesNotMatch(workflow, /wrangler secret put/,
    "secret put creates and deploys a newer unattributed version after the exact-sha deployment");
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
  // The seed runs through D1's query API (scripts/schema/apply-remote-sql.mjs), never a `--file` import,
  // which would make D1 refuse the live Worker's queries until it finished.
  assert.match(workflow, /node scripts\/schema\/apply-remote-sql\.mjs --binding DB --config dist\/server\/wrangler\.json --file scripts\/employee-seed\.sql/,
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

test("hosted certification uses the advertised seeded identities and routes that exist", async () => {
  const fs = await import("node:fs");
  const login = fs.readFileSync(new URL("../app/staging-login/page.tsx", import.meta.url), "utf8");
  const employeeSeed = fs.readFileSync(new URL("../scripts/employee-seed.sql", import.meta.url), "utf8");

  for (const identity of REQUIRED_STAFF_IDENTITIES) {
    assert.match(login, new RegExp(identity.email.replaceAll(".", "\\.")), `${identity.email} is not advertised by the staging login`);
    assert.match(employeeSeed, new RegExp(`'${identity.email.replaceAll(".", "\\.")}'[^\\n]*'${identity.role}'[^\\n]*'active'`),
      `${identity.email} is not an active ${identity.role} app_users seed row`);
  }

  for (const route of SMOKE_ROUTES) {
    const pathname = new URL(route, "https://staging.invalid").pathname;
    assert.equal(fs.existsSync(new URL(`../app${pathname}/route.ts`, import.meta.url)), true,
      `${pathname} has no deployed route module`);
  }
  assert.match(SYNTHETIC_CUSTOMER_PERSONA.phone, /^\d{10}$/);
  for (const route of ["/api/customer-otp", "/api/identity-session"]) {
    assert.equal(fs.existsSync(new URL(`../app${route}/route.ts`, import.meta.url)), true, `${route} has no deployed route module`);
  }
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

// Voice deployment regression: synthetic provider responses only; never reads real routing settings.
import { verifyStagingVoiceRouting } from '../scripts/verify-staging-voice-routing.mjs';
const routingEnv = () => ({ PAWSPACE_DEPLOYMENT_ENV:'staging', PAWSPACE_PAYMENT_ENV:'sandbox', PAWSPACE_VOICE_RUNTIME:'elevenlabs',
  EXOTEL_SUBDOMAIN:'api.exotel.com', EXOTEL_SID:'fixture-account', EXOTEL_API_KEY:'synthetic-key', EXOTEL_API_TOKEN:'synthetic-token',
  ELEVENLABS_API_BASE:'https://api.elevenlabs.io', ELEVENLABS_API_KEY:'synthetic-eleven-key',
  ELEVENLABS_AGENT_PHONE_NUMBER_ID:'phnum_Synthetic1196', EXOTEL_CALLER_ID:'+918000001196', EXOTEL_VOICE_APP_ID:'1347515' });
const routingUrls = ['https://api.exotel.com/v2_beta/Accounts/fixture-account/IncomingPhoneNumbers',
  'https://api.elevenlabs.io/v1/convai/phone-numbers', 'https://api.elevenlabs.io/v1/convai/phone-numbers/phnum_Synthetic1196'];
function routingWorld() {
  const phone={ provider:'exotel',phone_number:'+918000001196',phone_number_id:'phnum_Synthetic1196' };
  const responses=[{incoming_phone_numbers:[{phone_number:'+918000001196',region:'KA',capabilities:{voice:true},voice_url:'https://fixture.invalid/start_voice/1347515'}]}, [phone], {...phone}];
  const calls=[];
  const request=async(url, init)=>{
    calls.push({url,init});assert.equal(init.method,'GET');assert.equal(init.redirect,'error');assert.equal(init.body,undefined);
    const index=routingUrls.indexOf(url);assert.ok(index>=0,'only exact provider metadata endpoints are allowed');
    if(index===0){assert.ok(init.headers.authorization);assert.equal(init.headers['xi-api-key'],undefined);}
    else {assert.ok(init.headers['xi-api-key']);assert.equal(init.headers.authorization,undefined);}
    return responses[index] instanceof Response ? responses[index] : Response.json(responses[index]);
  };
  return {responses,calls,request};
}
test('staging routing guard verifies existing metadata without changing settings or calling',async()=>{
  const env=routingEnv(),before=structuredClone(env),w=routingWorld();const result=await verifyStagingVoiceRouting(env,w.request);
  assert.equal(result.checked,true);assert.equal(result.providerReadCount,3);assert.equal(result.dialed,false);assert.equal(result.configurationChanged,false);
  assert.deepEqual(w.calls.map(x=>x.url),routingUrls);assert.deepEqual(env,before);
  for(const field of ['EXOTEL_CALLER_ID','ELEVENLABS_AGENT_PHONE_NUMBER_ID','EXOTEL_API_TOKEN','ELEVENLABS_API_KEY'])assert.ok(!JSON.stringify(result).includes(env[field]));
});
for(const [field,value] of [['ELEVENLABS_AGENT_PHONE_NUMBER_ID','phnum_Stale'],['EXOTEL_CALLER_ID','+918000001111'],['EXOTEL_VOICE_APP_ID','1111111']])test('staging routing guard refuses stale '+field,async()=>{
  const w=routingWorld(),env={...routingEnv(),[field]:value};
  await assert.rejects(()=>verifyStagingVoiceRouting(env,w.request),error=>error.message.includes('stale_routing_settings')&&error.message.includes(field)&&!error.message.includes(value));
  assert.equal(w.calls.length,2);
});
for(const field of ['ELEVENLABS_AGENT_PHONE_NUMBER_ID','EXOTEL_CALLER_ID','EXOTEL_VOICE_APP_ID','ELEVENLABS_API_KEY','EXOTEL_API_TOKEN'])test('routing prerequisites refuse missing '+field+' before provider reads',async()=>{
  const w=routingWorld();await assert.rejects(()=>verifyStagingVoiceRouting({...routingEnv(),[field]:''},w.request));assert.equal(w.calls.length,0);
});
for(const override of [{PAWSPACE_DEPLOYMENT_ENV:'production'},{PAWSPACE_PAYMENT_ENV:'live'}])test('routing guard refuses non-staging scope '+JSON.stringify(override),async()=>{
  const w=routingWorld();await assert.rejects(()=>verifyStagingVoiceRouting({...routingEnv(),...override},w.request),/isolated_staging_required/);assert.equal(w.calls.length,0);
});
test('non-ElevenLabs deployments do not require or contact that provider',async()=>{
  const w=routingWorld();const result=await verifyStagingVoiceRouting({PAWSPACE_DEPLOYMENT_ENV:'staging',PAWSPACE_PAYMENT_ENV:'sandbox'},w.request);
  assert.equal(result.checked,false);assert.equal(result.reason,'elevenlabs_not_selected');assert.equal(w.calls.length,0);
});
for(const status of [401,403,404,429,500])test('routing HTTP '+status+' fails immediately without alternate-host retry',async()=>{
  const w=routingWorld();w.responses[0]=new Response('provider response is not safe to log',{status});
  await assert.rejects(()=>verifyStagingVoiceRouting(routingEnv(),w.request),new RegExp('provider_evidence_http_'+status));assert.equal(w.calls.length,1);
});
for(const mutation of [w=>{w.responses[0]={};},w=>{w.responses[1]={};},w=>{w.responses[1].push({...w.responses[1][0]});},w=>{w.responses[0].incoming_phone_numbers=[];}])test('incomplete or ambiguous provider inventory refuses routing certification',async()=>{
  const w=routingWorld();mutation(w);await assert.rejects(()=>verifyStagingVoiceRouting(routingEnv(),w.request),/incomplete|ambiguous/);assert.equal(w.calls.length,2);
});
for(const override of [{phone_number:'+918000001111'},{phone_number_id:'phnum_Changed'},{provider:'other'}])test('changed exact import refuses certification '+Object.keys(override)[0],async()=>{
  const w=routingWorld();Object.assign(w.responses[2],override);await assert.rejects(()=>verifyStagingVoiceRouting(routingEnv(),w.request),/import_identity_changed/);assert.equal(w.calls.length,3);
});
for(const raw of ['not-json','x'.repeat(1048577)])test('malformed or oversized routing evidence is rejected without echoing its body',async()=>{
  const w=routingWorld();w.responses[0]=new Response(raw);
  await assert.rejects(()=>verifyStagingVoiceRouting(routingEnv(),w.request),/provider_evidence_invalid_or_oversized/);assert.equal(w.calls.length,1);
});
test('normal staging deployment and voice repair resolve the same environment before any mutation',async()=>{
  const fs=await import('node:fs'),yaml=await import('js-yaml');
  const deployment=yaml.load(fs.readFileSync(new URL('../.github/workflows/deploy-staging.yml',import.meta.url),'utf8'));
  const voice=yaml.load(fs.readFileSync(new URL('../.github/workflows/elevenlabs-provider-preflight.yml',import.meta.url),'utf8'));
  const job=deployment.jobs.deploy;assert.equal(job.environment,'pawspace-staging');assert.equal(job.environment,voice.jobs['repair-staging-voice-config'].environment);
  const guardIndex=job.steps.findIndex(x=>x.name==='Verify existing staging voice routing before deployment');assert.ok(guardIndex>=0);
  const guard=job.steps[guardIndex],deploy=job.steps.find(x=>x.name==='Deploy to staging');
  assert.equal(guard.run,'node --experimental-strip-types scripts/verify-staging-voice-routing.mjs');
  assert.equal(guard['continue-on-error'],undefined);assert.equal(guard.if,undefined);
  for(const name of ['ELEVENLABS_AGENT_PHONE_NUMBER_ID','EXOTEL_CALLER_ID','EXOTEL_VOICE_APP_ID','ELEVENLABS_API_BASE','EXOTEL_SUBDOMAIN','PAWSPACE_VOICE_RUNTIME'])assert.equal(guard.env[name],deploy.env[name],name);
  for(const name of ['Apply D1 migrations to staging','Deploy to staging','Load the staff directory into the staging D1'])assert.ok(guardIndex<job.steps.findIndex(x=>x.name===name),name);
  assert.equal(deployment.on.workflow_dispatch.inputs.sms_smoke.default,'disabled');assert.equal(deployment.on.workflow_dispatch.inputs.atlas_smoke.default,false);
  assert.equal(job.concurrency['cancel-in-progress'],false);assert.match(deploy.run,/"EXOTEL_SUBDOMAIN"/);
});
test('operator routing inspection is explicitly selected, uses deploy settings, and has no mutation credentials',async()=>{
  const fs=await import('node:fs'),yaml=await import('js-yaml');
  const deployment=yaml.load(fs.readFileSync(new URL('../.github/workflows/deploy-staging.yml',import.meta.url),'utf8'));
  const voice=yaml.load(fs.readFileSync(new URL('../.github/workflows/elevenlabs-provider-preflight.yml',import.meta.url),'utf8'));
  const job=voice.jobs['verify-staging-voice-routing'];assert.equal(job.if,"${{ inputs.confirm == 'verify-staging-voice-routing' }}");
  assert.equal(job.environment,'pawspace-staging');const step=job.steps.find(x=>x.run);
  const guard=deployment.jobs.deploy.steps.find(x=>x.name==='Verify existing staging voice routing before deployment');
  assert.deepEqual(step.env,guard.env);assert.equal(step.run,guard.run);
  assert.ok(!Object.keys(step.env).some(name=>/CLOUDFLARE|ACCESS_CODE|VOICE_UAT_ALLOWLIST|RECORDING|LIVE_APPROVED/.test(name)));
});

// Exact publication provenance checks share the existing staging certification suite.
import {atlasProofProvenanceFields, verifyAtlasProofProvenance} from "../scripts/atlas-proof-provenance.mjs";
const sha = "b0c9e4a8b4663cba27d91ff60d20055e90d516a3";
const staging = () => ({annotations: {"workers/message": `staging ${sha}`}, resources: {bindings: [
  {name: "PAWSPACE_PAYMENT_ENV", text: "sandbox"}, {name: "FORBID_PRODUCTION", text: "true"},
  {name: "PAWSPACE_PAYMENT_LIVE_APPROVED", text: "false"}
]}});
const check = (version, extra = {}) => verifyAtlasProofProvenance({version, expectedSha: sha, targetEnvironment: "pawspace-staging", workerName: "pawspace-staging", ...extra});
test("certified normal staging needs no release-preview-only SHA binding", () => assert.equal(check(staging()).sha, sha));
test("wrong or missing staging publication message is refused", () => {
  for (const message of ["", `staging ${"a".repeat(40)}`, `release ${sha}`, `staging ${sha} extra`]) {
    const version = staging(); version.annotations["workers/message"] = message;
    assert.throws(() => check(version), /version message/);
  }
});
test("a staging SHA binding cannot contradict the publication message", () => {
  const version = staging(); version.resources.bindings.push({name: "PAWSPACE_STAGING_BUILD_SHA", text: "a".repeat(40)});
  assert.throws(() => check(version), /conflicts/);
});
test("sandbox envelope refuses each missing or unsafe payment flag", () => {
  for (const name of ["PAWSPACE_PAYMENT_ENV", "FORBID_PRODUCTION", "PAWSPACE_PAYMENT_LIVE_APPROVED"]) {
    for (const replacement of [null, "unsafe"]) {
      const version = staging(); const binding = version.resources.bindings.find(b => b.name === name);
      if (replacement === null) version.resources.bindings = version.resources.bindings.filter(b => b.name !== name);
      else binding.text = replacement;
      assert.throws(() => check(version), /sandbox payment envelope/);
    }
  }
});
test("wrong Worker, unknown environment and nonexact SHA are refused", () => {
  assert.throws(() => check(staging(), {workerName: "pawspace-production"}), /dedicated/);
  assert.throws(() => check(staging(), {targetEnvironment: "production"}), /Unsupported/);
  assert.throws(() => check(staging(), {expectedSha: "main"}), /exact commit/);
});
test("release-preview still requires its exact release SHA binding", () => {
  const version = {resources: {bindings: [{name: "PAWSPACE_RELEASE_SHA", text: sha}]}};
  assert.equal(check(version, {targetEnvironment: "pawspace-release-preview"}).sha, sha);
  assert.throws(() => check(staging(), {targetEnvironment: "pawspace-release-preview"}), /release-preview product SHA/);
});
test("diagnostic includes only needed public provenance and sandbox fields", () => {
  const version = staging();
  version.resources.bindings.push({name: "PAWSPACE_UAT_ACCESS_CODE", text: "must-not-export"});
  const fields = atlasProofProvenanceFields(version);
  assert.deepEqual(Object.keys(fields).sort(), ["forbidProduction", "paymentEnvironment", "paymentLiveApproved", "releaseSha", "stagingBuildSha", "versionMessage"].sort());
  assert.equal(JSON.stringify(fields).includes("must-not-export"), false);
  assert.equal(fields.versionMessage, `staging ${sha}`);
});

// Bounded read-only scheduler diagnostic evidence.
import {scheduledQuery,sanitizeResponse} from '../scripts/read-atlas-scheduled-slots.mjs';
test('query is bounded to eight staging slots, dry, and one Worker',()=>{const q=scheduledQuery();assert.equal(q.dry,true);assert.equal(q.limit,200);assert.deepEqual(q.parameters.datasets,['cloudflare-workers']);assert.deepEqual(q.parameters.filters,[{key:'$metadata.service',type:'string',operation:'eq',value:'pawspace-staging'}]);assert.equal(q.timeframe.from,1790940300000);assert.equal(q.timeframe.to,1790942760000);});
test('raw messages, requests, customer data and bindings never escape sanitization',()=>{const r=sanitizeResponse({success:true,result:{events:{count:1,events:[{$metadata:{id:'event1',service:'pawspace-staging',message:'secret email@example.com',error:'CPU time limit exceeded',trigger:'https://host/customer?email=secret',origin:'private',authorization:'secret'},$workers:{outcome:'exceededCpu',eventType:'private',event:{type:'cron',cron:'*/5 * * * *',scheduledTime:1790940300000,request:{headers:{trigger:'https://host/customer?email=secret',origin:'private',authorization:'secret'}}},exceptions:[{message:'private'}]},source:{phone:'private'},bindings:[{name:'SECRET',text:'secret'}]}]}}});assert.equal(r.events[0].errorCategory,'cpu_limit');assert.equal(r.events[0].worker.outcome,'exceededCpu');assert.equal(r.events[0].event.type,'cron');assert.doesNotMatch(JSON.stringify(r),/secret|private|email@example/);});
test('authentication error is retained without raw provider message',()=>{const r=sanitizeResponse({success:false,errors:[{code:10000,message:'Authentication error with secret'}]});assert.deepEqual(r.errorCodes,[10000]);assert.deepEqual(r.errorCategories,['authorization']);assert.doesNotMatch(JSON.stringify(r),/secret/);});
