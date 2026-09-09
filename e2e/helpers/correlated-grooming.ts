import { expect, request as playwrightRequest } from "@playwright/test";
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


export async function runGroomingDemo(origin: string, suffix: string, dayOffset: number, ending: "complete" | "cancel" = "complete") {
  const customer = await actorApi(origin, CUSTOMER_EMAIL);
  const provider = await actorApi(origin, PROVIDER_EMAIL);
  const admin = await actorApi(origin, ADMIN_EMAIL);
  const finance = await actorApi(origin, FINANCE_EMAIL);
  try {
    const groupId = `E2E-MULTI-${suffix}`;
    const deviceDayOffset = dayOffset;
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

    const bookingInput = {
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
    };
    const [booked, duplicateBooking] = await Promise.all([
      customer.post("/api/canonical-bookings", { data: bookingInput }),
      customer.post("/api/canonical-bookings", { data: bookingInput }),
    ]);
    const bookingBody = await expectOk(booked, "customer canonical booking");
    const bookingId = String(bookingBody?.data?.bookingId || "");
    expect(bookingId).toMatch(/^PS-|^BK-|^E2E-/);
    const replay = await expectOk(duplicateBooking, "concurrent duplicate booking replay");
    expect(replay.data.bookingId).toBe(bookingId);
    expect(bookingBody.data.duplicatePrevented || replay.data.duplicatePrevented).toBe(true);

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
    const locationBody = await expectOk(located, "customer service location");
    expect(locationBody?.data?.coordinateSource).toBe("server_geocode");
    const serviceLatitude = Number(locationBody?.data?.latitude);
    const serviceLongitude = Number(locationBody?.data?.longitude);
    expect(Number.isFinite(serviceLatitude)).toBe(true);
    expect(Number.isFinite(serviceLongitude)).toBe(true);

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

    if (ending === "cancel") {
      const data = {bookingId, customerId:CUSTOMER_ID, action:"cancel",reason:"Connected sandbox cancellation demo"};
      const responses = await Promise.all([customer.post("/api/grooming-booking-change",{data}),customer.post("/api/grooming-booking-change",{data})]);
      const cancellations = await Promise.all(responses.map(async response=>({status:response.status(),body:await response.json()})));
      console.log(JSON.stringify({bookingId,cancellations}));
      const successful = cancellations.filter(result=>result.status===200);
      expect(successful.length).toBeGreaterThan(0);
      const caseIds = [...new Set(successful.map(result=>result.body.data.refundCaseId))];
      expect(caseIds, "a double tap must not open two refund cases").toHaveLength(1);
      const adminBody = await expectOk(await admin.get("/api/canonical-bookings"),"admin cancellation visibility");
      const row = adminBody.bookings.find((row:{id:string})=>row.id===bookingId);
      expect(row.status).toBe("cancelled");expect(row.work_order_status).toBe("cancelled");expect(row.payment_status).toBe("refund_pending");
      return {bookingId,groupId,cancellations,adminView:row,paymentMode:"sandbox",evidenceKind:"built-worker-http-local-d1-cancellation"};
    }

    for (const action of ["accept", "on_the_way"] as const) {
      const response = await provider.post("/api/grooming-lifecycle", { data: { bookingId, action } });
      const body = await expectOk(response, `provider ${action}`);
      expect(body?.data?.booking?.provider_id).toBe(PROVIDER_ID);
    }

    // ARRIVED is fail-closed against fresh, trusted, server-bound GPS evidence. Use the canonical
    // server-geocoded service location returned above; browser-supplied coordinates are intentionally
    // ignored as authority by the production service-location route.
    const gps = await provider.post("/api/grooming-route", {
      data: {
        bookingId,
        providerId: PROVIDER_ID,
        latitude: serviceLatitude,
        longitude: serviceLongitude,
        accuracyMeters: 10,
        capturedAt: Date.now(),
        idempotencyKey: `gps_${suffix}`,
      },
    });
    const gpsBody = await expectOk(gps, "provider trusted GPS telemetry");
    expect(gpsBody?.data?.providerLocation?.trustState).toBe("accepted");
    expect(gpsBody?.data?.telemetryAccepted).toBe(true);

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

    const notificationPath = `/api/order-notifications?customerId=${CUSTOMER_ID}`;
    const notificationBody = await expectOk(await customer.get(notificationPath), "customer notification delivery visibility");
    expect(notificationBody.data.sweep.ok, JSON.stringify(notificationBody.data.sweep)).toBe(true);
    const notifications = notificationBody.data.items.filter((item: {booking_id: string}) => item.booking_id === bookingId);
    expect(notifications.some((item: {event_type: string}) => item.event_type === "payment_captured")).toBe(true);
    expect(notifications.some((item: {event_type: string}) => /completed/.test(item.event_type))).toBe(true);
    const repeatedNotifications = await expectOk(await customer.get(notificationPath), "notification retry");
    expect(repeatedNotifications.data.items.map((item: {id: string}) => item.id).sort()).toEqual(notificationBody.data.items.map((item: {id: string}) => item.id).sort());
    return { bookingId, groupId, notifications, adminView: adminBody.data, paymentMode: "sandbox", evidenceKind: "built-worker-http-local-d1" };
  } finally {
    await Promise.all([customer.dispose(), provider.dispose(), admin.dispose(), finance.dispose()]);
  }
}
