import { uatLoginEnabled } from "./uat-staging-auth";
import { developmentOtpSandboxEnabled, resolveOtpAssertionSecret } from "./otp-sandbox-runtime";

/**
 * Service-start OTP policy: every threshold is an explicit runtime setting and nothing here has a
 * default. The business has not yet approved an expiry, an attempt cap, a reissue cap, the services
 * this applies to, or the booking statuses a customer may issue a code from. Until each of those is
 * configured the module answers "not configured" and refuses to issue or verify anything.
 *
 * This module is TEST / NON-PRODUCTION ONLY. A production deployment is refused categorically, before
 * any other setting is read, so PAWSPACE_SERVICE_START_OTP_ENABLED=on cannot activate it there. The
 * one-time code is returned only to the issuing customer's own authenticated response, and only when
 * the existing sandbox code-return conventions (UAT login or the local development OTP sandbox) are on.
 * No SMS, WhatsApp or other delivery adapter is ever invoked by this module.
 */

export const SERVICE_START_OTP_SETTINGS = {
  enabled: "PAWSPACE_SERVICE_START_OTP_ENABLED",
  ttlSeconds: "PAWSPACE_SERVICE_START_OTP_TTL_SECONDS",
  maxAttempts: "PAWSPACE_SERVICE_START_OTP_MAX_ATTEMPTS",
  maxIssuesPerBooking: "PAWSPACE_SERVICE_START_OTP_MAX_ISSUES_PER_BOOKING",
  services: "PAWSPACE_SERVICE_START_OTP_SERVICES",
  eligibleStatuses: "PAWSPACE_SERVICE_START_OTP_ELIGIBLE_STATUSES",
} as const;

export type ServiceStartOtpPolicy = {
  ttlSeconds: number;
  maxAttempts: number;
  maxIssuesPerBooking: number;
  services: ReadonlySet<string>;
  eligibleStatuses: ReadonlySet<string>;
};

export class ServiceStartOtpUnavailableError extends Error {
  readonly status = 503;
  readonly code: string;
  constructor(message: string, code: string) { super(message); this.name = "ServiceStartOtpUnavailableError"; this.code = code; }
}

type Runtime = Record<string, unknown>;
const text = (value: unknown) => String(value ?? "").trim();
const lower = (value: unknown) => text(value).toLowerCase();

function unavailable(message: string, code: string): never { throw new ServiceStartOtpUnavailableError(message, code); }

/** A production deployment is never allowed to run this module, whatever else is configured. */
export function serviceStartOtpProductionRuntime(runtime: Runtime) {
  return [runtime.PAWSPACE_DEPLOYMENT_ENV, runtime.APP_ENV].some(value => lower(value) === "production");
}

/** Digits only, and the result must be a finite safe integer >= 1: "1e3", "Infinity" and digit strings
 * beyond Number.MAX_SAFE_INTEGER are refused, since arithmetic on them silently drifts. */
function positiveInteger(runtime: Runtime, name: string) {
  const raw = text(runtime[name]);
  if (!raw) unavailable(`${name} is not configured`, "policy_not_configured");
  const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(value) || value < 1) unavailable(`${name} must be a safe positive integer`, "policy_invalid");
  return value;
}

/** The TTL is also used as milliseconds added to a clock reading; both must stay safe integers. */
function ttlSeconds(runtime: Runtime) {
  const seconds = positiveInteger(runtime, SERVICE_START_OTP_SETTINGS.ttlSeconds);
  if (!Number.isSafeInteger(seconds * 1000) || !Number.isSafeInteger(Date.now() + seconds * 1000)) unavailable(`${SERVICE_START_OTP_SETTINGS.ttlSeconds} is too large to compute an expiry safely`, "policy_invalid");
  return seconds;
}

/** An expiry instant is only usable when the addition itself was exact. */
export function serviceStartOtpExpiry(now: number, policy: ServiceStartOtpPolicy) {
  const expiresAt = now + policy.ttlSeconds * 1000;
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(expiresAt)) unavailable("Service-start OTP expiry could not be computed safely", "policy_invalid");
  return expiresAt;
}

function codeList(runtime: Runtime, name: string) {
  const raw = text(runtime[name]);
  if (!raw) unavailable(`${name} is not configured`, "policy_not_configured");
  const items = raw.split(",").map(item => item.trim()).filter(Boolean);
  if (!items.length || items.some(item => !/^[a-z0-9_]+$/i.test(item))) unavailable(`${name} must list one or more codes`, "policy_invalid");
  return new Set(items.map(item => item.toLowerCase()));
}

/**
 * The non-production gate, in order: not production, explicitly enabled, the identity runtime not in
 * its live mode, and one of the existing sandbox code-return channels on. Each refusal names the
 * setting that stopped it so the operator can see which gate is closed without reading code.
 */
export function assertServiceStartOtpRuntime(request: Request, runtime: Runtime) {
  if (serviceStartOtpProductionRuntime(runtime)) unavailable("Service-start OTP is not available in production", "production_refused");
  if (lower(runtime[SERVICE_START_OTP_SETTINGS.enabled]) !== "on") unavailable(`${SERVICE_START_OTP_SETTINGS.enabled} is off`, "disabled");
  if (lower(runtime.PAWSPACE_IDENTITY_ENV) === "live") unavailable("Service-start OTP test delivery is not available with a live identity runtime", "live_identity_refused");
  if (!uatLoginEnabled(runtime) && !developmentOtpSandboxEnabled(request, runtime)) unavailable("Service-start OTP requires the UAT login or local sandbox code-return channel", "sandbox_channel_off");
}

/** Reads every threshold; any one missing or malformed fails the whole policy closed. */
export function resolveServiceStartOtpPolicy(runtime: Runtime): ServiceStartOtpPolicy {
  return {
    ttlSeconds: ttlSeconds(runtime),
    maxAttempts: positiveInteger(runtime, SERVICE_START_OTP_SETTINGS.maxAttempts),
    maxIssuesPerBooking: positiveInteger(runtime, SERVICE_START_OTP_SETTINGS.maxIssuesPerBooking),
    services: codeList(runtime, SERVICE_START_OTP_SETTINGS.services),
    eligibleStatuses: codeList(runtime, SERVICE_START_OTP_SETTINGS.eligibleStatuses),
  };
}

/** The keyed-verifier secret: the existing identity assertion secret resolver, never a local default. */
export function resolveServiceStartOtpSecret(runtime: Runtime) {
  const secret = resolveOtpAssertionSecret(runtime);
  if (secret.length < 32) unavailable("Service-start OTP verifier secret is not configured", "secret_not_configured");
  return secret;
}

/** Gate, policy and secret together: the one entry point the runtime module uses. */
export function loadServiceStartOtpRuntime(request: Request, runtime: Runtime) {
  assertServiceStartOtpRuntime(request, runtime);
  return { policy: resolveServiceStartOtpPolicy(runtime), secret: resolveServiceStartOtpSecret(runtime) };
}
