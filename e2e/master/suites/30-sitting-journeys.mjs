// Master suite 30 — Pet Sitting end to end on the REAL V2 screens: customer → sitter → staff → money (staging).
//
// Customer journeys (each its own run-scoped OTP customer, booked through /v2/sitting unless noted):
//   S1  Home Visit 60 min · 1 dog · Meet & Greet (in-person) requested for this sitter and date (SIT-01)
//       → pay in full on the payment step ("Pay securely", Razorpay TEST) → manage page shows the linked M&G.
//   S2  Home Visit 60 min · dog + cat (₹548) → pay in full. Pixel 7 with video; the plan is set like a person
//       would (after the page has loaded), so the number of automatic sitter searches is measured too.
//   S3  Overnight 1 night · dog + cat → pay in full (₹799 + ₹399 per the rule in lib/sitting-governance.ts).
//   S4  Overnight 5 nights · 1 dog · split 50/50 → deposit, then "Pay balance" on /v2/booking → fully paid.
//   S5  Validation: 2-hour visit not offered by the UI and refused by /api/sitting-commercial (SIT-04) and by
//       the scheduler; 10 h 00 min refused / 10 h 01 min = 1 overnight; a second customer asking for S3's sitter
//       on an overlapping night is refused or given another sitter (SIT-03); less than 24 h notice refused.
//   S6  Near-term Home Visit at the earliest allowed time (≥ 24 h 15 min, within the sitter's hours), created
//       through the same APIs the screen calls and paid on /v2/booking; saved with nearTerm:true for the
//       partner-due suite.
// Runner only (UAT access code / D1 credentials): the S1 sitter in the partner app (paid visit listed, door
// code / emergency contact / vet withheld until acceptance and shown after "Accept booking" (SIT-02), an early
// check-in refused, earnings view sane), staff Booking Command Center + Meet & Greet page, and D1 read-backs.
import {
  BASE, launch, newFlow, settle, api, runPhone, isoDay, WINDOWS, record, finding, saveBooking, writeJson,
  hasAccessCode, providerSession, staffSession, d1, dismissCookies,
} from "../lib.mjs";
import * as H from "./_30-sitting-journeys-helpers.mjs";

const SUITE = "30-sitting-journeys";
const STARTED = Date.now();
const BUDGET_MS = 32 * 60_000; // the runner kills a suite at 40 minutes; later phases are skipped past this
const RUN_KEY = String(process.env.GITHUB_RUN_ID || process.env.MASTER_RUN_ID || Date.now());
const ATTEMPT = Math.max(1, Number(process.env.GITHUB_RUN_ATTEMPT || 1));
const SEED = Number(RUN_KEY.slice(-6)) + (ATTEMPT - 1) * 7;
// Run-scoped 10-digit "97…" phones (the partner-due suite discovers bookings by a 97… phone, a CUS-OTP- id and a
// "Master E2E" name): 97 + the run id's last 5 digits + attempt + "3" + journey. runPhone(1..9) of the other suites
// puts the run id's last 7 digits in the same places, so the two never coincide within a run.
const phone = k => `97${RUN_KEY.replace(/\D/g, "").slice(-5).padStart(5, "0")}${ATTEMPT % 10}3${k}`;
const [W0, W1] = WINDOWS.sitting;
const BASE_DAY = W0 + (SEED % 12); // S4 ends at BASE_DAY + 10 ≤ W1 - 2
const VISIT_TIMES = ["10:00", "11:00", "12:00", "14:00", "15:00", "16:00"];
const T1 = VISIT_TIMES[SEED % 6], T2 = VISIT_TIMES[(SEED + 3) % 6];
const DAYS = { s1: isoDay(BASE_DAY), s2: isoDay(BASE_DAY + 1), s3: isoDay(BASE_DAY + 2), s3out: isoDay(BASE_DAY + 3), s4: isoDay(BASE_DAY + 5), s4out: isoDay(BASE_DAY + 10), s5a: isoDay(BASE_DAY + 4) };
if (BASE_DAY + 10 > W1) throw new Error("sitting window arithmetic");
const DOOR = String(1000 + (SEED % 9000));
const care = key => ({
  feeding: `Master E2E ${key}: two meals, 8 am and 7 pm; fresh water`,
  medication: "No medication. No known allergies.",
  vet: `Dr. Rao (UAT test vet ${key}), 9000000001`,
  emergencyContact: `Asha (UAT test contact ${key}), 9000000002`,
  homeAccess: `Door code ${DOOR}-${key}; spare key with the security desk`,
  specialInstructions: `Master E2E ${SUITE} ${key}; keep the balcony door closed`,
});
const DOG = { name: "SitDog", species: "dog" }, CAT = { name: "SitCat", species: "cat" };
const out = { suite: SUITE, base: BASE, runKey: RUN_KEY, attempt: ATTEMPT, baseDay: BASE_DAY, days: DAYS, times: { T1, T2 }, journeys: {}, previews: [], findingsFiled: [] };
const created = {};
const filed = new Set();
const elapsed = () => Math.round((Date.now() - STARTED) / 1000);
const log = text => console.log(`[${SUITE} +${elapsed()}s] ${text}`);
const overBudget = () => Date.now() - STARTED > BUDGET_MS;
// Local iteration aid only (never set on the runner): MASTER_SIT_ONLY=S1,S3,S5 runs just those journeys.
const ONLY = String(process.env.MASTER_SIT_ONLY || "").split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
const wanted = key => !ONLY.length || ONLY.includes(key);
const skipped = key => Promise.resolve({ o: null, skipped: key });

function file(key, row) {
  if (filed.has(key)) return;
  filed.add(key);
  out.findingsFiled.push({ key, severity: row.severity, title: row.title });
  finding({ suite: SUITE, ...row });
}
function money(n) { return n == null ? "?" : `₹${Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`; }

/** Unexpected 5xx on a booking/payment path is P1, other 5xx and uncaught page errors P2 (brief contract). */
function flowHealth(flow, journey, evidence) {
  // Outside GitHub Actions this container's egress cuts browser calls at ~30 s with a plain-text 502
  // "upstream request failed"; that is recorded as a transport note, not a product defect.
  const localCut = failure => !process.env.GITHUB_ACTIONS && ((failure.status === 502 && /^upstream request failed$/i.test(String(failure.body || "").trim())) || (failure.status >= 500 && !String(failure.body || "").trim()));
  out.transportNotes = [...(out.transportNotes || []), ...flow.log.apiFailures.filter(localCut).map(f => `${journey}: ${f.method} ${f.url.split("?")[0]} 502`)];
  const bookingPath = /\/api\/(uat-scheduling|sitting-|customer-checkout|customer-meet-and-greet|canonical-bookings|customer-account|service-zone)/;
  // The sitter search's governed 503 SCHEDULING_PREVIEW_TIMEOUT is counted in the performance finding instead.
  const previewTimeout = failure => failure.status === 503 && /SCHEDULING_PREVIEW_TIMEOUT/.test(String(failure.body || ""));
  out.previewTimeouts = (out.previewTimeouts || 0) + flow.log.apiFailures.filter(previewTimeout).length;
  for (const failure of flow.log.apiFailures.filter(a => a.status >= 500 && !localCut(a) && !previewTimeout(a))) {
    const path = failure.url.split("?")[0], body = String(failure.body || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 160);
    const cf = /Worker threw exception/i.test(failure.body || "") ? "Cloudflare 'Worker threw exception'" : body;
    file(`5xx:${path}:${failure.status}:${cf.slice(0, 40)}`, {
      severity: bookingPath.test(path) ? "P1" : "P2", area: "Pet Sitting", persona: "Customer", flow: journey,
      title: `${failure.method} ${path} answered HTTP ${failure.status} during the Pet Sitting journey`,
      steps: `${journey}: ${failure.method} ${path} (screen step ${failure.at})`, expected: "No server error on the booking path", actual: `HTTP ${failure.status}: ${cf}`, evidence,
    });
  }
  for (const error of flow.log.pageErrors) file(`pageerror:${String(error.text).slice(0, 60)}`, { severity: "P2", area: "Pet Sitting", persona: "Customer", flow: journey, title: `Uncaught page error on the Pet Sitting screens: ${String(error.text).slice(0, 90)}`, steps: journey, expected: "No uncaught page error", actual: String(error.text).slice(0, 300), evidence });
}

// ------------------------------------------------------------------------------------------------ customer
/**
 * One customer booking through /v2/sitting: plan → sitter → Care Card (+ optional Meet & Greet) → review →
 * "Request sitter & review payment" → pay the amount due on the payment step. Returns everything observed.
 */
async function bookThroughScreen(flow, spec) {
  const { page } = flow;
  const net = H.watchNet(page);
  const o = { key: spec.key, evidence: [], checks: [] };
  const check = (label, ok, detail = "") => { o.checks.push({ label, ok: Boolean(ok), detail }); return ok; };
  const cust = await H.setupCustomer(flow.context, { phone: phone(spec.slot), name: `Master E2E Sitting ${spec.key}`, pets: spec.accountPets, tag: `${RUN_KEY}-${ATTEMPT}-${spec.key}` });
  o.customerId = cust.customerId;
  const pets = spec.pets.map(p => cust.pets.find(x => x?.name === p.name));
  if (pets.some(p => !p)) throw new Error(`harness: pets not created for ${spec.key}`);
  await H.openSitting(flow);
  if (spec.natural) {
    // A person waits for the page, then sets care type, date, time and pets one by one.
    await page.getByRole("button", { name: /See available sitters|Select a pet to continue/ }).waitFor({ timeout: 60_000 }).catch(() => {});
    await settle(page, 1500);
  }
  const planStartedAt = Date.now();
  o.plan = await H.planCare(flow, { mode: spec.mode, day: spec.day, time: spec.time, endDay: spec.endDay, endTime: spec.endTime, pets, otherPets: cust.pets.filter(p => p && !spec.pets.some(x => x.name === p.name)) });
  o.evidence.push(await flow.shot("plan"));
  check("plan: window summary shown", o.plan.summary && !/more than 10 hours|Choose a check-out/.test(o.plan.summary), o.plan.summary);
  check("plan: exactly the chosen pets selected", o.plan.selected.join("+") === spec.pets.map(p => p.name).join("+"), o.plan.selected.join("+"));
  if (spec.mode === "visit") check("plan: Home Visit is 60 minutes (no check-out to choose)", /^60 minutes, ending/.test(o.plan.visitHint || "") && !(await page.getByLabel("Check-out time").count()), o.plan.visitHint);
  if (!o.plan.ctaEnabled) { o.blockedAt = "plan"; o.blockDetail = `plan CTA "${o.plan.cta}"`; return o; }
  const searchAt = Date.now();
  o.sitter = await H.chooseSitter(flow, { prefer: spec.preferSitter, avoid: spec.avoidSitters || [] });
  o.previewsBeforeSearch = net.previewStarts.filter(t => t < searchAt).length;
  o.previewsPlanning = net.previewStarts.filter(t => t >= planStartedAt && t < searchAt).length;
  o.evidence.push(await flow.shot("sitters"));
  if (!o.sitter.chosen) { o.blockedAt = "sitter"; o.blockDetail = `${o.sitter.alerts.some(a => H.TRANSPORT.test(a)) ? "harness: sitter search transport error" : "capacity:"} no sitter offered: ${o.sitter.alerts.join(" | ") || "empty list"}`; return o; }
  const unitWord = spec.mode === "visit" ? "visit" : "night";
  check(`sitter card price reads per ${unitWord}`, new RegExp(`/ ${unitWord}`).test(o.sitter.chosenPriceLabel || ""), o.sitter.chosenPriceLabel);
  o.care = await H.buildCareCard(flow, { net, care: care(spec.key), meet: spec.meet });
  o.evidence.push(await flow.shot("care-card"));
  if (spec.meet) {
    const m = o.care.meet;
    check("Meet & Greet request accepted (201)", m?.status === 201 && /^MGR-/.test(m?.request?.id || ""), JSON.stringify({ status: m?.status, id: m?.request?.id, error: m?.error }));
    check("Meet & Greet fee per policy (in-person ₹499 for a stay under 5 days)", m?.request?.priceCharged === 499 && m?.request?.format === "house_visit", JSON.stringify({ fee: m?.request?.priceCharged, format: m?.request?.format, days: m?.request?.intendedStayDays }));
    check("Meet & Greet for this sitter and these dates", m?.request?.intendedStayStart === spec.day && m?.request?.intendedStayEnd === (spec.endDay || spec.day), JSON.stringify({ host: m?.request?.hostProviderId, start: m?.request?.intendedStayStart, end: m?.request?.intendedStayEnd }));
    o.meet = m?.request || null;
  }
  o.review = await H.review(flow, { split: Boolean(spec.split) });
  o.evidence.push(await flow.shot("review"));
  const quote = H.quotes(net).filter(q => q.status < 300 && q.req?.providerId).at(-1)?.json?.data || null;
  o.reviewQuote = quote && { quoteId: quote.quoteId, packageCode: quote.packageCode, mode: quote.mode, units: quote.billableUnits, base: quote.basePricePerPet, extra: quote.extraPetPrice, total: quote.totalAmount, dueNow: quote.amountDueNow, paymentMode: quote.paymentMode, priceSource: quote.priceSource || null, providerId: quote.providerId || null };
  const exp = H.expectedSittingPrice({ mode: spec.mode, start: H.istIso(spec.day, spec.time), end: spec.mode === "visit" ? new Date(Date.parse(H.istIso(spec.day, spec.time)) + 3_600_000).toISOString() : H.istIso(spec.endDay, spec.endTime), pets: spec.pets.length, split: Boolean(spec.split) });
  o.expected = exp;
  check(`review: split 50/50 ${spec.split ? "offered" : "not offered"} (only overnight > 4 nights)`, o.review.splitOffered === Boolean(spec.splitEligible), `split offered: ${o.review.splitOffered}`);
  check(`quote = rule (${exp.packageCode}, ${exp.units} unit(s), ${money(exp.total)}, due now ${money(exp.dueNow)})`, quote && quote.packageCode === exp.packageCode && quote.billableUnits === exp.units && quote.totalAmount === exp.total && quote.amountDueNow === exp.dueNow, JSON.stringify(o.reviewQuote));
  check("review: booking total shown = rule", o.review.bookingTotal === exp.total, `shown ${money(o.review.bookingTotal)}`);
  check("review: amount collected now shown = rule", o.review.collectNow === exp.dueNow, `shown ${money(o.review.collectNow)}; ${o.review.laterText}`);
  if (spec.meet) check("review: the separate introduction is listed", o.review.introduction.includes(o.meet?.id || "MGR-"), o.review.introduction);
  if (!o.review.ctaEnabled) { o.blockedAt = "review"; o.blockDetail = `review CTA "${o.review.cta}"`; return o; }
  // Book: reserve → canonical booking → care plan → payment step.
  o.request = await H.requestBooking(flow, net);
  o.evidence.push(await flow.shot(o.request.paymentVisible ? "payment-step" : "after-request"));
  o.bookingId = o.request.bookingId;
  o.providerId = o.request.reserveCall?.provider?.id || null;
  o.groupId = o.request.reserveCall?.groupId || null;
  if (!o.bookingId) { o.blockedAt = "request"; o.blockDetail = `no booking: alerts ${JSON.stringify(o.request.alerts)} reserve ${JSON.stringify(o.request.reserveCall)} booking ${JSON.stringify(o.request.bookingCall).slice(0, 300)}`; return o; }
  const booked = { key: spec.key, bookingId: o.bookingId, service: "pet_sitting", packageCode: exp.packageCode, providerId: o.providerId, providerName: o.sitter.chosen, customer: o.customerId, scheduledStart: quote?.scheduledStart || H.istIso(spec.day, spec.time), scheduledEnd: quote?.scheduledEnd || null, total: quote?.totalAmount ?? exp.total, dueNow: quote?.amountDueNow ?? exp.dueNow, paid: false, paymentMode: spec.split ? "split_50_50" : "prepaid", groupId: o.groupId, meetId: o.meet?.id || null };
  created[spec.key] = booked;
  saveBooking({ suite: SUITE, bookingId: booked.bookingId, service: booked.service, packageCode: booked.packageCode, providerId: booked.providerId, customer: booked.customer, scheduledStart: booked.scheduledStart, scheduledEnd: booked.scheduledEnd, total: booked.total, dueNow: booked.dueNow, paid: false, paymentMode: booked.paymentMode });
  check("payment step shows this booking's reference", o.request.reference.includes(o.bookingId), o.request.reference);
  const shownNumbers = H.rupees(o.request.paymentText);
  check(`payment step: total ${money(exp.total)} and due now ${money(exp.dueNow)}`, shownNumbers.includes(exp.total) && shownNumbers.includes(exp.dueNow) && /Pay securely/.test(o.request.payButton) && H.rupees(o.request.payButton)[0] === exp.dueNow, `${o.request.paymentText.slice(0, 200)} | button "${o.request.payButton}"`);
  // Pay on the payment step (BookingPaymentPage → CustomerCheckoutController → Razorpay TEST).
  const section = page.locator("section[aria-label='Pet Sitting payment']");
  o.pay = await H.payRazorpay(flow, section.getByRole("button", { name: /Pay securely/ }), { waitOpenMs: spec.mobile ? 100_000 : 60_000 });
  if (o.pay.checkoutShot) o.evidence.push(o.pay.checkoutShot);
  if (!o.pay.opened) { o.blockedAt = "checkout"; o.blockDetail = `Razorpay did not open in ${o.pay.openMs} ms: ${o.pay.alerts.join(" | ")}`; o.evidence.push(await flow.shot("checkout-not-opened")); return o; }
  if (spec.mobile && !o.pay.paid?.ok) {
    // The Razorpay mobile checkout never became interactive: record it, then pay the same booking from the
    // customer booking page on desktop so the money journey still completes (the mobile session is superseded).
    o.evidence.push(await flow.shot("mobile-checkout-stuck", { fullPage: false }));
    o.mobileCheckout = { stuck: true, openMs: o.pay.openMs, paid: o.pay.paid, blockedHosts: flow.log.consoleErrors.filter(e => /ERR_TUNNEL_CONNECTION_FAILED|payment manifest/i.test(e.text)).length };
    const desk = await newFlow(browser, `${flow.name}-desktop-pay`);
    try {
      await H.retrying(() => H.otpSignIn(desk.context, phone(spec.slot), `Master E2E Sitting ${spec.key}`));
      const bp = await H.bookingPage(desk, o.bookingId);
      o.evidence.push(await desk.shot("booking-page-before-payment"));
      o.fallbackPay = /Pay securely/.test(bp.payText) ? await H.payRazorpay(desk, bp.payButton) : { opened: false, alerts: [`no Pay securely: ${bp.text.slice(0, 120)}`] };
      o.server = await H.waitForServer(desk, o.bookingId, s => s.paymentStatus === "captured" && s.ready === true);
      o.evidence.push(await desk.shot("booking-page-after-payment"));
    } finally { await desk.close(); }
  } else o.server = await H.waitForServer(flow, o.bookingId, s => s.paymentStatus === "captured" && s.ready === true);
  const panel = page.getByRole("heading", { name: "Your sitting booking" });
  await panel.waitFor({ timeout: o.mobileCheckout ? 1000 : 30_000 }).catch(() => {});
  // The payment step does not re-check on its own when the booking was still synchronizing at capture; a
  // customer presses "Retry booking confirmation" (payment is not retried).
  for (let i = 0; i < 3 && !o.mobileCheckout && !(await panel.isVisible().catch(() => false)); i++) {
    const retry = page.getByRole("button", { name: "Retry booking confirmation" });
    if (!(await retry.isVisible().catch(() => false))) { await panel.waitFor({ timeout: 20_000 }).catch(() => {}); continue; }
    if (!o.confirmRetryShot) o.confirmRetryShot = await flow.shot("payment-verified-still-synchronizing", { fullPage: false });
    o.confirmRetries = (o.confirmRetries || 0) + 1;
    await retry.click().catch(() => {});
    await panel.waitFor({ timeout: 25_000 }).catch(() => {});
  }
  await page.getByText("Loading saved booking and care updates…").waitFor({ state: "detached", timeout: 30_000 }).catch(() => {});
  await settle(page, 800);
  o.inFlowPanel = await panel.isVisible().catch(() => false);
  o.inFlowText = H.flat(await page.locator("main").innerText().catch(() => "")).slice(0, 700);
  o.evidence.push(await flow.shot("after-payment"));
  o.captured = o.server.paymentStatus === "captured" && o.server.ready === true;
  check("server: payment captured and booking ready", o.captured, JSON.stringify({ bookingStatus: o.server.bookingStatus, paymentStatus: o.server.paymentStatus, stage: o.server.paymentStage, dueNow: o.server.amountDueNow, waitedMs: o.server.waitedMs }));
  if (!o.mobileCheckout) check(`payment step moves on to the sitting booking panel${o.confirmRetries ? ` (after ${o.confirmRetries}× Retry booking confirmation)` : ""}`, o.inFlowPanel, o.inFlowText.slice(0, 200));
  if (o.confirmRetries && o.inFlowPanel) file("confirm-retry", { severity: "P3", area: "Pet Sitting payment", persona: "Customer", flow: `${spec.key} payment step`, title: "After a verified Pet Sitting payment the screen can stop at 'Payment is verified, but the canonical booking is still synchronizing' until the customer presses Retry booking confirmation", steps: `${spec.key}: pay on the payment step (Razorpay TEST); the capture arrives before the booking is confirmed`, expected: "The screen re-checks on its own and opens the booking", actual: `Stayed on the payment step; the booking opened after ${o.confirmRetries}× "Retry booking confirmation" (server was already confirmed/captured)`, evidence: [o.confirmRetryShot].filter(Boolean) });
  if (o.captured) {
    booked.paid = true;
    saveBooking({ suite: SUITE, bookingId: booked.bookingId, service: booked.service, packageCode: booked.packageCode, providerId: booked.providerId || o.server.providerId, customer: booked.customer, scheduledStart: booked.scheduledStart, scheduledEnd: booked.scheduledEnd, total: booked.total, dueNow: booked.dueNow, paid: true, paymentMode: booked.paymentMode });
    if (!booked.providerId) booked.providerId = o.server.providerId;
  }
  o.previews = H.previews(net).map(n => ({ status: n.status, ms: Math.round(n.ms), providers: n.json?.data?.providers?.map(p => p.id) ?? null, error: n.json?.error ?? (n.text || "").slice(0, 80) }));
  out.previews.push(...o.previews.map(p => ({ journey: spec.key, ...p })));
  return o;
}

function recordBooking(journey, combo, o) {
  const failed = o.checks.filter(c => !c.ok);
  const transportOnly = !process.env.GITHUB_ACTIONS && o.request?.alerts?.length && o.request.alerts.every(a => H.TRANSPORT.test(a));
  const result = o.blockedAt ? ((o.blockedAt === "checkout" || o.blockedAt === "request") && !transportOnly ? "FAIL" : "BLOCKED") : failed.length ? "FAIL" : "PASS";
  const detail = `${transportOnly ? "harness: local egress cut the request (transport error only); " : ""}${o.bookingId || "no booking"}${o.sitter?.chosen ? ` · sitter ${o.sitter.chosen} (${o.providerId || "?"})` : ""}${o.blockedAt ? ` · stopped at ${o.blockedAt}: ${o.blockDetail}` : ""} · checks: ${o.checks.map(c => `${c.ok ? "ok" : "MISMATCH"} ${c.label}${c.ok ? "" : ` [${String(c.detail).slice(0, 160)}]`}`).join("; ")}`;
  record({ suite: SUITE, journey, combo, result, detail: detail.slice(0, 1800), evidence: o.evidence });
  const raw = [...(o.request?.alerts || []), ...(o.request?.transportRetries || []), ...(o.sitter?.alerts || [])].filter(a => H.RAW_JSON_ERROR.test(a));
  if (raw.length) file("raw-json-error", { severity: "P2", area: "Pet Sitting UI", persona: "Customer", flow: journey, title: "The Pet Sitting review shows a raw JavaScript error when a server call answers with a non-JSON error", steps: `${journey}: press "Request sitter & review payment" while a server call fails (gateway error page / empty 5xx body)`, expected: "A plain sentence such as 'We could not reach PawSpace. Your request is safe — try again.'", actual: `alert: "${raw[0].slice(0, 160)}" (lib/uat-scheduling-client.ts reserveUatSchedule and lib/sitting-commercial-client.ts call response.json() before checking response.ok)`, evidence: [o.request?.transportShot, o.evidence.at(-1)].filter(Boolean) });
  return result;
}

/** Price/UI mismatches on a real booking are product findings (money: P0 when the charge is wrong). */
function priceFindings(journey, o) {
  if (!o.expected) return;
  const q = o.reviewQuote;
  if (q && (q.total !== o.expected.total || q.dueNow !== o.expected.dueNow || q.units !== o.expected.units)) {
    const provider = q.priceSource === "provider_rate";
    file(`price:${journey}`, { severity: provider ? "P1" : "P0", area: "Pet Sitting pricing", persona: "Customer", flow: journey, title: `${journey}: quote ${money(q.total)} (due now ${money(q.dueNow)}, ${q.units} unit(s)) differs from the published rule ${money(o.expected.total)} / ${money(o.expected.dueNow)}${provider ? " — the sitter's own rate was applied" : ""}`, steps: `Book ${journey} on /v2/sitting with ${o.sitter?.chosen}`, expected: `${o.expected.packageCode}: ${o.expected.units} unit(s), total ${money(o.expected.total)}, due now ${money(o.expected.dueNow)}`, actual: JSON.stringify(q), evidence: o.evidence.slice(-3) });
  }
}

async function journeyS1() {
  const flow = await newFlow(browser, "30-s1-visit-dog-meet-greet");
  const journey = "S1 Home Visit + Meet & Greet (SIT-01)";
  try {
    const o = await bookThroughScreen(flow, { key: "S1", slot: 1, mode: "visit", day: DAYS.s1, time: T1, accountPets: [DOG], pets: [DOG], meet: { format: "house_visit", preferredLocal: `${H.addDays(DAYS.s1, -1)}T11:00` } });
    out.journeys.S1 = o;
    priceFindings(journey, o);
    const result = recordBooking(journey, `60-min Home Visit ${DAYS.s1} ${T1} IST · 1 dog · in-person introduction · ₹399 in full`, o);
    // The manage page shows the linked Meet & Greet (format, status, fee).
    if (o.bookingId && o.meet?.id) {
      const m = await H.managePage(flow, o.bookingId);
      const shot = await flow.shot("manage-meet-greet");
      const ok = m.meetVisible && m.meet.includes(o.meet.id) && /In-person introduction/.test(m.meet) && /requested|confirmed/.test(m.meet) && /quoted fee ₹499/.test(m.meet);
      out.journeys.S1.manage = { meet: m.meet, text: m.text.slice(0, 600) };
      record({ suite: SUITE, journey: "S1 manage page shows the linked Meet & Greet (SIT-01)", combo: `${o.bookingId} · ${o.meet.id}`, result: ok ? "PASS" : "FAIL", detail: `Meet & Greet section: "${m.meet.slice(0, 400)}"`, evidence: [shot] });
      if (!ok) file("sit01-manage", { severity: "P1", area: "Pet Sitting Meet & Greet", persona: "Customer", flow: journey, title: "The Sitting manage page does not show the Meet & Greet requested for the booking", steps: `Request an in-person introduction on the Care Card, book and pay ${o.bookingId}, open /v2/sitting/manage`, expected: `Meet & Greet section: In-person introduction · requested · ${o.meet.id} · quoted fee ₹499`, actual: m.meet || m.text.slice(0, 300), evidence: [shot] });
      const view = await api(flow.context, "GET", `/api/sitting-lifecycle?scope=customer&bookingId=${encodeURIComponent(o.bookingId)}`, undefined, { timeout: 60_000 });
      out.journeys.S1.lifecycleMeet = view.body?.data?.[0]?.meetGreet ?? null;
    }
    flowHealth(flow, journey, o.evidence.slice(-2));
    return { o, result };
  } catch (error) {
    const shot = await flow.shot("error");
    record({ suite: SUITE, journey, combo: "Home Visit + Meet & Greet", result: "BLOCKED", detail: `harness: ${String(error?.message || error).slice(0, 400)}`, evidence: [shot] });
    return { o: null };
  } finally { await flow.close(); }
}

async function journeyS2() {
  const flow = await newFlow(browser, "30-s2-visit-dog-cat-pixel7", { mobile: true, video: true });
  const journey = "S2 Home Visit dog + cat (Pixel 7)";
  try {
    const o = await bookThroughScreen(flow, { key: "S2", slot: 2, mobile: true, natural: true, mode: "visit", day: DAYS.s2, time: T2, accountPets: [DOG, CAT], pets: [DOG, CAT] });
    out.journeys.S2 = o;
    priceFindings(journey, o);
    recordBooking(journey, `60-min Home Visit ${DAYS.s2} ${T2} IST · dog + cat · ₹548 in full · Pixel 7${o.mobileCheckout ? " (paid from /v2/booking on desktop)" : ""}`, o);
    if (o.bookingId) record({ suite: SUITE, journey: "S2 Razorpay checkout on Pixel 7", combo: o.bookingId, result: o.mobileCheckout ? (process.env.GITHUB_ACTIONS ? "PARTIAL" : "BLOCKED") : o.pay?.paid?.ok ? "PASS" : "FAIL", detail: o.mobileCheckout ? `${process.env.GITHUB_ACTIONS ? "" : "harness: this container's egress blocks hosts the Razorpay mobile checkout loads; "}checkout frame opened after ${o.mobileCheckout.openMs} ms but Netbanking was never reachable (${JSON.stringify(o.mobileCheckout.paid)}); ${o.mobileCheckout.blockedHosts} blocked-host console errors; booking paid on desktop /v2/booking instead: ${JSON.stringify({ opened: o.fallbackPay?.opened, paid: o.fallbackPay?.paid })}` : JSON.stringify({ opened: o.pay?.opened, openMs: o.pay?.openMs, paid: o.pay?.paid }), evidence: o.evidence.filter(e => /razorpay|mobile-checkout|booking-page/.test(e)) });
    flowHealth(flow, journey, o.evidence.slice(-2));
    return { o };
  } catch (error) {
    const shot = await flow.shot("error");
    record({ suite: SUITE, journey, combo: "Home Visit dog + cat, Pixel 7", result: "BLOCKED", detail: `harness: ${String(error?.message || error).slice(0, 400)}`, evidence: [shot] });
    return { o: null };
  } finally { await flow.close(); }
}

async function journeyS3() {
  const flow = await newFlow(browser, "30-s3-overnight-1n-dog-cat");
  const journey = "S3 Overnight 1 night dog + cat";
  try {
    const o = await bookThroughScreen(flow, { key: "S3", slot: 3, mode: "overnight", day: DAYS.s3, time: "19:00", endDay: DAYS.s3out, endTime: "09:00", accountPets: [DOG, CAT], pets: [DOG, CAT] });
    out.journeys.S3 = o;
    priceFindings(journey, o);
    recordBooking(journey, `Overnight ${DAYS.s3} 19:00 → ${DAYS.s3out} 09:00 IST · dog + cat · ₹1,198 in full`, o);
    flowHealth(flow, journey, o.evidence.slice(-2));
    return { o };
  } catch (error) {
    const shot = await flow.shot("error");
    record({ suite: SUITE, journey, combo: "Overnight 1 night dog + cat", result: "BLOCKED", detail: `harness: ${String(error?.message || error).slice(0, 400)}`, evidence: [shot] });
    return { o: null };
  } finally { await flow.close(); }
}

async function journeyS4() {
  const flow = await newFlow(browser, "30-s4-overnight-5n-split");
  const journey = "S4 Overnight 5 nights split 50/50";
  try {
    const o = await bookThroughScreen(flow, { key: "S4", slot: 4, mode: "overnight", day: DAYS.s4, time: "10:00", endDay: DAYS.s4out, endTime: "10:00", accountPets: [DOG], pets: [DOG], split: true, splitEligible: true });
    out.journeys.S4 = o;
    priceFindings(journey, o);
    recordBooking(journey, `Overnight ${DAYS.s4} → ${DAYS.s4out} 10:00 IST · 1 dog · deposit ${money(o.expected?.dueNow)} of ${money(o.expected?.total)}`, o);
    if (o.captured) {
      // PAY-03-style balance stage on the customer booking page.
      const before = await H.bookingPage(flow, o.bookingId);
      const shot1 = await flow.shot("booking-page-balance-stage");
      const bal = o.expected.balance;
      const status1 = await H.checkoutStatus(flow.context, o.bookingId);
      const balanceStage = /BALANCE PAYMENT/i.test(before.paymentSection) && /Pay balance/.test(before.payText) && H.rupees(before.payText)[0] === bal && !/Pay securely/.test(before.text);
      out.journeys.S4.balanceStage = { payText: before.payText, section: before.paymentSection.slice(0, 400), status: status1 };
      record({ suite: SUITE, journey: "S4 booking page after the deposit (balance stage)", combo: `${o.bookingId}: paid ${money(o.expected.dueNow)}, balance ${money(bal)}`, result: balanceStage && status1.paymentStage === "outstanding_balance" && status1.amountDueNow === bal ? "PASS" : "FAIL", detail: `button "${before.payText}"; section "${before.paymentSection.slice(0, 300)}"; server ${JSON.stringify({ stage: status1.paymentStage, dueNow: status1.amountDueNow, paid: status1.amountPaid, balanceDueAt: status1.balanceDueAt && new Date(status1.balanceDueAt).toISOString(), payableNow: status1.balancePayableNow })}`, evidence: [shot1] });
      if (!balanceStage && /Pay securely/.test(before.text)) file("s4-balance-stage", { severity: "P1", area: "Payments", persona: "Customer", flow: journey, title: "After the Sitting 50% deposit is captured the booking page still asks for the deposit ('Pay securely') instead of the balance", steps: `Pay the deposit for ${o.bookingId} in Razorpay TEST, open /v2/booking`, expected: `Balance payment: Paid so far ${money(o.expected.dueNow)}, 'Pay balance · ${money(bal)}'`, actual: before.text.slice(0, 400), evidence: [shot1] });
      if (/Pay balance/.test(before.payText)) {
        const pay = await H.payRazorpay(flow, before.payButton);
        const status2 = pay.opened ? await H.waitForServer(flow, o.bookingId, s => s.paymentStage === "settled" && s.amountDueNow === 0) : null;
        const after = await H.bookingPage(flow, o.bookingId);
        const shot2 = await flow.shot("booking-page-fully-paid");
        const settled = status2?.paymentStage === "settled" && status2?.amountDueNow === 0 && !after.hasPaymentSection && /Payment: captured/i.test(after.text);
        out.journeys.S4.balance = { pay: { opened: pay.opened, openMs: pay.openMs, paid: pay.paid, alerts: pay.alerts }, status: status2, after: after.text.slice(0, 400) };
        record({ suite: SUITE, journey: "S4 Pay balance → fully paid", combo: `${o.bookingId}: balance ${money(bal)} via Razorpay TEST`, result: settled ? "PASS" : pay.opened ? "FAIL" : "BLOCKED", detail: `${pay.opened ? "" : `checkout did not open: ${pay.alerts.join(" | ")}; `}server ${JSON.stringify(status2 && { stage: status2.paymentStage, dueNow: status2.amountDueNow, paymentStatus: status2.paymentStatus, bookingStatus: status2.bookingStatus })}; page "${after.text.slice(0, 260)}"`, evidence: [shot1, ...(pay.checkoutShot ? [pay.checkoutShot] : []), shot2] });
        if (settled) {
          created.S4.balancePaid = true;
          saveBooking({ suite: SUITE, bookingId: o.bookingId, service: "pet_sitting", packageCode: "sitting-overnight", providerId: created.S4.providerId, customer: o.customerId, scheduledStart: created.S4.scheduledStart, scheduledEnd: created.S4.scheduledEnd, total: created.S4.total, dueNow: created.S4.dueNow, paid: true, paymentMode: "split_50_50", balancePaid: true });
        } else if (pay.opened && pay.paid?.ok) file("s4-balance-not-settled", { severity: "P1", area: "Payments", persona: "Customer", flow: journey, title: "A Sitting balance paid in Razorpay TEST did not settle the booking within 3 minutes", steps: `Pay the balance of ${o.bookingId} on /v2/booking`, expected: "paymentStage settled, nothing due, booking page shows no payment", actual: JSON.stringify(status2).slice(0, 400), evidence: [shot2] });
      }
      // What the manage page tells the customer about the split (informational).
      const m = await H.managePage(flow, o.bookingId);
      out.journeys.S4.manage = m.text.slice(0, 500);
    }
    flowHealth(flow, journey, o.evidence.slice(-2));
    return { o };
  } catch (error) {
    const shot = await flow.shot("error");
    record({ suite: SUITE, journey, combo: "Overnight 5 nights split", result: "BLOCKED", detail: `harness: ${String(error?.message || error).slice(0, 400)}`, evidence: [shot] });
    return { o: null };
  } finally { await flow.close(); }
}

// ------------------------------------------------------------------------------------------------ S5 validation
async function journeyS5(s3) {
  const flow = await newFlow(browser, "30-s5-validation");
  const { page, context } = flow;
  const journey = "S5 Sitting validation";
  const o = { ui: {}, api: {} };
  out.journeys.S5 = o;
  try {
    const cust = await H.setupCustomer(context, { phone: phone(5), name: "Master E2E Sitting S5", pets: [DOG], tag: `${RUN_KEY}-${ATTEMPT}-S5` });
    const dog = cust.pets[0];
    const net = H.watchNet(page);
    const care = page.getByRole("group", { name: "Pet Sitting care" });
    const planCta = page.getByRole("button", { name: /See available sitters|Verify a service address to continue|Select a pet to continue/ });
    const addressResolved = async () => { for (let i = 0; i < 80 && !/See available sitters/.test(await planCta.innerText().catch(() => "")); i++) await page.waitForTimeout(750); };
    const fillOvernight = async (day, time, endDay, endTime) => { await page.getByLabel("Check-in date").fill(day); await page.getByLabel("Check-in time").fill(time); await page.getByLabel("Check-out date").fill(endDay); await page.getByLabel("Check-out time").fill(endTime); await settle(page, 600); };
    // Load 1 — (a) a 2-hour visit is not offered: Home Visit has no end time, Overnight refuses 2 hours;
    //          (b) boundary: 10 h 00 min refused, 10 h 01 min is one overnight (₹799 for one pet).
    await H.openSitting(flow);
    await care.getByRole("button", { name: /Home Visit/ }).click();
    await page.getByLabel("Visit date").fill(DAYS.s5a);
    await page.getByLabel("Visit start time").fill("10:00");
    const visitHint = H.flat(await page.getByText(/^60 minutes, ending/).first().innerText().catch(() => ""));
    const visitHasEnd = await page.getByLabel("Check-out time").count();
    const shotVisit = await flow.shot("home-visit-60-only");
    await care.getByRole("button", { name: /Overnight Pet Sitting/ }).click();
    await fillOvernight(DAYS.s5a, "10:00", DAYS.s5a, "12:00");
    await addressResolved();
    o.ui.twoHours = { summary: await H.durationSummary(page), cta: H.flat(await planCta.innerText().catch(() => "")), ctaEnabled: await planCta.isEnabled() };
    const shotTwo = await flow.shot("overnight-2h-refused");
    const twoHourUiOk = /^60 minutes, ending/.test(visitHint) && !visitHasEnd && /Overnight Pet Sitting covers more than 10 hours/.test(o.ui.twoHours.summary) && /See available sitters/.test(o.ui.twoHours.cta) && !o.ui.twoHours.ctaEnabled;
    record({ suite: SUITE, journey: "S5 a 2-hour visit is not offered by the screen (SIT-04)", combo: "Home Visit = 60 min only; Overnight 2 h refused", result: twoHourUiOk ? "PASS" : "FAIL", detail: `Home Visit hint "${visitHint}", check-out inputs in Home Visit: ${visitHasEnd}; Overnight 2 h: "${o.ui.twoHours.summary}", CTA "${o.ui.twoHours.cta}" enabled ${o.ui.twoHours.ctaEnabled}`, evidence: [shotVisit, shotTwo] });
    await page.getByLabel("Check-out time").fill("20:00");
    await settle(page, 600);
    o.ui.tenHours = { summary: await H.durationSummary(page), ctaEnabled: await planCta.isEnabled() };
    const quoteMark = net.length;
    await page.getByLabel("Check-out time").fill("20:01");
    await settle(page, 600);
    o.ui.tenHoursOne = { summary: await H.durationSummary(page), ctaEnabled: await planCta.isEnabled() };
    let uiQuote = null;
    for (let i = 0; i < 80 && !uiQuote; i++) { uiQuote = H.quotes(net.slice(quoteMark)).find(q => q.req?.scheduledEnd === H.istIso(DAYS.s5a, "20:01") && q.status < 300)?.json?.data || null; if (!uiQuote) await page.waitForTimeout(750); }
    o.ui.tenHoursOneQuote = uiQuote && { packageCode: uiQuote.packageCode, units: uiQuote.billableUnits, total: uiQuote.totalAmount };
    const shotTen = await flow.shot("overnight-10h01");
    const tenOk = /Overnight Pet Sitting covers more than 10 hours/.test(o.ui.tenHours.summary) && !o.ui.tenHours.ctaEnabled && o.ui.tenHoursOne.ctaEnabled && uiQuote?.packageCode === "sitting-overnight" && uiQuote?.billableUnits === 1 && uiQuote?.totalAmount === 799;
    const uiQuoteCall = H.quotes(net.slice(quoteMark)).filter(q => q.req?.scheduledEnd === H.istIso(DAYS.s5a, "20:01")).at(-1);
    o.ui.tenHoursOneQuoteCall = uiQuoteCall ? { status: uiQuoteCall.status, error: uiQuoteCall.json?.error ?? uiQuoteCall.text } : null;
    record({ suite: SUITE, journey: "S5 10 h 01 min is priced as one overnight", combo: "10 h 00 refused · 10 h 01 = 1 night ₹799 (1 pet)", result: tenOk ? "PASS" : !uiQuote && o.ui.tenHoursOne.ctaEnabled && /Overnight Pet Sitting covers/.test(o.ui.tenHours.summary) ? "BLOCKED" : "FAIL", detail: `10 h 00: "${o.ui.tenHours.summary}" CTA ${o.ui.tenHours.ctaEnabled}; 10 h 01: "${o.ui.tenHoursOne.summary}" CTA ${o.ui.tenHoursOne.ctaEnabled}; screen quote ${JSON.stringify(o.ui.tenHoursOneQuote)}${uiQuote ? "" : ` (harness: the screen's quote call did not return a price: ${JSON.stringify(o.ui.tenHoursOneQuoteCall)}; the API row below checks the price)`}`, evidence: [shotTen] });
    if (uiQuote && (uiQuote.billableUnits !== 1 || uiQuote.totalAmount !== 799)) file("tenh01-price", { severity: "P1", area: "Pet Sitting pricing", persona: "Customer", flow: journey, title: `A 10 h 01 min overnight is quoted ${money(uiQuote.totalAmount)} (${uiQuote.billableUnits} units) instead of one night ₹799`, steps: `/v2/sitting Overnight ${DAYS.s5a} 10:00 → 20:01, 1 pet`, expected: "sitting-overnight, 1 unit, ₹799", actual: JSON.stringify(o.ui.tenHoursOneQuote), evidence: [shotTen] });
    // Load 2 — (c) SIT-03 on the screen: the night S3 holds, searched by another household, never offers S3's sitter.
    const s3b = s3?.o && created.S3;
    if (s3b?.providerId) {
      await H.openSitting(flow);
      await fillOvernight(DAYS.s3, "21:00", DAYS.s3out, "08:00");
      await addressResolved();
      const sit = await H.chooseSitter(flow, {});
      o.ui.overlap = { offered: sit.sitters, s3Sitter: s3b.providerName, alerts: sit.alerts };
      const shotOverlap = await flow.shot("overlapping-night-sitters");
      const offeredS3 = sit.sitters.includes(s3b.providerName);
      record({ suite: SUITE, journey: "S5 overlapping night never offers S3's sitter on the screen (SIT-03)", combo: `${DAYS.s3} 21:00 → ${DAYS.s3out} 08:00 vs S3 ${s3b.bookingId} (${s3b.providerName})`, result: sit.sitters.length || sit.alerts.length ? (offeredS3 ? "FAIL" : "PASS") : "BLOCKED", detail: `offered ${JSON.stringify(sit.sitters)}; alerts ${JSON.stringify(sit.alerts)}`, evidence: [shotOverlap] });
      if (offeredS3) file("sit03-ui", { severity: "P1", area: "Pet Sitting scheduling", persona: "Customer", flow: journey, title: "A sitter already booked for an overnight is offered to another household for an overlapping night", steps: `S3 ${s3b.bookingId} holds ${s3b.providerName} ${DAYS.s3} 19:00 → ${DAYS.s3out} 09:00; a second customer searches ${DAYS.s3} 21:00 → ${DAYS.s3out} 08:00`, expected: `${s3b.providerName} is not offered`, actual: `offered ${sit.sitters.join(", ")}`, evidence: [shotOverlap] });
    } else record({ suite: SUITE, journey: "S5 overlapping night never offers S3's sitter on the screen (SIT-03)", combo: "needs S3's booking", result: "BLOCKED", detail: "harness: S3 did not produce a booking with a sitter", evidence: [] });
    // Load 3 — (d) less than 24 h notice through the screen.
    const soon = Date.now() + 23 * 3_600_000, soonParts = H.istParts(soon - (soon % (15 * 60_000)));
    await H.openSitting(flow);
    await care.getByRole("button", { name: /Home Visit/ }).click();
    await page.getByLabel("Visit date").fill(soonParts.day);
    await page.getByLabel("Visit start time").fill(soonParts.time);
    await addressResolved();
    const soonSearch = await H.chooseSitter(flow, { retries: 0 }).catch(e => ({ sitters: [], alerts: [String(e).slice(0, 120)] }));
    o.ui.notice = { window: `${soonParts.day} ${soonParts.time}`, offered: soonSearch.sitters, alerts: soonSearch.alerts };
    const shotSoon = await flow.shot("less-than-24h-notice");
    const soonRefused = !soonSearch.sitters.length && soonSearch.alerts.some(a => /notice|24 hours|1440/i.test(a));
    record({ suite: SUITE, journey: "S5 less than 24 h notice is refused on the screen", combo: `Home Visit ${soonParts.day} ${soonParts.time} IST (~23 h ahead)`, result: soonRefused ? "PASS" : soonSearch.sitters.length ? "FAIL" : "BLOCKED", detail: `offered ${JSON.stringify(soonSearch.sitters)}; alerts ${JSON.stringify(soonSearch.alerts)}`, evidence: [shotSoon] });
    if (soonRefused && soonSearch.alerts.some(a => /1440 minutes/.test(a))) file("sit12-copy", { severity: "P3", area: "Pet Sitting copy", persona: "Customer", flow: journey, title: "Less than 24 h notice is explained as \"This service needs at least 1440 minutes' notice\" only after the sitter search (still reproduces, round-1 SIT-12)", steps: `On /v2/sitting choose a Home Visit ${soonParts.day} ${soonParts.time} IST (~23 h ahead), press See available sitters`, expected: "The plan step says 'Book at least 24 hours ahead' before searching", actual: soonSearch.alerts.join(" | "), evidence: [shotSoon] });
    if (!soonRefused && soonSearch.sitters.length) file("lead-time-ui", { severity: "P1", area: "Pet Sitting scheduling", persona: "Customer", flow: journey, title: "Pet Sitting offers sitters for a visit less than 24 hours ahead", steps: `Home Visit ${soonParts.day} ${soonParts.time} IST`, expected: "Refused: 24 h minimum lead time", actual: `offered ${soonSearch.sitters.join(", ")}`, evidence: [shotSoon] });
    flowHealth(flow, journey, [shotSoon]);

    // API checks (the same routes the screen calls).
    const zone = await api(context, "GET", "/api/service-zone?pincode=560038", undefined, { timeout: 60_000 });
    const cityId = zone.body?.data?.assignment?.cityId || "blr", zoneId = zone.body?.data?.assignment?.zoneId || "blr-east";
    const safe = promise => promise.catch(e => ({ status: 0, body: { error: `harness: ${String(e?.message || e).split("\n")[0].slice(0, 120)}` } }));
    const quote = (packageCode, start, end, extra = {}) => safe(api(context, "POST", "/api/sitting-commercial", { packageCode, petCount: 1, scheduledStart: start, scheduledEnd: end, paymentMode: "prepaid", cityId, zoneId, ...extra }, { timeout: 150_000 }));
    const at = hhmm => H.istIso(DAYS.s5a, hhmm);
    const q60 = await quote("sitting-visit-60", at("10:00"), at("11:00"));
    const q2h = await quote("sitting-visit-60", at("10:00"), at("12:00"));
    const q10 = await quote("sitting-overnight", at("10:00"), at("20:00"));
    const q1001 = await quote("sitting-overnight", at("10:00"), at("20:01"));
    const brief = r => ({ status: r.status, total: r.body?.data?.totalAmount ?? null, units: r.body?.data?.billableUnits ?? null, error: r.body?.error ?? null });
    o.api.quotes = { visit60: brief(q60), visit2h: brief(q2h), overnight10h: brief(q10), overnight10h01: brief(q1001) };
    const sit04 = q60.status === 201 && q60.body?.data?.totalAmount === 399 && q2h.status === 409 && /A Home Visit is 60 minutes\. Book more visits for longer care, or choose Overnight Pet Sitting\./.test(String(q2h.body?.error));
    record({ suite: SUITE, journey: "S5 /api/sitting-commercial: 2-hour Home Visit refused (SIT-04)", combo: "60 min ₹399 · 2 h → 409", result: sit04 ? "PASS" : [q60, q2h].some(r => !r.status) ? "BLOCKED" : "FAIL", detail: JSON.stringify({ visit60: o.api.quotes.visit60, visit2h: o.api.quotes.visit2h }), evidence: [] });
    if (!sit04 && q2h.status < 300) file("sit04-api", { severity: "P1", area: "Pet Sitting pricing", persona: "Customer", flow: journey, title: "A 2-hour Home Visit is quoted instead of refused", steps: "POST /api/sitting-commercial sitting-visit-60, 10:00 → 12:00 IST", expected: "409 A Home Visit is 60 minutes…", actual: JSON.stringify(o.api.quotes.visit2h), evidence: [] });
    const boundary = q10.status === 409 && /more than 10 hours/.test(String(q10.body?.error)) && q1001.status === 201 && q1001.body?.data?.billableUnits === 1 && q1001.body?.data?.totalAmount === 799;
    record({ suite: SUITE, journey: "S5 /api/sitting-commercial: overnight boundary", combo: "10 h 00 → 409 · 10 h 01 → 1 night ₹799", result: boundary ? "PASS" : [q10, q1001].some(r => !r.status) ? "BLOCKED" : "FAIL", detail: JSON.stringify({ overnight10h: o.api.quotes.overnight10h, overnight10h01: o.api.quotes.overnight10h01 }), evidence: [] });
    // Round-1 SIT-05 regression watch: 50/50 split is only for overnight stays longer than 4 nights.
    const qSplit = await quote("sitting-overnight", at("19:00"), H.istIso(H.addDays(DAYS.s5a, 1), "09:00"), { paymentMode: "split_50_50" });
    o.api.splitOneNight = brief(qSplit);
    record({ suite: SUITE, journey: "S5 /api/sitting-commercial: split 50/50 refused for a 1-night stay", combo: "sitting-overnight 1 night split_50_50", result: !qSplit.status ? "BLOCKED" : qSplit.status >= 400 ? "PASS" : "FAIL", detail: JSON.stringify({ ...o.api.splitOneNight, dueNow: qSplit.body?.data?.amountDueNow ?? null }), evidence: [] });
    if (qSplit.status && qSplit.status < 300) file("sit05-split", { severity: "P2", area: "Pet Sitting payments", persona: "Customer", flow: journey, title: "The server still quotes a 50/50 split for a 1-night Pet Sitting stay (split is only for overnight stays longer than 4 nights; round-1 SIT-05)", steps: "POST /api/sitting-commercial {packageCode:'sitting-overnight', 19:00 → 09:00 next day, paymentMode:'split_50_50', cityId, zoneId}", expected: "409: split payment is only for overnight stays longer than 4 nights", actual: `HTTP ${qSplit.status} ${JSON.stringify(qSplit.body?.data ? { total: qSplit.body.data.totalAmount, amountDueNow: qSplit.body.data.amountDueNow, paymentMode: qSplit.body.data.paymentMode } : qSplit.body)}`, evidence: [] });
    // A valid-looking request without a city/zone gets no reason at all (the thrown text is redacted).
    const qNoZone = await safe(api(context, "POST", "/api/sitting-commercial", { packageCode: "sitting-visit-60", petCount: 1, scheduledStart: at("10:00"), scheduledEnd: at("11:00"), paymentMode: "prepaid" }, { timeout: 150_000 }));
    o.api.noZone = { status: qNoZone.status, body: qNoZone.body };
    if (qNoZone.status === 400 && /^Sitting commercial request failed$/.test(String(qNoZone.body?.error))) file("quote-generic-400", { severity: "P3", area: "Pet Sitting API", persona: "Integrator", flow: journey, title: "A Sitting quote without cityId/zoneId gets 400 'Sitting commercial request failed' with no reason", steps: "POST /api/sitting-commercial {packageCode:'sitting-visit-60', petCount:1, 60-minute window, paymentMode:'prepaid'} without cityId/zoneId", expected: "400 naming the missing field (lib/live-commercial-quotes.ts throws 'City and zone are required for a live commercial quote')", actual: `HTTP 400 ${JSON.stringify(qNoZone.body)} (lib/server-auth.ts authError redacts the ungoverned Response to the route fallback)`, evidence: [] });

    // Scheduler: a 2-hour visit, < 24 h notice, and S3's sitter on an overlapping night (preferredProviderId).
    const reserve = (body, label) => safe(api(context, "POST", "/api/uat-scheduling", { clientRequestId: `m30-s5-${label}-${RUN_KEY}-${ATTEMPT}-${Date.now()}`, customerId: cust.customerId, petIds: [dog.id], serviceCode: "pet_sitting", serviceAddress: "100 Feet Road, HAL 2nd Stage, Indiranagar, Bengaluru, 560038", servicePincode: "560038", cityId, zoneId, ...body }, { timeout: 150_000 }));
    const anySitter = s3b?.providerId || "sit_sana";
    const r2h = await reserve({ scheduledStart: at("10:00"), scheduledEnd: at("12:00"), careMode: "visit", preferredProviderId: anySitter }, "2h");
    o.api.reserve2h = { status: r2h.status, error: r2h.body?.error ?? null, provider: r2h.body?.data?.provider?.id ?? null };
    record({ suite: SUITE, journey: "S5 /api/uat-scheduling: 2-hour visit refused by the scheduler", combo: `2 h visit, preferred ${anySitter}`, result: r2h.status >= 400 && /Home Visit is 60 minutes/.test(String(r2h.body?.error)) ? "PASS" : r2h.status < 300 ? "FAIL" : "PARTIAL", detail: JSON.stringify(o.api.reserve2h), evidence: [] });
    if (r2h.status < 300) file("sit04-scheduler", { severity: "P1", area: "Pet Sitting scheduling", persona: "Customer", flow: journey, title: "The scheduler reserves a 2-hour Pet Sitting Home Visit", steps: "POST /api/uat-scheduling pet_sitting visit 10:00 → 12:00 IST", expected: "422 A Home Visit is 60 minutes…", actual: JSON.stringify(o.api.reserve2h), evidence: [] });
    const soonStart = new Date(Date.now() + 23 * 3_600_000 - ((Date.now() + 23 * 3_600_000) % (15 * 60_000))).toISOString();
    const rSoon = await reserve({ scheduledStart: soonStart, scheduledEnd: new Date(Date.parse(soonStart) + 3_600_000).toISOString(), careMode: "visit", preferredProviderId: anySitter }, "soon");
    o.api.reserveSoon = { status: rSoon.status, code: rSoon.body?.code ?? null, error: rSoon.body?.error ?? null, provider: rSoon.body?.data?.provider?.id ?? null };
    record({ suite: SUITE, journey: "S5 /api/uat-scheduling: less than 24 h notice refused", combo: `visit at ${soonStart} (~23 h ahead)`, result: rSoon.status === 400 && rSoon.body?.code === "below_minimum_lead_time" ? "PASS" : rSoon.status < 300 ? "FAIL" : "PARTIAL", detail: JSON.stringify(o.api.reserveSoon), evidence: [] });
    if (rSoon.status < 300) file("lead-time-api", { severity: "P1", area: "Pet Sitting scheduling", persona: "Customer", flow: journey, title: "The scheduler reserves a Pet Sitting visit less than 24 hours ahead", steps: `POST /api/uat-scheduling pet_sitting visit starting ${soonStart}`, expected: "400 below_minimum_lead_time", actual: JSON.stringify(o.api.reserveSoon), evidence: [] });
    if (s3b?.providerId) {
      const rOverlap = await reserve({ scheduledStart: H.istIso(DAYS.s3, "21:00"), scheduledEnd: H.istIso(DAYS.s3out, "08:00"), careMode: "overnight", preferredProviderId: s3b.providerId }, "overlap");
      const got = rOverlap.body?.data?.provider?.id ?? null;
      o.api.reserveOverlap = { status: rOverlap.status, error: rOverlap.body?.error ?? null, provider: got, s3Provider: s3b.providerId };
      const sameSitter = rOverlap.status < 300 && got === s3b.providerId;
      record({ suite: SUITE, journey: "S5 /api/uat-scheduling: S3's sitter is never double-booked (SIT-03)", combo: `second customer, ${DAYS.s3} 21:00 → ${DAYS.s3out} 08:00, preferredProviderId ${s3b.providerId}`, result: sameSitter ? "FAIL" : rOverlap.status === 409 || (rOverlap.status < 300 && got) ? "PASS" : "PARTIAL", detail: JSON.stringify(o.api.reserveOverlap), evidence: [] });
      if (sameSitter) file("sit03-api", { severity: "P1", area: "Pet Sitting scheduling", persona: "Customer", flow: journey, title: "The scheduler gives a second household the sitter already booked for an overlapping overnight", steps: `S3 ${s3b.bookingId} holds ${s3b.providerId}; second customer reserves ${DAYS.s3} 21:00 → ${DAYS.s3out} 08:00 with preferredProviderId`, expected: "409 SELECTED_SITTER_UNAVAILABLE or another sitter", actual: JSON.stringify(o.api.reserveOverlap), evidence: [] });
    } else record({ suite: SUITE, journey: "S5 /api/uat-scheduling: S3's sitter is never double-booked (SIT-03)", combo: "needs S3's booking", result: "BLOCKED", detail: "harness: S3 did not produce a booking with a sitter", evidence: [] });
  } catch (error) {
    const shot = await flow.shot("error");
    record({ suite: SUITE, journey, combo: "validation", result: "BLOCKED", detail: `harness: ${String(error?.message || error).slice(0, 400)}`, evidence: [shot] });
  } finally { await flow.close(); }
}

// ------------------------------------------------------------------------------------------------ S6 near-term
async function journeyS6() {
  const flow = await newFlow(browser, "30-s6-near-term-visit");
  const { context } = flow;
  const journey = "S6 near-term Home Visit (partner-due)";
  const o = { tries: [] };
  out.journeys.S6 = o;
  try {
    const cust = await H.setupCustomer(context, { phone: phone(6), name: "Master E2E Sitting S6", pets: [DOG], tag: `${RUN_KEY}-${ATTEMPT}-S6` });
    const dog = cust.pets[0];
    const zone = (await api(context, "GET", "/api/service-zone?pincode=560038", undefined, { timeout: 60_000 })).body?.data;
    const cityId = zone?.assignment?.cityId, zoneId = zone?.assignment?.zoneId;
    const address = { serviceAddress: "100 Feet Road, HAL 2nd Stage, Indiranagar, Bengaluru, 560038", servicePincode: "560038" };
    // Earliest start ≥ now + 24 h 15 min on a quarter hour, inside the sitters' visit hours (09:00–19:00 IST).
    const slotFrom = ms => { let t = Math.ceil(ms / 900_000) * 900_000; const p = H.istParts(t); if (p.time < "09:00") t = Date.parse(H.istIso(p.day, "09:00")); else if (p.time > "18:00") t = Date.parse(H.istIso(H.addDays(p.day, 1), "09:00")); return t; };
    let start = slotFrom(Date.now() + 24.25 * 3_600_000), booked = null;
    for (let attempt = 1; attempt <= 3 && !booked; attempt++, start = slotFrom(start + 30 * 60_000)) {
      const scheduledStart = new Date(start).toISOString(), scheduledEnd = new Date(start + 3_600_000).toISOString();
      const t0 = Date.now();
      let preview = null;
      // A governed 503 SCHEDULING_PREVIEW_TIMEOUT asks to retry in a moment: retry the same slot before moving on.
      for (let again = 0; again < 3; again++) {
        preview = await api(context, "POST", "/api/uat-scheduling", { action: "preview", clientRequestId: `preview:m30-s6-${RUN_KEY}-${attempt}-${again}`, customerId: cust.customerId, petIds: [dog.id], serviceCode: "pet_sitting", ...address, scheduledStart, scheduledEnd, careMode: "visit" }, { timeout: 150_000 }).catch(e => ({ status: 0, body: { error: String(e?.message || e).slice(0, 120) } }));
        if (preview.status === 503 && preview.body?.code === "SCHEDULING_PREVIEW_TIMEOUT") { out.previewTimeouts = (out.previewTimeouts || 0) + 1; await new Promise(r => setTimeout(r, 6000)); continue; }
        break;
      }
      const providers = preview.body?.data?.providers || [];
      const tryRow = { scheduledStart, preview: { status: preview.status, ms: Date.now() - t0, providers: providers.map(p => p.id), error: preview.body?.error ?? (typeof preview.body === "string" ? preview.body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 120) : null) } };
      o.tries.push(tryRow);
      out.previews.push({ journey: "S6", status: preview.status, ms: tryRow.preview.ms, providers: tryRow.preview.providers, error: tryRow.preview.error });
      if (preview.status >= 500 && preview.body?.code !== "SCHEDULING_PREVIEW_TIMEOUT" && !(!process.env.GITHUB_ACTIONS && /upstream request failed/i.test(String(tryRow.preview.error)))) file(`5xx:/api/uat-scheduling:preview:${preview.status}`, { severity: "P1", area: "Pet Sitting", persona: "Customer", flow: journey, title: `The sitter search (POST /api/uat-scheduling preview) answered HTTP ${preview.status}`, steps: `Preview a 60-minute Home Visit at ${scheduledStart}`, expected: "200 with available sitters", actual: `HTTP ${preview.status} ${tryRow.preview.error}`, evidence: [] });
      for (const provider of providers.slice(0, 2)) {
        const q = await api(context, "POST", "/api/sitting-commercial", { packageCode: "sitting-visit-60", petCount: 1, cityId, zoneId, scheduledStart, scheduledEnd, paymentMode: "prepaid", providerId: provider.id }, { timeout: 60_000 });
        const quote = q.body?.data;
        if (!quote) { tryRow.quote = { status: q.status, error: q.body?.error }; continue; }
        const rt0 = Date.now();
        const reserve = await api(context, "POST", "/api/uat-scheduling", { clientRequestId: `stay:m30-s6-${RUN_KEY}-${ATTEMPT}-${attempt}-${provider.id}`, customerId: cust.customerId, petIds: [dog.id], serviceCode: "pet_sitting", ...address, cityId, zoneId, scheduledStart, scheduledEnd, careMode: "visit", preferredProviderId: provider.id }, { timeout: 150_000 });
        tryRow.reserve = { provider: provider.id, status: reserve.status, ms: Date.now() - rt0, error: reserve.body?.error ?? null, code: reserve.body?.code ?? null };
        const decision = reserve.body?.data;
        if (reserve.status >= 300 || decision?.provider?.id !== provider.id) continue;
        const created6 = await api(context, "POST", "/api/sitting-bookings", {
          idempotencyKey: `sitting:${quote.quoteId}:${cust.customerId}`, groupId: decision.groupId, scheduleGroupId: decision.groupId, sittingQuoteId: quote.quoteId,
          customer: { id: cust.customerId, name: cust.name, primaryPhone: cust.phone },
          pets: [{ sourceId: dog.sourceId ?? dog.id, name: dog.name, species: "dog", breed: dog.breed ?? undefined, vaccinationStatus: dog.vaccinationStatus }],
          cityId, zoneId, packageCode: quote.packageCode, packageName: quote.packageName, scheduledStart: quote.scheduledStart, scheduledEnd: quote.scheduledEnd,
          provider: decision.provider, totalAmount: quote.totalAmount, amountDueNow: quote.amountDueNow, payment: { method: "payment_link", mode: "prepaid", detail: "Awaiting verified Razorpay payment" },
        }, { timeout: 150_000 });
        tryRow.booking = { status: created6.status, bookingId: created6.body?.data?.bookingId ?? null, error: created6.body?.error ?? null };
        if (!created6.body?.data?.bookingId) continue;
        booked = { bookingId: created6.body.data.bookingId, providerId: provider.id, providerName: provider.name, quote, groupId: decision.groupId, scheduledStart: quote.scheduledStart, scheduledEnd: quote.scheduledEnd };
        break;
      }
    }
    if (!booked) { const noSitter = o.tries.every(t => t.preview.status === 200 && !t.preview.providers.length); record({ suite: SUITE, journey, combo: "earliest allowed slot ≥ 24 h 15 min", result: "BLOCKED", detail: `${noSitter ? "capacity: " : "harness: "}no sitter could be booked: ${JSON.stringify(o.tries).slice(0, 900)}`, evidence: [] }); return; }
    o.booked = { ...booked, quote: { total: booked.quote.totalAmount, dueNow: booked.quote.amountDueNow } };
    const row = { key: "S6", bookingId: booked.bookingId, service: "pet_sitting", packageCode: "sitting-visit-60", providerId: booked.providerId, providerName: booked.providerName, customer: cust.customerId, scheduledStart: booked.scheduledStart, scheduledEnd: booked.scheduledEnd, total: booked.quote.totalAmount, dueNow: booked.quote.amountDueNow, paid: false, paymentMode: "prepaid", groupId: booked.groupId, nearTerm: true };
    created.S6 = row;
    saveBooking({ suite: SUITE, bookingId: row.bookingId, service: row.service, packageCode: row.packageCode, providerId: row.providerId, customer: row.customer, scheduledStart: row.scheduledStart, scheduledEnd: row.scheduledEnd, total: row.total, dueNow: row.dueNow, paid: false, paymentMode: row.paymentMode, nearTerm: true });
    // The care plan the payment step saves before checkout (the sitter needs it to check in).
    const plan = await api(context, "POST", "/api/sitting-lifecycle", { action: "submit_care_plan", bookingId: row.bookingId, carePlan: care("S6"), idempotencyKey: `initial-sitting-care:${row.bookingId}` }, { timeout: 150_000 });
    o.carePlan = { status: plan.status, result: plan.body?.data?.status ?? plan.body?.error };
    // Pay in full on the customer booking page.
    const page1 = await H.bookingPage(flow, row.bookingId);
    const shot1 = await flow.shot("booking-page-before-payment");
    const priceOk = row.total === 399 && row.dueNow === 399 && /Pay securely/.test(page1.payText) && H.rupees(page1.payText)[0] === 399;
    let pay = { opened: false, alerts: ["no Pay securely button"] }, status = null;
    if (/Pay securely/.test(page1.payText)) {
      pay = await H.payRazorpay(flow, page1.payButton);
      if (pay.opened) status = await H.waitForServer(flow, row.bookingId, s => s.paymentStatus === "captured" && s.ready === true);
    }
    const page2 = await H.bookingPage(flow, row.bookingId);
    const shot2 = await flow.shot("booking-page-after-payment");
    const paid = status?.paymentStatus === "captured" && status?.ready === true;
    o.pay = { opened: pay.opened, openMs: pay.openMs, alerts: pay.alerts, status, after: page2.text.slice(0, 300) };
    if (paid) { row.paid = true; saveBooking({ suite: SUITE, bookingId: row.bookingId, service: row.service, packageCode: row.packageCode, providerId: row.providerId, customer: row.customer, scheduledStart: row.scheduledStart, scheduledEnd: row.scheduledEnd, total: row.total, dueNow: row.dueNow, paid: true, paymentMode: row.paymentMode, nearTerm: true }); }
    const leadMin = Math.round((Date.parse(row.scheduledStart) - Date.now()) / 60_000);
    record({ suite: SUITE, journey, combo: `${H.istParts(Date.parse(row.scheduledStart)).day} ${H.istParts(Date.parse(row.scheduledStart)).time} IST (${leadMin} min ahead) · ${booked.providerName} · ₹399 on /v2/booking`, result: paid && priceOk && !page2.hasPaymentSection ? "PASS" : pay.opened ? "FAIL" : "BLOCKED", detail: `${row.bookingId}: quote ${money(row.total)}; button "${page1.payText}"; care plan ${JSON.stringify(o.carePlan)}; server ${JSON.stringify(status && { bookingStatus: status.bookingStatus, paymentStatus: status.paymentStatus, ready: status.ready, waitedMs: status.waitedMs })}${pay.opened ? "" : `; checkout did not open: ${pay.alerts.join(" | ")}`}; tries ${JSON.stringify(o.tries).slice(0, 500)}`, evidence: [shot1, ...(pay.checkoutShot ? [pay.checkoutShot] : []), shot2] });
    flowHealth(flow, journey, [shot2]);
    if (paid) await acceptNearTerm(row);
  } catch (error) {
    const shot = await flow.shot("error");
    record({ suite: SUITE, journey, combo: "near-term Home Visit", result: "BLOCKED", detail: `harness: ${String(error?.message || error).slice(0, 400)}`, evidence: [shot] });
  } finally { await flow.close(); }
}

/** A commission sitter's offer expires ~30 minutes after the reservation, so the near-term visit is accepted by its
 *  sitter in this run (sitter workspace, "Accept booking"); the partner-due suite then works an accepted job. */
async function acceptNearTerm(row) {
  const journey = "S6 near-term visit accepted by its sitter";
  if (!hasAccessCode()) { record({ suite: SUITE, journey, combo: `${row.bookingId} · ${row.providerId}`, result: "BLOCKED", detail: "harness: no UAT access code in this runner", evidence: [] }); return; }
  const flow = await newFlow(browser, "30-s6-sitter-accept");
  const { page, context } = flow;
  try {
    await providerSession(context, row.providerId);
    await page.goto(`${BASE}/sitter?bookingId=${encodeURIComponent(row.bookingId)}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.getByText("Loading canonical Sitting booking…").waitFor({ state: "detached", timeout: 60_000 }).catch(() => {});
    const accept = page.getByRole("button", { name: "Accept booking" });
    await accept.waitFor({ timeout: 30_000 }).catch(() => {});
    let via = "screen", apiResult = null;
    if (await accept.isEnabled().catch(() => false)) await accept.click();
    await page.getByText(/^Status:\s*assigned/).waitFor({ timeout: 60_000 }).catch(() => {});
    let status = H.flat(await page.getByText(/^Status:/).first().innerText().catch(() => ""));
    if (!/assigned/.test(status)) {
      via = "api";
      const r = await api(context, "POST", "/api/sitting-lifecycle", { bookingId: row.bookingId, action: "accept", idempotencyKey: `m30-s6-accept-${row.bookingId}` }, { timeout: 150_000 });
      apiResult = { status: r.status, body: r.body?.data ?? r.body };
      status = r.body?.data?.status || status;
    }
    const alerts = (await page.getByRole("alert").allInnerTexts().catch(() => [])).map(H.flat);
    const shot = await flow.shot("s6-accepted");
    const ok = /assigned/.test(status);
    if (ok) saveBooking({ suite: SUITE, bookingId: row.bookingId, service: row.service, packageCode: row.packageCode, providerId: row.providerId, customer: row.customer, scheduledStart: row.scheduledStart, scheduledEnd: row.scheduledEnd, total: row.total, dueNow: row.dueNow, paid: true, paymentMode: row.paymentMode, nearTerm: true, sitterAccepted: true });
    record({ suite: SUITE, journey, combo: `${row.bookingId} · ${row.providerId}`, result: ok ? "PASS" : "FAIL", detail: `status "${status}" via ${via}; alerts ${JSON.stringify(alerts)}; api ${JSON.stringify(apiResult)}`.slice(0, 700), evidence: [shot] });
    if (!ok) file("s6-accept", { severity: "P1", area: "Partner app", persona: "Sitter", flow: journey, title: "A sitter cannot accept a paid near-term Pet Sitting visit", steps: `Customer pays ${row.bookingId}; sitter ${row.providerId} presses Accept booking on /sitter`, expected: "Status assigned", actual: `status "${status}"; ${alerts.join(" | ")}; ${JSON.stringify(apiResult)}`.slice(0, 400), evidence: [shot] });
  } catch (error) {
    const shot = await flow.shot("error");
    record({ suite: SUITE, journey, combo: row.bookingId, result: "BLOCKED", detail: `harness: ${String(error?.message || error).slice(0, 300)}`, evidence: [shot] });
  } finally { await flow.close(); }
}

// ------------------------------------------------------------------------------------------------ sitter (runner)
async function sitterJourney(s1) {
  const journey = "S1 sitter in the partner app (SIT-02)";
  const booking = created.S1;
  if (!booking?.paid || !booking.providerId) { record({ suite: SUITE, journey, combo: "paid S1 visit", result: "BLOCKED", detail: "harness: S1 did not produce a paid booking", evidence: [] }); return; }
  if (!hasAccessCode()) { record({ suite: SUITE, journey, combo: `${booking.bookingId} · ${booking.providerId}`, result: "BLOCKED", detail: "harness: no UAT access code in this runner", evidence: [] }); return; }
  const flow = await newFlow(browser, "30-sitter-partner-app", { geolocation: { latitude: 12.9719, longitude: 77.6412 } });
  const { page, context } = flow;
  const secrets = [`Door code ${DOOR}-S1`, "9000000002", "9000000001", "Dr. Rao (UAT test vet S1)", "Asha (UAT test contact S1)"];
  out.journeys.sitter = {};
  try {
    await providerSession(context, booking.providerId);
    // 1) The paid visit is listed in the partner app.
    await page.goto(`${BASE}/partner-app`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await dismissCookies(page);
    await page.getByText("PAWSPACE PARTNER MOBILE").waitFor({ timeout: 60_000 }).catch(() => {});
    const link = page.locator(`a[href*="bookingId=${encodeURIComponent(booking.bookingId)}"]`).first();
    await link.waitFor({ timeout: 60_000 }).catch(() => {});
    const listed = await link.isVisible().catch(() => false);
    if (listed) await link.scrollIntoViewIfNeeded().catch(() => {});
    const shotList = await flow.shot("partner-app-home", { fullPage: false });
    const feed = await api(context, "GET", `/api/partner-job-feed?providerId=${encodeURIComponent(booking.providerId)}`, undefined, { timeout: 60_000 });
    const jobs = feed.body?.data ? [...feed.body.data.needsAction, ...feed.body.data.today, ...feed.body.data.upcoming, ...feed.body.data.completed] : [];
    const job = jobs.find(j => j.bookingId === booking.bookingId) || null;
    out.journeys.sitter.feed = { status: feed.status, counts: feed.body?.data?.counts ?? null, job, linkHref: listed ? await link.getAttribute("href") : null };
    record({ suite: SUITE, journey: "S1 sitter: partner app lists the paid visit", combo: `${booking.providerId} · ${booking.bookingId}`, result: listed && job ? "PASS" : "FAIL", detail: `link in "Your service workspaces": ${listed}; feed job ${JSON.stringify(job)}; feed counts ${JSON.stringify(feed.body?.data?.counts ?? feed.status)}`, evidence: [shotList] });
    if (!listed || !job) { const total = await d1("SELECT COUNT(*) AS n, SUM(CASE WHEN scheduled_start < ? THEN 1 ELSE 0 END) AS earlier FROM canonical_bookings WHERE provider_id=?", [booking.scheduledStart, booking.providerId]); out.journeys.sitter.providerBookings = total; }
    if (!listed || !job) file("partner-feed", { severity: "P1", area: "Partner app", persona: "Sitter", flow: journey, title: "A paid Pet Sitting visit is missing from the sitter's partner app", steps: `Customer pays ${booking.bookingId}; sitter ${booking.providerId} opens /partner-app`, expected: "The visit is listed with a link to the sitter workspace", actual: `link ${listed}; /api/partner-job-feed ${feed.status} counts ${JSON.stringify(feed.body?.data?.counts ?? null)}; provider bookings in D1 (all / starting earlier) ${JSON.stringify(out.journeys.sitter.providerBookings)} (lib/partner-job-feed.ts reads the first 500 by scheduled_start)`, evidence: [shotList] });
    // 2) Before acceptance: door code, emergency contact and vet are withheld.
    await page.goto(`${BASE}/sitter?bookingId=${encodeURIComponent(booking.bookingId)}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.getByText("Loading canonical Sitting booking…").waitFor({ state: "detached", timeout: 60_000 }).catch(() => {});
    const careRegion = page.getByRole("region", { name: "Customer care instructions" });
    await careRegion.waitFor({ timeout: 30_000 }).catch(() => {});
    const dd = async label => H.flat(await careRegion.locator("dl > div").filter({ has: page.locator("dt", { hasText: new RegExp(`^${label}$`) }) }).locator("dd").first().innerText().catch(() => ""));
    const before = { status: H.flat(await page.getByText(/^Status:/).first().innerText().catch(() => "")), homeAccess: await dd("Home access instructions"), emergency: await dd("Emergency contact"), vet: await dd("Vet contact"), feeding: await dd("Food and water routine"), text: H.flat(await page.locator("main").innerText().catch(() => "")) };
    const leakedBefore = secrets.filter(s => before.text.includes(s));
    const lifecycle = await api(context, "GET", `/api/sitting-lifecycle?bookingId=${encodeURIComponent(booking.bookingId)}`, undefined, { timeout: 60_000 });
    const plan = lifecycle.body?.data?.[0]?.carePlan || null;
    const shotBefore = await flow.shot("sitter-before-accept");
    const withheld = /Shared once the booking is paid and you have accepted it/.test(before.homeAccess) && /Shared once/.test(before.emergency) && /Shared once/.test(before.vet) && !leakedBefore.length && !plan?.plan?.homeAccess && !plan?.plan?.emergencyContact && !plan?.plan?.vet && ["homeAccess", "emergencyContact", "vet"].every(k => plan?.withheldUntilAccepted?.includes(k));
    out.journeys.sitter.before = { ...before, text: before.text.slice(0, 500), leakedBefore, apiPlan: plan };
    record({ suite: SUITE, journey: "S1 sitter: home access, emergency contact and vet hidden before acceptance (SIT-02)", combo: `${booking.bookingId} ${before.status}`, result: withheld ? "PASS" : "FAIL", detail: `screen: home access "${before.homeAccess}", emergency "${before.emergency}", vet "${before.vet}", food "${before.feeding}"; secrets on screen ${JSON.stringify(leakedBefore)}; API plan keys ${JSON.stringify(Object.keys(plan?.plan || {}))} withheld ${JSON.stringify(plan?.withheldUntilAccepted)}`, evidence: [shotBefore] });
    if (leakedBefore.length || plan?.plan?.homeAccess) file("sit02-leak", { severity: "P0", area: "Pet Sitting privacy", persona: "Sitter", flow: journey, title: "The sitter sees the customer's door code / emergency contact / vet before accepting the booking", steps: `Sitter ${booking.providerId} opens /sitter?bookingId=${booking.bookingId} before accepting`, expected: "Withheld until the paid booking is accepted", actual: `on screen ${JSON.stringify(leakedBefore)}; API plan ${JSON.stringify(plan?.plan).slice(0, 200)}`, evidence: [shotBefore] });
    // 3) Accept through the UI, then the instructions and the address are shared.
    const accept = page.getByRole("button", { name: "Accept booking" });
    const acceptEnabled = await accept.isEnabled().catch(() => false);
    if (acceptEnabled) await accept.click();
    await page.getByText(/^Status:\s*assigned/).waitFor({ timeout: 45_000 }).catch(() => {});
    await settle(page, 800);
    const after = { status: H.flat(await page.getByText(/^Status:/).first().innerText().catch(() => "")), homeAccess: await dd("Home access instructions"), emergency: await dd("Emergency contact"), vet: await dd("Vet contact"), location: H.flat(await page.getByRole("region", { name: "Accepted service location" }).innerText().catch(() => "")), alerts: (await page.getByRole("alert").allInnerTexts().catch(() => [])).map(H.flat) };
    const shotAfter = await flow.shot("sitter-after-accept");
    const shared = /assigned/.test(after.status) && after.homeAccess.includes(`Door code ${DOOR}-S1`) && after.emergency.includes("9000000002") && after.vet.includes("9000000001") && /Indiranagar|560038/.test(after.location);
    out.journeys.sitter.after = after;
    record({ suite: SUITE, journey: "S1 sitter: accepting in the UI shares the instructions and address", combo: `${booking.bookingId} Accept booking (enabled ${acceptEnabled})`, result: shared ? "PASS" : "FAIL", detail: JSON.stringify(after).slice(0, 700), evidence: [shotAfter] });
    if (!shared && after.alerts.some(a => /offer expired|not awaiting sitter acceptance|No pending sitter offer/i.test(a))) file("sitter-accept", { severity: "P1", area: "Partner app", persona: "Sitter", flow: journey, title: "The sitter cannot accept a paid Pet Sitting visit", steps: `Customer pays ${booking.bookingId}; sitter presses Accept booking`, expected: "Status assigned; care instructions shared", actual: after.alerts.join(" | "), evidence: [shotAfter] });
    // 4) Starting before the visit window is refused with a clear message.
    let early = { alerts: [], status: after.status };
    if (/assigned/.test(after.status)) {
      await page.getByRole("button", { name: "Check in with my location" }).click();
      await page.getByRole("alert").first().waitFor({ timeout: 45_000 }).catch(() => {});
      await settle(page, 500);
      early = { alerts: (await page.getByRole("alert").allInnerTexts().catch(() => [])).map(H.flat), status: H.flat(await page.getByText(/^Status:/).first().innerText().catch(() => "")) };
    }
    const shotEarly = await flow.shot("sitter-early-check-in");
    const refused = early.alerts.some(a => /Cannot check in before the Sitting care window starts/.test(a)) && /assigned/.test(early.status);
    out.journeys.sitter.early = early;
    record({ suite: SUITE, journey: "S1 sitter: an early check-in is refused with a clear message", combo: `${booking.bookingId} starts ${booking.scheduledStart}`, result: refused ? "PASS" : /in_progress/.test(early.status) ? "FAIL" : "BLOCKED", detail: JSON.stringify(early).slice(0, 500), evidence: [shotEarly] });
    if (/in_progress/.test(early.status)) file("sitter-early", { severity: "P1", area: "Partner app", persona: "Sitter", flow: journey, title: "A sitter can check in to a visit weeks before it starts", steps: `Accept ${booking.bookingId}, press Check in with my location`, expected: "409 Cannot check in before the Sitting care window starts", actual: early.status, evidence: [shotEarly] });
    // 5) Earnings: booking value is never shown as earned before the visit; figures are sane.
    await page.goto(`${BASE}/partner-app`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.getByText("PAWSPACE PARTNER MOBILE").waitFor({ timeout: 60_000 }).catch(() => {});
    await page.getByRole("button", { name: /Earnings/ }).first().click();
    await page.getByRole("heading", { name: "Earnings" }).waitFor({ timeout: 30_000 }).catch(() => {});
    await settle(page, 2500);
    const earningsText = H.flat(await page.locator("main").innerText().catch(() => ""));
    const shotEarn = await flow.shot("partner-earnings");
    const ws = await api(context, "GET", "/api/provider-workspace", undefined, { timeout: 60_000 });
    const earnings = ws.body?.data?.earnings || null;
    const figures = [earnings?.netPayout, earnings?.orders, earnings?.grossOrderValue].map(Number);
    const listedUpcoming = (ws.body?.data?.bookings?.upcoming || []).find(b => b.bookingId === booking.bookingId) || null;
    const earnedEarly = (earnings?.commissionOrders || []).find(c => c.bookingId === booking.bookingId) || null;
    const sane = ws.status === 200 && figures.every(n => Number.isFinite(n) && n >= 0) && !/NaN|undefined|₹-/.test(earningsText) && !earnedEarly;
    out.journeys.sitter.earnings = { status: ws.status, engagement: ws.body?.data?.engagement, netPayout: earnings?.netPayout, orders: earnings?.orders, gross: earnings?.grossOrderValue, listedUpcoming, earnedEarly, text: earningsText.slice(0, 500) };
    record({ suite: SUITE, journey: "S1 sitter: earnings view is sane", combo: `${booking.providerId} (${ws.body?.data?.engagement || "?"})`, result: sane ? "PASS" : "FAIL", detail: `net ${money(earnings?.netPayout)}, orders ${earnings?.orders}, gross ${money(earnings?.grossOrderValue)}; S1 in workspace upcoming: ${JSON.stringify(listedUpcoming)}; S1 counted as earned before the visit: ${JSON.stringify(earnedEarly)}; screen "${earningsText.slice(0, 240)}"`, evidence: [shotEarn] });
    if (earnedEarly) file("earned-early", { severity: "P1", area: "Partner earnings", persona: "Sitter", flow: journey, title: "A Pet Sitting visit weeks in the future is already counted as earned commission", steps: `Pay ${booking.bookingId}, open partner Earnings`, expected: "Commission appears after the visit is completed", actual: JSON.stringify(earnedEarly), evidence: [shotEarn] });
    flowHealth(flow, journey, [shotEarn]);
  } catch (error) {
    const shot = await flow.shot("error");
    record({ suite: SUITE, journey, combo: booking.bookingId, result: "BLOCKED", detail: `harness: ${String(error?.message || error).slice(0, 400)}`, evidence: [shot] });
  } finally { await flow.close(); }
}

// ------------------------------------------------------------------------------------------------ staff (runner)
async function staffJourney() {
  const journey = "Staff: Booking Command Center + Meet & Greet";
  const rows = Object.values(created);
  if (!rows.length) { record({ suite: SUITE, journey, combo: "bookings of this run", result: "BLOCKED", detail: "harness: no booking was created", evidence: [] }); return; }
  if (!hasAccessCode()) { record({ suite: SUITE, journey, combo: rows.map(r => r.bookingId).join(", "), result: "BLOCKED", detail: "harness: no UAT access code in this runner", evidence: [] }); return; }
  const flow = await newFlow(browser, "30-staff-bcc-meet-greet");
  const { page, context } = flow;
  out.journeys.staff = { bcc: [] };
  try {
    await staffSession(context, "founder@pawspace.in");
    for (const b of rows) {
      const r = await api(context, "GET", `/api/booking-command-center?q=${encodeURIComponent(b.bookingId)}`, undefined, { timeout: 60_000 });
      const row = (r.body?.bookings || []).find(x => x.id === b.bookingId) || null;
      const expectPaid = b.paid;
      const okState = row && (expectPaid ? row.payment_status === "captured" : row.payment_status !== "captured") && Number(row.payment_amount) === b.total && row.payment_mode === b.paymentMode && Number(row.amount_due_now) === b.dueNow;
      const brief = row && { status: row.status, payment_status: row.payment_status, payment_mode: row.payment_mode, payment_amount: row.payment_amount, amount_due_now: row.amount_due_now, provider: row.provider_id, work_order_status: row.work_order_status };
      out.journeys.staff.bcc.push({ key: b.key, bookingId: b.bookingId, http: r.status, row: brief });
      record({ suite: SUITE, journey: "Staff: Booking Command Center payment state", combo: `${b.key} ${b.bookingId}: ${b.paymentMode} ${money(b.total)}${b.balancePaid ? " (deposit + balance)" : ""}`, result: okState ? "PASS" : row ? "FAIL" : "FAIL", detail: `HTTP ${r.status} ${JSON.stringify(brief)}`, evidence: [] });
      if (!row) file(`bcc-missing-${b.key}`, { severity: "P1", area: "Booking Command Center", persona: "Operations", flow: journey, title: "A Pet Sitting booking cannot be found in the Booking Command Center", steps: `GET /api/booking-command-center?q=${b.bookingId} as founder@pawspace.in`, expected: "The booking with its payment state", actual: `HTTP ${r.status}, ${(r.body?.bookings || []).length} rows`, evidence: [] });
    }
    const s1 = created.S1 || rows[0];
    await page.goto(`${BASE}/booking-command-center?bookingId=${encodeURIComponent(s1.bookingId)}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.getByText("Loading connected booking records…").waitFor({ state: "detached", timeout: 60_000 }).catch(() => {});
    await page.getByRole("button", { name: new RegExp(H.flat(s1.bookingId).replace(/[-]/g, "\\-")) }).first().waitFor({ timeout: 30_000 }).catch(() => {});
    await settle(page, 1500);
    const bccText = H.flat(await page.locator("main").innerText().catch(() => ""));
    const shotBcc = await flow.shot("bcc-s1");
    record({ suite: SUITE, journey: "Staff: Booking Command Center opens the Sitting booking", combo: s1.bookingId, result: bccText.includes(s1.bookingId) && /Captured/.test(bccText) ? "PASS" : "FAIL", detail: bccText.slice(0, 400), evidence: [shotBcc] });
    if (created.S4) {
      await page.goto(`${BASE}/booking-command-center?bookingId=${encodeURIComponent(created.S4.bookingId)}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.getByText("Loading connected booking records…").waitFor({ state: "detached", timeout: 60_000 }).catch(() => {});
      await settle(page, 1500);
      await page.getByRole("button", { name: "Payments", exact: true }).click().catch(() => {});
      await settle(page, 600);
      out.journeys.staff.s4Payments = H.flat(await page.locator("main").innerText().catch(() => "")).match(/PAYMENT STATUS.{0,200}/)?.[0] || null;
      await flow.shot("bcc-s4-payments");
    }
    // Staff Meet & Greet page shows S1's request linked to its booking.
    if (created.S1?.meetId) {
      const mg = await api(context, "GET", `/api/meet-and-greet?customerId=${encodeURIComponent(created.S1.customer)}`, undefined, { timeout: 60_000 });
      const req = (Array.isArray(mg.body?.data) ? mg.body.data : []).find(x => x.id === created.S1.meetId) || null;
      await page.goto(`${BASE}/team/meet-and-greet`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.getByText("Loading meet & greet requests").waitFor({ state: "detached", timeout: 60_000 }).catch(() => {});
      const cell = page.getByText(`Booking ${created.S1.bookingId}`).first();
      await cell.waitFor({ timeout: 30_000 }).catch(() => {});
      const shown = await cell.isVisible().catch(() => false);
      if (shown) await cell.scrollIntoViewIfNeeded().catch(() => {});
      const shotMg = await flow.shot("staff-meet-greet", { fullPage: false });
      out.journeys.staff.meet = { http: mg.status, request: req, shown };
      const ok = req?.bookingId === created.S1.bookingId && shown;
      record({ suite: SUITE, journey: "Staff: Meet & Greet page shows S1's request linked to its booking (SIT-01)", combo: `${created.S1.meetId} → ${created.S1.bookingId}`, result: ok ? "PASS" : "FAIL", detail: `API ${mg.status} ${JSON.stringify(req && { id: req.id, bookingId: req.bookingId, status: req.status, format: req.format, priceCharged: req.priceCharged })}; row "Booking ${created.S1.bookingId}" on screen: ${shown}`, evidence: [shotMg] });
      if (!ok) file("sit01-staff", { severity: "P1", area: "Pet Sitting Meet & Greet", persona: "Operations", flow: journey, title: "The staff Meet & Greet page does not show the booking a Sitting introduction was requested for", steps: `Request an introduction on the Care Card and book ${created.S1.bookingId}; open /team/meet-and-greet as founder`, expected: `Request ${created.S1.meetId} shows 'Booking ${created.S1.bookingId}'`, actual: JSON.stringify({ apiBookingId: req?.bookingId ?? null, shown }), evidence: [shotMg] });
    }
    flowHealth(flow, journey, []);
  } catch (error) {
    const shot = await flow.shot("error");
    record({ suite: SUITE, journey, combo: "founder@pawspace.in", result: "BLOCKED", detail: `harness: ${String(error?.message || error).slice(0, 400)}`, evidence: [shot] });
  } finally { await flow.close(); }
}

// ------------------------------------------------------------------------------------------------ D1 (runner)
async function d1ReadBacks() {
  const rows = Object.values(created);
  out.d1 = {};
  if (!rows.length) return;
  const probe = await d1("SELECT 1 AS ok");
  if (probe?.skipped) { record({ suite: SUITE, journey: "D1 read-backs (payments, reconciliation, ledger, lifecycle, Meet & Greet, reservations)", combo: rows.map(r => r.bookingId).join(", "), result: "SKIPPED", detail: `not checked: ${probe.skipped}`, evidence: [] }); return; }
  const list = v => Array.isArray(v) ? v : [];
  for (const b of rows) {
    try {
      const [pay] = list(await d1("SELECT id, status, amount, amount_due_now, mode FROM booking_payments WHERE booking_id=?", [b.bookingId]));
      const events = list(await d1("SELECT event_type, processing_status, amount_subunits, gateway_order_id FROM payment_gateway_events WHERE booking_id=? ORDER BY received_at", [b.bookingId]));
      const [rec] = list(await d1("SELECT expected_amount, captured_amount, refunded_amount, reconciliation_status, gateway_status, variance_amount FROM payment_reconciliation_records WHERE booking_id=?", [b.bookingId]));
      const ledger = pay ? list(await d1("SELECT event, amount, verification_status FROM collection_ledger_postings WHERE payment_id=?", [pay.id])) : [];
      const life = list(await d1("SELECT event_type, actor_id FROM booking_lifecycle_events WHERE booking_id=? ORDER BY occurred_at", [b.bookingId]));
      const [booking] = list(await d1("SELECT status, provider_id, schedule_group_id, total_amount, package_code, scheduled_start, scheduled_end FROM canonical_bookings WHERE id=?", [b.bookingId]));
      const [schedule] = b.paymentMode === "split_50_50" ? list(await d1("SELECT status, total_amount, paid_now_amount, balance_amount FROM stay_payment_schedules WHERE booking_id=?", [b.bookingId])) : [null];
      const expectedPaid = !b.paid ? 0 : b.paymentMode === "split_50_50" ? (b.balancePaid ? b.total : b.dueNow) : b.total;
      const processed = events.filter(e => ["payment.captured", "order.paid"].includes(e.event_type) && e.processing_status === "processed");
      const capturedEvents = H.round2(processed.filter(e => e.event_type === "payment.captured").reduce((s, e) => s + Number(e.amount_subunits || 0), 0) / 100);
      const ledgerCaptured = H.round2(ledger.filter(l => l.event === "online_payment_captured").reduce((s, l) => s + Number(l.amount || 0), 0));
      const types = life.map(l => l.event_type);
      const checks = {
        payment: pay?.status === (b.paid ? "captured" : "created") && Number(pay?.amount) === b.total && Number(pay?.amount_due_now) === b.dueNow,
        gatewayEvents: !b.paid || (capturedEvents === expectedPaid && events.every(e => e.processing_status === "processed")),
        reconciliation: !b.paid || (Number(rec?.captured_amount) === expectedPaid && rec?.reconciliation_status === (b.paymentMode === "split_50_50" && !b.balancePaid ? "partially_captured" : "matched") && Number(rec?.variance_amount || 0) === 0),
        ledger: !b.paid || ledgerCaptured === expectedPaid,
        lifecycle: types.includes("sitting_payment_pending") && (!b.paid || (types.includes("payment_captured") && types.includes("booking_confirmed_after_verified_payment"))),
        booking: booking?.provider_id === b.providerId && Number(booking?.total_amount) === b.total,
        schedule: b.paymentMode !== "split_50_50" || schedule?.status === (b.balancePaid ? "paid" : "pending_balance"),
      };
      b.groupId = b.groupId || booking?.schedule_group_id || null;
      out.d1[b.key] = { pay, events, rec, ledger, lifecycle: types, booking, schedule, checks, expectedPaid, capturedEvents, ledgerCaptured };
      const bad = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
      record({ suite: SUITE, journey: "D1 money read-back", combo: `${b.key} ${b.bookingId}: expected captured ${money(expectedPaid)}`, result: bad.length ? "FAIL" : "PASS", detail: `mismatch: ${bad.join(", ") || "none"}; payment ${JSON.stringify(pay)}; capture events ${money(capturedEvents)} (${processed.length} processed / ${events.length}); reconciliation ${JSON.stringify(rec)}; ledger captured ${money(ledgerCaptured)} ${JSON.stringify(ledger)}; lifecycle ${JSON.stringify(types)}; booking ${JSON.stringify(booking && { status: booking.status, provider: booking.provider_id })}; schedule ${JSON.stringify(schedule)}`.slice(0, 1800), evidence: [] });
      if (b.paid && (!checks.reconciliation || !checks.ledger || !checks.gatewayEvents)) file(`d1-money-${b.key}`, { severity: "P1", area: "Payments", persona: "Finance", flow: `D1 read-back ${b.key}`, title: `A paid Pet Sitting booking's books disagree with what was captured (${bad.join(", ")})`, steps: `Pay ${b.bookingId} in Razorpay TEST; read booking_payments, payment_gateway_events, payment_reconciliation_records, collection_ledger_postings`, expected: `captured ${money(expectedPaid)} everywhere, reconciliation ${b.paymentMode === "split_50_50" && !b.balancePaid ? "partially_captured" : "matched"}`, actual: JSON.stringify({ capturedEvents, rec, ledgerCaptured }).slice(0, 400), evidence: [] });
    } catch (error) { record({ suite: SUITE, journey: "D1 money read-back", combo: `${b.key} ${b.bookingId}`, result: "BLOCKED", detail: `harness: ${String(error?.message || error).slice(0, 300)}`, evidence: [] }); }
  }
  // Meet & Greet linked to S1 (meet_greet_requests.booking_id).
  if (created.S1?.meetId) {
    const [mg] = list(await d1("SELECT id, booking_id, host_provider_id, format, status, price_charged, intended_stay_start, intended_stay_end FROM meet_greet_requests WHERE id=?", [created.S1.meetId]));
    const linkFailed = list(await d1("SELECT event_type FROM booking_lifecycle_events WHERE booking_id=? AND event_type='sitting_meet_greet_link_failed'", [created.S1.bookingId]));
    out.d1.meetGreet = { mg, linkFailed };
    const ok = mg?.booking_id === created.S1.bookingId && mg?.host_provider_id === created.S1.providerId && !linkFailed.length;
    record({ suite: SUITE, journey: "D1 meet_greet_requests.booking_id for S1 (SIT-01)", combo: `${created.S1.meetId} → ${created.S1.bookingId}`, result: ok ? "PASS" : "FAIL", detail: JSON.stringify({ mg, linkFailed }).slice(0, 600), evidence: [] });
    if (!ok) file("sit01-d1", { severity: "P1", area: "Pet Sitting Meet & Greet", persona: "Customer", flow: "S1", title: "The Meet & Greet requested for a Sitting booking is not linked to it", steps: `Request ${created.S1.meetId} on the Care Card, book ${created.S1.bookingId}`, expected: "meet_greet_requests.booking_id = the booking", actual: JSON.stringify({ mg, linkFailed }).slice(0, 300), evidence: [] });
  }
  // Each sitter holds no overlapping reservation around this run's bookings (SIT-03), and the acceptance offers.
  for (const b of rows.filter(r => r.providerId)) {
    const bufferMs = 30 * 60_000;
    const from = new Date(Date.parse(b.scheduledStart) - bufferMs).toISOString(), to = new Date(Date.parse(b.scheduledEnd || b.scheduledStart) + bufferMs).toISOString();
    const res = list(await d1("SELECT group_id, customer_id, scheduled_start, scheduled_end, care_mode, status FROM scheduling_reservations WHERE provider_id=? AND status!='cancelled' AND scheduled_start<? AND scheduled_end>?", [b.providerId, to, from]));
    const others = res.filter(r => r.group_id !== b.groupId);
    const [offer] = b.groupId ? list(await d1("SELECT status, offered_at, expires_at, responded_at FROM provider_assignment_offers WHERE group_id=?", [b.groupId])) : [null];
    out.d1[`reservations_${b.key}`] = { own: res.filter(r => r.group_id === b.groupId), others, offer };
    record({ suite: SUITE, journey: "D1 sitter reservations do not overlap (SIT-03)", combo: `${b.key} ${b.providerId} ${b.scheduledStart} → ${b.scheduledEnd || "?"} (±30 min travel buffer)`, result: others.length ? "FAIL" : res.length ? "PASS" : "FAIL", detail: `own ${res.length - others.length}, overlapping others ${JSON.stringify(others).slice(0, 500)}; acceptance offer ${JSON.stringify(offer && { status: offer.status, minutes: Math.round((Number(offer.expires_at) - Number(offer.offered_at)) / 60_000), expiresAt: new Date(Number(offer.expires_at)).toISOString() })}`, evidence: [] });
    if (others.length) file(`sit03-d1-${b.key}`, { severity: "P1", area: "Pet Sitting scheduling", persona: "Sitter", flow: `D1 reservations ${b.key}`, title: `Sitter ${b.providerId} holds overlapping reservations around ${b.bookingId}`, steps: `SELECT scheduling_reservations for ${b.providerId} between ${from} and ${to}`, expected: "Only this booking's reservation", actual: JSON.stringify(others).slice(0, 400), evidence: [] });
  }
}

// ------------------------------------------------------------------------------------------------ main
const browser = await launch();
try {
  log(`window days ${JSON.stringify(DAYS)} visit times ${T1}/${T2}; access code ${hasAccessCode()}`);
  // Phase 1: S1 (then its sitter while the acceptance offer is fresh) ∥ S2 (Pixel 7) ∥ S3.
  const [, , s3] = await Promise.all([
    wanted("S1") ? journeyS1().then(async r => { log(`S1 done ${created.S1?.bookingId || "-"} paid ${created.S1?.paid}`); await sitterJourney(r); return r; }) : skipped("S1"),
    wanted("S2") ? journeyS2().then(r => { log(`S2 done ${created.S2?.bookingId || "-"} paid ${created.S2?.paid}`); return r; }) : skipped("S2"),
    wanted("S3") ? journeyS3().then(r => { log(`S3 done ${created.S3?.bookingId || "-"} paid ${created.S3?.paid}`); return r; }) : skipped("S3"),
  ]);
  // Phase 2: S4 (split + balance) ∥ S5 (validation, uses S3's sitter) ∥ S6 (near-term).
  if (!overBudget()) {
    await Promise.all([
      wanted("S4") ? journeyS4().then(() => log(`S4 done ${created.S4?.bookingId || "-"} paid ${created.S4?.paid} balance ${created.S4?.balancePaid}`)) : skipped("S4"),
      wanted("S5") ? journeyS5(s3).then(() => log("S5 done")) : skipped("S5"),
      wanted("S6") ? journeyS6().then(() => log(`S6 done ${created.S6?.bookingId || "-"} paid ${created.S6?.paid}`)) : skipped("S6"),
    ]);
  } else record({ suite: SUITE, journey: "S4/S5/S6", combo: "time budget", result: "SKIPPED", detail: `suite passed ${Math.round(BUDGET_MS / 60_000)} minutes in phase 1`, evidence: [] });
  // Phase 3: staff and money read-backs (runner only).
  if (!overBudget()) await staffJourney();
  await d1ReadBacks();
  // Sitter search performance on the booking path (every journey's automatic sitter searches).
  const localCut = p => !process.env.GITHUB_ACTIONS && p.status === 502 && /upstream request failed/i.test(String(p.error || ""));
  const times = out.previews.filter(p => p.status === 200).map(p => p.ms).sort((a, b) => a - b);
  out.previewStats = { count: out.previews.length, ok: times.length, timeouts503: out.previewTimeouts || 0, failed: out.previews.filter(p => p.status !== 200 && p.status !== 503 && !localCut(p)).map(p => `${p.journey}:${p.status}`), localTransportCuts: out.previews.filter(localCut).length, medianMs: times[Math.floor(times.length / 2)] ?? null, maxMs: times.at(-1) ?? null };
  const s2Searches = out.journeys.S2?.previewsPlanning;
  const slow = (times.length >= 2 && out.previewStats.medianMs > 10_000) || out.previewStats.timeouts503 > 0;
  record({ suite: SUITE, journey: "Sitter search performance", combo: `${out.previewStats.count} searches across the journeys`, result: out.previewStats.failed.length ? "FAIL" : slow ? "PARTIAL" : times.length ? "PASS" : "SKIPPED", detail: JSON.stringify({ ...out.previewStats, s2SearchesWhilePlanning: s2Searches }), evidence: [] });
  if (slow) file("preview-slow", { severity: "P2", area: "Pet Sitting performance", persona: "Customer", flow: "Sitter search (POST /api/uat-scheduling action:preview)", title: `${times.length ? `Finding available sitters takes ${Math.round(out.previewStats.medianMs / 1000)} s (median of ${times.length}, max ${Math.round(out.previewStats.maxMs / 1000)} s) on staging` : "The sitter search is slow on staging"}${out.previewStats.timeouts503 ? `; ${out.previewStats.timeouts503} search(es) gave up with 503 "Checking availability is taking longer than usual"` : ""}`, steps: "Plan a Home Visit or Overnight on /v2/sitting and press See available sitters", expected: "< 5 s (the screen gives up after 60 s)", actual: JSON.stringify(out.previewStats), evidence: [] });
  if (s2Searches >= 3) file("preview-per-change", { severity: "P2", area: "Pet Sitting performance", persona: "Customer", flow: "S2 Plan step", title: `Every care-type/date/time/pet change on the Plan step starts a new sitter search (${s2Searches} before the customer pressed See available sitters); earlier searches are never cancelled`, steps: "On /v2/sitting (Pixel 7) wait for the page, choose Home Visit, a date, a time and a second pet", expected: "One search, when the customer asks for sitters (or earlier searches aborted)", actual: `${s2Searches} POST /api/uat-scheduling {action:"preview"} while planning; each takes ${out.previewStats.medianMs} ms median on staging (stay-flow.tsx preview effect has no AbortController)`, evidence: out.journeys.S2?.evidence?.slice(0, 1) || [] });
} catch (error) {
  record({ suite: SUITE, journey: "suite", combo: "harness", result: "BLOCKED", detail: `harness: ${String(error?.stack || error).slice(0, 600)}`, evidence: [] });
} finally {
  out.bookings = Object.values(created);
  out.elapsedSeconds = elapsed();
  writeJson("sitting-journeys.json", out);
  log(`finished in ${elapsed()} s; bookings ${out.bookings.map(b => `${b.key}:${b.bookingId}:${b.paid ? "paid" : "unpaid"}`).join(" ")}`);
  await browser.close();
}
