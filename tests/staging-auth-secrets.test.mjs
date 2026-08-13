import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";

// ---------------------------------------------------------------------------
// Staging UAT sign-in: four confirmed defects, each pinned here.
//
//   1. scripts/stage-config.mjs carried committed fallbacks for the UAT access code, the UAT signing
//      key and the identity-assertion secret — all readable in a public repository. The signing key is
//      what mints the cookie resolveActor trusts, so anyone who could read the repo could forge a
//      staging staff session.
//   2. .github/workflows/deploy-staging.yml passed ONLY STAGING_D1_ID to that script, so those
//      fallbacks were not a latent risk: they were what every CI deploy actually shipped.
//   3. The script printed the access code, putting it in every build log.
//   4. resolveUatStaffActor defaulted an unrecognised email to roleCode "founder" with ["*"], so the
//      access code alone conferred full authority over the staging workspace.
//
// Production is unaffected by construction: every path here is gated on PAWSPACE_UAT_LOGIN === "on",
// which only the staging build sets. The last test pins that gate.
// ---------------------------------------------------------------------------
const WORKERS_SHIM = `export const env = new Proxy({}, { get: (_, key) => globalThis.__PAWSPACE_TEST_ENV?.[key] });`;
const workersUrl = `data:text/javascript,${encodeURIComponent(WORKERS_SHIM)}`;
if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true };
      try { return nextResolve(specifier, context); }
      catch (error) {
        if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context);
        throw error;
      }
    },
  });
}

const uat = await import("../lib/uat-staging-auth.ts");
const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const stageConfig = read("scripts/stage-config.mjs");
const workflow = read(".github/workflows/deploy-staging.yml");

// The exact strings that were committed. They are public forever, so they must never work again.
const BURNED = ["pawspace-uat-2026", "pawspace-staging-uat-signing-key-do-not-reuse-in-prod", "pawspace-staging-identity-assertion-uat-secret"];

function makeD1(sqlite) {
  const statement = (sql, args) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
    run: async () => { sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: 0 } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return { prepare: (sql) => statement(sql, []), batch: async (list) => { for (const item of list) await item.run(); return []; }, exec: async (sql) => { sqlite.exec(sql); } };
}

/** A staff directory with one active user, one suspended, and one role that has no definition. */
function staffDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE app_users (id TEXT PRIMARY KEY,email TEXT NOT NULL,name TEXT,role_code TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE role_definitions (code TEXT PRIMARY KEY,permissions_json TEXT NOT NULL)");
  sqlite.prepare("INSERT INTO app_users VALUES (?,?,?,?,?,?,?)").run("U1", "real.manager@tkpetcare.in", "Real Manager", "manager", "active", 0, 0);
  sqlite.prepare("INSERT INTO app_users VALUES (?,?,?,?,?,?,?)").run("U2", "left.the.company@tkpetcare.in", "Former Staff", "manager", "suspended", 0, 0);
  sqlite.prepare("INSERT INTO app_users VALUES (?,?,?,?,?,?,?)").run("U3", "orphan.role@tkpetcare.in", "Orphan Role", "role_that_does_not_exist", "active", 0, 0);
  sqlite.prepare("INSERT INTO role_definitions VALUES (?,?)").run("manager", JSON.stringify(["bookings.view", "attendance.view"]));
  return makeD1(sqlite);
}

const ENV = { PAWSPACE_UAT_LOGIN: "on", PAWSPACE_UAT_SIGNING_KEY: "a-test-signing-key-that-is-long-enough-32", PAWSPACE_UAT_ACCESS_CODE: "a-test-access-code-16" };
const cookieFor = async (email) => new Request("http://localhost/x", { headers: { cookie: `pawspace_uat=${encodeURIComponent(await uat.issueUatToken(ENV, email, 3600))}` } });

// ---------------------------------------------------------------------------
// 1 + 2. No committed fallback, and the deploy fails closed without the secrets.
// ---------------------------------------------------------------------------
test("no authentication secret has a committed usable fallback", () => {
  for (const burned of BURNED) {
    // The value may appear only in the refusal list, never as a `|| "default"`.
    const asFallback = new RegExp(`\\|\\|\\s*["'\`]${burned.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
    assert.doesNotMatch(stageConfig, asFallback, `${burned} must not be a fallback value`);
  }
  assert.doesNotMatch(stageConfig, /PAWSPACE_UAT_ACCESS_CODE\s*\|\|\s*["'`][^"'`]+["'`]/, "the access code must have no default");
  assert.doesNotMatch(stageConfig, /PAWSPACE_UAT_SIGNING_KEY\s*\|\|\s*["'`][^"'`]+["'`]/, "the signing key must have no default");
  assert.doesNotMatch(stageConfig, /PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT\s*\|\|\s*["'`][^"'`]+["'`]/, "the identity secret must have no default");
});

/** Run the real script in a throwaway directory with a stub build output. */
function runStageConfig(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stage-config-"));
  fs.mkdirSync(path.join(dir, "dist", "server"), { recursive: true });
  fs.writeFileSync(path.join(dir, "dist", "server", "wrangler.json"), JSON.stringify({ name: "x", vars: {} }));
  const script = new URL("../scripts/stage-config.mjs", import.meta.url).pathname;
  try {
    const stdout = execFileSync(process.execPath, [script], { cwd: dir, env: { PATH: process.env.PATH, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, stdout, config: JSON.parse(fs.readFileSync(path.join(dir, "dist", "server", "wrangler.json"), "utf8")) };
  } catch (error) {
    return { code: error.status ?? 1, stdout: String(error.stdout || ""), stderr: String(error.stderr || "") };
  }
}

const GOOD = { STAGING_D1_ID: "11111111-2222-4333-8444-555555555555", PAWSPACE_UAT_ACCESS_CODE: "a-real-access-code-1", PAWSPACE_UAT_SIGNING_KEY: "0123456789abcdef0123456789abcdef01", PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT: "fedcba9876543210fedcba9876543210fe" };

test("real execution: the deploy fails closed when any required secret is missing", () => {
  for (const omit of ["PAWSPACE_UAT_ACCESS_CODE", "PAWSPACE_UAT_SIGNING_KEY", "PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT"]) {
    const env = { ...GOOD };
    delete env[omit];
    const result = runStageConfig(env);
    assert.notEqual(result.code, 0, `omitting ${omit} must fail the deploy, not fall back to a default`);
    assert.match(result.stderr, new RegExp(omit), "the failure must name the missing variable");
    assert.match(result.stderr, /secrets\./, "and point at where to supply it");
  }
});

test("real execution: the deploy refuses a value that was committed to this repository", () => {
  const attempts = [
    ["PAWSPACE_UAT_ACCESS_CODE", BURNED[0]],
    ["PAWSPACE_UAT_SIGNING_KEY", BURNED[1]],
    ["PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT", BURNED[2]],
  ];
  for (const [name, burned] of attempts) {
    const result = runStageConfig({ ...GOOD, [name]: burned });
    assert.notEqual(result.code, 0, `${name} must not accept the value that was published in the repo`);
    assert.match(result.stderr, /public/, "the refusal must say why");
  }
});

test("real execution: a too-weak secret is refused rather than accepted quietly", () => {
  assert.notEqual(runStageConfig({ ...GOOD, PAWSPACE_UAT_SIGNING_KEY: "short" }).code, 0);
  assert.notEqual(runStageConfig({ ...GOOD, PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT: "also-too-short" }).code, 0);
  assert.notEqual(runStageConfig({ ...GOOD, PAWSPACE_UAT_ACCESS_CODE: "tiny" }).code, 0);
});

test("real execution: with every secret supplied, the config is written from the environment", () => {
  const result = runStageConfig(GOOD);
  assert.equal(result.code, 0, `expected success, got: ${result.stderr}`);
  assert.equal(result.config.vars.PAWSPACE_UAT_ACCESS_CODE, GOOD.PAWSPACE_UAT_ACCESS_CODE);
  assert.equal(result.config.vars.PAWSPACE_UAT_SIGNING_KEY, GOOD.PAWSPACE_UAT_SIGNING_KEY);
  assert.equal(result.config.vars.PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT, GOOD.PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT);
  assert.equal(result.config.vars.PAWSPACE_PAYMENT_ENV, "sandbox", "sandbox payments are preserved");
  assert.equal(result.config.name, "pawspace-staging", "existing behaviour is preserved");
});

// ---------------------------------------------------------------------------
// 3. Nothing secret is printed.
// ---------------------------------------------------------------------------
test("real execution: no credential appears in the deploy output", () => {
  const result = runStageConfig(GOOD);
  const output = `${result.stdout}${result.stderr || ""}`;
  for (const secret of [GOOD.PAWSPACE_UAT_ACCESS_CODE, GOOD.PAWSPACE_UAT_SIGNING_KEY, GOOD.PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT]) {
    assert.ok(!output.includes(secret), "the deploy log must not contain a credential");
  }
  assert.doesNotMatch(stageConfig, /access code="\$\{accessCode\}"/, "the access code was printed here; it must not be");
  assert.match(result.stdout, /not logged/, "and it should say that it withheld them");
});

test("the workflow supplies all three from GitHub secrets", () => {
  for (const name of ["PAWSPACE_UAT_ACCESS_CODE", "PAWSPACE_UAT_SIGNING_KEY", "PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT"]) {
    assert.match(workflow, new RegExp(`${name}:\\s*\\$\\{\\{\\s*secrets\\.${name}\\s*\\}\\}`), `${name} must come from secrets.${name}`);
    assert.doesNotMatch(workflow, new RegExp(`${name}:\\s*\\$\\{\\{\\s*vars\\.${name}`), `${name} must not come from a repository VARIABLE, which is not secret`);
  }
});

// ---------------------------------------------------------------------------
// 4. An arbitrary email must never receive founder / ["*"].
// ---------------------------------------------------------------------------
test("real execution: an unrecognised email gets no actor at all, never founder", async () => {
  const db = staffDb();
  const actor = await uat.resolveUatStaffActor(db, await cookieFor("anyone@example.com"), ENV);
  assert.equal(actor, null, "a valid cookie for an unknown email must resolve to nobody");
});

test("real execution: a seeded staff email gets exactly its own role and permissions", async () => {
  const db = staffDb();
  const actor = await uat.resolveUatStaffActor(db, await cookieFor("real.manager@tkpetcare.in"), ENV);
  assert.equal(actor.roleCode, "manager", "the directory decides the role");
  assert.deepEqual(actor.permissions, ["bookings.view", "attendance.view"], "and the role definition decides the permissions");
  assert.ok(!actor.permissions.includes("*"), "no wildcard is granted");
  assert.equal(actor.developmentPreview, false);
});

test("real execution: a suspended account and an undefined role both resolve to nobody", async () => {
  const db = staffDb();
  assert.equal(await uat.resolveUatStaffActor(db, await cookieFor("left.the.company@tkpetcare.in"), ENV), null, "a suspended account must not sign in");
  // A role with no definition previously fell through to permissions [] but kept the actor; now it
  // grants no actor, because a role nobody defined must not be treated as a role.
  assert.equal(await uat.resolveUatStaffActor(db, await cookieFor("orphan.role@tkpetcare.in"), ENV), null, "an undefined role grants nothing");
});

test("sign-in itself refuses an unrecognised email, so a tester is told immediately", async () => {
  const db = staffDb();
  assert.equal(await uat.uatStaffIdentityAllowed(db, "real.manager@tkpetcare.in"), true);
  assert.equal(await uat.uatStaffIdentityAllowed(db, "anyone@example.com"), false);
  assert.equal(await uat.uatStaffIdentityAllowed(db, "left.the.company@tkpetcare.in"), false, "suspended is not allowed");
  const route = read("app/api/staging-login/route.ts");
  assert.match(route, /uatStaffIdentityAllowed/, "the login route must check the staff directory");
  assert.match(route, /403/, "and refuse rather than issue a cookie");
});

test("the founder default is gone from the source, not merely unreachable", () => {
  const source = read("lib/uat-staging-auth.ts");
  assert.doesNotMatch(source, /permissions\s*:\s*string\[\]\s*=\s*\[\s*["'`]\*["'`]\s*\]/, "no synthesised wildcard permission set");
  assert.doesNotMatch(source, /roleCode\s*=\s*["'`]founder["'`]/, "no synthesised founder role");
});

// ---------------------------------------------------------------------------
// Containment: rotating the signing key invalidates every cookie minted with the old one.
//
// The UAT token is stateless — {email, exp} plus an HMAC — with no jti, key version, not-before or
// revocation table. That is acceptable for this incident ONLY because verification uses exactly one
// key: the currently configured PAWSPACE_UAT_SIGNING_KEY. There is no previous-key fallback and no
// dual-key window, so the moment staging is redeployed with a fresh key, every cookie signed with the
// burned key stops verifying immediately — including cookies still inside their 8-hour TTL.
//
// These tests are the evidence for that claim, and the last one is what would fail if anybody later
// added a compatibility path.
// ---------------------------------------------------------------------------
const BURNED_KEY = "pawspace-staging-uat-signing-key-do-not-reuse-in-prod";
const ROTATED_ENV = { PAWSPACE_UAT_LOGIN: "on", PAWSPACE_UAT_SIGNING_KEY: "a-freshly-rotated-signing-key-32ch", PAWSPACE_UAT_ACCESS_CODE: "a-rotated-access-code" };
const BURNED_ENV = { ...ROTATED_ENV, PAWSPACE_UAT_SIGNING_KEY: BURNED_KEY };
const requestWith = (token) => new Request("http://localhost/x", { headers: { cookie: `pawspace_uat=${encodeURIComponent(token)}` } });

test("real execution: a cookie signed with the burned key is refused once the key is rotated", async () => {
  const db = staffDb();
  // Minted while the compromised key was live, and still well inside its 8-hour TTL.
  const oldToken = await uat.issueUatToken(BURNED_ENV, "real.manager@tkpetcare.in", 8 * 3600);
  assert.ok(await uat.resolveUatStaffActor(db, requestWith(oldToken), BURNED_ENV), "sanity: it did work against the old key");

  const afterRotation = await uat.resolveUatStaffActor(db, requestWith(oldToken), ROTATED_ENV);
  assert.equal(afterRotation, null, "after rotation the old cookie must resolve to nobody, TTL notwithstanding");
});

test("real execution: a cookie signed with the rotated key succeeds", async () => {
  const db = staffDb();
  const newToken = await uat.issueUatToken(ROTATED_ENV, "real.manager@tkpetcare.in", 3600);
  const actor = await uat.resolveUatStaffActor(db, requestWith(newToken), ROTATED_ENV);
  assert.ok(actor, "the new key must produce a working session");
  assert.equal(actor.roleCode, "manager");
});

test("real execution: expiry still works normally after rotation", async () => {
  const db = staffDb();
  // issueUatToken floors the TTL at 60s, so expire it by rewinding the clock the token was built from.
  const realNow = Date.now;
  Date.now = () => realNow() - 10 * 3600 * 1000;
  const expired = await uat.issueUatToken(ROTATED_ENV, "real.manager@tkpetcare.in", 3600);
  Date.now = realNow;
  assert.equal(await uat.resolveUatStaffActor(db, requestWith(expired), ROTATED_ENV), null, "an expired token is refused even though its signature is valid");

  const live = await uat.issueUatToken(ROTATED_ENV, "real.manager@tkpetcare.in", 3600);
  assert.ok(await uat.resolveUatStaffActor(db, requestWith(live), ROTATED_ENV), "and a live one still works, so expiry is not refusing everything");
});

test("no previous-key fallback or dual-key verification path exists", () => {
  const source = read("lib/uat-staging-auth.ts");
  // Exactly one key is read, and the same one signs and verifies.
  const keyReads = [...source.matchAll(/PAWSPACE_UAT_SIGNING_KEY/g)].length;
  const references = [...source.matchAll(/env(?:\?)?\.PAWSPACE_UAT_SIGNING_KEY/g)].length;
  assert.ok(references >= 2, "the key is used to sign and to verify");
  assert.ok(keyReads <= 4, `only the one signing key may be referenced, found ${keyReads} mentions`);
  for (const forbidden of [/PREVIOUS_SIGNING_KEY/i, /OLD_SIGNING_KEY/i, /previousKey/, /fallbackKey/, /SIGNING_KEYS/, /keyVersion/, /\bkid\b/]) {
    assert.doesNotMatch(source, forbidden, "no key-rotation compatibility window may be introduced");
  }
  // verifyUatToken compares against one computed HMAC and returns null otherwise: no second attempt.
  assert.match(source, /const expect=await hmac\(String\(env\.PAWSPACE_UAT_SIGNING_KEY\),payload\);\s*\n\s*if\(expect!==sig\)return null;/, "verification is a single comparison against the configured key");
});

// ---------------------------------------------------------------------------
// The whole suite must not re-encode the old vulnerability.
// ---------------------------------------------------------------------------
test("no test anywhere treats a burned credential as a working credential", () => {
  const offenders = [];
  for (const name of fs.readdirSync("tests")) {
    if (!name.endsWith(".mjs")) continue;
    const source = fs.readFileSync(path.join("tests", name), "utf8");
    for (const burned of BURNED) {
      if (!source.includes(burned)) continue;
      // This file is allowed to name them — it exists to assert they are refused.
      if (name === "staging-auth-secrets.test.mjs") continue;
      offenders.push(`${name} contains ${burned.slice(0, 24)}…`);
    }
  }
  assert.deepEqual(offenders, [], `a test still carries a committed credential: ${offenders.join("; ")}`);
});

test("no test asserts that an unknown identity receives full permissions", () => {
  const offenders = [];
  for (const name of fs.readdirSync("tests")) {
    if (!name.endsWith(".mjs")) continue;
    const source = fs.readFileSync(path.join("tests", name), "utf8");
    // The shape that encoded the defect: issue a UAT token, then assert permissions ["*"].
    if (!/issueUatToken/.test(source)) continue;
    const assertsWildcard = /permissions,\s*\[\s*["'`]\*["'`]\s*\]/.test(source);
    if (!assertsWildcard) continue;
    // Allowed only when the identity is explicitly seeded into the staff directory first.
    if (/seedStaff|app_users/.test(source)) continue;
    offenders.push(name);
  }
  assert.deepEqual(offenders, [], `these tests grant ["*"] to an unseeded UAT identity: ${offenders.join(", ")}`);
});

// ---------------------------------------------------------------------------
// Production behaviour is unchanged.
// ---------------------------------------------------------------------------
test("every UAT path stays dead in production, where the flag is unset", async () => {
  const db = staffDb();
  for (const env of [{}, { PAWSPACE_UAT_LOGIN: "off" }, { PAWSPACE_UAT_LOGIN: "on" }, { PAWSPACE_UAT_SIGNING_KEY: "0123456789abcdef0123456789abcdef01" }]) {
    assert.equal(uat.uatLoginEnabled(env), false, "the flag AND a key are both required");
    assert.equal(await uat.resolveUatStaffActor(db, await cookieFor("real.manager@tkpetcare.in"), env), null, "no UAT actor resolves without the flag");
  }
  // Production keeps the original 401 body byte-for-byte.
  const production = await uat.signInRequiredResponse({}).json();
  assert.deepEqual(production, { error: "Authentication required" }, "the production 401 body must not change");
  const staging = await uat.signInRequiredResponse(ENV).json();
  assert.equal(staging.code, "sign_in_required", "staging keeps its recoverable message");
});
