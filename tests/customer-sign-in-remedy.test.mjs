/**
 * DEFECT: a customer whose session expired was told to sign in at /staging-login.
 *
 * Every customer-scoped API answered
 *   401 {"error":"Your staging sign-in has expired. Open /staging-login to sign in again.",
 *        "code":"sign_in_required","signInUrl":"/staging-login"}
 * - observed on POST /api/customer-account (surfaced inside the pet editor as a visible role=alert)
 * and GET /api/customer-support-case. A customer signs in by phone OTP and can never hold the staging
 * STAFF cookie /staging-login issues, so the instruction was a dead end; and /staging-login is the
 * staff UAT switch, which names the internal staff identities it accepts. Two problems in one
 * sentence: an unactionable remedy, and internal identities surfaced on a customer-facing error path.
 *
 * Everything below EXECUTES lib/uat-staging-auth.ts. The final test executes the whole
 * lib/server-auth.ts actor path end to end; it is a `todo` because the last line of the wiring lives
 * in lib/server-auth.ts, which this change does not own - it flips to passing the moment
 * resolvePrimaryActor passes its request into signInRequiredResponse.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { freshSqlite, makeD1 } from "./helpers/taxi-harness.mjs";

installWorkersHooks("__CUSTOMER_SIGNIN_DB__", "__CUSTOMER_SIGNIN_ENV__");

const uat = await import("../lib/uat-staging-auth.ts");

const KEY = "x".repeat(uat.UAT_SIGNING_KEY_MIN_LENGTH);
const STAGING = { PAWSPACE_UAT_LOGIN: "on", PAWSPACE_UAT_SIGNING_KEY: KEY, PAWSPACE_UAT_ACCESS_CODE: "y".repeat(32) };
const PRODUCTION = {};
const ORIGIN = "https://staging.pawspace.example";
const get = (path) => new Request(`${ORIGIN}${path}`);
const post = (path) => new Request(`${ORIGIN}${path}`, { method: "POST" });
const bodyOf = async (response) => response.json();

/** The staff identities /staging-login lists. None of them may appear on a customer error path. */
const STAFF_DOMAINS = [/@tkpetcare\.in/i, /@pawspace\.in/i];

// ---------------------------------------------------------------------------------------------
test("the two reported customer routes get a remedy a customer can actually act on", async () => {
  for (const request of [post("/api/customer-account"), get("/api/customer-support-case")]) {
    const response = uat.signInRequiredResponse(STAGING, request);
    assert.equal(response.status, 401, "it is still an authentication refusal");
    const body = await bodyOf(response);
    const printed = JSON.stringify(body);
    assert.doesNotMatch(printed, /staging-login/, `a customer must never be sent to the staff sign-in: ${printed}`);
    assert.doesNotMatch(printed, /staging sign-in/i, "nor told about a staging sign-in they do not have");
    for (const domain of STAFF_DOMAINS) assert.doesNotMatch(printed, domain, "no internal staff identity on a customer error path");
    assert.equal(body.code, "customer_sign_in_required");
    assert.equal(body.signInUrl, "/mobile-app", "it points at the customer app, where phone verification lives");
    assert.match(body.error, /verify your phone number/i, "and names the action the customer takes");
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});

test("a customer gets the same actionable remedy in production, where UAT sign-in does not exist", async () => {
  const body = await bodyOf(uat.signInRequiredResponse(PRODUCTION, post("/api/customer-account")));
  assert.equal(body.code, "customer_sign_in_required", "a customer has no staging sign-in to expire in either environment");
  assert.equal(body.signInUrl, "/mobile-app");
});

test("the STAFF remedy is untouched - on staff routes, and for every existing caller", async () => {
  // A guarded staff route on staging keeps the recoverable staging instruction.
  const staff = await bodyOf(uat.signInRequiredResponse(STAGING, get("/api/platform-governance")));
  assert.deepEqual(staff, { error: "Your staging sign-in has expired. Open /staging-login to sign in again.", code: "sign_in_required", signInUrl: "/staging-login" });
  // Production keeps the bare body.
  assert.deepEqual(await bodyOf(uat.signInRequiredResponse(PRODUCTION, get("/api/platform-governance"))), { error: "Authentication required" });
  // And a caller that passes no request at all - which is every existing caller - is unchanged.
  assert.deepEqual(await bodyOf(uat.signInRequiredResponse(STAGING)), staff);
  assert.deepEqual(await bodyOf(uat.signInRequiredResponse(PRODUCTION)), { error: "Authentication required" });
});

test("staff CRM routes that merely have 'customer' in the name are NOT treated as customer surfaces", async () => {
  for (const path of ["/api/customer-360", "/api/customer-contact", "/api/customer-data-reveal", "/api/customer-targeting", "/api/customer-business-view"]) {
    const body = await bodyOf(uat.signInRequiredResponse(STAGING, get(path)));
    assert.equal(body.code, "sign_in_required", `${path} is a staff surface and keeps the staging remedy`);
  }
  // Non-vacuity: the customer-app routes next to them in the same namespace DO switch.
  for (const path of ["/api/customer-account", "/api/customer-profile", "/api/customer-billing", "/api/customer-checkout", "/api/customer-notifications", "/api/customer-offers", "/api/customer-reminders", "/api/customer-support-case", "/api/customer-grooming-summary"]) {
    assert.equal((await bodyOf(uat.signInRequiredResponse(STAGING, get(path)))).code, "customer_sign_in_required", `${path} is a customer surface`);
  }
});

test("path matching is exact: a trailing slash matches, a prefix does not, a broken URL fails closed", () => {
  assert.equal(uat.customerScopedRequest(get("/api/customer-account/")), true, "a trailing slash is the same route");
  assert.equal(uat.customerScopedRequest(get("/api/customer-account?customerId=CUS-1")), true, "a query string is the same route");
  assert.equal(uat.customerScopedRequest(get("/api/customer-accounts-admin")), false, "prefix matching would sweep in routes that were never listed");
  assert.equal(uat.customerScopedRequest(null), false);
  assert.equal(uat.customerScopedRequest(undefined), false, "no request means no claim about who is calling");
});

// ---------------------------------------------------------------------------------------------
test("END TO END: an unauthenticated customer-scoped request through lib/server-auth.ts gets the customer remedy",

  async () => {
    const sqlite = freshSqlite();
    const db = makeD1(sqlite);
    globalThis.__CUSTOMER_SIGNIN_DB__ = db;
    globalThis.__CUSTOMER_SIGNIN_ENV__ = STAGING;
    const { ensureSecurityTables, resolvePrimaryActor } = await import("../lib/server-auth.ts");
    await ensureSecurityTables(db);

    let refusal = null;
    try { await resolvePrimaryActor(post("/api/customer-account")); }
    catch (error) { refusal = error; }
    assert.ok(refusal instanceof Response, "an anonymous customer request is refused with a Response");
    assert.equal(refusal.status, 401);
    const printed = JSON.stringify(await refusal.json());
    assert.doesNotMatch(printed, /staging-login/, `the live path still sends customers to the staff sign-in: ${printed}`);
  });
