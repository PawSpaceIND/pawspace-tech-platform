import { test, expect, type Page, type Frame } from "@playwright/test";
import { createHmac } from "node:crypto";

const ORIGIN = "https://pawspace-checkout-674-34436602750-1.karthik-fce.workers.dev";
const WORKER = "pawspace-checkout-674-34436602750-1";
const CANDIDATE = "b1b0d6923ab769594d14fb42b4d72f585d9f87a2";
const PHONE = "9000000674";
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID || "";
const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN || "";
const RZP_KEY = process.env.RAZORPAY_KEY_ID_SANDBOX || "";
const RZP_SECRET = process.env.RAZORPAY_KEY_SECRET_SANDBOX || "";
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET_SANDBOX || "";

type Json = Record<string, any>;

async function cf(path: string, init: RequestInit = {}) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${CF_TOKEN}`, "content-type": "application/json", ...(init.headers || {}) },
  });
  const b = await r.json() as Json;
  if (!r.ok || b.success !== true) throw new Error(`Cloudflare request failed (${r.status})`);
  return b.result;
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
  return cf(`/d1/database/${dbId}/query`, { method: "POST", body: JSON.stringify({ sql, params }) });
}

async function rzp(path: string) {
  const basic = Buffer.from(`${RZP_KEY}:${RZP_SECRET}`).toString("base64");
  const r = await fetch(`https://api.razorpay.com${path}`, { headers: { authorization: `Basic ${basic}` } });
  const b = await r.json() as Json;
  if (!r.ok) throw new Error(`Razorpay provider read failed (${r.status})`);
  return b;
}

async function pagePost(page: Page, path: string, body: Json) {
  return page.evaluate(async ({ path, body }) => {
    const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
    return { status: r.status, body: await r.json() };
  }, { path, body });
}

async function seedPayableBooking(dbId: string, customerId: string) {
  const stamp = Date.now(), bookingId = `PR674-BK-${stamp}`, paymentId = `PR674-PAY-${stamp}`, groupId = `PR674-G-${stamp}`;
  const start = new Date(Date.now() + 7 * 86400000).toISOString(), end = new Date(Date.now() + 7 * 86400000 + 7200000).toISOString();
  await d1(dbId, "CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL DEFAULT '[]',source_pet_ids_json TEXT NOT NULL DEFAULT '[]',city_id TEXT NOT NULL,zone_id TEXT NOT NULL,service_code TEXT NOT NULL,package_code TEXT NOT NULL,package_name TEXT NOT NULL,schedule_group_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'confirmed',channel TEXT NOT NULL DEFAULT 'customer_app',total_amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',pricing_json TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  await d1(dbId, "CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,amount REAL NOT NULL,amount_due_now REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',method TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,gateway TEXT NOT NULL DEFAULT 'uat_sandbox',idempotency_key TEXT NOT NULL UNIQUE,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  await d1(dbId, "INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES (?,?,?,?,?,'blr','blr-east','grooming','pr674-sandbox','PR674 Checkout Sandbox',?,'groom_kiran',?,?,'confirmed','customer_app',1,'INR','{}','pr674_isolated_browser',?,?)", [bookingId, `idem-${bookingId}`, customerId, "[]", "[]", groupId, start, end, stamp, stamp]);
  await d1(dbId, "INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,currency,method,mode,status,gateway,idempotency_key,detail_json,created_at,updated_at) VALUES (?,?,?,1,1,'INR','upi','prepaid','created','uat_sandbox',?,'{}',?,?)", [paymentId, bookingId, customerId, `idem-${paymentId}`, stamp, stamp]);
  return { bookingId, paymentId };
}

async function visibleRazorpayFrame(page: Page) {
  await expect.poll(() => page.frames().some(frame => /razorpay/i.test(frame.url())), { timeout: 20000 }).toBeTruthy();
  return page.frames().find(frame => /razorpay/i.test(frame.url()) && frame !== page.mainFrame()) || page.frames().at(-1)!;
}

async function closeCheckout(page: Page) {
  const frames = page.frames().filter(frame => frame !== page.mainFrame());
  for (const frame of frames) {
    for (const locator of [frame.getByRole("button", { name: /close/i }).first(), frame.locator("button").filter({ hasText: /×|close/i }).first()]) {
      if (await locator.isVisible().catch(() => false)) { await locator.click(); return; }
    }
  }
  await page.keyboard.press("Escape");
}

async function submitUpi(page: Page, upi: string) {
  await visibleRazorpayFrame(page);
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    for (const frame of page.frames().filter(f => f !== page.mainFrame())) {
      const upiTab = frame.getByText(/^UPI$/i).first();
      if (await upiTab.isVisible().catch(() => false)) await upiTab.click().catch(() => {});
      const upiId = frame.getByText(/UPI ID|VPA/i).first();
      if (await upiId.isVisible().catch(() => false)) await upiId.click().catch(() => {});
      const inputs = frame.locator("input");
      for (let i = 0; i < await inputs.count(); i++) {
        const input = inputs.nth(i);
        if (!await input.isVisible().catch(() => false)) continue;
        const hint = `${await input.getAttribute("placeholder") || ""} ${await input.getAttribute("aria-label") || ""}`;
        if (/upi|vpa|id/i.test(hint)) {
          await input.fill(upi);
          const buttons = frame.getByRole("button");
          for (let j = (await buttons.count()) - 1; j >= 0; j--) {
            const b = buttons.nth(j), label = await b.innerText().catch(() => "");
            if (await b.isVisible().catch(() => false) && /pay|continue|verify|proceed/i.test(label)) { await b.click(); return; }
          }
          await input.press("Enter"); return;
        }
      }
    }
    await page.waitForTimeout(500);
  }
  throw new Error("Razorpay UPI control was not found");
}

async function webhookEvents(dbId: string, bookingId: string) {
  try {
    const result = await d1(dbId, "SELECT event_type,gateway_order_id,gateway_payment_id,signature_verified,processing_status,amount_subunits,currency FROM payment_gateway_events WHERE booking_id=? ORDER BY created_at", [bookingId]) as any[];
    return result?.[0]?.results || [];
  } catch { return []; }
}

async function paymentTruth(dbId: string, bookingId: string) {
  const result = await d1(dbId, "SELECT status,gateway,amount,amount_due_now FROM booking_payments WHERE booking_id=?", [bookingId]) as any[];
  return result?.[0]?.results?.[0] || null;
}

async function signedReplay(event: string, eventId: string, payment: Json) {
  const raw = JSON.stringify({ event, created_at: Math.floor(Date.now() / 1000), payload: { payment: { entity: payment } } });
  const signature = createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex");
  const r = await fetch(`${ORIGIN}/api/razorpay-webhook`, { method: "POST", headers: { "content-type": "application/json", "x-razorpay-event-id": eventId, "x-razorpay-signature": signature }, body: raw });
  return { status: r.status, body: await r.json().catch(() => null) };
}

test("PR674 isolated Worker performs real Razorpay Test Mode checkout without duplicate order or browser authority", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium");
  test.setTimeout(240000);
  expect(ACCOUNT).toMatch(/^[a-f0-9]{32}$/i); expect(CF_TOKEN.length).toBeGreaterThan(20);
  expect(RZP_KEY).toMatch(/^rzp_test_/); expect(RZP_SECRET.length).toBeGreaterThan(10); expect(WEBHOOK_SECRET.length).toBeGreaterThan(10);
  const report: Json = { candidate: CANDIDATE, origin: ORIGIN, liveMoney: false, providerWebhookDelivery: false, signedReplayApplied: false };
  await page.goto(`${ORIGIN}/mobile-app`, { waitUntil: "domcontentloaded" });
  const otp = await pagePost(page, "/api/customer-otp", { action: "request", phone: PHONE });
  expect(otp.status).toBe(200); expect(otp.body.data.sandboxDelivery).toBe(true); expect(otp.body.data.liveSmsDelivered).toBe(false);
  const verify = await pagePost(page, "/api/customer-otp", { action: "verify", challengeId: otp.body.data.challengeId, code: otp.body.data.sandboxCode, name: "PR674 Sandbox Customer", cityId: "blr", installId: `pr674-${Date.now()}` });
  expect(verify.status).toBe(200); const customerId = String(verify.body.data.customerId); report.customerId = customerId;
  const account = await page.evaluate(async () => { const r = await fetch("/api/customer-account", { cache: "no-store" }); return { status: r.status, body: await r.json() }; });
  expect(account.status).toBe(200); expect(account.body.data.customerId).toBe(customerId);
  const dbId = await isolatedDbId(); const fixture = await seedPayableBooking(dbId, customerId); report.bookingId = fixture.bookingId;
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("navigation", { name: "Customer navigation" }).getByRole("button", { name: /Account$/i }).click();
  const billing = page.locator("details").filter({ has: page.locator("summary").filter({ hasText: "Payments & invoice summaries" }) });
  await billing.locator("summary").click();
  const pay = billing.getByRole("button", { name: /^(Review & pay|Check balance) \(test\)$/ }).first();
  await expect(pay).toBeVisible();
  const startReply = () => page.waitForResponse(r => new URL(r.url()).pathname === "/api/customer-checkout" && r.request().method() === "POST" && (r.request().postData() || "").includes('"action":"start"'));
  const firstWait = startReply(); await pay.click(); const first = await (await firstWait).json(); report.orderId = first.data.orderId; expect(first.data.environment).toBe("sandbox"); expect(first.data.amountPaise).toBe(100);
  await visibleRazorpayFrame(page); await closeCheckout(page); await expect(billing.getByRole("alert")).toContainText(/Checkout closed|No payment confirmation/i);
  const retryWait = startReply(); await pay.click(); const retry = await (await retryWait).json(); expect(retry.data.orderId).toBe(report.orderId); report.dismissRetrySameOrder = true;
  await submitUpi(page, "failure@razorpay"); await expect(billing.getByRole("alert")).toContainText(/unsuccessful|failed/i, { timeout: 30000 });
  const failedProvider = await rzp(`/v1/orders/${report.orderId}/payments`); report.failedAttempts = (failedProvider.items || []).filter((p: Json) => p.status === "failed").length; expect(report.failedAttempts).toBeGreaterThanOrEqual(1);
  const successWait = startReply(); await pay.click(); const successStart = await (await successWait).json(); expect(successStart.data.orderId).toBe(report.orderId); report.failureRetrySameOrder = true;
  await submitUpi(page, "success@razorpay"); await expect(billing.getByRole("alert")).toContainText(/pending|verified/i, { timeout: 30000 });
  const provider = await rzp(`/v1/orders/${report.orderId}/payments`); const captured = (provider.items || []).find((p: Json) => p.status === "captured" || p.captured === true);
  expect(captured, "Razorpay Test Mode must show a captured payment").toBeTruthy(); report.providerPaymentId = captured.id; report.providerCaptured = true;
  await page.waitForTimeout(10000);
  let events = await webhookEvents(dbId, fixture.bookingId); let truth = await paymentTruth(dbId, fixture.bookingId);
  report.providerWebhookDelivery = events.some((e: Json) => e.gateway_payment_id === captured.id && Number(e.signature_verified) === 1 && e.processing_status === "processed");
  report.browserReceiptOnlyStatus = truth?.status;
  if (!report.providerWebhookDelivery) {
    expect(truth?.status).not.toBe("captured");
    const entity = { id: captured.id, order_id: report.orderId, amount: captured.amount, currency: captured.currency, status: "authorized", notes: { booking_id: fixture.bookingId } };
    const auth = await signedReplay("payment.authorized", `evt_pr674_auth_${Date.now()}`, entity); expect(auth.status).toBe(200);
    entity.status = "captured"; const cap = await signedReplay("payment.captured", `evt_pr674_cap_${Date.now()}`, entity); expect(cap.status).toBe(200);
    report.signedReplayApplied = true; events = await webhookEvents(dbId, fixture.bookingId); truth = await paymentTruth(dbId, fixture.bookingId);
    expect(truth?.status).toBe("captured");
  }
  const requestKinds: string[] = []; const observer = (req: any) => { if (new URL(req.url()).pathname === "/api/customer-checkout" && req.method() === "POST") { try { requestKinds.push(JSON.parse(req.postData() || "{}").action || "?"); } catch {} } };
  page.on("request", observer); await pay.click(); await page.waitForTimeout(1500); page.off("request", observer);
  expect(requestKinds).toContain("confirm"); expect(requestKinds).not.toContain("start"); report.postReceiptRetry = requestKinds;
  report.d1PaymentStatus = truth?.status; report.gatewayEvents = events.map((e: Json) => ({ eventType: e.event_type, verified: Number(e.signature_verified) === 1, status: e.processing_status }));
  await testInfo.attach("pr674-isolated-checkout-report", { body: JSON.stringify(report, null, 2), contentType: "application/json" });
  console.log(`[PR674-ISOLATED] ${JSON.stringify(report)}`);
  expect(report.providerWebhookDelivery, "Provider-origin Razorpay webhook delivery to the isolated Worker is still required; a signed replay is evidence of receiver correctness only").toBe(true);
});
