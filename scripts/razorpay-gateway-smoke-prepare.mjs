import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

const base = "https://pawspace-staging.karthik-fce.workers.dev";
const dbId = String(process.env.STAGING_D1_ID || "").trim();
const cfAccount = String(process.env.CLOUDFLARE_ACCOUNT_ID || "").trim();
const cfToken = String(process.env.CLOUDFLARE_API_TOKEN || "").trim();
const certKey = "gateway-smoke-20260901";
const amountRupees = 1500;
const evidencePath = "gateway-smoke-prepare.json";

for (const [name, value] of Object.entries({ STAGING_D1_ID: dbId, CLOUDFLARE_ACCOUNT_ID: cfAccount, CLOUDFLARE_API_TOKEN: cfToken })) {
  if (!value) throw new Error(`${name} is required`);
}

const safeJson = async (response) => { try { return await response.json(); } catch { return null; } };
async function d1(sql, params = []) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(cfAccount)}/d1/database/${encodeURIComponent(dbId)}/query`, {
    method: "POST",
    headers: { authorization: `Bearer ${cfToken}`, "content-type": "application/json" },
    body: JSON.stringify({ sql, params }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await safeJson(response);
  if (!response.ok || body?.success !== true || body?.result?.[0]?.success !== true) throw new Error(body?.errors?.[0]?.message || body?.result?.[0]?.error || `D1 HTTP ${response.status}`);
  return body.result[0].results || [];
}
function testPhone() {
  const suffix = BigInt(`0x${createHash("sha256").update(certKey).digest("hex").slice(0, 16)}`) % 1_000_000_000n;
  return `9${suffix.toString().padStart(9, "0")}`;
}
async function app(path, init = {}) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { origin: base, ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers || {}) },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await safeJson(response);
  if (!response.ok) throw new Error(`${path} failed (${response.status}): ${body?.error || "request failed"}`);
  return { body, response };
}
const cookieOf = (response) => String(response.headers.get("set-cookie") || "").split(";")[0];

const phone = testPhone();
const req = await app("/api/customer-otp", { method: "POST", body: JSON.stringify({ action: "request", phone }) });
const challengeId = String(req.body?.data?.challengeId || "");
const code = String(req.body?.data?.sandboxCode || "");
if (!challengeId || !/^\d{6}$/.test(code)) throw new Error("sandbox OTP unavailable");
const verified = await app("/api/customer-otp", { method: "POST", body: JSON.stringify({ action: "verify", challengeId, code, name: "Gateway Smoke Customer", cityId: "blr", installId: certKey }) });
const cookie = cookieOf(verified.response);
const customerId = String(verified.body?.data?.customerId || "");
if (!cookie || !customerId) throw new Error("customer session unavailable");

const bookingId = "CERT-GATEWAY-SMOKE-20260901";
const paymentId = "CERT-PAY-GATEWAY-SMOKE-20260901";
const now = Date.now();
const start = new Date(now + 86_400_000).toISOString();
const end = new Date(now + 90_000_000).toISOString();
const existing = await d1("SELECT COUNT(*) n FROM payment_intents WHERE booking_id=?", [bookingId]).catch(() => [{ n: 0 }]);
if (Number(existing[0]?.n || 0) > 0) throw new Error("gateway smoke booking already has payment intents; use a fresh certification key instead of deleting provider-linked financial evidence");
await d1("DELETE FROM booking_payments WHERE booking_id=?", [bookingId]);
await d1("DELETE FROM canonical_bookings WHERE id=?", [bookingId]);
await d1("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES (?,?,?,'[]','[]','blr','blr-cert','grooming','gateway-smoke','Gateway Smoke','CERT-GATEWAY-GROUP-20260901','CERT-PROVIDER',?,?,'confirmed','customer_app',?,'INR','{}',?,?,?)", [bookingId, certKey, customerId, start, end, amountRupees, customerId, now, now]);
await d1("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,currency,method,mode,status,gateway,idempotency_key,detail_json,created_at,updated_at) VALUES (?,?,?,?,?,'INR','online','prepaid','created','razorpay_sandbox',?,'{}',?,?)", [paymentId, bookingId, customerId, amountRupees, amountRupees, `gateway-smoke-payment-${certKey}`, now, now]);

const opened = await app("/api/payment-order", { method: "POST", headers: { cookie }, body: JSON.stringify({ bookingId }) });
const data = opened.body?.data || {};
if (!data.connected || !/^order_[A-Za-z0-9]+$/.test(String(data.orderId || ""))) throw new Error(`real test order was not created: ${JSON.stringify(data)}`);
const retried = await app("/api/payment-order", { method: "POST", headers: { cookie }, body: JSON.stringify({ bookingId }) });
const retryData = retried.body?.data || {};
if (!retryData.connected || retryData.orderId !== data.orderId) throw new Error(`payment order idempotency failed: first=${data.orderId} retry=${retryData.orderId}`);
const intentRows = await d1("SELECT id,state,order_request_state,gateway_order_id,amount_paise,currency FROM payment_intents WHERE booking_id=? ORDER BY created_at DESC", [bookingId]);
if (intentRows.length !== 1) throw new Error(`payment order retry created ${intentRows.length} intents`);
const intent = intentRows[0];
if (!intent || intent.state !== "CREATED" || intent.gateway_order_id !== data.orderId) throw new Error(`verify-first intent pin failed: ${JSON.stringify(intent)}`);
const evidence = {
  ok: true,
  certKey,
  stagingUrl: base,
  bookingId,
  paymentRecordId: paymentId,
  orderId: data.orderId,
  amountPaise: data.amountPaise,
  currency: data.currency,
  keyId: data.keyId,
  verifyFirst: { intentId: intent.id, state: intent.state, orderRequestState: intent.order_request_state, gatewayOrderId: intent.gateway_order_id },
  paymentIdempotency: { retryOrderId: retryData.orderId, sameOrderOnRetry: true, paymentIntentCount: intentRows.length },
};
writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence));
