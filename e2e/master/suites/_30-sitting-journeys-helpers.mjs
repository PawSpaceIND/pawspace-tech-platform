// Private helpers for 30-sitting-journeys: the V2 Pet Sitting screen driver (/v2/sitting), the booking-page
// payment, network capture and the price rule. Selectors follow app/mobile-app/stay-flow.tsx,
// app/mobile-app/stay-meeting-request.tsx, app/mobile-app/stay-care-payment-gate.tsx,
// app/mobile-app/booking-payment-page.tsx and app/v2/booking/page.tsx.
import { BASE, settle, api, dismissCookies, otpCustomerSession, payRazorpayTestNetbanking } from "../lib.mjs";

export const flat = text => String(text ?? "").replace(/\s+/g, " ").trim();
export const istIso = (day, hhmm) => new Date(`${day}T${hhmm}:00+05:30`).toISOString();
export const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
/** Every rupee figure in a text, as numbers ("₹1,997.50" → 1997.5). */
export const rupees = text => [...String(text || "").matchAll(/₹\s?([\d,]+(?:\.\d+)?)/g)].map(m => Number(m[1].replace(/,/g, "")));
const escapeRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** IST wall-clock date and time of an instant. */
export const istParts = ms => { const s = new Date(ms + 19_800_000).toISOString(); return { day: s.slice(0, 10), time: s.slice(11, 16) }; };

/** Published Pet Sitting rule (lib/sitting-governance.ts): Home Visit ₹399 + ₹149 per extra pet for exactly one
 *  60-minute visit; Overnight (more than 10 h) ₹799 + ₹399 per extra pet per started 24 h. */
export const PRICE = { visit: { base: 399, extra: 149 }, overnight: { base: 799, extra: 399 } };
export function expectedSittingPrice({ mode, start, end, pets, split = false }) {
  const hours = (Date.parse(end) - Date.parse(start)) / 3_600_000;
  const rule = PRICE[mode];
  const units = mode === "visit" ? 1 : Math.max(1, Math.ceil(hours / 24));
  const total = (rule.base + Math.max(0, pets - 1) * rule.extra) * units;
  const dueNow = split ? round2(total / 2) : total;
  return { hours, units, total, dueNow, balance: round2(total - dueNow), packageCode: mode === "visit" ? "sitting-visit-60" : "sitting-overnight" };
}

/** Records the Sitting-relevant API traffic of one page (request body + response, truncated). */
export function watchNet(page) {
  const net = [];
  // Start times of the automatic sitter searches (POST /api/uat-scheduling action:preview), in request order.
  net.previewStarts = [];
  page.on("request", req => { if (req.method() === "POST" && req.url().startsWith(`${BASE}/api/uat-scheduling`) && /"action":"preview"/.test(req.postData() || "")) net.previewStarts.push(Date.now()); });
  page.on("response", async res => {
    const url = res.url();
    if (!url.startsWith(BASE) || !/\/api\/(uat-scheduling|sitting-commercial|sitting-bookings|customer-meet-and-greet|customer-checkout|sitting-lifecycle)/.test(url)) return;
    const req = res.request();
    let body = ""; try { body = await res.text(); } catch {}
    let json = null; try { json = JSON.parse(body); } catch {}
    let reqJson = null; try { reqJson = JSON.parse(req.postData() || "null"); } catch {}
    net.push({ t: Date.now(), method: req.method(), path: url.replace(BASE, "").split("?")[0], status: res.status(), req: reqJson, json, text: json ? "" : body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 300), ms: Date.now() - (req.timing()?.startTime > 0 ? req.timing().startTime : Date.now()) });
  });
  return net;
}
export const previews = net => net.filter(n => n.path === "/api/uat-scheduling" && n.req?.action === "preview");
export const reserves = net => net.filter(n => n.path === "/api/uat-scheduling" && n.method === "POST" && n.req?.action !== "preview");
export const quotes = net => net.filter(n => n.path === "/api/sitting-commercial" && n.method === "POST");

/** Retry a slow staging call once on a timeout / transport error or a 5xx (reads and idempotent sign-ins only). */
export async function retrying(fn, { tries = 3, wait = 4000 } = {}) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try { const r = await fn(); if (!(r && typeof r.status === "number" && r.status >= 500)) return r; last = r; }
    catch (e) { last = e; }
    await new Promise(resolve => setTimeout(resolve, wait * i));
  }
  if (last instanceof Error) throw last;
  return last;
}

/** A run-scoped OTP customer with the pets it needs and the Indiranagar service address (API setup, not under test). */
/** OTP sign-in (lib helper) — re-signs a context in as the same customer (supersedes its other sessions). */
export const otpSignIn = (context, phone, name) => otpCustomerSession(context, phone, name);

export async function setupCustomer(context, { phone, name, pets, tag }) {
  const who = await retrying(() => otpCustomerSession(context, phone, name));
  const read = async () => { const r = await retrying(() => api(context, "GET", "/api/customer-account", undefined, { timeout: 60_000 })); if (r.status !== 200) throw new Error(`GET /api/customer-account → HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`); return r.body.data; };
  let account = await read();
  for (const pet of pets) {
    if (account.pets?.some(p => p.name === pet.name)) continue;
    const r = await retrying(() => api(context, "POST", "/api/customer-account", { customerId: account.customerId, action: "upsert_pet", idempotencyKey: `m30-pet-${tag}-${pet.name}`, pet: { name: pet.name, species: pet.species, breed: pet.species === "dog" ? "Indie" : "Persian", vaccinationStatus: "verified" } }, { timeout: 60_000 }));
    if (r.status >= 300) throw new Error(`add pet ${pet.name} → HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  }
  if (!account.addresses?.some(a => a.postalCode === "560038")) {
    const r = await retrying(() => api(context, "POST", "/api/customer-account", { customerId: account.customerId, action: "upsert_address", idempotencyKey: `m30-address-${tag}`, address: { label: "Home", line1: "100 Feet Road, HAL 2nd Stage, Indiranagar", area: "Indiranagar", city: "Bengaluru", postalCode: "560038", isDefault: true } }, { timeout: 60_000 }));
    if (r.status >= 300) throw new Error(`add address → HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  }
  account = await read();
  return { customerId: account.customerId, name: account.name, phone: account.primaryPhone, account, pets: pets.map(p => account.pets.find(x => x.name === p.name)) };
}

/** Open /v2/sitting and wait for the Plan step (the page gives the account load 15 s, so retry it when slow). */
export async function openSitting(flow) {
  const { page } = flow;
  await page.goto(`${BASE}/v2/sitting`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await dismissCookies(page);
  for (let attempt = 1; attempt <= 4; attempt++) {
    await page.getByText("Loading your PawSpace family…").waitFor({ state: "detached", timeout: 45_000 }).catch(() => {});
    if (await page.getByRole("heading", { name: "Plan their care" }).isVisible().catch(() => false)) return;
    const retry = page.getByRole("button", { name: "Retry account" });
    if (await retry.isVisible().catch(() => false)) { flow.note(`account load failed on /v2/sitting (attempt ${attempt}): ${flat(await page.locator("main").innerText().catch(() => "")).slice(0, 160)}`); await retry.click(); continue; }
    await page.waitForTimeout(1500);
  }
  await page.getByRole("heading", { name: "Plan their care" }).waitFor({ timeout: 30_000 });
}

/** The IST window summary under the date inputs, or the Overnight "more than 10 hours" alert. */
export async function durationSummary(page) {
  const summary = page.getByText(/ · .* → |Overnight Pet Sitting covers more than 10 hours|Choose a check-out after check-in/).first();
  return flat(await summary.innerText().catch(() => ""));
}

/** Plan step: care type, window, pets. Fills the window as soon as the inputs render, so the screen's automatic
 *  sitter search runs for the chosen window rather than for its 7-night default. */
export async function planCare(flow, spec) {
  const { page } = flow;
  const care = page.getByRole("group", { name: "Pet Sitting care" });
  await care.getByRole("button", { name: spec.mode === "visit" ? /Home Visit/ : /Overnight Pet Sitting/ }).click();
  if (spec.mode === "visit") {
    await page.getByLabel("Visit date").fill(spec.day);
    await page.getByLabel("Visit start time").fill(spec.time);
  } else {
    await page.getByLabel("Check-in date").fill(spec.day);
    await page.getByLabel("Check-in time").fill(spec.time);
    await page.getByLabel("Check-out date").fill(spec.endDay);
    await page.getByLabel("Check-out time").fill(spec.endTime);
  }
  // Pets load once on mount; select exactly the ones the journey needs.
  for (const pet of spec.pets) await page.getByRole("button", { name: new RegExp(`\\b${escapeRe(pet.name)}\\b`) }).first().waitFor({ timeout: 45_000 });
  for (const pet of spec.pets) {
    const button = page.getByRole("button", { name: new RegExp(`\\b${escapeRe(pet.name)}\\b`) }).first();
    if ((await button.getAttribute("aria-pressed")) !== "true") await button.click();
  }
  for (const other of spec.otherPets || []) {
    const button = page.getByRole("button", { name: new RegExp(`\\b${escapeRe(other.name)}\\b`) }).first();
    if ((await button.getAttribute("aria-pressed").catch(() => null)) === "true") await button.click();
  }
  const cta = page.getByRole("button", { name: /See available sitters|Verify a service address to continue|Select a pet to continue/ });
  let ctaText = "";
  for (let i = 0; i < 60; i++) { ctaText = flat(await cta.innerText().catch(() => "")); if (/See available sitters/.test(ctaText) && await cta.isEnabled().catch(() => false)) break; await page.waitForTimeout(750); }
  const selected = [];
  for (const pet of [...spec.pets, ...(spec.otherPets || [])]) if ((await page.getByRole("button", { name: new RegExp(`\\b${escapeRe(pet.name)}\\b`) }).first().getAttribute("aria-pressed").catch(() => null)) === "true") selected.push(pet.name);
  return { summary: await durationSummary(page), cta: ctaText, ctaEnabled: await cta.isEnabled().catch(() => false), selected, visitHint: spec.mode === "visit" ? flat(await page.getByText(/^60 minutes, ending/).first().innerText().catch(() => "")) : null };
}

/** Choose step: run the sitter search (retrying the screen's own "Retry sitter search"), list the sitters and pick one. */
export async function chooseSitter(flow, { prefer, avoid = [], retries = 3 } = {}) {
  const { page } = flow;
  await page.getByRole("button", { name: /See available sitters/ }).click();
  const out = { attempts: 0, alerts: [], sitters: [], priceLabels: [] };
  const cards = page.getByRole("button").filter({ has: page.locator("h4") });
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    out.attempts = attempt;
    await page.getByText("Checking sitter availability…").waitFor({ state: "detached", timeout: 100_000 }).catch(() => {});
    await settle(page, 600);
    if (await cards.count()) break;
    const alerts = (await page.getByRole("alert").allInnerTexts().catch(() => [])).map(flat).filter(Boolean);
    out.alerts.push(...alerts);
    const retry = page.getByRole("button", { name: "Retry sitter search" });
    if (!(await retry.isVisible().catch(() => false)) || attempt > retries) break;
    flow.note(`sitter search failed (attempt ${attempt}): ${alerts.join(" | ").slice(0, 200)} — pressing Retry sitter search`);
    await retry.click();
  }
  const n = await cards.count();
  for (let i = 0; i < n; i++) {
    const card = cards.nth(i);
    out.sitters.push(flat(await card.locator("h4").innerText().catch(() => "")));
    out.priceLabels.push(flat(await card.locator("strong").last().innerText().catch(() => "")));
  }
  if (!n) return out;
  const pick = out.sitters.findIndex(name => prefer && name === prefer) >= 0 ? out.sitters.indexOf(prefer) : out.sitters.findIndex(name => !avoid.includes(name));
  if (pick < 0) return out;
  await cards.nth(pick).click();
  await settle(page, 500);
  out.chosen = out.sitters[pick];
  // The price label settles once the quote for this sitter arrives.
  for (let i = 0; i < 30 && /Calculating/.test(await cards.nth(pick).locator("strong").last().innerText().catch(() => "")); i++) await page.waitForTimeout(700);
  out.chosenPriceLabel = flat(await cards.nth(pick).locator("strong").last().innerText().catch(() => ""));
  const next = page.getByRole("button", { name: /^Continue with |Choose an available caregiver/ });
  out.continueText = flat(await next.innerText().catch(() => ""));
  return out;
}

export const CARE_LABELS = { feeding: "Food and water routine", medication: "Medication and allergy instructions from your vet", vet: "Vet contact", emergencyContact: "Emergency contact", homeAccess: "Home access instructions", specialInstructions: "Other care instructions" };

/** Care Card step: instructions, and optionally a separate Meet & Greet introduction for this sitter and dates. */
export async function buildCareCard(flow, { care, meet, net }) {
  const { page } = flow;
  await page.getByRole("button", { name: /^Continue with / }).click();
  await page.getByRole("heading", { name: "Build the Care Card" }).waitFor({ timeout: 20_000 });
  for (const [field, label] of Object.entries(CARE_LABELS)) if (care[field]) await page.getByLabel(label, { exact: true }).fill(care[field]);
  const out = { meet: null };
  if (meet) {
    const section = page.getByRole("region", { name: "Separate caregiver introduction" });
    await section.getByText("Loading the existing meeting policy…").waitFor({ state: "detached", timeout: 45_000 }).catch(() => {});
    const format = section.getByLabel("Introduction format");
    await format.waitFor({ timeout: 30_000 });
    out.formatOptions = (await format.locator("option").allInnerTexts()).map(flat);
    await format.selectOption(meet.format);
    await section.getByLabel("Preferred introduction (IST)").fill(meet.preferredLocal);
    await section.getByLabel(/Request this separate introduction/).check();
    const mark = net.length;
    await section.getByRole("button", { name: "Request introduction" }).click();
    let posted = null;
    for (let i = 0; i < 60 && !posted; i++) { posted = net.slice(mark).find(n => n.path === "/api/customer-meet-and-greet" && n.method === "POST"); if (!posted) await page.waitForTimeout(500); }
    await section.getByText(/^Request MGR-/).first().waitFor({ timeout: 20_000 }).catch(() => {});
    out.meet = { status: posted?.status ?? null, request: posted?.json?.data?.request ?? null, error: posted?.json?.error ?? posted?.text ?? null, paymentStatus: posted?.json?.data?.paymentStatus ?? null, shown: flat(await section.innerText().catch(() => "")).slice(0, 600), alerts: (await section.getByRole("alert").allInnerTexts().catch(() => [])).map(flat) };
  }
  return out;
}

/** Review step: payment choice, consent and the priced call to action. Stops before the booking is requested. */
export async function review(flow, { split }) {
  const { page } = flow;
  await page.getByRole("button", { name: "Review protected booking" }).click();
  await page.getByRole("heading", { name: "Review and confirm" }).waitFor({ timeout: 20_000 });
  const out = { splitOffered: await page.getByRole("button", { name: /Reserve with 50% now/ }).isVisible().catch(() => false) };
  if (out.splitOffered) await page.getByRole("button", { name: split ? /Reserve with 50% now/ : /Pay the full amount now/ }).click();
  await page.getByLabel(/I agree to care, home-access/).check();
  // Anchored: while the price is missing the split-payment buttons' names also contain "Price unavailable".
  const cta = page.getByRole("button", { name: /^(Request sitter & review payment|Calculating price…|Price unavailable|Locking care capacity…)$/ });
  out.priceRetries = 0;
  for (let i = 0; i < 160; i++) {
    const text = flat(await cta.innerText().catch(() => ""));
    if (/Request sitter & review payment/.test(text) && await cta.isEnabled().catch(() => false)) break;
    if (/Price unavailable/.test(text) && i % 8 === 7 && out.priceRetries < 6) { out.priceRetries += 1; out.priceAlerts = (await page.getByRole("alert").allInnerTexts().catch(() => [])).map(flat); await page.getByRole("button", { name: "Retry price" }).click().catch(() => {}); }
    await page.waitForTimeout(750);
  }
  const main = flat(await page.locator("main").innerText().catch(() => ""));
  out.cta = flat(await cta.innerText().catch(() => ""));
  out.ctaEnabled = await cta.isEnabled().catch(() => false);
  out.review = flat(await page.locator("[aria-label='Review stay details']").innerText().catch(() => ""));
  out.bookingTotal = rupees(main.match(/Booking total\s*₹[\d,.]+/)?.[0])[0] ?? null;
  out.collectNow = rupees(main.match(/₹[\d,.]+ will be collected in this test checkout/)?.[0])[0] ?? null;
  out.laterText = main.match(/₹[\d,.]+ is due 24 hours before the booking starts\.|No later balance remains\./)?.[0] || null;
  out.visitNote = /A Home Visit is one 60-minute visit/.test(main);
  out.paymentChoice = flat(main.match(/LONG-STAY PAYMENT.*?no later balance/)?.[0] || main.match(/Full payment for a Home Visit[^.]*\./)?.[0] || "");
  out.introduction = flat(main.match(/Separate introduction\s*(.*?)\s*Booking updates/)?.[1] || "");
  return out;
}

/** A failure that is only transport (a gateway 502 page, a cut connection, a timeout), not a product refusal. */
export const TRANSPORT = /not valid JSON|Unexpected token|Unexpected end of JSON input|upstream request failed|timed out|Failed to fetch|NetworkError|Load failed/i;
/** A raw JavaScript parser error shown to the customer instead of a sentence. */
export const RAW_JSON_ERROR = /Unexpected token|Unexpected end of JSON input|is not valid JSON|Failed to execute 'json'/;

/** Request the sitter: the booking is created and the care plan saved; ends on the payment step. A transport
 *  failure is retried with the screen's own button — the reservation and the booking are idempotent per attempt. */
export async function requestBooking(flow, net) {
  const { page } = flow;
  const mark = net.length;
  const paySection = page.locator("section[aria-label='Pet Sitting payment']");
  const out = { alerts: [], rounds: 0, transportRetries: [] };
  for (let round = 1; round <= 3; round++) {
    out.rounds = round;
    out.alerts = [];
    await page.getByRole("button", { name: /Request sitter & review payment/ }).click();
    for (let i = 0; i < 240; i++) {
      if (await paySection.isVisible().catch(() => false)) break;
      const retryCare = page.getByRole("button", { name: "Retry saving care instructions" });
      if (await retryCare.isVisible().catch(() => false) && await retryCare.isEnabled().catch(() => false) && i % 20 === 19) await retryCare.click();
      const alerts = (await page.getByRole("alert").allInnerTexts().catch(() => [])).map(flat).filter(Boolean);
      const locking = await page.getByText("Locking care capacity…").isVisible().catch(() => false);
      const reviewing = await page.getByRole("heading", { name: "Review and confirm" }).isVisible().catch(() => false);
      if (alerts.length && reviewing && !locking) { out.alerts = alerts; break; }
      await page.waitForTimeout(750);
    }
    if (await paySection.isVisible().catch(() => false)) break;
    if (!(out.alerts.some(a => TRANSPORT.test(a)) && round < 3)) break;
    out.transportRetries.push(out.alerts.join(" | "));
    out.transportShot = out.transportShot || await flow.shot("request-transport-error");
    flow.note(`booking request hit a transport error (${out.alerts.join(" | ").slice(0, 120)}) — pressing the button again`);
  }
  const after = net.slice(mark);
  const booking = after.filter(n => n.path === "/api/sitting-bookings" && n.method === "POST").at(-1);
  const reserve = reserves(after).filter(n => n.status < 300).at(-1) || reserves(after).at(-1);
  out.bookingCall = booking ? { status: booking.status, body: booking.json ?? booking.text } : null;
  out.reserveCall = reserve ? { status: reserve.status, provider: reserve.json?.data?.provider ?? null, groupId: reserve.json?.data?.groupId ?? null, error: reserve.json?.error ?? reserve.text ?? null, ms: reserve.ms } : null;
  out.reserveCalls = reserves(after).map(n => ({ status: n.status, ms: Math.round(n.ms), error: n.json?.error ?? (n.text || null) }));
  out.quoteCall = quotes(after).filter(q => q.status < 300).at(-1)?.json?.data ?? null;
  out.bookingId = booking?.json?.data?.bookingId || (flat(await page.locator("main").innerText().catch(() => "")).match(/PS-UAT-SIT-[A-Z0-9-]+/) || [null])[0];
  out.paymentVisible = await paySection.isVisible().catch(() => false);
  if (out.paymentVisible) {
    out.paymentText = flat(await paySection.innerText());
    out.payButton = flat(await paySection.getByRole("button").first().innerText().catch(() => ""));
    out.reference = flat(await page.getByText(/^Booking reference:/).first().innerText().catch(() => ""));
  }
  return out;
}

/** Open the Razorpay TEST checkout from a payment section's button and complete it (Netbanking → Success). */
export async function payRazorpay(flow, button, { waitOpenMs = 60_000 } = {}) {
  const { page } = flow;
  const t0 = Date.now();
  let opened = false, alerts = [];
  for (let round = 1; round <= 2 && !opened; round++) {
    await button.click();
    const r0 = Date.now();
    while (Date.now() - r0 < waitOpenMs) {
      await page.waitForTimeout(1000);
      opened = page.frames().some(f => f !== page.mainFrame() && /razorpay/i.test(f.url()));
      alerts = (await page.getByRole("alert").allInnerTexts().catch(() => [])).map(flat).filter(Boolean);
      if (opened || alerts.length) break;
    }
    if (opened || !alerts.some(a => TRANSPORT.test(a))) break;
    flow.note(`checkout start hit a transport error (${alerts.join(" | ").slice(0, 120)}) — pressing the button again`);
  }
  if (!opened) return { opened, openMs: Date.now() - t0, alerts };
  await page.waitForTimeout(1500);
  const checkoutShot = await flow.shot("razorpay-checkout", { fullPage: false });
  const paid = await payRazorpayTestNetbanking(page);
  return { opened, openMs: Date.now() - t0, paid, checkoutShot };
}

/** Customer checkout status (same projection the V2 booking page reads). */
export async function checkoutStatus(context, bookingId) {
  const r = await api(context, "POST", "/api/customer-checkout", { action: "status", bookingId }, { timeout: 60_000 }).catch(e => ({ status: 0, body: { error: String(e).slice(0, 200) } }));
  const c = r.body?.data?.confirmation || {};
  return { http: r.status, status: r.body?.data?.status ?? null, ready: c.ready, bookingStatus: c.bookingStatus, paymentStatus: c.paymentStatus, paymentMode: c.paymentMode, paymentStage: c.paymentStage, amountDueNow: c.amountDueNow, amountPaid: c.amountPaid, totalAmount: c.totalAmount, balanceDueAt: c.balanceDueAt, balancePayableNow: c.balancePayableNow, providerId: c.providerId, providerName: c.providerName, workOrderStatus: c.workOrderStatus, packageCode: c.packageCode, scheduledStart: c.scheduledStart, scheduledEnd: c.scheduledEnd, transactionId: c.transactionId, error: r.body?.error ?? null };
}

/** Poll until the server shows `done(status)` (captured deposit / settled balance), clicking the screen's own
 *  "Retry booking confirmation" when it offers it. */
export async function waitForServer(flow, bookingId, done, { timeoutMs = 180_000 } = {}) {
  const { page, context } = flow;
  const t0 = Date.now();
  let status = null;
  while (Date.now() - t0 < timeoutMs) {
    await page.waitForTimeout(5000);
    status = await checkoutStatus(context, bookingId);
    if (done(status)) break;
    const retry = page.getByRole("button", { name: "Retry booking confirmation" });
    if (await retry.isVisible().catch(() => false) && await retry.isEnabled().catch(() => false)) await retry.click().catch(() => {});
  }
  return { ...status, waitedMs: Date.now() - t0 };
}

/** The customer booking page (/v2/booking): read what it shows and optionally pay what it offers. */
export async function bookingPage(flow, bookingId) {
  const { page } = flow;
  await page.goto(`${BASE}/v2/booking?bookingId=${encodeURIComponent(bookingId)}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await dismissCookies(page);
  await page.getByText("Loading your booking…").waitFor({ state: "detached", timeout: 60_000 }).catch(() => {});
  for (let i = 0; i < 3 && await page.getByRole("button", { name: "Retry booking" }).isVisible().catch(() => false); i++) { await page.getByRole("button", { name: "Retry booking" }).click(); await page.getByText("Loading your booking…").waitFor({ state: "detached", timeout: 60_000 }).catch(() => {}); }
  await settle(page, 1500);
  const text = flat(await page.locator("main").innerText().catch(() => ""));
  const section = page.locator("section[aria-label$=' payment']");
  const payButton = section.getByRole("button", { name: /Pay securely|Pay balance/ });
  return { text, hasPaymentSection: await section.isVisible().catch(() => false), payButton, payText: flat(await payButton.innerText().catch(() => "")), paymentSection: flat(await section.innerText().catch(() => "")) };
}

/** The sitting manage page (/v2/sitting/manage). */
export async function managePage(flow, bookingId) {
  const { page } = flow;
  await page.goto(`${BASE}/v2/sitting/manage?bookingId=${encodeURIComponent(bookingId)}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await dismissCookies(page);
  await page.getByText("Loading saved booking and care updates…").waitFor({ state: "detached", timeout: 60_000 }).catch(() => {});
  await page.getByRole("heading", { name: "Booking status" }).waitFor({ timeout: 30_000 }).catch(() => {});
  await settle(page, 1000);
  const meet = page.getByRole("region", { name: "Meet and Greet" });
  return { text: flat(await page.locator("main").innerText().catch(() => "")), meet: flat(await meet.innerText().catch(() => "")), meetVisible: await meet.isVisible().catch(() => false) };
}
