/**
 * Staging certification.
 *
 * `deploy-staging.yml` built, configured, deployed and installed secrets, and then said "Staging
 * deployed as pawspace-staging". Every fact a human UAT round actually depends on was unverified:
 *
 *   - which BUILD is running. "The deploy step succeeded" is not the same as "the sha I asked for is
 *     what answers requests" - a cached artifact, a concurrent deploy or a failed secret install all
 *     leave the step green and the wrong code live.
 *   - whether it is bound to the ISOLATED staging database, or to something shared.
 *   - whether it is in sandbox mode, or whether a live flag came along for the ride.
 *   - whether the advertised staff identities can sign in. Testers discovered this by failing to log
 *     in, because UAT sign-in refuses any email that is not an active app_users row.
 *   - whether the routes those testers were told to open actually answer.
 *   - what to roll back TO if the deploy is bad.
 *
 * This gate answers all six against the DEPLOYED origin and the DEPLOYED configuration, and emits one
 * sanitized artifact. Two design rules it shares with the release-preview gate:
 *
 *   A required check that could not be run FAILS. There is no third softer outcome, because a check
 *   nobody ran is indistinguishable from a failing one, and a gate that reports success for an
 *   unverified deploy is worse than no gate.
 *
 *   Isolation is proved before anything else runs, and a failure there stops the gate rather than
 *   being recorded and continued past. Every later check writes to the database it was pointed at; if
 *   that is the wrong database, running them is the harm.
 */

import { sanitizeEvidenceDetail } from "./release-preview-gate.mjs";
import { pathToFileURL } from "node:url";

export const STAGING_WORKER_NAME = "pawspace-staging";
export const STAGING_D1_NAME = "pawspace-staging";
const EXACT_SHA = /^[0-9a-f]{40}$/;

/** Credentials the deploy installs as Worker secrets. None may ever appear in the serialized config. */
export const STAGING_SECRET_NAMES = ["PAWSPACE_UAT_ACCESS_CODE", "PAWSPACE_UAT_SIGNING_KEY", "PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT"];

/**
 * Flags that would make staging behave like production. Checked as "absent or explicitly off" rather
 * than "not equal to live": a var carrying "LIVE" or "1" is the same mistake in different clothing.
 */
export const FORBIDDEN_ON_STAGING = {
  PAWSPACE_PAYMENT_ENV: ["live", "production", "prod"],
  PAWSPACE_VOICE_ENV: ["live", "production", "prod"],
  PAWSPACE_VOICE_LIVE_APPROVED: ["true", "1", "yes", "on"],
  PAWSPACE_VOICE_RECORDING_APPROVED: ["true", "1", "yes", "on"],
  PAWSPACE_VOICE_SALES_OUTBOUND_APPROVED: ["true", "1", "yes", "on"],
};

/** Required staging modes, as name → the only accepted value. */
export const REQUIRED_STAGING_VARS = { PAWSPACE_PAYMENT_ENV: "sandbox", PAWSPACE_UAT_LOGIN: "on" };

/**
 * The staff identities /staging-login advertises. Each must be an ACTIVE app_users row whose role has
 * a definition, and each must complete a real sign-in - the two are different failures and both
 * stranded testers before.
 */
export const REQUIRED_STAFF_IDENTITIES = [
  { email: "founder@pawspace.in", role: "founder" },
  { email: "admin@pawspace.in", role: "admin" },
  { email: "manager@pawspace.in", role: "manager" },
];

/**
 * The smoke pack. Each route must answer for a real staff session AND refuse an anonymous caller: a
 * route that answers 200 to everyone is worse than one that is down. Reads only - certification must
 * not create business records in a database testers are about to use.
 */
export const SMOKE_ROUTES = [
  "/api/platform-overview",
  "/api/integration-readiness",
  "/api/voice-outbound",
  "/api/ai-business-configuration?mode=status",
  "/api/staff-alerts",
  "/api/customer-360",
];

export class StagingIsolationRefused extends Error {
  constructor(message) { super(message); this.name = "StagingIsolationRefused"; }
}

const val = (record, name) => String(record?.[name] ?? "").trim();

/** A certification target must be one unambiguous version serving all traffic. */
export function activeVersionId(status) {
  const versions = Array.isArray(status?.versions) ? status.versions : [];
  if (versions.length !== 1) throw new StagingIsolationRefused(`Refusing to certify: the active deployment has ${versions.length} versions; staging certification requires exactly one`);
  const active = versions[0] ?? {};
  const percentage = Number(active.percentage);
  const id = String(active.version_id ?? "").trim();
  if (!id || percentage !== 100) throw new StagingIsolationRefused(`Refusing to certify: the active deployment is not one version at 100% traffic`);
  return id;
}

/** Normalize the live version resource returned by `wrangler versions view --json`. */
export function deployedConfigFromVersion(version) {
  const bindings = Array.isArray(version?.resources?.bindings) ? version.resources.bindings : [];
  const d1_databases = bindings.filter(binding => binding?.type === "d1").map(binding => ({
    binding: String(binding.name ?? ""), database_id: String(binding.id ?? binding.database_id ?? ""),
  }));
  const vars = Object.fromEntries(bindings.filter(binding => binding?.type === "plain_text").map(binding => [String(binding.name ?? ""), String(binding.text ?? binding.value ?? "")]));
  return { d1_databases, vars };
}

export function versionMessage(version) { return String(version?.annotations?.["workers/message"] ?? "").trim(); }

/**
 * Isolation, checked before anything else and thrown rather than recorded.
 *
 * Every later check writes a session and reads tables in whatever database this config points at. If
 * that is production, running them IS the damage - so this refuses to proceed rather than adding a
 * failing line to a report that the rest of the gate then continues past.
 */
export function assertStagingIsolation({ workerName, deployedConfig, env }) {
  const problems = [];
  if (workerName !== STAGING_WORKER_NAME) problems.push(`the target worker is "${workerName}", not the isolated ${STAGING_WORKER_NAME}`);
  if (val(env, "PRODUCTION_WORKER_NAME") && workerName === val(env, "PRODUCTION_WORKER_NAME")) problems.push("the target worker is the production worker");

  const bindings = Array.isArray(deployedConfig?.d1_databases) ? deployedConfig.d1_databases : [];
  if (bindings.length !== 1) problems.push(`the deployed config declares ${bindings.length} D1 bindings; staging must declare exactly one`);
  const binding = bindings[0] ?? {};
  if (val(binding, "binding") !== "DB") problems.push(`the D1 binding is "${val(binding, "binding")}", not DB`);
  if (val(binding, "database_name") && val(binding, "database_name") !== STAGING_D1_NAME) problems.push(`the bound database is "${val(binding, "database_name")}", not ${STAGING_D1_NAME}`);
  const boundId = val(binding, "database_id");
  if (!boundId) problems.push("the D1 binding carries no database id");
  if (val(env, "STAGING_D1_ID") && boundId && boundId !== val(env, "STAGING_D1_ID")) problems.push("the bound database id is not the configured staging database id");
  if (val(env, "PRODUCTION_D1_ID") && boundId && boundId === val(env, "PRODUCTION_D1_ID")) problems.push("the bound database is the production database");

  if (problems.length) throw new StagingIsolationRefused(`Refusing to certify: ${problems.join("; ")}`);
  return { workerName, databaseName: STAGING_D1_NAME };
}

/** Read-only preflight used before the workflow installs secrets or writes the employee seed. */
export async function runStagingIsolationPreflight({ deployedConfig, liveVersionMessage, env }) {
  const config = await deployedConfig();
  assertStagingIsolation({ workerName: val(env, "WORKER_NAME"), deployedConfig: config, env });
  const expectedSha = val(env, "EXPECTED_SHA");
  if (!EXACT_SHA.test(expectedSha)) throw new StagingIsolationRefused("Refusing to certify: EXPECTED_SHA is not an exact commit sha");
  if (String(await liveVersionMessage()).trim() !== `staging ${expectedSha}`) throw new StagingIsolationRefused("Refusing to certify: the active version does not match EXPECTED_SHA");
  const vars = config && typeof config.vars === "object" ? config.vars : {};
  for (const [name, expected] of Object.entries(REQUIRED_STAGING_VARS)) if (val(vars, name) !== expected) throw new StagingIsolationRefused(`Refusing to certify: ${name} is not ${expected}`);
  if (Object.entries(FORBIDDEN_ON_STAGING).some(([name, forbidden]) => forbidden.includes(val(vars, name).toLowerCase()))) throw new StagingIsolationRefused("Refusing to certify: a production/live approval flag is active");
  if (STAGING_SECRET_NAMES.some(name => val(vars, name))) throw new StagingIsolationRefused("Refusing to certify: a UAT credential is serialized in deployed vars");
  return { ok: true, worker: val(env, "WORKER_NAME"), sha: expectedSha, databaseIdVerified: true };
}

/**
 * @param {object} adapters
 * @param {(method: string, path: string, options?: object) => Promise<{status: number, headers: any, body?: any}>} adapters.http against the DEPLOYED origin
 * @param {(sql: string) => Promise<Array<Record<string, unknown>>>} adapters.d1 against the staging database
 * @param {() => Promise<object>} adapters.deployedConfig the configuration the running Worker was deployed with
 * @param {() => Promise<string>} adapters.liveVersionMessage the deploy message of the CURRENTLY ACTIVE version
 * @param {() => Promise<string>} adapters.rollbackReference the version that was live BEFORE this deploy
 */
export async function runStagingCertification({ http, d1, deployedConfig, liveVersionMessage, rollbackReference, env, log = console.log }) {
  const report = { worker: STAGING_WORKER_NAME, sha: val(env, "EXPECTED_SHA"), checks: [], counts: {} };
  let failures = 0;
  const safe = (value) => sanitizeEvidenceDetail(value, [val(env, "ACCESS_CODE"), val(env, "STAGING_D1_ID"), val(env, "PRODUCTION_D1_ID")]);
  const check = (name, ok, detail = "") => {
    const entry = { name, ok, detail: detail ? safe(detail) : "" };
    report.checks.push(entry);
    if (!ok) failures++;
    log(`  ${ok ? "PASS" : "FAIL"}  ${name}${entry.detail ? ` — ${entry.detail}` : ""}`);
    return ok;
  };
  const unavailable = (name, reason) => {
    report.checks.push({ name, ok: false, detail: `NOT RUN: ${safe(reason)}`, unavailable: true });
    failures++;
    log(`  FAIL  ${name} — NOT RUN: ${safe(reason)}`);
    return false;
  };

  const expectedSha = val(env, "EXPECTED_SHA");
  log(`Staging certification — ${expectedSha.slice(0, 8) || "no sha"}`);

  // ── isolation, first and hard ───────────────────────────────────────────────────────────────
  let config;
  try { config = await deployedConfig(); }
  catch (error) { throw new StagingIsolationRefused(`Refusing to certify: the deployed configuration could not be read (${safe(error?.message)})`); }
  const isolation = assertStagingIsolation({ workerName: val(env, "WORKER_NAME"), deployedConfig: config, env });
  check("the deploy target is the isolated staging worker and its dedicated D1", true, `worker ${isolation.workerName}, database ${isolation.databaseName}`);

  // ── exact deployed sha ──────────────────────────────────────────────────────────────────────
  //
  // The deploy message is required to match EXACTLY. A prefix match would let a version deployed for
  // a different sha satisfy this whenever one sha is a prefix of the message of another, and "a
  // staging deploy happened recently" is not the claim this gate is making.
  if (!EXACT_SHA.test(expectedSha)) {
    check("the requested build is an exact commit sha", false, `EXPECTED_SHA is "${expectedSha || "(unset)"}" - a branch name or short sha does not identify a build`);
  } else {
    check("the requested build is an exact commit sha", true, expectedSha);
    try {
      // The ACTIVE version's message, not any message in the deployment history. Searching the whole
      // history let an older version satisfy this check after a later or concurrent deploy had already
      // replaced it - certifying a build that is no longer the one answering requests, which is the
      // precise failure this check exists to catch.
      const live = String(await liveVersionMessage() ?? "").trim();
      const wanted = `staging ${expectedSha}`;
      check("the LIVE version was published for exactly this sha", live === wanted,
        live === wanted ? wanted : `the live version's message is ${live ? `"${live}"` : "empty"}, not "${wanted}" - deployment drift`);
    } catch (error) {
      unavailable("the LIVE version was published for exactly this sha", `the live version could not be read (${error?.message})`);
    }
  }

  // ── environment mode ────────────────────────────────────────────────────────────────────────
  const vars = (config && typeof config.vars === "object" && config.vars) || {};
  for (const [name, expected] of Object.entries(REQUIRED_STAGING_VARS)) {
    check(`environment mode: ${name} is ${expected}`, val(vars, name) === expected, `${name}="${val(vars, name) || "(unset)"}"`);
  }
  const liveFlags = Object.entries(FORBIDDEN_ON_STAGING)
    .filter(([name, forbidden]) => forbidden.includes(val(vars, name).toLowerCase()))
    .map(([name]) => name);
  check("no production or live-approval flag is set on staging", liveFlags.length === 0, liveFlags.length ? `set: ${liveFlags.join(", ")}` : "none set");

  const leaked = STAGING_SECRET_NAMES.filter(name => val(vars, name));
  check("no UAT credential is serialized into the deployed configuration", leaked.length === 0,
    leaked.length ? `${leaked.join(", ")} present in vars - these must be Worker secrets` : "credentials are Worker secrets only");

  // ── seeds and staff identities ──────────────────────────────────────────────────────────────
  //
  // Two separate facts. The row existing is not the same as sign-in working: UAT sign-in also needs
  // the role to have a definition, and a tester hitting that gets "access denied" with no way to tell
  // which half is missing.
  const sessions = new Map();
  for (const identity of REQUIRED_STAFF_IDENTITIES) {
    let seeded = false;
    try {
      const rows = await d1(`SELECT u.email, u.status, r.role_code FROM app_users u LEFT JOIN role_definitions r ON r.role_code=u.role_code WHERE u.email='${identity.email}'`);
      const row = rows?.[0];
      seeded = Boolean(row && String(row.status) === "active" && String(row.role_code || "") === identity.role);
      check(`seed: ${identity.role} is an active staff record with a role definition`, seeded,
        row ? `status=${row.status}, role_definition=${row.role_code || "(missing)"}` : "no app_users row");
    } catch (error) {
      unavailable(`seed: ${identity.role} is an active staff record with a role definition`, `the staging database could not be read (${error?.message})`);
    }
    if (!seeded) { check(`sign-in: ${identity.role} can sign in at /api/staging-login`, false, "skipped - the staff record is not seeded"); continue; }
    try {
      const response = await http("POST", "/api/staging-login", { body: { action: "login", code: val(env, "ACCESS_CODE"), email: identity.email } });
      const setCookie = String(response.headers?.["set-cookie"] ?? response.headers?.get?.("set-cookie") ?? "");
      const cookie = setCookie.split(";")[0];
      const ok = response.status >= 200 && response.status < 400 && Boolean(cookie);
      if (ok) sessions.set(identity.role, cookie);
      check(`sign-in: ${identity.role} can sign in at /api/staging-login`, ok, ok ? "session issued" : `status ${response.status}, no session cookie`);
    } catch (error) {
      unavailable(`sign-in: ${identity.role} can sign in at /api/staging-login`, `the deployed origin did not answer (${error?.message})`);
    }
  }

  // ── hosted route smoke pack ─────────────────────────────────────────────────────────────────
  const founderCookie = sessions.get("founder");
  if (!founderCookie) {
    unavailable("hosted smoke pack answers for a real staff session", "no founder session could be established");
    unavailable("hosted smoke pack refuses an anonymous caller", "no founder session to compare against");
  } else {
    const answered = [], refusedForStaff = [], openToAnonymous = [];
    for (const route of SMOKE_ROUTES) {
      try {
        const authed = await http("GET", route, { headers: { cookie: founderCookie } });
        if (authed.status >= 200 && authed.status < 300) answered.push(route); else refusedForStaff.push(`${route}:${authed.status}`);
      } catch (error) { refusedForStaff.push(`${route}:${safe(error?.message)}`); }
      try {
        const anonymous = await http("GET", route, {});
        if (anonymous.status !== 401 && anonymous.status !== 403) openToAnonymous.push(`${route}:${anonymous.status}`);
      } catch { /* a transport failure is not an authorization hole */ }
    }
    report.counts.smokeRoutesAnswered = answered.length;
    report.counts.smokeRoutesTotal = SMOKE_ROUTES.length;
    check("hosted smoke pack answers for a real staff session", refusedForStaff.length === 0,
      refusedForStaff.length ? `did not answer: ${refusedForStaff.join(", ")}` : `${answered.length}/${SMOKE_ROUTES.length} answered`);
    check("hosted smoke pack refuses an anonymous caller", openToAnonymous.length === 0,
      openToAnonymous.length ? `answered without a session: ${openToAnonymous.join(", ")}` : "every route refused an anonymous caller");
  }

  // ── rollback reference ──────────────────────────────────────────────────────────────────────
  //
  // Required, not advisory. A deploy with no recorded predecessor is a deploy with no way back, and
  // the moment that matters is after it has already gone wrong.
  try {
    const reference = String(await rollbackReference() ?? "").trim();
    check("a rollback reference was recorded before this deploy", Boolean(reference), reference ? "recorded" : "no previous version was captured");
    report.rollbackReferenceRecorded = Boolean(reference);
  } catch (error) {
    unavailable("a rollback reference was recorded before this deploy", `the previous version could not be read (${error?.message})`);
    report.rollbackReferenceRecorded = false;
  }

  report.failures = failures;
  report.ok = failures === 0;
  report.unavailable = report.checks.filter(entry => entry.unavailable).map(entry => entry.name);
  log(`\n${report.ok ? "CERTIFIED" : "NOT CERTIFIED"} — ${report.checks.length - failures}/${report.checks.length} checks passed`);
  return report;
}

/**
 * The uploaded artifact. Every string that reaches it has already been through `sanitizeEvidenceDetail`
 * inside the gate; this rejects the whole artifact if a known sensitive value is present anyway, rather
 * than quietly redacting it - a leak that gets scrubbed on the way out is still a leak in the code path
 * that produced it.
 */
export function stagingEvidenceArtifact(report, sensitiveValues = []) {
  const serialized = JSON.stringify(report, null, 2);
  for (const sensitive of sensitiveValues) {
    const raw = String(sensitive ?? "");
    const escaped = JSON.stringify(raw).slice(1, -1);
    if (raw.length >= 8 && (serialized.includes(raw) || (escaped !== raw && serialized.includes(escaped)))) {
      throw new Error("Refusing to write the staging evidence artifact: it contains a sensitive value");
    }
  }
  return serialized;
}

// ── CLI: wire the real adapters. Only reached when this file is executed, never when imported. ──
export function isMainModule(argvPath, moduleUrl) { return Boolean(argvPath) && moduleUrl === pathToFileURL(argvPath).href; }
const isMain = isMainModule(process.argv[1], import.meta.url);
if (isMain) {
  const { execFileSync } = await import("node:child_process");
  const { writeFileSync } = await import("node:fs");

  const isolationOnly = process.argv.includes("--isolation-only");
  const required = isolationOnly ? ["EXPECTED_SHA", "STAGING_D1_ID"] : ["EXPECTED_SHA", "STAGING_URL", "STAGING_D1_ID", "PAWSPACE_UAT_ACCESS_CODE"];
  const missing = required.filter(name => !String(process.env[name] || "").trim());
  if (missing.length) {
    console.error(`staging certification: required environment is not configured (${missing.join(", ")}).`);
    process.exit(1);
  }
  const BASE = String(process.env.STAGING_URL).replace(/\/$/, "");
  const env = {
    EXPECTED_SHA: String(process.env.EXPECTED_SHA).trim(),
    WORKER_NAME: String(process.env.STAGING_WORKER || STAGING_WORKER_NAME).trim(),
    STAGING_D1_ID: String(process.env.STAGING_D1_ID).trim(),
    PRODUCTION_D1_ID: String(process.env.PRODUCTION_D1_ID || "").trim(),
    PRODUCTION_WORKER_NAME: String(process.env.PRODUCTION_WORKER_NAME || "").trim(),
    ACCESS_CODE: String(process.env.PAWSPACE_UAT_ACCESS_CODE).trim(),
  };
  const wrangler = args => execFileSync("npx", ["wrangler", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024, timeout: 60_000, killSignal: "SIGKILL" });

  const http = async (method, path, { headers = {}, body } = {}) => {
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    let parsed;
    try { parsed = await response.json(); } catch { parsed = undefined; }
    return { status: response.status, headers: response.headers, body: parsed };
  };

  // Addressed by ID, never by name: name resolution is exactly how a statement lands on the wrong
  // database, and this gate's first claim is that it did not.
  const d1 = async sql => {
    const raw = wrangler(["d1", "execute", env.STAGING_D1_ID, "--remote", "--json", "--command", sql]);
    const parsed = JSON.parse(raw);
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    return first?.results ?? [];
  };

  let activeVersion;
  const readActiveVersion = async () => {
    if (activeVersion) return activeVersion;
    const status = JSON.parse(wrangler(["deployments", "status", "--json", "--name", env.WORKER_NAME]));
    const versionId = activeVersionId(status);
    const viewed = JSON.parse(wrangler(["versions", "view", versionId, "--name", env.WORKER_NAME, "--json"]));
    if (String(viewed?.id ?? "") !== versionId) throw new StagingIsolationRefused("Refusing to certify: Wrangler returned a different version than the active deployment");
    activeVersion = viewed;
    return viewed;
  };
  const deployedConfig = async () => deployedConfigFromVersion(await readActiveVersion());
  const liveVersionMessage = async () => versionMessage(await readActiveVersion());

  const rollbackReference = async () => String(process.env.ROLLBACK_REFERENCE || "").trim();

  if (isolationOnly) {
    try { console.log(JSON.stringify(await runStagingIsolationPreflight({ deployedConfig, liveVersionMessage, env }))); process.exit(0); }
    catch (error) { console.error(error?.message ?? String(error)); process.exit(1); }
  }

  let report;
  try {
    report = await runStagingCertification({ http, d1, deployedConfig, liveVersionMessage, rollbackReference, env });
  } catch (error) {
    console.error(error instanceof StagingIsolationRefused ? error.message : `staging certification failed to start: ${error?.message}`);
    process.exit(1);
  }
  const out = String(process.env.EVIDENCE_PATH || "staging-certification.json");
  writeFileSync(out, stagingEvidenceArtifact(report, [env.ACCESS_CODE, env.STAGING_D1_ID, env.PRODUCTION_D1_ID]));
  console.log(`\nEvidence artifact written to ${out}`);
  process.exit(report.ok ? 0 : 1);
}
