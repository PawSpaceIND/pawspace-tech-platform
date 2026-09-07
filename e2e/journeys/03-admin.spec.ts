import { test, expect } from "@playwright/test";

/*
 * Employee / admin journey: workspace visibility -> control surfaces -> refund adjudication.
 * Driven as the seeded admin identity (app_users role_code='admin').
 */
const AS_ADMIN = { "oai-authenticated-user-email": "e2e.admin@pawspace.test" };
test.use({ extraHTTPHeaders: AS_ADMIN });

test("the team workspace renders for an admin", async ({ page }) => {
  const res = await page.goto("/team", { waitUntil: "domcontentloaded" });
  expect(res?.status()).toBe(200);
  await page.waitForTimeout(900);
  const body = await page.locator("body").innerText();
  expect(body).not.toMatch(/Application error|Unhandled Runtime Error/i);
  expect(body.replace(/\s+/g, " ").trim().length).toBeGreaterThan(150);
});

test("the control workspace renders and exposes governed sections", async ({ page }) => {
  const res = await page.goto("/control", { waitUntil: "domcontentloaded" });
  expect(res?.status()).toBe(200);
  await page.waitForTimeout(900);
  const body = await page.locator("body").innerText();
  expect(body).not.toMatch(/Application error|Unhandled Runtime Error/i);
  expect(body).toMatch(/control|audit|finance|operations/i);
});

test("an admin CAN adjudicate a cancellation case - the staff gate is not blanket-deny", async ({ request }) => {
  /* Non-vacuity for the provider refusal in 02-partner. "return 403 always" would satisfy that test
   * and break the product; staff must get past the same gate. The case id does not exist, so the
   * route refuses for a DIFFERENT reason - the only thing asserted is that it is not the staff 403. */
  const res = await request.get("/api/booking-cancellation-case?caseId=E2E-CASE-1");
  expect(await res.text()).not.toMatch(/cancellation_case_staff_only/);
});

test("refund adjudication surface is reachable and refuses malformed input safely", async ({ request }) => {
  const res = await request.post("/api/booking-cancellation-case", {
    headers: { "content-type": "application/json" },
    data: { caseId: "", action: "finance_decision" },
  });
  // Must be a governed 4xx, never a 500 leaking internals.
  expect(res.status(), "malformed refund input must be refused, not crash").toBeGreaterThanOrEqual(400);
  expect(res.status(), "malformed refund input must not 500").toBeLessThan(500);
});

test("an admin can read customer records the customer role could not", async ({ request }) => {
  /* Non-vacuity for 00-identity's customer refusal: the same endpoint that refused a customer must
   * serve an admin, otherwise the RBAC assertions above prove only that the endpoint is broken. */
  const res = await request.get("/api/customer-360?customerId=E2E-CUS-UI-001");
  expect(res.status(), "admin must not be refused for lack of permission").not.toBe(403);
  expect(res.status(), "admin read must not be a server error").toBeLessThan(500);
});
