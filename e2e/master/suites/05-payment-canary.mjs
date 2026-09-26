// Payment canary: one cheap Boarding daycare created through the same APIs the V2 booking screen calls, then paid
// in the REAL Razorpay TEST checkout from the customer booking page. Runs first so the payment path is proven (or its
// failure is explained) before the long UI suites, and so later suites always have at least one paid booking.
import {
  BASE, launch, newFlow, settle, api, customerSession, otpCustomerSession, runPhone, dismissCookies, d1, isoDay,
  payRazorpayTestNetbanking, record, finding, saveBooking, writeJson,
} from "../lib.mjs";

const SUITE = "05-payment-canary";
const CANARY_DAY = 135; // outside every other suite window (services end at day 130)
const out = { suite: SUITE, steps: [] };
const step = (name, ok, detail) => { out.steps.push({ name, ok, detail }); console.log(`${ok ? "ok  " : "FAIL"} ${name} ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 300)}`); };
const istIso = (day, hhmm) => new Date(`${day}T${hhmm}:00+05:30`).toISOString();

const browser = await launch();
const flow = await newFlow(browser, SUITE, { video: true });
const { page, context } = flow;
let bookingId = null;
try {
  const who = process.env.MASTER_CUSTOMER_MODE === "otp"
    ? await otpCustomerSession(context, runPhone(5), "Master E2E Canary")
    : await customerSession(context, "customer-a");
  step("customer session", Boolean(who?.customerId), who?.customerId);
  let account = (await api(context, "GET", "/api/customer-account")).body?.data;
  let pet = account?.pets?.find(p => p.species === "dog" && p.vaccinationStatus === "verified");
  if (!pet) {
    const r = await api(context, "POST", "/api/customer-account", { customerId: account.customerId, action: "upsert_pet", idempotencyKey: `canary-pet-${runPhone(5)}`, pet: { name: "CanaryDog", species: "dog", breed: "Indie", vaccinationStatus: "verified" } });
    step("add vaccinated dog", r.status < 300, `HTTP ${r.status}`);
    account = (await api(context, "GET", "/api/customer-account")).body?.data;
    pet = account?.pets?.find(p => p.species === "dog" && p.vaccinationStatus === "verified");
  }
  if (!account?.addresses?.some(a => a.postalCode === "560038")) {
    const r = await api(context, "POST", "/api/customer-account", { customerId: account.customerId, action: "upsert_address", idempotencyKey: `canary-address-${runPhone(5)}`, address: { label: "Home", line1: "100 Feet Road, HAL 2nd Stage, Indiranagar", area: "Indiranagar", city: "Bengaluru", postalCode: "560038", isDefault: true } });
    step("add Indiranagar address", r.status < 300, `HTTP ${r.status}`);
  }
  const zone = (await api(context, "GET", "/api/service-zone?pincode=560038")).body?.data;
  const cityId = zone?.assignment?.cityId, zoneId = zone?.assignment?.zoneId;
  step("service zone 560038", Boolean(cityId && zoneId && zone?.zone?.serviceAvailable), `${cityId}/${zoneId}`);

  const day = isoDay(CANARY_DAY), scheduledStart = istIso(day, "09:00"), scheduledEnd = istIso(day, "13:00");
  const q = new URLSearchParams({ cityId, zoneId, scheduledStart, scheduledEnd, petCount: "1", species: "dog" });
  const commercial = await api(context, "GET", `/api/boarding-commercial?${q}`);
  const host = commercial.body?.data?.hosts?.[0];
  step("verified boarding hosts for the window", Boolean(host), `${commercial.status} ${commercial.body?.data?.hosts?.length ?? 0} hosts`);
  const quote = (await api(context, "POST", "/api/boarding-commercial", { packageCode: "boarding-4h", petCount: 1, cityId, zoneId, scheduledStart, scheduledEnd, paymentMode: "prepaid", providerId: host?.providerId })).body?.data;
  step("4-hour daycare quote", quote?.totalAmount === 499, `₹${quote?.totalAmount} (rule ₹499)`);
  const reserve = await api(context, "POST", "/api/uat-scheduling", { clientRequestId: `canary-${runPhone(5)}-${Date.now()}`, customerId: account.customerId, petIds: [pet.id], serviceCode: "boarding", serviceAddress: "100 Feet Road, HAL 2nd Stage, Indiranagar, Bengaluru, 560038", servicePincode: "560038", cityId, zoneId, scheduledStart, scheduledEnd, careMode: "visit", preferredProviderId: host?.providerId });
  step("scheduler reservation (uses Google geocoding on staging)", reserve.status === 200 || reserve.status === 201, `HTTP ${reserve.status} ${JSON.stringify(reserve.body?.error || reserve.body?.data?.provider || "").slice(0, 200)}`);
  const decision = reserve.body?.data;
  const created = await api(context, "POST", "/api/canonical-bookings", {
    idempotencyKey: `canary-${decision?.groupId}`, scheduleGroupId: decision?.groupId,
    customer: { id: account.customerId, name: account.name, primaryPhone: account.primaryPhone },
    pets: [{ sourceId: pet.sourceId ?? pet.id, name: pet.name, species: "dog", breed: pet.breed ?? undefined, vaccinationStatus: pet.vaccinationStatus }],
    cityId, zoneId, serviceCode: "boarding", packageCode: quote?.packageCode, packageName: quote?.packageName, scheduledStart, scheduledEnd,
    provider: decision?.provider, totalAmount: quote?.totalAmount, amountDueNow: quote?.amountDueNow,
    payment: { method: "upi", mode: "prepaid", status: "created", detail: "Awaiting verified Razorpay payment" },
    pricing: { discount: 0, boardingQuoteId: quote?.quoteId },
  });
  bookingId = created.body?.data?.bookingId || null;
  step("canonical booking created", Boolean(bookingId), `HTTP ${created.status} ${bookingId || JSON.stringify(created.body).slice(0, 200)}`);
  if (bookingId) {
    saveBooking({ suite: SUITE, bookingId, service: "boarding", packageCode: "boarding-4h", providerId: decision?.provider?.id, customer: account.customerId, scheduledStart, total: quote?.totalAmount, dueNow: quote?.amountDueNow, paid: false, paymentMode: "prepaid" });
    const stays = await api(context, "GET", `/api/boarding-stays?scope=customer&bookingId=${encodeURIComponent(bookingId)}`);
    const stay = Array.isArray(stays.body?.data) ? stays.body.data[0] : null;
    if (stay) {
      const care = await api(context, "POST", "/api/boarding-stays", { stayId: stay.id, action: "submit_care_plan", idempotencyKey: `canary-care-${bookingId}`, carePlan: { vet: "Dr. Rao, Indiranagar Vet Clinic, 9000000001", emergencyContact: "Asha, 9000000002", feeding: "Twice a day", medication: "None", specialInstructions: "Master E2E canary booking" } });
      step("care plan saved", care.status < 300, `HTTP ${care.status}`);
    }
    // Pay through the customer booking page — the same BookingPaymentPage + CustomerCheckoutController customers use.
    await page.goto(`${BASE}/v2/booking?bookingId=${encodeURIComponent(bookingId)}`); await settle(page, 2500); await dismissCookies(page);
    await flow.shot("booking-page-before-payment");
    const pay = page.getByRole("button", { name: /Pay securely/i }).first();
    await pay.waitFor({ timeout: 20_000 });
    await pay.click();
    await page.waitForTimeout(3000);
    const errorText = await page.locator("[role=alert]").allInnerTexts().catch(() => []);
    const razorpayOpened = page.frames().some(f => /razorpay/i.test(f.url()));
    await flow.shot("after-pay-click");
    if (!razorpayOpened) {
      step("Razorpay TEST checkout opened", false, errorText.join(" | ") || "no Razorpay frame");
      record({ suite: SUITE, journey: "payment canary", combo: "Boarding 4h ₹499 prepaid", result: /not configured/i.test(errorText.join(" ")) ? "ENV-GATED" : "FAIL", detail: `Checkout did not open: ${errorText.join(" | ")}`, evidence: [] });
    } else {
      step("Razorpay TEST checkout opened", true, "frame present");
      const paid = await payRazorpayTestNetbanking(page);
      step("Netbanking test bank → Success", paid.ok, JSON.stringify(paid));
      await flow.shot("after-razorpay-success");
      let status = null;
      for (let i = 0; i < 24 && status?.paymentStatus !== "captured"; i++) {
        await page.waitForTimeout(5000);
        const s = await api(context, "POST", "/api/customer-checkout", { action: "status", bookingId });
        status = s.body?.data?.confirmation || s.body?.data || null;
      }
      await page.goto(`${BASE}/v2/booking?bookingId=${encodeURIComponent(bookingId)}`); await settle(page, 2500);
      const evidence = [await flow.shot("booking-page-after-payment")];
      const captured = status?.paymentStatus === "captured" && ["confirmed", "assigned", "awaiting_host_acceptance"].includes(String(status?.bookingStatus));
      step("server shows payment captured + booking confirmed", captured, JSON.stringify({ bookingStatus: status?.bookingStatus, paymentStatus: status?.paymentStatus }));
      record({ suite: SUITE, journey: "payment canary", combo: "Boarding 4h ₹499 prepaid, Razorpay TEST Netbanking", result: captured ? "PASS" : "FAIL", detail: `booking ${bookingId}: ${JSON.stringify({ bookingStatus: status?.bookingStatus, paymentStatus: status?.paymentStatus })}`, evidence });
      if (captured) saveBooking({ suite: SUITE, bookingId, service: "boarding", packageCode: "boarding-4h", providerId: decision?.provider?.id, customer: account.customerId, scheduledStart, total: quote?.totalAmount, dueNow: quote?.amountDueNow, paid: true, paymentMode: "prepaid" });
      if (!captured) finding({ suite: SUITE, severity: "P1", area: "Payments", persona: "Customer", flow: "Razorpay TEST checkout on staging", title: "Payment completed in Razorpay TEST checkout but booking not captured/confirmed within 2 minutes", steps: `Create Boarding 4h booking ${bookingId}, pay via Netbanking test bank Success`, expected: "paymentStatus captured, booking confirmed", actual: JSON.stringify(status), evidence });
    }
    // Server-side truth (read-only).
    const payRows = await d1("SELECT status, amount, amount_due_now FROM booking_payments WHERE booking_id=?", [bookingId]);
    const events = await d1("SELECT event_type, processing_status, json_extract(CASE WHEN json_valid(detail_json) THEN detail_json ELSE '{}' END,'$.captureAuthority') AS authority FROM payment_gateway_events WHERE booking_id=?", [bookingId]);
    const inbox = await d1("SELECT event_type, processing_status, received_at FROM gateway_webhook_events WHERE raw_payload LIKE ? OR raw_payload LIKE ? ORDER BY received_at", [`%${bookingId}%`, `%${bookingId.toLowerCase()}%`]);
    step("D1 booking_payments", true, payRows); step("D1 payment_gateway_events", true, events); step("D1 webhook inbox rows for this booking", true, inbox);
    out.d1 = { payRows, events, inbox };
  }
} catch (error) {
  step("canary aborted", false, String(error?.message || error).slice(0, 500));
  record({ suite: SUITE, journey: "payment canary", combo: "Boarding 4h ₹499 prepaid", result: "BLOCKED", detail: `harness: ${String(error?.message || error).slice(0, 300)}`, evidence: [] });
} finally {
  out.bookingId = bookingId;
  writeJson("payment-canary.json", out);
  await flow.close();
  await browser.close();
}
