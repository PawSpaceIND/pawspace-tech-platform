import { expect, test } from "@playwright/test";

const phone = process.env.PW_CUSTOMER_PHONE || "9000000911";

async function sandboxLogin(page: import("@playwright/test").Page) {
  await page.goto("/mobile-app");
  const account = page.locator("nav").getByRole("button", { name: /account/i }).last();
  await account.click();
  await page.getByPlaceholder("10-digit phone number").fill(phone);
  await page.getByRole("button", { name: "Send OTP" }).click();
  const sandbox = page.getByText(/Sandbox code \(no real SMS yet\):/i);
  await expect(sandbox).toBeVisible();
  const code = (await sandbox.textContent())?.match(/\b(\d{6})\b/)?.[1];
  expect(code, "local sandbox OTP must be rendered").toMatch(/^\d{6}$/);
  await page.getByPlaceholder("6-digit code").fill(code!);
  const name = page.getByPlaceholder("Your name (first time only)");
  if (await name.isVisible().catch(() => false)) await name.fill("Browser E2E Customer");
  const verify = page.waitForResponse(response => response.url().includes("/api/customer-otp") && response.request().method() === "POST" && response.ok());
  await page.getByRole("button", { name: "Verify & continue" }).click();
  await verify;
  await expect(page.getByPlaceholder("6-digit code")).toBeHidden();
}

async function ensureCustomerPet(page: import("@playwright/test").Page) {
  const accountResponse = await page.context().request.get("/api/customer-account");
  expect(accountResponse.ok(), `customer account must resolve after sandbox OTP (${accountResponse.status()})`).toBeTruthy();
  const account = await accountResponse.json().catch(() => ({})) as { data?: { pets?: Array<{ name?: string }> } };
  if (account.data?.pets?.length) return;

  const create = await page.context().request.post("/api/customer-account", {
    data: {
      action: "upsert_pet",
      idempotencyKey: `browser-e2e:customer-pet:${phone}`,
      pet: {
        name: "Buddy",
        species: "dog",
        breed: "Labrador Retriever",
        vaccinationStatus: "not_provided",
      },
    },
  });
  if (!create.ok()) throw new Error(`authenticated customer pet seed failed (${create.status()}): ${await create.text()}`);

  await expect.poll(async () => {
    const response = await page.context().request.get("/api/customer-account");
    if (!response.ok()) return false;
    const body = await response.json().catch(() => ({})) as { data?: { pets?: Array<{ name?: string }> } };
    return Boolean(body.data?.pets?.some(pet => pet.name === "Buddy"));
  }).toBe(true);
}

function serviceCard(page: import("@playwright/test").Page, name: string) {
  return page.getByRole("region", { name: "Care services" }).getByRole("article").filter({ hasText: name }).first();
}

test("customer: discovery -> location -> grooming package -> slot/checkout surface", async ({ page }) => {
  await sandboxLogin(page);
  await ensureCustomerPet(page);
  await page.goto("/mobile-app");

  const home = page.locator("nav").getByRole("button", { name: /home/i }).last();
  await home.click();
  await expect(page.getByText("Everything they need", { exact: true })).toBeVisible();

  const grooming = serviceCard(page, "Grooming");
  const training = serviceCard(page, "Training");
  const boarding = serviceCard(page, "Boarding");
  await expect(grooming).toBeVisible();
  await expect(training).toBeVisible();
  await expect(boarding).toBeVisible();
  await expect(grooming.getByRole("button", { name: /book now/i })).toBeVisible();
  await expect(training.getByRole("button", { name: /book now/i })).toBeVisible();
  await expect(boarding.getByRole("button", { name: /book now/i })).toBeVisible();

  const location = page.getByRole("button", { name: "Choose your service location" });
  if (await location.isVisible().catch(() => false)) {
    await location.click();
    await page.getByPlaceholder("e.g. HSR Layout, Bengaluru").fill("Indiranagar, Bengaluru");
    await page.getByRole("button", { name: "Save location" }).click();
    await expect(page.getByRole("button", { name: /Choose your service location/i })).toContainText(/Indiranagar\s*,?\s*Bengaluru/i);
  }

  await grooming.getByRole("button", { name: /book now/i }).click();
  await expect(page.getByText("Who needs grooming?", { exact: false })).toBeVisible();
  await expect(page.getByText("Buddy", { exact: true }).first()).toBeVisible();

  const choosePackage = page.getByRole("button", { name: /Choose a package/i });
  await expect(choosePackage).toBeEnabled();
  await choosePackage.click();
  await expect(page.getByText(/Essential Bath|Bath & Basic|Complete Makeover|Just Trim/i).first()).toBeVisible();
});
