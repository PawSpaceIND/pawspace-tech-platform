/*
 * Staging, 26 Sep 2026: a tester who had booked Dog Training as a customer opened /team/sales in the same
 * browser and saw a bare "Permission denied" and "Your role does not include the Team menu". Staff sign-in
 * (/staging-login) is a separate cookie that outranks a customer or partner session, so her browser held no
 * staff identity at all. The Team shell's own call now says who the browser is signed in as and where staff
 * sign in; the refusal is still a 403 and returns nothing of the overview.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setupJourney, sessionCookie, routeCall } from "./helpers/grooming-journey-harness.mjs";

const ROUTE = "../../app/api/team-overview/route.ts";
const UAT_LOGIN = { PAWSPACE_UAT_LOGIN: "on", PAWSPACE_UAT_SIGNING_KEY: "k".repeat(64) };

test("a customer session on a Team page is told to sign in as staff, with the staging sign-in link", async (t) => {
  const ctx = await setupJourney(); t.after(ctx.close);
  Object.assign(globalThis.__GROOM_GOLDEN_ENV__, UAT_LOGIN);
  const cookie = await sessionCookie(ctx.db, "customer", "CUST-TEAM-1", "customer:CUST-TEAM-1");
  const response = await routeCall(ROUTE, "GET", "/api/team-overview", undefined, cookie);
  assert.equal(response.status, 403, JSON.stringify(response.body));
  assert.equal(response.body.code, "staff_sign_in_required");
  assert.equal(response.body.signInUrl, "/staging-login");
  assert.match(response.body.error, /signed in as a customer in this browser, not as PawSpace staff/);
  assert.equal(response.body.data, undefined, "nothing of the Team overview is returned");
});

test("a partner session names the partner, and a runtime without UAT sign-in offers no link", async (t) => {
  const ctx = await setupJourney(); t.after(ctx.close);
  const cookie = await sessionCookie(ctx.db, "provider", "PRV-TEAM-1", "provider:PRV-TEAM-1");
  const response = await routeCall(ROUTE, "GET", "/api/team-overview", undefined, cookie);
  assert.equal(response.status, 403, JSON.stringify(response.body));
  assert.equal(response.body.code, "staff_sign_in_required");
  assert.match(response.body.error, /signed in as a PawSpace partner/);
  assert.equal(response.body.signInUrl, undefined);
});

test("the Team shell shows that message with a staff sign-in link, above the page too", () => {
  const shell = readFileSync(new URL("../app/components/staff-workspace/StaffWorkspace.tsx", import.meta.url), "utf8");
  assert.match(shell, /nextCode = typeof body\.code === "string" \? body\.code : ""/);
  assert.match(shell, /const staffSignInNeeded = currentNavigation\?\.code === "staff_sign_in_required"/);
  assert.match(shell, /staffSignInNeeded \? navigationError : currentNavigation\?\.status === 403/);
  assert.match(shell, /\{staffSignInNeeded \? "Sign in as staff" : "Sign in again"\}/);
  assert.match(shell, /\{staffSignInNeeded && <p className=\{styles\.signInNotice\} role="alert">\{navigationError\}/);
});
