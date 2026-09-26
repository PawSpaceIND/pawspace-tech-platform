// Private helpers for suite 50-partner (files starting with "_" are not run as suites).
// Customer-side V2 stay driver (Boarding / Pet Sitting) used for the near-term Boarding stay the partner suite
// needs, plus small utilities (PNG generator, text helpers, booking hand-off merge).
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { deflateSync } from "node:zlib";
import { BASE, settle, dismissCookies, api, payRazorpayTestNetbanking } from "../lib.mjs";

export const oneLine = (s, n = 400) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
export const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const inr = (n) => (Number.isFinite(Number(n)) ? `₹${Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 })}` : String(n));
export async function mainText(page) {
  return (await page.locator("main").first().innerText({ timeout: 5000 }).catch(() => page.locator("body").innerText({ timeout: 5000 }).catch(() => ""))) || "";
}
export async function bodyText(page) { return (await page.locator("body").innerText({ timeout: 5000 }).catch(() => "")) || ""; }
export async function robustClick(locator, timeout = 10_000) {
  try { await locator.click({ timeout }); return true; }
  catch { try { await locator.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {}); await locator.evaluate(el => el.click()); return true; } catch { return false; } }
}
/** Wait (bounded) for the next POST whose path contains `frag`; resolves to {status, body} or null. */
export function nextPost(page, frag, timeout = 25_000) {
  return page.waitForResponse(r => r.url().startsWith(BASE) && r.url().includes(frag) && r.request().method() === "POST", { timeout })
    .then(async r => { let body = null; const text = await r.text().catch(() => ""); try { body = JSON.parse(text); } catch { body = text.slice(0, 400); } return { status: r.status(), body }; })
    .catch(() => null);
}
export const brief = (res) => (res ? `HTTP ${res.status} ${oneLine(typeof res.body === "string" ? res.body : JSON.stringify(res.body?.error ? { error: res.body.error, code: res.body.code } : res.body?.data ?? res.body), 260)}` : "no request observed");

// ---- deterministic PNG (solid gradient) for proof uploads -------------------------------------------------------
function crc32(buf) { let c, crc = 0xffffffff; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
export function makePng(file, w = 96, h = 96, rgb = [40, 150, 90]) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = (rgb[0] + x) & 255; raw[o + 1] = (rgb[1] + y) & 255; raw[o + 2] = rgb[2]; }
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, png); return file;
}

// ---- booking hand-off -----------------------------------------------------------------------------------------
/** bookings.jsonl may hold several rows per booking (creation + later updates): merge them in file order. */
export function mergeBookings(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!row?.bookingId) continue;
    const prev = map.get(row.bookingId) || { updates: [] };
    const next = { ...prev };
    for (const [k, v] of Object.entries(row)) if (v !== undefined && v !== null && k !== "updates") next[k] = v;
    if (row.update) next.updates = [...prev.updates, row.update];
    if (prev.paid === true && row.paid === false && row.update) next.paid = true; // an update row never un-pays a booking
    map.set(row.bookingId, next);
  }
  return [...map.values()];
}
export const isCancelled = (b) => Boolean(b.cancelRequested || /cancel/i.test(String(b.cancelStatus || "")) || (b.updates || []).some(u => /cancel/i.test(String(u))));

// ---- customer-side V2 stay flow (Boarding / Pet Sitting) -----------------------------------------------------
export async function checkoutStatus(capi, context, bookingId) {
  const r = await capi(context, "POST", "/api/customer-checkout", { action: "status", bookingId });
  const d = r.body?.data || {}, c = d.confirmation || {};
  return { http: r.status, status: d.status, bookingStatus: c.bookingStatus, paymentStatus: c.paymentStatus, paymentMode: c.paymentMode, amountDueNow: c.amountDueNow, totalAmount: c.totalAmount, providerName: c.providerName, error: r.body?.error };
}

async function chooseServiceAddress(flow, query, reauth) {
  const { page } = flow;
  const care = page.locator('section[aria-label="Care location"]').first();
  await care.waitFor({ timeout: 20_000 });
  await care.getByText("Checking service area…").waitFor({ state: "detached", timeout: 25_000 }).catch(() => {});
  const out = { attempts: [] };
  const change = care.getByRole("button", { name: "Change Address" });
  if (await change.isVisible().catch(() => false)) await change.click();
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
    const until = Date.now() + 20_000;
    while (Date.now() < until && !(await available.isVisible().catch(() => false)) && !(await care.locator('[role="alert"]').first().isVisible().catch(() => false))) await page.waitForTimeout(400);
    const a = { path, caption: oneLine(await care.locator("[class*=locationLine]").first().innerText({ timeout: 2000 }).catch(() => ""), 200), alert: oneLine(await care.locator('[role="alert"]').first().innerText({ timeout: 800 }).catch(() => ""), 200), usable: await use.isEnabled().catch(() => false) };
    out.attempts.push(a);
    return a;
  };
  await line1.waitFor({ timeout: 10_000 });
  let attempt = null;
  await line1.fill(query);
  const state = await waitSettled();
  if (state === "suggestions") {
    out.suggestions = (await suggestions.allInnerTexts()).slice(0, 3).map(t => oneLine(t, 120));
    await robustClick(suggestions.first());
    attempt = await readAttempt("google-suggestion");
  } else if (state === "resolved") attempt = await readAttempt("auto-typed");
  if (!attempt?.usable && /sign-in has expired/.test(attempt?.alert || "")) {
    await reauth(flow.context, "address resolve → 401");
    await line1.fill(query);
    if (await waitSettled() === "suggestions") { await robustClick(suggestions.first()); attempt = await readAttempt("google-suggestion"); }
  }
  if (!attempt?.usable) {
    await line1.fill(`${query} 560038`);
    await waitSettled(8000);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !(await verify.isEnabled().catch(() => false)) && !(await available.isVisible().catch(() => false))) await page.waitForTimeout(400);
    if (await verify.isEnabled().catch(() => false)) await robustClick(verify);
    attempt = await readAttempt("typed-verify");
  }
  Object.assign(out, { path: attempt.path, caption: attempt.caption, alert: attempt.alert, ok: attempt.usable });
  if (!attempt.usable) return out;
  await robustClick(use);
  await settle(page, 500);
  return out;
}

async function selectPets(page, wanted) {
  const petButtons = page.locator("[class*=petList] button[aria-pressed]");
  await petButtons.first().waitFor({ timeout: 20_000 });
  const count = await petButtons.count();
  for (let i = 0; i < count; i++) {
    const b = petButtons.nth(i);
    const name = oneLine(await b.locator("b").first().innerText().catch(() => ""), 60);
    const want = wanted.includes(name);
    if (want !== ((await b.getAttribute("aria-pressed")) === "true")) await b.click();
  }
  const selected = [];
  for (let i = 0; i < count; i++) { const b = petButtons.nth(i); if ((await b.getAttribute("aria-pressed")) === "true") selected.push(oneLine(await b.locator("b").first().innerText(), 60)); }
  return selected;
}

/**
 * Drive one V2 Boarding / Pet Sitting booking as the signed-in customer and (optionally) pay it with Razorpay TEST.
 * opts: {mode:"boarding"|"sitting", start, end, startTime, endTime, pets:[names], hostName?, care:{label:value},
 *        extras:[], address, pay:bool, reauth(context, why), capi}
 * Returns {stage, bookingId, quote, host, hosts, careSaved, checkoutStart, razorpay, capture, shots, alerts}.
 */
export async function createStayBooking(flow, opts) {
  const { page, context } = flow;
  const { reauth, capi } = opts;
  const r = { stage: "start", shots: [], quotes: [] };
  const net = { canonical: null, scheduling: null, start: null };
  const onResponse = async (res) => {
    try {
      const url = res.url(), req = res.request();
      if (req.method() !== "POST" || !url.startsWith(BASE)) return;
      const path = new URL(url).pathname;
      if (path === "/api/boarding-commercial" || path === "/api/sitting-commercial") { const b = await res.json().catch(() => null); if (b?.data?.quoteId || b?.data?.totalAmount != null || b?.data?.total != null) r.quotes.push({ http: res.status(), ...b.data }); }
      else if (path === "/api/canonical-bookings") { const b = await res.json().catch(() => null); net.canonical = { http: res.status(), bookingId: b?.data?.bookingId, status: b?.data?.status, error: b?.error }; }
      else if (path === "/api/uat-scheduling") { const b = await res.json().catch(() => null); if (!/"action":"preview"/.test(req.postData() || "")) net.scheduling = { http: res.status(), code: b?.code, error: b?.error }; }
      else if (path === "/api/customer-checkout" && /"action":"start"/.test(req.postData() || "")) { const b = await res.json().catch(() => null); net.start = { http: res.status(), orderId: b?.data?.orderId || b?.data?.razorpay_order_id, amountPaise: b?.data?.amountPaise, status: b?.data?.status, error: b?.error }; }
    } catch {}
  };
  page.on("response", onResponse);
  r.net = net;
  try {
    const service = opts.mode === "boarding" ? "boarding" : "sitting";
    await page.goto(`${BASE}/v2/${service}`, { waitUntil: "domcontentloaded" });
    await dismissCookies(page);
    await page.getByText("Loading your PawSpace family…").waitFor({ state: "detached", timeout: 25_000 }).catch(() => {});
    await page.locator("[class*=petList] button[aria-pressed]").first().waitFor({ timeout: 25_000 }).catch(() => {});
    if (await page.getByText(/Sign in to plan care/).isVisible().catch(() => false)) { await reauth(context, `/v2/${service} signed out`); await page.reload(); await settle(page, 1500); }
    r.address = await chooseServiceAddress(flow, opts.address, reauth);
    if (!r.address.ok) { r.stage = "address"; r.shots.push(await flow.shot("c-address-not-verified")); return r; }
    await page.getByLabel("Check-in date").fill(opts.start);
    await page.getByLabel("Check-in time").fill(opts.startTime);
    await page.getByLabel("Check-out date").fill(opts.end);
    await page.getByLabel("Check-out time").fill(opts.endTime);
    await settle(page, 400);
    r.selectedPets = await selectPets(page, opts.pets);
    r.durationSummary = oneLine(await page.locator("[class*=durationSummary]").first().innerText().catch(() => ""), 200);
    r.shots.push(await flow.shot("c1-plan"));
    const planCta = page.getByRole("button", { name: /See available (homes|sitters)|Verify a service address|Select a pet to continue/ });
    r.planCta = oneLine(await planCta.innerText().catch(() => ""));
    r.stage = "plan";
    if (!(await planCta.isEnabled().catch(() => false))) return r;
    await robustClick(planCta);
    await page.getByText(/Checking (governed host|sitter) availability/).waitFor({ state: "detached", timeout: 30_000 }).catch(() => {});
    await settle(page, 1000);
    const cards = page.locator("[class*=caregivers] > button");
    r.hosts = (await cards.allInnerTexts().catch(() => [])).map(t => oneLine(t.split("\n").slice(0, 4).join(" | "), 140));
    r.hostAlert = oneLine(await page.locator("[role=alert]").first().innerText({ timeout: 1500 }).catch(() => ""), 300);
    if (opts.hostName) {
      const card = cards.filter({ has: page.locator("h4", { hasText: new RegExp(`^${esc(opts.hostName)}$`) }) }).first();
      if (await card.count()) { await robustClick(card); await settle(page, 800); }
    }
    r.shots.push(await flow.shot("c2-caregivers"));
    const cont = page.getByRole("button", { name: /Continue with|Choose an available caregiver/ });
    r.stage = "caregiver";
    if (!(await cont.isEnabled().catch(() => false))) return r;
    r.host = oneLine((await cont.innerText()).replace("Continue with", ""), 60);
    await robustClick(cont);
    await settle(page, 500);
    for (const [label, value] of Object.entries(opts.care || {})) { const box = page.getByLabel(label, { exact: true }); if (await box.count()) await box.fill(value); }
    for (const extra of opts.extras || []) await page.getByRole("button", { name: new RegExp(`^[＋✓]\\s*${esc(extra)}$`) }).click().catch(() => {});
    r.shots.push(await flow.shot("c3-care-card"));
    await robustClick(page.getByRole("button", { name: "Review protected booking" }));
    await settle(page, 1000);
    r.stage = "review";
    if (await page.getByRole("button", { name: /Pay the full amount now/ }).isVisible().catch(() => false)) await page.getByRole("button", { name: /Pay the full amount now/ }).click();
    const cta = page.getByRole("button", { name: /Create stay request & review payment|Request sitter & review payment|Calculating price|Price unavailable|Locking care capacity/ }).last();
    const ctaDeadline = Date.now() + 25_000;
    while (Date.now() < ctaDeadline && !/review payment/.test(await cta.innerText().catch(() => ""))) await page.waitForTimeout(500);
    await page.getByLabel(/I agree to care/).check();
    r.cta = oneLine(await cta.innerText().catch(() => ""));
    r.bill = oneLine(await page.locator("[class*=bill]").first().innerText().catch(() => ""), 300);
    r.shots.push(await flow.shot("c4-review"));
    if (!/review payment/.test(r.cta)) { r.stage = "quote-unavailable"; r.alert = oneLine(await page.locator("[role=alert]").first().innerText({ timeout: 1000 }).catch(() => ""), 300); return r; }
    for (let attempt = 1; attempt <= 2; attempt++) {
      net.scheduling = null; net.canonical = null;
      await robustClick(cta);
      await page.getByText("Locking care capacity…").waitFor({ state: "detached", timeout: 45_000 }).catch(() => {});
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (await page.getByRole("button", { name: /Pay securely|Check payment status/ }).first().isVisible().catch(() => false)) break;
        if (await page.getByRole("button", { name: "Retry saving care instructions" }).isEnabled().catch(() => false)) break;
        if (await page.locator("p[role=alert]").first().isVisible().catch(() => false) && !net.canonical?.bookingId) break;
        await page.waitForTimeout(500);
      }
      const is401 = (x) => Number(x?.http) === 401;
      if (attempt === 1 && !net.canonical?.bookingId && (is401(net.scheduling) || is401(net.canonical))) { await reauth(context, "reserve/create → 401"); continue; }
      break;
    }
    const careRetry = page.getByRole("button", { name: "Retry saving care instructions" });
    for (let i = 0; i < 2 && net.canonical?.bookingId && await careRetry.isVisible().catch(() => false); i++) {
      await reauth(context, "care gate retry");
      await robustClick(careRetry);
      await page.getByRole("button", { name: /Pay securely/ }).first().waitFor({ timeout: 20_000 }).catch(() => {});
    }
    r.bookingId = net.canonical?.bookingId || null;
    r.quote = r.quotes.at(-1) || null;
    r.alert = oneLine(await page.locator("p[role=alert]").first().innerText({ timeout: 1000 }).catch(() => ""), 300);
    r.shots.push(await flow.shot("c5-after-create"));
    r.stage = r.bookingId ? "created" : "create-blocked";
    if (!r.bookingId || !opts.pay) return r;
    const payBtn = page.getByRole("button", { name: /Pay securely/ }).first();
    for (let attempt = 1; attempt <= 3; attempt++) {
      net.start = null;
      await robustClick(payBtn);
      const deadline = Date.now() + 25_000;
      while (Date.now() < deadline && !net.start) await page.waitForTimeout(300);
      await page.waitForTimeout(1500);
      if (attempt < 3 && net.start?.http === 401) { await reauth(context, "checkout start → 401"); await payBtn.waitFor({ timeout: 10_000 }).catch(() => {}); continue; }
      break;
    }
    r.checkoutStart = net.start;
    if (!net.start || net.start.http >= 400) {
      r.stage = "checkout-refused";
      r.envGated = net.start?.http === 503 && /not configured/i.test(String(net.start?.error || ""));
      r.shots.push(await flow.shot("c6-checkout-refused"));
      return r;
    }
    if (net.start.status === "nothing_due") { r.stage = "nothing-due"; return r; }
    await page.waitForTimeout(2500);
    r.shots.push(await flow.shot("c6-razorpay-open", { fullPage: false }));
    r.razorpay = await payRazorpayTestNetbanking(page);
    r.stage = "paid-submitted";
    // Poll the page and the customer projection (max 90 s) until the capture is verified.
    const deadline = Date.now() + (r.razorpay?.ok ? 90_000 : 20_000);
    let lastCheck = 0, status = null;
    while (Date.now() < deadline) {
      status = await checkoutStatus(capi, context, r.bookingId);
      if (status.paymentStatus === "captured" && ["confirmed", "assigned", "in_progress"].includes(String(status.bookingStatus))) break;
      const check = page.getByRole("button", { name: /Check payment status|Retry booking confirmation/ }).first();
      if (Date.now() - lastCheck > 8000 && await check.isVisible().catch(() => false) && await check.isEnabled().catch(() => false)) { lastCheck = Date.now(); await check.click().catch(() => {}); }
      await page.waitForTimeout(2500);
    }
    await settle(page, 1500);
    r.capture = { final: status || await checkoutStatus(capi, context, r.bookingId), ui: oneLine(((await bodyText(page)).match(/(Boarding booking ·[^\n]*|Payment verified[^\n]*|Razorpay returned[^\n]*|Waiting for signed[^\n]*|Payment was unsuccessful[^\n]*)/) || [""])[0], 200) };
    r.capture.server = r.capture.final?.paymentStatus === "captured";
    r.shots.push(await flow.shot("c7-after-payment"));
    r.stage = r.capture.server ? "captured" : "capture-pending";
    return r;
  } finally {
    page.off("response", onResponse);
  }
}

/** Customer API with one session re-issue on 401 (another sign-in as the same customer supersedes ours). */
export function makeCustomerApi(customerSession, persona, log) {
  const reauth = async (context, why) => { await customerSession(context, persona); log?.(`customer ${persona} session re-issued (${why})`); };
  const capi = async (context, method, path, data) => {
    let r = await api(context, method, path, data).catch(e => ({ status: 0, body: String(e) }));
    if (r.status === 401) { await reauth(context, `${method} ${path} → 401`); r = await api(context, method, path, data).catch(e => ({ status: 0, body: String(e) })); }
    return r;
  };
  return { reauth, capi };
}
