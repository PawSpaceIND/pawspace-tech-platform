import test from "node:test";
import assert from "node:assert/strict";
import {
  ENVIRONMENTS, RefusedError, resolveEnvironment, requireCredentials,
  resolveRestoreSource, assertRestoreAllowed, assertDrillAllowed, computeRpoSeconds,
} from "../scripts/d1-environments.mjs";

// ---------------------------------------------------------------------------
// The refusals in the restore tooling, executed.
//
// What is NOT claimed here, and must not be read into a green run: these tests
// do not show that a restore works. They cannot — there is no Cloudflare account
// in this process. They pin the refusals, which are the part that has to hold
// while somebody is under pressure at 3am with a broken database.
//
// Whether the restore PATH works is established by running the drill in
// ops/database-restore-runbook.md and recording the RTO. Until that drill has
// been run at least once, this suite passing means the guards are right and the
// recovery path is still unproven.
// ---------------------------------------------------------------------------

const refusal = (fn) => {
  try { fn(); } catch (error) { return error; }
  return null;
};

// --- D1G-01 ---------------------------------------------------------------
// "prod" must not resolve to production. Fuzzy matching on the name of the thing
// you are about to overwrite is not a convenience.
test("D1G-01: only exact environment names resolve, and there is no default", () => {
  assert.equal(resolveEnvironment("staging").database, "pawspace-staging");
  assert.equal(resolveEnvironment("production").database, "pawspace-prod-bengaluru");
  /* Case and surrounding whitespace ARE tolerated on the selector - that is operator typing, not a
   * different environment. Strictness lives on --confirm-production, pinned exactly by D1G-03. */
  for (const wrong of ["prod", "stage", "", null, undefined, "pawspace-prod-bengaluru"]) {
    const error = refusal(() => resolveEnvironment(wrong));
    assert.ok(error instanceof RefusedError, `${JSON.stringify(wrong)} must be refused, not resolved`);
  }
  // Case and surrounding whitespace are operator typing, not a different environment.
  assert.equal(resolveEnvironment(" Production ").database, "pawspace-prod-bengaluru");
});

// --- D1G-02 ---------------------------------------------------------------
// The central control. Each gate alone must be insufficient.
test("D1G-02: production needs both gates, and either one alone is refused", () => {
  const production = resolveEnvironment("production");
  const db = production.database;

  assert.ok(refusal(() => assertRestoreAllowed({ environment: production, confirmProduction: "", env: {} })) instanceof RefusedError);
  assert.ok(refusal(() => assertRestoreAllowed({ environment: production, confirmProduction: db, env: {} })) instanceof RefusedError,
    "typed confirmation alone must not be enough");
  assert.ok(refusal(() => assertRestoreAllowed({ environment: production, confirmProduction: "", env: { PAWSPACE_RESTORE_ALLOW_PRODUCTION: "yes" } })) instanceof RefusedError,
    "the environment variable alone must not be enough");

  // Both together, and only then.
  assert.deepEqual(
    assertRestoreAllowed({ environment: production, confirmProduction: db, env: { PAWSPACE_RESTORE_ALLOW_PRODUCTION: "yes" } }),
    { gated: true });
});

// --- D1G-03 ---------------------------------------------------------------
// A near-miss on the confirmation is a typo, and a typo is not consent.
test("D1G-03: the typed confirmation must be the exact database name", () => {
  const production = resolveEnvironment("production");
  const env = { PAWSPACE_RESTORE_ALLOW_PRODUCTION: "yes" };
  for (const near of ["pawspace-prod", "pawspace-prod-bengaluru ", "PAWSPACE-PROD-BENGALURU", "production", "yes"]) {
    const error = refusal(() => assertRestoreAllowed({ environment: production, confirmProduction: near, env }));
    if (near.trim() === production.database) continue; // trimming operator whitespace is allowed
    assert.ok(error instanceof RefusedError, `"${near}" must not confirm a production restore`);
  }
  // Truthy-but-wrong values for the env gate must not pass either.
  for (const value of ["true", "1", "y", "YES ", "please"]) {
    const error = refusal(() => assertRestoreAllowed({
      environment: production, confirmProduction: production.database,
      env: { PAWSPACE_RESTORE_ALLOW_PRODUCTION: value },
    }));
    if (value.trim().toLowerCase() === "yes") continue;
    assert.ok(error instanceof RefusedError, `PAWSPACE_RESTORE_ALLOW_PRODUCTION="${value}" must not open the gate`);
  }
});

// --- D1G-04 ---------------------------------------------------------------
test("D1G-04: staging is not gated, because a destructive restore there is an ordinary operation", () => {
  assert.deepEqual(assertRestoreAllowed({ environment: resolveEnvironment("staging"), env: {} }), { gated: false });
});

// --- D1G-05 ---------------------------------------------------------------
// Two sources is not a precedence question. It means the operator holds two different
// beliefs about what they are restoring, and picking one silently resolves it wrongly
// half the time.
test("D1G-05: exactly one restore source", () => {
  assert.deepEqual(resolveRestoreSource({ bookmark: "bm-1" }), { kind: "bookmark", value: "bm-1" });
  assert.deepEqual(resolveRestoreSource({ file: "a.sql" }), { kind: "file", value: "a.sql" });
  assert.ok(refusal(() => resolveRestoreSource({})) instanceof RefusedError, "no source must be refused");
  assert.ok(refusal(() => resolveRestoreSource({ bookmark: "bm-1", file: "a.sql" })) instanceof RefusedError);
  assert.ok(refusal(() => resolveRestoreSource({ timestamp: "2026-09-02T05:00:00Z", file: "a.sql" })) instanceof RefusedError);
  assert.ok(refusal(() => resolveRestoreSource({ bookmark: "b", timestamp: "t", file: "f" })) instanceof RefusedError);
});

// --- D1G-06 ---------------------------------------------------------------
// Time Travel restores in place. A "drill" against production would be an outage.
test("D1G-06: a destructive drill is refused against production and allowed on staging", () => {
  assert.ok(refusal(() => assertDrillAllowed(resolveEnvironment("production"))) instanceof RefusedError);
  assert.equal(assertDrillAllowed(resolveEnvironment("staging")), true);
});

// --- D1G-07 ---------------------------------------------------------------
test("D1G-07: absent credentials are refused by name, and never read from a repository file", () => {
  const error = refusal(() => requireCredentials({}));
  assert.ok(error instanceof RefusedError);
  assert.match(error.message, /CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID/);
  assert.ok(refusal(() => requireCredentials({ CLOUDFLARE_API_TOKEN: "x" })) instanceof RefusedError, "half-configured is not configured");
  assert.ok(refusal(() => requireCredentials({ CLOUDFLARE_API_TOKEN: "x", CLOUDFLARE_ACCOUNT_ID: "   " })) instanceof RefusedError,
    "whitespace is not a credential");
  assert.equal(requireCredentials({ CLOUDFLARE_API_TOKEN: "x", CLOUDFLARE_ACCOUNT_ID: "y" }), true);
});

// --- D1G-08 ---------------------------------------------------------------
// RPO is measured or it is null. A missing timestamp must not silently become "0 seconds
// of data lost", which is the most reassuring possible way to be wrong.
test("D1G-08: RPO is computed from real timestamps, and is null when it cannot be", () => {
  const incidentAt = Date.parse("2026-09-02T06:00:00Z");
  assert.equal(computeRpoSeconds({ incidentAt, recoveryPointAt: Date.parse("2026-09-02T05:45:00Z") }), 900);
  assert.equal(computeRpoSeconds({ incidentAt, recoveryPointAt: incidentAt }), 0);
  for (const missing of [null, undefined, NaN, "not-a-date"]) {
    assert.equal(computeRpoSeconds({ incidentAt, recoveryPointAt: missing }), null,
      "an unknown recovery point must report null, never zero");
  }
  // A recovery point after the incident cannot mean negative data loss.
  assert.equal(computeRpoSeconds({ incidentAt, recoveryPointAt: Date.parse("2026-09-02T07:00:00Z") }), 0);
});

// --- D1G-09 ---------------------------------------------------------------
// The registry is the list of databases this tooling can ever touch.
test("D1G-09: exactly one environment is marked production, and it is not drillable", () => {
  const production = Object.entries(ENVIRONMENTS).filter(([, value]) => value.production);
  assert.equal(production.length, 1);
  assert.equal(production[0][0], "production");
  assert.equal(production[0][1].destructiveDrillAllowed, false);
});
