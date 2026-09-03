/**
 * Environment-aware, fail-closed Razorpay order/refund adapter for the CUSTOMER verify-first payment
 * path. All provider-bound money is converted to integer paise before the HTTP boundary.
 */
import{parsePaymentEnvironment,type PaymentEnvironment}from"./payment-environment";
export type{PaymentEnvironment}from"./payment-environment";

type RazorEnv = Record<string, unknown>;
export type OrderResult =
  | { connected: true; environment: PaymentEnvironment; order: Record<string, unknown> }
  | { connected: false; environment: PaymentEnvironment; reason: string };
export type PaymentLinkResult =
  | { connected: true; environment: "sandbox"; paymentLink: Record<string, unknown> }
  | { connected: false; environment: PaymentEnvironment | "unconfigured"; reason: string };

export function paymentEnvironment(env: RazorEnv): PaymentEnvironment {
  return parsePaymentEnvironment(env);
}

function credentials(env: RazorEnv): { environment: PaymentEnvironment; keyId: string; keySecret: string } {
  const environment = paymentEnvironment(env);
  const keyId = String((environment === "sandbox" ? env?.RAZORPAY_KEY_ID_SANDBOX : env?.RAZORPAY_KEY_ID) || "").trim();
  const keySecret = String((environment === "sandbox" ? env?.RAZORPAY_KEY_SECRET_SANDBOX : env?.RAZORPAY_KEY_SECRET) || "").trim();
  return { environment, keyId, keySecret };
}

const RAZORPAY_API = "https://api.razorpay.com";
const MAX_PROVIDER_BYTES = 65_536;

function exactRupeesToPaise(value: string | number) {
  const source = String(value).trim();
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(source);
  if (!match) throw new Error("Razorpay amount must have at most two decimal places");
  const paise = BigInt(match[1]) * BigInt(100) + BigInt((match[2] || "").padEnd(2, "0"));
  if (paise <= BigInt(0) || paise > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Razorpay amount is outside the supported paise range");
  return Number(paise);
}

function assertPositivePaise(amountPaise: number) {
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) throw new Error("A positive integer paise amount is required");
  return amountPaise;
}

function providerBase(env: RazorEnv, environment: PaymentEnvironment) {
  const raw = String(env?.PAWSPACE_RAZORPAY_API_BASE_URL || RAZORPAY_API).trim().replace(/\/$/, "");
  if (raw === RAZORPAY_API) return raw;
  if (environment !== "sandbox" || String(env?.PAWSPACE_PAYMENT_CONTRACT_TEST || "").toLowerCase() !== "true") throw new Error("Razorpay contract-test override is allowed only in the sandbox contract-test environment");
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("Razorpay contract-test override URL is invalid"); }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (!loopback || !["http:", "https:"].includes(url.protocol)) throw new Error("Razorpay contract-test override must use a loopback HTTP(S) server");
  return raw;
}

async function boundedBody(response: Response) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > MAX_PROVIDER_BYTES) throw new Error("Razorpay provider response exceeded the size limit");
  if (!response.body) return "";
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) { total += value.byteLength; if (total > MAX_PROVIDER_BYTES) { await reader.cancel(); throw new Error("Razorpay provider response exceeded the size limit"); } chunks.push(value); }
  }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

async function providerRequest(env: RazorEnv, environment: PaymentEnvironment, path: string, init: RequestInit) {
  const timeout = Math.max(50, Math.min(Number(env?.PAWSPACE_RAZORPAY_TIMEOUT_MS || 10_000), 30_000));
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(`${providerBase(env, environment)}${path}`, { ...init, redirect: "error", signal: controller.signal });
    const raw = await boundedBody(response);
    let body: Record<string, unknown> = {};
    try { const parsed = JSON.parse(raw); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>; } catch {}
    return { response, body };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error(`Razorpay provider request timed out after ${timeout}ms`);
    throw error;
  } finally { clearTimeout(timer); }
}

export function publicKeyId(env: RazorEnv): string {
  return credentials(env).keyId;
}

/** Paise-native order creation used by the durable financial outbox worker. */
export async function createPaymentOrderPaise(env: RazorEnv, input: { bookingId: string; paymentId: string; amountPaise: number; currency: string }): Promise<OrderResult> {
  const { environment, keyId, keySecret } = credentials(env);
  if (environment === "live" && env?.PAWSPACE_PAYMENT_LIVE_APPROVED !== "true") return { connected: false, environment, reason: "Live Razorpay order creation is not approved (PAWSPACE_PAYMENT_LIVE_APPROVED must equal \"true\")" };
  if (!keyId || !keySecret) return { connected: false, environment, reason: `Razorpay ${environment} API credentials are not configured - online payment is not connected yet` };
  let amountPaise: number;
  try { amountPaise = assertPositivePaise(input.amountPaise); } catch (error) { return { connected: false, environment, reason: error instanceof Error ? error.message : String(error) }; }
  try {
    const { response, body } = await providerRequest(env, environment, "/v1/orders", {
      method: "POST",
      headers: { authorization: `Basic ${btoa(`${keyId}:${keySecret}`)}`, "content-type": "application/json" },
      body: JSON.stringify({ amount: amountPaise, currency: input.currency, receipt: input.paymentId.slice(0, 40), notes: { booking_id: input.bookingId, payment_id: input.paymentId, pawspace_environment: environment } }),
    });
    if (!response.ok) return { connected: false, environment, reason: `Razorpay ${environment} order create failed (${response.status}): ${String((body.error as Record<string, unknown> | undefined)?.description || "request failed")}` };
    if (!String(body.id || "").startsWith("order_")) return { connected: false, environment, reason: "Razorpay did not return an order id" };
    return { connected: true, environment, order: body };
  } catch (error) {
    return { connected: false, environment, reason: `Razorpay request failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Compatibility boundary: convert decimal rupees exactly, never with floating-point multiplication. */
export async function createPaymentOrder(env: RazorEnv, input: { bookingId: string; paymentId: string; amount: number; currency: string }): Promise<OrderResult> {
  let amountPaise: number;
  try { amountPaise = exactRupeesToPaise(input.amount); } catch (error) {
    return { connected: false, environment: paymentEnvironment(env), reason: error instanceof Error ? error.message : String(error) };
  }
  return createPaymentOrderPaise(env, { bookingId: input.bookingId, paymentId: input.paymentId, amountPaise, currency: input.currency });
}

export async function createSandboxPaymentLink(env: RazorEnv, input: { bookingId: string; paymentId: string; referenceId: string; customerId: string; amount: number; currency: string; expiresAt: number }): Promise<PaymentLinkResult> {
  let environment: PaymentEnvironment, keyId: string, keySecret: string;
  try {
    ({ environment, keyId, keySecret } = credentials(env));
  } catch (error) {
    // parsePaymentEnvironment throws when PAWSPACE_PAYMENT_ENV is unset or not exactly
    // "sandbox"/"live". Report it the same way as every other refusal here rather than escaping
    // this function as an exception: the environment is genuinely unknown, so say so.
    return { connected: false, environment: "unconfigured", reason: error instanceof Error ? error.message : String(error) };
  }
  if (environment !== "sandbox") return { connected: false, environment, reason: "Post-service payment links are locked to Razorpay sandbox" };
  if (!keyId || !keySecret) return { connected: false, environment, reason: "Razorpay sandbox API credentials are not configured - payment link was not created" };
  let amountPaise: number;
  try { amountPaise = exactRupeesToPaise(input.amount); } catch (error) { return { connected: false, environment, reason: error instanceof Error ? error.message : String(error) }; }
  if (!Number.isFinite(input.expiresAt) || input.expiresAt <= Date.now()) return { connected: false, environment, reason: "A future payment-link expiry is required" };
  try {
    const { response, body } = await providerRequest(env, environment, "/v1/payment_links", {
      method: "POST",
      headers: { authorization: `Basic ${btoa(`${keyId}:${keySecret}`)}`, "content-type": "application/json" },
      body: JSON.stringify({
        amount: amountPaise, currency: input.currency, accept_partial: false,
        expire_by: Math.floor(input.expiresAt / 1000),
        reference_id: input.referenceId.slice(0, 40), description: `PawSpace booking ${input.bookingId}`,
        notes: { booking_id: input.bookingId, payment_id: input.paymentId, customer_id: input.customerId, pawspace_environment: "sandbox" },
      }),
    });
    if (!response.ok) return { connected: false, environment, reason: `Razorpay sandbox payment-link create failed (${response.status}): ${String((body.error as Record<string, unknown> | undefined)?.description || "request failed")}` };
    if (!String(body.id || "").startsWith("plink_") || !String(body.short_url || "").startsWith("https://") || !Number.isFinite(Number(body.expire_by)) || Number(body.expire_by) <= Math.floor(Date.now() / 1000)) return { connected: false, environment, reason: "Razorpay did not return a collectable payment link" };
    return { connected: true, environment, paymentLink: body };
  } catch (error) {
    return { connected: false, environment, reason: `Razorpay sandbox payment-link request failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
