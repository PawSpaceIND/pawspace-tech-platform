/** Canonical, fail-closed payment-environment handling. */
export type PaymentEnvironment="sandbox"|"live";
type PaymentEnv=Record<string,unknown>|null|undefined;

export class PaymentEnvironmentConfigurationError extends Error{
 constructor(value:unknown){super(`PAWSPACE_PAYMENT_ENV must be exactly "sandbox" or "live"; received ${value===undefined||value===null||value===""?"an unset/empty value":JSON.stringify(value)}`);this.name="PaymentEnvironmentConfigurationError";}
}

/** The only payment-environment parser. No defaults, aliases, trimming, or case folding. */
export function parsePaymentEnvironment(env:PaymentEnv):PaymentEnvironment{
 const value=env?.PAWSPACE_PAYMENT_ENV;
 if(value==="sandbox"||value==="live")return value;
 throw new PaymentEnvironmentConfigurationError(value);
}

/** Non-authorizing diagnostic view of the declaration. */
export function declaredPaymentEnvironment(env:PaymentEnv){
 const value=env?.PAWSPACE_PAYMENT_ENV;
 return typeof value==="string"?value:"";
}

/** Sandbox-only capabilities require the same exact canonical declaration. */
export function sandboxCapabilitiesUnlocked(env:PaymentEnv){
 try{return parsePaymentEnvironment(env)==="sandbox";}catch{return false;}
}
