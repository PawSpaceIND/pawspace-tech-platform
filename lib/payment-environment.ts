/**
 * Canonical payment-environment handling.
 *
 * Provider-bound payment operations must use parsePaymentEnvironment(). It accepts only the two
 * deliberately supported runtime values and throws for missing, misspelled, cased, padded, or otherwise
 * invalid declarations. That makes an invalid deployment configuration fail closed before money can
 * cross a provider boundary.
 *
 * declaredPaymentEnvironment() and sandboxCapabilitiesUnlocked() remain the declaration/introspection
 * helpers used by sandbox-only capability gates. They do not authorize provider-bound money movement.
 */
export type PaymentEnvironment="sandbox"|"live";
type PaymentEnv=Record<string,unknown>|null|undefined;

export class PaymentEnvironmentConfigurationError extends Error{
 constructor(value:unknown){super(`PAWSPACE_PAYMENT_ENV must be exactly "sandbox" or "live"; received ${value===undefined||value===null||value===""?"an unset/empty value":JSON.stringify(value)}`);this.name="PaymentEnvironmentConfigurationError";}
}

/** Strict provider-bound parser: no default, aliases, trimming, or case folding. */
export function parsePaymentEnvironment(env:PaymentEnv):PaymentEnvironment{
 const value=env?.PAWSPACE_PAYMENT_ENV;
 if(value==="sandbox"||value==="live")return value;
 throw new PaymentEnvironmentConfigurationError(value);
}

/** The declared environment for non-authorizing diagnostics/capability checks. */
export function declaredPaymentEnvironment(env:PaymentEnv){return String(env?.PAWSPACE_PAYMENT_ENV??"").trim().toLowerCase();}

/** Sandbox-only capabilities require an explicit sandbox declaration. */
export function sandboxCapabilitiesUnlocked(env:PaymentEnv){return declaredPaymentEnvironment(env)==="sandbox";}
