import { expect, test } from "@playwright/test";

test("staff: deterministic UAT login renders and issues Founder session", async ({ page }) => {
  const code = process.env.PW_STAFF_UAT_ACCESS_CODE || "";
  expect(code.length).toBeGreaterThanOrEqual(8);
  const response = await page.goto("/staging-login", { waitUntil: "domcontentloaded" });
  expect(response?.status()).toBe(200);
  await expect(page.getByPlaceholder("shared UAT access code")).toBeVisible();
  await page.getByPlaceholder("shared UAT access code").fill(code);
  const signed = page.waitForResponse(r => r.url().endsWith("/api/staging-login") && r.request().method() === "POST");
  await page.getByRole("button", { name: /Founder \(full access\)/ }).click();
  const signedResponse = await signed;
  expect(signedResponse.status()).toBe(200);
  await page.waitForURL("**/me");
  const session = await page.evaluate(async () => {
    const r = await fetch("/api/staging-login", { cache: "no-store" });
    return r.ok ? r.json() : null;
  });
  expect(session?.signedInAs?.email).toBe("founder@pawspace.in");
});
