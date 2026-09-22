/**
 * LP-D08 - a superseded partner session (signed in again on another device) kept the green
 * "✓ Verified" / "🟢 Online" header pills forever while every background call 401'd, and the one banner
 * that did appear used STAFF wording lifted straight from lib/uat-staging-auth.ts's
 * signInRequiredResponse ("Your staging sign-in has expired. Open /staging-login to sign in again."),
 * which is meaningless to a partner and only a manual reload actually returned them to the OTP form.
 *
 * The fix: a 401 from either background poll (Jobs, Earnings) now runs handleUnauthorized(), which
 * clears the identity, drops the stale job list, and flips sessionState away from "verified" - which is
 * the SAME gate that already renders the OTP sign-in screen instead of the dashboard. Because the
 * identityPill/"Online" pill markup only exists inside the verified-dashboard branch, this structurally
 * fixes the stale pills; a partner-worded notice is shown on the sign-in screen it falls back to, with no
 * reload required.
 *
 * These tests evaluate real expressions and structural positions pulled from the shipped source, not a
 * hand-copied re-implementation, following the technique in
 * tests/partner-app-refresh-identity-guard.test.mjs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
installWorkersHooks("__LP_D08_DB__");
import { readFile } from "node:fs/promises";

const source = () => readFile(new URL("../app/partner-app/page.tsx", import.meta.url), "utf8");

test("LP-D08: handleUnauthorized clears identity, jobs and flips sessionState away from verified", async () => {
  const page = await source();
  const start = page.indexOf("const handleUnauthorized = () => {");
  assert.ok(start >= 0, "handleUnauthorized must be defined");
  const body = page.slice(start, page.indexOf("};", start) + 2);
  assert.match(body, /setIdentity\(null\)/, "the stale identity must be dropped");
  assert.match(body, /setJobs\(\[\]\)/, "the stale job list (from the previous session) must not linger");
  assert.match(body, /setSessionState\("unauthenticated"\)/, "this is what un-mounts the dashboard and its pills");
  assert.match(body, /setSessionNotice\(/, "a partner-facing notice must be set");
});

test("LP-D08: the session notice uses partner wording, never the staff /staging-login copy", async () => {
  const page = await source();
  const match = page.match(/setSessionNotice\("([^"]+)"\)/);
  assert.ok(match, "handleUnauthorized must set a literal notice string");
  const notice = match[1];
  assert.doesNotMatch(notice, /staging-login/i, "staff sign-in wording must not reach a partner");
  assert.doesNotMatch(notice, /staging sign-in/i);
  assert.match(notice, /session ended|signed in on another device/i, "the copy must explain what actually happened");
});

test("LP-D08: both background polls (Jobs and Earnings) react to a 401 by calling handleUnauthorized", async () => {
  const page = await source();
  const jobsFetchStart = page.indexOf('fetch(`/api/partner-jobs');
  assert.ok(jobsFetchStart >= 0);
  const jobsChainEnd = page.indexOf(".catch(", jobsFetchStart);
  const jobsChain = page.slice(jobsFetchStart, jobsChainEnd);
  assert.match(jobsChain, /response\.status === 401.*handleUnauthorized\(\)/, "the Jobs poll must treat a 401 as a superseded session, not a generic load error");

  const workspaceFetchStart = page.indexOf('fetch("/api/provider-workspace"');
  assert.ok(workspaceFetchStart >= 0);
  const workspaceChainEnd = page.indexOf(".catch(", workspaceFetchStart);
  const workspaceChain = page.slice(workspaceFetchStart, workspaceChainEnd);
  assert.match(workspaceChain, /response\.status === 401.*handleUnauthorized\(\)/, "the Earnings poll must treat a 401 as a superseded session, not a generic load error");
});

test("LP-D08: the session notice is rendered on the sign-in screen and cleared once the server re-verifies a session", async () => {
  const page = await source();
  assert.match(page, /\{sessionNotice && <div className=\{styles\.error\} role="alert">\{sessionNotice\}<\/div>\}/);
  // Cleared where every other post-verification reset already lives (the identity effect's success
  // branch), not inlined into onLoggedIn - tests/partner-app-login-gate.test.mjs pins onLoggedIn's exact
  // body as only re-asking the server, so the notice is cleared once that re-ask actually verifies.
  assert.match(page, /setIdentity\(data\); setSessionState\("verified"\); setError\(""\); setSessionNotice\(""\); \}/,
    "a freshly verified session must clear the stale notice");
});

test("LP-D08: the 'Verified'/'Online' pills exist only inside the verified-dashboard branch, which the sign-in gate returns from before reaching", async () => {
  const page = await source();
  const gateIndex = page.indexOf('if (sessionState !== "verified") return <main');
  const pillIndex = page.indexOf('<span>{identity?.subjectId ? "Verified" : "Checking"}</span>');
  const onlinePillIndex = page.indexOf('statusQueue.connection==="Online"?"🟢"');
  assert.ok(gateIndex >= 0 && pillIndex >= 0 && onlinePillIndex >= 0, "all three markers must be present in source");
  assert.ok(gateIndex < pillIndex, "the sign-in gate's early return must come before the Verified pill in source order");
  assert.ok(gateIndex < onlinePillIndex, "the sign-in gate's early return must come before the Online pill in source order");
});

test("LP-D08 executed: the partner notice is not the staff sign-in sentence the auth library emits", async () => {
  const auth = await import("../lib/uat-staging-auth.ts");
  // signInRequiredResponse needs the UAT env to emit its full sentence; without it the library
  // deliberately answers a bare "Authentication required".
  const staffRefusal = auth.signInRequiredResponse({ PAWSPACE_UAT_LOGIN: "on", PAWSPACE_UAT_SIGNING_KEY: "x".repeat(64) });
  const staffCopy = await staffRefusal.clone().text().catch(() => "");
  assert.match(staffCopy, /staging sign-in has expired|\/staging-login/, "the staff copy is what it always was");
  const page = fs.readFileSync(new URL("../app/partner-app/page.tsx", import.meta.url), "utf8");
  const notice = page.match(/setSessionNotice\(\s*["'`]([^"'`]+)["'`]/);
  assert.ok(notice, "the partner path must set its own notice");
  assert.ok(!staffCopy.includes(notice[1]), "the partner must not be shown the staff sentence");
  assert.ok(!/staging-login/.test(notice[1]), "the partner notice must not send them to the staff entry point");
});
