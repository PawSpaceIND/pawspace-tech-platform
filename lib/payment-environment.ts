/**
 * Which payment environment the runtime has been DECLARED to be in.
 *
 * Two questions live behind one variable, and they must not share an answer:
 *
 *   which CREDENTIALS to use     - an unset PAWSPACE_PAYMENT_ENV resolving to sandbox is the documented,
 *                                  deliberate rollback (docs/payments-staging-setup.md: "unset
 *                                  PAWSPACE_PAYMENT_ENV (-> defaults to sandbox)"). That default stays
 *                                  exactly as documented, in lib/razorpay-client.ts and
 *                                  lib/payment-webhook-gate.ts. Unsetting still takes live money OFF.
 *
 *   which CAPABILITIES to unlock - sandbox mode also unlocks the staff gateway-event simulators, which
 *                                  write signatureVerified:true captures with zero gateway contact, and
 *                                  it exempts a booking from verify-first so a client-asserted
 *                                  'captured' is recorded as collected money. Those are capabilities,
 *                                  and an ABSENT variable must never unlock one: a deployment that
 *                                  simply forgot to set PAWSPACE_PAYMENT_ENV=live would otherwise carry
 *                                  a staff endpoint that records a full-value capture for any booking
 *                                  at any caller-supplied amount, with no money received.
 *
 * So capabilities require an EXPLICIT declaration. This is not a new default: every documented
 * deployment - staging setup, release evidence, human-test readiness - already sets the variable
 * explicitly to `sandbox`. The only case whose behaviour changes is the one nobody declared.
 */
type PaymentEnv=Record<string,unknown>|null|undefined;

/** The declared environment, lowercased and trimmed. Empty string when nothing was declared. */
export function declaredPaymentEnvironment(env:PaymentEnv){return String(env?.PAWSPACE_PAYMENT_ENV??"").trim().toLowerCase();}

/**
 * Whether sandbox-only CAPABILITIES are unlocked - the staff event simulators and the verify-first
 * exemption. True only for an explicit `sandbox` declaration; an absent or empty variable is not a
 * declaration and unlocks nothing.
 */
export function sandboxCapabilitiesUnlocked(env:PaymentEnv){return declaredPaymentEnvironment(env)==="sandbox";}
