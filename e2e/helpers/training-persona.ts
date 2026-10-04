import { expect, test, type Browser, type Page } from "@playwright/test";

const trainer = { id: "uatcap_train_east", name: "Arjun T. (UAT East)", phone: "9000000932" };
const fixtureDoorstep = { latitude: 12.9716, longitude: 77.5946 };
const fixturePng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=", "base64");

async function dismissPrivacy(page: Page) {
  await page.waitForLoadState("domcontentloaded");
  const hasChoice = await page.evaluate(() => window.localStorage.getItem("pawspace.cookie-consent.v1") !== null);
  if (hasChoice) return;
  const consent = page.getByRole("dialog", { name: "Cookie consent", exact: true });
  await expect(consent).toBeVisible();
  await consent.getByRole("button", { name: "Essential only", exact: true }).click();
  await expect(consent).toBeHidden();
}

function assertLocalSandbox(baseURL: string) {
  const origin = new URL(baseURL);
  expect(origin.protocol).toBe("http:");
  expect(["localhost", "127.0.0.1"]).toContain(origin.hostname);
  expect(process.env.PAWSPACE_DEPLOYMENT_ENV).toBe("e2e");
  expect(process.env.PAWSPACE_PAYMENT_ENV).toBe("sandbox");
  expect(process.env.PAWSPACE_PAYMENT_LIVE_APPROVED).toBe("false");
  expect(process.env.FORBID_PRODUCTION).toBe("true");
  return origin.origin;
}

async function fixtureTotp() {
  // The existing disposable seed-identities.mjs Finance fixture, never a hosted credential.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits = [..."JBSWY3DPEHPK3PXP"].map(ch => alphabet.indexOf(ch).toString(2).padStart(5, "0")).join("");
  const bytes = Uint8Array.from({ length: bits.length / 8 }, (_, i) => parseInt(bits.slice(i * 8, i * 8 + 8), 2));
  const counter = new Uint8Array(8);
  let value = Math.floor(Date.now() / 30_000);
  for (let i = 7; i >= 0; i--) { counter[i] = value & 255; value = Math.floor(value / 256); }
  const key = await crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter));
  const offset = signature[signature.length - 1] & 15;
  const code = ((signature[offset] & 127) << 24) | (signature[offset + 1] << 16) | (signature[offset + 2] << 8) | signature[offset + 3];
  return String(code % 1_000_000).padStart(6, "0");
}

/** Existing local dispatch identity, followed by real MFA verification; no manufactured session cookie. */
export async function openFixtureFinance(browser: Browser, baseURL: string): Promise<Page> {
  const origin = assertLocalSandbox(baseURL);
  const page = await browser.newPage({ baseURL: origin, extraHTTPHeaders: { "oai-authenticated-user-email": "e2e.finance@pawspace.test" } });
  try {
    const refused = await page.request.get("/api/training-finance");
    expect(refused.status()).toBe(401);
    expect(await refused.json()).toEqual({ error: "MFA required" });
    const checking = page.waitForResponse(r => r.url().endsWith("/api/v1/auth/mfa/enroll") && r.request().method() === "POST");
    await page.goto("/mfa?next=%2Fteam%2Ffinance");
    await dismissPrivacy(page);
    expect((await checking).status()).toBe(409);
    await page.getByLabel("6-digit authenticator code", { exact: true }).fill(await fixtureTotp());
    const verified = page.waitForResponse(r => r.url().endsWith("/api/v1/auth/mfa/verify") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Verify & continue", exact: true }).click();
    expect((await verified).status()).toBe(200);
    await page.waitForURL("**/team/finance");
    const authorized = await page.request.get("/api/training-finance");
    expect(authorized.status(), await authorized.text()).toBe(200);
    return page;
  } catch (error) { await page.close(); throw error; }
}

async function loginTrainer(page: Page) {
  await page.goto("/partner/onboarding"); await dismissPrivacy(page);
  await page.getByPlaceholder("10-digit phone number").fill(trainer.phone);
  await page.getByRole("button", { name: "Send OTP", exact: true }).click();
  const sandbox = page.getByText(/Sandbox code \(no real SMS yet\):/i);
  await expect(sandbox).toBeVisible();
  const code = (await sandbox.textContent())?.match(/\b(\d{6})\b/)?.[1];
  expect(code).toMatch(/^\d{6}$/);
  await page.getByPlaceholder("6-digit code").fill(code!);
  await page.getByRole("button", { name: "Verify & continue", exact: true }).click();
  await expect.poll(() => page.evaluate(async () => {
    const response = await fetch("/api/identity-session", { cache: "no-store" });
    return response.ok ? (await response.json()).data?.subjectId : null;
  })).toBe(trainer.id);
}

async function loginOperations(page: Page) {
  const access = process.env.PW_STAFF_UAT_ACCESS_CODE;
  expect(access).toBeTruthy();
  await page.goto("/staging-login"); await dismissPrivacy(page);
  await page.getByPlaceholder("shared UAT access code").fill(access!);
  const signedIn = page.waitForResponse(r => r.url().endsWith("/api/staging-login") && r.request().method() === "POST");
  await page.getByRole("button", { name: /Manager \(operations/ }).click();
  expect((await signedIn).status()).toBe(200);
  await page.waitForURL("**/booking-command-center");
  const persisted = await page.request.get("/api/staging-login");
  expect(persisted.status()).toBe(200);
  expect(await persisted.json()).toMatchObject({ signedInAs: { email: "jyoti.manager39@tkpetcare.in", role: "manager" } });
}

type TrainingPersonaInput = {
  page: Page; browser: Browser; baseURL: string;
  sandboxLogin: (page: Page, phone: string) => Promise<void>;
  ensureCustomerPet: (page: Page, vaccinationStatus: string) => Promise<void>;
};

export async function runTrainingPersona({ page, browser, baseURL, sandboxLogin, ensureCustomerPet }: TrainingPersonaInput) {
  const origin = assertLocalSandbox(baseURL);
  expect(process.env.PAWSPACE_TEST_SERVICE_DISCOVERY_FIXTURE).toBe("on");
  test.setTimeout(240_000);
  test.info().annotations.push({ type: "simulation", description: "Disposable Training Meet & Greet; normal customer/trainer OTP; Finance sandbox event; synthetic GPS/photo bytes with independent UAT release. Handover is a completion attestation, with no claim of elapsed 45/15-minute or scheduled-start enforcement." });
  const date = process.env.PW_UAT_SERVICE_DATE!;
  expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  const partner = await browser.newPage({ baseURL: origin, viewport: page.viewportSize()! });
  const operations = await browser.newPage({ baseURL: origin });
  let finance: Page | undefined;
  try {
    // Existing persona customer from customer-booking.spec.ts; its wrong-owner probe creates no pet.
    await sandboxLogin(page, "9000000913");
    // M&G explicitly allows a dog without vaccination proof. Paid programmes retain their separate gate.
    await ensureCustomerPet(page, "not_provided");
    const accountResponse = await page.request.get("/api/customer-account");
    expect(accountResponse.ok()).toBeTruthy();
    const account = (await accountResponse.json()).data;
    expect(account.pets).toHaveLength(1);
    expect(account.pets[0].vaccinationStatus).toBe("not_provided");
    const address = await page.request.post("/api/customer-account", { data: {
      action: "upsert_address", idempotencyKey: `training-address-${account.customerId}`,
      address: { label: "Home", line1: "42, Indiranagar Double Road", area: "Indiranagar", city: "Bengaluru", postalCode: "560038", isDefault: true },
    } });
    expect(address.ok(), await address.text()).toBeTruthy();
    await page.goto("/v2/training"); await dismissPrivacy(page);
    await page.getByLabel(/^First session date/).fill(date);
    await page.getByLabel("First session start (IST, on the hour)", { exact: true }).selectOption("13:00");
    await page.getByRole("button", { name: /Trainer Meet & Greet/ }).click();
    await expect(page.getByLabel("Payment mode")).toBeDisabled();
    await expect(page.getByLabel("Payment mode")).toHaveValue("prepaid");
    await expect(page.getByText(/trainer is available|trainers are available/)).toBeVisible();
    const created = page.waitForResponse(r => r.url().endsWith("/api/canonical-bookings") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Reserve trainer & continue to payment →", exact: true }).click();
    const createdResponse = await created;
    expect(createdResponse.status(), await createdResponse.text()).toBe(201);
    const booking = (await createdResponse.json()).data;
    const bookingId = String(booking.bookingId), paymentId = String(booking.paymentId);
    await expect(page.getByRole("region", { name: "Reserved training details" })).toContainText(trainer.name);
    await expect.poll(async () => (await page.request.get(`/api/training-programmes?bookingId=${encodeURIComponent(bookingId)}`)).status()).toBe(200);
    const programmeResponse = await page.request.get(`/api/training-programmes?bookingId=${encodeURIComponent(bookingId)}`);
    const programme = (await programmeResponse.json()).data;
    expect(programme.sessions).toHaveLength(1);
    expect(programme.programme).toMatchObject({ booking_id: bookingId, provider_id: trainer.id, plan_code: "trainer-meet-greet", total_sessions: 1 });
    const session = programme.sessions[0], sessionId = String(session.id);
    expect(session.status).toBe("scheduled");
    expect(new Date(session.scheduled_start).toISOString()).toBe(`${date}T07:30:00.000Z`);
    expect(new Date(session.scheduled_end).toISOString()).toBe(`${date}T08:30:00.000Z`);
    await loginTrainer(partner);
    const denied = await partner.request.post("/api/training-sessions", { data: { sessionId, action: "accept", idempotencyKey: `training-unpaid-${sessionId}` } });
    expect(denied.status(), await denied.text()).toBe(409);
    expect((await denied.json()).code).toBe("training_payment_required");
    const billing = await page.request.get("/api/customer-billing");
    expect(billing.ok()).toBeTruthy();
    const payment = (await billing.json()).data.payments.find((row: { id: string }) => row.id === paymentId);
    expect(payment.status).toBe("created");
    const amount = Number(payment.amount_due_now);
    expect(amount).toBeGreaterThan(0); expect(amount).toBe(Number(payment.amount));
    finance = await openFixtureFinance(browser, origin);
    const linked = await finance.request.post("/api/grooming-payment-sandbox", { data: { action: "link_order", bookingId, gatewayOrderId: `order_e2e_training_${bookingId}` } });
    expect(linked.status(), await linked.text()).toBe(201);
    const capture = { action: "simulate_event", bookingId, eventType: "payment.captured", eventId: `evt_e2e_training_${bookingId}`, gatewayPaymentId: `pay_e2e_training_${bookingId}`, amount, currency: "INR" };
    const captured = await finance.request.post("/api/grooming-payment-sandbox", { data: capture });
    expect(captured.status(), await captured.text()).toBe(201);
    expect((await captured.json()).data).toMatchObject({ synthetic: true, environment: "sandbox", result: { status: "processed", duplicate: false } });
    const replay = await finance.request.post("/api/grooming-payment-sandbox", { data: capture });
    expect(replay.status()).toBe(201); expect((await replay.json()).data.result.duplicate).toBe(true);
    await partner.goto(`/v2/partner/trainer?bookingId=${encodeURIComponent(bookingId)}&sessionId=${encodeURIComponent(sessionId)}`);
    const action = async (name: string, expectedAction: string) => {
      const pending = partner.waitForResponse(r => r.url().endsWith("/api/training-sessions") && r.request().method() === "POST" && r.request().postDataJSON()?.action === expectedAction);
      await partner.getByRole("button", { name, exact: true }).click();
      const response = await pending; expect(response.status(), await response.text()).toBe(200);
      return response;
    };
    const sessionsResponse = await partner.request.get(`/api/training-sessions?providerId=${encodeURIComponent(trainer.id)}`);
    expect(sessionsResponse.status(), await sessionsResponse.text()).toBe(200);
    const ownedSessions = (await sessionsResponse.json()).data;
    const ownedSession = ownedSessions.find((item: { id: string }) => item.id === sessionId);
    expect(ownedSession).toBeTruthy();
    expect(ownedSession.status).toBe("scheduled");
    if (ownedSession.providerModel === "full_time") {
      await expect(partner.getByRole("button", { name: "Accept", exact: true })).toHaveCount(0);
    } else {
      expect(ownedSession.providerModel).toBe("commission");
      await action("Accept", "accept");
    }
    await action("On the way", "on_the_way");
    // The server-owned explicit service-discovery fixture uses these coordinates; browser GPS is synthetic.
    const outside = await partner.request.post("/api/training-sessions", { data: { sessionId, action: "arrive", latitude: 13.1, longitude: 77.8, accuracyMeters: 5, idempotencyKey: `training-outside-${sessionId}` } });
    expect(outside.status()).toBe(409); expect((await outside.json()).code).toBe("training_outside_geofence");
    await partner.evaluate(({ latitude, longitude }) => Object.defineProperty(navigator, "geolocation", { configurable: true, value: { getCurrentPosition(success: (value: { coords: { latitude: number; longitude: number; accuracy: number } }) => void) { success({ coords: { latitude, longitude, accuracy: 5 } }); } } }), fixtureDoorstep);
    const arrived = await action("Confirm arrival with device GPS", "arrive");
    expect((await arrived.json()).data.geofence.distanceMeters).toBeLessThanOrEqual(250);
    await partner.getByLabel("Parent/caretaker attendance confirmed", { exact: true }).check();
    await partner.getByLabel("Training area is safe", { exact: true }).check();
    await expect(partner.getByRole("button", { name: "Start session", exact: true })).toBeDisabled();
    await action("Save attendance & safety", "save_report");
    const uploadPhoto = async (label: string) => {
      const input = partner.getByLabel(label, { exact: true });
      await expect(input).toBeEnabled();
      const registered = partner.waitForResponse(r => r.url().endsWith("/api/training-session-media") && r.request().method() === "POST" && r.request().postDataJSON()?.sessionId === sessionId);
      const uploaded = partner.waitForResponse(r => r.url().endsWith("/api/service-media/upload") && r.request().method() === "PUT");
      await input.setInputFiles({ name: `synthetic-${label.replaceAll(" ", "-")}.png`, mimeType: "image/png", buffer: fixturePng });
      const registration = await registered;
      expect(registration.status(), await registration.text()).toBe(201);
      expect(registration.request().postDataJSON().purpose).toBe(label === "Before photo" ? "before_service" : "after_service");
      expect((await registration.json()).data.upload.token).toBeTruthy();
      const uploadResponse = await uploaded; expect(uploadResponse.status(), await uploadResponse.text()).toBe(200);
      expect((await uploadResponse.json()).data.objectStored).toBe(false);
      await expect(partner.getByRole("button", { name: "Refresh photo approval", exact: true })).toBeEnabled();
    };
    await uploadPhoto("Before photo");
    await action("Start session", "start");
    await expect(partner.getByLabel("I completed the pet-parent handover", { exact: true })).toBeVisible();
    await expect(partner.getByLabel("Parent/caretaker attendance confirmed", { exact: true })).toBeChecked();
    const noHandover = await partner.request.post("/api/training-sessions", { data: { sessionId, action: "complete", idempotencyKey: `training-no-handover-${sessionId}` } });
    expect(noHandover.status()).toBe(409); expect((await noHandover.json()).code).toBe("training_owner_handover_required");
    const incompleteHandover = await partner.request.post("/api/training-sessions", { data: { sessionId, action: "owner_handover", ownerHandoverCompleted: false, idempotencyKey: `training-incomplete-handover-${sessionId}` } });
    expect(incompleteHandover.status()).toBe(409);
    expect((await incompleteHandover.json()).code).toBe("training_owner_handover_required");
    await expect(partner.getByRole("button", { name: "Confirm completed handover", exact: true })).toBeDisabled();
    await loginOperations(operations);
    await partner.getByLabel("I completed the pet-parent handover", { exact: true }).check();
    const handover = await action("Confirm completed handover", "owner_handover");
    expect(handover.request().postDataJSON().ownerHandoverCompleted).toBe(true);
    await expect(partner.getByText("Pet-parent handover completion recorded.", { exact: true })).toBeVisible();
    await uploadPhoto("After photo");
    const media = await partner.request.get(`/api/training-session-media?sessionId=${encodeURIComponent(sessionId)}`);
    expect(media.ok()).toBeTruthy(); const assets = (await media.json()).data.assets;
    expect(assets).toHaveLength(2);
    expect(assets.map((row: { purpose: string }) => row.purpose).sort()).toEqual(["after_service", "before_service"]);
    for (const asset of assets) {
      expect(asset.proofReady).toBe(false); expect(asset.objectStored).toBe(false);
      const review = { action: "record_review", id: asset.id, decision: "approved", reason: "Independent review of synthetic local Training image bytes" };
      const selfReview = await partner.request.patch("/api/training-session-media", { data: review }); expect(selfReview.status()).toBe(403);
      const approved = await operations.request.patch("/api/training-session-media", { data: review });
      expect(approved.status(), await approved.text()).toBe(200); expect((await approved.json()).data.proofReady).toBe(true);
    }
    await partner.getByRole("button", { name: "Refresh photo approval", exact: true }).click();
    await expect(partner.getByText(/Approved — hash only/)).toHaveCount(2);
    await partner.getByLabel("Homework for pet parent", { exact: true }).fill("Practise the demonstrated cue briefly with praise and supervised rest.");
    const unassessedLabels = ["Recall score", "Impulse score", "Parent practice score"];
    await expect(partner.getByLabel("Focus score", { exact: true })).toHaveValue("");
    for (const label of unassessedLabels) await expect(partner.getByLabel(label, { exact: true })).toHaveValue("");
    await expect(partner.getByRole("button", { name: "Complete & consume one session", exact: true })).toBeDisabled();
    await partner.getByLabel("Focus score", { exact: true }).selectOption("7");
    for (const label of unassessedLabels) await expect(partner.getByLabel(label, { exact: true })).toHaveValue("");
    const expectedProgress = { focus: 7, recall: null, impulse: null, parent: null };
    const saved = await action("Save report", "save_report");
    expect(saved.request().postDataJSON().report.progress).toEqual(expectedProgress);
    // Provider projection omits nulls; read the customer's owned canonical session to prove storage preserves them.
    const persistedProgress = async () => {
      const response = await page.request.get(`/api/training-programmes?bookingId=${encodeURIComponent(bookingId)}`);
      expect(response.status(), await response.text()).toBe(200);
      const rows = (await response.json()).data.sessions.filter((row: { id: string }) => row.id === sessionId);
      expect(rows).toHaveLength(1);
      return JSON.parse(rows[0].progress_json);
    };
    expect(await persistedProgress()).toEqual(expectedProgress);
    await expect(partner.getByLabel("Focus score", { exact: true })).toHaveValue("7");
    for (const label of unassessedLabels) await expect(partner.getByLabel(label, { exact: true })).toHaveValue("");
    const completion = await action("Complete & consume one session", "complete");
    const completed = (await completion.json()).data;
    expect(completion.request().postDataJSON().report.progress).toEqual(expectedProgress);
    expect(await persistedProgress()).toEqual(expectedProgress);
    expect(completed).toMatchObject({ status: "completed", consumedExactlyOnce: true, programme: { completed: 1, status: "completed" }, closure: { assessmentCompleted: true, certificateNumber: null, reviewDispatched: false } });
    const repeat = await partner.request.post("/api/training-sessions", { data: completion.request().postDataJSON() });
    expect(repeat.status(), await repeat.text()).toBe(200); expect((await repeat.json()).data.duplicatePrevented).toBe(true);
    await partner.reload(); await expect(partner.getByRole("heading", { name: "Session completed canonically", exact: true })).toBeVisible();
    const finalAccount = await page.request.get("/api/customer-account"); expect(finalAccount.ok()).toBeTruthy();
    const bookings = (await finalAccount.json()).data.bookings.filter((row: { id: string }) => row.id === bookingId);
    expect(bookings).toHaveLength(1); expect(bookings[0]).toMatchObject({ status: "completed", providerId: trainer.id });
    const finalBilling = await page.request.get("/api/customer-billing"); expect(finalBilling.ok()).toBeTruthy();
    const paid = (await finalBilling.json()).data.payments.filter((row: { id: string }) => row.id === paymentId);
    expect(paid).toHaveLength(1); expect(paid[0]).toMatchObject({ status: "captured", gateway: "razorpay_sandbox" }); expect(Number(paid[0].amount)).toBe(amount);
    const opsFinance = await operations.request.get("/api/training-finance"); expect(opsFinance.status()).toBe(403);
    const financeRead = await finance.request.get("/api/training-finance"); expect(financeRead.status(), await financeRead.text()).toBe(200);
    const truth = (await financeRead.json()).data;
    expect(truth).toMatchObject({ livePayout: false, executionMode: "sandbox_not_connected" });
    const invoice = truth.invoices.find((row: { booking_id: string }) => row.booking_id === bookingId);
    expect(invoice.payment_status).toBe("FULLY_PAID"); expect(Number(invoice.commercial_total)).toBe(amount);
    const earnings = truth.earnings.filter((row: { session_id: string }) => row.session_id === sessionId);
    expect(earnings).toHaveLength(1); expect(earnings[0]).toMatchObject({ status: "pending_rate_configuration", gross_earning: null });
    const reconciled = await finance.request.get("/api/training-reconciliation"); expect(reconciled.status(), await reconciled.text()).toBe(200);
    const record = (await reconciled.json()).data.records.find((row: { bookingId: string }) => row.bookingId === bookingId);
    expect(record).toMatchObject({ status: "reconciled", issues: [], programmeStatus: "completed", bookingStatus: "completed", paymentStatus: "captured", sessions: { expected: 1, actual: 1, completed: 1, consumed: 1, earnings: 1 } });
    await finance.goto("/v2/team/finance/training"); await expect(finance.getByRole("heading", { name: "Training finance & payout readiness", exact: true })).toBeVisible();
    await partner.screenshot({ path: test.info().outputPath("training-trainer-completed.png"), fullPage: true });
    await finance.screenshot({ path: test.info().outputPath("training-finance-completed.png"), fullPage: true });
    const receipt = { bookingId, paymentId, sessionId, providerId: trainer.id, customerStatus: "completed", partnerStatus: "completed", paymentStatus: "captured", gateway: "razorpay_sandbox", reconciliation: record.status, ownerHandoverCompletionAttested: true, elapsedDurationEnforced: false, scheduledStartEnforced: false, evidenceStorage: "hash_only", liveMoney: false };
    console.log("TRAINING-PERSISTENT", JSON.stringify(receipt));
    return receipt;
  } finally { await Promise.allSettled([partner.close(), operations.close(), finance?.close()]); }
}
