import { test, expect, type Page } from "@playwright/test";

const ORIGIN = String(process.env.PR735_WORKER_ORIGIN || "").trim();
const WORKER = String(process.env.PR735_WORKER_NAME || "").trim();
const CANDIDATE = String(process.env.PR735_CANDIDATE_SHA || "").trim();
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
  throw new Error("Staging database was not found");
}

async function d1(dbId: string, sql: string, params: unknown[] = []) {
  const result = await cf(`/d1/database/${dbId}/query`, {
    method: "POST",
    body: JSON.stringify({ sql, params }),
  }) as Array<{ results?: Json[] }>;
  return result?.[0]?.results || [];
}

async function revalidateTarget() {
  const pr = await fetch("https://api.github.com/repos/PawSpaceIND/pawspace-tech-platform/pulls/735", {
    headers: { authorization: `Bearer ${GH_TOKEN}`, accept: "application/vnd.github+json" },
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
  });
  expect(pr.status).toBe(200);
  const prBody = await pr.json() as Json;
  expect(prBody.state).toBe("open");
  expect(prBody.head?.sha).toBe(CANDIDATE);
  expect(prBody.head?.ref).toBe("fix/razorpay-capture-reconciliation-post734-20260911");

  const settings = await cf(`/workers/scripts/${WORKER}/settings`) as Json;
  const deployments = await cf(`/workers/scripts/${WORKER}/deployments`) as Json;
  const bindings = Array.isArray(settings.bindings) ? settings.bindings : [];
  const plain = Object.fromEntries(bindings.filter((b: Json) => b.type === "plain_text").map((b: Json) => [String(b.name), String(b.text ?? b.value ?? "")]));
  expect(WORKER).toBe("pawspace-staging");
  expect(plain.PAWSPACE_DEPLOYMENT_ENV).toBe("staging");
  expect(plain.PAWSPACE_PAYMENT_ENV).toBe("sandbox");
  expect(plain.PAWSPACE_UAT_LOGIN).toBe("on");
  expect(plain.PAWSPACE_RAZORPAYX_LIVE_APPROVED).toBe("false");
  for (const name of ["PAWSPACE_PAYMENT_LIVE_APPROVED","PAWSPACE_LIVE_PAYMENTS","PAWSPACE_LIVE_REFUNDS","PAWSPACE_LIVE_PAYOUTS"]) {
    expect(String(plain[name] || "false").toLowerCase(), `${name} must not enable live money`).not.toBe("true");
  }
  expect(String(plain.PAWSPACE_RAZORPAY_SANDBOX_RELAY_TARGET_ORIGIN || "")).toBe("");
  const webhook = bindings.find((b: Json) => b.name === "RAZORPAY_WEBHOOK_SECRET_SANDBOX");
  expect(webhook).toBeTruthy();
  expect(String(webhook.type || "")).toMatch(/secret/i);
  const dbBindings = bindings.filter((b: Json) => b.type === "d1" && b.name === "DB");
  expect(dbBindings).toHaveLength(1);
  const active = deployments?.deployments?.[0];
  expect(active?.id).toBeTruthy();
  expect(active?.versions).toHaveLength(1);
  expect(Number(active.versions[0]?.percentage)).toBe(100);
  expect(settings?.annotations?.["workers/message"]).toBe(`staging ${CANDIDATE}`);
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
  const bookingId = `PR735-PROVIDER-${stamp}`;
  const paymentId = `PR735-PROVIDER-PAY-${stamp}`;
  const start = new Date(stamp + 7 * 86400000).toISOString();
  const end = new Date(stamp + 7 * 86400000 + 7200000).toISOString();
  await d1(dbId, "CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL DEFAULT '[]',source_pet_ids_json TEXT NOT NULL DEFAULT '[]',city_id TEXT NOT NULL,zone_id TEXT NOT NULL,service_code TEXT NOT NULL,package_code TEXT NOT NULL,package_name TEXT NOT NULL,schedule_group_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'confirmed',channel TEXT NOT NULL DEFAULT 'customer_app',total_amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',pricing_json TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  await d1(dbId, "CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,amount REAL NOT NULL,amount_due_now REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',method TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,gateway TEXT NOT NULL DEFAULT 'uat_sandbox',idempotency_key TEXT NOT NULL UNIQUE,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  await d1(dbId, "INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES (?,?,?,?,?,'blr','blr-east','grooming','pr735-provider-proof','PR735 Provider Proof',?,'groom_kiran',?,?,'confirmed','customer_app',1,'INR','{}','pr735_provider_proof',?,?)", [bookingId, `idem-${bookingId}`, customerId, "[]", "[]", `group-${bookingId}`, start, end, stamp, stamp]);
  await d1(dbId, "INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,currency,method,mode,status,gateway,idempotency_key,detail_json,created_at,updated_at) VALUES (?,?,?,1,1,'INR','netbanking','prepaid','created','uat_sandbox',?,'{}',?,?)", [paymentId, bookingId, customerId, `idem-${paymentId}`, stamp, stamp]);
  return { bookingId, paymentId };
}

async function visibleRazorpayFrame(page: Page) {
  await expect.poll(() => page.frames().some(frame => /razorpay/i.test(frame.url())), { timeout: 25_000 }).toBeTruthy();
  return page.frames().find(frame => /razorpay/i.test(frame.url()) && frame !== page.mainFrame()) || page.frames().at(-1)!;
}

async function submitNetbankingSuccess(page: Page) {
  await visibleRazorpayFrame(page);
  const deadline = Date.now() + 60_000;
  let contactSubmitted = false;
  let netbankingSelected = false;
  let bankSelected = false;
  while (Date.now() < deadline) {
    const frames = page.frames().filter(frame => frame !== page.mainFrame() && /razorpay/i.test(frame.url()));
    for (const frame of frames) {
      try {
        const mobile = frame.getByRole("textbox", { name: /Mobile number/i }).first();
        if (!contactSubmitted && await mobile.isVisible().catch(() => false)) {
          await mobile.fill(PHONE);
          const next = frame.getByRole("button", { name: /^Continue$/i }).first();
          if (await next.isVisible().catch(() => false)) {
            await next.click(); contactSubmitted = true; await page.waitForTimeout(700); continue;
          }
        }
        if (!netbankingSelected) {
          const netbankingChoices = [
            frame.locator('[data-testid="netbanking"]').first(),
            frame.getByText(/^Netbanking$/i).first(),
          ];
          for (const netbanking of netbankingChoices) {
            if (!await netbanking.isVisible().catch(() => false)) continue;
            await netbanking.click(); netbankingSelected = true; await page.waitForTimeout(700); break;
          }
          if (netbankingSelected) continue;
        }
        if (netbankingSelected && !bankSelected) {
          const search = frame.locator('input[placeholder*="bank" i],input[aria-label*="bank" i]').first();
          if (await search.isVisible().catch(() => false)) await search.fill("HDFC Bank");
          const bankChoices = [
            frame.getByRole("button", { name: /HDFC Bank/i }).first(),
            frame.locator('[data-value="HDFC"], [data-testid="HDFC"]').first(),
            frame.getByText(/^HDFC Bank$/i).first(),
            frame.getByText(/^HDFC$/i).first(),
          ];
          for (const choice of bankChoices) {
            if (!await choice.isVisible().catch(() => false)) continue;
            const label = await choice.innerText().catch(() => "");
            if (/facing issues|unavailable|try with other payment options/i.test(label)) continue;
            // Checkout v2 starts Netbanking processing when the bank itself is selected; there is no
            // separate generic "Pay" click to make. Retrying a hidden bank row can stall under the
            // processing overlay, so select one healthy Test bank once and wait for the mock bank UI.
            await choice.click(); bankSelected = true; await page.waitForTimeout(900); break;
          }
          if (bankSelected) continue;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/Frame was detached|Execution context was destroyed|Target page, context or browser has been closed/i.test(message)) throw error;
      }
    }
    for (const candidatePage of page.context().pages()) {
      for (const surface of [candidatePage, ...candidatePage.frames()]) {
        try {
          const success = surface.getByRole("button", { name: /^Success$/i }).first();
          if (await success.isVisible().catch(() => false)) { await success.click(); return; }
        } catch {}
      }
    }
    await page.waitForTimeout(500);
  }
  throw new Error("Razorpay Test Netbanking mock-success control was not reached");
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
test("PR735 exact staging proves Razorpay Test capture and provider-origin webhook", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium");
  test.setTimeout(300_000);
  expect(CANDIDATE).toMatch(/^[0-9a-f]{40}$/);
  expect(WORKER).toBe("pawspace-staging");
  const target = new URL(ORIGIN);
  expect(target.protocol).toBe("https:");
  expect(target.hostname).toMatch(new RegExp(`^${WORKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.[a-z0-9-]+\\.workers\\.dev$`, "i"));
  expect(target.username || target.password || target.port || target.search || target.hash).toBe("");
  expect(["", "/"]).toContain(target.pathname);
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
    name: "PR735 Provider Proof",
    cityId: "blr",
    installId: `pr735-provider-${Date.now()}`,
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
  report.negativeCheckoutSemantics = "covered_by_exact_head_pr735_ci";
  await submitNetbankingSuccess(page);
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

  await testInfo.attach("pr735-provider-webhook-proof", {
    body: JSON.stringify(report, null, 2),
    contentType: "application/json",
  });
  console.log(`[PR735-PROVIDER-PROOF] ${JSON.stringify(report)}`);
  expect(report.providerCaptured, "A real Razorpay TEST payment must be captured; order creation alone is insufficient").toBe(true);
  expect(report.providerWebhookDelivery, "Razorpay-origin signed webhook delivery to this exact isolated Worker is still required; no synthetic replay is allowed").toBe(true);
  expect(report.d1PaymentStatus).toBe("captured");
  expect(report.intentState).toBe("CAPTURED");
});
