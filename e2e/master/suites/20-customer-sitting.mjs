// Master suite 20 — V2 Pet Sitting customer journeys (/v2/sitting) as the synthetic customer-a.
//
// Combos (all inside WINDOWS.sitting):
//   c1 1-hour visit · 1 dog                      → PAY (Razorpay TEST) and verify confirmed/captured
//   c2 4-hour visit · 1 cat · M&G phone call     → booking created, left unpaid
//   c3 10-hour day 09:00–19:00 · 1 dog · M&G visit → booking created, left unpaid; exact quote recorded (revenue-leak check)
//   c4 overnight 1 night · dog + cat · M&G house visit (₹499 separate) → PAY
//   c5 3 nights · 3 pets · M&G phone call        → booking created, left unpaid
//   c6 5 nights · split 50/50 · M&G visit waived → PAY the 50 % deposit
//   c7 missing / blank home access               → Care Card validation, no booking
//   c8 Boarding ↔ Sitting mode switch            → state reset, URL / hero-tab behaviour
// Then: booking page + manage page for paid bookings, date-change request (c4), cancellation request (c6),
// unpaid manage page (c2), Meet & Greet request rows (d1: meet_greet_requests) and a customer-b privacy probe.
//
// Rules under test: sitting-visit-60 ₹399 + ₹149 per extra pet for any window ≤ 10 h (1 unit);
// sitting-overnight ₹799/night + ₹399 per extra pet per night; split 50/50 only for overnight > 4 nights;
// Meet & Greet house visit ₹499 paid separately, waived for ≥ 5 nights; phone call free; home access,
// vet and emergency contact required in the Care Card.
//
// Local iteration aids (never set on staging): MASTER_SIT_ONLY=c1,c7,m (journey-key prefixes),
// MASTER_SIT_REUSE=c4=PS-…,c6=PS-… (reuse existing bookings for the post-booking journeys),
// MASTER_SIT_SHIFT=<0..3> (date shift inside the window; default rotates hourly so reruns do not collide).
import {
  BASE, launch, newFlow, settle, customerSession, dismissCookies, api, d1, payRazorpayTestNetbanking,
  record, finding, saveBooking, isoDay, WINDOWS, writeJson,
} from "../lib.mjs";

const SUITE = "20-customer-sitting";
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE);
const SUITE_STARTED = Date.now();
const ONLY = String(process.env.MASTER_SIT_ONLY || "").split(",").map(s => s.trim()).filter(Boolean);
const wanted = key => !ONLY.length || ONLY.some(prefix => key.startsWith(prefix));
const REPRO = LOCAL ? "REPRODUCED-LOCALLY" : "CONFIRMED-ON-STAGING";
const NOT_REPRO = LOCAL ? "NOT-REPRODUCED-LOCALLY" : "NOT-REPRODUCED-ON-STAGING";
const REUSE = Object.fromEntries(String(process.env.MASTER_SIT_REUSE || "").split(",").map(s => s.trim().split("=")).filter(p => p.length === 2 && p[1]));

const [W0, W1] = WINDOWS.sitting;
const SHIFT_RAW = Number(process.env.MASTER_SIT_SHIFT);
const SHIFT = Number.isInteger(SHIFT_RAW) && SHIFT_RAW >= 0 && SHIFT_RAW <= 3 ? SHIFT_RAW : Math.floor(Date.now() / 3_600_000) % 4;
const day = n => { const offset = W0 + SHIFT + n; if (offset > W1) throw new Error(`date offset ${offset} outside sitting window`); return isoDay(offset); };

const PRICE = { visitBase: 399, visitExtra: 149, nightBase: 799, nightExtra: 399, meetVisit: 499 };
const CARE = {
  "Food and water routine": "Master E2E: two meals, 8am and 7pm; fresh water always",
  "Medication and allergy instructions from your vet": "No medication. No known allergies.",
  "Vet contact": "Dr. Rao (UAT test vet), 9000000001",
  "Emergency contact": "Asha (UAT test contact), 9000000002",
  "Home access instructions": "Master E2E: key with security desk, gate code 4321",
  "Other care instructions": "Loves fetch; keep balcony door closed",
};

const summary = { suite: SUITE, base: BASE, local: LOCAL, shift: SHIFT, startedAt: new Date(SUITE_STARTED).toISOString(), combos: {}, meetGreet: [], findings: [] };
const made = {};                       // combo key → booking facts, consumed by the post-booking journeys
const filed = new Set();
let customerId = "UAT-AUDIT-CUSTOMER-A";
let accountPets = null;

// ---------------------------------------------------------------- small utilities
const j = text => { try { return JSON.parse(text); } catch { return null; } };
const round2 = n => Math.round(n * 100) / 100;
const inr = n => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(n);
const inr2 = n => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(n);
const flat = t => String(t || "").replace(/\s*\n+\s*/g, " | ").trim();
const istMs = (date, time) => Date.parse(`${date}T${time}:00+05:30`);

function fileFinding(key, row) {
  if (filed.has(key)) return;
  filed.add(key);
  const full = { suite: SUITE, persona: "customer-a", ...row };
  summary.findings.push({ key, severity: row.severity, title: row.title });
  finding(full);
}

/** Expected quote from the published rules (not from the app) so a pricing regression is visible. */
function expectedQuote({ start, startTime, end, endTime, petCount, split }) {
  const hours = (istMs(end, endTime) - istMs(start, startTime)) / 3_600_000;
  const overnight = hours > 10;
  const calendarNights = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);
  const units = overnight ? Math.max(1, Math.ceil(hours / 24)) : 1;
  const perUnit = overnight ? PRICE.nightBase + (petCount - 1) * PRICE.nightExtra : PRICE.visitBase + (petCount - 1) * PRICE.visitExtra;
  const total = units * perUnit;
  const splitEligible = overnight && calendarNights > 4;
  const mode = splitEligible && split !== false ? "split_50_50" : "prepaid";
  const dueNow = mode === "split_50_50" ? round2(total / 2) : total;
  return { hours, overnight, calendarNights, packageCode: overnight ? "sitting-overnight" : "sitting-visit-60", units, total, dueNow, mode, splitEligible, meetFeeWaived: calendarNights >= 5 };
}

/** Records sitting-related API traffic of one flow (request + response, truncated). */
function watchNet(flow) {
  const net = [];
  flow.page.on("response", async res => {
    const url = res.url();
    if (!url.startsWith(BASE) || !/\/api\/(sitting-commercial|uat-scheduling|sitting-bookings|customer-checkout|meet-and-greet|sitting-lifecycle|sitting-finance|boarding-commercial|razorpay-checkout-return)/.test(url)) return;
    const req = res.request();
    let body = ""; try { body = await res.text(); } catch {}
    net.push({ t: Date.now(), method: req.method(), path: url.replace(BASE, "").slice(0, 200), status: res.status(), req: (req.postData() || "").slice(0, 1500), body: body.slice(0, 3000) });
  });
  return net;
}
const quoteCalls = net => net.filter(n => n.path.startsWith("/api/sitting-commercial") && n.method === "POST").map(n => {
  const b = j(n.body); const d = b?.data || {}; const r = j(n.req) || {};
  return { t: n.t, status: n.status, req: r, quoteId: d.quoteId, packageCode: d.packageCode, units: d.billableUnits, base: d.basePricePerPet, extra: d.extraPetPrice, total: d.totalAmount, dueNow: d.amountDueNow, mode: d.paymentMode, petCount: d.petCount, error: b?.error };
});
const sessionLost = flow => flow.log.apiFailures.some(a => a.status === 401 && !a.url.includes("identity-session"));
const EXPIRED = /sign-in has expired|sign_in_required|Sign in to plan care|Please sign in again|verified customer sign-in is required/i;
/** customer-a is a shared synthetic identity: any other sign-in as customer-a supersedes this session (single active
 *  session per subject). When the page reports that, re-issue the session in the same browser context and continue. */
async function reauthIfExpired(flow, texts, where) {
  if (!texts.some(t => EXPIRED.test(String(t || "")))) return false;
  flow.reauths = (flow.reauths || 0) + 1;
  if (flow.reauths > 6) throw new Error(`harness: customer-a session keeps being superseded (${where})`);
  flow.note(`customer-a session superseded at ${where} — re-issuing (${flow.reauths})`);
  await customerSession(flow.context, "customer-a");
  return true;
}

/** Cheap pre-check before steps that remount the flow (mode switch, reload): re-issue customer-a if superseded. */
async function ensureSession(flow) {
  const r = await api(flow.context, "GET", "/api/customer-account");
  if (r.status === 401) await reauthIfExpired(flow, ["sign_in_required"], "pre-check");
}

/** A textarea wrapped by its <label>. getByLabel(exact) cannot be used once it has a value: the accessible name of
 *  a label that wraps a textbox includes the textbox value. */
const labelledTextarea = (page, label) => page.locator("label").filter({ hasText: new RegExp(`^\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) }).locator("textarea").first();

/** Navigate and re-issue the customer-a session if the page says it expired. */
async function gotoWithReauth(flow, path, ready) {
  const { page } = flow;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
    await dismissCookies(page);
    if (ready) await ready(page);
    await settle(page, 800);
    const text = await page.locator("main").innerText().catch(() => "");
    if (!(await reauthIfExpired(flow, [text], path.split("?")[0]))) return;
  }
}

/** Click a submit button; if the result says the session expired, re-issue it and submit again (same idempotency). */
async function submitWithReauth(flow, button, readMessages, doneRe) {
  const { page } = flow;
  let msgs = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    await button.click();
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(700);
      msgs = (await readMessages()).map(flat).filter(Boolean);
      if (msgs.some(m => doneRe.test(m) || EXPIRED.test(m) || /not confirmed|Unable|required|allowed|cannot/i.test(m))) break;
    }
    if (!(await reauthIfExpired(flow, msgs, "form submit"))) break;
  }
  return msgs;
}

// ---------------------------------------------------------------- account and pets
async function loadAccount(context) {
  const r = await api(context, "GET", "/api/customer-account");
  if (r.status !== 200) throw new Error(`GET /api/customer-account → HTTP ${r.status}`);
  return r.body.data;
}

/** Makes sure customer-a has at least two dogs and one cat (creates synthetic ones only if missing). */
async function ensurePets(context) {
  let account = await loadAccount(context);
  const need = { dog: 2, cat: 1 };
  const created = [];
  for (const [species, count] of Object.entries(need)) {
    const have = account.pets.filter(p => p.species === species).length;
    for (let i = have; i < count; i++) {
      const name = species === "cat" ? "Misty" : i === 0 ? "Bruno" : "Rocky";
      const r = await api(context, "POST", "/api/customer-account", { action: "upsert_pet", idempotencyKey: `master-sit-pet-${species}-${i}`, pet: { name, species, breed: species === "cat" ? "Indian Shorthair" : "Labrador Retriever", vaccinationStatus: "verified" } });
      created.push(`${name}/${species}: HTTP ${r.status}`);
    }
  }
  if (created.length) account = await loadAccount(context);
  accountPets = account.pets;
  return { pets: account.pets.map(p => `${p.name}(${p.species})`), created };
}

/** Resolve pet specs ({species, prefer}) to concrete account pets, preferring the seeded names. */
function pickPets(specs) {
  const used = new Set(), out = [];
  const preferred = { dog: ["Bruno", "Rocky"], cat: ["Misty"] };
  for (const spec of specs) {
    const pool = accountPets.filter(p => p.species === spec.species && !used.has(p.id));
    const order = [spec.prefer, ...(preferred[spec.species] || [])].filter(Boolean);
    const pet = order.map(name => pool.find(p => p.name === name)).find(Boolean) || pool.find(p => p.vaccinationStatus === "verified") || pool[0];
    if (!pet) throw new Error(`harness: customer-a has no free ${spec.species} for this combo`);
    used.add(pet.id); out.push(pet);
  }
  return out;
}

// ---------------------------------------------------------------- page helpers
async function openSitting(flow) {
  const { page } = flow;
  for (let attempt = 1; attempt <= 4; attempt++) {
    await page.goto(`${BASE}/v2/sitting`, { waitUntil: "domcontentloaded" });
    await dismissCookies(page);
    await page.getByText("Loading your PawSpace family…").waitFor({ state: "detached", timeout: 25_000 }).catch(() => {});
    const signedOut = await page.getByText("Sign in to plan care.").isVisible().catch(() => false);
    if (!signedOut) {
      await page.getByLabel("Check-in date").waitFor({ timeout: 25_000 });
      await page.getByText("Checking service area…").waitFor({ state: "detached", timeout: 30_000 }).catch(() => {});
      await page.getByText("Loading your pets…").waitFor({ state: "detached", timeout: 25_000 }).catch(() => {});
      await settle(page, 600);
    }
    // Pets / address load once on mount; a superseded session shows up as an alert (or the sign-in card) and needs a reload.
    const texts = signedOut ? ["Sign in to plan care"] : await page.locator("[role=alert]").allInnerTexts().catch(() => []);
    if (!(await reauthIfExpired(flow, texts, "/v2/sitting load"))) return;
  }
}

/** If the saved address is not resolved/serviceable, pick the Indiranagar address through the AddressPicker (Google Places on staging). */
async function ensureServiceAddress(flow) {
  const { page } = flow;
  const cta = page.getByRole("button", { name: /See available sitters|Verify a service address|Select a pet/ });
  const text = await cta.innerText().catch(() => "");
  if (!/Verify a service address/.test(text)) return { changed: false, address: await page.locator("[aria-label='Care location'] p").first().innerText().catch(() => "") };
  flow.note("saved address not serviceable/resolved — choosing Indiranagar through the address picker");
  await page.getByRole("button", { name: "Change Address" }).click();
  const input = page.getByPlaceholder("House / flat, street, area and city");
  await input.fill("100 Feet Road, HAL 2nd Stage, Indiranagar, Bengaluru 560038");
  const suggestion = page.locator("[aria-label='Google address suggestions'] button").first();
  if (await suggestion.waitFor({ timeout: 10_000 }).then(() => true).catch(() => false)) await suggestion.click();
  else await page.getByRole("button", { name: /Verify service address/ }).first().click().catch(() => {});
  await page.getByText("Checking service area…").waitFor({ state: "detached", timeout: 30_000 }).catch(() => {});
  await page.getByRole("button", { name: "Use this address" }).click({ timeout: 20_000 });
  await settle(page, 1000);
  return { changed: true, address: await page.locator("[aria-label='Care location'] p").first().innerText().catch(() => "") };
}

async function setWindow(page, { start, startTime, end, endTime }) {
  await page.getByLabel("Check-in date").fill(start);
  await page.getByLabel("Check-in time").fill(startTime);
  await page.getByLabel("Check-out date").fill(end);
  await page.getByLabel("Check-out time").fill(endTime);
  await settle(page, 500);
}

/** Select exactly the given pets (by their position in the account list, which is the render order). */
async function selectPets(page, pets) {
  const buttons = page.locator("[class*=petList] > button[aria-pressed]");
  await buttons.first().waitFor({ timeout: 20_000 });
  const count = await buttons.count();
  const wantIdx = pets.map(p => accountPets.findIndex(a => a.id === p.id));
  for (const idx of wantIdx) {
    if (idx < 0 || idx >= count) throw new Error("harness: pet button not rendered");
    const b = buttons.nth(idx);
    if (!(await b.innerText()).includes(accountPets[idx].name)) throw new Error(`harness: pet button ${idx} is not ${accountPets[idx].name}`);
    if ((await b.getAttribute("aria-pressed")) !== "true") await b.click();
  }
  for (let i = 0; i < count; i++) {
    if (wantIdx.includes(i)) continue;
    const b = buttons.nth(i);
    if ((await b.getAttribute("aria-pressed")) === "true") await b.click();
  }
  await settle(page, 400);
  return (await page.locator("[class*=petList] > button[aria-pressed=true] b").allInnerTexts());
}

async function fillCare(page, overrides = {}) {
  const values = { ...CARE, ...overrides };
  const filled = {};
  for (const [label, value] of Object.entries(values)) {
    const box = page.getByLabel(label, { exact: true });
    if (await box.count()) { await box.fill(value); filled[label] = value; }
  }
  return filled;
}

async function chooseMeet(page, meet) {
  const box = page.locator("label").filter({ hasText: /sitter Meet & Greet/ }).locator("input[type=checkbox]").first();
  if (!meet) { if (await box.isChecked()) await box.uncheck(); return; }
  if (!(await box.isChecked())) await box.check();
  await page.getByRole("button", { name: meet === "call" ? /10-minute phone call/ : /2-hour home Meet & Greet/ }).click();
}

async function waitForPricedCta(page) {
  const cta = page.getByRole("button", { name: /^Pay .*(request final partner approval|create canonical stay)|Calculating price|Price unavailable|Locking care capacity/ });
  for (let i = 0; i < 30; i++) {
    const text = await cta.innerText().catch(() => "");
    if (text && !/Calculating/.test(text)) return { cta, text };
    await page.waitForTimeout(700);
  }
  return { cta, text: await cta.innerText().catch(() => "?") };
}

/** Drive plan → sitter → care card → review. Returns everything observed; stops before the Pay click. */
async function planToReview(flow, spec, observed) {
  const { page } = flow;
  await openSitting(flow);
  observed.address = await ensureServiceAddress(flow);
  await setWindow(page, spec);
  observed.pets = await selectPets(page, spec.petObjs);
  for (const need of spec.needs || []) await page.getByRole("button", { name: new RegExp(need) }).click();
  await settle(page, 800);
  observed.planSummary = await page.locator("p[role=status],p[role=alert]").allInnerTexts().catch(() => []);
  observed.evidence.push(await flow.shot("plan"));
  const planCta = page.getByRole("button", { name: /See available sitters|Verify a service address|Select a pet/ });
  observed.planCta = await planCta.innerText().catch(() => "?");
  if (!(await planCta.isEnabled().catch(() => false))) { observed.blockedAt = "plan"; return false; }
  await planCta.click();
  await page.getByText("Checking sitter availability…").waitFor({ state: "detached", timeout: 35_000 }).catch(() => {});
  await settle(page, 1500);
  for (let i = 0; i < 3 && await reauthIfExpired(flow, await page.locator("[role=alert]").allInnerTexts(), "sitter search"); i++) {
    await page.getByRole("button", { name: "Retry sitter search" }).click().catch(() => {});
    await page.getByText("Checking sitter availability…").waitFor({ state: "detached", timeout: 35_000 }).catch(() => {});
    await settle(page, 1500);
  }
  const cards = page.locator("[class*=caregivers] > button");
  observed.sitters = (await cards.allInnerTexts()).map(flat);
  observed.sitterAlerts = await page.locator("[role=alert]").allInnerTexts();
  observed.sitterPriceLabels = observed.sitters.map(t => (t.match(/₹[\d,]+(?:\.\d+)?\s*(?:\|\s*)?\/\s*[a-z ]+/i) || [""])[0].replace(/\s*\|\s*/g, " "));
  observed.evidence.push(await flow.shot("sitters"));
  const cont = page.getByRole("button", { name: /Continue with|Choose an available caregiver/ });
  observed.sitterCta = await cont.innerText().catch(() => "?");
  if (!(await cont.isEnabled().catch(() => false))) { observed.blockedAt = "sitter"; return false; }
  observed.sitter = observed.sitterCta.replace(/^Continue with\s*/, "");
  await cont.click();
  await settle(page, 700);
  observed.care = await fillCare(page, spec.care || {});
  await chooseMeet(page, spec.meet);
  await settle(page, 400);
  observed.meetOptions = flat(await page.locator("[class*=options]").first().innerText().catch(() => ""));
  observed.evidence.push(await flow.shot("care-card"));
  await page.getByRole("button", { name: "Review protected booking" }).click();
  await settle(page, 1200);
  if (spec.split === true) await page.getByRole("button", { name: /Reserve with 50% now/ }).click().catch(() => {});
  if (spec.split === false) await page.getByRole("button", { name: /Pay the full amount now/ }).click().catch(() => {});
  await settle(page, 800);
  const { text: ctaText } = await waitForPricedCta(page);
  observed.review = flat(await page.locator("[aria-label='Review stay details']").innerText().catch(() => ""));
  observed.bill = flat(await page.locator("[class*=bill]").first().innerText().catch(() => ""));
  observed.payChoice = flat(await page.locator("[class*=paymentChoice],[class*=fullPaymentNote]").first().innerText().catch(() => ""));
  observed.hints = (await page.locator("p[class*=hint]").allInnerTexts().catch(() => [])).map(flat);
  if (spec.agree !== false) await page.getByLabel(/I agree to care/).check();
  let priced = await waitForPricedCta(page);
  for (let i = 0; i < 2 && /Price unavailable/.test(priced.text); i++) {
    const alerts = await page.locator("[role=alert]").allInnerTexts().catch(() => []);
    if (!(await reauthIfExpired(flow, alerts, "review price"))) break;
    await page.getByRole("button", { name: "Retry price" }).click().catch(() => {});
    priced = await waitForPricedCta(page);
  }
  observed.reviewCta = priced.text;
  observed.reviewCtaEnabled = await priced.cta.isEnabled().catch(() => false);
  observed.evidence.push(await flow.shot("review"));
  return true;
}

/** Click the review CTA and wait for the payment gate (or an alert). */
async function confirmBooking(flow, net, observed) {
  const { page } = flow;
  const cta = page.getByRole("button", { name: /^Pay .*request final partner approval/ });
  const mark = net.length;
  const paymentPage = page.locator("[aria-label='Pet Sitting payment']");
  for (let attempt = 1; attempt <= 4; attempt++) {
    observed.confirmAlerts = null;
    const attemptMark = net.length;
    await cta.click();
    await page.getByText("Locking care capacity…").waitFor({ state: "detached", timeout: 60_000 }).catch(() => {});
    for (let i = 0; i < 40; i++) {
      if (await paymentPage.isVisible().catch(() => false)) break;
      const alerts = (await page.locator("[role=alert]").allInnerTexts().catch(() => [])).filter(Boolean);
      if (alerts.length && !(await page.getByText("Saving care instructions for this booking…").isVisible().catch(() => false))) { observed.confirmAlerts = alerts; break; }
      await page.waitForTimeout(750);
    }
    if (await paymentPage.isVisible().catch(() => false)) break;
    // The care-plan save gate (booking already created) has its own retry button; reserve/create errors leave the review CTA.
    const alerts = observed.confirmAlerts || [];
    // The review screen masks a 401 from the scheduler as "We could not reserve this slot…", so read the response too.
    const expired401 = net.slice(attemptMark).find(n => n.status === 401 && /sign_in_required/.test(n.body));
    if (expired401 && alerts.length && !alerts.some(a => EXPIRED.test(a))) {
      const shot = await flow.shot("expired-session-shown-as-slot-error");
      observed.evidence.push(shot);
      fileFinding("expired-session-masked", { severity: "P2", area: "Pet Sitting review", flow: flow.name, title: "An expired sign-in during 'Pay & request final partner approval' is shown as 'We could not reserve this slot' (customer is told to pick another time)", steps: "Review a Sitting booking; the customer session is replaced (another sign-in as the same customer, single active session per customer); press Pay & request final partner approval", expected: "Ask the customer to sign in again and keep the chosen slot", actual: `${expired401.path.split("?")[0]} answered HTTP 401 sign_in_required; the review shows "${alerts.join(" / ")}"`, evidence: [shot] });
    }
    if (!(await reauthIfExpired(flow, expired401 ? [...alerts, "sign_in_required"] : alerts, "confirm"))) break;
    const retryCare = page.getByRole("button", { name: "Retry saving care instructions" });
    if (await retryCare.isVisible().catch(() => false)) { await retryCare.click(); await paymentPage.waitFor({ timeout: 30_000 }).catch(() => {}); if (await paymentPage.isVisible().catch(() => false)) break; }
    if (!(await cta.isVisible().catch(() => false))) break;
  }
  const after = net.slice(mark);
  const bookingPosts = after.filter(n => n.path.startsWith("/api/sitting-bookings") && n.method === "POST");
  const bookingCall = bookingPosts.filter(n => n.status < 300).at(-1) || bookingPosts.at(-1);
  observed.bookingPostStatuses = bookingPosts.map(n => n.status);
  observed.bookingCall = bookingCall ? { status: bookingCall.status, body: bookingCall.body.slice(0, 400) } : null;
  observed.reserveCalls = after.filter(n => n.path.startsWith("/api/uat-scheduling") && !/"preview"/.test(n.req)).map(n => ({ status: n.status, body: n.body.slice(0, 300) }));
  observed.governedQuote = quoteCalls(after).filter(q => q.status < 300).at(-1) || null;
  observed.meetGreetCalls = net.filter(n => n.path.startsWith("/api/meet-and-greet")).map(n => `${n.method} ${n.status}`);
  const bid = j(bookingCall?.body)?.data?.bookingId;
  observed.bookingId = bid || (flat(await page.locator("main").innerText().catch(() => "")).match(/PS-UAT-SIT-[A-Z0-9-]+/) || [null])[0];
  observed.paymentPageVisible = await paymentPage.isVisible().catch(() => false);
  if (observed.paymentPageVisible) {
    observed.paymentPage = flat(await paymentPage.innerText());
    observed.paymentPageShowsBookingRef = Boolean(observed.bookingId && observed.paymentPage.includes(observed.bookingId));
  }
  observed.evidence.push(await flow.shot(observed.paymentPageVisible ? "payment-page" : "after-confirm"));
  return Boolean(observed.bookingId);
}

/** Read the booking back through the customer checkout status API (same projection the V2 booking page uses). */
async function bookingStatus(context, bookingId, persona = "customer-a") {
  let r = await api(context, "POST", "/api/customer-checkout", { action: "status", bookingId });
  if (r.status === 401) { await customerSession(context, persona); r = await api(context, "POST", "/api/customer-checkout", { action: "status", bookingId }); }
  const d = r.body?.data || {};
  const c = d.confirmation || {};
  return { http: r.status, status: d.status, ready: c.ready, bookingStatus: c.bookingStatus, paymentStatus: c.paymentStatus, paymentMode: c.paymentMode, amountDueNow: c.amountDueNow, totalAmount: c.totalAmount, providerId: c.providerId, providerName: c.providerName, packageCode: c.packageCode, scheduledStart: c.scheduledStart, scheduledEnd: c.scheduledEnd, transactionId: c.transactionId, workOrderStatus: c.workOrderStatus, error: r.body?.error };
}

async function d1Booking(bookingId) {
  const rows = await d1("SELECT b.id, b.status AS booking_status, b.package_code, b.total_amount, b.provider_id, b.scheduled_start, b.scheduled_end, p.status AS payment_status, p.mode AS payment_mode, p.amount AS payment_amount, p.amount_due_now, w.status AS work_order_status FROM canonical_bookings b JOIN booking_payments p ON p.booking_id = b.id LEFT JOIN provider_work_orders w ON w.booking_id = b.id WHERE b.id = ?", [bookingId]);
  const events = await d1("SELECT event_type, processing_status, signature_verified, amount_subunits, environment, gateway_payment_id IS NOT NULL AS has_payment_id FROM payment_gateway_events WHERE booking_id = ? ORDER BY received_at", [bookingId]);
  return { rows, events };
}

/** Pay the amount due through the real Razorpay TEST checkout and wait (≤ 60 s) until the app shows it verified. */
async function payAndVerify(flow, observed, spec) {
  const { page, context } = flow;
  const pay = { clicked: false };
  const payBtn = page.getByRole("button", { name: /Pay securely/ });
  pay.button = await payBtn.innerText().catch(() => "?");
  pay.buttonMatchesDueNow = pay.button.includes(inr2(spec.expected.dueNow));
  let razorpayOpened = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    pay.error = null;
    await payBtn.click();
    pay.clicked = true;
    // Wait for either the Razorpay iframe or an error.
    for (let i = 0; i < 40; i++) {
      if (page.frames().some(f => /razorpay/i.test(f.url()))) { razorpayOpened = true; break; }
      const alerts = (await page.locator("[aria-label='Pet Sitting payment'] [role=alert]").allInnerTexts().catch(() => [])).filter(Boolean);
      if (alerts.length) { pay.error = alerts.join(" / "); break; }
      await page.waitForTimeout(500);
    }
    if (razorpayOpened || !(await reauthIfExpired(flow, [pay.error], "payment start"))) break;
  }
  pay.razorpayOpened = razorpayOpened;
  if (!razorpayOpened) {
    pay.evidence = await flow.shot("payment-not-opened");
    pay.outcome = /not configured/i.test(pay.error || "") ? "gateway-not-configured" : "checkout-not-opened";
    return pay;
  }
  await page.waitForTimeout(1500);
  pay.razorpayShot = await flow.shot("razorpay-checkout");
  const rz = await payRazorpayTestNetbanking(page);
  pay.razorpay = rz;
  if (!rz.ok) { pay.outcome = "razorpay-not-completed"; pay.evidence = await flow.shot("razorpay-stuck"); return pay; }
  // Poll UI + API for verification.
  const deadline = Date.now() + 60_000;
  let ui = null, st = null;
  while (Date.now() < deadline) {
    await page.waitForTimeout(3000);
    if (await page.getByRole("heading", { name: "Your sitting booking" }).isVisible().catch(() => false)) ui = "sitting-panel";
    else if (await page.getByRole("heading", { name: /booking is confirmed/i }).isVisible().catch(() => false)) ui = "confirmation-page (redirect return)";
    else if (/Status:\s*confirmed/i.test(await page.locator("main").innerText().catch(() => ""))) ui = "booking-page";
    const check = page.getByRole("button", { name: /Check payment status|Retry booking confirmation/ });
    if (!ui && await check.isVisible().catch(() => false) && await check.isEnabled().catch(() => false)) await check.click().catch(() => {});
    st = await bookingStatus(context, observed.bookingId);
    if (st.http === 401) { await reauthIfExpired(flow, [st.error || "sign_in_required"], "payment status poll"); continue; }
    if (st.status === "captured" && st.ready && ui) break;
  }
  pay.ui = ui; pay.status = st;
  pay.statusMessages = (await page.locator("[role=status],[role=alert]").allInnerTexts().catch(() => [])).map(flat).filter(Boolean).slice(0, 6);
  pay.outcome = st?.status === "captured" && st?.ready ? (ui ? "captured" : "captured-api-only") : "not-verified";
  pay.evidence = await flow.shot(`after-payment-${pay.outcome}`);
  if (ui === "sitting-panel") {
    await page.getByText("Loading saved booking and care updates…").waitFor({ state: "detached", timeout: 20_000 }).catch(() => {});
    const panel = page.locator("section[aria-label='Your sitting booking']");
    pay.panel = flat(await panel.innerText().catch(() => "")).slice(0, 900);
    pay.panelHomeAccess = await labelledTextarea(page, "Home access instructions").inputValue().catch(() => null);
    pay.panelShot = await flow.shot("sitting-customer-panel");
  }
  return pay;
}

async function meetGreetRows(sinceMs) {
  return d1("SELECT id, host_provider_id, format, intended_stay_days, price_charged, price_waived_reason, status, created_at FROM meet_greet_requests WHERE customer_id = ? AND created_at >= ? ORDER BY created_at", [customerId, sinceMs]);
}

// ---------------------------------------------------------------- combo journeys
const COMBOS = [
  { key: "c1", journey: "sit-c1-visit-1h-dog", combo: "1-hour visit · 1 dog · no Meet & Greet · pay in full", start: day(1), startTime: "10:00", end: day(1), endTime: "11:00", pets: [{ species: "dog" }], meet: false, pay: true },
  { key: "c2", journey: "sit-c2-visit-4h-cat", combo: "4-hour visit · 1 cat · M&G phone call (free) · left unpaid", start: day(2), startTime: "09:00", end: day(2), endTime: "13:00", pets: [{ species: "cat" }], meet: "call", pay: false },
  { key: "c3", journey: "sit-c3-day-10h-dog", combo: "10-hour day 09:00–19:00 · 1 dog · M&G house visit · left unpaid (revenue-leak check)", start: day(3), startTime: "09:00", end: day(3), endTime: "19:00", pets: [{ species: "dog" }], meet: "visit", pay: false },
  { key: "c4", journey: "sit-c4-overnight-1n-dog-cat-mg-visit", combo: "Overnight 1 night 19:00→09:00 · dog + cat · Medication need · M&G house visit ₹499 separate · pay in full", start: day(5), startTime: "19:00", end: day(6), endTime: "09:00", pets: [{ species: "dog" }, { species: "cat" }], needs: ["Medication"], meet: "visit", pay: true, video: true },
  { key: "c5", journey: "sit-c5-3n-3pets-mg-call", combo: "3 nights · 3 pets (2 dogs + cat) · M&G phone call · left unpaid", start: day(7), startTime: "10:00", end: day(10), endTime: "10:00", pets: [{ species: "dog" }, { species: "cat" }, { species: "dog" }], needs: ["Two daily walks"], meet: "call", pay: false },
  { key: "c6", journey: "sit-c6-5n-split-deposit", combo: "5 nights · 1 dog · split 50/50 · M&G house visit (waived ≥5 nights) · pay the 50% deposit", start: day(12), startTime: "10:00", end: day(17), endTime: "10:00", pets: [{ species: "dog", prefer: "Rocky" }], meet: "visit", split: true, pay: true },
];

async function runCombo(browser, spec, attempt = 1) {
  const name = attempt > 1 ? `${spec.journey}-retry${attempt}` : spec.journey;
  const flow = await newFlow(browser, name, { video: Boolean(spec.video) && attempt === 1 });
  const net = watchNet(flow);
  const observed = { evidence: [] };
  const t0 = Date.now();
  let bookingSaved = false;
  const save = paid => {
    if (bookingSaved || !observed.bookingId) return;
    bookingSaved = true;
    saveBooking({ suite: SUITE, bookingId: observed.bookingId, service: "pet_sitting", packageCode: observed.governedQuote?.packageCode || spec.expected.packageCode, providerId: observed.status?.providerId || null, providerName: observed.status?.providerName || observed.sitter || null, customer: "customer-a", scheduledStart: new Date(istMs(spec.start, spec.startTime)).toISOString(), scheduledEnd: new Date(istMs(spec.end, spec.endTime)).toISOString(), total: observed.governedQuote?.total ?? spec.expected.total, dueNow: observed.governedQuote?.dueNow ?? spec.expected.dueNow, paid, paymentMode: observed.governedQuote?.mode || spec.expected.mode, pets: observed.pets, combo: spec.key, meetGreet: spec.meet || "none" });
  };
  try {
    const who = await customerSession(flow.context, "customer-a");
    customerId = who?.customerId || customerId;
    if (!accountPets) observed.petsSetup = await ensurePets(flow.context);
    spec.petObjs = pickPets(spec.pets);
    spec.expected = expectedQuote({ ...spec, petCount: spec.petObjs.length });
    flow.note(`${spec.key}: ${spec.start} ${spec.startTime} → ${spec.end} ${spec.endTime} pets=${spec.petObjs.map(p => p.name).join("+")} expected ${JSON.stringify(spec.expected)}`);
    const reached = await planToReview(flow, spec, observed);
    observed.reviewQuote = quoteCalls(net).filter(q => q.status < 300).at(-1) || null;
    if (!reached) {
      if (sessionLost(flow) && attempt < 3) { await flow.close(); return runCombo(browser, spec, attempt + 1); }
      const why = observed.blockedAt === "sitter" ? `no sitter offered: ${observed.sitterAlerts.join(" / ") || observed.sitterCta}` : `plan CTA disabled: ${observed.planCta}`;
      record({ suite: SUITE, journey: spec.journey, combo: spec.combo, result: "BLOCKED", detail: `${why}; window ${spec.start} ${spec.startTime}→${spec.end} ${spec.endTime}; plan summary ${observed.planSummary?.join(" / ")}`, evidence: observed.evidence });
      return;
    }
    // ---- price assertions (review screen + quote API)
    const exp = spec.expected, q = observed.reviewQuote || {};
    const checks = [];
    const ck = (ok, label) => checks.push({ ok: Boolean(ok), label });
    ck(q.packageCode === exp.packageCode, `package ${q.packageCode} (expected ${exp.packageCode})`);
    ck(q.units === exp.units, `units ${q.units} (expected ${exp.units})`);
    ck(q.total === exp.total, `quote total ${q.total} (expected ${exp.total})`);
    ck(q.dueNow === exp.dueNow, `due now ${q.dueNow} (expected ${exp.dueNow})`);
    ck(q.mode === exp.mode, `payment mode ${q.mode} (expected ${exp.mode})`);
    ck(observed.bill.includes(`Booking total | ${inr(exp.total)}`), `bill shows Booking total ${inr(exp.total)}`);
    ck(observed.reviewCta.includes(`Pay ${inr(exp.dueNow)}`), `CTA "${observed.reviewCta}" asks for ${inr(exp.dueNow)}`);
    if (spec.meet === "visit") {
      ck(/Meet & Greet \| ₹499/.test(observed.bill), "bill lists the ₹499 house-visit Meet & Greet");
      ck(/paid separately/.test(observed.bill), "bill marks the Meet & Greet as paid separately");
      ck(exp.meetFeeWaived ? /waived/.test(observed.bill) : !/waived/.test(observed.bill), exp.meetFeeWaived ? "M&G shown as waived (≥5 nights)" : "M&G not waived (<5 nights)");
    }
    if (spec.meet === "call") ck(/confidence call \| Included/.test(observed.bill), "phone call shown as Included");
    if (exp.splitEligible) ck(/Reserve with 50% now/.test(observed.payChoice), "split choice offered (> 4 nights)");
    else ck(!/Reserve with 50% now/.test(observed.payChoice), "no split offered (≤ 4 nights / hourly)");
    observed.checks = checks;
    let priceOk = checks.every(c => c.ok);
    // ---- create the booking
    const created = await confirmBooking(flow, net, observed);
    if (!created) {
      if (sessionLost(flow) && attempt < 3) { await flow.close(); return runCombo(browser, spec, attempt + 1); }
      record({ suite: SUITE, journey: spec.journey, combo: spec.combo, result: "FAIL", detail: `booking not created. alerts=${JSON.stringify(observed.confirmAlerts || [])} reserve=${JSON.stringify(observed.reserveCalls)} booking=${JSON.stringify(observed.bookingCall)} | price checks: ${checks.map(c => `${c.ok ? "ok" : "MISMATCH"} ${c.label}`).join("; ")}`, evidence: observed.evidence });
      return;
    }
    observed.governed = observed.governedQuote;
    observed.status = await bookingStatus(flow.context, observed.bookingId);
    ck(observed.status.totalAmount === exp.total, `server booking total ${observed.status.totalAmount} (expected ${exp.total})`);
    priceOk = checks.every(c => c.ok);
    // ---- pay (combos 1, 4, 6)
    let result, payDetail = "";
    if (spec.pay && observed.paymentPageVisible) {
      if (sessionLost(flow)) { await customerSession(flow.context, "customer-a"); flow.note("session was superseded after booking creation — re-issued before paying"); }
      const pay = await payAndVerify(flow, observed, spec);
      observed.pay = pay;
      for (const e of [pay.razorpayShot, pay.evidence, pay.panelShot]) if (e) observed.evidence.push(e);
      const dbv = await d1Booking(observed.bookingId);
      observed.d1 = dbv;
      const d1Row = Array.isArray(dbv.rows) ? dbv.rows[0] : null;
      const captureEvents = Array.isArray(dbv.events) ? dbv.events.filter(e => /captured|order\.paid|payment_link\.paid/.test(e.event_type) && e.processing_status === "processed") : null;
      const d1Text = Array.isArray(dbv.rows) ? `d1 booking=${d1Row?.booking_status}/payment=${d1Row?.payment_status}/workOrder=${d1Row?.work_order_status} captureEvents=${JSON.stringify(captureEvents)}` : `d1 ${JSON.stringify(dbv.rows).slice(0, 160)}`;
      if (pay.outcome === "gateway-not-configured") {
        result = LOCAL ? "ENV-GATED" : "FAIL";
        payDetail = `Pay securely → "${pay.error}"${LOCAL ? " (local mirror has no Razorpay keys)" : ""}`;
        if (!LOCAL) fileFinding("rzp-not-configured", { severity: "P1", area: "Payments", flow: spec.journey, title: "Razorpay TEST checkout does not open for Pet Sitting on staging", steps: `Sitting booking ${observed.bookingId} → payment page → Pay securely`, expected: "Razorpay TEST checkout opens", actual: pay.error, evidence: observed.evidence });
      } else if (pay.outcome === "captured" || pay.outcome === "captured-api-only") {
        const amountOk = captureEvents === null ? null : captureEvents.some(e => Number(e.amount_subunits) === Math.round(exp.dueNow * 100));
        const d1Ok = d1Row ? d1Row.payment_status === "captured" && ["confirmed", "assigned"].includes(d1Row.booking_status) : null;
        result = pay.outcome === "captured" && d1Ok !== false && amountOk !== false && priceOk ? "PASS" : "PARTIAL";
        payDetail = `PAID ${inr2(exp.dueNow)} via Razorpay TEST netbanking; UI=${pay.ui || "no confirmation UI"}; api status=${pay.status?.status} ready=${pay.status?.ready} booking=${pay.status?.bookingStatus} payment=${pay.status?.paymentStatus} dueNow=${pay.status?.amountDueNow} txn=${pay.status?.transactionId ? "yes" : "no"}; ${d1Text}; captured amount matches due-now: ${amountOk}`;
        if (pay.panel) payDetail += `; in-flow panel: ${pay.panel.slice(0, 260)}; care plan home access persisted: ${pay.panelHomeAccess === CARE["Home access instructions"]}`;
      } else {
        result = "FAIL";
        payDetail = `payment not verified within 60 s: outcome=${pay.outcome} razorpay=${JSON.stringify(pay.razorpay || {})} api=${JSON.stringify(pay.status || {})} messages=${JSON.stringify(pay.statusMessages || [])} ${d1Text}`;
        fileFinding(`pay-not-verified-${spec.key}`, { severity: "P1", area: "Payments", flow: spec.journey, title: `Pet Sitting payment not shown as verified after Razorpay TEST success (${spec.key})`, steps: `Book ${spec.combo}; Pay securely; Razorpay netbanking test bank → Success; wait 60 s`, expected: "Booking confirmed and payment captured in UI, API and D1", actual: payDetail, evidence: observed.evidence });
      }
      save(pay.outcome === "captured" || pay.outcome === "captured-api-only");
    } else {
      save(false);
      const st = observed.status;
      result = priceOk && observed.paymentPageVisible && st.http === 200 ? "PASS" : "PARTIAL";
      payDetail = `booking left unpaid by design: api booking=${st.bookingStatus} payment=${st.paymentStatus} total=${st.totalAmount} dueNow=${st.amountDueNow}`;
    }
    made[spec.key] = { bookingId: observed.bookingId, paid: observed.pay?.outcome?.startsWith("captured") || false, expected: exp, spec, status: observed.status, pay: observed.pay || null, sitter: observed.sitter };
    // ---- Meet & Greet persistence
    if (spec.meet) {
      const rows = await meetGreetRows(t0 - 60_000);
      summary.meetGreet.push({ combo: spec.key, format: spec.meet, bookingId: observed.bookingId, apiCalls: observed.meetGreetCalls, d1: rows, evidence: observed.evidence.at(-1) });
    }
    if (spec.key === "c3") await c3PricingBoundary(flow, net, observed);
    if (!priceOk) result = "FAIL";
    const ruleMiss = checks.filter(c => !c.ok && /^(package|units|quote total|due now|payment mode)/.test(c.label));
    if (ruleMiss.length) fileFinding(`rule-mismatch-${spec.key}`, { severity: "P1", area: "Pet Sitting pricing", flow: spec.journey, title: `Sitting quote differs from the published pricing rule (${spec.key}: ${ruleMiss.map(c => c.label).join("; ")})`, steps: `/v2/sitting → ${spec.combo}`, expected: `${exp.packageCode} × ${exp.units} = ${inr(exp.total)}, due now ${inr(exp.dueNow)} (${exp.mode})`, actual: JSON.stringify(q), evidence: observed.evidence.filter(e => /review/.test(e)) });
    if (q.total != null && observed.status?.totalAmount != null && q.total !== observed.status.totalAmount) fileFinding(`server-total-differs-${spec.key}`, { severity: "P0", area: "Pet Sitting pricing", flow: spec.journey, title: `Booking total saved on the server differs from the price shown at review (${spec.key})`, steps: `/v2/sitting → ${spec.combo} → Pay & request final partner approval`, expected: `server total ${q.total}`, actual: `server total ${observed.status.totalAmount} for ${observed.bookingId}`, evidence: observed.evidence });
    const priceText = `quote ${q.packageCode} units=${q.units} base=${q.base} extra=${q.extra} total=${q.total} dueNow=${q.dueNow} mode=${q.mode} (expected ${exp.packageCode} ×${exp.units} = ${exp.total}, due ${exp.dueNow})`;
    record({ suite: SUITE, journey: spec.journey, combo: spec.combo, result, detail: `booking ${observed.bookingId} with ${observed.sitter}; window ${spec.start} ${spec.startTime}→${spec.end} ${spec.endTime}; pets ${observed.pets.join("+")}; ${priceText}; bill: ${observed.bill}; CTA "${observed.reviewCta}"; sitter card price labels ${JSON.stringify([...new Set(observed.sitterPriceLabels)])}; checks: ${checks.map(c => `${c.ok ? "ok" : "MISMATCH"} ${c.label}`).join("; ")}; reserve calls ${observed.reserveCalls.length} / booking POST statuses ${JSON.stringify(observed.bookingPostStatuses)}${flow.reauths ? ` (customer-a session re-issued ${flow.reauths}× after being superseded)` : ""}; payment page shows booking ref: ${observed.paymentPageShowsBookingRef} (PAY-04 ${observed.paymentPageShowsBookingRef === false ? REPRO : NOT_REPRO})${exp.splitEligible ? `; one-decimal rupees on review (BRD-05): ${/₹[\d,]+\.\d(?!\d)/.test(`${observed.payChoice} ${observed.reviewCta}`) ? REPRO : NOT_REPRO}` : ""}; ${payDetail}`, evidence: observed.evidence });
    summary.combos[spec.key] = { result, bookingId: observed.bookingId, quote: q, expected: exp, bill: observed.bill, cta: observed.reviewCta, sitters: observed.sitters, pay: observed.pay ? { outcome: observed.pay.outcome, ui: observed.pay.ui, status: observed.pay.status } : null, d1: observed.d1 || null, meetGreetCalls: observed.meetGreetCalls };
    // ---- product findings driven by what this combo showed
    const perVisitLabel = observed.sitterPriceLabels.find(l => /\/\s*night/i.test(l));
    if (!exp.overnight && perVisitLabel) fileFinding("visit-card-per-night", { severity: "P2", area: "Pet Sitting pricing display", flow: spec.journey, title: `Sitter cards price an hourly home visit as "${perVisitLabel.trim()}"`, steps: `/v2/sitting → ${spec.start} ${spec.startTime}–${spec.endTime} (${exp.hours} h visit) → See available sitters`, expected: "Visit price labelled per visit (₹399 / visit), matching the sitting-visit-60 quote", actual: `Every sitter card reads "${perVisitLabel.trim()}" although the quote is sitting-visit-60 (${q.units} unit) and the stay is ${exp.hours} h`, evidence: observed.evidence.filter(e => /sitters/.test(e)) });
    if (observed.paymentPageVisible && observed.paymentPageShowsBookingRef === false) fileFinding("payment-page-no-ref", { severity: "P2", area: "Payment page", flow: spec.journey, title: "Sitting payment page shows no booking reference while payment is pending (re-verifies PAWSPACE PAY-04)", steps: `Book ${spec.combo} → payment page`, expected: "Booking reference visible so the customer can find/recover the booking", actual: `Booking ${observed.bookingId} was created but the payment page text is: ${observed.paymentPage.slice(0, 300)}`, evidence: observed.evidence.filter(e => /payment-page/.test(e)) });
    if (exp.splitEligible && /₹[\d,]+\.\d(?!\d)/.test(`${observed.payChoice} ${observed.reviewCta}`)) fileFinding("one-decimal-rupees", { severity: "P3", area: "Pet Sitting pricing display", flow: spec.journey, title: "Split amounts shown with one decimal on the Sitting review (re-verifies BRD-05)", steps: `Book ${spec.combo} → review`, expected: `${inr2(exp.dueNow)}`, actual: `"${observed.reviewCta}" · "${observed.payChoice.slice(0, 160)}"`, evidence: observed.evidence.filter(e => /review/.test(e)) });
  } catch (e) {
    const shot = await flow.shot("error").catch(() => null);
    if (shot) observed.evidence.push(shot);
    const harness = /harness|Timeout|locator|waiting for/i.test(String(e));
    save(false);
    record({ suite: SUITE, journey: spec.journey, combo: spec.combo, result: harness ? "BLOCKED" : "FAIL", detail: `${harness ? "harness: " : ""}${String(e).slice(0, 400)}; booking=${observed.bookingId || "none"}; api failures=${JSON.stringify(flow.log.apiFailures.filter(a => !a.url.includes("identity-session")).slice(-3))}`, evidence: observed.evidence });
  } finally {
    flow.log.observed = { ...observed, net: net.map(n => ({ ...n, body: n.body.slice(0, 600) })) };
    await flow.close();
  }
}

/** c3 extra: price the same day at 10 h, 10.5 h and 1 h through the quote API to show the unit cliff. */
async function c3PricingBoundary(flow, net, observed) {
  const base = quoteCalls(net).filter(q => q.status < 300 && q.req?.cityId).at(-1)?.req;
  if (!base) return;
  const spec = COMBOS.find(c => c.key === "c3");
  const at = (t) => new Date(istMs(spec.start, t)).toISOString();
  const variants = [["1 h visit", "sitting-visit-60", "09:00", "10:00"], ["10 h day", "sitting-visit-60", "09:00", "19:00"], ["10.5 h day", "sitting-overnight", "09:00", "19:30"]];
  const rows = [];
  for (const [label, packageCode, s, e] of variants) {
    const r = await api(flow.context, "POST", "/api/sitting-commercial", { packageCode, petCount: 1, cityId: base.cityId, zoneId: base.zoneId, scheduledStart: at(s), scheduledEnd: at(e), paymentMode: "prepaid" });
    rows.push({ label, packageCode, http: r.status, units: r.body?.data?.billableUnits, total: r.body?.data?.totalAmount, error: r.body?.error });
  }
  observed.boundary = rows;
  summary.c3Boundary = rows;
  const tenHour = rows.find(r => r.label === "10 h day"), oneHour = rows.find(r => r.label === "1 h visit"), tenHalf = rows.find(r => r.label === "10.5 h day");
  if (tenHour?.total != null && oneHour?.total != null && tenHour.total === oneHour.total) {
    fileFinding("sitting-10h-one-unit", {
      severity: "P1", area: "Pet Sitting pricing", flow: "sit-c3-day-10h-dog",
      title: `A 10-hour Pet Sitting day is priced as one 60-minute Home Visit (${inr(tenHour.total)}) — suspected revenue leak`,
      steps: `/v2/sitting → ${spec.start} 09:00–19:00 · 1 dog → sitter → review; plus POST /api/sitting-commercial for 1 h, 10 h and 10.5 h on the same day`,
      expected: "A full care day is priced above a single 60-minute visit (owner to confirm the intended day rate)",
      actual: `Review quote sitting-visit-60 × ${observed.reviewQuote?.units} unit = ${inr(observed.reviewQuote?.total)} (booking ${observed.bookingId}, server total ${observed.status?.totalAmount}). API: 1 h → ${inr(oneHour.total)}, 10 h → ${inr(tenHour.total)} (units ${tenHour.units}), 10.5 h → ${tenHalf?.total != null ? inr(tenHalf.total) : tenHalf?.error} (${tenHalf?.packageCode}). Any window up to 10 h costs the same as 1 h, then jumps ×2 at 10 h 01 min.`,
      evidence: observed.evidence.filter(e => /review|payment-page/.test(e)),
    });
  }
}

// ---------------------------------------------------------------- c7 Care Card validation
async function runValidation(browser) {
  const journey = "sit-c7-missing-home-access", combo = "1-hour visit · Care Card without home access (blank, then whitespace) → must be refused before any reservation";
  const flow = await newFlow(browser, journey);
  const net = watchNet(flow);
  const observed = { evidence: [] };
  try {
    await customerSession(flow.context, "customer-a");
    if (!accountPets) await ensurePets(flow.context);
    const spec = { start: day(4), startTime: "10:00", end: day(4), endTime: "11:00", petObjs: pickPets([{ species: "dog" }]), meet: false, care: { "Home access instructions": "" } };
    const reached = await planToReview(flow, spec, observed);
    if (!reached) { record({ suite: SUITE, journey, combo, result: "BLOCKED", detail: `could not reach review: blockedAt=${observed.blockedAt} ${observed.sitterAlerts?.join(" / ") || observed.planCta}`, evidence: observed.evidence }); return; }
    const reviewReachedWithoutHomeAccess = true;
    const page = flow.page;
    const mark = net.length;
    await page.getByRole("button", { name: /^Pay .*request final partner approval/ }).click();
    await settle(page, 1500);
    const alert1 = (await page.locator("[role=alert]").allInnerTexts()).map(flat).filter(Boolean);
    observed.evidence.push(await flow.shot("blank-home-access-refused"));
    // whitespace-only home access
    await page.getByRole("button", { name: "← Care plan" }).click();
    await page.getByLabel("Home access instructions", { exact: true }).fill("   ");
    await page.getByRole("button", { name: "Review protected booking" }).click();
    await settle(page, 800);
    await waitForPricedCta(page);
    await page.getByRole("button", { name: /^Pay .*request final partner approval/ }).click();
    await settle(page, 1500);
    const alert2 = (await page.locator("[role=alert]").allInnerTexts()).map(flat).filter(Boolean);
    observed.evidence.push(await flow.shot("whitespace-home-access-refused"));
    const after = net.slice(mark);
    const reserve = after.filter(n => n.path.startsWith("/api/uat-scheduling") && !/"preview"/.test(n.req));
    const bookings = after.filter(n => n.path.startsWith("/api/sitting-bookings"));
    const refused = [alert1, alert2].every(a => a.some(t => /home access/i.test(t)));
    const noWrites = reserve.length === 0 && bookings.length === 0;
    record({ suite: SUITE, journey, combo, result: refused && noWrites ? "PASS" : "FAIL", detail: `blank → alert ${JSON.stringify(alert1)}; whitespace → alert ${JSON.stringify(alert2)}; reservation calls after Pay: ${reserve.length}, booking calls: ${bookings.length}; the Care Card let the customer continue to review without home access (validation fires only at Pay)`, evidence: observed.evidence });
    if (!refused || !noWrites) fileFinding("home-access-not-enforced", { severity: "P1", area: "Pet Sitting Care Card", flow: journey, title: "Sitting booking proceeds without home access instructions", steps: "Care Card with blank/whitespace home access → review → Pay", expected: "Refused before any reservation", actual: `alerts ${JSON.stringify([alert1, alert2])}; reserve ${reserve.length}; booking ${bookings.length}`, evidence: observed.evidence });
    else if (reviewReachedWithoutHomeAccess) fileFinding("home-access-late-validation", { severity: "P3", area: "Pet Sitting Care Card", flow: journey, title: "Required home-access / vet / emergency fields are only enforced at the final Pay click", steps: "/v2/sitting → sitter → Care Card with Home access blank → Review protected booking → agree → Pay", expected: "Care Card step flags the missing required field before leaving step 3", actual: `Step 3 → 4 is allowed with the field blank; the error "${alert1[0] || ""}" appears only on the review screen after pressing Pay`, evidence: observed.evidence });
  } catch (e) {
    observed.evidence.push(await flow.shot("error").catch(() => null));
    record({ suite: SUITE, journey, combo, result: "BLOCKED", detail: `harness: ${String(e).slice(0, 400)}`, evidence: observed.evidence.filter(Boolean) });
  } finally { flow.log.observed = { ...observed, net: net.map(n => ({ ...n, body: n.body.slice(0, 400) })) }; await flow.close(); }
}

// ---------------------------------------------------------------- c8 mode switch
async function runModeSwitch(browser) {
  const journey = "sit-c8-mode-switch", combo = "Plan edited in Sitting → switch to Home Boarding → back to Sitting; stage-2 caregivers; hero tabs; reload";
  const flow = await newFlow(browser, journey);
  const net = watchNet(flow);
  const evidence = [];
  const page = flow.page;
  const state = async () => page.evaluate(() => ({
    url: location.pathname,
    eyebrow: document.querySelector("[class*=stayIntro] span")?.textContent || null,
    heroEyebrow: document.querySelector("section[class*=hero] small")?.textContent || null,
    stage: document.querySelector("[class*=stayIntro] b")?.textContent || null,
    pressed: [...document.querySelectorAll("[class*=modeSwitch] button")].filter(b => b.getAttribute("aria-pressed") === "true").map(b => b.querySelector("b")?.textContent),
    heroTab: [...document.querySelectorAll("a[aria-current=page]")].map(a => a.textContent),
    dates: [...document.querySelectorAll("input[type=date],input[type=time]")].map(i => i.value),
    pets: [...document.querySelectorAll("[class*=petList] button[aria-pressed=true] b")].map(b => b.textContent),
    needs: [...document.querySelectorAll("[class*=chips] button[aria-pressed=true]")].map(b => b.textContent.replace(/^[✓＋]\s*/, "")),
    heading: document.querySelector("[class*=head] h3")?.textContent || null,
    cta: [...document.querySelectorAll("button")].map(b => b.textContent).find(t => /See available|Verify a service|Select a pet|Continue with|Choose an available/.test(t || "")) || null,
  }));
  try {
    await customerSession(flow.context, "customer-a");
    if (!accountPets) await ensurePets(flow.context);
    await openSitting(flow);
    await ensureServiceAddress(flow);
    const edited = { start: day(4), startTime: "19:00", end: day(6), endTime: "09:00" };
    await setWindow(page, edited);
    await selectPets(page, pickPets([{ species: "dog" }, { species: "cat" }]));
    await page.getByRole("button", { name: /Medication/ }).click();
    await settle(page, 1000);
    const s1 = await state(); evidence.push(await flow.shot("sitting-edited"));
    await ensureSession(flow);
    let mark = net.length;
    await page.locator("[class*=modeSwitch] button").filter({ hasText: "Home Boarding" }).click();
    await settle(page, 2500);
    const s2 = await state(); s2.calls = [...new Set(net.slice(mark).map(n => n.path.split("?")[0]))]; evidence.push(await flow.shot("switched-to-boarding"));
    await ensureSession(flow);
    mark = net.length;
    await page.locator("[class*=modeSwitch] button").filter({ hasText: "Pet Sitting" }).click();
    await settle(page, 2500);
    const s3 = await state(); s3.calls = [...new Set(net.slice(mark).map(n => n.path.split("?")[0]))]; evidence.push(await flow.shot("switched-back-to-sitting"));
    // stage 2 in Sitting, back, switch to Boarding, stage 2 again — no sitter may leak into the host list
    await page.getByRole("button", { name: /See available sitters/ }).click();
    await page.getByText("Checking sitter availability…").waitFor({ state: "detached", timeout: 30_000 }).catch(() => {});
    await settle(page, 1200);
    const sitterCards = (await page.locator("[class*=caregivers] > button").allInnerTexts()).map(t => flat(t).split(" | ").slice(0, 3).join(" "));
    evidence.push(await flow.shot("sitting-stage2"));
    await page.getByRole("button", { name: "← Plan" }).click();
    await settle(page, 600);
    await ensureSession(flow);
    await page.locator("[class*=modeSwitch] button").filter({ hasText: "Home Boarding" }).click();
    await settle(page, 2000);
    await page.getByRole("button", { name: /See available homes/ }).click().catch(() => {});
    await page.getByText(/Checking governed host availability/).waitFor({ state: "detached", timeout: 30_000 }).catch(() => {});
    await settle(page, 1500);
    const s4 = await state(); s4.cards = (await page.locator("[class*=caregivers] > button").allInnerTexts()).map(t => flat(t).split(" | ").slice(0, 3).join(" "));
    evidence.push(await flow.shot("boarding-stage2-after-switch"));
    // hero tab "Pet Sitting" while the in-flow switch shows Boarding on the /v2/sitting URL
    await page.getByRole("link", { name: "Pet Sitting", exact: true }).first().click();
    await settle(page, 2500);
    const s5 = await state(); evidence.push(await flow.shot("hero-tab-pet-sitting"));
    await ensureSession(flow);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByText("Loading your PawSpace family…").waitFor({ state: "detached", timeout: 25_000 }).catch(() => {});
    await settle(page, 2500);
    const s6 = await state(); evidence.push(await flow.shot("after-reload"));
    const toBoardingOk = /BOARDING/.test(s2.eyebrow || "") && s2.pressed.includes("Home Boarding") && /See available homes/.test(s2.cta || "") && s2.stage?.startsWith("1") && !s2.calls.includes("/api/sitting-commercial");
    const backOk = /SITTING/.test(s3.eyebrow || "") && s3.pressed.includes("Pet Sitting") && /See available sitters/.test(s3.cta || "") && !s3.calls.includes("/api/boarding-commercial");
    const noLeak = !s4.cards.some(c => sitterCards.includes(c)) && /host/i.test(s4.heading || "");
    const preserved = JSON.stringify(s2.dates) === JSON.stringify(s1.dates) && JSON.stringify(s2.pets) === JSON.stringify(s1.pets);
    const heroTabWorks = /SITTING/.test(s5.eyebrow || "");
    const detail = `edited sitting plan ${JSON.stringify({ dates: s1.dates, pets: s1.pets, needs: s1.needs })}; → Boarding: eyebrow=${s2.eyebrow} stage=${s2.stage} cta="${s2.cta}" url=${s2.url} heroTab=${s2.heroTab} dates=${JSON.stringify(s2.dates)} pets=${JSON.stringify(s2.pets)} needs=${JSON.stringify(s2.needs)} calls=${JSON.stringify(s2.calls)}; → Sitting: eyebrow=${s3.eyebrow} cta="${s3.cta}" dates=${JSON.stringify(s3.dates)} calls=${JSON.stringify(s3.calls)}; plan edits ${preserved ? "PRESERVED" : "RESET to defaults"} on switch; sitter stage-2 cards ${JSON.stringify(sitterCards)} vs boarding stage-2 heading "${s4.heading}" cards ${JSON.stringify(s4.cards)}; hero "Pet Sitting" tab while in-flow Boarding → eyebrow=${s5.eyebrow} stage=${s5.stage} url=${s5.url}; reload → eyebrow=${s6.eyebrow} pressed=${JSON.stringify(s6.pressed)}`;
    const verdictOk = toBoardingOk && backOk && noLeak;
    const contention = !verdictOk && sessionLost(flow);
    record({ suite: SUITE, journey, combo, result: verdictOk ? (heroTabWorks ? "PASS" : "PARTIAL") : contention ? "BLOCKED" : "FAIL", detail: `${contention ? "harness: customer-a session was superseded by another sign-in during the journey (401s in log); " : ""}${detail}`, evidence });
    if (verdictOk && !heroTabWorks && /BOARDING/.test(s5.eyebrow || "")) fileFinding("hero-tab-noop", { severity: "P3", area: "V2 stay navigation", flow: journey, title: "After the in-flow switch to Home Boarding, the 'Pet Sitting' hero tab does nothing (URL stays /v2/sitting)", steps: "/v2/sitting → in-flow 'Home Boarding' → See available homes → click hero tab 'Pet Sitting'", expected: "Pet Sitting flow shown", actual: `URL ${s2.url} while Boarding is shown; after clicking the hero 'Pet Sitting' tab the page still shows ${s5.eyebrow} stage ${s5.stage}; only a reload restores Sitting (${s6.eyebrow})`, evidence: evidence.slice(-3) });
    if (!preserved && toBoardingOk && s1.pets.length > 1) {
      summary.modeSwitchResets = { before: s1, after: s2 };
      fileFinding("mode-switch-discards-plan", { severity: "P3", area: "V2 stay planning", flow: journey, title: "Switching Pet Sitting ↔ Home Boarding discards the dates, pets and care needs already entered", steps: "/v2/sitting → set dates/times, select two pets and 'Medication' → in-flow 'Home Boarding' → back to 'Pet Sitting'", expected: "Shared plan inputs (dates, times, pets, needs) carry over; only caregiver and price reset", actual: `Before ${JSON.stringify({ dates: s1.dates, pets: s1.pets, needs: s1.needs })}; after switching ${JSON.stringify({ dates: s2.dates, pets: s2.pets, needs: s2.needs })} (StayFlow remounts per mode)`, evidence: evidence.slice(0, 3) });
    }
  } catch (e) {
    evidence.push(await flow.shot("error").catch(() => null));
    record({ suite: SUITE, journey, combo, result: "BLOCKED", detail: `harness: ${String(e).slice(0, 400)}`, evidence: evidence.filter(Boolean) });
  } finally { await flow.close(); }
}

// ---------------------------------------------------------------- post-booking journeys
async function openManage(flow, bookingId, { reauth = true } = {}) {
  const { page } = flow;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.goto(`${BASE}/v2/sitting/manage?bookingId=${encodeURIComponent(bookingId)}`, { waitUntil: "domcontentloaded" });
    await dismissCookies(page);
    await page.getByRole("heading", { name: "Your sitting booking" }).waitFor({ timeout: 25_000 }).catch(() => {});
    await page.getByText("Loading saved booking and care updates…").waitFor({ state: "detached", timeout: 25_000 }).catch(() => {});
    await settle(page, 800);
    if (!reauth || !(await reauthIfExpired(flow, await page.locator("[role=alert]").allInnerTexts().catch(() => []), "manage page"))) break;
  }
  const panel = flat(await page.locator("section[aria-label='Your sitting booking']").innerText().catch(() => ""));
  const status = (panel.match(/Booking status \| ([^|]+)/) || [])[1]?.trim() || null;
  const homeAccess = await labelledTextarea(page, "Home access instructions").inputValue().catch(() => null);
  const alerts = (await page.locator("[role=alert]").allInnerTexts().catch(() => [])).map(flat).filter(Boolean);
  return { panel, status, homeAccess, alerts };
}

function bookingFor(key) {
  if (made[key]?.bookingId) return made[key];
  if (REUSE[key]) return { bookingId: REUSE[key], paid: null, reused: true };
  return null;
}

async function withCustomerFlow(browser, journey, fn, opts = {}) {
  const flow = await newFlow(browser, journey, opts);
  const evidence = [];
  try { await customerSession(flow.context, "customer-a"); await fn(flow, evidence); }
  catch (e) { evidence.push(await flow.shot("error").catch(() => null)); record({ suite: SUITE, journey, combo: opts.combo || journey, result: "BLOCKED", detail: `harness: ${String(e).slice(0, 400)}`, evidence: evidence.filter(Boolean) }); }
  finally { await flow.close(); }
}

async function runBookingPages(browser) {
  for (const key of ["c1", "c4", "c6"]) {
    const b = bookingFor(key);
    const journey = `sit-m1-${key}-booking-and-manage`, combo = `V2 booking page + /v2/sitting/manage for ${key} (${b?.bookingId || "no booking"})`;
    if (!b) { record({ suite: SUITE, journey, combo, result: "SKIPPED", detail: `no ${key} booking was created in this run`, evidence: [] }); continue; }
    await withCustomerFlow(browser, journey, async (flow, evidence) => {
      const { page, context } = flow;
      const st = await bookingStatus(context, b.bookingId);
      await gotoWithReauth(flow, `/v2/booking?bookingId=${encodeURIComponent(b.bookingId)}`, p => p.getByText("Loading your booking…").waitFor({ state: "detached", timeout: 25_000 }).catch(() => {}));
      await settle(page, 600);
      const bookingText = flat(await page.locator("main").innerText().catch(() => ""));
      const payButton = await page.getByRole("button", { name: /Pay securely/ }).innerText().catch(() => null);
      const manageHref = await page.getByRole("link", { name: "Manage service" }).getAttribute("href").catch(() => null);
      evidence.push(await flow.shot("v2-booking-page"));
      let manageUrl = null;
      if (manageHref) { await page.getByRole("link", { name: "Manage service" }).click(); await page.waitForURL(/\/sitting\/manage/, { timeout: 20_000 }).catch(() => {}); manageUrl = page.url().replace(BASE, ""); }
      const m = { url: manageUrl, ...(await openManage(flow, b.bookingId)) };
      evidence.push(await flow.shot("manage-page"));
      const dateChangeEnabled = await page.getByLabel("Requested start (your local time)").isEnabled().catch(() => false);
      const cancelForm = await page.locator("form").filter({ hasText: "Request cancellation" }).count();
      const confirmed = ["confirmed", "assigned"].includes(st.bookingStatus) && st.paymentStatus === "captured";
      const careOk = m.homeAccess === CARE["Home access instructions"];
      const split = st.paymentMode === "split_50_50";
      let detail = `api booking=${st.bookingStatus} payment=${st.paymentStatus} mode=${st.paymentMode} total=${st.totalAmount} dueNow=${st.amountDueNow}; booking page: ${bookingText.slice(0, 320)}; Pay button on booking page: ${payButton || "none"}; Manage link ${manageHref}; manage (${m.url}) status "${m.status}", care plan home access persisted: ${careOk}, date-change form enabled: ${dateChangeEnabled}, cancellation form present: ${cancelForm > 0}`;
      if (split && confirmed) {
        const balanceOffered = Boolean(payButton);
        detail += `; split balance offered immediately after the deposit: ${balanceOffered ? `YES "${payButton}" (PAY-03 ${REPRO})` : `no (PAY-03 ${NOT_REPRO})`}`;
        if (balanceOffered) fileFinding("split-balance-pay-now", { severity: "P2", area: "Payments / booking page", flow: journey, title: "After the 50% Sitting deposit is captured the booking page immediately offers 'Pay securely' for the balance (re-verifies PAY-03)", steps: `Pay the 50% deposit for ${b.bookingId} → /v2/booking?bookingId=${b.bookingId}`, expected: "Deposit shown as paid; balance shown as due 24 h before check-in, not as 'Due now'", actual: `${payButton}; page: ${bookingText.slice(0, 240)}`, evidence: evidence.slice(-2) });
      }
      const result = confirmed ? (careOk && cancelForm > 0 && dateChangeEnabled && m.status ? "PASS" : "PARTIAL") : (LOCAL ? "ENV-GATED" : "FAIL");
      record({ suite: SUITE, journey, combo, result, detail: confirmed ? detail : `${detail}; booking is not confirmed/captured${LOCAL ? " (payment cannot be captured on the local mirror)" : ""}`, evidence });
    }, { combo });
  }
}

async function runDateChange(browser) {
  const b = bookingFor("c4");
  const journey = "sit-m2-date-change-request", combo = `Manage page → Request date change on the paid overnight booking (${b?.bookingId || "none"})`;
  if (!b) { record({ suite: SUITE, journey, combo, result: "SKIPPED", detail: "no c4 booking", evidence: [] }); return; }
  await withCustomerFlow(browser, journey, async (flow, evidence) => {
    const { page, context } = flow;
    const before = await bookingStatus(context, b.bookingId);
    const m = await openManage(flow, b.bookingId);
    evidence.push(await flow.shot("manage-before"));
    const startField = page.getByLabel("Requested start (your local time)");
    if (!(await startField.isEnabled().catch(() => false))) {
      const note = flat(await page.locator("form").filter({ hasText: "Request date change" }).innerText().catch(() => ""));
      record({ suite: SUITE, journey, combo, result: LOCAL && before.paymentStatus !== "captured" ? "ENV-GATED" : "FAIL", detail: `date-change form disabled for booking status "${m.status}" (api ${before.bookingStatus}/${before.paymentStatus}): ${note.slice(0, 200)}`, evidence });
      return;
    }
    const reqStart = `${day(19)}T19:00`, reqEnd = `${day(20)}T09:00`;
    await startField.fill(reqStart);
    await page.getByLabel("Requested end (your local time)").fill(reqEnd);
    await page.locator("form").filter({ hasText: "Request date change" }).locator("textarea").fill("Master E2E: travel moved by two weeks");
    const dcForm = page.locator("form").filter({ hasText: "Request date change" });
    const msgs = await submitWithReauth(flow, page.getByRole("button", { name: "Request date change" }), () => dcForm.locator("[role=status],[role=alert]").allInnerTexts(), /Date-change request .* recorded/);
    evidence.push(await flow.shot("date-change-requested"));
    const requestId = (msgs.join(" ").match(/Date-change request ([0-9a-f-]{36})/) || [])[1] || null;
    const after = await bookingStatus(context, b.bookingId);
    const rows = await d1("SELECT id, status, requested_start, requested_end, old_total, requested_by, created_at FROM sitting_date_change_requests WHERE booking_id = ? ORDER BY created_at", [b.bookingId]);
    const unchanged = after.scheduledStart === before.scheduledStart && after.totalAmount === before.totalAmount && after.bookingStatus === before.bookingStatus;
    const d1Ok = Array.isArray(rows) ? rows.some(r => r.id === requestId && r.status === "commercial_quote_required") : null;
    record({ suite: SUITE, journey, combo, result: requestId && unchanged && d1Ok !== false ? "PASS" : "FAIL", detail: `requested ${reqStart} → ${reqEnd} (IST); message ${JSON.stringify(msgs)}; booking unchanged: ${unchanged} (${before.scheduledStart} ₹${before.totalAmount} ${before.bookingStatus} → ${after.scheduledStart} ₹${after.totalAmount} ${after.bookingStatus}); d1 sitting_date_change_requests ${JSON.stringify(rows).slice(0, 400)}`, evidence });
    if (made.c4) made.c4.dateChangeRequestId = requestId;
    saveBooking({ suite: SUITE, bookingId: b.bookingId, service: "pet_sitting", packageCode: "sitting-overnight", customer: "customer-a", paid: after.paymentStatus === "captured", total: after.totalAmount, dueNow: after.amountDueNow, paymentMode: after.paymentMode, providerId: after.providerId, scheduledStart: after.scheduledStart, update: "date_change_requested", dateChangeRequestId: requestId, requestedStart: reqStart, requestedEnd: reqEnd });
  }, { combo });
}

async function runCancelRequest(browser) {
  const b = bookingFor("c6");
  const journey = "sit-m3-cancel-request", combo = `Manage page → Request cancellation on the split-deposit booking (${b?.bookingId || "none"}); repeat submit must not duplicate`;
  if (!b) { record({ suite: SUITE, journey, combo, result: "SKIPPED", detail: "no c6 booking", evidence: [] }); return; }
  await withCustomerFlow(browser, journey, async (flow, evidence) => {
    const { page, context } = flow;
    const before = await bookingStatus(context, b.bookingId);
    const m = await openManage(flow, b.bookingId);
    const form = page.locator("form").filter({ hasText: "Request cancellation" });
    if (!(await form.count())) { evidence.push(await flow.shot("no-cancel-form")); record({ suite: SUITE, journey, combo, result: "FAIL", detail: `no cancellation form on manage page (status "${m.status}"): ${m.panel.slice(0, 300)}`, evidence }); return; }
    const reason = "Master E2E: plans changed, please review cancellation";
    await form.locator("textarea").fill(reason);
    const panelMessages = () => page.locator("section[aria-label='Your sitting booking'] > [role=status], section[aria-label='Your sitting booking'] > [role=alert]").allInnerTexts();
    const submit = page.getByRole("button", { name: "Submit cancellation request" });
    const msg1 = await submitWithReauth(flow, submit, panelMessages, /Cancellation request .* recorded/);
    evidence.push(await flow.shot("cancel-requested"));
    const msg2 = await submitWithReauth(flow, submit, panelMessages, /Cancellation request .* recorded/);
    evidence.push(await flow.shot("cancel-repeat-submit"));
    const id1 = (msg1.join(" ").match(/Cancellation request ([0-9a-f-]{36})/) || [])[1] || null;
    const id2 = (msg2.join(" ").match(/Cancellation request ([0-9a-f-]{36})/) || [])[1] || null;
    const after = await bookingStatus(context, b.bookingId);
    const rows = await d1("SELECT id, status, reason, requested_by, created_at FROM sitting_cancellation_requests WHERE booking_id = ? ORDER BY created_at", [b.bookingId]);
    const unchanged = after.bookingStatus === before.bookingStatus && after.paymentStatus === before.paymentStatus;
    const d1Rows = Array.isArray(rows) ? rows.filter(r => r.reason === reason) : null;
    const ok = id1 && unchanged && (id2 === null || id2 === id1) && (d1Rows === null || (d1Rows.length === 1 && d1Rows[0].status === "policy_review_required"));
    record({ suite: SUITE, journey, combo, result: ok ? "PASS" : "FAIL", detail: `booking ${before.bookingStatus}/${before.paymentStatus} (paid: ${b.paid}); first submit ${JSON.stringify(msg1)}; repeat submit ${JSON.stringify(msg2)} (same request id: ${id1 === id2}); booking unchanged: ${unchanged} (${after.bookingStatus}/${after.paymentStatus}); d1 sitting_cancellation_requests ${JSON.stringify(rows).slice(0, 400)}`, evidence });
    if (d1Rows && d1Rows.length > 1) fileFinding("cancel-duplicate", { severity: "P2", area: "Pet Sitting manage", flow: journey, title: "Repeat 'Submit cancellation request' creates duplicate cancellation requests", steps: `Manage ${b.bookingId} → Request cancellation → submit twice with the same reason`, expected: "One request (idempotent)", actual: `${d1Rows.length} rows: ${JSON.stringify(d1Rows).slice(0, 300)}`, evidence });
    saveBooking({ suite: SUITE, bookingId: b.bookingId, service: "pet_sitting", packageCode: "sitting-overnight", customer: "customer-a", paid: after.paymentStatus === "captured", total: after.totalAmount, dueNow: after.amountDueNow, paymentMode: after.paymentMode, providerId: after.providerId, scheduledStart: after.scheduledStart, update: "cancellation_requested", cancellationRequestId: id1 });
  }, { combo });
}

async function runUnpaidManage(browser) {
  const b = bookingFor("c2");
  const journey = "sit-m4-unpaid-manage", combo = `Unpaid 4-hour visit (${b?.bookingId || "none"}): manage page and V2 booking page`;
  if (!b) { record({ suite: SUITE, journey, combo, result: "SKIPPED", detail: "no c2 booking", evidence: [] }); return; }
  await withCustomerFlow(browser, journey, async (flow, evidence) => {
    const { page, context } = flow;
    const st = await bookingStatus(context, b.bookingId);
    const m = await openManage(flow, b.bookingId);
    const payOnManage = await page.getByRole("button", { name: /Pay/ }).count();
    const dateNote = flat(await page.locator("form").filter({ hasText: "Request date change" }).innerText().catch(() => ""));
    evidence.push(await flow.shot("unpaid-manage"));
    await gotoWithReauth(flow, `/v2/booking?bookingId=${encodeURIComponent(b.bookingId)}`, p => p.getByText("Loading your booking…").waitFor({ state: "detached", timeout: 25_000 }).catch(() => {}));
    await settle(page, 600);
    const bookingText = flat(await page.locator("main").innerText().catch(() => ""));
    const payOnBooking = await page.getByRole("button", { name: /Pay securely/ }).innerText().catch(() => null);
    evidence.push(await flow.shot("unpaid-booking-page"));
    const ok = st.paymentStatus !== "captured" && Boolean(payOnBooking);
    record({ suite: SUITE, journey, combo, result: ok ? "PASS" : "FAIL", detail: `api ${st.bookingStatus}/${st.paymentStatus} dueNow=${st.amountDueNow}; manage status "${m.status}", pay control on manage page: ${payOnManage > 0}, date-change: ${dateNote.slice(0, 160)}; V2 booking page offers "${payOnBooking}"; booking page: ${bookingText.slice(0, 240)}`, evidence });
    if (payOnManage === 0 && payOnBooking) fileFinding("unpaid-manage-no-pay", { severity: "P2", area: "Pet Sitting manage", flow: journey, title: "Unpaid Sitting booking's manage page offers no way to complete the payment", steps: `Create a Sitting booking, leave the Razorpay step → /v2/sitting/manage?bookingId=${b.bookingId}`, expected: "Clear 'payment pending' state with a Pay control (as on /v2/booking)", actual: `Manage shows status "${m.status}" and only care/cancel/date forms; the V2 booking page does offer "${payOnBooking}"`, evidence });
  }, { combo });
}

async function runPrivacy(browser) {
  const b = bookingFor("c1") || bookingFor("c4");
  const journey = "sit-p1-privacy-customer-b", combo = `customer-b tries to read customer-a's sitting booking ${b?.bookingId || "none"} (care plan with home access)`;
  if (!b) { record({ suite: SUITE, journey, combo, result: "SKIPPED", detail: "no customer-a sitting booking", evidence: [] }); return; }
  const flow = await newFlow(browser, journey);
  const evidence = [];
  try {
    await customerSession(flow.context, "customer-b");
    const life = await api(flow.context, "GET", `/api/sitting-lifecycle?scope=customer&bookingId=${encodeURIComponent(b.bookingId)}`);
    const status = await api(flow.context, "POST", "/api/customer-checkout", { action: "status", bookingId: b.bookingId });
    const m = await openManage(flow, b.bookingId, { reauth: false });
    evidence.push(await flow.shot("customer-b-on-a-manage"));
    const leakText = JSON.stringify(life.body) + JSON.stringify(status.body) + m.panel;
    const leaked = leakText.includes("gate code 4321") || leakText.includes("Dr. Rao (UAT test vet)") || (life.status === 200 && JSON.stringify(life.body).includes(b.bookingId) && Array.isArray(life.body?.data) && life.body.data.length > 0);
    record({ suite: SUITE, journey, combo, result: leaked ? "FAIL" : "PASS", detail: `GET sitting-lifecycle → HTTP ${life.status} ${JSON.stringify(life.body).slice(0, 160)}; checkout status → HTTP ${status.status} ${JSON.stringify(status.body).slice(0, 160)}; manage page: ${m.panel.slice(0, 160) || JSON.stringify(m.alerts)}`, evidence });
    if (leaked) fileFinding("privacy-leak", { severity: "P0", area: "Privacy", persona: "customer-b", flow: journey, title: "Another customer can read a Sitting booking's care plan / home access", steps: `customer-b → /v2/sitting/manage?bookingId=${b.bookingId}`, expected: "403/404, nothing disclosed", actual: leakText.slice(0, 400), evidence });
  } catch (e) {
    evidence.push(await flow.shot("error").catch(() => null));
    record({ suite: SUITE, journey, combo, result: "BLOCKED", detail: `harness: ${String(e).slice(0, 400)}`, evidence: evidence.filter(Boolean) });
  } finally { await flow.close(); }
}

/** Aggregate the Meet & Greet evidence of every combo that selected one. */
function recordMeetGreet() {
  const journey = "sit-mg-meet-greet-requests";
  const rows = summary.meetGreet;
  if (!rows.length) { record({ suite: SUITE, journey, combo: "Meet & Greet request persistence", result: "SKIPPED", detail: "no combo with Meet & Greet ran", evidence: [] }); return; }
  const d1Available = rows.every(r => Array.isArray(r.d1));
  const d1Missing = rows.some(r => r.d1 && r.d1.error && /no such table/i.test(r.d1.detail || ""));
  const anyApi = rows.some(r => r.apiCalls.length);
  const anyRow = rows.some(r => Array.isArray(r.d1) && r.d1.length);
  const detail = rows.map(r => `${r.combo} ${r.format} booking ${r.bookingId}: /api/meet-and-greet calls ${JSON.stringify(r.apiCalls)}, d1 meet_greet_requests since journey start ${Array.isArray(r.d1) ? JSON.stringify(r.d1).slice(0, 200) : JSON.stringify(r.d1).slice(0, 160)}`).join("; ");
  const result = anyApi || anyRow ? "PASS" : "FAIL";
  record({ suite: SUITE, journey, combo: "Is a Meet & Greet request created when the customer selects one in the Sitting flow?", result, detail: `${detail}${d1Available ? "" : " (d1 not available here — verdict from network evidence only)"}`, evidence: rows.map(r => r.evidence).filter(Boolean) });
  if (!anyApi && !anyRow) fileFinding("mg-not-created", {
    severity: "P1", area: "Pet Sitting · Meet & Greet", flow: journey,
    title: "Selecting a Meet & Greet in the Sitting flow creates no Meet & Greet request (the ₹499 house visit / phone call is silently dropped)",
    steps: "/v2/sitting → Care Card → keep '2-hour sitter Meet & Greet' checked, choose house visit or phone call → review ('₹499 · paid separately') → Pay & request final partner approval",
    expected: "A meet_greet_requests row (format house_visit/phone, price 499 or waived) is created for the chosen sitter, as the review promises it is 'arranged and paid separately'",
    actual: `No request to /api/meet-and-greet during any of ${rows.length} bookings; ${d1Available ? `staging D1 meet_greet_requests has no row for customer ${customerId} since the journeys started` : d1Missing ? "meet_greet_requests table does not exist on this database" : "D1 not readable here"}; the booking's pricing and care plan do not mention it either. ${detail.slice(0, 500)}`,
    evidence: rows.map(r => r.evidence).filter(Boolean),
  });
}

// ---------------------------------------------------------------- main
const browser = await launch();
try {
  flowNote(`V2 Pet Sitting master suite against ${BASE} (${LOCAL ? "LOCAL mirror" : "staging"}), window days ${W0}–${W1}, shift ${SHIFT}`);
  for (const spec of COMBOS) if (wanted(spec.key)) await runCombo(browser, spec);
  if (wanted("c7")) await runValidation(browser);
  if (wanted("c8")) await runModeSwitch(browser);
  if (wanted("mg")) recordMeetGreet();
  if (wanted("m1")) await runBookingPages(browser);
  if (wanted("m2")) await runDateChange(browser);
  if (wanted("m3")) await runCancelRequest(browser);
  if (wanted("m4")) await runUnpaidManage(browser);
  if (wanted("p1")) await runPrivacy(browser);
} catch (e) {
  record({ suite: SUITE, journey: "suite", combo: "harness", result: "BLOCKED", detail: `harness: ${String(e).slice(0, 500)}`, evidence: [] });
} finally {
  summary.finishedAt = new Date().toISOString();
  summary.bookings = Object.fromEntries(Object.entries(made).map(([k, v]) => [k, { bookingId: v.bookingId, paid: v.paid, total: v.expected?.total, dueNow: v.expected?.dueNow, sitter: v.sitter }]));
  writeJson(`${SUITE}.json`, summary);
  await browser.close().catch(() => {});
  console.log(`[${SUITE}] done in ${Math.round((Date.now() - SUITE_STARTED) / 1000)} s; bookings ${JSON.stringify(summary.bookings)}; findings ${summary.findings.map(f => f.key).join(", ") || "none"}`);
}

function flowNote(text) { console.log(`[${SUITE}] ${text}`); }
