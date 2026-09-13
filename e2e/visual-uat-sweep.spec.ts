import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

const EVIDENCE_DIR = "visual-uat-evidence";
const ADDRESS = "42, Indiranagar Double Road, Stage 2, Hoysala Nagar, Indiranagar, Bengaluru 560038";
const phone = `9${String(Date.now()).slice(-9)}`;
const providerCandidates = [
  "uat.demo.groomer@tkpetcare.in",
  "asha.groomer1@tkpetcare.in",
  "rahul.groomer2@tkpetcare.in",
  "priya.groomer3@tkpetcare.in",
  "sanjay.groomer4@tkpetcare.in",
  "neha.groomer5@tkpetcare.in",
  "vikram.groomer6@tkpetcare.in",
  "divya.groomer7@tkpetcare.in",
  "arjun.groomer8@tkpetcare.in",
  "meena.groomer9@tkpetcare.in",
  "kiran.groomer10@tkpetcare.in",
];

function dateAhead(days: number) {
  const now = new Date(Date.now() + 330 * 60_000);
  now.setUTCDate(now.getUTCDate() + days);
  return now.toISOString().slice(0, 10);
}
function dateButtonName(iso: string) {
  const day = Number(iso.slice(-2));
  const month = new Intl.DateTimeFormat("en-IN", { month: "short", timeZone: "Asia/Kolkata" })
    .format(new Date(`${iso}T12:00:00+05:30`));
  return new RegExp(`${day} ${month}$`);
}
async function shot(page: Page, name: string) {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({ path: `${EVIDENCE_DIR}/${name}.png`, fullPage: true });
}

async function sandboxLogin(page: Page) {
  await page.goto("/mobile-app");
  await page.locator("nav").getByRole("button", { name: /account/i }).last().click();
  await page.getByPlaceholder("10-digit phone number").fill(phone);
  await page.getByRole("button", { name: "Send OTP" }).click();
  const sandbox = page.getByText(/Sandbox code \(no real SMS yet\):/i);
  await expect(sandbox).toBeVisible();
  const code = (await sandbox.textContent())?.match(/\b(\d{6})\b/)?.[1];
  expect(code, "staging sandbox OTP must be visible only to the browser session").toMatch(/^\d{6}$/);
  await page.getByPlaceholder("6-digit code").fill(code!);
  const name = page.getByPlaceholder("Your name (first time only)");
  if (await name.isVisible().catch(() => false)) await name.fill("Visual UAT Sweep");
  await page.getByRole("button", { name: "Verify & continue" }).click();
  await expect(page.getByPlaceholder("6-digit code")).toBeHidden();
}

async function ensurePet(page: Page) {
  const accountResponse = await page.context().request.get("/api/customer-account");
  expect(accountResponse.status(), await accountResponse.text()).toBe(200);
  const account = await accountResponse.json();
  if (account.data?.pets?.length) return String(account.data.customerId);
  const created = await page.context().request.post("/api/customer-account", { data: {
    action: "upsert_pet", idempotencyKey: `visual-sweep:${account.data.customerId}`,
    pet: { name: "Buddy", species: "dog", breed: "Labrador Retriever", vaccinationStatus: "not_provided" },
  }});
  expect(created.status(), await created.text()).toBe(201);
  return String(account.data.customerId);
}

async function mockAddress(page: Page) {
  await page.route("**/api/address-autocomplete?*", async route => {
    const mode = new URL(route.request().url()).searchParams.get("mode");
    if (mode === "search") return route.fulfill({ json: { data: { status: "configured", suggestions: [
      { placeId: "visual-uat-doorstep", mainText: "42, Indiranagar Double Road", secondaryText: "Bengaluru 560038", fullText: ADDRESS },
    ] } } });
    return route.fulfill({ json: { data: { status: "configured", address: ADDRESS, latitude: 12.9783692, longitude: 77.6408356 } } });
  });
}

async function reachReview(page: Page, serviceDate: string) {
  await page.goto("/mobile-app");
  await page.locator("nav").getByRole("button", { name: /home/i }).last().click();
  const location = page.getByRole("button", { name: "Choose your service location" });
  if (await location.isVisible().catch(() => false)) {
    await location.click();
    await page.getByRole("dialog", { name: "Choose your service area" }).getByRole("button", { name: "Browse without location" }).click();
  }
  const grooming = page.getByRole("region", { name: "Care services" }).getByRole("article").filter({ hasText: "Grooming" }).first();
  await grooming.getByRole("button", { name: /book now/i }).click();
  await page.getByRole("button", { name: /Choose a package/i }).click();
  await page.getByRole("button", { name: "Choose address and requested time" }).click();
  await page.getByLabel("Complete doorstep address").fill("42, Indiranagar Double Road, Bengaluru");
  await page.getByLabel("Pincode").fill("560038");
  await page.getByRole("button", { name: "Use this address" }).click();
  await page.getByRole("region", { name: "Matching map addresses" }).getByRole("button", { name: /42.*Indiranagar Double Road/ }).click();
  await page.getByRole("button", { name: dateButtonName(serviceDate) }).click();
  await page.getByRole("button", { name: /^11:00 AM–1:00 PM/ }).click();
  await page.getByRole("button", { name: "Review booking" }).click();
  await expect(page.getByText("Review and confirm", { exact: true })).toBeVisible();
}

async function createPayAfter(page: Page, serviceDate: string) {
  await reachReview(page, serviceDate);
  await page.getByRole("button", { name: /^Pay after service/ }).click();
  const created = page.waitForResponse(r => r.url().includes("/api/canonical-bookings") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Continue to payment" }).click();
  const response = await created;
  expect(response.status(), await response.text()).toBe(201);
  const payload = await response.json();
  const bookingId = String(payload.data?.bookingId || "");
  expect(bookingId).toMatch(/^PS-/);
  await page.getByRole("button", { name: "Confirm booking", exact: true }).click();
  await expect(page.getByText("Your groomer is reserved.", { exact: true })).toBeVisible();
  await expect(page.getByText(new RegExp(bookingId))).toBeVisible();
  return bookingId;
}

async function proveRazorpayModal(page: Page, serviceDate: string) {
  await reachReview(page, serviceDate);
  await page.getByRole("button", { name: /^Pay online/ }).click();
  const created = page.waitForResponse(r => r.url().includes("/api/canonical-bookings") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Continue to payment" }).click();
  const response = await created;
  expect(response.status(), await response.text()).toBe(201);
  const payload = await response.json();
  expect(String(payload.data?.bookingId || "")).toMatch(/^PS-/);
  await expect(page.getByText("Secure Razorpay checkout", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Pay securely/ }).click();
  const iframe = page.locator("iframe.razorpay-checkout-frame, iframe[src*='razorpay']").first();
  await expect(iframe, "RAZORPAY_MODAL_MISSING: sandbox checkout iframe did not mount").toBeAttached({ timeout: 20_000 });
  await shot(page, "02-customer-razorpay-modal");
}

async function stagingLogin(browser: Browser, email: string) {
  const baseURL = process.env.PW_BASE_URL!;
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await page.goto("/staging-login");
  await page.getByPlaceholder("shared UAT access code").fill(process.env.PW_STAFF_UAT_ACCESS_CODE || "");
  if (email === "founder@pawspace.in") {
    await page.getByRole("button", { name: /Founder \(full access\)/ }).click();
  } else {
    await page.getByPlaceholder(/seeded staff email/).fill(email);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
  }
  await page.waitForURL("**/me");
  return { context, page };
}

async function assignedProvider(founder: Page, bookingId: string) {
  const response = await founder.request.get("/api/canonical-bookings");
  expect(response.status(), await response.text()).toBe(200);
  const body = await response.json();
  const row = (body.bookings || []).find((item: Record<string, unknown>) => String(item.id) === bookingId);
  expect(row, `ADMIN_DISCONNECTION: ${bookingId} is missing from canonical founder booking read`).toBeTruthy();
  const providerId = String(row.provider_id || "");
  expect(providerId, `PROVIDER_DISCONNECTION: ${bookingId} has no canonical provider`).not.toBe("");
  return providerId;
}

async function linkedPartner(browser: Browser, providerId: string, bookingId: string) {
  let lastStatus = 0;
  for (const email of providerCandidates) {
    const session = await stagingLogin(browser, email);
    const response = await session.page.request.get(`/api/partner-job-feed?providerId=${encodeURIComponent(providerId)}`);
    lastStatus = response.status();
    if (response.ok()) {
      const body = await response.json();
      const jobs = [body.data?.needsAction, body.data?.today, body.data?.upcoming, body.data?.completed].flat().filter(Boolean);
      const exact = jobs.find((job: { bookingId?: string }) => job.bookingId === bookingId);
      if (exact) return { ...session, email };
    }
    await session.context.close();
  }
  throw new Error(`PARTNER_IDENTITY_DISCONNECTION: provider ${providerId} for ${bookingId} has no tested active provider identity link (last status ${lastStatus})`);
}

test("visual staging sweep proves Customer -> Partner -> Founder wiring", async ({ page, browser }) => {
  test.setTimeout(240_000);
  expect(process.env.PW_BASE_URL).toMatch(/^https:\/\/pawspace-staging\./);
  expect(process.env.PW_STAFF_UAT_ACCESS_CODE, "CI must inject the staging UAT access code").toBeTruthy();
  await mockAddress(page);
  await sandboxLogin(page);
  await ensurePet(page);

  // Razorpay modal proof uses its own future slot. No fake receipt or captured-payment assertion.
  await proveRazorpayModal(page, dateAhead(2));
  await page.goto("/mobile-app");

  // This pay-after booking is the canonical ID followed through Partner, Admin and CRM.
  const bookingId = await createPayAfter(page, dateAhead(1));
  await shot(page, "01-customer-pay-after-confirmed");

  const founder = await stagingLogin(browser, "founder@pawspace.in");
  let partner: { context: BrowserContext; page: Page; email: string } | null = null;
  try {
    const providerId = await assignedProvider(founder.page, bookingId);
    partner = await linkedPartner(browser, providerId, bookingId);
    await partner.page.goto("/partner/jobs");
    await expect(partner.page.getByRole("heading", { name: "Your jobs", exact: true })).toBeVisible();
    await expect(partner.page.locator("body"), "PARTNER_JOB_DISCONNECTION: assigned partner UI does not contain canonical booking").toContainText(bookingId);
    await shot(partner.page, "03-partner-jobs");

    await founder.page.goto("/admin");
    await expect(founder.page.getByText("Today’s bookings", { exact: true })).toBeVisible();
    await shot(founder.page, "04-founder-admin-overview");
    // The booking is future-dated by design; verify its literal ID in the connected Booking Command Center.
    await founder.page.goto(`/team/operations/bookings?bookingId=${encodeURIComponent(bookingId)}`);
    await expect(founder.page.locator("body"), "ADMIN_BOOKING_DISCONNECTION: command center cannot render canonical booking ID").toContainText(bookingId);
    await shot(founder.page, "05-founder-booking-command-center");

    await founder.page.goto("/crm");
    await expect(founder.page.locator("body"), "CRM_LEDGER_DISCONNECTION: CRM does not expose latest canonical booking ID").toContainText(bookingId);
    await shot(founder.page, "06-founder-crm");

    console.log(JSON.stringify({ result: "PASS", bookingId, providerId, partnerEmail: partner.email }));
  } finally {
    await partner?.context.close();
    await founder.context.close();
  }
});
