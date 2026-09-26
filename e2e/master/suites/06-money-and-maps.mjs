// Money + Maps paths on staging, driven through the same APIs the V2 screens call and paid in the REAL Razorpay TEST
// checkout from the customer booking page:
//  A) Boarding 5 nights with the 50/50 split — pay the deposit, then check what the customer is asked to pay next.
//  B) Pet Taxi fares from real Google Routes for several combinations, checked against lib/taxi-business-rules.ts.
//  C) One Pet Taxi ride reserved and its 50% booking fee paid.
import {
  BASE, launch, newFlow, settle, api, customerSession, otpCustomerSession, runPhone, dismissCookies, d1, isoDay,
  payRazorpayTestNetbanking, record, finding, saveBooking, writeJson, recordWebhookCheck,
} from "../lib.mjs";

const SUITE = "06-money-and-maps";
const out = { suite: SUITE, steps: [], taxi: [] };
const step = (name, ok, detail) => { out.steps.push({ name, ok, detail }); console.log(`${ok ? "ok  " : "FAIL"} ${name} ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 300)}`); };
const istIso = (day, hhmm) => new Date(`${day}T${hhmm}:00+05:30`).toISOString();
// Mirror of lib/taxi-business-rules.ts calculateTaxiFare (kept in plain JS so the runner needs no TypeScript).
const VEH = { citroen_ec3: { base: 500, perKm: 35, wait: 150, airport: 2300 }, xuv: { base: 600, perKm: 40, wait: 200, airport: 2600 } };
const round2 = v => Math.round((v + Number.EPSILON) * 100) / 100;
function expectedFare(v, q) {
  const veh = VEH[v], km = round2(Number(q.distanceKm));
  const distanceFare = q.ridePurpose === "airport" ? veh.airport : round2(veh.base + Math.max(0, km - 5) * veh.perKm);
  const waiting = q.tripType === "round_trip" ? q.waitingMinutes / 30 * veh.wait : 0;
  const handler = q.passengerCount === 0 ? 300 : 0;
  const total = round2(distanceFare + waiting + handler);
  return { total, fee: round2(total / 2) };
}

async function payFromBookingPage(flow, bookingId) {
  const { page, context } = flow;
  await page.goto(`${BASE}/v2/booking?bookingId=${encodeURIComponent(bookingId)}`); await settle(page, 2500); await dismissCookies(page);
  const before = await flow.shot(`booking-${bookingId}-before-payment`);
  const pay = page.getByRole("button", { name: /Pay securely/i }).first();
  if (!(await pay.isVisible().catch(() => false))) return { opened: false, reason: "no Pay securely button", evidence: [before] };
  await pay.click();
  const t0 = Date.now(); let opened = false, alerts = [];
  while (Date.now() - t0 < 60_000) {
    await page.waitForTimeout(1000);
    opened = page.frames().some(f => f !== page.mainFrame() && /razorpay/i.test(f.url()));
    alerts = (await page.locator("[role=alert]").allInnerTexts().catch(() => [])).filter(t => t.trim());
    if (opened || alerts.length) break;
  }
  if (!opened) return { opened, reason: alerts.join(" | ") || "Razorpay did not open in 60 s", evidence: [before, await flow.shot(`booking-${bookingId}-checkout-not-opened`)] };
  const paid = await payRazorpayTestNetbanking(page);
  let status = null;
  for (let i = 0; i < 24 && status?.paymentStatus !== "captured"; i++) {
    await page.waitForTimeout(5000);
    const s = await api(context, "POST", "/api/customer-checkout", { action: "status", bookingId });
    status = s.body?.data?.confirmation || s.body?.data || null;
  }
  await page.goto(`${BASE}/v2/booking?bookingId=${encodeURIComponent(bookingId)}`); await settle(page, 2500);
  const after = await flow.shot(`booking-${bookingId}-after-payment`);
  const pageText = (await page.locator("main").innerText().catch(() => "")).replace(/\s+/g, " ");
  return { opened, paid, status, checkoutOpenMs: null, evidence: [before, after], pageText };
}

const browser = await launch();
const flow = await newFlow(browser, SUITE, { video: true });
const { context } = flow;
try {
  const who = process.env.MASTER_CUSTOMER_MODE === "otp" ? await otpCustomerSession(context, runPhone(6), "Master E2E Money") : await customerSession(context, "customer-b");
  step("customer session", Boolean(who?.customerId), who?.customerId);
  let account = (await api(context, "GET", "/api/customer-account")).body?.data;
  for (const [name, species] of [["MoneyDog", "dog"], ["MoneyCat", "cat"]]) {
    if (!account?.pets?.some(p => p.name === name)) {
      const r = await api(context, "POST", "/api/customer-account", { customerId: account.customerId, action: "upsert_pet", idempotencyKey: `money-pet-${name}-${runPhone(6)}`, pet: { name, species, breed: species === "dog" ? "Indie" : "Persian", vaccinationStatus: "verified" } });
      step(`add ${name}`, r.status < 300, `HTTP ${r.status}`);
    }
  }
  if (!account?.addresses?.some(a => a.postalCode === "560038")) {
    const r = await api(context, "POST", "/api/customer-account", { customerId: account.customerId, action: "upsert_address", idempotencyKey: `money-address-${runPhone(6)}`, address: { label: "Home", line1: "100 Feet Road, HAL 2nd Stage, Indiranagar", area: "Indiranagar", city: "Bengaluru", postalCode: "560038", isDefault: true } });
    step("add Indiranagar address", r.status < 300, `HTTP ${r.status}`);
  }
  account = (await api(context, "GET", "/api/customer-account")).body?.data;
  const dog = account.pets.find(p => p.name === "MoneyDog");
  const zone = (await api(context, "GET", "/api/service-zone?pincode=560038")).body?.data;
  const cityId = zone?.assignment?.cityId, zoneId = zone?.assignment?.zoneId;

  // ---------- A) Boarding 5 nights, 50/50 split ----------
  try {
    const startDay = isoDay(137), endDay = isoDay(142), scheduledStart = istIso(startDay, "10:00"), scheduledEnd = istIso(endDay, "10:00");
    const hosts = (await api(context, "GET", `/api/boarding-commercial?${new URLSearchParams({ cityId, zoneId, scheduledStart, scheduledEnd, petCount: "1", species: "dog" })}`)).body?.data?.hosts || [];
    const quote = (await api(context, "POST", "/api/boarding-commercial", { packageCode: "boarding-24h", petCount: 1, cityId, zoneId, scheduledStart, scheduledEnd, paymentMode: "split_50_50", providerId: hosts[0]?.providerId })).body?.data;
    step("5-night split quote", quote?.totalAmount === 3495 && quote?.amountDueNow === 1747.5, `total ₹${quote?.totalAmount} due now ₹${quote?.amountDueNow} (rule ₹3,495 / ₹1,747.50)`);
    const t0 = Date.now();
    const reserve = await api(context, "POST", "/api/uat-scheduling", { clientRequestId: `money-split-${runPhone(6)}-${Date.now()}`, customerId: account.customerId, petIds: [dog.id], serviceCode: "boarding", serviceAddress: "100 Feet Road, HAL 2nd Stage, Indiranagar, Bengaluru, 560038", servicePincode: "560038", cityId, zoneId, scheduledStart, scheduledEnd, careMode: "overnight", preferredProviderId: hosts[0]?.providerId }, { timeout: 150_000 });
    step("split reservation", reserve.status === 200, `HTTP ${reserve.status} in ${Date.now() - t0} ms`);
    const created = await api(context, "POST", "/api/canonical-bookings", {
      idempotencyKey: `money-split-${reserve.body?.data?.groupId}`, scheduleGroupId: reserve.body?.data?.groupId,
      customer: { id: account.customerId, name: account.name, primaryPhone: account.primaryPhone },
      pets: [{ sourceId: dog.sourceId ?? dog.id, name: dog.name, species: "dog", vaccinationStatus: dog.vaccinationStatus }],
      cityId, zoneId, serviceCode: "boarding", packageCode: quote.packageCode, packageName: quote.packageName, scheduledStart, scheduledEnd,
      provider: reserve.body?.data?.provider, totalAmount: quote.totalAmount, amountDueNow: quote.amountDueNow,
      payment: { method: "upi", mode: "split_50_50", status: "created", detail: "Awaiting verified Razorpay payment" }, pricing: { discount: 0, boardingQuoteId: quote.quoteId },
    });
    const bookingId = created.body?.data?.bookingId;
    step("split booking created", Boolean(bookingId), `HTTP ${created.status} ${bookingId || JSON.stringify(created.body).slice(0, 200)}`);
    if (bookingId) {
      const stay = (await api(context, "GET", `/api/boarding-stays?scope=customer&bookingId=${encodeURIComponent(bookingId)}`)).body?.data?.[0];
      if (stay) await api(context, "POST", "/api/boarding-stays", { stayId: stay.id, action: "submit_care_plan", idempotencyKey: `money-care-${bookingId}`, carePlan: { vet: "Dr. Rao, 9000000001", emergencyContact: "Asha, 9000000002", feeding: "Twice a day" } });
      const r = await payFromBookingPage(flow, bookingId);
      const captured = r.status?.paymentStatus === "captured";
      const stillAsksDeposit = /Due now\s*₹1,747\.50/.test(r.pageText || "") && /Pay securely/.test(r.pageText || "");
      step("deposit paid in Razorpay TEST", captured, JSON.stringify({ opened: r.opened, paid: r.paid, status: r.status && { bookingStatus: r.status.bookingStatus, paymentStatus: r.status.paymentStatus } }));
      record({ suite: SUITE, journey: "Boarding 5 nights split 50/50", combo: "deposit ₹1,747.50 via Razorpay TEST", result: captured ? "PASS" : (r.opened ? "FAIL" : "BLOCKED"), detail: `${bookingId} ${JSON.stringify(r.status || r.reason)}`, evidence: r.evidence });
      saveBooking({ suite: SUITE, bookingId, service: "boarding", packageCode: "boarding-24h", providerId: reserve.body?.data?.provider?.id, customer: account.customerId, scheduledStart, total: quote.totalAmount, dueNow: quote.amountDueNow, paid: captured, paymentMode: "split_50_50" });
      if (captured) {
        record({ suite: SUITE, journey: "Boarding split — after deposit", combo: "what the booking page asks next", result: stillAsksDeposit ? "FAIL" : "PASS", detail: (r.pageText || "").slice(0, 600), evidence: r.evidence });
        if (stillAsksDeposit) finding({ suite: SUITE, severity: "P1", area: "Payments", persona: "Customer", flow: "Boarding split 50/50", title: "CONFIRMED ON STAGING: after the 50% deposit is captured the booking page still shows 'Due now ₹1,747.50 · Pay securely'", steps: `Pay deposit for ${bookingId} in Razorpay TEST, reopen /v2/booking`, expected: "Deposit paid; balance ₹1,747.50 due 24 h before check-in", actual: (r.pageText || "").slice(0, 400), evidence: r.evidence });
      }
      out.split = { bookingId, pay: r.status, d1: {
        payments: await d1("SELECT status, amount, amount_due_now FROM booking_payments WHERE booking_id=?", [bookingId]),
        events: await d1("SELECT event_type, processing_status, amount_subunits FROM payment_gateway_events WHERE booking_id=?", [bookingId]),
      } };
      step("split D1 truth", true, out.split.d1);
    }
  } catch (e) { step("split journey aborted", false, String(e?.message || e).slice(0, 400)); record({ suite: SUITE, journey: "Boarding 5 nights split 50/50", combo: "deposit", result: "BLOCKED", detail: `harness: ${String(e?.message || e).slice(0, 300)}`, evidence: [] }); }

  // ---------- B) Pet Taxi fares from real Google Routes ----------
  // A slot of its own per run: rides booked by earlier runs keep their fleet car reserved, so a fixed slot
  // eventually has no Citroen eC3 free (run 11: 409 "No Citroen eC3 is free for this 3-hour Taxi window").
  const seed = Number(String(process.env.GITHUB_RUN_ID || Date.now()).slice(-6));
  const taxiStart = istIso(isoDay(139 + (seed % 20)), ["09:00", "12:00", "15:00"][Math.floor(seed / 20) % 3]);
  const base = { originLabel: "100 Feet Road, Indiranagar, Bengaluru 560038", destinationLabel: "Koramangala 5th Block, Bengaluru 560095", scheduledStart: taxiStart };
  const combos = [
    ["one-way 1 pax 1 pet", { ...base, passengerCount: 1, petCount: 1, luggageCount: 0, tripType: "one_way", ridePurpose: "regular", waitingMinutes: 0 }],
    ["one-way no passenger (handler)", { ...base, passengerCount: 0, petCount: 1, luggageCount: 0, tripType: "one_way", ridePurpose: "regular", waitingMinutes: 0 }],
    ["round trip + 90 min wait, 2 pax 2 pets", { ...base, returnDropLabel: "100 Feet Road, Indiranagar, Bengaluru 560038", passengerCount: 2, petCount: 2, luggageCount: 2, tripType: "round_trip", ridePurpose: "regular", waitingMinutes: 90 }],
    ["airport flat fare", { ...base, destinationLabel: "Kempegowda International Airport, Bengaluru 560300", passengerCount: 2, petCount: 1, luggageCount: 3, tripType: "one_way", ridePurpose: "airport", waitingMinutes: 0 }],
    ["4 pax 3 pets 4 bags (XUV only)", { ...base, passengerCount: 4, petCount: 3, luggageCount: 4, tripType: "one_way", ridePurpose: "regular", waitingMinutes: 0 }],
  ];
  let firstQuote = null;
  for (const [label, input] of combos) {
    try {
      const r = await api(context, "POST", "/api/taxi-commercial", input, { timeout: 60_000 });
      const q = r.body?.data;
      if (!q) { out.taxi.push({ label, status: r.status, error: r.body?.error }); record({ suite: SUITE, journey: "Pet Taxi quote (Google Routes)", combo: label, result: "FAIL", detail: `HTTP ${r.status} ${JSON.stringify(r.body?.error || r.body).slice(0, 300)}`, evidence: [] }); continue; }
      if (!firstQuote) firstQuote = q;
      const rows = {};
      let allMatch = true;
      for (const v of ["citroen_ec3", "xuv"]) {
        const opt = q.fareOptions?.[v], exp = expectedFare(v, q);
        const match = !opt?.eligible || (Number(opt.quotedTotal) === exp.total && Number(opt.bookingFee) === exp.fee);
        if (!match) allMatch = false;
        rows[v] = { eligible: opt?.eligible, quoted: opt?.quotedTotal, fee: opt?.bookingFee, expected: exp.total, ineligible: opt?.ineligibleReason };
      }
      out.taxi.push({ label, distanceKm: q.distanceKm, minutes: q.estimatedDurationMinutes, routeSource: q.routeSource, rows });
      record({ suite: SUITE, journey: "Pet Taxi quote (Google Routes)", combo: label, result: allMatch ? "PASS" : "FAIL", detail: `${q.distanceKm} km / ${q.estimatedDurationMinutes} min via ${q.routeSource}; ${JSON.stringify(rows)}`, evidence: [] });
      if (!allMatch) finding({ suite: SUITE, severity: "P1", area: "Pet Taxi pricing", persona: "Customer", flow: "Taxi quote", title: `Taxi fare differs from the fare rules for "${label}"`, steps: JSON.stringify(input), expected: "fare per lib/taxi-business-rules.ts", actual: JSON.stringify(rows), evidence: [] });
    } catch (e) { record({ suite: SUITE, journey: "Pet Taxi quote (Google Routes)", combo: label, result: "BLOCKED", detail: `harness: ${String(e?.message || e).slice(0, 200)}`, evidence: [] }); }
  }
  step("taxi quotes", out.taxi.length > 0, out.taxi.map(t => `${t.label}: ${t.distanceKm ?? t.status} km`).join("; "));

  // ---------- C) One Pet Taxi ride reserved + 50% booking fee paid ----------
  try {
    if (firstQuote?.fareOptions?.citroen_ec3?.eligible) {
      const opt = firstQuote.fareOptions.citroen_ec3;
      const reserve = await api(context, "POST", "/api/uat-scheduling", { clientRequestId: `money-taxi-${runPhone(6)}-${Date.now()}`, customerId: account.customerId, petIds: [dog.id], serviceCode: "pet_taxi", cityId, zoneId, scheduledStart: firstQuote.scheduledStart, scheduledEnd: firstQuote.scheduledEnd, occurrences: 1 }, { timeout: 150_000 });
      const provider = reserve.body?.data?.provider;
      step("taxi reservation", Boolean(provider), `HTTP ${reserve.status} ${provider?.id || JSON.stringify(reserve.body).slice(0, 200)}`);
      const created = await api(context, "POST", "/api/taxi-ride-bookings", {
        idempotencyKey: `money-taxi-${firstQuote.quoteId}`, groupId: reserve.body?.data?.groupId, scheduleGroupId: reserve.body?.data?.groupId, taxiQuoteId: firstQuote.quoteId, vehicleClass: "citroen_ec3",
        customer: { id: account.customerId, name: account.name, primaryPhone: account.primaryPhone },
        pets: [{ sourceId: dog.sourceId ?? dog.id, name: dog.name, species: "dog", vaccinationStatus: dog.vaccinationStatus }],
        cityId, zoneId, scheduledStart: firstQuote.scheduledStart, scheduledEnd: firstQuote.scheduledEnd, provider,
        totalAmount: Number(opt.quotedTotal), amountDueNow: Number(opt.bookingFee), hyperactivePet: false, channel: "customer_app",
      });
      const bookingId = created.body?.data?.bookingId;
      step("taxi ride booking created", Boolean(bookingId), `HTTP ${created.status} ${bookingId || JSON.stringify(created.body).slice(0, 200)}`);
      if (bookingId) {
        const r = await payFromBookingPage(flow, bookingId);
        const captured = r.status?.paymentStatus === "captured";
        record({ suite: SUITE, journey: "Pet Taxi ride 50% booking fee", combo: `Citroën one-way ₹${opt.quotedTotal}, fee ₹${opt.bookingFee}`, result: captured ? "PASS" : (r.opened ? "FAIL" : "BLOCKED"), detail: `${bookingId} ${JSON.stringify(r.status ? { bookingStatus: r.status.bookingStatus, paymentStatus: r.status.paymentStatus } : r.reason)}`, evidence: r.evidence });
        saveBooking({ suite: SUITE, bookingId, service: "pet_taxi", providerId: provider?.id, customer: account.customerId, scheduledStart: firstQuote.scheduledStart, total: Number(opt.quotedTotal), dueNow: Number(opt.bookingFee), paid: captured, paymentMode: "split_50_50" });
        out.taxiBooking = { bookingId, pay: r.status, reason: r.reason };
        // PAY-05 live check: after the fee is captured the page must not offer another payment; the final balance
        // is requested after drop-off. Read after a reload so the page shows the server's post-capture state.
        if (captured) {
          await flow.page.goto(`${BASE}/v2/booking?bookingId=${encodeURIComponent(bookingId)}`, { waitUntil: "domcontentloaded" });
          await settle(flow.page, 4000);
          const after = (await flow.page.locator("main").innerText().catch(() => "")).replace(/\s+/g, " ");
          const offersPayment = /Pay securely|Pay balance/.test(after), explains = /requested after drop-off/.test(after);
          const shot = await flow.shot("taxi-booking-after-fee-reload");
          record({ suite: SUITE, journey: "Pet Taxi — after the booking fee (PAY-05)", combo: "what the booking page asks next", result: !offersPayment && explains ? "PASS" : "FAIL", detail: after.slice(0, 600), evidence: [shot] });
          if (offersPayment) finding({ suite: SUITE, severity: "P1", area: "Payments", persona: "Customer", flow: "Pet Taxi booking fee", title: "After the Pet Taxi booking fee is captured the booking page still offers a payment", steps: `Pay the fee for ${bookingId} in Razorpay TEST, reload /v2/booking`, expected: "Booking fee paid; final balance requested after drop-off", actual: after.slice(0, 400), evidence: [shot] });
        }
      }
    } else record({ suite: SUITE, journey: "Pet Taxi ride 50% booking fee", combo: "Citroën one-way", result: "BLOCKED", detail: "no eligible Citroën quote from part B", evidence: [] });
  } catch (e) { step("taxi booking aborted", false, String(e?.message || e).slice(0, 400)); }

  // Webhook inbox evidence for everything this suite paid (read-only).
  out.inboxSince = await d1("SELECT event_type, processing_status, COUNT(*) AS n FROM gateway_webhook_events WHERE received_at > ? GROUP BY 1,2", [Date.now() - 60 * 60_000]);
  step("webhook inbox, last hour", true, out.inboxSince);
  // PAY-01 regression watch: webhooks stuck since the live deploy (in-flight ones are given 2 minutes to settle).
  out.unfinishedWebhooks = await recordWebhookCheck(SUITE);
  step("webhooks stuck since the live deploy", !out.unfinishedWebhooks.stuckAfterDeployCount, out.unfinishedWebhooks.stuckAfterDeploy || out.unfinishedWebhooks.error);
} catch (error) {
  step("suite aborted", false, String(error?.message || error).slice(0, 500));
} finally {
  writeJson("money-and-maps.json", out);
  await flow.close();
  await browser.close();
}
