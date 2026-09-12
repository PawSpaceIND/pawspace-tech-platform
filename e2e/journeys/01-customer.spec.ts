import { test, expect } from "@playwright/test";

/*
 * Customer journey: discovery -> service selection -> booking surface -> customer-owned account.
 * Driven as the SEEDED customer identity (app_users role_code='customer'), not the preview superuser.
 */
const AS_CUSTOMER = { "oai-authenticated-user-email": "e2e.customer@pawspace.test" };
test.use({ extraHTTPHeaders: AS_CUSTOMER });

test("the storefront renders real content, not a blank or error page", async ({ page }) => {
  const res = await page.goto("/", { waitUntil: "domcontentloaded" });
  expect(res?.status()).toBe(200);
  const body = await page.locator("body").innerText();
  expect(body.replace(/\s+/g, " ").trim().length, "storefront must render substantive content").toBeGreaterThan(200);
  expect(body).not.toMatch(/Application error|Something went wrong|Unhandled Runtime Error/i);
  await expect(page.getByText(/Bengaluru/i).filter({ visible: true }).first()).toBeVisible();
});

test("the customer can reach the canonical grooming service and see a bookable surface", async ({ page }) => {
  const response = await page.goto("/services/grooming", { waitUntil: "domcontentloaded" });
  expect(response?.status(), "canonical grooming route must resolve").toBe(200);
  const body = await page.locator("body").innerText();
  expect(body).not.toMatch(/Application error|Unhandled Runtime Error/i);
  expect(body).toMatch(/groom|package|price|₹|book/i);
});

test("the mobile app surface renders (was a blank screen in the 2026-09-05 audit)", async ({ page }) => {
  const res = await page.goto("/mobile-app", { waitUntil: "domcontentloaded" });
  expect(res?.status()).toBe(200);
  // The mobile app paints a brief "Opening PawSpace" splash, then hydrates a large client bundle.
  // A fixed wait races that hydration and can sample the splash (0 chars); wait for real content to
  // appear instead. This still fails if the page never renders substantive content within the timeout.
  await page.waitForFunction(
    () => document.body.innerText.replace(/\s+/g, " ").trim().length > 150,
    null,
    { timeout: 15_000 },
  );
  const body = (await page.locator("body").innerText()).replace(/\s+/g, " ").trim();
  expect(body.length, "/mobile-app must not render blank").toBeGreaterThan(150);
  expect(body).not.toMatch(/Application error|Unhandled Runtime Error/i);
});

test("the customer can read their own governed account surface", async ({ request }) => {
  const res = await request.get("/api/customer-account?customerId=E2E-CUS-UI-001");
  expect(res.ok(), `own customer account must succeed (${res.status()})`).toBeTruthy();
  const body = await res.json();
  expect(body?.source).toBe("canonical_customer_account");
  expect(body?.data?.customerId).toBe("E2E-CUS-UI-001");
  expect(Array.isArray(body?.data?.pets)).toBeTruthy();
  expect(body.data.pets.some((pet: { id?: string }) => pet.id === "E2E-PET-UI-001")).toBeTruthy();
});

test("customer discovery and app surfaces never expose sandbox/prototype payment wording", async ({ page }) => {
  const findings: string[] = [];
  for (const path of ["/discover", "/mobile-app"]) {
    const response = await page.goto(path, { waitUntil: "domcontentloaded" });
    expect(response?.status() ?? 500, `${path} must load`).toBeLessThan(400);
    await page.waitForTimeout(300);
    const body = await page.locator("body").innerText();
    const hits = body.match(/\b(sandbox|prototype)\b/gi) ?? [];
    if (hits.length) findings.push(`${path}: ${[...new Set(hits.map(hit => hit.toLowerCase()))].join(",")}`);
  }
  expect(findings, "customer discovery/app copy must not disclose sandbox or prototype internals").toEqual([]);
});
