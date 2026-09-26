/*
 * Dog Training MASTER end-to-end acceptance against the deployed staging origin.
 *
 * Run from GitHub Actions (the only place that can reach staging and hold the UAT access code; the
 * staging worker holds the Razorpay TEST keys). Every step is soft: it records PASS / FAIL / BLOCKED /
 * INFO with evidence and the run continues, so a single defect does not hide the rest of the journey.
 * Nothing bypasses a control: customers and trainers use the sandbox OTP shown on screen, staff use
 * /staging-login with the UAT access code, payments go through the real Razorpay TEST checkout with the
 * documented test card, and maker/checker approvals are made by a different person than the uploader.
 *
 * Each paid journey uses its own new customer and browser context, so one checkout's saved state can
 * never change what the next checkout shows.
 */
import { test, devices, type Browser, type BrowserContext, type Page, type Locator, type Request as PwRequest, type Response as PwResponse } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const BASE = process.env.PW_BASE_URL || "https://pawspace-staging.karthik-fce.workers.dev";
const ACCESS_CODE = String(process.env.PAWSPACE_UAT_ACCESS_CODE || "").trim();
const OUT = process.env.MASTER_OUT || "test-results/training-master";
const SHOTS = `${OUT}/shots`;
const RUN_BASE = Date.now();
let phoneSeq = 0;
const nextPhone = () => `8${String(RUN_BASE + (phoneSeq++) * 7919).slice(-9)}`;
/**
 * A per-run first-session time, 10:00-17:00 IST in 30-minute steps, inside the 09:00-19:00 trainer roster. Every run
 * used to book 11:00 and 15:00, and unpaid staging bookings keep their trainer's slot, so those hours ran out of
 * trainers (run 36243387701: 28 Sept 11:00 had none, 29 Sept offered only one).
 */
const runSlot = (offset: number) => { const minutes = 600 + 30 * ((Math.floor(RUN_BASE / 1000) + offset) % 15); return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`; };
const MEET_TIME = runSlot(0), STARTER_TIME = runSlot(7);
const EMAIL = "uat.training.master@example.com";
const TRAINER_PHONES: Record<string, string> = {
  "PawSpace Training Team (UAT)": "9000000931", "Arjun T. (UAT East)": "9000000932", "Kavya R. (UAT South)": "9000000933",
  "Nikhil B. (UAT North)": "9000000934", "Anitha G. (UAT West)": "9000000935", "Rohan D. (UAT Central)": "9000000936",
};
const PHONE_DEVICE = devices["Pixel 7"];
mkdirSync(SHOTS, { recursive: true });

type Status = "PASS" | "FAIL" | "BLOCKED" | "INFO";
type Row = { n: number; area: string; step: string; status: Status; detail: string; shots: string[] };
const rows: Row[] = [];
const apiErrors: string[] = [];
const customers: string[] = [];
let shotNo = 0;
let pendingShots: string[] = [];
class Outcome extends Error { constructor(public status: Status, message: string) { super(message); } }
const blocked = (m: string) => new Outcome("BLOCKED", m);
const info = (m: string) => new Outcome("INFO", m);
const fail = (m: string) => new Outcome("FAIL", m);
function flush() {
  const md = ["# PawSpace staging — Dog Training master E2E", "", `- Origin: ${BASE}`, `- Run: ${new Date().toISOString()}`, `- Customers: ${customers.join(", ")}`, "",
    `| # | Area | Step | Result | Detail | Evidence |`, `|---|---|---|---|---|---|`,
    ...rows.map(r => `| ${r.n} | ${r.area} | ${r.step} | ${r.status} | ${r.detail.replace(/\|/g, "/").replace(/\n/g, " ").slice(0, 700)} | ${r.shots.map(s => s.replace(`${OUT}/`, "")).join("<br>")} |`),
    "", "## API errors observed (4xx/5xx)", "", ...apiErrors.slice(0, 250).map(e => `- ${e.replace(/\n/g, " ")}`)];
  writeFileSync(`${OUT}/report.md`, md.join("\n") + "\n");
  writeFileSync(`${OUT}/report.json`, JSON.stringify({ base: BASE, customers, rows, apiErrors }, null, 1));
}
async function step(area: string, name: string, fn: () => Promise<string | void>) {
  pendingShots = [];
  let status: Status = "PASS", detail = "";
  try { detail = String((await fn()) || ""); }
  catch (error) {
    if (error instanceof Outcome) { status = error.status; detail = error.message; }
    else { status = "FAIL"; detail = error instanceof Error ? error.message.split("\n")[0] : String(error); }
  }
  rows.push({ n: rows.length + 1, area, step: name, status, detail, shots: pendingShots });
  console.log(`[master] ${status} · ${area} · ${name} · ${detail.slice(0, 400)}`);
  flush();
  return status;
}
/** Click Send in the V2 chat; when it cannot be clicked, say why (disabled, covered, or not rendered) with a screenshot. */
async function sendChat(page: Page, label: string) {
  // V2 chat names the button "Send" since #1092; older staging builds called it "Send message".
  const send = page.getByRole("button", { name: /^Send( message)?$/ });
  try { await send.click({ timeout: 20_000 }); return; } catch {
    await shot(page, `${label}-send-blocked`);
    const why = await send.evaluate((el) => {
      const b = el as HTMLButtonElement, r = b.getBoundingClientRect(), top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return `disabled=${b.disabled} aria-disabled=${b.getAttribute("aria-disabled")} rect=${Math.round(r.top)},${Math.round(r.height)} covered-by=${top && top !== b && !b.contains(top) ? (top.tagName + "." + String(top.className).slice(0, 60) + " \"" + (top.textContent || "").trim().slice(0, 60) + "\"") : "none"}`;
    }).catch(() => "Send button not rendered");
    throw fail(`Send could not be clicked (${why}); page: ${(await mainText(page)).replace(/\n+/g, " | ").slice(0, 300)}`);
  }
}

async function shot(page: Page, name: string, fullPage = false) {
  shotNo += 1;
  const file = `${SHOTS}/${String(shotNo).padStart(3, "0")}-${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.jpg`;
  try { await page.screenshot({ path: file, fullPage, type: "jpeg", quality: 62 }); pendingShots.push(file); } catch { /* evidence is best effort */ }
}
function watchApi(page: Page, who: string) {
  page.on("response", async response => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith("/api/") || response.status() < 400) return;
    if (url.pathname === "/api/identity-session" && response.status() === 401) return;
    let body = ""; try { body = (await response.text()).slice(0, 220); } catch { /* navigated */ }
    apiErrors.push(`${who} ${response.status()} ${response.request().method()} ${url.pathname} ${body}`);
  });
}
const dialogAnswers = new WeakMap<Page, string[]>();
function answerDialogs(page: Page) {
  dialogAnswers.set(page, []);
  page.on("dialog", async dialog => {
    const queue = dialogAnswers.get(page) || [];
    const answer = queue.shift();
    if (answer === undefined) await dialog.dismiss().catch(() => {});
    else await dialog.accept(answer).catch(() => {});
  });
}
const queueAnswers = (page: Page, ...answers: string[]) => dialogAnswers.get(page)?.push(...answers);
const visible = (locator: Locator, timeout = 3000) => locator.first().waitFor({ state: "visible", timeout }).then(() => true).catch(() => false);
// After the first load networkidle has already fired and Playwright does not re-arm it, so after a client-side click
// this is a plain fixed delay. Never read a server-dependent outcome after it; wait for the outcome itself.
async function settle(page: Page, ms = 1200) { await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {}); await page.waitForTimeout(ms); }
const mainText = async (page: Page) => (await page.locator("main").first().innerText().catch(() => "")).replace(/\n+/g, " | ");
const pathOf = (url: string) => { try { return new URL(url).pathname; } catch { return ""; } };
/** What the browser shows when it gives up on a slow request: apiSend's two messages and boundedFetch's. */
const CLIENT_TIMEOUT = /took too long|couldn't reach|timed out/i;
const alertTexts = async (page: Page) => (await page.locator("[role=alert]").allInnerTexts().catch(() => [] as string[])).map(text => text.trim()).filter(Boolean);
const freshAlerts = async (page: Page, before: string[]) => (await alertTexts(page)).filter(text => !before.includes(text));
const usable = async (locator: Locator) => (await locator.first().isVisible().catch(() => false)) && (await locator.first().isEnabled({ timeout: 1000 }).catch(() => false));
const inr = (amount: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(amount);
/** Log how long each matching request took (request.timing()), so the report shows the latency staging served. */
function timeRequests(page: Page, paths: RegExp) {
  const started = Date.now(), log: string[] = [];
  const finished = async (request: PwRequest) => {
    if (!paths.test(pathOf(request.url()))) return;
    const timing = request.timing(), response = await request.response().catch(() => null);
    log.push(`${request.method()} ${pathOf(request.url())} ${response?.status() ?? "?"} in ${timing.responseEnd >= 0 ? `${Math.round(timing.responseEnd)} ms` : "n/a"} at +${Math.round(timing.startTime - started)} ms`);
  };
  const failed = (request: PwRequest) => { if (paths.test(pathOf(request.url()))) log.push(`${request.method()} ${pathOf(request.url())} FAILED ${request.failure()?.errorText || ""} at +${Date.now() - started} ms`); };
  page.on("requestfinished", finished); page.on("requestfailed", failed);
  return { log, stop: () => { page.off("requestfinished", finished); page.off("requestfailed", failed); } };
}
async function api(page: Page, path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  return page.evaluate(async ({ path, init }) => {
    const response = await fetch(path, { method: init.method || "GET", credentials: "include", headers: { "content-type": "application/json", ...(init.headers || {}) }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
    let body: unknown = null; try { body = await response.json(); } catch { /* not json */ }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- schemaless API bodies at the external test boundary
    return { status: response.status, body: body as Record<string, any> | null };
  }, { path, init });
}
function png(rgb: [number, number, number], size = 96) {
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buffer: Buffer) => { let c = 0xffffffff; for (const byte of buffer) c = table[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const length = Buffer.alloc(4); length.writeUInt32BE(data.length); const typed = Buffer.concat([Buffer.from(type), data]); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(typed)); return Buffer.concat([length, typed, sum]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 2;
  const raw = Buffer.alloc((size * 3 + 1) * size), seed = shotNo * 37 + size;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) { const o = y * (size * 3 + 1) + 1 + x * 3; raw[o] = (rgb[0] + x + seed) & 255; raw[o + 1] = (rgb[1] + y) & 255; raw[o + 2] = rgb[2]; }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// ---------------------------------------------------------------- identity
type Customer = { context: BrowserContext; page: Page; phone: string; name: string };
async function customerLogin(page: Page, phone: string, name: string) {
  await page.goto("/mobile-app"); await settle(page);
  const account = page.locator("nav").getByRole("button", { name: /account/i }).last();
  if (await visible(account, 5000)) await account.click();
  await page.getByPlaceholder("10-digit phone number").fill(phone);
  await page.getByRole("button", { name: "Send OTP" }).click();
  const sandbox = page.getByText(/Sandbox code \(no real SMS yet\):/i);
  if (!(await visible(sandbox, 20_000))) throw fail("Sandbox OTP code was not shown on screen (live OTP mode?)");
  const code = (await sandbox.textContent())?.match(/\b(\d{6})\b/)?.[1] || "";
  await page.getByPlaceholder("6-digit code").fill(code);
  const nameBox = page.getByPlaceholder("Your name (first time only)");
  if (await visible(nameBox, 1500)) await nameBox.fill(name);
  await page.getByRole("button", { name: "Verify & continue" }).click();
  for (let i = 0; i < 40; i++) { if ((await page.evaluate(() => fetch("/api/identity-session", { credentials: "include" }).then(r => r.status))) === 200) return; await page.waitForTimeout(500); }
  throw fail("Customer identity session was not established after OTP verification");
}
/** A brand-new customer in its own browser context, with a Bengaluru (560038) address and dogs. */
async function newCustomer(browser: Browser, name: string, pets: Array<{ name: string; species: string; breed: string; vaccinationStatus: string }>) {
  const phone = nextPhone(); customers.push(`${name} ${phone}`);
  const context = await browser.newContext({ ...PHONE_DEVICE, baseURL: BASE, locale: "en-IN", timezoneId: "Asia/Kolkata" });
  const page = await context.newPage(); watchApi(page, `customer:${name}`); answerDialogs(page);
  await customerLogin(page, phone, name);
  const results: string[] = [];
  const a = await api(page, "/api/customer-account", { method: "POST", body: { action: "upsert_address", idempotencyKey: `master-addr:${phone}`, address: { label: "Home", line1: "42 Indiranagar Double Road", area: "Indiranagar", city: "Bengaluru", postalCode: "560038", isDefault: true } } });
  results.push(`address ${a.status}`);
  for (const pet of pets) { const r = await api(page, "/api/customer-account", { method: "POST", body: { action: "upsert_pet", idempotencyKey: `master-pet:${phone}:${pet.name}`, pet } }); results.push(`${pet.name} ${r.status}`); }
  if (results.some(r => !/ 20[01]$/.test(r))) throw fail(`account setup: ${results.join(", ")}`);
  return { customer: { context, page, phone, name } as Customer, setup: results.join(", ") };
}
/** Same signed-in PawSpace session in a new context without any checkout.razorpay.com state. */
async function cleanCheckoutContext(browser: Browser, from: Customer): Promise<Customer> {
  const state = await from.context.storageState();
  state.cookies = state.cookies.filter(cookie => !/razorpay/i.test(cookie.domain));
  state.origins = state.origins.filter(origin => !/razorpay/i.test(origin.origin));
  const context = await browser.newContext({ ...PHONE_DEVICE, baseURL: BASE, locale: "en-IN", timezoneId: "Asia/Kolkata", storageState: state });
  const page = await context.newPage(); watchApi(page, `customer:${from.name}`); answerDialogs(page);
  return { context, page, phone: from.phone, name: from.name };
}
async function partnerLogin(page: Page, phone: string, path = "/partner-app", beforeVerify?: () => void) {
  await page.goto(path); await settle(page);
  await page.getByPlaceholder("10-digit phone number").fill(phone);
  await page.getByRole("button", { name: "Send OTP" }).click();
  const sandbox = page.getByText(/Sandbox code \(no real SMS yet\):/i);
  if (!(await visible(sandbox, 20_000))) throw fail("Partner sandbox OTP code was not shown on screen");
  const code = (await sandbox.textContent())?.match(/\b(\d{6})\b/)?.[1] || "";
  await page.getByPlaceholder("6-digit code").fill(code);
  const nameBox = page.getByPlaceholder("Your name (first time only)");
  if (await visible(nameBox, 1500)) await nameBox.fill("UAT Trainer");
  beforeVerify?.();
  await page.getByRole("button", { name: "Verify & continue" }).click();
  for (let i = 0; i < 40; i++) {
    const r = await page.evaluate(() => fetch("/api/identity-session", { credentials: "include" }).then(async r => ({ s: r.status, b: await r.json().catch(() => null) })));
    if (r.s === 200) return String(r.b?.data?.subjectId || "");
    await page.waitForTimeout(500);
  }
  throw fail("Partner identity session was not established");
}
async function staffLogin(page: Page, email: string) {
  if (!ACCESS_CODE) throw blocked("PAWSPACE_UAT_ACCESS_CODE secret is not available to this run");
  await page.goto("/staging-login"); await settle(page);
  const signOut = page.getByRole("button", { name: "sign out" });
  if (await visible(signOut, 2500)) { await signOut.click(); await settle(page, 1500); }
  await page.getByPlaceholder("shared UAT access code").fill(ACCESS_CODE);
  await page.getByPlaceholder(/seeded staff email/).fill(email);
  const response = page.waitForResponse(r => r.url().includes("/api/staging-login") && r.request().method() === "POST", { timeout: 20_000 }).catch(() => null);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const r = await response;
  if (!r || r.status() !== 200) throw fail(`Staff sign-in for ${email} returned ${r?.status() ?? "no response"}`);
  await settle(page, 800);
}

// ---------------------------------------------------------------- Razorpay TEST checkout
async function frameText(page: Page) {
  for (const f of page.frames()) if (/razorpay/i.test(f.url())) { const t = await f.locator("body").innerText().catch(() => ""); if (t.trim()) return t.replace(/\s+/g, " ").slice(0, 600); }
  return "(no Razorpay frame text)";
}
async function payRazorpay(page: Page, contactPhone: string) {
  const selector = "iframe.razorpay-checkout-frame, iframe[src*='razorpay']";
  if (!(await visible(page.locator(selector), 45_000))) { await shot(page, "razorpay-not-open"); throw fail("Razorpay checkout did not open"); }
  const frame = page.frameLocator(selector).first();
  await page.waitForTimeout(2500);
  const contact = frame.locator("#contact, input[name='contact'], input[type='tel']");
  if (await visible(contact, 8000)) {
    if (!(await contact.first().inputValue().catch(() => ""))) await contact.first().fill(contactPhone);
    const email = frame.locator("#email, input[type='email']"); if (await visible(email) && !(await email.first().inputValue().catch(() => ""))) await email.first().fill(EMAIL);
    const next = frame.getByRole("button", { name: /continue|proceed|next/i }); if (await visible(next, 5000)) await next.first().click();
    await page.waitForTimeout(1500);
  }
  for (const tile of [frame.locator("[data-value='card'],[data-method='card']"), frame.getByRole("button", { name: /^cards?(\s|$)/i }), frame.getByRole("button", { name: /credit|debit/i }), frame.getByText(/^cards?$/i), frame.getByText(/^card$/i)]) {
    if (await visible(tile)) { await tile.first().click().catch(() => {}); break; }
  }
  for (const other of [frame.getByText(/add (a )?new card/i), frame.getByText(/use (a |another |different )?(new )?card/i), frame.getByText(/pay (using|with) (a )?new card/i)]) {
    if (await visible(other, 1500)) { await other.first().click().catch(() => {}); break; }
  }
  const number = frame.locator("#card_number,input[name='card[number]'],input[autocomplete='cc-number'],input[placeholder*='card number' i]");
  if (!(await visible(number, 20_000))) { await shot(page, "razorpay-no-card-form"); throw fail(`Razorpay card form did not appear. Checkout showed: ${await frameText(page)}`); }
  await number.first().fill("4111111111111111");
  await frame.locator("#card_expiry,input[name='card[expiry]'],input[autocomplete='cc-exp'],input[placeholder*='MM' i]").first().fill("12/29");
  await frame.locator("#card_cvv,input[name='card[cvv]'],input[autocomplete='cc-csc'],input[placeholder*='CVV' i]").first().fill("123");
  const popupPromise = page.context().waitForEvent("page", { timeout: 25_000 }).catch(() => null);
  const payButton = () => frame.getByRole("button", { name: /^pay\b|pay ₹|pay now|^continue$/i }).last();
  await payButton().click();
  for (let i = 0; i < 3; i++) {
    await page.waitForTimeout(1500); let filled = false;
    const holder = frame.getByPlaceholder(/name on (your )?card/i).or(frame.locator("#card_name,input[name='card[name]']"));
    if (await visible(holder) && !(await holder.first().inputValue().catch(() => ""))) { await holder.first().fill("UAT Training Master"); filled = true; }
    const email = frame.getByPlaceholder(/email/i).or(frame.locator("#email,input[type='email']"));
    if (await visible(email) && !(await email.first().inputValue().catch(() => ""))) { await email.first().fill(EMAIL); filled = true; }
    if (!filled) break;
    if (await visible(payButton(), 3000)) await payButton().click().catch(() => {});
  }
  const decline = async () => { const later = frame.getByRole("button", { name: /maybe later|no thanks|not now|skip/i }); if (await visible(later, 4000)) { await later.first().click().catch(() => {}); return true; } return false; };
  await decline();
  const popup = await popupPromise;
  const pressSuccess = async () => {
    if (popup) { const b = popup.getByRole("button", { name: /^success$/i }).first(); if (await b.waitFor({ state: "visible", timeout: 1500 }).then(() => true).catch(() => false)) { await b.click(); return true; } }
    const inCheckout = frame.getByRole("button", { name: /^success$/i }).first(); if (await inCheckout.waitFor({ state: "visible", timeout: 1500 }).then(() => true).catch(() => false)) { await inCheckout.click(); return true; }
    for (const f of page.frames()) { const b = f.getByRole("button", { name: /^success$/i }).first(); if (await b.waitFor({ state: "visible", timeout: 700 }).then(() => true).catch(() => false)) { await b.click(); return true; } }
    return false;
  };
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) { if (await pressSuccess()) return; if (await decline()) continue; await page.waitForTimeout(1200); }
  await shot(page, "razorpay-no-success-control");
}
async function checkoutStatus(page: Page, bookingId: string) {
  const r = await api(page, "/api/customer-checkout", { method: "POST", body: { action: "status", bookingId } });
  return { http: r.status, status: String(r.body?.data?.status || r.body?.data?.paymentStatus || ""), data: r.body?.data };
}
async function waitCaptured(page: Page, bookingId: string, ms = 120_000) {
  const until = Date.now() + ms; let last = { http: 0, status: "", data: null as unknown };
  while (Date.now() < until) { last = await checkoutStatus(page, bookingId); if (/captured|paid|settled/i.test(last.status)) return last; await page.waitForTimeout(4000); }
  return last;
}
async function fundingState(page: Page, bookingId: string) {
  const programme = await api(page, `/api/training-programmes?bookingId=${encodeURIComponent(bookingId)}`);
  return String(programme.body?.data?.payment?.status || programme.body?.data?.paymentState?.status || "");
}

// ---------------------------------------------------------------- V2 Training booking
async function v2Choose(page: Page, input: { pkg: RegExp; dogs: string[]; mode?: "split" | "prepaid"; cadence?: string; time: string; trainers: RegExp[]; label: string; requireKnownTrainer?: boolean }) {
  await page.goto("/v2/training"); await settle(page, 2500);
  const group = page.getByRole("group", { name: /Dogs/ });
  await group.getByRole("button").first().waitFor({ timeout: 30_000 });
  for (const button of await group.getByRole("button").all()) {
    const name = (await button.innerText()).split("\n")[0].trim(); const want = input.dogs.includes(name), on = (await button.getAttribute("aria-pressed")) === "true";
    if (want !== on) { await button.click(); await page.waitForTimeout(300); }
  }
  await page.getByRole("button", { name: input.pkg }).first().click();
  if (input.cadence) await page.locator("select").first().selectOption(input.cadence).catch(() => {});
  if (input.mode) await page.locator("select").nth(1).selectOption(input.mode).catch(() => {});
  await page.getByLabel("First session time (IST)").fill(input.time).catch(() => {});
  const reserve = page.getByRole("button", { name: /Reserve trainer/ });
  const trainerSection = page.locator("section").filter({ hasText: "3. Available trainer" }).first();
  for (let offset = 2; offset <= 18; offset++) {
    const date = new Date(Date.now() + offset * 86_400_000 + 330 * 60_000).toISOString().slice(0, 10);
    await page.getByLabel("First session date").fill(date);
    const until = Date.now() + 40_000;
    while (Date.now() < until) {
      const text = await trainerSection.innerText().catch(() => "");
      if (/No available trainer/i.test(text)) break;
      if (await reserve.isEnabled().catch(() => false) && !/Checking availability/.test(text)) {
        const choices = trainerSection.getByRole("button").filter({ hasText: /★/ });
        // A trainer without a UAT phone cannot sign in to run the lifecycle, so optionally try the next date instead.
        for (const preference of input.requireKnownTrainer ? input.trainers : [...input.trainers, /./]) {
          const wanted = choices.filter({ hasText: preference });
          if (await wanted.count()) { await wanted.first().click(); await page.waitForTimeout(600); return { date, trainerText: (await wanted.first().innerText()).split("\n")[0].trim() }; }
        }
        break;
      }
      await page.waitForTimeout(600);
    }
  }
  throw fail(`No date in the next 18 days had a trainer available for ${input.label}`);
}
const isCreate = (request: PwRequest) => request.method() === "POST" && pathOf(request.url()) === "/api/canonical-bookings";
/** The reserve itself: a trainer preview is the same POST /api/uat-scheduling with action "preview". */
const isReserve = (request: PwRequest) => request.method() === "POST" && pathOf(request.url()) === "/api/uat-scheduling" && !/"action":"preview"/.test(request.postData() || "");
/**
 * Click the reserve button and report what actually happened. apiSend gives up on the create after 20 s, and an
 * aborted fetch never raises a "response" event, so a bare waitForResponse turned a slow staging create into a
 * 120 s timeout with no evidence (run 36243387701, where staging took about 0.26-0.4 s per D1 round trip). Race the
 * create's response against a failed reserve or create request and a new alert. A client-side timeout is a
 * staging-latency failure, never a pass and never a product refusal.
 */
async function createBooking(page: Page, label: string, click: () => Promise<void>) {
  const started = Date.now(), ms = () => Date.now() - started;
  const before = await alertTexts(page);
  const reserves: string[] = [], failed: string[] = []; let createSent = -1, settled = false;
  const onRequest = (request: PwRequest) => { if (isCreate(request) && createSent < 0) createSent = ms(); };
  const onResponse = (response: PwResponse) => { if (isReserve(response.request())) reserves.push(`${response.status()} at ${ms()} ms`); };
  const onFailed = (request: PwRequest) => { if (isReserve(request) || isCreate(request)) failed.push(`${pathOf(request.url())} ${request.failure()?.errorText || "failed"} at ${ms()} ms`); };
  page.on("request", onRequest); page.on("response", onResponse); page.on("requestfailed", onFailed);
  const timing = () => `reserve ${reserves.join(", ") || "no response"} · create ${createSent < 0 ? "not sent" : `sent at ${createSent} ms`}`;
  try {
    const created = page.waitForResponse(r => isCreate(r.request()), { timeout: 120_000 }).then(response => ({ response })).catch(() => null);
    const aborted = page.waitForEvent("requestfailed", { predicate: r => isReserve(r) || isCreate(r), timeout: 120_000 }).then(() => ({ aborted: true })).catch(() => null);
    const alerted = (async () => { while (!settled && ms() < 120_000) { await page.waitForTimeout(500).catch(() => {}); if ((await freshAlerts(page, before)).length) return { alert: true }; } return null; })();
    await click();
    const first = await Promise.race([created, aborted, alerted]);
    settled = true;
    if (first && "response" in first) {
      const body = await first.response.json().catch(() => null) as { data?: { bookingId?: string }; error?: string } | null;
      if (first.response.status() === 201 && body?.data?.bookingId) return { bookingId: body.data.bookingId, timing: `${timing()}, answered 201 at ${ms()} ms` };
      await shot(page, `${label}-create-refused`);
      throw fail(`${label}: booking create ${first.response.status()} ${JSON.stringify(body).slice(0, 200)} · ${timing()} · ${await committedAnyway(page)}`);
    }
    // A failed request lands a moment before the page shows its alert, so give the alert a few seconds.
    let alerts = await freshAlerts(page, before);
    for (let i = 0; i < 10 && first && !alerts.length; i++) { await page.waitForTimeout(500); alerts = await freshAlerts(page, before); }
    await shot(page, `${label}-reserve-failed`);
    const verdict = failed.length || alerts.some(text => CLIENT_TIMEOUT.test(text)) ? "the browser gave up waiting: a client-side timeout on staging (latency), not a product refusal"
      : alerts.length ? "refused before a booking was created" : "no create response, failed request or alert within 120 s";
    const detail = `${verdict} · alert ${JSON.stringify(alerts)} · failed requests [${failed.join("; ")}] · ${timing()} · ${ms()} ms after the click`;
    throw fail(`${label}: ${detail} · ${createSent < 0 ? "no create was sent" : await committedAnyway(page)}`);
  } finally {
    settled = true;
    page.off("request", onRequest); page.off("response", onResponse); page.off("requestfailed", onFailed);
  }
}
/** After a failed create: did the server commit the booking anyway? An unpaid orphan keeps its trainer's slot. */
async function committedAnyway(page: Page) {
  // Every journey signs in a brand-new customer, so any Training booking on the account came from this attempt.
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await page.waitForTimeout(15_000);
      const account = await api(page, "/api/customer-account");
      if (account.status !== 200) return `server check: customer-account ${account.status}`;
      const bookings = ((account.body?.data?.bookings || []) as Array<{ id: string; serviceCode: string; packageName: string; status: string; scheduledStart: string }>).filter(booking => booking.serviceCode === "dog_training");
      if (!bookings.length) continue;
      const programme = await api(page, `/api/training-programmes?bookingId=${encodeURIComponent(bookings[0].id)}`);
      return `server committed it anyway: ${bookings.map(booking => `${booking.id} ${booking.packageName} ${booking.status} ${booking.scheduledStart}`).join(", ")}; programme read ${programme.status} ${programme.body?.data?.programme?.status || programme.body?.error || ""}`.trim();
    }
    return "server check: no Training booking on the customer's account 30 s later";
  } catch (error) { return `server check failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`; }
}
/** After the create the page prepares the programme (POST /api/training-programmes, also under apiSend's 20 s deadline). */
async function awaitPayButton(page: Page, label: string, made: { bookingId: string; timing: string }) {
  if (await visible(page.getByRole("button", { name: /^Pay securely/ }), 60_000)) return made;
  await shot(page, `${label}-no-pay-button`);
  const alerts = await alertTexts(page);
  throw fail(`${label}: booking ${made.bookingId} was created (${made.timing}) but no "Pay securely" button appeared within 60 s${alerts.some(text => CLIENT_TIMEOUT.test(text)) ? ": a client-side timeout on staging (latency), not a refusal" : ""} · alert ${JSON.stringify(alerts)}`);
}
async function v2Reserve(page: Page, label: string) {
  return awaitPayButton(page, label, await createBooking(page, label, () => page.getByRole("button", { name: /Reserve trainer/ }).click()));
}
async function payOnPage(page: Page, contactPhone: string, bookingId: string, label: string) {
  // A first payment reads "Pay securely · ₹…"; a split's outstanding balance reads "Pay balance · ₹…" (#1098).
  const pay = page.getByRole("button", { name: /^Pay (securely|balance)/ });
  if (!(await visible(pay, 30_000))) { await shot(page, `${label}-no-pay-button`); throw fail(`${label}: no "Pay securely" or "Pay balance" button (${(await mainText(page)).slice(0, 200)})`); }
  const payLabel = (await pay.first().innerText()).trim();
  await shot(page, `${label}-payment-page`);
  await pay.first().click();
  await payRazorpay(page, contactPhone);
  const status = await waitCaptured(page, bookingId);
  await settle(page, 2000); await shot(page, `${label}-after-razorpay`);
  if (!/captured|paid|settled/i.test(status.status)) throw fail(`${label}: ${payLabel} → payment status after Razorpay "${status.status}" (http ${status.http})`);
  return `${payLabel} → ${status.status}`;
}
async function confirmScreen(page: Page, heading: RegExp) {
  const check = page.getByRole("button", { name: "Check payment status" }); if (await visible(check, 15_000)) await check.click().catch(() => {});
  const refresh = page.getByRole("button", { name: "Refresh confirmation" });
  const until = Date.now() + 90_000;
  while (Date.now() < until) {
    if (await visible(page.getByRole("heading", { name: heading }), 2000)) return true;
    if (await visible(refresh, 500)) await refresh.click().catch(() => {});
    await page.waitForTimeout(2000);
  }
  return false;
}

// ---------------------------------------------------------------- trainer helpers
/**
 * Open (or reload) the trainer workspace on one session and wait until that session is rendered. The page shows only
 * "Loading trainer workspace…" until identity, sessions and photos have loaded, about 55 sequential D1 round trips:
 * 18-24 s on staging in run 36243387701, longer than the fixed wait that read it.
 */
async function openTrainerSession(page: Page, bookingId: string, sessionId: string, reload = false) {
  const started = Date.now(), ms = () => Date.now() - started;
  if (reload) await page.reload(); else await page.goto(`/trainer?bookingId=${encodeURIComponent(bookingId)}&sessionId=${encodeURIComponent(sessionId)}`);
  const loaded = await page.getByRole("heading", { name: "Loading trainer workspace…" }).waitFor({ state: "detached", timeout: 120_000 }).then(() => true).catch(() => false);
  const head = page.getByText(`${sessionId} · Booking ${bookingId}`);
  // Whatever the workspace settles on: this session, another one, no sessions, or the sign-in refusal.
  const shown = head.or(page.getByText(/ · Booking /)).or(page.getByText("No Training sessions are currently assigned")).or(page.getByRole("heading", { name: "Trainer sign-in required" }));
  if (loaded && await visible(shown, Math.max(5000, 120_000 - ms())) && await visible(head, 1000)) return ms();
  await shot(page, `trainer-${sessionId}-not-open`);
  throw fail(`Trainer workspace ${loaded ? `does not show ${sessionId} · Booking ${bookingId}` : "still shows \"Loading trainer workspace…\""} after ${ms()} ms: ${(await mainText(page)).slice(0, 250)}`);
}
/** The workspace disables every action, and its ledger "Refresh", while an action or its follow-up refresh runs. */
const ledgerRefresh = (page: Page) => page.getByRole("button", { name: "Refresh", exact: true });
async function workspaceIdle(page: Page, timeout = 120_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await usable(ledgerRefresh(page))) return true; await page.waitForTimeout(500); }
  return false;
}
/** check()/fill() only a rendered control: an absent label would otherwise burn the 20 s actionTimeout each time. */
async function checkIfShown(page: Page, label: string) { const box = page.getByLabel(label); if (await box.count()) await box.first().check().catch(() => {}); }
async function fillIfShown(page: Page, label: string, value: string) { const box = page.getByLabel(label); if (await box.count()) await box.first().fill(value).catch(() => {}); }
async function sessionAction(page: Page, name: string) {
  const started = Date.now(), ms = () => Date.now() - started;
  const button = page.getByRole("button", { name, exact: true }).first();
  // Wait up to 60 s for the action to become usable. Once the workspace has sat idle for 10 s without it, only
  // another action could enable it, so stop there instead of waiting out the minute.
  for (let idleSince = 0; !(await usable(button));) {
    idleSince = (await usable(ledgerRefresh(page))) ? idleSince || Date.now() : 0;
    if (ms() > 60_000 || (idleSince && Date.now() - idleSince > 10_000)) return { status: 0, body: `button "${name}" not available (${(await button.count()) ? "disabled" : "not shown"} after ${ms()} ms)`, ms: ms() };
    await page.waitForTimeout(500);
  }
  const posted = Date.now();
  const isAction = (request: PwRequest) => request.method() === "POST" && pathOf(request.url()) === "/api/training-sessions";
  const response = page.waitForResponse(r => isAction(r.request()), { timeout: 90_000 }).then(r => ({ r })).catch(() => null);
  const aborted = page.waitForEvent("requestfailed", { predicate: isAction, timeout: 90_000 }).then(request => ({ failure: request.failure()?.errorText || "failed" })).catch(() => null);
  await button.click();
  const first = await Promise.race([response, aborted]);
  // The action is over when the ledger Refresh is usable again: `busy` holds every button through the post-action refresh.
  const tail = (await workspaceIdle(page, 120_000)) ? "" : " (workspace still busy 120 s later)";
  if (first && "r" in first) return { status: first.r.status(), body: `${(await first.r.text().catch(() => "")).slice(0, 300)}${tail}`, ms: ms() };
  const alerts = await alertTexts(page);
  const why = !first ? "no answer to POST /api/training-sessions within 90 s"
    : `the browser gave up on POST /api/training-sessions after ${Date.now() - posted} ms (${first.failure})${/ABORTED/i.test(first.failure) || alerts.some(text => CLIENT_TIMEOUT.test(text)) ? ": a client-side timeout on staging (latency), not a refusal" : ""}`;
  return { status: 0, body: `${why}; alert ${JSON.stringify(alerts)}${tail}`, ms: ms() };
}
function metersFrom(latitude: number, longitude: number, lat0: number, lng0: number) {
  return { x: (longitude - lng0) * Math.cos(lat0 * Math.PI / 180) * 111_320, y: (latitude - lat0) * 110_540 };
}
async function arriveProbe(page: Page, sessionId: string, latitude: number, longitude: number) {
  const r = await api(page, "/api/training-sessions", { method: "POST", body: { sessionId, action: "arrive", latitude, longitude, idempotencyKey: `master-probe:${sessionId}:${Date.now()}:${Math.random()}` } });
  const message = String(r.body?.error || ""); const meters = Number(message.match(/You are (\d+)m/)?.[1] ?? NaN);
  return { status: r.status, message, meters };
}
/** Locate the doorstep the server geofences against, from three refused arrival probes (distance only). */
async function locateDoorstep(page: Page, sessionId: string, guess: { latitude: number; longitude: number }) {
  const p0 = await arriveProbe(page, sessionId, guess.latitude, guess.longitude);
  if (p0.status === 200) return { ...guess, arrivedByProbe: true };
  if (!Number.isFinite(p0.meters)) throw fail(`Arrival refused for a non-geofence reason: ${p0.status} ${p0.message}`);
  const d = 0.02;
  const p1 = await arriveProbe(page, sessionId, guess.latitude, guess.longitude + d);
  const p2 = await arriveProbe(page, sessionId, guess.latitude + d, guess.longitude);
  if ([p1, p2].some(p => p.status === 200)) return { ...guess, arrivedByProbe: true };
  const x1 = metersFrom(guess.latitude, guess.longitude + d, guess.latitude, guess.longitude).x, y2 = metersFrom(guess.latitude + d, guess.longitude, guess.latitude, guess.longitude).y;
  const x = (p0.meters ** 2 - p1.meters ** 2 + x1 ** 2) / (2 * x1), y = (p0.meters ** 2 - p2.meters ** 2 + y2 ** 2) / (2 * y2);
  return { latitude: guess.latitude + y / 110_540, longitude: guess.longitude + x / (Math.cos(guess.latitude * Math.PI / 180) * 111_320), arrivedByProbe: false };
}
async function uploadEvidence(page: Page) {
  const results: string[] = [];
  for (const [label, rgb] of [["Before photo", [200, 90, 40]], ["After photo", [30, 150, 210]]] as const) {
    const input = page.getByLabel(label, { exact: true });
    if (!(await input.count())) { results.push(`${label}: input missing`); continue; }
    // The workspace ignores a photo chosen while it is busy, so start each upload from an idle workspace.
    await workspaceIdle(page);
    const response = page.waitForResponse(r => r.url().includes("/api/training-session-media") && r.request().method() === "POST", { timeout: 90_000 }).catch(() => null);
    await input.setInputFiles({ name: `${label.replace(/\W/g, "-").toLowerCase()}.png`, mimeType: "image/png", buffer: png(rgb as unknown as [number, number, number]) });
    const r = await response; results.push(`${label}: ${r?.status() ?? "no request"}`);
    await workspaceIdle(page);
  }
  return results.join("; ");
}
async function approveProof(staff: Page, bookingId: string) {
  await staff.goto("/control"); await settle(staff, 2500);
  const lifecycle = staff.getByRole("button", { name: /Customer booking lifecycle/i }).or(staff.getByRole("link", { name: /Customer booking lifecycle/i }));
  if (await lifecycle.count()) { await lifecycle.first().click(); await settle(staff, 2500); }
  const region = staff.getByRole("region", { name: "Service proof awaiting review" });
  if (!(await visible(region, 20_000))) throw fail("Service proof review panel not visible in Control");
  const refresh = region.getByRole("button", { name: "Refresh" }); if (await refresh.count()) { await refresh.click(); await settle(staff, 1500); }
  let approved = 0; const notes: string[] = [];
  for (let i = 0; i < 4; i++) {
    const article = region.locator("article").filter({ hasText: bookingId }).filter({ has: staff.getByRole("button", { name: /^Approve/ }) }).first();
    if (!(await article.count())) break;
    const reason = article.locator("input, textarea").first(); if (await reason.count()) await reason.fill("Session photo matches the booking — QA master approval");
    const response = staff.waitForResponse(r => r.url().includes("/api/service-media") && r.request().method() === "PATCH", { timeout: 20_000 }).catch(() => null);
    await article.getByRole("button", { name: /^Approve/ }).first().click();
    const r = await response; notes.push(`${r?.status()}`); if (r?.status() === 200) approved++;
    await settle(staff, 1500);
  }
  await shot(staff, `proof-review-${bookingId}`);
  return { approved, notes: notes.join(",") };
}
async function completeViaApi(page: Page, sessionId: string, homework: string) {
  const media = await api(page, `/api/training-session-media?sessionId=${encodeURIComponent(sessionId)}`);
  const assets = (media.body?.data?.assets || media.body?.assets || []) as Array<{ proofReady?: boolean; ref?: string }>;
  const report = { attendance: { mode: "parent", parentOrCaretakerConfirmed: true, safeAreaConfirmed: true }, homework, progress: { focus: 8, recall: 7, impulse: 7, parent: 8 }, evidenceRefs: assets.filter(a => a.proofReady).map(a => a.ref) };
  return api(page, "/api/training-sessions", { method: "POST", body: { sessionId, action: "complete", report, idempotencyKey: `master-complete:${sessionId}:${Date.now()}` } });
}

// ================================================================= the journeys
test("Dog Training master E2E on staging", async ({ browser }) => {
  test.setTimeout(80 * 60_000);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- shared, schemaless journey state
  const state: Record<string, any> = {};
  const staffContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, baseURL: BASE, locale: "en-IN", timezoneId: "Asia/Kolkata" });
  const staff = await staffContext.newPage(); watchApi(staff, "staff"); answerDialogs(staff);
  const open: BrowserContext[] = [staffContext];
  let A: Customer | null = null, B: Customer | null = null, C: Customer | null = null;
  let trainer: Page | null = null, trainerContext: BrowserContext | null = null;
  try {
    // ================= Journey A: Meet & Greet (₹500 prepaid) + discovery, maps, pricing, coupons
    await step("Customer", "Customer A: sandbox OTP sign-in + address (560038) + 3 dogs + 1 cat", async () => {
      const made = await newCustomer(browser, "Master A", [{ name: "Bruno", species: "dog", breed: "Labrador Retriever", vaccinationStatus: "verified" }, { name: "Coco", species: "dog", breed: "Beagle", vaccinationStatus: "verified" }, { name: "Max", species: "dog", breed: "German Shepherd", vaccinationStatus: "pending" }, { name: "Whiskers", species: "cat", breed: "Persian", vaccinationStatus: "verified" }]);
      A = made.customer; open.push(A.context);
      await A.page.goto("/v2/account"); await settle(A.page, 2000); await shot(A.page, "customer-a-account");
      return `${A.phone} · ${made.setup}`;
    });
    if (!A) throw new Error("Customer A could not be created; nothing further can run");
    const a = A as Customer;
    await step("Maps", "Google Places autocomplete, place resolve, reverse geocode", async () => {
      const search = await api(a.page, `/api/address-autocomplete?mode=search&query=${encodeURIComponent("42 Indiranagar Double Road Bengaluru")}`);
      const data = search.body?.data; const first = data?.suggestions?.[0];
      if (data?.status !== "configured" || !first) throw fail(`search ${search.status} status=${data?.status} error=${data?.error || ""}`);
      const resolved = await api(a.page, `/api/address-autocomplete?mode=resolve&placeId=${encodeURIComponent(first.placeId)}`);
      const r = resolved.body?.data; if (r?.status === "configured" && Number.isFinite(r.latitude)) state.doorGuess = { latitude: Number(r.latitude), longitude: Number(r.longitude) };
      const reverse = await api(a.page, "/api/address-autocomplete?mode=reverse&latitude=12.9352&longitude=77.6245");
      return `${data.suggestions.length} suggestion(s); first="${first.fullText}"; resolve=${r?.status} ${r?.latitude},${r?.longitude}; reverse(Koramangala)=${reverse.body?.data?.status} "${reverse.body?.data?.address || reverse.body?.data?.error || ""}"`;
    });
    await step("Maps", "Service zone by PIN (serviceable and not)", async () => {
      const out: string[] = [];
      for (const pin of ["560038", "560068", "560001", "560102", "110001", "12345"]) { const z = await api(a.page, `/api/service-zone?pincode=${pin}`); out.push(`${pin}=${z.status}:${z.body?.data?.zone?.zoneId || z.body?.error || ""}`); }
      if (!out[0].includes("blr-east")) throw fail(out.join(" · "));
      return out.join(" · ");
    });
    await step("Pricing", "Catalogue + quote matrix (8 packages × prepaid/split × 1/4/5 dogs)", async () => {
      const catalogue = await api(a.page, "/api/training-commercial");
      const packages = (catalogue.body?.data?.packages || []) as Array<{ package_code: string; name: string; base_price: number }>;
      const start = new Date(Date.now() + 5 * 86_400_000); start.setUTCHours(5, 30, 0, 0);
      const cells: string[] = [];
      for (const p of packages) for (const mode of ["prepaid", "split"]) for (const petCount of [1, 4, 5]) {
        const q = await api(a.page, "/api/training-commercial", { method: "POST", body: { packageCode: p.package_code, petCount, scheduledStart: start.toISOString(), paymentMode: mode } });
        cells.push(`${p.package_code}/${mode}/${petCount}: ${q.status === 201 ? `₹${q.body?.data?.totalAmount} due ₹${q.body?.data?.amountDueNow} ${q.body?.data?.minutesPerSession}m` : `${q.status} ${q.body?.error}`}`);
      }
      return `${packages.length} packages: ${packages.map(p => `${p.name} ₹${p.base_price}`).join(", ")} || ${cells.join(" ; ")}`;
    });
    await step("Pricing", "Training coupon (UATCARE100 / WELCOME) on the Training quote", async () => {
      const start = new Date(Date.now() + 5 * 86_400_000); start.setUTCHours(5, 30, 0, 0);
      // Same contract as the app's review step: the governed coupon engine prices the code for this customer
      // first, and the Training quote honours that governed coupon quote (couponQuoteId), never a bare code.
      const customerId = String((await api(a.page, "/api/identity-session")).body?.data?.subjectId || "");
      const catalogue = await api(a.page, "/api/training-commercial");
      const price = Number(((catalogue.body?.data?.packages || []) as Array<{ package_code: string; base_price: number }>).find(p => p.package_code === "training-8-basic")?.base_price || 0);
      const out: string[] = [];
      for (const code of ["UATCARE100", "WELCOME"]) {
        const governed = await api(a.page, "/api/coupon-governance", { method: "POST", body: { action: "quote", input: { code, customerId, serviceCode: "dog_training", cityId: "blr", channel: "customer_app", packageCode: "training-8-basic", orderValue: price, paymentMode: "full", isSubscription: false } } });
        if (governed.status !== 200) { out.push(`${code}: coupon ${governed.status} ${governed.body?.error || governed.body?.data?.error}`); continue; }
        const q = await api(a.page, "/api/training-commercial", { method: "POST", body: { packageCode: "training-8-basic", petCount: 1, scheduledStart: start.toISOString(), paymentMode: "prepaid", couponCode: code, couponQuoteId: governed.body?.data?.quoteId } });
        out.push(`${code}: ${q.status} ${q.status === 201 ? `discount ₹${q.body?.data?.discount}` : q.body?.error}`);
      }
      if (!out.some(o => o.includes(": 201 "))) throw fail(`No coupon is accepted by the Training quote: ${out.join(" · ")}`);
      return out.join(" · ");
    });
    await step("Customer V2", "Training page: dogs-only list, zone, catalogue", async () => {
      await a.page.goto("/v2/training"); await settle(a.page, 3000);
      const dogs = (await a.page.getByRole("group", { name: /Dogs/ }).getByRole("button").allInnerTexts()).map(t => t.split("\n")[0]);
      const zone = await a.page.getByText(/Training zone/).first().innerText().catch(() => "");
      await shot(a.page, "v2-training-page"); await shot(a.page, "v2-training-page-full", true);
      if (dogs.includes("Whiskers")) throw fail(`Cat listed for dog training: ${dogs.join(", ")}`);
      return `dogs=[${dogs.join(", ")}] · ${zone}`;
    });
    await step("Customer V2", "Reserve Meet & Greet (1 dog, prepaid ₹500)", async () => {
      const picked = await v2Choose(a.page, { pkg: /^Trainer Meet & Greet/, dogs: ["Bruno"], time: MEET_TIME, trainers: [/PawSpace Training Team/], label: "meet" });
      await shot(a.page, "meet-before-reserve");
      state.meet = { trainer: picked.trainerText, date: picked.date };
      const made = await v2Reserve(a.page, "meet");
      state.meet.bookingId = made.bookingId;
      return `${state.meet.bookingId} · ${picked.trainerText} · ${picked.date} ${MEET_TIME} · ${made.timing}`;
    });
    await step("Payment", "Meet & Greet: pay ₹500 with Razorpay TEST card → captured", async () => {
      if (!state.meet?.bookingId) throw blocked("Meet & Greet was not reserved");
      return payOnPage(a.page, a.phone, state.meet.bookingId, "meet");
    });
    await step("Customer V2", "Meet & Greet confirmation screen", async () => {
      if (!state.meet?.bookingId) throw blocked("Meet & Greet was not reserved");
      const ok = await confirmScreen(a.page, /Trainer Meet & Greet confirmed/); await shot(a.page, "meet-confirmed");
      if (!ok) throw fail(`${state.meet.bookingId}: confirmation did not render`);
      return `${state.meet.bookingId} confirmed`;
    });
    await step("Customer app", "Coupon UATCARE100 on the Training review step (fresh page)", async () => {
      // The coupon is two sequential server answers: CouponField's coupon quote, then the Training quote bound to it.
      // Read each when the page shows it. Run 36243387701 read the pay button at a fixed 3.5 s, while the Training
      // quote was still in flight ("Refreshing server quote…"), and reported that as a refusal.
      const requests = timeRequests(a.page, /^\/api\/(customer-offers|coupon-governance|training-commercial)$/);
      try {
        await a.page.goto("/mobile-app?service=dog_training"); await settle(a.page, 3000);
        await a.page.getByRole("button", { name: /^(See training options|Book a Meet & Greet|Choose a programme)$/ }).first().click(); await settle(a.page, 2500);
        await a.page.getByRole("button", { name: "Choose trainer", exact: true }).click(); await settle(a.page, 2000);
        await a.page.getByRole("button", { name: "Build session calendar", exact: true }).click(); await settle(a.page, 1200);
        await a.page.getByRole("button", { name: "Review & pay", exact: true }).click(); await settle(a.page, 3000);
        const full = a.page.getByRole("button", { name: /Pay 100% upfront/ });
        await full.click();
        const price = Number((await full.innerText()).match(/₹([\d,]+) before an eligible coupon/)?.[1]?.replace(/,/g, "") ?? NaN);
        // The codes are listed only after /api/customer-offers answers.
        const codes = a.page.getByRole("button", { name: /available code/ });
        if (!(await visible(codes, 20_000))) throw info(`No coupon offered for Dog Training within 20 s · ${requests.log.join("; ")}`);
        await codes.first().click();
        const offer = a.page.locator("button").filter({ hasText: /UATCARE100|WELCOME/ }).first();
        if (!(await visible(offer, 5000))) throw info("No coupon offered for Dog Training");
        if (!Number.isFinite(price)) throw fail(`Could not read the plan price from "Pay 100% upfront": ${(await full.innerText()).replace(/\s+/g, " ")}`);
        const code = (await offer.innerText()).match(/UATCARE100|WELCOME/)?.[0] || "";
        // CouponField's own section: the review step's outer section also contains its text (and a <small> of its own).
        const coupon = a.page.getByText("Coupon code · UAT governed", { exact: true }).locator("xpath=ancestor::section[1]");
        const apply = coupon.getByRole("button", { name: "Apply", exact: true });
        await apply.waitFor({ timeout: 25_000 }).catch(() => {}); // a welcome code the page auto-applies may still be checking
        const alertsBefore = await alertTexts(a.page);
        const clicked = Date.now(), since = () => Date.now() - clicked;
        const couponAnswer = a.page.waitForResponse(r => pathOf(r.url()) === "/api/coupon-governance" && r.request().method() === "POST", { timeout: 25_000 }).catch(() => null);
        await offer.click();
        // 1. CouponField's own outcome: "you save ₹N", or its error line. Its button reads "Checking…" until then.
        const couponResponse = await couponAnswer;
        if (couponResponse) await apply.waitFor({ timeout: 10_000 }).catch(() => {});
        const couponLine = (await coupon.locator("small").first().innerText().catch(() => "")).trim();
        const saved = Number(couponLine.match(/you save ₹([\d,]+)/)?.[1]?.replace(/,/g, "") ?? NaN);
        if (!couponResponse || !Number.isFinite(saved)) {
          await shot(a.page, "app-coupon");
          throw fail(couponResponse ? `${code} was not applied: "${couponLine}" (coupon quote ${couponResponse.status()} after ${since()} ms) · ${requests.log.join("; ")}`
            : `Coupon quote did not answer within 25 s of choosing ${code} (coupon line "${couponLine}") · ${requests.log.join("; ")}`);
        }
        // 2. The Training quote bound to that coupon: its "Coupon saving" line, or a new alert. 30 s outlasts apiSend's 20 s deadline.
        const saving = a.page.getByText(/^Coupon saving −₹/);
        let answered = false, fresh: string[] = [];
        for (const until = Date.now() + 30_000; Date.now() < until;) {
          if (await saving.first().isVisible().catch(() => false)) { answered = true; break; }
          fresh = await freshAlerts(a.page, alertsBefore); if (fresh.length) break;
          await a.page.waitForTimeout(500);
        }
        const elapsed = since();
        await shot(a.page, "app-coupon"); await shot(a.page, "app-coupon-full", true);
        const payLabel = (await a.page.getByRole("button", { name: /Pay ₹|Refreshing server quote/ }).first().innerText().catch(() => "")).trim();
        const evidence = `${elapsed} ms after choosing ${code} · ${requests.log.join("; ")}`;
        if (fresh.some(text => CLIENT_TIMEOUT.test(text))) throw fail(`Training quote timed out on staging (latency), not a refusal: ${JSON.stringify(fresh)} · pay button "${payLabel}" · ${evidence}`);
        if (fresh.length) throw fail(`Training quote refused the applied coupon: ${JSON.stringify(fresh)} · pay button "${payLabel}" · ${evidence}`);
        if (!answered) throw fail(`No Training quote answer within 30 s of the coupon (pay button "${payLabel}", coupon "${couponLine}") · ${evidence}`);
        const savingText = (await saving.first().innerText().catch(() => "")).replace(/\s+/g, " ").trim();
        const quoted = Number(savingText.match(/−₹([\d,]+)/)?.[1]?.replace(/,/g, "") ?? NaN);
        const expected = `Pay ${inr(price - saved)} & request trainer approval`;
        if (quoted !== saved || payLabel !== expected) throw fail(`${code}: "${couponLine}", but the page shows "${savingText}" and pay button "${payLabel}", expected a ${inr(saved)} saving and "${expected}" · ${evidence}`);
        return `${code}: ${couponLine} · ${savingText} · pay button "${payLabel}" · ${evidence}`;
      } finally { requests.stop(); }
    });

    // ================= Journey B: Starter split programme → deposit → trainer lifecycle → balance → completion
    await step("Customer", "Customer B: sandbox OTP sign-in + address + dog", async () => {
      const made = await newCustomer(browser, "Master B", [{ name: "Coco", species: "dog", breed: "Beagle", vaccinationStatus: "verified" }]);
      B = made.customer; open.push(B.context); return `${B.phone} · ${made.setup}`;
    });
    const b = B as Customer | null;
    if (b) {
      await step("Customer V2", "Reserve Starter Plan (2 sessions, 50% split)", async () => {
        const picked = await v2Choose(b.page, { pkg: /^Starter Plan/, dogs: ["Coco"], mode: "split", cadence: "7", time: STARTER_TIME, trainers: [/Arjun T\./, /Kavya R\.|Rohan D\.|Nikhil B\.|Anitha G\./, /PawSpace Training Team/], label: "starter", requireKnownTrainer: true });
        await shot(b.page, "starter-before-reserve");
        state.starter = { trainer: picked.trainerText, date: picked.date };
        const made = await v2Reserve(b.page, "starter");
        state.starter.bookingId = made.bookingId;
        const prog = await api(b.page, `/api/training-programmes?bookingId=${encodeURIComponent(state.starter.bookingId)}`);
        state.starter.sessions = (prog.body?.data?.sessions || []).map((s: { id: string; sequence_no: number; status: string }) => ({ id: s.id, n: s.sequence_no, status: s.status }));
        state.starter.providerId = prog.body?.data?.programme?.provider_id;
        return `${state.starter.bookingId} · ${picked.trainerText} (${state.starter.providerId}) · ${picked.date} ${STARTER_TIME} · sessions ${JSON.stringify(state.starter.sessions)} · ${made.timing}`;
      });
      await step("Payment", "Starter deposit: pay ₹1,750 with Razorpay TEST card → captured", async () => {
        if (!state.starter?.bookingId) throw blocked("Starter was not reserved");
        const result = await payOnPage(b.page, b.phone, state.starter.bookingId, "starter-deposit");
        state.starter.depositPaid = true;
        return result;
      });
      await step("Customer V2", "Programme confirmation screen after deposit", async () => {
        if (!state.starter?.depositPaid) throw blocked("Deposit not captured");
        const ok = await confirmScreen(b.page, /Training programme confirmed/);
        await shot(b.page, "starter-confirmed"); await shot(b.page, "starter-confirmed-full", true);
        if (!ok) throw fail("Captured, but the programme confirmation did not render");
        return (await mainText(b.page)).slice(0, 300);
      });
      await step("Customer V2", "Activity + booking page after deposit", async () => {
        if (!state.starter?.bookingId) throw blocked("Starter was not reserved");
        await b.page.goto("/v2/activity"); await settle(b.page, 2500); await shot(b.page, "v2-activity");
        await b.page.goto(`/v2/booking?bookingId=${encodeURIComponent(state.starter.bookingId)}`); await settle(b.page, 3000); await shot(b.page, "v2-booking-after-deposit");
        return (await mainText(b.page)).slice(0, 500);
      });
    }
    const trainerPhone = TRAINER_PHONES[String(state.starter?.trainer || "").trim()] || "";
    // The lifecycle below needs a signed-in trainer, not a fast partner-jobs feed: /trainer reads its own endpoint.
    await step("Trainer", "Partner app sandbox OTP sign-in as the assigned trainer", async () => {
      if (!state.starter?.depositPaid) throw blocked("Deposit not captured, so the trainer is correctly not allowed to start");
      if (!trainerPhone) throw blocked(`Assigned trainer "${state.starter?.trainer}" has no known UAT phone`);
      trainerContext = await browser.newContext({ ...PHONE_DEVICE, baseURL: BASE, locale: "en-IN", timezoneId: "Asia/Kolkata", permissions: ["geolocation"], geolocation: state.doorGuess || { latitude: 12.9784, longitude: 77.6408 } });
      open.push(trainerContext);
      const page = await trainerContext.newPage(); trainer = page; watchApi(page, "trainer"); answerDialogs(page);
      // The home shows "No assigned jobs" until GET /api/partner-jobs answers, which took about 26-30 s on staging in
      // run 36243387701, where a screenshot taken before it counted as a pass. Judge the feed the home is built from.
      let jobs: Promise<PwResponse | null> = Promise.resolve(null), asked = Date.now();
      const subject = await partnerLogin(page, trainerPhone, `/partner-app?bookingId=${encodeURIComponent(state.starter.bookingId)}`, () => {
        asked = Date.now();
        jobs = page.waitForResponse(r => pathOf(r.url()) === "/api/partner-jobs" && r.request().method() === "GET", { timeout: 120_000 }).catch(() => null);
      });
      state.trainerSignedIn = true;
      const response = await jobs, answeredMs = Date.now() - asked;
      const body = response ? await response.json().catch(() => null) as { jobs?: Array<{ trainingSessionId?: string }>; error?: string } | null : null;
      const listed = (body?.jobs || []).map(job => String(job.trainingSessionId || "")).filter(Boolean);
      const expected = ((state.starter.sessions || []) as Array<{ id: string }>).map(session => session.id);
      const missing = expected.filter(id => !listed.includes(id));
      await visible(page.getByText(state.starter.bookingId), 15_000);
      await shot(page, "partner-app-home");
      const home = (await mainText(page)).slice(0, 300);
      if (!response) throw fail(`${trainerPhone} → ${subject}: GET /api/partner-jobs did not answer within 120 s of Verify · ${home}`);
      if (response.status() !== 200 || !expected.length || missing.length) throw fail(`${trainerPhone} → ${subject}: GET /api/partner-jobs ${response.status()} after ${answeredMs} ms lists ${listed.length} Training session(s), not ${(missing.length ? missing : ["the Starter sessions"]).join(", ")} of ${state.starter.bookingId} ${body?.error || ""} · ${home}`);
      return `${trainerPhone} → ${subject} · partner-jobs listed ${expected.join(", ")} after ${answeredMs} ms · ${home}`;
    });
    const s1 = state.starter?.sessions?.[0]?.id, s2 = state.starter?.sessions?.[1]?.id;
    if (state.trainerSignedIn && trainer && s1 && s2) {
      const t = trainer as Page, tc = trainerContext as unknown as BrowserContext;
      await step("Trainer", "Session 1: accept → on the way", async () => {
        const opened = await openTrainerSession(t, state.starter.bookingId, s1);
        const x = await sessionAction(t, "Accept"); const y = await sessionAction(t, "On the way"); await shot(t, "trainer-s1-on-the-way");
        if (x.status !== 200 || y.status !== 200) throw fail(`accept ${x.status} ${x.body} · on the way ${y.status} ${y.body} · workspace opened in ${opened} ms`);
        return `accepted (${x.ms} ms) + on the way (${y.ms} ms) · workspace opened in ${opened} ms`;
      });
      await step("Maps", "Session 1: arrival geofence (250 m) at the geocoded doorstep", async () => {
        const first = await sessionAction(t, "Arrived");
        if (first.status === 200) { await shot(t, "trainer-s1-arrived"); state.door = state.doorGuess; return `arrived via the app using the Google Places doorstep · ${first.body.slice(0, 120)}`; }
        if (!/doorstep|geofence|location/i.test(first.body)) throw fail(`Arrived ${first.status} ${first.body}`);
        const door = await locateDoorstep(t, s1, state.doorGuess || { latitude: 12.9784, longitude: 77.6408 });
        state.door = door;
        if (door.arrivedByProbe) {
          // The probe arrived through the API, so reload for the workspace to show the session as arrived.
          await openTrainerSession(t, state.starter.bookingId, s1, true).catch(() => 0);
          return `first app arrival refused (${first.body.slice(0, 110)}); arrival accepted on a probe`;
        }
        await tc.setGeolocation({ latitude: door.latitude, longitude: door.longitude, accuracy: 10 }); await openTrainerSession(t, state.starter.bookingId, s1, true);
        const r = await sessionAction(t, "Arrived"); await shot(t, "trainer-s1-arrived");
        if (r.status !== 200) throw fail(`Arrived ${r.status} ${r.body}`);
        return `first app arrival refused (${first.body.slice(0, 110)}); server doorstep located at ${door.latitude.toFixed(5)},${door.longitude.toFixed(5)}; app arrival then 200`;
      });
      await step("Trainer", "Session 1: pre-check → start → photos → handover → report", async () => {
        await checkIfShown(t, "Parent/caretaker attendance confirmed"); await checkIfShown(t, "Training area is safe");
        await shot(t, "trainer-s1-precheck");
        const start = await sessionAction(t, "Start session"); if (start.status !== 200) throw fail(`start ${start.status} ${start.body}`);
        const uploads = await uploadEvidence(t);
        await fillIfShown(t, "Minutes completed", "15"); const handover = await sessionAction(t, "Record completed handover");
        await fillIfShown(t, "Homework for pet parent", "Practise sit-stay 3x daily for 5 minutes; loose-leash walk 10 minutes each evening.");
        const save = await sessionAction(t, "Save report"); await shot(t, "trainer-s1-in-session"); await shot(t, "trainer-s1-in-session-full", true);
        return `start 200 · ${uploads} · handover ${handover.status} · report ${save.status}`;
      });
      await step("Staff", "Founder approves session 1 photos in Control (maker/checker)", async () => {
        await staffLogin(staff, "founder@pawspace.in");
        const r = await approveProof(staff, state.starter.bookingId); if (r.approved < 2) throw fail(`approved ${r.approved}/2 (${r.notes})`); return `approved ${r.approved} photos`;
      });
      await step("Trainer", "Session 1: Complete & consume one session (trainer screen)", async () => {
        await openTrainerSession(t, state.starter.bookingId, s1, true);
        const refresh = t.getByRole("button", { name: "Refresh photo approval" }); if (await refresh.count()) { await refresh.click(); await workspaceIdle(t); }
        const r = await sessionAction(t, "Complete & consume one session");
        await t.evaluate(() => window.scrollTo(0, 0)); await shot(t, "trainer-s1-complete-ui");
        state.s1UiComplete = r;
        if (r.status !== 200) throw fail(`${r.status} ${r.body}`);
        return r.body.slice(0, 200);
      });
      if ((state.s1UiComplete?.status ?? 0) !== 200) await step("Trainer", "Session 1: same completion with the pre-check confirmation included (server check)", async () => {
        const r = await completeViaApi(t, s1, "Practise sit-stay 3x daily for 5 minutes; loose-leash walk 10 minutes each evening.");
        if (r.status !== 200) throw fail(`${r.status} ${JSON.stringify(r.body).slice(0, 250)}`); return JSON.stringify(r.body?.data).slice(0, 250);
      });
      await step("Trainer", "Session 2 (final): accept → journey → arrive → start → photos → report", async () => {
        await openTrainerSession(t, state.starter.bookingId, s2);
        const out: string[] = [];
        for (const name of ["Accept", "On the way", "Arrived"]) { const r = await sessionAction(t, name); out.push(`${name} ${r.status}`); }
        await checkIfShown(t, "Parent/caretaker attendance confirmed"); await checkIfShown(t, "Training area is safe");
        out.push(`start ${(await sessionAction(t, "Start session")).status}`);
        out.push(await uploadEvidence(t));
        await fillIfShown(t, "Minutes completed", "15"); out.push(`handover ${(await sessionAction(t, "Record completed handover")).status}`);
        await fillIfShown(t, "Homework for pet parent", "Keep daily recall games; add distractions gradually over two weeks.");
        out.push(`report ${(await sessionAction(t, "Save report")).status}`); await shot(t, "trainer-s2-in-session");
        if (out.some(o => / (0|4\d\d|5\d\d)$/.test(o))) throw fail(out.join(" · "));
        return out.join(" · ");
      });
      await step("Staff", "Founder approves session 2 photos", async () => { const r = await approveProof(staff, state.starter.bookingId); if (r.approved < 2) throw fail(`approved ${r.approved}/2`); return `approved ${r.approved}`; });
      await step("Payment", "Final session is blocked until the balance is paid", async () => {
        const r = await completeViaApi(t, s2, "Keep daily recall games; add distractions gradually over two weeks.");
        if (r.status === 200) throw fail("Final session completed without the remaining balance");
        if (r.status !== 409 || String(r.body?.code) !== "training_payment_required") throw fail(`expected 409 training_payment_required, got ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
        return `${r.status} ${String(r.body?.error || "").slice(0, 200)}`;
      });
    }
    if (b && state.starter?.depositPaid) {
      await step("Payment", "Customer pays the remaining ₹1,750 balance with Razorpay (V2 booking page)", async () => {
        const clean = await cleanCheckoutContext(browser, b); open.push(clean.context);
        await clean.page.goto(`/v2/booking?bookingId=${encodeURIComponent(state.starter.bookingId)}`); await settle(clean.page, 3000);
        await shot(clean.page, "balance-before");
        const result = await payOnPage(clean.page, b.phone, state.starter.bookingId, "starter-balance");
        state.starter.balancePaid = true;
        await clean.page.goto(`/v2/booking?bookingId=${encodeURIComponent(state.starter.bookingId)}`); await settle(clean.page, 3000); await shot(clean.page, "balance-after");
        return `${result} · booking page now: ${(await mainText(clean.page)).slice(0, 250)}`;
      });
    }
    if (state.trainerSignedIn && trainer && s2) {
      const t = trainer as Page;
      await step("Trainer", "Final session completion → programme completed + certificate", async () => {
        if (!state.starter?.balancePaid) throw blocked("Balance not paid");
        let r = await completeViaApi(t, s2, "Keep daily recall games; add distractions gradually over two weeks.");
        for (let i = 0; i < 6 && r.status === 409 && /payment/i.test(JSON.stringify(r.body)); i++) { await t.waitForTimeout(15_000); r = await completeViaApi(t, s2, "Keep daily recall games; add distractions gradually over two weeks."); }
        await openTrainerSession(t, state.starter.bookingId, s2, true).catch(() => 0); await shot(t, "trainer-programme-complete");
        if (r.status !== 200) throw fail(`${r.status} ${JSON.stringify(r.body).slice(0, 250)}`);
        state.starter.completed = true;
        return JSON.stringify(r.body?.data).slice(0, 300);
      });
      await step("Trainer", "Earnings (trainer workspace + partner app)", async () => {
        const opened = Date.now();
        await t.getByRole("button", { name: /Earnings/ }).first().click();
        // "Loading Training earnings…" stays up until /api/training-provider-earnings answers (about 60 D1 round trips).
        const unavailable = t.getByRole("heading", { name: "Training earnings are unavailable" });
        const ready = await visible(t.getByText("CANONICAL TRAINING PAYOUT LEDGER").or(unavailable), 120_000);
        const elapsed = Date.now() - opened;
        await shot(t, "trainer-earnings");
        const shown = await mainText(t);
        const latency = CLIENT_TIMEOUT.test(shown) ? ": a client-side timeout on staging (latency), not a refusal" : "";
        if (!ready) throw fail(`"Loading Training earnings…" still shown after ${elapsed} ms${latency} · page: ${shown.slice(0, 300)}`);
        if (await unavailable.first().isVisible().catch(() => false)) throw fail(`Training earnings are unavailable after ${elapsed} ms${latency} · page: ${shown.slice(0, 300)}`);
        const workspace = shown.match(/CANONICAL TRAINING PAYOUT LEDGER.{0,300}|TRAINING PAYOUT LEDGER.{0,300}/)?.[0] || shown.slice(0, 300);
        await t.goto("/partner-app"); await settle(t, 2500);
        const tab = t.getByRole("button", { name: /Earnings/ }).first(); if (await tab.count()) { await tab.click(); await settle(t, 2500); }
        await shot(t, "partner-app-earnings");
        return `workspace (earnings answered in ${elapsed} ms): ${workspace.slice(0, 250)} || partner app: ${(await mainText(t)).slice(0, 300)}`;
      });
    }

    // ================= Journey C: mobile app programme (50%) → dashboard → cancellation request
    await step("Customer", "Customer C: sandbox OTP sign-in + address + dog", async () => {
      const made = await newCustomer(browser, "Master C", [{ name: "Luna", species: "dog", breed: "Indie", vaccinationStatus: "verified" }]);
      C = made.customer; open.push(C.context); return `${C.phone} · ${made.setup}`;
    });
    const c = C as Customer | null;
    if (c) {
      await step("Customer app", "Mobile 5-stage flow: goals → Basic Obedience → trainer → calendar → review", async () => {
        await c.page.goto("/mobile-app?service=dog_training"); await settle(c.page, 3000);
        const reqs = c.page.getByRole("group", { name: "Training requirements" });
        await reqs.getByRole("button", { name: /Recall/ }).click().catch(() => {});
        await c.page.getByLabel("Home routine, behaviour and trainer notes").fill("Walks 7am/7pm, pulls on leash, reactive to scooters").catch(() => {});
        await shot(c.page, "app-stage1");
        await c.page.getByRole("button", { name: /^(See training options|Book a Meet & Greet|Choose a programme)$/ }).first().click(); await settle(c.page, 2500);
        await shot(c.page, "app-stage2");
        await c.page.getByRole("button", { name: /Basic Obedience Plan/ }).first().click().catch(() => {});
        await c.page.getByRole("button", { name: "Choose trainer", exact: true }).click(); await settle(c.page, 2500);
        await c.page.getByRole("button").filter({ hasText: /PawSpace Training Team/ }).first().click().catch(() => {}); await shot(c.page, "app-stage3");
        await c.page.getByRole("button", { name: "Build session calendar", exact: true }).click(); await settle(c.page, 1200);
        await c.page.getByLabel("Repeat schedule").selectOption("Wed & Sun").catch(() => {});
        await c.page.getByRole("button", { name: /^9:00 AM/ }).click().catch(() => {}); await c.page.waitForTimeout(600); await shot(c.page, "app-stage4");
        await c.page.getByRole("button", { name: "Review & pay", exact: true }).click(); await settle(c.page, 3000); await shot(c.page, "app-stage5");
        return (await mainText(c.page)).match(/Review your programme.*?Cancellation/)?.[0]?.slice(0, 500) || "";
      });
      await step("Customer app", "Reserve Basic Obedience with 50% split", async () => {
        const pay = c.page.getByRole("button", { name: /Pay ₹[\d,]+ & request trainer approval/ });
        if (!(await visible(pay, 45_000))) { await shot(c.page, "app-no-pay-button", true); throw fail(`Pay button not ready: "${(await c.page.getByRole("button", { name: /Pay ₹|Refreshing/ }).first().innerText().catch(() => "?")).trim()}" alerts ${JSON.stringify(await c.page.locator("[role=alert]").allInnerTexts())}`); }
        // Same race as V2: in run 36243387701 this create hit apiSend's 20 s deadline ("The request took too long").
        const made = await awaitPayButton(c.page, "app", await createBooking(c.page, "app", () => pay.click()));
        state.app = { bookingId: made.bookingId };
        return `${state.app.bookingId} · ${made.timing}`;
      });
      await step("Payment", "Mobile app: pay ₹6,000 deposit with Razorpay TEST card → captured", async () => {
        if (!state.app?.bookingId) throw blocked("App programme not reserved");
        const result = await payOnPage(c.page, c.phone, state.app.bookingId, "app-deposit");
        state.app.paid = true;
        return result;
      });
      await step("Customer app", "In-app programme dashboard (plan / homework / progress)", async () => {
        if (!state.app?.paid) throw blocked("App deposit not captured");
        const ready = await visible(c.page.getByText(/plan is ready/i), 60_000);
        await shot(c.page, "app-dashboard");
        if (!ready) throw fail("Captured, but the in-app programme dashboard did not appear");
        for (const tab of ["Homework", "Progress", "Plan"]) { const tb = c.page.getByRole("button", { name: tab, exact: true }); if (await tb.count()) { await tb.click(); await c.page.waitForTimeout(600); await shot(c.page, `app-dashboard-${tab.toLowerCase()}`); } }
        return (await mainText(c.page)).slice(0, 300);
      });
      await step("Customer app", "Request programme cancellation / refund review", async () => {
        if (!state.app?.paid) throw blocked("App deposit not captured");
        queueAnswers(c.page, "Plans changed — QA master cancellation request");
        const cancel = c.page.getByRole("button", { name: /Request programme cancellation/ });
        if (!(await cancel.count())) throw fail("Cancellation button not shown on the dashboard");
        const response = c.page.waitForResponse(r => r.url().includes("/api/training-cancellation"), { timeout: 30_000 }).catch(() => null);
        await cancel.click(); const r = await response; await settle(c.page, 1500); await shot(c.page, "app-cancel-requested");
        const text = r ? await r.text().catch(() => "") : "";
        state.app.cancelRequested = r?.status() === 200;
        if (r?.status() !== 200) throw fail(`${r?.status()} ${text.slice(0, 250)}`);
        return `${r?.status()} ${text.slice(0, 250)}`;
      });
    }

    // ================= Staff, finance, CRM, BCC, roles
    await step("Staff", "Training operations console", async () => {
      await staffLogin(staff, "founder@pawspace.in");
      await staff.goto("/team/operations/training"); await settle(staff, 3500); await shot(staff, "ops-console");
      return (await mainText(staff)).slice(0, 400);
    });
    await step("Accounts", "Training finance: invoice for the fully paid programme", async () => {
      await staff.goto("/team/finance/training"); await settle(staff, 3500); await shot(staff, "finance-training"); await shot(staff, "finance-training-full", true);
      if (!state.starter?.completed) throw blocked("Starter programme not fully paid and completed");
      const row = staff.locator("tr").filter({ hasText: state.starter.bookingId });
      if (!(await row.count())) throw blocked(`${state.starter.bookingId} is not listed in Training invoices (${await staff.locator("tr").count()} rows)`);
      const text = (await row.first().innerText()).replace(/\s+/g, " ");
      const button = row.first().getByRole("button", { name: "Issue UAT invoice" });
      if (!(await button.isEnabled().catch(() => false))) throw fail(`Issue UAT invoice disabled — row: ${text}`);
      queueAnswers(staff, "QA master invoice issue");
      await button.click(); await settle(staff, 2500); await shot(staff, "finance-invoice-issued");
      return (await staff.locator("tr").filter({ hasText: state.starter.bookingId }).first().innerText()).replace(/\s+/g, " ");
    });
    await step("Accounts", "Trainer payout statement → approve sandbox instruction", async () => {
      if (!state.starter?.completed) throw blocked("No completed sessions to pay out");
      const provider = String(state.starter?.providerId || "");
      const row = staff.locator("tr").filter({ hasText: provider }).filter({ has: staff.getByRole("button", { name: /Approve sandbox instruction/ }) }).first();
      if (!provider || !(await row.count())) throw blocked(`No payout statement row for ${provider}`);
      const before = (await row.innerText()).replace(/\s+/g, " ");
      const button = row.getByRole("button", { name: /Approve sandbox instruction/ });
      if (!(await button.isEnabled())) return `not approvable now: ${before}`;
      queueAnswers(staff, "QA master payout approval");
      const response = staff.waitForResponse(r => r.url().includes("/api/training-finance") && r.request().method() === "POST", { timeout: 20_000 }).catch(() => null);
      await button.click(); const r = await response; await settle(staff, 2000); await shot(staff, "finance-payout");
      return `${before} → ${r?.status()} ${(r ? await r.text().catch(() => "") : "").slice(0, 200)}`;
    });
    await step("Accounts", "Cancellation case for the mobile programme (policy, calculation, approval, sandbox refund)", async () => {
      if (!state.app?.cancelRequested) throw blocked("No cancellation request");
      await staff.goto("/team/finance/training"); await settle(staff, 3500);
      const row = staff.locator("tr").filter({ hasText: state.app.bookingId }).filter({ hasText: /chargeable/ });
      const text = (await row.first().innerText().catch(() => "")).replace(/\s+/g, " ");
      await shot(staff, "finance-cancellation");
      if (!text) throw fail("Cancellation case not visible in Training finance");
      const approve = row.first().getByRole("button", { name: "Approve" });
      if (!(await approve.isEnabled().catch(() => false))) return `case: ${text} (approval not available — policy/calculation state)`;
      queueAnswers(staff, "QA master cancellation approval");
      const response = staff.waitForResponse(r => r.url().includes("/api/training-cancellation") && r.request().method() === "POST", { timeout: 20_000 }).catch(() => null);
      await approve.click(); const r = await response; await settle(staff, 2500);
      const approved = r ? (await r.text().catch(() => "")).slice(0, 250) : "no request";
      const steps: string[] = [];
      const refundRow = () => staff.locator("div").filter({ hasText: state.app.bookingId }).filter({ has: staff.getByRole("button", { name: "Process sandbox" }) }).last();
      if (await refundRow().count()) {
        queueAnswers(staff, "QA sandbox refund processing");
        await refundRow().getByRole("button", { name: "Process sandbox" }).click().catch(() => {}); await settle(staff, 2000); steps.push("processing");
        queueAnswers(staff, `rfnd_QA${Date.now()}`, "QA sandbox refund completed");
        await refundRow().getByRole("button", { name: "Complete sandbox" }).click().catch(() => {}); await settle(staff, 2000); steps.push("completed");
        const credit = staff.getByRole("button", { name: "Issue UAT credit note" }).first();
        if (await credit.isEnabled().catch(() => false)) { queueAnswers(staff, "QA credit note"); await credit.click(); await settle(staff, 2000); steps.push("credit note"); }
      }
      await shot(staff, "finance-refund");
      return `case: ${text} → approve ${r?.status()} ${approved} → refund: ${steps.join(" → ") || "no refund row"}`;
    });
    await step("CRM", "Capture a Dog Training lead and find it", async () => {
      await staff.goto("/crm"); await settle(staff, 3500);
      await staff.getByRole("button", { name: /Add lead/ }).click(); await staff.waitForTimeout(800);
      await staff.getByLabel("Customer name").fill("Master Training Lead");
      await staff.getByLabel("Primary mobile").fill(nextPhone().replace(/^8/, "9"));
      await staff.getByLabel("Pet name").fill("Simba");
      await staff.getByLabel("Interested service").selectOption({ label: "Dog Training" }).catch(() => {});
      await staff.getByLabel(/Consent evidence/).fill("Recorded call — QA master consent");
      const response = staff.waitForResponse(r => r.url().includes("/api/crm") && r.request().method() === "POST", { timeout: 20_000 }).catch(() => null);
      await staff.getByRole("button", { name: /Save lead & create follow-up/ }).click();
      const r = await response; await settle(staff, 2000);
      await staff.getByPlaceholder("Search customer, phone or pet").fill("Master Training"); await settle(staff, 1500); await shot(staff, "crm-lead");
      if (r?.status() !== 201) throw fail(`lead create ${r?.status()}`);
      return (await r.text().catch(() => "")).slice(0, 200);
    });
    await step("Ops", "Booking Command Center finds each Training booking", async () => {
      await staff.goto("/booking-command-center");
      const ids = [state.meet?.bookingId, state.starter?.bookingId, state.app?.bookingId].filter(Boolean) as string[];
      if (!ids.length) throw blocked("No bookings created");
      const search = staff.getByPlaceholder("Search booking, customer, pet, phone or provider");
      await search.waitFor({ timeout: 30_000 }).catch(() => {});
      const found: string[] = [], missing: string[] = [];
      for (const id of ids) {
        // Wait for the id itself. The list renders only once the initial snapshot has loaded, and a search result stays
        // hidden behind it; that snapshot took about 50 s on staging (run 36243387701), past the old fixed waits.
        const started = Date.now();
        const searched = staff.waitForResponse(r => r.url().includes("/api/booking-command-center?") && decodeURIComponent(r.url()).includes(id), { timeout: 90_000 }).then(r => `search ${r.status()} at ${Date.now() - started} ms`).catch(() => "no search response");
        await search.fill(id);
        const shown = await visible(staff.getByText(id), 90_000);
        (shown ? found : missing).push(`${id} (${shown ? "shown" : "not shown"} after ${Date.now() - started} ms; ${await Promise.race([searched, Promise.resolve("search pending")])})`);
      }
      await shot(staff, "bcc");
      if (missing.length) throw fail(`not found: ${missing.join(", ")} (found ${found.join(", ")})`);
      return `found ${found.join(", ")}`;
    });
    await step("Roles", "Manager / Finance access to Training ops, finance, CRM, BCC", async () => {
      const out: string[] = [];
      for (const email of ["jyoti.manager39@tkpetcare.in", "uat.demo.manager@tkpetcare.in", "anjali.finance33@tkpetcare.in"]) {
        try { await staffLogin(staff, email); } catch (error) { out.push(`${email} sign-in failed ${error instanceof Error ? error.message : ""}`); continue; }
        for (const path of ["/api/training-ops", "/api/training-finance", "/api/crm", "/api/booking-command-center"]) { const r = await api(staff, path); out.push(`${email.split("@")[0]} ${path} ${r.status}${r.status >= 400 ? ` ${String(r.body?.error || "").slice(0, 70)}` : ""}`); }
      }
      return out.join(" · ");
    });

    // ================= AI
    await step("AI", "V2 chat (guest): training packages and prices", async () => {
      const guest = await browser.newContext({ ...PHONE_DEVICE, baseURL: BASE }); open.push(guest); const g = await guest.newPage(); watchApi(g, "guest");
      await g.goto("/v2/chat"); await settle(g, 2500);
      await g.getByLabel("Your message").fill("What dog training packages do you offer in Bengaluru and what do they cost?");
      const response = g.waitForResponse(r => r.url().includes("/api/ai-web-chat") && r.request().method() === "POST", { timeout: 90_000 }).catch(() => null);
      await sendChat(g, "ai-guest");
      const r = await response;
      await g.getByRole("status", { name: "PawSpace is typing" }).waitFor({ state: "hidden", timeout: 75_000 }).catch(() => {});
      await settle(g, 1500); await shot(g, "ai-guest-chat");
      const convo = (await g.getByRole("region", { name: "Conversation" }).innerText().catch(() => mainText(g))).replace(/\n+/g, " | ");
      return `${r?.status()} · ${convo.slice(-700)}`;
    });
    await step("AI", "V2 chat (signed-in customer with a confirmed programme): my next session", async () => {
      // Ask as the customer whose Starter programme is paid and confirmed; without one there is nothing to ask about.
      const who = b && state.starter?.bookingId ? b : state.meet?.bookingId ? a : null;
      if (!who) throw blocked("No confirmed Training booking to ask about");
      await who.page.goto("/v2/chat"); await settle(who.page, 2500);
      const mine = who.page.getByRole("button", { name: "My PawSpace" }); if (await mine.count()) await mine.click();
      await who.page.getByLabel("Your message").fill("When is my next training session and who is my trainer?");
      const response = who.page.waitForResponse(r => r.url().includes("/api/ai-web-chat") && r.request().method() === "POST", { timeout: 90_000 }).catch(() => null);
      await sendChat(who.page, "ai-customer");
      const r = await response;
      // Wait for the reply itself, not just the request: the typing indicator goes away when the answer is shown.
      await who.page.getByRole("status", { name: "PawSpace is typing" }).waitFor({ state: "hidden", timeout: 75_000 }).catch(() => {});
      await settle(who.page, 1500); await shot(who.page, "ai-customer-chat");
      const convo = (await who.page.getByRole("region", { name: "Conversation" }).innerText().catch(() => mainText(who.page))).replace(/\n+/g, " | ");
      const answer = convo.split("When is my next training session and who is my trainer?").pop() ?? "";
      if (!/PawSpace Training Team|trainer|session|Sept|Oct|\d{1,2}:\d{2}/i.test(answer)) throw fail(`No answer about the booking (${r?.status()}): ${convo.slice(-500)}`);
      return `${r?.status()} · ${answer.slice(0, 600)}`;
    });
    await step("AI", "AI configuration readiness (founder)", async () => {
      await staffLogin(staff, "founder@pawspace.in");
      await staff.goto("/team/ai/configuration"); await settle(staff, 3500); await shot(staff, "ai-configuration");
      return (await mainText(staff)).slice(0, 600);
    });
    if (state.meet?.bookingId) await step("Payment", "Payment state recorded against the bookings", async () => {
      const out: string[] = [];
      if (state.meet?.bookingId) out.push(`meet ${state.meet.bookingId}: ${(await checkoutStatus(a.page, state.meet.bookingId)).status}`);
      if (b && state.starter?.bookingId) out.push(`starter ${state.starter.bookingId}: ${(await checkoutStatus(b.page, state.starter.bookingId)).status} / funding ${await fundingState(b.page, state.starter.bookingId) || "n/a"}`);
      if (c && state.app?.bookingId) out.push(`app ${state.app.bookingId}: ${(await checkoutStatus(c.page, state.app.bookingId)).status}`);
      return out.join(" · ");
    });
  } finally {
    flush();
    for (const context of open) await context.close().catch(() => {});
    console.log(`[master] summary: ${rows.filter(r => r.status === "PASS").length} pass · ${rows.filter(r => r.status === "FAIL").length} fail · ${rows.filter(r => r.status === "BLOCKED").length} blocked · ${rows.filter(r => r.status === "INFO").length} info`);
  }
});
