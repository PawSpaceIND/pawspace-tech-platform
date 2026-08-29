export type RazorpayEnvironment = "sandbox" | "live";
export type RazorpayRuntime = { environment: RazorpayEnvironment; keyId: string; keySecret: string; configured: boolean };

type Env = Record<string, unknown>;

/** Mission 2 payment runtime: sandbox by default; live requires two explicit switches. */
export function resolveRazorpayRuntime(env: Env): RazorpayRuntime {
  const declared = String(env.PAWSPACE_PAYMENT_ENV ?? "sandbox").trim().toLowerCase();
  let environment: RazorpayEnvironment;
  if (!declared || declared === "sandbox") environment = "sandbox";
  else if (declared === "live" && String(env.PAWSPACE_ENABLE_LIVE_PAYMENTS ?? "").trim().toLowerCase() === "true") environment = "live";
  else throw new Error("Razorpay live mode is disabled unless PAWSPACE_PAYMENT_ENV=live and PAWSPACE_ENABLE_LIVE_PAYMENTS=true");

  const keyId = String(environment === "sandbox" ? env.RAZORPAY_KEY_ID_SANDBOX ?? "" : env.RAZORPAY_KEY_ID ?? "").trim();
  const keySecret = String(environment === "sandbox" ? env.RAZORPAY_KEY_SECRET_SANDBOX ?? "" : env.RAZORPAY_KEY_SECRET ?? "").trim();
  if (!keyId && !keySecret) return { environment, keyId: "", keySecret: "", configured: false };
  if (!keyId || !keySecret) throw new Error(`Razorpay ${environment} credentials are incomplete`);
  const prefix = environment === "sandbox" ? "rzp_test_" : "rzp_live_";
  if (!keyId.startsWith(prefix)) throw new Error(`Razorpay ${environment} key id must start with ${prefix}`);
  return { environment, keyId, keySecret, configured: true };
}
