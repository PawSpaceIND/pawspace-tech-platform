import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Automated multi-persona human-UAT sweep against the deployed STAGING origin (latest build).
 *
 * Drives a real browser as three personas and records, module by module, what the browser saw.
 * Customer self-serves the sandbox OTP (shown on screen); Partner + Founder sign in at /staging-login
 * with PAWSPACE_UAT_ACCESS_CODE (a CI secret — never hard-coded). Address autocomplete is mocked so the
 * Google Places picker resolves deterministically (the picker UI is still exercised); everything else —
 * OTP, mandatory contact fields, booking + provider assignment, the partner job feed, admin + CRM —
 * runs for real. The customer books PAY-AFTER (a real canonical booking, no card); the online path is
 * probed to confirm the Razorpay sandbox modal opens (a real capture needs manual card entry in
 * Razorpay's cross-origin iframe, which is reported, not faked).
 */

const BASE = process.env.PW_BASE_URL || "https://pawspace-staging.karthik-fce.workers.dev";
const ACCESS_CODE = process.env.PAWSPACE_UAT_ACCESS_CODE || "";
const PHONE = process.env.PW_CUSTOMER_PHONE || `9${String(Date.now()).slice(-9)}`;
const ALT_PHONE = "9123456780";
const CUSTOMER_NAME = "UAT Sweep Customer";
const REPORT_PATH = process.env.SWEEP_REPORT || "test-results/human-sweep-report.md";
const GROOMER_EMAIL = "asha.groomer1@tkpetcare.in";
const FOUNDER_EMAIL = "founder@pawspace.in";
// Address with an embedded serviceable PIN; the new picker extracts the PIN from the chosen Google result.
const ADDRESS = "42, Indiranagar Double Road, Stage 2, Hoysala Nagar, Indiranagar, Bengaluru 560038";

const report: string[] = ["# PawSpace staging — automated multi-persona sweep", "", `- Origin: ${BASE}`, `- Run: ${new Date().toISOString()}`, ""];
function log(line: string) { report.push(line); console.log(`[sweep] ${line}`); }
function section(title: string) { report.push("", `## ${title}`, ""); console.log(`\n[sweep] === ${title} ===`); }
async function shot(page: Page, name: string) { try { await page.screenshot({ path: `test-results/sweep-${name}.png`, fullPage: true }); report.push(`  ↳ screenshot: test-results/sweep-${name}.png`); } catch { /* best effort */ } }

let bookingId = "";
let assignedGroomer = "";

test.describe.configure({ mode: "serial" });

test.afterAll(() => {
  try { mkdirSync(dirname(REPORT_PATH), { recursive: true }); writeFileSync(REPORT_PATH, report.join("\n") + "\n"); } catch { /* best effort */ }
});

async function mockAddressAutocomplete(context: BrowserContext) {
  await context.route("**/api/address-autocomplete?*", async route => {
    const mode = new URL(route.request().url()).searchParams.get("mode");
    if (mode === "search") {
      return route.fulfill({ json: { data: { status: "configured", suggestions: [
        { placeId: "uat-sweep-doorstep", mainText: "42, Indiranagar Double Road", secondaryText: "Indiranagar, Bengaluru 560038", fullText: ADDRESS } ] } } });
    }
    return route.fulfill({ json: { data: { status: "configured", address: ADDRESS, latitude: 12.9783692, longitude: 77.6408356 } } });
  });
}

async function customerOtpLogin(page: Page) {
  await page.goto("/mobile-app");
  await page.locator("nav").getByRole("button", { name: /account/i }).last().click();
  await page.getByPlaceholder("10-digit phone number").fill(PHONE);
  await page.getByRole("button", { name: "Send OTP" }).click();
  const sandbox = page.getByText(/Sandbox code \(no real SMS yet\):/i);
  await expect(sandbox, "sandbox OTP must be shown on screen (staging sandbox mode)").toBeVisible({ timeout: 20_000 });
  const code = (await sandbox.textContent())?.match(/\b(\d{6})\b/)?.[1];
  expect(code, "a 6-digit sandbox OTP must render").toMatch(/^\d{6}$/);
  await page.getByPlaceholder("6-digit code").fill(code!);
  const name = page.getByPlaceholder("Your name (first time only)");
  if (await name.isVisible().catch(() => false)) await name.fill(CUSTOMER_NAME);
  const verify = page.waitForResponse(r => r.url().includes("/api/customer-otp") && r.request().method() === "POST" && r.ok());
  await page.getByRole("button", { name: "Verify & continue" }).click();
  await verify;
  await expect.poll(() => page.evaluate(async () => (await fetch("/api/identity-session", { cache: "no-store", credentials: "include" })).status)).toBe(200);
}

async function ensurePet(page: Page) {
  const acct = await (await page.context().request.get("/api/customer-account")).json().catch(() => ({})) as { data?: { customerId?: string; pets?: unknown[] } };
  if (acct.data?.pets?.length) return;
  const res = await page.context().request.post("/api/customer-account", { data: { action: "upsert_pet", idempotencyKey: `uat-sweep:${acct.data?.customerId}`, pet: { name: "Bruno", species: "dog", breed: "Labrador Retriever", vaccinationStatus: "not_provided" } } });
  expect(res.ok(), `pet seed (${res.status()})`).toBeTruthy();
}

// Walk grooming steps 1→4 (new Google Places picker + mandatory contact fields), stopping on the review step.
async function reachReview(page: Page, opts: { line2?: string } = {}) {
  await page.goto("/mobile-app");
  await page.locator("nav").getByRole("button", { name: /home/i }).last().click();
  const grooming = page.getByRole("region", { name: "Care services" }).getByRole("article").filter({ hasText: "Grooming" }).first();
  const loc = page.getByRole("button", { name: "Choose your service location" });
  if (await loc.isVisible().catch(() => false)) {
    await loc.click();
    await page.getByRole("dialog", { name: "Choose your service area" }).getByRole("button", { name: "Browse without location", exact: true }).click();
  }
  await grooming.getByRole("button", { name: /book now/i }).click();
  await page.getByRole("button", { name: /Choose a package/i }).click();
  await page.getByRole("button", { name: "Choose address and requested time", exact: true }).click();

  // New picker: type into Address Line 1, pick a Google suggestion (no pincode field / no "Use this address").
  const line1 = page.locator("#grooming-address-line-1");
  await expect(line1, "Address Line 1 (Google Places) input present").toBeVisible();
  await line1.fill("42, Indiranagar Double Road, Bengaluru");
  const suggestions = page.getByRole("region", { name: "Google address suggestions" });
  await expect(suggestions).toBeVisible({ timeout: 20_000 });
  await suggestions.getByRole("button").first().click();
  await expect(page.getByText("Verified service doorstep", { exact: true })).toBeVisible({ timeout: 20_000 });
  if (opts.line2) await page.locator("#grooming-address-line-2").fill(opts.line2);
  log("✅ Address (Google Places): Line 1 typed → suggestion picked → 'Verified service doorstep'; optional Line 2 accepted.");

  const preferred = page.getByRole("button").filter({ hasText: "PawSpace Grooming Team (UAT)" }).first();
  if (await preferred.isVisible().catch(() => false)) { await preferred.click(); log("✅ Preferred groomer 'PawSpace Grooming Team (UAT)' selected."); }
  else log("ℹ️ Preferred-groomer chip not shown; proceeding with best-eligible assignment.");

  await page.getByRole("button", { name: /^11:00 AM–1:00 PM/ }).click();
  await page.getByRole("button", { name: "Review booking", exact: true }).click();
  await expect(page.getByText("Review and confirm", { exact: true })).toBeVisible();

  // Mandatory contact fields (Customer Name, Customer Phone, Alternative Phone are all required now).
  await page.getByLabel("Customer Name", { exact: true }).fill(CUSTOMER_NAME);
  await page.getByLabel("Customer Phone Number", { exact: true }).fill(PHONE);
  await page.getByLabel("Alternative Phone Number", { exact: true }).fill(ALT_PHONE);
  await page.getByLabel("Special instructions to groomer", { exact: true }).fill("Bruno is nervous with clippers — go slow.");
  log("✅ Review step: mandatory Customer Name / Phone / Alternative Phone + optional instructions filled.");
}

async function staffSignIn(context: BrowserContext, email: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto("/staging-login");
  const codeField = page.getByPlaceholder("shared UAT access code");
  await expect(codeField, "staging-login must be enabled on this environment").toBeVisible({ timeout: 20_000 });
  await codeField.fill(ACCESS_CODE);
  await page.getByPlaceholder(/seeded staff email/i).fill(email);
  const signed = page.waitForResponse(r => r.url().endsWith("/api/staging-login") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const res = await signed;
  expect(res.status(), `staging-login for ${email}`).toBe(200);
  await page.waitForURL("**/me", { timeout: 20_000 });
  return page;
}

test("Customer persona — OTP → grooming booking → real booking ID (+ Razorpay modal probe)", async ({ browser }) => {
  test.setTimeout(180_000);
  section("Customer persona (mobile app)");
  const context = await browser.newContext();
  await mockAddressAutocomplete(context);
  const page = await context.newPage();
  try {
    await customerOtpLogin(page);
    log(`✅ Login: sandbox OTP for ${PHONE} accepted; customer session (identity-session 200).`);
    await ensurePet(page);
    await reachReview(page, { line2: "Near the corner park" });

    await page.getByRole("button", { name: /^Pay after service/ }).click();
    const created = page.waitForResponse(r => r.url().includes("/api/canonical-bookings") && r.request().method() === "POST");
    const confirm = page.getByRole("button", { name: "Confirm booking", exact: true });
    await expect(confirm, "Confirm booking enabled once mandatory fields are valid").toBeEnabled();
    await confirm.click();
    const res = await created;
    expect(res.status(), await res.text()).toBe(201);
    const body = await res.json().catch(() => ({})) as { data?: { bookingId?: string; id?: string } };
    bookingId = String(body.data?.bookingId || body.data?.id || "");
    log(`✅ Provider assigned + canonical booking created (HTTP 201). Booking ID: ${bookingId || "(from confirmation)"}${/^PS-/.test(bookingId) ? " (PS- canonical)" : ""}.`);

    // Pay-after confirms on the server-authoritative BookingPaymentPage. It mounts only after the 201 and its
    // primary button is disabled ("Please wait…") until the checkout controller settles, so wait for the page
    // and for an enabled "Confirm booking" instead of probing once (a one-shot isVisible() raced the mount).
    const paymentPage = page.getByRole("region", { name: "Grooming payment" });
    await expect(paymentPage, "pay-after payment page rendered after the 201").toBeVisible({ timeout: 20_000 });
    await expect(paymentPage.getByText(/Nothing is charged now/), "pay-after notice shown").toBeVisible();
    const payConfirm = paymentPage.getByRole("button", { name: "Confirm booking", exact: true });
    await expect(payConfirm, "pay-after 'Confirm booking' enabled").toBeEnabled({ timeout: 20_000 });
    await payConfirm.click();
    log("✅ Pay-after payment page: 'Nothing is charged now' notice shown; 'Confirm booking' accepted.");
    await expect(page.getByText("Your groomer is reserved.", { exact: true })).toBeVisible({ timeout: 20_000 });
    const confirmed = await page.getByText(/BOOKING CONFIRMED ·/).textContent().catch(() => "");
    if (!bookingId) bookingId = confirmed?.match(/BOOKING CONFIRMED ·\s*(\S+)/)?.[1] || "";
    assignedGroomer = (await page.getByText("YOUR ASSIGNED GROOMER").locator("xpath=following-sibling::b[1]").textContent().catch(() => "")) || "";
    log(`✅ Confirmation: "Your groomer is reserved." Booking ID ${bookingId || "(unresolved)"}${assignedGroomer ? `, assigned groomer: ${assignedGroomer}` : ""}.`);
    if (await page.getByText(/Groomer note ·/).isVisible().catch(() => false)) log("✅ Special-instructions 'Groomer note' surfaced on the confirmation screen.");
    await shot(page, "customer-confirmation");

    // Online-pay probe: does the Razorpay sandbox modal open? (Real capture = manual card entry.)
    section("Customer persona — Razorpay online-pay probe");
    const p2 = await context.newPage();
    try {
      await reachReview(p2);
      await p2.getByRole("button", { name: /^Pay online/ }).click();
      await p2.getByRole("button", { name: "Confirm booking", exact: true }).click();
      // Prepaid auto-starts the Razorpay checkout on the payment page; a "Pay securely" button may also exist.
      const payBtn = p2.getByRole("button", { name: /^Pay securely/ });
      if (await payBtn.isVisible({ timeout: 8_000 }).catch(() => false)) await payBtn.click().catch(() => {});
      const modalOpened = await p2.locator("iframe.razorpay-checkout-frame, iframe[src*='razorpay']").first().isVisible({ timeout: 20_000 }).catch(() => false);
      const secureCopy = await p2.getByText(/Secure Razorpay checkout/i).first().isVisible().catch(() => false);
      log(modalOpened
        ? "✅ 'Pay online' → the Razorpay sandbox checkout opened (iframe mounted). Completing a capture needs manual card entry in Razorpay's cross-origin iframe."
        : `⚠️ Razorpay iframe not visibly detected within timeout (payment page ${secureCopy ? "showed 'Secure Razorpay checkout'" : "did not show the secure-checkout copy"}) — needs a human check.`);
      await shot(p2, "customer-razorpay");
    } catch (e) {
      log(`⚠️ Online-pay probe could not complete: ${e instanceof Error ? e.message : String(e)} (the pay-after booking above already succeeded).`);
    } finally { await p2.close(); }
  } finally { await context.close(); }
});

test("Partner persona — groomer sees the incoming job card in /partner/jobs", async ({ browser }) => {
  test.setTimeout(120_000);
  section("Partner persona (/partner/jobs)");
  expect(ACCESS_CODE, "PAWSPACE_UAT_ACCESS_CODE must be provided (CI secret)").not.toEqual("");
  const context = await browser.newContext();
  try {
    const page = await staffSignIn(context, GROOMER_EMAIL);
    log(`✅ Login: staff sign-in as ${GROOMER_EMAIL} (redirected to /me).`);
    await page.goto("/partner/jobs");
    await expect(page.getByRole("heading", { name: "Your jobs" })).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => page.evaluate(async () => (await fetch("/api/partner-job-feed", { cache: "no-store", credentials: "include" })).status)).toBe(200);
    const feed = await page.evaluate(async () => (await (await fetch("/api/partner-job-feed", { cache: "no-store", credentials: "include" })).json()));
    const counts = feed?.data?.counts ?? {};
    log(`✅ Partner job feed loaded. Counts — needsAction:${counts.needsAction ?? "?"}, today:${counts.today ?? "?"}, upcoming:${counts.upcoming ?? "?"}, completed:${counts.completed ?? "?"}, total:${counts.total ?? "?"}.`);
    if (bookingId) {
      const matched = await page.locator(`[data-testid="partner-workspace-${bookingId}"]`).isVisible().catch(() => false);
      const anyGrooming = await page.getByText(/grooming/i).first().isVisible().catch(() => false);
      log(matched
        ? `✅ Incoming job card for the customer's booking ${bookingId} renders (grooming, "Open assigned workspace →").`
        : `⚠️ Booking ${bookingId} not in this groomer's feed (auto-assignment may not have picked the linked provider). Feed rendered ${anyGrooming ? "with" : "without"} a grooming card.`);
    } else {
      log("ℹ️ No booking ID captured from the customer step; asserting the feed structure only.");
    }
    expect(await page.getByRole("heading", { name: /Needs action|Today|Upcoming/ }).first().isVisible()).toBeTruthy();
    log("✅ Provider dashboard structure (Needs action / Today / Upcoming / Completed) rendered.");
    await shot(page, "partner-jobs");
  } finally { await context.close(); }
});

test("Founder persona — /admin + /crm render, tables load, booking ID visible", async ({ browser }) => {
  test.setTimeout(120_000);
  section("Founder / Admin persona");
  expect(ACCESS_CODE, "PAWSPACE_UAT_ACCESS_CODE must be provided (CI secret)").not.toEqual("");
  const context = await browser.newContext();
  try {
    const page = await staffSignIn(context, FOUNDER_EMAIL);
    log(`✅ Login: staff sign-in as ${FOUNDER_EMAIL} (Founder).`);

    await page.goto("/admin");
    await expect(page.locator("h1, h2").first()).toBeVisible({ timeout: 20_000 });
    const adminHeading = (await page.locator("h1, h2").first().textContent().catch(() => ""))?.trim();
    const adminFont = await page.locator("h1, h2").first().evaluate(el => parseFloat(getComputedStyle(el).fontSize)).catch(() => 0);
    log(`✅ /admin rendered. Lead heading: "${adminHeading}" (font-size ${adminFont}px → typography ${adminFont >= 16 ? "OK" : "SUSPECT"}).`);
    const todaysBookings = await page.getByText(/Today’s bookings|Today's bookings|Booking activity|Command Center/i).first().isVisible().catch(() => false);
    log(`${todaysBookings ? "✅" : "⚠️"} /admin booking panel ${todaysBookings ? "present" : "not detected"}.`);
    await shot(page, "admin");

    await page.goto("/crm");
    await expect(page.locator("h1").first()).toBeVisible({ timeout: 20_000 });
    const crmSearch = await page.getByPlaceholder(/Search customer/i).isVisible().catch(() => false);
    let crmLoaded = false;
    try {
      await expect.poll(async () => {
        const empty = await page.getByText(/No CRM contacts yet/i).isVisible().catch(() => false);
        const head = await page.getByText("Customer", { exact: true }).first().isVisible().catch(() => false);
        return empty || head;
      }, { timeout: 20_000 }).toBe(true);
      crmLoaded = true;
    } catch { crmLoaded = false; }
    log(`${crmSearch ? "✅" : "⚠️"} /crm rendered (search box ${crmSearch ? "present" : "missing"}; customer table/empty-state ${crmLoaded ? "resolved" : "did not resolve"}).`);
    await shot(page, "crm");

    if (bookingId) {
      await page.goto(`/team/operations/bookings?bookingId=${encodeURIComponent(bookingId)}`);
      await page.waitForLoadState("networkidle").catch(() => {});
      const idVisible = await page.getByText(bookingId, { exact: false }).first().isVisible({ timeout: 20_000 }).catch(() => false);
      log(`${idVisible ? "✅" : "⚠️"} Canonical booking ID ${bookingId} ${idVisible ? "is visible in the Booking Command Center" : "was not visible"}.`);
      await shot(page, "founder-command-center");
      expect(idVisible, `booking ${bookingId} should be visible to Founder`).toBeTruthy();
    } else {
      log("ℹ️ No booking ID captured; skipped the booking-ID visibility assertion.");
    }
  } finally { await context.close(); }
});
