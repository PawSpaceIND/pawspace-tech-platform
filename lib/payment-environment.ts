export type PaymentEnvironment="sandbox"|"live";
type PaymentEnv=Record<string,unknown>|null|undefined;

/**
 * The payment environment has one safe rollback: an absent/empty declaration remains sandbox.
 * Any non-empty declaration must be exactly one of the two supported semantic values after
 * whitespace/case normalization; typos never fall through to live credentials.
 */
export function declaredPaymentEnvironment(env:PaymentEnv){return String(env?.PAWSPACE_PAYMENT_ENV??"").trim().toLowerCase();}
export function parsePaymentEnvironment(env:PaymentEnv):PaymentEnvironment{const declared=declaredPaymentEnvironment(env);if(!declared)return"sandbox";if(declared==="sandbox"||declared==="live")return declared;throw new Error('PAWSPACE_PAYMENT_ENV must be "sandbox" or "live"');}

/** Sandbox-only capabilities still require an explicit sandbox declaration. */
export function sandboxCapabilitiesUnlocked(env:PaymentEnv){return declaredPaymentEnvironment(env)==="sandbox";}
