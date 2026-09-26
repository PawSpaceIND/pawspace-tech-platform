import { test, expect, type Frame, type Locator, type Page, type Response } from "@playwright/test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * V2 staging end-to-end journey, run on demand by .github/workflows/v2-staging-e2e.yml
 * (playwright.v2-staging.config.ts). It drives the DEPLOYED staging origin as a customer would:
 *
 *   sandbox phone OTP (the code staging shows on screen) -> add a pet inline when the account has none ->
 *   Bath & Basic -> service area by PIN -> first available slot -> live price & groomers (<= 60 s) ->
 *   first groomer -> Reserve & review payment -> [run_payment] Razorpay TEST checkout with the standard
 *   test card and the test-bank Success page -> V2 booking confirmation shows "confirmed" -> Activity
 *   lists the booking.
 *
 * The optional staff check signs in at /staging-login with PAWSPACE_UAT_ACCESS_CODE and searches the booking
 * in the Booking Command Center. It runs in its own project with tracing off, and the code is never passed
 * to fill()/type() (their step titles repeat the value), so it cannot reach logs, reports or artifacts.
 *
 * Sign-ins are the sanctioned test ones only. Card details are entered only after PawSpace answers the
 * checkout start with a sandbox order and a Razorpay test-mode key.
 */

const BASE_URL = (process.env.PW_BASE_URL ?? "").trim();
const SERVICE_PINCODE = (process.env.PW_SERVICE_PINCODE ?? "560068").trim();
const RUN_PAYMENT = !/^(false|0|no|off)$/i.test((process.env.PW_RUN_PAYMENT ?? "true").trim());
const ACCESS_CODE = process.env.PAWSPACE_UAT_ACCESS_CODE ?? "";
const EVIDENCE_DIR = process.env.V2_STAGING_EVIDENCE_DIR ?? "test-results/v2-staging-evidence";
const REPORT = join(EVIDENCE_DIR, "report.md");
const HANDOFF = join(EVIDENCE_DIR, "booking.json");

// A fresh synthetic customer per run (sandbox OTP sends no SMS), so the inline "add your pet" path is exercised.
const PHONE = (process.env.PW_CUSTOMER_PHONE ?? `8${String(Date.now()).slice(-9)}`).trim();
const CUSTOMER_NAME = "QA V2 Staging";
const CUSTOMER_EMAIL = "qa.v2.staging@example.com";
const PET_NAME = "QA Bruno";
// No city or PIN in the text: staging appends the governed area, city and PIN for whichever PIN is tested.
const SERVICE_ADDRESS = (process.env.PW_SERVICE_ADDRESS ?? "Flat 101, PawSpace QA Test Residency, 16th Main Road").trim();

// Razorpay's published test card; any future expiry and any CVV.
const TEST_CARD = "4111111111111111";
const TEST_CVV = "123";
const TEST_EXPIRY = `12/${String((new Date().getFullYear() + 3) % 100).padStart(2, "0")}`;

const LIVE_CHECK_TIMEOUT = 60_000;
const MAX_SLOT_ATTEMPTS = 4;
const PRODUCTION_HOSTS = new Set(["pawspace.in", "www.pawspace.in", "app.pawspace.in"]);

type Handoff = { bookingId: string; paid: boolean; origin: string; groomer: string; recordedAt: string };

let bookingId = "";
let stepNumber = 0;

function writeReportLine(line: string) {
  try {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    appendFileSync(REPORT, `${line}\n`);
  } catch {
    // The console line below is the fallback record.
  }
}
/** One numbered step, always carrying the booking ID (or that it does not exist yet). */
function log(message: string) {
  stepNumber += 1;
  const line = `${String(stepNumber).padStart(2, "0")}. [booking ${bookingId || "not created yet"}] ${message}`;
  console.log(`[v2-staging] ${line}`);
  writeReportLine(`- ${line}`);
}
function note(message: string) {
  console.log(`[v2-staging] note: ${message}`);
  writeReportLine(`  - note: ${message}`);
}
async function snap(page: Page, name: string) {
  try {
    await test.info().attach(name, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  } catch {
    // Screenshots are evidence, never the reason a run fails.
  }
}
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();
const seconds = (since: number) => `${Math.round((Date.now() - since) / 1000)} s`;
const isPost = (response: Response, path: string) =>
  response.request().method() === "POST" && new URL(response.url()).pathname === path;
async function errorText(response: Response) {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : `HTTP ${response.status()}`;
}

/** The deployed origin under test. Refuses a missing value and the production hosts. */
function stagingOrigin() {
  if (!BASE_URL) throw new Error("Set PW_BASE_URL to the deployed staging origin (workflow input base_url).");
  const url = new URL(BASE_URL);
  const host = url.hostname.toLowerCase();
  const local = host === "localhost" || host === "127.0.0.1";
  if (url.protocol !== "https:" && !local) throw new Error("PW_BASE_URL must be an https origin.");
  if (PRODUCTION_HOSTS.has(host) || host.startsWith("pawspace-tech-platform.")) {
    throw new Error(`Refusing to run the staging journey against the production origin ${url.origin}.`);
  }
  return url.origin;
}

/** A booking step on /v2/grooming, found by its heading. */
const stepSection = (page: Page, heading: RegExp | string) =>
  page.locator("section").filter({ has: page.getByRole("heading", { name: heading }) });

async function signInWithSandboxOtp(page: Page) {
  await page.goto("/v2");
  const signIn = page.getByRole("button", { name: "Sign in", exact: true });
  await expect(signIn).toBeVisible({ timeout: 60_000 });
  await signIn.click();
  const dialog = page.getByRole("dialog", { name: "Sign in to PawSpace" });
  await dialog.getByLabel("Mobile number", { exact: true }).fill(PHONE);
  const requested = page.waitForResponse(response => isPost(response, "/api/customer-otp"), { timeout: 60_000 });
  await dialog.getByRole("button", { name: /Continue securely/ }).click();
  const request = await requested;
  if (!request.ok()) throw new Error(`The sandbox OTP request was refused: ${await errorText(request)}`);

  const codeInput = dialog.getByLabel("Verification code", { exact: true });
  await expect(codeInput).toBeVisible({ timeout: 30_000 });
  const sandboxLabel = dialog.getByText("Sandbox code (no real SMS yet)", { exact: true });
  if (!(await sandboxLabel.isVisible())) {
    throw new Error("Staging did not display a sandbox OTP (is live customer OTP enabled?). This journey only uses the on-screen sandbox code.");
  }
  const code = ((await sandboxLabel.locator("xpath=..").locator("b").first().textContent()) ?? "").trim();
  expect(code, "the sandbox OTP shown on screen").toMatch(/^\d{6}$/);
  await codeInput.fill(code);
  const nameInput = dialog.getByLabel("Your name", { exact: true });
  if (await nameInput.isVisible()) await nameInput.fill(CUSTOMER_NAME);

  const verified = page.waitForResponse(
    response => isPost(response, "/api/customer-otp") && (response.request().postData() ?? "").includes('"verify"'),
    { timeout: 60_000 },
  );
  await dialog.getByRole("button", { name: /Open my PawSpace/ }).click();
  const verification = await verified;
  if (!verification.ok()) throw new Error(`The sandbox OTP was not accepted: ${await errorText(verification)}`);
  await expect(dialog).toBeHidden({ timeout: 60_000 });
  await expect
    .poll(() => page.evaluate(async () => (await fetch("/api/identity-session", { cache: "no-store", credentials: "include" })).status), { timeout: 30_000 })
    .toBe(200);
}

async function openGrooming(page: Page) {
  await page.goto("/v2/grooming");
  const ready = page.getByRole("heading", { name: /A calmer spa day/ });
  const blocked = page.getByRole("heading", { name: /We can.t begin this booking yet/ });
  await expect(ready.or(blocked).first()).toBeVisible({ timeout: 90_000 });
  if (await blocked.isVisible()) throw new Error(`V2 grooming could not start: ${oneLine(await page.locator("main").first().innerText())}`);
}

/** Uses the account's first pet, or adds one through the inline pet form when the account has none. */
async function ensurePetSelected(page: Page) {
  const family = stepSection(page, /getting pampered/);
  const addFirst = family.getByRole("button", { name: /Add your pet to start/ });
  if (!(await addFirst.isVisible())) {
    const selected = family.locator('button[aria-pressed="true"]').first();
    await expect(selected).toBeVisible();
    const name = oneLine(await selected.locator("b").first().innerText());
    log(`Account already has pets; using the pre-selected pet ${name}`);
    return name;
  }
  await addPetInline(page, addFirst);
  return PET_NAME;
}

async function addPetInline(page: Page, opener: Locator) {
  await opener.click();
  const manager = page.locator("section").filter({ has: page.getByText("Your pets", { exact: true }) }).last();
  await manager.getByRole("button", { name: /Add pet$/ }).click();
  const form = manager.locator("div").filter({ has: page.getByText("Add a pet", { exact: true }) }).last();
  await form.getByLabel(/^Name/).fill(PET_NAME);
  await form.getByLabel(/^Species/).selectOption("dog");
  await form.getByLabel(/^Breed/).fill("Labrador Retriever");
  await form.getByLabel(/^Age/).selectOption("3 years");
  await form.getByLabel(/^Weight/).selectOption("Not sure");
  await form.getByLabel(/^Temperament/).selectOption("Friendly");
  await form.getByLabel(/^Vaccinated/).selectOption("yes");
  const saved = page.waitForResponse(response => isPost(response, "/api/customer-account"), { timeout: 60_000 });
  // After saving, the pet form re-reads the account in the background and hands the refreshed list to the
  // booking page, which resets any live price/groomer check in flight. Wait for that read before moving on.
  const reconciled = page.waitForResponse(
    async response => response.request().method() === "GET" && new URL(response.url()).pathname === "/api/customer-account" &&
      response.ok() && (await response.text()).includes(`"${PET_NAME}"`),
    { timeout: 90_000 },
  ).then(() => true, () => false);
  await form.getByRole("button", { name: "Add pet", exact: true }).click();
  const response = await saved;
  if (!response.ok()) throw new Error(`Adding the pet failed: ${await errorText(response)}`);
  const card = stepSection(page, /getting pampered/).getByRole("button", { name: new RegExp(escapeRegex(PET_NAME)) }).first();
  await expect(card).toHaveAttribute("aria-pressed", "true", { timeout: 60_000 });
  if (!(await reconciled)) note("The pet list refresh after saving was not observed within 90 s; continuing");
  await expect(card).toHaveAttribute("aria-pressed", "true");
  log(`Account had no pets; added ${PET_NAME} (dog, Labrador Retriever, 3 years) with the inline pet form and selected it`);
}

async function chooseBathAndBasic(page: Page) {
  const care = stepSection(page, /Choose their grooming ritual/);
  const bath = care.getByRole("button").filter({ has: page.locator("h3", { hasText: /^Bath & Basic$/ }) }).first();
  await expect(bath, "the published Bath & Basic package for this pet").toBeEnabled({ timeout: 30_000 });
  await bath.click();
  await expect(bath).toContainText("Selected");
  const issue = page.locator("#v2-selection-issue, #v2-young-issue").first();
  if (await issue.isVisible()) throw new Error(`The pet cannot book Bath & Basic: ${oneLine(await issue.innerText())}`);
  const card = oneLine(await bath.innerText());
  const price = /₹\s?[\d,]+/.exec(card)?.[0] ?? "price shown";
  const duration = /\d+ min · \d+ pets?/.exec(card)?.[0];
  log(`Chose Bath & Basic (${price}${duration ? `, ${duration}` : ""})`);
}

async function verifyServiceArea(page: Page) {
  const doorstep = stepSection(page, /Where should we come/);
  await doorstep.getByLabel("House, street & area").fill(SERVICE_ADDRESS);
  await doorstep.getByLabel("PIN code", { exact: true }).fill(SERVICE_PINCODE);
  const covered = doorstep.getByText(/ is covered$/);
  const problem = doorstep.getByRole("alert").first();
  const started = Date.now();
  await doorstep.getByRole("button", { name: "Check service area" }).click();
  await expect(covered.or(problem).first()).toBeVisible({ timeout: 60_000 });
  if (await problem.isVisible()) throw new Error(`Service area check failed for PIN ${SERVICE_PINCODE}: ${oneLine(await problem.innerText())}`);
  log(`Service area verified by PIN ${SERVICE_PINCODE}: ${oneLine(await covered.innerText())} (${seconds(started)})`);
}

/** Picks the first available slot and checks live price and groomers, moving on only when no groomer is free. */
async function findLiveCare(page: Page) {
  const time = stepSection(page, /Pick a beautiful time/);
  const liveButton = time.getByRole("button", { name: /Check live price & groomers|Checking PawSpace live/ });
  const liveError = time.locator("p");
  const providersHeading = page.getByRole("heading", { name: "Available for this exact slot" });
  const dateButtons = time.getByRole("button").filter({ hasNotText: /Check live|Unavailable|Checking PawSpace/ });
  const slotButtons = time.getByRole("button", { name: /Check live groomers/ });
  let attempts = 0;
  // Index 1 is the page's own default date; the next two days are the bounded fallback.
  for (let day = 1; day <= 3 && attempts < MAX_SLOT_ATTEMPTS; day++) {
    const dateButton = dateButtons.nth(day);
    if (!(await dateButton.isVisible())) break;
    const dateLabel = oneLine(await dateButton.innerText());
    await dateButton.click();
    const slotCount = await slotButtons.count();
    for (let index = 0; index < slotCount && attempts < MAX_SLOT_ATTEMPTS; index++) {
      attempts += 1;
      const slot = slotButtons.nth(index);
      const slotLabel = oneLine(await slot.locator("span").first().innerText());
      await slot.click();
      await expect(liveButton).toBeEnabled();
      const started = Date.now();
      await liveButton.click();
      await expect(providersHeading.or(liveError).first()).toBeVisible({ timeout: LIVE_CHECK_TIMEOUT });
      if (await providersHeading.isVisible()) {
        log(`Slot ${dateLabel} ${slotLabel}: live price and groomers checked in ${seconds(started)}`);
        return;
      }
      log(`Slot ${dateLabel} ${slotLabel}: no bookable care after ${seconds(started)} - ${oneLine(await liveError.first().innerText())}`);
    }
  }
  throw new Error(`No groomer was available in the first ${attempts} available slot(s).`);
}

async function chooseFirstGroomer(page: Page) {
  const providers = stepSection(page, "Available for this exact slot");
  const first = providers.getByRole("button").first();
  const groomer = oneLine(await first.locator("b").first().innerText());
  await first.click();
  await expect(first).toContainText("✓");
  const summary = page.locator("aside");
  await expect(summary).toContainText(groomer);
  await expect(summary).toContainText("Verified live price");
  const price = /Verified live price\s*(₹\s?[\d,]+)/.exec(await summary.innerText())?.[1] ?? "shown";
  log(`Chose the first groomer ${groomer}; verified live price ${price}`);
  return groomer;
}

/** The value next to a label in the V2 grooming checkout facts. */
const checkoutFact = (checkout: Locator, label: string) =>
  checkout.locator("div").filter({ has: checkout.page().getByText(label, { exact: true }) }).last().locator("b").first();

async function reserve(page: Page) {
  const reserveButton = page.getByRole("button", { name: /Reserve & review payment/ });
  await expect(reserveButton).toBeEnabled();
  const started = Date.now();
  await reserveButton.click();
  const checkout = page.getByRole("region", { name: "Grooming checkout" });
  const reserveError = page.locator("aside").getByRole("alert").first();
  await expect(checkout.or(reserveError).first()).toBeVisible({ timeout: 150_000 });
  if (!(await checkout.isVisible())) throw new Error(`Reservation failed: ${oneLine(await reserveError.innerText())}`);
  await expect(page).toHaveURL(/[?&]bookingId=/, { timeout: 30_000 });
  bookingId = new URL(page.url()).searchParams.get("bookingId") ?? "";
  expect(bookingId, "the booking ID in the checkout URL").not.toBe("");
  test.info().annotations.push({ type: "bookingId", description: bookingId });
  await expect(checkout.getByText(bookingId, { exact: true })).toBeVisible();
  await expect(checkoutFact(checkout, "Package")).not.toHaveText("Verifying package", { timeout: 90_000 });
  log(`Reserved in ${seconds(started)}: ${await checkoutFact(checkout, "Package").innerText()} with ${await checkoutFact(checkout, "Care professional").innerText()}, ` +
    `${await checkoutFact(checkout, "Exact visit time (IST)").innerText()}, total ${await checkoutFact(checkout, "Booking total").innerText()}`);
  return checkout;
}

/** Waits for the verified doorstep and a payable booking; the panel's own polling pauses after about a minute. */
async function waitForPayable(checkout: Locator) {
  const pay = checkout.getByRole("button", { name: "Pay securely with Razorpay" });
  let doorstepRetried = false;
  const started = Date.now();
  await expect(async () => {
    const doorstep = checkout.getByRole("heading", { name: "Verify the doorstep for this booking" });
    if (!doorstepRetried && (await doorstep.isVisible())) {
      doorstepRetried = true;
      note("The doorstep was not map-verified during reservation; saving it once from the recovery form");
      await checkout.getByRole("button", { name: "Save verified doorstep" }).click();
    }
    if (await checkout.getByText(/Automatic checks have paused/).isVisible()) {
      await checkout.getByRole("button", { name: "Check verified status" }).click();
    }
    await expect(pay).toBeEnabled({ timeout: 5_000 });
  }).toPass({ timeout: 180_000, intervals: [1_000, 2_000, 5_000] });
  log(`Doorstep verified and payment available (${seconds(started)})`);
  return pay;
}

type CheckoutStep = "success" | "progress" | "idle";
type RazorpayState = { card: boolean; methodClicks: number; resubmits: number; declines: number; lastError: string };
// Short per-action timeout inside Razorpay: a surface that changed under us is retried on the next poll.
const RZP_ACTION = { timeout: 5_000 };
const CONTACT = '[data-testid="contactNumber"], input[name="contact"], input[type="tel"]';
const CARD_NUMBER = "#card_number, input[name='card[number]'], input[name='card.number'], input[autocomplete='cc-number'], input[placeholder*='card number' i]";
const CARD_EXPIRY = "#card_expiry, input[name='card[expiry]'], input[name='card.expiry'], input[autocomplete='cc-exp'], input[placeholder*='MM' i], input[placeholder*='expiry' i]";
const CARD_CVV = "#card_cvv, input[name='card[cvv]'], input[name='card.cvv'], input[autocomplete='cc-csc'], input[placeholder*='CVV' i]";
const CARD_NAME = "#card_name, input[name='card[name]'], input[name='card.name'], input[autocomplete='cc-name'], input[placeholder*='name on' i]";
const shown = (locator: Locator) => locator.isVisible().catch(() => false);

async function fillIfEmpty(field: Locator, value: string) {
  if ((await field.inputValue(RZP_ACTION).catch(() => "")) === "") await field.fill(value, RZP_ACTION);
}
async function submitCardForm(frame: Frame) {
  const submit = frame.getByRole("button", { name: /^(pay\b|pay now|continue)/i }).last();
  if (await shown(submit)) await submit.click(RZP_ACTION);
  else await frame.locator(CARD_CVV).first().press("Enter", RZP_ACTION);
}

/** One action on whichever Razorpay surface is showing; "success" once the test-bank Success is pressed. */
async function advanceRazorpay(page: Page, state: RazorpayState): Promise<CheckoutStep> {
  // The test-bank page opens as a popup window, or inside a checkout frame.
  for (const candidate of page.context().pages()) {
    for (const frame of candidate.frames()) {
      const success = frame.getByRole("button", { name: /^success$/i }).first();
      if (await shown(success)) {
        await success.click(RZP_ACTION);
        return "success";
      }
    }
  }
  const frames = page.frames().filter(frame => frame !== page.mainFrame() && /razorpay/i.test(frame.url()));
  for (const frame of frames) {
    // Checkout asks for contact details first (PawSpace sends no prefill); complete it, never click past it.
    const overlay = frame.locator('[data-testid="contact-overlay-container"]').first();
    if (await shown(overlay)) {
      const mobile = overlay.locator(CONTACT).first();
      if (await shown(mobile)) await fillIfEmpty(mobile, PHONE);
      const email = overlay.locator('input[type="email"], input[name="email"]').first();
      if (await shown(email)) await fillIfEmpty(email, CUSTOMER_EMAIL);
      await overlay.getByRole("button", { name: /^(continue|proceed)/i }).first().click(RZP_ACTION);
      return "progress";
    }
    const legacyContact = frame.locator("#contact").first();
    if ((await shown(legacyContact)) && (await legacyContact.inputValue(RZP_ACTION)) === "") {
      await legacyContact.fill(PHONE, RZP_ACTION);
      const email = frame.locator("#email").first();
      if (await shown(email)) await fillIfEmpty(email, CUSTOMER_EMAIL);
      await frame.getByRole("button", { name: /^(proceed|continue)/i }).first().click(RZP_ACTION);
      return "progress";
    }
    // Save-card offers are declined (bounded, so a persistent "Skip" control cannot stall the card entry).
    const later = frame.getByRole("button", { name: /maybe later|not now|no thanks|skip|without saving/i }).first();
    if (state.declines < 3 && (await shown(later))) {
      await later.click(RZP_ACTION);
      state.declines += 1;
      return "progress";
    }
    const number = frame.locator(CARD_NUMBER).first();
    if (!state.card && (await shown(number))) {
      await number.fill(TEST_CARD, RZP_ACTION);
      await frame.locator(CARD_EXPIRY).first().fill(TEST_EXPIRY, RZP_ACTION);
      await frame.locator(CARD_CVV).first().fill(TEST_CVV, RZP_ACTION);
      const cardholder = frame.locator(CARD_NAME).first();
      if (await shown(cardholder)) await fillIfEmpty(cardholder, CUSTOMER_NAME);
      await submitCardForm(frame);
      state.card = true;
      log(`Razorpay: entered the test card 4111 1111 1111 1111 (expiry ${TEST_EXPIRY}) and submitted it`);
      return "progress";
    }
    // Some checkouts ask for the cardholder name only after the first submit.
    const holder = frame.locator(CARD_NAME).first();
    if (state.card && state.resubmits < 2 && (await shown(holder)) && (await holder.inputValue(RZP_ACTION)) === "") {
      await holder.fill(CUSTOMER_NAME, RZP_ACTION);
      await submitCardForm(frame);
      state.resubmits += 1;
      return "progress";
    }
    if (!state.card && state.methodClicks < 2) {
      const cardMethod = frame.locator('[data-testid="card"], [data-value="card"], [method="card"]')
        .or(frame.getByRole("button", { name: /^cards?\b/i })).first();
      if (await shown(cardMethod)) {
        await cardMethod.click(RZP_ACTION);
        state.methodClicks += 1;
        return "progress";
      }
    }
  }
  return "idle";
}

async function completeRazorpayTestCheckout(page: Page, checkout: Locator) {
  const frame = page.locator("iframe.razorpay-checkout-frame, iframe[src*='razorpay']").first();
  const checkoutError = checkout.getByRole("alert").first();
  await expect(frame.or(checkoutError).first()).toBeVisible({ timeout: 60_000 });
  if (!(await frame.isVisible())) throw new Error(`Razorpay checkout did not open: ${oneLine(await checkoutError.innerText())}`);
  log("Razorpay test checkout opened");
  const state: RazorpayState = { card: false, methodClicks: 0, resubmits: 0, declines: 0, lastError: "" };
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    let step: CheckoutStep = "idle";
    try {
      step = await advanceRazorpay(page, state);
    } catch (error) {
      // Razorpay re-renders and detaches frames between screens; the next poll re-reads the surface.
      state.lastError = oneLine(error instanceof Error ? error.message : String(error)).slice(0, 240);
    }
    if (step === "success") {
      log("Razorpay: pressed Success on the test-bank page");
      return;
    }
    // Some test flows finish without a bank page; the V2 panel then already reports the verified payment.
    if (state.card && (await shown(page.getByRole("heading", { name: /Payment verified|A lovely spa day/ })))) {
      note("Razorpay returned without showing a test-bank page");
      return;
    }
    if (step === "idle") await page.waitForTimeout(500);
  }
  await snap(page, "razorpay-not-completed");
  throw new Error(`The Razorpay test-bank Success page was not reached within 3 minutes${state.lastError ? ` (last error: ${state.lastError})` : ""}.`);
}

async function pay(page: Page, checkout: Locator, payButton: Locator) {
  const started = page.waitForResponse(
    response => isPost(response, "/api/customer-checkout") && /"action":"start"/.test(response.request().postData() ?? ""),
    { timeout: 90_000 },
  );
  await payButton.click();
  const start = await started;
  if (!start.ok()) throw new Error(`Checkout could not start: ${await errorText(start)}`);
  const order = ((await start.json()) as { data?: Record<string, unknown> }).data ?? {};
  expect(order.environment, "PawSpace must open a sandbox payment").toBe("sandbox");
  expect(/^rzp_test_/.test(String(order.keyId ?? order.RAZORPAY_KEY_ID ?? "")), "Razorpay must be in test mode").toBe(true);
  log("PawSpace created a sandbox Razorpay order (test-mode key)");
  await completeRazorpayTestCheckout(page, checkout);

  const confirmed = checkout.getByText("Your grooming visit is confirmed", { exact: true });
  const began = Date.now();
  await expect(async () => {
    if (await checkout.getByText(/Automatic checks have paused/).isVisible()) {
      await checkout.getByRole("button", { name: "Check verified status" }).click();
    }
    await expect(confirmed).toBeVisible({ timeout: 10_000 });
  }).toPass({ timeout: 240_000, intervals: [2_000, 5_000] });
  log(`Payment verified and the V2 checkout shows the visit confirmed (${seconds(began)}); payment reference ${await checkoutFact(checkout, "Payment reference").innerText()}`);
  await snap(page, "v2-checkout-confirmed");
}

async function assertConfirmationPage(page: Page) {
  const began = Date.now();
  await page.goto(`/v2/booking-confirmation?bookingId=${encodeURIComponent(bookingId)}`);
  const heading = page.getByRole("heading", { level: 1, name: /booking is confirmed/i });
  await expect(heading).toBeVisible({ timeout: 120_000 });
  const details = page.getByRole("region", { name: "Booking details" });
  await expect(details).toContainText(bookingId);
  await expect(details).toContainText(/Status\s*confirmed/i);
  log(`V2 booking confirmation page shows "${oneLine(await heading.innerText())}" with status confirmed (${seconds(began)})`);
  await snap(page, "v2-booking-confirmation");
}

async function assertActivityListsBooking(page: Page, paid: boolean) {
  const link = page.locator(`a[href="/v2/booking?bookingId=${encodeURIComponent(bookingId)}"]`);
  const began = Date.now();
  await expect(async () => {
    await page.goto("/v2/activity");
    await expect(link).toBeVisible({ timeout: 30_000 });
  }).toPass({ timeout: 150_000, intervals: [2_000, 5_000] });
  const card = page.getByRole("article").filter({ has: link });
  if (paid) await expect(card).toContainText(/confirmed/i);
  log(`Activity lists the booking: ${oneLine(await card.innerText())} (${seconds(began)})`);
  await snap(page, "v2-activity");
}

test("customer: V2 grooming journey on staging", { tag: "@customer" }, async ({ page }) => {
  test.setTimeout(25 * 60_000);
  const origin = stagingOrigin();
  if (!/^[1-9]\d{5}$/.test(SERVICE_PINCODE)) throw new Error("PW_SERVICE_PINCODE must be a 6-digit Indian PIN code.");
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  rmSync(HANDOFF, { force: true });
  writeFileSync(REPORT, [
    "# PawSpace V2 staging end-to-end journey",
    "",
    `- Origin: ${origin}`,
    `- Service PIN: ${SERVICE_PINCODE}`,
    `- Run payment: ${RUN_PAYMENT}`,
    `- Synthetic customer phone: ${PHONE}`,
    `- Staff check: ${ACCESS_CODE.trim() ? "enabled (access code present)" : "skipped (no access code)"}`,
    `- Started: ${new Date().toISOString()}`,
    "",
    "## Customer",
    "",
  ].join("\n") + "\n");
  page.on("pageerror", error => note(`browser error: ${error.message}`));

  await test.step("Sign in with the on-screen sandbox OTP", async () => {
    await signInWithSandboxOtp(page);
    log(`Signed in to V2 with the sandbox OTP for ${PHONE}`);
  });

  let groomer = "";
  await test.step("Choose pet, package, doorstep, slot and groomer", async () => {
    await openGrooming(page);
    log("V2 grooming booking opened");
    await ensurePetSelected(page);
    await chooseBathAndBasic(page);
    await verifyServiceArea(page);
    await findLiveCare(page);
    groomer = await chooseFirstGroomer(page);
    await snap(page, "v2-care-plan");
  });

  const checkout = await test.step("Reserve & review payment", async () => reserve(page));
  const payButton = await test.step("Wait for a payable booking", async () => waitForPayable(checkout));
  await snap(page, "v2-checkout-ready");

  if (RUN_PAYMENT) {
    await test.step("Pay with the Razorpay test card", async () => pay(page, checkout, payButton));
    await test.step("Confirmation page shows confirmed", async () => assertConfirmationPage(page));
  } else {
    log("run_payment is false: stopped before Razorpay; the booking stays payment pending");
  }
  await test.step("Activity lists the booking", async () => assertActivityListsBooking(page, RUN_PAYMENT));

  const handoff: Handoff = { bookingId, paid: RUN_PAYMENT, origin, groomer, recordedAt: new Date().toISOString() };
  writeFileSync(HANDOFF, `${JSON.stringify(handoff, null, 2)}\n`);
  log("Customer journey complete");
});

/** Sets a controlled React input without fill()/type(), whose step titles would repeat the value. */
function setReactInputValue(element: Element, value: string) {
  const input = element as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) throw new Error("The input value setter is unavailable");
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
/** Empties every password field, so no later page snapshot or screenshot can hold the access code. */
function clearPasswordInputs(elements: Element[]) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  for (const element of elements) {
    setter?.call(element, "");
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

test("staff: Booking Command Center finds the booking", { tag: "@staff" }, async ({ page }) => {
  test.skip(!ACCESS_CODE.trim(), "PAWSPACE_UAT_ACCESS_CODE is not configured, so the optional staff check is skipped.");
  test.setTimeout(8 * 60_000);
  // A failing test normally saves an ARIA page snapshot, which includes input values. This worker runs only
  // the staff project, so switching that snapshot off here keeps the access code out of error-context files.
  process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";
  stagingOrigin();
  if (!existsSync(HANDOFF)) throw new Error("The customer journey recorded no booking to look up.");
  const handoff = JSON.parse(readFileSync(HANDOFF, "utf8")) as Handoff;
  bookingId = handoff.bookingId;
  expect(bookingId, "the booking recorded by the customer journey").not.toBe("");
  writeReportLine("\n## Staff (optional)\n");

  await test.step("Sign in at /staging-login as the operations manager", async () => {
    await page.goto("/staging-login");
    const codeField = page.getByLabel("Access code", { exact: true });
    const disabled = page.getByText("UAT sign-in is not enabled on this environment.");
    await expect(codeField.or(disabled).first()).toBeVisible({ timeout: 60_000 });
    if (await disabled.isVisible()) throw new Error("/staging-login is not enabled on this origin.");
    let signIn: Response | null = null;
    try {
      await codeField.evaluate(setReactInputValue, ACCESS_CODE.trim());
      expect(await codeField.evaluate(element => (element as HTMLInputElement).value.length > 0), "access code entered").toBe(true);
      const signedIn = page.waitForResponse(response => isPost(response, "/api/staging-login"), { timeout: 60_000 });
      await page.getByRole("button", { name: /^Manager \(operations/ }).click();
      signIn = await signedIn;
    } finally {
      // On success the page navigates away; on any failure the code must not stay in the field.
      await page.locator("input[type='password']").evaluateAll(clearPasswordInputs).catch(() => undefined);
    }
    if (signIn.status() !== 200) throw new Error(`staging-login as the seeded operations manager failed: ${await errorText(signIn)}`);
    await page.waitForURL(/\/booking-command-center/, { timeout: 60_000 });
    log("Signed in at /staging-login with the UAT access code as the seeded operations manager");
  });

  await test.step("Search the booking ID", async () => {
    await expect(page.getByRole("heading", { name: "Booking Command Center" })).toBeVisible({ timeout: 60_000 });
    const searched = page.waitForResponse(response => response.url().includes("/api/booking-command-center?q="), { timeout: 60_000 });
    await page.getByPlaceholder("Search booking, customer, pet, phone or provider").fill(bookingId);
    const search = await searched;
    expect(search.ok(), "Booking Command Center search").toBe(true);
    const row = page.getByRole("button").filter({ hasText: bookingId }).first();
    await expect(row).toBeVisible({ timeout: 60_000 });
    await row.click();
    const detail = page.locator("aside").filter({ hasText: bookingId }).first();
    await expect(detail).toBeVisible();
    const status = oneLine(await detail.getByRole("heading", { level: 2 }).first().innerText());
    log(`Booking Command Center search found the booking; status ${status}, row: ${oneLine(await row.innerText())}`);
    await snap(page, "booking-command-center");
  });
});
