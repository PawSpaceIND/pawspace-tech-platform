import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/*
 * Customer app sign-in / sign-out contract.
 *
 * Human UAT could sign in to /mobile-app (OTP via the Account tab) but had no way to sign out or
 * switch to another customer number, and a guest reaching the grooming review step saw a disabled
 * "Confirm booking" with no sign-in form (the form was gated behind a click that could never happen).
 */
const page = readFileSync(new URL("../app/mobile-app/page.tsx", import.meta.url), "utf8");
const grooming = readFileSync(new URL("../app/mobile-app/grooming-flow.tsx", import.meta.url), "utf8");
const route = readFileSync(new URL("../app/api/identity-session/route.ts", import.meta.url), "utf8");

test("customer sign-out revokes the platform session server-side and clears the client cache", () => {
  assert.match(page, /const signOut=async\(\)=>\{/);
  assert.match(page, /await fetchWithDeadline\("\/api\/identity-session",\{method:"DELETE"/);
  assert.match(page, /window\.localStorage\.removeItem\("pawspace_customer"\)/);
  assert.match(page, /setCustomer\(null\);setTab\("home"\)/);
  // A stale cookie (401) still completes a local sign-out instead of trapping the tester.
  assert.match(page, /if\(!response\.ok&&response\.status!==401\)/);
  assert.match(route, /export async function DELETE\(request:Request\)\{try\{sameOriginWrite\(request\);const db=await database\(\);await revokePlatformSession\(db,request,"user_logout"\)/);
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
