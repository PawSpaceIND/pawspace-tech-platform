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
const EXPECTED_SHA = process.env.PW_EXPECTED_SHA || "unverified";
const PHONE = process.env.PW_CUSTOMER_PHONE || `9${String(Date.now()).slice(-9)}`;
const ALT_PHONE = "9123456780";
const CUSTOMER_NAME = "UAT Sweep Customer";
const REPORT_PATH = process.env.SWEEP_REPORT || "test-results/human-sweep-report.md";
const GROOMER_EMAIL = "asha.groomer1@tkpetcare.in";
const FOUNDER_EMAIL = "founder@pawspace.in";
// Address with an embedded serviceable PIN; the picker extracts the PIN from the chosen Google result. MG Road (560001,
// blr-central) is the home base of the city-wide UAT team groomer, so ranked assignment favours the provider that the
// partner persona is linked to; the per-zone groomers seeded for other areas would otherwise win on distance.
const ADDRESS = "12, Church Street, MG Road, Bengaluru 560001";
// The UAT team groomer is linked to GROOMER_EMAIL (provider_identity_links) — prefer it so the partner step is deterministic.
const PREFERRED_GROOMER = "PawSpace Grooming Team (UAT)";
// Requested window: spread across +2…+6 days and the four grooming slots (from the run minute) so repeated sweeps
// do not pile onto one provider-window (capacity 1 per window) and overflow to a different groomer.
const GROOMING_SLOTS = ["9:00–11:00 AM", "11:00 AM–1:00 PM", "1:00–3:00 PM", "3:00–5:00 PM"];
const RUN_MINUTE = Math.floor(Date.now() / 60_000);
const DAY_OFFSET = 2 + (RUN_MINUTE % 5);
const SLOT = GROOMING_SLOTS[Math.floor(RUN_MINUTE / 5) % GROOMING_SLOTS.length];
const SERVICE_DATE = new Date(Date.now() + DAY_OFFSET * 86_400_000);
const ist = (locale: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, { timeZone: "Asia/Kolkata", ...o }).format(SERVICE_DATE);
const SERVICE_DATE_LABEL = `${ist("en-IN", { day: "numeric" })} ${ist("en-IN", { month: "short" })}`; // the flow's "Tue, 15 Sept" buttons
const SERVICE_DATE_ISO = ist("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" });
const rx = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const report: string[] = ["# PawSpace staging — automated multi-persona sweep", "", `- Origin: ${BASE}`, `- Exact deployed SHA: ${EXPECTED_SHA}`, `- Run: ${new Date().toISOString()}`, ""];
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
        { placeId: "uat-sweep-doorstep", mainText: "12, Church Street", secondaryText: "MG Road, Bengaluru 560001", fullText: ADDRESS } ] } } });
    }
    return route.fulfill({ json: { data: { status: "configured", address: ADDRESS, latitude: 12.975, longitude: 77.6063 } } });
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
async function reachReview(page: Page, opts: { line2?: string; preferGroomer?: boolean } = {}) {
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
  await line1.fill("12, Church Street, MG Road, Bengaluru");
  const suggestions = page.getByRole("region", { name: "Google address suggestions" });
  await expect(suggestions).toBeVisible({ timeout: 20_000 });
  await suggestions.getByRole("button").first().click();
  await expect(page.getByText("Verified service doorstep", { exact: true })).toBeVisible({ timeout: 20_000 });
  if (opts.line2) await page.locator("#grooming-address-line-2").fill(opts.line2);
  log("✅ Address (Google Places): Line 1 typed → suggestion picked → 'Verified service doorstep'; optional Line 2 accepted.");

  // Requested window first (the provider preview is keyed on address + date + slot), then the preferred-groomer
  // chip. The preview is a real scheduler evaluation on remote D1 (tens of seconds), so capture its response
  // rather than probing the chip once.
  const wantPreferred = opts.preferGroomer !== false;
  const previewWait = wantPreferred
    ? page.waitForResponse(r => r.url().includes("/api/uat-scheduling") && r.request().method() === "POST" && (r.request().postData() || "").includes("\"preview\""), { timeout: 90_000 }).catch(() => null)
    : Promise.resolve(null);
  await page.getByRole("button", { name: new RegExp(`\\b${rx(SERVICE_DATE_LABEL)}$`) }).first().click();
  await page.getByRole("button", { name: new RegExp(`^${rx(SLOT)}`) }).click();
  log(`✅ Requested window: ${SERVICE_DATE_ISO} (IST, +${DAY_OFFSET} days) · ${SLOT}.`);
  if (wantPreferred) {
    const previewRes = await previewWait;
    const previewBody = previewRes ? await previewRes.json().catch(() => ({})) as { data?: { providers?: Array<{ name?: string }> } } : null;
    const offered = (previewBody?.data?.providers ?? []).map(p => p.name).filter(Boolean);
    log(offered.length
      ? `ℹ️ Scheduler preview shortlist for this window: ${offered.join(" · ")}.`
      : "ℹ️ Scheduler preview did not resolve in time; no shortlist captured.");
    const preferred = page.getByRole("button").filter({ hasText: PREFERRED_GROOMER }).first();
    if (await preferred.waitFor({ state: "visible", timeout: 20_000 }).then(() => true).catch(() => false)) {
      await preferred.click();
      log(`✅ Preferred groomer '${PREFERRED_GROOMER}' selected (the provider linked to ${GROOMER_EMAIL}).`);
    } else log("ℹ️ Preferred-groomer chip not offered for this window; proceeding with best-eligible assignment.");
  }
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

test("Customer V2 persona — sandbox OTP → unified shell, account, activity and AI", async ({ browser }) => {
  test.setTimeout(180_000);
  section("Customer V2 persona");
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await customerOtpLogin(page);
    log(`✅ V2 login prerequisite: sandbox OTP for ${PHONE} accepted; customer session is active.`);

    await page.goto("/v2");
    await expect(page.getByRole("heading", { name: /Everything your pet needs/ })).toBeVisible({ timeout: 20_000 });
    for (const route of ["grooming", "boarding", "training", "sitting", "walking", "food", "relocation", "taxi"]) {
      await expect(page.locator(`a[href="/v2/${route}"]`), `V2 service link /v2/${route}`).toHaveCount(1);
    }
    await expect(page.locator('a[href="/v2/chat"]:visible').first()).toBeVisible();
    await expect(page.locator('a[href="/v2/activity"]:visible').first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "V2 home should not overflow horizontally").toBe(true);
    log("✅ /v2 rendered with all 8 service links plus V2 AI and Activity; no horizontal overflow.");
    await shot(page, "v2-home");

    await page.goto("/v2/activity");
    await expect(page.getByRole("heading", { name: /Every booking, one clear timeline/ })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("heading", { name: "Upcoming & active", exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("heading", { name: /Sign in to see your care history/ })).toHaveCount(0);
    log("✅ /v2/activity reused the authenticated customer session.");
    await shot(page, "v2-activity");

    await page.goto("/v2/account");
    await expect(page.getByRole("heading", { name: /Family details without leaving V2/ })).toBeVisible({ timeout: 20_000 });
    const accountResponse = await context.request.get("/api/customer-account");
    expect(accountResponse.status(), "same-session canonical account must load").toBe(200);
    const accountBody = await accountResponse.json() as { data?: { customerId?: string; name?: string; primaryPhone?: string } };
    expect(accountBody.data?.customerId, "canonical customer identity is present").toBeTruthy();
    expect(accountBody.data?.name, "canonical customer name is present").toBeTruthy();
    expect(accountBody.data?.primaryPhone, "canonical verified phone is present").toBeTruthy();
    // Profile values are input values, not text nodes. Compare the rendered form to the real API.
    await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue(accountBody.data!.name!, { timeout: 20_000 });
    await expect(page.getByRole("textbox", { name: "Verified mobile", exact: true })).toHaveValue(accountBody.data!.primaryPhone!);
    await expect(page.getByRole("button", { name: "Save profile", exact: true })).toBeEnabled();
    log("✅ /v2/account loaded canonical signed-in customer details.");
    await shot(page, "v2-account");

    await page.goto("/v2/chat");
    await expect(page.getByRole("heading", { name: /One conversation for your pet/ })).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "My PawSpace" }).click();
    await expect(page.getByRole("button", { name: "My PawSpace" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByLabel("Your message")).toBeEnabled();
    await page.getByLabel("Your message").fill("What PawSpace services are available?");
    // A text area alone is not proof of authentication; Send stays disabled until identity resolves.
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled({ timeout: 20_000 });
    log("✅ /v2/chat authenticated mode is available from the same customer session.");
    await shot(page, "v2-chat-authenticated");
  } finally { await context.close(); }
});

test("Customer persona — OTP → grooming booking → real booking ID (+ Razorpay modal probe)", async ({ browser }) => {
  test.setTimeout(480_000); // two real scheduler reservations on remote D1 (~40 s each) plus the preview
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
    // A reservation is a real scheduler evaluation on remote D1 (40 s+ once the roster carries several groomers
    // per zone), so this wait gets its own budget instead of the 45 s action timeout.
    const created = page.waitForResponse(r => r.url().includes("/api/canonical-bookings") && r.request().method() === "POST", { timeout: 150_000 });
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
      await reachReview(p2, { preferGroomer: false });
      await p2.getByRole("button", { name: /^Pay online/ }).click();
      const createdOnline = p2.waitForResponse(r => r.url().includes("/api/canonical-bookings") && r.request().method() === "POST", { timeout: 150_000 });
      await p2.getByRole("button", { name: "Confirm booking", exact: true }).click();
      const onlineRes = await createdOnline;
      const onlineBody = await onlineRes.json().catch(() => ({})) as { data?: { bookingId?: string } };
      log(`${onlineRes.status() === 201 ? "✅" : "⚠️"} 'Pay online' booking request → HTTP ${onlineRes.status()}${onlineBody.data?.bookingId ? ` (${onlineBody.data.bookingId}, payment pending until captured)` : ""}.`);
      // Prepaid auto-starts the Razorpay checkout on the payment page; a "Pay securely" button may also exist.
      const payPage = p2.getByRole("region", { name: "Grooming payment" });
      await expect(payPage, "prepaid payment page rendered").toBeVisible({ timeout: 20_000 });
      const secureCopy = await payPage.getByText(/Secure Razorpay checkout/i).first().isVisible().catch(() => false);
      const payBtn = payPage.getByRole("button", { name: /^Pay securely/ });
      if (await payBtn.waitFor({ state: "visible", timeout: 8_000 }).then(() => true).catch(() => false)) await payBtn.click().catch(() => {});
      const modalOpened = await p2.locator("iframe.razorpay-checkout-frame, iframe[src*='razorpay']").first().waitFor({ state: "visible", timeout: 20_000 }).then(() => true).catch(() => false);
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
      type FeedJob = { bookingId?: string; serviceCode?: string; packageName?: string; status?: string; scheduledStart?: string; customerFirstName?: string };
      const sections = (["needsAction", "today", "upcoming"] as const).map(k => [k, ((feed?.data?.[k] ?? []) as FeedJob[])] as const);
      const hit = sections.flatMap(([section, jobs]) => jobs.filter(j => j.bookingId === bookingId).map(job => ({ section, job })))[0];
      if (hit) {
        log(`✅ Booking ${bookingId} is in ${GROOMER_EMAIL}'s job feed (${hit.section}: ${hit.job.serviceCode} · ${hit.job.packageName} · status ${hit.job.status} · ${hit.job.scheduledStart}).`);
        // The card prints "<service> · <package> for <first name>" and the window — never the raw id — so match on those.
        const firstName = hit.job.customerFirstName || CUSTOMER_NAME.split(" ")[0];
        const cards = page.getByText(new RegExp(`^for ${rx(firstName)}$`));
        const cardVisible = await cards.first().waitFor({ state: "visible", timeout: 20_000 }).then(() => true).catch(() => false);
        if (cardVisible) await cards.first().scrollIntoViewIfNeeded().catch(() => {});
        const cardCount = cardVisible ? await cards.count().catch(() => 1) : 0;
        const workspaceLink = await page.locator(`[data-testid="partner-workspace-${bookingId}"]`).isVisible().catch(() => false);
        log(cardVisible
          ? `✅ Job card rendered on /partner/jobs under "${hit.section}" (${hit.job.serviceCode} · ${hit.job.packageName} for ${firstName}; ${cardCount} card${cardCount === 1 ? "" : "s"} for this sweep customer)${workspaceLink ? " with the 'Open assigned workspace →' link" : "; the workspace link appears once the job is actionable"}.`
          : "⚠️ Job is in the feed API but its card was not located in the DOM within 20 s — check the screenshot.");
      } else {
        const anyGrooming = await page.getByText(/grooming/i).first().isVisible().catch(() => false);
        log(`⚠️ Booking ${bookingId} not in this groomer's feed — it was assigned to ${assignedGroomer || "an unlinked provider"}, not the provider linked to ${GROOMER_EMAIL}. Feed rendered ${anyGrooming ? "with" : "without"} a grooming card.`);
      }
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
      // The Command Center keeps an SSE stream open, so "networkidle" never fires; wait for its heading and for
      // its list API (one payload: the 150 latest bookings by schedule), then narrow with the page's search box.
      const listRes = page.waitForResponse(r => r.url().includes("/api/booking-command-center") && !r.url().includes("stream") && r.request().method() === "GET", { timeout: 90_000 }).catch(() => null);
      await page.goto("/team/operations/bookings");
      await expect(page.getByRole("heading", { name: "Booking Command Center" })).toBeVisible({ timeout: 30_000 });
      const list = await listRes;
      const listBody = list ? await list.json().catch(() => ({})) as { bookings?: Array<{ id?: string }>; error?: string } : null;
      const listed = listBody?.bookings ?? [];
      const inList = listed.some(b => String(b.id) === bookingId);
      log(list
        ? `${list.ok() ? "ℹ️" : "⚠️"} Command Center list API → HTTP ${list.status()}${list.ok() ? `, ${listed.length} bookings loaded (150 latest by schedule); ${inList ? "includes" : "does not include"} ${bookingId}` : ` (${listBody?.error || "error"})`}.`
        : "⚠️ Command Center list API did not answer within 90 s.");
      const search = page.getByPlaceholder(/Search booking, customer, pet, phone or provider/i);
      if (await search.waitFor({ state: "visible", timeout: 10_000 }).then(() => true).catch(() => false)) await search.fill(bookingId);
      const idVisible = await page.getByText(bookingId, { exact: false }).first().waitFor({ state: "visible", timeout: 30_000 }).then(() => true).catch(() => false);
      log(`${idVisible ? "✅" : "⚠️"} Canonical booking ID ${bookingId} ${idVisible ? "is visible in the Booking Command Center" : "was not visible in the Booking Command Center"}.`);
      await shot(page, "founder-command-center");

      // Second founder surface: the ops scheduling board for the service date prints "Booking <id>" under the
      // assigned provider's column, and its API is the same data the board renders.
      let boardVisible = false, boardApiHas = false;
      if (!idVisible) {
        const boardRes = await page.request.get(`/api/uat-scheduling?date=${SERVICE_DATE_ISO}`);
        const raw = await boardRes.json().catch(() => ({})) as { data?: unknown; providers?: unknown };
        const board = (raw.data ?? raw) as { providers?: Array<{ providerName?: string; reservations?: Array<{ bookingId?: string | null }> }> };
        const column = (board.providers ?? []).find(p => (p.reservations ?? []).some(r => r.bookingId === bookingId));
        boardApiHas = Boolean(column);
        log(`${boardApiHas ? "✅" : "⚠️"} Scheduling board API for ${SERVICE_DATE_ISO} → HTTP ${boardRes.status()}${boardApiHas ? `; booking ${bookingId} sits in ${column?.providerName || "its provider"}'s column` : `; booking ${bookingId} not found in any provider column`}.`);
        await page.goto(`/team/scheduling?date=${SERVICE_DATE_ISO}`);
        const dateInput = page.locator('input[type="date"]').first();
        if (await dateInput.isVisible().catch(() => false) && (await dateInput.inputValue().catch(() => "")) !== SERVICE_DATE_ISO) await dateInput.fill(SERVICE_DATE_ISO);
        boardVisible = await page.getByText(`Booking ${bookingId}`, { exact: false }).first().waitFor({ state: "visible", timeout: 45_000 }).then(() => true).catch(() => false);
        log(`${boardVisible ? "✅" : "⚠️"} Founder scheduling board (${SERVICE_DATE_ISO}) ${boardVisible ? `shows "Booking ${bookingId}"` : `did not render "Booking ${bookingId}" within 45 s`}.`);
        await shot(page, "founder-scheduling-board");
      }
      expect(idVisible || boardVisible || boardApiHas, `booking ${bookingId} should be visible to Founder (Command Center or scheduling board)`).toBeTruthy();
    } else {
      log("ℹ️ No booking ID captured; skipped the booking-ID visibility assertion.");
    }
  } finally { await context.close(); }
});

test("Employee AI V2 — unauthorized customer blocked; authorized staff chat persists once", async ({ browser }) => {
  test.setTimeout(180_000);
  section("Employee AI V2 — mobile chat authorization and persistence");
  expect(ACCESS_CODE, "PAWSPACE_UAT_ACCESS_CODE must be provided (CI secret)").not.toEqual("");

  const customerContext = await browser.newContext();
  try {
    const customerPage = await customerContext.newPage();
    await customerOtpLogin(customerPage);
    const denied = await customerContext.request.get("/api/mobile-employee-ai");
    expect(denied.status(), "customer identities must not receive employee AI access").toBe(403);
    await customerPage.goto("/mobile-app");
    await expect(customerPage.getByRole("button", { name: /^AI$/ })).toHaveCount(0);
    log("✅ Customer identity received HTTP 403 and no Employee AI navigation item.");
    await shot(customerPage, "employee-ai-customer-denied");
  } finally { await customerContext.close(); }

  const staffContext = await browser.newContext();
  try {
    const page = await staffSignIn(staffContext, FOUNDER_EMAIL);
    const bootstrap = await staffContext.request.get("/api/mobile-employee-ai");
    expect(bootstrap.status(), await bootstrap.text()).toBe(200);
    const bootstrapBody = await bootstrap.json() as { data?: { capabilities?: { chat?: boolean; voice?: boolean }; customers?: Array<{ id?: string }> } };
    expect(bootstrapBody.data?.capabilities?.chat).toBe(true);
    const customerId = String(bootstrapBody.data?.customers?.[0]?.id || "");
    expect(customerId, "Employee AI requires at least one governed customer context").not.toEqual("");

    await page.goto("/mobile-app");
    const aiNav = page.getByRole("button", { name: /^AI$/ });
    await expect(aiNav, "authorized staff should receive the Employee AI navigation item").toBeVisible({ timeout: 20_000 });
    await aiNav.click();
    await expect(page.getByRole("region", { name: "Employee AI mobile workspace" })).toBeVisible();
    await expect(page.getByLabel("Employee AI message")).toBeEnabled();

    const idempotencyKey = `uat-employee-ai:${EXPECTED_SHA}:${Date.now()}`;
    const payload = { action: "chat", customerId, message: "Summarise this customer's current PawSpace context and recommend the next customer-safe step.", idempotencyKey };
    const first = await staffContext.request.post("/api/mobile-employee-ai", { data: payload });
    expect(first.status(), await first.text()).toBe(200);
    const firstBody = await first.json() as { data?: { duplicatePrevented?: boolean; messageId?: string; threadId?: string; autonomousExecution?: boolean; ai?: { turn?: { output?: string } } } };
    expect(firstBody.data?.duplicatePrevented).toBe(false);
    expect(firstBody.data?.messageId).toBeTruthy();
    expect(firstBody.data?.threadId).toBeTruthy();
    expect(firstBody.data?.autonomousExecution).toBe(false);
    expect(firstBody.data?.ai?.turn?.output, "real governed AI turn should return displayable output").toBeTruthy();

    const replay = await staffContext.request.post("/api/mobile-employee-ai", { data: payload });
    expect(replay.status(), await replay.text()).toBe(200);
    const replayBody = await replay.json() as { data?: { duplicatePrevented?: boolean; messageId?: string; threadId?: string; autonomousExecution?: boolean } };
    expect(replayBody.data?.duplicatePrevented).toBe(true);
    expect(replayBody.data?.messageId).toBe(firstBody.data?.messageId);
    expect(replayBody.data?.threadId).toBe(firstBody.data?.threadId);
    expect(replayBody.data?.autonomousExecution).toBe(false);

    const snapshot = await staffContext.request.get(`/api/ai-conversation?threadId=${encodeURIComponent(firstBody.data!.threadId!)}&customerId=${encodeURIComponent(customerId)}`);
    expect(snapshot.status(), await snapshot.text()).toBe(200);
    log(`✅ Authorized Employee AI returned a governed real chat turn for customer ${customerId}; canonical thread ${firstBody.data?.threadId} persisted and an identical replay was deduplicated with autonomousExecution=false.`);
    log(`${bootstrapBody.data?.capabilities?.voice ? "✅" : "⚠️"} Employee AI voice capability is ${bootstrapBody.data?.capabilities?.voice ? "authorized for this staff identity" : "not authorized for this staff identity"}.`);
    await shot(page, "employee-ai-authorized");
  } finally { await staffContext.close(); }
});
