import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";

const ADDRESS = "42, Indiranagar Double Road, Stage 2, Hoysala Nagar, Indiranagar, Bengaluru 560038";
const PROVIDER_NAME = "PawSpace Grooming Team (UAT)";
const PREFERRED_PROVIDER_ID = "uatcap_groom_ft";
const phone = `6${String(Date.now()).slice(-9)}`;
const evidenceDir = process.env.PW_VISUAL_UAT_ARTIFACT_DIR || "visual-uat-evidence";
mkdirSync(evidenceDir, { recursive: true });

async function shot(page: Page, name: string) {
  await page.screenshot({ path: join(evidenceDir, name), fullPage: true });
}

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
  if (await name.isVisible().catch(() => false)) await name.fill("Visual UAT Sweep");
  await page.getByRole("button", { name: "Verify & continue" }).click();
  await expect(page.getByPlaceholder("6-digit code")).toBeHidden();
}

async function ensurePet(page: Page) {
  const response = await page.context().request.get("/api/customer-account");
  expect(response.status(), await response.text()).toBe(200);
  const account = await response.json();
  if (account.data?.pets?.length) return account.data.customerId as string;
  const created = await page.context().request.post("/api/customer-account", { data: {
    action: "upsert_pet",
    idempotencyKey: `visual-uat:${account.data.customerId}`,
    pet: { name: "Buddy", species: "dog", breed: "Labrador Retriever", vaccinationStatus: "not_provided" },
  }});
  expect(created.status(), await created.text()).toBe(201);
  return account.data.customerId as string;
}

async function staffPage(browser: Browser, baseURL: string, identity: RegExp) {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await page.goto("/staging-login");
  await page.getByPlaceholder("shared UAT access code").fill(process.env.PW_STAFF_UAT_ACCESS_CODE || "");
  const signed = page.waitForResponse(r => r.url().endsWith("/api/staging-login") && r.request().method() === "POST");
  await page.getByRole("button", { name: identity }).click();
  expect((await signed).status()).toBe(200);
  await page.waitForURL("**/me");
  return { context, page };
}

async function mockAddress(page: Page) {
  await page.route("**/api/address-autocomplete?*", async route => {
    const mode = new URL(route.request().url()).searchParams.get("mode");
    if (mode === "search") return route.fulfill({ json: { data: { status: "configured", suggestions: [{
      placeId: "visual-uat-doorstep", mainText: "42, Indiranagar Double Road", secondaryText: "Bengaluru 560038", fullText: ADDRESS,
    }] } } });
    return route.fulfill({ json: { data: { status: "configured", address: ADDRESS, latitude: 12.9783692, longitude: 77.6408356 } } });
  });
}

async function openGrooming(page: Page, serviceDate: string, slot = "3:00–5:00 PM") {
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
  await page.getByLabel(/Address Line 1/).fill("42, Indiranagar Double Road, Bengaluru");
  await page
    .getByRole("region", { name: "Google address suggestions" })
    .getByRole("button", { name: /42.*Indiranagar Double Road/ })
    .click();
  await expect(page.getByText("Verified service doorstep", { exact: true })).toBeVisible();
  const serviceDay = Number(serviceDate.slice(-2));
  const serviceMonth = new Intl.DateTimeFormat("en-IN", { month: "short", timeZone: "Asia/Kolkata" }).format(new Date(`${serviceDate}T12:00:00+05:30`));
  await page.getByRole("button", { name: new RegExp(`${serviceDay} ${serviceMonth}$`) }).click();
  await page.getByRole("button", { name: new RegExp(`^${slot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) }).click();
  const preferredRegion = page.getByRole("region", { name: "Preferred groomer" });
  await expect(preferredRegion).toBeVisible();
  const preferredProvider = preferredRegion.getByRole("button", { name: new RegExp(PROVIDER_NAME) });
  const preferredVisible = await expect(preferredProvider).toBeVisible({ timeout: 10_000 }).then(() => true).catch(() => false);
  if (preferredVisible) {
    await preferredProvider.click();
  } else {
    await expect(preferredRegion.getByRole("alert")).toContainText("Availability search timed out");
    await preferredRegion.getByRole("button", { name: "No preference" }).click();
  }
  await page.getByRole("button", { name: "Review booking" }).click();
  await page.getByLabel("Alternative Phone Number").fill("9876543210");
  return preferredVisible;
}

async function createPayAfter(page: Page) {
  await page.getByRole("button", { name: /^Pay after service/ }).click();
  const created = page.waitForResponse(r => r.url().includes("/api/canonical-bookings") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Confirm booking" }).click();
  const response = await created;
  expect(response.status(), await response.text()).toBe(201);
  const body = await response.json();
  const bookingId = String(body.data?.bookingId || "");
  expect(bookingId).toMatch(/^PS-/);
  await expect(page.getByText("Pay after service", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Confirm booking" }).click();
  await expect(page.getByText(new RegExp(`BOOKING CONFIRMED · ${bookingId}`))).toBeVisible();
  return bookingId;
}

async function verifyRazorpayModal(page: Page, serviceDate: string) {
  const nextDate = new Date(`${serviceDate}T12:00:00+05:30`);
  nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  const onlineDate = nextDate.toISOString().slice(0, 10);
  await openGrooming(page, onlineDate, "11:00 AM–1:00 PM");
  await page.getByRole("button", { name: /^Pay online/ }).click();
  const created = page.waitForResponse(r => r.url().includes("/api/canonical-bookings") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Confirm booking" }).click();
  const response = await created;
  expect(response.status(), await response.text()).toBe(201);
  const body = await response.json();
  expect(body.data?.status).toBe("payment_pending");
  await expect(page.locator(".razorpay-checkout-frame")).toBeAttached({ timeout: 30_000 });
  await shot(page, "02-customer-razorpay-modal.png");
}

test("live staging visual UAT sweep: Customer -> Partner -> Admin -> CRM", async ({ page, browser }) => {
  test.setTimeout(360_000);
  const baseURL = process.env.PW_BASE_URL!;
  const serviceDate = process.env.PW_UAT_SERVICE_DATE!;
  expect(baseURL).toContain("pawspace-staging");
  expect(process.env.PW_STAFF_UAT_ACCESS_CODE).toBeTruthy();
  await mockAddress(page);
  await sandboxLogin(page);
  const customerId = await ensurePet(page);

  const founder = await staffPage(browser, baseURL, /Founder \(full access\)/);
  const partner = await staffPage(browser, baseURL, /Employee — groomer \(self-service\)/);
  try {
    const asOf = Date.parse(`${serviceDate}T12:00:00+05:30`);
    const overviewPath = `/api/operations-overview?asOf=${asOf}`;
    const beforeResponse = await founder.page.request.get(overviewPath);
    expect(beforeResponse.status(), await beforeResponse.text()).toBe(200);
    const before = await beforeResponse.json();
    const beforeCount = Number(before.data.metrics.bookingsToday);

    const preferredProviderSelected = await openGrooming(page, serviceDate);
    const bookingId = await createPayAfter(page);
    await shot(page, "01-customer-pay-after-confirmed.png");

    const canonicalResponse = await founder.page.request.get("/api/canonical-bookings");
    expect(canonicalResponse.status(), await canonicalResponse.text()).toBe(200);
    const canonical = await canonicalResponse.json();
    const canonicalBooking = (canonical.bookings || []).find((row: { id?: string }) => row.id === bookingId);
    expect(canonicalBooking, `ADMIN_DISCONNECTION: ${bookingId} missing from canonical lifecycle`).toBeTruthy();
    const assignedProviderId = String(canonicalBooking.provider_id || "");
    expect(assignedProviderId, `SCHEDULING_DISCONNECTION: ${bookingId} has no assigned provider`).toBeTruthy();
    if (preferredProviderSelected) {
      expect(assignedProviderId, `SCHEDULING_DISCONNECTION: preferred groomer was selected but ${bookingId} was assigned elsewhere`).toBe(PREFERRED_PROVIDER_ID);
    }

    const switched = await partner.page.request.post("/api/uat-provider-switch", { data: {
      providerId: assignedProviderId,
      code: process.env.PW_STAFF_UAT_ACCESS_CODE,
    }});
    expect(switched.status(), await switched.text()).toBe(200);
    const switchedBody = await switched.json();
    expect(switchedBody.data?.providerId).toBe(assignedProviderId);

    const feedResponse = await partner.page.request.get("/api/partner-job-feed");
    expect(feedResponse.status(), await feedResponse.text()).toBe(200);
    const feed = await feedResponse.json();
    const jobs = [ ...(feed.data?.needsAction || []), ...(feed.data?.today || []), ...(feed.data?.upcoming || []), ...(feed.data?.completed || []) ];
    expect(jobs.some((job: { bookingId?: string }) => job.bookingId === bookingId), `PARTNER_DISCONNECTION: ${bookingId} missing from authenticated provider feed`).toBe(true);
    await partner.page.goto("/partner/jobs");
    await expect(partner.page.getByTestId(`partner-job-${bookingId}`)).toBeVisible();
    await shot(partner.page, "03-partner-exact-job.png");

    await expect.poll(async () => {
      const r = await founder.page.request.get(overviewPath);
      return Number((await r.json()).data.metrics.bookingsToday);
    }, { message: "ADMIN_DISCONNECTION: service-date booking count did not increment" }).toBe(beforeCount + 1);
    await founder.page.goto(`/team/operations/bookings?bookingId=${encodeURIComponent(bookingId)}`);
    await expect(founder.page.locator("body")).toContainText(bookingId);
    await shot(founder.page, "04-founder-admin-booking-command-center.png");

    await founder.page.goto("/crm");
    const crmResponse = await founder.page.request.get("/api/crm");
    expect(crmResponse.status(), await crmResponse.text()).toBe(200);
    const crm = await crmResponse.json();
    const contact = (crm.contacts || []).find((row: { id?: string }) => row.id === customerId);
    expect(contact, `CRM_DISCONNECTION: ${customerId} missing from crm_contacts`).toBeTruthy();
    expect(contact.latest_booking_id).toBe(bookingId);
    await expect(founder.page.locator("body")).toContainText(bookingId);
    await shot(founder.page, "05-founder-crm.png");

    await verifyRazorpayModal(page, serviceDate);
    console.log(`VISUAL_UAT_BOOKING_ID=${bookingId}`);
  } finally {
    await partner.context.close();
    await founder.context.close();
  }
});
