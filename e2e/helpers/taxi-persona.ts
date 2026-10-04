import { createHmac } from "node:crypto";
import { expect, test, type Browser, type Page, type Response } from "@playwright/test";
import { openFixtureFinance } from "./training-persona";

type PersonaInput = {
  page: Page;
  browser: Browser;
  baseURL: string | undefined;
  sandboxLogin: (page: Page, phone?: string) => Promise<void>;
  ensureCustomerPet: (page: Page, vaccinationStatus?: "verified" | "not_provided") => Promise<void>;
};
const driverPhones: Record<string, string> = { taxi_rahul: "9000000981", taxi_meera: "9000000980" };
const round = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

async function readData(response: Response) {
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()).data;
}

/** One real V2 ride in the disposable persona app. Routes uses the existing UAT Google binding;
 * payment capture, the service clock and route coordinates are explicitly synthetic boundaries.
 */
export async function runTaxiPersona({ page, browser, baseURL, sandboxLogin, ensureCustomerPet }: PersonaInput) {
  test.setTimeout(180_000);
  const origin = new URL(baseURL!);
  expect(origin.protocol).toBe("http:");
  expect(["localhost", "127.0.0.1"]).toContain(origin.hostname);
  expect(process.env.PAWSPACE_DEPLOYMENT_ENV).toBe("e2e");
  expect(process.env.FORBID_PRODUCTION).toBe("true");
  expect(process.env.PAWSPACE_PAYMENT_ENV).toBe("sandbox");
  expect(process.env.PAWSPACE_PAYMENT_LIVE_APPROVED).toBe("false");
  expect(process.env.PAWSPACE_UAT_SERVICE_CLOCK).toBe("on");
  const date = process.env.PW_UAT_SERVICE_DATE;
  expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  test.info().annotations.push({ type: "simulation", description: "Local synthetic D1/OTP and service clock; real configured UAT Google geocoding/Routes for public Bengaluru locations; authenticated locally signed synthetic webhook; synthetic route telemetry. No payment-provider call, voice call, physical GPS or native-device claim." });

  // Reuse the documented persona customer, avoiding new guessed phone identities.
  await sandboxLogin(page, "9000000912");
  await ensureCustomerPet(page, "verified");
  await page.goto("/v2/taxi");
  await expect(page.getByRole("heading", { name: "Plan your Pet Taxi ride", exact: true })).toBeVisible();
  const privacy = page.getByRole("button", { name: "Essential only", exact: true });
  await expect(privacy).toBeVisible(); await privacy.click();
  await expect(page.getByRole("dialog", { name: "Cookie consent", exact: true })).toBeHidden();
  await page.getByRole("combobox", { name: "Passengers", exact: true }).selectOption("1");
  await page.getByRole("combobox", { name: "Luggage", exact: true }).selectOption("0");
  const pets = page.locator("button[aria-pressed]");
  await expect(pets.first()).toBeVisible();
  for (const pet of await pets.all()) {
    const chosen = (await pet.innerText()).includes("Buddy");
    if (chosen !== ((await pet.getAttribute("aria-pressed")) === "true")) await pet.click();
  }
  await page.getByRole("button", { name: "Continue to trip details", exact: true }).click();
  await page.getByRole("button", { name: "One-way", exact: true }).click();
  await page.getByLabel("Pickup address", { exact: true }).fill("100 Feet Road, Indiranagar, Bengaluru 560038");
  await page.getByLabel("Drop address / Point 1", { exact: true }).fill("Koramangala 5th Block, Bengaluru 560095");
  await page.getByLabel("Pickup date", { exact: true }).fill(date!);
  // Matches the runner's documented 14:00 IST execution clock; no hosted time override is used.
  await page.getByRole("combobox", { name: "Pickup time", exact: true }).selectOption("14:00");
  const coverageResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/service-zone" && response.request().method() === "GET" && new URL(response.url()).searchParams.get("pincode") === "560038");
  await page.getByLabel("Pickup PIN code", { exact: true }).fill("560038");
  expect((await coverageResponse).status()).toBe(200);
  await expect(page.getByRole("status").filter({ hasText: "PIN 560038 is served." })).toBeVisible();
  await page.getByRole("button", { name: "Review ride requirements", exact: true }).click();
  const quoted = page.waitForResponse(r => r.url().endsWith("/api/taxi-commercial") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Calculate Citroën & XUV fares", exact: true }).click();
  const quoteResponse = await quoted;
  expect(quoteResponse.request().postDataJSON()).toMatchObject({ ridePurpose: "regular", tripType: "one_way" });
  expect(quoteResponse.status(), await quoteResponse.text()).toBe(201);
  const quote = (await quoteResponse.json()).data;
  expect(quote.routeSource).toBe("google_routes_uat");
  expect(quote.scheduledStart).toBe(`${date}T08:30:00.000Z`);
  expect(Date.parse(quote.scheduledEnd) - Date.parse(quote.scheduledStart)).toBe(180 * 60_000);
  expect(quote.petCount).toBe(1); expect(quote.passengerCount).toBe(1);
  const fare = quote.fareOptions.citroen_ec3;
  expect(fare.eligible).toBe(true);
  const total = round(500 + Math.max(0, Number(quote.distanceKm) - 5) * 35), fee = round(total / 2), balance = round(total - fee);
  expect(fare).toMatchObject({ quotedTotal: total, bookingFee: fee, finalBalanceBeforeAdjustments: balance, waitingCharge: 0, handlerCharge: 0 });
  await expect(page.getByRole("heading", { name: "Choose your car", exact: true })).toBeVisible();
  await page.getByRole("button").filter({ hasText: "booking fee · 50%" }).filter({ hasText: "Citroen eC3" }).click();
  await page.screenshot({ path: test.info().outputPath("taxi-canonical-route-quote.png"), fullPage: true });

  const bookingResponse = page.waitForResponse(r => r.url().endsWith("/api/taxi-ride-bookings") && r.request().method() === "POST", { timeout: 45_000 });
  await page.getByRole("button", { name: /^Reserve · pay/ }).click();
  const created = await bookingResponse;
  expect(created.status(), await created.text()).toBe(201);
  const booking = (await created.json()).data;
  const bookingId = String(booking.bookingId), paymentId = String(booking.paymentId), providerId = String(created.request().postDataJSON().provider.id);
  expect(driverPhones[providerId], "Only a documented local full-time fleet driver may be used").toBeTruthy();
  expect(booking).toMatchObject({ status: "payment_pending", amountDueNow: fee, balanceAmount: balance, liveMoney: false });
  expect(booking.reservedVehicle.vehicleClass).toBe("citroen_ec3");
  // Retry the same successful request, never a blind retry after an uncertain timeout.
  const repeated = await page.request.post("/api/taxi-ride-bookings", { data: created.request().postDataJSON() });
  expect(repeated.status(), await repeated.text()).toBe(200);
  expect((await repeated.json()).data).toMatchObject({ bookingId, paymentId, duplicatePrevented: true });

  const driver = await browser.newPage({ baseURL, viewport: page.viewportSize()! });
  let finance: Page | undefined;
  try {
    await driver.goto("/partner/onboarding");
    const driverConsent = driver.getByRole("button", { name: "Essential only", exact: true });
    await expect(driverConsent).toBeVisible(); await driverConsent.click();
    await driver.getByPlaceholder("10-digit phone number").fill(driverPhones[providerId]);
    await driver.getByRole("button", { name: "Send OTP", exact: true }).click();
    const otp = driver.getByText(/Sandbox code \(no real SMS yet\):/i); await expect(otp).toBeVisible();
    const code = (await otp.textContent())?.match(/\b(\d{6})\b/)?.[1]; expect(code).toMatch(/^\d{6}$/);
    await driver.getByPlaceholder("6-digit code").fill(code!);
    await driver.getByRole("button", { name: "Verify & continue", exact: true }).click();
    await expect.poll(async () => { const r = await driver.request.get("/api/identity-session"); return r.ok() ? (await r.json()).data.subjectId : null; }).toBe(providerId);
    const unpaid = await driver.request.post("/api/taxi-lifecycle", { data: { bookingId, action: "accept", idempotencyKey: `taxi-unpaid-${bookingId}` } });
    expect(unpaid.status(), await unpaid.text()).toBe(409);
    finance = await openFixtureFinance(browser, origin.origin);
    const capture = async (stage: string, amount: number) => {
      // The booking fee and final balance have distinct simulated orders, as in the split checkout.
      const linked = await finance!.request.post("/api/grooming-payment-sandbox", { data: { action: "link_order", bookingId, gatewayOrderId: `order_taxi_${stage}_${bookingId}` } });
      expect(linked.status(), await linked.text()).toBe(201);
      expect((await linked.json()).data).toMatchObject({ environment: "sandbox", synthetic: true });
      const secret = process.env.PW_PERSONA_WEBHOOK_SECRET;
      expect(secret, "the disposable persona runner must provision its own local webhook key").toBeTruthy();
      const eventId = `evt_taxi_${stage}_${bookingId}`;
      const raw = JSON.stringify({ event: "payment.captured", created_at: Math.floor(Date.now()/1000), payload: { payment: { entity: { id: `pay_taxi_${stage}_${bookingId}`, order_id: `order_taxi_${stage}_${bookingId}`, amount: Math.round(amount*100), currency: "INR", status: "captured", method: "upi", notes: { bookingId } } } } });
      const headers = { "content-type": "application/json", "x-razorpay-event-id": eventId, "x-razorpay-signature": createHmac("sha256",secret!).update(raw).digest("hex") };
      const first = await finance!.request.post("/api/razorpay-webhook", { data: raw, headers });
      expect(first.status(), await first.text()).toBe(200);
      expect(await first.json()).toMatchObject({ ok: true, environment: "sandbox", status: "processed", atomicCapture: true, duplicateCapture: false });
      const replay = await finance!.request.post("/api/razorpay-webhook", { data: raw, headers });
      expect(replay.status(), await replay.text()).toBe(200); expect(await replay.json()).toMatchObject({ok:true,duplicate:true});
    };
    await capture("fee", fee);
    const schedule = async () => { const r = await page.request.get(`/api/taxi-adjustments?scope=customer&bookingId=${encodeURIComponent(bookingId)}`); expect(r.status(), await r.text()).toBe(200); return (await r.json()).data.paymentSchedule; };
    await expect.poll(async () => (await schedule()).status).toBe("pending_balance");
    expect(await schedule()).toMatchObject({ total_amount: total, booking_fee_amount: fee, balance_amount: balance });
    await driver.goto(`/v2/partner/driver?bookingId=${encodeURIComponent(bookingId)}`);
    const act = async (label: string, action: string) => {
      const pending = driver.waitForResponse(r => r.url().endsWith("/api/taxi-lifecycle") && r.request().method() === "POST" && r.request().postDataJSON()?.action === action);
      await driver.getByRole("button", { name: label, exact: true }).click();
      return readData(await pending);
    };
    expect((await act("Accept trip", "accept")).status).toBe("assigned");
    expect((await act("Confirm reserved fleet car", "assign_vehicle")).status).toBe("vehicle_assigned");
    expect((await act("Confirm owner pickup · UAT", "confirm_pickup")).status).toBe("pickup_confirmed");
    expect((await act("Start trip", "start_trip")).status).toBe("in_progress");
    await act("Log pet settled", "trip_event");
    const withoutRoute = await driver.request.post("/api/taxi-lifecycle", { data: { bookingId, action: "arrive_dropoff", idempotencyKey: `taxi-no-route-${bookingId}` } });
    expect(withoutRoute.status(), await withoutRoute.text()).toBe(409);
    expect((await withoutRoute.json()).code).toBe("taxi_route_evidence_required");
    await driver.goto(`/v2/partner/driver/proof?bookingId=${encodeURIComponent(bookingId)}`);
    for (const point of [quote.origin, quote.destination]) {
      expect(Number.isFinite(Number(point.latitude)) && Number.isFinite(Number(point.longitude))).toBe(true);
      await driver.getByPlaceholder("Latitude", { exact: true }).fill(String(point.latitude));
      await driver.getByPlaceholder("Longitude", { exact: true }).fill(String(point.longitude));
      await driver.getByPlaceholder("Accuracy metres", { exact: true }).fill("10");
      const recorded = driver.waitForResponse(r => r.url().endsWith("/api/taxi-proof") && r.request().method() === "POST" && r.request().postDataJSON()?.action === "record_location_sample");
      await driver.getByRole("button", { name: "Record sandbox location sample", exact: true }).click();
      expect(await readData(await recorded)).toMatchObject({ status: "recorded", environment: "deterministic_sandbox", productionVerified: false });
    }
    await expect(driver.getByText("Route samples: 2", { exact: true })).toBeVisible();
    await driver.screenshot({ path: test.info().outputPath("taxi-synthetic-route-evidence.png"), fullPage: true });
    await driver.goto(`/v2/partner/driver?bookingId=${encodeURIComponent(bookingId)}`);
    expect((await act("Arrive drop-off", "arrive_dropoff")).status).toBe("arrived_dropoff");
    expect((await act("Confirm drop-off · UAT", "confirm_dropoff")).status).toBe("dropoff_confirmed");
    const completed = await act("Complete trip · create payment due", "complete_trip");
    expect(completed).toMatchObject({ status: "completed", paymentStatus: "due", amount: balance, payout: "awaiting_final_payment", tax: "awaiting_final_payment", routeSamples: 2, liveMoney: false });
    const prematureSettlement = await finance.request.post("/api/taxi-finance", { data: { bookingId, action: "prepare_settlement", idempotencyKey: `taxi-unpaid-settlement-${bookingId}` } });
    expect(prematureSettlement.status(), await prematureSettlement.text()).toBe(409);
    await capture("balance", balance);
    await expect.poll(async () => (await schedule()).status).toBe("paid");
    const prepared = await finance.request.post("/api/taxi-finance", { data: { bookingId, action: "prepare_settlement", idempotencyKey: `taxi-settlement-${bookingId}` } });
    expect(prepared.status(), await prepared.text()).toBe(200);
    const settlement = (await prepared.json()).data;
    expect(settlement).toMatchObject({ beneficiaryType: "vehicle_owner", beneficiaryId: booking.reservedVehicle.id, grossPaidValue: total, payoutRule: "rule_applied", tax: "resolved", source: "canonical_taxi_vehicle_owner_completion" });
    expect(settlement.beneficiaryId).not.toBe(providerId);
    expect(["not_instructed", "not_applicable"]).toContain(settlement.payoutStatus);
    const financeRead = await finance.request.get(`/api/taxi-finance?bookingId=${encodeURIComponent(bookingId)}`);
    expect(financeRead.status(), await financeRead.text()).toBe(200);
    const financial = (await financeRead.json()).data;
    expect(financial.booking).toMatchObject({ id: bookingId, status: "completed", payment_status: "captured", total_amount: total });
    expect(financial.trip).toMatchObject({ status: "completed", trip_payment_status: "gateway_paid" });
    const customerRead = await page.request.get("/api/customer-account"); expect(customerRead.ok()).toBe(true);
    const rows = (await customerRead.json()).data.bookings.filter((row: { id: string }) => row.id === bookingId);
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ status: "completed", providerId });
    const deniedFinance = await driver.request.get(`/api/taxi-finance?bookingId=${encodeURIComponent(bookingId)}`); expect(deniedFinance.status()).toBe(403);
    await page.goto(`/v2/taxi/manage?bookingId=${encodeURIComponent(bookingId)}`);
    await expect(page.locator("main")).toContainText("completed");
    await expect(page.getByText("✓ Final Taxi balance verified as paid.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /Pay final balance/ })).toHaveCount(0);
    await finance.goto(`/v2/team/finance/taxi?bookingId=${encodeURIComponent(bookingId)}`);
    await expect(finance.getByRole("heading", { name: "Taxi payment & reconciliation", exact: true })).toBeVisible();
    await expect(finance.getByPlaceholder("Canonical Taxi booking ID", { exact: true })).toHaveValue(bookingId);
    await expect(finance.getByText("gateway paid", { exact: true })).toBeVisible();
    await driver.reload();
    await expect(driver.locator("main")).toContainText("Trip payment event: gateway paid");
    await page.screenshot({ path: test.info().outputPath("customer-taxi-completed.png"), fullPage: true });
    await driver.screenshot({ path: test.info().outputPath("taxi-driver-completed.png"), fullPage: true });
    await finance.screenshot({ path: test.info().outputPath("taxi-finance-completed.png"), fullPage: true });
    console.log("TAXI-PERSISTENT", JSON.stringify({ bookingId, paymentId, providerId, vehicleId: booking.reservedVehicle.id, quoteId: quote.quoteId, total, bookingFee: fee, finalBalance: balance, customerStatus: "completed", partnerStatus: "completed", paymentStatus: "captured", paymentEvidence: "locally_signed_synthetic_webhook", routeProvider: "google_routes_uat", routeSamples: 2, productionGpsVerified: false, settlementBeneficiary: settlement.beneficiaryId, payoutStatus: settlement.payoutStatus, tax: settlement.tax, liveMoney: false }));
  } finally { await Promise.allSettled([driver.close(), ...(finance ? [finance.close()] : [])]); }
}
