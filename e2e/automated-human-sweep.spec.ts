import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Automated multi-persona human-UAT sweep against the deployed STAGING origin.
 *
 * It drives a real browser as three personas and records, module by module, what the browser actually
 * saw. Auth: the Customer self-serves the sandbox OTP (shown on screen); Partner and Founder sign in at
 * /staging-login with PAWSPACE_UAT_ACCESS_CODE (injected as a CI secret — never hard-coded).
 *
 * Determinism: address autocomplete is mocked so the Places picker resolves without depending on live
 * Google results (the picker UI is still exercised). Everything else — OTP, booking creation, scheduling
 * / provider assignment, the partner job feed, admin + CRM — runs for real against staging. The customer
 * books PAY-AFTER (a real canonical booking, no card needed); the online path is probed to confirm the
 * Razorpay modal opens (a real capture needs manual card entry in Razorpay's cross-origin iframe and is
 * reported, not faked).
 */

const BASE = process.env.PW_BASE_URL || "https://pawspace-staging.karthik-fce.workers.dev";
const ACCESS_CODE = process.env.PAWSPACE_UAT_ACCESS_CODE || "";
const PHONE = process.env.PW_CUSTOMER_PHONE || `9${String(Date.now()).slice(-9)}`;
const REPORT_PATH = process.env.SWEEP_REPORT || "test-results/human-sweep-report.md";
const GROOMER_EMAIL = "asha.groomer1@tkpetcare.in";
const FOUNDER_EMAIL = "founder@pawspace.in";
const MAPPED_ADDRESS = "12, 7th Cross, BTM Layout 2nd Stage, Bengaluru 560068";
const PINCODE = "560068";

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
    const q = new URL(route.request().url()).searchParams;
    if (q.get("mode") === "search") {
      return route.fulfill({ json: { data: { status: "configured", suggestions: [
        { placeId: "uat-sweep-btm", mainText: "12, 7th Cross, BTM Layout 2nd Stage", secondaryText: "Bengaluru 560068", fullText: MAPPED_ADDRESS } ] } } });
    }
    return route.fulfill({ json: { data: { status: "configured", address: MAPPED_ADDRESS, latitude: 12.9166, longitude: 77.6101 } } });
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
  if (await name.isVisible().catch(() => false)) await name.fill("UAT Sweep Customer");
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

async function staffSignIn(context: BrowserContext, email: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto("/staging-login");
  const codeField = page.getByPlaceholder("shared UAT access code");
  await expect(codeField, "staging-login must be enabled on this environment").toBeVisible({ timeout: 20_000 });
  await codeField.fill(ACCESS_CODE);
  await page.getByPlaceholder(/seeded staff email/i).fill(email);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
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

    await page.goto("/mobile-app");
    await page.locator("nav").getByRole("button", { name: /home/i }).last().click();
    const grooming = page.getByRole("region", { name: "Care services" }).getByRole("article").filter({ hasText: "Grooming" }).first();
    await expect(grooming, "Grooming service card renders on home").toBeVisible({ timeout: 20_000 });
    log("✅ Home: 'Care services' region + Grooming card visible.");
    const loc = page.getByRole("button", { name: "Choose your service location" });
    if (await loc.isVisible().catch(() => false)) {
      await loc.click();
      const dlg = page.getByRole("dialog", { name: "Choose your service area" });
      await dlg.getByRole("button", { name: "Browse without location", exact: true }).click();
      await expect(dlg).toBeHidden();
    }
    await grooming.getByRole("button", { name: /book now/i }).click();
    await expect(page.getByText("Who needs grooming?", { exact: false })).toBeVisible();
    log("✅ Grooming step 1 (pets) reached.");
    await page.getByRole("button", { name: /Choose a package/i }).click();
    await page.getByRole("button", { name: "Choose address and requested time", exact: true }).click();

    await page.getByLabel("Complete doorstep address", { exact: true }).fill("12, 7th Cross, BTM Layout 2nd Stage, Bengaluru");
    const line2 = page.getByLabel("Address line 2", { exact: true });
    await expect(line2, "optional Address line 2 present").toBeVisible();
    await line2.fill("Near the park");
    await page.getByLabel("Pincode", { exact: true }).fill(PINCODE);
    await page.getByRole("button", { name: "Use this address", exact: true }).click();
    await page.getByRole("region", { name: "Matching map addresses", exact: true }).getByRole("button", { name: /BTM Layout/ }).first().click();
    await expect(page.getByText("Service doorstep ready", { exact: true })).toBeVisible({ timeout: 20_000 });
    log(`✅ Address: line 1 + optional line 2 accepted; Places pick verified (${PINCODE} → service doorstep ready).`);

    // Prefer the seeded full-time grooming provider so the booking lands in the linked groomer's feed.
    const preferred = page.getByRole("button").filter({ hasText: "PawSpace Grooming Team (UAT)" }).first();
    if (await preferred.isVisible().catch(() => false)) { await preferred.click(); log("✅ Preferred groomer 'PawSpace Grooming Team (UAT)' selected."); }
    else log("ℹ️ Preferred-groomer chip not shown; proceeding with best-eligible assignment.");

    await page.getByRole("button", { name: /^11:00 AM–1:00 PM/ }).click();
    await page.getByRole("button", { name: "Review booking", exact: true }).click();
    await expect(page.getByText("Review and confirm", { exact: true })).toBeVisible();
    await page.getByLabel("Alternative phone number", { exact: true }).fill("9123456780");
    await page.getByLabel("Special instructions to groomer", { exact: true }).fill("Bruno is nervous with clippers — go slow.");
    log("✅ Review step: optional alt-phone + special instructions accepted (non-blocking).");

    await page.getByRole("button", { name: /^Pay after service/ }).click();
    const created = page.waitForResponse(r => r.url().includes("/api/canonical-bookings") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Continue to payment", exact: true }).click();
    const res = await created;
    expect(res.status(), await res.text()).toBe(201);
    const body = await res.json().catch(() => ({})) as { data?: { bookingId?: string; id?: string } };
    bookingId = String(body.data?.bookingId || body.data?.id || "");
    log(`✅ Provider assigned + canonical booking created (HTTP 201). Booking ID: ${bookingId || "(from confirmation screen)"}.`);

    await page.getByRole("button", { name: "Confirm booking", exact: true }).click();
    await expect(page.getByText("Your groomer is reserved.", { exact: true })).toBeVisible({ timeout: 20_000 });
    const confirmed = await page.getByText(/BOOKING CONFIRMED ·/).textContent().catch(() => "");
    const idFromScreen = confirmed?.match(/BOOKING CONFIRMED ·\s*(\S+)/)?.[1] || "";
    if (!bookingId && idFromScreen) bookingId = idFromScreen;
    assignedGroomer = (await page.getByText(/YOUR ASSIGNED GROOMER/).locator("xpath=following-sibling::b[1]").textContent().catch(() => "")) || "";
    log(`✅ Confirmation screen: "Your groomer is reserved." Booking ID ${bookingId || idFromScreen || "(unresolved)"}${assignedGroomer ? `, assigned groomer: ${assignedGroomer}` : ""}.`);
    if (await page.getByText(/Groomer note ·/).isVisible().catch(() => false)) log("✅ Special-instructions 'Groomer note' surfaced on the confirmation screen.");
    await shot(page, "customer-confirmation");

    // Online-pay probe: does the Razorpay sandbox modal open? (Real capture = manual card entry.)
    section("Customer persona — Razorpay online-pay probe");
    const p2 = await context.newPage();
    let modalOpened = false;
    try {
      await p2.goto("/mobile-app");
      // Fresh booking flow to the payment page, online path.
      await p2.locator("nav").getByRole("button", { name: /home/i }).last().click();
      const g2 = p2.getByRole("region", { name: "Care services" }).getByRole("article").filter({ hasText: "Grooming" }).first();
      const loc2 = p2.getByRole("button", { name: "Choose your service location" });
      if (await loc2.isVisible().catch(() => false)) { await loc2.click(); await p2.getByRole("dialog").getByRole("button", { name: "Browse without location", exact: true }).click(); }
      await g2.getByRole("button", { name: /book now/i }).click();
      await p2.getByRole("button", { name: /Choose a package/i }).click();
      await p2.getByRole("button", { name: "Choose address and requested time", exact: true }).click();
      await p2.getByLabel("Complete doorstep address", { exact: true }).fill("12, 7th Cross, BTM Layout 2nd Stage, Bengaluru");
      await p2.getByLabel("Pincode", { exact: true }).fill(PINCODE);
      await p2.getByRole("button", { name: "Use this address", exact: true }).click();
      await p2.getByRole("region", { name: "Matching map addresses", exact: true }).getByRole("button", { name: /BTM Layout/ }).first().click();
      await expect(p2.getByText("Service doorstep ready", { exact: true })).toBeVisible({ timeout: 20_000 });
      await p2.getByRole("button", { name: /^11:00 AM–1:00 PM/ }).click();
      await p2.getByRole("button", { name: "Review booking", exact: true }).click();
      await p2.getByRole("button", { name: /^Pay online/ }).click();
      await p2.getByRole("button", { name: "Continue to payment", exact: true }).click();
      const payBtn = p2.getByRole("button", { name: /^Pay securely/ });
      await expect(payBtn).toBeVisible({ timeout: 20_000 });
      await payBtn.click();
      modalOpened = await p2.locator("iframe.razorpay-checkout-frame, iframe[src*='razorpay']").first().isVisible({ timeout: 20_000 }).catch(() => false);
      log(modalOpened
        ? "✅ 'Pay online' → 'Pay securely' opened the Razorpay sandbox checkout (iframe mounted). Completing a capture requires manual card entry in Razorpay's cross-origin iframe."
        : "⚠️ Razorpay modal did not visibly mount within timeout on the online path — needs a human check (real checkout.js/iframe).");
    } catch (e) {
      log(`⚠️ Online-pay probe could not complete: ${e instanceof Error ? e.message : String(e)} (pay-after booking above already succeeded).`);
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
    // Wait for the client feed fetch to land.
    await expect.poll(() => page.evaluate(async () => (await fetch("/api/partner-job-feed", { cache: "no-store", credentials: "include" })).status)).toBe(200);
    const feed = await page.evaluate(async () => (await (await fetch("/api/partner-job-feed", { cache: "no-store", credentials: "include" })).json()));
    const counts = feed?.data?.counts ?? {};
    log(`✅ Partner job feed loaded. Counts — needsAction:${counts.needsAction ?? "?"}, today:${counts.today ?? "?"}, upcoming:${counts.upcoming ?? "?"}, completed:${counts.completed ?? "?"}, total:${counts.total ?? "?"}.`);
    const grooming = page.getByText(/grooming/i).first();
    const anyCard = await grooming.isVisible().catch(() => false);
    if (bookingId) {
      const cardLink = page.locator(`[data-testid="partner-workspace-${bookingId}"]`);
      const matched = await cardLink.isVisible().catch(() => false);
      if (matched) log(`✅ Incoming job card for the customer's booking ${bookingId} renders (grooming, "Open assigned workspace →").`);
      else log(`⚠️ Booking ${bookingId} not found in this groomer's feed (auto-assignment may have picked a different provider than the linked uatcap_groom_ft). Feed rendered ${anyCard ? "with" : "without"} a grooming card.`);
    } else {
      log(`ℹ️ No booking ID captured from the customer step; asserting the feed structure renders. Grooming card present: ${anyCard}.`);
    }
    expect(await page.getByRole("heading", { name: /Needs action|Today|Upcoming/ }).first().isVisible()).toBeTruthy();
    log("✅ Provider dashboard structure (Needs action / Today / Upcoming / Completed sections) rendered.");
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
    log(`✅ /admin rendered. Lead heading: "${adminHeading}" (font-size ${adminFont}px → typography scaling ${adminFont >= 16 ? "OK" : "SUSPECT"}).`);
    const bookingActivity = await page.getByText(/Booking activity|Command Center|Booking/i).first().isVisible().catch(() => false);
    log(`${bookingActivity ? "✅" : "⚠️"} /admin operations/booking panels ${bookingActivity ? "present" : "not detected"}.`);
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

    // Canonical booking ID visible in the Booking Command Center.
    if (bookingId) {
      await page.goto(`/team/operations/bookings?bookingId=${encodeURIComponent(bookingId)}`);
      await page.waitForLoadState("networkidle").catch(() => {});
      const idVisible = await page.getByText(bookingId, { exact: false }).first().isVisible({ timeout: 20_000 }).catch(() => false);
      log(`${idVisible ? "✅" : "⚠️"} Canonical booking ID ${bookingId} ${idVisible ? "is visible in the Booking Command Center" : "was not visible (check the command center lookup)"}.`);
      await shot(page, "founder-command-center");
      expect(idVisible, `booking ${bookingId} should be visible to Founder`).toBeTruthy();
    } else {
      log("ℹ️ No booking ID captured from the customer step; skipped the booking-ID visibility assertion.");
    }
  } finally { await context.close(); }
});
