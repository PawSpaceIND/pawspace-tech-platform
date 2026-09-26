// Private helpers for 50-leads-crm (not a suite: files starting with "_" run only when named explicitly).
import { BASE, settle, api, dismissCookies, payRazorpayTestNetbanking } from "../lib.mjs";

export const clip = (value, n = 400) => String(typeof value === "string" ? value : JSON.stringify(value ?? null)).replace(/\s+/g, " ").slice(0, n);
export const mainText = async (page, n = 4000) => clip(await page.locator("main").first().innerText({ timeout: 5000 }).catch(() => page.locator("body").innerText().catch(() => "")), n);
const json = async (response) => { try { return await response.json(); } catch { return null; } };
const isPost = (part) => (r) => r.url().includes(part) && r.request().method() === "POST";
const isGet = (part) => (r) => r.url().includes(part) && r.request().method() === "GET";

/** Run `action` and wait for the first matching response; returns {status, body} or {status:null} on timeout. */
export async function withResponse(page, match, action, timeout = 45_000) {
  const [response] = await Promise.all([page.waitForResponse(match, { timeout }).catch(() => null), action()]);
  return response ? { status: response.status(), body: await json(response) } : { status: null, body: null };
}

/** Customer OTP (request -> sandbox code -> verify) keeping the request's `existingCustomer` flag. */
export async function otpProbe(context, phone, name) {
  const r1 = await api(context, "POST", "/api/customer-otp", { action: "request", phone });
  const data = r1.body?.data || {};
  if (r1.status !== 200 || !data.challengeId || !data.sandboxCode) return { requestStatus: r1.status, error: clip(r1.body, 200) };
  const r2 = await api(context, "POST", "/api/customer-otp", { action: "verify", challengeId: data.challengeId, code: data.sandboxCode, name });
  return { requestStatus: r1.status, existingCustomer: data.existingCustomer ?? null, verifyStatus: r2.status, customerId: r2.body?.data?.customerId || null, error: r2.status === 200 ? null : clip(r2.body, 300) };
}

// ---------------------------------------------------------------- public web chat (/v2/chat, signed out)
/** One bot turn through the screen: tap a choice button or type into the composer. */
export async function chatTurn(page, { choice, text }) {
  const r = await withResponse(page, isPost("/api/ai-web-chat"), async () => {
    if (choice) await page.getByRole("group", { name: "Choose an option" }).last().getByRole("button", { name: choice, exact: true }).click();
    else { const box = page.getByLabel("Your message"); await box.fill(text); await box.press("Enter"); }
  }, 40_000);
  await page.getByRole("status", { name: "PawSpace is typing" }).waitFor({ state: "detached", timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(400);
  return { status: r.status, bot: clip(r.body?.data?.bot?.text || r.body?.error, 300), event: r.body?.data?.event ?? null, lead: r.body?.data?.lead ?? null };
}
export async function chatScript(page, steps) {
  const turns = [];
  for (const step of steps) {
    const t = await chatTurn(page, step);
    turns.push({ in: step.choice || step.text, ...t });
    if (t.status !== 200) break;
  }
  return turns;
}
export const conversationText = async (page) => clip(await page.getByRole("region", { name: "Conversation with PawSpace" }).innerText().catch(() => ""), 3000);

// ---------------------------------------------------------------- staff CRM (/crm)
export async function openCrm(flow) {
  const r = await flow.page.goto(`${BASE}/crm`, { waitUntil: "domcontentloaded" }).catch(() => null);
  await dismissCookies(flow.page); await settle(flow.page, 2500);
  return r?.status() ?? null;
}
/** "＋ Add lead" modal -> "Save lead & create follow-up". WhatsApp consent is never ticked (no message may be sent). */
export async function addLeadUI(flow, { name, phone, pet, service }) {
  const { page } = flow;
  await page.getByRole("button", { name: /Add lead/ }).first().click();
  const form = page.locator("form").filter({ hasText: "NEW CRM LEAD" });
  await form.waitFor({ timeout: 10_000 });
  await form.locator("input[name=name]").fill(name);
  await form.locator("input[name=phone]").fill(phone);
  await form.locator("input[name=pet]").fill(pet);
  await form.locator("select[name=service]").selectOption({ label: service });
  const filled = await flow.shot(`add-lead-${service}-filled`);
  const r = await withResponse(page, (res) => new URL(res.url()).pathname === "/api/crm" && res.request().method() === "POST", () => form.getByRole("button", { name: /Save lead/ }).click(), 30_000);
  await page.waitForTimeout(1200);
  const alert = clip((await form.locator("[role=alert]").allInnerTexts().catch(() => [])).join(" | "), 300);
  const toast = clip((await page.locator("body").innerText().catch(() => "")).match(/✓[^\n]*/)?.[0] || "", 200);
  const after = await flow.shot(`add-lead-${service}-result`);
  if (await form.isVisible().catch(() => false)) await form.getByRole("button", { name: "×" }).click().catch(() => {});
  return { status: r.status, body: r.body, alert, toast, evidence: [filled, after] };
}
/** Server search in the CRM list; returns the count shown and the detail panel text. */
export async function searchCrm(flow, term, label) {
  const { page } = flow;
  const box = page.getByPlaceholder("Search customer, phone or pet");
  const r = await withResponse(page, (res) => res.url().includes("/api/crm?search=") && res.request().method() === "GET", () => box.fill(term), 20_000);
  await settle(page, 1500);
  const text = await mainText(page, 6000);
  const shown = Number((text.match(/(\d+) shown/) || [])[1] ?? -1);
  const shot = await flow.shot(label || `crm-search-${term}`);
  return { status: r.status, count: Array.isArray(r.body?.contacts) ? r.body.contacts.length : null, contacts: r.body?.contacts || [], shown, text, shot };
}
/** Opens the Revenue & CX engine view (its nav sits in the collapsed "CRM views and status" panel). */
export async function openRevenueEngine(flow) {
  const { page } = flow;
  const nav = page.getByRole("button", { name: /Revenue & CX engine/ }).first();
  if (!(await nav.isVisible().catch(() => false))) await page.getByText("CRM views and status", { exact: true }).click().catch(() => {});
  const r = await withResponse(page, isGet("/api/revenue-crm"), () => page.getByRole("button", { name: /Revenue & CX engine/ }).first().click(), 30_000);
  await settle(page, 1500);
  return r;
}
export async function revenueTab(page, name) { await page.getByRole("button", { name, exact: true }).first().click(); await page.waitForTimeout(800); }
/** Clicks a button inside the card/article of one lead and returns the /api/revenue-crm POST result. */
export async function leadCardAction(page, leadId, buttonName) {
  const card = page.locator("article").filter({ hasText: leadId }).first();
  if (!(await card.isVisible().catch(() => false))) return { status: null, error: "lead card not visible" };
  const button = card.getByRole("button", { name: buttonName }).first();
  if (!(await button.isEnabled().catch(() => false))) return { status: null, error: `${buttonName} disabled` };
  const r = await withResponse(page, isPost("/api/revenue-crm"), () => button.click(), 30_000);
  await page.waitForTimeout(1200);
  return { status: r.status, body: r.body };
}

// ---------------------------------------------------------------- assisted booking (/assisted-booking?customerId=…)
export async function openAssisted(flow, customerId) {
  const { page } = flow;
  const r = await page.goto(`${BASE}/assisted-booking?customerId=${encodeURIComponent(customerId)}`, { waitUntil: "domcontentloaded" }).catch(() => null);
  await dismissCookies(page); await settle(page, 3000);
  await page.getByText("Loading selected CRM customer…").waitFor({ state: "detached", timeout: 20_000 }).catch(() => {});
  const text = await mainText(page, 6000);
  const services = await page.locator("main button").allInnerTexts().catch(() => []);
  return { status: r?.status() ?? null, text, services: services.map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean) };
}
/**
 * The "PET TAXI · ASSISTED STAFF" panel: species (a CRM pet without one), consent evidence, pickup/drop, fare, create.
 * Returns the server's answers for the quote, the scheduler reservation and the ride booking.
 */
export async function assistedTaxi(flow, { pickup, drop, pincode, date, time, consentRef }) {
  const { page } = flow;
  const species = page.getByLabel(/^Species/);
  if (await species.isVisible().catch(() => false)) await species.selectOption("dog");
  await page.getByLabel("Evidence reference").fill(consentRef);
  await page.getByLabel(/Customer explicitly authorized/).check();
  await page.getByLabel(/^Pickup/).fill(pickup);
  await page.getByLabel(/^Drop/).fill(drop);
  await page.getByLabel(/^PIN/).fill(pincode);
  await page.getByLabel(/^Date/).fill(date);
  await page.getByLabel(/^Time/).fill(time);
  await page.keyboard.press("Escape").catch(() => {});
  const quote = await withResponse(page, isPost("/api/taxi-commercial"), () => page.getByRole("button", { name: "Calculate Taxi fare" }).click(), 60_000);
  await page.waitForTimeout(1200);
  const quoted = await flow.shot("assisted-taxi-quoted");
  const out = { quote: { status: quote.status, total: quote.body?.data?.fareOptions?.citroen_ec3?.quotedTotal ?? null, fee: quote.body?.data?.fareOptions?.citroen_ec3?.bookingFee ?? null, error: quote.body?.error ?? null }, evidence: [quoted] };
  const create = page.getByRole("button", { name: /Create payment-pending Taxi/ });
  if (!(await create.isVisible().catch(() => false)) || !(await create.isEnabled().catch(() => false))) { out.error = "Create payment-pending Taxi not available"; out.panel = clip(await page.locator("main").innerText().catch(() => ""), 400); return out; }
  const responses = [];
  const listener = async (res) => { if (res.request().method() === "POST" && /\/api\/(uat-scheduling|taxi-ride-bookings)$/.test(new URL(res.url()).pathname)) responses.push({ path: new URL(res.url()).pathname, status: res.status(), body: await json(res) }); };
  page.on("response", listener);
  await create.click();
  for (let i = 0; i < 90 && !responses.some((r) => r.path.endsWith("taxi-ride-bookings") || (r.path.endsWith("uat-scheduling") && r.status >= 400)); i++) await page.waitForTimeout(1000);
  await page.waitForTimeout(1500);
  page.off("response", listener);
  const schedule = responses.find((r) => r.path.endsWith("uat-scheduling")), booking = responses.find((r) => r.path.endsWith("taxi-ride-bookings"));
  out.schedule = schedule ? { status: schedule.status, error: schedule.body?.error ?? null, provider: schedule.body?.data?.provider?.id ?? null } : null;
  out.booking = booking ? { status: booking.status, bookingId: booking.body?.data?.bookingId ?? null, amountDueNow: booking.body?.data?.amountDueNow ?? null, error: booking.body?.error ?? null } : null;
  out.panel = clip((await page.locator("main").innerText().catch(() => "")).match(/(Taxi PS-[^\n]*|Pet ownership[^\n]*|[^\n]*(denied|refused|could not|unable|required)[^\n]*)/i)?.[0] || "", 300);
  out.evidence.push(await flow.shot("assisted-taxi-result"));
  return out;
}

// ---------------------------------------------------------------- customer payment (06-money-and-maps pattern)
export async function payFromBookingPage(flow, bookingId, { complete = true } = {}) {
  const { page, context } = flow;
  await page.goto(`${BASE}/v2/booking?bookingId=${encodeURIComponent(bookingId)}`); await settle(page, 2500); await dismissCookies(page);
  const before = await flow.shot(`booking-${bookingId}-before-payment`);
  const pay = page.getByRole("button", { name: /Pay securely/i }).first();
  if (!(await pay.isVisible().catch(() => false))) return { opened: false, reason: `no Pay securely button: ${clip(await mainText(page, 400), 300)}`, evidence: [before] };
  await pay.click();
  const t0 = Date.now(); let opened = false, alerts = [];
  while (Date.now() - t0 < 60_000) {
    await page.waitForTimeout(1000);
    opened = page.frames().some((f) => f !== page.mainFrame() && /razorpay/i.test(f.url()));
    alerts = (await page.locator("[role=alert]").allInnerTexts().catch(() => [])).filter((t) => t.trim());
    if (opened || alerts.length) break;
  }
  if (!opened) return { opened, reason: alerts.join(" | ") || "Razorpay did not open in 60 s", evidence: [before, await flow.shot(`booking-${bookingId}-checkout-not-opened`)] };
  const openedShot = await flow.shot(`booking-${bookingId}-checkout-open`, { fullPage: false });
  if (!complete) return { opened, paid: null, status: null, evidence: [before, openedShot], skippedPayment: true };
  const paid = await payRazorpayTestNetbanking(page);
  let status = null;
  for (let i = 0; i < 24 && status?.paymentStatus !== "captured"; i++) {
    await page.waitForTimeout(5000);
    const s = await api(context, "POST", "/api/customer-checkout", { action: "status", bookingId });
    status = s.body?.data?.confirmation || s.body?.data || null;
  }
  await page.goto(`${BASE}/v2/booking?bookingId=${encodeURIComponent(bookingId)}`); await settle(page, 2500);
  const after = await flow.shot(`booking-${bookingId}-after-payment`);
  return { opened, paid, status: status && { bookingStatus: status.bookingStatus, paymentStatus: status.paymentStatus }, evidence: [before, openedShot, after] };
}

/** Unexpected 5xx responses and uncaught page errors seen by a flow (expected refusals are filtered by the caller). */
export function flowProblems(flow, { allow = [] } = {}) {
  const fiveXX = flow.log.apiFailures.filter((f) => f.status >= 500 && !allow.some((re) => re.test(`${f.method} ${f.url} ${f.status}`)));
  return { fiveXX, pageErrors: flow.log.pageErrors };
}
