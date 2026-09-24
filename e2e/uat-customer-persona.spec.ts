import { expect, test } from "@playwright/test";

test("test customer signs in without OTP and persists a pet through the real account API", async ({ page, baseURL }) => {
  test.skip(process.env.PAWSPACE_UAT_PERSONAS !== "on", "test-customer access requires explicit opt-in");
  test.skip(!["localhost", "127.0.0.1"].includes(new URL(baseURL || "http://localhost").hostname), "these synthetic writes are local-only");
  const otpRequests: string[] = [];
  page.on("request", request => { if (request.url().includes("/api/customer-otp")) otpRequests.push(request.url()); });
  await page.goto("/staging-login");
  await expect(page.getByRole("region", { name: "Synthetic customer testing" })).toBeVisible();
  await page.getByPlaceholder("shared UAT access code").fill(process.env.PW_STAFF_UAT_ACCESS_CODE || "pawspace-e2e-access-only");
  const signed = page.waitForResponse(response => response.url().endsWith("/api/uat-customer-switch") && response.request().method() === "POST");
  await page.getByRole("button", { name: "UAT Audit Customer A", exact: true }).click();
  expect((await signed).status()).toBe(200);
  await page.waitForURL("**/mobile-app");
  // The discovery home deliberately hides the shell header; account controls live on Account.
  await page.getByRole("button", { name: "Account", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Home", exact: true }).click();
  const initial = await page.request.get("/api/customer-account");
  expect(initial.status()).toBe(200); expect((await initial.json()).data.customerId).toBe("UAT-AUDIT-CUSTOMER-A");
  await page.getByRole("button", { name: /Book now.*Grooming/ }).click();
  const back = page.getByRole("button", { name: /^\u2190 Pets$/ });
  if (await back.isVisible().catch(() => false)) await back.click();
  const details = page.getByRole("button", { name: "Add or edit pet details", exact: true });
  if (await details.isVisible().catch(() => false)) await details.click();
  await page.getByRole("button", { name: /\uff0b Add pet/, exact: true }).click();
  const petName = `Audit Persist ${test.info().project.name}`;
  await page.getByPlaceholder("Pet name", { exact: true }).fill(petName);
  await page.getByPlaceholder("Start typing a breed").fill("Labrador Retriever");
  await page.locator("select").filter({ has: page.locator('option[value="3 years"]') }).selectOption("3 years");
  await page.locator("select").filter({ has: page.locator('option[value="Not sure"]') }).selectOption("Not sure");
  await page.locator("select").filter({ has: page.locator('option[value="Friendly"]') }).selectOption("Friendly");
  await page.locator("select").filter({ has: page.locator('option[value="yes"]') }).selectOption("yes");
  await page.getByRole("button", { name: "Add pet", exact: true }).click();
  await expect(page.getByPlaceholder("Pet name", { exact: true })).toBeHidden();
  await expect.poll(async () => {
    const response = await page.request.get("/api/customer-account"), result = await response.json();
    return result.data?.pets?.some((pet: { name: string }) => pet.name === petName);
  }).toBe(true);
  await page.reload();
  // The discovery home deliberately hides the shell header; account controls live on Account.
  await page.getByRole("button", { name: "Account", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Home", exact: true }).click();
  const persisted = await page.request.get("/api/customer-account");
  expect((await persisted.json()).data.pets.some((pet: { name: string }) => pet.name === petName)).toBe(true);
  const other = await page.request.get("/api/customer-account?customerId=UAT-AUDIT-CUSTOMER-B");
  expect(other.status()).toBe(403);
  const session = await page.request.get("/api/identity-session");
  expect((await session.json()).data).toMatchObject({ roleCode: "customer", identitySource: "uat_persona" });
  expect(otpRequests).toEqual([]);
  await test.info().attach("synthetic-customer-browser", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
});
