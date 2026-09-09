/**
 * PawSpace Mobile Native Razorpay SDK Binding
 * Strictly enforces sandbox environment locks:
 * PAWSPACE_PAYMENT_ENV="sandbox", FORBID_PRODUCTION="true", PAWSPACE_PAYMENT_LIVE_APPROVED="false".
 */

export interface MobileRazorpayCheckoutOptions {
  keyId: string;
  orderId: string;
  amountPaise: number;
  currency?: string;
  name?: string;
  description?: string;
  prefill?: {
    name?: string;
    contact?: string;
    email?: string;
  };
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

/**
 * Validate that sandbox security locks are strictly held.
 * Prevents any accidental or malicious activation of live payment gateways.
 */
/**
 * The three sandbox locks, and the only values that satisfy them.
 *
 * A release-gating lock has to be PROVEN, not assumed. The previous version
 * defaulted every absent value to its safe setting (|| "sandbox", || "true",
 * || "false"), so a build that simply never set the locks inherited a
 * safe-looking result and passed - and an unrecognised value such as
 * "unexpected" fell through the equality checks entirely. Both now fail closed.
 *
 * Exact string comparison only: no defaults, no aliases, no trimming, no case
 * folding. This is deliberately the same posture as lib/payment-environment.ts,
 * which accepts only the exact strings "sandbox" and "live".
 */
const SANDBOX_LOCKS = {
  PAWSPACE_PAYMENT_ENV: "sandbox",
  FORBID_PRODUCTION: "true",
  PAWSPACE_PAYMENT_LIVE_APPROVED: "false",
} as const;

export function assertSandboxPaymentLocks(env?: Record<string, unknown>): void {
  // When an environment is supplied, it is the whole truth: falling back to
  // process.env would let ambient values satisfy a lock the caller did not set.
  const source: Record<string, unknown> = env
    ?? (typeof process !== "undefined" && process.env ? (process.env as Record<string, unknown>) : {});

  for (const [name, expected] of Object.entries(SANDBOX_LOCKS)) {
    const value = source[name];
    if (value !== expected) {
      throw new Error(
        `PAWSPACE PAYMENT SECURITY LOCK VIOLATION: ${name} must be exactly '${expected}', received ${
          value === undefined ? "no value" : JSON.stringify(value)
        }`
      );
    }
  }
}

/**
 * Validates that the provided Razorpay key is exclusively a sandbox key.
 */
export function assertSandboxKey(keyId: string): void {
  const key = String(keyId || "").trim();
  if (key.startsWith("rzp_live_")) {
    throw new Error(
      "PAWSPACE SECURITY LOCK REJECTION: Live Razorpay key rejected. Only test/sandbox credentials are authorized."
    );
  }
  if (!key.startsWith("rzp_test_") && key !== "rzp_test_placeholder") {
    throw new Error(
      "PAWSPACE SECURITY LOCK REJECTION: Key must be an authorized Razorpay sandbox key starting with 'rzp_test_'."
    );
  }
}

/**
 * Launches native Razorpay checkout or web checkout fallback with absolute sandbox locks.
 */
export async function openMobileRazorpayCheckout(
  options: MobileRazorpayCheckoutOptions,
  runtimeEnv?: Record<string, unknown>
): Promise<MobileRazorpayResult> {
  // 1. Enforce sandbox locks
  assertSandboxPaymentLocks(runtimeEnv);
  assertSandboxKey(options.keyId);

  if (!options.orderId || !options.amountPaise || options.amountPaise <= 0) {
    return {
      success: false,
      code: "INVALID_PARAMETERS",
      description: "Valid order ID and positive integer amount in paise are required",
      environment: "sandbox",
    };
  }

  // 2. Check for native Cordova / Capacitor Razorpay plugin on window
  const win = typeof window !== "undefined" ? (window as unknown as Record<string, unknown>) : null;
  const nativePlugin = win?.RazorpayCheckout as
    | {
        open: (
          opts: Record<string, unknown>,
          success: (data: { razorpay_payment_id: string; razorpay_order_id: string; razorpay_signature: string }) => void,
          error: (err: { code: string; description: string }) => void
        ) => void;
      }
    | undefined;

  const payload = {
    key: options.keyId,
    amount: options.amountPaise,
    currency: options.currency || "INR",
    name: options.name || "PawSpace (Sandbox)",
    description: options.description || "PawSpace Service Booking",
    order_id: options.orderId,
    prefill: options.prefill || {},
    notes: {
      ...options.notes,
      environment: "sandbox",
      platform: "pawspace_mobile",
    },
    theme: {
      color: options.themeColor || "#4b168c",
    },
  };

  if (nativePlugin && typeof nativePlugin.open === "function") {
    return new Promise<MobileRazorpayResult>((resolve) => {
      nativePlugin.open(
        payload,
        (data) => {
          resolve({
            success: true,
            paymentId: data.razorpay_payment_id,
            orderId: data.razorpay_order_id || options.orderId,
            signature: data.razorpay_signature,
            environment: "sandbox",
          });
        },
        (err) => {
          resolve({
            success: false,
            code: err.code || "PAYMENT_FAILED",
            description: err.description || "Native payment failed or cancelled",
            environment: "sandbox",
          });
        }
      );
    });
  }

  // 3. Fallback: Load standard Razorpay script in WebView / browser
  if (!win) {
    return {
      success: false,
      code: "NO_WINDOW_CONTEXT",
      description: "Payment checkout requires a browser or webview environment",
      environment: "sandbox",
    };
  }

  await loadRazorpayScript();

  const RazorpayConstructor = win.Razorpay as
    | (new (opts: Record<string, unknown>) => {
        open: () => void;
        on: (event: string, handler: (resp: unknown) => void) => void;
      })
    | undefined;

  if (!RazorpayConstructor) {
    return {
      success: false,
      code: "SDK_UNAVAILABLE",
      description: "Razorpay Checkout script could not be loaded",
      environment: "sandbox",
    };
  }

  return new Promise<MobileRazorpayResult>((resolve) => {
    let settled = false;

    const rzp = new RazorpayConstructor({
      ...payload,
      handler: (response: {
        razorpay_payment_id: string;
        razorpay_order_id: string;
        razorpay_signature: string;
      }) => {
        if (!settled) {
          settled = true;
          resolve({
            success: true,
            paymentId: response.razorpay_payment_id,
            orderId: response.razorpay_order_id || options.orderId,
            signature: response.razorpay_signature,
            environment: "sandbox",
          });
        }
      },
      modal: {
        ondismiss: () => {
          if (!settled) {
            settled = true;
            resolve({
              success: false,
              code: "USER_DISMISSED",
              description: "Customer closed the checkout window",
              environment: "sandbox",
            });
          }
        },
      },
    });

    rzp.open();
  });
}

function loadRazorpayScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if ((window as unknown as Record<string, unknown>).Razorpay) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load Razorpay Checkout SDK"));
    document.body.appendChild(script);
  });
}
