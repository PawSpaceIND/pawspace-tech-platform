import fs from "node:fs";
import { chromium } from "playwright";

const arg = (name, fallback = "") => {
  const found = process.argv.find((item) => item.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};

const BASE = arg("base", process.env.PREVIEW_URL || "").replace(/\/$/, "");
const JSON_OUT = arg("json", "customer-ui-acceptance-report.json");
const PHONE = arg("phone", "9000000911");
const CUSTOMER_NAME = "UI Acceptance Customer";
const PET_NAME = "UI Test Bruno";
const PINCODE = "560034";
const ADDRESS = "12 Acceptance Road, Koramangala, Bengaluru";
const TIMEOUT = Number(arg("timeout", "15000"));

if (!BASE) throw new Error("--base or PREVIEW_URL is required");

const report = {
  generatedAt: new Date().toISOString(),
  base: BASE,
  customerPhoneSuffix: PHONE.slice(-4),
  pincode: PINCODE,
  cases: [],
  failures: [],
};

function writeReport() {
  report.summary = {
    total: report.cases.length,
    passed: report.cases.filter((item) => item.ok).length,
    failed: report.cases.filter((item) => !item.ok).length,
  };
  fs.writeFileSync(JSON_OUT, `${JSON.stringify(report, null, 2)}\n`);
}

function fail(message) {
  throw new Error(message);
}

async function caseRun(name, action) {
  const startedAt = Date.now();
  try {
    const detail = await action();
    report.cases.push({ name, ok: true, ms: Date.now() - startedAt, detail: detail || "passed" });
    console.log(`PASS ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    report.cases.push({ name, ok: false, ms: Date.now() - startedAt, detail });
    report.failures.push({ name, detail });
    console.error(`FAIL ${name} — ${detail}`);
  } finally {
    writeReport();
  }
}

async function settled(page, ms = 350) {
  await page.waitForLoadState("domcontentloaded", { timeout: TIMEOUT }).catch(() => undefined);
  await page.waitForTimeout(ms);
}

async function gotoApp(page) {
  const response = await page.goto(`${BASE}/mobile-app`, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
  if (!response || response.status() >= 500) fail(`mobile app failed to load: HTTP ${response?.status() ?? 0}`);
  await settled(page);
}

async function clickNav(page, label) {
  const button = page.getByRole("button", { name: new RegExp(`^${label}$`, "i") }).last();
  await button.waitFor({ state: "visible", timeout: TIMEOUT });
  await button.click();
  await settled(page, 250);
}

async function ensureCustomerSession(page, context) {
  await gotoApp(page);
  const session = await context.request.get(`${BASE}/api/identity-session`);
  if (session.ok()) {
    const body = await session.json().catch(() => ({}));
    if (body?.data?.subjectType === "customer") return `existing customer session ${body.data.subjectId}`;
  }

  await clickNav(page, "Account");
  const phone = page.getByPlaceholder("10-digit phone number");
  await phone.waitFor({ state: "visible", timeout: TIMEOUT });
  await phone.fill(PHONE);
  await page.getByRole("button", { name: "Send OTP" }).click();
  const sandbox = page.getByText(/Sandbox code \(no real SMS yet\):/i);
  await sandbox.waitFor({ state: "visible", timeout: TIMEOUT });
  const text = await sandbox.textContent();
  const code = text?.match(/\b(\d{6})\b/)?.[1];
  if (!code) fail("sandbox OTP code was not rendered after Send OTP");
  await page.getByPlaceholder("6-digit code").fill(code);
  await page.getByPlaceholder("Your name (first time only)").fill(CUSTOMER_NAME);
  await page.getByRole("button", { name: "Verify & continue" }).click();
  await settled(page, 500);

  const verified = await context.request.get(`${BASE}/api/identity-session`);
  const verifiedBody = await verified.json().catch(() => ({}));
  if (!verified.ok() || verifiedBody?.data?.subjectType !== "customer") {
    fail(`OTP completed but no customer platform session was established (HTTP ${verified.status()})`);
  }
  return `real sandbox OTP -> customer session ${verifiedBody.data.subjectId}`;
}

async function ensureDog(page) {
  await clickNav(page, "My Pets");
  if (await page.getByText(PET_NAME, { exact: true }).count()) return `${PET_NAME} already present`;
  const add = page.getByRole("button", { name: /Add pet/i }).first();
  await add.waitFor({ state: "visible", timeout: TIMEOUT });
  await add.click();
  await page.getByPlaceholder("Pet name").fill(PET_NAME);
  const form = page.locator("form").last();
  void form;
  const selects = page.locator("select");
  if (await selects.count() < 6) fail("pet profile form did not expose the expected governed selectors");
  await page.getByLabel("Breed").selectOption({ index: 1 });
  await page.getByLabel("Age").selectOption({ index: 1 });
  await page.getByLabel("Weight").selectOption({ index: 1 });
  await page.getByLabel("Temperament").selectOption({ index: 1 });
  await page.getByLabel("Vaccinated?").selectOption("yes");
  const gender = page.getByLabel("Gender (optional)");
  if (await gender.count()) await gender.selectOption({ index: 1 });
  await page.getByRole("button", { name: "Add pet", exact: true }).click();
  await page.getByText(PET_NAME, { exact: true }).waitFor({ state: "visible", timeout: TIMEOUT });
  return `${PET_NAME} created through customer UI`;
}

function careSection(page) {
  return page.locator("section").filter({ hasText: "Care for every kind of day" }).first();
}

async function home(page) {
  await gotoApp(page);
  await clickNav(page, "Home");
  await page.getByText("Care for every kind of day", { exact: true }).waitFor({ state: "visible", timeout: TIMEOUT });
}

async function openService(page, name) {
  await home(page);
  const button = careSection(page).getByRole("button", { name: new RegExp(name, "i") });
  if (await button.count() !== 1) fail(`${name} should have exactly one discovery card; found ${await button.count()}`);
  if (await button.isDisabled()) fail(`${name} discovery card is disabled in the release preview`);
  await button.click();
  await settled(page, 450);
}

async function expectVisible(page, text) {
  const locator = typeof text === "string" ? page.getByText(text, { exact: false }).first() : page.getByText(text).first();
  await locator.waitFor({ state: "visible", timeout: TIMEOUT });
}

async function blockNextMutation(page, button, expectedPath) {
  const attempts = [];
  const handler = async (route) => {
    const request = route.request();
    const method = request.method();
    if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      attempts.push(`${method} ${new URL(request.url()).pathname}`);
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  };
  await page.route("**/api/**", handler);
  try {
    await button.click({ timeout: TIMEOUT });
    await page.waitForTimeout(800);
  } finally {
    await page.unroute("**/api/**", handler);
  }
  if (!attempts.some((item) => expectedPath.test(item))) {
    fail(`expected mutation ${expectedPath} was not attempted; saw ${attempts.join(", ") || "none"}`);
  }
  return attempts.join(", ");
}

async function homeControls(page) {
  await home(page);
  const services = ["Grooming", "Training", "Boarding", "Pet Sitting", "Pet Taxi", "Dog Walking", "Fresh Food", "Relocation"];
  for (const name of services) {
    const card = careSection(page).getByRole("button", { name: new RegExp(name, "i") });
    if (await card.count() !== 1) fail(`${name} missing or duplicated on premium Home`);
    if (await card.isDisabled()) fail(`${name} is unexpectedly disabled on premium Home`);
  }

  const video = page.locator("section").filter({ hasText: "Watch before you book" }).first();
  const guides = video.getByRole("button", { name: /guide/i });
  if (await guides.count() !== 6) fail(`expected exactly six service video slots, found ${await guides.count()}`);

  await page.getByRole("button", { name: "Choose your service location" }).click();
  await page.getByPlaceholder("e.g. HSR Layout, Bengaluru").fill("Koramangala, Bengaluru");
  await page.getByRole("button", { name: "Save location" }).click();
  await expectVisible(page, "Koramangala, Bengaluru");

  const search = page.getByLabel("Search PawSpace services");
  await search.fill("food");
  await careSection(page).getByRole("button", { name: /Fresh Food/i }).waitFor({ state: "visible", timeout: TIMEOUT });
  if (await careSection(page).getByRole("button", { name: /Grooming/i }).count()) fail("Home search did not filter non-matching service cards");
  await search.fill("");

  await page.getByRole("button", { name: /Preview next ad/i }).click();
  await expectVisible(page, "Pet-friendly dining slot");
  await video.getByRole("button", { name: /Grooming guide/i }).click();
  const dialog = page.getByRole("dialog", { name: /Grooming video guide/i });
  await dialog.waitFor({ state: "visible", timeout: TIMEOUT });
  await dialog.getByRole("button", { name: /Close video guide/i }).click();

  await page.getByRole("button", { name: /Your bookings/i }).click();
  await settled(page, 200);
  await clickNav(page, "Home");
  await page.getByRole("button", { name: "Open pet profiles" }).click();
  await expectVisible(page, "Your pets");
  await clickNav(page, "Home");
  return "8 service cards + 6 videos + location + search + ads + bookings + pet-profile controls";
}

async function groomingJourney(page) {
  await openService(page, "Grooming");
  await expectVisible(page, "Who needs grooming?");
  await page.getByText(PET_NAME, { exact: true }).first().click();
  const next = page.getByRole("button", { name: /Choose a package/i });
  await next.waitFor({ state: "visible", timeout: TIMEOUT });
  if (await next.isDisabled()) fail("Grooming pet selection did not enable package progression");
  await next.click();
  await expectVisible(page, "Essential Bath");
  await expectVisible(page, "Bath & Basic");
  await expectVisible(page, "Complete Makeover");
  await expectVisible(page, "Just Trim");
  return "pet selection -> package stage and legacy package set rendered";
}

async function trainingJourney(page) {
  await openService(page, "Training");
  await expectVisible(page, "Build better days together.");
  const plans = page.getByRole("button", { name: /See PawSpace plans/i });
  await plans.waitFor({ state: "visible", timeout: TIMEOUT });
  if (await plans.isDisabled()) fail("Training did not auto-select the customer dog");
  await plans.click();
  await expectVisible(page, "All training programmes");
  const pin = page.getByPlaceholder("Enter six-digit PIN code").first();
  await pin.fill(PINCODE);
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "Choose trainer" }).click();
  await expectVisible(page, "Your trainer matches");
  const calendar = page.getByRole("button", { name: "Build session calendar" });
  await calendar.waitFor({ state: "visible", timeout: TIMEOUT });
  if (await calendar.isDisabled()) fail("Training coverage did not produce an eligible trainer");
  await calendar.click();
  await expectVisible(page, "Plan your sessions");
  await page.getByRole("button", { name: "Review & pay" }).click();
  await expectVisible(page, "Review your programme");
  await page.waitForTimeout(1000);
  const final = page.getByRole("button", { name: /request trainer approval|Refreshing server quote/i });
  await final.waitFor({ state: "visible", timeout: TIMEOUT });
  if (await final.isDisabled()) fail("Training final action stayed disabled after governed quote/coverage resolution");
  const attempts = await blockNextMutation(page, final, /POST \/api\/uat-scheduling/);
  return `5 stages + governed quote + final scheduler wiring (${attempts})`;
}

async function resolveAddress(page) {
  await page.getByLabel("Complete doorstep address").fill(ADDRESS);
  await page.getByPlaceholder("e.g., 560034").fill(PINCODE);
  const check = page.getByRole("button", { name: "Check", exact: true });
  await check.click();
  await expectVisible(page, "Koramangala");
}

async function stayJourney(page, sitting) {
  const name = sitting ? "Pet Sitting" : "Boarding";
  await openService(page, name);
  await expectVisible(page, sitting ? "Care at home, around their routine." : "A stay that feels like home.");
  await resolveAddress(page);
  const pet = page.getByText(PET_NAME, { exact: true }).first();
  await pet.click();
  const available = page.getByRole("button", { name: sitting ? /See available sitters/i : /See available homes/i });
  await available.waitFor({ state: "visible", timeout: TIMEOUT });
  if (await available.isDisabled()) fail(`${name} stage 1 did not become serviceable`);
  await available.click();
  await expectVisible(page, sitting ? "Choose your sitter" : "Choose your host");

  if (sitting) {
    const cardRates = await page.locator("button").filter({ hasText: "/ night" }).allTextContents();
    if (!cardRates.length) fail("Sitting caregiver cards did not render profile rate presentation for review");
    report.sittingProfileRateEvidence = cardRates.slice(0, 3).map((value) => value.replace(/\s+/g, " ").trim());
  }

  const continueButton = page.getByRole("button", { name: /Continue with/i });
  await continueButton.waitFor({ state: "visible", timeout: TIMEOUT });
  if (await continueButton.isDisabled()) fail(`${name} did not expose an eligible caregiver/host`);
  await continueButton.click();
  await expectVisible(page, "Build the Care Card");
  await page.getByRole("button", { name: "Review protected booking" }).click();
  await expectVisible(page, "Review and confirm");
  await page.waitForTimeout(900);
  const final = page.getByRole("button", { name: /create canonical stay|request final partner approval/i });
  await final.waitFor({ state: "visible", timeout: TIMEOUT });
  if (await final.isDisabled()) fail(`${name} final action stayed disabled after quote and address resolution`);
  const attempts = await blockNextMutation(page, final, /POST \/api\/(uat-scheduling|sitting-payment-sandbox|canonical-bookings)/);
  return `4 stages + caregiver + quote + final canonical wiring (${attempts})`;
}

async function walkingJourney(page) {
  await openService(page, "Dog Walking");
  await expectVisible(page, "Choose a walk package");
  const schedule = page.getByRole("button", { name: "Plan the schedule" });
  await schedule.waitFor({ state: "visible", timeout: TIMEOUT });
  if (await schedule.isDisabled()) fail("Walking catalogue did not load a selectable package");
  await schedule.click();
  await page.getByRole("button", { name: "Choose your dog" }).click();
  await expectVisible(page, "Who's walking?");
  await page.getByText(PET_NAME, { exact: true }).first().click();
  const review = page.getByRole("button", { name: "Review & confirm" });
  if (await review.isDisabled()) fail("Walking did not accept the dog profile");
  await review.click();
  await expectVisible(page, "Review your walks");
  await page.getByPlaceholder("Enter six-digit PIN code").fill(PINCODE);
  await page.waitForTimeout(1000);
  const final = page.getByRole("button", { name: /Confirm \d+ walk|Refreshing server quote/i });
  await final.waitFor({ state: "visible", timeout: TIMEOUT });
  if (await final.isDisabled()) fail("Walking final action stayed disabled after quote/coverage resolution");
  const attempts = await blockNextMutation(page, final, /POST \/api\/(walking|uat-scheduling)/);
  return `4 stages + commercial quote + final booking wiring (${attempts})`;
}

async function taxiJourney(page) {
  await openService(page, "Pet Taxi");
  await expectVisible(page, "Choose a route class");
  const route = page.getByRole("button", { name: "Set pickup & drop" });
  await route.waitFor({ state: "visible", timeout: TIMEOUT });
  if (await route.isDisabled()) fail("Taxi route catalogue did not load");
  await route.click();
  await page.getByPlaceholder("e.g. Indiranagar, 100 Feet Road").fill("Koramangala");
  await page.getByPlaceholder("e.g. Whitefield vet clinic").fill("Indiranagar Vet Clinic");
  const choose = page.getByRole("button", { name: "Choose your pet" });
  if (await choose.isDisabled()) fail("Taxi pickup/drop validation did not enable progression");
  await choose.click();
  await page.getByText(PET_NAME, { exact: true }).first().click();
  const review = page.getByRole("button", { name: "Review & confirm" });
  if (await review.isDisabled()) fail("Taxi did not accept the customer pet");
  await review.click();
  await expectVisible(page, "Review your trip");
  await page.getByPlaceholder("Enter six-digit PIN code").fill(PINCODE);
  await page.waitForTimeout(1000);
  const final = page.getByRole("button", { name: /Confirm trip|Refreshing server quote/i });
  await final.waitFor({ state: "visible", timeout: TIMEOUT });
  if (await final.isDisabled()) fail("Taxi final action stayed disabled after quote/coverage resolution");
  const attempts = await blockNextMutation(page, final, /POST \/api\/(taxi|uat-scheduling)/);
  return `4 stages + route quote + final booking wiring (${attempts})`;
}

async function foodJourney(page) {
  await openService(page, "Fresh Food");
  await expectVisible(page, "Fresh food for your pets");
  const pin = page.getByPlaceholder("Enter six-digit PIN code").first();
  await pin.fill(PINCODE);
  await page.getByRole("button", { name: "Check service area & load catalogue" }).click();
  await expectVisible(page, "Delivery coverage confirmed");
  const add = page.getByRole("button", { name: "Add", exact: true }).first();
  await add.waitFor({ state: "visible", timeout: TIMEOUT });
  await add.click();
  const cart = page.getByRole("button", { name: /Review cart/i });
  if (await cart.isDisabled()) fail("Food cart did not accept a catalogue item");
  await cart.click();
  await page.getByRole("button", { name: "Choose delivery plan" }).click();
  await page.getByRole("button", { name: "Delivery details" }).click();
  await expectVisible(page, "Where and when?");
  await page.getByPlaceholder("House, street, area").fill(ADDRESS);
  const review = page.getByRole("button", { name: "Review with server quote" });
  if (await review.isDisabled()) fail("Food delivery stage lost resolved service coverage");
  await review.click();
  await expectVisible(page, "Review and confirm");
  await expectVisible(page, "server quote");
  const final = page.getByRole("button", { name: /Confirm food order|Confirm order \+ repeat plan/i });
  if (await final.isDisabled()) fail("Food final action is disabled after server quote");
  const attempts = await blockNextMutation(page, final, /POST \/api\/food/);
  return `5 stages + catalogue + cart + server quote + final order wiring (${attempts})`;
}

async function relocationJourney(page) {
  await openService(page, "Relocation");
  await expectVisible(page, "PET RELOCATION · ENQUIRY");
  await page.getByLabel("Email").fill("ui-acceptance@pawspace.test");
  await page.getByLabel("Pickup location").fill("Koramangala, Bengaluru");
  await page.getByLabel("Drop location").fill("Indiranagar, Bengaluru");
  const final = page.getByRole("button", { name: "Request relocation plan & quote" });
  const attempts = await blockNextMutation(page, final, /POST \/api\/relocation-enquiry/);
  return `enquiry-only final endpoint wiring (${attempts}); no payment path`;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error.message).slice(0, 240)));

  try {
    await caseRun("customer OTP establishes a real platform session", () => ensureCustomerSession(page, context));
    await caseRun("customer pet profile is available", () => ensureDog(page));
    await caseRun("premium Home controls and all eight services", () => homeControls(page));
    await caseRun("Grooming customer journey", () => groomingJourney(page));
    await caseRun("Training customer journey", () => trainingJourney(page));
    await caseRun("Boarding customer journey", () => stayJourney(page, false));
    await caseRun("Pet Sitting customer journey", () => stayJourney(page, true));
    await caseRun("Dog Walking customer journey", () => walkingJourney(page));
    await caseRun("Pet Taxi customer journey", () => taxiJourney(page));
    await caseRun("Fresh Food customer journey", () => foodJourney(page));
    await caseRun("Relocation enquiry journey", () => relocationJourney(page));
    await caseRun("no uncaught browser errors", async () => {
      if (pageErrors.length) fail(pageErrors.join(" | "));
      return "no pageerror events across customer acceptance";
    });
  } finally {
    writeReport();
    await browser.close();
  }

  if (report.failures.length) {
    console.error(`Customer UI acceptance failed: ${report.failures.length} finding(s).`);
    process.exitCode = 1;
    return;
  }
  console.log(`Customer UI acceptance passed: ${report.summary.passed}/${report.summary.total} cases.`);
}

main().catch((error) => {
  report.failures.push({ name: "harness", detail: error instanceof Error ? error.message : String(error) });
  writeReport();
  console.error(error);
  process.exit(1);
});
