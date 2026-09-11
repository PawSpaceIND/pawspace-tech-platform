import { expect, request as playwrightRequest, test } from "@playwright/test";

const CUSTOMER_EMAIL = "e2e.customer@pawspace.test";
const PROVIDER_EMAIL = "e2e.provider@pawspace.test";
const AUTO_GROOMER_EMAIL = "e2e.auto.groomer@pawspace.test";
const GROOM_KIRAN_EMAIL = "e2e.groom.kiran@pawspace.test";
const GROOM_SANJAY_EMAIL = "e2e.groom.sanjay@pawspace.test";
const ADMIN_EMAIL = "e2e.admin@pawspace.test";
const FINANCE_EMAIL = "e2e.finance@pawspace.test";
const CUSTOMER_ID = "E2E-CUS-UI-001";
const PROVIDER_ID = "E2E-PRV-UI-001";
const PET_ID = "E2E-PET-UI-001";
const PROVIDER_EMAILS:Record<string,string>={
  [PROVIDER_ID]:PROVIDER_EMAIL,
  groom_arun:AUTO_GROOMER_EMAIL,
  groom_kiran:GROOM_KIRAN_EMAIL,
  groom_sanjay:GROOM_SANJAY_EMAIL,
};

type AdminGroomingView={data?:{booking?:{id?:string;status?:string};invoice?:{status?:string;invoiceNumber?:string;total?:number;tax?:number};taxReadiness?:{taxRuleStatus?:string};payoutReadiness?:{status?:string;payoutAmount?:number}}};
type CustomerAccountView={data?:{customerId?:string}};

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
  let provider: Awaited<ReturnType<typeof actorApi>> | null = null;
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
      const day=start.toISOString().slice(0,10);
      const boardApi=await expectOk(await admin.get(`/api/uat-scheduling?date=${encodeURIComponent(day)}`),"admin waiting-request board API");
      expect(boardApi.data.pendingRequests.some((row:{groupId:string})=>row.groupId===groupId)).toBe(true);
      await page.setExtraHTTPHeaders({"oai-authenticated-user-email":ADMIN_EMAIL});
      await page.goto("/team/scheduling");
      // Wait for client hydration before changing the controlled date input. On mobile Chromium the
      // server-rendered input can accept a Playwright fill before React attaches onChange, then hydration
      // restores today's value and the browser journey observes the wrong day even though the API is sound.
      const refresh=page.getByRole("button",{name:/Refresh|Refreshing/});
      await expect(refresh).toBeEnabled({timeout:15000});
      const dayInput=page.getByLabel("Day (IST)",{exact:true});
      await dayInput.fill(day);
      await expect(dayInput).toHaveValue(day);
      const waiting=page.getByRole("region",{name:"Requests awaiting admin"}).locator("article").filter({hasText:groupId});
      await expect(waiting).toBeVisible({timeout:15000});
      await expect(refresh).toBeEnabled({timeout:15000});
      await refresh.click();
      await expect(waiting).toBeVisible({timeout:15000});await waiting.getByRole("button",{name:"Manage request",exact:true}).click();
      const providerSelect=waiting.getByRole("combobox",{name:"Recommended provider",exact:true});
      const candidateIds=await providerSelect.locator("option").evaluateAll(options=>options.map(option=>(option as HTMLOptionElement).value).filter(Boolean));
      const chosenProviderId=candidateIds.find(id=>Boolean(PROVIDER_EMAILS[id]));
      expect(chosenProviderId,"admin shortlist must contain a provider with a governed E2E identity").toBeTruthy();
      await providerSelect.selectOption(chosenProviderId!);
      await waiting.getByRole("textbox",{name:"Reason",exact:true}).fill("Customer requested this verified provider");
      await page.screenshot({path:test.info().outputPath("employee-assignment-live-form.png"),fullPage:true});
      await waiting.getByRole("button",{name:"Assign provider",exact:true}).click();
      await expect(waiting).toHaveCount(0);
      await page.setExtraHTTPHeaders({"oai-authenticated-user-email":CUSTOMER_EMAIL});
      scheduleBody=await expectOk(await customer.post("/api/uat-scheduling",{data:schedulePayload}),"customer resumes the staff-assigned request");
      expect(scheduleBody.data.duplicatePrevented).toBe(true);
    }
    const assignedProviderId=String(scheduleBody?.data?.provider?.id||"");
    expect(assignedProviderId).toBeTruthy();
    const assignedProviderEmail=PROVIDER_EMAILS[assignedProviderId]||"";
    expect(assignedProviderEmail,`assigned provider ${assignedProviderId} needs a governed local E2E identity`).toBeTruthy();
    provider=await actorApi(origin,assignedProviderEmail);

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
      expect(body?.data?.booking?.provider_id).toBe(assignedProviderId);
    }

    // ARRIVED is fail-closed against fresh, trusted, server-bound GPS evidence. Use the canonical
    // server-geocoded service location returned above; browser-supplied coordinates are intentionally
    // ignored as authority by the production service-location route.
    const gps = await provider.post("/api/grooming-route", {
      data: {
        bookingId,
        providerId: assignedProviderId,
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
      expect(body?.data?.booking?.provider_id).toBe(assignedProviderId);
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

    await expect.poll(async()=>{
      const adminView=await admin.get(`/api/grooming-lifecycle?bookingId=${encodeURIComponent(bookingId)}`);
      if(!adminView.ok())return false;
      const body=JSON.parse(await adminView.text()) as AdminGroomingView;
      return body.data?.booking?.status==="completed"&&body.data?.invoice?.status==="issued";
    },{timeout:15000}).toBe(true);
    const adminBody=await expectOk(await admin.get(`/api/grooming-lifecycle?bookingId=${encodeURIComponent(bookingId)}`),"admin completed transaction view") as AdminGroomingView;
    expect(adminBody.data?.booking?.id).toBe(bookingId);
    expect(adminBody.data?.booking?.status).toBe("completed");
    expect(adminBody.data?.invoice?.status).toBe("issued");
    expect(adminBody.data?.invoice?.invoiceNumber).toBeTruthy();
    expect(adminBody.data?.taxReadiness?.taxRuleStatus).toBe("resolved");
    expect(adminBody.data?.payoutReadiness?.status).toBe("accrued");
    const assignedModel=String(scheduleBody?.data?.provider?.model||"");
    if(assignedModel==="commission")expect(Number(adminBody.data?.payoutReadiness?.payoutAmount)).toBeGreaterThan(0);
    else expect(Number(adminBody.data?.payoutReadiness?.payoutAmount)).toBeGreaterThanOrEqual(0);

    // Completion only returns 200 after service-completion-finance proves the journal balances.
    // Verify the separately authorized Finance surface also observes the captured/invoiced transaction,
    // rather than re-exposing raw finance rows on the provider-safe lifecycle response.
    const financeBody=await expectOk(await finance.get("/api/grooming-finance"),"finance completed transaction view");
    const financeItem=financeBody.items.find((item:{booking_id:string})=>item.booking_id===bookingId);
    expect(financeItem).toBeTruthy();
    expect(financeItem.invoice_status).toBe("issued");
    expect(Number(financeItem.gross_amount)).toBe(1899);
    expect(Number(financeItem.captured_amount)).toBe(1899);
    expect(financeItem.reconciliation_status).toBe("matched");
    expect(Number(financeItem.open_reconciliation_exceptions)).toBe(0);

    // Exchange a real local sandbox OTP for a customer session; provider/admin headers are removed.
    await page.setExtraHTTPHeaders({});await page.context().clearCookies();await page.goto("/mobile-app");
    await page.locator("nav").getByRole("button",{name:/account/i}).last().click();await page.getByPlaceholder("10-digit phone number").fill("9800000111");await page.getByRole("button",{name:"Send OTP",exact:true}).click();
    const sandbox=page.getByText(/Sandbox code \(no real SMS yet\):/i);await expect(sandbox).toBeVisible();const code=(await sandbox.textContent())?.match(/\b(\d{6})\b/)?.[1];expect(code).toMatch(/^\d{6}$/);await page.getByPlaceholder("6-digit code").fill(code!);
    const name=page.getByPlaceholder("Your name (first time only)");if(await name.isVisible().catch(()=>false))await name.fill("E2E UI Customer");
    await page.getByRole("button",{name:"Verify & continue",exact:true}).click();await expect(page.getByPlaceholder("6-digit code")).toBeHidden();
    // Verify the actual browser-owned customer cookie, but do not depend on the shell emitting one
    // particular hydration request at a specific moment (mobile Chromium can coalesce that fetch).
    await expect.poll(async()=>page.evaluate(async()=>{const response=await fetch("/api/customer-account",{cache:"no-store"});return response.ok?await response.json():null;}),{timeout:15000}).toMatchObject({data:{customerId:CUSTOMER_ID}});
    const ownAccountBody=await page.evaluate(async()=>{const response=await fetch("/api/customer-account",{cache:"no-store"});return response.ok?await response.json():null;}) as CustomerAccountView|null;
    expect(ownAccountBody?.data?.customerId).toBe(CUSTOMER_ID);
    await page.goto(`/grooming/manage?bookingId=${encodeURIComponent(bookingId)}`);
    const care=page.getByRole("region",{name:"Completed care summary",exact:true});await expect(care).toContainText("Persona E2E completed safely");await expect(care.getByRole("listitem")).toHaveText(["coat","nails","ears"]);await expect(care).toContainText(String(adminBody.data?.invoice?.invoiceNumber));
    const summary=await page.evaluate(async id=>{const response=await fetch(`/api/customer-grooming-summary?bookingId=${encodeURIComponent(id)}`,{cache:"no-store"});return{status:response.status,body:await response.json()};},bookingId);expect(summary.status).toBe(200);expect(summary.body.data.invoice.total).toBe(Number(financeItem.gross_amount));expect(summary.body.data.invoice.tax).toBe(Number(financeItem.tax_amount));expect(summary.body.data).not.toHaveProperty("payoutReadiness");
    await page.reload();await expect(care).toContainText("Persona E2E completed safely");await page.screenshot({path:test.info().outputPath(`customer-completed-care-${assignmentMode}.png`),fullPage:true});
    await page.goto("/mobile-app");
    await page.locator("nav").getByRole("button",{name:/activity/i}).last().click();
    await page.getByRole("button",{name:"History",exact:true}).click();
    const feedbackCard=page.getByRole("article",{name:`Feedback for booking ${bookingId}`,exact:true});
    await expect(feedbackCard).toBeVisible();
    const fourStarAnswers=feedbackCard.getByRole("button",{name:/4 out of 5$/});expect(await fourStarAnswers.count()).toBe(5);for(let i=0;i<5;i++)await fourStarAnswers.nth(i).click();
    await page.route("**/api/service-review",async route=>{if(route.request().method()==="POST")await route.fulfill({status:503,contentType:"application/json",body:JSON.stringify({error:"Feedback is temporarily unavailable. Please retry."})});else await route.continue();});
    await feedbackCard.getByRole("button",{name:"Submit feedback & receive reward",exact:true}).click();
    await expect(feedbackCard.getByRole("alert")).toContainText("Feedback is temporarily unavailable");await expect(feedbackCard).toBeVisible();
    await page.unroute("**/api/service-review");
    const savedFeedback=page.waitForResponse(response=>response.url().endsWith("/api/service-review")&&response.request().method()==="POST");
    await feedbackCard.getByRole("button",{name:"Submit feedback & receive reward",exact:true}).click();
    const feedbackResponse=await savedFeedback;expect(feedbackResponse.status()).toBe(201);const feedbackRequest=feedbackResponse.request().postDataJSON();expect(feedbackRequest.customerId).toBe(CUSTOMER_ID);expect(Object.keys(feedbackRequest.answers)).toHaveLength(5);expect(Object.values(feedbackRequest.answers)).toEqual([4,4,4,4,4]);const feedbackBody=await feedbackResponse.json();expect(feedbackBody.data.average).toBe(4);const rewardCode=String(feedbackBody.data.feedbackReward.code);expect(rewardCode).toMatch(/^FB-/);
    await expect(feedbackCard).toHaveCount(0);
    await page.reload();await page.locator("nav").getByRole("button",{name:/activity/i}).last().click();await page.getByRole("button",{name:"History",exact:true}).click();
    const persistedFeedback=await page.evaluate(async()=>{const response=await fetch("/api/service-review",{cache:"no-store"});return{status:response.status,body:await response.json()};});expect(persistedFeedback.status).toBe(200);expect(persistedFeedback.body.data.pending.some((item:{bookingId:string})=>item.bookingId===bookingId)).toBe(false);expect(persistedFeedback.body.data.rewards.some((item:{code:string})=>item.code===rewardCode)).toBe(true);
    await expect(feedbackCard).toHaveCount(0);await expect(page.getByText(bookingId,{exact:false}).first()).toBeVisible();
    await page.screenshot({path:test.info().outputPath(`customer-feedback-saved-${assignmentMode}.png`),fullPage:true});
    await page.context().clearCookies();
    await page.setExtraHTTPHeaders({ "oai-authenticated-user-email": ADMIN_EMAIL });
    const adminUi = await page.goto("/booking-command-center", { waitUntil: "domcontentloaded" });
    expect(adminUi?.status() ?? 500).toBeLessThan(500);
    await expect(page.locator("body")).toContainText(/booking/i);
  } finally {
    await Promise.all([customer.dispose(), provider?.dispose()??Promise.resolve(), admin.dispose(), finance.dispose()]);
  }
});
