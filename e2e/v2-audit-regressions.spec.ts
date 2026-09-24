import { expect, test, type Page } from "@playwright/test";
// Real application UI; external Places suggestions are deliberately absent so typed-address fallback is exercised.
// No authentication bypass, live payment, SMS, customer call or production data is used.
async function startGrooming(page: Page) {
  await page.route("**/api/address-autocomplete?*", route => route.fulfill({ json: { data: { status: "configured", suggestions: [] } } }));
  await page.goto("/mobile-app");
  const essential = page.getByRole("button", { name: "Essential only", exact: true });
  if (await essential.isVisible().catch(() => false)) await essential.click();
  await page.getByRole("button", { name: /Book now.*Grooming/ }).click();
  const back = page.getByRole("button", { name: /^\u2190 Pets$/ });
  if (await back.isVisible().catch(() => false)) await back.click();
}
async function addPet(page: Page, name: string) {
  const details = page.getByRole("button", { name: "Add or edit pet details", exact: true });
  if (await details.isVisible().catch(() => false)) await details.click();
  await page.getByRole("button", { name: /\uff0b Add pet/, exact: true }).click();
  await page.getByPlaceholder("Pet name", { exact: true }).fill(name);
  await page.getByPlaceholder("Start typing a breed").fill("Labrador Retriever");
  await page.locator("select").filter({ has: page.locator('option[value="3 years"]') }).selectOption("3 years");
  await page.locator("select").filter({ has: page.locator('option[value="Not sure"]') }).selectOption("Not sure");
  await page.locator("select").filter({ has: page.locator('option[value="Friendly"]') }).selectOption("Friendly");
  await page.locator("select").filter({ has: page.locator('option[value="yes"]') }).selectOption("yes");
  await page.getByRole("button", { name: "Add pet", exact: true }).click();
  await expect(page.getByPlaceholder("Pet name", { exact: true })).toBeHidden();
}
async function reachAddress(page: Page) {
  await startGrooming(page); await addPet(page, "QA Audit Bruno");
  await page.getByRole("button", { name: "Choose a package", exact: true }).click();
  await page.getByRole("button", { name: "Choose address and requested time", exact: true }).click();
}
test("contradictory typed address is rejected without an unhandled browser error", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await reachAddress(page);
  await page.locator("#grooming-address-line-1").fill("24 QA Test Road, Andheri West, Mumbai, Maharashtra 560076");
  await expect(page.getByRole("alert")).toContainText("different city");
  await expect(page.getByRole("button", { name: "Review booking", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Verify service address", exact: true }).first().click();
  await expect(page.getByRole("alert")).toContainText("different city");
  expect(errors).toEqual([]);
});
test("review retains the complete street and apartment and rejects a conflicting edit", async ({ page }) => {
  await reachAddress(page);
  const street = "Flat 123456, 18th Main Road, BTM Layout, Bengaluru 560076", apartment = "QA Tower, Flat 402, Fourth floor";
  await page.locator("#grooming-address-line-1").fill(street);
  await expect(page.getByText("Service area matched - doorstep not map verified", { exact: true })).toBeVisible();
  await page.locator("#grooming-address-line-2").fill(apartment);
  const draft = await page.evaluate(() => JSON.parse(sessionStorage.getItem("pawspace.selected-service-address") || "null"));
  expect(draft).toMatchObject({addressLine1:street,addressLine2:apartment,verification:"manual",requiresRevalidation:true});
  for(const field of ["latitude","longitude","placeId","zone","assignment"])expect(draft).not.toHaveProperty(field);
  await page.getByRole("button", { name: /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun),/ }).first().click();
  await page.getByRole("button", { name: /^11:00 AM/ }).click();
  await page.getByRole("button", { name: "Review booking", exact: true }).click();
  await expect(page.getByText("Review and confirm", { exact: true })).toBeVisible();
  await expect(page.getByText(`${street}, ${apartment}`, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm booking", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: /^\u2190 Slot$/ }).click();
  await page.locator("#grooming-address-line-2").fill("Mumbai, Maharashtra");
  await expect(page.getByRole("alert")).toContainText("different city");
  await expect(page.getByRole("button", { name: "Review booking", exact: true })).toHaveCount(0);
});
test("the fifth pet opens a prefilled enquiry and preserves the four-pet booking", async ({ page }) => {
  await startGrooming(page);
  const names = ["QA Audit One", "QA Audit Two", "QA Audit Three", "QA Audit Four", "QA Audit Five"];
  for (const name of names) await addPet(page, name);
  const card = (name: string) => page.getByRole("button").filter({ hasText: name }).filter({ hasText: /Selected|Add/ }).first();
  for (const name of names.slice(0, 4)) if (!(await card(name).innerText()).includes("Selected")) await card(name).click();
  await card(names[4]).click();
  const enquiry = page.getByRole("dialog", { name: "Large pet family enquiry" });
  await expect(enquiry).toBeVisible();
  await expect(enquiry.locator('select[name="service"]')).toHaveValue("Grooming");
  for (const name of names) await expect(enquiry.locator('textarea[name="message"]')).toHaveValue(new RegExp(name));
  await enquiry.locator('input[name="name"]').fill("QA Large Family");
  await enquiry.locator('input[name="phone"]').fill("9000000803");
  await expect(enquiry.locator('input[name="whatsappConsent"]')).not.toBeChecked();
  const responsePromise = page.waitForResponse(r => r.url().endsWith("/api/public-contact") && r.request().method() === "POST");
  await enquiry.getByRole("button", { name: "Send message", exact: true }).click();
  const response = await responsePromise;
  expect(response.status(), await response.text()).toBe(201);
  await expect(enquiry.getByText("Thanks — we've got it.", { exact: true })).toBeVisible();
  await enquiry.getByRole("button", { name: "Return to booking", exact: true }).click();
  await expect(enquiry).toHaveCount(0);
  for (const name of names.slice(0, 4)) await expect(card(name)).toContainText("Selected");
  await expect(card(names[4])).not.toContainText("Selected");
});
test("manual CRM offers Relocation and blocks a two-digit mobile before sending", async ({ page }) => {
  const posts: string[] = [];
  page.on("request", request => { if (request.method() === "POST" && request.url().endsWith("/api/crm")) posts.push(request.url()); });
  const loaded = page.waitForResponse(response => response.url().endsWith("/api/crm") && response.request().method() === "GET");
  await page.goto("/v2/crm");
  await loaded; // The CRM effect has mounted; do not click an unhydrated SSR button.
  const essential = page.getByRole("button", { name: "Essential only", exact: true });
  if (await essential.isVisible().catch(() => false)) await essential.click();
  await page.getByRole("button", { name: /Add lead/ }).click();
  await page.locator('select[name="service"]').selectOption({ label: "Relocation" });
  await expect(page.locator('select[name="service"]')).toHaveValue("Relocation");
  await page.getByPlaceholder("Full name").fill("QA Invalid Lead");
  await page.getByPlaceholder("10-digit number", { exact: true }).fill("12");
  await page.getByPlaceholder("Pet name", { exact: true }).fill("QA Pet");
  await page.getByRole("button", { name: "Save lead & create follow-up", exact: true }).click();
  expect(await page.locator('input[name="phone"]').evaluate((input: HTMLInputElement) => input.validity.patternMismatch)).toBe(true);
  expect(posts).toEqual([]);
});
test.beforeEach(async ({ baseURL }) => {
  const host = new URL(baseURL || "http://localhost").hostname;
  test.skip(!["localhost", "127.0.0.1"].includes(host), "these synthetic write tests run only against the isolated local harness; remote E2E remains a separate gate");
});
test.afterEach(async ({ page }, testInfo) => {
  if (!page.isClosed()) await testInfo.attach("audit-browser", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
});
test("restored address cannot reuse stale coverage after a service area is removed", async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("pawspace.selected-service-address", JSON.stringify({
    addressLine1: "18th Main Road, BTM Layout, Bengaluru 560076", addressLine2: "QA Flat 402",
    address: "18th Main Road, BTM Layout, Bengaluru 560076, QA Flat 402", verification: "map", placeId: "old-place",
    latitude: 12.925, longitude: 77.5938,
    assignment: { cityId: "blr", city: "Bengaluru", zoneId: "blr-south", area: "BTM Layout", pincode: "560076" },
    zone: { zoneId: "blr-south", zoneName: "South Bengaluru", serviceAvailable: true, description: "Old coverage", color: "#000000" },
  })));
  let lookups = 0;
  await page.route("**/api/service-zone?pincode=560076", route => {
    lookups += 1; return route.fulfill({ status: 404, json: { error: "This service area has been removed" } });
  });
  await reachAddress(page);
  await expect(page.getByRole("alert")).toContainText("service area has been removed");
  expect(lookups).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: "Review booking", exact: true })).toHaveCount(0);
  await expect(page.getByText("Verified service doorstep", { exact: true })).toHaveCount(0);
});
