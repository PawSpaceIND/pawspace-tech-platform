// Master suite 10 — V2 BOARDING customer journeys at /v2/boarding as synthetic customer "customer-a".
// Every combination runs through the real V2 UI (AddressPicker → plan → host → care card → review → pay) and the
// real Razorpay TEST checkout on staging. Server truth is read back through the customer's own API projection and
// (on the runner) read-only staging D1. Locally the Razorpay order is refused with 503 → recorded as ENV-GATED.
import {
  BASE, launch, newFlow, settle, customerSession, dismissCookies, api, d1, payRazorpayTestNetbanking,
  record, finding, saveBooking, isoDay, WINDOWS, writeJson, redact,
} from "../lib.mjs";

const SUITE = "10-customer-boarding";
const PERSONA = "customer-a";
const STARTED = Date.now();
const BUDGET_MS = 33 * 60_000; // runner hard limit is 40 min per suite
const [W_FROM, W_TO] = WINDOWS.boarding;
const ADDRESS_QUERY = "100 Feet Road Indiranagar";
const STAMP = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
const summary = { suite: SUITE, base: BASE, startedAt: new Date(STARTED).toISOString(), journeys: [], bookings: {} };

// Pets this suite owns on customer-a. MasterBuddy is a third vaccinated pet so the 3-pet combo never depends on
// pets other testers created.
const PETS = [
  { name: "MasterDog", species: "dog", breed: "Labrador Retriever", vaccinated: "yes", dose: "Rabies" },
  { name: "MasterCat", species: "cat", breed: "Persian", vaccinated: "yes", dose: "FVRCP" },
  { name: "MasterPup", species: "dog", breed: "Beagle", vaccinated: "no" },
  { name: "MasterBuddy", species: "dog", breed: "Golden Retriever", vaccinated: "yes", dose: "DHPPi" },
];
const CARE = {
  "Food and water routine": "Twice a day, 8am and 7pm (master E2E)",
  "Medication and allergy instructions from your vet": "None known",
  "Vet contact": "Dr. Rao, Indiranagar Vet Clinic, 9000000001",
  "Emergency contact": "Asha, 9000000002",
  "Other care instructions": "Loves fetch. Master E2E synthetic booking.",
};
const ALL_EXTRAS = ["Pickup & drop", "Three walks", "Medication support", "1-hour play time", "Grooming add-on", "Training add-on"];

// ---------------------------------------------------------------------------------------------------------------
// small utilities
const inr = (n) => (Number.isFinite(Number(n)) ? `₹${Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 })}` : String(n));
const money = (text) => { const m = String(text || "").match(/₹\s?([\d,]+(?:\.\d+)?)/); return m ? Number(m[1].replace(/,/g, "")) : null; };
const near = (a, b) => a != null && b != null && Math.abs(Number(a) - Number(b)) < 0.011;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const timeLeft = () => BUDGET_MS - (Date.now() - STARTED);
const oneLine = (s, n = 400) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
async function mainText(page) { return (await page.locator("main").first().innerText({ timeout: 5000 }).catch(() => page.locator("body").innerText().catch(() => ""))) || ""; }
async function robustClick(locator, timeout = 10_000) {
  try { await locator.click({ timeout }); return true; }
  catch { try { await locator.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {}); await locator.evaluate(el => el.click()); return true; } catch { return false; } }
}
function hoursBetween(start, startTime, end, endTime) { return (Date.parse(`${end}T${endTime}:00+05:30`) - Date.parse(`${start}T${startTime}:00+05:30`)) / 3_600_000; }
function nightsBetween(start, end) { return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000); }

/** The published customer rule the quote is checked against. */
function expectedPrice({ start, startTime, end, endTime, pets, split }) {
  const hours = hoursBetween(start, startTime, end, endTime), nights = nightsBetween(start, end);
  const pkg = hours <= 4 ? "boarding-4h" : hours <= 10 ? "boarding-10h" : "boarding-24h";
  const unit = pkg === "boarding-4h" ? 499 : pkg === "boarding-10h" ? 599 : 699;
  const units = pkg === "boarding-24h" ? Math.ceil(hours / 24 - 1e-9) : 1;
  const total = unit * units * pets;
  const splitOffered = hours > 10 && nights > 4;
  const dueNow = splitOffered && split !== false ? Math.round(total * 50) / 100 : total;
  return { hours, nights, pkg, unit, units, total, splitOffered, dueNow };
}

// ---------------------------------------------------------------------------------------------------------------
// session: a customer has ONE active platform session — any other sign-in as customer-a (a human tester on staging,
// another suite) supersedes ours and the API answers 401. Re-issue the synthetic session and retry once.
const SESSION_EVENTS = [];
async function reauth(context, why) {
  await customerSession(context, PERSONA);
  context.__reauths = (context.__reauths || 0) + 1;
  SESSION_EVENTS.push({ at: new Date().toISOString(), why });
  console.log(redact(`[${SUITE}] customer-a session re-issued (${why})`));
}
async function capi(context, method, path, data) {
  let r = await api(context, method, path, data).catch(e => ({ status: 0, body: String(e) }));
  if (r.status === 401) { await reauth(context, `${method} ${path} → 401`); r = await api(context, method, path, data).catch(e => ({ status: 0, body: String(e) })); }
  return r;
}
const is401 = (x) => Number(x?.http) === 401 || /sign-in has expired|sign_in_required/i.test(String(x?.error || x?.code || ""));

// ---------------------------------------------------------------------------------------------------------------
// server reads
async function checkoutStatus(context, bookingId) {
  const r = await capi(context, "POST", "/api/customer-checkout", { action: "status", bookingId });
  const d = r.body?.data || {};
  const c = d.confirmation || {};
  return { http: r.status, status: d.status, bookingStatus: c.bookingStatus, paymentStatus: c.paymentStatus, paymentMode: c.paymentMode, amountDueNow: c.amountDueNow, totalAmount: c.totalAmount, ready: c.ready, providerName: c.providerName, gatewayPaymentId: c.gatewayPaymentId || c.transactionId || null, error: r.body?.error };
}
async function boardingStay(context, bookingId) {
  const r = await capi(context, "GET", `/api/boarding-stays?scope=customer&bookingId=${encodeURIComponent(bookingId)}`);
  return Array.isArray(r?.body?.data) ? r.body.data[0] || null : null;
}
async function d1Payment(bookingId) {
  const payments = await d1("SELECT id,status,amount,amount_due_now,mode FROM booking_payments WHERE booking_id=?", [bookingId]);
  if (!Array.isArray(payments)) return { skipped: payments?.skipped || payments?.error || "d1 unavailable" };
  const events = await d1("SELECT event_type,processing_status,signature_verified,amount_subunits,json_extract(CASE WHEN json_valid(detail_json) THEN detail_json ELSE '{}' END,'$.captureAuthority') AS authority,failure_reason FROM payment_gateway_events WHERE booking_id=? ORDER BY received_at", [bookingId]);
  const booking = await d1("SELECT status,total_amount,package_code FROM canonical_bookings WHERE id=?", [bookingId]);
  const schedule = await d1("SELECT status,total_amount,paid_now_amount,balance_amount,balance_due_at FROM stay_payment_schedules WHERE booking_id=?", [bookingId]);
  const stay = await d1("SELECT status,billed_units,pet_count,care_plan_status FROM boarding_stays WHERE booking_id=?", [bookingId]);
  return { payment: payments[0] || null, events: Array.isArray(events) ? events : events, booking: Array.isArray(booking) ? booking[0] || null : booking, schedule: Array.isArray(schedule) ? schedule[0] || null : schedule, stay: Array.isArray(stay) ? stay[0] || null : stay };
}
function d1Captured(db) {
  if (!db || db.skipped) return null;
  const events = Array.isArray(db.events) ? db.events : [];
  const processed = events.some(e => ["payment.captured", "order.paid", "payment_link.paid"].includes(e.event_type) && e.processing_status === "processed");
  return db.payment?.status === "captured" && processed;
}
function d1Brief(db) {
  if (!db) return "d1: n/a";
  if (db.skipped) return `d1: skipped (${db.skipped})`;
  const ev = Array.isArray(db.events) ? db.events.map(e => `${e.event_type}/${e.processing_status}/sig${e.signature_verified}${e.authority ? "/" + e.authority : ""}${e.amount_subunits ? "/" + e.amount_subunits : ""}`).join(",") : JSON.stringify(db.events);
  return `d1: booking=${db.booking?.status} payment=${db.payment?.status} amount=${db.payment?.amount} dueNow=${db.payment?.amount_due_now} mode=${db.payment?.mode} events=[${ev}]${db.schedule ? ` schedule=${db.schedule.status} paidNow=${db.schedule.paid_now_amount} balance=${db.schedule.balance_amount}` : ""}${db.stay ? ` stay=${db.stay.status} units=${db.stay.billed_units}` : ""}`;
}

/** First start offset (days) inside the Boarding window where a governed host has room for every pet. */
async function pickDates(context, zone, { prefer, spanDays, startTime, endTime, pets, species }) {
  const last = W_TO - spanDays;
  const offsets = [];
  for (let off = Math.max(W_FROM, prefer); off <= last; off++) offsets.push(off);
  for (let off = W_FROM; off < Math.max(W_FROM, prefer) && off <= last; off++) offsets.push(off); // wrap to the window start
  for (const off of offsets) {
    const start = isoDay(off), end = isoDay(off + spanDays);
    if (!zone) return { start, end, offset: off, probe: "no zone (unprobed)" };
    const s = new Date(`${start}T${startTime}:00+05:30`).toISOString(), e = new Date(`${end}T${endTime}:00+05:30`).toISOString();
    const r = await capi(context, "GET", `/api/boarding-commercial?cityId=${zone.cityId}&zoneId=${zone.zoneId}&scheduledStart=${encodeURIComponent(s)}&scheduledEnd=${encodeURIComponent(e)}&petCount=${pets}&species=${species.join(",")}`).catch(() => null);
    const hosts = r?.body?.data?.hosts;
    if (!Array.isArray(hosts)) return { start, end, offset: off, probe: `probe HTTP ${r?.status}` };
    const ok = hosts.filter(h => Number(h.availableGuestPets ?? h.capacity) >= pets);
    if (ok.length) return { start, end, offset: off, probe: `${ok.length} host(s) free: ${ok.map(h => `${h.name}(${h.availableGuestPets ?? h.capacity})`).join(", ")}` };
  }
  return { start: isoDay(prefer), end: isoDay(prefer + spanDays), offset: prefer, probe: "no host capacity found in window" };
}

// ---------------------------------------------------------------------------------------------------------------
// UI steps
async function openBoarding(flow) {
  const { page } = flow;
  await page.goto(`${BASE}/v2/boarding`, { waitUntil: "domcontentloaded" });
  await dismissCookies(page);
  await page.getByText("Loading your PawSpace family…").waitFor({ state: "detached", timeout: 25_000 }).catch(() => {});
  await settle(page, 800);
  if (await page.getByText("Sign in to plan care.").isVisible().catch(() => false)) {
    await reauth(flow.context, "/v2/boarding rendered signed-out");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByText("Loading your PawSpace family…").waitFor({ state: "detached", timeout: 25_000 }).catch(() => {});
    await settle(page, 800);
    if (await page.getByText("Sign in to plan care.").isVisible().catch(() => false)) throw new Error("harness: /v2/boarding shows the signed-out state after customerSession");
  }
}

/** Pick the service address through the booking AddressPicker (first Google suggestion; typed verify as fallback). */
async function chooseServiceAddress(flow) {
  const { page } = flow;
  const care = page.locator('section[aria-label="Care location"]').first();
  await care.waitFor({ timeout: 20_000 });
  await care.getByText("Checking service area…").waitFor({ state: "detached", timeout: 25_000 }).catch(() => {});
  const out = { path: "none", attempts: [] };
  const change = care.getByRole("button", { name: "Change Address" });
  if (await change.isVisible().catch(() => false)) { out.savedAddress = oneLine(await care.locator("p").first().innerText().catch(() => ""), 160); await change.click(); }
  const line1 = page.locator("#grooming-address-line-1");
  const suggestions = page.locator('section[aria-label="Google address suggestions"] button');
  const available = care.getByText("✓ Available");
  const verify = page.getByRole("button", { name: "Verify service address" });
  const use = care.getByRole("button", { name: "Use this address" });
  const waitSettled = async (ms = 20_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await suggestions.first().isVisible().catch(() => false)) return "suggestions";
      if (await available.isVisible().catch(() => false)) return "resolved";
      if (await care.locator('[role="alert"]').first().isVisible().catch(() => false)) return "alert";
      await page.waitForTimeout(400);
    }
    return "timeout";
  };
  const readAttempt = async (path) => {
    await available.waitFor({ timeout: 20_000 }).catch(() => {});
    const a = { path, caption: oneLine(await care.locator("[class*=locationLine]").first().innerText({ timeout: 2000 }).catch(() => ""), 200), alert: oneLine(await care.locator('[role="alert"]').first().innerText({ timeout: 800 }).catch(() => ""), 200), usable: await use.isEnabled().catch(() => false) };
    out.attempts.push(a);
    return a;
  };
  let autocomplete401 = false;
  const on401 = (res) => { if (res.status() === 401 && res.url().includes("/api/address-autocomplete")) autocomplete401 = true; };
  page.on("response", on401);
  await line1.waitFor({ timeout: 10_000 });
  let attempt = null;
  for (let round = 1; round <= 2; round++) {
    autocomplete401 = false;
    await line1.fill(ADDRESS_QUERY);
    const state = await waitSettled();
    if (round === 1 && autocomplete401 && state !== "suggestions") { await reauth(flow.context, "address autocomplete → 401"); await line1.fill(""); continue; }
    if (state === "suggestions") {
      out.suggestions = (await suggestions.allInnerTexts()).slice(0, 5).map(t => oneLine(t, 120));
      await suggestions.first().scrollIntoViewIfNeeded().catch(() => {});
      out.shot = await flow.shot("0-address-suggestions", { fullPage: false });
      await robustClick(suggestions.first());
      attempt = await readAttempt("google-suggestion");
    } else if (state === "resolved") attempt = await readAttempt("auto-typed");
    break;
  }
  page.off("response", on401);
  if (!attempt?.usable && /sign-in has expired/.test(attempt?.alert || "")) {
    // Our session was superseded mid-resolve: re-issue it and take the Google path again.
    await reauth(flow.context, "address resolve → 401");
    await line1.fill(ADDRESS_QUERY);
    if (await waitSettled() === "suggestions") { await robustClick(suggestions.first()); attempt = await readAttempt("google-suggestion"); }
  }
  if (!attempt?.usable) {
    // Fallback: the typed path ("Verify service address") infers the Indiranagar PIN from the text.
    await line1.fill(`${ADDRESS_QUERY} 560038`);
    await waitSettled(8000);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !(await verify.isEnabled().catch(() => false)) && !(await available.isVisible().catch(() => false))) await page.waitForTimeout(400);
    if (await verify.isEnabled().catch(() => false)) await robustClick(verify);
    attempt = await readAttempt("typed-verify");
  }
  Object.assign(out, { path: attempt.path, caption: attempt.caption, alert: attempt.alert, mapVerified: /Google map verified/.test(attempt.caption) });
  if (!attempt.usable) { out.ok = false; return out; }
  await robustClick(use);
  await settle(page, 500);
  out.summary = oneLine(await care.locator("p").first().innerText().catch(() => ""), 200);
  out.ok = true;
  return out;
}

async function selectPets(page, wanted) {
  const petButtons = page.locator("[class*=petList] button[aria-pressed]");
  await petButtons.first().waitFor({ timeout: 20_000 });
  const byName = (name) => petButtons.filter({ has: page.locator("b", { hasText: new RegExp(`^${esc(name)}$`) }) }).first();
  for (const name of wanted) {
    const b = byName(name);
    if (!(await b.count())) throw new Error(`harness: pet ${name} not listed on /v2/boarding`);
    if ((await b.getAttribute("aria-pressed")) !== "true") await b.click();
  }
  const count = await petButtons.count();
  for (let i = 0; i < count; i++) {
    const b = petButtons.nth(i);
    const name = oneLine(await b.locator("b").first().innerText().catch(() => ""), 60);
    if (!wanted.includes(name) && (await b.getAttribute("aria-pressed")) === "true") await b.click();
  }
  const selected = [];
  for (let i = 0; i < count; i++) { const b = petButtons.nth(i); if ((await b.getAttribute("aria-pressed")) === "true") selected.push(oneLine(await b.locator("b").first().innerText(), 60)); }
  return selected;
}

/**
 * Drive one Boarding combination through the V2 UI. opts:
 *  {start,end,startTime,endTime,pets:[],needs:[],extras:[],food,meet:false|"call"|"visit",split:true|false|undefined,
 *   create:bool, pay:bool}
 */
async function runBoarding(flow, opts) {
  const { page, context } = flow;
  const r = { opts: { ...opts }, shots: [], quotes: [], stage: "start" };
  const net = { canonical: null, scheduling: null, start: null };
  page.on("response", async (res) => {
    try {
      const url = res.url(), req = res.request();
      if (res.status() === 401 && url.startsWith(BASE) && url.includes("/api/boarding-stays")) net.care401 = true;
      if (req.method() !== "POST" || !url.startsWith(BASE)) return;
      const path = new URL(url).pathname;
      if (path === "/api/boarding-commercial") { const b = await res.json().catch(() => null); if (b?.data?.quoteId) r.quotes.push({ http: res.status(), ...b.data }); }
      else if (path === "/api/canonical-bookings") { const b = await res.json().catch(() => null); net.canonical = { http: res.status(), bookingId: b?.data?.bookingId, status: b?.data?.status, error: b?.error }; }
      else if (path === "/api/uat-scheduling") { const b = await res.json().catch(() => null); if (!/"action":"preview"/.test(req.postData() || "")) net.scheduling = { http: res.status(), code: b?.code, error: b?.error, provider: b?.data?.provider?.name }; }
      else if (path === "/api/customer-checkout" && /"action":"start"/.test(req.postData() || "")) { const b = await res.json().catch(() => null); net.start = { http: res.status(), orderId: b?.data?.orderId || b?.data?.razorpay_order_id, amountPaise: b?.data?.amountPaise, status: b?.data?.status, error: b?.error, code: b?.code }; }
    } catch {}
  });
  r.net = net;
  const exp = expectedPrice({ ...opts, pets: opts.pets.length });
  r.expected = exp;

  await openBoarding(flow);
  r.address = await chooseServiceAddress(flow);
  if (r.address.shot) r.shots.push(r.address.shot);
  if (!r.address.ok) { r.stage = "address"; r.shots.push(await flow.shot("address-not-verified")); return r; }
  if (r.address.attempts.length > 1) flow.note(`address fallback used: ${JSON.stringify(r.address.attempts)}`);
  // dates
  await page.getByLabel("Check-in date").fill(opts.start);
  await page.getByLabel("Check-in time").fill(opts.startTime);
  await page.getByLabel("Check-out date").fill(opts.end);
  await page.getByLabel("Check-out time").fill(opts.endTime);
  await settle(page, 400);
  r.selectedPets = await selectPets(page, opts.pets);
  for (const need of opts.needs || []) await page.getByRole("button", { name: new RegExp(`^[＋✓]\\s*${esc(need)}$`) }).click();
  await settle(page, 600);
  r.durationSummary = oneLine(await page.locator("[class*=durationSummary]").first().innerText().catch(() => ""), 200);
  r.planHint = oneLine(await page.locator("p[class*=hint]").filter({ hasText: /selected ·|End date must/ }).first().innerText({ timeout: 1500 }).catch(() => ""), 200);
  r.shots.push(await flow.shot("1-plan"));
  const planCta = page.getByRole("button", { name: /See available homes|Verify a service address|Select a pet to continue/ });
  r.planCta = oneLine(await planCta.innerText().catch(() => ""));
  r.planCtaEnabled = await planCta.isEnabled().catch(() => false);
  r.stage = "plan";
  if (!r.planCtaEnabled) return r;
  await robustClick(planCta);
  // hosts
  await page.getByText(/Checking governed host availability/).waitFor({ state: "detached", timeout: 30_000 }).catch(() => {});
  await settle(page, 1000);
  const cards = page.locator("[class*=caregivers] > button");
  r.hosts = (await cards.allInnerTexts().catch(() => [])).map(t => oneLine(t.split("\n").slice(0, 4).join(" | "), 140));
  r.hostAlert = oneLine(await page.locator("[role=alert]").first().innerText({ timeout: 1500 }).catch(() => ""), 300);
  r.shots.push(await flow.shot("2-hosts"));
  const cont = page.getByRole("button", { name: /Continue with|Choose an available caregiver/ });
  r.stage = "hosts";
  if (!(await cont.isEnabled().catch(() => false))) return r;
  r.host = oneLine((await cont.innerText()).replace("Continue with", ""), 60);
  await robustClick(cont);
  await settle(page, 500);
  // care card
  for (const [label, value] of Object.entries(CARE)) { const box = page.getByLabel(label, { exact: true }); if (await box.count()) await box.fill(value); }
  for (const extra of opts.extras || []) await page.getByRole("button", { name: new RegExp(`^[＋✓]\\s*${esc(extra)}$`) }).click();
  if (opts.food) await page.getByLabel("Food preference").selectOption({ label: opts.food });
  const meetBox = page.locator("[class*=options] label").filter({ hasText: /host-home trial/ }).locator("input[type=checkbox]").first();
  if (opts.meet === false) { if (await meetBox.isChecked().catch(() => false)) await meetBox.uncheck(); }
  else if (opts.meet === "call") await page.getByRole("button", { name: /10-minute phone call/ }).click();
  else if (opts.meet === "visit") await page.getByRole("button", { name: /3-hour host-home trial/ }).click();
  await settle(page, 300);
  r.shots.push(await flow.shot("3-care-card"));
  await robustClick(page.getByRole("button", { name: "Review protected booking" }));
  await settle(page, 1000);
  r.stage = "review";
  // review + payment choice
  r.splitOffered = await page.getByRole("button", { name: /Reserve with 50% now/ }).isVisible().catch(() => false);
  if (r.splitOffered && opts.split === false) await page.getByRole("button", { name: /Pay the full amount now/ }).click();
  if (r.splitOffered && opts.split === true) await page.getByRole("button", { name: /Reserve with 50% now/ }).click();
  const payCta = page.getByRole("button", { name: /^Pay .*(create canonical stay|& )|Calculating price|Price unavailable|Locking care capacity/ }).last();
  const ctaDeadline = Date.now() + 25_000;
  while (Date.now() < ctaDeadline && !/^Pay /.test(await payCta.innerText().catch(() => ""))) await page.waitForTimeout(500);
  await settle(page, 600);
  r.review = oneLine(await page.locator("[aria-label='Review stay details']").innerText().catch(() => ""), 900);
  r.bill = oneLine(await page.locator("[class*=bill]").first().innerText().catch(() => ""), 400);
  r.uiTotal = money(await page.locator("[class*=bill] strong b").first().innerText().catch(() => ""));
  r.payChoice = oneLine(await page.locator("[class*=paymentChoice],[class*=fullPaymentNote]").first().innerText().catch(() => ""), 400);
  r.reviewHints = (await page.locator("p[class*=hint]").allInnerTexts().catch(() => [])).map(t => oneLine(t, 300));
  const consent = page.getByLabel(/I agree to care/);
  await consent.check();
  r.payCta = oneLine(await payCta.innerText().catch(() => ""));
  r.shots.push(await flow.shot("4-review"));
  r.quote = r.quotes.at(-1) || null;
  if (!opts.create) return r;
  if (!/^Pay /.test(r.payCta)) {
    r.stage = "quote-unavailable";
    r.confirmAlert = oneLine(await page.locator("[role=alert]").first().innerText({ timeout: 1000 }).catch(() => ""), 300);
    return r;
  }
  // create the canonical stay (the button is labelled "Pay … & create canonical stay")
  const before = r.quotes.length;
  for (let attempt = 1; attempt <= 2; attempt++) {
    net.scheduling = null; net.canonical = null;
    await robustClick(payCta);
    await page.getByText("Locking care capacity…").waitFor({ state: "detached", timeout: 45_000 }).catch(() => {});
    const createDeadline = Date.now() + 30_000;
    while (Date.now() < createDeadline) {
      if (await page.getByRole("button", { name: /Pay securely|Check payment status/ }).first().isVisible().catch(() => false)) break;
      if (await page.getByText(/Save care instructions before payment/).isVisible().catch(() => false) && await page.getByRole("button", { name: "Retry saving care instructions" }).isEnabled().catch(() => false)) break;
      if (await page.locator("[class*=flow] p[role=alert]").first().isVisible().catch(() => false)) break;
      await page.waitForTimeout(500);
    }
    await settle(page, 800);
    if (attempt === 1 && !net.canonical?.bookingId && (is401(net.scheduling) || is401(net.canonical))) { await reauth(context, "reserve/create → 401"); continue; }
    break;
  }
  r.quote = r.quotes.at(-1) || null; // the governed quote re-issued at confirmation (or the last review quote)
  r.quotesDuringConfirm = r.quotes.length - before;
  // The care-instructions gate (before payment) retries on the SAME booking; re-issue the session if it was superseded.
  const careRetry = page.getByRole("button", { name: "Retry saving care instructions" });
  for (let i = 0; i < 2 && net.canonical?.bookingId && await careRetry.isVisible().catch(() => false); i++) {
    r.careGateError = oneLine(await page.locator('section[aria-label="Save stay care before payment"] [role=alert]').first().innerText({ timeout: 1000 }).catch(() => ""), 200);
    if (net.care401 || /sign-in has expired/.test(r.careGateError)) { net.care401 = false; await reauth(context, "care gate → 401"); }
    await robustClick(careRetry);
    await page.getByRole("button", { name: /Pay securely/ }).first().waitFor({ timeout: 20_000 }).catch(() => {});
  }
  r.confirmAlert = oneLine(await page.locator("[class*=flow] p[role=alert]").first().innerText({ timeout: 1000 }).catch(() => ""), 300);
  r.bookingId = net.canonical?.bookingId || null;
  r.shots.push(await flow.shot("5-after-create"));
  r.stage = r.bookingId ? "created" : "confirm-blocked";
  if (!r.bookingId) return r;
  // payment page
  const payPage = page.locator('section[aria-label="Boarding payment"]').first();
  r.paymentPage = oneLine(await payPage.innerText().catch(() => ""), 600);
  r.paymentPageShowsRef = r.paymentPage.includes(r.bookingId);
  r.paymentDueNowUi = money((r.paymentPage.match(/Due now\s*₹[\d,.]+/) || [""])[0]);
  r.afterCreate = await checkoutStatus(context, r.bookingId);
  if (!opts.pay) return r;
  // pay with Razorpay TEST
  const payBtn = page.getByRole("button", { name: /Pay securely/ }).first();
  for (let attempt = 1; attempt <= 3; attempt++) {
    net.start = null;
    await robustClick(payBtn);
    const startDeadline = Date.now() + 25_000;
    while (Date.now() < startDeadline && !net.start) await page.waitForTimeout(300);
    await page.waitForTimeout(1500);
    if (attempt < 3 && is401(net.start)) { await reauth(context, "checkout start → 401"); await page.getByRole("button", { name: /Pay securely/ }).first().waitFor({ timeout: 10_000 }).catch(() => {}); continue; }
    break;
  }
  r.checkoutStart = net.start;
  r.payAlert = oneLine(await payPage.locator("[role=alert]").first().innerText({ timeout: 1500 }).catch(() => ""), 300);
  if (!net.start || net.start.http >= 400) {
    r.stage = "checkout-refused";
    r.envGated = net.start?.http === 503 && /not configured/i.test(`${net.start?.error} ${r.payAlert}`);
    r.shots.push(await flow.shot("6-checkout-refused"));
    return r;
  }
  if (net.start.status === "nothing_due") { r.stage = "nothing-due"; r.shots.push(await flow.shot("6-nothing-due")); return r; }
  await page.waitForTimeout(2500);
  r.shots.push(await flow.shot("6-razorpay-open", { fullPage: false }));
  r.razorpay = await payRazorpayTestNetbanking(page);
  flow.note(`razorpay result ${JSON.stringify(r.razorpay)}`);
  r.stage = "paid-submitted";
  r.capture = await waitForCapture(flow, r.bookingId, r.razorpay?.ok ? 90_000 : 20_000);
  r.shots.push(await flow.shot("7-after-payment"));
  r.stage = r.capture.server ? "captured" : "capture-pending";
  return r;
}

/** Poll page + customer projection until the capture is verified (UI) and projected (server). */
async function waitForCapture(flow, bookingId, timeoutMs = 90_000) {
  const { page, context } = flow;
  const deadline = Date.now() + timeoutMs;
  let lastCheck = 0, server = null, ui = false, uiText = "", serverAt = 0;
  while (Date.now() < deadline) {
    const text = await page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
    ui = /Payment verified by PawSpace|Boarding booking ·/.test(text) || (/booking-confirmation/.test(page.url()) && /confirmed|captured|verified/i.test(text));
    uiText = oneLine((text.match(/(Payment verified[^\n]*|Boarding booking ·[^\n]*|Razorpay returned[^\n]*|Waiting for signed[^\n]*|Payment is verified, but[^\n]*|Razorpay was closed[^\n]*)/) || [""])[0], 200);
    const status = await checkoutStatus(context, bookingId);
    // The instalment is captured once the payment record says so; booking confirmation is asserted separately.
    if (status.paymentStatus === "captured") { server = status; if (!serverAt) serverAt = Date.now(); }
    if (server && ui) break;
    if (server && Date.now() - serverAt > 25_000) break;
    const check = page.getByRole("button", { name: /Check payment status|Retry booking confirmation/ }).first();
    if (Date.now() - lastCheck > 8000 && await check.isVisible().catch(() => false) && await check.isEnabled().catch(() => false)) { lastCheck = Date.now(); await check.click().catch(() => {}); }
    await page.waitForTimeout(2500);
  }
  await settle(page, 1500);
  const final = await checkoutStatus(context, bookingId);
  return { ui, uiText, server: Boolean(server) || final.paymentStatus === "captured", final, waitedMs: timeoutMs - Math.max(0, deadline - Date.now()) };
}

/** Customer-facing booking page /v2/booking?bookingId= — what the customer sees after checkout. */
async function readBookingPage(flow, bookingId, label) {
  const { page } = flow;
  await page.goto(`${BASE}/v2/booking?bookingId=${encodeURIComponent(bookingId)}`, { waitUntil: "domcontentloaded" });
  await page.getByText("Loading your booking…").waitFor({ state: "detached", timeout: 25_000 }).catch(() => {});
  await settle(page, 1200);
  if (await page.getByRole("button", { name: "Retry booking" }).isVisible().catch(() => false)) {
    await reauth(flow.context, "/v2/booking load failed");
    await page.getByRole("button", { name: "Retry booking" }).click().catch(() => {});
    await page.getByText("Loading your booking…").waitFor({ state: "detached", timeout: 25_000 }).catch(() => {});
    await settle(page, 1200);
  }
  const text = oneLine(await mainText(page), 1200);
  const shot = await flow.shot(label);
  return {
    text, shot,
    status: (text.match(/Status: ([a-z ]+?)(?= \d| ·|$)/i) || [])[1] || null,
    payment: (text.match(/Payment: ([a-z_ ]+?)(?= Manage| Refresh|$)/i) || [])[1] || null,
    dueNow: money((text.match(/Due now\s*₹[\d,.]+/) || [""])[0]),
    balanceLater: money((text.match(/Balance later\s*₹[\d,.]+/) || [""])[0]),
    payButton: /Pay securely/.test(text),
  };
}

async function readManagePage(flow, bookingId, label) {
  const { page } = flow;
  await page.goto(`${BASE}/v2/boarding/manage?bookingId=${encodeURIComponent(bookingId)}`, { waitUntil: "domcontentloaded" });
  await dismissCookies(page);
  await page.getByText("Loading stay status…").waitFor({ state: "detached", timeout: 25_000 }).catch(() => {});
  await settle(page, 1200);
  if (/Stay record unavailable/.test(await mainText(page)) && /sign|expired|401/i.test(await mainText(page))) {
    await reauth(flow.context, "manage page signed-out");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByText("Loading stay status…").waitFor({ state: "detached", timeout: 25_000 }).catch(() => {});
    await settle(page, 1200);
  }
  const text = oneLine(await mainText(page), 1500);
  const status = oneLine(await page.locator("[class*=careLive] h4").first().innerText({ timeout: 3000 }).catch(() => ""), 80);
  const shot = await flow.shot(label);
  return { text, status, shot };
}

// ---------------------------------------------------------------------------------------------------------------
// findings helpers
const reported = new Set();
/** Known defects re-verified on several combos (once:true) are reported once per run; others once per flow. */
function reportFinding({ once = false, ...row }) {
  const key = row.title.replace(/\d[\d,.]*/g, "#") + (once ? "" : ` @ ${row.flow}`);
  if (reported.has(key)) return;
  reported.add(key);
  finding({ suite: SUITE, persona: PERSONA, ...row });
}
function priceCheck(r) {
  const q = r.quote, e = r.expected;
  if (!q) return { ok: false, text: `no quote captured (UI total ${inr(r.uiTotal)})` };
  const ok = q.packageCode === e.pkg && near(q.totalAmount, e.total) && Number(q.stayUnits) === e.units && near(q.basePricePerPet, e.unit);
  const dueOk = near(q.amountDueNow, e.dueNow);
  const uiOk = r.uiTotal == null || near(r.uiTotal, q.totalAmount);
  return { ok: ok && dueOk && uiOk, priceOk: ok, dueOk, uiOk, text: `quote ${q.packageCode} ${inr(q.basePricePerPet)}×${q.stayUnits} unit(s)×${q.petCount} pet(s) = ${inr(q.totalAmount)} due now ${inr(q.amountDueNow)} (${q.paymentMode}) vs rule ${e.pkg} ${inr(e.unit)}×${e.units}×${r.opts.pets.length} = ${inr(e.total)} due now ${inr(e.dueNow)}; UI total ${inr(r.uiTotal)}; split offered=${r.splitOffered} (rule ${e.splitOffered})` };
}
function copyChecks(r, evidence, comboLabel) {
  const all = [r.bill, r.payCta, r.payChoice, ...(r.reviewHints || [])].join(" | ");
  const jargon = ["Production OTP is not connected", "create canonical stay", "canonical Boarding quote", "UAT checkout", "UAT payment", "Canonical host capacity"].filter(p => all.includes(p));
  if (jargon.length) reportFinding({ severity: "P2", area: "Boarding copy", flow: `/v2/boarding ${comboLabel} review`, once: true, title: "Internal/UAT jargon in the customer Boarding review (BRD-04 — re-verified)", steps: "Plan → host → care card → Review protected booking", expected: "Customer-facing copy without internal terms", actual: `Visible: ${jargon.map(j => `"${j}"`).join(", ")}`, evidence });
  const oneDecimal = (all.match(/₹[\d,]+\.\d(?!\d)/g) || []);
  if (oneDecimal.length) reportFinding({ severity: "P3", area: "Boarding pricing display", flow: `/v2/boarding ${comboLabel} review`, once: true, title: "Amounts rendered with one decimal (BRD-05 — re-verified)", steps: "Review a split 50% Boarding stay", expected: "₹1,747.50", actual: `Visible: ${[...new Set(oneDecimal)].join(", ")}`, evidence });
}

// ---------------------------------------------------------------------------------------------------------------
// journeys
let browser;
const zoneCtx = { zone: null };
const PET_STATE = { ok: null, check: [] };
const created = {};

async function journey(name, combo, fn, { mobile = false, video = false, useBrowser = null } = {}) {
  if (timeLeft() < 90_000) { record({ suite: SUITE, journey: name, combo, result: "SKIPPED", detail: "suite time budget exhausted", evidence: [] }); return null; }
  const flow = await newFlow(useBrowser || browser, `${SUITE}/${name}`, { mobile, video });
  const t0 = Date.now();
  try {
    await customerSession(flow.context, PERSONA);
    const out = await fn(flow);
    summary.journeys.push({ name, combo, ms: Date.now() - t0, result: out?.result });
    return out;
  } catch (e) {
    const shot = await flow.shot("error").catch(() => null);
    const harness = /harness:|Timeout|locator|waiting for|strict mode|Target closed|net::/i.test(String(e));
    record({ suite: SUITE, journey: name, combo, result: "BLOCKED", detail: `${harness ? "harness: " : ""}${oneLine(String(e?.message || e), 600)}`, evidence: [shot].filter(Boolean) });
    summary.journeys.push({ name, combo, ms: Date.now() - t0, result: "BLOCKED", error: oneLine(String(e), 300) });
    return null;
  } finally {
    await flow.close();
  }
}

/** Setup: make sure customer-a owns the Master pets (added via /v2/account PetManager only when missing). */
async function setupPets(flow) {
  const { page, context } = flow;
  const acct = await capi(context, "GET", "/api/customer-account");
  if (acct.status !== 200) throw new Error(`harness: GET /api/customer-account HTTP ${acct.status}`);
  const zone = await capi(context, "GET", "/api/service-zone?pincode=560038");
  zoneCtx.zone = zone.body?.data?.assignment ? { cityId: zone.body.data.assignment.cityId, zoneId: zone.body.data.assignment.zoneId } : null;
  const existing = acct.body?.data?.pets || [];
  const missing = PETS.filter(p => !existing.some(e => e.name === p.name));
  const vaccinated = (e) => ["verified", "vaccinated"].includes(String(e?.vaccinationStatus));
  const wrong = PETS.filter(p => { const e = existing.find(x => x.name === p.name); return e && vaccinated(e) !== (p.vaccinated === "yes"); });
  flow.note(`customer-a pets before: ${existing.map(p => `${p.name}(${p.species},${p.vaccinationStatus})`).join(", ") || "none"}; missing: ${missing.map(p => p.name).join(", ") || "none"}; vaccination to reset: ${wrong.map(p => p.name).join(", ") || "none"}`);
  await page.goto(`${BASE}/v2/account`, { waitUntil: "domcontentloaded" });
  await dismissCookies(page);
  await page.getByText("Loading your account…").waitFor({ state: "detached", timeout: 25_000 }).catch(() => {});
  await page.getByText("Loading your pets…").first().waitFor({ state: "detached", timeout: 25_000 }).catch(() => {});
  await settle(page, 800);
  const shots = [await flow.shot("account-pets-before")];
  const added = [], issues = [];
  for (const p of missing) {
    await page.getByRole("button", { name: /Add pet/ }).first().click();
    const form = page.locator("[class*=form]").filter({ has: page.getByPlaceholder("Pet name") }).first();
    await form.getByPlaceholder("Pet name").fill(p.name);
    await form.getByLabel("Species").selectOption(p.species);
    await form.getByPlaceholder("Start typing a breed").fill(p.breed);
    for (const [label, index] of [[/^Age/, 3], [/^Weight/, 2], [/^Temperament/, 1]]) {
      const sel = form.locator("label").filter({ hasText: label }).locator("select").first();
      const n = await sel.locator("option").count();
      await sel.selectOption({ index: Math.min(index, n - 1) });
    }
    await form.locator("label").filter({ hasText: /^Vaccinated\?/ }).locator("select").selectOption(p.vaccinated);
    if (p.dose) await form.getByPlaceholder("e.g. Rabies / DHPPi").fill(p.dose);
    shots.push(await flow.shot(`add-${p.name}-form`));
    await form.getByRole("button", { name: "Add pet", exact: true }).click();
    await page.getByRole("button", { name: /Saving…/ }).waitFor({ state: "detached", timeout: 20_000 }).catch(() => {});
    await settle(page, 800);
    const alert = oneLine(await page.locator("ul[role=alert]").first().innerText({ timeout: 1000 }).catch(() => ""), 300);
    if (alert) issues.push(`${p.name}: ${alert}`); else added.push(p.name);
    if (alert) await page.getByRole("button", { name: "Cancel" }).first().click().catch(() => {});
  }
  for (const p of wrong) {
    // Another tester changed a Master pet's vaccination answer: put it back through the same PetManager Edit form.
    const card = page.locator("article").filter({ has: page.locator("b", { hasText: new RegExp(`^${esc(p.name)}$`) }) }).first();
    await card.getByRole("button", { name: "Edit" }).click();
    const form = page.locator("[class*=form]").filter({ has: page.getByPlaceholder("Pet name") }).first();
    await form.locator("label").filter({ hasText: /^Vaccinated\?/ }).locator("select").selectOption(p.vaccinated);
    for (const [label, index] of [[/^Age/, 3], [/^Weight/, 2], [/^Temperament/, 1]]) {
      const sel = form.locator("label").filter({ hasText: label }).locator("select").first();
      if (!(await sel.inputValue().catch(() => ""))) await sel.selectOption({ index }).catch(() => {});
    }
    await form.getByRole("button", { name: "Save changes" }).click();
    await settle(page, 1200);
    const alert = oneLine(await page.locator("ul[role=alert]").first().innerText({ timeout: 1000 }).catch(() => ""), 300);
    if (alert) { issues.push(`${p.name} (fix vaccination): ${alert}`); await page.getByRole("button", { name: "Cancel" }).first().click().catch(() => {}); }
    else added.push(`${p.name} (vaccination reset to ${p.vaccinated})`);
  }
  shots.push(await flow.shot("account-pets-after"));
  const after = (await capi(context, "GET", "/api/customer-account")).body?.data?.pets || [];
  const check = PETS.map(p => { const e = after.find(x => x.name === p.name); return { name: p.name, present: Boolean(e), vaccinationStatus: e?.vaccinationStatus, expectVaccinated: p.vaccinated === "yes", ok: Boolean(e) && (p.vaccinated === "yes" ? ["verified", "vaccinated"].includes(e.vaccinationStatus) : !["verified", "vaccinated"].includes(e.vaccinationStatus)) }; });
  const ok = check.every(c => c.ok);
  PET_STATE.ok = ok; PET_STATE.check = check;
  record({ suite: SUITE, journey: "setup-pets", combo: "customer-a MasterDog/MasterCat/MasterBuddy vaccinated + MasterPup unvaccinated", result: ok ? "PASS" : issues.length ? "FAIL" : "PARTIAL", detail: `added via /v2/account PetManager: [${added.join(", ") || "none — already present"}]; issues: [${issues.join("; ")}]; API after: ${check.map(c => `${c.name}=${c.present ? c.vaccinationStatus : "MISSING"}`).join(", ")}; zone probe ${JSON.stringify(zoneCtx.zone)}`, evidence: shots, data: { check } });
  if (issues.length) reportFinding({ severity: "P1", area: "Account / pets", flow: "/v2/account PetManager", title: "Adding a pet from V2 account failed", steps: "Account → Pets → + Add pet → fill profile → Add pet", expected: "Pet saved", actual: issues.join("; "), evidence: shots });
  return { result: ok ? "PASS" : "FAIL", check };
}

/** Records a combination, saves the booking hand-off row and returns the run. */
async function comboJourney(flow, { name, combo, opts, requireCapture }) {
  const r = await runBoarding(flow, opts);
  const pc = priceCheck(r);
  const evidence = r.shots.filter(Boolean);
  copyChecks(r, evidence, combo);
  const parts = [
    `dates ${opts.start} ${opts.startTime} → ${opts.end} ${opts.endTime} (${r.durationSummary})`,
    `pets [${(r.selectedPets || []).join("+")}]`,
    `address ${r.address?.path}${r.address?.mapVerified ? " (Google map verified)" : ""} "${r.address?.caption || r.address?.alert || ""}"${r.address?.attempts?.length > 1 ? ` after ${JSON.stringify(r.address.attempts.slice(0, -1))}` : ""}${r.address?.suggestions ? ` suggestions=${JSON.stringify(r.address.suggestions.slice(0, 2))}` : ""}`,
    `host ${r.host || "-"} of [${(r.hosts || []).map(h => h.split(" | ").slice(-1)[0]).join(", ")}]`,
    pc.text,
    `CTA "${r.payCta || r.planCta}"`,
  ];
  if (flow.context.__reauths) parts.push(`customer-a session re-issued ×${flow.context.__reauths} (superseded by a concurrent customer-a sign-in)`);
  if (r.bookingId) parts.push(`booking ${r.bookingId} → after create: booking=${r.afterCreate?.bookingStatus} payment=${r.afterCreate?.paymentStatus} dueNow=${inr(r.afterCreate?.amountDueNow)}`);
  if (r.net?.scheduling && r.net.scheduling.http >= 400) parts.push(`uat-scheduling HTTP ${r.net.scheduling.http} ${r.net.scheduling.code || ""} ${r.net.scheduling.error || ""}`);
  if (r.hostAlert) parts.push(`host step alert "${r.hostAlert}"`);
  if (r.confirmAlert) parts.push(`alert "${r.confirmAlert}"`);
  if (r.checkoutStart) parts.push(`checkout start HTTP ${r.checkoutStart.http} ${r.checkoutStart.orderId ? `${r.checkoutStart.orderId} amount ${r.checkoutStart.amountPaise} paise` : r.checkoutStart.error || ""}`);
  if (r.razorpay) parts.push(`razorpay ${JSON.stringify(r.razorpay)}`);
  if (r.capture) parts.push(`capture ui=${r.capture.ui} "${r.capture.uiText}" server=${r.capture.server} final booking=${r.capture.final?.bookingStatus} payment=${r.capture.final?.paymentStatus} dueNow=${inr(r.capture.final?.amountDueNow)} pay=${r.capture.final?.gatewayPaymentId || "-"}`);
  // server + D1 truth for created bookings
  let db = null;
  if (r.bookingId) {
    db = await d1Payment(r.bookingId);
    // The capture row can trail the customer projection by a few seconds; re-read before judging.
    for (let i = 0; i < 6 && r.capture?.server && d1Captured(db) === false; i++) { await new Promise(res => setTimeout(res, 5000)); db = await d1Payment(r.bookingId); }
    parts.push(d1Brief(db));
    if (r.capture?.server) {
      const bp = await readBookingPage(flow, r.bookingId, "8-booking-page");
      r.bookingPage = bp; evidence.push(bp.shot);
      parts.push(`/v2/booking: status=${bp.status} payment=${bp.payment} dueNow=${inr(bp.dueNow)} balanceLater=${inr(bp.balanceLater)} payButton=${bp.payButton}`);
    }
  }
  // outcome
  let result;
  if (r.stage === "address") result = r.address?.alert ? "FAIL" : "BLOCKED";
  else if (r.stage === "quote-unavailable") result = "FAIL";
  else if (!r.bookingId && opts.create) result = r.net?.scheduling?.code === "SERVICE_ADDRESS_UNVERIFIED" ? "FAIL" : (r.stage === "plan" || r.stage === "hosts") ? "BLOCKED" : "FAIL";
  else if (!pc.ok) result = "FAIL";
  else if (!opts.pay) result = r.bookingId || !opts.create ? "PASS" : "FAIL";
  else if (r.stage === "checkout-refused") result = r.envGated ? "ENV-GATED" : "FAIL";
  else if (r.razorpay && !r.razorpay.ok) result = "BLOCKED";
  else if (r.capture?.server) {
    const dbOk = d1Captured(db);
    const confirmed = ["confirmed", "assigned", "in_progress"].includes(String(r.capture.final?.bookingStatus));
    result = confirmed && r.capture.ui && dbOk !== false ? "PASS" : "PARTIAL";
  } else result = "FAIL";
  if (r.razorpay && !r.razorpay.ok) parts.push("harness: Razorpay TEST netbanking success control was not reached");
  record({ suite: SUITE, journey: name, combo, result, detail: parts.join(" · "), evidence, data: { bookingId: r.bookingId, quote: r.quote, expected: r.expected, stage: r.stage, checkout: r.checkoutStart, capture: r.capture?.final, db } });

  // product findings with evidence
  if (r.stage === "address" && r.address?.alert) reportFinding({ severity: "P1", area: "Maps / AddressPicker", flow: `/v2/boarding ${combo}`, title: "Booking AddressPicker could not verify a serviceable Indiranagar address", steps: `Change Address → type "${ADDRESS_QUERY}" → first Google suggestion, then "Verify service address"`, expected: "Serviceable zone resolved, 'Use this address' enabled", actual: `attempts ${JSON.stringify(r.address.attempts)}`, evidence });
  if (r.stage === "confirm-blocked" && r.net?.scheduling?.code !== "SERVICE_ADDRESS_UNVERIFIED" && !is401(r.net?.scheduling) && !is401(r.net?.canonical)) reportFinding({ severity: "P1", area: "Boarding booking", flow: `/v2/boarding ${combo}`, title: "Boarding booking could not be created after hosts and price were shown", steps: "Plan → host → care card → review → Pay & create canonical stay", expected: "Canonical stay created, payment step shown", actual: `uat-scheduling ${JSON.stringify(r.net?.scheduling)}; canonical-bookings ${JSON.stringify(r.net?.canonical)}; UI alert "${r.confirmAlert}"`, evidence });
  if (r.stage === "quote-unavailable") reportFinding({ severity: "P1", area: "Boarding pricing", flow: `/v2/boarding ${combo}`, title: "Boarding review cannot price the stay", steps: "Plan → host → care card → review", expected: "Governed quote and a Pay button", actual: `CTA "${r.payCta}"; alert "${r.confirmAlert}"`, evidence });
  if (r.quote && !pc.priceOk) reportFinding({ severity: "P0", area: "Boarding pricing", flow: `/v2/boarding ${combo}`, title: "Boarding quote does not follow the published per-pet unit rule", steps: `Plan ${opts.pets.length} pet(s) ${opts.start} ${opts.startTime} → ${opts.end} ${opts.endTime}; review`, expected: `${r.expected.pkg} ${inr(r.expected.unit)} × ${r.expected.units} × ${opts.pets.length} = ${inr(r.expected.total)}`, actual: pc.text, evidence });
  if (r.quote && pc.priceOk && !pc.dueOk) reportFinding({ severity: "P0", area: "Boarding payment schedule", flow: `/v2/boarding ${combo}`, title: "Amount due now does not match the chosen payment option", steps: `Review, choose ${opts.split === true ? "Reserve with 50% now" : opts.split === false ? "Pay the full amount now" : "default"}`, expected: `due now ${inr(r.expected.dueNow)}`, actual: pc.text, evidence });
  if (r.splitOffered !== undefined && r.stage !== "plan" && r.stage !== "hosts" && r.splitOffered !== r.expected.splitOffered) reportFinding({ severity: "P1", area: "Boarding payment schedule", flow: `/v2/boarding ${combo}`, title: `50/50 split ${r.splitOffered ? "offered" : "not offered"} contrary to the >4-night rule`, steps: `Review ${r.expected.nights} night(s), ${r.expected.hours} h`, expected: `split offered=${r.expected.splitOffered}`, actual: `split offered=${r.splitOffered}; ${r.payChoice}`, evidence });
  if (r.checkoutStart?.orderId && r.quote && Number(r.checkoutStart.amountPaise) !== Math.round(Number(r.quote.amountDueNow) * 100)) reportFinding({ severity: "P0", area: "Payments", flow: `/v2/boarding ${combo}`, title: "Razorpay order amount differs from the amount due now", steps: "Pay & create canonical stay → Pay securely", expected: `${Math.round(Number(r.quote.amountDueNow) * 100)} paise (${inr(r.quote.amountDueNow)})`, actual: `order ${r.checkoutStart.orderId} amountPaise=${r.checkoutStart.amountPaise}`, evidence });
  if (r.net?.scheduling?.code === "SERVICE_ADDRESS_UNVERIFIED") reportFinding({ severity: "P1", area: "Maps / Boarding", flow: `/v2/boarding ${combo}`, title: "Reserve refused SERVICE_ADDRESS_UNVERIFIED after the AddressPicker verified the address (MAP-01 — CONFIRMED-ON-STAGING if BASE is staging)", steps: `AddressPicker "${ADDRESS_QUERY}" → ${r.address?.path} → plan → review → Pay & create`, expected: "Canonical stay created", actual: `POST /api/uat-scheduling ${r.net.scheduling.http} ${r.net.scheduling.code}; UI: "${r.confirmAlert}"`, evidence });
  if (r.bookingId && r.paymentPage && !r.paymentPageShowsRef) reportFinding({ severity: "P2", area: "Payment page", flow: `/v2/boarding ${combo} payment step`, once: true, title: "Payment step shows no booking reference while payment is pending (PAY-04 — re-verified)", steps: "Pay & create canonical stay → payment step", expected: `Booking reference ${r.bookingId} visible`, actual: `Payment step text: "${oneLine(r.paymentPage, 250)}"`, evidence });
  if (opts.pay && r.razorpay?.ok && !r.capture?.server) reportFinding({ severity: "P1", area: "Payments", flow: `/v2/boarding ${combo}`, title: "Razorpay TEST payment succeeded but PawSpace never projected the capture", steps: "Pay securely → Razorpay TEST Netbanking → Success", expected: "Booking payment captured within 90 s", actual: `${r.capture?.uiText || "no UI confirmation"}; status=${r.capture?.final?.status} payment=${r.capture?.final?.paymentStatus}; ${d1Brief(db)}`, evidence });
  if (r.capture?.server && !["confirmed", "assigned", "in_progress"].includes(String(r.capture.final?.bookingStatus))) reportFinding({ severity: "P1", area: "Booking lifecycle", flow: `/v2/boarding ${combo}`, title: "Captured Boarding payment did not confirm the booking", steps: "Pay with Razorpay TEST", expected: "bookingStatus confirmed", actual: `bookingStatus=${r.capture.final?.bookingStatus} paymentStatus=${r.capture.final?.paymentStatus}`, evidence });
  if (r.capture?.server && r.capture.final?.paymentMode === "prepaid" && r.bookingPage?.payButton) reportFinding({ severity: "P1", area: "Payment page", flow: `/v2/booking ${combo}`, title: "Fully paid booking still offers 'Pay securely'", steps: "Pay in full, open /v2/booking", expected: "No payment control", actual: r.bookingPage.text.slice(0, 300), evidence });

  if (r.bookingId) {
    const row = { suite: SUITE, bookingId: r.bookingId, service: "boarding", packageCode: r.quote?.packageCode, providerId: null, providerName: r.capture?.final?.providerName || r.afterCreate?.providerName || r.host, customer: PERSONA, scheduledStart: r.quote?.scheduledStart || `${opts.start}T${opts.startTime}+05:30`, scheduledEnd: r.quote?.scheduledEnd, total: r.quote?.totalAmount, dueNow: r.quote?.amountDueNow, paid: Boolean(r.capture?.server), paymentMode: r.quote?.paymentMode, pets: r.selectedPets, combo };
    const pid = await api(flow.context, "GET", `/api/boarding-stays?scope=customer&bookingId=${encodeURIComponent(r.bookingId)}`).catch(() => null);
    row.providerId = pid?.body?.data?.[0]?.host_provider_id || null;
    saveBooking(row);
    created[name] = { ...row, result, run: r };
    summary.bookings[name] = row;
  }
  return { result, r, db };
}

/** Read-only D1 check, after the other journeys, that each Razorpay TEST payment reached the ledger via a signed webhook. */
async function reconcilePayments() {
  const paidRuns = Object.entries(created).filter(([, b]) => b.run?.checkoutStart?.orderId);
  if (!paidRuns.length) { record({ suite: SUITE, journey: "payments-d1-webhook-reconciliation", combo: "all Razorpay TEST orders", result: "SKIPPED", detail: "no Razorpay order was opened in this run (locally: checkout refused 503)", evidence: [] }); return; }
  for (const [name, b] of paidRuns) {
    const orderId = b.run.checkoutStart.orderId;
    const db = await d1Payment(b.bookingId);
    if (db.skipped) { record({ suite: SUITE, journey: "payments-d1-webhook-reconciliation", combo: `${name} ${b.bookingId}`, result: "ENV-GATED", detail: `order ${orderId}; ${d1Brief(db)}`, evidence: [] }); continue; }
    const inbox = await d1("SELECT event_type,processing_status,failure_reason,received_at,processed_at FROM gateway_webhook_events WHERE raw_payload LIKE ? ORDER BY received_at", [`%${orderId}%`]);
    const events = Array.isArray(db.events) ? db.events : [];
    const signed = events.filter(e => Number(e.signature_verified) === 1 && e.processing_status === "processed" && ["payment.captured", "order.paid"].includes(e.event_type));
    const providerApi = events.filter(e => e.authority === "provider_api");
    const stuck = Array.isArray(inbox) ? inbox.filter(e => !["PROCESSED", "processed", "DUPLICATE", "duplicate"].includes(String(e.processing_status))) : [];
    const captured = db.payment?.status === "captured";
    const result = captured && signed.length ? "PASS" : captured ? "PARTIAL" : "FAIL";
    const detail = `order ${orderId}; booking=${db.booking?.status} payment=${db.payment?.status}; signed webhook captures processed=${signed.length}; provider_api captures=${providerApi.length}; webhook inbox rows=${Array.isArray(inbox) ? inbox.map(e => `${e.event_type}/${e.processing_status}${e.failure_reason ? "/" + e.failure_reason : ""}`).join(",") || "none" : JSON.stringify(inbox)}; ${d1Brief(db)}${captured && !signed.length && stuck.length ? " · PAY-01 CONFIRMED-ON-STAGING" : captured && signed.length ? " · PAY-01 NOT-REPRODUCED-ON-STAGING" : ""}`;
    record({ suite: SUITE, journey: "payments-d1-webhook-reconciliation", combo: `${name} ${b.bookingId}`, result, detail, evidence: [] });
    if (captured && !signed.length && stuck.length) reportFinding({ once: true, severity: "P1", area: "Payments", flow: "Razorpay webhook → PawSpace", title: "Razorpay TEST webhooks for captured Boarding payments are left unprocessed in the inbox (PAY-01 — CONFIRMED-ON-STAGING)", steps: "Pay a Boarding booking with Razorpay TEST; read gateway_webhook_events / payment_gateway_events", expected: "Signed payment.captured webhook processed", actual: detail, evidence: [] });
    if (!captured && b.paid) reportFinding({ severity: "P0", area: "Payments", flow: `ledger ${name}`, title: "Customer projection said captured but booking_payments is not captured", steps: "Pay with Razorpay TEST; compare /api/customer-checkout status with D1", expected: "booking_payments.status=captured", actual: detail, evidence: [] });
  }
}

// ---------------------------------------------------------------------------------------------------------------
async function main() {
  browser = await launch();
  console.log(`[${SUITE}] BASE=${BASE} window=${W_FROM}-${W_TO} days`);

  await journey("setup-pets", "ensure Master pets", setupPets);

  // date planning (read-only capacity probe so re-runs on staging do not collide with earlier stays)
  const plan = {};
  await journey("plan-dates", "capacity probe", async (flow) => {
    const z = zoneCtx.zone || (await api(flow.context, "GET", "/api/service-zone?pincode=560038")).body?.data?.assignment;
    const zone = z ? { cityId: z.cityId, zoneId: z.zoneId } : null;
    const specs = {
      c1: { prefer: 41, spanDays: 0, startTime: "09:00", endTime: "13:00", pets: 1, species: ["dog"] },
      c2: { prefer: 42, spanDays: 0, startTime: "09:00", endTime: "19:00", pets: 1, species: ["cat"] },
      c3: { prefer: 44, spanDays: 2, startTime: "10:00", endTime: "10:00", pets: 2, species: ["dog", "cat"] },
      c4: { prefer: 47, spanDays: 5, startTime: "10:00", endTime: "10:00", pets: 1, species: ["dog"] },
      c5: { prefer: 53, spanDays: 6, startTime: "11:00", endTime: "11:00", pets: 3, species: ["dog", "cat"] },
      c8: { prefer: 60, spanDays: 3, startTime: "09:00", endTime: "18:00", pets: 1, species: ["dog"] },
      c6: { prefer: 64, spanDays: 2, startTime: "10:00", endTime: "10:00", pets: 2, species: ["dog"] },
      show: { prefer: 67, spanDays: 2, startTime: "10:00", endTime: "10:00", pets: 2, species: ["dog", "cat"] },
    };
    for (const [k, s] of Object.entries(specs)) plan[k] = { ...(await pickDates(flow.context, zone, s)), startTime: s.startTime, endTime: s.endTime };
    record({ suite: SUITE, journey: "plan-dates", combo: "read-only host capacity probe", result: "PASS", detail: Object.entries(plan).map(([k, v]) => `${k}: ${v.start}→${v.end} (+${v.offset}d; ${v.probe})`).join(" · "), evidence: [] });
    return { result: "PASS" };
  });
  const P = (k, fallback) => plan[k] || fallback;
  const d = (k, prefer, span, st, et) => P(k, { start: isoDay(prefer), end: isoDay(prefer + span), startTime: st, endTime: et });

  // (1) 4 h daycare, 1 dog — PAY
  const p1 = d("c1", 41, 0, "09:00", "13:00");
  await journey("combo-1-4h-daycare-dog", "4h daycare · MasterDog · no trial · pay full", (flow) => comboJourney(flow, { name: "combo-1-4h-daycare-dog", combo: "4h daycare 1 dog",
    opts: { start: p1.start, end: p1.end, startTime: p1.startTime, endTime: p1.endTime, pets: ["MasterDog"], meet: false, create: true, pay: true } }));

  // (2) 10 h daycare cat + Grooming add-on + phone-call meet — UNPAID (ledger suite)
  const p2 = d("c2", 42, 0, "09:00", "19:00");
  await journey("combo-2-10h-daycare-cat-unpaid", "10h daycare · MasterCat · Grooming add-on · phone call · left unpaid", async (flow) => {
    const out = await comboJourney(flow, { name: "combo-2-10h-daycare-cat-unpaid", combo: "10h daycare cat + grooming add-on + call (unpaid)",
      opts: { start: p2.start, end: p2.end, startTime: p2.startTime, endTime: p2.endTime, pets: ["MasterCat"], extras: ["Grooming add-on"], food: "Pet food from home", meet: "call", create: true, pay: false } });
    const id = out?.r?.bookingId;
    if (id) {
      // BRD-02 re-check: what does the unpaid stay tell the customer?
      const m = await readManagePage(flow, id, "9-manage-unpaid");
      const mentionsPayment = /payment pending|awaiting payment|pay now|unpaid|Pay securely/i.test(m.text);
      record({ suite: SUITE, journey: "combo-2-unpaid-manage-page", combo: "unpaid booking manage page", result: mentionsPayment ? "PASS" : "FAIL", detail: `booking ${id} manage status "${m.status}"; payment state shown=${mentionsPayment}; ${oneLine(m.text, 300)}`, evidence: [m.shot] });
      if (!mentionsPayment) reportFinding({ severity: "P2", area: "Boarding manage page", flow: "/v2/boarding/manage (unpaid)", title: "Unpaid Boarding booking shows host-acceptance status with no payment-pending state or pay control (BRD-02 — re-verified)", steps: "Create 10h Boarding booking, do not pay, open Manage", expected: "Payment pending + a way to pay", actual: `Status "${m.status}"; no payment wording`, evidence: [m.shot] });
    }
    return out;
  });

  // (3) 2 nights dog+cat, ALL extras, food, host-home trial — PAY
  const p3 = d("c3", 44, 2, "10:00", "10:00");
  await journey("combo-3-2n-dog-cat-all-extras", "2 nights · MasterDog+MasterCat · all 6 extras · food · host-home trial · pay full", async (flow) => {
    const out = await comboJourney(flow, { name: "combo-3-2n-dog-cat-all-extras", combo: "2 nights dog+cat all extras + food + trial visit",
      opts: { start: p3.start, end: p3.end, startTime: p3.startTime, endTime: p3.endTime, pets: ["MasterDog", "MasterCat"], needs: ["Medication", "Two daily walks"], extras: ALL_EXTRAS, food: "Vegetarian fresh food", meet: "visit", create: true, pay: true } });
    // BRD-01 re-check: extras recorded as free text but not billed
    const r = out?.r;
    if (r?.bookingId) {
      const stay = await boardingStay(flow.context, r.bookingId);
      const special = String(stay?.carePlan?.plan?.specialInstructions || "");
      const extrasSaved = ALL_EXTRAS.every(x => special.includes(x));
      const unbilled = r.quote && near(r.quote.totalAmount, r.expected.total);
      record({ suite: SUITE, journey: "combo-3-extras-persistence", combo: "requested extras + food saved on care plan", result: extrasSaved && special.includes("Vegetarian fresh food") ? "PASS" : "FAIL", detail: `care plan status ${stay?.care_plan_status}; specialInstructions: "${oneLine(special, 400)}"; bill ${r.bill}`, evidence: r.shots.slice(2, 4) });
      if (extrasSaved && unbilled) reportFinding({ severity: "P2", area: "Boarding add-ons", flow: "/v2/boarding 2 nights all extras", title: "Requested extras (6 add-ons) are not priced or billed — saved only as free text (BRD-01 — re-verified)", steps: "Care card → select all six Requested extras → Review", expected: "Priced add-ons or an explicit 'quoted later' line in the bill", actual: `Bill "${r.bill}" equals the base rule ${inr(r.expected.total)}; extras stored in care plan text only`, evidence: r.shots.slice(2, 4) });
    }
    return out;
  });

  // (4) 5 nights split 50% — PAY the deposit, then check booking + manage pages
  const p4 = d("c4", 47, 5, "10:00", "10:00");
  await journey("combo-4-5n-split-deposit", "5 nights · MasterDog · Reserve with 50% · pay deposit", async (flow) => {
    const out = await comboJourney(flow, { name: "combo-4-5n-split-deposit", combo: "5 nights split 50% deposit",
      opts: { start: p4.start, end: p4.end, startTime: p4.startTime, endTime: p4.endTime, pets: ["MasterDog"], meet: "visit", split: true, create: true, pay: true } });
    const r = out?.r;
    if (!r?.bookingId) return out;
    const bp = r.bookingPage || await readBookingPage(flow, r.bookingId, "9-booking-page-split");
    const m = await readManagePage(flow, r.bookingId, "10-manage-split");
    const total = r.quote?.totalAmount, deposit = r.quote?.amountDueNow;
    const PAID_RX = /deposit[^.]{0,40}(paid|received|captured)|amount paid|paid ₹\s?\d|₹[\d,.]+ (paid|received)|balance (due|of) ₹|balance due (on|by|before)/i;
    const bookingShowsDepositPaid = PAID_RX.test(bp.text);
    const manageShowsPayment = PAID_RX.test(m.text) || /deposit|balance ₹|Payment: captured/i.test(m.text);
    const stillAsksDeposit = bp.payButton && bp.dueNow != null && bp.balanceLater != null && near(bp.dueNow + bp.balanceLater, total);
    const db = r.capture?.server ? await d1Payment(r.bookingId) : null;
    const detail = `booking ${r.bookingId} total ${inr(total)} deposit ${inr(deposit)} captured=${Boolean(r.capture?.server)} · /v2/booking: status=${bp.status} payment=${bp.payment} "Due now" ${inr(bp.dueNow)} "Balance later" ${inr(bp.balanceLater)} payButton=${bp.payButton} depositPaidShown=${bookingShowsDepositPaid} · manage: "${m.status}" paymentInfo=${manageShowsPayment} · ${db ? d1Brief(db) : "d1: not read (no capture)"}`;
    let result;
    if (!r.capture?.server) result = r.stage === "checkout-refused" && r.envGated ? "ENV-GATED" : "BLOCKED";
    else result = !stillAsksDeposit && bookingShowsDepositPaid && manageShowsPayment ? "PASS" : "FAIL";
    record({ suite: SUITE, journey: "combo-4-split-after-deposit", combo: "split: booking + manage pages after deposit", result, detail: `${detail}${r.capture?.server ? ` · PAY-03 ${stillAsksDeposit ? "CONFIRMED-ON-STAGING" : "NOT-REPRODUCED-ON-STAGING"}` : ""}`, evidence: [bp.shot, m.shot] });
    if (r.capture?.server && stillAsksDeposit) reportFinding({ severity: "P1", area: "Payments", flow: "/v2/booking (split after deposit)", title: `Split Boarding booking still shows "Due now ${inr(bp.dueNow)} · Balance later ${inr(bp.balanceLater)} · Pay securely" after the 50% deposit was captured (PAY-03 — CONFIRMED-ON-STAGING)`, steps: "Book 5 nights, Reserve with 50%, pay deposit with Razorpay TEST, open /v2/booking", expected: `Deposit ${inr(deposit)} shown as paid, balance ${inr(total - deposit)} due 24 h before check-in`, actual: `Status ${bp.status}, Payment ${bp.payment}; Due now ${inr(bp.dueNow)} + Balance later ${inr(bp.balanceLater)} = ${inr(total)} (full price) with a Pay button`, evidence: [bp.shot] });
    if (r.capture?.server && !manageShowsPayment) reportFinding({ severity: "P2", area: "Boarding manage page", flow: "/v2/boarding/manage (split after deposit)", title: "Manage page shows no payment state (deposit paid / balance due) for a split Boarding booking", steps: "Pay the 50% deposit, open Manage", expected: "Deposit paid + balance due date", actual: `Status "${m.status}"; no deposit/balance wording`, evidence: [m.shot] });
    return out;
  });

  // (5) 6 nights, 3 pets, PAY FULL
  const p5 = d("c5", 53, 6, "11:00", "11:00");
  await journey("combo-5-6n-3pets-full", "6 nights · MasterDog+MasterCat+MasterBuddy · Pay the full amount · Three walks", (flow) => comboJourney(flow, { name: "combo-5-6n-3pets-full", combo: "6 nights 3 pets pay full",
    opts: { start: p5.start, end: p5.end, startTime: p5.startTime, endTime: p5.endTime, pets: ["MasterDog", "MasterCat", "MasterBuddy"], extras: ["Three walks"], food: "Non-vegetarian fresh food", meet: "call", split: false, create: true, pay: true } }));

  // (6) unvaccinated pet → blocked (no booking may be created)
  const p6 = d("c6", 64, 2, "10:00", "10:00");
  await journey("combo-6-unvaccinated-blocked", "2 nights · MasterDog+MasterPup (unvaccinated)", async (flow) => {
    const pup = (await capi(flow.context, "GET", "/api/customer-account")).body?.data?.pets?.find(p => p.name === "MasterPup");
    if (!pup || ["verified", "vaccinated"].includes(String(pup.vaccinationStatus))) {
      record({ suite: SUITE, journey: "combo-6-unvaccinated-blocked", combo: "unvaccinated pet", result: "BLOCKED", detail: `harness: MasterPup is ${pup ? `recorded as ${pup.vaccinationStatus}` : "missing"} — cannot test the unvaccinated gate`, evidence: [] });
      return { result: "BLOCKED" };
    }
    const r = await runBoarding(flow, { start: p6.start, end: p6.end, startTime: p6.startTime, endTime: p6.endTime, pets: ["MasterDog", "MasterPup"], meet: false, create: true, pay: false });
    const blocked = !r.bookingId && /vaccination/i.test(r.confirmAlert || "");
    const earlyWarning = /vaccin/i.test(`${r.planHint} ${r.durationSummary} ${(r.hosts || []).join(" ")} ${r.review}`);
    record({ suite: SUITE, journey: "combo-6-unvaccinated-blocked", combo: "unvaccinated pet", result: blocked ? "PASS" : r.bookingId ? "FAIL" : "BLOCKED", detail: `stage ${r.stage}; alert "${r.confirmAlert}"; canonical-bookings POST ${r.net.canonical ? `HTTP ${r.net.canonical.http} ${r.net.canonical.bookingId || ""}` : "not sent"}; warned before final click=${earlyWarning}; ${priceCheck(r).text}`, evidence: r.shots });
    if (r.bookingId) {
      reportFinding({ severity: "P0", area: "Boarding safety", flow: "/v2/boarding unvaccinated", title: "Boarding booking created for an unvaccinated pet", steps: "Select MasterDog + MasterPup (Vaccinated? No) → review → Pay & create", expected: "Blocked: verified vaccination required", actual: `Booking ${r.bookingId} created`, evidence: r.shots });
      saveBooking({ suite: SUITE, bookingId: r.bookingId, service: "boarding", customer: PERSONA, paid: false, total: r.quote?.totalAmount, dueNow: r.quote?.amountDueNow, paymentMode: r.quote?.paymentMode, combo: "unvaccinated (should not exist)" });
    } else if (blocked && !earlyWarning) reportFinding({ severity: "P3", area: "Boarding UX", flow: "/v2/boarding unvaccinated", title: "Vaccination rule only enforced at the final Pay click (BRD-06 — re-verified)", steps: "Select an unvaccinated pet → hosts → care card → review → Pay", expected: "Warn when the pet is selected", actual: `No warning until "${r.confirmAlert}" at the last step`, evidence: r.shots });
    return { result: blocked ? "PASS" : "FAIL" };
  });

  // (7) check-out before check-in → blocked
  await journey("combo-7-checkout-before-checkin", "check-out 1 day before check-in", async (flow) => {
    const s = isoDay(66), e = isoDay(65);
    const r = await runBoarding(flow, { start: s, end: e, startTime: "10:00", endTime: "10:00", pets: ["MasterDog"], meet: false, create: false, pay: false });
    const blocked = r.stage === "plan" && !r.planCtaEnabled && /check-out after check-in/i.test(r.durationSummary);
    record({ suite: SUITE, journey: "combo-7-checkout-before-checkin", combo: "check-out before check-in", result: blocked ? "PASS" : "FAIL", detail: `${s} 10:00 → ${e} 10:00; summary "${r.durationSummary}"; hint "${r.planHint}"; CTA "${r.planCta}" enabled=${r.planCtaEnabled}; quotes sent=${r.quotes.length}`, evidence: r.shots });
    if (!blocked) reportFinding({ severity: "P1", area: "Boarding validation", flow: "/v2/boarding", title: "Check-out before check-in is not blocked", steps: `Check-in ${s}, check-out ${e}`, expected: "CTA disabled with 'Choose a check-out after check-in.'", actual: `CTA "${r.planCta}" enabled=${r.planCtaEnabled}; stage ${r.stage}`, evidence: r.shots });
    return { result: blocked ? "PASS" : "FAIL" };
  });

  // (8) late checkout: 3 nights + 9 hours → billing units (quote only, no booking)
  const p8 = d("c8", 60, 3, "09:00", "18:00");
  await journey("combo-8-late-checkout-3n9h", "3 nights + 9 h · MasterDog · quote only", async (flow) => {
    const r = await runBoarding(flow, { start: p8.start, end: p8.end, startTime: p8.startTime, endTime: p8.endTime, pets: ["MasterDog"], meet: false, create: false, pay: false });
    const pc = priceCheck(r);
    const headline = r.durationSummary;
    const explainsUnits = /4 (stay )?units|4 × |× ?4|4 nights|extra (night|unit)|late checkout/i.test(`${r.bill} ${r.review} ${(r.reviewHints || []).join(" ")}`);
    record({ suite: SUITE, journey: "combo-8-late-checkout-3n9h", combo: "late checkout 3 nights + 9 hours", result: r.quote ? (pc.ok ? "PASS" : "FAIL") : "BLOCKED", detail: `${p8.start} 09:00 → ${p8.end} 18:00 (${r.expected.hours} h) headline "${headline}"; ${pc.text}; bill "${r.bill}"; UI explains extra billing unit=${explainsUnits}`, evidence: r.shots, data: { quote: r.quote, expected: r.expected } });
    if (r.quote && pc.priceOk && !explainsUnits && Number(r.quote.stayUnits) > r.expected.nights) reportFinding({ severity: "OBS", area: "Boarding pricing", flow: "/v2/boarding late checkout", title: `Part-day beyond full 24 h blocks billed as a full unit without saying so (${r.quote.stayUnits} units for "${headline.split(" · ")[0]}") (BRD-09 — re-verified)`, steps: "Plan 3 nights with a 9-hour later checkout → review", expected: "Bill explains the extra unit (e.g. '4 stay units × ₹699' or 'late checkout = 1 extra night')", actual: `Bill "${r.bill}"`, evidence: r.shots });
    return { result: pc.ok ? "PASS" : "FAIL" };
  });

  // Manage page on a paid overnight booking: care plan, extension state, date change, Pet Taxi hand-off
  await journey("manage-overnight-requests", "care plan save · extension state · date change · Add Pet Taxi", async (flow) => {
    const pick = ["combo-3-2n-dog-cat-all-extras", "combo-5-6n-3pets-full", "combo-4-5n-split-deposit"].map(k => created[k]).filter(Boolean);
    const target = pick.find(b => b.paid) || pick[0];
    if (!target) { record({ suite: SUITE, journey: "manage-overnight-requests", combo: "manage page", result: "BLOCKED", detail: "no overnight booking was created earlier in this run", evidence: [] }); return { result: "BLOCKED" }; }
    const id = target.bookingId, { page, context } = flow;
    const shots = [];
    const m = await readManagePage(flow, id, "1-manage-open"); shots.push(m.shot);
    const stayBefore = await boardingStay(context, id);
    // care plan save
    const tag = `Master E2E care update ${STAMP}`;
    await page.getByPlaceholder("Sleep, walks, separation or other care needs").fill(`Loves fetch. ${tag}`);
    const save = page.getByRole("button", { name: /Save canonical care plan/ });
    const CARE_RX = /Care instructions saved\.|Unable to confirm care-plan save|sign-in has expired|was not confirmed|timed out/;
    let careMsg = "";
    for (let attempt = 1; attempt <= 2; attempt++) {
      await robustClick(save);
      await page.getByText(CARE_RX).first().waitFor({ timeout: 20_000 }).catch(() => {});
      await settle(page, 800);
      careMsg = oneLine(await page.getByText(CARE_RX).first().innerText({ timeout: 1500 }).catch(() => ""), 200);
      if (attempt === 1 && /sign-in has expired/.test(careMsg)) { await reauth(context, "care plan save → 401"); continue; }
      break;
    }
    const stayAfterCare = await boardingStay(context, id);
    const careOk = String(stayAfterCare?.carePlan?.plan?.specialInstructions || "").includes(tag);
    shots.push(await flow.shot("2-care-plan-saved"));
    record({ suite: SUITE, journey: "manage-care-plan-save", combo: `booking ${id}`, result: careOk ? "PASS" : "FAIL", detail: `UI "${careMsg}"; API care_plan_status=${stayAfterCare?.care_plan_status} contains tag=${careOk}`, evidence: shots.slice(-1) });
    if (!careOk) reportFinding({ severity: "P1", area: "Boarding manage page", flow: "/v2/boarding/manage care plan", title: "Care plan update not persisted", steps: "Manage → edit Special instructions → Save canonical care plan", expected: "Saved and returned by /api/boarding-stays", actual: `UI "${careMsg}"; API plan: ${oneLine(JSON.stringify(stayAfterCare?.carePlan?.plan || {}), 200)}`, evidence: shots.slice(-1) });
    // extension button state
    const ext = page.getByRole("button", { name: /Request extension|Checking capacity/ });
    const extEnabled = await ext.isEnabled().catch(() => null);
    const status = String(stayAfterCare?.status || stayBefore?.status || "");
    const expectedEnabled = ["confirmed", "in_progress"].includes(status);
    const explains = /after (the )?host accept|once (the )?host|available after/i.test(await mainText(page));
    record({ suite: SUITE, journey: "manage-extension-state", combo: `booking ${id}`, result: extEnabled === expectedEnabled ? "PASS" : "FAIL", detail: `stay status ${status}; "Request extension" enabled=${extEnabled} (expected ${expectedEnabled} — enabled only once the host accepted); disabled state explained=${explains}; extension_status=${stayAfterCare?.extension_status}`, evidence: [shots[0]] });
    if (extEnabled === false && !explains) reportFinding({ severity: "P3", area: "Boarding manage page", flow: "/v2/boarding/manage extension", title: "'Request extension' is disabled with no explanation until the host accepts (BRD-10 — re-verified)", steps: "Open Manage for a paid stay awaiting host acceptance", expected: "Say why extension is unavailable", actual: `Stay ${status}; disabled button, no explanatory text`, evidence: [shots[0]] });
    // date change request (+1 day on both ends, reason)
    const inAt = new Date(new Date(stayAfterCare?.check_in_at || `${p3.start}T10:00:00+05:30`).getTime() + 86_400_000);
    const outAt = new Date(new Date(stayAfterCare?.check_out_at || `${p3.end}T10:00:00+05:30`).getTime() + 86_400_000);
    const local = (dt) => new Date(dt.getTime() + 5.5 * 3600_000).toISOString().slice(0, 16);
    await page.getByLabel("Requested check-in").fill(local(inAt));
    await page.getByLabel("Requested checkout").fill(local(outAt));
    await page.getByPlaceholder("Why do you need to change the stay dates?").fill("Master E2E: flight moved by one day");
    let dc = null, dcBody = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const dcResp = page.waitForResponse(res => res.url().includes("/api/boarding-finance") && res.request().method() === "POST", { timeout: 20_000 }).catch(() => null);
      await robustClick(page.getByRole("button", { name: /Request date change/ }));
      dc = await dcResp;
      dcBody = dc ? await dc.json().catch(() => null) : null;
      if (attempt === 1 && dc?.status() === 401) { await reauth(context, "date change → 401"); await settle(page, 500); continue; }
      break;
    }
    await settle(page, 800);
    const dcMsg = oneLine(await page.getByText(/Date-change request recorded|Unable to request date change/).first().innerText({ timeout: 3000 }).catch(() => ""), 200);
    shots.push(await flow.shot("3-date-change-requested"));
    const dcDb = await d1("SELECT status,requested_start,requested_end,old_total,new_total,amount_delta FROM boarding_date_change_requests WHERE booking_id=? ORDER BY created_at DESC LIMIT 1", [id]);
    const dcOk = dc?.status() < 300 && /recorded/i.test(dcMsg);
    record({ suite: SUITE, journey: "manage-date-change-request", combo: `booking ${id} → ${local(inAt)} / ${local(outAt)}`, result: dcOk ? "PASS" : "FAIL", detail: `POST /api/boarding-finance HTTP ${dc?.status()} ${oneLine(JSON.stringify(dcBody?.data || dcBody?.error || ""), 200)}; UI "${dcMsg}"; d1 ${oneLine(JSON.stringify(dcDb), 250)}`, evidence: shots.slice(-1) });
    if (!dcOk) reportFinding({ severity: "P1", area: "Boarding manage page", flow: "/v2/boarding/manage date change", title: "Date-change request not recorded", steps: "Manage → Change stay dates (+1 day) → reason → Request date change", expected: "Request recorded (commercial quote required)", actual: `HTTP ${dc?.status()} ${oneLine(JSON.stringify(dcBody || ""), 250)}; UI "${dcMsg}"`, evidence: shots.slice(-1) });
    // Add Pet Taxi for this stay → hand-off to the taxi suite
    const taxiLink = page.getByRole("link", { name: /Add Pet Taxi for this stay/ });
    const href = await taxiLink.getAttribute("href").catch(() => null);
    await robustClick(taxiLink);
    await page.waitForURL(/\/v2\/taxi\?sourceBookingId=/, { timeout: 20_000 }).catch(() => {});
    await settle(page, 2000);
    const taxiText = oneLine(await mainText(page), 400);
    shots.push(await flow.shot("4-add-pet-taxi"));
    const taxiOk = page.url().includes(`sourceBookingId=${encodeURIComponent(id)}`);
    const taxiSelected = (await page.locator("[class*=petGrid] button[class*=selected] b").allInnerTexts().catch(() => [])).map(t => oneLine(t, 40));
    const stayPets = target.pets || [];
    const preselectOk = stayPets.length > 0 && stayPets.every(n => taxiSelected.includes(n)) && taxiSelected.every(n => stayPets.includes(n));
    if (taxiOk && taxiSelected.length && !preselectOk) reportFinding({ severity: "P3", area: "Pet Taxi (from Boarding)", flow: "/v2/boarding/manage → Add Pet Taxi for this stay", title: "Pet Taxi opened for a Boarding stay preselects the account's first pet instead of the pets on the stay", steps: `Manage booking ${id} (pets ${stayPets.join(" + ")}) → Add Pet Taxi for this stay`, expected: `${stayPets.join(" + ")} preselected`, actual: `Preselected: ${taxiSelected.join(" + ")} (taxi-flow.tsx selects rows[0] regardless of sourceBookingId)`, evidence: shots.slice(-1) });
    saveBooking({ ...target, run: undefined, result: undefined, suite: SUITE, purpose: "taxi-source", taxiSource: true, forSuite: "taxi", taxiEntry: `/v2/taxi?sourceBookingId=${id}` });
    record({ suite: SUITE, journey: "manage-add-pet-taxi-handoff", combo: `booking ${id}`, result: taxiOk ? "PASS" : "FAIL", detail: `link href ${href}; landed ${page.url().replace(BASE, "")}; taxi preselected pets [${taxiSelected.join(", ")}] vs stay pets [${stayPets.join(", ")}]; page: "${taxiText.slice(0, 200)}"; handed to taxi suite via bookings.jsonl (purpose=taxi-source)`, evidence: shots.slice(-1) });
    return { result: careOk && dcOk && taxiOk ? "PASS" : "PARTIAL" };
  });

  // Cancellation request with reason on the combo-1 booking (staff suite processes the refund)
  await journey("manage-cancellation-request", "cancel combo 1 with reason", async (flow) => {
    const target = created["combo-1-4h-daycare-dog"];
    if (!target) { record({ suite: SUITE, journey: "manage-cancellation-request", combo: "combo 1 cancellation", result: "BLOCKED", detail: "combo 1 booking was not created in this run", evidence: [] }); return { result: "BLOCKED" }; }
    const id = target.bookingId, { page } = flow;
    const m = await readManagePage(flow, id, "1-manage-combo1");
    const reason = "Master E2E: plans changed — please cancel and refund";
    const cancelBtn = page.getByRole("button", { name: /Request cancellation/ });
    const enabledEmpty = await cancelBtn.isEnabled().catch(() => null);
    await page.getByPlaceholder("Why do you need to cancel?").fill(reason);
    let res = null, body = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const resp = page.waitForResponse(r2 => r2.url().includes("/api/boarding-finance") && r2.request().method() === "POST", { timeout: 20_000 }).catch(() => null);
      await robustClick(cancelBtn);
      res = await resp;
      body = res ? await res.json().catch(() => null) : null;
      if (attempt === 1 && res?.status() === 401) { await reauth(flow.context, "cancellation → 401"); await page.getByPlaceholder("Why do you need to cancel?").fill(reason); continue; }
      break;
    }
    await settle(page, 800);
    const msg = oneLine(await page.getByText(/Cancellation request recorded|Unable to request cancellation/).first().innerText({ timeout: 3000 }).catch(() => ""), 200);
    const shot = await flow.shot("2-cancellation-requested");
    const cdb = await d1("SELECT status,reason,approved_refund_amount FROM boarding_cancellation_requests WHERE booking_id=? ORDER BY created_at DESC LIMIT 1", [id]);
    const ok = res?.status() < 300 && /recorded/i.test(msg);
    record({ suite: SUITE, journey: "manage-cancellation-request", combo: `booking ${id} (paid=${target.paid})`, result: ok ? "PASS" : "FAIL", detail: `stay "${m.status}"; button enabled with empty reason=${enabledEmpty}; POST /api/boarding-finance HTTP ${res?.status()} ${oneLine(JSON.stringify(body?.data || body?.error || ""), 200)}; UI "${msg}"; d1 ${oneLine(JSON.stringify(cdb), 250)}`, evidence: [m.shot, shot] });
    if (ok) saveBooking({ ...target, run: undefined, result: undefined, suite: SUITE, cancelRequested: true, cancelReason: reason, cancelStatus: body?.data?.status || null });
    else reportFinding({ severity: "P1", area: "Boarding manage page", flow: "/v2/boarding/manage cancellation", title: "Cancellation request not recorded", steps: "Manage → Cancellation → reason → Request cancellation", expected: "Request recorded (policy review required)", actual: `HTTP ${res?.status()} ${oneLine(JSON.stringify(body || ""), 250)}; UI "${msg}"`, evidence: [m.shot, shot] });
    return { result: ok ? "PASS" : "FAIL" };
  });

  // Showcase: Pixel 7 run of combo 3 with video (slowed down so the recording is watchable)
  const ps = d("show", 67, 2, "10:00", "10:00");
  let showBrowser = null;
  try {
    showBrowser = await launch({ slowMo: 150 });
    await journey("showcase-pixel7-combo-3", "Pixel 7 · 2 nights dog+cat all extras · video", (flow) => comboJourney(flow, { name: "showcase-pixel7-combo-3", combo: "Pixel 7 showcase: 2 nights dog+cat all extras + trial (video)",
      opts: { start: ps.start, end: ps.end, startTime: ps.startTime, endTime: ps.endTime, pets: ["MasterDog", "MasterCat"], needs: ["Medication"], extras: ALL_EXTRAS, food: "Pet food from home", meet: "visit", create: true, pay: true } }), { mobile: true, video: true, useBrowser: showBrowser });
  } catch (e) {
    record({ suite: SUITE, journey: "showcase-pixel7-combo-3", combo: "Pixel 7 showcase", result: "BLOCKED", detail: `harness: ${oneLine(String(e), 300)}`, evidence: [] });
  } finally { await showBrowser?.close().catch(() => {}); }

  // Webhook delivery / ledger truth for every booking that reached Razorpay (read minutes after payment).
  await reconcilePayments();

  summary.sessionReissues = SESSION_EVENTS;
  summary.finishedAt = new Date().toISOString();
  summary.elapsedSec = Math.round((Date.now() - STARTED) / 1000);
  writeJson(`${SUITE}.json`, summary);
  console.log(redact(`[${SUITE}] done in ${summary.elapsedSec}s — ${summary.journeys.map(j => `${j.name}:${j.result ?? "-"}`).join(", ")}`));
}

try { await main(); }
catch (e) { console.error(redact(`[${SUITE}] harness error: ${String(e?.stack || e)}`)); record({ suite: SUITE, journey: "suite", combo: "-", result: "BLOCKED", detail: `harness: ${oneLine(String(e), 500)}`, evidence: [] }); }
finally { await browser?.close().catch(() => {}); }
process.exit(0);
