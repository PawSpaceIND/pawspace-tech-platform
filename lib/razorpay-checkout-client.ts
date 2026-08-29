export type RazorpayCheckoutProof = { razorpay_payment_id: string; razorpay_order_id: string; razorpay_signature: string };
type CheckoutInput = { keyId: string; orderId: string; amount: number; currency: string; customerName: string; phone: string; description: string };
type RazorpayInstance = { open: () => void; on: (event: string, callback: (value: unknown) => void) => void };
declare global { interface Window { Razorpay?: new (options: Record<string, unknown>) => RazorpayInstance } }
let loader: Promise<void> | null = null;

async function loadCheckout() {
  if (typeof window === "undefined") throw new Error("Razorpay Checkout requires a browser");
  if (window.Razorpay) return;
  if (!loader) loader = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.async = true;
    script.onload = () => window.Razorpay ? resolve() : reject(new Error("Razorpay Checkout did not initialise"));
    script.onerror = () => reject(new Error("Razorpay Checkout could not be loaded"));
    document.head.appendChild(script);
  });
  return loader;
}

export async function openRazorpayCheckout(input: CheckoutInput): Promise<RazorpayCheckoutProof> {
  await loadCheckout();
  if (!input.keyId.startsWith("rzp_test_")) throw new Error("Customer UAT checkout is locked to a Razorpay test key");
  return new Promise((resolve, reject) => {
    const Razorpay = window.Razorpay;
    if (!Razorpay) return reject(new Error("Razorpay Checkout is unavailable"));
    const checkout = new Razorpay({
      key: input.keyId, amount: Math.round(input.amount * 100), currency: input.currency, order_id: input.orderId,
      name: "PawSpace", description: input.description, prefill: { name: input.customerName, contact: `+91${input.phone}` },
      retry: { enabled: false }, modal: { ondismiss: () => reject(new Error("Razorpay Checkout was closed before payment")) },
      handler: (raw: unknown) => {
        const proof = raw as Partial<RazorpayCheckoutProof>;
        if (!proof.razorpay_payment_id || !proof.razorpay_order_id || !proof.razorpay_signature) return reject(new Error("Razorpay Checkout returned incomplete proof"));
        resolve(proof as RazorpayCheckoutProof);
      },
    });
    checkout.on("payment.failed", failure => reject(new Error(`Razorpay payment failed: ${JSON.stringify(failure)}`)));
    checkout.open();
  });
}
