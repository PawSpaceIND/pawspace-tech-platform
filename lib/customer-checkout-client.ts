import { openMobileRazorpayCheckout, type MobileRazorpayCheckoutOptions, type MobileRazorpayResult } from "./mobile/razorpay";
export type CheckoutState = { phase: "ready" | "starting" | "checkout" | "confirming" | "pending" | "captured" | "settled" | "error"; message: string; canCheck: boolean };
type Receipt = { bookingId: string; orderId: string; paymentId: string; signature: string };
type Dependencies = { fetch: typeof fetch; open: (options: MobileRazorpayCheckoutOptions, env?: Record<string, unknown>) => Promise<MobileRazorpayResult> };
/** One UI intent, with same-receipt confirmation retries. No client capture/status writes. */
export class CustomerCheckoutController {
  private receipt?: Receipt;
  private busy = false;
  private captured = false;
  private dependencies: Dependencies;
  private bookingId: string;
  private publish: (state: CheckoutState) => void;
  constructor(bookingId: string, publish: (state: CheckoutState) => void, dependencies?: Dependencies) {
    this.bookingId = bookingId;
    this.publish = publish;
    this.dependencies = dependencies ?? { fetch: (...args) => fetch(...args), open: openMobileRazorpayCheckout };
  }
  private update(phase: CheckoutState["phase"], message: string) { this.publish({ phase, message, canCheck: !!this.receipt && !this.captured }); }
  private async post(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await this.dependencies.fetch("/api/customer-checkout", { method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "content-type": "application/json" }, signal: controller.signal, body: JSON.stringify(body) });
      const result: unknown = await response.json();
      if (!result || typeof result !== "object") throw new Error("Invalid checkout response. Check payment status before retrying.");
      const envelope = result as Record<string, unknown>;
      if (!response.ok) throw new Error(typeof envelope.error === "string" ? envelope.error : "Checkout is unavailable. Contact billing support.");
      if (!envelope.data || typeof envelope.data !== "object") throw new Error("Invalid checkout response. Contact billing support.");
      return envelope.data as Record<string, unknown>;
    } finally { clearTimeout(timeout); }
  }
  private async confirm() {
    if (!this.receipt) return;
    this.update("confirming", "Verifying your payment with PawSpace…");
    const result = await this.post({ action: "confirm", ...this.receipt });
    if (result.bookingId !== this.bookingId || result.orderId !== this.receipt.orderId || result.receiptVerified !== true ||
      result.environment !== "sandbox" || !["captured", "awaiting_confirmation"].includes(String(result.status))) {
      throw new Error("Payment confirmation could not be matched. Contact billing support.");
    }
    if (result.status === "captured") {
      this.captured = true;
      this.update("captured", "This test payment is verified. Refresh billing to view your updated payment and any remaining balance.");
    } else {
      this.update("pending", "Checkout returned successfully; gateway confirmation is still pending. Do not pay again. Check payment status below.");
    }
  }
  async start(): Promise<void> {
    if (this.busy || this.captured) return;
    this.busy = true;
    try {
      // A lost confirmation response must not create/reopen checkout or charge a second time.
      if (this.receipt) { await this.confirm(); return; }
      this.update("starting", "Preparing your secure test payment…");
      const order = await this.post({ action: "start", bookingId: this.bookingId });
      if (order.connected === false && order.status === "nothing_due" && order.bookingId === this.bookingId && order.environment === "sandbox") {
        this.captured = true; // Stop this UI intent; no external payment or capture is claimed.
        this.update("settled", "No payment is currently due for this booking.");
        return;
      }
      if (order.connected !== true || order.environment !== "sandbox" || order.bookingId !== this.bookingId ||
          typeof order.orderId !== "string" || !/^order_[a-zA-Z0-9_]+$/.test(order.orderId) ||
          typeof order.keyId !== "string" || !/^rzp_test_[a-zA-Z0-9]+$/.test(order.keyId) || /placeholder/i.test(order.keyId) ||
          typeof order.amountPaise !== "number" || !Number.isSafeInteger(order.amountPaise) || order.amountPaise <= 0 || order.currency !== "INR" ||
          !order.locks || typeof order.locks !== "object") throw new Error("Secure test checkout is not configured correctly. Contact billing support.");
      const locks = order.locks as Record<string, unknown>;
      if (locks.PAWSPACE_PAYMENT_ENV !== "sandbox" || locks.FORBID_PRODUCTION !== "true" || locks.PAWSPACE_PAYMENT_LIVE_APPROVED !== "false") {
        throw new Error("Checkout safety configuration could not be verified.");
      }
      this.update("checkout", "Complete or close the secure Razorpay test checkout.");
      const result = await this.dependencies.open({ keyId: order.keyId, orderId: order.orderId,
        amountPaise: order.amountPaise, currency: "INR", name: "PawSpace (Sandbox)", description: `Booking ${this.bookingId}` }, locks);
      if (!result.success) { this.update("error", result.description); return; }
      if (result.orderId !== order.orderId || result.environment !== "sandbox" ||
          !/^pay_[a-zA-Z0-9_]+$/.test(result.paymentId) || !/^[a-fA-F0-9]{64}$/.test(result.signature)) {
        throw new Error("Payment receipt could not be matched. Check billing before retrying.");
      }
      this.receipt = { bookingId: this.bookingId, orderId: result.orderId, paymentId: result.paymentId, signature: result.signature };
      await this.confirm();
    } catch (error) {
      this.update("error", error instanceof Error && error.name !== "AbortError" ? error.message : "Connection timed out. Check payment status before retrying.");
    } finally { this.busy = false; }
  }
}
