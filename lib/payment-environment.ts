/**
 * Single fail-closed payment environment parser.
 *
 * Payment mode is a security boundary: only the two explicitly supported values are accepted.
 * Missing, empty, misspelled, or otherwise unknown values must not silently select provider
 * credentials or unlock sandbox-only capabilities.
 */
export type PaymentEnvironment = "sandbox" | "live";
type PaymentEnv = Record<string, unknown> | null | undefined;

export function parsePaymentEnvironment(env: PaymentEnv): PaymentEnvironment {
  const declared = String(env?.PAWSPACE_PAYMENT_ENV ?? "").trim().toLowerCase();
  if (declared === "sandbox" || declared === "live") return declared;
  throw new Error("PAWSPACE_PAYMENT_ENV must be explicitly set to 'sandbox' or 'live'");
}

/** Compatibility name for existing callers; all payment environment reads share the strict parser. */
export const paymentEnvironment = parsePaymentEnvironment;

/** Sandbox-only staff/test capabilities require the same explicit, valid declaration. */
export function sandboxCapabilitiesUnlocked(env: PaymentEnv) {
  try { return parsePaymentEnvironment(env) === "sandbox"; }
  catch { return false; }
}
