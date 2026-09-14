import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks, enterWorkersDbScope } from "./helpers/module-hooks.mjs";
import { d1 } from "./helpers/execution-harness.mjs";

/*
 * Customer app sign-in / sign-out.
 *
 * Human UAT could sign in to /mobile-app (OTP via the Account tab) but had no way to sign out or
 * switch to another customer number, and a guest reaching the grooming review step saw a disabled
 * "Confirm booking" with no sign-in form (the form was gated behind a click that could never happen).
 *
 * The server side is executed for real: a customer platform session is issued into transactional
 * SQLite, the REAL DELETE /api/identity-session handler the app calls revokes it, and the same
 * cookie is then refused by GET. The UI wiring is pinned from source.
 */
installWorkersHooks("__CUSTOMER_SIGNOUT_DB__", "__CUSTOMER_SIGNOUT_ENV__");
const identitySession = await import("../app/api/identity-session/route.ts");
const { upsertIdentityBinding } = await import("../lib/identity-binding.ts");
const { issuePlatformSession, PLATFORM_SESSION_COOKIE } = await import("../lib/platform-session.ts");

const ORIGIN = "https://customer-signout.pawspace.test";
const page = readFileSync(new URL("../app/mobile-app/page.tsx", import.meta.url), "utf8");
const grooming = readFileSync(new URL("../app/mobile-app/grooming-flow.tsx", import.meta.url), "utf8");

function world(t) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  const db = d1(sqlite); enterWorkersDbScope(db);
  globalThis.__CUSTOMER_SIGNOUT_DB__ = db;
  globalThis.__CUSTOMER_SIGNOUT_ENV__ = {};
  return { sqlite, db };
}
async function customerCookie(db, customerId) {
  const principalKey = `customer:${customerId}`;
  const binding = await upsertIdentityBinding(db, { identitySource: "customer_otp", principalType: "identity_subject", principalKey,
    subjectType: "customer", subjectId: customerId, actorId: "customer-signout-test", reason: "Synthetic session fixture" });
  const session = await issuePlatformSession(db, { bindingId: binding.id, identitySource: "customer_otp", principalType: "identity_subject",
    principalKey, subjectType: "customer", subjectId: customerId });
  return `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(session.token)}`;
}
const whoAmI = async (cookie) => {
  const response = await identitySession.GET(new Request(`${ORIGIN}/api/identity-session`, { headers: cookie ? { cookie } : {} }));
  return { status: response.status, body: await response.json() };
};
const signOut = (cookie, headers = {}) => identitySession.DELETE(new Request(`${ORIGIN}/api/identity-session`, {
  method: "DELETE", headers: { cookie, origin: ORIGIN, "content-type": "application/json", ...headers } }));

test("DELETE /api/identity-session revokes the customer session and clears the cookie", async (t) => {
  const { db } = world(t);
  const cookie = await customerCookie(db, "CUS-SIGNOUT-A");
  const before = await whoAmI(cookie);
  assert.equal(before.status, 200);
  assert.equal(before.body.data.subjectType, "customer");
  assert.equal(before.body.data.subjectId, "CUS-SIGNOUT-A");

  const response = await signOut(cookie);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, { loggedOut: true });
  assert.match(response.headers.get("set-cookie") || "", new RegExp(`^${PLATFORM_SESSION_COOKIE}=;`), "the session cookie must be cleared");
  assert.equal(response.headers.get("cache-control"), "no-store");

  const after = await whoAmI(cookie);
  assert.equal(after.status, 401, "the revoked token must be refused server-side, not only forgotten by the browser");
});

test("signing out one customer never touches another customer's live session, and a second sign-in is a different subject", async (t) => {
  const { db } = world(t);
  const a = await customerCookie(db, "CUS-SIGNOUT-A");
  const b = await customerCookie(db, "CUS-SIGNOUT-B");
  assert.equal((await signOut(a)).status, 200);
  assert.equal((await whoAmI(a)).status, 401);
  const stillB = await whoAmI(b);
  assert.equal(stillB.status, 200);
  assert.equal(stillB.body.data.subjectId, "CUS-SIGNOUT-B");
});

test("cross-origin sign-out is refused and a stale cookie sign-out still succeeds", async (t) => {
  const { db } = world(t);
  const cookie = await customerCookie(db, "CUS-SIGNOUT-C");
  const crossOrigin = await signOut(cookie, { origin: "https://evil.example" });
  assert.equal(crossOrigin.status, 403);
  assert.equal((await whoAmI(cookie)).status, 200, "a blocked cross-origin request must not revoke anything");
  assert.equal((await signOut(cookie)).status, 200);
  const again = await signOut(cookie);
  assert.ok(again.status === 200 || again.status === 401, `a second sign-out with the dead cookie must not error out (${again.status})`);
});

test("customer app sign-out calls that route through the bounded helper and clears the client cache", () => {
  assert.match(page, /const signOut=async\(\)=>\{/);
  assert.match(page, /await fetchWithDeadline\("\/api\/identity-session",\{method:"DELETE"/);
  assert.match(page, /window\.localStorage\.removeItem\("pawspace_customer"\)/);
  assert.match(page, /setCustomer\(null\);setTab\("home"\)/);
  // A stale cookie (401) still completes a local sign-out instead of trapping the tester.
  assert.match(page, /if\(!response\.ok&&response\.status!==401\)/);
});

test("customer sign-out is reachable from the header and from the Account tab", () => {
  assert.match(page, /\{customer&&<button type="button" className=\{styles\.signOut\} aria-label="Sign out"/);
  assert.match(page, /Sign out \/ switch account/);
  assert.match(page, /onSignOut=\{signOut\} signingOut=\{signingOut\}/);
  assert.match(page, /disabled=\{signingOut\} onClick=\{\(\)=>void onSignOut\(\)\}/);
});

test("customer sign-in stays available: guests get the OTP gate on every account-only tab", () => {
  for (const what of ["see your activity", "manage your pets", "open your account"]) {
    assert.ok(page.includes(`<GuestGate onLoggedIn={onLoggedIn} what="${what}"/>`), what);
  }
  assert.match(page, /function GuestGate\(\{onLoggedIn,what\}[\s\S]*<CustomerLogin onLoggedIn=\{onLoggedIn\} embedded\/>/);
});

test("guest grooming review step renders the OTP form without waiting for a click on a disabled confirm button", () => {
  assert.match(grooming, /\{!customer&&<section aria-label="Verify before booking">/);
  assert.doesNotMatch(grooming, /\{verifying&&!customer&&<section aria-label="Verify before booking">/);
  assert.match(grooming, /\{!verifiedIdentity&&<CustomerLogin embedded onLoggedIn=\{acceptIdentity\}\/>\}/);
});
