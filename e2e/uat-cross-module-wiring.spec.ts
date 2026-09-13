import { expect, test, type Browser, type Page } from "@playwright/test";

const ADDRESS = "42, Indiranagar Double Road, Stage 2, Hoysala Nagar, Indiranagar, Bengaluru 560038";
const phone = `6${String(Date.now()).slice(-9)}`;

async function sandboxLogin(page: Page) {
  await page.goto("/mobile-app");
  await page.locator("nav").getByRole("button", { name: /account/i }).last().click();
  await page.getByPlaceholder("10-digit phone number").fill(phone);
  await page.getByRole("button", { name: "Send OTP" }).click();
  const sandbox = page.getByText(/Sandbox code \(no real SMS yet\):/i);
  await expect(sandbox).toBeVisible();
  const code = (await sandbox.textContent())?.match(/\b(\d{6})\b/)?.[1];
  expect(code).toMatch(/^\d{6}$/);
  await page.getByPlaceholder("6-digit code").fill(code!);
  const name = page.getByPlaceholder("Your name (first time only)");
  if (await name.isVisible().catch(() => false)) await name.fill("Cross Module Wiring UAT");
  await page.getByRole("button", { name: "Verify & continue" }).click();
  await expect(page.getByPlaceholder("6-digit code")).toBeHidden();
}

async function ensurePet(page: Page) {
  const account = await (await page.context().request.get("/api/customer-account")).json();
  if (account.data?.pets?.length) return account.data.customerId as string;
  const created = await page.context().request.post("/api/customer-account", { data: {
    action: "upsert_pet", idempotencyKey: `cross-module:${account.data.customerId}`,
    pet: { name: "Buddy", species: "dog", breed: "Labrador Retriever", vaccinationStatus: "not_provided" },
  }});
  expect(created.status(), await created.text()).toBe(201);
  return account.data.customerId as string;
}

async function staffPage(browser: Browser, baseURL: string) {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await page.goto("/staging-login");
  await page.getByPlaceholder("shared UAT access code").fill(process.env.PW_STAFF_UAT_ACCESS_CODE || "pawspace-e2e-access-only");
  const signed = page.waitForResponse(r => r.url().endsWith("/api/staging-login") && r.request().method() === "POST");
  await page.getByRole("button", { name: /Founder \(full access\)/ }).click();
  expect((await signed).status()).toBe(200);
  await page.waitForURL("**/me");
  return { context, page };
}

test("grooming sandbox checkout propagates to Admin and CRM", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const baseURL = process.env.PW_BASE_URL || `http://localhost:${process.env.PW_PORT || "4185"}`;
  const staff = await staffPage(browser, baseURL);
  page.on("response", async response => {
    if (response.url().includes("/api/uat-scheduling") && response.request().method() === "POST") {
      console.log("UAT-SCHEDULING", response.status(), await response.text().catch(() => "<unreadable>"));
    }
  });
  try {
    const serviceDate = process.env.PW_UAT_SERVICE_DATE!;
    const serviceAsOf = Date.parse(`${serviceDate}T12:00:00+05:30`);
    const overviewPath = `/api/operations-overview?asOf=${serviceAsOf}`;
    const beforeResponse = await staff.page.request.get(overviewPath);
    expect(beforeResponse.status(), await beforeResponse.text()).toBe(200);
    const before = await beforeResponse.json();
    const beforeCount = Number(before.data.metrics.bookingsToday);

    await page.route("**/api/address-autocomplete?*", async route => {
      const mode = new URL(route.request().url()).searchParams.get("mode");
      if (mode === "search") return route.fulfill({ json: { data: { status: "configured", suggestions: [
        { placeId: "cross-module-doorstep", mainText: "42, Indiranagar Double Road", secondaryText: "Bengaluru 560038", fullText: ADDRESS },
      ] } } });
      return route.fulfill({ json: { data: { status: "configured", address: ADDRESS, latitude: 12.9783692, longitude: 77.6408356 } } });
    });

    await sandboxLogin(page);
    const customerId = await ensurePet(page);
    await page.goto("/mobile-app");
    await page.locator("nav").getByRole("button", { name: /home/i }).last().click();
    const grooming = page.getByRole("region", { name: "Care services" }).getByRole("article").filter({ hasText: "Grooming" }).first();
    const location = page.getByRole("button", { name: "Choose your service location" });
    if (await location.isVisible().catch(() => false)) {
      await location.click();
      await page.getByRole("dialog", { name: "Choose your service area" }).getByRole("button", { name: "Browse without location" }).click();
    }
    await grooming.getByRole("button", { name: /book now/i }).click();
    await page.getByRole("button", { name: /Choose a package/i }).click();
    await page.getByRole("button", { name: "Choose address and requested time" }).click();
    await page.getByLabel("Complete doorstep address").fill("42, Indiranagar Double Road, Bengaluru");
    await page.getByLabel("Pincode").fill("560038");
    await page.getByRole("button", { name: "Use this address" }).click();
    await page.getByRole("region", { name: "Matching map addresses" }).getByRole("button", { name: /42.*Indiranagar Double Road/ }).click();

    const serviceDay = Number(serviceDate.slice(-2));
    const serviceMonth = new Intl.DateTimeFormat("en-IN", { month: "short", timeZone: "Asia/Kolkata" })
      .format(new Date(`${serviceDate}T12:00:00+05:30`));
    await page.getByRole("button", { name: new RegExp(`${serviceDay} ${serviceMonth}$`) }).click();
    await page.getByRole("button", { name: /^3:00–5:00 PM/ }).click();
    await page.getByRole("button", { name: "Review booking" }).click();
    await page.getByRole("button", { name: /^Pay online/ }).click();
    const created = page.waitForResponse(r => r.url().includes("/api/canonical-bookings") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Continue to payment" }).click();
    const bookingResponse = await created;
    expect(bookingResponse.status(), await bookingResponse.text()).toBe(201);
    const booking = await bookingResponse.json();
    const bookingId = String(booking.data?.bookingId || "");
    expect(bookingId).toMatch(/^PS-/);
    await expect(page.getByText("Secure Razorpay checkout", { exact: true })).toBeVisible();

    // Local UAT uses the governed Razorpay sandbox simulator to reconcile a capture without live money.
    const linked = await staff.page.request.post("/api/grooming-payment-sandbox", { data: { action: "link_order", bookingId } });
    expect(linked.status(), await linked.text()).toBe(201);
    const captured = await staff.page.request.post("/api/grooming-payment-sandbox", { data: { action: "simulate_event", bookingId, eventType: "payment.captured" } });
    expect(captured.status(), await captured.text()).toBe(201);
    await page.getByRole("button", { name: /Pay securely/ }).click();
    await expect(page.getByText(/verified|captured|updated payment/i).first()).toBeVisible();

    await staff.page.goto("/admin");
    await expect(staff.page.getByText("Today’s bookings", { exact: true })).toBeVisible();
    await expect.poll(async () => Number((await (await staff.page.request.get(overviewPath)).json()).data.metrics.bookingsToday), {
      message: "ADMIN_DISCONNECTION: canonical booking did not increment operations overview",
    }).toBe(beforeCount + 1);

    await staff.page.goto("/crm");
    const crmResponse = await staff.page.request.get("/api/crm");
    expect(crmResponse.status(), await crmResponse.text()).toBe(200);
    const crm = await crmResponse.json();
    const contact = (crm.contacts || []).find((row: { id?: string }) => row.id === customerId);
    expect(contact, `CRM_DISCONNECTION: customer ${customerId} from canonical checkout is not projected into crm_contacts`).toBeTruthy();
    await expect(staff.page.locator("body"), "CRM_LEDGER_DISCONNECTION: CRM customer ledger does not expose the canonical booking ID").toContainText(bookingId);
  } finally {
    await staff.context.close();
  }
});
