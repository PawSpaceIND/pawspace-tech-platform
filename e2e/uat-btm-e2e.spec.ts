import { test, expect, type BrowserContext, type Page, type FrameLocator } from "@playwright/test";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * End-to-end proof against the DEPLOYED staging origin for the resolved BTM Layout booking flow.
 *
 *   1. Customer (sandbox OTP) books grooming at BTM Layout & Bommanahalli (560068) on the requested
 *      date, pays online: the reserve call must assign a provider (no NO_SCHEDULE_AVAILABLE), the
 *      canonical booking must be created, and the Razorpay sandbox checkout is driven with the test
 *      card. Whether the capture completes is REPORTED from the server's own status, never assumed.
 *   2. If the online capture could not be completed by automation, a pay-after booking is created so
 *      the partner lifecycle can still be proved on a confirmed job.
 *   3. Partner (OTP as the ASSIGNED UAT groomer's seeded number) accepts, starts the journey, reports
 *      GPS at the booking's own doorstep coordinates, marks arrived, starts service and uploads the
 *      before/after photos through the server-verified upload route.
 *   4. Founder approves both photos in Control -> Customer booking lifecycle (maker/checker).
 *   5. Partner adds service proof and completes the job.
 *
 * Address autocomplete is mocked so the Google Places picker resolves deterministically to a BTM
 * doorstep (the picker UI is still exercised); everything else runs for real against staging.
 */

const BASE = process.env.PW_BASE_URL || "https://pawspace-staging.karthik-fce.workers.dev";
const ACCESS_CODE = process.env.PAWSPACE_UAT_ACCESS_CODE || "";
/**
 * Requested service date (IST). Default: the day after tomorrow. Every booking this proof makes holds a
 * groomer for its window plus the travel-buffer neighbours, so running it repeatedly on the date manual
 * testers are using starves them (2026-09-14 at BTM was exhausted this way); pass PW_SERVICE_DATE to
 * prove a specific date.
 */
const SERVICE_DATE = process.env.PW_SERVICE_DATE || (() => {
  const ist = new Date(Date.now() + 5.5 * 3_600_000 + 2 * 86_400_000);
  return ist.toISOString().slice(0, 10);
})();
const PHONE = process.env.PW_CUSTOMER_PHONE || `9${String(Date.now()).slice(-9)}`;
// The partner app shows only the customer's FIRST name on job cards (partnerFirstName in
// app/api/partner-grooming-jobs), so the first name must be distinctive on its own.
const CUSTOMER_NAME = "Uatbtm Customer";
const CUSTOMER_FIRST = CUSTOMER_NAME.split(" ")[0];
const REPORT_PATH = process.env.E2E_REPORT || "test-results/uat-btm-report.md";
const FOUNDER_EMAILS = ["founder@pawspace.in", "sunita.manager37@tkpetcare.in"];
const PINCODE = "560068";
const ADDRESS = "12, 16th Main Road, BTM Layout 2nd Stage, Bengaluru 560068";
const DOORSTEP = { latitude: 12.9166, longitude: 77.6101 };
/** Seeded UAT groomer numbers (scripts/uat-staging-provider-capacity.sql canonical_providers). */
const PROVIDER_PHONES: Record<string, string> = {
  uatcap_groom_ft: "9000000901", uatcap_groom_cm: "9000000902", uatcap_groom_east: "9000000903",
  uatcap_groom_south: "9000000904", uatcap_groom_north: "9000000905", uatcap_groom_west: "9000000906", uatcap_groom_central: "9000000907",
  uatcap_groom_east_2: "9000000911", uatcap_groom_east_3: "9000000912", uatcap_groom_south_2: "9000000913", uatcap_groom_south_3: "9000000914",
  uatcap_groom_north_2: "9000000915", uatcap_groom_north_3: "9000000916", uatcap_groom_west_2: "9000000917", uatcap_groom_west_3: "9000000918",
  uatcap_groom_central_2: "9000000919", uatcap_groom_central_3: "9000000920",
  uatcap_groom_east_4: "9000000921", uatcap_groom_east_5: "9000000922", uatcap_groom_south_4: "9000000923", uatcap_groom_south_5: "9000000924",
  uatcap_groom_north_4: "9000000925", uatcap_groom_north_5: "9000000926", uatcap_groom_west_4: "9000000927", uatcap_groom_west_5: "9000000928",
  uatcap_groom_central_4: "9000000929", uatcap_groom_central_5: "9000000930",
  uatcap_groom_east_6: "9000000951", uatcap_groom_east_7: "9000000952", uatcap_groom_east_8: "9000000953", uatcap_groom_south_6: "9000000954",
  uatcap_groom_south_7: "9000000955", uatcap_groom_south_8: "9000000956", uatcap_groom_north_6: "9000000957", uatcap_groom_north_7: "9000000958",
  uatcap_groom_north_8: "9000000959", uatcap_groom_west_6: "9000000960", uatcap_groom_west_7: "9000000961", uatcap_groom_west_8: "9000000962",
  uatcap_groom_central_6: "9000000963", uatcap_groom_central_7: "9000000964", uatcap_groom_central_8: "9000000965",
};
/**
 * Slot order for the proof: the LATE windows first. Every booking the proof makes holds one groomer for that
 * window plus the 30-minute travel buffer either side, so booking 11:00 also blocks 09:00 and 13:00 for that
 * groomer. Taking 15:00 (then 09:00) leaves the midday windows, the ones a manual tester picks first, free.
 */
const SLOTS_ONLINE = [/^3:00–5:00 PM/, /^9:00–11:00 AM/, /^1:00–3:00 PM/, /^11:00 AM–1:00 PM/];
const SLOTS_PAY_AFTER = [/^3:00–5:00 PM/, /^9:00–11:00 AM/, /^11:00 AM–1:00 PM/, /^1:00–3:00 PM/];
const CUSTOMER_EMAIL = "uat.btm.customer@example.com";

const report: string[] = ["# PawSpace staging — BTM Layout (560068) end-to-end proof", "", `- Origin: ${BASE}`, `- Requested date: ${SERVICE_DATE}`, `- Run: ${new Date().toISOString()}`, ""];
function log(line: string) { report.push(line); console.log(`[e2e] ${line}`); }
function section(title: string) { report.push("", `## ${title}`, ""); console.log(`\n[e2e] === ${title} ===`); }
async function shot(page: Page, name: string) { try { await page.screenshot({ path: `test-results/btm-${name}.png`, fullPage: true }); report.push(`  ↳ screenshot: test-results/btm-${name}.png`); } catch { /* best effort */ } }
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 300);

// Shared across the serial tests.
let bookingId = "";
let bookingMode: "online" | "pay_after" | "" = "";
let paymentCaptured = false;
let assignedProviderId = "";
let assignedProviderName = "";
let providerPhone = "";
const uploadedPurposes: string[] = [];

test.describe.configure({ mode: "serial" });
test.afterAll(() => { try { mkdirSync(dirname(REPORT_PATH), { recursive: true }); writeFileSync(REPORT_PATH, report.join("\n") + "\n"); } catch { /* best effort */ } });

function serviceDateLabel() {
  // The date chips read "<weekday>, <d> <Mon>" (or "Today, <d> <Mon>") in IST; match on the day + month part.
  const [y, m, d] = SERVICE_DATE.split("-").map(Number);
  const value = new Date(Date.UTC(y, m - 1, d, 12));
  const date = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" }).format(value);
  return new RegExp(date.replace(".", "\\.").replace(/\s+/g, "\\s+"));
}

/** A tiny but real JPEG (1x1, baseline) with a per-call suffix so before/after differ. */
function jpegBytes(seed: string) {
  const base = Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AKpgA//Z", "base64");
  // Trailing bytes after EOI are ignored by decoders; they make each upload's checksum unique.
  return Buffer.concat([base, Buffer.from(`\n${seed}:${Date.now()}`)]);
}

async function mockAddressAutocomplete(context: BrowserContext) {
  await context.route("**/api/address-autocomplete?*", async route => {
    const mode = new URL(route.request().url()).searchParams.get("mode");
    if (mode === "search") {
      return route.fulfill({ json: { data: { status: "configured", suggestions: [
        { placeId: "uat-btm-doorstep", mainText: "12, 16th Main Road, BTM Layout 2nd Stage", secondaryText: `BTM Layout, Bengaluru ${PINCODE}`, fullText: ADDRESS } ] } } });
    }
    return route.fulfill({ json: { data: { status: "configured", address: ADDRESS, latitude: DOORSTEP.latitude, longitude: DOORSTEP.longitude } } });
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
  const res = await page.context().request.post("/api/customer-account", { data: { action: "upsert_pet", idempotencyKey: `uat-btm:${acct.data?.customerId}`, pet: { name: "Bruno", species: "dog", breed: "Labrador Retriever", vaccinationStatus: "not_provided" } } });
  expect(res.ok(), `pet seed (${res.status()})`).toBeTruthy();
}

/** Walk grooming steps 1→4 for the BTM doorstep on SERVICE_DATE, stopping on the review step. Returns the slot used. */
async function reachReview(page: Page, preferredSlots: RegExp[]) {
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

  const line1 = page.locator("#grooming-address-line-1");
  await expect(line1, "Address Line 1 (Google Places) input present").toBeVisible();
  await line1.fill("12, 16th Main Road, BTM Layout");
  const suggestions = page.getByRole("region", { name: "Google address suggestions" });
  await expect(suggestions).toBeVisible({ timeout: 20_000 });
  await suggestions.getByRole("button").first().click();
  await expect(page.getByText("Verified service doorstep", { exact: true })).toBeVisible({ timeout: 20_000 });
  await page.locator("#grooming-address-line-2").fill("2nd floor, opposite the park");
  log(`✅ Address: "${ADDRESS}" picked through the Places picker → "Verified service doorstep" (pincode ${PINCODE}, zone blr-south).`);

  const dateChip = page.locator("button[aria-pressed]").filter({ hasText: serviceDateLabel() }).first();
  await expect(dateChip, `a date chip for ${SERVICE_DATE} must be offered`).toBeVisible({ timeout: 20_000 });
  await dateChip.click();
  log(`✅ Date ${SERVICE_DATE} selected ("${(await dateChip.textContent())?.trim()}").`);

  const tried = new Set<string>();
  const slotUsed = await selectSlot(page, preferredSlots, tried);
  expect(slotUsed, "an available slot must exist on the requested date").not.toEqual("");
  log(`✅ Slot "${slotUsed}" selected.`);
  await openReview(page);
  return { slotUsed, tried };
}

/** Slot step (3 of 4): click the first offered slot chip not tried yet. Returns its label, or "" when none is left. */
async function selectSlot(page: Page, preferred: RegExp[], tried: Set<string>): Promise<string> {
  for (const slot of preferred) {
    if (tried.has(String(slot))) continue;
    const chip = page.getByRole("button", { name: slot }).first();
    if (await chip.isVisible().catch(() => false) && await chip.isEnabled().catch(() => false)) {
      await chip.click();
      tried.add(String(slot));
      return (await chip.locator("b").first().textContent().catch(() => null))?.trim() || String(slot);
    }
  }
  return "";
}

/** Review step (4 of 4): open it and (re)fill the mandatory details; the alternative phone stays blank on purpose. */
async function openReview(page: Page) {
  await page.getByRole("button", { name: "Review booking", exact: true }).click();
  await expect(page.getByText("Review and confirm", { exact: true })).toBeVisible();
  await page.getByLabel("Customer Name", { exact: true }).fill(CUSTOMER_NAME);
  await page.getByLabel("Customer Phone Number", { exact: true }).fill(PHONE);
  // Alternative phone deliberately left blank: it is optional and must not hold Confirm back.
  await page.getByLabel("Special instructions to groomer", { exact: true }).fill("Bruno is nervous with clippers - go slow.");
  log("✅ Review step: name + phone filled, alternative phone left blank (optional), instructions added.");
}

type ReserveOutcome = { status: number; body: Record<string, unknown> };
type CreatedOutcome = { status: number; body: Record<string, unknown> };
type BookingAttempt = { reserve: ReserveOutcome | null; created: CreatedOutcome | null; refused: boolean };

/**
 * Click Confirm and read what the server said: FIRST the reserve call (/api/uat-scheduling), which is where
 * "No provider is available" comes from, THEN the canonical booking call, which the app only makes once a
 * provider is assigned. A refusal is logged with every candidate's evaluation in full (this is the evidence
 * the capacity question needs) and returned as refused:true so the caller can try another slot.
 */
async function confirmBooking(page: Page): Promise<BookingAttempt> {
  // The slot step also POSTs /api/uat-scheduling with action:"preview" (the "Preferred groomer" list); only the
  // reserve call, which carries no action, decides capacity.
  const reservePromise = page.waitForResponse(r => r.url().includes("/api/uat-scheduling") && r.request().method() === "POST" && !(r.request().postData() || "").includes("\"action\":\"preview\""), { timeout: 150_000 }).catch(() => null);
  // A reserve is a real scheduler evaluation on remote D1 (about 8 s per candidate groomer); give both
  // server calls their own generous budget rather than the action timeout.
  const createdPromise = page.waitForResponse(r => r.url().includes("/api/canonical-bookings") && r.request().method() === "POST", { timeout: 150_000 }).catch(() => null);
  const confirm = page.getByRole("button", { name: "Confirm booking", exact: true });
  await expect(confirm, "Confirm booking must be enabled with the alternative phone blank").toBeEnabled();
  await confirm.click();
  const reserveRes = await reservePromise;
  const reserve = reserveRes ? { status: reserveRes.status(), body: await reserveRes.json().catch(() => ({})) as Record<string, unknown> } : null;
  let refused = false;
  if (reserve) {
    const data = (reserve.body.data ?? {}) as Record<string, unknown>;
    const provider = (data.provider ?? {}) as Record<string, unknown>;
    if (reserve.status === 200 && provider.id) {
      assignedProviderId = String(provider.id); assignedProviderName = String(provider.name ?? "");
      log(`✅ Capacity: reserve returned HTTP 200, status "${String(data.status)}", provider assigned: ${assignedProviderName || assignedProviderId} (${assignedProviderId}). The "No provider is available" refusal did NOT occur.`);
    } else {
      refused = true;
      const evaluations = Array.isArray(reserve.body.evaluations) ? reserve.body.evaluations as Array<Record<string, unknown>> : [];
      log(`⚠️ Capacity: reserve returned HTTP ${reserve.status} "${String(reserve.body.error ?? reserve.body.message ?? "")}" for this slot; ${evaluations.length} candidate(s) evaluated:`);
      for (const ev of evaluations) log(`   · ${String(ev.providerId ?? ev.id ?? "?")}: ${ev.eligible ? "eligible" : "refused"} — ${(Array.isArray(ev.reasons) ? ev.reasons : []).map(String).join(" | ")}`);
      if (!evaluations.length) log(`   body: ${JSON.stringify(reserve.body)}`);
    }
  } else {
    log("ℹ️ The reserve call was not observed separately (it may have been folded into the booking call); relying on the booking result.");
  }
  if (refused) {
    // The app stops before the canonical booking call after a refusal; allow a folded call a moment, then move on.
    const folded = await Promise.race([createdPromise, page.waitForTimeout(5_000).then(() => null)]);
    return { reserve, created: folded ? { status: folded.status(), body: await folded.json().catch(() => ({})) as Record<string, unknown> } : null, refused };
  }
  const createdRes = await createdPromise;
  const created = createdRes ? { status: createdRes.status(), body: await createdRes.json().catch(() => ({})) as Record<string, unknown> } : null;
  return { reserve, created, refused };
}

/**
 * Book on SERVICE_DATE with the chosen payment mode, falling back across the offered slots when the reserve
 * call refuses one (a slot can be exhausted by other testers: one job per groomer per overlapping window).
 * Each refusal is evidence in the report; only exhausting EVERY offered slot is a capacity failure.
 */
async function bookWithSlotFallback(page: Page, preferred: RegExp[], payMode: "online" | "after"): Promise<BookingAttempt> {
  const { tried } = await reachReview(page, preferred);
  let last: BookingAttempt = { reserve: null, created: null, refused: false };
  for (let attempt = 1; attempt <= preferred.length; attempt += 1) {
    await page.getByRole("button", { name: payMode === "online" ? /^Pay online/ : /^Pay after service/ }).click();
    last = await confirmBooking(page);
    if (last.created?.status === 201 || !last.refused) return last;
    const alert = (await page.locator("p[role='alert']").last().textContent().catch(() => "")) || "";
    log(`ℹ️ Customer saw: "${alert.trim()}" — trying the next offered slot on ${SERVICE_DATE}.`);
    await shot(page, `slot-refused-${attempt}`);
    await page.getByRole("button", { name: "← Slot", exact: true }).click();
    const dateChip = page.locator("button[aria-pressed='true']").filter({ hasText: serviceDateLabel() }).first();
    await expect(dateChip, `date ${SERVICE_DATE} must stay selected after going back`).toBeVisible();
    const next = await selectSlot(page, preferred, tried);
    if (!next) { log(`❌ Capacity: every offered slot on ${SERVICE_DATE} was refused for this doorstep.`); return last; }
    log(`✅ Slot "${next}" selected (retry ${attempt}).`);
    await openReview(page);
  }
  return last;
}

/** Bounded, log-friendly outline of what a frame shows right now (ARIA snapshot, else its text). Evidence for the report. */
async function frameOutline(scope: FrameLocator | Page, label: string, limit = 3_500) {
  try {
    const body = scope.locator("body");
    let text = "";
    try { text = await body.ariaSnapshot({ timeout: 5_000 }); } catch { text = await body.innerText({ timeout: 5_000 }); }
    text = text.replace(/[ \t]+\n/g, "\n").trim();
    log(`🔍 ${label} (${text.length} chars):\n${text.slice(0, limit)}${text.length > limit ? "\n…(truncated)" : ""}`);
  } catch (e) { log(`🔍 ${label}: not readable (${errText(e)})`); }
}
function logFrames(page: Page, label: string) {
  log(`🔍 ${label}: ${page.frames().map(f => f.url() || "(about:blank)").join(" | ")}`);
}

/**
 * Drive Razorpay's sandbox checkout (checkout.js v1, opened by lib/mobile/razorpay.ts with no prefill) with the
 * standard test card. The modal is Razorpay's own cross-origin iframe, so every step is best-effort and logs
 * what the frame showed; the OUTCOME is read from PawSpace's server via the checkout status endpoint, never
 * from what the modal appeared to show.
 */
async function completeRazorpayTestPayment(page: Page): Promise<void> {
  const selector = "iframe.razorpay-checkout-frame, iframe[src*='razorpay']";
  await page.locator(selector).first().waitFor({ state: "visible", timeout: 45_000 });
  log("ℹ️ Razorpay sandbox checkout iframe mounted.");
  await shot(page, "razorpay-modal");
  const frame: FrameLocator = page.frameLocator(selector).first();
  const visible = async (loc: ReturnType<FrameLocator["locator"]>, timeout = 3_000) => loc.first().waitFor({ state: "visible", timeout }).then(() => true).catch(() => false);
  await page.waitForTimeout(2_500);
  await frameOutline(frame, "Razorpay checkout as opened");

  // A. Contact screen. The app sends no prefill, so the modal asks for a phone number (and email) first.
  const contact = frame.locator("#contact, input[name='contact'], input[type='tel']");
  if (await visible(contact, 8_000)) {
    await contact.first().fill(PHONE);
    const email = frame.locator("#email, input[name='email'], input[type='email']");
    if (await visible(email)) await email.first().fill(CUSTOMER_EMAIL);
    log("ℹ️ Contact screen: phone number (and email) entered.");
    const proceed = frame.getByRole("button", { name: /continue|proceed|next/i });
    if (await visible(proceed, 5_000)) { await proceed.first().click({ timeout: 10_000 }); log("ℹ️ Contact screen: Continue pressed."); }
    await page.waitForTimeout(2_000);
    await frameOutline(frame, "Razorpay checkout after the contact step");
  }

  // B. Payment method: Card.
  const cardTiles = [
    frame.locator("[data-value='card'], [data-method='card'], .method[data-value='card']"),
    frame.getByRole("button", { name: /^cards?(\s|$)/i }),
    frame.getByRole("button", { name: /credit|debit/i }),
    frame.getByText(/^cards?$/i),
    frame.getByText(/credit \/ debit|credit\/debit|credit or debit/i),
  ];
  let picked = false;
  for (const tile of cardTiles) { if (await visible(tile)) { await tile.first().click({ timeout: 10_000 }).catch(() => {}); picked = true; break; } }
  log(picked ? "ℹ️ Payment method: Card chosen." : "ℹ️ Payment method: no Card tile found (the card form may already be showing).");
  const addCard = frame.getByText(/add (a )?new card/i);
  if (await visible(addCard)) { await addCard.first().click({ timeout: 10_000 }).catch(() => {}); log("ℹ️ 'Add new card' chosen."); }

  // C. Card form.
  const number = frame.locator("#card_number, input[name='card[number]'], input[autocomplete='cc-number'], input[placeholder*='card number' i]");
  if (!(await visible(number, 20_000))) {
    await frameOutline(frame, "Razorpay checkout (card number field not found)");
    logFrames(page, "Frames");
    throw new Error("card number field not found in the Razorpay checkout");
  }
  await number.first().fill("4111111111111111");
  await frame.locator("#card_expiry, input[name='card[expiry]'], input[autocomplete='cc-exp'], input[placeholder*='MM' i]").first().fill("12/29");
  await frame.locator("#card_cvv, input[name='card[cvv]'], input[autocomplete='cc-csc'], input[placeholder*='CVV' i]").first().fill("123");
  const holder = frame.locator("#card_name, input[name='card[name]'], input[autocomplete='cc-name'], input[placeholder*='name' i]");
  if (await visible(holder)) await holder.first().fill("UAT BTM Customer");
  log("ℹ️ Test card 4111 1111 1111 1111 entered.");
  await shot(page, "razorpay-card");
  await frameOutline(frame, "Razorpay checkout with the card entered");

  // D. Continue / Pay. Razorpay's card form asks for the name on the card and an email only AFTER the first
  // Continue (run 12 outline: "Please enter name on your card", "Please fill out this field"), so fill whatever
  // it then asks for and press again, bounded to three rounds.
  const popupPromise = page.context().waitForEvent("page", { timeout: 25_000 }).catch(() => null);
  const payButton = () => frame.getByRole("button", { name: /^pay\b|pay ₹|pay now|^continue$/i }).last();
  await payButton().click({ timeout: 10_000 });
  log("ℹ️ Continue/Pay pressed.");
  for (let round = 1; round <= 3; round += 1) {
    await page.waitForTimeout(2_000);
    let filled = false;
    const holderLate = frame.getByPlaceholder(/name on (your )?card/i).or(frame.locator("#card_name, input[name='card[name]']"));
    if (await visible(holderLate) && !(await holderLate.first().inputValue().catch(() => ""))) { await holderLate.first().fill("UAT BTM Customer"); filled = true; }
    const emailLate = frame.getByPlaceholder(/email/i).or(frame.locator("#email, input[type='email']"));
    if (await visible(emailLate) && !(await emailLate.first().inputValue().catch(() => ""))) { await emailLate.first().fill(CUSTOMER_EMAIL); filled = true; }
    if (!filled) break;
    log(`ℹ️ The card form asked for more details (name on card / email): filled, pressing Continue again (round ${round}).`);
    await frameOutline(frame, `Razorpay card form before Continue (round ${round})`, 1_800);
    if (await visible(payButton(), 3_000)) await payButton().click({ timeout: 10_000 }).catch(() => {});
  }
  // Razorpay then offers to tokenise the card ("Save your card for future payments?" / "Maybe later" /
  // "Yes, secure my card"): decline, a test card is never saved.
  const declineSave = async () => {
    const later = frame.getByRole("button", { name: /maybe later|no thanks|not now|skip/i });
    if (await visible(later, 8_000)) { await later.first().click({ timeout: 10_000 }).catch(() => {}); log("ℹ️ Declined Razorpay's save-card prompt (\"Maybe later\")."); return true; }
    return false;
  };
  await declineSave();
  await page.waitForTimeout(2_000);
  await frameOutline(frame, "Razorpay checkout right after Continue", 2_500);

  // E. Razorpay's test bank page (Success / Failure): inside the checkout, in a nested frame, or as a popup.
  const popup = await popupPromise;
  const successIn = async (scope: { getByRole: FrameLocator["getByRole"] }, timeout: number) => {
    const b = scope.getByRole("button", { name: /^success$/i }).first();
    if (await b.waitFor({ state: "visible", timeout }).then(() => true).catch(() => false)) { await b.click({ timeout: 10_000 }); return true; }
    return false;
  };
  let bankDone = false;
  const deadline = Date.now() + 90_000;
  while (!bankDone && Date.now() < deadline) {
    if (popup && await successIn(popup, 3_000)) { bankDone = true; log("ℹ️ Test-bank \"Success\" pressed (popup)."); break; }
    if (await successIn(frame, 3_000)) { bankDone = true; log("ℹ️ Test-bank \"Success\" pressed (checkout iframe)."); break; }
    for (const f of page.frames()) { if (await successIn(f, 1_000)) { bankDone = true; log(`ℹ️ Test-bank "Success" pressed (frame ${f.url()}).`); break; } }
    if (!bankDone && await declineSave()) continue;
    if (!bankDone) await page.waitForTimeout(2_000);
  }
  await shot(page, "razorpay-after-pay");
  if (!bankDone) {
    log("ℹ️ No test-bank Success button was found within 90 s; the card may have been captured directly, or the bank step did not render.");
    logFrames(page, "Frames after Pay");
    await frameOutline(frame, "Razorpay checkout after Pay");
    if (popup) await frameOutline(popup, "Popup after Pay");
  }
}

async function serverPaymentStatus(page: Page, id: string) {
  return page.evaluate(async (bookingId) => {
    const r = await fetch("/api/customer-checkout", { method: "POST", credentials: "include", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "status", bookingId }) });
    return { http: r.status, body: await r.json().catch(() => null) as { data?: { status?: string } } | null };
  }, id);
}

async function partnerOtpLogin(context: BrowserContext, phone: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto("/partner/onboarding");
  await page.getByPlaceholder("10-digit phone number").fill(phone);
  await page.getByRole("button", { name: "Send OTP" }).click();
  const sandbox = page.getByText(/Sandbox code \(no real SMS yet\):/i);
  await expect(sandbox, "partner sandbox OTP must be shown on screen").toBeVisible({ timeout: 20_000 });
  const code = (await sandbox.textContent())?.match(/\b(\d{6})\b/)?.[1];
  expect(code, "a 6-digit partner OTP must render").toMatch(/^\d{6}$/);
  await page.getByPlaceholder("6-digit code").fill(code!);
  const verify = page.waitForResponse(r => r.url().includes("/api/partner-otp") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Verify & continue" }).click();
  const res = await verify;
  const body = await res.json().catch(() => ({})) as { data?: { providerId?: string; providerName?: string }; error?: string };
  expect(res.status(), `partner OTP verify for ${phone}: ${JSON.stringify(body).slice(0, 200)}`).toBe(200);
  log(`✅ Partner OTP login as ${phone} → provider ${body.data?.providerName ?? ""} (${body.data?.providerId ?? "?"}).`);
  return page;
}

/**
 * Job cards read "14 Sept, 9:30 am Essential Bath Bruno · Uatbtm confirmed" in the accessibility tree, but
 * their text nodes are adjacent (no whitespace between them), so match on the accessible NAME, not on text.
 */
function jobCards(page: Page) { return page.getByRole("button", { name: new RegExp(`${CUSTOMER_FIRST}|${bookingId}`) }); }

/** On the Jobs tab: click through the cards for this customer until the detail shows BOOKING <id>. */
async function selectJobCard(page: Page): Promise<boolean> {
  const cards = jobCards(page);
  const listed = await expect.poll(async () => cards.count(), { timeout: 45_000 }).toBeGreaterThan(0).then(() => true, () => false);
  if (!listed) { await frameOutline(page, `Partner Jobs tab (no card for "${CUSTOMER_FIRST}" or ${bookingId})`, 3_000); return false; }
  const n = await cards.count();
  for (let i = 0; i < n; i += 1) {
    await cards.nth(i).click();
    if (await page.getByText(`BOOKING ${bookingId}`, { exact: true }).waitFor({ state: "visible", timeout: 5_000 }).then(() => true, () => false)) return true;
  }
  await frameOutline(page, `Partner Jobs tab (${n} card(s) for "${CUSTOMER_FIRST}", none showing BOOKING ${bookingId})`, 3_000);
  return false;
}

async function openPartnerJob(page: Page): Promise<boolean> {
  await page.goto("/partner-app");
  await expect(page.getByText("Verified", { exact: true })).toBeVisible({ timeout: 20_000 });
  await page.locator("nav").getByRole("button", { name: /jobs/i }).last().click();
  return selectJobCard(page);
}

/** Re-open this booking's card after a refresh (the list re-renders and drops the selection). */
async function reselectJobCard(page: Page): Promise<boolean> {
  const cards = jobCards(page);
  const n = await cards.count();
  for (let i = 0; i < n; i += 1) {
    await cards.nth(i).click().catch(() => {});
    if (await page.getByText(`BOOKING ${bookingId}`, { exact: true }).waitFor({ state: "visible", timeout: 3_000 }).then(() => true, () => false)) return true;
  }
  return false;
}

/**
 * Wait for a job action to become available. Right after a sandbox capture the booking can still read
 * "payment pending" for a few seconds while the post-payment saga confirms it and creates the partner's
 * work order; the partner app only offers "Accept job" once the status is confirmed. Refresh the list
 * (↻) between polls and log the last status seen, so a slow saga is evidence rather than a mystery.
 */
async function awaitPartnerAction(page: Page, label: RegExp, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "";
  let polls = 0;
  while (Date.now() < deadline) {
    if (await page.getByRole("button", { name: label }).first().isVisible().catch(() => false)) {
      if (polls) log(`ℹ️ ${String(label)} became available after ${polls} refresh(es) (last status seen: "${lastStatus}").`);
      return true;
    }
    lastStatus = (await page.locator("main").getByText(/^(payment pending|confirmed|assigned|on the way|arrived|in service|completed|awaiting acceptance)$/).first().textContent().catch(() => "")) || lastStatus;
    polls += 1;
    await page.getByRole("button", { name: "↻" }).first().click().catch(() => {});
    await page.waitForTimeout(6_000);
    await reselectJobCard(page);
  }
  log(`⚠️ ${String(label)} did not appear within ${Math.round(timeoutMs / 1000)} s; last job status seen: "${lastStatus}".`);
  await frameOutline(page, `Partner job while waiting for ${String(label)}`, 2_500);
  return false;
}

type PartnerLifecycleProjection = {
  data?: {
    booking?: { status?: string; workOrderStatus?: string; work_order_status?: string };
    events?: Array<{ eventType?: string }>;
  };
};

async function readPartnerLifecycle(page: Page): Promise<PartnerLifecycleProjection | null> {
  const res = await page.context().request.get(`/api/grooming-lifecycle?bookingId=${encodeURIComponent(bookingId)}`, {
    headers: { "cache-control": "no-store" },
  }).catch(() => null);
  if (!res?.ok()) return null;
  return res.json().catch(() => null) as Promise<PartnerLifecycleProjection | null>;
}

async function partnerAct(page: Page, label: RegExp, expectStatus: RegExp) {
  const button = page.getByRole("button", { name: label }).first();
  await awaitPartnerAction(page, label, 30_000);
  await expect(button, `partner action ${label}`).toBeVisible({ timeout: 5_000 });

  // On deployed Chromium, waitForResponse can remain unresolved for minutes even after the lifecycle
  // POST has returned 200 and D1/UI have moved forward. Use the authenticated canonical projection as
  // the completion authority instead. This also keeps a real postcondition for add_proof, whose status
  // intentionally remains in_service: require a new service_proof_updated lifecycle event.
  const before = await readPartnerLifecycle(page);
  const proofEventsBefore = before?.data?.events?.filter(e => e.eventType === "service_proof_updated").length ?? 0;
  void button.click({ noWaitAfter: true, timeout: 15_000 }).catch((error) =>
    log(`ℹ️ ${String(label)} click did not settle within the bounded browser wait: ${errText(error)}`),
  );

  let canonicalStatus = "";
  const committed = await expect.poll(async () => {
    const projection = await readPartnerLifecycle(page);
    const booking = projection?.data?.booking;
    canonicalStatus = String(booking?.workOrderStatus || booking?.work_order_status || booking?.status || "").replaceAll("_", " ");
    if (/Add service proof/i.test(String(label))) {
      const proofEvents = projection?.data?.events?.filter(e => e.eventType === "service_proof_updated").length ?? 0;
      return proofEvents > proofEventsBefore;
    }
    return expectStatus.test(canonicalStatus);
  }, { timeout: 60_000, intervals: [500, 1_000, 2_000, 3_000] }).toBe(true).then(() => true, () => false);

  if (!committed) {
    await frameOutline(page, `Partner job after ${String(label)} did not reach canonical ${String(expectStatus)}`, 2_500);
    throw new Error(`${String(label)} did not commit within 60 s (last canonical status: "${canonicalStatus || "unknown"}")`);
  }
  log(`✅ ${String(label)} committed in canonical lifecycle${canonicalStatus ? ` (status: ${canonicalStatus})` : ""}.`);

  // Refresh/reselect once so the visual assertion proves the Partner UI consumed the committed truth.
  await page.getByRole("button", { name: "↻" }).first().click().catch(() => {});
  await page.waitForTimeout(2_000);
  await reselectJobCard(page);
  const shown = page.getByText(expectStatus).first();
  if (!(await shown.waitFor({ state: "visible", timeout: 30_000 }).then(() => true, () => false))) await frameOutline(page, `Partner job after ${String(label)} (expected ${String(expectStatus)})`, 2_500);
  await expect(shown, `status after ${String(label)}`).toBeVisible();
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

// ---------------------------------------------------------------------------------------------------

test("1. Customer — BTM Layout 560068 on the requested date, pay online through the Razorpay sandbox", async ({ browser }) => {
  test.setTimeout(600_000);
  section("1. Customer persona — BTM Layout checkout (online)");
  const context = await browser.newContext();
  await mockAddressAutocomplete(context);
  const page = await context.newPage();
  try {
    await customerOtpLogin(page);
    log(`✅ Login: sandbox OTP for ${PHONE} accepted (identity-session 200).`);
    await ensurePet(page);
    const { created } = await bookWithSlotFallback(page, SLOTS_ONLINE, "online");
    if(process.env.PW_MAP_PROOF_ONLY==="1") expect([200,201], `canonical booking: ${JSON.stringify(created?.body ?? { note: "no canonical booking call was made" })}`).toContain(created?.status); else expect(created?.status, `canonical booking: ${JSON.stringify(created?.body ?? { note: "no canonical booking call was made" })}`).toBe(201);
    const data = (created?.body.data ?? {}) as Record<string, unknown>;
    bookingId = String(data.bookingId || data.id || "");
    bookingMode = "online";
    log(`✅ Canonical booking created (HTTP 201): ${bookingId}, status "${String(data.status ?? "")}". Checkout progressed to the payment step.`);
    await shot(page, "customer-payment-step");

    section("2. Razorpay sandbox payment");
    try {
      const paySecurely = page.getByRole("button", { name: /^Pay securely\b/i });
      await expect(paySecurely, "prepaid checkout must expose the real Pay securely button").toBeVisible({ timeout: 30_000 });
      await paySecurely.click();
      log("✅ Pay securely pressed through the real Customer UI; waiting for Razorpay sandbox checkout.");
      await completeRazorpayTestPayment(page);
      const verified = page.getByText(/Payment verified by PawSpace/i).first();
      const reserved = page.getByText("Your groomer is reserved.", { exact: true });
      await Promise.race([verified.waitFor({ timeout: 60_000 }), reserved.waitFor({ timeout: 60_000 })]).catch(() => {});
    } catch (e) {
      log(`⚠️ Razorpay automation stopped: ${errText(e)}`);
    }
    // The truth comes from the server, not from the modal.
    let status = await serverPaymentStatus(page, bookingId);
    for (let i = 0; i < 10 && status.body?.data?.status !== "captured"; i += 1) { await page.waitForTimeout(5_000); status = await serverPaymentStatus(page, bookingId); }
    paymentCaptured = status.body?.data?.status === "captured";
    log(paymentCaptured
      ? `✅ Server checkout status for ${bookingId}: "captured" (signed receipt verified by PawSpace). Post-payment saga engaged.`
      : `❌ Server checkout status for ${bookingId}: HTTP ${status.http}, ${JSON.stringify(status.body)}. The sandbox capture did not complete under automation; see the checkout outlines above and the screenshots.`);
    expect(paymentCaptured, "online UAT must prove the Razorpay sandbox payment captured; pay-after fallback cannot make this gate green").toBe(true);
    await frameOutline(page, "Customer payment page after the checkout attempt", 2_000);
    if (paymentCaptured) {
      if (await page.getByText("Your groomer is reserved.", { exact: true }).isVisible({ timeout: 20_000 }).catch(() => false)) log("✅ Confirmation screen: \"Your groomer is reserved.\"");
    }
    await shot(page, "customer-after-payment");
  } finally { await context.close(); }
});

test("2. Fallback — pay-after booking for the partner lifecycle when the online capture did not complete", async ({ browser }) => {
  test.setTimeout(360_000);
  if (paymentCaptured) { log("ℹ️ Online capture succeeded; no fallback booking needed."); return; }
  section("2b. Fallback booking (pay after service) for the partner lifecycle");
  const context = await browser.newContext();
  await mockAddressAutocomplete(context);
  const page = await context.newPage();
  try {
    await customerOtpLogin(page);
    await ensurePet(page);
    const { created } = await bookWithSlotFallback(page, SLOTS_PAY_AFTER, "after");
    expect(created?.status, `canonical booking: ${JSON.stringify(created?.body ?? { note: "no canonical booking call was made" })}`).toBe(201);
    const data = (created?.body.data ?? {}) as Record<string, unknown>;
    bookingId = String(data.bookingId || data.id || "");
    bookingMode = "pay_after";
    // The app saves the service location and then shows the server-authoritative payment page; its
    // "Confirm booking" (pay after service) is what records the acceptance. Wait for it rather than peeking.
    const payConfirm = page.getByRole("button", { name: "Confirm booking", exact: true });
    if (await payConfirm.waitFor({ state: "visible", timeout: 60_000 }).then(() => true).catch(() => false)) {
      await payConfirm.click();
      log("ℹ️ Pay-after: \"Confirm booking\" pressed on the payment page.");
    } else {
      log("ℹ️ Pay-after: no payment-page Confirm button appeared within 60 s (the flow may have confirmed directly).");
    }
    const reserved = page.getByText("Your groomer is reserved.", { exact: true });
    if (!(await reserved.waitFor({ state: "visible", timeout: 90_000 }).then(() => true).catch(() => false))) await frameOutline(page, "Customer page after the pay-after confirm (confirmation text not found)", 2_500);
    await expect(reserved).toBeVisible();
    log(`✅ Pay-after booking ${bookingId} confirmed on the same BTM doorstep and date; provider ${assignedProviderName || assignedProviderId}.`);
    await shot(page, "customer-fallback-confirmation");
  } finally { await context.close(); }
});

test("3. Partner — OTP login as the assigned groomer, accept, GPS, arrive, start service, upload photos", async ({ browser }) => {
  test.setTimeout(600_000);
  section("3. Partner persona (/partner-app)");
  expect(bookingId, "a booking must exist from the customer step").not.toEqual("");
  providerPhone = PROVIDER_PHONES[assignedProviderId] || "9000000904";
  log(`ℹ️ Assigned provider ${assignedProviderId || "(unknown)"} → partner phone ${providerPhone}.`);
  const context = await browser.newContext({ permissions: ["geolocation"], geolocation: { ...DOORSTEP, accuracy: 8 } });
  try {
    const page = await partnerOtpLogin(context, providerPhone);
    const opened = await openPartnerJob(page);
    if (!opened && providerPhone !== "9000000901") {
      log(`⚠️ Booking ${bookingId} not in ${providerPhone}'s job list; retrying with the city-wide team 9000000901.`);
      providerPhone = "9000000901";
      const alt = await partnerOtpLogin(await browser.newContext({ permissions: ["geolocation"], geolocation: { ...DOORSTEP, accuracy: 8 } }), providerPhone);
      expect(await openPartnerJob(alt), `booking ${bookingId} must be in the assigned groomer's job list`).toBeTruthy();
      return await partnerLifecycle(alt);
    }
    expect(opened, `booking ${bookingId} must be in the assigned groomer's job list`).toBeTruthy();
    await partnerLifecycle(page);
  } finally { await context.close(); }
});

async function partnerLifecycle(page: Page) {
  log(`✅ Job ${bookingId} visible in the partner app (customer ${CUSTOMER_NAME}).`);
  await shot(page, "partner-job");
  expect(await awaitPartnerAction(page, /^Accept job$/, 150_000), "Accept job must become available once the post-payment saga confirms the booking").toBeTruthy();
  await partnerAct(page, /^Accept job$/, /assigned/i); log("✅ Accept job → assigned.");
  await partnerAct(page, /^Start journey$/, /on the way/i); log("✅ Start journey → on the way.");

  // GPS at the booking's own doorstep: ask the server where that is, then report a fix there.
  const route = await page.evaluate(async ({ bookingId, providerId }) => {
    const r = await fetch(`/api/grooming-route?bookingId=${encodeURIComponent(bookingId)}&providerId=${encodeURIComponent(providerId)}`, { cache: "no-store", credentials: "include" });
    return { http: r.status, body: await r.json().catch(() => null) as unknown };
  }, { bookingId, providerId: assignedProviderId });
  const found = (function find(value: unknown): { lat: number; lng: number } | null {
    if (!value || typeof value !== "object") return null;
    const v = value as Record<string, unknown>;
    if (typeof v.lat === "number" && typeof v.lng === "number") return { lat: v.lat, lng: v.lng };
    if (typeof v.latitude === "number" && typeof v.longitude === "number") return { lat: v.latitude, lng: v.longitude };
    for (const key of Object.keys(v)) { const hit = find(v[key]); if (hit) return hit; }
    return null;
  })((route.body as { data?: unknown })?.data ?? route.body);
  const doorstep = found ? { latitude: found.lat, longitude: found.lng } : DOORSTEP;
  const target = { latitude: doorstep.latitude + 0.008, longitude: doorstep.longitude - 0.006 };
  log(`${found ? "✅" : "ℹ️"} Doorstep coordinates ${found ? "from the route API" : "not exposed by the route API; using the mocked doorstep"}: ${doorstep.latitude.toFixed(5)}, ${doorstep.longitude.toFixed(5)}; provider proof point: ${target.latitude.toFixed(5)}, ${target.longitude.toFixed(5)}.`);
  await page.context().setGeolocation({ ...target, accuracy: 8 });
  await page.locator("nav").getByRole("button", { name: /gps/i }).last().click();
  const gpsPost = page.waitForResponse(r => r.url().includes("/api/grooming-route") && r.request().method() === "POST", { timeout: 30_000 });
  await page.getByRole("button", { name: /Update once/ }).click();
  const gpsRes = await gpsPost;
  const gpsBody = await gpsRes.json().catch(() => ({})) as { error?: string; data?: { route?: { status?: string; distanceMeters?: number; durationSeconds?: number; error?: string } | null } };
  log(`🗺️ Route evidence after GPS: ${JSON.stringify(gpsBody.data?.route ?? null)}`);
  log(`${gpsRes.ok() ? "✅" : "❌"} GPS fix reported to /api/grooming-route (HTTP ${gpsRes.status()})${gpsRes.ok() ? "" : `: ${gpsBody.error ?? ""}`}.`);
  await shot(page, "partner-gps");

  // Customer live-map proof: use a fresh authenticated customer session against the same deployed
  // staging booking immediately after the trusted provider GPS fix, while the job is still on_the_way.
  // This proves the real Google Static Maps response, not a mocked screenshot.
  const proofBrowser=page.context().browser();
  expect(proofBrowser,"customer live-map proof requires the Playwright browser").not.toBeNull();
  const customerContext=await proofBrowser!.newContext();
  try{
    const customerPage=await customerContext.newPage();
    await customerOtpLogin(customerPage);
    const summary=await customerPage.evaluate(async(id)=>{
      const response=await fetch(`/api/customer-grooming-summary?bookingId=${encodeURIComponent(id)}`,{cache:"no-store",credentials:"include"});
      return{http:response.status,body:await response.json().catch(()=>null)};
    },bookingId) as {http:number;body:{data?:{tracking?:{state?:string;etaMinutes?:number|null;distanceKm?:number|null}}}|null};
    expect(summary.http,"customer Grooming summary must load for the owning customer").toBe(200);
    expect(summary.body?.data?.tracking?.state,`fresh trusted GPS + Routes evidence must expose live customer tracking; route=${JSON.stringify(gpsBody.data?.route ?? null)} summary=${JSON.stringify(summary.body?.data?.tracking ?? null)}`).toBe("live");
    expect(Number(summary.body?.data?.tracking?.etaMinutes||0),"live tracking must contain a positive ETA").toBeGreaterThan(0);
    const mapUrl=`${BASE}/api/customer-grooming-summary?bookingId=${encodeURIComponent(bookingId)}&map=1&proof=${Date.now()}`;
    const mapResponse=await customerPage.goto(mapUrl,{waitUntil:"load",timeout:30_000});
    expect(mapResponse,"customer live-map endpoint must answer").not.toBeNull();
    expect(mapResponse!.status(),"customer live-map endpoint must return the Google map image").toBe(200);
    expect(mapResponse!.headers()["content-type"]||"","customer live-map response must be an image").toMatch(/^image\//i);
    expect(mapResponse!.headers()["x-pawspace-map-source"],"customer live-map must come from Google Static Maps").toBe("google-static-maps");
    expect(mapResponse!.headers()["x-pawspace-location-privacy"],"customer map must use the privacy-rounded provider point").toBe("provider-rounded-3dp");
    await customerPage.screenshot({path:"test-results/btm-customer-live-google-map.png",fullPage:true});
    log(`✅ Customer live map: tracking live, ETA ${summary.body?.data?.tracking?.etaMinutes} min, distance ${summary.body?.data?.tracking?.distanceKm} km, Google Static Maps image HTTP 200.`);
  }finally{await customerContext.close();}
  if(process.env.PW_MAP_PROOF_ONLY==="1"){log("✅ Maps-only proof complete; stopping partner lifecycle after live-map evidence.");return;}
  await page.locator("nav").getByRole("button", { name: /jobs/i }).last().click();
  expect(await selectJobCard(page), `job ${bookingId} must reopen after the GPS fix`).toBeTruthy();
  await partnerAct(page, /^Mark arrived$/, /arrived/i); log("✅ Mark arrived accepted (fresh trusted GPS inside the doorstep geofence).");

  // The Partner app intentionally blocks service start until the groomer acknowledges every
  // before-service safety check. Exercise those real UI controls rather than bypassing the gate.
  const beforeServiceChecklist = page.getByRole("group", { name: /Before-service checklist/i });
  await expect(beforeServiceChecklist, "before-service checklist after arrival").toBeVisible({ timeout: 30_000 });
  const checklistItems = beforeServiceChecklist.getByRole("checkbox");
  await expect(checklistItems, "three required before-service checks").toHaveCount(3);
  for (let i = 0; i < 3; i += 1) {
    await checklistItems.nth(i).check();
    await expect(checklistItems.nth(i), `before-service check ${i + 1}`).toBeChecked();
  }
  const startService = page.getByRole("button", { name: /^Start service$/ }).first();
  await expect(startService, "Start service must unlock only after all safety checks").toBeEnabled({ timeout: 15_000 });
  log("✅ Before-service checklist completed; Start service enabled through the real Partner UI.");

  await partnerAct(page, /^Start service$/, /in service/i); log("✅ Start service → in service.");
  await shot(page, "partner-in-service");

  for (const [purpose, label] of [["before_service", "Before photo"], ["after_service", "After photo"]] as const) {
    const input = page.getByLabel(label, { exact: true });
    await expect(input, `${label} file input`).toBeAttached({ timeout: 20_000 });
    const uploaded = page.waitForResponse(r => r.url().includes("/api/service-media/upload") && r.request().method() === "PUT", { timeout: 60_000 });
    await input.setInputFiles({ name: `${purpose}.jpg`, mimeType: "image/jpeg", buffer: jpegBytes(purpose) });
    const res = await uploaded;
    const body = await res.json().catch(() => ({})) as { data?: { id?: string; accessStatus?: string; sha256?: string; adapterConnected?: boolean; objectStored?: boolean }; error?: string; code?: string };
    expect(body.data?.adapterConnected, "Private staging media storage must be bound").toBe(true);
    expect(body.data?.objectStored, "A hash without retained photo bytes does not certify the upload journey").toBe(true);
    if (res.ok()) { uploadedPurposes.push(purpose); log(`✅ ${label}: bytes uploaded and verified by the server (HTTP 200, asset ${body.data?.id}, ${body.data?.accessStatus}, sha256 ${String(body.data?.sha256).slice(0, 12)}…, bucket ${body.data?.adapterConnected ? "bound, object stored" : "not bound in staging"}).`); }
    else log(`❌ ${label}: upload refused (HTTP ${res.status()}): ${body.error ?? body.code ?? ""}`);
    // The app registers, uploads, then discards the queued item and FLUSHES the offline queue; a second
    // photo added before that flush finishes gets registered twice (one registration never receives its
    // bytes and sits in the Ops queue as "upload incomplete"). Wait for the app's own confirmation first.
    const settled = await page.getByText(new RegExp(`${label.split(" ")[0]} photo uploaded and verified`)).first().waitFor({ state: "visible", timeout: 30_000 }).then(() => true, () => false);
    log(settled ? `ℹ️ Partner app confirmed the ${label.toLowerCase()} upload and queue flush.` : `⚠️ Partner app did not show its "${label} uploaded and verified" message within 30 s.`);
  }
  await expect.poll(async () => (await page.getByText(/awaiting Ops approval/i).count()), { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
  const assets = await page.evaluate(async (id) => (await (await fetch(`/api/service-media?bookingId=${encodeURIComponent(id)}`, { cache: "no-store", credentials: "include" })).json()), bookingId) as { assets?: Array<{ id: string; purpose: string; accessStatus?: string; access_status?: string; reviewStatus?: string; review_status?: string; retention_status?: string; proofReady?: boolean }> };
  for (const asset of assets.assets ?? []) log(`ℹ️ Media asset ${asset.id}: ${asset.purpose}, access ${asset.accessStatus ?? asset.access_status}, review ${asset.reviewStatus ?? asset.review_status}, proofReady ${String(asset.proofReady)}.`);
  const activeAssets = (assets.assets ?? []).filter(asset => asset.retention_status === "active");
  expect(activeAssets.map(asset => asset.purpose).sort(), "exactly one active registration per proof purpose").toEqual(["after_service", "before_service"]);
  for (const asset of activeAssets) {
    expect(["quarantined", "ready"], "each active proof has received its bytes").toContain(asset.accessStatus ?? asset.access_status);
  }
  log("PASS: exactly one active before-service photo and one active after-service photo; no pending-upload duplicate.");
  log("✅ Partner app shows the photos as uploaded and awaiting Ops approval.");
  const premature = page.getByRole("button", { name: /^Add service proof$/ });
  if (await premature.isVisible().catch(() => false)) {
    await premature.click();
    const refusal = await page.locator("[class*='error']").first().textContent({ timeout: 10_000 }).catch(() => "");
    log(refusal ? `✅ Premature "Add service proof" refused with the per-photo reason: ${refusal.slice(0, 200)}` : "ℹ️ Premature \"Add service proof\" did not surface a refusal message.");
  }
  await shot(page, "partner-photos-uploaded");
}

test("MAP-DIRECT — existing confirmed booking reaches trusted GPS and Google customer map", async ({ browser }) => {
  test.setTimeout(180_000);
  bookingId=process.env.PW_MAP_BOOKING_ID||"PS-UAT-MUGQERZ7-2ADF";
  assignedProviderId=process.env.PW_MAP_PROVIDER_ID||"uatcap_groom_south_2";
  providerPhone=process.env.PW_MAP_PROVIDER_PHONE||"9000000913";

  const customerContext=await browser.newContext();
  const customerPage=await customerContext.newPage();
  await customerOtpLogin(customerPage);
  const own=await customerContext.request.get(`/api/customer-grooming-summary?bookingId=${encodeURIComponent(bookingId)}`);
  expect(own.status(),await own.text()).toBe(200);

  const partnerContext=await browser.newContext();
  const partnerPage=await partnerOtpLogin(partnerContext,providerPhone);
  let projection=await readPartnerLifecycle(partnerPage);
  let status=String(projection?.data?.booking?.workOrderStatus||projection?.data?.booking?.work_order_status||projection?.data?.booking?.status||"").toLowerCase();

  if(status==="confirmed"||status==="awaiting acceptance"||status==="awaiting_acceptance"){
    const accepted=await partnerContext.request.post("/api/grooming-lifecycle",{data:{bookingId,action:"accept"}});
    expect(accepted.status(),await accepted.text()).toBe(200);
  }
  projection=await readPartnerLifecycle(partnerPage);
  status=String(projection?.data?.booking?.workOrderStatus||projection?.data?.booking?.work_order_status||projection?.data?.booking?.status||"").toLowerCase();
  if(status==="assigned"){
    const started=await partnerContext.request.post("/api/grooming-lifecycle",{data:{bookingId,action:"on_the_way"}});
    expect(started.status(),await started.text()).toBe(200);
  }
  projection=await readPartnerLifecycle(partnerPage);
  status=String(projection?.data?.booking?.workOrderStatus||projection?.data?.booking?.work_order_status||projection?.data?.booking?.status||"").toLowerCase();
  expect(["on_the_way","on the way","arrived","in_service","in service"]).toContain(status);

  const gps=await partnerContext.request.post("/api/grooming-route",{data:{
    bookingId,
    providerId:assignedProviderId,
    latitude:DOORSTEP.latitude + 0.008,
    longitude:DOORSTEP.longitude - 0.006,
    accuracyMeters:8,
    capturedAt:Date.now(),
    idempotencyKey:`maps-direct-${Date.now()}`
  }});
  const gpsText=await gps.text();
  expect([200,201],gpsText).toContain(gps.status());
  const gpsBody=JSON.parse(gpsText) as {data?:{providerLocation?:{trustState?:string};telemetryAccepted?:boolean}};
  expect(gpsBody.data?.providerLocation?.trustState).toBe("accepted");
  expect(gpsBody.data?.telemetryAccepted).toBe(true);

  let summary:any=null;
  await expect.poll(async()=>{
    const response=await customerContext.request.get(`/api/customer-grooming-summary?bookingId=${encodeURIComponent(bookingId)}&proof=${Date.now()}`,{headers:{"cache-control":"no-store"}});
    if(response.status()!==200)return `http-${response.status()}`;
    summary=await response.json();
    return summary?.data?.tracking?.state||"missing";
  },{timeout:45_000,intervals:[1000,2000,3000,5000]}).toBe("live");

  expect(Number(summary?.data?.tracking?.etaMinutes||0)).toBeGreaterThan(0);
  const mapUrl=`/api/customer-grooming-summary?bookingId=${encodeURIComponent(bookingId)}&map=1&proof=${Date.now()}`;
  const mapResponse=await customerPage.goto(mapUrl,{waitUntil:"load",timeout:30_000});
  expect(mapResponse).not.toBeNull();
  expect(mapResponse!.status()).toBe(200);
  expect(mapResponse!.headers()["content-type"]||"").toMatch(/^image\//i);
  expect(mapResponse!.headers()["x-pawspace-map-source"]).toBe("google-static-maps");
  expect(mapResponse!.headers()["x-pawspace-location-privacy"]).toBe("provider-rounded-3dp");
  await customerPage.screenshot({path:"test-results/btm-customer-live-google-map.png",fullPage:true});
  log(`✅ MAP_DIRECT_PASS booking ${bookingId}: tracking live, ETA ${summary?.data?.tracking?.etaMinutes} min, distance ${summary?.data?.tracking?.distanceKm} km, Google Static Maps HTTP 200.`);

  await partnerContext.close();
  await customerContext.close();
});

test("4. Founder — approves both photos in Control → Customer booking lifecycle", async ({ browser }) => {
  test.setTimeout(180_000);
  section("4. Founder persona (maker/checker approval)");
  expect(ACCESS_CODE, "PAWSPACE_UAT_ACCESS_CODE must be provided (CI secret)").not.toEqual("");
  expect(uploadedPurposes.length, "both photos must have uploaded").toBe(2);
  const context = await browser.newContext();
  try {
    let page: Page | null = null, who = "";
    for (const email of FOUNDER_EMAILS) { try { page = await staffSignIn(context, email); who = email; break; } catch (e) { log(`⚠️ Staff sign-in as ${email} failed: ${errText(e)}`); } }
    expect(page, "a staff identity must sign in").not.toBeNull();
    log(`✅ Staff sign-in as ${who}.`);
    await page!.goto("/control");
    await page!.getByRole("button", { name: "Customer booking lifecycle" }).click();
    const queue = page!.getByRole("region", { name: "Service proof awaiting review" });
    await expect(queue).toBeVisible({ timeout: 20_000 });
    await queue.getByRole("button", { name: "Refresh" }).click().catch(() => {});
    const mine = queue.locator("article").filter({ hasText: bookingId });
    await expect.poll(async () => mine.count(), { timeout: 30_000 }).toBe(2);
    for (const label of ["before service", "after service"]) {
      // One uploaded photo must create one review entry, not a candidate list hiding duplicates.
      const candidates = mine.filter({ hasText: new RegExp(`^${label} photo`, "i") });
      const count = await candidates.count();
      expect(count, `exactly one ${label} review entry for ${bookingId}`).toBe(1);
      log(`ℹ️ ${count} "${label} photo" asset(s) listed for ${bookingId} in the review queue.`);
      let approved = false;
      for (let i = 0; i < count && !approved; i += 1) {
        const article = candidates.nth(i);
        const state = ((await article.locator("span").first().textContent().catch(() => "")) || "").trim();
        await article.getByLabel(`Review reason for ${label} photo`).fill("Synthetic UAT pipeline fixture for this booking; not a real service photograph");
        const decided = page!.waitForResponse(r => r.url().includes("/api/service-media") && r.request().method() === "PATCH", { timeout: 30_000 });
        await article.getByRole("button", { name: `Approve ${label} photo` }).click();
        const res = await decided;
        const body = await res.json().catch(() => ({})) as { data?: { proofReady?: boolean; releaseBlockedReason?: string | null }; error?: string; code?: string };
        log(`${res.ok() && body.data?.proofReady ? "✅" : "❌"} ${label} photo #${i + 1} (${state || "state unknown"}): approve → HTTP ${res.status()}, proofReady ${String(body.data?.proofReady)}${body.error ? `, ${body.error}` : ""}${body.data?.releaseBlockedReason ? `, held: ${body.data.releaseBlockedReason}` : ""}.`);
        if (res.ok()) approved = true;
      }
      expect(approved, `an uploaded ${label} photo must be approvable for ${bookingId}`).toBeTruthy();
    }
    const listing = await page!.evaluate(async (id) => (await (await fetch(`/api/service-media?bookingId=${encodeURIComponent(id)}`, { cache: "no-store", credentials: "include" })).json()), bookingId) as { assets?: Array<{ purpose: string; proofReady: boolean }> };
    const ready = (listing.assets ?? []).filter(a => a.proofReady).map(a => a.purpose);
    expect(ready.slice().sort(), "both unique proof purposes are approved").toEqual(["after_service", "before_service"]);
    log(`${ready.length >= 2 ? "✅" : "❌"} Media listing for ${bookingId}: proofReady for ${ready.join(", ") || "none"}.`);
    await shot(page!, "founder-approval");
  } finally { await context.close(); }
});

test("5. Partner — adds service proof and completes the job", async ({ browser }) => {
  test.setTimeout(180_000);
  section("5. Partner persona — completion");
  const context = await browser.newContext({ permissions: ["geolocation"], geolocation: { ...DOORSTEP, accuracy: 8 } });
  try {
    const page = await partnerOtpLogin(context, providerPhone || "9000000904");
    expect(await openPartnerJob(page), `booking ${bookingId} must still be in the job list`).toBeTruthy();
    await page.getByRole("button", { name: /Refresh proof status/ }).click().catch(() => {});
    await expect(page.getByText(/Both photos approved/i)).toBeVisible({ timeout: 30_000 });
    log("✅ Partner app: \"Both photos approved.\"");

    // The Partner app intentionally keeps service proof disabled until every after-service
    // handover/safety acknowledgement is checked. Exercise those real UI controls so the
    // acceptance journey proves the same completion gate a groomer must satisfy.
    const afterServiceChecklist = page.getByRole("group", { name: /After-service checklist/i });
    await expect(afterServiceChecklist, "after-service checklist before service proof").toBeVisible({ timeout: 30_000 });
    const afterChecklistItems = afterServiceChecklist.getByRole("checkbox");
    await expect(afterChecklistItems, "four required after-service checks").toHaveCount(4);
    for (let i = 0; i < 4; i += 1) {
      await afterChecklistItems.nth(i).check();
      await expect(afterChecklistItems.nth(i)).toBeChecked();
    }
    await expect(page.getByRole("button", { name: /^Add service proof$/ }).first(), "Add service proof enabled after after-service checklist").toBeEnabled();
    log("✅ After-service checklist completed; Add service proof enabled through the real Partner UI.");

    await partnerAct(page, /^Add service proof$/, /in service/i); log("✅ Add service proof recorded (approved before/after references, checklist).");
    await partnerAct(page, /^Complete job$/, /completed/i); log("✅ Complete job → completed.");
    await shot(page, "partner-completed");
    const invoice = await page.getByText(/Invoice /).first().textContent().catch(() => "");
    if (invoice) log(`✅ ${invoice.trim()}`);
    if (bookingMode === "pay_after") {
      const request = page.getByRole("button", { name: "Create payment request" });
      if (await request.isVisible({ timeout: 10_000 }).catch(() => false)) {
        await request.click();
        const link = await page.getByRole("link", { name: /Open sandbox checkout/ }).isVisible({ timeout: 20_000 }).catch(() => false);
        log(`${link ? "✅" : "⚠️"} Pay-after: Razorpay sandbox payment request ${link ? "created (checkout link + QR payload shown)" : "did not surface a checkout link"}.`);
        await shot(page, "partner-payment-request");
      }
    } else {
      log("✅ Prepaid booking: nothing further to collect after completion.");
    }
  } finally { await context.close(); }
});
