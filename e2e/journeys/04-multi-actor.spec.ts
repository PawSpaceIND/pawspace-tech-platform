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

for(const assignmentMode of ["auto","admin_choice"] as const)test(`correlated journey (${assignmentMode}): customer reserves/books -> assigned provider completes -> admin sees balanced completion finance`, async ({ page, baseURL }) => {
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
    const deviceDayOffset = (test.info().project.name === "mobile-chromium" ? 6 : 5)+(assignmentMode==="admin_choice"?2:0);
    const start = new Date(Date.now() + deviceDayOffset * 86_400_000);
    start.setUTCHours(4, 30, 0, 0);
    const end = new Date(start.getTime() + 2 * 60 * 60_000);

    const schedulePayload = {
        action: "reserve",
        assignmentStrategy: assignmentMode,
        clientRequestId: groupId,
        customerId: CUSTOMER_ID,
        petIds: [PET_ID],
        serviceCode: "grooming",
        cityId: "blr",
        zoneId: "blr-east",
        scheduledStart: start.toISOString(),
        scheduledEnd: end.toISOString(),
        preferredProviderId: PROVIDER_ID,
      };
    const scheduled=await customer.post("/api/uat-scheduling",{data:schedulePayload});
    let scheduleBody=await expectOk(scheduled,"customer slot reservation");
    if(assignmentMode==="admin_choice"){
      expect(scheduleBody.data.status).toBe("awaiting_admin");
      await page.setExtraHTTPHeaders({"oai-authenticated-user-email":ADMIN_EMAIL});
      await page.goto("/team/scheduling");
      await page.getByLabel("Day (IST)",{exact:true}).fill(start.toISOString().slice(0,10));
      const waiting=page.getByRole("region",{name:"Requests awaiting admin"}).locator("article").filter({hasText:groupId});
      await expect(waiting).toBeVisible();await waiting.getByRole("button",{name:"Manage request",exact:true}).click();
      await waiting.getByRole("combobox",{name:"Recommended provider",exact:true}).selectOption(PROVIDER_ID);
      await waiting.getByRole("textbox",{name:"Reason",exact:true}).fill("Customer requested this verified provider");
      await page.screenshot({path:test.info().outputPath("employee-assignment-live-form.png"),fullPage:true});
      await waiting.getByRole("button",{name:"Assign provider",exact:true}).click();
      await expect(page.getByRole("status")).toContainText("Partner acceptance and customer booking confirmation are still pending.");
      await expect(waiting).toHaveCount(0);
      await page.setExtraHTTPHeaders({"oai-authenticated-user-email":CUSTOMER_EMAIL});
      scheduleBody=await expectOk(await customer.post("/api/uat-scheduling",{data:schedulePayload}),"customer resumes the staff-assigned request");
      expect(scheduleBody.data.duplicatePrevented).toBe(true);
    }
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

    // Exchange a real local sandbox OTP for a customer session; provider/admin headers are removed.
    await page.setExtraHTTPHeaders({});await page.context().clearCookies();await page.goto("/mobile-app");
    await page.locator("nav").getByRole("button",{name:/account/i}).last().click();await page.getByPlaceholder("10-digit phone number").fill("9800000111");await page.getByRole("button",{name:"Send OTP",exact:true}).click();
    const sandbox=page.getByText(/Sandbox code \(no real SMS yet\):/i);await expect(sandbox).toBeVisible();const code=(await sandbox.textContent())?.match(/\b(\d{6})\b/)?.[1];expect(code).toMatch(/^\d{6}$/);await page.getByPlaceholder("6-digit code").fill(code!);
    const name=page.getByPlaceholder("Your name (first time only)");if(await name.isVisible().catch(()=>false))await name.fill("E2E UI Customer");
    await page.getByRole("button",{name:"Verify & continue",exact:true}).click();await expect(page.getByPlaceholder("6-digit code")).toBeHidden();
    // Chromium sends Secure cookies on trustworthy loopback; APIRequestContext does not.
    // Read through the actual browser session, without manually copying or weakening cookies.
    const ownAccount=await page.evaluate(async()=>{const response=await fetch("/api/customer-account",{cache:"no-store"});return{status:response.status,body:await response.json()};});expect(ownAccount.status).toBe(200);expect(ownAccount.body.data.customerId).toBe(CUSTOMER_ID);
    await page.goto(`/grooming/manage?bookingId=${encodeURIComponent(bookingId)}`);
    const care=page.getByRole("region",{name:"Completed care summary",exact:true});await expect(care).toContainText("Persona E2E completed safely");await expect(care.getByRole("listitem")).toHaveText(["coat","nails","ears"]);await expect(care).toContainText(String(adminBody.data.invoice.invoice_number));
    const summary=await page.evaluate(async id=>{const response=await fetch(`/api/customer-grooming-summary?bookingId=${encodeURIComponent(id)}`,{cache:"no-store"});return{status:response.status,body:await response.json()};},bookingId);expect(summary.status).toBe(200);expect(summary.body.data.invoice.total).toBe(adminBody.data.invoice.gross_amount);expect(summary.body.data.invoice.tax).toBe(adminBody.data.invoice.tax_amount);expect(summary.body.data).not.toHaveProperty("payoutReadiness");
    await page.reload();await expect(care).toContainText("Persona E2E completed safely");await page.screenshot({path:test.info().outputPath(`customer-completed-care-${assignmentMode}.png`),fullPage:true});
    await page.goto("/mobile-app");
    await page.locator("nav").getByRole("button",{name:/activity/i}).last().click();
    await page.getByRole("button",{name:"History",exact:true}).click();
    const ratingCard=page.getByRole("article",{name:`Rate booking ${bookingId}`,exact:true});
    await expect(ratingCard).toBeVisible();
    await page.route("**/api/booking-rating",async route=>{if(route.request().method()==="POST")await route.fulfill({status:503,contentType:"application/json",body:JSON.stringify({error:"Rating is temporarily unavailable. Please retry."})});else await route.continue();});
    await ratingCard.getByRole("button",{name:"4 stars",exact:true}).click();
    await expect(page.getByRole("alert")).toContainText("Rating is temporarily unavailable");
    await expect(ratingCard).toBeVisible();
    await page.unroute("**/api/booking-rating");
    const savedRating=page.waitForResponse(response=>response.url().endsWith("/api/booking-rating")&&response.request().method()==="POST");
    await ratingCard.getByRole("button",{name:"4 stars",exact:true}).click();
    const ratingResponse=await savedRating;expect(ratingResponse.status()).toBe(201);const ratingBody=await ratingResponse.json();expect(ratingBody.data.bookingId).toBe(bookingId);expect(ratingBody.data.stars).toBe(4);
    await expect(ratingCard).toHaveCount(0);
    await page.reload();await page.locator("nav").getByRole("button",{name:/activity/i}).last().click();await page.getByRole("button",{name:"History",exact:true}).click();
    const persistedRating=await page.evaluate(async()=>{const response=await fetch("/api/booking-rating",{cache:"no-store"});return{status:response.status,body:await response.json()};});expect(persistedRating.status).toBe(200);expect(persistedRating.body.data.ratableBookings.some((item:{bookingId:string})=>item.bookingId===bookingId)).toBe(false);
    await expect(ratingCard).toHaveCount(0);await expect(page.getByText(bookingId,{exact:false}).first()).toBeVisible();
    await page.screenshot({path:test.info().outputPath(`customer-rating-saved-${assignmentMode}.png`),fullPage:true});
    await page.context().clearCookies();
    await page.setExtraHTTPHeaders({ "oai-authenticated-user-email": ADMIN_EMAIL });
    const adminUi = await page.goto("/booking-command-center", { waitUntil: "domcontentloaded" });
    expect(adminUi?.status() ?? 500).toBeLessThan(500);
    await expect(page.locator("body")).toContainText(/booking/i);
  } finally {
    await Promise.all([customer.dispose(), provider.dispose(), admin.dispose(), finance.dispose()]);
  }
});
