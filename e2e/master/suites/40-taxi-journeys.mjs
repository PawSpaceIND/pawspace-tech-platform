// Pet Taxi end to end on staging — customer → driver → staff → money — on the REAL V2 5-step flow (/v2/taxi, which
// renders app/mobile-app/taxi-flow.tsx): party → trip → review → server route quote (Google geocoding + Google Routes)
// → car choice, PIN and reservation (POST /api/uat-scheduling, then /api/taxi-ride-bookings, which holds a physical
// fleet car for the 3-hour window) → 50% booking fee in the Razorpay TEST checkout.
//  Customer (two parallel lanes, one run-scoped OTP customer each; T2 runs on a Pixel 7 with video):
//   T1 one-way 1 passenger 1 pet Citroën, fee paid on the booking page, then PAY-05 (nothing payable until drop-off)
//   T2 round trip + 90 min wait, 2 passengers 2 pets (mobile), fee paid from step 5
//   T3 airport flat fare (₹2,300 Citroën / ₹2,600 XUV), XUV fee paid on the booking page
//   T4 no passenger (+₹300 handler), checkout opened and left unpaid
//   T5 4 passengers 3 pets 4 bags: only the XUV is eligible, the Citroën shows why
//   T6 refusals: same pickup and drop · < 2 h notice · > 180 days · pickup outside the service area
//   T7 the customer tries to cancel T4's unpaid hold (what the product offers, and whether the car is released)
//   T8 near-term ride (earliest slot ≥ 2 h 15 min inside service hours), fee paid — saved nearTerm for partner-due
//  Driver (runner only): the partner app lists the rides; the driver accepts T1 in the driver workspace, confirms the
//   reserved car, and confirming pickup weeks early is refused on screen (409 taxi_pickup_too_early, PARTNER-03);
//   the Earnings view loads.
//  Staff (runner only): the Booking Command Center shows every ride with its payment state; the Taxi finance workspace
//   loads (founder — Finance accounts need MFA on staging).
//  D1 (runner only, read-only): payments, fee/balance schedule, gateway events, reconciliation, collection ledger,
//   lifecycle events, trip, ride details and fleet reservation for every ride.
// Far-future rides sit on one day inside days 96–110 picked from the run id, one per 3½-hour window so a single
// driver can take them all; a capacity refusal moves that ride to the next day.
import {
  BASE, launch, newFlow, settle, api, otpCustomerSession, providerSession, staffSession, runPhone, dismissCookies,
  d1, isoDay, record, finding, saveBooking, writeJson, hasAccessCode,
} from "../lib.mjs";
import {
  sleep, istMs, TIMES, inr, num, text, expectedFare, citroenReasons, instrument, isLocalProxyCut, openTaxi, fillParty,
  fillTrip, setWhen, priceRide, readCards, chooseVehicle, fareRows, reserveRide, CAPACITY, backToTrip,
  payFromBookingPage, payInFlow, openCheckoutOnly, readBookingPage, readManagePage, LEGACY_TAXI,
} from "./_40-taxi-journeys-helpers.mjs";

const SUITE = "40-taxi-journeys";
const RUN = String(process.env.GITHUB_RUN_ID || process.env.MASTER_RUN_ID || Date.now());
const SEED = Number(RUN.replace(/\D/g, "").slice(-6)) || 0;
const DAY = 96 + (SEED % 15);                                     // ride day inside the Taxi window 96–110
const wrapDay = d => 96 + ((d - 96) % 15 + 15) % 15;
const PICKUP = "100 Feet Road, Indiranagar, Bengaluru 560038", DROP = "Koramangala 5th Block, Bengaluru 560095";
const AIRPORT = "Kempegowda International Airport, Bengaluru 560300", OUTSIDE = "Mysore Palace, Mysuru, Karnataka 570001";
const FLEET_DRIVERS = ["taxi_rahul", "taxi_meera"];              // lib/taxi-fleet-governance.ts TAXI_FULL_TIME_DRIVERS
const CUSTOMERS = { A: { phone: runPhone(4), name: "Master E2E Taxi A" }, B: { phone: runPhone(7), name: "Master E2E Taxi B" } };
const started = Date.now();
// Local development only: TAXI40_ONLY=T5,T6 runs a subset of the customer journeys (the workflow never sets it).
const ONLY = String(process.env.TAXI40_ONLY || "").split(",").map(x => x.trim()).filter(Boolean);
const want = id => !ONLY.length || ONLY.includes(id);
const out = { suite: SUITE, run: RUN, day: DAY, date: isoDay(DAY), journeys: {}, rides: [], perf: { quotes: [], reserves: [], refusals: [] }, driver: {}, staff: {}, d1: {} };
const log = (m, extra) => console.log(`[${SUITE}] ${m}${extra === undefined ? "" : " " + JSON.stringify(extra).slice(0, 600)}`);
const once = new Set();
const findingOnce = (key, row) => { if (once.has(key)) return; once.add(key); finding({ suite: SUITE, ...row }); };
const rec = row => { record({ suite: SUITE, ...row }); out.journeys[`${row.journey} · ${row.combo}`] = { result: row.result, detail: String(row.detail).slice(0, 400) }; log(`${row.result} ${row.journey} · ${row.combo}`); };
const ENVIRONMENT = /long-running import|upstream r|Unexpected token/;
/** Why a ride could not be reserved, in the words the report uses: a full window is capacity, not a defect. */
const whyBlocked = b => { const e = String(b.priced?.error || b.reserved?.error || ""), refusals = JSON.stringify(b.refusals || []).slice(0, 350); return CAPACITY.test(e) ? `capacity: ${e}; attempts ${refusals}` : ENVIRONMENT.test(e) ? `environment: ${e}; attempts ${refusals}` : `${b.stage}: ${e}; attempts ${refusals}`; };
const harness = e => {
  const m = String(e?.message || e).split("\n")[0];
  if (m.includes(LEGACY_TAXI)) { findingOnce("legacy-taxi", { severity: "P1", area: "Pet Taxi (V2 customer)", persona: "Customer", flow: "Open /v2/taxi", title: "Staging /v2/taxi serves the legacy Gate-1 trip page again (TAXI-01 regression)", steps: "Sign in as a customer and open /v2/taxi", expected: "The 5-step ride flow: passengers & pets → trip → review → Google Routes fare → car, PIN and reserve", actual: m, evidence: [] }); return `product: ${m.slice(0, 300)}`; }
  return `harness: ${m.slice(0, 300)}`;
};

/** A new context signed in as the lane's customer (a new OTP sign-in supersedes that customer's older session). */
async function customerFlow(browser, lane, name, opts = {}) {
  const flow = await newFlow(browser, name, opts);
  instrument(flow);
  const c = CUSTOMERS[lane];
  const who = await otpCustomerSession(flow.context, c.phone, c.name);
  flow.customer = { lane, phone: c.phone, id: who.customerId };
  const close = flow.close.bind(flow);
  flow.close = async () => { if (flow.accountRetries) out.perf.accountRetries = (out.perf.accountRetries || 0) + flow.accountRetries; return close(); };
  return flow;
}
async function ensurePets(flow) {
  const { context } = flow;
  let account = (await api(context, "GET", "/api/customer-account")).body?.data;
  for (const [name, species] of [["TaxiDog", "dog"], ["TaxiCat", "cat"], ["TaxiPup", "dog"]]) {
    if (account?.pets?.some(p => p.name === name)) continue;
    const r = await api(context, "POST", "/api/customer-account", { customerId: account.customerId, action: "upsert_pet", idempotencyKey: `taxi40-pet-${name}-${flow.customer.phone}`, pet: { name, species, breed: species === "dog" ? "Indie" : "Persian", vaccinationStatus: "verified" } });
    if (r.status >= 300) throw new Error(`could not add pet ${name}: HTTP ${r.status}`);
  }
  account = (await api(context, "GET", "/api/customer-account")).body?.data;
  return account;
}

/** Every unexpected 5xx on this journey and every uncaught page error is a finding (the local proxy's cut excluded). */
function auditFlow(flow, journey) {
  const bad = flow.log.apiFailures.filter(f => f.status >= 500 && !isLocalProxyCut({ status: f.status, body: f.body }) && !/long-running import/.test(String(f.body)));
  for (const f of flow.log.apiFailures.filter(x => /long-running import/.test(String(x.body)))) out.environment = [...(out.environment || []), `${f.method} ${f.url.split("?")[0]} ${f.status}: staging D1 import in progress`];
  for (const f of bad) {
    const money = /taxi|scheduling|checkout|payment/.test(f.url);
    findingOnce(`5xx ${f.method} ${f.url.split("?")[0]} ${f.status}`, { severity: money ? "P1" : "P2", area: "Pet Taxi", persona: "Customer", flow: journey, title: `${f.method} ${f.url.split("?")[0]} answered HTTP ${f.status} during "${journey}"`, steps: `Run ${journey} on /v2/taxi`, expected: "A governed JSON answer (or a clear refusal)", actual: `HTTP ${f.status} ${String(f.body).replace(/\s+/g, " ").slice(0, 250)}`, evidence: flow.log.steps.filter(s => s.file).slice(-2).map(s => `shots/${flow.name}/${s.file}`) });
  }
  for (const e of flow.log.pageErrors) findingOnce(`pageerror ${e.text.slice(0, 80)}`, { severity: "P2", area: "Pet Taxi", persona: "Customer", flow: journey, title: `Uncaught page error on the Pet Taxi journey: ${e.text.slice(0, 120)}`, steps: journey, expected: "No uncaught errors", actual: e.text, evidence: [] });
}
function checkQuote(label, q, step4, rows, vehicle) {
  const problems = [];
  for (const v of ["citroen_ec3", "xuv"]) {
    const opt = q.fareOptions?.[v], exp = expectedFare(v, q), reasons = citroenReasons(q);
    const shouldBeEligible = v === "xuv" || reasons.length === 0;
    if (Boolean(opt?.eligible) !== shouldBeEligible) problems.push(`${v} eligible=${opt?.eligible}, rules say ${shouldBeEligible}`);
    if (opt?.eligible && (Number(opt.quotedTotal) !== exp.total || Number(opt.bookingFee) !== exp.fee || Number(opt.distanceFare) !== exp.distanceFare || Number(opt.waitingCharge) !== exp.waiting || Number(opt.handlerCharge) !== exp.handler))
      problems.push(`${v} server ${JSON.stringify({ d: opt.distanceFare, w: opt.waitingCharge, h: opt.handlerCharge, t: opt.quotedTotal, f: opt.bookingFee })} vs rules ${JSON.stringify(exp)}`);
    if (opt?.eligible && !step4.includes(inr(opt.quotedTotal))) problems.push(`${v} card does not show ${inr(opt.quotedTotal)}`);
  }
  const sel = q.fareOptions?.[vehicle];
  if (sel && rows && (rows.total !== Number(sel.quotedTotal) || rows.fee !== Number(sel.bookingFee) || rows.balance !== Number(sel.finalBalanceBeforeAdjustments)))
    problems.push(`fare rows ${JSON.stringify(rows)} vs server ${JSON.stringify({ t: sel.quotedTotal, f: sel.bookingFee, b: sel.finalBalanceBeforeAdjustments })}`);
  const oneDecimal = step4.match(/₹[\d,]+\.\d(?!\d)/);
  if (oneDecimal) findingOnce("one-decimal", { severity: "P3", area: "Pet Taxi UI copy", persona: "Customer", flow: label, title: `Pet Taxi prices are shown with a single decimal (e.g. "${oneDecimal[0]}")`, steps: `Price ${label} on /v2/taxi`, expected: "Rupee amounts with two decimals (₹722.80) or none", actual: oneDecimal[0], evidence: [] });
  if (problems.length) findingOnce(`fare ${label}`, { severity: "P1", area: "Pet Taxi pricing", persona: "Customer", flow: label, title: `Pet Taxi fare shown for "${label}" differs from the fare rules`, steps: `Price ${label} on /v2/taxi (${q.distanceKm} km, ${q.tripType}, ${q.ridePurpose})`, expected: "lib/taxi-business-rules.ts calculateTaxiFare", actual: problems.join("; ").slice(0, 500), evidence: [] });
  return problems;
}

/**
 * One ride through the UI up to a booking, moving to the next day when the window has no free driver/car.
 * Records the scheduler's choice of driver so a refusal caused by a driver with no fleet car is reported.
 */
async function bookRide(flow, o, label) {
  await openTaxi(flow);
  const party = await fillParty(flow, o);
  const evidence = [await flow.shot(`${label}-party`, { fullPage: false })];
  const days = o.days || [o.day, wrapDay(o.day + 1), wrapDay(o.day + 2)];
  let trip = null, attempt = 0, last = null;
  const refusals = [];
  for (const day of days) {
    const date = typeof day === "string" ? day : isoDay(day), time = o.times?.[attempt] || o.time;
    if (attempt === 0) { await flow.page.getByRole("button", { name: "Continue to trip details" }).click(); trip = await fillTrip(flow, { ...o, date, time }); evidence.push(await flow.shot(`${label}-trip`, { fullPage: false })); }
    else { await backToTrip(flow); await setWhen(flow, date, time); }
    attempt += 1;
    const priced = await priceRide(flow, { shotLabel: `${label}-${attempt}` });
    out.perf.quotes.push({ label, ms: priced.ms ?? priced.attempts.at(-1)?.ms, status: priced.ok ? 201 : priced.status });
    if (!priced.ok) return { ok: false, stage: "quote", priced, party, trip, evidence: [...evidence, ...priced.evidence], refusals };
    await chooseVehicle(flow, o.vehicle);
    await settle(flow.page, 300);
    const step4 = await text(flow.page), cards = await readCards(flow), rows = fareRows(step4);
    const problems = checkQuote(label, priced.q, step4, rows, o.vehicle);
    const reserved = await reserveRide(flow, { pin: o.pin || "560038", shotLabel: `${label}-${attempt}` });
    for (const a of reserved.attempts) out.perf.reserves.push({ label, ms: a.ms, schedulingMs: a.schedulingMs, bookingMs: a.bookingMs, outcome: a.outcome, harness: a.harness || null });
    last = { priced, step4, cards, rows, problems, reserved, date, time };
    if (reserved.ok) return { ok: true, ...last, party, trip, evidence: [...evidence, ...priced.evidence, ...reserved.evidence], refusals };
    const a = reserved.attempts.at(-1);
    refusals.push({ date, time, error: reserved.error, providerId: a?.providerId, scheduling: a?.schedulingError, booking: a?.bookingError });
    out.perf.refusals.push({ label, date, time, error: reserved.error, providerId: a?.providerId || null, fleetDriver: a?.providerId ? FLEET_DRIVERS.includes(a.providerId) : null });
    const retryable = CAPACITY.test(reserved.error || "") || ENVIRONMENT.test(reserved.error || "") || reserved.attempts.some(x => x.harness);
    if (!retryable || !o.fallback) return { ok: false, stage: "reserve", ...last, party, trip, evidence: [...evidence, ...priced.evidence, ...reserved.evidence], refusals };
    log(`${label}: ${date} ${time} refused (${reserved.error}); trying the next day`);
  }
  return { ok: false, stage: "reserve", ...last, party, trip, evidence, refusals };
}
function rideRow(label, o, b, flow) {
  const sel = b.priced.q.fareOptions[o.vehicle];
  const ride = { label, bookingId: b.reserved.bookingId, customer: flow.customer.id, phone: flow.customer.phone, providerId: b.reserved.providerId || b.reserved.booking?.provider?.id || null, vehicle: o.vehicle, scheduledStart: b.priced.q.scheduledStart, total: Number(sel.quotedTotal), fee: Number(sel.bookingFee), balance: Number(sel.finalBalanceBeforeAdjustments), distanceKm: b.priced.q.distanceKm, reservedVehicle: b.reserved.booking?.reservedVehicle || null, paid: false, nearTerm: Boolean(o.nearTerm), q: { passengerCount: b.priced.q.passengerCount, petCount: b.priced.q.petCount, luggageCount: b.priced.q.luggageCount, tripType: b.priced.q.tripType, ridePurpose: b.priced.q.ridePurpose, waitingMinutes: b.priced.q.waitingMinutes } };
  out.rides.push(ride);
  return ride;
}
const save = ride => saveBooking({ suite: SUITE, bookingId: ride.bookingId, service: "pet_taxi", packageCode: ride.vehicle, providerId: ride.providerId, customer: ride.customer, customerPhone: ride.phone, scheduledStart: ride.scheduledStart, total: ride.total, dueNow: ride.fee, paid: ride.paid, paymentMode: "split_50_50", nearTerm: ride.nearTerm || undefined, driverAccepted: ride.driverAccepted || undefined });
function step5Check(ride, b) {
  const s = b.reserved.step5 || "";
  if (/NaN|undefined/.test(s)) findingOnce("step5-nan", { severity: "P2", area: "Pet Taxi", persona: "Customer", flow: `${ride.label} reserve`, title: `After Reserve the ride summary shows "${(s.match(/[^|]*\| ₹?(NaN|undefined)/) || ["NaN"])[0].trim()}"`, steps: `Reserve ${ride.bookingId} on /v2/taxi${b.reserved.attempts.some(a => a.harness) ? " (the first Reserve response was lost and the customer pressed Reserve again, so /api/taxi-ride-bookings answered with its idempotent replay, which carries no balanceAmount)" : ""}`, expected: `Base final balance ${inr(ride.balance)}`, actual: (s.match(/Booking fee[^]*?Car \| [^|]+/) || [s.slice(0, 200)])[0], evidence: b.reserved.evidence });
  const ok = /RIDE HELD · PAYMENT REQUIRED/.test(s) && s.includes(ride.bookingId) && s.includes(`Booking fee | ${inr(ride.fee)}`) && s.includes(`Base final balance | ${inr(ride.balance)}`);
  return { ok, excerpt: (s.match(/RIDE HELD[^]*?Status \| [^|]+/) || [s.slice(0, 300)])[0] };
}
/** Fee paid → the booking page must not ask for more money now; the balance is requested after drop-off (PAY-05). */
function feeRecords(journey, ride, pay, extraEvidence = []) {
  const captured = pay.status?.paymentStatus === "captured" && pay.status?.bookingStatus === "confirmed";
  ride.paid = pay.status?.paymentStatus === "captured"; ride.payment = pay.status || null;
  rec({ journey, combo: `50% booking fee ${inr(ride.fee)} via Razorpay TEST`, result: captured ? "PASS" : pay.opened && pay.paid?.ok ? "FAIL" : "BLOCKED", detail: `${pay.opened && !pay.paid?.ok ? "harness: Razorpay TEST control not reached; " : ""}${ride.bookingId}: ${JSON.stringify(pay.status || pay.reason)}; checkout opened in ${pay.checkoutOpenMs ?? "-"} ms; netbanking ${JSON.stringify(pay.paid || null)}`, evidence: [...pay.evidence, ...extraEvidence] });
  if (pay.opened && pay.paid?.ok && !captured) findingOnce(`not-captured-${ride.bookingId}`, { severity: "P1", area: "Payments", persona: "Customer", flow: journey, title: "Pet Taxi booking fee paid in Razorpay TEST but the ride is not captured and confirmed within 2.5 minutes", steps: `Pay the fee for ${ride.bookingId}`, expected: "paymentStatus captured, booking confirmed", actual: JSON.stringify(pay.status), evidence: pay.evidence });
  return captured;
}
async function pay05(flow, journey, ride) {
  const page = await readBookingPage(flow, ride.bookingId, journey.slice(0, 2));
  const exactBalance = num((page.text.match(/The final balance of (₹[\d,.]+) is requested after drop-off/) || [])[1]) === ride.balance;
  rec({ journey, combo: "booking page after the fee (PAY-05)", result: !page.offersPayment && page.explains && exactBalance ? "PASS" : "FAIL", detail: page.text.slice(0, 500), evidence: page.evidence });
  if (page.offersPayment) findingOnce(`pay05-${journey}`, { severity: "P1", area: "Payments", persona: "Customer", flow: journey, title: "After the Pet Taxi booking fee is captured the booking page still offers a payment", steps: `Pay the fee for ${ride.bookingId}, reload /v2/booking`, expected: "Booking fee paid; final balance requested after drop-off; nothing due now", actual: page.text.slice(0, 400), evidence: page.evidence });
  return page;
}

// ------------------------------------------------------------------------------------------------ customer lanes
async function laneA(browser) {
  // T1 — one-way, 1 passenger, 1 pet, Citroën; fee on the booking page; PAY-05; manage page.
  if (want("T1")) await (async () => { const flow = await customerFlow(browser, "A", "40-T1-oneway-citroen");
  try {
    await ensurePets(flow);
    const o = { passengers: 1, luggage: 0, pets: ["TaxiDog"], trip: "one_way", purpose: "regular", pickup: PICKUP, drop: DROP, day: DAY, time: "06:00", vehicle: "citroen_ec3", fallback: true };
    const b = await bookRide(flow, o, "T1");
    if (b.trip) rec({ journey: "T1 one-way 1 pax 1 pet", combo: "address entry", result: "PASS", detail: `Pickup and drop are free-text fields: typing "${PICKUP}" offered ${b.trip.suggestions} suggestion list(s); the server geocodes the text with Google when it prices the route`, evidence: b.evidence.slice(1, 2) });
    if (!b.ok) { rec({ journey: "T1 one-way 1 pax 1 pet", combo: "Citroën, reserve", result: b.stage === "quote" ? "FAIL" : "BLOCKED", detail: whyBlocked(b), evidence: b.evidence }); return; }
    const ride = rideRow("T1", o, b, flow), s5 = step5Check(ride, b);
    rec({ journey: "T1 one-way 1 pax 1 pet", combo: `Citroën quote ${b.priced.q.distanceKm} km`, result: b.problems.length ? "FAIL" : "PASS", detail: `total ${inr(ride.total)} fee ${inr(ride.fee)} balance ${inr(ride.balance)}; route ${b.priced.q.routeSource}; quote ${b.priced.ms} ms; ${b.problems.join("; ")}`, evidence: b.priced.evidence });
    rec({ journey: "T1 one-way 1 pax 1 pet", combo: "reserve → step 5", result: s5.ok ? "PASS" : "FAIL", detail: `${ride.bookingId} ${b.date} ${b.time} IST driver ${ride.providerId} car ${ride.reservedVehicle?.label}; ${s5.excerpt}; reserve ${b.reserved.attempts.at(-1).ms} ms (scheduling ${b.reserved.attempts.at(-1).schedulingMs} ms, booking ${b.reserved.attempts.at(-1).bookingMs} ms)`, evidence: b.reserved.evidence });
    const pay = await payFromBookingPage(flow, ride.bookingId, "T1");
    const feeShown = pay.dueNow === ride.fee && pay.balanceLater === ride.balance;
    rec({ journey: "T1 one-way 1 pax 1 pet", combo: "booking page before payment", result: feeShown ? "PASS" : "FAIL", detail: `Due now ${pay.dueNow} (quote ${ride.fee}), balance later ${pay.balanceLater} (quote ${ride.balance})`, evidence: pay.evidence.slice(0, 1) });
    if (!feeShown && pay.dueNow) findingOnce("fee-mismatch", { severity: "P2", area: "Pet Taxi pricing", persona: "Customer", flow: "T1", title: "The booking page asks for a different booking fee than the ride quote (TAXI-04)", steps: `Reserve ${ride.bookingId}, open /v2/booking`, expected: `Due now ${inr(ride.fee)}, balance later ${inr(ride.balance)}`, actual: `Due now ${pay.dueNow}, balance later ${pay.balanceLater}`, evidence: pay.evidence.slice(0, 1) });
    const captured = feeRecords("T1 one-way 1 pax 1 pet", ride, pay);
    save(ride);
    if (captured) {
      await pay05(flow, "T1 one-way 1 pax 1 pet", ride);
      const m = await readManagePage(flow, ride.bookingId, "T1");
      const exact = m.total === ride.total && m.fee === ride.fee && m.balance === ride.balance;
      rec({ journey: "T1 one-way 1 pax 1 pet", combo: "manage page after the fee", result: m.total !== null && !m.offersFinalPayment ? (exact ? "PASS" : "PARTIAL") : "FAIL", detail: `ride total ${m.total}, fee ${m.fee}, final balance ${m.balance} (exact ${ride.total}/${ride.fee}/${ride.balance}); final payment offered: ${m.offersFinalPayment}`, evidence: m.evidence });
      if (m.total !== null && !exact) findingOnce("manage-rounding", { severity: "P3", area: "Pet Taxi", persona: "Customer", flow: "T1 manage page", title: "The ride manage page rounds the fare to whole rupees, so the booking fee shown differs from what was charged", steps: `Open /v2/taxi/manage?bookingId=${ride.bookingId} after paying ${inr(ride.fee)}`, expected: `Ride total ${inr(ride.total)} · booking fee ${inr(ride.fee)} · final balance ${inr(ride.balance)}`, actual: `Ride total ₹${m.total} · booking fee ₹${m.fee} · final balance ₹${m.balance}`, evidence: m.evidence });
    }
  } catch (e) { rec({ journey: "T1 one-way 1 pax 1 pet", combo: "Citroën, fee paid", result: "BLOCKED", detail: harness(e), evidence: [await flow.shot("T1-harness-error").catch(() => null)].filter(Boolean) }); }
  finally { auditFlow(flow, "T1 one-way"); await flow.close(); }
  })().catch(e => rec({ journey: "Customer sign-in", combo: "journey start", result: "BLOCKED", detail: harness(e), evidence: [] }));

  // T3 — airport flat fare; XUV fee on the booking page.
  if (want("T3")) await (async () => { const flow = await customerFlow(browser, "A", "40-T3-airport");
  try {
    const o = { passengers: 1, luggage: 2, pets: ["TaxiDog"], trip: "one_way", purpose: "airport", pickup: PICKUP, drop: AIRPORT, day: DAY, time: "13:00", vehicle: "xuv", fallback: true };
    const b = await bookRide(flow, o, "T3");
    if (!b.ok) { rec({ journey: "T3 airport flat fare", combo: "XUV, reserve", result: b.stage === "quote" ? "FAIL" : "BLOCKED", detail: whyBlocked(b), evidence: b.evidence }); return; }
    const q = b.priced.q, flat = q.fareOptions.citroen_ec3.quotedTotal === 2300 && q.fareOptions.xuv.quotedTotal === 2600 && q.fareOptions.xuv.bookingFee === 1300 && b.cards.citroen_ec3.text.includes("₹2,300") && b.cards.xuv.text.includes("₹2,600");
    rec({ journey: "T3 airport flat fare", combo: `Kempegowda airport, ${q.distanceKm} km`, result: flat && !b.problems.length ? "PASS" : "FAIL", detail: `Citroën ${inr(q.fareOptions.citroen_ec3.quotedTotal)} (eligible ${q.fareOptions.citroen_ec3.eligible}), XUV ${inr(q.fareOptions.xuv.quotedTotal)} fee ${inr(q.fareOptions.xuv.bookingFee)}; ${b.problems.join("; ")}`, evidence: b.priced.evidence });
    const ride = rideRow("T3", o, b, flow), s5 = step5Check(ride, b);
    rec({ journey: "T3 airport flat fare", combo: "XUV reserve → step 5", result: s5.ok && /XUV/.test(ride.reservedVehicle?.label || b.reserved.step5) ? "PASS" : "FAIL", detail: `${ride.bookingId} ${b.date} ${b.time} driver ${ride.providerId} car ${ride.reservedVehicle?.label}; ${s5.excerpt}`, evidence: b.reserved.evidence });
    const pay = await payFromBookingPage(flow, ride.bookingId, "T3");
    feeRecords("T3 airport flat fare", ride, pay);
    save(ride);
    if (ride.paid) await pay05(flow, "T3 airport flat fare", ride);
  } catch (e) { rec({ journey: "T3 airport flat fare", combo: "XUV, fee paid", result: "BLOCKED", detail: harness(e), evidence: [] }); }
  finally { auditFlow(flow, "T3 airport"); await flow.close(); }
  })().catch(e => rec({ journey: "Customer sign-in", combo: "journey start", result: "BLOCKED", detail: harness(e), evidence: [] }));

  // T5 — 4 passengers, 3 pets, 4 bags: XUV only.
  if (want("T5")) await (async () => { const flow = await customerFlow(browser, "A", "40-T5-xuv-only");
  try {
    await ensurePets(flow);
    await openTaxi(flow);
    await fillParty(flow, { passengers: 4, luggage: 4, pets: ["TaxiDog", "TaxiCat", "TaxiPup"] });
    await flow.page.getByRole("button", { name: "Continue to trip details" }).click();
    await fillTrip(flow, { trip: "one_way", purpose: "regular", pickup: PICKUP, drop: DROP, date: isoDay(wrapDay(DAY + 4)), time: "11:00" }, { typeAddresses: false });
    const priced = await priceRide(flow, { shotLabel: "T5" });
    if (!priced.ok) throw new Error(`quote refused: ${priced.error}`);
    const q = priced.q, cards = await readCards(flow);
    await flow.page.getByLabel("Pickup PIN code").fill("560038");
    const reserveLabel = await flow.page.getByRole("button", { name: /^Reserve · pay/ }).innerText().catch(() => "");
    const shot = await flow.shot("T5-xuv-only", { fullPage: false });
    const reason = q.fareOptions.citroen_ec3.ineligibleReason || "";
    const ok = !q.fareOptions.citroen_ec3.eligible && q.fareOptions.xuv.eligible && q.recommendedVehicleClass === "xuv" && cards.citroen_ec3.disabled === true && cards.citroen_ec3.text.includes(reason) && reserveLabel.includes(inr(q.fareOptions.xuv.bookingFee));
    const problems = checkQuote("T5 4 pax 3 pets 4 bags", q, priced.step4, fareRows(priced.step4), "xuv");
    rec({ journey: "T5 4 pax 3 pets 4 bags", combo: "only the XUV is eligible", result: ok && !problems.length ? "PASS" : "FAIL", detail: `Citroën card disabled=${cards.citroen_ec3.disabled}, reason "${reason}"; XUV ${inr(q.fareOptions.xuv.quotedTotal)} fee ${inr(q.fareOptions.xuv.bookingFee)}; button "${reserveLabel}"; ${problems.join("; ")}`, evidence: [...priced.evidence, shot] });
    if (/more_than_|route_over_/.test(cards.citroen_ec3.text)) findingOnce("raw-ineligible-reason", { severity: "P3", area: "Pet Taxi UI copy", persona: "Customer", flow: "T5 car choice", title: "The Citroën card explains its ineligibility with internal rule codes", steps: "Price a ride for 4 passengers, 3 pets and 4 bags on /v2/taxi", expected: "Plain words, e.g. 'Seats up to 3 passengers and 3 bags — choose the XUV'", actual: `"${reason}"`, evidence: [shot] });
  } catch (e) { rec({ journey: "T5 4 pax 3 pets 4 bags", combo: "only the XUV is eligible", result: "BLOCKED", detail: harness(e), evidence: [] }); }
  finally { auditFlow(flow, "T5 XUV only"); await flow.close(); }
  })().catch(e => rec({ journey: "Customer sign-in", combo: "journey start", result: "BLOCKED", detail: harness(e), evidence: [] }));

  // T6 — refusals.
  if (want("T6")) await (async () => { const flow = await customerFlow(browser, "A", "40-T6-validation");
  const base = { passengers: 1, luggage: 0, pets: ["TaxiDog"], trip: "one_way", purpose: "regular", vehicle: "citroen_ec3" };
  const account = await ensurePets(flow).catch(() => null);
  const dog = account?.pets?.find(p => p.name === "TaxiDog");
  // (a) same pickup and drop
  try {
    await openTaxi(flow); await fillParty(flow, base);
    await flow.page.getByRole("button", { name: "Continue to trip details" }).click();
    await fillTrip(flow, { ...base, pickup: PICKUP, drop: PICKUP, date: isoDay(wrapDay(DAY + 5)), time: "10:00" }, { typeAddresses: false });
    const priced = await priceRide(flow, { shotLabel: "T6a-same-address" });
    const ok = !priced.ok && priced.status === 400 && /distinct complete pickup and drop/i.test(priced.error);
    rec({ journey: "T6 validation", combo: "same pickup and drop", result: ok ? "PASS" : "FAIL", detail: priced.ok ? `quoted ${priced.q.distanceKm} km` : `HTTP ${priced.status}: "${priced.error}"`, evidence: priced.evidence });
  } catch (e) { rec({ journey: "T6 validation", combo: "same pickup and drop", result: "BLOCKED", detail: harness(e), evidence: [] }); }
  // (b) less than 2 hours' notice: through the screen when today still offers such a time, otherwise the same call it makes.
  try {
    const now = Date.now(), today = isoDay(0);
    const slot = TIMES.find(t => istMs(today, t) > now + 12 * 60_000 && istMs(today, t) < now + 105 * 60_000);
    if (slot) {
      await openTaxi(flow); await fillParty(flow, base);
      await flow.page.getByRole("button", { name: "Continue to trip details" }).click();
      await fillTrip(flow, { ...base, pickup: PICKUP, drop: DROP, date: today, time: slot }, { typeAddresses: false });
      const priced = await priceRide(flow, { shotLabel: "T6b-short-notice" });
      let detail = priced.ok ? "" : `quote refused: ${priced.error}`, ok = false, evidence = priced.evidence;
      if (priced.ok) {
        const r = await reserveRide(flow, { shotLabel: "T6b-short-notice" });
        ok = !r.ok && /at least 120 minutes' notice/.test(r.error || "");
        detail = r.ok ? `BOOKED ${r.bookingId} for ${today} ${slot}` : `"${r.error}"`; evidence = [...evidence, ...r.evidence];
        if (r.ok) { const ride = { label: "T6b", bookingId: r.bookingId, customer: flow.customer.id, phone: flow.customer.phone, providerId: r.providerId, vehicle: "citroen_ec3", scheduledStart: priced.q.scheduledStart, total: priced.q.fareOptions.citroen_ec3.quotedTotal, fee: priced.q.fareOptions.citroen_ec3.bookingFee, paid: false }; save(ride); findingOnce("lead-time", { severity: "P1", area: "Pet Taxi booking rules", persona: "Customer", flow: "T6 short notice", title: "A Pet Taxi ride with less than 2 hours' notice was reserved", steps: `${today} ${slot} IST on /v2/taxi`, expected: "Refused: at least 120 minutes' notice", actual: `booked ${r.bookingId}`, evidence }); }
      }
      rec({ journey: "T6 validation", combo: `less than 2 h notice (${today} ${slot} IST, through the screen)`, result: ok ? "PASS" : "FAIL", detail, evidence });
    } else {
      const s = new Date(Math.ceil((Date.now() + 60 * 60_000) / 60_000) * 60_000), e = new Date(s.getTime() + 180 * 60_000);
      const r = await api(flow.context, "POST", "/api/uat-scheduling", { clientRequestId: `taxi40-lead-${flow.customer.phone}-${Date.now()}`, customerId: account.customerId, petIds: [dog.id], serviceCode: "pet_taxi", scheduledStart: s.toISOString(), scheduledEnd: e.toISOString(), occurrences: 1, serviceAddress: PICKUP, servicePincode: "560038" }, { timeout: 150_000 });
      const ok = r.status === 400 && r.body?.code === "below_minimum_lead_time";
      rec({ journey: "T6 validation", combo: "less than 2 h notice (reserve call the screen makes; no bookable time left today in the 06:00–19:00 list)", result: ok ? "PASS" : "FAIL", detail: `pickup ${s.toISOString()}: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 250)}`, evidence: [] });
      if (r.status === 200) findingOnce("lead-time", { severity: "P1", area: "Pet Taxi booking rules", persona: "Customer", flow: "T6 short notice", title: "A Pet Taxi reservation with 60 minutes' notice was accepted", steps: "POST /api/uat-scheduling pet_taxi 60 minutes ahead", expected: "400 below_minimum_lead_time", actual: JSON.stringify(r.body).slice(0, 300), evidence: [] });
    }
  } catch (e) { rec({ journey: "T6 validation", combo: "less than 2 h notice", result: "BLOCKED", detail: harness(e), evidence: [] }); }
  // (c) beyond the 180-day horizon
  try {
    await openTaxi(flow); await fillParty(flow, base);
    await flow.page.getByRole("button", { name: "Continue to trip details" }).click();
    await fillTrip(flow, { ...base, pickup: PICKUP, drop: DROP, date: isoDay(182), time: "10:00" }, { typeAddresses: false });
    const priced = await priceRide(flow, { shotLabel: "T6c-beyond-180" });
    let ok = false, detail = priced.ok ? "" : `quote refused: ${priced.error}`, evidence = priced.evidence;
    if (priced.ok) {
      const r = await reserveRide(flow, { shotLabel: "T6c-beyond-180" });
      ok = !r.ok && /up to 180 days ahead/.test(r.error || ""); detail = r.ok ? `BOOKED ${r.bookingId}` : `quote shown (${inr(priced.q.fareOptions.citroen_ec3.quotedTotal)}), reserve refused: "${r.error}"`; evidence = [...evidence, ...r.evidence];
      if (r.ok) { save({ bookingId: r.bookingId, customer: flow.customer.id, phone: flow.customer.phone, providerId: r.providerId, vehicle: "citroen_ec3", scheduledStart: priced.q.scheduledStart, total: priced.q.fareOptions.citroen_ec3.quotedTotal, fee: priced.q.fareOptions.citroen_ec3.bookingFee, paid: false }); findingOnce("horizon", { severity: "P1", area: "Pet Taxi booking rules", persona: "Customer", flow: "T6 horizon", title: "A Pet Taxi ride 182 days ahead was reserved", steps: `${isoDay(182)} 10:00 on /v2/taxi`, expected: "Refused: up to 180 days ahead", actual: `booked ${r.bookingId}`, evidence }); }
    } else ok = /180 days/.test(priced.error || "");
    rec({ journey: "T6 validation", combo: `beyond 180 days (${isoDay(182)})`, result: ok ? "PASS" : "FAIL", detail, evidence });
  } catch (e) { rec({ journey: "T6 validation", combo: "beyond 180 days", result: "BLOCKED", detail: harness(e), evidence: [] }); }
  // (d) pickup outside the service area (Mysuru, PIN 570001)
  try {
    await openTaxi(flow); await fillParty(flow, base);
    await flow.page.getByRole("button", { name: "Continue to trip details" }).click();
    await fillTrip(flow, { ...base, pickup: OUTSIDE, drop: DROP, date: isoDay(wrapDay(DAY + 5)), time: "10:00" }, { typeAddresses: false });
    const priced = await priceRide(flow, { shotLabel: "T6d-outside-area" });
    let ok = false, detail = priced.ok ? "" : `quote refused: ${priced.error}`, evidence = priced.evidence;
    if (priced.ok) {
      await chooseVehicle(flow, "xuv");
      const r = await reserveRide(flow, { pin: "570001", shotLabel: "T6d-outside-area" });
      ok = !r.ok && /outside|not currently serving|Zone not found|service area/i.test(r.error || "");
      detail = r.ok ? `BOOKED ${r.bookingId}` : `quoted ${priced.q.distanceKm} km (Citroën: "${priced.q.fareOptions.citroen_ec3.ineligibleReason || "eligible"}", XUV ${inr(priced.q.fareOptions.xuv.quotedTotal)}); with PIN 570001 the customer sees "${r.error}"`;
      evidence = [...evidence, ...r.evidence];
      if (r.ok) save({ bookingId: r.bookingId, customer: flow.customer.id, phone: flow.customer.phone, providerId: r.providerId, vehicle: "xuv", scheduledStart: priced.q.scheduledStart, total: priced.q.fareOptions.xuv.quotedTotal, fee: priced.q.fareOptions.xuv.bookingFee, paid: false });
      if (!r.ok && /Zone not found/.test(r.error || "")) findingOnce("zone-copy", { severity: "P3", area: "Pet Taxi UI copy", persona: "Customer", flow: "T6 outside the service area", title: "An out-of-area pickup PIN is refused with the technical text 'Zone not found for this pincode'", steps: "Pickup in Mysuru, PIN 570001, Reserve on /v2/taxi", expected: "e.g. 'PawSpace Pet Taxi does not serve PIN 570001 yet'", actual: r.error, evidence: r.evidence });
    }
    rec({ journey: "T6 validation", combo: "pickup outside the service area (Mysuru, PIN 570001)", result: ok ? "PASS" : "FAIL", detail, evidence });
  } catch (e) { rec({ journey: "T6 validation", combo: "pickup outside the service area", result: "BLOCKED", detail: harness(e), evidence: [] }); }
  // (e) the same Mysuru pickup with a Bengaluru PIN: the reserve call the screen makes (no booking is created; an
  // unbooked driver hold is released by the 5-minute reservation lease).
  try {
    const day = isoDay(wrapDay(DAY + 3)), s = new Date(istMs(day, "19:00")), e = new Date(s.getTime() + 180 * 60_000);
    const r = await api(flow.context, "POST", "/api/uat-scheduling", { clientRequestId: `taxi40-area-${flow.customer.phone}-${Date.now()}`, customerId: account.customerId, petIds: [dog.id], serviceCode: "pet_taxi", scheduledStart: s.toISOString(), scheduledEnd: e.toISOString(), occurrences: 1, serviceAddress: "Mysore Palace, Mysuru", servicePincode: "560038" }, { timeout: 150_000 });
    const accepted = r.status === 200 && r.body?.data?.status === "assigned";
    const inconclusive = r.status === 409 && /NO_SCHEDULE_AVAILABLE|SLOT_TAKEN/.test(JSON.stringify(r.body));
    rec({ journey: "T6 validation", combo: "Mysuru pickup typed with Bengaluru PIN 560038 (reserve call)", result: accepted ? "FAIL" : inconclusive ? "BLOCKED" : "PASS", detail: `HTTP ${r.status} ${JSON.stringify(accepted ? { status: r.body.data.status, provider: r.body.data.provider?.id, addressAuthority: r.body.data.addressAuthority } : r.body).slice(0, 350)}`, evidence: [] });
    if (accepted) findingOnce("area-by-pin", { severity: "P2", area: "Pet Taxi service area", persona: "Customer", flow: "T6 outside the service area", title: "A pickup 147 km outside Bengaluru is accepted when the customer types a Bengaluru PIN: the area check uses the typed PIN, not the quoted pickup", steps: "Quote 'Mysore Palace, Mysuru' → Koramangala (the quote geocodes the pickup to 12.31, 76.66), enter PIN 560038, Reserve (POST /api/uat-scheduling serviceAddress 'Mysore Palace, Mysuru', servicePincode 560038)", expected: "Refused: the pickup is outside the PawSpace Pet Taxi service area", actual: `HTTP 200 assigned driver ${r.body.data.provider?.id} in zone ${r.body.data.addressAuthority?.zoneId}; POST /api/taxi-ride-bookings has no area check, so the ride can be booked and paid`, evidence: [] });
  } catch (e) { rec({ journey: "T6 validation", combo: "Mysuru pickup with Bengaluru PIN", result: "BLOCKED", detail: harness(e), evidence: [] }); }
  finally { auditFlow(flow, "T6 validation"); await flow.close(); }
  })().catch(e => rec({ journey: "Customer sign-in", combo: "journey start", result: "BLOCKED", detail: harness(e), evidence: [] }));
}

async function laneB(browser) {
  // T2 — round trip + 90 min wait, 2 passengers 2 pets, on a Pixel 7 (video); fee paid from step 5.
  if (want("T2")) await (async () => { const flow = await customerFlow(browser, "B", "40-T2-roundtrip-mobile", { mobile: true, video: true });
  try {
    await ensurePets(flow);
    const o = { passengers: 2, luggage: 1, pets: ["TaxiDog", "TaxiCat"], trip: "round_trip", purpose: "regular", pickup: PICKUP, drop: DROP, returnDrop: PICKUP, waiting: 90, day: DAY, time: "09:30", vehicle: "citroen_ec3", fallback: true };
    const b = await bookRide(flow, o, "T2");
    if (!b.ok) { rec({ journey: "T2 round trip + 90 min wait (Pixel 7)", combo: "Citroën, reserve", result: b.stage === "quote" ? "FAIL" : "BLOCKED", detail: whyBlocked(b), evidence: b.evidence }); return; }
    const ride = rideRow("T2", o, b, flow), q = b.priced.q, exp = expectedFare("citroen_ec3", q);
    rec({ journey: "T2 round trip + 90 min wait (Pixel 7)", combo: `quote ${q.distanceKm} km out and back`, result: b.problems.length || exp.waiting !== 450 ? "FAIL" : "PASS", detail: `Citroën distance ${inr(q.fareOptions.citroen_ec3.distanceFare)} + waiting ${inr(q.fareOptions.citroen_ec3.waitingCharge)} = ${inr(ride.total)}, fee ${inr(ride.fee)}; XUV ${inr(q.fareOptions.xuv.quotedTotal)}; ${b.problems.join("; ")}`, evidence: b.priced.evidence });
    const s5 = step5Check(ride, b);
    rec({ journey: "T2 round trip + 90 min wait (Pixel 7)", combo: "reserve → step 5", result: s5.ok ? "PASS" : "FAIL", detail: `${ride.bookingId} ${b.date} ${b.time} driver ${ride.providerId} car ${ride.reservedVehicle?.label}; ${s5.excerpt}`, evidence: b.reserved.evidence });
    const pay = await payInFlow(flow, ride.bookingId, "T2");
    const captured = feeRecords("T2 round trip + 90 min wait (Pixel 7)", ride, pay);
    save(ride);
    if (captured) {
      const confirmedOnScreen = /TAXI CONFIRMED/.test(pay.step5 || "") && /Payment verified/.test(pay.step5 || "");
      rec({ journey: "T2 round trip + 90 min wait (Pixel 7)", combo: "step 5 after the fee", result: confirmedOnScreen ? "PASS" : "PARTIAL", detail: (pay.step5 || "").slice(Math.max(0, (pay.step5 || "").indexOf("Open saved ride")), Math.max(0, (pay.step5 || "").indexOf("Open saved ride")) + 400), evidence: pay.evidence.slice(-1) });
      await pay05(flow, "T2 round trip + 90 min wait (Pixel 7)", ride);
    }
  } catch (e) { rec({ journey: "T2 round trip + 90 min wait (Pixel 7)", combo: "Citroën, fee paid", result: "BLOCKED", detail: harness(e), evidence: [await flow.shot("T2-harness-error").catch(() => null)].filter(Boolean) }); }
  finally { auditFlow(flow, "T2 round trip (mobile)"); await flow.close(); }
  })().catch(e => rec({ journey: "Customer sign-in", combo: "journey start", result: "BLOCKED", detail: harness(e), evidence: [] }));

  // T4 — no passenger: the pet travels with the driver (+₹300); checkout opened, left unpaid.
  let t4 = null;
  if (want("T4")) await (async () => { const flow = await customerFlow(browser, "B", "40-T4-no-passenger");
  try {
    await ensurePets(flow);
    const o = { passengers: 0, luggage: 0, pets: ["TaxiDog"], trip: "one_way", purpose: "regular", pickup: PICKUP, drop: DROP, day: DAY, time: "16:30", vehicle: "citroen_ec3", fallback: true };
    const b = await bookRide(flow, o, "T4");
    const note = b.party?.handlerNote || "";
    if (!b.ok) { rec({ journey: "T4 no passenger (handler)", combo: "Citroën, reserve", result: b.stage === "quote" ? "FAIL" : "BLOCKED", detail: `${whyBlocked(b)}; note "${note}"`, evidence: b.evidence }); return; }
    const ride = t4 = rideRow("T4", o, b, flow), q = b.priced.q;
    const handlerOk = q.fareOptions.citroen_ec3.handlerCharge === 300 && q.fareOptions.xuv.handlerCharge === 300 && b.rows.handler === 300 && /₹300 handler charge/.test(note);
    rec({ journey: "T4 no passenger (handler)", combo: "quote with ₹300 handler", result: handlerOk && !b.problems.length ? "PASS" : "FAIL", detail: `note "${note}"; Citroën ${inr(q.fareOptions.citroen_ec3.distanceFare)} + handler ${inr(q.fareOptions.citroen_ec3.handlerCharge)} = ${inr(ride.total)}, fee ${inr(ride.fee)}; XUV ${inr(q.fareOptions.xuv.quotedTotal)}; ${b.problems.join("; ")}`, evidence: [b.evidence[0], ...b.priced.evidence] });
    const open = await openCheckoutOnly(flow, "T4");
    rec({ journey: "T4 no passenger (handler)", combo: "checkout opened from step 5, left unpaid", result: open.opened ? "PASS" : "FAIL", detail: `${ride.bookingId} ${b.date} ${b.time} driver ${ride.providerId}; "${open.buttonLabel}" opened Razorpay in ${open.ms} ms ${open.alerts?.join(" | ") || ""}`, evidence: [...b.reserved.evidence, ...open.evidence] });
    save(ride);
  } catch (e) { rec({ journey: "T4 no passenger (handler)", combo: "Citroën, checkout", result: "BLOCKED", detail: harness(e), evidence: [] }); }
  finally { auditFlow(flow, "T4 no passenger"); await flow.close(); }
  })().catch(e => rec({ journey: "Customer sign-in", combo: "journey start", result: "BLOCKED", detail: harness(e), evidence: [] }));

  // T7 — the customer tries to cancel T4's unpaid hold from the ride manage page.
  if (want("T7")) await (async () => { const flow = await customerFlow(browser, "B", "40-T7-cancel-unpaid");
  try {
    if (!t4?.bookingId) throw new Error("no unpaid T4 ride in this run");
    const before = await readManagePage(flow, t4.bookingId, "T7-before");
    const lifecycle = async () => { const r = await api(flow.context, "GET", `/api/taxi-lifecycle?scope=customer&bookingId=${encodeURIComponent(t4.bookingId)}`, undefined, { timeout: 150_000 }); const x = r.body?.data?.[0] || {}; return { http: r.status, status: x.status, trip: x.trip_status, reservedVehicle: x.reserved_vehicle_id || null, payment: x.payment_status }; };
    const held = await lifecycle();
    const page = flow.page, button = page.getByRole("button", { name: "Request cancellation review" });
    const offered = { cancelNow: await page.getByRole("button", { name: /^Cancel (ride|booking)/i }).count(), review: await button.count() };
    await page.locator("section").filter({ hasText: "Request cancellation" }).locator("input").first().fill("Master E2E: plans changed, releasing an unpaid test ride");
    const [resp] = await Promise.all([page.waitForResponse(r => r.url().includes("/api/taxi-finance") && r.request().method() === "POST", { timeout: 150_000 }).catch(() => null), button.click()]);
    let resp2 = resp;
    // A lost answer (local proxy) or a 5xx makes the customer press again; the request is idempotent.
    if (resp && resp.status() >= 500) [resp2] = await Promise.all([page.waitForResponse(r => r.url().includes("/api/taxi-finance") && r.request().method() === "POST", { timeout: 150_000 }).catch(() => null), button.click()]);
    await page.getByText(/Cancellation request/).first().waitFor({ timeout: 20_000 }).catch(() => {});
    await settle(page, 800);
    const after = await text(page), shot = await flow.shot("T7-after-request");
    const body = resp2 ? await resp2.json().catch(() => null) : null;
    const released = await lifecycle();
    const carReleased = !released.reservedVehicle || released.status === "cancelled";
    out.t7 = { bookingId: t4.bookingId, before: held, offered, response: { status: resp?.status() ?? null, body: body?.data ?? body }, after: released };
    rec({ journey: "T7 cancel an unpaid ride hold", combo: "manage page → cancellation", result: carReleased ? "PASS" : "PARTIAL", detail: `offered: ${offered.cancelNow ? "cancel" : "request-only review"}; POST /api/taxi-finance ${resp?.status() ?? "none"}${resp2 !== resp ? ` then ${resp2?.status() ?? "none"} on the second press` : ""} ${JSON.stringify(body?.data ?? body).slice(0, 200)}; customer sees "${(after.match(/Cancellation request[^|]*/) || [""])[0]}"; after: booking ${released.status}, payment ${released.payment}, car ${released.reservedVehicle || "released"}`, evidence: [...before.evidence, shot] });
    if (!carReleased) findingOnce("unpaid-hold", { severity: "P2", area: "Pet Taxi capacity", persona: "Customer", flow: "T7 cancel an unpaid ride", title: "An unpaid Pet Taxi hold cannot be released by the customer: the cancellation is only a Finance review request and the car and driver stay reserved", steps: `Reserve ${t4.bookingId}, leave the fee unpaid ("Vehicle and driver held for 3 hours. Pay the 50% booking fee…"), open /v2/taxi/manage, Request cancellation review`, expected: "An unpaid hold is cancelled at once (or expires) and its car and driver are released", actual: `taxi-finance → ${JSON.stringify(body?.data ?? body).slice(0, 160)}; the booking stays ${released.status} with car ${released.reservedVehicle}`, evidence: [shot] });
  } catch (e) { rec({ journey: "T7 cancel an unpaid ride hold", combo: "manage page", result: "BLOCKED", detail: harness(e), evidence: [] }); }
  finally { auditFlow(flow, "T7 cancel unpaid"); await flow.close(); }
  })().catch(e => rec({ journey: "Customer sign-in", combo: "journey start", result: "BLOCKED", detail: harness(e), evidence: [] }));

  // T8 — near-term ride for the partner-due suite: earliest slot ≥ 2 h 15 min ahead inside 06:00–19:00 IST.
  if (want("T8")) await (async () => { const flow = await customerFlow(browser, "B", "40-T8-near-term");
  try {
    await ensurePets(flow);
    const now = Date.now(), slots = [];
    for (let d = 0; d <= 2 && slots.length < 3; d++) for (const t of TIMES) if (istMs(isoDay(d), t) >= now + 135 * 60_000 && slots.length < 3) slots.push({ date: isoDay(d), time: t });
    const o = { passengers: 1, luggage: 0, pets: ["TaxiDog"], trip: "one_way", purpose: "regular", pickup: PICKUP, drop: DROP, days: slots.map(s => s.date), times: slots.map(s => s.time), vehicle: "citroen_ec3", fallback: true, nearTerm: true };
    const b = await bookRide(flow, o, "T8");
    if (!b.ok) { rec({ journey: "T8 near-term ride", combo: `earliest slot ${slots[0]?.date} ${slots[0]?.time}`, result: "BLOCKED", detail: whyBlocked(b), evidence: b.evidence }); return; }
    const ride = rideRow("T8", o, b, flow);
    const pay = await payFromBookingPage(flow, ride.bookingId, "T8");
    feeRecords("T8 near-term ride", ride, pay, b.reserved.evidence);
    if (ride.paid) await acceptNearTerm(browser, ride);
    save(ride);
    rec({ journey: "T8 near-term ride", combo: `${b.date} ${b.time} IST (lead ${Math.round((Date.parse(ride.scheduledStart) - now) / 60_000)} min)`, result: ride.paid && !b.problems.length ? "PASS" : "FAIL", detail: `${ride.bookingId} driver ${ride.providerId} car ${ride.reservedVehicle?.label}; total ${inr(ride.total)} fee ${inr(ride.fee)}; saved nearTerm for the partner-due suite`, evidence: b.reserved.evidence });
  } catch (e) { rec({ journey: "T8 near-term ride", combo: "earliest slot", result: "BLOCKED", detail: harness(e), evidence: [] }); }
  finally { auditFlow(flow, "T8 near-term"); await flow.close(); }
  })().catch(e => rec({ journey: "Customer sign-in", combo: "journey start", result: "BLOCKED", detail: harness(e), evidence: [] }));
}

// ------------------------------------------------------------------------------------------------ driver
/** One driver-workspace button (/driver?bookingId=…), returning the lifecycle answer and what the screen says. */
async function driverAct(page, name, expect) {
  const btn = page.getByRole("button", { name });
  const enabled = await btn.isEnabled().catch(() => false);
  if (!enabled) return { enabled, status: null, body: null, shown: "" };
  const [resp] = await Promise.all([page.waitForResponse(r => r.url().includes("/api/taxi-lifecycle") && r.request().method() === "POST", { timeout: 150_000 }).catch(() => null), btn.click()]);
  await page.getByText(expect).first().waitFor({ timeout: 45_000 }).catch(() => {});
  await settle(page, 600);
  const body = resp ? await resp.json().catch(() => null) : null;
  const shown = (await page.locator("[role=alert]").allInnerTexts().catch(() => [])).join(" | ") || ((await text(page)).match(expect) || [""])[0];
  return { enabled, status: resp?.status() ?? null, body, shown };
}
/** The near-term ride is accepted by its driver right after payment, so the partner-due suite finds it assigned. */
async function acceptNearTerm(browser, ride) {
  const journey = "T8 near-term ride";
  if (!hasAccessCode()) { rec({ journey, combo: "driver accepts after payment", result: "BLOCKED", detail: "harness: no UAT access code in this runner", evidence: [] }); return; }
  const flow = await newFlow(browser, "40-T8-driver-accept"); instrument(flow);
  try {
    await providerSession(flow.context, ride.providerId);
    await flow.page.goto(`${BASE}/driver?bookingId=${encodeURIComponent(ride.bookingId)}`, { waitUntil: "domcontentloaded" }); await dismissCookies(flow.page);
    await flow.page.getByRole("heading", { name: ride.bookingId }).waitFor({ timeout: 60_000 });
    const accept = await driverAct(flow.page, "Accept trip", /accept · assigned/);
    const shot = await flow.shot("T8-driver-accepted");
    ride.driverAccepted = accept.status === 200;
    rec({ journey, combo: `driver ${ride.providerId} accepts after payment`, result: accept.status === 200 ? "PASS" : "FAIL", detail: `HTTP ${accept.status} ${JSON.stringify(accept.body).slice(0, 200)}; on screen "${accept.shown}"`, evidence: [shot] });
  } catch (e) { rec({ journey, combo: "driver accepts after payment", result: "BLOCKED", detail: harness(e), evidence: [] }); }
  finally { auditFlow(flow, "T8 driver accept"); await flow.close(); }
}
async function driverPart(browser) {
  const paid = out.rides.filter(r => r.paid && !r.nearTerm && r.providerId);
  const t1 = paid.find(r => r.label === "T1") || paid[0];
  if (!hasAccessCode()) { rec({ journey: "Driver: partner app + early pickup (PARTNER-03)", combo: t1?.bookingId || "no paid ride", result: "BLOCKED", detail: "harness: no UAT access code in this runner", evidence: [] }); return; }
  if (!t1) { rec({ journey: "Driver: partner app + early pickup (PARTNER-03)", combo: "no paid far-future ride", result: "BLOCKED", detail: "harness: no paid ride from the customer journeys", evidence: [] }); return; }
  const flow = await newFlow(browser, "40-driver"); instrument(flow);
  const { page } = flow;
  try {
    await providerSession(flow.context, t1.providerId);
    await page.goto(`${BASE}/partner-app`, { waitUntil: "domcontentloaded" }); await dismissCookies(page);
    await page.getByText(/Your service workspaces|No assigned jobs|Your assigned work/).first().waitFor({ timeout: 60_000 }).catch(() => {});
    await settle(page, 2500);
    const listed = {};
    for (const r of paid.filter(x => x.providerId === t1.providerId)) listed[r.bookingId] = await page.locator(`a[href*="${encodeURIComponent(r.bookingId)}"]`).count();
    const home = await flow.shot("driver-partner-app");
    const feed = await api(flow.context, "GET", `/api/partner-job-feed?providerId=${encodeURIComponent(t1.providerId)}`, undefined, { timeout: 60_000 });
    const feedIds = JSON.stringify(feed.body?.data || {});
    out.driver.listed = listed; out.driver.feedStatus = feed.status;
    const allListed = Object.values(listed).every(n => n > 0);
    rec({ journey: "Driver: partner app lists the rides", combo: `${t1.providerId}: ${Object.keys(listed).join(", ")}`, result: allListed ? "PASS" : "FAIL", detail: `links on /partner-app ${JSON.stringify(listed)}; /api/partner-job-feed ${feed.status} contains ${Object.keys(listed).filter(id => feedIds.includes(id)).length}/${Object.keys(listed).length}`, evidence: [home] });
    if (!allListed) findingOnce("partner-feed", { severity: "P1", area: "Partner app", persona: "Driver", flow: "Partner app home", title: "A paid Pet Taxi ride assigned to the driver is missing from the partner app", steps: `providerSession ${t1.providerId}, open /partner-app`, expected: "Every assigned ride under 'Your service workspaces' with an 'Open pet taxi job' link", actual: JSON.stringify(listed), evidence: [home] });
    // Accept T1 through the driver workspace the partner app links to.
    const link = page.locator(`a[href*="${encodeURIComponent(t1.bookingId)}"]`).first();
    if (await link.count()) await link.click(); else await page.goto(`${BASE}/driver?bookingId=${encodeURIComponent(t1.bookingId)}`);
    await page.getByRole("heading", { name: t1.bookingId }).waitFor({ timeout: 60_000 });
    const act = (name, expect) => driverAct(page, name, expect);
    const accept = await act("Accept trip", /accept · assigned/);
    const s1 = await flow.shot("driver-accepted");
    const assign = await act(/Confirm reserved fleet car|Assign UAT vehicle/, /assign vehicle · vehicle assigned/);
    const pickup = await act(/Confirm owner pickup/, /30 minutes before the booked pickup/);
    const s2 = await flow.shot("driver-early-pickup-refused");
    out.driver.lifecycle = { accept: { status: accept.status, shown: accept.shown }, assign: { status: assign.status, shown: assign.shown }, pickup: { status: pickup.status, body: pickup.body, shown: pickup.shown } };
    rec({ journey: "Driver: accepts the ride in the driver workspace", combo: t1.bookingId, result: accept.status === 200 && assign.status === 200 ? "PASS" : "FAIL", detail: JSON.stringify(out.driver.lifecycle).slice(0, 500), evidence: [s1] });
    const refused = pickup.status === 409 && pickup.body?.code === "taxi_pickup_too_early" && /30 minutes before the booked pickup time/.test(pickup.shown);
    rec({ journey: "Driver: early pickup refused on screen (PARTNER-03)", combo: `${t1.bookingId}, pickup ${t1.scheduledStart}`, result: refused ? "PASS" : (assign.status === 200 ? "FAIL" : "BLOCKED"), detail: `HTTP ${pickup.status} ${JSON.stringify(pickup.body).slice(0, 200)}; on screen "${pickup.shown}"`, evidence: [s2] });
    if (!refused && pickup.status === 200) findingOnce("early-pickup", { severity: "P1", area: "Pet Taxi driver lifecycle", persona: "Driver", flow: "Pickup handover", title: "A Pet Taxi pickup weeks ahead can be confirmed now", steps: `Accept, confirm car, confirm pickup for ${t1.bookingId}`, expected: "409 taxi_pickup_too_early with a clear message", actual: JSON.stringify(pickup.body).slice(0, 300), evidence: [s2] });
    // Earnings.
    await page.goto(`${BASE}/partner-app`, { waitUntil: "domcontentloaded" }); await settle(page, 2500);
    await page.getByRole("button", { name: /Earnings/ }).first().click();
    await page.getByRole("heading", { name: "Earnings" }).waitFor({ timeout: 45_000 }).catch(() => {});
    await settle(page, 3000);
    const earn = await text(page), s3 = await flow.shot("driver-earnings");
    const alerts = (await page.locator("[role=alert]").allInnerTexts().catch(() => [])).join(" | ");
    const sane = /Earnings/.test(earn) && /Settlement-controlled earnings/.test(earn) && !/NaN|undefined|\[object/.test(earn) && !alerts;
    rec({ journey: "Driver: earnings view", combo: t1.providerId, result: sane ? "PASS" : "FAIL", detail: `${alerts ? `alert "${alerts}"; ` : ""}${earn.slice(earn.indexOf("Earnings"), earn.indexOf("Earnings") + 400)}`, evidence: [s3] });
  } catch (e) { rec({ journey: "Driver: partner app + early pickup (PARTNER-03)", combo: t1.bookingId, result: "BLOCKED", detail: harness(e), evidence: [await flow.shot("driver-harness-error").catch(() => null)].filter(Boolean) }); }
  finally { auditFlow(flow, "Driver"); await flow.close(); }
}

// ------------------------------------------------------------------------------------------------ staff
async function staffPart(browser) {
  const rides = out.rides.filter(r => r.bookingId);
  if (!hasAccessCode()) { rec({ journey: "Staff: Booking Command Center + Taxi finance", combo: `${rides.length} rides`, result: "BLOCKED", detail: "harness: no UAT access code in this runner", evidence: [] }); return; }
  const flow = await newFlow(browser, "40-staff"); instrument(flow);
  const { page } = flow;
  try {
    await staffSession(flow.context, "founder@pawspace.in");
    for (const ride of rides) {
      try {
        const r = await api(flow.context, "GET", `/api/booking-command-center?q=${encodeURIComponent(ride.bookingId)}`, undefined, { timeout: 150_000 });
        const row = (r.body?.bookings || []).find(x => x.id === ride.bookingId);
        const expected = ride.paid ? "captured" : "created";
        let evidence = [];
        if (["T1", "T4"].includes(ride.label)) {
          await page.goto(`${BASE}/team/operations/bookings?bookingId=${encodeURIComponent(ride.bookingId)}`, { waitUntil: "domcontentloaded" }); await dismissCookies(page);
          await page.locator("button").filter({ hasText: ride.bookingId }).first().waitFor({ timeout: 60_000 }).catch(() => {});
          await settle(page, 1500);
          evidence = [await flow.shot(`bcc-${ride.label}`)];
        }
        const rowText = evidence.length ? (await page.locator("button").filter({ hasText: ride.bookingId }).first().innerText().catch(() => "")).replace(/\s+/g, " ") : "";
        const ok = row && String(row.payment_status) === expected && (!evidence.length || new RegExp(expected, "i").test(rowText));
        rec({ journey: "Staff: Booking Command Center", combo: `${ride.label} ${ride.bookingId}`, result: ok ? "PASS" : "FAIL", detail: `API ${r.status}: ${row ? JSON.stringify({ status: row.status, payment_status: row.payment_status, payment_mode: row.payment_mode, payment_amount: row.payment_amount, amount_due_now: row.amount_due_now, provider: row.provider_id }) : "not found"}${rowText ? `; row "${rowText.slice(0, 200)}"` : ""}; expected payment ${expected}`, evidence });
        if (!ok && row) findingOnce(`bcc-${ride.label}`, { severity: "P2", area: "Booking Command Center", persona: "Operations", flow: "Find a Pet Taxi ride", title: `The Command Center shows the wrong payment state for a Pet Taxi ride (${ride.label})`, steps: `Search ${ride.bookingId}`, expected: `payment ${expected}`, actual: `payment ${row.payment_status}`, evidence });
      } catch (e) { rec({ journey: "Staff: Booking Command Center", combo: `${ride.label} ${ride.bookingId}`, result: "BLOCKED", detail: harness(e), evidence: [] }); }
    }
    const t1 = rides.find(r => r.label === "T1" && r.paid) || rides.find(r => r.paid);
    if (t1) {
      const api1 = await api(flow.context, "GET", `/api/taxi-finance?bookingId=${encodeURIComponent(t1.bookingId)}`, undefined, { timeout: 150_000 });
      await page.goto(`${BASE}/team/finance/taxi?bookingId=${encodeURIComponent(t1.bookingId)}`, { waitUntil: "domcontentloaded" }); await dismissCookies(page);
      await page.getByRole("heading", { name: "Taxi payment & reconciliation" }).waitFor({ timeout: 60_000 }).catch(() => {});
      await page.getByText("Booking value").first().waitFor({ timeout: 60_000 }).catch(() => {});
      await settle(page, 1500);
      const t = await text(page), shot = await flow.shot("taxi-finance-workspace");
      const value = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(t1.total);
      const ok = api1.status === 200 && /Taxi payment & reconciliation/.test(t) && t.includes(`Booking value | ${value}`) && !/Unable to load|role=alert/.test(t);
      rec({ journey: "Staff: Taxi finance workspace (/team/finance/taxi)", combo: `founder@pawspace.in, ${t1.bookingId}`, result: ok ? "PASS" : "FAIL", detail: `API ${api1.status} booking ${api1.body?.data?.booking?.status} payment ${api1.body?.data?.booking?.payment_status}; page "${t.slice(t.indexOf("Taxi payment"), t.indexOf("Taxi payment") + 300)}" (Finance accounts such as anjali.finance33 need MFA on staging, so the founder account is used)`, evidence: [shot] });
    }
  } catch (e) { rec({ journey: "Staff: Booking Command Center + Taxi finance", combo: "founder", result: "BLOCKED", detail: harness(e), evidence: [] }); }
  finally { auditFlow(flow, "Staff"); await flow.close(); }
}

// ------------------------------------------------------------------------------------------------ D1 read-backs
async function d1Part() {
  const probe = await d1("SELECT 1 AS ok");
  if (probe?.skipped) { rec({ journey: "D1 read-backs", combo: `${out.rides.length} rides`, result: "SKIPPED", detail: "harness: Cloudflare D1 read credentials not configured in this runner (not checked)", evidence: [] }); return; }
  for (const ride of out.rides.filter(r => r.bookingId)) {
    const id = ride.bookingId;
    const rows = {
      booking: await d1("SELECT status, provider_id, total_amount, package_code FROM canonical_bookings WHERE id=?", [id]),
      payment: await d1("SELECT id, status, amount, amount_due_now, mode FROM booking_payments WHERE booking_id=?", [id]),
      schedule: await d1("SELECT total_amount, booking_fee_amount, balance_amount, status, booking_fee_paid_at, booking_fee_reference FROM taxi_payment_schedules WHERE booking_id=?", [id]),
      events: await d1("SELECT event_type, processing_status, amount_subunits, signature_verified, json_extract(CASE WHEN json_valid(detail_json) THEN detail_json ELSE '{}' END,'$.captureAuthority') AS authority FROM payment_gateway_events WHERE booking_id=?", [id]),
      reconciliation: await d1("SELECT expected_amount, captured_amount, refunded_amount, gateway_status, reconciliation_status, variance_amount FROM payment_reconciliation_records WHERE booking_id=?", [id]),
      ledger: await d1("SELECT c.event, c.amount, c.verification_status FROM collection_ledger_postings c JOIN booking_payments p ON p.id=c.payment_id WHERE p.booking_id=?", [id]),
      lifecycle: await d1("SELECT event_type, actor_id FROM booking_lifecycle_events WHERE booking_id=? ORDER BY occurred_at", [id]),
      trip: await d1("SELECT status, provider_id, vehicle_id, synthetic_distance_km FROM taxi_trips WHERE booking_id=?", [id]),
      ride: await d1("SELECT vehicle_class, passenger_count, pet_count, luggage_count, trip_type, ride_purpose, waiting_minutes, distance_km, initial_total, booking_fee_amount FROM taxi_ride_booking_details WHERE booking_id=?", [id]),
      fleet: await d1("SELECT r.status, r.vehicle_id, v.vehicle_class, v.label FROM taxi_fleet_reservations r LEFT JOIN taxi_fleet_vehicles v ON v.id=r.vehicle_id WHERE r.booking_id=?", [id]),
      intents: await d1("SELECT state, amount_paise, gateway_order_id FROM payment_intents WHERE booking_id=?", [id]),
    };
    const orders = Array.isArray(rows.intents) ? rows.intents.map(x => x.gateway_order_id).filter(Boolean) : [];
    rows.webhooks = orders.length ? await d1(`SELECT event_type, processing_status, COUNT(*) AS n FROM gateway_webhook_events WHERE ${orders.map(() => "raw_payload LIKE ?").join(" OR ")} GROUP BY 1,2`, orders.map(o => `%${o}%`)) : [];
    out.d1[id] = rows;
    const errs = Object.entries(rows).filter(([, v]) => !Array.isArray(v)).map(([k, v]) => `${k}: ${JSON.stringify(v).slice(0, 80)}`);
    if (errs.length) { rec({ journey: "D1 read-backs", combo: `${ride.label} ${id}`, result: "BLOCKED", detail: `harness: ${errs.join("; ")}`, evidence: [] }); continue; }
    const f = x => x[0] || {}, cents = v => Math.round(Number(v) * 100);
    const problems = [];
    const r = f(rows.ride), fl = f(rows.fleet), sch = f(rows.schedule), rc = f(rows.reconciliation), pmt = f(rows.payment);
    if (cents(sch.booking_fee_amount) !== cents(ride.fee) || cents(sch.balance_amount) !== cents(ride.balance) || cents(sch.total_amount) !== cents(ride.total)) problems.push(`schedule ${JSON.stringify(sch)}`);
    if (r.vehicle_class !== ride.vehicle || Number(r.passenger_count) !== ride.q.passengerCount || Number(r.pet_count) !== ride.q.petCount || Number(r.luggage_count) !== ride.q.luggageCount || r.trip_type !== ride.q.tripType || r.ride_purpose !== ride.q.ridePurpose || Number(r.waiting_minutes) !== ride.q.waitingMinutes) problems.push(`ride details ${JSON.stringify(r)}`);
    if (!["confirmed", "in_progress"].includes(String(fl.status)) || fl.vehicle_class !== ride.vehicle) problems.push(`fleet ${JSON.stringify(fl)}`);
    const types = rows.lifecycle.map(x => x.event_type);
    if (!types.includes("taxi_booking_fee_pending")) problems.push("no taxi_booking_fee_pending event");
    let money = [];
    if (ride.paid) {
      const captures = rows.events.filter(e => e.event_type === "payment.captured" && e.processing_status === "processed");
      const captured = cents(rc.captured_amount), posted = rows.ledger.filter(x => x.event === "online_payment_captured").reduce((s, x) => s + cents(x.amount), 0);
      if (pmt.status !== "captured") problems.push(`payment ${pmt.status}`);
      if (!["pending_balance"].includes(String(sch.status)) || !sch.booking_fee_reference) problems.push(`schedule status ${sch.status}`);
      if (!captures.length || captures.some(e => Number(e.amount_subunits) !== cents(ride.fee))) problems.push(`gateway events ${JSON.stringify(rows.events).slice(0, 160)}`);
      if (captured !== cents(ride.fee)) money.push(`reconciliation captured ${rc.captured_amount} vs fee ${ride.fee}`);
      if (posted !== captured) money.push(`collection ledger ${posted / 100} vs captured ${captured / 100}`);
      if (rc.gateway_status !== "captured") problems.push(`reconciliation ${rc.gateway_status}/${rc.reconciliation_status}`);
      if (!types.includes("taxi_booking_confirmed_after_booking_fee")) problems.push("no taxi_booking_confirmed_after_booking_fee event");
      if (!["confirmed", "assigned"].includes(String(f(rows.booking).status))) problems.push(`booking ${f(rows.booking).status}`);
      if (rows.webhooks.some(w => ["RECEIVED", "PROCESSING", "FAILED"].includes(String(w.processing_status)))) problems.push(`webhooks ${JSON.stringify(rows.webhooks)}`);
    } else {
      if (pmt.status !== "created" || sch.status !== "booking_fee_pending" || f(rows.booking).status !== "payment_pending") problems.push(`unpaid state ${JSON.stringify({ payment: pmt.status, schedule: sch.status, booking: f(rows.booking).status })}`);
      if (rows.ledger.length || rows.events.some(e => e.event_type === "payment.captured")) money.push(`money posted for an unpaid ride: ${JSON.stringify(rows.ledger)}`);
    }
    const all = [...money, ...problems];
    rec({ journey: "D1 read-backs", combo: `${ride.label} ${id} (${ride.paid ? "fee paid" : "unpaid"})`, result: all.length ? "FAIL" : "PASS", detail: all.length ? all.join("; ").slice(0, 500) : `payment ${pmt.status}; schedule ${sch.status} fee ${sch.booking_fee_amount} balance ${sch.balance_amount}; reconciliation ${rc.captured_amount ?? "-"} ${rc.reconciliation_status ?? ""}; ledger ${rows.ledger.map(x => x.amount).join("+") || "none"}; events ${types.join(",")}; fleet ${fl.status} ${fl.label}; webhooks ${JSON.stringify(rows.webhooks)}`, evidence: [] });
    if (money.length) findingOnce(`d1-money-${id}`, { severity: "P0", area: "Payments", persona: "Finance", flow: `${ride.label} Pet Taxi booking fee`, title: `Pet Taxi money in the books does not match the captured booking fee (${ride.label})`, steps: `Pay the fee for ${id}, read staging D1`, expected: `captured = ledger = ${ride.fee}`, actual: money.join("; "), evidence: [] });
    else if (problems.length) findingOnce(`d1-state-${id}`, { severity: "P1", area: "Pet Taxi records", persona: "Finance", flow: `${ride.label} Pet Taxi`, title: `Pet Taxi ride records are inconsistent after the booking fee (${ride.label})`, steps: `Book ${id}${ride.paid ? " and pay the fee" : ""}, read staging D1`, expected: "payment captured, schedule pending_balance, events processed, fleet car reserved, lifecycle events recorded", actual: problems.join("; ").slice(0, 400), evidence: [] });
  }
  // Context for T7 and the driver-assignment refusal: unpaid holds older than 3 hours that still hold a car, and
  // which drivers are allowed to drive the fleet.
  out.d1.unpaidHolds = await d1("SELECT COUNT(*) AS n, MIN(b.created_at) AS oldest FROM canonical_bookings b JOIN taxi_fleet_reservations f ON f.booking_id=b.id AND f.status IN ('held','confirmed') WHERE b.service_code='pet_taxi' AND b.status='payment_pending' AND b.created_at < ?", [Date.now() - 3 * 3_600_000]);
  out.d1.fleetEligibility = await d1("SELECT provider_id, COUNT(*) AS vehicles FROM taxi_driver_vehicle_eligibility WHERE status='active' GROUP BY provider_id");
  out.d1.taxiDrivers = await d1("SELECT id, provider_model, live, status FROM provider_capacity_profiles WHERE services_json LIKE '%pet_taxi%'");
  const holds = Array.isArray(out.d1.unpaidHolds) ? out.d1.unpaidHolds[0] : null;
  rec({ journey: "D1 read-backs", combo: "unpaid Pet Taxi holds older than 3 hours", result: holds ? (Number(holds.n) ? "FAIL" : "PASS") : "BLOCKED", detail: JSON.stringify({ unpaidHolds: out.d1.unpaidHolds, fleetEligibility: out.d1.fleetEligibility, taxiDrivers: out.d1.taxiDrivers }).slice(0, 600), evidence: [] });
  if (holds && Number(holds.n)) findingOnce("unpaid-hold", { severity: "P2", area: "Pet Taxi capacity", persona: "Customer", flow: "Unpaid ride holds", title: `${holds.n} unpaid Pet Taxi rides still hold a fleet car more than 3 hours after booking (the flow says the car is "held for 3 hours")`, steps: "Read canonical_bookings payment_pending pet_taxi joined to taxi_fleet_reservations held/confirmed", expected: "Unpaid holds expire and release the car and driver", actual: `${holds.n} holds, oldest created ${new Date(Number(holds.oldest)).toISOString()}`, evidence: [] });
}

// ------------------------------------------------------------------------------------------------ main
const browser = await launch();
try {
  log(`run ${RUN}: rides on ${isoDay(DAY)} (day ${DAY}); customers ${CUSTOMERS.A.phone} / ${CUSTOMERS.B.phone}`);
  await Promise.all([
    laneA(browser).catch(e => rec({ journey: "Customer lane A (T1, T3, T5, T6)", combo: "lane", result: "BLOCKED", detail: harness(e), evidence: [] })),
    laneB(browser).catch(e => rec({ journey: "Customer lane B (T2, T4, T7, T8)", combo: "lane", result: "BLOCKED", detail: harness(e), evidence: [] })),
  ]);
  await driverPart(browser).catch(e => rec({ journey: "Driver", combo: "part", result: "BLOCKED", detail: harness(e), evidence: [] }));
  await staffPart(browser).catch(e => rec({ journey: "Staff", combo: "part", result: "BLOCKED", detail: harness(e), evidence: [] }));
  await d1Part().catch(e => rec({ journey: "D1 read-backs", combo: "part", result: "BLOCKED", detail: harness(e), evidence: [] }));
  // Speed of the two slow steps a customer waits on (the local egress proxy's 30 s cuts are left out).
  const quotes = out.perf.quotes.filter(x => x.status === 201).map(x => x.ms).sort((a, b) => a - b);
  const reserves = out.perf.reserves.filter(x => x.outcome === "booked" && !x.harness).map(x => x.ms).sort((a, b) => a - b);
  const median = a => a.length ? a[Math.floor(a.length / 2)] : null;
  out.perf.summary = { quoteMedianMs: median(quotes), quoteMaxMs: quotes.at(-1) ?? null, reserveMedianMs: median(reserves), reserveMaxMs: reserves.at(-1) ?? null, accountLoadRetries: out.perf.accountRetries || 0, n: { quotes: quotes.length, reserves: reserves.length } };
  rec({ journey: "Pet Taxi speed", combo: "route quote and reservation", result: !quotes.length && !reserves.length ? "SKIPPED" : (median(reserves) ?? 0) > 20_000 || (median(quotes) ?? 0) > 15_000 ? "FAIL" : "PASS", detail: JSON.stringify({ ...out.perf.summary, reserves: out.perf.reserves.slice(0, 12) }).slice(0, 600), evidence: [] });
  if ((median(reserves) ?? 0) > 20_000 || (median(quotes) ?? 0) > 15_000) findingOnce("speed", { severity: "P2", area: "Pet Taxi performance", persona: "Customer", flow: "Calculate fares / Reserve", title: `Pet Taxi customers wait ${Math.round((median(quotes) ?? 0) / 1000)} s for a fare and ${Math.round((median(reserves) ?? 0) / 1000)} s to reserve (medians on staging)`, steps: "Calculate Citroën & XUV fares, then Reserve on /v2/taxi", expected: "A few seconds each", actual: JSON.stringify(out.perf.summary), evidence: [] });
} finally {
  out.durationS = Math.round((Date.now() - started) / 1000);
  writeJson("taxi-journeys.json", out);
  log(`finished in ${out.durationS}s`);
  await browser.close();
}
