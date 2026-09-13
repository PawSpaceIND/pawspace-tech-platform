import { expect, test, type Page } from "@playwright/test";

// Follow-up UAT coverage for three OPTIONAL grooming-checkout UI fields that were missing from main:
//   1. Address line 2 (optional) in the shared AddressPicker
//   2. Alternative phone number (optional) on the grooming review step
//   3. Special instructions to groomer (optional) on the grooming review step
// These are additive: they must never block checkout. main's server-authoritative payment model
// (BookingPaymentPage + verified-capture) and the verified OTP identity are left untouched, so this
// spec drives the pay-after path only and asserts the optional fields do not gate confirmation.

const phone = process.env.PW_CUSTOMER_PHONE || `9${String(Date.now()).slice(-9)}`;
const MAPPED_ADDRESS = "42, Indiranagar Double Road, Stage 2, Hoysala Nagar, Indiranagar, Bengaluru 560038";

async function sandboxLogin(page: Page, loginPhone = phone) {
  await page.goto("/mobile-app");
  await page.locator("nav").getByRole("button", { name: /account/i }).last().click();
  await page.getByPlaceholder("10-digit phone number").fill(loginPhone);
  await page.getByRole("button", { name: "Send OTP" }).click();
  const sandbox = page.getByText(/Sandbox code \(no real SMS yet\):/i);
  await expect(sandbox).toBeVisible();
  const code = (await sandbox.textContent())?.match(/\b(\d{6})\b/)?.[1];
  expect(code, "local sandbox OTP must render").toMatch(/^\d{6}$/);
  await page.getByPlaceholder("6-digit code").fill(code!);
  const name = page.getByPlaceholder("Your name (first time only)");
  if (await name.isVisible().catch(() => false)) await name.fill("UAT Grooming Customer");
  const verify = page.waitForResponse(r => r.url().includes("/api/customer-otp") && r.request().method() === "POST" && r.ok());
  await page.getByRole("button", { name: "Verify & continue" }).click();
  await verify;
  await expect(page.getByPlaceholder("6-digit code")).toBeHidden();
  await expect.poll(() => page.evaluate(async () => {
    const response = await fetch("/api/identity-session", { cache: "no-store", credentials: "include" });
    return response.status;
  })).toBe(200);
}

async function ensureCustomerPet(page: Page) {
  const account = await (await page.context().request.get("/api/customer-account")).json().catch(() => ({})) as { data?: { customerId?: string; pets?: unknown[] } };
  if (account.data?.pets?.length) return;
  const create = await page.context().request.post("/api/customer-account", {
    data: { action: "upsert_pet", idempotencyKey: `uat-grooming-fields:${account.data!.customerId}`,
      pet: { name: "Buddy", species: "dog", breed: "Labrador Retriever", vaccinationStatus: "not_provided" } },
  });
  if (!create.ok()) throw new Error(`pet seed failed (${create.status()}): ${await create.text()}`);
  await expect.poll(async () => {
    const body = await (await page.context().request.get("/api/customer-account")).json().catch(() => ({})) as { data?: { pets?: Array<{ name?: string }> } };
    return Boolean(body.data?.pets?.some(p => p.name === "Buddy"));
  }).toBe(true);
}

function serviceCard(page: Page, name: string) {
  return page.getByRole("region", { name: "Care services" }).getByRole("article").filter({ hasText: name }).first();
}

async function mockAddressAutocomplete(page: Page) {
  await page.route("**/api/address-autocomplete?*", async route => {
    const query = new URL(route.request().url()).searchParams;
    if (query.get("mode") === "search") {
      return route.fulfill({ json: { data: { status: "configured", suggestions: [
        { placeId: "uat-grooming-doorstep", mainText: "42, Indiranagar Double Road",
          secondaryText: "Stage 2, Hoysala Nagar, Indiranagar, Bengaluru 560038", fullText: MAPPED_ADDRESS } ] } } });
    }
    return route.fulfill({ json: { data: { status: "configured", address: MAPPED_ADDRESS, latitude: 12.9783692, longitude: 77.6408356 } } });
  });
}

async function reachReview(page: Page, opts: { line2?: string } = {}) {
  await sandboxLogin(page);
  await ensureCustomerPet(page);
  await page.goto("/mobile-app");
  await page.locator("nav").getByRole("button", { name: /home/i }).last().click();
  const grooming = serviceCard(page, "Grooming");
  const location = page.getByRole("button", { name: "Choose your service location" });
  if (await location.isVisible().catch(() => false)) {
    await location.click();
    const dialog = page.getByRole("dialog", { name: "Choose your service area" });
    await dialog.getByRole("button", { name: "Browse without location", exact: true }).click();
    await expect(dialog).toBeHidden();
  }
  await grooming.getByRole("button", { name: /book now/i }).click();
  await expect(page.getByText("Who needs grooming?", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: /Choose a package/i }).click();
  await page.getByRole("button", { name: "Choose address and requested time", exact: true }).click();

  // Address step on the current picker (post #821): line 1 takes the typed text, a Places suggestion
  // verifies the doorstep, line 2 stays optional.
  const line1 = page.locator("#grooming-address-line-1");
  await line1.fill("42 Indiranagar Double Road");
  await page.getByRole("region", { name: "Google address suggestions", exact: true }).getByRole("button", { name: /42.*Indiranagar Double Road/ }).first().click();
  const line2 = page.locator("#grooming-address-line-2");
  await expect(line2, "optional address line 2 must be present").toBeVisible();
  await expect(line2, "address line 2 must be optional").not.toHaveAttribute("required", /.*/);
  if (opts.line2) await line2.fill(opts.line2);
  await expect(page.getByText("Verified service doorstep", { exact: true })).toBeVisible();
  // Address 1 is populated from the verified Places selection.
  await expect(line1).toHaveValue(MAPPED_ADDRESS);

  await page.getByRole("button", { name: /^11:00 AM–1:00 PM/ }).click();
  await page.getByRole("button", { name: "Review booking", exact: true }).click();
  await expect(page.getByText("Review and confirm", { exact: true })).toBeVisible();
}

async function payAfterAndConfirm(page: Page) {
  await page.getByRole("button", { name: /^Pay after service/ }).click();
  // main's sequence: "Confirm booking" on the review step creates the server-authoritative booking, then the
  // BookingPaymentPage confirms pay-after with a second "Confirm booking".
  const confirm = page.getByRole("button", { name: "Confirm booking", exact: true });
  await expect(confirm, "a blank alternative phone must not hold Confirm back").toBeEnabled();
  const created = page.waitForResponse(r => r.url().includes("/api/canonical-bookings") && r.request().method() === "POST");
  await confirm.click();
  const response = await created;
  expect(response.status(), await response.text()).toBe(201);
  await expect(page.getByRole("heading", { name: "Review payment", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Confirm booking", exact: true }).click();
  await expect(page.getByText("Your groomer is reserved.", { exact: true })).toBeVisible();
}

test("optional address line 2, alternative phone and special instructions are present, optional, and persist through checkout", async ({ page }) => {
  test.setTimeout(120_000);
  await mockAddressAutocomplete(page);
  await reachReview(page, { line2: "Near the corner park" });

  // Alternative phone (optional): present, not required, accepts a value.
  const altPhone = page.getByLabel("Alternative Phone Number", { exact: true });
  await expect(altPhone).toBeVisible();
  await expect(altPhone, "alternative phone must be optional").not.toHaveAttribute("required", /.*/);
  await altPhone.fill("9123456780");

  // Special instructions to groomer (optional): present, not required, accepts a value.
  const instructions = page.getByLabel("Special instructions to groomer", { exact: true });
  await expect(instructions).toBeVisible();
  await expect(instructions, "special instructions must be optional").not.toHaveAttribute("required", /.*/);
  await instructions.fill("Bruno is nervous with clippers — go slow.");

  await payAfterAndConfirm(page);
  // The captured instruction surfaces on the confirmation screen.
  await expect(page.getByText(/Groomer note · Bruno is nervous with clippers/)).toBeVisible();
});

test("leaving every optional field empty never blocks grooming checkout", async ({ page }) => {
  test.setTimeout(120_000);
  await mockAddressAutocomplete(page);
  await reachReview(page); // no line 2

  // Alt phone and instructions left empty on purpose.
  await expect(page.getByLabel("Alternative Phone Number", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Special instructions to groomer", { exact: true })).toHaveValue("");

  await payAfterAndConfirm(page);
  // No groomer note is rendered when instructions are empty.
  await expect(page.getByText(/Groomer note ·/)).toHaveCount(0);
});
