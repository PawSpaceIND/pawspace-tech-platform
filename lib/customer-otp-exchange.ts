/**
 * Customer OTP as one exchange: send a code to a phone, then turn the verified code into a signed-in
 * customer session. Shared by the sign-in route (app/api/customer-otp) and the web chat, where a visitor
 * who has finished the bot's questions confirms their number in the conversation so PawSpace AI can book
 * for them. The gates, delivery rules and identity exchange are the sign-in route's, unchanged.
 */
import { CustomerOtpVerificationError, discardCustomerOtpChallenge, requestCustomerOtp, verifyCustomerOtp } from "./customer-otp";
import { upsertIdentityBinding } from "./identity-binding";
import { issuePlatformSession, platformSessionCookie } from "./platform-session";
import { verifyIdentityAssertion } from "./verified-identity-assertion";
import { clearUatCookie, uatLoginEnabled } from "./uat-staging-auth";
import { developmentOtpSandboxEnabled } from "./otp-sandbox-runtime";
import { productionOtpEnabled } from "./otp-production-runtime";
import { normalizeIndianMobile, parseSmsTestAllowlist, sendFast2SmsMessage } from "./sms-test-provider";
import { sendProductionSms } from "./production-sms-provider";

type Runtime = Record<string, unknown>;
const enabled = (value: unknown) => ["true", "1", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());

export class CustomerOtpUnavailableError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

function liveStagingOtpEnabled(runtime: Runtime) {
  return uatLoginEnabled(runtime)
    && String(runtime.PAWSPACE_DEPLOYMENT_ENV ?? "").trim() === "staging"
    && enabled(runtime.PAWSPACE_STAGING_LIVE_CUSTOMER_OTP);
}
function approvedLiveOtpPhone(runtime: Runtime) {
  return [...parseSmsTestAllowlist(String(runtime.PAWSPACE_SMS_TEST_NUMBERS ?? ""))][0] ?? null;
}

/** Which OTP mode this environment runs, or none: production SMS, isolated-staging SMS, or the sandbox. */
export function customerOtpMode(request: Request, runtime: Runtime) {
  const productionMode = productionOtpEnabled(runtime), stagingLiveMode = liveStagingOtpEnabled(runtime), liveMode = productionMode || stagingLiveMode;
  const available = liveMode || uatLoginEnabled(runtime) || developmentOtpSandboxEnabled(request, runtime);
  return { available, productionMode, stagingLiveMode, liveMode };
}

export type CustomerOtpStarted = { challengeId: string; phone: string; expiresInSeconds: number; sandboxDelivery: boolean; sandboxCode?: string; liveSmsDelivered: boolean; existingCustomer: boolean };

/** Sends a code to the phone. Throws CustomerOtpUnavailableError (503/400/403) exactly where the sign-in route refuses. */
export async function startCustomerOtp(db: D1Database, request: Request, runtime: Runtime, phone: string): Promise<CustomerOtpStarted> {
  const mode = customerOtpMode(request, runtime);
  if (!mode.available) throw new CustomerOtpUnavailableError("OTP delivery is not configured for this environment", 503);
  const result = await requestCustomerOtp(db, { phone });
  if (!mode.liveMode) return result;
  const normalized = normalizeIndianMobile(result.phone);
  if (!normalized) { await discardCustomerOtpChallenge(db, result.challengeId); throw new CustomerOtpUnavailableError("A valid Indian mobile number is required", 400); }
  if (mode.stagingLiveMode) {
    const approved = approvedLiveOtpPhone(runtime);
    if (!approved || normalized !== approved) {
      await discardCustomerOtpChallenge(db, result.challengeId);
      throw new CustomerOtpUnavailableError("This staging OTP run is restricted to the approved test number", 403);
    }
  }
  try {
    if (mode.productionMode) await sendProductionSms(runtime, { phone: normalized, message: `Your PawSpace verification code is ${result.sandboxCode}. It expires in 5 minutes.`, idempotencyKey: `otp-${result.challengeId}` });
    else await sendFast2SmsMessage({ apiKey: String(runtime.FAST2SMS_API_KEY ?? ""), phone: normalized, message: `Your PawSpace verification code is ${result.sandboxCode}. It expires in 5 minutes.`, udf1: "pawspace-staging-customer-otp" });
  } catch {
    await discardCustomerOtpChallenge(db, result.challengeId);
    throw new CustomerOtpUnavailableError("OTP delivery failed - please try again", 503);
  }
  // The code itself never leaves the server when it was delivered by SMS.
  return { challengeId: result.challengeId, phone: result.phone, expiresInSeconds: result.expiresInSeconds, sandboxDelivery:false,liveSmsDelivered:true,existingCustomer:result.existingCustomer };
}

/**
 * Turns a verified code into a customer session: the identity assertion is verified, the binding
 * upserted and a platform session issued. `headers` carry the session cookie (and clear the UAT one).
 * Throws CustomerOtpVerificationError for a wrong, used or expired code.
 */
export async function exchangeCustomerOtp(db: D1Database, request: Request, runtime: Runtime, input: { challengeId: string; code: string; name?: string; cityId?: string; installId?: string }) {
  const mode = customerOtpMode(request, runtime);
  if (!mode.available) throw new CustomerOtpUnavailableError("OTP delivery is not configured for this environment", 503);
  const { assertion, customerId, customerName, phone } = await verifyCustomerOtp(db, input);
  const verified = await verifyIdentityAssertion(db, assertion);
  const binding = await upsertIdentityBinding(db, {
    identitySource: verified.identitySource, principalType: verified.principalType, principalKey: verified.principalKey,
    subjectType: verified.subjectType, subjectId: verified.subjectId, cityId: verified.cityId ?? null,
    verificationState: "verified", expiresAt: null, metadata: { verifiedBy: mode.productionMode ? "customer_otp_production_sms" : mode.stagingLiveMode ? "customer_otp_fast2sms_staging" : "customer_otp_sandbox", assertionIssuedAt: verified.issuedAt },
    actorId: `customer_otp:${verified.identitySource}`, reason: mode.productionMode ? "Verified production SMS OTP identity assertion exchange" : mode.stagingLiveMode ? "Verified isolated-staging Fast2SMS OTP identity assertion exchange" : "Verified sandbox OTP identity assertion exchange",
  });
  const issued = await issuePlatformSession(db, {
    request,
    bindingId: String(binding?.id || ""), identitySource: verified.identitySource, principalType: verified.principalType,
    principalKey: verified.principalKey, subjectType: verified.subjectType, subjectId: verified.subjectId,
    ttlSeconds: 28_800, metadata: { cityId: verified.cityId ?? null },
  });
  const headers = new Headers({ "cache-control": "no-store" });
  headers.append("set-cookie", platformSessionCookie(issued.token, issued.ttlSeconds));
  headers.append("set-cookie", clearUatCookie());
  return { customerId, customerName, phone, expiresAt: issued.session.expiresAt, token: issued.token, headers };
}

export { CustomerOtpVerificationError };
