/** Sandbox-only SDK transport. A callback is a receipt, never proof of capture. */
export interface MobileRazorpayCheckoutOptions {
  keyId: string;
  orderId: string;
  amountPaise: number;
  currency?: string;
  name?: string;
  description?: string;
  prefill?: { name?: string; contact?: string; email?: string };
  notes?: Record<string, string>;
  themeColor?: string;
}
export interface MobileRazorpaySuccessResult {
  success: true;
  paymentId: string;
  orderId: string;
  signature: string;
  environment: "sandbox";
}
export interface MobileRazorpayFailureResult {
  success: false;
  code: string;
  description: string;
  environment: "sandbox";
}
export type MobileRazorpayResult = MobileRazorpaySuccessResult | MobileRazorpayFailureResult;
const failure = (code: string, description: string): MobileRazorpayFailureResult =>
  ({ success: false, code, description, environment: "sandbox" });

export function assertSandboxPaymentLocks(env?: Record<string, unknown>): void {
  // An explicit object is authoritative. Missing/false values never fall back to safe defaults.
  const runtime = env ?? (typeof process !== "undefined" ? process.env : {});
  const required = { PAWSPACE_PAYMENT_ENV: "sandbox", FORBID_PRODUCTION: "true", PAWSPACE_PAYMENT_LIVE_APPROVED: "false" };
  for (const [key, expected] of Object.entries(required)) {
    if (String(runtime[key] ?? "").trim().toLowerCase() !== expected) {
      throw new Error(`PAWSPACE PAYMENT SECURITY LOCK VIOLATION: ${key} must be explicitly ${expected}`);
    }
  }
}
export function assertSandboxKey(keyId: string): void {
  const key = String(keyId || "").trim();
  if (key.startsWith("rzp_live_")) throw new Error("PAWSPACE SECURITY LOCK REJECTION: Live Razorpay key rejected");
  if (!/^rzp_test_[a-zA-Z0-9]+$/.test(key) || /placeholder/i.test(key)) {
    throw new Error("PAWSPACE SECURITY LOCK REJECTION: A configured Razorpay test key is required");
  }
}

type Receipt = { razorpay_payment_id?: unknown; razorpay_order_id?: unknown; razorpay_signature?: unknown };
function receiptResult(data: Receipt, expectedOrderId: string): MobileRazorpayResult {
  if (data?.razorpay_order_id !== expectedOrderId ||
      !/^pay_[a-zA-Z0-9_]+$/.test(String(data?.razorpay_payment_id || "")) ||
      !/^[a-fA-F0-9]{64}$/.test(String(data?.razorpay_signature || ""))) {
    return failure("INVALID_RECEIPT", "Payment response could not be matched to this order. Check payment status before retrying.");
  }
  return { success: true, paymentId: String(data.razorpay_payment_id), orderId: expectedOrderId,
    signature: String(data.razorpay_signature), environment: "sandbox" };
}

type Checkout = { open: () => void; close?: () => void; on: (event: string, handler: (response: { error?: { code?: unknown; description?: unknown } }) => void) => void };
type SdkWindow = { Razorpay?: new (options: Record<string, unknown>) => Checkout;
  RazorpayCheckout?: { open: (options: Record<string, unknown>, success: (data: Receipt) => void,
    error: (error: { code?: unknown; description?: unknown }) => void) => void } };
let sdkLoading: Promise<void> | undefined;
let checkoutOpen = false;

function loadRazorpayScript(): Promise<void> {
  const win = window as unknown as SdkWindow;
  if (win.Razorpay) return Promise.resolve();
  if (sdkLoading) return sdkLoading;
  sdkLoading = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      script.onload = null;
      script.onerror = null;
      if (ok && win.Razorpay) resolve();
      else { script.remove(); reject(new Error("Razorpay Checkout SDK unavailable")); }
    };
    const timer = setTimeout(() => finish(false), 12_000);
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.async = true;
    script.onload = () => finish(true);
    script.onerror = () => finish(false);
    try { document.body.appendChild(script); } catch { finish(false); }
  }).finally(() => { sdkLoading = undefined; });
  return sdkLoading;
}

export async function openMobileRazorpayCheckout(options: MobileRazorpayCheckoutOptions,
  runtimeEnv?: Record<string, unknown>): Promise<MobileRazorpayResult> {
  assertSandboxPaymentLocks(runtimeEnv);
  assertSandboxKey(options.keyId);
  if (!/^order_[a-zA-Z0-9_]+$/.test(options.orderId) || !Number.isSafeInteger(options.amountPaise) || options.amountPaise <= 0 ||
      (options.currency !== undefined && options.currency !== "INR")) {
    return failure("INVALID_PARAMETERS", "An order ID, positive integer paise amount and INR currency are required");
  }
  if (typeof window === "undefined") return failure("NO_WINDOW_CONTEXT", "Payment checkout requires a browser or webview environment");
  if (checkoutOpen) return failure("CHECKOUT_ALREADY_OPEN", "Finish or close the current checkout before opening another");
  checkoutOpen = true;
  const win = window as unknown as SdkWindow;
  const payload = { key: options.keyId.trim(), order_id: options.orderId, amount: options.amountPaise,
    currency: "INR", name: options.name || "PawSpace (Sandbox)", description: options.description || "PawSpace Service Booking",
    prefill: options.prefill || {}, notes: { ...options.notes, environment: "sandbox", platform: "pawspace_mobile" },
    theme: { color: options.themeColor || "#4b168c" } };
  try {
    if (win.RazorpayCheckout && typeof win.RazorpayCheckout.open === "function") {
      return await new Promise<MobileRazorpayResult>((resolve) => {
        try {
          win.RazorpayCheckout!.open(payload, data => resolve(receiptResult(data, options.orderId)),
            () => resolve(failure("PAYMENT_FAILED", "Payment failed or was cancelled. Check payment status before retrying.")));
        } catch { resolve(failure("SDK_OPEN_FAILED", "Payment checkout could not open. Please try again.")); }
      });
    }
    try { await loadRazorpayScript(); }
    catch { return failure("SDK_UNAVAILABLE", "Unable to load secure checkout. Check your connection and try again."); }
    const Constructor = win.Razorpay;
    if (!Constructor) return failure("SDK_UNAVAILABLE", "Secure checkout is unavailable. Please try again.");
    return await new Promise<MobileRazorpayResult>((resolve) => {
      let settled = false;
      const finish = (result: MobileRazorpayResult) => { if (!settled) { settled = true; resolve(result); } };
      let rzp: Checkout;
      try {
        rzp = new Constructor({ ...payload, retry: { enabled: false },
          handler: (data: Receipt) => finish(receiptResult(data, options.orderId)),
          modal: { ondismiss: () => finish(failure("USER_DISMISSED", "Checkout closed. No payment confirmation has been recorded here.")) } });
        rzp.on("payment.failed", () => {
          finish(failure("PAYMENT_FAILED", "Payment was unsuccessful. Check payment status before retrying."));
          try { rzp.close?.(); } catch { /* Failure has already been surfaced. */ }
        });
        rzp.open();
      } catch { finish(failure("SDK_OPEN_FAILED", "Payment checkout could not open. Please try again.")); }
    });
  } finally { checkoutOpen = false; }
}
