import { expect, test, type APIResponse, type Browser, type BrowserContext, type Page, type Response as BrowserResponse } from "@playwright/test";
import { createHmac } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

type Inputs = {
  page: Page;
  browser: Browser;
  baseURL?: string;
  sandboxLogin: (page: Page, phone: string) => Promise<void>;
  ensureCustomerPet: (page: Page, vaccinationStatus?: string) => Promise<void>;
};
type Session = { id: string; status: string; handover_status: string; completion_status: string; updated_at: number };
type Payment = { id: string; session_id: string; amount: number; status: string; gateway?: string; reference?: string | null };
type Walk = { id: string; status: string; provider_id: string; work_order_status: string; payment_status: string; sessions: Session[]; sessionPayments: Payment[] };
type Finance = { booking: { status: string; payment_status: string }; sessions: Array<{ id: string; payment_event_status: string; payment_reference: string | null }>; settlement: null | { eligible_at: number; approval_status: string; payout_status: string; payout_rule_status: string; tax_status: string }; reconciliation: null | { status: string; paid_total: number; unpaid_completed_total: number; tax_state: string } };

// Existing documented identities in scripts/uat-staging-provider-capacity.sql. The local persona
// fixture binds these phones and publishes 06:00–21:00 source='roster' on PW_UAT_SERVICE_DATE.
const WALKER_PHONES: Record<string, string> = { walk_asha: "9000000986", walk_kiran: "9000000987", walk_nisha: "9000000989" };
// New disposable local-only customer fixtures defined by this helper, not recovered prior-build
// identities. The supported persona runner pins the Worker to e2e: production SMS requires
// deployment=production and staging SMS requires deployment=staging (customer-otp-exchange.ts).
const CUSTOMER_PHONES = { desktop: "9000000661", mobile: "9000000662" };
const TIMING_QUALIFICATION = "Recorded synthetic Walking lifecycle only. Current Walking start/completion do not enforce a scheduled window or elapsed package duration; this test does not certify a real 30-minute walk or decide the intended timing policy.";
const PAYMENT_UI_QUALIFICATION = "V2 shows Pay after completed walk and zero due now on the booking form. It has no separate payment-review or pay-after acceptance step; this test exercises the current Reserve walks action and verifies its actual pay_after_service request.";

/** Read only the exact local booking snapshot; never substitute the Places display coordinates. */
export function readLocalWalkingDoorstep(input: { bookingId: string; scheduleGroupId: string; customerId: string }, fixtureRoot = process.cwd()) {
  const matches: Array<{ latitude: number; longitude: number }> = [];
  for (const relative of [".wrangler/state/v3/d1/miniflare-D1DatabaseObject", "dist/server/.wrangler/state/v3/d1/miniflare-D1DatabaseObject"]) {
    const directory = join(fixtureRoot, relative);
    let files;
    try { files = readdirSync(directory, { withFileTypes: true }).filter(file => file.isFile() && file.name.endsWith(".sqlite") && file.name !== "metadata.sqlite"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    expect(files.length, "disposable D1 discovery must stay bounded").toBeLessThanOrEqual(16);
    for (const file of files) {
      const db = new DatabaseSync(join(directory, file.name), { readOnly: true });
      try {
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('canonical_bookings','scheduling_assignment_decisions')").all();
        if (tables.length !== 2) continue;
        const row = db.prepare("SELECT d.shortlist_json FROM canonical_bookings b JOIN scheduling_assignment_decisions d ON d.group_id=b.schedule_group_id WHERE b.id=? AND b.schedule_group_id=? AND b.customer_id=? AND b.service_code='dog_walking'").get(input.bookingId, input.scheduleGroupId, input.customerId);
        if (!row) continue;
        const request = JSON.parse(String(row.shortlist_json)).request;
        expect(request.customerId).toBe(input.customerId); expect(request.serviceCode).toBe("dog_walking");
        expect(typeof request.latitude).toBe("number"); expect(typeof request.longitude).toBe("number");
        const latitude = Number(request.latitude), longitude = Number(request.longitude);
        expect(Number.isFinite(latitude) && Math.abs(latitude) <= 90).toBe(true);
        expect(Number.isFinite(longitude) && Math.abs(longitude) <= 180).toBe(true);
        matches.push({ latitude, longitude });
      } finally { db.close(); }
    }
  }
  expect(matches, "exactly one canonical local Walking doorstep must exist").toHaveLength(1);
  return matches[0];
}

async function dismissPrivacy(page: Page) {
  await page.waitForLoadState("domcontentloaded");
  // CookieConsent renders nothing on the server. Read its existing choice without changing it;
  // if unset, wait for the real hydrated dialog instead of skipping a not-yet-visible banner.
  const hasChoice = await page.evaluate(() => window.localStorage.getItem("pawspace.cookie-consent.v1") !== null);
  if (hasChoice) return;
  const consent = page.getByRole("dialog", { name: "Cookie consent", exact: true });
  await expect(consent).toBeVisible();
  await consent.getByRole("button", { name: "Essential only", exact: true }).click();
  await expect(consent).toBeHidden();
}

async function localOnly(context: BrowserContext, origin: string, denied: string[]) {
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.continue();
    denied.push(url.origin);
    await route.abort("blockedbyclient");
  });
}

async function okJson(response: APIResponse | BrowserResponse, status = 200) {
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

function nextPost(page: Page, path: string, action?: string) {
  return page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === "POST"
    && (!action || response.request().postDataJSON()?.action === action));
}

function fixtureTotp() {
  // Same public synthetic fixture as seed-identities.mjs; no production secret or copied MFA cookie.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits = [..."JBSWY3DPEHPK3PXP"].map(char => alphabet.indexOf(char).toString(2).padStart(5, "0")).join("");
  const key = Buffer.from(bits.match(/.{8}/g)!.map(byte => parseInt(byte, 2)));
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const signature = createHmac("sha1", key).update(counter).digest(), offset = signature[signature.length - 1] & 15;
  return String((signature.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

async function signInFixtureFinance(page: Page, bookingId: string) {
  const code = process.env.PW_STAFF_UAT_ACCESS_CODE;
  expect(code, "local runner must supply its synthetic staff access code").toBeTruthy();
  await page.goto("/staging-login"); await dismissPrivacy(page);
  await page.getByPlaceholder("shared UAT access code").fill(code!);
  await page.getByPlaceholder("seeded staff email (e.g. founder@pawspace.in)").fill("e2e.finance@pawspace.test");
  const signedIn = nextPost(page, "/api/staging-login");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  expect((await signedIn).status()).toBe(200);
  // Finance identities follow the application's MFA redirect, including custom seeded identities.
  await page.waitForURL("**/mfa?next=%2Fteam%2Ffinance");
  const session = await okJson(await page.request.get("/api/staging-login", { maxRedirects: 0 }));
  expect(session).toMatchObject({ enabled: true, signedInAs: { email: "e2e.finance@pawspace.test", role: "finance" } });
  const beforeMfa = await page.request.get(`/api/walking-finance?bookingId=${encodeURIComponent(bookingId)}`, { maxRedirects: 0 });
  expect(beforeMfa.status()).toBe(401); expect(await beforeMfa.json()).toEqual({ error: "MFA required" });
  await expect(page.getByRole("heading", { name: "Verify your authenticator code", exact: true })).toBeVisible();
  await page.getByLabel("6-digit authenticator code", { exact: true }).fill(fixtureTotp());
  const verified = nextPost(page, "/api/v1/auth/mfa/verify");
  await page.getByRole("button", { name: "Verify & continue", exact: true }).click();
  expect((await verified).status()).toBe(200); await page.waitForURL("**/team/finance");
  const fresh = await okJson(await page.request.get("/api/staging-login", { maxRedirects: 0 }));
  expect(fresh.signedInAs).toMatchObject({ email: "e2e.finance@pawspace.test", role: "finance" });
}

/** Register from customer-booking.spec.ts; all mutations reach the local application and real D1. */
export async function runWalkingPersona({ page, browser, baseURL, sandboxLogin, ensureCustomerPet }: Inputs) {
  test.setTimeout(240_000);
  const origin = new URL(baseURL || "http://localhost:4185").origin;
  expect(new URL(origin).protocol).toBe("http:");
  expect(["localhost", "127.0.0.1", "[::1]"]).toContain(new URL(origin).hostname);
  expect(process.env.PAWSPACE_DEPLOYMENT_ENV).toBe("e2e"); expect(process.env.FORBID_PRODUCTION).toBe("true");
  expect(process.env.PAWSPACE_PAYMENT_ENV).toBe("sandbox"); expect(process.env.PAWSPACE_PAYMENT_LIVE_APPROVED).toBe("false");
  expect(process.env.PAWSPACE_TEST_SERVICE_DISCOVERY_FIXTURE).toBe("on");
  const date = String(process.env.PW_UAT_SERVICE_DATE || ""); expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  test.info().annotations.push({ type: "simulation", description: "Local D1; newly defined disposable customer phones 9000000661/9000000662; real sandbox OTP; synthetic GPS/proof; separate Finance sandbox payment record; no live payment or provider transport." }, { type: "timing-limitation", description: TIMING_QUALIFICATION }, { type: "payment-ui-limitation", description: PAYMENT_UI_QUALIFICATION });
  const deniedOrigins: string[] = [];
  await localOnly(page.context(), origin, deniedOrigins);
  const contexts: BrowserContext[] = [];
  try {
    // Establish privacy through the ordinary V2 UI before the shared sandbox-login helper clicks.
    await page.goto("/v2/walking"); await dismissPrivacy(page);
    const customerPhone = test.info().project.name.includes("mobile") ? CUSTOMER_PHONES.mobile : CUSTOMER_PHONES.desktop;
    const customerOtp = nextPost(page, "/api/customer-otp", "request").then(response => okJson(response));
    await sandboxLogin(page, customerPhone);
    expect((await customerOtp).data).toMatchObject({ phone: customerPhone, sandboxDelivery: true, liveSmsDelivered: false });
    await dismissPrivacy(page); await ensureCustomerPet(page, "verified");
    const initialAccount = await okJson(await page.request.get("/api/customer-account", { maxRedirects: 0 }));
    const dog = initialAccount.data.pets.find((pet: { species: string }) => pet.species === "dog");
    expect(dog, "customer must own a real saved dog").toBeTruthy();
    expect(dog.vaccinationStatus).toBe("verified");
    await page.goto("/v2/walking"); await dismissPrivacy(page);
    await expect(page.locator("main[data-v2-walking='true']")).toBeVisible();
    await expect(page.getByRole("heading", { name: "How often should we walk?", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "One-time walk", exact: true }).click();
    await page.getByRole("combobox", { name: "Pet", exact: true }).selectOption(dog.id);
    await page.getByRole("combobox", { name: "Walk duration", exact: true }).selectOption("30");
    await page.getByLabel("Start from", { exact: true }).fill(date);
    await page.getByRole("button", { name: /^7:00 AM\b/ }).click();
    await page.getByLabel("Walking & safety instructions").fill("Use the red harness. Avoid busy roads. Synthetic local care instructions.");
    await page.getByRole("combobox", { name: "Handover preference", exact: true }).selectOption("owner");
    const orderSummary = page.getByRole("complementary", { name: "Walking order summary", exact: true });
    const reserve = orderSummary.getByRole("button", { name: "Reserve walks →", exact: true });
    await expect(reserve, "booking stays disabled until the real service-zone check accepts the address").toBeDisabled();
    // Reject the optional Places transport before it reaches a configured Google key. The normal
    // typed-address fallback still calls the real service-zone endpoint; scheduling independently
    // resolves the server-owned local discovery fixture. No application response is fabricated.
    await page.route("**/api/address-autocomplete?*", route => route.abort("blockedbyclient"));
    await page.locator("#grooming-address-line-1").fill("42, Indiranagar Double Road, Bengaluru 560038");
    await expect(page.getByText("Service area matched - doorstep not map verified", { exact: true })).toBeVisible();
    await expect(page.getByText("✓ Pay after completed walk", { exact: true })).toBeVisible();
    await expect(orderSummary).toContainText("One-time walk · 30 min");
    await orderSummary.getByText("Quote details", { exact: true }).click();
    await expect(orderSummary).toContainText(/Quote .+ · ₹0 due now · scheduler verifies final walker/);
    await expect(reserve).toBeEnabled();
    const assigned = nextPost(page, "/api/uat-scheduling"), created = nextPost(page, "/api/walking-bookings");
    await reserve.click();
    const schedule = (await okJson(await assigned)).data;
    expect(schedule.status).toBe("assigned");
    const createdResponse = await created, result = (await okJson(createdResponse, 201)).data;
    const submitted = createdResponse.request().postDataJSON();
    const bookingId = String(result.bookingId), sessionId = String(result.sessions[0]?.id), providerId = String(schedule.provider.id);
    expect(bookingId).toMatch(/^PS-UAT-WALK-/); expect(result.sessions).toHaveLength(1); expect(sessionId).not.toBe("");
    expect(submitted.provider.id).toBe(providerId); expect(WALKER_PHONES[providerId], "scheduler must select a documented local walker").toBeTruthy();
    expect(result.amountDueNow).toBe(0); expect(result.liveMoney).toBe(false); expect(result.status).toBe("confirmed");
    expect(result.totalAmount).toBeGreaterThan(0); expect(result.perWalkAmount).toBe(result.totalAmount);
    expect(submitted.payment.mode).toBe("pay_after_service");
    expect(Date.parse(result.sessions[0].scheduledStart)).toBe(Date.parse(`${date}T07:00:00+05:30`));
    expect(Date.parse(result.sessions[0].scheduledEnd) - Date.parse(result.sessions[0].scheduledStart)).toBe(30 * 60_000);
    await expect(page.getByText(bookingId, { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: `${dog.name}'s walk schedule is created.`, exact: true })).toBeVisible();
    await expect(page.getByText("₹0 due now · pay after each completed UAT walk", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Manage walks", exact: true })).toHaveAttribute("href", `/v2/walking/manage?bookingId=${encodeURIComponent(bookingId)}`);
    await expect(page.getByText(schedule.provider.name, { exact: false }).first()).toBeVisible();
    const doorstep = readLocalWalkingDoorstep({ bookingId, scheduleGroupId: result.scheduleGroupId, customerId: result.customerId });
    const walkerContext = await browser.newContext({ baseURL: origin, viewport: page.viewportSize() || undefined, permissions: ["geolocation"], geolocation: doorstep });
    contexts.push(walkerContext); await localOnly(walkerContext, origin, deniedOrigins);
    const walker = await walkerContext.newPage();
    await walker.goto("/partner/onboarding"); await dismissPrivacy(walker);
    await walker.getByPlaceholder("10-digit phone number").fill(WALKER_PHONES[providerId]);
    const otpSent = nextPost(walker, "/api/partner-otp", "request");
    await walker.getByRole("button", { name: "Send OTP", exact: true }).click();
    expect((await okJson(await otpSent)).data).toMatchObject({ phone: WALKER_PHONES[providerId], sandboxDelivery: true, liveSmsDelivered: false });
    const codeText = walker.getByText(/Sandbox code \(no real SMS yet\):/i); await expect(codeText).toBeVisible();
    const otp = (await codeText.textContent())?.match(/\b(\d{6})\b/)?.[1]; expect(otp).toMatch(/^\d{6}$/);
    await walker.getByPlaceholder("6-digit code").fill(otp!);
    const otpVerified = nextPost(walker, "/api/partner-otp", "verify");
    await walker.getByRole("button", { name: "Verify & continue", exact: true }).click(); expect((await otpVerified).status()).toBe(200);
    await expect.poll(() => walker.evaluate(async () => { const response = await fetch("/api/identity-session", { cache: "no-store" }); return response.ok ? (await response.json()).data?.subjectId : null; })).toBe(providerId);
    await walker.goto(`/v2/partner/walker?bookingId=${encodeURIComponent(bookingId)}`); await dismissPrivacy(walker);
    await expect(walker.getByRole("heading", { name: bookingId, exact: true })).toBeVisible();
    const readWalk = async (): Promise<Walk> => {
      const body = await okJson(await page.request.get(`/api/walking-lifecycle?scope=customer&bookingId=${encodeURIComponent(bookingId)}`, { maxRedirects: 0 }));
      expect(body.data).toHaveLength(1); return body.data[0];
    };
    const state = async () => { const walk = await readWalk(); return { status: walk.status, provider: walk.provider_id, workOrder: walk.work_order_status, payment: walk.payment_status, sessions: walk.sessions.map(item => ({ id: item.id, status: item.status, handover: item.handover_status, completion: item.completion_status })), payments: walk.sessionPayments }; };
    let key = 0;
    const postLifecycle = (action: string, detail: Record<string, unknown> = {}) => walker.request.post("/api/walking-lifecycle", { data: { bookingId, sessionId, action, idempotencyKey: `walking-persona:${bookingId}:${++key}:${action}`, ...detail }, maxRedirects: 0 });
    const refusals: string[] = [];
    async function refuse(label: string, action: string, detail: Record<string, unknown>, message: RegExp) {
      const before = await state(), response = await postLifecycle(action, detail);
      expect(response.status(), await response.text()).toBe(409); expect(await response.text()).toMatch(message);
      expect(await state()).toEqual(before); refusals.push(label);
    }
    await refuse("walker acceptance required", "start_walk", doorstep, /assigned/);
    const acceptance = nextPost(walker, "/api/walking-lifecycle", "accept");
    await walker.getByRole("button", { name: "Accept canonical schedule", exact: true }).click();
    expect((await okJson(await acceptance)).data).toMatchObject({ bookingId, status: "assigned", providerId });
    await refuse("owner handover required", "start_walk", doorstep, /Confirmed handover/);
    const handover = nextPost(walker, "/api/walking-lifecycle", "confirm_handover");
    await walker.getByRole("button", { name: "Confirm owner handover · UAT", exact: true }).click();
    expect((await okJson(await handover)).data).toMatchObject({ status: "ready_to_start", handoverStatus: "complete", otpConnected: false });
    await refuse("GPS coordinate required", "start_walk", {}, /latitude and longitude/);
    await refuse("250 m geofence enforced", "start_walk", { ...doorstep, latitude: doorstep.latitude + 1200 / 111_320 }, /start requires <=250m/);
    await expect(walker.getByText("Use the red harness. Avoid busy roads. Synthetic local care instructions.", { exact: true })).toBeVisible();
    const started = nextPost(walker, "/api/walking-lifecycle", "start_walk");
    await walker.getByRole("button", { name: "Start walk", exact: true }).click();
    expect((await okJson(await started)).data).toMatchObject({ status: "in_progress", thresholdMeters: 250, telemetryMode: "deterministic_sandbox" });
    const care = nextPost(walker, "/api/walking-lifecycle", "walk_event"); await walker.getByRole("button", { name: "Care update", exact: true }).click();
    expect((await okJson(await care)).data.eventType).toBe("general_update");
    await refuse("zero route samples refused", "complete_walk", {}, /at least two canonical sandbox route samples/);
    await expect(walker.getByRole("button", { name: "Complete walk · create payment-due event", exact: true })).toBeDisabled();
    await walker.getByRole("link", { name: "⌖ Route & proof", exact: true }).click();
    await expect(walker).toHaveURL(`${origin}/v2/partner/walker/proof?bookingId=${encodeURIComponent(bookingId)}&sessionId=${encodeURIComponent(sessionId)}`);
    await expect(walker.getByRole("heading", { name: "Sandbox route evidence", exact: true })).toBeVisible();
    for (let index = 0; index < 2; index++) {
      await walker.getByPlaceholder("Latitude", { exact: true }).fill(String(doorstep.latitude + index * 20 / 111_320));
      await walker.getByPlaceholder("Longitude", { exact: true }).fill(String(doorstep.longitude));
      await walker.getByPlaceholder("Accuracy metres", { exact: true }).fill("10");
      const sample = nextPost(walker, "/api/walking-proof", "record_location_sample");
      await walker.getByRole("button", { name: "Record sandbox route sample", exact: true }).click();
      expect((await okJson(await sample)).data).toMatchObject({ status: "recorded", environment: "sandbox", productionVerified: false });
      await expect(walker.getByText(`Samples for this walk: ${index + 1}`, { exact: true })).toBeVisible();
      if (index === 0) await refuse("one route sample refused", "complete_walk", {}, /at least two canonical sandbox route samples/);
    }
    const proof = (await okJson(await walker.request.get(`/api/walking-proof?bookingId=${encodeURIComponent(bookingId)}`, { maxRedirects: 0 }))).data;
    expect(proof.productionGpsConnected).toBe(false); expect(proof.routeEnvironment).toBe("sandbox_unverified");
    expect(proof.routeSamples.filter((item: { session_id: string }) => item.session_id === sessionId)).toHaveLength(2);
    await walker.getByRole("link", { name: "← Walker workspace", exact: true }).click();
    await expect(walker).toHaveURL(`${origin}/v2/partner/walker?bookingId=${encodeURIComponent(bookingId)}`);
    const completedResponse = nextPost(walker, "/api/walking-lifecycle", "complete_walk");
    await walker.getByRole("button", { name: "Complete walk · create payment-due event", exact: true }).click();
    const completionResponse = await completedResponse, completion = (await okJson(completionResponse)).data;
    expect(completion).toMatchObject({ bookingId, sessionId, status: "completed", paymentStatus: "due", amount: result.perWalkAmount, allComplete: true, liveMoney: false, routeSamples: 2, payout: "accrued", tax: "resolved" });
    expect(completion.finance).toMatchObject({ providerId, ledgerStatus: "balanced", payoutStatus: "accrued", taxStatus: "resolved" });
    const duplicate = await okJson(await walker.request.post("/api/walking-lifecycle", { data: completionResponse.request().postDataJSON(), maxRedirects: 0 }));
    expect(duplicate.data.duplicatePrevented).toBe(true);
    const finished = await readWalk(); expect(finished.status).toBe("completed"); expect(finished.work_order_status).toBe("completed");
    expect(finished.sessions).toHaveLength(1); expect(finished.sessions[0].status).toBe("completed");
    expect(finished.sessionPayments).toHaveLength(1); expect(finished.sessionPayments[0]).toMatchObject({ session_id: sessionId, status: "due", amount: result.perWalkAmount, reference: null, gateway: "uat_sandbox" });
    await walker.reload(); await expect(walker.getByRole("button", { name: "Start walk", exact: true })).toBeDisabled();
    await expect(walker.getByRole("button", { name: "Complete walk · create payment-due event", exact: true })).toBeDisabled();
    await page.goto(`/v2/walking/manage?bookingId=${encodeURIComponent(bookingId)}`); await dismissPrivacy(page);
    await expect(page.getByText(`Walk 1 · completed`, { exact: true })).toBeVisible(); await page.reload();
    await expect(page.getByText(`Walk 1 · completed`, { exact: true })).toBeVisible();
    const financeContext = await browser.newContext({ baseURL: origin, viewport: page.viewportSize() || undefined });
    contexts.push(financeContext); await localOnly(financeContext, origin, deniedOrigins);
    const finance = await financeContext.newPage();
    await signInFixtureFinance(finance, bookingId);
    const readFinance = async (): Promise<Finance> => (await okJson(await finance.request.get(`/api/walking-finance?bookingId=${encodeURIComponent(bookingId)}`, { maxRedirects: 0 }))).data;
    const due = await readFinance(); expect(due.booking.payment_status).toBe("created"); expect(due.sessions[0].payment_event_status).toBe("due");
    const providerFinance = await walker.request.post("/api/walking-finance", { data: { bookingId, action: "record_session_payment", sessionId, paymentReference: "LOCAL-UNAUTHORIZED", idempotencyKey: `walking-provider-finance:${bookingId}` }, maxRedirects: 0 });
    expect(providerFinance.status()).toBe(403); expect((await readFinance()).sessions[0].payment_event_status).toBe("due");
    const unpaidSettlement = await finance.request.post("/api/walking-finance", { data: { bookingId, action: "prepare_settlement", idempotencyKey: `walking-unpaid:${bookingId}` }, maxRedirects: 0 });
    expect(unpaidSettlement.status(), await unpaidSettlement.text()).toBe(409); expect(await unpaidSettlement.text()).toContain("sandbox-paid");
    await finance.goto(`/v2/team/finance/walking?bookingId=${encodeURIComponent(bookingId)}`); await dismissPrivacy(finance);
    await expect(finance.getByRole("heading", { name: "Walking payment & reconciliation", exact: true })).toBeVisible();
    await expect(finance.getByPlaceholder("Canonical Walking booking ID")).toHaveValue(bookingId);
    const paymentReference = `LOCAL-WALK-PAY-${bookingId}`;
    finance.once("dialog", dialog => dialog.accept(paymentReference));
    const paid = nextPost(finance, "/api/walking-finance", "record_session_payment");
    await finance.getByRole("button", { name: "Record sandbox payment", exact: true }).click();
    const paidResponse = await paid, paidData = (await okJson(paidResponse)).data;
    expect(paidData).toMatchObject({ status: "sandbox_paid", aggregateStatus: "paid", amount: result.perWalkAmount, liveMoney: false });
    const paidReplay = await okJson(await finance.request.post("/api/walking-finance", { data: paidResponse.request().postDataJSON(), maxRedirects: 0 }));
    expect(paidReplay.data.duplicatePrevented).toBe(true);
    const prepared = nextPost(finance, "/api/walking-finance", "prepare_settlement");
    await finance.getByRole("button", { name: "Prepare settlement readiness", exact: true }).click();
    const readiness = (await okJson(await prepared)).data;
    expect(readiness).toMatchObject({ status: "awaiting_finance_approval", payoutRule: "canonical_provider_payable", tax: "resolved", payout: "accrued" });
    expect(Number(readiness.eligibleAt) - Number(finished.sessions[0].updated_at)).toBe(7 * 86_400_000);
    const held = nextPost(finance, "/api/walking-finance", "approve_settlement");
    await finance.getByRole("button", { name: "Approve provider payable", exact: true }).click();
    const heldResponse = await held; expect(heldResponse.status(), await heldResponse.text()).toBe(409);
    expect(await heldResponse.text()).toContain("7 days after the last walk");
    await expect(finance.getByRole("alert")).toContainText("7 days after the last walk");
    const reconciled = nextPost(finance, "/api/walking-finance", "reconcile");
    await finance.getByRole("button", { name: "Run reconciliation", exact: true }).click();
    expect((await okJson(await reconciled)).data).toMatchObject({ status: "attention_required", paidTotal: result.totalAmount, unpaidCompletedTotal: 0, settlementState: "awaiting_finance_approval", taxState: "resolved" });
    const finalFinance = await readFinance(); expect(finalFinance.sessions).toHaveLength(1);
    expect(finalFinance.booking).toMatchObject({ status: "completed", payment_status: "paid" });
    expect(finalFinance.sessions[0]).toMatchObject({ id: sessionId, payment_event_status: "sandbox_paid", payment_reference: paymentReference });
    expect(finalFinance.settlement).toMatchObject({ approval_status: "awaiting_finance_approval", payout_status: "accrued", tax_status: "resolved" });
    await finance.reload(); await expect(finance.getByText("awaiting finance approval · payout accrued · tax resolved", { exact: true })).toBeVisible();
    const account = await okJson(await page.request.get("/api/customer-account", { maxRedirects: 0 }));
    const saved = account.data.bookings.filter((item: { id: string }) => item.id === bookingId);
    expect(saved).toHaveLength(1); expect(saved[0]).toMatchObject({ status: "completed", providerId, serviceCode: "dog_walking" });
    expect(refusals).toHaveLength(6);
    for (const [name, target] of [["customer", page], ["walker", walker], ["finance", finance]] as const) await target.screenshot({ path: test.info().outputPath(`walking-${name}-recorded.png`), fullPage: true });
    const evidence = { bookingId, sessionId, providerId, customerFixtureProvenance: "new_disposable_local_only_identity_defined_in_walking_helper", customerPhone, bookingPath: "/v2/walking", customerManagementPath: "/v2/walking/manage", providerPath: "/v2/partner/walker", status: "completed", paymentStatus: "sandbox_paid", paymentEvidence: "finance_sandbox_session_ledger", paymentUiQualification: PAYMENT_UI_QUALIFICATION, payout: "accrued", settlement: "awaiting_finance_approval", payoutHoldDays: 7, reconciliation: "attention_required", canonicalJournal: "balanced", customerOtpLiveSmsDelivered: false, providerOtpLiveSmsDelivered: false, handoverOtpConnected: false, productionGpsConnected: false, routeSamples: 2, canonicalDoorstep: doorstep, addressEvidence: "service_area_matched_doorstep_not_map_verified_with_server_owned_discovery_fixture", optionalPlacesTransport: "aborted_before_provider", refusals, timingQualification: TIMING_QUALIFICATION, deniedExternalOrigins: [...new Set(deniedOrigins)], liveMoney: false };
    await test.info().attach("walking-recorded-lifecycle.json", { body: JSON.stringify(evidence, null, 2), contentType: "application/json" });
    console.log("WALKING-RECORDED-SYNTHETIC", JSON.stringify(evidence));
    return evidence;
  } finally { await Promise.allSettled(contexts.map(context => context.close())); }
}
