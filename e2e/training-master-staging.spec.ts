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
import { test, devices, type Browser, type BrowserContext, type Page, type Locator } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const BASE = process.env.PW_BASE_URL || "https://pawspace-staging.karthik-fce.workers.dev";
const ACCESS_CODE = String(process.env.PAWSPACE_UAT_ACCESS_CODE || "").trim();
const OUT = process.env.MASTER_OUT || "test-results/training-master";
const SHOTS = `${OUT}/shots`;
const RUN_BASE = Date.now();
let phoneSeq = 0;
const nextPhone = () => `8${String(RUN_BASE + (phoneSeq++) * 7919).slice(-9)}`;
const EMAIL = "uat.training.master@example.com";
const TRAINER_PHONES: Record<string, string> = {
  "PawSpace Training Team (UAT)": "9000000931", "Arjun T. (UAT East)": "9000000932", "Kavya R. (UAT South)": "9000000933",
  "Nikhil B. (UAT North)": "9000000934", "Anitha G. (UAT West)": "9000000935", "Rohan D. (UAT Central)": "9000000936",
  "PawSpace Training Team 2 (UAT)": "9000000937", "PawSpace Training Team 3 (UAT)": "9000000938",
  "PawSpace Training Team 4 (UAT)": "9000000939", "PawSpace Training Team 5 (UAT)": "9000000940",
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
async function settle(page: Page, ms = 1200) { await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {}); await page.waitForTimeout(ms); }
const mainText = async (page: Page) => (await page.locator("main").first().innerText().catch(() => "")).replace(/\n+/g, " | ");
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
async function partnerLogin(page: Page, phone: string) {
  await page.goto("/partner-app"); await settle(page);
  await page.getByPlaceholder("10-digit phone number").fill(phone);
  await page.getByRole("button", { name: "Send OTP" }).click();
  const sandbox = page.getByText(/Sandbox code \(no real SMS yet\):/i);
  if (!(await visible(sandbox, 20_000))) throw fail("Partner sandbox OTP code was not shown on screen");
  const code = (await sandbox.textContent())?.match(/\b(\d{6})\b/)?.[1] || "";
  await page.getByPlaceholder("6-digit code").fill(code);
  const nameBox = page.getByPlaceholder("Your name (first time only)");
  if (await visible(nameBox, 1500)) await nameBox.fill("UAT Trainer");
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
async function v2Reserve(page: Page, label: string) {
  const created = page.waitForResponse(r => r.url().includes("/api/canonical-bookings") && r.request().method() === "POST", { timeout: 120_000 });
  await page.getByRole("button", { name: /Reserve trainer/ }).click();
  const response = await created; const body = await response.json().catch(() => null) as { data?: { bookingId?: string }; error?: string } | null;
  if (response.status() !== 201 || !body?.data?.bookingId) throw fail(`${label}: booking create ${response.status()} ${JSON.stringify(body).slice(0, 200)}`);
  await page.getByRole("button", { name: /^Pay securely/ }).waitFor({ timeout: 60_000 });
  return body.data.bookingId;
}
async function payOnPage(page: Page, contactPhone: string, bookingId: string, label: string) {
  const pay = page.getByRole("button", { name: /^Pay securely/ });
  if (!(await visible(pay, 30_000))) { await shot(page, `${label}-no-pay-button`); throw fail(`${label}: no "Pay securely" button (${(await mainText(page)).slice(0, 200)})`); }
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
async function sessionAction(page: Page, name: string) {
  const button = page.getByRole("button", { name, exact: true });
  if (!(await button.count()) || !(await button.first().isEnabled())) return { status: 0, body: `button "${name}" not available` };
  const response = page.waitForResponse(r => r.url().includes("/api/training-sessions") && r.request().method() === "POST", { timeout: 30_000 }).catch(() => null);
  await button.first().click();
  const r = await response; const text = r ? await r.text().catch(() => "") : "no request";
  await settle(page, 1200);
  return { status: r?.status() ?? 0, body: text.slice(0, 300) };
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
    const response = page.waitForResponse(r => r.url().includes("/api/training-session-media") && r.request().method() === "POST", { timeout: 30_000 }).catch(() => null);
    await input.setInputFiles({ name: `${label.replace(/\W/g, "-").toLowerCase()}.png`, mimeType: "image/png", buffer: png(rgb as unknown as [number, number, number]) });
    const r = await response; results.push(`${label}: ${r?.status() ?? "no request"}`);
    await settle(page, 1500);
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
      const picked = await v2Choose(a.page, { pkg: /^Trainer Meet & Greet/, dogs: ["Bruno"], time: "11:00", trainers: [/PawSpace Training Team/], label: "meet" });
      await shot(a.page, "meet-before-reserve");
      state.meet = { trainer: picked.trainerText, date: picked.date };
      state.meet.bookingId = await v2Reserve(a.page, "meet");
      return `${state.meet.bookingId} · ${picked.trainerText} · ${picked.date}`;
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
      await a.page.goto("/mobile-app?service=dog_training"); await settle(a.page, 3000);
      await a.page.getByRole("button", { name: /^(See training options|Book a Meet & Greet|Choose a programme)$/ }).first().click(); await settle(a.page, 2500);
      await a.page.getByRole("button", { name: "Choose trainer", exact: true }).click(); await settle(a.page, 2000);
      await a.page.getByRole("button", { name: "Build session calendar", exact: true }).click(); await settle(a.page, 1200);
      await a.page.getByRole("button", { name: "Review & pay", exact: true }).click(); await settle(a.page, 3000);
      await a.page.getByRole("button", { name: /Pay 100% upfront/ }).click(); await settle(a.page, 2500);
      const codes = a.page.getByRole("button", { name: /available code/ }); if (await codes.count()) { await codes.click(); await settle(a.page, 1000); }
      const offer = a.page.locator("button").filter({ hasText: /UATCARE100|WELCOME/ }).first();
      if (!(await offer.count())) throw info("No coupon offered for Dog Training");
      await offer.click(); await settle(a.page, 3500); await shot(a.page, "app-coupon"); await shot(a.page, "app-coupon-full", true);
      const payLabel = (await a.page.getByRole("button", { name: /Pay ₹|Refreshing server quote/ }).first().innerText().catch(() => "")).trim();
      const alerts = await a.page.locator("[role=alert]").allInnerTexts();
      if (/Refreshing/.test(payLabel) || alerts.some(t => /coupon/i.test(t))) throw fail(`Coupon shown as applied but Training quote refused it — pay button "${payLabel}", alert ${JSON.stringify(alerts)}`);
      return `pay button "${payLabel}"`;
    });

    // ================= Journey B: Starter split programme → deposit → trainer lifecycle → balance → completion
    await step("Customer", "Customer B: sandbox OTP sign-in + address + dog", async () => {
      const made = await newCustomer(browser, "Master B", [{ name: "Coco", species: "dog", breed: "Beagle", vaccinationStatus: "verified" }]);
      B = made.customer; open.push(B.context); return `${B.phone} · ${made.setup}`;
    });
    const b = B as Customer | null;
    if (b) {
      await step("Customer V2", "Reserve Starter Plan (2 sessions, 50% split)", async () => {
        const picked = await v2Choose(b.page, { pkg: /^Starter Plan/, dogs: ["Coco"], mode: "split", cadence: "7", time: "15:00", trainers: [/Arjun T\./, /Kavya R\.|Rohan D\.|Nikhil B\.|Anitha G\./, /PawSpace Training Team/], label: "starter", requireKnownTrainer: true });
        await shot(b.page, "starter-before-reserve");
        state.starter = { trainer: picked.trainerText, date: picked.date };
        state.starter.bookingId = await v2Reserve(b.page, "starter");
        const prog = await api(b.page, `/api/training-programmes?bookingId=${encodeURIComponent(state.starter.bookingId)}`);
        state.starter.sessions = (prog.body?.data?.sessions || []).map((s: { id: string; sequence_no: number; status: string }) => ({ id: s.id, n: s.sequence_no, status: s.status }));
        state.starter.providerId = prog.body?.data?.programme?.provider_id;
        return `${state.starter.bookingId} · ${picked.trainerText} (${state.starter.providerId}) · sessions ${JSON.stringify(state.starter.sessions)}`;
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
    const trainerReady = await step("Trainer", "Partner app sandbox OTP sign-in as the assigned trainer", async () => {
      if (!state.starter?.depositPaid) throw blocked("Deposit not captured, so the trainer is correctly not allowed to start");
      if (!trainerPhone) throw blocked(`Assigned trainer "${state.starter?.trainer}" has no known UAT phone`);
      trainerContext = await browser.newContext({ ...PHONE_DEVICE, baseURL: BASE, locale: "en-IN", timezoneId: "Asia/Kolkata", permissions: ["geolocation"], geolocation: state.doorGuess || { latitude: 12.9784, longitude: 77.6408 } });
      open.push(trainerContext);
      trainer = await trainerContext.newPage(); watchApi(trainer, "trainer"); answerDialogs(trainer);
      const subject = await partnerLogin(trainer, trainerPhone); await settle(trainer, 2500); await shot(trainer, "partner-app-home");
      return `${trainerPhone} → ${subject} · ${(await mainText(trainer)).slice(0, 300)}`;
    });
    const s1 = state.starter?.sessions?.[0]?.id, s2 = state.starter?.sessions?.[1]?.id;
    if (trainerReady === "PASS" && trainer && s1 && s2) {
      const t = trainer as Page, tc = trainerContext as unknown as BrowserContext;
      await step("Trainer", "Session 1: accept → on the way", async () => {
        await t.goto(`/trainer?bookingId=${encodeURIComponent(state.starter.bookingId)}&sessionId=${encodeURIComponent(s1)}`); await settle(t, 3000);
        const x = await sessionAction(t, "Accept"); const y = await sessionAction(t, "On the way"); await shot(t, "trainer-s1-on-the-way");
        if (x.status !== 200 || y.status !== 200) throw fail(`accept ${x.status} ${x.body} · on the way ${y.status} ${y.body}`);
        return "accepted + on the way";
      });
      await step("Maps", "Session 1: arrival geofence (250 m) at the geocoded doorstep", async () => {
        const first = await sessionAction(t, "Arrived");
        if (first.status === 200) { await shot(t, "trainer-s1-arrived"); state.door = state.doorGuess; return `arrived via the app using the Google Places doorstep · ${first.body.slice(0, 120)}`; }
        if (!/doorstep|geofence|location/i.test(first.body)) throw fail(`Arrived ${first.status} ${first.body}`);
        const door = await locateDoorstep(t, s1, state.doorGuess || { latitude: 12.9784, longitude: 77.6408 });
        state.door = door;
        if (door.arrivedByProbe) return `first app arrival refused (${first.body.slice(0, 110)}); arrival accepted on a probe`;
        await tc.setGeolocation({ latitude: door.latitude, longitude: door.longitude, accuracy: 10 }); await t.reload(); await settle(t, 2500);
        const r = await sessionAction(t, "Arrived"); await shot(t, "trainer-s1-arrived");
        if (r.status !== 200) throw fail(`Arrived ${r.status} ${r.body}`);
        return `first app arrival refused (${first.body.slice(0, 110)}); server doorstep located at ${door.latitude.toFixed(5)},${door.longitude.toFixed(5)}; app arrival then 200`;
      });
      await step("Trainer", "Session 1: pre-check → start → photos → handover → report", async () => {
        await t.getByLabel("Parent/caretaker attendance confirmed").check().catch(() => {}); await t.getByLabel("Training area is safe").check().catch(() => {});
        await shot(t, "trainer-s1-precheck");
        const start = await sessionAction(t, "Start session"); if (start.status !== 200) throw fail(`start ${start.status} ${start.body}`);
        const uploads = await uploadEvidence(t);
        await t.getByLabel("Minutes completed").fill("15").catch(() => {}); const handover = await sessionAction(t, "Record completed handover");
        await t.getByLabel("Homework for pet parent").fill("Practise sit-stay 3x daily for 5 minutes; loose-leash walk 10 minutes each evening.").catch(() => {});
        const save = await sessionAction(t, "Save report"); await shot(t, "trainer-s1-in-session"); await shot(t, "trainer-s1-in-session-full", true);
        return `start 200 · ${uploads} · handover ${handover.status} · report ${save.status}`;
      });
      await step("Staff", "Founder approves session 1 photos in Control (maker/checker)", async () => {
        await staffLogin(staff, "founder@pawspace.in");
        const r = await approveProof(staff, state.starter.bookingId); if (r.approved < 2) throw fail(`approved ${r.approved}/2 (${r.notes})`); return `approved ${r.approved} photos`;
      });
      await step("Trainer", "Session 1: Complete & consume one session (trainer screen)", async () => {
        await t.reload(); await settle(t, 2500);
        const refresh = t.getByRole("button", { name: "Refresh photo approval" }); if (await refresh.count()) { await refresh.click(); await settle(t, 1500); }
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
        await t.goto(`/trainer?bookingId=${encodeURIComponent(state.starter.bookingId)}&sessionId=${encodeURIComponent(s2)}`); await settle(t, 3000);
        const out: string[] = [];
        for (const name of ["Accept", "On the way", "Arrived"]) { const r = await sessionAction(t, name); out.push(`${name} ${r.status}`); }
        await t.getByLabel("Parent/caretaker attendance confirmed").check().catch(() => {}); await t.getByLabel("Training area is safe").check().catch(() => {});
        out.push(`start ${(await sessionAction(t, "Start session")).status}`);
        out.push(await uploadEvidence(t));
        await t.getByLabel("Minutes completed").fill("15").catch(() => {}); out.push(`handover ${(await sessionAction(t, "Record completed handover")).status}`);
        await t.getByLabel("Homework for pet parent").fill("Keep daily recall games; add distractions gradually over two weeks.").catch(() => {});
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
    if (trainerReady === "PASS" && trainer && s2) {
      const t = trainer as Page;
      await step("Trainer", "Final session completion → programme completed + certificate", async () => {
        if (!state.starter?.balancePaid) throw blocked("Balance not paid");
        let r = await completeViaApi(t, s2, "Keep daily recall games; add distractions gradually over two weeks.");
        for (let i = 0; i < 6 && r.status === 409 && /payment/i.test(JSON.stringify(r.body)); i++) { await t.waitForTimeout(15_000); r = await completeViaApi(t, s2, "Keep daily recall games; add distractions gradually over two weeks."); }
        await t.reload(); await settle(t, 2500); await shot(t, "trainer-programme-complete");
        if (r.status !== 200) throw fail(`${r.status} ${JSON.stringify(r.body).slice(0, 250)}`);
        state.starter.completed = true;
        return JSON.stringify(r.body?.data).slice(0, 300);
      });
      await step("Trainer", "Earnings (trainer workspace + partner app)", async () => {
        await t.getByRole("button", { name: /Earnings/ }).first().click(); await settle(t, 2500); await shot(t, "trainer-earnings");
        const workspace = (await mainText(t)).match(/CANONICAL TRAINING PAYOUT LEDGER.{0,300}|TRAINING PAYOUT LEDGER.{0,300}/)?.[0] || (await mainText(t)).slice(0, 300);
        await t.goto("/partner-app"); await settle(t, 2500);
        const tab = t.getByRole("button", { name: /Earnings/ }).first(); if (await tab.count()) { await tab.click(); await settle(t, 2500); }
        await shot(t, "partner-app-earnings");
        return `workspace: ${workspace.slice(0, 250)} || partner app: ${(await mainText(t)).slice(0, 300)}`;
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
        const alertsBefore = JSON.stringify(await c.page.locator("[role=alert]").allInnerTexts());
        const created = c.page.waitForResponse(r => r.url().includes("/api/canonical-bookings") && r.request().method() === "POST", { timeout: 120_000 }).catch(() => null);
        const refused = (async () => { for (let i = 0; i < 240; i++) { await c.page.waitForTimeout(500); const now = JSON.stringify(await c.page.locator("[role=alert]").allInnerTexts().catch(() => [])); if (now !== alertsBefore && now !== "[]") return "alert" as const; } return null; })();
        await pay.click();
        const first = await Promise.race([created, refused]);
        if (first === "alert" || first === null) { await shot(c.page, "app-reserve-refused"); throw fail(`Reservation refused before booking: ${JSON.stringify(await c.page.locator("[role=alert]").allInnerTexts())}`); }
        const body = await first.json().catch(() => null) as { data?: { bookingId?: string } } | null;
        state.app = { bookingId: String(body?.data?.bookingId || "") };
        if (!state.app.bookingId) throw fail(`booking create ${first.status()}`);
        await c.page.getByRole("button", { name: /^Pay securely/ }).waitFor({ timeout: 60_000 });
        return state.app.bookingId;
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
      await staff.goto("/booking-command-center"); await settle(staff, 4000);
      const ids = [state.meet?.bookingId, state.starter?.bookingId, state.app?.bookingId].filter(Boolean) as string[];
      if (!ids.length) throw blocked("No bookings created");
      const search = staff.getByPlaceholder("Search booking, customer, pet, phone or provider");
      const found: string[] = [], missing: string[] = [];
      for (const id of ids) {
        // Wait for this id's server search, not a fixed delay: the first search raced the heavy initial list load.
        const searched = staff.waitForResponse(r => r.url().includes("/api/booking-command-center?") && decodeURIComponent(r.url()).includes(id), { timeout: 30_000 }).catch(() => null);
        await search.fill(id); await searched; await settle(staff, 1000);
        ((await staff.getByText(id).count()) ? found : missing).push(id);
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
      const r = await response; await settle(g, 4000); await shot(g, "ai-guest-chat");
      const convo = (await g.getByRole("region", { name: "Conversation" }).innerText().catch(() => mainText(g))).replace(/\n+/g, " | ");
      return `${r?.status()} · ${convo.slice(-700)}`;
    });
    await step("AI", "V2 chat (signed-in customer with a confirmed Meet & Greet): my next session", async () => {
      await a.page.goto("/v2/chat"); await settle(a.page, 2500);
      const mine = a.page.getByRole("button", { name: "My PawSpace" }); if (await mine.count()) await mine.click();
      await a.page.getByLabel("Your message").fill("When is my Meet & Greet and who is my trainer?");
      const response = a.page.waitForResponse(r => r.url().includes("/api/ai-web-chat") && r.request().method() === "POST", { timeout: 90_000 }).catch(() => null);
      await sendChat(a.page, "ai-customer");
      const r = await response; await settle(a.page, 4000); await shot(a.page, "ai-customer-chat");
      const convo = (await a.page.getByRole("region", { name: "Conversation" }).innerText().catch(() => mainText(a.page))).replace(/\n+/g, " | ");
      return `${r?.status()} · ${convo.slice(-700)}`;
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
