import { test, expect, type Page } from "@playwright/test";

const ORIGIN = "https://pawspace-checkout-674-34495251052-1.karthik-fce.workers.dev";
const WORKER = "pawspace-checkout-674-34495251052-1";
const CANDIDATE = "a4d1a8706e2d484beaf1944c44f6345c21ac5494";
const PHONE = "9000000674";
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID || "";
const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN || "";
const RZP_KEY = process.env.RAZORPAY_KEY_ID_SANDBOX || "";
const RZP_SECRET = process.env.RAZORPAY_KEY_SECRET_SANDBOX || "";
const GH_TOKEN = process.env.GITHUB_TOKEN || "";
// Provider/D1 payloads are intentionally schemaless at this external test boundary.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

async function cf(path: string, init: RequestInit = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${CF_TOKEN}`, "content-type": "application/json", ...(init.headers || {}) },
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json() as Json;
  if (!response.ok || body.success !== true) throw new Error(`Cloudflare request failed (${response.status})`);
  return body.result;
}
async function isolatedDbId() {
  for (let page = 1; page <= 10; page++) {
    const rows = await cf(`/d1/database?per_page=100&page=${page}`) as Json[];
    const hit = rows.find(row => row.name === WORKER);
    if (hit?.uuid) return String(hit.uuid);
    if (!rows.length) break;
  }
  throw new Error("Isolated checkout database was not found");
}

async function d1(dbId: string, sql: string, params: unknown[] = []) {
  const result = await cf(`/d1/database/${dbId}/query`, {
    method: "POST",
    body: JSON.stringify({ sql, params }),
  }) as Array<{ results?: Json[] }>;
  return result?.[0]?.results || [];
}

async function revalidateTarget() {
  const pr = await fetch("https://api.github.com/repos/PawSpaceIND/pawspace-tech-platform/pulls/674", {
    headers: { authorization: `Bearer ${GH_TOKEN}`, accept: "application/vnd.github+json" },
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
  });
  expect(pr.status).toBe(200);
  const prBody = await pr.json() as Json;
  expect(prBody.state).toBe("open");
  expect(prBody.head?.sha).toBe(CANDIDATE);
  expect(prBody.head?.ref).toBe("fix/customer-sandbox-checkout-wiring-20260909");
  const settings = await cf(`/workers/scripts/${WORKER}/settings`) as Json;
  const bindings = Array.isArray(settings.bindings) ? settings.bindings : [];
  const plain = Object.fromEntries(bindings.filter((b: Json) => b.type === "plain_text").map((b: Json) => [b.name, b.text]));
  expect(plain.PAWSPACE_RELEASE_SHA).toBe(CANDIDATE);
  expect(plain.PAWSPACE_PAYMENT_ENV).toBe("sandbox");
  expect(plain.PAWSPACE_PAYMENT_LIVE_APPROVED).toBe("false");
  expect(plain.FORBID_PRODUCTION).toBe("true");
  expect(plain.PAWSPACE_LIVE_PAYMENTS).toBe("false");
  expect(plain.PAWSPACE_LIVE_REFUNDS).toBe("false");
  expect(plain.PAWSPACE_LIVE_PAYOUTS).toBe("false");
  const dbBindings = bindings.filter((b: Json) => b.type === "d1" && b.name === "DB");
  expect(dbBindings).toHaveLength(1);
  const dbId = await isolatedDbId();
  expect(String(dbBindings[0].id || "").toLowerCase()).toBe(dbId.toLowerCase());
  return dbId;
}

async function rzp(path: string) {
  const auth = Buffer.from(`${RZP_KEY}:${RZP_SECRET}`).toString("base64");
  const response = await fetch(`https://api.razorpay.com${path}`, {
    headers: { authorization: `Basic ${auth}` },
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json() as Json;
  if (!response.ok) throw new Error(`Razorpay provider read failed (${response.status})`);
  return body;
}

async function pagePost(page: Page, path: string, body: Json) {
  return page.evaluate(async ({ path, body }) => {
    const response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    return { status: response.status, body: await response.json() };
  }, { path, body });
}

async function seedPayableBooking(dbId: string, customerId: string) {
  const stamp = Date.now();
  const bookingId = `PR674-PROVIDER-${stamp}`;
  const paymentId = `PR674-PROVIDER-PAY-${stamp}`;
  const start = new Date(stamp + 7 * 86400000).toISOString();
  const end = new Date(stamp + 7 * 86400000 + 7200000).toISOString();
  await d1(dbId, "CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL DEFAULT '[]',source_pet_ids_json TEXT NOT NULL DEFAULT '[]',city_id TEXT NOT NULL,zone_id TEXT NOT NULL,service_code TEXT NOT NULL,package_code TEXT NOT NULL,package_name TEXT NOT NULL,schedule_group_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'confirmed',channel TEXT NOT NULL DEFAULT 'customer_app',total_amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',pricing_json TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  await d1(dbId, "CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,amount REAL NOT NULL,amount_due_now REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',method TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,gateway TEXT NOT NULL DEFAULT 'uat_sandbox',idempotency_key TEXT NOT NULL UNIQUE,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  await d1(dbId, "INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES (?,?,?,?,?,'blr','blr-east','grooming','pr674-provider-proof','PR674 Provider Proof',?,'groom_kiran',?,?,'confirmed','customer_app',1,'INR','{}','pr674_provider_proof',?,?)", [bookingId, `idem-${bookingId}`, customerId, "[]", "[]", `group-${bookingId}`, start, end, stamp, stamp]);
  await d1(dbId, "INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,currency,method,mode,status,gateway,idempotency_key,detail_json,created_at,updated_at) VALUES (?,?,?,1,1,'INR','upi','prepaid','created','uat_sandbox',?,'{}',?,?)", [paymentId, bookingId, customerId, `idem-${paymentId}`, stamp, stamp]);
  return { bookingId, paymentId };
}

async function visibleRazorpayFrame(page: Page) {
  await expect.poll(() => page.frames().some(frame => /razorpay/i.test(frame.url())), { timeout: 25_000 }).toBeTruthy();
  return page.frames().find(frame => /razorpay/i.test(frame.url()) && frame !== page.mainFrame()) || page.frames().at(-1)!;
}

function hasRazorpayFrame(page: Page) {
  return page.frames().some(frame => frame !== page.mainFrame() && /razorpay/i.test(frame.url()));
}

async function closeCheckout(page: Page) {
  const frame = await visibleRazorpayFrame(page);
  const candidates = [
    frame.locator('[data-testid="checkout-close"]').first(),
    frame.getByRole("button", { name: /^Go back$/i }).first(),
    frame.getByRole("button", { name: /^Close Checkout$/i }).first(),
    frame.getByRole("button", { name: /^Close$/i }).first(),
  ];
  await expect.poll(async () => {
    for (const candidate of candidates) if (await candidate.isVisible().catch(() => false)) return true;
    return false;
  }, { timeout: 15_000 }).toBeTruthy();

  let dismissed = false;
  for (const candidate of candidates) {
    if (!await candidate.isVisible().catch(() => false)) continue;
    try {
      await candidate.click({ timeout: 5_000 });
      dismissed = true;
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/intercepts pointer events|not stable|Timeout|Frame was detached/i.test(message)) throw error;
    }
  }
  if (!dismissed && hasRazorpayFrame(page)) {
    // Checkout v2 can leave a QR/status overlay above the visible close control. Escape is the
    // real browser dismissal path and avoids bypassing Razorpay's pointer/overlay protections.
    await page.keyboard.press("Escape");
  }
  if (hasRazorpayFrame(page)) {
    const current = page.frames().find(item => item !== page.mainFrame() && /razorpay/i.test(item.url())) || frame;
    const confirmExit = current.getByRole("button", { name: /^Yes, exit$/i }).first();
    await confirmExit.waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
    if (await confirmExit.isVisible().catch(() => false)) await confirmExit.click({ timeout: 5_000 });
  }
  await expect.poll(() => hasRazorpayFrame(page), { timeout: 15_000 }).toBeFalsy();
}
async function submitUpi(page: Page, upi: string) {
  await visibleRazorpayFrame(page);
  const deadline = Date.now() + 45_000;
  let contactSubmitted = false;
  while (Date.now() < deadline) {
    const frames = page.frames().filter(frame => frame !== page.mainFrame() && /razorpay/i.test(frame.url()));
    for (const frame of frames) {
      try {
        const mobile = frame.locator('input[placeholder*="Mobile" i], input[aria-label*="mobile" i], input[aria-label*="phone" i]').first();
        if (!contactSubmitted && await mobile.isVisible().catch(() => false)) {
          await mobile.fill(PHONE);
          const next = frame.getByRole("button", { name: /^Continue$/i }).first();
          if (await next.isVisible().catch(() => false)) {
            await next.click();
            contactSubmitted = true;
            await page.waitForTimeout(800);
            continue;
          }
        }

        // Razorpay Checkout v2 keeps the parent UPI row visible while its nested choices are open.
        // Always consume the terminal VPA field first, then the nested "Apps & UPI ID" choice, and
        // only fall back to the parent UPI row when neither deeper state is present.
        const inputs = frame.locator("input");
        const inputCount = await inputs.count();
        for (let index = 0; index < inputCount; index++) {
          const input = inputs.nth(index);
          if (!await input.isVisible().catch(() => false)) continue;
          const hint = `${await input.getAttribute("placeholder") || ""} ${await input.getAttribute("aria-label") || ""} ${await input.getAttribute("name") || ""} ${await input.getAttribute("data-testid") || ""}`;
          if (!/upi|vpa|upi id/i.test(hint)) continue;
          await input.fill(upi);
          const buttons = frame.getByRole("button");
          const buttonCount = await buttons.count();
          for (let button = buttonCount - 1; button >= 0; button--) {
            const candidate = buttons.nth(button);
            const label = await candidate.innerText().catch(() => "");
            if (await candidate.isVisible().catch(() => false) && /pay|continue|verify|proceed/i.test(label)) {
              await candidate.click();
              return;
            }
          }
          await input.press("Enter");
          return;
        }

        const appsAndUpiId = [
          frame.getByRole("button", { name: /Apps & UPI ID/i }).first(),
          frame.locator('[data-testid="more"]').first(),
          frame.getByText(/^Apps & UPI ID$/i).first(),
        ];
        let selectedNestedUpi = false;
        for (const locator of appsAndUpiId) {
          if (!await locator.isVisible().catch(() => false)) continue;
          await locator.click();
          selectedNestedUpi = true;
          break;
        }
        if (selectedNestedUpi) {
          await page.waitForTimeout(800);
          continue;
        }

        const topLevelUpi = [
          frame.getByRole("button", { name: /^UPI$/i }).first(),
          frame.getByText(/^UPI$/i).first(),
        ];
        let selectedTopLevelUpi = false;
        for (const locator of topLevelUpi) {
          if (!await locator.isVisible().catch(() => false)) continue;
          await locator.click();
          selectedTopLevelUpi = true;
          break;
        }
        if (selectedTopLevelUpi) {
          await page.waitForTimeout(800);
          continue;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/Frame was detached|Execution context was destroyed|Target page, context or browser has been closed/i.test(message)) continue;
        throw error;
      }
    }
    await page.waitForTimeout(500);
  }
  throw new Error("Razorpay Test UPI ID control was not found on mobile web");
}
async function paymentRows(dbId: string, bookingId: string) {
  return d1(dbId, "SELECT event_type,gateway_order_id,gateway_payment_id,signature_verified,processing_status,amount_subunits,currency FROM payment_gateway_events WHERE booking_id=? ORDER BY received_at", [bookingId]);
}

async function paymentTruth(dbId: string, bookingId: string) {
  return (await d1(dbId, "SELECT status,gateway,amount,amount_due_now FROM booking_payments WHERE booking_id=?", [bookingId]))[0] || null;
}

async function intentTruth(dbId: string, bookingId: string) {
  return (await d1(dbId, "SELECT state,gateway_order_id,gateway_payment_id,amount_paise,currency FROM payment_intents WHERE booking_id=? ORDER BY created_at DESC LIMIT 1", [bookingId]))[0] || null;
}

async function waitForProviderPayment(orderId: string, wanted: (row: Json) => boolean, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let items: Json[] = [];
  while (Date.now() < deadline) {
    const provider = await rzp(`/v1/orders/${orderId}/payments`);
    items = Array.isArray(provider.items) ? provider.items : [];
    const hit = items.find(wanted);
    if (hit) return { hit, items };
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  return { hit: null, items };
}

async function waitForProviderWebhook(dbId: string, bookingId: string, paymentId: string, timeoutMs = 75_000) {
  const deadline = Date.now() + timeoutMs;
  let rows: Json[] = [];
  while (Date.now() < deadline) {
    rows = await paymentRows(dbId, bookingId).catch(() => []);
    const hit = rows.find(row => row.gateway_payment_id === paymentId && Number(row.signature_verified) === 1 && row.processing_status === "processed" && ["payment.captured", "order.paid"].includes(String(row.event_type)));
    if (hit) return { hit, rows };
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  return { hit: null, rows };
}
test("PR674 current isolated Worker proves Razorpay Test capture and provider-origin webhook", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium");
  test.setTimeout(300_000);
  expect(ACCOUNT).toMatch(/^[a-f0-9]{32}$/i);
  expect(CF_TOKEN.length).toBeGreaterThan(20);
  expect(RZP_KEY).toMatch(/^rzp_test_[A-Za-z0-9]+$/);
  expect(RZP_SECRET.length).toBeGreaterThan(10);
  expect(GH_TOKEN.length).toBeGreaterThan(20);
  const report: Json = {
    candidate: CANDIDATE,
    worker: WORKER,
    origin: ORIGIN,
    amountPaise: 100,
    liveMoney: false,
    refund: "NOT_RUN",
    syntheticWebhookReplay: false,
    providerCaptured: false,
    providerWebhookDelivery: false,
  };

  const dbId = await revalidateTarget();
  await page.goto(`${ORIGIN}/mobile-app`, { waitUntil: "domcontentloaded" });
  const otp = await pagePost(page, "/api/customer-otp", { action: "request", phone: PHONE });
  expect(otp.status).toBe(200);
  expect(otp.body.data.sandboxDelivery).toBe(true);
  expect(otp.body.data.liveSmsDelivered).toBe(false);
  const verified = await pagePost(page, "/api/customer-otp", {
    action: "verify",
    challengeId: otp.body.data.challengeId,
    code: otp.body.data.sandboxCode,
    name: "PR674 Provider Proof",
    cityId: "blr",
    installId: `pr674-provider-${Date.now()}`,
  });
  expect(verified.status).toBe(200);
  const customerId = String(verified.body.data.customerId);
  const account = await page.evaluate(async () => {
    const response = await fetch("/api/customer-account", { cache: "no-store" });
    return { status: response.status, body: await response.json() };
  });
  expect(account.status).toBe(200);
  expect(account.body.data.customerId).toBe(customerId);
  const fixture = await seedPayableBooking(dbId, customerId);
  report.bookingId = fixture.bookingId;
  await page.reload({ waitUntil: "domcontentloaded" });
  const accountTab = page.getByRole("navigation", { name: "Customer navigation" }).getByRole("button", { name: /Account$/i });
  await expect(accountTab).toBeVisible();
  await accountTab.click();
  const billing = page.locator("details").filter({ has: page.locator("summary").filter({ hasText: "Payments & invoice summaries" }) });
  await billing.locator("summary").click();
  const pay = billing.getByRole("button", { name: /^(Review & pay|Check balance) \(test\)$/ }).first();
  await expect(pay).toBeVisible();
  const waitForStart = () => page.waitForResponse(response => {
    const request = response.request();
    return new URL(response.url()).pathname === "/api/customer-checkout" && request.method() === "POST" && (request.postData() || "").includes('"action":"start"');
  });
  const firstWait = waitForStart();
  await pay.click();
  const first = await (await firstWait).json();
  expect(first.data.environment).toBe("sandbox");
  expect(first.data.amountPaise).toBe(100);
  expect(String(first.data.orderId)).toMatch(/^order_/);
  report.orderId = String(first.data.orderId);
  await visibleRazorpayFrame(page);
  await closeCheckout(page);
  await expect.poll(() => hasRazorpayFrame(page), { timeout: 10_000 }).toBeFalsy();
  const paymentAfterDismiss = await paymentTruth(dbId, fixture.bookingId);
  const intentAfterDismiss = await intentTruth(dbId, fixture.bookingId);
  expect(paymentAfterDismiss?.status).toBe("created");
  expect(intentAfterDismiss?.state).toBe("CREATED");
  expect(intentAfterDismiss?.gateway_order_id).toBe(report.orderId);
  report.dismissState = { payment: paymentAfterDismiss?.status, intent: intentAfterDismiss?.state };
  await expect(pay).toBeEnabled();

  const retryWait = waitForStart();
  await pay.click();
  const retry = await (await retryWait).json();
  expect(retry.data.orderId).toBe(report.orderId);
  report.dismissRetrySameOrder = true;
  await submitUpi(page, "failure@razorpay");
  await expect(billing.getByRole("alert")).toContainText(/unsuccessful|failed/i, { timeout: 35_000 });
  const failed = await waitForProviderPayment(report.orderId, row => row.status === "failed", 35_000);
  report.failedProviderAttempts = failed.items.filter(row => row.status === "failed").length;
  expect(report.failedProviderAttempts).toBeGreaterThanOrEqual(1);
  const successWait = waitForStart();
  await pay.click();
  const successStart = await (await successWait).json();
  expect(successStart.data.orderId).toBe(report.orderId);
  report.failureRetrySameOrder = true;
  await submitUpi(page, "success@razorpay");
  await expect(billing.getByRole("status")).toContainText(/pending|verified|confirmation/i, { timeout: 40_000 });

  const provider = await waitForProviderPayment(report.orderId, row => row.status === "captured" || row.captured === true, 50_000);
  report.providerPaymentStatuses = provider.items.map(row => ({ id: row.id, status: row.status, captured: row.captured, amount: row.amount, currency: row.currency }));
  if (provider.hit) {
    report.providerCaptured = true;
    report.providerPaymentId = provider.hit.id;
  }
  const delivered = provider.hit
    ? await waitForProviderWebhook(dbId, fixture.bookingId, String(provider.hit.id))
    : { hit: null, rows: await paymentRows(dbId, fixture.bookingId).catch(() => []) };
  report.providerWebhookDelivery = Boolean(delivered.hit);
  report.gatewayEvents = delivered.rows.map(row => ({ eventType: row.event_type, paymentId: row.gateway_payment_id, signatureVerified: Number(row.signature_verified) === 1, status: row.processing_status }));
  const truth = await paymentTruth(dbId, fixture.bookingId);
  const intent = await intentTruth(dbId, fixture.bookingId);
  report.d1PaymentStatus = truth?.status;
  report.intentState = intent?.state;
  report.syntheticWebhookReplay = false;
  if (delivered.hit) {
    expect(truth?.status).toBe("captured");
    expect(intent?.state).toBe("CAPTURED");
    const lifecycle = await d1(dbId, "SELECT COUNT(*) n FROM booking_lifecycle_events WHERE booking_id=? AND event_type='payment_captured'", [fixture.bookingId]);
    report.paymentCapturedTimelineCount = Number(lifecycle[0]?.n || 0);
    expect(report.paymentCapturedTimelineCount).toBe(1);
  }

  await testInfo.attach("pr674-provider-webhook-proof", {
    body: JSON.stringify(report, null, 2),
    contentType: "application/json",
  });
  console.log(`[PR674-PROVIDER-PROOF] ${JSON.stringify(report)}`);
  expect(report.providerCaptured, "A real Razorpay TEST payment must be captured; order creation alone is insufficient").toBe(true);
  expect(report.providerWebhookDelivery, "Razorpay-origin signed webhook delivery to this exact isolated Worker is still required; no synthetic replay is allowed").toBe(true);
  expect(report.d1PaymentStatus).toBe("captured");
  expect(report.intentState).toBe("CAPTURED");
});
