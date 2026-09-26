// Private helpers for 40-taxi-journeys: drive the real V2 5-step Pet Taxi flow (/v2/taxi → app/mobile-app/taxi-flow.tsx)
// the way a customer does, and read back what the server said on the way.
import { BASE, settle, api, dismissCookies, isoDay, payRazorpayTestNetbanking } from "../lib.mjs";

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const istMs = (date, hhmm) => Date.parse(`${date}T${hhmm}:00+05:30`);
/** The pickup times the flow offers (06:00–19:00 IST, 30-minute steps; each ride holds a driver and a car for 3 hours). */
export const TIMES = Array.from({ length: 27 }, (_, i) => { const m = 360 + i * 30; return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; });
/** Same formatter the flow uses (lib/taxi-presentation.ts taxiMoney). */
export const inr = v => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(Number(v));
export const num = s => Number(String(s || "").replace(/[₹,\s]/g, ""));
export const text = async (page, sel = "main") => (await page.locator(sel).first().innerText({ timeout: 10_000 }).catch(() => "")).replace(/\s*\n+\s*/g, " | ");

// Mirror of lib/taxi-business-rules.ts calculateTaxiFare (same as 06-money-and-maps expectedFare).
const VEH = { citroen_ec3: { base: 500, perKm: 35, wait: 150, airport: 2300 }, xuv: { base: 600, perKm: 40, wait: 200, airport: 2600 } };
const round2 = v => Math.round((v + Number.EPSILON) * 100) / 100;
export function expectedFare(v, q) {
  const veh = VEH[v], km = round2(Number(q.distanceKm));
  const distanceFare = q.ridePurpose === "airport" ? veh.airport : round2(veh.base + Math.max(0, km - 5) * veh.perKm);
  const waiting = q.tripType === "round_trip" ? q.waitingMinutes / 30 * veh.wait : 0;
  const handler = q.passengerCount === 0 ? 300 : 0;
  const total = round2(distanceFare + waiting + handler);
  return { distanceFare, waiting, handler, total, fee: round2(total / 2), balance: round2(total - round2(total / 2)) };
}
/** Citroën eligibility per the rules: >3 passengers, >3 pets, >3 bags or >70 km need the XUV. */
export function citroenReasons(q) {
  const r = [];
  if (q.passengerCount > 3) r.push("more_than_3_passengers");
  if (q.petCount > 3) r.push("more_than_3_pets");
  if (q.luggageCount > 3) r.push("more_than_3_luggage_items");
  if (Number(q.distanceKm) > 70) r.push("route_over_70_km");
  return r;
}

/** Timings and bodies of the API calls a journey makes (the lib flow log keeps only failures). */
export function instrument(flow) {
  const cap = flow.cap = { timings: [], last: {} };
  const started = new Map();
  flow.page.on("request", r => { if (r.url().startsWith(BASE) && r.url().includes("/api/")) started.set(r, Date.now()); });
  flow.page.on("response", async r => {
    const t0 = started.get(r.request()); if (t0 === undefined) return; started.delete(r.request());
    const path = new URL(r.url()).pathname, method = r.request().method(), status = r.status(), ms = Date.now() - t0;
    cap.timings.push({ path, method, status, ms });
    if (method === "POST" && /taxi-commercial|uat-scheduling|taxi-ride-bookings|taxi-finance|taxi-lifecycle|customer-checkout/.test(path)) {
      let body = null; const raw = await r.text().catch(() => "");
      try { body = JSON.parse(raw); } catch { body = raw.slice(0, 300); }
      cap.last[path] = { status, ms, body, at: Date.now() };
    }
  });
  return cap;
}
/** A 502 "upstream request failed" is the sandbox egress proxy of a local container cutting a >30 s request, not staging. */
export const isLocalProxyCut = e => e && e.status === 502 && /^upstream request failed/.test(typeof e.body === "string" ? e.body : "");

async function waitFor(fn, ms, step = 500) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(step); } return null; }
const alertText = async page => (await page.locator("[class*=alert]").allInnerTexts().catch(() => [])).map(t => t.trim()).filter(Boolean).join(" | ");

export const LEGACY_TAXI = "/v2/taxi serves the legacy Gate-1 'PET TAXI · CANONICAL UAT — Book one governed trip' page (synthetic route classes, ₹0 due now), not the 5-step ride flow";
/** Open /v2/taxi signed in and wait for the travelling-pets step. */
export async function openTaxi(flow) {
  const { page } = flow;
  await page.goto(`${BASE}/v2/taxi`, { waitUntil: "domcontentloaded" });
  await dismissCookies(page); await settle(page, 1500); await dismissCookies(page);
  // The flow gives up loading the account after 15 s and offers "Retry account"; a customer presses it.
  flow.accountRetries = flow.accountRetries || 0;
  for (let i = 0; i < 3; i++) {
    const ready = await Promise.race([
      page.getByRole("button", { name: "Continue to trip details" }).waitFor({ timeout: 60_000 }).then(() => true),
      page.getByRole("button", { name: "Retry account" }).waitFor({ timeout: 60_000 }).then(() => false),
      page.getByText(/Book one governed trip|CANONICAL UAT/).first().waitFor({ timeout: 60_000 }).then(() => "legacy"),
    ]).catch(() => null);
    if (ready === "legacy") throw new Error(LEGACY_TAXI);
    if (ready !== false) break;
    flow.accountRetries += 1;
    await page.getByRole("button", { name: "Retry account" }).click();
  }
  await page.getByRole("button", { name: "Continue to trip details" }).waitFor({ timeout: 45_000 });
  await page.locator("button[aria-pressed]").first().waitFor({ timeout: 30_000 });
}

/**
 * Steps 1–2 of the flow. The address fields are typed character by character like a customer; the flow offers no
 * suggestion list (the server geocodes the typed text with Google when it prices the route), which is noted.
 */
export async function fillParty(flow, o) {
  const { page } = flow;
  await page.getByLabel("Passengers").selectOption(String(o.passengers));
  await page.getByLabel("Luggage").selectOption(String(o.luggage ?? 0));
  for (const btn of await page.locator("button[aria-pressed]").all()) {
    const label = (await btn.innerText()).replace(/\s+/g, " ");
    const want = o.pets.some(name => label.includes(name)), pressed = (await btn.getAttribute("aria-pressed")) === "true";
    if (want !== pressed) await btn.click();
  }
  if (o.hyperactive) await page.getByLabel(/Hyperactive/).check();
  const note = await page.getByText(/handler charge/).first().innerText({ timeout: 2000 }).catch(() => "");
  return { handlerNote: note };
}
export async function fillTrip(flow, o, { typeAddresses = true } = {}) {
  const { page } = flow;
  await page.getByRole("button", { name: o.trip === "round_trip" ? "Round trip" : "One-way", exact: true }).click();
  await page.getByRole("button", { name: o.purpose === "airport" ? "Airport flat fare" : "City / regular", exact: true }).click();
  const out = { suggestions: 0 };
  const pickup = page.getByLabel("Pickup address");
  if (typeAddresses) {
    await pickup.fill(""); await pickup.pressSequentially(o.pickup, { delay: 25 });
    await page.waitForTimeout(1200);
    out.suggestions = await page.locator("[role=listbox]:visible, [role=option]:visible:not(option)").count();
  } else await pickup.fill(o.pickup);
  const drop = page.getByLabel("Drop address / Point 1");
  if (typeAddresses) { await drop.fill(""); await drop.pressSequentially(o.drop, { delay: 25 }); } else await drop.fill(o.drop);
  if (o.trip === "round_trip") {
    await page.getByLabel("Return drop address").fill(o.returnDrop);
    await page.getByLabel("Planned waiting").selectOption(String(o.waiting || 0));
  }
  await setWhen(flow, o.date, o.time);
  return out;
}
export async function setWhen(flow, date, time) {
  await flow.page.getByLabel("Pickup date").fill(date);
  await flow.page.getByLabel("Pickup time").selectOption(time);
}

/** Steps 2→3→4: review and price the ride. Returns the server quote and what step 4 shows. One retry on a 5xx. */
export async function priceRide(flow, { shotLabel = "quote" } = {}) {
  const { page, cap } = flow;
  await page.getByRole("button", { name: "Review ride requirements" }).click();
  await page.getByRole("button", { name: /Calculate Citro/ }).waitFor({ timeout: 15_000 });
  const attempts = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    delete cap.last["/api/taxi-commercial"];
    const t0 = Date.now();
    await page.getByRole("button", { name: /Calculate Citro/ }).click();
    const res = await waitFor(() => cap.last["/api/taxi-commercial"], 110_000);
    await waitFor(async () => (await page.getByRole("heading", { name: "Choose your car" }).isVisible().catch(() => false)) || (await alertText(page)), 15_000);
    await settle(page, 400);
    attempts.push({ status: res?.status ?? null, ms: Date.now() - t0, alert: await alertText(page) });
    if (res?.status === 201) {
      const q = res.body?.data;
      const step4 = await text(page);
      return { ok: true, q, step4, ms: res.ms, attempts, evidence: [await flow.shot(`${shotLabel}-step4`)] };
    }
    if (!res || res.status < 500) break; // a governed refusal is the answer; only a 5xx is retried, as a customer would
  }
  return { ok: false, attempts, error: attempts.at(-1)?.alert || `quote HTTP ${attempts.at(-1)?.status}`, status: attempts.at(-1)?.status, evidence: [await flow.shot(`${shotLabel}-refused`)] };
}

/** What each vehicle card shows on step 4. */
export async function readCards(flow) {
  const cards = {};
  for (const [code, label] of [["citroen_ec3", "Citroen eC3"], ["xuv", "XUV"]]) {
    const card = flow.page.locator("button").filter({ hasText: "booking fee · 50%" }).filter({ hasText: label }).first();
    cards[code] = { disabled: await card.isDisabled().catch(() => null), text: (await card.innerText().catch(() => "")).replace(/\s*\n+\s*/g, " | ") };
  }
  return cards;
}
export async function chooseVehicle(flow, code) {
  const card = flow.page.locator("button").filter({ hasText: "booking fee · 50%" }).filter({ hasText: code === "xuv" ? "XUV" : "Citroen eC3" }).first();
  if (!(await card.isDisabled())) await card.click();
}
/** The fare rows under the cards for the selected vehicle. */
export function fareRows(step4) {
  const pick = label => { const m = step4.match(new RegExp(`${label} \\| (₹[\\d,.]+)`)); return m ? num(m[1]) : null; };
  return { distanceFare: pick("Distance fare"), waiting: pick("Planned waiting"), handler: pick("Handler"), total: pick("Total"), fee: pick("Pay now to confirm"), balance: pick("Final base balance") };
}

/**
 * Step 4 → 5: PIN, Reserve. Returns the booking or the refusal the customer saw, with the scheduler's driver choice.
 * A cut by the local egress proxy (>30 s) is retried once with the same quote (the request id is idempotent).
 */
export async function reserveRide(flow, { pin = "560038", shotLabel = "reserve" } = {}) {
  const { page, cap } = flow;
  await page.getByLabel("Pickup PIN code").fill(pin);
  const button = page.getByRole("button", { name: /^Reserve · pay/ });
  const label = await button.innerText().catch(() => "");
  const out = { label, attempts: [] };
  for (let attempt = 0; attempt < 2; attempt++) {
    delete cap.last["/api/uat-scheduling"]; delete cap.last["/api/taxi-ride-bookings"];
    const t0 = Date.now();
    await button.click();
    const done = await waitFor(async () => {
      if (await page.getByText(/RIDE HELD|TAXI CONFIRMED/).first().isVisible().catch(() => false)) return "booked";
      const a = await alertText(page); if (a && !(await button.innerText().catch(() => "")).includes("Reserving")) return "refused";
      return null;
    }, 200_000, 750);
    await settle(page, 600);
    const sched = cap.last["/api/uat-scheduling"], created = cap.last["/api/taxi-ride-bookings"];
    const a = { outcome: done || "timeout", ms: Date.now() - t0, schedulingMs: sched?.ms ?? null, bookingMs: created?.ms ?? null, schedulingStatus: sched?.status ?? null, bookingStatus: created?.status ?? null, alert: await alertText(page) };
    a.providerId = sched?.body?.data?.provider?.id || null;
    a.schedulingError = sched && sched.status >= 400 ? sched.body : null;
    a.bookingError = created && created.status >= 400 ? created.body : null;
    out.attempts.push(a);
    if (done === "booked") {
      const step5 = await text(page);
      out.ok = true; out.step5 = step5;
      out.bookingId = (step5.match(/PS-UAT-TAXI-[A-Z0-9-]+/) || [])[0] || created?.body?.data?.bookingId || null;
      out.booking = created?.body?.data || null;
      out.providerId = a.providerId || null;
      out.evidence = [await flow.shot(`${shotLabel}-step5`)];
      return out;
    }
    const proxyCut = isLocalProxyCut(sched) || isLocalProxyCut(created);
    if (!proxyCut) break;
    a.harness = "local egress proxy cut a >30 s request; retried";
  }
  out.ok = false; out.error = out.attempts.at(-1)?.alert || out.attempts.at(-1)?.outcome;
  out.evidence = [await flow.shot(`${shotLabel}-refused`)];
  return out;
}
export const CAPACITY = /No (Citroen eC3|XUV) is free|NO_SCHEDULE_AVAILABLE|SLOT_TAKEN|No driver is available|availability changed|assignment changed/i;

/** Back from a step-4 refusal to the trip details (the party and addresses stay filled). */
export async function backToTrip(flow) {
  const { page } = flow;
  await page.getByRole("button", { name: "← Requirements" }).click().catch(() => {});
  await page.getByRole("button", { name: "← Trip details" }).click({ timeout: 10_000 }).catch(() => {});
  await page.getByLabel("Pickup date").waitFor({ timeout: 10_000 });
}

/** Wait for the server to show the payment captured and the ride confirmed (the signed webhook is authoritative). */
export async function waitCaptured(context, bookingId, ms = 150_000) {
  let st = null; const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const s = await api(context, "POST", "/api/customer-checkout", { action: "status", bookingId }).catch(() => null);
    st = s?.body?.data?.confirmation || s?.body?.data || st;
    if (st?.paymentStatus === "captured" && ["confirmed", "assigned"].includes(String(st?.bookingStatus))) break;
    await sleep(4000);
  }
  return st && { bookingStatus: st.bookingStatus, paymentStatus: st.paymentStatus, amountDueNow: st.amountDueNow, totalAmount: st.totalAmount, providerId: st.providerId, gatewayOrderId: st.gatewayOrderId, gatewayPaymentId: st.gatewayPaymentId, paymentStage: st.paymentStage, workOrderStatus: st.workOrderStatus, ms: Date.now() - t0 };
}
async function waitCheckoutOpen(page, ms = 60_000) {
  const t0 = Date.now(); let alerts = [];
  while (Date.now() - t0 < ms) {
    await sleep(1000);
    if (page.frames().some(f => f !== page.mainFrame() && /razorpay/i.test(f.url()))) return { opened: true, ms: Date.now() - t0 };
    alerts = (await page.locator("[role=alert]").allInnerTexts().catch(() => [])).filter(t => t.trim());
    if (alerts.length) break;
  }
  return { opened: false, ms: Date.now() - t0, alerts };
}

/**
 * The phone-sized Razorpay checkout asks for the contact number on a full page (not the desktop overlay the shared
 * helper handles): fill it the way a customer does, then hand over to payRazorpayTestNetbanking.
 */
async function razorpayContact(page, phone = "9000000841", ms = 45_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    for (const f of page.frames().filter(f => f !== page.mainFrame() && /razorpay/i.test(f.url()))) {
      if (await f.locator('[data-testid="netbanking"]').first().isVisible().catch(() => false)) return "methods";
      const input = f.locator('input[placeholder="Mobile number"], input[name="contact"]').first();
      if (await input.isVisible().catch(() => false)) {
        await input.fill(phone).catch(() => {});
        await f.getByRole("button", { name: /^Continue$/i }).first().click({ timeout: 5000 }).catch(() => {});
        await sleep(1500);
        return "contact";
      }
    }
    await sleep(700);
  }
  return "none";
}
/** Phone layout: Netbanking is an accordion and the chosen bank is submitted with the bottom "Continue" button. */
async function mobileNetbanking(page, ms = 90_000) {
  const frame = page.frames().find(f => f !== page.mainFrame() && /razorpay/i.test(f.url()));
  const cta = frame?.locator('[data-testid="bottom-cta-button"]').first();
  if (!frame || !(await cta.isVisible().catch(() => false))) return null;
  let nb = null;
  for (const t0 = Date.now(); !nb && Date.now() - t0 < 30_000; await sleep(700)) for (const c of await frame.locator('[data-testid="netbanking"]').all()) if (await c.isVisible().catch(() => false)) { nb = c; break; }
  if (!nb) return { ok: false, layout: "mobile", error: "Netbanking option not shown" };
  // The Netbanking row is an accordion: open it until the bank list shows, then pick the test bank.
  const hdfc = frame.getByText(/^HDFC( Bank)?$/).filter({ visible: true }).first();
  let picked = false;
  for (let i = 0; i < 3 && !picked; i++) {
    if (!(await hdfc.isVisible().catch(() => false))) await frame.getByText("Netbanking", { exact: true }).first().click({ timeout: 10_000 }).catch(() => nb.click({ timeout: 10_000, force: true }).catch(() => {}));
    await hdfc.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
    picked = await hdfc.click({ timeout: 4_000 }).then(() => true).catch(() => false);
  }
  await sleep(800);
  // A pick whose click raced the checkout moving on still counts: the Success control below is the proof.
  if (!picked) ms = 30_000;
  // Selecting the bank can submit on its own; otherwise the bottom Continue submits it.
  if (!page.context().pages().some(p => p !== page)) await cta.click({ timeout: 8_000 }).catch(() => frame.getByRole("button", { name: /^(Continue|Pay Now)$/ }).last().click({ timeout: 5_000 }).catch(() => {}));
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    for (const p of page.context().pages()) for (const surface of [p, ...p.frames()]) {
      const ok = surface.getByRole("button", { name: /^Success$/i }).first();
      if (await ok.isVisible().catch(() => false)) { await ok.click({ timeout: 5000 }).catch(() => {}); return { ok: true, netbanking: true, bank: true, layout: "mobile" }; }
    }
    await sleep(700);
  }
  return { ok: false, netbanking: true, bank: picked, layout: "mobile", error: picked ? "bank simulator Success control not reached" : "test bank not shown under Netbanking" };
}
const payWithRazorpay = async page => { const contact = await razorpayContact(page); const mobile = await mobileNetbanking(page).catch(e => ({ ok: false, error: String(e).slice(0, 160), layout: "mobile" })); const r = mobile || await payRazorpayTestNetbanking(page); return { ...r, contact }; };

/** Pay the 50% booking fee from the customer booking page (/v2/booking → "Pay securely" → Razorpay TEST Netbanking). */
export async function payFromBookingPage(flow, bookingId, label) {
  const { page, context } = flow;
  await page.goto(`${BASE}/v2/booking?bookingId=${encodeURIComponent(bookingId)}`, { waitUntil: "domcontentloaded" });
  await dismissCookies(page);
  await page.getByRole("button", { name: /Pay securely/ }).waitFor({ timeout: 45_000 }).catch(() => {});
  await settle(page, 800);
  const before = await text(page);
  const evidence = [await flow.shot(`${label}-booking-page-before`)];
  const dueNow = num((before.match(/Due now \| (₹[\d,.]+)/) || [])[1]), balanceLater = num((before.match(/Balance later \| (₹[\d,.]+)/) || [])[1]);
  const pay = page.getByRole("button", { name: /Pay securely/ }).first();
  if (!(await pay.isVisible().catch(() => false))) return { opened: false, reason: "no Pay securely button", before, dueNow, balanceLater, evidence };
  await pay.click();
  const open = await waitCheckoutOpen(page);
  if (!open.opened) return { opened: false, reason: open.alerts?.join(" | ") || "Razorpay did not open in 60 s", before, dueNow, balanceLater, evidence: [...evidence, await flow.shot(`${label}-checkout-not-opened`)] };
  evidence.push(await flow.shot(`${label}-razorpay-open`, { fullPage: false }));
  const paid = await payWithRazorpay(page);
  const status = paid.ok ? await waitCaptured(context, bookingId) : await waitCaptured(context, bookingId, 10_000);
  return { opened: true, checkoutOpenMs: open.ms, paid, status, before, dueNow, balanceLater, evidence };
}
/** Pay from step 5 of the flow ("Pay 50% booking fee"), then read what step 5 shows. */
export async function payInFlow(flow, bookingId, label) {
  const { page, context } = flow;
  const button = page.getByRole("button", { name: /Pay 50% booking fee/ });
  const buttonLabel = await button.innerText().catch(() => "");
  await button.click();
  const open = await waitCheckoutOpen(page);
  const evidence = [];
  if (!open.opened) return { opened: false, reason: open.alerts?.join(" | ") || "Razorpay did not open in 60 s", buttonLabel, evidence: [await flow.shot(`${label}-checkout-not-opened`)] };
  evidence.push(await flow.shot(`${label}-razorpay-open`, { fullPage: false }));
  const paid = await payWithRazorpay(page);
  const status = paid.ok ? await waitCaptured(context, bookingId) : await waitCaptured(context, bookingId, 10_000);
  await waitFor(async () => /Payment verified|TAXI CONFIRMED/.test(await text(page)), 30_000, 1000);
  const step5 = await text(page);
  evidence.push(await flow.shot(`${label}-step5-after-payment`));
  return { opened: true, checkoutOpenMs: open.ms, paid, status, buttonLabel, step5, evidence };
}
/** Open the checkout from step 5 and leave it unpaid (the customer walks away). */
export async function openCheckoutOnly(flow, label) {
  const { page } = flow;
  const button = page.getByRole("button", { name: /Pay 50% booking fee/ });
  const buttonLabel = await button.innerText().catch(() => "");
  await button.click();
  const open = await waitCheckoutOpen(page);
  await sleep(2500);
  return { ...open, buttonLabel, evidence: [await flow.shot(`${label}-checkout-open`, { fullPage: false })] };
}

/** The booking page after the fee (PAY-05): nothing payable now, final balance requested after drop-off. */
export async function readBookingPage(flow, bookingId, label) {
  const { page } = flow;
  await page.goto(`${BASE}/v2/booking?bookingId=${encodeURIComponent(bookingId)}`, { waitUntil: "domcontentloaded" });
  await dismissCookies(page);
  await page.getByText(/Status:/).first().waitFor({ timeout: 45_000 }).catch(() => {});
  await settle(page, 2500);
  const t = await text(page);
  return { text: t, offersPayment: /Pay securely|Pay balance/.test(t), explains: /Booking fee paid/.test(t) && /requested after drop-off/.test(t) && /Nothing is due now/.test(t), evidence: [await flow.shot(`${label}-booking-page-after-fee`)] };
}
/** The customer's manage page (/v2/taxi/manage). */
export async function readManagePage(flow, bookingId, label) {
  const { page } = flow;
  await page.goto(`${BASE}/v2/taxi/manage?bookingId=${encodeURIComponent(bookingId)}`, { waitUntil: "domcontentloaded" });
  await dismissCookies(page);
  await page.getByRole("heading", { name: "Manage your ride" }).waitFor({ timeout: 60_000 }).catch(() => {});
  await dismissCookies(page);
  await page.getByRole("heading", { name: "Payment & final bill" }).waitFor({ timeout: 45_000 }).catch(() => {});
  await settle(page, 1000);
  const t = await text(page);
  const pick = l => { const m = t.match(new RegExp(`${l} \\| (₹[\\d,.]+)`)); return m ? num(m[1]) : null; };
  return { text: t, total: pick("Ride total"), fee: pick("Booking fee · 50%"), balance: pick("Final balance"), offersFinalPayment: /Pay final balance/.test(t), evidence: [await flow.shot(`${label}-manage`)] };
}
