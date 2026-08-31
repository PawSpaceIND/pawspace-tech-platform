"use client";

type CheckoutOrder = {
  connected: boolean;
  environment: "sandbox" | "live";
  bookingId: string;
  paymentId: string;
  orderId: string;
  amount: number;
  amountPaise: number;
  currency: string;
  keyId: string;
  status: string;
};

type PaymentTruth = {
  bookingId: string;
  paymentId: string;
  paymentStatus: string;
  verifiedCaptured: boolean;
  environment: string | null;
  gatewayOrderId: string | null;
  gatewayPaymentId: string | null;
  reconciliationStatus: string | null;
  capturedAmount: number | null;
  refundedAmount: number | null;
  varianceAmount: number | null;
};

type RazorpaySuccess = {
  razorpay_payment_id?: string;
  razorpay_order_id?: string;
  razorpay_signature?: string;
};

type RazorpayInstance = {
  open(): void;
  on(event: "payment.failed", callback: (payload: unknown) => void): void;
};

type RazorpayConstructor = new (options: Record<string, unknown>) => RazorpayInstance;

declare global {
  interface Window { Razorpay?: RazorpayConstructor }
}

const CHECKOUT_SRC = "https://checkout.razorpay.com/v1/checkout.js";
let checkoutScriptPromise: Promise<void> | null = null;

function messageFrom(value: unknown, fallback: string) {
  if (value && typeof value === "object" && "error" in value && typeof value.error === "string") return value.error;
  return fallback;
}

async function readJson(response: Response) {
  const payload = await response.json().catch(() => ({})) as { data?: unknown; error?: string };
  if (!response.ok) throw new Error(messageFrom(payload, `Payment request failed (${response.status})`));
  return payload.data;
}

export function loadRazorpayCheckout() {
  if (typeof window === "undefined") return Promise.reject(new Error("Razorpay Checkout requires a browser"));
  if (window.Razorpay) return Promise.resolve();
  if (checkoutScriptPromise) return checkoutScriptPromise;
  checkoutScriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${CHECKOUT_SRC}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Unable to load Razorpay Checkout")), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = CHECKOUT_SRC;
    script.async = true;
    script.referrerPolicy = "strict-origin-when-cross-origin";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Unable to load Razorpay Checkout"));
    document.head.appendChild(script);
  }).catch(error => {
    checkoutScriptPromise = null;
    throw error;
  });
  return checkoutScriptPromise;
}

export async function createCustomerPaymentOrder(bookingId: string) {
  const response = await fetch("/api/payment-order", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "create", bookingId }),
  });
  const data = await readJson(response) as CheckoutOrder;
  if (!data?.connected) throw new Error("Razorpay Test Mode is not connected for this booking");
  if (data.environment !== "sandbox") throw new Error("This certification checkout is restricted to Razorpay Test Mode");
  if (!data.keyId || !data.orderId?.startsWith("order_") || !Number.isInteger(data.amountPaise) || data.amountPaise <= 0) {
    throw new Error("Razorpay Test order is incomplete");
  }
  return data;
}

export async function verifyCustomerCheckout(bookingId: string, result: RazorpaySuccess) {
  const paymentId = String(result.razorpay_payment_id || "").trim();
  const signature = String(result.razorpay_signature || "").trim();
  if (!paymentId.startsWith("pay_") || !/^[a-fA-F0-9]{64}$/.test(signature)) throw new Error("Razorpay callback was incomplete");
  const response = await fetch("/api/payment-order", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "verify_checkout", bookingId, razorpayPaymentId: paymentId, razorpaySignature: signature }),
  });
  return readJson(response) as Promise<{ verified: true; bookingId: string; paymentId: string; status: "awaiting_webhook_capture" }>;
}

export async function readCustomerPaymentTruth(bookingId: string) {
  const response = await fetch(`/api/payment-order?bookingId=${encodeURIComponent(bookingId)}`, { cache: "no-store" });
  return readJson(response) as Promise<PaymentTruth>;
}

export async function waitForWebhookCapture(bookingId: string, options: { attempts?: number; delayMs?: number } = {}) {
  const attempts = Math.max(1, options.attempts ?? 12);
  const delayMs = Math.max(250, options.delayMs ?? 1000);
  let last = await readCustomerPaymentTruth(bookingId);
  if (last.verifiedCaptured) return last;
  for (let attempt = 1; attempt < attempts; attempt += 1) {
    await new Promise(resolve => window.setTimeout(resolve, delayMs));
    last = await readCustomerPaymentTruth(bookingId);
    if (last.verifiedCaptured) return last;
  }
  return last;
}

export async function openRazorpayTestCheckout(input: {
  bookingId: string;
  customerName?: string;
  customerPhone?: string;
  customerEmail?: string;
  description?: string;
}) {
  const order = await createCustomerPaymentOrder(input.bookingId);
  await loadRazorpayCheckout();
  if (!window.Razorpay) throw new Error("Razorpay Checkout did not initialise");

  return new Promise<{ outcome: "captured" | "capture_pending" | "cancelled" | "failed"; order: CheckoutOrder; truth?: PaymentTruth; error?: string }>(resolve => {
    let settled = false;
    const finish = (value: { outcome: "captured" | "capture_pending" | "cancelled" | "failed"; order: CheckoutOrder; truth?: PaymentTruth; error?: string }) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const checkout = new window.Razorpay!({
      key: order.keyId,
      order_id: order.orderId,
      amount: order.amountPaise,
      currency: order.currency,
      name: "PawSpace",
      description: input.description || "PawSpace service",
      prefill: { name: input.customerName || "", contact: input.customerPhone || "", email: input.customerEmail || "" },
      notes: { pawspace_booking_id: input.bookingId, payment_environment: "sandbox" },
      modal: { ondismiss: () => finish({ outcome: "cancelled", order, error: "Payment was not completed. Your booking remains confirmed and payment is still pending." }) },
      handler: async (result: RazorpaySuccess) => {
        try {
          await verifyCustomerCheckout(input.bookingId, result);
          const truth = await waitForWebhookCapture(input.bookingId);
          finish(truth.verifiedCaptured
            ? { outcome: "captured", order, truth }
            : { outcome: "capture_pending", order, truth, error: "Razorpay authorization was verified. Capture confirmation is still pending from the webhook; do not pay again yet." });
        } catch (error) {
          finish({ outcome: "failed", order, error: error instanceof Error ? error.message : "Unable to verify Razorpay payment" });
        }
      },
    });
    checkout.on("payment.failed", () => finish({ outcome: "failed", order, error: "Razorpay Test payment failed. Your booking remains confirmed and can be paid again." }));
    checkout.open();
  });
}
