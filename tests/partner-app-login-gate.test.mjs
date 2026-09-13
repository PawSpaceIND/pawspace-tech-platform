/**
 * /partner-app must never drop an unauthenticated visitor into the restricted dashboard.
 *
 * Human UAT found no phone input and no "Send OTP" on /partner-app: the page fetched
 * /api/identity-session, failed with "Verified provider session required", and rendered the
 * dashboard anyway behind a red banner. The gate below is evaluated from the committed source, the
 * way tests/partner-app-refresh-identity-guard.test.mjs evaluates its guards, so a rewording that
 * breaks the behaviour still fails.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const source = (path) => readFile(new URL("../" + path, import.meta.url), "utf8");
const evaluate = (expression, scope) => new Function(...Object.keys(scope), `return (${expression});`)(...Object.values(scope));

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
  assert.match(page, /if \(body\.data\?\.subjectType !== "provider" \|\| !body\.data\.subjectId\) throw new Error\("Verified provider session required"\);/);
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
