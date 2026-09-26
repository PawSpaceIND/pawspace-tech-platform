// Master suite 40 — V2 customer SERVICES as synthetic customer-b (on staging: a fresh run-scoped OTP customer):
// real sandbox OTP sign-in / wrong code / sign-out / returning sign-in (new number runPhone(3)), /v2/account profile +
// addresses (unserviceable PIN re-check) + pets, Grooming (catalogue; booking + Razorpay TEST only if packages are
// published — this suite NEVER publishes packages), Training (Meet & Greet + split programme, Razorpay TEST), Dog
// Walking (Mon–Fri 30 min + one-time 60 min, double-booking probe), Fresh Food (2× Adult Dog + 14-day repeat),
// Relocation (domestic + international) and the activity / booking / chat pages.
// Payments go through the app's own checkout (CustomerCheckoutController → Razorpay TEST checkout) and are judged by
// server state (/api/customer-checkout status, read-only staging D1). Locally Razorpay is not configured (HTTP 503) →
// ENV-GATED; the code path is the one used on staging.
import {
  BASE, launch, newFlow, settle, customerSession, dismissCookies, api, d1, payRazorpayTestNetbanking,
  record, finding, saveBooking, isoDay, WINDOWS, writeJson, redact, runPhone,
} from "../lib.mjs";

const SUITE = "40-customer-services";
const PERSONA = "customer-b";
const STARTED = Date.now();
const BUDGET_MS = 30 * 60_000;
const [W_FROM, W_TO] = WINDOWS.services;
const ON = /localhost|127\.0\.0\.1/.test(BASE) ? "LOCAL" : "STAGING";
const OTP_MODE = process.env.MASTER_CUSTOMER_MODE === "otp";
const OTP_PHONE = runPhone(3);
const STAMP = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
const ADDRESS_QUERY = "100 Feet Road Indiranagar";
const HOME = { label: "Home", line1: "100 Feet Road, HAL 2nd Stage, Indiranagar", area: "Indiranagar", city: "Bengaluru", postal: "560038" };
const DELHI = { label: "Delhi office", line1: "1 Janpath, Connaught Place", area: "Connaught Place", city: "New Delhi", postal: "110001" };
// Pets this suite owns on customer-b (added through the V2 account PetManager only when missing).
const DOG = "SvcDog", CAT = "SvcCat";
const PETS = [
  { name: DOG, species: "dog", breed: "Labrador Retriever", vaccinated: "yes", dose: "Rabies" },
  { name: CAT, species: "cat", breed: "Persian", vaccinated: "yes", dose: "FVRCP" },
];

// Dates inside WINDOWS.services (days from today, IST).
const D_MEET = isoDay(W_FROM + 1);          // Training Meet & Greet 16:00 + one-time 60-min walk 4 PM (double-booking probe)
const D_PROGRAMME = isoDay(W_FROM + 3);     // Puppy Training Plan, 4 sessions every 3 days (+3 +6 +9 → inside the window)
const D_RELO_DOMESTIC = isoDay(W_FROM + 7), D_RELO_INTL = isoDay(W_FROM + 14);
function firstMondayOffset(from, to) {
  for (let off = from; off <= to; off++) if (new Date(`${isoDay(off)}T12:00:00Z`).getUTCDay() === 1) return off;
  return from;
}
const D_WALK_WEEK = isoDay(firstMondayOffset(W_FROM + 5, W_TO - 7)); // Mon–Fri 7 AM inside the window

const summary = { suite: SUITE, base: BASE, mode: OTP_MODE ? "otp" : "persona", startedAt: new Date(STARTED).toISOString(), dates: { D_MEET, D_PROGRAMME, D_WALK_WEEK, D_RELO_DOMESTIC, D_RELO_INTL }, journeys: [], created: [] };
const created = { bookings: [], foodOrders: [], subscriptions: [], relocation: [] };
const ctx = { customerId: null, customerName: null, meetGreet: null, grooming: { packages: null } };

// ---------------------------------------------------------------------------------------------------------------
// utilities
const inr = (n) => (n == null || !Number.isFinite(Number(n)) ? String(n) : `₹${Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`);
const near = (a, b) => a != null && b != null && Math.abs(Number(a) - Number(b)) < 0.011;
const oneLine = (s, n = 400) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const timeLeft = () => BUDGET_MS - (Date.now() - STARTED);
async function mainText(page) { return (await page.locator("main").first().innerText({ timeout: 5000 }).catch(() => page.locator("body").innerText({ timeout: 5000 }).catch(() => ""))) || ""; }
async function alerts(page, scope = null) { return (await (scope || page).locator("[role=alert]").allInnerTexts().catch(() => [])).map(t => oneLine(t, 240)).filter(Boolean); }
async function robustClick(locator, timeout = 10_000) {
  try { await locator.click({ timeout }); return true; }
  catch { try { await locator.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {}); await locator.evaluate(el => el.click()); return true; } catch { return false; } }
}
async function waitGone(page, text, ms = 20_000) { await page.getByText(text).first().waitFor({ state: "detached", timeout: ms }).catch(() => {}); }
async function until(fn, ms = 20_000, every = 400, page = null) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const v = await fn().catch(() => null); if (v) return v; await (page ? page.waitForTimeout(every) : new Promise(r => setTimeout(r, every))); }
  return null;
}
const lastPost = (flow, path, pred = () => true) => [...flow.posts].reverse().find(p => p.path === path && pred(p)) || null;

const reported = new Set();
function reportFinding({ once = true, ...row }) {
  const key = row.title + (once ? "" : ` @ ${row.flow}`);
  if (reported.has(key)) return;
  reported.add(key);
  finding({ suite: SUITE, persona: row.persona || (OTP_MODE ? "run-scoped OTP customer-b" : "customer-b"), ...row });
}
function rec(journey, combo, result, detail, evidence = [], extra = {}) {
  record({ suite: SUITE, journey, combo, result, detail: oneLine(detail, 1800), evidence: evidence.filter(Boolean), ...extra });
  summary.journeys.push({ journey, combo, result });
}
function keep(row) {
  saveBooking({ suite: SUITE, customer: ctx.customerId || PERSONA, persona: PERSONA, ...row });
  summary.created.push(row);
}

// ---------------------------------------------------------------------------------------------------------------
// session (customer-b). A new sign-in as the same customer supersedes the older session (401): re-issue once.
let reissues = 0;
async function reauth(context, why) {
  reissues += 1;
  await customerSession(context, PERSONA);
  console.log(redact(`[${SUITE}] customer-b session re-issued (${why})`));
}
async function capi(context, method, path, data) {
  let r = await api(context, method, path, data).catch(e => ({ status: 0, body: String(e) }));
  if (r.status === 401 && reissues < 8) { await reauth(context, `${method} ${path.split("?")[0]} → 401`); r = await api(context, method, path, data).catch(e => ({ status: 0, body: String(e) })); }
  return r;
}
async function account(context) {
  const r = await capi(context, "GET", "/api/customer-account");
  return r.status === 200 ? r.body?.data || null : null;
}
async function checkoutStatus(context, bookingId) {
  const r = await capi(context, "POST", "/api/customer-checkout", { action: "status", bookingId });
  const d = r.body?.data || {}, c = d.confirmation || {};
  return { http: r.status, status: d.status, bookingStatus: c.bookingStatus, paymentStatus: c.paymentStatus, paymentMode: c.paymentMode, amountDueNow: c.amountDueNow, totalAmount: c.totalAmount, providerName: c.providerName, transactionId: c.transactionId || null, error: r.body?.error };
}
async function d1Payment(bookingId) {
  const pay = await d1("SELECT status,amount,amount_due_now,mode FROM booking_payments WHERE booking_id=?", [bookingId]);
  if (!Array.isArray(pay)) return { skipped: pay?.skipped || pay?.error || "d1 unavailable" };
  const booking = await d1("SELECT status,total_amount,package_code,service_code FROM canonical_bookings WHERE id=?", [bookingId]);
  const events = await d1("SELECT event_type,processing_status,amount_subunits FROM payment_gateway_events WHERE booking_id=? ORDER BY received_at", [bookingId]);
  return { payment: pay[0] || null, booking: Array.isArray(booking) ? booking[0] || null : booking, events: Array.isArray(events) ? events : [] };
}
const d1Brief = (db) => !db ? "d1: n/a" : db.skipped ? `d1: skipped (${db.skipped})` : `d1: booking=${db.booking?.status} payment=${db.payment?.status} amount=${db.payment?.amount} dueNow=${db.payment?.amount_due_now} mode=${db.payment?.mode} events=[${(db.events || []).map(e => `${e.event_type}/${e.processing_status}/${e.amount_subunits}`).join(",")}]`;

// ---------------------------------------------------------------------------------------------------------------
// journey wrapper: own browser context, own try/catch, always closed
let browser;
async function journey(name, combo, fn, { mobile = false, video = false, signIn = true } = {}) {
  if (timeLeft() < 60_000) { rec(name, combo, "SKIPPED", "suite time budget exhausted"); return null; }
  const flow = await newFlow(browser, `${SUITE}/${name}`, { mobile, video });
  flow.posts = [];
  flow.page.on("response", async (res) => {
    const req = res.request();
    if (req.method() !== "POST") return;
    const url = res.url();
    if (!url.startsWith(BASE) || !url.includes("/api/")) return;
    const path = url.replace(BASE, "").split("?")[0];
    if (path === "/api/customer-otp") return; // handled by the OTP journey itself (status/error only)
    let action = null; try { action = JSON.parse(req.postData() || "{}").action || null; } catch {}
    let body = null; try { body = await res.json(); } catch {}
    flow.posts.push({ path, http: res.status(), action, data: body?.data ?? null, error: body?.error ?? null, code: body?.code ?? null, at: Date.now() });
  });
  const t0 = Date.now();
  try {
    if (signIn) {
      const who = await customerSession(flow.context, PERSONA);
      if (who?.customerId) { ctx.customerId = who.customerId; ctx.customerName = who.name || ctx.customerName; }
    }
    const out = await fn(flow);
    return out;
  } catch (e) {
    const shot = await flow.shot("error").catch(() => null);
    const msg = String(e?.message || e);
    const harness = /harness:|Timeout|locator|waiting for|strict mode|Target closed|net::|refused: HTTP/i.test(msg);
    rec(name, combo, "BLOCKED", `${harness && !msg.startsWith("harness:") ? "harness: " : ""}${msg}`, [shot]);
    return null;
  } finally {
    summary.journeys.push({ name, ms: Date.now() - t0 });
    await flow.close();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// payment through the app's own checkout (Razorpay TEST on staging) and server-side verification
const CONFIRMED = ["confirmed", "assigned", "in_progress", "awaiting_host_acceptance", "provider_assigned"];
async function waitForCapture(flow, bookingId, timeoutMs) {
  const { page, context } = flow;
  const deadline = Date.now() + timeoutMs;
  let lastClick = 0, status = null, capturedAt = 0;
  while (Date.now() < deadline) {
    status = await checkoutStatus(context, bookingId);
    if (status.paymentStatus === "captured") { capturedAt = capturedAt || Date.now(); if (CONFIRMED.includes(String(status.bookingStatus)) || Date.now() - capturedAt > 30_000) break; }
    const check = page.getByRole("button", { name: /Check payment status|Check verified status|Retry booking confirmation|Refresh confirmation/ }).first();
    if (Date.now() - lastClick > 8000 && await check.isVisible().catch(() => false) && await check.isEnabled().catch(() => false)) { lastClick = Date.now(); await check.click({ timeout: 5000 }).catch(() => {}); }
    await page.waitForTimeout(3000);
  }
  const text = oneLine(await page.locator("body").innerText({ timeout: 3000 }).catch(() => ""), 3000);
  const uiText = oneLine((text.match(/(Payment verified[^.]*\.|Training programme confirmed|A lovely spa day is on its way\.|Your grooming visit is confirmed|Razorpay returned[^.]*\.|Waiting for signed[^.]*|Payment is verified, but[^.]*\.|Razorpay was closed[^.]*\.)/) || [""])[0], 200);
  return { server: status?.paymentStatus === "captured", final: status, uiText, waitedMs: timeoutMs - Math.max(0, deadline - Date.now()) };
}
/** Click the app's pay button, complete Razorpay TEST (Netbanking → Success) and read the server truth back. */
async function payWithApp(flow, bookingId, payButton, label) {
  const { page } = flow;
  const r = { shots: [], stage: "start" };
  const before = flow.posts.length;
  if (!(await payButton.isVisible().catch(() => false))) { r.stage = "no-pay-button"; r.shots.push(await flow.shot(`${label}-no-pay-button`)); return r; }
  r.payLabel = oneLine(await payButton.innerText().catch(() => ""), 80);
  await robustClick(payButton);
  const start = await until(async () => flow.posts.slice(before).find(p => p.action === "start"), 25_000, 300, page);
  await page.waitForTimeout(1500);
  r.start = start ? { http: start.http, path: start.path, status: start.data?.status, orderId: start.data?.razorpay_order_id || start.data?.orderId || null, amountPaise: start.data?.amountPaise, error: start.error } : null;
  r.alerts = await alerts(page);
  if (!start || start.http >= 400) {
    r.stage = "checkout-refused";
    r.envGated = start?.http === 503 && /not configured/i.test(`${start?.error} ${r.alerts.join(" ")}`);
    r.shots.push(await flow.shot(`${label}-checkout-refused`));
    return r;
  }
  if (start.data?.status === "nothing_due") { r.stage = "nothing-due"; r.shots.push(await flow.shot(`${label}-nothing-due`)); return r; }
  await page.waitForTimeout(2500);
  r.shots.push(await flow.shot(`${label}-razorpay-open`, { fullPage: false }));
  r.razorpay = await payRazorpayTestNetbanking(page);
  flow.note(`${label}: razorpay ${JSON.stringify(r.razorpay)}`);
  r.capture = await waitForCapture(flow, bookingId, r.razorpay?.ok ? 90_000 : 25_000);
  r.shots.push(await flow.shot(`${label}-after-payment`));
  r.db = await d1Payment(bookingId);
  r.stage = r.capture.server ? "captured" : "capture-pending";
  return r;
}
/** Result + findings for one payment attempt. expectDueNow in rupees. */
function judgePayment(r, { journeyName, combo, bookingId, expectDueNow, evidence, flowLabel }) {
  const ev = [...evidence, ...(r.shots || [])];
  if (r.stage === "checkout-refused") {
    if (r.envGated) return { result: "ENV-GATED", text: `checkout start HTTP ${r.start?.http} "${r.start?.error}" (Razorpay TEST not configured here)`, ev };
    reportFinding({ severity: "P1", area: "Payments", flow: flowLabel, title: `Checkout could not start for a new ${flowLabel} booking`, steps: `Create booking ${bookingId} → ${r.payLabel || "Pay securely"}`, expected: "Razorpay TEST checkout opens", actual: `start HTTP ${r.start?.http ?? "none"} ${r.start?.error || ""}; alerts: ${r.alerts?.join(" | ")}`, evidence: ev });
    return { result: "FAIL", text: `checkout start HTTP ${r.start?.http ?? "no request"} ${r.start?.error || ""} ${r.alerts?.join(" | ")}`, ev };
  }
  if (r.stage === "no-pay-button") return { result: "FAIL", text: "no pay button on the payment step", ev };
  if (r.stage === "nothing-due") return { result: "FAIL", text: "checkout answered nothing_due for an unpaid booking", ev };
  const order = r.start?.amountPaise;
  if (order != null && expectDueNow != null && Number(order) !== Math.round(expectDueNow * 100)) reportFinding({ severity: "P0", area: "Payments", flow: flowLabel, title: `Razorpay order amount differs from the amount due now (${flowLabel})`, steps: `Booking ${bookingId} → Pay`, expected: `${Math.round(expectDueNow * 100)} paise`, actual: `order ${r.start?.orderId} amountPaise=${order}`, evidence: ev });
  const text = `order ${r.start?.orderId} ${order} paise; razorpay ok=${r.razorpay?.ok}${r.razorpay?.error ? ` (${r.razorpay.error})` : ""}; server payment=${r.capture?.final?.paymentStatus} booking=${r.capture?.final?.bookingStatus} dueNow=${r.capture?.final?.amountDueNow} after ${Math.round((r.capture?.waitedMs || 0) / 1000)}s; UI "${r.capture?.uiText}"; ${d1Brief(r.db)}`;
  if (!r.razorpay?.ok) return { result: "BLOCKED", text: `harness: Razorpay TEST checkout not completed — ${text}`, ev };
  if (!r.capture?.server) {
    reportFinding({ severity: "P1", area: "Payments", flow: flowLabel, title: `Razorpay TEST payment succeeded but PawSpace never projected the capture (${flowLabel})`, steps: `Booking ${bookingId} → Pay → Razorpay TEST Netbanking → Success`, expected: "paymentStatus captured within 90 s", actual: text, evidence: ev });
    return { result: "FAIL", text, ev };
  }
  const confirmed = CONFIRMED.includes(String(r.capture.final?.bookingStatus));
  return { result: confirmed ? "PASS" : "PARTIAL", text: `${text}${confirmed ? "" : " (captured but booking not confirmed)"}`, ev };
}

// ---------------------------------------------------------------------------------------------------------------
// (1) OTP sign-in through the V2 UI with a NEW number, wrong code, sign out, returning sign-in
async function otpJourney(flow) {
  const { page, context } = flow;
  const otp = [];
  page.on("response", async (res) => {
    if (!res.url().includes("/api/customer-otp") || res.request().method() !== "POST") return;
    let action = null; try { action = JSON.parse(res.request().postData() || "{}").action || null; } catch {}
    let body = null; try { body = await res.json(); } catch {}
    otp.push({ action, http: res.status(), error: body?.error || null, existingCustomer: body?.data?.existingCustomer ?? null, sandbox: Boolean(body?.data?.sandboxCode) });
  });
  const ev = [];
  const dialog = page.getByRole("dialog", { name: "Sign in to PawSpace" });
  const readCode = async () => {
    const box = oneLine(await dialog.locator("[class*=sandboxCode] b").first().innerText({ timeout: 4000 }).catch(() => ""), 20);
    if (/^\d{6}$/.test(box)) return box;
    return ((await dialog.innerText().catch(() => "")).match(/Sandbox code[^\d]{0,80}(\d{6})/) || [])[1] || null;
  };
  const openModal = async () => {
    await page.goto(`${BASE}/v2`, { waitUntil: "domcontentloaded" });
    await dismissCookies(page); await settle(page, 800);
    await page.getByRole("button", { name: /^Sign in$/ }).first().click();
    await dialog.waitFor({ timeout: 10_000 });
  };
  const requestCode = async (phone) => {
    await dialog.getByLabel("Mobile number").fill(phone);
    await dialog.getByRole("button", { name: /Continue securely/ }).click();
    await dialog.getByLabel("Verification code").waitFor({ timeout: 20_000 });
    await settle(page, 400);
  };
  const submit = async () => {
    const n = otp.length;
    await dialog.getByRole("button", { name: /Open my PawSpace/ }).click();
    await until(async () => otp.length > n && otp[otp.length - 1].action === "verify", 20_000, 300, page);
    await page.waitForTimeout(800);
    return otp[otp.length - 1];
  };

  // new number
  await openModal();
  ev.push(await flow.shot("1-v2-home-signin-modal"));
  await dialog.getByLabel("Mobile number").fill("12345");
  await dialog.getByRole("button", { name: /Continue securely/ }).click();
  await page.waitForTimeout(600);
  const shortPhone = (await alerts(page, dialog)).join(" | ");
  await requestCode(OTP_PHONE);
  const req1 = otp.filter(o => o.action === "request").pop();
  const code = await readCode();
  const nameField = await dialog.getByLabel("Your name").isVisible().catch(() => false);
  ev.push(await flow.shot("2-code-step-sandbox-code-on-screen"));
  if (!code) { rec("otp-signin", `new number ${OTP_PHONE}`, "BLOCKED", `harness: no on-screen sandbox code (request HTTP ${req1?.http}, sandbox=${req1?.sandbox}); cannot sign in through the UI`, ev); return; }
  // wrong code
  const wrong = code === "111111" ? "222222" : "111111";
  await dialog.getByLabel("Verification code").fill(wrong);
  if (nameField) await dialog.getByLabel("Your name").fill(`Master OTP ${STAMP.slice(-6)}`);
  const bad = await submit();
  const badAlert = (await alerts(page, dialog)).join(" | ");
  ev.push(await flow.shot("3-wrong-code"));
  const wrongOk = bad?.http === 401 || bad?.http === 400;
  rec("otp-wrong-code", "wrong 6-digit code", wrongOk ? "PASS" : "FAIL", `verify HTTP ${bad?.http} error "${bad?.error}"; UI alert "${badAlert}" (earlier HTTP 500 was fixed to 401 locally — ${wrongOk ? `CONFIRMED FIXED ON ${ON}` : `500 STILL REPRODUCES ON ${ON}`})`, [ev[ev.length - 1]]);
  if (!wrongOk) reportFinding({ severity: "P2", area: "Customer OTP", flow: "/v2 Sign in → wrong code", title: `Wrong OTP answers HTTP ${bad?.http} instead of 401`, steps: `Sign in with ${OTP_PHONE}, enter a wrong 6-digit code`, expected: "401 'Incorrect OTP code'", actual: `HTTP ${bad?.http} ${bad?.error}; UI "${badAlert}"`, evidence: [ev[ev.length - 1]] });
  // correct code
  await dialog.getByLabel("Verification code").fill(code);
  const good = await submit();
  await dialog.waitFor({ state: "detached", timeout: 15_000 }).catch(() => {});
  await settle(page, 1200);
  ev.push(await flow.shot("4-signed-in-home"));
  const acct1 = (await api(context, "GET", "/api/customer-account")).body?.data || null;
  const signedIn = good?.http === 200 && acct1?.primaryPhone?.endsWith(OTP_PHONE.slice(-10));
  // sign out from /v2/account
  await page.goto(`${BASE}/v2/account`, { waitUntil: "domcontentloaded" });
  await waitGone(page, "Loading your account…", 20_000); await settle(page, 600);
  const acctPagePhone = await page.getByLabel("Verified mobile").inputValue({ timeout: 5000 }).catch(() => "");
  ev.push(await flow.shot("5-account-before-sign-out"));
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL(u => u.pathname === "/v2", { timeout: 15_000 }).catch(() => {});
  await settle(page, 800);
  const afterOut = await api(context, "GET", "/api/customer-account");
  const signInVisible = await page.getByRole("button", { name: /^Sign in$/ }).first().isVisible().catch(() => false);
  ev.push(await flow.shot("6-after-sign-out"));
  const signedOut = afterOut.status === 401 || afterOut.status === 403;
  // returning customer
  await openModal();
  await requestCode(OTP_PHONE);
  const req2 = otp.filter(o => o.action === "request").pop();
  const code2 = await readCode();
  const nameField2 = await dialog.getByLabel("Your name").isVisible().catch(() => false);
  ev.push(await flow.shot("7-returning-code-step"));
  let back = null;
  if (code2) { await dialog.getByLabel("Verification code").fill(code2); back = await submit(); await dialog.waitFor({ state: "detached", timeout: 15_000 }).catch(() => {}); await settle(page, 1000); }
  const acct2 = (await api(context, "GET", "/api/customer-account")).body?.data || null;
  ev.push(await flow.shot("8-returning-signed-in"));
  const returningOk = back?.http === 200 && acct2?.customerId && acct2.customerId === acct1?.customerId && !nameField2 && req2?.existingCustomer === true;
  const ok = signedIn && signedOut && returningOk;
  rec("otp-signin", `new number ${OTP_PHONE} → sign out → returning sign-in`, ok ? "PASS" : (signedIn ? "PARTIAL" : "FAIL"),
    `short phone "12345" → "${shortPhone}"; request HTTP ${req1?.http} existingCustomer=${req1?.existingCustomer} (name field shown=${nameField}) sandbox code on screen=${Boolean(code)}; verify HTTP ${good?.http}; account ${acct1?.customerId} phone ${acct1?.primaryPhone} (account page "${acctPagePhone}"); sign out → /api/customer-account HTTP ${afterOut.status}, Sign in button visible=${signInVisible}; returning request HTTP ${req2?.http} existingCustomer=${req2?.existingCustomer} name field shown=${nameField2}; verify HTTP ${back?.http} same customer=${acct2?.customerId === acct1?.customerId}`, ev);
  if (req1?.existingCustomer === true) flow.note("OTP number was already registered (re-run with the same run id) — the new-customer name step could not be exercised");
  if (signedIn && !signedOut) reportFinding({ severity: "P1", area: "Customer session", flow: "/v2/account Sign out", title: "Sign out leaves the customer session valid", steps: "Sign in with OTP → /v2/account → Sign out", expected: "/api/customer-account 401", actual: `HTTP ${afterOut.status}`, evidence: ev.slice(-3) });
}

// ---------------------------------------------------------------------------------------------------------------
// (2) /v2/account — profile, addresses (unserviceable PIN), pets
async function openAccount(flow) {
  const { page } = flow;
  await page.goto(`${BASE}/v2/account`, { waitUntil: "domcontentloaded" });
  await dismissCookies(page);
  await waitGone(page, "Loading your account…", 25_000);
  await settle(page, 600);
  if (await page.getByText("You are signed out.").isVisible().catch(() => false)) {
    await reauth(flow.context, "/v2/account signed out");
    await page.reload({ waitUntil: "domcontentloaded" }); await waitGone(page, "Loading your account…", 25_000); await settle(page, 600);
  }
  if (!(await page.getByRole("button", { name: "Save profile" }).isVisible().catch(() => false))) throw new Error("harness: /v2/account did not load signed in");
}
async function saveAddress(flow, a) {
  const { page } = flow;
  const form = page.locator("form").filter({ has: page.locator("input[name=line1]") }).first();
  await form.locator("input[name=label]").fill(a.label);
  await form.locator("input[name=line1]").fill(a.line1);
  await form.locator("input[name=area]").fill(a.area);
  await form.locator("input[name=city]").fill(a.city);
  await form.locator("input[name=postal]").fill(a.postal);
  const before = flow.posts.length;
  await form.getByRole("button", { name: /Save address/ }).click();
  const post = await until(async () => flow.posts.slice(before).find(p => p.path === "/api/customer-account"), 20_000, 300, page);
  await settle(page, 800);
  const status = oneLine(await page.locator("[role=status]").first().innerText({ timeout: 1500 }).catch(() => ""), 200);
  const alert = (await alerts(page)).join(" | ");
  return { http: post?.http ?? null, error: post?.error || null, status, alert };
}
async function addPets(flow, missing) {
  const { page } = flow;
  const added = [], issues = [], shots = [];
  for (const p of missing) {
    await page.getByRole("button", { name: /Add pet/ }).first().click();
    const form = page.locator("[class*=form]").filter({ has: page.getByPlaceholder("Pet name") }).first();
    await form.getByPlaceholder("Pet name").waitFor({ timeout: 10_000 });
    await form.getByPlaceholder("Pet name").fill(p.name);
    await form.getByLabel("Species").selectOption(p.species);
    await form.getByPlaceholder("Start typing a breed").fill(p.breed);
    for (const [label, index] of [[/^Age/, 3], [/^Weight/, 2], [/^Temperament/, 1]]) {
      const sel = form.locator("label").filter({ hasText: label }).locator("select").first();
      const n = await sel.locator("option").count();
      await sel.selectOption({ index: Math.min(index, n - 1) });
    }
    await form.locator("label").filter({ hasText: /^Vaccinated\?/ }).locator("select").selectOption(p.vaccinated);
    if (p.dose) await form.getByPlaceholder("e.g. Rabies / DHPPi").fill(p.dose).catch(() => {});
    shots.push(await flow.shot(`add-${p.name}-form`));
    await form.getByRole("button", { name: "Add pet", exact: true }).click();
    await page.getByRole("button", { name: /Saving…/ }).waitFor({ state: "detached", timeout: 20_000 }).catch(() => {});
    await settle(page, 800);
    const alert = oneLine(await page.locator("ul[role=alert]").first().innerText({ timeout: 1000 }).catch(() => ""), 300);
    if (alert) { issues.push(`${p.name}: ${alert}`); await page.getByRole("button", { name: "Cancel" }).first().click().catch(() => {}); } else added.push(p.name);
  }
  return { added, issues, shots };
}
async function accountJourney(flow) {
  const { page, context } = flow;
  await openAccount(flow);
  const ev = [await flow.shot("1-account")];
  // profile: keep the name, set a run-scoped synthetic email
  const email = `master.e2e.svc.${STAMP}@example.com`;
  const name = oneLine(await page.getByLabel("Name", { exact: true }).inputValue().catch(() => ""), 60) || (OTP_MODE ? "Master E2E B" : "UAT Audit Customer B");
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByLabel("Email").fill(email);
  const before = flow.posts.length;
  await page.getByRole("button", { name: "Save profile" }).click();
  const post = await until(async () => flow.posts.slice(before).find(p => p.path === "/api/customer-account"), 20_000, 300, page);
  await settle(page, 800);
  const msg = oneLine(await page.locator("[role=status]").first().innerText({ timeout: 2000 }).catch(() => ""), 120);
  ev.push(await flow.shot("2-profile-saved"));
  const after = await account(context);
  const profileOk = post?.http < 300 && after?.email === email.toLowerCase() && after?.name === name;
  rec("account-profile", "save name + email", profileOk ? "PASS" : "FAIL", `POST /api/customer-account HTTP ${post?.http} ${post?.error || ""}; UI "${msg}"; API after: name "${after?.name}" email "${after?.email}"`, ev.slice(-1));
  if (!profileOk && post?.http >= 400) reportFinding({ severity: "P1", area: "Account", flow: "/v2/account Save profile", title: "Profile update refused", steps: "Account → edit email → Save profile", expected: "Profile updated", actual: `HTTP ${post?.http} ${post?.error}; UI "${msg}"`, evidence: ev.slice(-1) });

  // unserviceable PIN (ACC-01 re-check)
  const zone110001 = await capi(context, "GET", "/api/service-zone?pincode=110001");
  const delhi = await saveAddress(flow, DELHI);
  ev.push(await flow.shot("3-address-110001"));
  const acctDelhi = await account(context);
  const savedDelhi = (acctDelhi?.addresses || []).find(a => a.postalCode === "110001");
  const serviceable = zone110001.body?.data?.zone?.serviceAvailable === true;
  const accepted = Boolean(savedDelhi);
  rec("account-address-unserviceable", "PIN 110001 (New Delhi)", accepted ? "FAIL" : "PASS", `service-zone 110001 HTTP ${zone110001.status} serviceAvailable=${zone110001.body?.data?.zone?.serviceAvailable} (${oneLine(zone110001.body?.error || "", 120)}); save HTTP ${delhi.http} "${delhi.status || delhi.alert}"; stored=${accepted}${savedDelhi ? ` isDefault=${savedDelhi.isDefault}` : ""} → ACC-01 ${accepted ? `CONFIRMED-ON-${ON}` : `NOT-REPRODUCED-ON-${ON}`}`, ev.slice(-1));
  if (accepted && !serviceable) reportFinding({ severity: "P2", area: "Account / addresses", flow: "/v2/account Saved places", title: `Unserviceable address (New Delhi 110001) accepted and saved as default (ACC-01 — CONFIRMED-ON-${ON})`, steps: "Account → Add default address → New Delhi, PIN 110001 → Save address", expected: "Refused or flagged as outside the service area", actual: `Saved (isDefault=${savedDelhi.isDefault}); /api/service-zone?pincode=110001 serviceAvailable=${zone110001.body?.data?.zone?.serviceAvailable}`, evidence: ev.slice(-1) });

  // serviceable default address (Training/Grooming use the default saved address)
  const home = await saveAddress(flow, HOME);
  const acctHome = await account(context);
  const def = (acctHome?.addresses || []).find(a => a.isDefault);
  ev.push(await flow.shot("4-address-560038-default"));
  const homeOk = def?.postalCode === HOME.postal;
  rec("account-address-default", "Indiranagar 560038 as default", homeOk ? "PASS" : "FAIL", `save HTTP ${home.http} "${home.status || home.alert}"; default now ${def ? `${def.label}: ${def.line1}, ${def.postalCode}` : "none"}; ${acctHome?.addresses?.length ?? 0} saved address(es)`, ev.slice(-1));

  // pets (dog + cat)
  const existing = acctHome?.pets || [];
  const missing = PETS.filter(p => !existing.some(e => e.name === p.name));
  const res = await addPets(flow, missing);
  await page.reload({ waitUntil: "domcontentloaded" }); await waitGone(page, "Loading your account…", 20_000); await settle(page, 800);
  ev.push(await flow.shot("5-account-pets"));
  const pets = (await account(context))?.pets || [];
  const check = PETS.map(p => { const e = pets.find(x => x.name === p.name); return `${p.name}=${e ? `${e.species}/${e.vaccinationStatus}` : "MISSING"}`; });
  const petsOk = PETS.every(p => pets.some(x => x.name === p.name && x.species === p.species));
  rec("account-pets", "dog SvcDog + cat SvcCat", petsOk ? "PASS" : "FAIL", `added via PetManager: [${res.added.join(", ") || "none — already present"}]; issues: [${res.issues.join("; ")}]; API: ${check.join(", ")}`, [...res.shots, ev[ev.length - 1]]);
  if (res.issues.length) reportFinding({ severity: "P1", area: "Account / pets", flow: "/v2/account PetManager", title: "Adding a pet from V2 account failed", steps: "Account → Pets → + Add pet → fill → Add pet", expected: "Pet saved", actual: res.issues.join("; "), evidence: res.shots });
}

// ---------------------------------------------------------------------------------------------------------------
// (3) Grooming
async function groomingJourney(flow) {
  const { page, context } = flow;
  const cat = await capi(context, "GET", "/api/v2/grooming-catalogue");
  const pkgs = Array.isArray(cat.body?.data?.packages) ? cat.body.data.packages : [];
  ctx.grooming.packages = pkgs.length;
  await page.goto(`${BASE}/v2/grooming`, { waitUntil: "domcontentloaded" });
  await dismissCookies(page);
  await waitGone(page, "Preparing a beautiful grooming experience…", 30_000);
  await settle(page, 1000);
  const ev = [await flow.shot("1-grooming-page")];
  const fatal = await page.getByText("We can’t begin this booking yet.").isVisible().catch(() => false);
  if (fatal) {
    const why = oneLine(await mainText(page), 300);
    rec("grooming-catalogue", "open /v2/grooming", "FAIL", `error page: ${why}; catalogue API HTTP ${cat.status} packages=${pkgs.length}`, ev);
    return;
  }
  // pet: SvcDog only
  const petCards = page.locator("[class*=petGrid] button[aria-pressed]");
  await petCards.first().waitFor({ timeout: 15_000 });
  const dogCard = petCards.filter({ has: page.locator("b", { hasText: new RegExp(`^${DOG}$`) }) }).first();
  if (await dogCard.count()) { if ((await dogCard.getAttribute("aria-pressed")) !== "true") await dogCard.click(); }
  for (let i = 0; i < await petCards.count(); i++) {
    const b = petCards.nth(i), nm = oneLine(await b.locator("b").first().innerText().catch(() => ""), 40);
    if (nm !== DOG && (await b.getAttribute("aria-pressed")) === "true") await b.click();
  }
  await settle(page, 500);
  const packageButtons = page.locator("[class*=packageGrid] button");
  const packageCount = await packageButtons.count();
  const emptyText = await page.getByText("No published package supports this pet selection yet.").isVisible().catch(() => false);
  const coupon = await page.locator("input[placeholder*=oupon i], input[name*=oupon i], [aria-label*=oupon i]").count();
  ev.push(await flow.shot("2-grooming-packages-for-dog"));
  const dogPkgs = pkgs.filter(p => p.audience === "dog");
  rec("grooming-catalogue", "published packages for a dog", packageCount ? "PASS" : "FAIL", `GET /api/v2/grooming-catalogue HTTP ${cat.status}: ${pkgs.length} published package(s) (${dogPkgs.length} dog): ${pkgs.slice(0, 8).map(p => `${p.code || p.name}`).join(", ") || "none"}; UI package cards=${packageCount}; empty-state shown=${emptyText} → SVC-GRM-01 ${packageCount ? `NOT-REPRODUCED-ON-${ON}` : `CONFIRMED-ON-${ON}`}`, ev.slice(-1));
  rec("grooming-coupons", "WELCOME / UATCARE100 entry on V2 grooming", "PARTIAL", `coupon inputs on /v2/grooming: ${coupon} → SVC-OBS-01 (no coupon entry in V2) ${coupon ? `NOT-REPRODUCED-ON-${ON}` : `CONFIRMED-ON-${ON}`}; add-ons: V2 grooming offers package bundles only (no add-on controls in app/v2/grooming/page.tsx)`, ev.slice(-1));
  if (!coupon) reportFinding({ severity: "OBS", area: "Coupons", flow: "/v2/grooming", title: "No coupon entry in V2 Grooming/Training (WELCOME / UATCARE100 cannot be applied)", steps: "Open /v2/grooming and /v2/training", expected: "Coupon entry if coupons are offered", actual: "No coupon input on the V2 pages", evidence: ev.slice(-1) });
  if (!packageCount) {
    reportFinding({ severity: "P1", area: "Grooming (V2)", flow: "/v2/grooming catalogue", title: `V2 Grooming has no published package, so no grooming booking is possible (SVC-GRM-01 — CONFIRMED-ON-${ON})`, steps: "Sign in, add a dog, open /v2/grooming", expected: "Published grooming packages selectable", actual: `GET /api/v2/grooming-catalogue → ${pkgs.length} packages; UI "No published package supports this pet selection yet."`, evidence: ev.slice(-1) });
    rec("grooming-booking", "package + slot + groomer + Razorpay TEST", "BLOCKED", `no published grooming package on ${ON} (this suite never publishes Pricing Control packages)`, ev.slice(-1));
    return;
  }
  // package (first card), doorstep from the saved default address
  await robustClick(packageButtons.first());
  const pkgText = oneLine(await packageButtons.first().innerText().catch(() => ""), 200);
  const saved = page.getByLabel("Saved service address");
  if (await saved.isVisible().catch(() => false)) {
    const options = await saved.locator("option").allInnerTexts();
    const pick = options.find(o => /560038|Indiranagar/.test(o) && /default/i.test(o)) || options.find(o => /Indiranagar/.test(o));
    if (pick) await saved.selectOption({ label: pick }).catch(() => {});
  }
  const pin = page.getByPlaceholder("560102");
  if ((await pin.inputValue().catch(() => "")) !== HOME.postal) { await page.getByPlaceholder("e.g. 21, 18th Main, HSR Layout").fill(`${HOME.line1}, ${HOME.city}`); await pin.fill(HOME.postal); }
  await robustClick(page.getByRole("button", { name: /Check service area/ }));
  await until(async () => (await page.getByText(/is covered/).first().isVisible()) || (await page.locator("[class*=inlineError][role=alert]").first().isVisible()), 20_000, 400, page);
  const coverage = oneLine(await page.locator("[class*=coverageSuccess]").first().innerText({ timeout: 1500 }).catch(() => ""), 160);
  // date: the last day the strip offers (the strip only offers the next 14 days — outside WINDOWS.services by design)
  const dateButtons = page.locator("[class*=dateStrip] button");
  const nDates = await dateButtons.count();
  let providers = 0, tried = [], providerError = "";
  for (let d = nDates - 1; d >= Math.max(0, nDates - 3) && !providers; d--) {
    await robustClick(dateButtons.nth(d));
    await settle(page, 300);
    const slots = page.locator("[class*=slotGrid] button:not([disabled])");
    for (let s = 0; s < Math.min(await slots.count(), 3) && !providers; s++) {
      await robustClick(slots.nth(s));
      const live = page.getByRole("button", { name: /Check live price & groomers/ });
      await robustClick(live);
      await until(async () => !(await page.getByRole("button", { name: /Checking PawSpace live…/ }).isVisible()), 45_000, 500, page);
      await settle(page, 600);
      providers = await page.locator("[class*=providerGrid] button").count();
      providerError = oneLine(await page.locator("[class*=inlineError]").last().innerText({ timeout: 800 }).catch(() => ""), 200);
      tried.push(`${oneLine(await dateButtons.nth(d).innerText(), 20)} slot${s + 1}: ${providers} groomer(s)${providerError ? ` "${providerError}"` : ""}`);
    }
  }
  ev.push(await flow.shot("3-grooming-slot-groomers"));
  if (!providers) { rec("grooming-booking", "package + slot + groomer", "FAIL", `package "${pkgText}"; coverage "${coverage}"; no groomer for tried slots: ${tried.join(" · ")}`, ev.slice(-1)); return; }
  const provider = page.locator("[class*=providerGrid] button").first();
  await robustClick(provider);
  const providerName = oneLine(await provider.locator("b").first().innerText().catch(() => ""), 60);
  const priceBlock = oneLine(await page.locator("[class*=priceBlock]").first().innerText().catch(() => ""), 160);
  const summaryText = oneLine(await page.locator("aside").first().innerText().catch(() => ""), 500);
  const when = (summaryText.match(/When\s+(.+?)\s+Groomer/) || [])[1] || "";
  ev.push(await flow.shot("4-grooming-summary"));
  const reserve = page.getByRole("button", { name: /Reserve & review payment/ });
  if (!(await reserve.isEnabled().catch(() => false))) { rec("grooming-booking", "reserve", "FAIL", `"Reserve & review payment" disabled; ${summaryText}`, ev.slice(-1)); return; }
  await robustClick(reserve);
  await page.waitForURL(/bookingId=/, { timeout: 45_000 }).catch(() => {});
  await settle(page, 1500);
  const bookingId = decodeURIComponent((page.url().match(/bookingId=([^&]+)/) || [])[1] || "") || null;
  const alert = (await alerts(page)).join(" | ");
  ev.push(await flow.shot("5-grooming-checkout"));
  if (!bookingId) { rec("grooming-booking", "reserve", "FAIL", `no booking reference after reserve; alerts "${alert}"`, ev.slice(-1)); return; }
  const st0 = await checkoutStatus(context, bookingId);
  const rowBase = { bookingId, service: "grooming", packageCode: pkgs[0]?.code || null, providerId: null, providerName, scheduledStart: when, total: st0.totalAmount, dueNow: st0.amountDueNow, paymentMode: st0.paymentMode };
  keep({ ...rowBase, paid: false });
  created.bookings.push({ id: bookingId, service: "grooming" });
  // the panel may ask to verify the doorstep before payment
  const doorstep = page.getByRole("button", { name: "Save verified doorstep" });
  if (await doorstep.isVisible().catch(() => false)) { await robustClick(doorstep); await settle(page, 2500); }
  const payBtn = page.getByRole("button", { name: /Pay securely with Razorpay/ });
  await until(async () => payBtn.isEnabled(), 20_000, 500, page);
  const pay = await payWithApp(flow, bookingId, payBtn, "6-grooming");
  const j = judgePayment(pay, { journeyName: "grooming-booking", combo: "grooming", bookingId, expectDueNow: st0.amountDueNow, evidence: ev, flowLabel: "/v2/grooming" });
  if (pay.capture?.server) keep({ ...rowBase, paid: true, paymentStatus: "captured" });
  rec("grooming-booking", `package "${pkgText.slice(0, 60)}" + ${when} + groomer ${providerName} + Razorpay TEST`, j.result, `booking ${bookingId}; package ${pkgText}; live price ${priceBlock}; coverage "${coverage}"; groomer ${providerName}; total ${inr(st0.totalAmount)} due now ${inr(st0.amountDueNow)} (${st0.paymentMode}); slot outside WINDOWS.services because the V2 date strip offers only the next 14 days; ${j.text}`, j.ev);
}

// ---------------------------------------------------------------------------------------------------------------
// (4) Training
async function openTraining(flow) {
  const { page } = flow;
  await page.goto(`${BASE}/v2/training`, { waitUntil: "domcontentloaded" });
  await dismissCookies(page);
  await waitGone(page, "Loading your pets…", 25_000);
  await waitGone(page, "Confirming your training zone…", 25_000);
  await waitGone(page, "Loading canonical Training catalogue…", 25_000);
  await settle(page, 800);
}
async function runTraining(flow, { pkg, date, time, mode, cadence, label }) {
  const { page } = flow;
  const r = { shots: [] };
  await openTraining(flow);
  const dogs = page.locator('[aria-labelledby="training-dogs-label"] button[aria-pressed]');
  await dogs.first().waitFor({ timeout: 20_000 }).catch(() => {});
  const nDogs = await dogs.count();
  if (!nDogs) { r.error = `harness: no dog buttons on /v2/training (${oneLine(await mainText(page), 300)})`; return r; }
  for (let i = 0; i < nDogs; i++) {
    const b = dogs.nth(i), nm = oneLine(await b.locator("strong").first().innerText().catch(() => ""), 40);
    const pressed = (await b.getAttribute("aria-pressed")) === "true";
    if ((nm === DOG) !== pressed) await b.click();
  }
  await page.getByLabel("First session date").fill(date);
  await page.getByLabel("First session time (IST)").fill(time);
  await robustClick(page.locator("button[aria-pressed]").filter({ hasText: pkg }).first());
  if (mode) await page.getByLabel("Payment mode").selectOption(mode).catch(e => { r.modeError = oneLine(String(e), 120); });
  if (cadence) await page.getByLabel("Days between sessions").selectOption(String(cadence)).catch(e => { r.cadenceError = oneLine(String(e), 120); });
  await settle(page, 1200);
  const cta = page.getByRole("button", { name: /Reserve trainer & continue to payment/ });
  await until(async () => (await cta.isEnabled()) && !(await page.getByText("Checking availability for every programme session...").isVisible()), 45_000, 600, page);
  await settle(page, 800);
  const sticky = page.locator("section").filter({ has: cta }).last();
  r.sticky = oneLine(await sticky.innerText().catch(() => ""), 300);
  r.trainers = oneLine(await page.locator("section").filter({ hasText: "3. Available trainer" }).first().innerText().catch(() => ""), 400);
  r.calendar = oneLine(await page.locator("[aria-label='Proposed training calendar']").innerText().catch(() => ""), 600);
  const q = lastPost(flow, "/api/training-commercial", p => p.http === 200 && p.data?.totalAmount != null);
  r.quote = q?.data ? { packageCode: q.data.packageCode, packageName: q.data.packageName, totalAmount: q.data.totalAmount, amountDueNow: q.data.amountDueNow, sessions: q.data.sessions, minutesPerSession: q.data.minutesPerSession, paymentMode: q.data.paymentMode } : null;
  r.pageAlerts = await alerts(page);
  r.shots.push(await flow.shot(`${label}-1-form-priced`));
  if (!(await cta.isEnabled().catch(() => false))) { r.stage = "cta-disabled"; return r; }
  const before = flow.posts.length;
  await robustClick(cta);
  await until(async () => (await page.getByText(/Booking reference:/).first().isVisible()) || (await page.locator("[role=alert]").first().isVisible()), 60_000, 500, page);
  await waitGone(page, "Reserving trainer…", 30_000);
  await settle(page, 1500);
  const text = await mainText(page);
  r.bookingId = (text.match(/Booking reference:\s*(PS-[A-Z0-9-]+)/) || [])[1] || flow.posts.slice(before).map(p => p.data?.bookingId).find(Boolean) || null;
  const sched = flow.posts.slice(before).find(p => p.path === "/api/uat-scheduling");
  r.scheduling = sched ? { http: sched.http, error: sched.error, provider: sched.data?.provider?.name || sched.data?.provider?.id || null, providerId: sched.data?.provider?.id || null } : null;
  r.reserved = oneLine((text.match(/Trainer:[^\n]*/) || [""])[0], 160);
  r.first = oneLine((text.match(/First session:[^\n]*/) || [""])[0], 160);
  r.afterAlerts = await alerts(page);
  r.paymentPanel = oneLine(await page.locator('section[aria-label$=" payment"]').first().innerText({ timeout: 3000 }).catch(() => ""), 400);
  r.shots.push(await flow.shot(`${label}-2-reserved-payment-step`));
  r.stage = r.bookingId ? "reserved" : "reserve-failed";
  return r;
}
async function trainingJourney(flow, { name, combo, pkg, date, time, mode, cadence, expectTotal, expectDueNow }) {
  const { page, context } = flow;
  const r = await runTraining(flow, { pkg, date, time, mode, cadence, label: name.replace(/^training-/, "") });
  if (r.error) throw new Error(r.error);
  const priced = r.quote ? `quote ${r.quote.packageName} ${inr(r.quote.totalAmount)} due now ${inr(r.quote.amountDueNow)} (${r.quote.paymentMode || mode || "prepaid"}), ${r.quote.sessions} session(s) × ${r.quote.minutesPerSession} min` : `no quote captured; sticky "${r.sticky}"`;
  const priceOk = r.quote && near(r.quote.totalAmount, expectTotal) && near(r.quote.amountDueNow, expectDueNow);
  if (r.quote && !priceOk) reportFinding({ severity: "P1", area: "Training pricing", flow: `/v2/training ${pkg}`, title: `${pkg} quote differs from the published programme price`, steps: `Choose ${pkg}${mode ? ` (${mode})` : ""}`, expected: `${inr(expectTotal)} total, ${inr(expectDueNow)} due now`, actual: priced, evidence: r.shots });
  if (r.stage !== "reserved") {
    rec(name, combo, "FAIL", `${priced}; ${r.stage}; trainers "${r.trainers}"; alerts ${JSON.stringify([...(r.pageAlerts || []), ...(r.afterAlerts || [])])}; scheduling ${JSON.stringify(r.scheduling)}`, r.shots);
    return { r };
  }
  created.bookings.push({ id: r.bookingId, service: "dog_training", pkg });
  const st0 = await checkoutStatus(context, r.bookingId);
  const rowBase = { bookingId: r.bookingId, service: "dog_training", packageCode: r.quote?.packageCode || null, providerId: r.scheduling?.providerId || null, providerName: r.scheduling?.provider || null, scheduledStart: `${date}T${time}:00+05:30`, total: st0.totalAmount ?? r.quote?.totalAmount, dueNow: st0.amountDueNow ?? r.quote?.amountDueNow, paymentMode: st0.paymentMode || mode || "prepaid", pets: [DOG] };
  keep({ ...rowBase, paid: false });
  const pay = await payWithApp(flow, r.bookingId, page.getByRole("button", { name: /Pay securely/ }).first(), `${name.replace(/^training-/, "")}-3`);
  const j = judgePayment(pay, { journeyName: name, combo, bookingId: r.bookingId, expectDueNow: rowBase.dueNow, evidence: r.shots, flowLabel: `/v2/training ${pkg}` });
  if (pay.capture?.server) keep({ ...rowBase, paid: true, paymentStatus: "captured" });
  const result = priceOk ? j.result : (j.result === "PASS" ? "PARTIAL" : j.result);
  rec(name, combo, result, `booking ${r.bookingId}; ${priced} (expected ${inr(expectTotal)} / ${inr(expectDueNow)} due now); ${r.reserved}; ${r.first}; calendar "${r.calendar.slice(0, 240)}"; payment step "${r.paymentPanel.slice(0, 160)}"; ${j.text}`, j.ev);
  return { r, pay, rowBase };
}
async function readBookingPage(flow, bookingId, label) {
  const { page } = flow;
  await page.goto(`${BASE}/v2/booking?bookingId=${encodeURIComponent(bookingId)}`, { waitUntil: "domcontentloaded" });
  await waitGone(page, "Loading your booking…", 25_000);
  await settle(page, 1500);
  const text = oneLine(await mainText(page), 2000);
  const manageHref = await page.getByRole("link", { name: "Manage service" }).getAttribute("href", { timeout: 2000 }).catch(() => null);
  const shot = await flow.shot(label);
  return { text, shot, manageHref, status: (text.match(/Status: ([a-z_ ]+?)(?= \d| ·|$)/i) || [])[1] || null, payment: (text.match(/Payment: ([a-z_ ]+?)(?= Manage| Refresh|$)/i) || [])[1] || null, payButton: /Pay securely/.test(text) };
}

// ---------------------------------------------------------------------------------------------------------------
// (5) Dog Walking
async function verifyWalkAddress(flow) {
  const { page } = flow;
  const line1 = page.locator("#grooming-address-line-1");
  await line1.waitFor({ timeout: 15_000 });
  const scope = page.locator("fieldset").filter({ has: line1 }).first();
  const suggestions = page.locator('section[aria-label="Google address suggestions"] button');
  const available = scope.getByText("✓ Available");
  const alert = scope.locator("[role=alert]").first();
  const verify = scope.getByRole("button", { name: "Verify service address" });
  const settled = async (ms) => until(async () => (await available.isVisible()) ? "resolved" : (await suggestions.first().isVisible()) ? "suggestions" : (await alert.isVisible()) ? "alert" : null, ms, 400, page);
  await line1.fill(ADDRESS_QUERY);
  let state = await settled(20_000), path = "none";
  if (state === "suggestions") { path = "google-suggestion"; await robustClick(suggestions.first()); state = await until(async () => (await available.isVisible()) ? "resolved" : (await alert.isVisible()) ? "alert" : null, 20_000, 400, page); }
  if (state !== "resolved") {
    path = "typed-verify";
    await line1.fill(`${ADDRESS_QUERY} ${HOME.postal}`);
    await settled(8000);
    if (!(await available.isVisible().catch(() => false))) {
      await until(async () => verify.isEnabled(), 10_000, 400, page);
      if (await verify.isEnabled().catch(() => false)) await robustClick(verify);
      state = await until(async () => (await available.isVisible()) ? "resolved" : (await alert.isVisible()) ? "alert" : null, 20_000, 400, page);
    } else state = "resolved";
  }
  return { ok: state === "resolved", path, caption: oneLine(await scope.locator("[class*=locationLine]").first().innerText({ timeout: 1500 }).catch(() => ""), 200), alert: oneLine(await alert.innerText({ timeout: 800 }).catch(() => ""), 200) };
}
async function runWalking(flow, { type, duration, days, slot, start, label }) {
  const { page } = flow;
  const r = { shots: [] };
  await page.goto(`${BASE}/v2/walking`, { waitUntil: "domcontentloaded" });
  await dismissCookies(page);
  await settle(page, 1500);
  await robustClick(page.getByRole("button", { name: type === "once" ? "One-time walk" : "Recurring starter schedule" }));
  const petSel = page.getByLabel("Pet", { exact: true });
  await until(async () => (await petSel.locator("option").count()) > 1, 20_000, 400, page);
  const options = await petSel.locator("option").allInnerTexts();
  const opt = options.find(o => o.startsWith(DOG));
  if (!opt) { r.error = `harness: ${DOG} not offered in the Walking pet list (${options.join(", ")})`; return r; }
  await petSel.selectOption({ label: opt });
  await page.getByLabel("Walk duration").selectOption(String(duration));
  r.address = await verifyWalkAddress(flow);
  await page.getByLabel("Start from").fill(start);
  if (days) {
    const want = days.map(d => d.toLowerCase());
    for (const d of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]) {
      const b = page.getByRole("button", { name: d, exact: true });
      const on = /active/.test((await b.getAttribute("class").catch(() => "")) || "");
      if (on !== want.includes(d.toLowerCase())) { await robustClick(b); await page.waitForTimeout(250); }
    }
  }
  await robustClick(page.getByRole("button", { name: new RegExp(`^${esc(slot)}`) }));
  await page.getByLabel("Walking & safety instructions").fill("Harness only; avoid other dogs near the park gate. Master E2E synthetic booking.");
  await page.getByLabel("Handover preference").selectOption("owner");
  await settle(page, 1500);
  await waitGone(page, "Refreshing canonical quote…", 20_000);
  const summaryBox = page.locator("aside[aria-label='Walking order summary']");
  await summaryBox.locator("summary").click({ timeout: 3000 }).catch(() => {});
  r.summary = oneLine(await summaryBox.innerText().catch(() => ""), 400);
  const q = lastPost(flow, "/api/walking-commercial", p => p.http === 200 && p.data?.totalAmount != null);
  r.quote = q?.data ? { packageCode: q.data.packageCode, walkCount: q.data.walkCount, perWalkAmount: q.data.perWalkAmount, totalAmount: q.data.totalAmount, amountDueNow: q.data.amountDueNow, weekdays: q.data.weekdays, scheduledStart: q.data.scheduledStart } : null;
  r.pageAlerts = await alerts(page);
  r.shots.push(await flow.shot(`${label}-1-walking-form`));
  const cta = page.getByRole("button", { name: /Reserve walks/ });
  if (!(await cta.isEnabled().catch(() => false))) { r.stage = "cta-disabled"; return r; }
  const before = flow.posts.length;
  await robustClick(cta);
  await until(async () => (await page.getByRole("link", { name: "Manage walks" }).isVisible()) || flow.posts.slice(before).some(p => p.http >= 400) || (await page.locator("[class*=bookingError]").first().isVisible()), 60_000, 500, page);
  await waitGone(page, "Reserving canonical walks…", 20_000);
  await settle(page, 1500);
  const wb = flow.posts.slice(before).find(p => p.path === "/api/walking-bookings");
  const sched = flow.posts.slice(before).find(p => p.path === "/api/uat-scheduling");
  const text = await mainText(page);
  r.bookingId = wb?.data?.bookingId || (text.match(/(PS-[A-Z0-9-]*WALK[A-Z0-9-]*)/) || [])[1] || null;
  r.scheduling = sched ? { http: sched.http, error: sched.error, code: sched.code, provider: sched.data?.provider?.name || null, providerId: sched.data?.provider?.id || null } : null;
  r.booking = wb ? { http: wb.http, error: wb.error, total: wb.data?.totalAmount, sessions: wb.data?.sessions?.length } : null;
  r.bookingError = oneLine(await page.locator("[class*=bookingError]").first().innerText({ timeout: 800 }).catch(() => ""), 300) || (await alerts(page)).join(" | ");
  r.confirmed = oneLine(text, 600);
  r.manageHref = await page.getByRole("link", { name: "Manage walks" }).getAttribute("href", { timeout: 1500 }).catch(() => null);
  r.shots.push(await flow.shot(`${label}-2-after-reserve`));
  r.stage = r.bookingId ? "booked" : "refused";
  return r;
}
async function walkingManage(flow, r, label) {
  const { page } = flow;
  if (!r.manageHref) return null;
  await page.goto(`${BASE}${r.manageHref}`, { waitUntil: "domcontentloaded" });
  await settle(page, 3000);
  const text = oneLine(await mainText(page), 1500);
  const shot = await flow.shot(`${label}-3-manage-walks`);
  return { text, shot, liveTooEarly: /walker is on the way|LIVE WALK/i.test(text) };
}
function walkPriceCheck(r, count, perWalk) {
  const q = r.quote;
  if (!q) return { ok: false, text: `no quote captured; summary "${r.summary}"` };
  const ok = Number(q.walkCount) === count && near(q.perWalkAmount, perWalk) && near(q.totalAmount, count * perWalk);
  return { ok, text: `quote ${q.packageCode} ${q.walkCount} × ${inr(q.perWalkAmount)} = ${inr(q.totalAmount)}, due now ${inr(q.amountDueNow)} (expected ${count} × ${inr(perWalk)} = ${inr(count * perWalk)}); weekdays [${q.weekdays}]` };
}
async function walkingWeekJourney(flow) {
  const r = await runWalking(flow, { type: "recurring", duration: 30, days: ["Mon", "Tue", "Wed", "Thu", "Fri"], slot: "7:00 AM", start: D_WALK_WEEK, label: "week" });
  if (r.error) throw new Error(r.error);
  const pc = walkPriceCheck(r, 5, 349);
  if (r.quote && !pc.ok) reportFinding({ severity: "P1", area: "Dog Walking pricing", flow: "/v2/walking recurring", title: "Mon–Fri 30-minute walking quote differs from 5 × ₹349", steps: "Recurring starter schedule, Mon–Fri, 30 min, 7 AM", expected: "5 walks × ₹349 = ₹1,745", actual: pc.text, evidence: r.shots });
  if (r.stage !== "booked") { rec("walking-weekdays-30", `Mon–Fri 30 min 7 AM from ${D_WALK_WEEK}`, "FAIL", `${pc.text}; address ${r.address?.path} "${r.address?.caption || r.address?.alert}"; ${r.stage}; scheduling ${JSON.stringify(r.scheduling)}; booking ${JSON.stringify(r.booking)}; "${r.bookingError}"`, r.shots); return; }
  created.bookings.push({ id: r.bookingId, service: "dog_walking" });
  keep({ bookingId: r.bookingId, service: "dog_walking", packageCode: r.quote?.packageCode || "walking-30", providerId: r.scheduling?.providerId || null, providerName: r.scheduling?.provider || null, scheduledStart: r.quote?.scheduledStart || `${D_WALK_WEEK}T07:00:00+05:30`, total: r.quote?.totalAmount, dueNow: r.quote?.amountDueNow ?? 0, paid: false, paymentMode: "pay_after_service", walks: r.quote?.walkCount, pets: [DOG] });
  const m = await walkingManage(flow, r, "week");
  if (m?.liveTooEarly) reportFinding({ severity: "P2", area: "Dog Walking manage", flow: "/v2/walking/manage", title: `Manage page says the walker is on the way weeks before the first walk (SVC-WLK-01 — CONFIRMED-ON-${ON})`, steps: `Book Mon–Fri walks from ${D_WALK_WEEK}, open Manage walks`, expected: "Next walk date/time; walker not started", actual: m.text.slice(0, 300), evidence: [m.shot] });
  rec("walking-weekdays-30", `Mon–Fri 30 min 7 AM from ${D_WALK_WEEK}`, pc.ok ? "PASS" : "PARTIAL", `booking ${r.bookingId}; ${pc.text}; walker ${r.scheduling?.provider}; ${r.booking?.sessions} session(s); address ${r.address?.path} "${r.address?.caption}"; ₹0 upfront (pay after service) so no Razorpay step; manage page ${m ? (m.liveTooEarly ? `shows live-walk copy early (SVC-WLK-01 CONFIRMED-ON-${ON})` : `no early live-walk copy (SVC-WLK-01 NOT-REPRODUCED-ON-${ON})`) : "n/a"}`, [...r.shots, m?.shot]);
}
async function walkingOnceJourney(flow) {
  // Same dog, same time as the Training Meet & Greet → double-booking probe (SVC-SCH-01), then a clean one-time walk.
  const mg = ctx.meetGreet;
  const r = await runWalking(flow, { type: "once", duration: 60, slot: "4:00 PM", start: D_MEET, label: "overlap" });
  if (r.error) throw new Error(r.error);
  const pc = walkPriceCheck(r, 1, 549);
  const shots = [...r.shots];
  let booked = r.stage === "booked" ? r : null;
  if (mg) {
    const accepted = r.stage === "booked";
    const conflictMsg = /already|conflict|overlap|another booking|same time/i.test(`${r.bookingError} ${r.scheduling?.error} ${r.booking?.error}`);
    rec("double-booking-same-pet", `${DOG}: Training Meet & Greet ${D_MEET} 16:00–17:00 vs one-time 60-min walk ${D_MEET} 4 PM`, accepted ? "FAIL" : (conflictMsg ? "PASS" : "PARTIAL"), accepted ? `second booking ${r.bookingId} ACCEPTED for the same pet and time as ${mg.bookingId} (walker ${r.scheduling?.provider}) → SVC-SCH-01 CONFIRMED-ON-${ON}` : `walk refused: scheduling ${JSON.stringify(r.scheduling)}; booking ${JSON.stringify(r.booking)}; "${r.bookingError}" → SVC-SCH-01 NOT-REPRODUCED-ON-${ON}`, r.shots);
    if (accepted) reportFinding({ severity: "P2", area: "Scheduling (all V2 services)", flow: "/v2/walking after /v2/training", title: `The same pet can be booked into overlapping services at the same time (SVC-SCH-01 — CONFIRMED-ON-${ON})`, steps: `1) Training Meet & Greet for ${DOG} ${D_MEET} 16:00 (${mg.bookingId}); 2) one-time 60-min walk for ${DOG} ${D_MEET} 4:00 PM`, expected: `Second reservation refused or warned ("${DOG} is already booked 4–5 pm")`, actual: `Walk ${r.bookingId} reserved (walker ${r.scheduling?.provider}) overlapping ${mg.bookingId}`, evidence: r.shots });
  } else rec("double-booking-same-pet", `${DOG} same-time probe`, "SKIPPED", "Training Meet & Greet was not reserved, so there is no booking to overlap", []);
  if (!booked) {
    // one-time 60-min walk at a free time (6 PM) so the one-time combination is still covered
    const r2 = await runWalking(flow, { type: "once", duration: 60, slot: "6:00 PM", start: D_MEET, label: "once-6pm" });
    shots.push(...r2.shots);
    if (r2.stage === "booked") booked = r2;
    else { rec("walking-once-60", `one-time 60 min ${D_MEET}`, "FAIL", `${walkPriceCheck(r2, 1, 549).text}; ${r2.error || r2.stage}; scheduling ${JSON.stringify(r2.scheduling)}; "${r2.bookingError}"`, shots); return; }
  }
  const pc2 = walkPriceCheck(booked, 1, 549);
  if (booked.quote && !pc2.ok) reportFinding({ severity: "P1", area: "Dog Walking pricing", flow: "/v2/walking one-time", title: "One-time 60-minute walk quote differs from ₹549", steps: "One-time walk, 60 min", expected: "₹549", actual: pc2.text, evidence: shots });
  created.bookings.push({ id: booked.bookingId, service: "dog_walking" });
  keep({ bookingId: booked.bookingId, service: "dog_walking", packageCode: booked.quote?.packageCode || "walking-60", providerId: booked.scheduling?.providerId || null, providerName: booked.scheduling?.provider || null, scheduledStart: booked.quote?.scheduledStart || D_MEET, total: booked.quote?.totalAmount, dueNow: booked.quote?.amountDueNow ?? 0, paid: false, paymentMode: "pay_after_service", walks: 1, pets: [DOG], overlapsBookingId: booked === r && mg ? mg.bookingId : undefined });
  const bp = await readBookingPage(flow, booked.bookingId, "once-4-booking-page");
  const payAfterCopy = /payment request after service completion/i.test(bp.text);
  rec("walking-once-60", `one-time 60 min ${D_MEET} ${booked === r ? "4 PM" : "6 PM"}`, pc2.ok ? "PASS" : "PARTIAL", `booking ${booked.bookingId}; ${pc2.text}; walker ${booked.scheduling?.provider}; /v2/booking status "${bp.status}" payment "${bp.payment}"; pay-after-service copy shown=${payAfterCopy}; pay button=${bp.payButton} (₹0 due now → no Razorpay step)`, [...shots, bp.shot]);
  if (pc.ok === false && r.quote && r !== booked) flow.note(`overlap attempt quote: ${pc.text}`);
}

// ---------------------------------------------------------------------------------------------------------------
// (6) Fresh Food
async function foodJourney(flow) {
  const { page, context } = flow;
  const cat = await capi(context, "GET", "/api/food-commercial?zoneId=blr-east");
  const item = (cat.body?.data?.items || []).find(i => i.sku === "food-uat-dog-adult-2kg") || (cat.body?.data?.items || []).find(i => /Adult Dog/i.test(i.name));
  const unit = Number(item?.unit_price ?? 799);
  await page.goto(`${BASE}/v2/food`, { waitUntil: "domcontentloaded" });
  await dismissCookies(page);
  await settle(page, 2000);
  await robustClick(page.getByRole("button", { name: /Adult Dog Food/ }).first());
  await settle(page, 1000);
  const petSel = page.getByLabel("Selected pet");
  await until(async () => (await petSel.locator("option").count()) > 1, 15_000, 400, page);
  const options = await petSel.locator("option").allInnerTexts().catch(() => []);
  const opt = options.find(o => o.startsWith(DOG));
  if (!opt) throw new Error(`harness: ${DOG} not offered for Adult Dog Food (${options.join(", ")})`);
  await petSel.selectOption({ label: opt });
  await settle(page, 800);
  await page.locator("section").filter({ hasText: "Quantity" }).locator("select").first().selectOption("2");
  await robustClick(page.getByRole("button", { name: "Repeat subscription" }));
  await page.getByLabel("Renewal interval").selectOption("14");
  await settle(page, 1000);
  await waitGone(page, "Refreshing canonical quote…", 20_000);
  await settle(page, 800);
  const q = lastPost(flow, "/api/food-commercial", p => p.http === 200 && p.data?.totalAmount != null);
  const quote = q?.data ? { quantity: q.data.quantity, unitPrice: q.data.unitPrice, totalAmount: q.data.totalAmount, amountDueNow: q.data.amountDueNow, name: q.data.name } : null;
  const ev = [await flow.shot("1-food-form")];
  const priceOk = quote && Number(quote.quantity) === 2 && near(quote.unitPrice, unit) && near(quote.totalAmount, 2 * unit) && near(unit, 799);
  const cta = page.getByRole("button", { name: /Reserve order \+ create subscription/ });
  if (!(await cta.isEnabled().catch(() => false))) { rec("food-order-subscription", "2 × Adult Dog Food + repeat every 14 days", "FAIL", `CTA disabled; quote ${JSON.stringify(quote)}; alerts ${JSON.stringify(await alerts(page))}`, ev); return; }
  const before = flow.posts.length;
  await robustClick(cta);
  await until(async () => (await page.getByRole("link", { name: "Manage order" }).isVisible()) || flow.posts.slice(before).some(p => p.http >= 400), 45_000, 500, page);
  await waitGone(page, "Reserving UAT stock…", 20_000);
  await settle(page, 1500);
  const orderPost = flow.posts.slice(before).find(p => p.path === "/api/food-orders");
  const subPost = flow.posts.slice(before).find(p => p.path === "/api/food-subscriptions");
  const text = await mainText(page);
  const orderId = orderPost?.data?.orderId || (text.match(/(PS-UAT-FOOD-[A-Z0-9-]+)/) || [])[1] || null;
  const subscriptionId = subPost?.data?.subscriptionId || (text.match(/(FSUB-[A-Z0-9-]+)/) || [])[1] || null;
  ev.push(await flow.shot("2-food-order-created"));
  if (!orderId) { rec("food-order-subscription", "2 × Adult Dog Food + repeat every 14 days", "FAIL", `order refused: food-orders ${orderPost ? `HTTP ${orderPost.http} ${orderPost.error}` : "no request"}; alerts ${JSON.stringify(await alerts(page))}`, ev); return; }
  created.foodOrders.push(orderId);
  if (subscriptionId) created.subscriptions.push(subscriptionId);
  keep({ bookingId: orderId, service: "food", kind: "food_order", packageCode: item?.sku || "food-uat-dog-adult-2kg", providerId: null, scheduledStart: null, total: orderPost?.data?.totalAmount ?? quote?.totalAmount, dueNow: 0, paid: false, paymentMode: "sandbox_deferred", quantity: 2, subscriptionId, renewalIntervalDays: 14, pets: [DOG] });
  // manage order
  await page.goto(`${BASE}/v2/food/manage?orderId=${encodeURIComponent(orderId)}`, { waitUntil: "domcontentloaded" });
  await settle(page, 3000);
  const manage = oneLine(await mainText(page), 1200);
  ev.push(await flow.shot("3-food-manage"));
  const manageOk = manage.includes(orderId) || /Adult Dog Food/.test(manage);
  // subscription page
  let sub = "";
  if (subscriptionId) {
    await page.goto(`${BASE}/v2/food/subscriptions?subscriptionId=${encodeURIComponent(subscriptionId)}`, { waitUntil: "domcontentloaded" });
    await settle(page, 3000);
    sub = oneLine(await mainText(page), 800);
    ev.push(await flow.shot("4-food-subscription"));
  }
  const subOk = Boolean(subscriptionId) && /14/.test(sub);
  const ok = priceOk && manageOk && subOk;
  rec("food-order-subscription", "2 × Adult Dog Food 2 kg + repeat every 14 days", ok ? "PASS" : (orderId ? "PARTIAL" : "FAIL"), `order ${orderId} (HTTP ${orderPost?.http}) total ${inr(orderPost?.data?.totalAmount ?? quote?.totalAmount)}; quote ${quote ? `${quote.quantity} × ${inr(quote.unitPrice)} = ${inr(quote.totalAmount)} due now ${inr(quote.amountDueNow)}` : "n/a"} (expected 2 × ₹799 = ₹1,598; catalogue unit ${inr(unit)}); subscription ${subscriptionId || `not created (${subPost ? `HTTP ${subPost.http} ${subPost.error}` : "no request"})`}; manage page lists order=${manageOk}; subscription page "${sub.slice(0, 200)}"; ₹0 due now (sandbox_deferred) → no Razorpay step`, ev);
  if (quote && !priceOk) reportFinding({ severity: "P1", area: "Fresh Food pricing", flow: "/v2/food", title: "2 × Adult Dog Food quote differs from 2 × ₹799", steps: "Adult Dog Food 2 kg, qty 2", expected: "₹1,598", actual: JSON.stringify(quote), evidence: ev.slice(0, 1) });
  if (!subscriptionId) reportFinding({ severity: "P1", area: "Fresh Food subscription", flow: "/v2/food repeat subscription", title: "Repeat subscription not created with the order", steps: "Adult Dog Food ×2 → Repeat subscription → every 14 days → Reserve order + create subscription", expected: "FSUB-… every 14 days", actual: subPost ? `HTTP ${subPost.http} ${subPost.error}` : "no subscription request", evidence: ev });
}

// ---------------------------------------------------------------------------------------------------------------
// (7) Relocation
async function relocationJourney(flow, c) {
  const { page } = flow;
  await page.goto(`${BASE}/v2/relocation`, { waitUntil: "domcontentloaded" });
  await dismissCookies(page);
  await settle(page, 2500);
  await page.getByLabel("Pet name").fill(c.petName);
  await page.getByPlaceholder("e.g. Indie, Labrador, Persian").fill(c.breed);
  await page.getByLabel("Age (years)").fill(c.age);
  await page.getByRole("combobox", { name: /^Size/ }).selectOption(c.size);
  await page.getByLabel("Travel mode").selectOption(c.mode);
  await page.getByLabel("Origin country").fill("India");
  await page.getByLabel("Origin city").fill("Bengaluru");
  await page.getByLabel("Destination country").fill(c.dc);
  await page.getByLabel("Destination city").fill(c.dcity);
  await page.getByLabel("Target date").fill(c.date);
  await settle(page, 400);
  const hint = oneLine(((await mainText(page)).match(/(Domestic|International) (move|relocation)[^\n]*/) || [""])[0], 120);
  const ev = [await flow.shot(`${c.key}-1-filled`)];
  const before = flow.posts.length;
  await robustClick(page.getByRole("button", { name: /Create relocation inquiry/ }));
  await page.waitForURL(/caseId=/, { timeout: 25_000 }).catch(() => {});
  await settle(page, 2500);
  const post = flow.posts.slice(before).find(p => p.path === "/api/relocation");
  const caseId = decodeURIComponent((page.url().match(/caseId=([^&]+)/) || [])[1] || "") || post?.data?.id || null;
  const text = oneLine(await mainText(page), 1500);
  ev.push(await flow.shot(`${c.key}-2-case`));
  if (!caseId) { rec(`relocation-${c.key}`, c.combo, "FAIL", `inquiry not created: POST /api/relocation ${post ? `HTTP ${post.http} ${post.error}` : "none"}; alerts ${JSON.stringify(await alerts(page))}`, ev); return; }
  created.relocation.push(caseId);
  const route = oneLine((text.match(/(Domestic|International) move[^·]*·[^·]*·[^→]*→[^T]*/) || [""])[0], 200);
  const stored = post?.data ? `${post.data.origin_city}, ${post.data.origin_country} → ${post.data.destination_city}, ${post.data.destination_country}` : null;
  const destOk = new RegExp(`${esc(c.dcity)}, ${esc(c.dc)}`).test(text) && (!post?.data || (post.data.destination_country === c.dc && post.data.destination_city === c.dcity));
  const kindOk = new RegExp(`^${c.kind}`, "i").test(route);
  rec(`relocation-${c.key}`, c.combo, destOk && kindOk ? "PASS" : "FAIL", `case ${caseId}; form hint "${hint}"; case page "${route}"; stored ${stored || "(from page)"}; target ${c.date}; quote ${/Quote is pending/.test(text) ? "pending Operations review (nothing to pay)" : oneLine((text.match(/Quote:[^\n]*/) || [""])[0], 80)} → destination recorded correctly=${destOk}`, ev);
  if (!destOk) reportFinding({ severity: "P1", area: "Relocation", flow: `/v2/relocation ${c.key}`, title: `Relocation inquiry stored a different destination than entered (${c.key})`, steps: `India/Bengaluru → ${c.dc}/${c.dcity} by ${c.mode}`, expected: `${c.dcity}, ${c.dc} (${c.kind})`, actual: `${route} / stored ${stored}`, evidence: ev });
}

// ---------------------------------------------------------------------------------------------------------------
// (8) activity, booking pages, chat
async function activityJourney(flow) {
  const { page, context } = flow;
  const acct = await account(context);
  await page.goto(`${BASE}/v2/activity`, { waitUntil: "domcontentloaded" });
  await dismissCookies(page);
  await waitGone(page, "Loading your care activity…", 25_000);
  await waitGone(page, "Loading your saved inquiries…", 20_000);
  await settle(page, 1500);
  const ev = [await flow.shot("1-activity")];
  const hrefs = await page.locator("a[href]").evaluateAll(as => as.map(a => a.getAttribute("href") || ""));
  const has = (id, key) => hrefs.some(h => h.includes(`${key}=${encodeURIComponent(id)}`));
  const missingBookings = created.bookings.filter(b => !has(b.id, "bookingId")).map(b => b.id);
  const missingFood = created.foodOrders.filter(id => !has(id, "orderId"));
  const missingRelo = created.relocation.filter(id => !has(id, "caseId"));
  const apiIds = new Set((acct?.bookings || []).map(b => b.id));
  const notInApi = created.bookings.filter(b => !apiIds.has(b.id)).map(b => b.id);
  const total = created.bookings.length + created.foodOrders.length + created.relocation.length;
  const missing = [...missingBookings, ...missingFood, ...missingRelo];
  rec("activity-lists-everything", `${created.bookings.length} bookings + ${created.foodOrders.length} food order(s) + ${created.relocation.length} relocation inquiries`, !total ? "SKIPPED" : missing.length ? "FAIL" : "PASS", !total ? "nothing was created earlier in this suite" : `activity links present for ${total - missing.length}/${total}; missing: [${missing.join(", ")}]; /api/customer-account bookings=${acct?.bookings?.length} (missing from API: [${notInApi.join(", ")}]) foodOrders=${acct?.foodOrders?.length}`, ev);
  if (total && missing.length) reportFinding({ severity: "P1", area: "Activity", flow: "/v2/activity", title: "Bookings created in V2 are missing from the activity timeline", steps: "Create bookings/orders/inquiries in this run → /v2/activity", expected: "Every booking, food order and relocation inquiry listed", actual: `missing: ${missing.join(", ")}`, evidence: ev });
  // every booking page
  for (const b of created.bookings) {
    if (timeLeft() < 90_000) break;
    const bp = await readBookingPage(flow, b.id, `2-booking-${b.id}`);
    const st = await checkoutStatus(context, b.id);
    let extra = "";
    if (b.service === "dog_training" && bp.manageHref) extra = `; Manage service → ${bp.manageHref}${/booking-confirmation/.test(bp.manageHref) ? ` (payment page, no reschedule/cancel — SVC-TRN-02 CONFIRMED-ON-${ON})` : ""}`;
    const ok = bp.text.includes(b.id) && Boolean(bp.status);
    rec("booking-page", `${b.service} ${b.id}`, ok ? "PASS" : "FAIL", `status "${bp.status}" payment "${bp.payment}" pay button=${bp.payButton}; server booking=${st.bookingStatus} payment=${st.paymentStatus} mode=${st.paymentMode} total ${inr(st.totalAmount)} dueNow ${inr(st.amountDueNow)}${extra}; "${bp.text.slice(0, 260)}"`, [bp.shot]);
    if (b.service === "dog_training" && /booking-confirmation/.test(bp.manageHref || "")) reportFinding({ severity: "P2", area: "Training manage (V2)", flow: "/v2/booking → Manage service (training)", title: `V2 Training has no reschedule or cancel: 'Manage service' opens the payment-return page (SVC-TRN-02 — CONFIRMED-ON-${ON})`, steps: "/v2/activity → training booking → View booking & payment → Manage service", expected: "Session change / cancellation request like Walking and Food", actual: `Manage service → ${bp.manageHref}`, evidence: [bp.shot] });
  }
  // chat reachable (no message sent — the AI/human queue is shared with live testers)
  await page.goto(`${BASE}/v2/chat`, { waitUntil: "domcontentloaded" });
  await waitGone(page, "Checking your PawSpace sign-in...", 20_000);
  await settle(page, 2000);
  const chatText = oneLine(await mainText(page), 600);
  const composer = await page.locator("textarea, input[type=text]").count();
  const signInError = /We could not check your sign-in/.test(chatText);
  const chatShot = await flow.shot("3-chat");
  rec("chat-reachable", "/v2/chat signed in", !signInError && composer ? "PASS" : "FAIL", `composer inputs=${composer}; sign-in check error=${signInError}; "${chatText.slice(0, 240)}" (no message sent)`, [chatShot]);
}
/** Training split: after the deposit is captured, can the customer see (and pay) the balance? (SVC-TRN-01) */
async function splitBalanceJourney(flow, prog) {
  const { context } = flow;
  const { bookingId } = prog.rowBase;
  const st = await checkoutStatus(context, bookingId);
  const bp = await readBookingPage(flow, bookingId, "1-programme-booking-page");
  const total = Number(st.totalAmount ?? prog.rowBase.total), deposit = Number(prog.rowBase.dueNow);
  const balance = Math.round((total - deposit) * 100) / 100;
  const balanceShown = /balance/i.test(bp.text) && (bp.text.includes(inr(balance)) || bp.text.includes(balance.toLocaleString("en-IN")));
  if (st.paymentStatus !== "captured") {
    rec("training-split-balance-visible", `programme ${bookingId} after deposit`, "ENV-GATED", `deposit not captured (payment ${st.paymentStatus}, ${prog.pay?.stage}); balance check needs a captured deposit; page "${bp.text.slice(0, 200)}"`, [bp.shot]);
    return;
  }
  rec("training-split-balance-visible", `programme ${bookingId}: total ${inr(total)}, deposit ${inr(deposit)} captured`, balanceShown ? "PASS" : "FAIL", `booking page status "${bp.status}" payment "${bp.payment}"; balance ${inr(balance)} shown=${balanceShown}; pay button=${bp.payButton}; server amountDueNow=${st.amountDueNow} → SVC-TRN-01 ${balanceShown ? `NOT-REPRODUCED-ON-${ON}` : `CONFIRMED-ON-${ON}`}; "${bp.text.slice(0, 300)}"`, [bp.shot]);
  if (!balanceShown) reportFinding({ severity: "P2", area: "Training payments (V2)", flow: "/v2/booking (training split)", title: `After the Training deposit is captured the booking shows no outstanding balance and no way to pay it (SVC-TRN-01 — CONFIRMED-ON-${ON})`, steps: `Book Puppy Training Plan with Approved split, pay the ${inr(deposit)} deposit in Razorpay TEST, open /v2/booking?bookingId=${bookingId}`, expected: `Deposit ${inr(deposit)} paid · Balance ${inr(balance)} due + a pay-balance action`, actual: `Status ${bp.status}; Payment ${bp.payment}; server amountDueNow=${st.amountDueNow}; no balance shown`, evidence: [bp.shot] });
}

// ---------------------------------------------------------------------------------------------------------------
async function main() {
  browser = await launch();
  console.log(`[${SUITE}] BASE=${BASE} mode=${OTP_MODE ? "otp" : "persona"} window=${W_FROM}-${W_TO} days; meet=${D_MEET} programme=${D_PROGRAMME} walks=${D_WALK_WEEK}`);

  // (1) OTP sign-in with a brand-new number (its own identity — never customer-b)
  await journey("otp-signin", `new number ${OTP_PHONE}`, otpJourney, { signIn: false });

  // (2) account set-up for customer-b
  await journey("account", "profile + addresses + pets", accountJourney);

  // (3) Grooming
  await journey("grooming", "catalogue + booking + Razorpay TEST", groomingJourney);

  // (4) Training — Meet & Greet (video showcase) and a split programme
  await journey("training-meet-greet", `Trainer Meet & Greet ${D_MEET} 16:00 · ${DOG} · prepaid ₹500`, async (flow) => {
    const out = await trainingJourney(flow, { name: "training-meet-greet", combo: `Trainer Meet & Greet ${D_MEET} 16:00 · ${DOG} · prepaid`, pkg: "Trainer Meet & Greet", date: D_MEET, time: "16:00", expectTotal: 500, expectDueNow: 500 });
    if (out?.r?.bookingId) ctx.meetGreet = { bookingId: out.r.bookingId };
    return out;
  }, { video: true });
  let programme = null;
  await journey("training-programme-split", `Puppy Training Plan from ${D_PROGRAMME} 10:00 every 3 days · split`, async (flow) => {
    programme = await trainingJourney(flow, { name: "training-programme-split", combo: `Puppy Training Plan · 4 sessions every 3 days from ${D_PROGRAMME} 10:00 · ${DOG} · Approved split`, pkg: "Puppy Training Plan", date: D_PROGRAMME, time: "10:00", mode: "split", cadence: 3, expectTotal: 6000, expectDueNow: 3000 });
    return programme;
  });
  if (programme?.rowBase) await journey("training-split-balance", "balance visible after deposit", (flow) => splitBalanceJourney(flow, programme));
  else rec("training-split-balance-visible", "programme after deposit", "SKIPPED", "no programme booking was reserved");

  // (5) Dog Walking
  await journey("walking-weekdays-30", `Mon–Fri 30 min 7 AM from ${D_WALK_WEEK}`, walkingWeekJourney);
  await journey("walking-once-60", `one-time 60 min ${D_MEET} 4 PM (overlaps Meet & Greet)`, walkingOnceJourney);

  // (6) Fresh Food
  await journey("food", "2 × Adult Dog + repeat every 14 days", foodJourney);

  // (7) Relocation
  await journey("relocation-domestic", "Bengaluru → Pune by road", (flow) => relocationJourney(flow, { key: "domestic", combo: `domestic road India/Bengaluru → India/Pune ${D_RELO_DOMESTIC}`, kind: "Domestic", petName: DOG, breed: "Labrador Retriever", age: "3", size: "large", mode: "road", dc: "India", dcity: "Pune", date: D_RELO_DOMESTIC }));
  await journey("relocation-international", "Bengaluru → London by air", (flow) => relocationJourney(flow, { key: "international", combo: `international air India/Bengaluru → United Kingdom/London ${D_RELO_INTL}`, kind: "International", petName: CAT, breed: "Persian", age: "4", size: "small", mode: "air", dc: "United Kingdom", dcity: "London", date: D_RELO_INTL }));

  // (8) activity + every booking page + chat
  await journey("activity-bookings-chat", "activity + /v2/booking + /v2/chat", activityJourney);

  summary.createdIds = created;
  summary.sessionReissues = reissues;
  summary.finishedAt = new Date().toISOString();
  summary.elapsedSec = Math.round((Date.now() - STARTED) / 1000);
  writeJson(`${SUITE}.json`, summary);
  console.log(redact(`[${SUITE}] done in ${summary.elapsedSec}s — ${summary.journeys.filter(j => j.result).map(j => `${j.journey}:${j.result}`).join(", ")}`));
}

try { await main(); }
catch (e) { console.error(redact(`[${SUITE}] harness error: ${String(e?.stack || e)}`)); record({ suite: SUITE, journey: "suite", combo: "-", result: "BLOCKED", detail: `harness: ${oneLine(String(e), 500)}`, evidence: [] }); }
finally { await browser?.close().catch(() => {}); }
process.exit(0);
