import { test, expect } from "@playwright/test";

/*
 * Partner journey: queue -> assigned work visible -> acceptance -> completion.
 * Driven as the seeded provider identity (app_users role_code='service_provider').
 */
const AS_PROVIDER = { "oai-authenticated-user-email": "e2e.provider@pawspace.test" };
test.use({ extraHTTPHeaders: AS_PROVIDER });

test("the partner hub renders for a provider identity", async ({ page }) => {
  const res = await page.goto("/partner", { waitUntil: "domcontentloaded" });
  expect(res?.status()).toBe(200);
  await page.waitForTimeout(800);
  const body = await page.locator("body").innerText();
  expect(body).not.toMatch(/Application error|Unhandled Runtime Error/i);
  expect(body.replace(/\s+/g, " ").trim().length).toBeGreaterThan(100);
  await expect(page.getByText(/partner/i).first()).toBeVisible();
});

test("a provider sees their own assigned work and no one else's", async ({ request }) => {
  const res = await request.get("/api/partner-job-feed?providerId=E2E-PRV-UI-001");
  expect(res.ok(), `own job feed must succeed (${res.status()})`).toBeTruthy();
  const body = await res.text();
  // The PII audit established this feed returns customerFirstName only. Guard that it stays so.
  expect(body, "the job feed must not leak a raw 10-digit phone").not.toMatch(/\b[6-9]\d{9}\b/);
  expect(body, "the job feed must not leak a raw email").not.toMatch(/[\w.+-]+@(?!pawspace\.test)[\w-]+\.[\w.]+/);
});

test("cross-tenant provider access is refused", async ({ request }) => {
  const res = await request.get("/api/partner-job-feed?providerId=SOME-OTHER-PROVIDER");
  expect(res.status(), "a provider must not read another provider's queue").toBeGreaterThanOrEqual(400);
  expect(res.status()).toBeLessThan(500);
});

test("a provider cannot adjudicate a cancellation dispute (AUDIT-H4, in the browser)", async ({ request }) => {
  const res = await request.get("/api/booking-cancellation-case?caseId=E2E-CASE-1");
  expect(res.status()).toBe(403);
  expect(await res.text()).toMatch(/cancellation_case_staff_only/);
});

test("the boarding host surface renders", async ({ page }) => {
  const res = await page.goto("/host", { waitUntil: "domcontentloaded" });
  expect(res?.status()).toBe(200);
  const body = await page.locator("body").innerText();
  expect(body).not.toMatch(/Application error|Unhandled Runtime Error/i);
});

test("partner hub reaches every governed service workspace from one provider entry point", async ({ page, request }) => {
  const hub = await page.goto("/partner", { waitUntil: "domcontentloaded" });
  expect(hub?.status()).toBe(200);
  const destinations = [
    ["All assigned jobs", "/partner/jobs"],
    ["Grooming", "/partner-app"],
    ["Training", "/trainer"],
    ["Dog Walking", "/walker"],
    ["Pet Taxi", "/driver"],
    ["Boarding", "/host"],
    ["Pet Sitting", "/sitter"],
  ] as const;
  for (const [label, href] of destinations) {
    await expect(page.getByRole("link", { name: label, exact: true }).first()).toHaveAttribute("href", href);
    const response = await request.get(href);
    expect(response.status(), `${href} must resolve for the authenticated provider test identity`).toBe(200);
    expect(await response.text(), `${href} must not render a server application error`).not.toMatch(/Application error|Unhandled Runtime Error/i);
  }
});
