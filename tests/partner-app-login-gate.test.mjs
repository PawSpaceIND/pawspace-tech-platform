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
const partnerOtp = await import("../app/api/partner-otp/route.ts");
const { upsertIdentityBinding } = await import("../lib/identity-binding.ts");
const { issuePlatformSession, PLATFORM_SESSION_COOKIE } = await import("../lib/platform-session.ts");

/* The same UAT gate the staging Worker runs with: OTP sandbox on, assertion material configured. The
 * values are synthetic fixtures built at runtime (long enough for the gate's minimum length), not
 * credentials. */
const synthetic = (label) => `${label}-${"0123456789abcdef".repeat(2)}`;
const UAT_ENV = { PAWSPACE_UAT_LOGIN: "on", PAWSPACE_UAT_SIGNING_KEY: synthetic("uat-signing-key"),
  PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT: synthetic("uat-assertion-secret") };
const cookieOf = (response) => String(response.headers.get("set-cookie") || "").split(";")[0];
const escapeRegExp = (value) => value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");

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
  for (const state of ["checking", "revoking", "revocation_failed", "unauthenticated"]) assert.equal(evaluate(gate[1], { sessionState: state }), true, `${state} must block the dashboard`);
  assert.equal(evaluate(gate[1], { sessionState: "verified" }), false, "a verified session must reach the dashboard");
  // The gate precedes the dashboard, so its hidden markers and controls are unreachable without a session.
  assert.ok(page.indexOf('if (sessionState !== "verified") return') < page.indexOf('<span hidden aria-hidden="true">TEST TRANSACTION ENGINE</span>'));
});

test("an unauthenticated visitor gets the OTP sign-in, not a restricted dashboard", async () => {
  const page = await source("app/partner-app/page.tsx");
  assert.match(page, /import PartnerLogin from "\.\.\/partner\/partner-login";/);
  assert.match(page, /Checking your partner session…/, "a session still being resolved shows a status line, never the sign-in form nor the dashboard");
  assert.match(page, /<PartnerLogin eyebrow="🐾 PawSpace Partner" title="Sign in to your Partner app"/);
  assert.match(page, /onLoggedIn=\{\(\) => \{ sessionVersion\.current\+=1;setError\(""\); setSessionState\("checking"\); setIdentityKey\(\(value\) => value \+ 1\); \}\}/,
    "a successful OTP only re-runs the server identity check");
  assert.match(page, /\}, \[identityKey\]\);/, "the identity effect must re-run when the sign-in completes");
  assert.match(page, /\.catch\(\(\) => \{ if \(!cancelled && version === sessionVersion\.current\) \{ setIdentity\(null\); setSessionState\("unauthenticated"\); \} \}\);/,
    "a refused or missing session clears the identity and opens the gate");
  assert.match(page, /setSessionState\("verified"\)/);
});

test("both sign-out controls revoke the backend session and purge provider-owned client state before another login", async () => {
  const [page, queue] = await Promise.all([source("app/partner-app/page.tsx"), source("lib/provider-proof-offline-queue.ts")]);
  assert.ok((page.match(/onClick=\{\(\) => void signOut\(\)\}/g) || []).length >= 2, "header and More tab must share the same sign-out path");
  assert.match(page, /setSessionState\("revoking"\)/, "the authenticated workspace unmounts before revocation waits on the network");
  assert.ok(page.indexOf('setSessionState("revoking")') < page.indexOf('fetch("/api/identity-session", { method: "DELETE"'), "client state is gated before DELETE resolves");
  for (const wipe of [/setIdentity\(null\)/, /setJobs\(\[\]\)/, /setEarnings\(null\)/, /setMediaAssets\(\[\]\)/, /setPaymentRequest\(null\)/, /clearProviderProofQueue\(\)/]) assert.match(page, wipe);
  assert.match(page, /method: "DELETE", credentials:"same-origin"/);
  assert.match(queue, /export async function clearProviderProofQueue\(\)/);
  assert.match(page, /sessionState === "revocation_failed"/, "a failed revocation must block a new login until the user retries it");
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

/* ------------------------------------------------------------------------------------------------
 * Sign out. The page has no local notion of "signed out": it asks the server to revoke the session and
 * then re-runs the identity check, so the server's refusal is what opens the gate.
 * ---------------------------------------------------------------------------------------------- */
test("sign out revokes the session on the server, so the old cookie is refused and the gate opens", async t => {
  const { db } = world(t);
  const cookie = await sessionCookie(db, "provider", "UAT-PROVIDER-2", "partner_otp");
  assert.equal((await readIdentity(cookie)).status, 200, "precondition: the session is valid");
  const signedOut = await identitySession.DELETE(new Request(`${ORIGIN}/api/identity-session`, { method: "DELETE", headers: { cookie, origin: ORIGIN } }));
  assert.equal(signedOut.status, 200);
  assert.deepEqual(await signedOut.json(), { data: { loggedOut: true } });
  assert.match(String(signedOut.headers.get("set-cookie")), new RegExp(`^${PLATFORM_SESSION_COOKIE}=`), "the browser is told to drop the cookie");
  const after = await readIdentity(cookie);
  assert.equal(after.status, 401, "a revoked session is refused even if the browser kept the cookie");
  const { refuses } = await pageGuard();
  assert.equal(refuses(after), true);
});

test("sign out is a same-origin write: a cross-site DELETE cannot end a partner's session", async t => {
  const { db } = world(t);
  const cookie = await sessionCookie(db, "provider", "UAT-PROVIDER-3", "partner_otp");
  const blocked = await identitySession.DELETE(new Request(`${ORIGIN}/api/identity-session`, { method: "DELETE", headers: { cookie, origin: "https://evil.example" } }));
  assert.equal(blocked.status, 403);
  assert.equal((await readIdentity(cookie)).status, 200, "the session is untouched");
});

/* ------------------------------------------------------------------------------------------------
 * Trainer sign-in. The staging roster is the only thing that decides which phone numbers can open
 * /partner-app, so its canonical_providers statements are executed here verbatim and a trainer is then
 * signed in through the REAL partner OTP route.
 * ---------------------------------------------------------------------------------------------- */
const TRAINERS = { uatcap_train_ft: "9000000931", uatcap_train_east: "9000000932", uatcap_train_south: "9000000933",
  uatcap_train_north: "9000000934", uatcap_train_west: "9000000935", uatcap_train_central: "9000000936" };
async function rosterIdentityStatements() {
  const roster = await source("scripts/uat-staging-provider-capacity.sql");
  const create = roster.match(/^CREATE TABLE IF NOT EXISTS canonical_providers[^\n]*;$/m);
  const insert = roster.match(/^INSERT OR IGNORE INTO canonical_providers[\s\S]*?\);$/m);
  assert.ok(create && insert, "the roster must keep its canonical_providers identity block");
  return { roster, statements: [create[0], insert[0]] };
}

test("the roster gives every UAT trainer a partner OTP number that is unique and tied to a live training profile", async () => {
  const { roster, statements } = await rosterIdentityStatements();
  const rows = [...statements[1].matchAll(/\('([a-z_]+)','blr','([^']*)','(\d{10})'/g)].map(([, id, name, phone]) => ({ id, name, phone }));
  const phones = rows.map(row => row.phone);
  assert.equal(new Set(phones).size, phones.length, "no two providers may share a sign-in number");
  for (const [id, phone] of Object.entries(TRAINERS)) {
    const row = rows.find(candidate => candidate.id === id);
    assert.ok(row, `${id} must be able to sign in`);
    assert.equal(row.phone, phone, `${id} keeps the documented number`);
    assert.match(roster, new RegExp(`VALUES \\('${escapeRegExp(id)}','blr','${escapeRegExp(row.name)}','full_time','\\["dog_training"\\]'`),
      `${id} must be the same provider the scheduler assigns training to, under the same name`);
  }
  const guide = await source("docs/UAT-TESTER-GUIDE.md");
  for (const phone of Object.values(TRAINERS)) assert.match(guide, new RegExp(phone), "testers are told the number");
});

test("a seeded UAT trainer signs in through the real partner OTP route and the gate opens as that provider", async t => {
  const { sqlite, db } = world(t);
  globalThis.__PARTNER_LOGIN_GATE_ENV__ = { DB: db, ...UAT_ENV };
  for (const statement of (await rosterIdentityStatements()).statements) sqlite.exec(statement);
  const post = (body) => partnerOtp.POST(new Request(`${ORIGIN}/api/partner-otp`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify(body) }));
  const requested = await post({ action: "request", phone: TRAINERS.uatcap_train_south });
  const challenge = await requested.json();
  assert.equal(requested.status, 200, JSON.stringify(challenge));
  assert.match(String(challenge.data?.sandboxCode), /^\d{6}$/, "sandbox OTP is shown on screen");
  const verified = await post({ action: "verify", challengeId: challenge.data.challengeId, code: challenge.data.sandboxCode, cityId: "blr" });
  const session = await verified.json();
  assert.equal(verified.status, 200, JSON.stringify(session));
  assert.equal(session.data.providerId, "uatcap_train_south", "the phone resolves to the seeded trainer, not a fresh onboarding identity");
  assert.equal(session.data.providerName, "Kavya R. (UAT South)");
  const identity = await readIdentity(cookieOf(verified));
  assert.equal(identity.status, 200);
  assert.equal(identity.body.data.subjectType, "provider");
  assert.equal(identity.body.data.subjectId, "uatcap_train_south");
  const { refuses } = await pageGuard();
  assert.equal(refuses(identity), false, "the trainer reaches the Partner app dashboard");
  // An unseeded number still takes the onboarding path: a new provider, never a roster provider.
  const stranger = await post({ action: "request", phone: "9000000999" });
  const strangerChallenge = await stranger.json();
  const strangerVerified = await post({ action: "verify", challengeId: strangerChallenge.data.challengeId, code: strangerChallenge.data.sandboxCode, name: "Stranger", cityId: "blr" });
  const strangerSession = await strangerVerified.json();
  assert.equal(strangerVerified.status, 200, JSON.stringify(strangerSession));
  assert.doesNotMatch(String(strangerSession.data.providerId), /^uatcap_/, "a number outside the roster cannot become a roster provider");
});

/* ------------------------------------------------------------------------------------------------
 * Page wiring for both.
 * ---------------------------------------------------------------------------------------------- */
test("the Partner app offers Sign out and only ever re-asks the server after it", async () => {
  const page = await source("app/partner-app/page.tsx");
  assert.match(page, /fetch\("\/api\/identity-session", \{ method: "DELETE", credentials:"same-origin"/, "sign out is the server's revoke, not a cookie trick");
  assert.match(page, /clearProviderProofQueue\(\)\]\);\s*if \(!response\.ok && response\.status !== 401\)[^\n]*\n[^\n]*\n\s*setSessionState\("checking"\); setIdentityKey\(\(value\) => value \+ 1\);/,
    "after the revoke the identity check runs again and decides; a failed revoke stays in revocation_failed");
  assert.equal(page.split('setSessionState("unauthenticated")').length, 2, "only the server-refusal path opens the gate");
  assert.match(page, /<b>\{signingOut \? "Signing out…" : "Sign out \/ switch partner"\}<\/b>/, "Sign out is in the More menu, named for what a tester looks for");
  assert.match(page, /\{identity\?\.subjectId && <button type="button" className=\{styles\.headerSignOut\} onClick=\{\(\) => void signOut\(\)\} disabled=\{accountBusy\}>/, "and in the header of a signed-in shell");
  // Every per-account state is dropped when the session changes hands (sign-out and switch alike).
  // Asserted as "each of these setters is present" rather than as the exact body: the reset is the
  // right home for any new per-account state, so pinning the literal list makes ADDING to it fail.
  // main's list is required in full below; PR #847 adds earningsNotice, engagement and
  // workspaceState (the last naming the previous partner's booking ids), which is what this wants.
  const resetBody = page.match(/const resetAccountState = \(\) => \{([\s\S]*?)\n  \};/);
  assert.ok(resetBody, "resetAccountState must exist as one shared reset");
  for (const setter of ['setIdentity(null)', 'setJobs([])', 'setSelectedId("")', 'setTab("home")',
                        'setOperationResult(null)', 'setOperationBusy(false)', 'setPaymentRequest(null)',
                        'setPaymentPollKey(0)', 'setEarnings(null)', 'setMediaMessage("")', 'setMediaAssets([])',
                        'setMediaAssetsError("")', 'setMediaPollKey(0)', 'setBusy(false)', 'setRefreshKey(0)',
                        'lifecycleLock.current = false']) {
    assert.ok(resetBody[1].includes(setter), `resetAccountState must drop ${setter}`);
  }
  assert.equal(page.split("resetAccountState();").length, 3, "sign-out and the switch both reset the account state");
  // One busy guard for both account actions: a sign-out and a switch can never be in flight together.
  assert.match(page, /const accountBusy = signingOut \|\| switching;/);
  assert.equal(page.split("if (accountBusy) return;").length, 3, "both handlers refuse to start while the other is in flight");
  assert.match(page, /onClick=\{\(\) => void signOut\(\)\} disabled=\{accountBusy\}/);
  assert.match(page, /onClick=\{\(\) => void switchUatProvider\(\)\} disabled=\{accountBusy \|\| !uatProviderId \|\| !uatCode\}/);
  assert.match(page, /<button type="button" className=\{styles\.identityPill\} onClick=\{\(\) => setTab\("more"\)\}/, "the header pill leads to it");
});

test("the UAT provider switch is rendered only when the gated roster answers, and it also just re-asks the server", async () => {
  const page = await source("app/partner-app/page.tsx");
  assert.match(page, /if \(sessionState !== "verified"\) return;\s*let cancelled = false;\s*fetch\("\/api\/uat-provider-switch", \{ cache: "no-store" \}\)/, "the roster is only requested for a verified session");
  assert.match(page, /if \(response\.status === 404\) return null;/, "outside UAT the switch does not exist");
  assert.match(page, /\.catch\(\(err\) => \{ if \(!cancelled\) \{ setUatProviders\(null\); setUatRosterError\(err instanceof Error \? err\.message : "Unable to load the UAT provider roster"\); \} \}\);/,
    "a roster failure other than the shut gate is surfaced, not swallowed");
  assert.match(page, /\{!uatProviders && uatRosterError && <p role="status" className=\{styles\.empty\}>Switch UAT provider is unavailable right now: \{uatRosterError\}<\/p>\}/);
  assert.match(page, /const providerName = selected\?\.providerName \|\| uatProviders\?\.find\(\(provider\) => provider\.id === identity\?\.subjectId\)\?\.name \|\| "PawSpace Partner";/,
    "a switched-to provider with no grooming job is still named from the roster");
  assert.match(page, /\{uatProviders && <section className=\{styles\.uatSwitch\}/);
  assert.match(page, /body: JSON\.stringify\(\{ providerId: uatProviderId, code: uatCode \}\)/, "the shared UAT access code is required");
  assert.match(page, /sessionVersion\.current \+= 1;\s*setUatCode\(""\); resetAccountState\(\); await clearProviderProofQueue\(\);\s*setSessionState\("checking"\); setIdentityKey\(\(value\) => value \+ 1\);/,
    "a successful switch invalidates the old provider's in-flight reads, clears its state and queued proofs, and re-runs the identity check");
  assert.doesNotMatch(page, /setIdentity\(\{/, "the switch response never becomes a client-side identity");
});

