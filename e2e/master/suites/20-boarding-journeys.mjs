// 20-boarding-journeys — Boarding end to end on the REAL V2 screens: customer → host → staff → money.
//  Customer (run-scoped OTP customer; desktop 1366×900, B1 on Pixel 7 with video):
//   B1 4 h daycare, 1 dog, paid in full (₹499 rule)            B2 2 nights dog + cat with every add-on, paid in full
//   B3 5 nights split 50/50: deposit, then the balance          B4 validation (dates, PIN, vaccination, 24 h, 180 days)
//   B5 manage page of B2 (care plan, date change, extension, messaging, paid cancellation → policy review) and an
//      UNPAID reservation the customer cancels (capacity released)
//   B6 near-term 4 h daycare (earliest start ≥ 24 h 15 min), paid, handed to the partner-due suite (nearTerm)
//  Host (runner only): partner app lists the paid stays; /host shows pets + care plan with contacts withheld until
//   acceptance; accept B2 in the UI; contacts then visible; early check-in refused; earnings view sane.
//  Staff (runner only): Booking Command Center payment state/amounts per booking; /team/finance/boarding lists B2's
//   paid cancellation; the Finance persona is refused with "MFA enrollment required" (expected security control).
//  D1 read-backs (runner only): payments, gateway events, reconciliation, collection ledger, lifecycle, stays, locks.
// Staging answers Boarding calls slowly (15–50 s measured); the page's own "Retry" controls are used like a customer
// would, and every client-side abort is counted and reported once as a latency finding.
import {
  BASE, launch, newFlow, api, otpCustomerSession, providerSession, staffSession, runPhone, d1, isoDay,
  record, finding, saveBooking, writeJson, hasAccessCode, recordWebhookCheck, settle, dismissCookies,
} from "../lib.mjs";
import * as H from "./_20-boarding-journeys-helpers.mjs";

const SUITE = "20-boarding-journeys";
const STARTED = Date.now();
const BUDGET_MS = 37 * 60_000; // the runner kills a suite at 40 min
const ONLY = new Set(String(process.env.MASTER_JOURNEYS || "").split(",").map(s => s.trim()).filter(Boolean));
const want = (id) => !ONLY.size || ONLY.has(id);
const SEED = Number(String(process.env.GITHUB_RUN_ID || process.env.MASTER_RUN_ID || Date.now()).replace(/\D/g, "").slice(-6)) || 1;
const PHONE = runPhone(4);
const CUSTOMER_NAME = "Master E2E Boarding";
const PETS = { dog: "BrdDog", cat: "BrdCat", pup: "BrdPup" };
const CARE = { feeding: "Twice a day, 8am and 7pm (master E2E)", medication: "None known", vet: "Dr. Rao, Indiranagar Vet Clinic, 9000000001", emergencyContact: "Asha (sister), 9000000002", specialInstructions: "Loves fetch. Master E2E synthetic booking." };
const ALL_EXTRAS = ["Pickup & drop", "Three walks", "Medication support", "1-hour play time", "Grooming add-on", "Training add-on"];
const FOOD = "Vegetarian fresh food";
const RULE_UNIT = { "boarding-4h": 499, "boarding-10h": 599, "boarding-24h": 699 }; // lib/boarding-governance.ts packages
const PREFERRED_HOST = "Priya & Dev"; // multi-family host with 4 spots: paid test stays block the least capacity
const BASE_DAY = 40 + (SEED % 20); // Boarding window is 40–70 days out; the run id spreads repeated runs
const DATES = {
  B1: { start: isoDay(BASE_DAY), startTime: "09:00", end: isoDay(BASE_DAY), endTime: "13:00" },
  B2: { start: isoDay(BASE_DAY + 1), startTime: "10:00", end: isoDay(BASE_DAY + 3), endTime: "10:00" },
  B3: { start: isoDay(BASE_DAY + 4), startTime: "10:00", end: isoDay(BASE_DAY + 9), endTime: "10:00" },
  B4: { start: isoDay(BASE_DAY + 2), startTime: "10:00", end: isoDay(BASE_DAY + 2), endTime: "14:00" },
  B5u: { start: isoDay(BASE_DAY + 10), startTime: "11:00", end: isoDay(BASE_DAY + 10), endTime: "15:00" },
};
const out = { suite: SUITE, base: BASE, seed: SEED, baseDay: BASE_DAY, dates: DATES, customer: null, journeys: [], bookings: {}, latency: [], transportNotes: [] };
const CUSTOMER = { id: null, name: CUSTOMER_NAME, phone: PHONE };
const BK = {}; // booking results by journey id
const timeLeft = () => BUDGET_MS - (Date.now() - STARTED);
const { oneLine, inr, near } = H;
const log = (text) => console.log(`[${SUITE}] ${oneLine(text, 900)}`);
const filed = new Set();
function file(key, row) { if (filed.has(key)) return; filed.add(key); finding({ suite: SUITE, persona: "Customer", ...row }); }
function rec(journey, combo, result, detail, evidence = []) { record({ suite: SUITE, journey, combo, result, detail: oneLine(detail, 1800), evidence: evidence.filter(Boolean) }); log(`${result} ${journey} · ${combo}`); }

/** The approved per-pet rule (lib/boarding-governance.ts): 4 h ₹499 / 10 h ₹599 / overnight ₹699 per started 24 h, × pets. */
function expectedPrice(d, pets, split) {
  const hours = (Date.parse(H.istIso(d.end, d.endTime)) - Date.parse(H.istIso(d.start, d.startTime))) / 3_600_000;
  const pkg = hours <= 4 ? "boarding-4h" : hours <= 10 ? "boarding-10h" : "boarding-24h";
  const units = pkg === "boarding-24h" ? Math.max(1, Math.ceil(hours / 24 - 1e-9)) : 1, unit = RULE_UNIT[pkg], total = unit * units * pets;
  const nights = Math.round((Date.parse(`${d.end}T00:00:00Z`) - Date.parse(`${d.start}T00:00:00Z`)) / 86_400_000);
  const splitOffered = hours > 10 && nights > 4, dueNow = splitOffered && split !== false ? Math.round(total * 50) / 100 : total;
  return { hours, nights, pkg, units, unit, total, splitOffered, dueNow };
}
function priceCheck(q, exp) {
  if (!q) return { ok: false, text: "no governed quote captured" };
  // A provider-specific rate (priceSource provider_rate) may lawfully replace the catalogue unit; everything else is the catalogue rule.
  const unitOk = q.priceSource === "provider_rate" ? Number(q.basePricePerPet) >= exp.unit : near(q.basePricePerPet, exp.unit);
  const ok = q.packageCode === exp.pkg && Number(q.stayUnits) === exp.units && Number(q.petCount) > 0 && unitOk && near(q.totalAmount, Number(q.basePricePerPet) * Number(q.petCount) * Number(q.stayUnits)) && (q.priceSource === "provider_rate" || near(q.totalAmount, exp.total));
  const dueOk = near(q.amountDueNow, q.paymentMode === "split_50_50" ? Math.round(Number(q.totalAmount) * 50) / 100 : q.totalAmount);
  return { ok: ok && dueOk, priceOk: ok, dueOk, text: `quote ${q.packageCode} ${inr(q.basePricePerPet)}×${q.stayUnits} unit(s)×${q.petCount} pet(s) = ${inr(q.totalAmount)}, due now ${inr(q.amountDueNow)} (${q.paymentMode}${q.priceSource ? `, ${q.priceSource}` : ""}) vs rule ${exp.pkg} ${inr(exp.unit)}×${exp.units}×pets = ${inr(exp.total)}, due now ${inr(exp.dueNow)}` };
}

// ------------------------------------------------------------------------------------------------ harness

let browser;
async function journey(id, combo, fn, { mobile = false, video = false, needMs = 240_000 } = {}) {
  if (!want(id)) return null;
  if (timeLeft() < needMs) { rec(id, combo, "SKIPPED", `suite time budget: ${Math.round(timeLeft() / 1000)} s left, this journey needs ~${Math.round(needMs / 1000)} s`); return null; }
  const flow = await newFlow(browser, `${SUITE}-${id}`, { mobile, video });
  const net = H.watchNetwork(flow);
  const t0 = Date.now();
  try { return await fn(flow, net); }
  catch (e) {
    const shot = await flow.shot("error").catch(() => null);
    rec(id, combo, "BLOCKED", `harness: ${oneLine(e?.message || e, 600)}`, [shot]);
    return null;
  } finally {
    flowHealth(flow, id);
    latencyNote(net, id);
    out.journeys.push({ id, ms: Date.now() - t0 });
    await flow.close();
  }
}
async function signIn(flow) {
  let who = null;
  for (let i = 1; i <= 2 && !who; i++) who = await otpCustomerSession(flow.context, PHONE, CUSTOMER_NAME).catch(e => { if (i === 2) throw e; return null; });
  CUSTOMER.id = CUSTOMER.id || who?.customerId || null;
  return who;
}
/** Unexpected 5xx on a booking/payment path is P1, other 5xx and uncaught page errors P2 (brief contract). */
function flowHealth(flow, journeyId) {
  const cut = flow.log.apiFailures.filter(H.localCut);
  out.transportNotes.push(...cut.map(f => `${journeyId}: ${f.method} ${f.url.split("?")[0]} 502 (this container's egress cut)`));
  const bookingPath = /\/api\/(uat-scheduling|boarding-|customer-checkout|canonical-bookings|customer-account|service-zone|booking-command-center|customer-caregiver-chat)/;
  for (const f of flow.log.apiFailures.filter(a => a.status >= 500 && !H.localCut(a))) {
    const path = f.url.split("?")[0], body = oneLine(String(f.body || "").replace(/<[^>]+>/g, " "), 160);
    file(`5xx:${path}:${f.status}`, { severity: bookingPath.test(path) ? "P1" : "P2", area: "Boarding", flow: journeyId, title: `${f.method} ${path} answered HTTP ${f.status} during a Boarding journey`, steps: `Journey ${journeyId} on ${BASE}`, expected: "2xx, or a governed 4xx refusal", actual: `HTTP ${f.status} ${body}`, evidence: [] });
  }
  for (const e of flow.log.pageErrors) file(`pageerror:${oneLine(e.text, 60)}`, { severity: "P2", area: "Boarding", flow: journeyId, title: "Uncaught page error on a Boarding screen", steps: `Journey ${journeyId}`, expected: "No uncaught errors", actual: oneLine(e.text, 300), evidence: [] });
}
function latencyNote(net, journeyId) {
  const slow = H.slowBoardingCalls(net);
  if (slow.aborted.length || slow.slow.length) out.latency.push({ journey: journeyId, aborted: slow.aborted.map(H.callBrief), slow: slow.slow.map(H.callBrief) });
}
/** A 5xx from a call the V2 screen makes (made here with a patient timeout) is a product finding, like one seen in the page. */
function api5xx(method, path, res) {
  const body = oneLine(typeof res.body === "string" ? res.body.replace(/<[^>]+>/g, " ") : JSON.stringify(res.body), 200);
  if (H.localCut({ status: res.status, body: typeof res.body === "string" ? res.body : "" })) { out.transportNotes.push(`${method} ${path.split("?")[0]} 502 (this container's egress cut)`); return; }
  const p = path.split("?")[0];
  file(`5xx:${p}:${res.status}`, { severity: "P1", area: "Boarding", flow: `${method} ${p}`, title: `${method} ${p} answered HTTP ${res.status} during a Boarding booking`, steps: `${method} ${path.slice(0, 160)} as the signed-in customer (the call /v2/boarding makes)`, expected: "2xx or a governed 4xx", actual: `HTTP ${res.status} ${body} at ${new Date().toISOString()}`, evidence: [] });
}
/** The customer's stay record (retried: the read can time out on a slow staging). null = could not be read. */
async function readStay(context, bookingId) {
  for (let i = 1; i <= 3; i++) {
    const r = await customerApi(context, "GET", `/api/boarding-stays?scope=customer&bookingId=${encodeURIComponent(bookingId)}`);
    if (Array.isArray(r.body?.data)) return r.body.data[0] || null;
    await new Promise(res => setTimeout(res, 3000));
  }
  return undefined;
}
async function customerApi(context, method, path, data) { return api(context, method, path, data, { timeout: 150_000 }).catch(e => ({ status: 0, body: { error: String(e?.message || e) } })); }

// ------------------------------------------------------------------------------------------------ booking driver

/**
 * Plan → Match → Care Card → Review → "Create stay request & review payment" on /v2/boarding.
 * When no host has room for the window it moves the stay one day later (at most twice) through "← Plan".
 */
async function bookStay(flow, net, opts) {
  const r = await bookStayUi(flow, net, opts);
  // The page gives up on a slow staging answer (15 s / 20 s client timeouts). When that alone stopped the booking,
  // the stay is created through the same calls the screen makes (with patient timeouts) so the rest of the journey
  // — payment on /v2/booking, manage page, host, staff, books — is still exercised; the journey is then PARTIAL.
  const transportOnly = (r.hosts?.state && r.hosts.state !== "hosts" && r.hosts.state !== "none" && (r.hosts.timeouts || r.hosts.state === "timeout"))
    || (r.review && r.review.cta !== "Create stay request & review payment" && (r.review.priceTimeouts || /Calculating|unavailable/i.test(r.review.cta)))
    || (r.create && !r.bookingId && (r.create.errors || []).length && r.create.errors.every(e => H.TRANSPORT.test(e)));
  if (opts.create !== false && !opts.expectRefusal && !r.bookingId && transportOnly && opts.fallback !== false && timeLeft() > 240_000) {
    r.uiStoppedAt = r.stage;
    r.shots.push(await flow.shot(`${opts.label}-ui-gave-up`));
    try {
      const a = await apiBook(flow.context, { ...opts, dates: r.dates });
      Object.assign(r, { bookingId: a.bookingId, quote: a.quote, reviewQuote: r.reviewQuote || a.quote, reserve: a.reserve, providerId: a.reserve?.providerId || null, fallback: a.trace, stage: a.bookingId ? "created (API fallback)" : `api fallback failed: ${a.trace}` });
    } catch (e) { r.fallback = `api fallback failed: ${oneLine(e?.message || e, 200)}`; }
  }
  return r;
}

/** The calls stay-flow.tsx confirm() makes, in order, with patient timeouts (used only when the page timed out). */
async function apiBook(context, { label, dates, pets, needs = [], extras = [], food = "", split, care = CARE, host = PREFERRED_HOST }) {
  const trace = [];
  const call = async (method, path, data, tries = 3) => { let res; for (let i = 1; i <= tries; i++) { res = await customerApi(context, method, path, data); trace.push(`${method} ${path.split("?")[0]} ${res.status}`); if (res.status >= 500) api5xx(method, path, res); if (res.status && res.status < 500) break; await new Promise(r => setTimeout(r, 3000)); } return res; };
  const account = (await call("GET", "/api/customer-account")).body?.data;
  const petRows = pets.map(n => account?.pets?.find(p => p.name === n)).filter(Boolean);
  const home = account?.addresses?.find(a => a.isDefault) || account?.addresses?.[0];
  const zone = (await call("GET", `/api/service-zone?pincode=${home?.postalCode || "560038"}`)).body?.data?.assignment;
  const scheduledStart = H.istIso(dates.start, dates.startTime), scheduledEnd = H.istIso(dates.end, dates.endTime);
  const exp = expectedPrice(dates, petRows.length, split);
  const species = [...new Set(petRows.map(p => p.species))].join(",");
  const reqs = { medicationRequired: needs.includes("Medication"), noResidentPets: needs.includes("No resident pets"), oneFamilyOnly: needs.includes("One family only") };
  const hosts = (await call("GET", `/api/boarding-commercial?${new URLSearchParams({ cityId: zone.cityId, zoneId: zone.zoneId, scheduledStart, scheduledEnd, petCount: String(petRows.length), species })}`)).body?.data?.hosts || [];
  const chosen = hosts.find(h => h.name === host) || hosts[0];
  if (!chosen) return { trace: `${trace.join(", ")}; no host with capacity` };
  const paymentMode = exp.splitOffered && split !== false ? "split_50_50" : "prepaid";
  const quote = (await call("POST", "/api/boarding-commercial", { packageCode: exp.pkg, petCount: petRows.length, cityId: zone.cityId, zoneId: zone.zoneId, scheduledStart, scheduledEnd, paymentMode, providerId: chosen.providerId })).body?.data;
  if (!quote?.quoteId) return { trace: `${trace.join(", ")}; no quote` };
  const address = [home.line1, home.line2, home.area, home.city, home.postalCode].filter(Boolean).join(", ");
  const res = await call("POST", "/api/uat-scheduling", { clientRequestId: `b20-${label}-${PHONE}-${Date.now()}`, customerId: account.customerId, petIds: petRows.map(p => p.id), serviceCode: "boarding", serviceAddress: address, servicePincode: home.postalCode, cityId: zone.cityId, zoneId: zone.zoneId, scheduledStart, scheduledEnd, careMode: exp.pkg === "boarding-24h" ? "overnight" : "visit", preferredProviderId: chosen.providerId });
  const decision = res.body?.data;
  const reserve = { http: res.status, providerId: decision?.provider?.id || null, groupId: decision?.groupId || null, error: res.body?.error || null };
  if (!decision?.groupId) return { reserve, trace: `${trace.join(", ")}; reservation refused ${JSON.stringify(res.body).slice(0, 160)}` };
  const payload = { idempotencyKey: `b20-${label}-${decision.groupId}`, scheduleGroupId: decision.groupId, customer: { id: account.customerId, name: account.name, primaryPhone: account.primaryPhone }, pets: petRows.map(p => ({ sourceId: p.sourceId ?? p.id, name: p.name, species: p.species, breed: p.breed ?? undefined, vaccinationStatus: p.vaccinationStatus, medicationRequired: needs.includes("Medication") })), cityId: zone.cityId, zoneId: zone.zoneId, serviceCode: "boarding", packageCode: quote.packageCode, packageName: quote.packageName, scheduledStart, scheduledEnd, provider: decision.provider, totalAmount: quote.totalAmount, amountDueNow: quote.amountDueNow, payment: { method: "upi", mode: quote.paymentMode, status: "created", detail: "Awaiting verified Razorpay payment" }, pricing: { discount: 0, boardingQuoteId: quote.quoteId, boardingRequirements: reqs } };
  const created = await call("POST", "/api/canonical-bookings", payload);
  const bookingId = created.body?.data?.bookingId || null;
  if (bookingId) {
    const plan = { ...care, specialInstructions: [care.specialInstructions, needs.length ? `Care requests: ${needs.join(", ")}` : "", extras.length ? `Requested extras (subject to host agreement): ${extras.join(", ")}` : "", food ? `Food preference: ${food}` : ""].filter(Boolean).join("\n") };
    const stay = (await call("GET", `/api/boarding-stays?scope=customer&bookingId=${encodeURIComponent(bookingId)}`)).body?.data?.[0];
    if (stay) await call("POST", "/api/boarding-stays", { stayId: stay.id, action: "submit_care_plan", idempotencyKey: `initial-boarding-care:${bookingId}`, carePlan: plan });
  }
  return { bookingId, quote, reserve, trace: `API fallback: ${trace.join(", ")}${bookingId ? ` → ${bookingId}` : `; create refused ${JSON.stringify(created.body).slice(0, 160)}`}` };
}

async function bookStayUi(flow, net, { label, dates, pets, needs = [], extras = [], food = "", split, care = CARE, host = PREFERRED_HOST, create = true, expectRefusal = false, open = true }) {
  const { page } = flow;
  const r = { label, dates: { ...dates }, shots: [], stage: "open" };
  r.open = open ? await H.openStay(flow) : { cta: "See available homes", reused: true };
  if (r.open.cta !== "See available homes" && r.open.cta !== "Select a pet to continue") { r.stage = "plan"; r.shots.push(await flow.shot(`${label}-plan-blocked`)); return r; }
  for (let shift = 0; shift <= 2; shift++) {
    if (shift) {
      const add = (day) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };
      r.dates = { ...r.dates, start: add(r.dates.start), end: add(r.dates.end) };
      await H.robustClick(page.getByRole("button", { name: "← Plan" }));
    }
    r.summary = (await H.setStayDates(page, r.dates)).summary;
    r.selectedPets = await H.selectPets(page, pets);
    if (needs.length && !shift) await H.toggleChips(page, needs);
    if (!shift) r.shots.push(await flow.shot(`${label}-plan`));
    r.hosts = await H.toHosts(flow, { maxRetries: out.uiHostGaveUp ? 1 : 4 });
    if (r.hosts.state !== "hosts" && r.hosts.timeouts) out.uiHostGaveUp = (out.uiHostGaveUp || 0) + 1;
    if (r.hosts.state === "hosts" || r.hosts.blocked) break;
    r.noHost = oneLine(`${r.hosts.state}: ${r.hosts.alert}`, 300);
    if (r.hosts.state !== "none") break;
  }
  if (r.hosts.state !== "hosts") { r.stage = "hosts"; r.shots.push(await flow.shot(`${label}-no-hosts`)); return r; }
  if (host && r.hosts.hosts.some(h => h.name === host)) await H.chooseHost(page, host);
  r.cardPrice = await H.waitCardPrice(flow);
  r.shots.push(await flow.shot(`${label}-hosts`));
  r.stage = "hosts";
  r.host = await H.toCareCard(page);
  r.careCard = await H.fillCareCard(page, care, { extras, food });
  r.shots.push(await flow.shot(`${label}-care-card`));
  r.stage = "review";
  r.review = await H.toReview(flow, { split });
  r.reviewQuote = net.quotes.at(-1) || null;
  r.shots.push(await flow.shot(`${label}-review`));
  if (!create || r.review.cta !== "Create stay request & review payment") return r;
  r.create = await H.createStay(flow, net, { expectRefusal });
  r.shots.push(await flow.shot(`${label}-after-create`));
  r.bookingId = r.create.bookingId || null;
  r.quote = net.quotes.at(-1) || r.reviewQuote;
  r.reserve = net.reserve.filter(x => x.providerId).at(-1) || net.reserve.at(-1) || null;
  r.providerId = r.reserve?.providerId || null;
  r.stage = r.bookingId ? (r.create.state === "payment" ? "payment" : "created") : "create-refused";
  return r;
}

/** Pays the amount due now: in the booking flow's own payment step when it is on screen, else on /v2/booking. */
async function payStay(flow, net, r, { surface = "booking", stage, label }) {
  const { page, context } = flow;
  const p = { surface, shots: [] };
  const inFlow = surface === "flow" && await page.getByRole("button", { name: /^Pay securely/ }).first().isVisible().catch(() => false);
  if (!inFlow) { const before = await H.readBookingPage(flow, r.bookingId, `${label}-booking-before-pay`); p.before = before; p.shots.push(before.shot); p.surface = "booking page"; }
  else p.surface = "booking flow payment step";
  const pay = await H.payOnScreen(flow, net, r.bookingId, { button: stage === "balance" ? /^Pay balance/ : /^Pay securely/, stage });
  Object.assign(p, { opened: pay.opened, alert: pay.alert, order: pay.order, paid: pay.paid, captured: pay.captured, status: pay.status, label: pay.label, openMs: pay.openMs, clicks: pay.clicks, starts: pay.starts });
  if (pay.paid?.shot) p.shots.push(pay.paid.shot);
  if (pay.shotOpen) p.shots.push(pay.shotOpen);
  if (inFlow && pay.paid?.ok) { await page.getByText(/Boarding booking ·/).first().waitFor({ timeout: 60_000 }).catch(() => {}); p.flowAfter = oneLine(await H.mainText(page), 300); p.shots.push(await flow.shot(`${label}-flow-after-pay`)); }
  const after = await H.readBookingPage(flow, r.bookingId, `${label}-booking-after-pay`);
  p.after = after; p.shots.push(after.shot);
  for (const view of [p.before, after].filter(Boolean)) if (/not valid JSON/.test(view.text) && /DOCTYPE|<html/i.test(view.text)) file("raw-json-error", { severity: "P3", area: "Booking page", flow: "/v2/booking", title: "The booking page shows a raw JSON parse error when the server answers with an HTML error page", steps: `Open /v2/booking?bookingId=${r.bookingId}`, expected: "A customer-facing retry message", actual: oneLine(view.text, 200), evidence: [view.shot] });
  if (!p.status) p.status = await H.checkoutStatus(context, r.bookingId);
  return p;
}
function paymentFindings(journeyId, r, p, expectedDue, evidence) {
  const order = p.order;
  if (order?.amountPaise != null && Math.round(Number(expectedDue) * 100) !== Number(order.amountPaise)) file(`order-amount:${journeyId}`, { severity: "P0", area: "Payments", flow: journeyId, title: "Razorpay order amount differs from the amount due now", steps: `${p.label} on ${r.bookingId}`, expected: `${Math.round(expectedDue * 100)} paise`, actual: `${order.amountPaise} paise (order ${order.orderId})`, evidence });
  if (p.paid?.ok && !p.captured) file(`not-captured:${journeyId}`, { severity: "P1", area: "Payments", flow: journeyId, title: "Razorpay TEST payment succeeded but PawSpace did not show it captured within 150 s", steps: `Pay ${r.bookingId} in Razorpay TEST (Netbanking → Success)`, expected: "paymentStatus captured, booking confirmed", actual: JSON.stringify(p.status).slice(0, 300), evidence });
  if (p.captured && !["confirmed", "assigned", "in_progress"].includes(String(p.status?.bookingStatus))) file(`not-confirmed:${journeyId}`, { severity: "P1", area: "Booking lifecycle", flow: journeyId, title: "Captured Boarding payment did not confirm the booking", steps: `Pay ${r.bookingId}`, expected: "bookingStatus confirmed", actual: `bookingStatus ${p.status?.bookingStatus}`, evidence });
  if (!p.opened && p.alert && !/not configured/i.test(p.alert)) file(`checkout-refused:${journeyId}`, { severity: "P1", area: "Payments", flow: journeyId, title: "The booking page could not open the Razorpay TEST checkout", steps: `Open /v2/booking?bookingId=${r.bookingId} → ${p.label}`, expected: "Razorpay checkout opens", actual: p.alert, evidence });
}
/** A journey whose booking had to be created through the screen's APIs is at best PARTIAL. */
const viaUi = (r, result) => (r?.fallback && result === "PASS" ? "PARTIAL" : result);
const payBrief = (p) => `checkout ${p.opened ? "opened" : "NOT opened"} after ${p.clicks ?? "-"} click(s) in ${Math.round((p.openMs || 0) / 1000)} s [${(p.starts || []).join(", ")}]${p.alert ? ` alert "${p.alert}"` : ""}; Razorpay ${JSON.stringify(p.paid ? { ok: p.paid.ok, layout: p.paid.layout, error: p.paid.error, screen: p.paid.screen } : null)}`;
function reviewBrief(r) {
  const rv = r.review || {};
  return `${r.uiStoppedAt ? `V2 page stopped at ${r.uiStoppedAt} (client timeouts: hosts ${r.hosts?.timeouts || 0}/${r.hosts?.retries || 0} retries, price ${r.review?.priceTimeouts || 0}, create [${(r.create?.errors || []).join(" | ")}]) → ${r.fallback}; ` : ""}${r.summary || ""}; pets [${(r.selectedPets || []).join("+")}]; host ${r.host || "-"} of [${(r.hosts?.hosts || []).map(h => `${h.name}(${h.spots})`).join(", ")}]${r.hosts?.retries ? ` after ${r.hosts.retries} "Retry host search"` : ""}; card price "${r.cardPrice?.price || ""}"; bill [${(rv.billLines || []).join(" | ")}]; CTA "${rv.cta || ""}"`;
}

// ------------------------------------------------------------------------------------------------ journeys

async function setupCustomer(flow) {
  const { context } = flow;
  const who = await signIn(flow);
  let account = (await customerApi(context, "GET", "/api/customer-account")).body?.data;
  if (!account?.customerId) throw new Error(`harness: customer account not readable after OTP sign-in (${JSON.stringify(who).slice(0, 120)})`);
  CUSTOMER.id = account.customerId;
  const steps = [];
  for (const [name, species, breed, vaccinationStatus] of [[PETS.dog, "dog", "Indie", "verified"], [PETS.cat, "cat", "Persian", "verified"], [PETS.pup, "dog", "Beagle", "not_provided"]]) {
    const existing = account.pets?.find(p => p.name === name);
    if (existing && existing.vaccinationStatus === vaccinationStatus) continue;
    const r = await customerApi(context, "POST", "/api/customer-account", { customerId: account.customerId, action: "upsert_pet", idempotencyKey: `b20-pet-${name}-${PHONE}-${existing ? "fix" : "new"}`, pet: { ...(existing ? { id: existing.id } : {}), name, species, breed, vaccinationStatus } });
    steps.push(`${name} ${r.status}`);
  }
  const home = account.addresses?.find(a => a.postalCode === "560038");
  if (!home?.isDefault) {
    const r = await customerApi(context, "POST", "/api/customer-account", { customerId: account.customerId, action: "upsert_address", idempotencyKey: `b20-address-${PHONE}`, address: { ...(home ? { id: home.id } : {}), label: "Home", line1: "100 Feet Road, HAL 2nd Stage, Indiranagar", area: "Indiranagar", city: "Bengaluru", postalCode: "560038", isDefault: true } });
    steps.push(`address ${r.status}`);
  }
  account = (await customerApi(context, "GET", "/api/customer-account")).body?.data;
  const pets = Object.values(PETS).map(n => account?.pets?.find(p => p.name === n));
  const ok = pets.every(Boolean) && pets[0].vaccinationStatus === "verified" && pets[1].vaccinationStatus === "verified" && pets[2].vaccinationStatus !== "verified" && account.addresses?.find(a => a.isDefault)?.postalCode === "560038";
  out.customer = { id: CUSTOMER.id, phone: PHONE, pets: pets.map(p => p && `${p.name}:${p.species}:${p.vaccinationStatus}`) };
  rec("setup", "run-scoped OTP customer with BrdDog/BrdCat (vaccinated), BrdPup (not vaccinated), Indiranagar 560038", ok ? "PASS" : "BLOCKED", `${ok ? "" : "harness: "}customer ${CUSTOMER.id}; ${steps.join(", ") || "already set up"}; pets ${out.customer.pets.join(", ")}; default PIN ${account?.addresses?.find(a => a.isDefault)?.postalCode}`);
  if (!ok) throw new Error("harness: customer setup incomplete");
}

/** B1 / B6: 4 h daycare for one dog, paid in full. */
async function daycare(flow, net, { id, dates, mobile, nearTerm = false }) {
  await signIn(flow);
  const exp = expectedPrice(dates, 1, undefined);
  const r = await bookStay(flow, net, { label: id, dates, pets: [PETS.dog] });
  BK[id] = r;
  const combo = `${nearTerm ? "near-term " : ""}4 h daycare, 1 dog, ${r.dates.start} ${r.dates.startTime}–${r.dates.endTime} IST${mobile ? ", Pixel 7" : ""}, pay in full`;
  if (!r.bookingId) { rec(id, combo, r.stage === "hosts" && !r.hosts?.timeouts ? "BLOCKED" : "FAIL", `stopped at ${r.stage}: ${reviewBrief(r)}; ${r.noHost || ""} ${(r.create?.errors || []).join(" | ")}`, r.shots); return r; }
  const pc = priceCheck(r.quote, expectedPrice(r.dates, 1, undefined));
  if (!pc.priceOk) file(`price:${id}`, { severity: "P0", area: "Boarding pricing", flow: id, title: "Boarding 4 h daycare is not priced by the published rule", steps: `Plan ${combo}`, expected: `${inr(exp.total)} (₹499 × 1 pet)`, actual: pc.text, evidence: r.shots });
  const p = await payStay(flow, net, r, { surface: mobile ? "flow" : "booking", label: id });
  const evidence = [...r.shots, ...p.shots];
  paymentFindings(id, r, p, r.quote?.amountDueNow ?? exp.dueNow, evidence);
  const pageOk = p.after && /confirmed|assigned/i.test(String(p.after.status)) && /captured/i.test(String(p.after.paymentStatus)) && !p.after.payButton;
  const ok = pc.ok && p.captured && pageOk;
  rec(id, combo, viaUi(r, ok ? "PASS" : (p.opened === false && !p.alert ? "BLOCKED" : "FAIL")), `booking ${r.bookingId}; ${pc.text}; UI total ${inr(r.review?.total)}; ${reviewBrief(r)}; in-flow payment step reached: ${r.create?.state === "payment"}${r.create?.errors?.length ? ` (create/care retries: ${r.create.errors.join(" | ")})` : ""}; paid on ${p.surface}: "${p.label}" order ${p.order?.orderId || "-"} ${p.order?.amountPaise ?? "-"} paise; ${payBrief(p)}; server booking=${p.status?.bookingStatus} payment=${p.status?.paymentStatus} stage=${p.status?.paymentStage} due=${inr(p.status?.amountDueNow)}; /v2/booking "Status: ${p.after?.status} · Payment: ${p.after?.paymentStatus}" pay button ${p.after?.payButton || "none"}`, evidence);
  saveBooking({ suite: SUITE, bookingId: r.bookingId, service: "boarding", packageCode: r.quote?.packageCode || "boarding-4h", providerId: r.providerId || p.status?.providerId || null, customer: CUSTOMER.id, scheduledStart: H.istIso(r.dates.start, r.dates.startTime), scheduledEnd: H.istIso(r.dates.end, r.dates.endTime), total: r.quote?.totalAmount ?? exp.total, dueNow: r.quote?.amountDueNow ?? exp.dueNow, paid: Boolean(p.captured), paymentMode: "prepaid", ...(nearTerm ? { nearTerm: true } : {}) });
  Object.assign(r, { pay: p, paid: Boolean(p.captured), total: r.quote?.totalAmount, providerId: r.providerId || p.status?.providerId || null });
  if (nearTerm && r.paid) await acceptNow(r, id);
  return r;
}

/** A commission host's offer expires ~30 min after booking: the near-term stay is accepted by its host right away (runner). */
async function acceptNow(r, id) {
  if (!hasAccessCode()) { rec(`${id}-host-accept`, "host accepts the near-term stay right after payment", "BLOCKED", "harness: no UAT access code in this runner"); return; }
  const ctx = await browser.newContext();
  try {
    await providerSession(ctx, r.providerId);
    const stay = (await api(ctx, "GET", `/api/boarding-stays?bookingId=${encodeURIComponent(r.bookingId)}`, undefined, { timeout: 150_000 })).body?.data?.[0];
    const res = await api(ctx, "POST", "/api/boarding-stays", { stayId: stay?.id, action: "accept", idempotencyKey: `b20-accept-${r.bookingId}` }, { timeout: 150_000 });
    const after = (await api(ctx, "GET", `/api/boarding-stays?bookingId=${encodeURIComponent(r.bookingId)}`, undefined, { timeout: 150_000 })).body?.data?.[0];
    r.accepted = ["confirmed", "in_progress"].includes(String(after?.status));
    rec(`${id}-host-accept`, `${r.providerId} accepts ${r.bookingId} right after payment`, r.accepted ? "PASS" : "FAIL", `accept HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 200)}; stay ${stay?.status} → ${after?.status}; care plan ${after?.care_plan_status}`);
    if (!r.accepted) file(`${id}-accept`, { severity: "P1", area: "Boarding host lifecycle", persona: "Host", flow: "/api/boarding-stays accept", title: "Host could not accept a freshly paid near-term Boarding stay", steps: `Pay ${r.bookingId}; host ${r.providerId} accepts within minutes`, expected: "Stay confirmed", actual: `HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 200)}; status ${after?.status}`, evidence: [] });
  } catch (e) { rec(`${id}-host-accept`, "host accepts the near-term stay right after payment", "BLOCKED", `harness: ${oneLine(e?.message || e, 200)}`); }
  finally { await ctx.close(); }
}

/** B2: 2 nights, dog + cat, every add-on the Care Card offers, food preference, paid in full on /v2/booking. */
async function overnightAllAddOns(flow, net) {
  const id = "B2";
  await signIn(flow);
  const exp = expectedPrice(DATES.B2, 2, undefined);
  const r = await bookStay(flow, net, { label: id, dates: DATES.B2, pets: [PETS.dog, PETS.cat], needs: ["Two daily walks"], extras: ALL_EXTRAS, food: FOOD });
  BK[id] = r;
  const combo = `2 nights ${r.dates.start}→${r.dates.end}, dog + cat, all ${ALL_EXTRAS.length} add-ons + food "${FOOD}", pay in full`;
  // Add-ons: are they priced and itemised? (round-1 BRD-01: listed but not priced)
  const rv = r.review || {}, listed = ALL_EXTRAS.filter(x => String(rv.rows?.["Care benefits"] || "").includes(x));
  const itemised = ALL_EXTRAS.filter(x => (rv.billLines || []).some(line => line.includes(x)));
  const quote = r.reviewQuote, quoteHasAddOns = quote ? Object.keys(quote).some(k => /addon|add_on|extra/i.test(k) && k !== "extraPetPrice") : false;
  const unpricedTotal = quote && near(quote.totalAmount, Number(quote.basePricePerPet) * Number(quote.petCount) * Number(quote.stayUnits));
  const addOnEvidence = r.shots.filter(s => /care-card|review/.test(s));
  if (r.review) {
    const priced = itemised.length > 0 || quoteHasAddOns || (quote && !unpricedTotal);
    rec("B2-add-ons", `${ALL_EXTRAS.length} Care Card add-ons on a 2-night dog + cat stay`, priced ? "PASS" : "FAIL", `Care Card offers [${(r.careCard?.extrasOnScreen || []).join(", ")}] under "Requested extras · Subject to host agreement"; review "Care benefits": "${rv.rows?.["Care benefits"] || ""}" (${listed.length}/${ALL_EXTRAS.length} listed); bill lines [${(rv.billLines || []).join(" | ")}] itemise ${itemised.length} add-on(s); governed quote ${quote ? `${inr(quote.basePricePerPet)}×${quote.petCount}×${quote.stayUnits} = ${inr(quote.totalAmount)} (no add-on fields)` : "not captured"}; food "${rv.rows?.Food || ""}"`, addOnEvidence);
    if (!priced && listed.length) file("BRD-01", { severity: "P2", area: "Boarding add-ons", flow: "/v2/boarding Care Card → Review", title: "Boarding add-ons are still listed but neither priced nor itemised (BRD-01 re-verified on staging)", steps: `Plan 2 nights dog + cat → Care Card: select ${ALL_EXTRAS.join(", ")} → Review`, expected: "Each chargeable add-on priced and itemised on the bill (or clearly marked free/included), and the total/Razorpay order to match", actual: `Review lists "${rv.rows?.["Care benefits"]}" under Care benefits, but the bill is only [${(rv.billLines || []).join(" | ")}] and the governed quote carries no add-on amount (total ${inr(quote?.totalAmount)} = ${inr(quote?.basePricePerPet)} × ${quote?.petCount} pets × ${quote?.stayUnits} nights). The Care Card only says "Subject to host agreement"; the add-ons reach the host as free text.`, evidence: addOnEvidence });
  }
  else rec("B2-add-ons", `${ALL_EXTRAS.length} Care Card add-ons on a 2-night dog + cat stay`, "BLOCKED", `the V2 page did not reach Review: ${reviewBrief(r)}`, r.shots);
  if (!r.bookingId) { rec(id, combo, r.stage === "hosts" && !r.hosts?.timeouts ? "BLOCKED" : "FAIL", `stopped at ${r.stage}: ${reviewBrief(r)}; ${r.noHost || ""} ${(r.create?.errors || []).join(" | ")}`, r.shots); return r; }
  const pc = priceCheck(r.quote, expectedPrice(r.dates, 2, undefined));
  if (!pc.priceOk) file("price:B2", { severity: "P0", area: "Boarding pricing", flow: id, title: "2-night dog + cat stay is not priced by the per-pet rule", steps: `Plan ${combo}`, expected: `${inr(exp.total)} (₹699 × 2 nights × 2 pets)`, actual: pc.text, evidence: r.shots });
  const p = await payStay(flow, net, r, { surface: "booking", label: id });
  const evidence = [...r.shots, ...p.shots];
  paymentFindings(id, r, p, r.quote?.amountDueNow ?? exp.dueNow, evidence);
  const pageOk = p.after && /confirmed|assigned/i.test(String(p.after.status)) && /captured/i.test(String(p.after.paymentStatus)) && !p.after.payButton;
  rec(id, combo, viaUi(r, pc.ok && p.captured && pageOk ? "PASS" : (p.opened === false && !p.alert ? "BLOCKED" : "FAIL")), `booking ${r.bookingId}; ${pc.text}; UI total ${inr(r.review?.total)}; ${reviewBrief(r)}; paid on ${p.surface}: "${p.label}" order ${p.order?.orderId || "-"} ${p.order?.amountPaise ?? "-"} paise; ${payBrief(p)}; server booking=${p.status?.bookingStatus} payment=${p.status?.paymentStatus}; /v2/booking "Status: ${p.after?.status} · Payment: ${p.after?.paymentStatus}" pay button ${p.after?.payButton || "none"}`, evidence);
  saveBooking({ suite: SUITE, bookingId: r.bookingId, service: "boarding", packageCode: r.quote?.packageCode || "boarding-24h", providerId: r.providerId || p.status?.providerId || null, customer: CUSTOMER.id, scheduledStart: H.istIso(r.dates.start, r.dates.startTime), scheduledEnd: H.istIso(r.dates.end, r.dates.endTime), total: r.quote?.totalAmount ?? exp.total, dueNow: r.quote?.amountDueNow ?? exp.dueNow, paid: Boolean(p.captured), paymentMode: "prepaid" });
  Object.assign(r, { pay: p, paid: Boolean(p.captured), total: r.quote?.totalAmount, providerId: r.providerId || p.status?.providerId || null, pets: [PETS.dog, PETS.cat] });
  return r;
}

/** B3: 5 nights with the 50/50 split — deposit, the balance and its due date on /v2/booking (PAY-03), then the balance. */
async function splitStay(flow, net) {
  const id = "B3", { context } = flow;
  await signIn(flow);
  const exp = expectedPrice(DATES.B3, 1, true);
  const r = await bookStay(flow, net, { label: id, dates: DATES.B3, pets: [PETS.dog], split: true });
  BK[id] = r;
  const combo = `5 nights ${r.dates.start}→${r.dates.end}, 1 dog, "Reserve with 50% now"`;
  const rv = r.review || {};
  const oneDecimal = [...new Set(`${rv.payChoice} ${rv.hints?.join(" ")} ${rv.bill}`.match(/₹[\d,]+\.\d(?!\d)/g) || [])];
  if (oneDecimal.length) file("BRD-05", { severity: "P3", area: "Boarding pricing display", flow: "/v2/boarding review (split)", title: "Split amounts are rendered with one decimal (BRD-05 re-verified)", steps: "Review a 5-night split stay", expected: "₹1,747.50", actual: oneDecimal.join(", "), evidence: r.shots });
  if (!r.bookingId) { rec(id, combo, r.stage === "hosts" && !r.hosts?.timeouts ? "BLOCKED" : "FAIL", `stopped at ${r.stage}: split offered=${rv.splitOffered}; ${reviewBrief(r)}; ${r.noHost || ""} ${(r.create?.errors || []).join(" | ")}`, r.shots); return r; }
  const pc = priceCheck(r.quote, expectedPrice(r.dates, 1, true));
  if (!pc.priceOk || r.quote?.paymentMode !== "split_50_50") file("price:B3", { severity: "P0", area: "Boarding pricing", flow: id, title: "5-night split stay quote does not follow the rule (₹699 × 5, 50% now)", steps: `Plan ${combo}`, expected: `${inr(exp.total)}, due now ${inr(exp.dueNow)}, split_50_50`, actual: pc.text, evidence: r.shots });
  if (rv.splitOffered === false) file("split-not-offered", { severity: "P1", area: "Boarding payment schedule", flow: id, title: "50/50 split not offered for a 5-night stay", steps: `Review ${combo}`, expected: '"Reserve with 50% now" option', actual: rv.payChoice, evidence: r.shots });
  // Deposit.
  const dep = await payStay(flow, net, r, { surface: "flow", label: `${id}-deposit` });
  const depEvidence = [...r.shots, ...dep.shots];
  paymentFindings(`${id}-deposit`, r, dep, r.quote?.amountDueNow ?? exp.dueNow, depEvidence);
  const st = dep.status || {}, total = Number(r.quote?.totalAmount ?? exp.total), deposit = Number(r.quote?.amountDueNow ?? exp.dueNow), balance = Math.round((total - deposit) * 100) / 100;
  const dueAtExpected = Date.parse(H.istIso(r.dates.start, r.dates.startTime)) - 24 * 3_600_000, dueParts = H.istParts(dueAtExpected);
  const dueDay = Number(dueParts.date.slice(8, 10)), dueTime = `${Number(dueParts.time.slice(0, 2)) % 12 || 12}:${dueParts.time.slice(3)}`;
  const bp = dep.after || {};
  const showsBalance = /BALANCE PAYMENT/i.test(bp.payment || "") && near(bp.paidSoFar, deposit) && bp.balanceLine && H.parseMoney(bp.balanceLine) === balance && new RegExp(`\\b${dueDay}\\b[^₹]*${dueTime}`).test(bp.dueBy || "") && new RegExp(`^Pay balance · ₹${balance.toLocaleString("en-IN", { minimumFractionDigits: 2 })}$`).test(bp.payButton || "");
  const projectionOk = dep.captured && st.paymentStage === "outstanding_balance" && near(st.amountDueNow, balance) && Number(st.balanceDueAt) === dueAtExpected && st.balancePayableNow === true;
  const d1Deposit = await d1Money(r.bookingId);
  rec(`${id}-deposit`, `${combo}: deposit ${inr(deposit)}`, viaUi(r, pc.ok && dep.captured ? "PASS" : (dep.opened === false && !dep.alert ? "BLOCKED" : "FAIL")), `booking ${r.bookingId}; ${pc.text}; ${reviewBrief(r)}; review payment choice "${oneLine(rv.payChoice, 200)}"; paid on ${dep.surface}: "${dep.label}" order ${dep.order?.amountPaise ?? "-"} paise; ${payBrief(dep)}; server booking=${st.bookingStatus} payment=${st.paymentStatus} stage=${st.paymentStage}; ${d1Brief(d1Deposit)}`, depEvidence);
  rec(`${id}-balance-shown`, "after the deposit: balance, due date and 'Pay balance' on /v2/booking (PAY-03)", showsBalance && projectionOk ? "PASS" : dep.captured ? "FAIL" : "BLOCKED", `projection stage=${st.paymentStage} dueNow=${inr(st.amountDueNow)} paid=${inr(st.amountPaid)} balanceDueAt=${st.balanceDueAt ? new Date(st.balanceDueAt).toISOString() : null} (expected ${new Date(dueAtExpected).toISOString()} = check-in − 24 h) payableNow=${st.balancePayableNow}; page: "${oneLine(bp.payment, 400)}"`, [bp.shot]);
  if (dep.captured && !(showsBalance && projectionOk)) file("PAY-03", { severity: "P1", area: "Payments", flow: "/v2/booking after a split deposit", title: "After the 50% deposit the booking page does not show the balance with its due date and 'Pay balance' (PAY-03 regression)", steps: `Pay the deposit of ${r.bookingId} in Razorpay TEST, reopen /v2/booking`, expected: `Paid so far ${inr(deposit)}; Balance · due by ${dueParts.date} ${dueParts.time} IST ${inr(balance)}; "Pay balance · ${inr(balance)}"`, actual: `${oneLine(bp.payment, 300)} · projection ${JSON.stringify({ stage: st.paymentStage, due: st.amountDueNow, dueAt: st.balanceDueAt, payable: st.balancePayableNow })}`, evidence: [bp.shot] });
  if (d1Deposit.recon && d1Deposit.recon !== "partially_captured") file("recon-after-deposit", { severity: "P1", area: "Reconciliation", flow: id, title: "Reconciliation is not 'partially_captured' after a split deposit", steps: `Pay the deposit of ${r.bookingId}`, expected: "payment_reconciliation_records.reconciliation_status = partially_captured", actual: d1Brief(d1Deposit), evidence: [] });
  Object.assign(r, { deposit: dep, paid: Boolean(dep.captured), total, providerId: r.providerId || st.providerId || null, d1Deposit });
  // Balance.
  let bal = null;
  if (dep.captured && /Pay balance/.test(bp.payButton || "")) {
    bal = await payStay(flow, net, r, { surface: "booking", stage: "balance", label: `${id}-balance` });
    const bst = bal.status || {}, ev = bal.shots;
    paymentFindings(`${id}-balance`, r, { ...bal, captured: bal.captured }, balance, ev);
    const settled = bal.captured && bst.paymentStage === "settled" && Number(bst.amountDueNow) === 0;
    const pageClear = bal.after && !bal.after.payButton && /captured/i.test(String(bal.after.paymentStatus));
    rec(`${id}-balance`, `pay the balance ${inr(balance)} → fully paid`, settled && pageClear ? "PASS" : (bal.opened === false && !bal.alert ? "BLOCKED" : "FAIL"), `"${bal.label}" order ${bal.order?.orderId || "-"} ${bal.order?.amountPaise ?? "-"} paise; ${payBrief(bal)}; projection stage=${bst.paymentStage} dueNow=${inr(bst.amountDueNow)} payment=${bst.paymentStatus} booking=${bst.bookingStatus}; /v2/booking "Status: ${bal.after?.status} · Payment: ${bal.after?.paymentStatus}" pay button ${bal.after?.payButton || "none"}`, ev);
    if (bal.captured && !pageClear) file("balance-page", { severity: "P1", area: "Payments", flow: "/v2/booking after the balance", title: "After the balance is paid the booking page still offers a payment", steps: `Pay the balance of ${r.bookingId}, reopen /v2/booking`, expected: "No payment control; Payment: captured", actual: oneLine(bal.after?.text, 300), evidence: ev });
  } else rec(`${id}-balance`, `pay the balance ${inr(balance)} → fully paid`, dep.captured ? "FAIL" : "BLOCKED", dep.captured ? `no "Pay balance" control on /v2/booking: "${oneLine(bp.payment, 300)}"` : "deposit not captured", [bp.shot]);
  r.balance = bal; r.balancePaid = Boolean(bal?.captured);
  saveBooking({ suite: SUITE, bookingId: r.bookingId, service: "boarding", packageCode: r.quote?.packageCode || "boarding-24h", providerId: r.providerId, customer: CUSTOMER.id, scheduledStart: H.istIso(r.dates.start, r.dates.startTime), scheduledEnd: H.istIso(r.dates.end, r.dates.endTime), total, dueNow: deposit, paid: Boolean(dep.captured), paymentMode: "split_50_50", balancePaid: r.balancePaid });
  return r;
}

/** B4: what the flow refuses, and where. One page session, moving back with the flow's own "←" controls. */
async function validations(flow, net) {
  const { page } = flow;
  await signIn(flow);
  await H.openStay(flow);
  // (a) check-out before check-in
  const a = await H.setStayDates(page, { start: DATES.B4.start, startTime: "10:00", end: isoDay(BASE_DAY + 1), endTime: "10:00" });
  const aAlert = H.oneLine(await page.locator("[class*=durationSummary][role=alert]").first().innerText({ timeout: 1500 }).catch(() => ""));
  const aHint = H.oneLine(await page.getByText("End date must be after the start date.").first().innerText({ timeout: 1000 }).catch(() => ""));
  const aCta = page.getByRole("button", { name: "See available homes" });
  const aBlocked = !(await aCta.isEnabled().catch(() => true));
  const aShot = await flow.shot("B4a-checkout-before-checkin");
  rec("B4a", "check-out before check-in", aBlocked && aAlert ? "PASS" : "FAIL", `summary (role=alert) "${aAlert || a.summary}"; hint "${aHint}"; "See available homes" disabled=${aBlocked}`, [aShot]);
  if (!aBlocked) file("B4a", { severity: "P1", area: "Boarding validation", flow: "/v2/boarding Plan", title: "A check-out before check-in can still continue to host search", steps: "Plan: check-out one day before check-in", expected: "Blocked with a message", actual: `CTA enabled; summary "${a.summary}"`, evidence: [aShot] });
  // (b) unserviceable PIN (Delhi 110001) through the booking AddressPicker
  await H.robustClick(page.getByRole("button", { name: "Change Address" }));
  const line1 = page.locator("#grooming-address-line-1");
  await line1.waitFor({ timeout: 20_000 });
  await line1.fill("Connaught Place, New Delhi 110001");
  await page.waitForTimeout(2500);
  const verify = page.getByRole("button", { name: "Verify service address" }), suggestionButtons = page.locator("section[aria-label='Google address suggestions'] button");
  let bAlert = "", bPath = "", suggestions = [];
  for (let i = 0; i < 80 && !bAlert; i++) {
    bAlert = H.oneLine(await page.locator("section[aria-label='Care location'] [role=alert]").first().innerText({ timeout: 500 }).catch(() => ""), 300);
    if (bAlert) break;
    if (!bPath && await suggestionButtons.first().isVisible().catch(() => false)) { suggestions = (await suggestionButtons.allInnerTexts().catch(() => [])).map(t => H.oneLine(t, 80)); bPath = "first Google suggestion"; await H.robustClick(suggestionButtons.first()); continue; }
    if (!bPath && await verify.isEnabled().catch(() => false)) { bPath = "Verify service address"; await H.robustClick(verify); continue; }
    await page.waitForTimeout(500);
  }
  const useEnabled = await page.getByRole("button", { name: "Use this address" }).isEnabled().catch(() => false);
  const bCta = H.oneLine(await page.getByRole("button", { name: /^(See available homes|Verify a service address to continue|Select a pet to continue)$/ }).innerText().catch(() => ""));
  const bShot = await flow.shot("B4b-unserviceable-pin");
  const clear = /not (currently )?(serv|available|cover)|outside|don.?t serve|not serve|coming soon/i.test(bAlert);
  rec("B4b", "unserviceable PIN (Connaught Place, New Delhi 110001)", bAlert && !useEnabled && /Verify a service address/.test(bCta) ? (clear ? "PASS" : "PARTIAL") : "FAIL", `via ${bPath || "typing only"}: message "${bAlert}"; "Use this address" enabled=${useEnabled}; Plan CTA "${bCta}"; Google suggestions [${suggestions.slice(0, 3).join(" | ")}]`, [bShot]);
  if (bAlert && !clear) file("B4b", { severity: "P3", area: "Boarding service area", flow: "/v2/boarding Change Address", title: "An unserviceable PIN is refused with an unclear message", steps: "Change Address → 'Connaught Place, New Delhi 110001' → Verify service address", expected: "A customer-facing sentence such as 'PawSpace does not serve 110001 yet'", actual: `"${bAlert}"`, evidence: [bShot] });
  if (!bAlert || useEnabled) file("B4b-accepted", { severity: "P1", area: "Boarding service area", flow: "/v2/boarding Change Address", title: "An unserviceable Delhi PIN is not refused by the booking address step", steps: "Change Address → 'Connaught Place, New Delhi 110001' → Verify service address", expected: "Refused with a message; the stay cannot continue", actual: `alert "${bAlert}", Use this address enabled=${useEnabled}, CTA "${bCta}"`, evidence: [bShot] });
  // Back to the saved Indiranagar address (nothing was saved).
  const restored = await H.openStay(flow);
  // (c) unvaccinated pet: where is it refused?
  if (timeLeft() < 180_000) { for (const k of ["B4c", "B4d", "B4e"]) rec(k, "needs hosts, price and the Review step", "SKIPPED", "suite time budget"); return; }
  const planText = await H.mainText(page);
  const c = await bookStay(flow, net, { label: "B4c", dates: DATES.B4, pets: [PETS.pup], create: true, expectRefusal: true, open: false });
  const cAlert = (c.create?.errors || []).join(" | ") || c.create?.lastAlert || "";
  const refusedClientSide = /verified vaccination/i.test(cAlert) && !c.bookingId;
  const warnedEarlier = /vaccin/i.test(planText) || /vaccin/i.test((c.hosts?.hosts || []).map(h => h.text).join(" ")) || /vaccin/i.test(c.review?.review || "");
  rec("B4c", `unvaccinated pet (${PETS.pup}) — where the flow refuses it`, refusedClientSide ? (warnedEarlier ? "PASS" : "PARTIAL") : c.bookingId ? "FAIL" : "BLOCKED", `restored address CTA "${restored.cta}"; host step reached=${c.hosts?.state === "hosts"} (${(c.hosts?.hosts || []).length} hosts), Care Card and Review reached=${Boolean(c.review)}; refusal at the final "Create stay request & review payment" click: "${cAlert}"; any earlier vaccination hint=${warnedEarlier}; booking created=${c.bookingId || "no"}`, c.shots);
  if (refusedClientSide && !warnedEarlier) file("BRD-06", { severity: "P3", area: "Boarding UX", flow: "/v2/boarding", title: "An unvaccinated pet is refused only at the final click (BRD-06 re-verified on staging)", steps: `Select ${PETS.pup} (vaccination not provided) → See available homes → host → Care Card → Review → Create stay request`, expected: "The Plan step flags the pet (or hides it) before the customer builds the whole stay", actual: `Hosts, price, Care Card and Review all accept the pet; only the final click says "${cAlert}"`, evidence: c.shots });
  if (c.bookingId) { file("B4c-created", { severity: "P1", area: "Boarding validation", flow: "/v2/boarding", title: "A Boarding stay was created for an unvaccinated pet", steps: `Book ${PETS.pup}`, expected: "Refused", actual: `booking ${c.bookingId}`, evidence: c.shots }); await cancelUnpaid(flow, c.bookingId, "B4c"); }
  // (d) less than 24 h notice, (e) beyond 180 days — both refused by the reservation step (lib/booking-time-policy.ts).
  const now = Date.now(), soon = H.istParts(now + 20 * 3_600_000 + (15 - (Math.floor((now + 20 * 3_600_000) / 60_000) % 15)) * 60_000);
  const soonEnd = H.istParts(Date.parse(H.istIso(soon.date, soon.time)) + 4 * 3_600_000);
  const far = isoDay(185);
  for (const [key, combo, d, expectText] of [
    ["B4d", "less than 24 h notice (start in ~20 h, 4 h daycare)", { start: soon.date, startTime: soon.time, end: soonEnd.date, endTime: soonEnd.time }, /more notice|24 hours|1440 minutes|notice/i],
    ["B4e", "beyond the 180-day horizon (start in 185 days)", { start: far, startTime: "10:00", end: far, endTime: "14:00" }, /180 days|up to 180|horizon|too far/i],
  ]) {
    if (timeLeft() < 150_000) { rec(key, combo, "SKIPPED", "suite time budget"); continue; }
    const x = await bookStay(flow, net, { label: key, dates: d, pets: [PETS.dog], create: true, expectRefusal: true });
    const msg = (x.create?.errors || []).filter(e => !H.TRANSPORT.test(e)).at(-1) || x.create?.lastAlert || "";
    const reserveRow = net.reserve.at(-1) || {};
    const refused = !x.bookingId && Boolean(msg);
    const specific = expectText.test(msg);
    rec(key, combo, refused ? (specific ? "PASS" : "PARTIAL") : x.bookingId ? "FAIL" : "BLOCKED", `${x.summary || ""}; hosts listed ${(x.hosts?.hosts || []).length}, quote ${x.reviewQuote ? inr(x.reviewQuote.totalAmount) : "none"}; refusal "${msg}"; reservation HTTP ${reserveRow.http ?? "-"} code ${reserveRow.code ?? "-"} "${reserveRow.error ?? ""}"; booking created=${x.bookingId || "no"}`, x.shots);
    if (x.bookingId) { file(`${key}-created`, { severity: "P1", area: "Boarding booking rules", flow: "/v2/boarding", title: `Boarding accepted a stay that breaks the booking-time policy (${combo})`, steps: `Plan ${combo} → Create stay request`, expected: "Refused", actual: `booking ${x.bookingId}`, evidence: x.shots }); await cancelUnpaid(flow, x.bookingId, key); }
    else if (refused && specific && (x.hosts?.hosts || []).length) file(`${key}-late`, { severity: "P3", area: "Boarding booking rules", flow: "/v2/boarding Review", title: `${key === "B4d" ? "The 24-hour notice rule" : "The 180-day horizon"} is enforced only at the final click`, steps: `Plan ${combo} → hosts → Care Card → Review → Create stay request`, expected: "The Plan step refuses the dates before hosts and a price are shown", actual: `${(x.hosts?.hosts || []).length} hosts and a price are shown; the final click says "${msg}"`, evidence: x.shots });
    else if (refused && !specific) file(`${key}-message`, { severity: "P2", area: "Boarding booking rules", flow: "/v2/boarding Review", title: `${key === "B4d" ? "Short-notice" : "Beyond-180-day"} Boarding request is refused only at the final click with a message that does not state the rule`, steps: `Plan ${combo} → hosts → Care Card → Review → Create stay request`, expected: key === "B4d" ? "The 24-hour notice rule stated (ideally before host search)" : "The 180-day booking horizon stated (ideally on the date picker)", actual: `Hosts and a price are shown; the final click says "${msg}" (reservation ${reserveRow.http} ${reserveRow.code || reserveRow.error || ""})`, evidence: x.shots });
  }
}

/** Customer cancels an unpaid reservation from the manage page (owner decision 2026-09-22: capacity is released). */
async function cancelUnpaid(flow, bookingId, label) {
  const { page } = flow;
  await H.openManage(flow, bookingId, `${label}-manage-before-cancel`);
  await page.getByLabel(/^Reason/).last().fill("Master E2E: cancelling a test reservation");
  return H.manageAction(page, page.getByRole("button", { name: "Request cancellation" }), { busyLabel: "Recording request…", expect: /Cancellation request recorded/ });
}

async function hostSpots(context, dates, pets, species) {
  const q = new URLSearchParams({ cityId: "blr", zoneId: "blr-east", scheduledStart: H.istIso(dates.start, dates.startTime), scheduledEnd: H.istIso(dates.end, dates.endTime), petCount: String(pets), species });
  const r = await customerApi(context, "GET", `/api/boarding-commercial?${q}`);
  return Array.isArray(r.body?.data?.hosts) ? Object.fromEntries(r.body.data.hosts.map(h => [h.providerId, Number(h.availableGuestPets)])) : { error: `HTTP ${r.status}` };
}

/** B5: manage page of the paid B2 stay — care plan, date change, extension state, messaging. */
async function manageB2(flow) {
  const b2 = BK.B2, { page, context } = flow;
  if (!b2?.bookingId) { for (const j of ["B5-care-plan", "B5-date-change", "B5-extension", "B5-messaging"]) rec(j, "manage page of B2", "BLOCKED", "no B2 booking in this run"); return; }
  await signIn(flow);
  const m = await H.openManage(flow, b2.bookingId, "B5-manage-open");
  const careBefore = await H.readManageCare(page);
  // Care plan save.
  const marker = `Updated from the manage page (${String(SEED).slice(-4)})`;
  await page.getByLabel(/^Special instructions/).first().fill(`${careBefore.specialInstructions || CARE.specialInstructions}\n${marker}`);
  const save = await H.manageAction(page, page.getByRole("button", { name: /^(Save canonical care plan|Saving…)$/ }), { busyLabel: "Saving…", expect: /Care instructions saved/ });
  const staySaved = await readStay(context, b2.bookingId);
  const persisted = staySaved === undefined ? null : String(staySaved?.carePlan?.plan?.specialInstructions || "").includes(marker);
  const saveShot = await flow.shot("B5-care-plan-saved");
  rec("B5-care-plan", `save the care plan on ${b2.bookingId}`, save.ok && persisted ? "PASS" : persisted || (save.ok && persisted === null) ? "PARTIAL" : "FAIL", `stay "${m.status}", ${m.careHeader}; before: vet "${careBefore.vet}", emergency "${careBefore.emergencyContact}", feeding "${careBefore.feeding}"; outcome "${save.message || save.alerts.join(" | ")}" in ${Math.round(save.ms / 1000)} s; server plan now carries the edit=${persisted} (care_plan_status ${staySaved?.care_plan_status})`, [m.shot, saveShot]);
  if (persisted === false || (persisted === null && !save.ok)) file("B5-care-plan", { severity: "P1", area: "Boarding manage page", flow: "/v2/boarding/manage care plan", title: "Saving the care plan from the manage page did not persist", steps: `Edit Special instructions on ${b2.bookingId} → Save canonical care plan`, expected: "Care instructions saved and returned by the stay", actual: `"${save.message || save.alerts.join(" | ")}"; plan ${JSON.stringify(staySaved?.carePlan?.plan || null).slice(0, 200)}`, evidence: [saveShot] });
  // Date change request.
  const shift = (iso) => H.istParts(Date.parse(iso) + 86_400_000);
  const ns = shift(H.istIso(b2.dates.start, b2.dates.startTime)), ne = shift(H.istIso(b2.dates.end, b2.dates.endTime));
  await page.getByLabel("Requested check-in (IST)").fill(`${ns.date}T${ns.time}`);
  await page.getByLabel("Requested checkout (IST)").fill(`${ne.date}T${ne.time}`);
  await page.getByLabel(/^Reason/).first().fill("Master E2E: flight moved by one day");
  const change = await H.manageAction(page, page.getByRole("button", { name: /^(Request date change|Recording request…)$/ }).first(), { busyLabel: "Recording request…", expect: /Date-change request recorded/ });
  const stayAfter = await readStay(context, b2.bookingId);
  const unchanged = stayAfter && Date.parse(stayAfter.check_in_at) === Date.parse(H.istIso(b2.dates.start, b2.dates.startTime));
  const changeShot = await flow.shot("B5-date-change");
  rec("B5-date-change", `request a date change (+1 day) on ${b2.bookingId}`, change.ok && /commercial quote required/i.test(change.message) && unchanged ? "PASS" : change.ok ? "PARTIAL" : "FAIL", `requested ${ns.date} ${ns.time} → ${ne.date} ${ne.time} IST; outcome "${change.message || change.alerts.join(" | ")}" in ${Math.round(change.ms / 1000)} s; paid stay window unchanged=${unchanged} (${stayAfter?.check_in_at} → ${stayAfter?.check_out_at})`, [changeShot]);
  if (!change.ok) file("B5-date-change", { severity: "P1", area: "Boarding manage page", flow: "/v2/boarding/manage date change", title: "A customer date-change request on a paid stay was not recorded", steps: `Manage ${b2.bookingId} → Change stay dates (+1 day) → Request date change`, expected: "Recorded · Commercial quote required", actual: change.alerts.join(" | ") || "no confirmation", evidence: [changeShot] });
  // Extension and messaging before the host has accepted.
  const view = await H.readManage(flow, "B5-extension-messaging");
  const explained = /host (has )?accept|after (the )?host|once (the )?host|accepted stay/i.test(view.text.match(/STAY EXTENSION.{0,400}/)?.[0] || "");
  rec("B5-extension", `extension state before host acceptance (${view.status})`, !view.extensionEnabled ? (explained ? "PASS" : "PARTIAL") : "FAIL", `"Request extension" enabled=${view.extensionEnabled}; explanation on screen=${explained}: "${(view.text.match(/STAY EXTENSION.{0,260}/) || [""])[0]}"`, [view.shot]);
  if (!view.extensionEnabled && !explained) file("BRD-10", { severity: "P3", area: "Boarding manage page", flow: "/v2/boarding/manage extension", title: "'Request extension' is disabled before host acceptance with no explanation (BRD-10 re-verified)", steps: `Open manage for paid ${b2.bookingId} (awaiting host acceptance)`, expected: "Say that extensions open once the host accepts", actual: "Disabled button, no reason shown", evidence: [view.shot] });
  rec("B5-messaging", `caregiver messaging state (${view.status})`, view.conversation ? "PASS" : "FAIL", `can message=${view.canMessage}; panel "${oneLine(view.conversation, 300)}"`, [view.shot]);
  b2.manage = { status: view.status, canMessage: view.canMessage };
}

/** After the host accepted B2 (runner): extension request and a message to the host. */
async function manageB2AfterAcceptance(flow) {
  const b2 = BK.B2, { page } = flow;
  await signIn(flow);
  const m = await H.openManage(flow, b2.bookingId, "B5-after-acceptance");
  let ext = null;
  if (m.extensionEnabled) ext = await H.manageAction(page, page.getByRole("button", { name: /^(Request extension|Checking capacity…)$/ }), { busyLabel: "Checking capacity…", expect: /Extension request recorded/ });
  const extShot = await flow.shot("B5-extension-requested");
  const extLine = oneLine((await H.mainText(page)).match(/Latest request:[^.]*\.[^.]*\./)?.[0] || "", 200);
  rec("B5-extension-after-acceptance", `request an extension on the accepted stay (${m.status})`, ext?.ok ? "PASS" : m.extensionEnabled ? "FAIL" : "FAIL", `enabled=${m.extensionEnabled}; outcome "${ext?.message || ext?.alerts?.join(" | ") || "not attempted"}"; ${extLine}`, [m.shot, extShot]);
  if (m.extensionEnabled && !ext?.ok) file("B5-extension", { severity: "P1", area: "Boarding manage page", flow: "/v2/boarding/manage extension", title: "An extension request on an accepted Boarding stay failed", steps: `Manage ${b2.bookingId} (confirmed) → Request extension (+1 day)`, expected: "Recorded; commercial quote required; paid checkout unchanged", actual: ext?.alerts?.join(" | ") || "no confirmation", evidence: [extShot] });
  let sent = null;
  if (m.canMessage) {
    await page.locator("section[aria-label='Caregiver booking conversation'] textarea").fill("Master E2E: hello from the customer — please confirm the drop-off time.");
    await H.robustClick(page.getByRole("button", { name: "Send in PawSpace" }));
    sent = oneLine(await page.locator("section[aria-label='Caregiver booking conversation'] [role=status],section[aria-label='Caregiver booking conversation'] [role=alert]").first().innerText({ timeout: 60_000 }).catch(() => ""), 200);
  }
  const msgShot = await flow.shot("B5-message");
  rec("B5-messaging-after-acceptance", "message the host from the manage page once accepted", m.canMessage && /Message saved/i.test(sent || "") ? "PASS" : "FAIL", `can message=${m.canMessage}; outcome "${sent || m.conversation}"`, [msgShot]);
  if (!m.canMessage) file("B5-messaging", { severity: "P2", area: "Boarding messaging", flow: "/v2/boarding/manage", title: "Customer cannot message the host of an accepted, paid Boarding stay", steps: `Host accepts ${b2.bookingId}; customer opens manage`, expected: "Caregiver messaging open", actual: oneLine(m.conversation, 200), evidence: [msgShot] });
}

/** Paid cancellation request (goes to Finance policy review; nothing is refunded automatically). */
async function paidCancellation(flow) {
  const b2 = BK.B2, { page, context } = flow;
  if (!b2?.paid) { rec("B5-paid-cancellation", "customer cancellation request of a paid stay", "BLOCKED", "B2 was not paid in this run"); return; }
  await signIn(flow);
  await H.openManage(flow, b2.bookingId, "B5-before-paid-cancel");
  await page.getByLabel(/^Reason/).last().fill("Master E2E: plans changed, please review the refund");
  const res = await H.manageAction(page, page.getByRole("button", { name: /^(Request cancellation|Recording request…)$/ }), { busyLabel: "Recording request…", expect: /Cancellation request recorded/ });
  const shot = await flow.shot("B5-paid-cancel-requested");
  const status = await H.checkoutStatus(context, b2.bookingId);
  const stay = await readStay(context, b2.bookingId);
  const events = (stay?.events || []).map(e => e.event_type);
  // The stay read can time out on staging; the event is then not checked rather than counted as missing.
  const review = res.ok && /policy review required/i.test(res.message) && status.paymentStatus === "captured" && !["cancelled"].includes(String(status.bookingStatus)) && (stay === undefined || events.includes("cancellation_requested"));
  rec("B5-paid-cancellation", `customer asks to cancel the paid stay ${b2.bookingId}`, review ? "PASS" : "FAIL", `outcome "${res.message || res.alerts.join(" | ")}"; booking=${status.bookingStatus} payment=${status.paymentStatus} stay=${stay === undefined ? "not readable (timeout)" : stay?.status}; events [${events.join(", ")}]`, [shot]);
  if (!review) file("B5-paid-cancel", { severity: "P1", area: "Boarding cancellation", flow: "/v2/boarding/manage", title: "A paid Boarding cancellation request did not go to policy review as designed", steps: `Manage ${b2.bookingId} → Request cancellation`, expected: "Recorded · Policy review required; booking and payment unchanged", actual: `"${res.message || res.alerts.join(" | ")}"; booking ${status.bookingStatus}/${status.paymentStatus}; stay ${stay?.status}`, evidence: [shot] });
  b2.cancelRequested = review || res.ok;
}

/** B5: an unpaid reservation the customer cancels; its capacity must come back. */
async function unpaidReservation(flow, net) {
  const id = "B5-unpaid", { context } = flow;
  await signIn(flow);
  const r = await bookStay(flow, net, { label: id, dates: DATES.B5u, pets: [PETS.dog] });
  BK[id] = r;
  const combo = `unpaid 4 h reservation ${r.dates.start} ${r.dates.startTime} → customer cancels on the manage page`;
  if (!r.bookingId) { rec(id, combo, "BLOCKED", `harness: reservation not created (${r.stage}): ${(r.create?.errors || []).join(" | ")} ${r.noHost || ""}`, r.shots); return; }
  saveBooking({ suite: SUITE, bookingId: r.bookingId, service: "boarding", packageCode: r.quote?.packageCode || "boarding-4h", providerId: r.providerId, customer: CUSTOMER.id, scheduledStart: H.istIso(r.dates.start, r.dates.startTime), scheduledEnd: H.istIso(r.dates.end, r.dates.endTime), total: r.quote?.totalAmount ?? 499, dueNow: r.quote?.amountDueNow ?? 499, paid: false, paymentMode: "prepaid", cancelledByCustomer: true });
  const statusBefore = await H.checkoutStatus(context, r.bookingId);
  const spotsBefore = await hostSpots(context, r.dates, 1, "dog");
  const manageUnpaid = await H.openManage(flow, r.bookingId, "B5-unpaid-manage");
  const mentionsPayment = /payment (is )?pending|awaiting payment|unpaid|not (yet )?paid|pay now|complete (your )?payment|Pay securely/i.test(manageUnpaid.text);
  if (!mentionsPayment) file("BRD-02", { severity: "P2", area: "Boarding manage page", flow: "/v2/boarding/manage (unpaid)", title: "An unpaid Boarding reservation's manage page shows no payment-pending state or pay link (BRD-02 re-verified)", steps: `Create ${r.bookingId}, do not pay, open Manage`, expected: "Payment pending + a way to pay (or a link to the booking page)", actual: `"${manageUnpaid.status}": ${oneLine(manageUnpaid.text.match(/CANONICAL BOARDING STAY.{0,260}/)?.[0], 260)}`, evidence: [manageUnpaid.shot] });
  const res = await cancelUnpaid(flow, r.bookingId, id);
  const shot = await flow.shot("B5-unpaid-cancelled");
  const statusAfter = await H.checkoutStatus(context, r.bookingId);
  const spotsAfter = await hostSpots(context, r.dates, 1, "dog");
  const host = r.providerId, before = spotsBefore[host] ?? 0, after = spotsAfter[host] ?? 0;
  const released = after > before;
  const ok = res.ok && /Cancelled/i.test(res.message) && statusAfter.bookingStatus === "cancelled" && released;
  r.cancelled = statusAfter.bookingStatus === "cancelled";
  rec(id, combo, ok ? "PASS" : "FAIL", `booking ${r.bookingId} (booking=${statusBefore.bookingStatus} payment=${statusBefore.paymentStatus} before); manage status "${manageUnpaid.status}", payment state shown=${mentionsPayment}; outcome "${res.message || res.alerts.join(" | ")}"; after: booking=${statusAfter.bookingStatus}; host ${host} spots for the window ${before} → ${after} (${JSON.stringify(spotsBefore)} → ${JSON.stringify(spotsAfter)})`, [...r.shots, manageUnpaid.shot, shot]);
  if (!ok) file("B5-unpaid", { severity: "P1", area: "Boarding cancellation", flow: "/v2/boarding/manage (unpaid)", title: "Cancelling an unpaid Boarding reservation did not cancel it and release the host capacity", steps: `Create ${r.bookingId} unpaid → Manage → Request cancellation`, expected: "Cancelled; the host's guest-pet spots for the window return", actual: `"${res.message || res.alerts.join(" | ")}"; booking ${statusAfter.bookingStatus}; spots ${before} → ${after}`, evidence: [shot] });
}

/** B6: near-term daycare for the partner-due suite: earliest start ≥ 24 h 15 min from now inside the host roster day. */
function nearTermDates() {
  // Boarding hosts' UAT roster window is 00:00–23:59 IST (app/api/uat-scheduling seedUatRoster) and Boarding is
  // capacity-scheduled with no time-of-day check; the booking-time policy needs 24 h notice. A daycare is kept to
  // 07:00–19:00 IST starts (ending by 23:00), rounded up to the next quarter hour.
  const earliest = Date.now() + (24 * 60 + 15) * 60_000;
  let at = Math.ceil(earliest / 900_000) * 900_000, p = H.istParts(at);
  const hour = Number(p.time.slice(0, 2));
  if (hour < 7) at = Date.parse(H.istIso(p.date, "07:00"));
  else if (hour > 19 || (hour === 19 && p.time !== "19:00")) { const next = new Date(`${p.date}T00:00:00Z`); next.setUTCDate(next.getUTCDate() + 1); at = Date.parse(H.istIso(next.toISOString().slice(0, 10), "07:00")); }
  p = H.istParts(at); const e = H.istParts(at + 4 * 3_600_000);
  return { start: p.date, startTime: p.time, end: e.date, endTime: e.time };
}

// ------------------------------------------------------------------------------------------------ host (runner)

async function hostPhase() {
  if (!want("host")) return;
  const b2 = BK.B2;
  const paid = ["B1", "B2", "B3", "B6"].map(k => BK[k]).filter(r => r?.paid && r.bookingId);
  const rows = ["H-partner-app", "H-pets-care-plan", "H-accept", "H-contacts-after-accept", "H-early-check-in", "H-earnings"];
  if (!hasAccessCode()) { for (const j of rows) rec(j, "Boarding host", "BLOCKED", "harness: no UAT access code in this runner"); return; }
  if (!b2?.paid || !b2.providerId) { for (const j of rows) rec(j, "Boarding host", "BLOCKED", `B2 not paid or host unknown (${b2?.bookingId || "no booking"})`); return; }
  await journey("host", "Boarding host", async (flow) => {
    const { page, context } = flow;
    // Pets + care plan of every paid stay, as each stay's own host sees it (acceptance-gated projection).
    const careRows = [];
    for (const r of paid) {
      if (!r.providerId) { careRows.push(`${r.bookingId}: host unknown`); continue; }
      await providerSession(context, r.providerId);
      const s = (await api(context, "GET", `/api/boarding-stays?bookingId=${encodeURIComponent(r.bookingId)}`, undefined, { timeout: 150_000 })).body?.data?.[0];
      const plan = s?.carePlan?.plan || {}, withheld = s?.carePlan?.withheldUntilAccepted || [];
      const pets = (s?.pets || []).map(p => p.name);
      const ok = s && pets.length === (r === b2 ? 2 : 1) && plan.feeding && !plan.emergencyContact && !plan.vet && withheld.includes("emergencyContact") && withheld.includes("vet");
      r.hostView = { ok, pets, status: s?.status };
      careRows.push(`${r.bookingId}@${r.providerId}: ${s?.status} pets [${pets.join(", ")}] feeding "${oneLine(plan.feeding, 40)}" extras [${(s?.carePlan?.requestedExtras || []).join(", ")}] contacts ${plan.emergencyContact || plan.vet ? "VISIBLE" : "withheld"} (${withheld.join("/")})`);
      if (s && (plan.emergencyContact || plan.vet)) file(`contacts-leak:${r.bookingId}`, { severity: "P0", area: "Boarding host privacy", persona: "Host", flow: "/api/boarding-stays (host)", title: "Host sees the customer's emergency contact / vet before accepting the stay (PARTNER-01 regression)", steps: `Host ${r.providerId} reads ${r.bookingId} before acceptance`, expected: "withheldUntilAccepted: emergencyContact, vet", actual: JSON.stringify({ emergencyContact: plan.emergencyContact, vet: plan.vet }), evidence: [] });
    }
    // Partner app (the host's home) lists the paid stays.
    await providerSession(context, b2.providerId);
    await page.goto(`${BASE}/partner-app`, { waitUntil: "domcontentloaded" }); await dismissCookies(page);
    await page.locator("section[aria-label='Other assigned services']").waitFor({ timeout: 90_000 }).catch(() => {});
    await settle(page, 1500);
    const listText = oneLine(await page.locator("section[aria-label='Other assigned services']").innerText().catch(() => ""), 1200);
    const links = await page.locator("section[aria-label='Other assigned services'] a").evaluateAll(els => els.map(a => a.getAttribute("href"))).catch(() => []);
    const mine = paid.filter(r => r.providerId === b2.providerId);
    const listed = mine.filter(r => links.some(h => String(h).includes(encodeURIComponent(r.bookingId)) || String(h).includes(r.bookingId)));
    const appShot = await flow.shot("H-partner-app-home");
    rec("H-partner-app", `${b2.providerId} partner app lists its paid stays`, listed.length === mine.length ? "PASS" : "FAIL", `${listed.length}/${mine.length} of this host's paid stays linked (${mine.map(r => r.bookingId).join(", ")}); section "${listText.slice(0, 400)}"`, [appShot]);
    if (listed.length < mine.length) file("H-partner-app", { severity: "P1", area: "Partner app", persona: "Host", flow: "/partner-app", title: "The host's partner app does not list a paid Boarding stay", steps: `Sign in as ${b2.providerId}, open /partner-app`, expected: `Service workspace links for ${mine.map(r => r.bookingId).join(", ")}`, actual: `links ${JSON.stringify(links).slice(0, 300)}`, evidence: [appShot] });
    // Host workspace: pets + care plan before acceptance, then accept in the UI.
    await H.openHost(flow, b2.bookingId);
    await H.hostTab(page, "Requests");
    const care = oneLine(await page.getByRole("region", { name: "Pets and care plan" }).first().innerText({ timeout: 20_000 }).catch(() => ""), 900);
    const beforeShot = await flow.shot("H-request-before-accept");
    const uiPets = [PETS.dog, PETS.cat].every(n => care.includes(n)), uiWithheld = /Shared once the booking is paid and you have accepted it/.test(care), uiFeeding = care.includes(CARE.feeding.slice(0, 20));
    rec("H-pets-care-plan", "host sees pets + care plan, contacts withheld until acceptance (PARTNER-01)", uiPets && uiWithheld && uiFeeding && paid.every(r => r.hostView?.ok !== false) ? "PASS" : "FAIL", `UI (${b2.bookingId}): "${care.slice(0, 500)}"; API per stay: ${careRows.join(" · ")}`, [beforeShot]);
    if (!(uiPets && uiFeeding)) file("PARTNER-01", { severity: "P1", area: "Boarding host workspace", persona: "Host", flow: "/host Requests", title: "Host workspace does not show the pets and care plan of a paid stay (PARTNER-01 regression)", steps: `Host ${b2.providerId} → /host?bookingId=${b2.bookingId} → Requests`, expected: `${PETS.dog}, ${PETS.cat} and the feeding/medication plan`, actual: care.slice(0, 300), evidence: [beforeShot] });
    const accept = page.getByRole("button", { name: /^Accept & lock capacity$/ });
    const acceptEnabled = await accept.isEnabled().catch(() => false);
    if (acceptEnabled) await H.robustClick(accept);
    let accepted = null;
    for (let i = 0; i < 24; i++) { await page.waitForTimeout(5000); const s = (await api(context, "GET", `/api/boarding-stays?bookingId=${encodeURIComponent(b2.bookingId)}`, undefined, { timeout: 150_000 })).body?.data?.[0]; if (s?.status === "confirmed" || s?.status === "in_progress") { accepted = s; break; } accepted = s; }
    const panel = oneLine(await page.locator("section[class*=panel]").filter({ hasText: "Action required" }).first().innerText({ timeout: 1000 }).catch(() => ""), 300);
    const acceptShot = await flow.shot("H-after-accept");
    const acceptedOk = ["confirmed", "in_progress"].includes(String(accepted?.status));
    rec("H-accept", `host accepts ${b2.bookingId} in the UI`, acceptedOk ? "PASS" : "FAIL", `"Accept & lock capacity" enabled=${acceptEnabled}; stay status ${accepted?.status}; ${panel}`, [acceptShot]);
    if (!acceptedOk) file("H-accept", { severity: "P1", area: "Boarding host workspace", persona: "Host", flow: "/host Requests → Accept", title: "Host could not accept a paid Boarding stay", steps: `Host ${b2.providerId} → Requests → Accept & lock capacity on ${b2.bookingId}`, expected: "Stay confirmed, capacity locked", actual: `status ${accepted?.status}; ${panel || "no message"}`, evidence: [acceptShot] });
    b2.accepted = acceptedOk;
    // Contacts after acceptance.
    const plan = accepted?.carePlan?.plan || {};
    await H.openHost(flow, b2.bookingId);
    const today = oneLine(await H.mainText(page), 3000);
    const todayShowsB2 = today.includes(b2.bookingId);
    const contactsUi = todayShowsB2 && today.includes(CARE.vet.slice(0, 12)) && today.includes(CARE.emergencyContact.slice(0, 10));
    const contactsShot = await flow.shot("H-contacts-after-accept");
    rec("H-contacts-after-accept", "emergency contact + vet visible once accepted", acceptedOk && plan.emergencyContact && plan.vet ? "PASS" : acceptedOk ? "FAIL" : "BLOCKED", `API: emergency "${plan.emergencyContact}", vet "${plan.vet}"; Today panel shows ${todayShowsB2 ? b2.bookingId : "another stay (earliest accepted)"}, contacts on screen=${contactsUi}`, [contactsShot]);
    if (acceptedOk && !(plan.emergencyContact && plan.vet)) file("H-contacts", { severity: "P1", area: "Boarding host workspace", persona: "Host", flow: "/host after acceptance", title: "Host still cannot see emergency contact / vet after accepting a paid stay", steps: `Accept ${b2.bookingId}, read the stay`, expected: "Contacts released on acceptance", actual: JSON.stringify(plan).slice(0, 200), evidence: [contactsShot] });
    // Early check-in (time gate): the stay starts weeks from now.
    let early = null;
    const checkIn = page.getByRole("button", { name: "✓ Check in" });
    if (todayShowsB2 && await checkIn.isEnabled().catch(() => false)) {
      await H.robustClick(checkIn);
      await page.waitForTimeout(8000);
      early = { via: "UI", text: oneLine(await page.locator("section[class*=panel]").filter({ hasText: "Action required" }).first().innerText({ timeout: 30_000 }).catch(() => ""), 300) };
    }
    const apiTry = await api(context, "POST", "/api/boarding-stays", { stayId: accepted?.id, action: "check_in", idempotencyKey: `b20-early-checkin-${b2.bookingId}` }, { timeout: 150_000 });
    const after = (await api(context, "GET", `/api/boarding-stays?bookingId=${encodeURIComponent(b2.bookingId)}`, undefined, { timeout: 150_000 })).body?.data?.[0];
    const earlyShot = await flow.shot("H-early-check-in");
    const refused = apiTry.status === 409 && after?.check_in_status !== "complete";
    const clearMsg = /before the Boarding stay window starts|too early|not started|starts at/i.test(`${apiTry.body?.error} ${early?.text || ""}`);
    rec("H-early-check-in", `check in ${b2.bookingId} weeks before ${b2.dates.start}`, refused ? (clearMsg ? "PASS" : "PARTIAL") : acceptedOk ? "FAIL" : "BLOCKED", `${early ? `UI "✓ Check in" → "${early.text}"; ` : "UI Check in not on the Today panel for this stay; "}API check_in → HTTP ${apiTry.status} ${JSON.stringify(apiTry.body).slice(0, 200)}; check_in_status ${after?.check_in_status}`, [earlyShot]);
    if (!refused && acceptedOk) file("H-early-check-in", { severity: "P1", area: "Boarding host lifecycle", persona: "Host", flow: "/host check-in", title: "Host can check in a Boarding stay weeks before it starts", steps: `Accept ${b2.bookingId} → Check in now`, expected: "409 before the stay window", actual: `HTTP ${apiTry.status}; check_in_status ${after?.check_in_status}`, evidence: [earlyShot] });
    if (refused && !clearMsg) file("PARTNER-05", { severity: "P2", area: "Boarding host workspace", persona: "Host", flow: "/host check-in", title: "An early Boarding check-in is refused with a generic message instead of the time gate (PARTNER-05 re-verified)", steps: `Accept ${b2.bookingId} → ✓ Check in weeks early`, expected: '"Cannot check in before the Boarding stay window starts"', actual: `HTTP ${apiTry.status} "${apiTry.body?.error}"${early ? `; UI "${early.text}"` : ""}`, evidence: [earlyShot] });
    // Earnings.
    await page.goto(`${BASE}/partner-app`, { waitUntil: "domcontentloaded" });
    await H.robustClick(page.getByRole("button", { name: /Earnings/ }).first());
    await page.getByText(/Commission earned|Computed net payout|Earnings are not shown yet/).first().waitFor({ timeout: 90_000 }).catch(() => {});
    await settle(page, 1500);
    const earn = oneLine(await H.mainText(page), 1500);
    const ws = (await api(context, "GET", "/api/provider-workspace", undefined, { timeout: 150_000 })).body?.data;
    const e = ws?.earnings || {};
    const nums = [e.netPayout, e.grossOrderValue, ...(e.commissionOrders || []).flatMap(o => [o.commissionAmount, o.orderAmount])].filter(v => v != null);
    const nan = /NaN|undefined|Infinity/.test(earn) || nums.some(v => !Number.isFinite(Number(v)));
    const zeroWithOrders = Number(e.orders || 0) > 0 && Number(e.netPayout || 0) === 0;
    await H.openHost(flow, b2.bookingId); await H.hostTab(page, "Settlement");
    const settlement = oneLine(await H.mainText(page), 800);
    const earnShot = await flow.shot("H-earnings");
    rec("H-earnings", `${b2.providerId} earnings view`, !nan && !zeroWithOrders && /Commission earned|Computed net payout/.test(earn) ? "PASS" : "FAIL", `partner app: "${(earn.match(/(Commission earned|Computed net payout).{0,260}/) || [earn.slice(0, 260)])[0]}"; API engagement ${ws?.engagement} netPayout ${e.netPayout} orders ${e.orders} gross ${e.grossOrderValue}; host Settlement tab: "${(settlement.match(/Settlement status.{0,200}/) || [""])[0]}"`, [earnShot]);
    if (nan || zeroWithOrders) file("H-earnings", { severity: "P2", area: "Partner earnings", persona: "Host", flow: "/partner-app Earnings", title: "Host earnings view shows an impossible payout", steps: `Host ${b2.providerId} → Earnings`, expected: "Finite payout; non-zero when orders are counted", actual: `netPayout ${e.netPayout}, orders ${e.orders}; screen "${earn.slice(0, 200)}"`, evidence: [earnShot] });
  }, { needMs: 300_000 });
}

// ------------------------------------------------------------------------------------------------ staff (runner)

async function staffPhase() {
  if (!want("staff")) return;
  const all = ["B1", "B2", "B3", "B6", "B5-unpaid"].map(k => [k, BK[k]]).filter(([, r]) => r?.bookingId);
  if (!hasAccessCode()) { for (const j of ["S-bcc", "S-finance-boarding", "S-finance-mfa"]) rec(j, "staff", "BLOCKED", "harness: no UAT access code in this runner"); return; }
  await journey("staff", "Booking Command Center + Finance", async (flow) => {
    const { page, context } = flow;
    await staffSession(context, "founder@pawspace.in");
    const rows = [];
    let bad = [];
    for (const [k, r] of all) {
      const res = await api(context, "GET", `/api/booking-command-center?q=${encodeURIComponent(r.bookingId)}&limit=5`, undefined, { timeout: 150_000 });
      const b = (res.body?.bookings || []).find(x => x.id === r.bookingId);
      const exp = k === "B5-unpaid" ? { status: "cancelled", payment: "created", due: null } : { payment: "captured", due: 0, stage: "settled" };
      const total = Number(r.total ?? r.quote?.totalAmount);
      const ok = b && (k === "B5-unpaid" ? b.status === "cancelled" : b.payment_status === "captured" && near(b.payment_amount, total) && Number(b.amount_due_now) === 0 && b.payment_stage === "settled" && ["confirmed", "assigned"].includes(String(b.status)));
      if (!ok && !(k === "B3" && !r.balancePaid) && r.paid !== false) bad.push(k);
      rows.push(`${k} ${r.bookingId}: ${b ? `status ${b.status} · payment ${b.payment_status} ${inr(b.payment_amount)} (${b.payment_mode}) due now ${inr(b.amount_due_now)} stage ${b.payment_stage} refunds ${b.refunds?.length ?? 0}` : `not found (HTTP ${res.status})`}`);
      void exp;
    }
    await page.goto(`${BASE}/team/operations/bookings`, { waitUntil: "domcontentloaded" }); await dismissCookies(page);
    const probe = BK.B3?.bookingId || all[0]?.[1]?.bookingId;
    if (probe) { await page.getByPlaceholder("Search booking, customer, pet, phone or provider").fill(probe); await page.waitForTimeout(6000); }
    await page.getByText("Loading connected booking records…").waitFor({ state: "detached", timeout: 90_000 }).catch(() => {});
    await settle(page, 2000);
    const bccText = oneLine(await H.mainText(page), 800);
    const bccShot = await flow.shot("S-bcc-search");
    rec("S-bcc", "Booking Command Center finds each booking with its payment state and amounts", !bad.length && (!probe || bccText.includes(probe)) ? "PASS" : "FAIL", `${rows.join(" · ")}; UI search "${probe}" shows it=${probe ? bccText.includes(probe) : "-"}`, [bccShot]);
    if (bad.length) file("S-bcc", { severity: "P1", area: "Booking Command Center", persona: "Staff", flow: "/team/operations/bookings", title: "Booking Command Center shows a wrong payment state or amount for a Boarding booking", steps: "Search each booking id as founder", expected: "Paid stays: captured, full amount, due now ₹0, settled; the cancelled reservation: cancelled", actual: rows.filter(x => bad.some(k => x.startsWith(k))).join(" · "), evidence: [bccShot] });
    // Finance: B2's paid cancellation request waiting on Finance.
    const b2 = BK.B2;
    if (b2?.cancelRequested) {
      const queue = await api(context, "GET", "/api/boarding-finance?view=queue", undefined, { timeout: 150_000 });
      const item = (queue.body?.data?.items || []).find(x => x.booking_id === b2.bookingId);
      await page.goto(`${BASE}/team/finance/boarding?bookingId=${encodeURIComponent(b2.bookingId)}`, { waitUntil: "domcontentloaded" }); await dismissCookies(page);
      await page.getByText("Loading pending Boarding requests…").waitFor({ state: "detached", timeout: 90_000 }).catch(() => {});
      await settle(page, 3000);
      const text = oneLine(await H.mainText(page), 1500);
      const finShot = await flow.shot("S-finance-boarding");
      const listed = Boolean(item) && Number(item.pending_cancellations) > 0 && text.includes(b2.bookingId) && /Cancellation awaiting policy review|policy review required/i.test(text);
      rec("S-finance-boarding", `/team/finance/boarding lists ${b2.bookingId}'s paid cancellation request`, listed ? "PASS" : "FAIL", `queue HTTP ${queue.status}: ${item ? `pending_cancellations ${item.pending_cancellations}, pending_date_changes ${item.pending_date_changes}, stay ${item.stay_status}, payment ${item.payment_status}` : "not listed"}; page "${text.slice(0, 400)}"`, [finShot]);
      if (!listed) file("S-finance", { severity: "P1", area: "Finance", persona: "Finance", flow: "/team/finance/boarding", title: "A paid Boarding cancellation request is not waiting in the Finance Boarding queue", steps: `Customer requests cancellation of ${b2.bookingId}; founder opens /team/finance/boarding`, expected: "Listed with 'Cancellation awaiting policy review'", actual: item ? JSON.stringify(item).slice(0, 200) : `not in queue (HTTP ${queue.status})`, evidence: [finShot] });
    } else rec("S-finance-boarding", "/team/finance/boarding lists B2's paid cancellation request", "BLOCKED", "no paid cancellation request was made in this run");
    // The Finance persona needs MFA on staging (expected security control, lib/admin-mfa.ts).
    const fin = await browser.newContext();
    try {
      await staffSession(fin, "anjali.finance33@tkpetcare.in");
      const r = await api(fin, "GET", "/api/boarding-finance?view=queue", undefined, { timeout: 150_000 });
      rec("S-finance-mfa", "Finance persona without MFA is refused (expected)", r.status === 403 && /MFA enrollment required/i.test(JSON.stringify(r.body)) ? "PASS" : "FAIL", `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    } catch (e) { rec("S-finance-mfa", "Finance persona without MFA is refused (expected)", "BLOCKED", `harness: ${oneLine(e?.message || e, 200)}`); }
    finally { await fin.close(); }
  }, { needMs: 200_000 });
}

// ------------------------------------------------------------------------------------------------ D1 (runner)

async function d1Money(bookingId) {
  const q = async (sql) => { const r = await d1(sql, [bookingId]).catch(e => ({ error: String(e?.message || e) })); return r; };
  const pay = await q("SELECT id,status,amount,amount_due_now,mode FROM booking_payments WHERE booking_id=?");
  if (pay?.skipped) return { skipped: pay.skipped };
  if (!Array.isArray(pay)) return { error: JSON.stringify(pay).slice(0, 200) };
  const p = pay[0] || {};
  const [events, recon, ledger, life, stay, locks, sched] = await Promise.all([
    q("SELECT event_type,processing_status,amount_subunits,signature_verified,gateway_payment_id,failure_reason FROM payment_gateway_events WHERE booking_id=? ORDER BY received_at"),
    q("SELECT expected_amount,captured_amount,refunded_amount,reconciliation_status,variance_amount FROM payment_reconciliation_records WHERE booking_id=?"),
    d1("SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS total FROM collection_ledger_postings WHERE payment_id=? AND event='online_payment_captured'", [p.id || ""]),
    q("SELECT event_type, COUNT(*) AS n FROM booking_lifecycle_events WHERE booking_id=? GROUP BY event_type"),
    q("SELECT id,status,care_plan_status,billed_units,pet_count,host_provider_id,check_in_status FROM boarding_stays WHERE booking_id=?"),
    q("SELECT status,capacity_units,provider_id FROM boarding_capacity_locks WHERE booking_id=?"),
    q("SELECT status,paid_now_amount,balance_amount,balance_due_at FROM stay_payment_schedules WHERE booking_id=?"),
  ]);
  const arr = (x) => (Array.isArray(x) ? x : []);
  // payment.captured and order.paid (and repeats) all name the same gateway payment: count each payment once.
  const captures = arr(events).filter(e => ["payment.captured", "order.paid", "payment_link.paid"].includes(e.event_type) && e.processing_status === "processed");
  const byPayment = new Map(captures.map(e => [e.gateway_payment_id || `${e.event_type}:${e.amount_subunits}`, Number(e.amount_subunits || 0) / 100]));
  return { payment: p, events: arr(events), capturedByEvents: [...byPayment.values()].reduce((s, v) => s + v, 0), gatewayPayments: byPayment.size, recon: arr(recon)[0]?.reconciliation_status || null, reconRow: arr(recon)[0] || null, ledger: arr(ledger)[0] || null, lifecycle: Object.fromEntries(arr(life).map(r => [r.event_type, Number(r.n)])), stay: arr(stay)[0] || null, locks: arr(locks), schedule: arr(sched)[0] || null };
}
function d1Brief(x) {
  if (!x) return "d1: n/a"; if (x.skipped) return `d1: not checked (${x.skipped})`; if (x.error) return `d1: read failed ${x.error}`;
  return `d1: payment ${x.payment?.status} ${x.payment?.amount} due ${x.payment?.amount_due_now} ${x.payment?.mode}; captures [${x.events.map(e => `${e.event_type}/${e.processing_status}/${e.amount_subunits}`).join(",")}]; recon ${x.recon} captured ${x.reconRow?.captured_amount}; ledger ${x.ledger?.n} posting(s) ₹${x.ledger?.total}; lifecycle ${JSON.stringify(x.lifecycle)}; stay ${x.stay?.status}/${x.stay?.care_plan_status} units ${x.stay?.billed_units} pets ${x.stay?.pet_count}; locks ${JSON.stringify(x.locks)}${x.schedule ? `; schedule ${x.schedule.status} ${x.schedule.paid_now_amount}+${x.schedule.balance_amount}` : ""}`;
}
async function d1Phase() {
  const list = ["B1", "B2", "B3", "B6", "B5-unpaid"].map(k => [k, BK[k]]).filter(([, r]) => r?.bookingId);
  for (const [k, r] of list) {
    try {
      const x = await d1Money(r.bookingId);
      if (x.skipped) { rec(`D1-${k}`, `${r.bookingId} books`, "BLOCKED", `harness: d1 not checked (${x.skipped})`); continue; }
      if (x.error) { rec(`D1-${k}`, `${r.bookingId} books`, "BLOCKED", `harness: ${x.error}`); continue; }
      const problems = [];
      if (k === "B5-unpaid") {
        if (x.payment?.status === "captured") problems.push("unpaid reservation shows a capture");
        if (x.stay?.status !== "cancelled") problems.push(`stay ${x.stay?.status}`);
        const res = await d1("SELECT r.status, COUNT(*) AS n FROM scheduling_reservations r JOIN canonical_bookings b ON b.schedule_group_id=r.group_id WHERE b.id=? GROUP BY r.status", [r.bookingId]);
        if (Array.isArray(res) && res.some(row => row.status !== "cancelled")) problems.push(`reservations ${JSON.stringify(res)}`);
        if (x.locks.some(l => l.status === "active")) problems.push("active capacity lock");
      } else if (r.paid) {
        const captured = k === "B3" ? (r.balancePaid ? Number(r.total) : Number(r.deposit?.status?.amountPaid ?? r.quote?.amountDueNow)) : Number(r.total);
        if (x.payment?.status !== "captured") problems.push(`booking_payments ${x.payment?.status}`);
        if (!near(x.payment?.amount, r.total)) problems.push(`amount ${x.payment?.amount} ≠ ${r.total}`);
        if (!near(x.capturedByEvents, captured)) problems.push(`processed captures ₹${x.capturedByEvents} ≠ ₹${captured}`);
        if (!near(x.reconRow?.captured_amount, captured)) problems.push(`reconciliation captured ${x.reconRow?.captured_amount}`);
        const wantRecon = k === "B3" && !r.balancePaid ? "partially_captured" : "matched";
        if (x.recon !== wantRecon) problems.push(`reconciliation ${x.recon} (want ${wantRecon})`);
        if (!near(x.ledger?.total, captured)) problems.push(`collection ledger ₹${x.ledger?.total} ≠ captured ₹${captured}`);
        if (!(x.lifecycle.payment_captured >= (k === "B3" && r.balancePaid ? 2 : 1))) problems.push(`lifecycle payment_captured ${x.lifecycle.payment_captured || 0}`);
        if (!x.stay) problems.push("no boarding_stays row");
        if (x.stay && Number(x.stay.pet_count) !== (k === "B2" ? 2 : 1)) problems.push(`stay pet_count ${x.stay.pet_count}`);
        if (k === "B2" && r.accepted && !x.locks.some(l => l.status === "active")) problems.push("no active capacity lock after host acceptance");
        if (k === "B3" && r.balancePaid && x.schedule?.status !== "paid") problems.push(`stay_payment_schedules ${x.schedule?.status}`);
      }
      rec(`D1-${k}`, `${r.bookingId} books (read-only D1)`, problems.length ? "FAIL" : "PASS", `${problems.length ? `problems: ${problems.join("; ")} · ` : ""}${d1Brief(x)}`);
      if (problems.length) file(`D1-${k}`, { severity: problems.some(p => /capture|amount|ledger|reconciliation/.test(p)) ? "P0" : "P1", area: "Payments / books", persona: "Finance", flow: `D1 read-back ${k}`, title: `Staging books disagree with what was paid for ${k} (${r.bookingId})`, steps: `Pay ${r.bookingId} through /v2/booking in Razorpay TEST; read D1`, expected: "Payment captured, captures processed, reconciliation matched/partially_captured, ledger = money captured, lifecycle events, stay row", actual: `${problems.join("; ")} — ${d1Brief(x)}`.slice(0, 900), evidence: [] });
    } catch (e) { rec(`D1-${k}`, `${r.bookingId} books`, "BLOCKED", `harness: ${oneLine(e?.message || e, 200)}`); }
  }
}

// ------------------------------------------------------------------------------------------------ run

async function main() {
  browser = await launch();
  log(`BASE ${BASE}; seed ${SEED}; base day +${BASE_DAY} (${DATES.B1.start}); customer phone ${PHONE}; access code ${hasAccessCode() ? "present" : "absent"}`);
  const setupOk = await journey("setup", "customer", setupCustomer, { needMs: 60_000 }).then(() => Boolean(CUSTOMER.id)).catch(() => false);
  if (!setupOk && !ONLY.size) { rec("suite", "customer journeys", "BLOCKED", "harness: customer setup failed"); return; }
  await journey("B1", "4 h daycare on Pixel 7", (flow, net) => daycare(flow, net, { id: "B1", dates: DATES.B1, mobile: true }), { mobile: true, video: true, needMs: 420_000 });
  await journey("B2", "2 nights dog + cat, all add-ons", overnightAllAddOns, { needMs: 420_000 });
  // B2's commission-host offer expires ~30 min after booking: manage it and let the host accept before the long journeys.
  await journey("B5", "manage page of B2", manageB2, { needMs: 240_000 });
  await hostPhase();
  await journey("B3", "5 nights split 50/50", splitStay, { needMs: 600_000 });
  await journey("B6", "near-term 4 h daycare", (flow, net) => daycare(flow, net, { id: "B6", dates: nearTermDates(), nearTerm: true }), { needMs: 420_000 });
  await journey("B5-unpaid", "unpaid reservation cancelled by the customer", unpaidReservation, { needMs: 360_000 });
  if (BK.B2?.accepted) await journey("B5-after", "manage after host acceptance", manageB2AfterAcceptance, { needMs: 180_000 });
  else if (want("B5-after") && BK.B2?.bookingId) { rec("B5-extension-after-acceptance", "request an extension on the accepted stay", "BLOCKED", hasAccessCode() ? "the host did not accept B2" : "harness: host acceptance needs the UAT access code (runner only)"); rec("B5-messaging-after-acceptance", "message the host once accepted", "BLOCKED", hasAccessCode() ? "the host did not accept B2" : "harness: host acceptance needs the UAT access code (runner only)"); }
  await journey("B5-cancel", "paid cancellation request", paidCancellation, { needMs: 150_000 });
  await staffPhase();
  if (want("D1")) await d1Phase();
  await journey("B4", "validation", validations, { needMs: 120_000 });
  // Latency: one finding for the whole run, with every client-side abort as evidence.
  const aborted = out.latency.flatMap(l => l.aborted.map(a => `${l.journey}: ${a}`)), slow = out.latency.flatMap(l => l.slow.map(a => `${l.journey}: ${a}`));
  if (aborted.length) {
    const stopped = Object.entries(BK).filter(([, r]) => r?.uiStoppedAt).map(([k, r]) => `${k} at ${r.uiStoppedAt}`), blocked = stopped.length > 0;
    file("latency", { severity: blocked ? "P1" : "P2", area: "Boarding performance", flow: "/v2/boarding (hosts, price, create, care plan)", title: `V2 Boarding calls exceed the page's own client timeouts on staging (${aborted.length} aborted in this run)`, steps: "Book Boarding stays on /v2/boarding: host search and price (15 s client timeout), create (20 s), care-plan save before payment (15 s)", expected: "Hosts, price, booking and care plan answer well inside the client timeouts", actual: `${blocked ? `The V2 page could not complete ${stopped.join(", ")} even after the page's own Retry controls (bookings then created through the same APIs). ` : ""}${aborted.slice(0, 12).join("; ")}${slow.length ? `; slow but answered: ${slow.slice(0, 6).join("; ")}` : ""}. The customer sees "Boarding request timed out. Please try again." / "The request took too long" and must retry. Likely cause (code read): lib/boarding-governance.ts ensureBoardingGovernanceTables has no per-isolate guard and issues ~18 sequential D1 statements (11 writes: package and host INSERT OR IGNORE + host UPDATEs) on every call; GET /api/boarding-commercial runs it twice (listBoardingPackages, discoverBoardingHosts → ensureBoardingStayLifecycleTables) and the stay/care-plan writes run it again.`, evidence: [] });
  }
  if (want("D1") && process.env.CLOUDFLARE_API_TOKEN && Object.values(BK).some(r => r?.paid)) await recordWebhookCheck(SUITE).catch(() => {});
}

try { await main(); }
catch (e) { log(`suite aborted: ${oneLine(e?.stack || e, 600)}`); rec("suite", "harness", "BLOCKED", `harness: ${oneLine(e?.message || e, 400)}`); }
finally {
  out.bookings = Object.fromEntries(Object.entries(BK).filter(([, r]) => r).map(([k, r]) => [k, { bookingId: r.bookingId, dates: r.dates, providerId: r.providerId, total: r.total ?? r.quote?.totalAmount, paid: r.paid, balancePaid: r.balancePaid, accepted: r.accepted, cancelled: r.cancelled, stage: r.stage }]));
  out.ms = Date.now() - STARTED;
  writeJson("boarding-journeys.json", out);
  await browser?.close().catch(() => {});
  log(`done in ${Math.round(out.ms / 1000)} s`);
}
