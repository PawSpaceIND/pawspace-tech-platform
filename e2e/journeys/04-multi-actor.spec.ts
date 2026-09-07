import { expect, request as playwrightRequest, test } from "@playwright/test";

const CUSTOMER_EMAIL = "e2e.customer@pawspace.test";
const PROVIDER_EMAIL = "e2e.provider@pawspace.test";
const ADMIN_EMAIL = "e2e.admin@pawspace.test";
const FINANCE_EMAIL = "e2e.finance@pawspace.test";
const CUSTOMER_ID = "E2E-CUS-UI-001";
const PROVIDER_ID = "E2E-PRV-UI-001";
const PET_ID = "E2E-PET-UI-001";

async function actorApi(baseURL: string, email: string) {
  return playwrightRequest.newContext({
    baseURL,
    extraHTTPHeaders: {
      "oai-authenticated-user-email": email,
      "oai-authenticated-user-full-name": encodeURIComponent(email.split("@")[0]),
      "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
    },
  });
}

async function expectOk(response: import("@playwright/test").APIResponse, label: string) {
  const text = await response.text();
  expect(response.ok(), `${label} failed (${response.status()}): ${text}`).toBeTruthy();
  return text ? JSON.parse(text) : {};
}

test("correlated journey: customer reserves/books -> assigned provider completes -> admin sees balanced completion finance", async ({ page, baseURL }) => {
  expect(baseURL).toBeTruthy();
  const origin = baseURL!;
  const customer = await actorApi(origin, CUSTOMER_EMAIL);
  const provider = await actorApi(origin, PROVIDER_EMAIL);
  const admin = await actorApi(origin, ADMIN_EMAIL);
  const finance = await actorApi(origin, FINANCE_EMAIL);
  test.info().annotations.push({ type: "isolation", description: "payment=sandbox; live-approved=false; local Miniflare only" });

  try {
    await page.setExtraHTTPHeaders({ "oai-authenticated-user-email": CUSTOMER_EMAIL });
    const customerHome = await page.goto("/mobile-app", { waitUntil: "domcontentloaded" });
    expect(customerHome?.status() ?? 500).toBeLessThan(500);
    await expect(page.locator("body")).toContainText(/PawSpace|Everything they need|Care services/i);

    const suffix = `${Date.now()}-${test.info().project.name}`.replace(/[^a-zA-Z0-9-]/g, "");
    const groupId = `E2E-MULTI-${suffix}`;
    const deviceDayOffset = test.info().project.name === "mobile-chromium" ? 6 : 5;
    const start = new Date(Date.now() + deviceDayOffset * 86_400_000);
    start.setUTCHours(4, 30, 0, 0);
    const end = new Date(start.getTime() + 2 * 60 * 60_000);

    const scheduled = await customer.post("/api/uat-scheduling", {
      data: {
        action: "reserve",
        clientRequestId: groupId,
        customerId: CUSTOMER_ID,
        petIds: [PET_ID],
        serviceCode: "grooming",
        cityId: "blr",
        zoneId: "blr-east",
        scheduledStart: start.toISOString(),
        scheduledEnd: end.toISOString(),
        preferredProviderId: PROVIDER_ID,
      },
    });
    const scheduleBody = await expectOk(scheduled, "customer slot reservation");
    expect(scheduleBody?.data?.provider?.id).toBe(PROVIDER_ID);

    const booked = await customer.post("/api/canonical-bookings", {
      data: {
        idempotencyKey: groupId,
        scheduleGroupId: groupId,
        customer: { id: CUSTOMER_ID, name: "E2E UI Customer", primaryPhone: "9800000111", email: CUSTOMER_EMAIL },
        pets: [{ sourceId: PET_ID, name: "Bruno", species: "dog", breed: "indie", vaccinationStatus: "vaccinated" }],
        cityId: "blr",
        zoneId: "blr-east",
        serviceCode: "grooming",
        packageCode: "dog-basic",
        packageName: "Bath & Basic",
        scheduledStart: start.toISOString(),
        scheduledEnd: end.toISOString(),
        provider: scheduleBody.data.provider,
        totalAmount: 1899,
        amountDueNow: 1899,
        payment: { method: "upi", mode: "prepaid", status: "created", detail: "persona sandbox" },
        pricing: { discount: 0 },
      },
    });
    const bookingBody = await expectOk(booked, "customer canonical booking");
    const bookingId = String(bookingBody?.data?.bookingId || "");
    expect(bookingId).toMatch(/^PS-|^BK-|^E2E-/);

    const located = await customer.post("/api/grooming-service-location", {
      data: {
        bookingId,
        customerId: CUSTOMER_ID,
        address: "100 Feet Road, Indiranagar, Bengaluru",
        pincode: "560038",
        latitude: 12.9719,
        longitude: 77.6412,
      },
    });
    await expectOk(located, "customer service location");

    const linked = await finance.post("/api/grooming-payment-sandbox", {
      data: { action: "link_order", bookingId, gatewayOrderId: `order_${suffix}` },
    });
    await expectOk(linked, "finance sandbox payment order link");
    const captured = await finance.post("/api/grooming-payment-sandbox", {
      data: {
        action: "simulate_event",
        bookingId,
        eventType: "payment.captured",
        eventId: `evt_${suffix}`,
        gatewayPaymentId: `pay_${suffix}`,
        amount: 1899,
        currency: "INR",
      },
    });
    await expectOk(captured, "finance sandbox payment capture");

    for (const action of ["accept", "on_the_way"] as const) {
      const response = await provider.post("/api/grooming-lifecycle", { data: { bookingId, action } });
      const body = await expectOk(response, `provider ${action}`);
      expect(body?.data?.booking?.provider_id).toBe(PROVIDER_ID);
    }

    // ARRIVED is now fail-closed against fresh, trusted, server-bound GPS evidence. Feed the provider's
    // foreground location through the governed telemetry route first; lifecycle coordinates are
    // intentionally ignored by the production arrival gate.
    const gps = await provider.post("/api/grooming-route", {
      data: {
        bookingId,
        providerId: PROVIDER_ID,
        latitude: 12.9719,
        longitude: 77.6412,
        accuracyMeters: 10,
        capturedAt: Date.now(),
        idempotencyKey: `gps_${suffix}`,
      },
    });
    const gpsBody = await expectOk(gps, "provider trusted GPS telemetry");
    expect(gpsBody?.data?.trustState).toBe("accepted");

    for (const action of ["arrived", "start_service"] as const) {
      const response = await provider.post("/api/grooming-lifecycle", { data: { bookingId, action } });
      const body = await expectOk(response, `provider ${action}`);
      expect(body?.data?.booking?.provider_id).toBe(PROVIDER_ID);
    }

    const proof = await provider.post("/api/grooming-lifecycle", {
      data: {
        bookingId,
        action: "add_proof",
        beforePhotoRef: `uat://proof/${bookingId}/before`,
        afterPhotoRef: `uat://proof/${bookingId}/after`,
        checklist: ["coat", "nails", "ears"],
        completionNotes: "Persona E2E completed safely",
      },
    });
    await expectOk(proof, "provider service proof");

    const completed = await provider.post("/api/grooming-lifecycle", { data: { bookingId, action: "complete" } });
    const completedBody = await expectOk(completed, "provider complete");
    expect(completedBody?.data?.booking?.status).toBe("completed");
    expect(completedBody?.data?.booking?.work_order_status).toBe("completed");

    const adminView = await admin.get(`/api/grooming-lifecycle?bookingId=${encodeURIComponent(bookingId)}`);
    const adminBody = await expectOk(adminView, "admin completed transaction view");
    expect(adminBody?.data?.booking?.id).toBe(bookingId);
    expect(adminBody?.data?.booking?.status).toBe("completed");
    expect(adminBody?.data?.invoice?.status).toBe("issued");
    expect(adminBody?.data?.taxReadiness?.tax_rule_status).toBe("resolved");
    expect(adminBody?.data?.payoutReadiness?.status).toBe("accrued");
    expect(String(adminBody?.data?.payoutReadiness?.reason || "")).toMatch(/ledger balanced/i);

    await page.setExtraHTTPHeaders({ "oai-authenticated-user-email": ADMIN_EMAIL });
    const adminUi = await page.goto("/booking-command-center", { waitUntil: "domcontentloaded" });
    expect(adminUi?.status() ?? 500).toBeLessThan(500);
    await expect(page.locator("body")).toContainText(/booking/i);
  } finally {
    await Promise.all([customer.dispose(), provider.dispose(), admin.dispose(), finance.dispose()]);
  }
});
