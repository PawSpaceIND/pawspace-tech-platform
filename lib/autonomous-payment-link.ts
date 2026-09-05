import { parsePaymentEnvironment, type PaymentEnvironment } from "./payment-environment";

type Runtime = Record<string, unknown>;
type PaymentLinkInput = {
  bookingId: string;
  paymentId: string;
  referenceId: string;
  customerId: string;
  amount: number;
  currency: string;
  expiresAt: number;
};

export type AutonomousPaymentLinkResult =
  | { connected: true; environment: PaymentEnvironment; paymentLink: Record<string, unknown> }
  | { connected: false; environment: PaymentEnvironment | "unconfigured"; reason: string };

const RAZORPAY_API = "https://api.razorpay.com";
const MAX_PROVIDER_BYTES = 65_536;

function exactRupeesToPaise(value: number) {
  const source = String(value).trim();
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(source);
  if (!match) throw new Error("Razorpay amount must have at most two decimal places");
  const paise = BigInt(match[1]) * BigInt(100) + BigInt((match[2] || "").padEnd(2, "0"));
  if (paise <= BigInt(0) || paise > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Razorpay amount is outside the supported paise range");
  return Number(paise);
}

function resolveCredentials(runtime: Runtime):
  | { ok: true; environment: PaymentEnvironment; keyId: string; keySecret: string }
  | { ok: false; reason: string } {
  let environment: PaymentEnvironment;
  try {
    environment = parsePaymentEnvironment(runtime);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  const keyId = String(environment === "sandbox" ? runtime.RAZORPAY_KEY_ID_SANDBOX : runtime.RAZORPAY_KEY_ID || "").trim();
  const keySecret = String(environment === "sandbox" ? runtime.RAZORPAY_KEY_SECRET_SANDBOX : runtime.RAZORPAY_KEY_SECRET || "").trim();
  return { ok: true, environment, keyId, keySecret };
}

function providerBase(runtime: Runtime, environment: PaymentEnvironment) {
  const raw = String(runtime.PAWSPACE_RAZORPAY_API_BASE_URL || RAZORPAY_API).trim().replace(/\/$/, "");
  if (raw === RAZORPAY_API) return raw;
  if (environment !== "sandbox" || String(runtime.PAWSPACE_PAYMENT_CONTRACT_TEST || "").toLowerCase() !== "true") {
    throw new Error("Razorpay payment-link override is allowed only for sandbox contract tests");
  }
  const url = new URL(raw);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (!loopback || !["http:", "https:"].includes(url.protocol)) throw new Error("Razorpay payment-link contract-test URL must be loopback HTTP(S)");
  return raw;
}

async function boundedBody(response: Response) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > MAX_PROVIDER_BYTES) throw new Error("Razorpay provider response exceeded the size limit");
  const raw = await response.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_PROVIDER_BYTES) throw new Error("Razorpay provider response exceeded the size limit");
  return raw;
}

/**
 * Creates a customer-facing Razorpay payment link without ever treating link creation as payment.
 * Live creation is fail-closed behind the same PAWSPACE_PAYMENT_LIVE_APPROVED switch used by the
 * canonical Razorpay order adapter. Payment truth still comes only from the signed webhook.
 */
export async function createAutonomousPaymentLink(
  runtime: Runtime,
  input: PaymentLinkInput,
  fetcher: typeof fetch = fetch,
): Promise<AutonomousPaymentLinkResult> {
  const resolved = resolveCredentials(runtime);
  if (!resolved.ok) return { connected: false, environment: "unconfigured", reason: resolved.reason };
  const { environment, keyId, keySecret } = resolved;
  if (environment === "live" && String(runtime.PAWSPACE_PAYMENT_LIVE_APPROVED || "").toLowerCase() !== "true") {
    return { connected: false, environment, reason: "Live Razorpay payment-link creation is not approved (PAWSPACE_PAYMENT_LIVE_APPROVED must equal \"true\")" };
  }
  if (!keyId || !keySecret) return { connected: false, environment, reason: `Razorpay ${environment} API credentials are not configured` };
  if (!Number.isFinite(input.expiresAt) || input.expiresAt <= Date.now()) return { connected: false, environment, reason: "A future payment-link expiry is required" };
  let amount: number;
  try {
    amount = exactRupeesToPaise(input.amount);
  } catch (error) {
    return { connected: false, environment, reason: error instanceof Error ? error.message : String(error) };
  }
  const timeoutMs = Math.max(50, Math.min(Number(runtime.PAWSPACE_RAZORPAY_TIMEOUT_MS || 10_000), 30_000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(`${providerBase(runtime, environment)}/v1/payment_links`, {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`${keyId}:${keySecret}`)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        amount,
        currency: input.currency,
        accept_partial: false,
        expire_by: Math.floor(input.expiresAt / 1000),
        reference_id: input.referenceId.slice(0, 40),
        description: `PawSpace booking ${input.bookingId}`,
        notes: {
          booking_id: input.bookingId,
          payment_id: input.paymentId,
          customer_id: input.customerId,
          pawspace_environment: environment,
          source: "autonomous_voice_booking",
        },
      }),
      redirect: "error",
      signal: controller.signal,
    });
    const raw = await boundedBody(response);
    let body: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch {}
    if (!response.ok) {
      const error = body.error && typeof body.error === "object" ? body.error as Record<string, unknown> : {};
      return { connected: false, environment, reason: `Razorpay ${environment} payment-link create failed (${response.status}): ${String(error.description || "request failed")}` };
    }
    const id = String(body.id || "");
    const shortUrl = String(body.short_url || "");
    if (!id.startsWith("plink_") || !shortUrl.startsWith("https://")) return { connected: false, environment, reason: "Razorpay did not return a collectable payment link" };
    return { connected: true, environment, paymentLink: body };
  } catch (error) {
    const reason = error instanceof Error && error.name === "AbortError"
      ? `Razorpay payment-link request timed out after ${timeoutMs}ms`
      : `Razorpay payment-link request failed: ${error instanceof Error ? error.message : String(error)}`;
    return { connected: false, environment, reason };
  } finally {
    clearTimeout(timer);
  }
}
