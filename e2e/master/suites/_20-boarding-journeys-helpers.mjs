// Private helpers for 20-boarding-journeys: drivers for the REAL V2 Boarding screens (app/mobile-app/stay-flow.tsx,
// stay-care-payment-gate.tsx, booking-payment-page.tsx, boarding-customer-stay-panel.tsx, app/host/page.tsx).
// Selectors are role/label/text based; the few CSS-module class hooks ([class*=caregivers], [class*=petList]) are the
// same ones the V2 page has used since round 1.
import { BASE, settle, api, dismissCookies, payRazorpayTestNetbanking } from "../lib.mjs";

export const oneLine = (value, n = 400) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, n);
/** Messages that mean the call did not complete (client timeout, dropped connection, a gateway's non-JSON body). */
export const TRANSPORT = /timed out|took too long|could not be read|not valid JSON|Unexpected token|upstream request failed|Failed to fetch|NetworkError|Load failed|network request/i;
/** Outside GitHub Actions this container's egress cuts browser calls at ~30 s with a plain-text 502 (see 30-sitting-journeys). */
export const localCut = (failure) => !process.env.GITHUB_ACTIONS && Number(failure?.status) === 502 && /^upstream request failed$/i.test(String(failure?.body || "").trim());
export const esc = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const inr = (n) => (Number.isFinite(Number(n)) ? `₹${Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 })}` : String(n));
export const near = (a, b) => a != null && b != null && Math.abs(Number(a) - Number(b)) < 0.011;
export const istIso = (day, hhmm) => new Date(`${day}T${hhmm}:00+05:30`).toISOString();
/** IST calendar date and HH:MM of an instant. */
export const istParts = (ms) => { const s = new Date(ms + 5.5 * 3600_000).toISOString(); return { date: s.slice(0, 10), time: s.slice(11, 16) }; };
export async function mainText(page) { return oneLine(await page.locator("main").first().innerText({ timeout: 5000 }).catch(() => page.locator("body").innerText().catch(() => "")), 6000); }

/** Click that survives the floating V2 dock / appearance button covering the target. */
export async function robustClick(locator, timeout = 10_000) {
  try { await locator.click({ timeout }); return true; }
  catch { try { await locator.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {}); await locator.evaluate(el => el.click()); return true; } catch { return false; } }
}

/**
 * Network watcher for one flow: every /api/ call with its duration and outcome, plus the Boarding payloads the
 * journeys assert on (governed quotes, host lists, reservation, canonical booking, checkout order).
 */
export function watchNetwork(flow) {
  const net = { calls: [], quotes: [], hostLists: [], reserve: [], canonical: [], checkout: [], care: [] };
  const started = new Map();
  const isApi = (url) => url.startsWith(BASE) && url.includes("/api/");
  const pathOf = (url) => { try { return new URL(url).pathname; } catch { return url; } };
  flow.page.on("request", req => { if (isApi(req.url())) started.set(req, Date.now()); });
  flow.page.on("requestfailed", req => {
    const t = started.get(req); if (t === undefined) return;
    net.calls.push({ m: req.method(), p: pathOf(req.url()), s: "ABORTED", err: req.failure()?.errorText || "", ms: Date.now() - t, at: new Date().toISOString() });
  });
  flow.page.on("response", async res => {
    const req = res.request(), url = res.url();
    if (!isApi(url)) return;
    const t = started.get(req), path = pathOf(url), method = req.method();
    let body = null;
    const wants = (method === "POST" && ["/api/boarding-commercial", "/api/uat-scheduling", "/api/canonical-bookings", "/api/customer-checkout", "/api/boarding-stays"].includes(path)) || (method === "GET" && path === "/api/boarding-commercial");
    if (wants) body = await res.json().catch(() => null);
    net.calls.push({ m: method, p: path, s: res.status(), ms: t === undefined ? null : Date.now() - t, at: new Date().toISOString() });
    const post = String(req.postData() || "");
    if (path === "/api/boarding-commercial" && method === "POST" && body?.data?.quoteId) net.quotes.push({ http: res.status(), ...body.data });
    if (path === "/api/boarding-commercial" && method === "GET" && Array.isArray(body?.data?.hosts) && /scheduledStart=/.test(url)) net.hostLists.push({ url: url.replace(BASE, ""), hosts: body.data.hosts.map(h => ({ providerId: h.providerId, name: h.name, available: h.availableGuestPets, capacity: h.capacity })) });
    if (path === "/api/uat-scheduling" && method === "POST" && !/"action":"preview"/.test(post)) net.reserve.push({ http: res.status(), code: body?.code || null, error: body?.error || null, providerId: body?.data?.provider?.id || null, groupId: body?.data?.groupId || null });
    if (path === "/api/canonical-bookings" && method === "POST") net.canonical.push({ http: res.status(), bookingId: body?.data?.bookingId || null, status: body?.data?.status || null, error: body?.error || null });
    if (path === "/api/customer-checkout" && method === "POST" && /"action":"start"/.test(post)) net.checkout.push({ http: res.status(), orderId: body?.data?.orderId || body?.data?.razorpay_order_id || null, amountPaise: body?.data?.amountPaise ?? null, status: body?.data?.status || null, error: body?.error || null, code: body?.code || null });
    if (path === "/api/boarding-stays" && method === "POST") net.care.push({ http: res.status(), status: body?.data?.status || null, error: body?.error || null });
  });
  return net;
}
/** Boarding endpoint calls that the V2 client aborted (its own 15 s / 20 s timeouts) or that ran longer than 15 s. */
export function slowBoardingCalls(net) {
  const watched = ["/api/boarding-commercial", "/api/canonical-bookings", "/api/uat-scheduling", "/api/customer-checkout", "/api/boarding-stays", "/api/customer-account"];
  const rows = net.calls.filter(c => watched.includes(c.p));
  // Only aborts at the client timeouts count; a navigation away also aborts calls in flight.
  return { aborted: rows.filter(c => c.s === "ABORTED" && Number(c.ms) >= 14_000), slow: rows.filter(c => c.s !== "ABORTED" && Number(c.ms) > 15_000), all: rows };
}
export const callBrief = (c) => `${c.m} ${c.p} ${c.s}${c.ms != null ? ` ${Math.round(c.ms / 100) / 10}s` : ""}`;

// ------------------------------------------------------------------------------------------------ stay flow

/** Opens /v2/boarding signed in and waits until the Plan step can act (saved address checked, pets loaded). */
export async function openStay(flow, { path = "/v2/boarding" } = {}) {
  const { page } = flow;
  await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
  await dismissCookies(page);
  const cta = page.getByRole("button", { name: /^(See available homes|Verify a service address to continue|Select a pet to continue)$/ });
  const deadline = Date.now() + 90_000;
  let addressRetries = 0;
  while (Date.now() < deadline) {
    if (await page.getByText("Sign in to plan care.").isVisible().catch(() => false)) throw new Error("harness: /v2/boarding shows 'Sign in to plan care.' (customer session missing)");
    const retryAddress = page.getByRole("button", { name: "Retry address check" });
    if (await retryAddress.isVisible().catch(() => false) && addressRetries < 3) { addressRetries += 1; await robustClick(retryAddress); await page.waitForTimeout(1500); continue; }
    const text = oneLine(await cta.innerText({ timeout: 500 }).catch(() => ""));
    const checking = await page.getByText("Checking service area…").isVisible().catch(() => false);
    const loadingPets = await page.getByText("Loading your pets…").isVisible().catch(() => false);
    if (text && !checking && !loadingPets && (text === "See available homes" || Date.now() > deadline - 60_000)) return { cta: text, addressRetries };
    await page.waitForTimeout(700);
  }
  return { cta: oneLine(await cta.innerText({ timeout: 500 }).catch(() => "")), addressRetries, timedOut: true };
}

export async function setStayDates(page, { start, startTime, end, endTime }) {
  await page.getByLabel("Check-in date").fill(start);
  await page.getByLabel("Check-in time").fill(startTime);
  await page.getByLabel("Check-out date").fill(end);
  await page.getByLabel("Check-out time").fill(endTime);
  await page.waitForTimeout(400);
  return { summary: oneLine(await page.locator("[class*=durationSummary]").first().innerText({ timeout: 2000 }).catch(() => ""), 200) };
}

/** Makes the selected pets exactly `names` (the flow keeps at least one pet selected). */
export async function selectPets(page, names) {
  const buttons = page.locator("[class*=petList] button[aria-pressed]");
  await buttons.first().waitFor({ timeout: 30_000 });
  const byName = (name) => buttons.filter({ has: page.locator("b", { hasText: new RegExp(`^${esc(name)}$`) }) }).first();
  for (const name of names) {
    const b = byName(name);
    if (!(await b.count())) throw new Error(`harness: pet ${name} is not listed on the Plan step`);
    if ((await b.getAttribute("aria-pressed")) !== "true") await robustClick(b);
  }
  const count = await buttons.count();
  for (let i = 0; i < count; i++) {
    const b = buttons.nth(i), name = oneLine(await b.locator("b").first().innerText().catch(() => ""), 60);
    if (!names.includes(name) && (await b.getAttribute("aria-pressed")) === "true") await robustClick(b);
  }
  const selected = [];
  for (let i = 0; i < count; i++) { const b = buttons.nth(i); if ((await b.getAttribute("aria-pressed")) === "true") selected.push(oneLine(await b.locator("b").first().innerText(), 60)); }
  return selected;
}

export async function toggleChips(page, labels) {
  for (const label of labels) await robustClick(page.getByRole("button", { name: new RegExp(`^[＋✓]\\s*${esc(label)}$`) }).first());
}

const hostCards = (page) => page.locator("[class*=caregivers] > button");

/**
 * Plan → Match. Waits for the governed host list; when the V2 client gives up ("Boarding request timed out") it uses
 * the page's own "Retry host search" control, like a customer would, and counts the retries.
 */
export async function toHosts(flow, { maxRetries = 4 } = {}) {
  const { page } = flow;
  const out = { retries: 0, hosts: [], alert: "", timeouts: 0 };
  const see = page.getByRole("button", { name: "See available homes" });
  if (!(await see.isEnabled().catch(() => false))) { out.blocked = oneLine(await page.getByRole("button", { name: /^(See available homes|Verify a service address to continue|Select a pet to continue)$/ }).innerText().catch(() => "")); return out; }
  await robustClick(see);
  for (;;) {
    const deadline = Date.now() + 60_000;
    let state = "timeout";
    while (Date.now() < deadline) {
      if (await hostCards(page).count()) { state = "hosts"; break; }
      const retry = page.getByRole("button", { name: "Retry host search" });
      if (await retry.isVisible().catch(() => false)) { state = "retry"; break; }
      const none = page.getByText(/No verified Boarding host currently has capacity/).first();
      if (await none.isVisible().catch(() => false)) { state = "none"; break; }
      await page.waitForTimeout(500);
    }
    if (state === "hosts") break;
    out.alert = oneLine(await page.locator("p[role=alert]").first().innerText({ timeout: 800 }).catch(() => ""), 300);
    if (/timed out/i.test(out.alert)) out.timeouts += 1;
    if (state === "none" || state === "timeout" || out.retries >= maxRetries) { out.state = state; return out; }
    out.retries += 1;
    await robustClick(page.getByRole("button", { name: "Retry host search" }));
  }
  out.state = "hosts";
  const cards = hostCards(page), n = await cards.count();
  for (let i = 0; i < n; i++) {
    const card = cards.nth(i), text = oneLine(await card.innerText().catch(() => ""), 400);
    out.hosts.push({ name: oneLine(await card.locator("h4").first().innerText().catch(() => ""), 80), spots: Number(text.match(/(\d+) guest-pet spots? available/)?.[1] ?? NaN), text });
  }
  return out;
}

/** Waits until the governed quote price is on the selected card; uses the page's "Retry price" control on timeouts. */
export async function waitCardPrice(flow, { maxRetries = 6 } = {}) {
  const { page } = flow;
  let retries = 0, timeouts = 0;
  for (let i = 0; i < 200; i++) {
    const text = oneLine(await hostCards(page).first().locator("strong").first().innerText({ timeout: 1000 }).catch(() => ""), 120);
    if (/₹/.test(text)) return { price: text, retries, timeouts };
    const retry = page.getByRole("button", { name: "Retry price" });
    if (await retry.isVisible().catch(() => false)) {
      const alert = oneLine(await page.locator("div[role=alert] p").first().innerText({ timeout: 800 }).catch(() => ""), 200);
      if (/timed out/i.test(alert)) timeouts += 1;
      if (retries >= maxRetries) return { price: text, retries, timeouts, alert };
      retries += 1; await robustClick(retry); await page.waitForTimeout(1500); continue;
    }
    await page.waitForTimeout(700);
  }
  return { price: "", retries, timeouts };
}

export async function chooseHost(page, name) {
  const card = hostCards(page).filter({ has: page.locator("h4", { hasText: new RegExp(`^${esc(name)}$`) }) }).first();
  if (!(await card.count())) return false;
  await robustClick(card); await page.waitForTimeout(500);
  return true;
}

export async function toCareCard(page) {
  const cont = page.getByRole("button", { name: /^Continue with / });
  await cont.waitFor({ timeout: 20_000 });
  const host = oneLine((await cont.innerText()).replace(/^Continue with\s*/, ""), 60);
  await robustClick(cont);
  await page.getByRole("button", { name: "Review protected booking" }).waitFor({ timeout: 20_000 });
  return host;
}

export const CARE_LABELS = { feeding: "Food and water routine", medication: "Medication and allergy instructions from your vet", vet: "Vet contact", emergencyContact: "Emergency contact", specialInstructions: "Other care instructions" };
export async function fillCareCard(page, care, { extras = [], food = "" } = {}) {
  for (const [key, label] of Object.entries(CARE_LABELS)) if (care[key] !== undefined) await page.getByLabel(new RegExp(`^${esc(label)}`)).first().fill(care[key]);
  await toggleChips(page, extras);
  if (food) await page.getByLabel("Food preference").selectOption({ label: food });
  const extrasOnScreen = [];
  for (const b of await page.locator("[class*=benefitGrid] button").all()) extrasOnScreen.push(oneLine(await b.innerText(), 60));
  const foodOptions = (await page.getByLabel("Food preference").locator("option").allInnerTexts().catch(() => [])).map(t => oneLine(t, 60));
  return { extrasOnScreen, foodOptions };
}

/** Care Card → Review; picks the payment option when the split is offered; ticks consent; waits for a priced CTA. */
export async function toReview(flow, { split } = {}) {
  const { page } = flow;
  await robustClick(page.getByRole("button", { name: "Review protected booking" }));
  await page.locator("[aria-label='Review stay details']").waitFor({ timeout: 20_000 });
  const splitOffered = await page.getByRole("button", { name: /Reserve with 50% now/ }).isVisible().catch(() => false);
  if (splitOffered && split === false) await robustClick(page.getByRole("button", { name: /Pay the full amount now/ }));
  if (splitOffered && split === true) await robustClick(page.getByRole("button", { name: /Reserve with 50% now/ }));
  const consent = page.getByLabel(/I agree to care/);
  if (!(await consent.isChecked().catch(() => false))) await consent.check();
  const cta = page.getByRole("button", { name: /^(Create stay request & review payment|Calculating price…|Price unavailable|Locking care capacity…)$/ });
  let priceRetries = 0, priceTimeouts = 0;
  for (let i = 0; i < 240; i++) {
    const text = oneLine(await cta.innerText({ timeout: 1000 }).catch(() => ""));
    if (text === "Create stay request & review payment") break;
    const retry = page.getByRole("button", { name: "Retry price" });
    if (await retry.isVisible().catch(() => false) && priceRetries < 6) {
      const alert = oneLine(await page.locator("div[role=alert] p").first().innerText({ timeout: 800 }).catch(() => ""), 200);
      if (/timed out/i.test(alert)) priceTimeouts += 1;
      priceRetries += 1; await robustClick(retry); await page.waitForTimeout(1500);
      if (!(await consent.isChecked().catch(() => false))) await consent.check().catch(() => {});
      continue;
    }
    await page.waitForTimeout(700);
  }
  await page.waitForTimeout(600);
  return { splitOffered, priceRetries, priceTimeouts, ...(await readReview(page)) };
}

export async function readReview(page) {
  const review = oneLine(await page.locator("[aria-label='Review stay details']").innerText().catch(() => ""), 1200);
  const bill = oneLine(await page.locator("[class*=bill]").first().innerText().catch(() => ""), 600);
  const billLines = [];
  for (const line of await page.locator("[class*=bill] > span, [class*=bill] > strong").all()) billLines.push(oneLine(await line.innerText().catch(() => ""), 160));
  const totalText = oneLine(await page.locator("[class*=bill] strong b").first().innerText().catch(() => ""), 60);
  const payChoice = oneLine(await page.locator("[class*=paymentChoice],[class*=fullPaymentNote]").first().innerText().catch(() => ""), 400);
  const hints = (await page.locator("p[class*=hint]").allInnerTexts().catch(() => [])).map(t => oneLine(t, 300));
  const cta = oneLine(await page.getByRole("button", { name: /^(Create stay request & review payment|Calculating price…|Price unavailable|Locking care capacity…)$/ }).innerText({ timeout: 1000 }).catch(() => ""));
  const rows = {};
  for (const span of await page.locator("[aria-label='Review stay details'] > span").all()) {
    const label = oneLine(await span.evaluate(el => el.firstChild?.textContent || "").catch(() => ""), 60), value = oneLine(await span.locator("b").first().innerText().catch(() => ""), 400);
    if (label) rows[label] = value;
  }
  return { review, bill, billLines, totalText, total: parseMoney(totalText), payChoice, hints, cta, rows };
}
export function parseMoney(text) { const m = String(text || "").match(/₹\s?([\d,]+(?:\.\d+)?)/); return m ? Number(m[1].replace(/,/g, "")) : null; }

/**
 * Review → "Create stay request & review payment". The flow re-reads hosts and the quote, reserves the host, creates
 * the canonical booking and saves the Care Card; retrying the button reuses the same attempt (same idempotency key).
 * Returns once the payment step shows "Pay securely", the create call failed for good, or the flow refused.
 */
export async function createStay(flow, net, { maxAttempts = 5, expectRefusal = false } = {}) {
  const { page } = flow;
  const out = { attempts: 0, errors: [], bookingId: null };
  const cta = page.getByRole("button", { name: "Create stay request & review payment" });
  const consent = page.getByLabel(/I agree to care/);
  while (out.attempts < maxAttempts) {
    out.attempts += 1;
    if (!(await consent.isChecked().catch(() => true))) await consent.check().catch(() => {});
    await cta.waitFor({ timeout: 60_000 }).catch(() => {});
    if (!(await cta.isEnabled().catch(() => false))) { out.errors.push(`CTA not enabled: ${oneLine(await page.locator("button[class*=primary]").last().innerText().catch(() => ""))}`); break; }
    const before = net.canonical.length;
    await robustClick(cta);
    await page.waitForTimeout(1200); // the click clears the previous attempt's alert on the next render
    const deadline = Date.now() + 180_000;
    let state = "timeout";
    while (Date.now() < deadline) {
      if (await page.getByRole("button", { name: /^Pay securely/ }).first().isVisible().catch(() => false)) { state = "payment"; break; }
      if (await page.getByRole("button", { name: "Retry saving care instructions" }).isEnabled().catch(() => false) && await page.getByText(/Save care instructions before payment/).isVisible().catch(() => false)) { state = "care-gate"; break; }
      const busy = await page.getByRole("button", { name: "Locking care capacity…" }).isVisible().catch(() => false);
      const alert = oneLine(await page.locator("[class*=flow] > p[role=alert]").first().innerText({ timeout: 300 }).catch(() => ""), 300);
      if (!busy && alert) { state = "alert"; out.lastAlert = alert; break; }
      await page.waitForTimeout(600);
    }
    out.state = state;
    const created = net.canonical.slice(before).find(c => c.bookingId) || net.canonical.find(c => c.bookingId);
    if (created) out.bookingId = created.bookingId;
    if (!out.bookingId) out.bookingId = new URL(page.url()).searchParams.get("bookingId");
    if (state === "payment") break;
    if (state === "care-gate") {
      const payVisible = () => page.getByRole("button", { name: /^Pay securely/ }).first().isVisible().catch(() => false);
      const retry = page.getByRole("button", { name: "Retry saving care instructions" });
      for (let i = 0; i < 6 && !(await payVisible()); i++) {
        out.errors.push(`care gate: ${oneLine(await page.locator("section[aria-label='Save stay care before payment'] [role=alert]").first().innerText({ timeout: 500 }).catch(() => ""), 200)}`);
        out.careGateRetries = (out.careGateRetries || 0) + 1;
        await robustClick(retry);
        await page.waitForTimeout(1500);
        for (const until = Date.now() + 90_000; Date.now() < until;) { if (await payVisible() || await retry.isEnabled().catch(() => false)) break; await page.waitForTimeout(600); }
      }
      out.state = (await page.getByRole("button", { name: /^Pay securely/ }).first().isVisible().catch(() => false)) ? "payment" : "care-gate";
      break;
    }
    if (state === "alert") {
      out.errors.push(out.lastAlert);
      // Transport failures (client timeouts, a non-JSON gateway body) are retried with the same attempt, which the
      // page keys to one idempotent reservation and booking; a governed refusal is final.
      if (!TRANSPORT.test(out.lastAlert) || (expectRefusal && out.attempts >= 3)) break;
      out.transportRetries = (out.transportRetries || 0) + 1;
      await page.waitForTimeout(2000);
      continue;
    }
    break;
  }
  out.paymentText = out.state === "payment" ? oneLine(await page.locator("section[aria-label='Boarding payment']").first().innerText().catch(() => ""), 600) : "";
  out.referenceShown = out.bookingId ? (await mainText(page)).includes(out.bookingId) : false;
  return out;
}

/** Customer projection of the booking/payment (the same call the booking page makes). */
export async function checkoutStatus(context, bookingId) {
  const r = await api(context, "POST", "/api/customer-checkout", { action: "status", bookingId }, { timeout: 60_000 }).catch(e => ({ status: 0, body: { error: String(e?.message || e) } }));
  const d = r.body?.data || {}, c = d.confirmation || {};
  return { http: r.status, status: d.status, bookingStatus: c.bookingStatus, paymentStatus: c.paymentStatus, paymentMode: c.paymentMode, paymentStage: c.paymentStage, amountDueNow: c.amountDueNow, amountPaid: c.amountPaid, balanceDueAt: c.balanceDueAt, balancePayableNow: c.balancePayableNow, totalAmount: c.totalAmount, providerId: c.providerId, providerName: c.providerName, ready: c.ready, gatewayPaymentId: c.gatewayPaymentId || c.transactionId || null, error: r.body?.error };
}

/**
 * Clicks the payment button of a BookingPaymentPage and waits for the Razorpay TEST checkout. The page's checkout
 * start call has its own 15 s client timeout; when it gives up the button returns, and it is clicked again (at most
 * three times), as a customer would.
 */
export async function openCheckout(flow, net, { button = /^Pay securely/ } = {}) {
  const { page } = flow;
  const pay = page.getByRole("button", { name: button }).first();
  await pay.waitFor({ timeout: 60_000 });
  const label = oneLine(await pay.innerText());
  const before = net.checkout.length, alerts = [];
  const t0 = Date.now();
  let opened = false, clicks = 0;
  while (!opened && clicks < 3) {
    clicks += 1;
    await robustClick(pay);
    const t1 = Date.now();
    while (Date.now() - t1 < 75_000) {
      await page.waitForTimeout(800);
      opened = page.frames().some(f => f !== page.mainFrame() && /razorpay/i.test(f.url()));
      if (opened) break;
      const alert = oneLine((await page.locator("section[aria-label$='payment'] [role=alert]").allInnerTexts().catch(() => [])).join(" | "), 300);
      if (alert && await pay.isEnabled().catch(() => false)) { alerts.push(alert); break; }
    }
    if (!opened && !TRANSPORT.test(alerts.at(-1) || "timed out")) break;
  }
  const order = net.checkout.slice(before).filter(o => o.orderId).at(-1) || net.checkout.slice(before).at(-1) || null;
  const starts = net.calls.filter(c => c.p === "/api/customer-checkout").slice(-6).map(callBrief);
  return { label, opened, alert: alerts.join(" | "), clicks, order, openMs: Date.now() - t0, starts };
}

/** Polls the customer projection until this instalment is captured (or the wait runs out). */
export async function waitCaptured(context, bookingId, { timeoutMs = 150_000, stage } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await checkoutStatus(context, bookingId);
    const done = stage === "balance" ? last.paymentStage === "settled" : last.paymentStatus === "captured";
    if (done && ["confirmed", "assigned", "awaiting_host_acceptance", "in_progress"].includes(String(last.bookingStatus))) return { captured: true, status: last };
    if (done && Date.now() > deadline - timeoutMs / 2) return { captured: true, status: last };
    await new Promise(r => setTimeout(r, 5000));
  }
  return { captured: false, status: last };
}

/**
 * Razorpay TEST Netbanking → Success. On a phone-sized viewport Razorpay opens on a full contact page
 * (data-testid contact-container) rather than the desktop contact overlay the shared helper handles, so that step
 * is done here first; the shared payRazorpayTestNetbanking then completes the payment.
 */
export async function payRazorpay(page, { phone = "9000000841", timeoutMs = 120_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let layout = "", hdfc = false, hdfcAt = 0, bankClicks = 0, contactAt = 0;
  const clickSuccess = async () => {
    for (const p of page.context().pages()) for (const surface of [p, ...p.frames()]) {
      const ok = surface.getByRole("button", { name: /^Success$/i }).first();
      if (await ok.isVisible().catch(() => false)) { await ok.click({ timeout: 5000 }).catch(() => {}); return true; }
    }
    return false;
  };
  while (Date.now() < deadline && !["desktop", "phone-fallback"].includes(layout)) {
    if (hdfc) {
      if (await clickSuccess()) return { ok: true, layout, netbanking: true, bank: true, bankClicks };
      // A click during the sheet's transition opens nothing: choose the bank again if no mock-bank window appeared.
      if (Date.now() - hdfcAt > 12_000 && page.context().pages().length === 1 && bankClicks < 4) hdfc = false;
      await page.waitForTimeout(700); continue;
    }
    for (const frame of page.frames().filter(f => f !== page.mainFrame() && /razorpay/i.test(f.url()))) {
      // Desktop wraps the contact form in an overlay (present in the DOM even before it is visible).
      if (await frame.locator('[data-testid="contact-overlay-container"]').count().catch(() => 0)) { layout = layout === "phone" ? "phone-fallback" : "desktop"; break; }
      if (layout !== "phone" && await frame.locator('[data-testid="contact-container"]').first().isVisible().catch(() => false)) {
        layout = "phone"; contactAt = Date.now();
        await frame.locator('[data-testid="contactNumber"], input[name="contact"]').first().fill(phone, { timeout: 5000 }).catch(() => {});
        await frame.getByRole("button", { name: /^Continue$/i }).first().click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(4500); // the payment sheet slides in; a click during the transition does nothing
      }
      const bank = frame.getByText(/HDFC Bank Netbanking/).first();
      if (layout === "phone" && await bank.isVisible().catch(() => false)) { await bank.click({ timeout: 5000 }).catch(() => {}); hdfc = true; hdfcAt = Date.now(); bankClicks += 1; await page.waitForTimeout(2500); }
      else if (layout === "phone" && Date.now() - contactAt > 10_000) layout = "phone-fallback"; // no shortcut offered
      if (!layout && await frame.locator('[data-testid="netbanking"]').first().isVisible().catch(() => false)) layout = "desktop";
    }
    await page.waitForTimeout(700);
  }
  if (layout !== "phone") return { ...(await payRazorpayTestNetbanking(page, { phone, timeoutMs: Math.max(30_000, deadline - Date.now()) })), layout: layout || "unknown" };
  const last = await payRazorpayTestNetbanking(page, { phone, timeoutMs: 45_000 }); // last resort: the shared desktop path
  if (last.ok) return { ...last, layout: "phone→shared" };
  const frame = page.frames().find(f => f !== page.mainFrame() && /razorpay/i.test(f.url()));
  const screen = oneLine(await frame?.locator("body").innerText({ timeout: 2000 }).catch(() => "") || "", 300);
  return { ok: false, layout, netbanking: hdfc, bank: hdfc, bankClicks, pages: page.context().pages().map(p => p.url().slice(0, 60)), screen, error: "Razorpay TEST phone layout: the HDFC mock bank Success control was not reached" };
}

/** Full Razorpay TEST payment from whichever BookingPaymentPage is on screen. */
export async function payOnScreen(flow, net, bookingId, { button = /^Pay securely/, stage } = {}) {
  const { page, context } = flow;
  const open = await openCheckout(flow, net, { button });
  if (!open.opened) return { ...open, paid: null, captured: false, shotOpen: await flow.shot(`checkout-not-opened-${stage || "full"}`, { fullPage: false }) };
  // No screenshot while the Razorpay sheet opens: on a phone viewport it stopped the mock bank window from opening.
  const paid = await payRazorpay(page);
  const shotOpen = await flow.shot(`razorpay-${paid.ok ? "done" : "stuck"}-${stage || "full"}`, { fullPage: false });
  const capture = await waitCaptured(context, bookingId, { stage });
  return { ...open, paid, shotOpen, ...capture };
}

/** /v2/booking?bookingId= — the customer booking & payment page. */
export async function readBookingPage(flow, bookingId, label) {
  const { page } = flow;
  await page.goto(`${BASE}/v2/booking?bookingId=${encodeURIComponent(bookingId)}`, { waitUntil: "domcontentloaded" });
  await dismissCookies(page);
  for (let i = 0; i < 4; i++) {
    await page.getByText("Loading your booking…").waitFor({ state: "detached", timeout: 90_000 }).catch(() => {});
    const retry = page.getByRole("button", { name: "Retry booking" });
    if (!(await retry.isVisible().catch(() => false))) break;
    flow.bookingPageRetries = (flow.bookingPageRetries || 0) + 1;
    await robustClick(retry);
  }
  await settle(page, 1200);
  const text = await mainText(page);
  const shot = await flow.shot(label);
  const payment = oneLine(await page.locator("section[aria-label$='payment']").first().innerText({ timeout: 1500 }).catch(() => ""), 600);
  return {
    text, shot, payment,
    status: (text.match(/Status: ([a-z ]+?)(?= \d| ·|$)/i) || [])[1] || null,
    paymentStatus: (text.match(/Payment: ([a-z_ ]+?)(?= Manage| Refresh|$)/i) || [])[1] || null,
    total: parseMoney((text.match(/Total: ₹[\d,.]+/) || [""])[0]),
    payButton: (text.match(/Pay securely · ₹[\d,.]+|Pay balance · ₹[\d,.]+/) || [null])[0],
    balanceLine: (payment.match(/Balance(?: · due by [^₹]+)?₹[\d,.]+/) || [null])[0],
    dueBy: (payment.match(/due by ([^₹]+?)(?=₹)/) || [])[1] || null,
    paidSoFar: parseMoney((payment.match(/Paid so far\s*₹[\d,.]+/) || [""])[0]),
  };
}

// ------------------------------------------------------------------------------------------------ manage page

export async function openManage(flow, bookingId, label) {
  const { page } = flow;
  // The panel's stay read has a 15 s client timeout; on a slow answer it shows "Stay record unavailable": reload.
  for (let attempt = 1; attempt <= 4; attempt++) {
    await page.goto(`${BASE}/v2/boarding/manage?bookingId=${encodeURIComponent(bookingId)}`, { waitUntil: "domcontentloaded" });
    await dismissCookies(page);
    await page.getByText("Loading stay status…").waitFor({ state: "detached", timeout: 60_000 }).catch(() => {});
    if (await page.locator("[class*=careLive] h4").first().waitFor({ timeout: 20_000 }).then(() => true).catch(() => false)) break;
    flow.manageReloads = (flow.manageReloads || 0) + 1;
  }
  await settle(page, 1000);
  return readManage(flow, label);
}
export async function readManage(flow, label) {
  const { page } = flow;
  const text = await mainText(page);
  const status = oneLine(await page.locator("[class*=careLive] h4").first().innerText({ timeout: 3000 }).catch(() => ""), 80);
  const careHeader = oneLine(await page.getByText(/^CARE PLAN · /).first().innerText({ timeout: 1000 }).catch(() => ""), 80);
  const extensionButton = page.getByRole("button", { name: /^(Request extension|Checking capacity…)$/ });
  const conversation = oneLine(await page.locator("section[aria-label='Caregiver booking conversation']").first().innerText({ timeout: 2000 }).catch(() => ""), 500);
  const canMessage = await page.getByRole("button", { name: "Send in PawSpace" }).isEnabled().catch(() => false) || await page.locator("section[aria-label='Caregiver booking conversation'] textarea").isEnabled().catch(() => false);
  const shot = label ? await flow.shot(label) : null;
  return { text, status, careHeader, extensionEnabled: await extensionButton.isEnabled().catch(() => false), conversation, canMessage, shot };
}
/**
 * Runs one manage-page action and returns what the panel then says: its confirmation line (a p.hint without a role)
 * or its error (p[role=alert]). The panel clears both when an action starts, so an older load error does not count.
 */
export async function manageAction(page, button, { busyLabel, expect = /recorded|saved/i, timeoutMs = 120_000 } = {}) {
  const started = Date.now();
  await robustClick(button);
  const busy = busyLabel ? page.getByRole("button", { name: busyLabel }) : null;
  await page.waitForTimeout(800);
  while (Date.now() - started < timeoutMs) {
    if (!busy || !(await busy.isVisible().catch(() => false))) break;
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(800);
  const alerts = (await page.locator("main p[role=alert]").allInnerTexts().catch(() => [])).map(t => oneLine(t, 300)).filter(Boolean);
  const hints = (await page.locator("main p[class*=hint]:not([role])").allInnerTexts().catch(() => [])).map(t => oneLine(t, 300));
  const message = hints.find(t => expect.test(t)) || "";
  return { ok: Boolean(message) && !alerts.length, message, alerts, ms: Date.now() - started };
}
/** Current values of the manage page's care-plan inputs. */
export async function readManageCare(page) {
  // A filled textarea's value joins its label's accessible name, so match the label text as a prefix.
  const value = (label) => page.getByLabel(new RegExp(`^${esc(label)}`)).first().inputValue().catch(() => null);
  return { emergencyContact: await value("Emergency contact"), vet: await value("Vet details"), feeding: await value("Feeding routine"), medication: await value("Medication / allergies"), specialInstructions: await value("Special instructions") };
}

// ------------------------------------------------------------------------------------------------ host workspace

/** /host?bookingId= (the Boarding host workspace the partner app links to). */
export async function openHost(flow, bookingId, { v2 = false } = {}) {
  const { page } = flow;
  await page.goto(`${BASE}${v2 ? "/v2/partner/host" : "/host"}?bookingId=${encodeURIComponent(bookingId)}`, { waitUntil: "domcontentloaded" });
  await dismissCookies(page);
  await page.getByText("Loading governed Boarding stays…").waitFor({ state: "detached", timeout: 90_000 }).catch(() => {});
  await settle(page, 1200);
  return mainText(page);
}
export async function hostTab(page, name) { await robustClick(page.locator("aside nav button").filter({ hasText: name }).first()); await page.waitForTimeout(800); }
