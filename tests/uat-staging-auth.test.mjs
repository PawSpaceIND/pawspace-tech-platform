/**
 * Staging-only UAT sign-in — EXECUTED.
 *
 * WHAT THIS FILE USED TO BE. Four tests that read `lib/uat-staging-auth.ts`, `lib/server-auth.ts`,
 * the login route, the gateway and `scripts/stage-config.mjs` as strings. "UAT sign-in is
 * production-safe: flag-gated and dead unless enabled" asserted that the regex
 * /PAWSPACE_UAT_LOGIN.*==="on".*PAWSPACE_UAT_SIGNING_KEY/s matched the source — which is satisfied by
 * the two names appearing in that order anywhere in the file, including in a comment. The claim it was
 * making is the most safety-critical one in the module (this path mints an authenticated staff actor),
 * and it was never once executed.
 *
 * Now the flag gate, the access-code check, the cookie signature and the gateway wiring all run.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { freshSqlite, makeD1 } from "./helpers/taxi-harness.mjs";

installWorkersHooks("__UAT_AUTH_DB__", "__UAT_AUTH_ENV__");

const uat = await import("../lib/uat-staging-auth.ts");

/** A key at the module's own documented floor. Not a credential — a test value. */
const KEY = "x".repeat(uat.UAT_SIGNING_KEY_MIN_LENGTH);
const CODE = "y".repeat(32);
const STAFF = "uat.tester@pawspace.test";
const enabledEnv = (extra = {}) => ({ PAWSPACE_UAT_LOGIN: "on", PAWSPACE_UAT_SIGNING_KEY: KEY, PAWSPACE_UAT_ACCESS_CODE: CODE, ...extra });

/** A staging world with one ACTIVE seeded staff identity holding a real role. */
async function uatWorld({ role = "manager", status = "active", env = enabledEnv() } = {}) {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__UAT_AUTH_DB__ = db;
  globalThis.__UAT_AUTH_ENV__ = env;
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db);
  const now = Date.now();
  sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('U-UAT',?,?,?,?,?,?)")
    .run(STAFF, "UAT Tester", role, status, now, now);
  return { sqlite, db, env };
}

/** A request carrying a UAT cookie for `email`, signed with `env`'s key. */
async function signedRequest(env, email, { url = "https://staging.pawspace.example/api/anything", ttl = 3600 } = {}) {
  const token = await uat.issueUatToken(env, email, ttl);
  return new Request(url, { headers: { cookie: `pawspace_uat=${token}` } });
}

// ---------------------------------------------------------------------------------------------
test("UAT sign-in is production-safe: flag-gated and dead unless enabled", async () => {
  // THE PRODUCTION CASE FIRST: with neither var set — which is production — the whole path is off.
  assert.equal(uat.uatLoginEnabled({}), false, "unset means off, which is what makes this production-safe");
  assert.equal(uat.uatLoginEnabled({ PAWSPACE_UAT_LOGIN: "on" }), false, "the flag alone is not enough without a signing key");
  assert.equal(uat.uatLoginEnabled({ PAWSPACE_UAT_SIGNING_KEY: KEY }), false, "nor a key without the flag");

  /*
   * The key floor is enforced, not merely documented.
   *
   * Asserted against the LITERAL 32 and a LITERAL 16-character key, not against
   * uat.UAT_SIGNING_KEY_MIN_LENGTH. Measured: an earlier version derived the short key from the
   * constant, which made the assertion self-referential — lowering the floor to 8 moved both sides at
   * once and the test stayed green. A floor that can be lowered without a test noticing is not a floor.
   */
  assert.equal(uat.UAT_SIGNING_KEY_MIN_LENGTH, 32, "the documented floor is 32 characters");
  assert.equal(uat.uatLoginEnabled({ PAWSPACE_UAT_LOGIN: "on", PAWSPACE_UAT_SIGNING_KEY: "x".repeat(16) }), false,
    "a 16-character key must leave the branch OFF rather than on with a weak key");
  assert.equal(uat.uatLoginEnabled({ PAWSPACE_UAT_LOGIN: "on", PAWSPACE_UAT_SIGNING_KEY: "x".repeat(31) }), false,
    "and one character under the floor is still refused");
  assert.equal(uat.uatLoginEnabled(enabledEnv()), true, "and at the floor it is on — non-vacuity for every case above");

  // resolveUatStaffActor is a NO-OP when disabled, even with a cookie that would otherwise be valid.
  const off = await uatWorld({ env: {} });
  const cookie = await signedRequest(enabledEnv(), STAFF);
  assert.equal(await uat.resolveUatStaffActor(off.db, cookie, {}), null,
    "a validly signed cookie must resolve to nothing when the feature is off — this is the production guarantee");

  /*
   * THE CASE THAT ACTUALLY TESTS THE FLAG: signing key PRESENT, flag ABSENT.
   *
   * Measured — deleting the `if(!uatLoginEnabled(env))return null;` guard from resolveUatStaffActor
   * survived the assertion above, because with an empty env the signature check fails anyway and masks
   * the missing guard. The flag is only load-bearing when a valid key IS configured and the flag is
   * not, which is exactly the configuration a half-provisioned production worker would be in. Here the
   * cookie is signed with the very key in the env, so nothing but the flag can refuse it.
   */
  const keyButNoFlag = { PAWSPACE_UAT_SIGNING_KEY: KEY };
  const keyed = await uatWorld({ env: keyButNoFlag });
  const validlySigned = await signedRequest(keyButNoFlag, STAFF);
  assert.equal(await uat.resolveUatStaffActor(keyed.db, validlySigned, keyButNoFlag), null,
    "with a real key but no flag, a correctly signed cookie must still resolve to nothing");

  // Enabled, the same cookie resolves to the SEEDED identity and its real role. Nothing is synthesised.
  const on = await uatWorld();
  const actor = await uat.resolveUatStaffActor(on.db, await signedRequest(on.env, STAFF), on.env);
  assert.ok(actor, "an enabled staging worker honours the signed cookie");
  assert.equal(actor.email, STAFF);
  assert.equal(actor.roleCode, "manager", "the role comes from app_users, not from the cookie");
  assert.equal(actor.permissions.includes("*"), false,
    "a UAT tester must NOT be handed the wildcard — an unrecognised identity once defaulted to founder");

  // A COOKIE SIGNED WITH THE WRONG KEY IS REFUSED. This is what "signed cookie" has to mean.
  const forged = await signedRequest(enabledEnv({ PAWSPACE_UAT_SIGNING_KEY: "z".repeat(uat.UAT_SIGNING_KEY_MIN_LENGTH) }), STAFF);
  assert.equal(await uat.resolveUatStaffActor(on.db, forged, on.env), null, "a cookie signed with another key must not resolve");

  // An identity that is not provisioned, or is disabled, resolves to nothing rather than to a default.
  const unknown = await uat.resolveUatStaffActor(on.db, await signedRequest(on.env, "nobody@pawspace.test"), on.env);
  assert.equal(unknown, null, "an unprovisioned email must not become an actor");
  const disabled = await uatWorld({ status: "disabled" });
  assert.equal(await uat.resolveUatStaffActor(disabled.db, await signedRequest(disabled.env, STAFF), disabled.env), null,
    "a disabled identity must not sign in");
});

// ---------------------------------------------------------------------------------------------
test("stage-config turns UAT login ON for staging only, with an access code + signing key", async () => {
  /*
   * DELIBERATELY STILL A SOURCE ASSERTION, and the only one left in this file.
   *
   * scripts/stage-config.mjs is a DEPLOY-TIME configuration generator, not a library. At module load
   * it validates the environment and calls process.exit(1) when a secret is missing — measured: a
   * dynamic import of it from a test kills the whole test process, and `.catch()` cannot intercept
   * process.exit. Supplying a full staging environment to get past that would then have it WRITE the
   * wrangler config into the working tree. There is no in-process way to execute it, so the shape of
   * the config it generates is a build-config invariant of exactly the kind that cannot be driven.
   *
   * What IS runtime-enforced is executed elsewhere in this file rather than pinned here: the flag +
   * signing-key gate and the 32-character key floor are asserted behaviourally in the first test, and
   * the access-code comparison in the third. So the security guarantee is executed; only the
   * generator's output shape is matched as text.
   */
  const source = await readFile(new URL("../scripts/stage-config.mjs", import.meta.url), "utf8");
  assert.match(source, /PAWSPACE_UAT_LOGIN: "on"/, "staging turns the flag on");
  assert.match(source, /PAWSPACE_UAT_ACCESS_CODE/, "and requires an access code");
  assert.match(source, /PAWSPACE_UAT_SIGNING_KEY/, "and a signing key");
  // The burned-credential denylist and the dev-only leak check are the security-bearing parts of this
  // generator; assert they are still present by NAME, since their values are what a reviewer checks.
  assert.match(source, /BURNED_CREDENTIALS/, "credentials published in this repository stay denylisted");
  assert.match(source, /DEV_ONLY_VARS/, "and the preview flag cannot leak into a staging config");
  assert.match(source, /PAWSPACE_LOCAL_PREVIEW/, "which is the flag that would otherwise mint a ['*'] actor");
});

// ---------------------------------------------------------------------------------------------
test("the login route requires the access code and only works when enabled", async () => {
  const route = await import("../app/api/staging-login/route.ts");
  const url = "https://staging.pawspace.example/api/staging-login";
  const attempt = async (body) => {
    const response = await route.POST(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    return { status: response.status, body: await response.json().catch(() => null), setCookie: response.headers.get("set-cookie") };
  };

  // DISABLED: the endpoint must not mint a session at all.
  await uatWorld({ env: {} });
  const whenOff = await attempt({ email: STAFF, code: CODE });
  assert.notEqual(whenOff.status, 200, `sign-in must be unavailable when the feature is off: ${JSON.stringify(whenOff).slice(0, 250)}`);
  assert.equal(whenOff.setCookie, null, "and must set no cookie");

  // ENABLED but with the WRONG code: refused, no cookie.
  await uatWorld();
  const wrongCode = await attempt({ email: STAFF, code: "not-the-code" });
  assert.notEqual(wrongCode.status, 200, `a wrong access code must be refused: ${JSON.stringify(wrongCode).slice(0, 250)}`);
  assert.match(String(wrongCode.body?.error ?? ""), /access code/i);
  assert.equal(wrongCode.setCookie, null, "and must set no cookie");

  // The access-code comparison itself, executed against the module.
  assert.equal(uat.uatAccessCodeValid(enabledEnv(), CODE), true);
  assert.equal(uat.uatAccessCodeValid(enabledEnv(), "not-the-code"), false);
  assert.equal(uat.uatAccessCodeValid({}, ""), false, "an unset expected code must never be satisfied by an empty one");
  assert.equal(uat.uatAccessCodeValid({ PAWSPACE_UAT_ACCESS_CODE: "" }, ""), false, "nor by an empty configured value");

  // ENABLED with the RIGHT code: a session cookie is issued for a provisioned identity.
  const ok = await attempt({ email: STAFF, code: CODE });
  assert.equal(ok.status, 200, `the happy path must work, or every refusal above is vacuous: ${JSON.stringify(ok).slice(0, 250)}`);
  assert.match(String(ok.setCookie ?? ""), /pawspace_uat=/, "a signed session cookie is set");
  assert.match(String(ok.setCookie ?? ""), /HttpOnly/i, "not readable from script");

  // And the expiry response tells a tester how to recover rather than saying "Authentication required".
  const expired = uat.signInRequiredResponse(enabledEnv());
  assert.equal(expired.status, 401);
  const expiredBody = await expired.json();
  assert.equal(expiredBody.code, "sign_in_required");
  assert.equal(expiredBody.signInUrl, "/staging-login");
  const production = await uat.signInRequiredResponse({}).json();
  assert.equal(production.code, undefined, "production keeps the original bare body — this branch cannot fire there");
});

// ---------------------------------------------------------------------------------------------
test("the API gateway allowlists the login endpoint and honours the UAT cookie", async () => {
  const gateway = await import("../lib/api-gateway.ts");
  const world = await uatWorld();

  // The login endpoint itself must be reachable unauthenticated, or nobody could ever sign in.
  const login = await gateway.authorizeApiRequest(new Request("https://staging.pawspace.example/api/staging-login", { method: "POST", headers: { "content-type": "application/json" } }), { DB: world.db, ...world.env });
  assert.ok(!(login instanceof Response), "the login endpoint must not be gated behind the session it creates");
  assert.equal(login.permission, null, "it is public");

  // A GUARDED endpoint with NO cookie is refused.
  const guardedUrl = "https://staging.pawspace.example/api/platform-governance";
  const anonymous = await gateway.authorizeApiRequest(new Request(guardedUrl), { DB: world.db, ...world.env });
  assert.ok(anonymous instanceof Response, "an anonymous request to a guarded route must be refused");
  assert.ok(anonymous.status === 401 || anonymous.status === 403, `refused with an auth status, got ${anonymous.status}`);

  // The SAME endpoint WITH a valid UAT cookie resolves the seeded actor — the cookie is honoured, and
  // the actor is the provisioned identity rather than a wildcard.
  const request = await signedRequest(world.env, STAFF, { url: guardedUrl });
  const withCookie = await gateway.authorizeApiRequest(request, { DB: world.db, ...world.env });
  if (withCookie instanceof Response) {
    // A manager does not hold users.manage, so a 403 here is the CORRECT outcome and still proves the
    // cookie was resolved: an unresolved cookie would have produced the 401 above.
    assert.equal(withCookie.status, 403, `the cookie resolved and the role was then judged: ${withCookie.status}`);
  } else {
    assert.equal(withCookie.actor.email, STAFF, "the resolved actor is the cookie's identity");
    assert.equal(withCookie.actor.permissions.includes("*"), false, "and is not a wildcard");
  }

  // With the feature OFF, the same cookie must not authenticate anything.
  const offWorld = await uatWorld({ env: {} });
  const offRequest = await signedRequest(enabledEnv(), STAFF, { url: guardedUrl });
  const offDecision = await gateway.authorizeApiRequest(offRequest, { DB: offWorld.db });
  assert.ok(offDecision instanceof Response, "with UAT login disabled the cookie must not grant access");
  assert.ok(offDecision.status === 401 || offDecision.status === 403, `refused, got ${offDecision.status}`);
});
