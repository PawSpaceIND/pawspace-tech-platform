/**
 * /partner-app must never drop an unauthenticated visitor into the restricted dashboard.
 *
 * Human UAT found no phone input and no "Send OTP" on /partner-app: the page fetched
 * /api/identity-session, failed with "Verified provider session required", and rendered the
 * dashboard anyway behind a red banner.
 *
 * Two halves, deliberately joined:
 *   1. The REAL /api/identity-session route is executed against transactional SQLite for the three
 *      callers the page can meet - anonymous, a provider OTP session, a customer OTP session - so the
 *      server contract the gate depends on is exercised, not assumed.
 *   2. The page's own guard and gate expressions are evaluated from the committed source against
 *      those real responses, the way tests/partner-app-refresh-identity-guard.test.mjs evaluates its
 *      guards, so a rewording that breaks the behaviour still fails.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks, enterWorkersDbScope } from "./helpers/module-hooks.mjs";
import { d1 } from "./helpers/execution-harness.mjs";

installWorkersHooks("__PARTNER_LOGIN_GATE_DB__", "__PARTNER_LOGIN_GATE_ENV__");
const identitySession = await import("../app/api/identity-session/route.ts");
const { upsertIdentityBinding } = await import("../lib/identity-binding.ts");
const { issuePlatformSession, PLATFORM_SESSION_COOKIE } = await import("../lib/platform-session.ts");

const ORIGIN = "https://partner-login-gate.pawspace.test";
const source = (path) => readFile(new URL("../" + path, import.meta.url), "utf8");
const evaluate = (expression, scope) => new Function(...Object.keys(scope), `return (${expression});`)(...Object.values(scope));

function world(t) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  const db = d1(sqlite); enterWorkersDbScope(db);
  globalThis.__PARTNER_LOGIN_GATE_DB__ = db;
  globalThis.__PARTNER_LOGIN_GATE_ENV__ = {};
  return { sqlite, db };
}
async function sessionCookie(db, subjectType, subjectId, identitySource) {
  const principalKey = `${subjectType}:${subjectId}`;
  const binding = await upsertIdentityBinding(db, { identitySource, principalType: "identity_subject", principalKey,
    subjectType, subjectId, actorId: "partner-login-gate-test", reason: "Synthetic session fixture" });
  const session = await issuePlatformSession(db, { bindingId: binding.id, identitySource, principalType: "identity_subject",
    principalKey, subjectType, subjectId });
  return `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(session.token)}`;
}
async function readIdentity(cookie) {
  const response = await identitySession.GET(new Request(`${ORIGIN}/api/identity-session`, { headers: cookie ? { cookie } : {} }));
  return { ok: response.ok, status: response.status, body: await response.json() };
}
/* The page's own identity guard, lifted from source so the test cannot drift from what ships. */
async function pageGuard() {
  const page = await source("app/partner-app/page.tsx");
  const refused = page.match(/if \(!response\.ok\) throw new Error\(body\.error \|\| "Verified provider session required"\);/);
  const guard = page.match(/if \((body\.data\?\.subjectType !== "provider" \|\| !body\.data\.subjectId)\) throw new Error\("Verified provider session required"\);/);
  assert.ok(refused && guard, "the page must keep its server-only identity guard verbatim");
  return { page, refuses: (response) => !response.ok || evaluate(guard[1], { body: response.body }) };
}

test("an anonymous visitor is refused by the real identity route, so the page opens the sign-in gate", async t => {
  world(t);
  const anonymous = await readIdentity();
  assert.equal(anonymous.status, 401);
  const { refuses } = await pageGuard();
  assert.equal(refuses(anonymous), true, "the page must treat a refused identity read as unauthenticated");
});

test("a provider OTP session is the only caller the real route resolves as a provider subject", async t => {
  const { db } = world(t);
  const provider = await readIdentity(await sessionCookie(db, "provider", "UAT-PROVIDER-1", "partner_otp"));
  assert.equal(provider.status, 200);
  assert.equal(provider.body.data.subjectType, "provider");
  assert.equal(provider.body.data.subjectId, "UAT-PROVIDER-1");
  const customer = await readIdentity(await sessionCookie(db, "customer", "UAT-CUSTOMER-1", "customer_otp"));
  assert.equal(customer.status, 200);
  assert.equal(customer.body.data.subjectType, "customer");
  const { refuses } = await pageGuard();
  assert.equal(refuses(provider), false, "a verified provider session reaches the dashboard");
  assert.equal(refuses(customer), true, "a customer session is not a provider session and must see the sign-in gate, never the dashboard");
});

test("the dashboard is rendered only for a server-verified provider session", async () => {
  const page = await source("app/partner-app/page.tsx");
  const gate = page.match(/if \((sessionState !== "verified")\) return <main className=\{styles\.viewport\}>/);
  assert.ok(gate, "the sign-in gate must return before the dashboard markup");
  for (const state of ["checking", "unauthenticated"]) assert.equal(evaluate(gate[1], { sessionState: state }), true, `${state} must block the dashboard`);
  assert.equal(evaluate(gate[1], { sessionState: "verified" }), false, "a verified session must reach the dashboard");
  // The gate precedes the dashboard, so its hidden markers and controls are unreachable without a session.
  assert.ok(page.indexOf('if (sessionState !== "verified") return') < page.indexOf('<span hidden aria-hidden="true">TEST TRANSACTION ENGINE</span>'));
});

test("an unauthenticated visitor gets the OTP sign-in, not a restricted dashboard", async () => {
  const page = await source("app/partner-app/page.tsx");
  assert.match(page, /import PartnerLogin from "\.\.\/partner\/partner-login";/);
  assert.match(page, /sessionState === "checking"\s*\?\s*<p role="status"[^>]*>Checking your partner session…<\/p>/, "a session still being resolved shows a status line, never the sign-in form nor the dashboard");
  assert.match(page, /<PartnerLogin eyebrow="🐾 PawSpace Partner" title="Sign in to your Partner app"/);
  assert.match(page, /onLoggedIn=\{\(\) => \{ setError\(""\); setSessionState\("checking"\); setIdentityKey\(\(value\) => value \+ 1\); \}\}/,
    "a successful OTP only re-runs the server identity check");
  assert.match(page, /\}, \[identityKey\]\);/, "the identity effect must re-run when the sign-in completes");
  assert.match(page, /\.catch\(\(\) => \{ if \(!cancelled\) \{ setIdentity\(null\); setSessionState\("unauthenticated"\); \} \}\);/,
    "a refused or missing session clears the identity and opens the gate");
  assert.match(page, /setSessionState\("verified"\)/);
});

test("identity is still resolved by the server alone", async () => {
  const page = await source("app/partner-app/page.tsx");
  assert.match(page, /fetch\("\/api\/identity-session", \{ cache: "no-store" \}\)/);
  assert.doesNotMatch(page, /setIdentity\(\{/, "the OTP result must never be turned into a client-side identity");
  assert.doesNotMatch(page, /setSessionState\("verified"\)[^\n]*onLoggedIn|onLoggedIn[^\n]*setSessionState\("verified"\)/, "sign-in success must not mark the session verified by itself");
});

test("the shared OTP sign-in keeps the transport and selectors the browser journeys drive", async () => {
  const login = await source("app/partner/partner-login.tsx");
  assert.match(login, /placeholder="10-digit phone number"/);
  assert.match(login, /placeholder="6-digit code"/);
  assert.match(login, /placeholder="Your name \(first time only\)"/);
  assert.match(login, /\{busy \? "Sending…" : "Send OTP"\}/);
  assert.match(login, /\{busy \? "Verifying…" : "Verify & continue"\}/);
  assert.match(login, /Sandbox code \(no real SMS yet\):/);
  assert.match(login, /fetch\("\/api\/partner-otp", \{ method: "POST"/);
  // Onboarding keeps its own framing by default; only the Partner app overrides it.
  assert.match(login, /eyebrow = "🐾 Become a caregiver", title = "Sign in to start your application"/);
  const onboarding = await source("app/partner/onboarding/page.tsx");
  assert.match(onboarding, /<PartnerLogin onLoggedIn=/);
  assert.doesNotMatch(onboarding, /<PartnerLogin[^>]*title=/);
});
