import { database } from "../../../lib/server-auth";
import { discardCustomerOtpChallenge, requestCustomerOtp, verifyCustomerOtp } from "../../../lib/customer-otp";
import { upsertIdentityBinding } from "../../../lib/identity-binding";
import { issuePlatformSession, platformSessionCookie } from "../../../lib/platform-session";
import { verifyIdentityAssertion } from "../../../lib/verified-identity-assertion";
import { uatLoginEnabled } from "../../../lib/uat-staging-auth";
import { developmentOtpSandboxEnabled } from "../../../lib/otp-sandbox-runtime";
import { normalizeIndianMobile, parseSmsTestAllowlist, sendFast2SmsMessage } from "../../../lib/sms-test-provider";

const json = (value: unknown, status = 200, headers?: HeadersInit) => Response.json(value, { status, headers });
const unavailable = () => json({ error: "OTP delivery is not configured for this environment" }, 503, { "cache-control": "no-store" });
const deliveryFailed = () => json({ error: "OTP delivery failed - please try again" }, 503, { "cache-control": "no-store" });
const enabled=(value:unknown)=>["true","1","yes","on"].includes(String(value??"").trim().toLowerCase());
function liveStagingOtpEnabled(runtime:Record<string,unknown>){
  return uatLoginEnabled(runtime)
    && String(runtime.PAWSPACE_DEPLOYMENT_ENV??"").trim()==="staging"
    && enabled(runtime.PAWSPACE_STAGING_LIVE_CUSTOMER_OTP);
}
function approvedLiveOtpPhone(runtime:Record<string,unknown>){
  return [...parseSmsTestAllowlist(String(runtime.PAWSPACE_SMS_TEST_NUMBERS??""))][0]??null;
}
function sameOriginWrite(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) throw new Response("Cross-origin write blocked", { status: 403 });
}
function failure(error: unknown) {
  if (error instanceof Response) return error;
  return json({ error: error instanceof Error ? error.message : "Request failed" }, 500);
}

export async function POST(request: Request) {
  try {
    sameOriginWrite(request);
    const body = (await request.json()) as { action?: string; phone?: string; challengeId?: string; code?: string; name?: string; cityId?: string; installId?: string };
    if (body.action === "request") {
      if (!body.phone) return json({ error: "Phone number is required" }, 400);
      const { env } = await import("cloudflare:workers");
      const runtime=env as unknown as Record<string, unknown>;
      const liveMode=liveStagingOtpEnabled(runtime);
      if (!liveMode && !uatLoginEnabled(runtime) && !developmentOtpSandboxEnabled(request,runtime)) return unavailable();
      const db = await database();
      const result = await requestCustomerOtp(db, { phone: body.phone });
      if (!liveMode) return json({ data: result }, 200, { "cache-control": "no-store" });

      const normalized=normalizeIndianMobile(result.phone);
      const approved=approvedLiveOtpPhone(runtime);
      if(!normalized||!approved||normalized!==approved){
        await discardCustomerOtpChallenge(db,result.challengeId);
        return json({ error:"This staging OTP run is restricted to the approved test number" },403,{"cache-control":"no-store"});
      }
      try{
        await sendFast2SmsMessage({
          apiKey:String(runtime.FAST2SMS_API_KEY??""),
          phone:normalized,
          message:`Your PawSpace verification code is ${result.sandboxCode}. It expires in 5 minutes.`,
          udf1:"pawspace-staging-customer-otp",
        });
      }catch{
        await discardCustomerOtpChallenge(db,result.challengeId);
        return deliveryFailed();
      }
      return json({data:{challengeId:result.challengeId,phone:result.phone,expiresInSeconds:result.expiresInSeconds,sandboxDelivery:false,liveSmsDelivered:true}},200,{"cache-control":"no-store"});
    }
    if (body.action === "verify") {
      if (!body.challengeId || !body.code) return json({ error: "Challenge and code are required" }, 400);
      const { env } = await import("cloudflare:workers");
      const runtime=env as unknown as Record<string, unknown>;
      const liveMode=liveStagingOtpEnabled(runtime);
      if (!liveMode && !uatLoginEnabled(runtime) && !developmentOtpSandboxEnabled(request,runtime)) return unavailable();
      const db = await database();
      const { assertion, customerId, customerName, phone } = await verifyCustomerOtp(db, { challengeId: body.challengeId, code: body.code, name: body.name, cityId: body.cityId, installId: body.installId });
      const verified = await verifyIdentityAssertion(db, assertion);
      const binding = await upsertIdentityBinding(db, {
        identitySource: verified.identitySource, principalType: verified.principalType, principalKey: verified.principalKey,
        subjectType: verified.subjectType, subjectId: verified.subjectId, cityId: verified.cityId ?? null,
        verificationState: "verified", expiresAt: null, metadata: { verifiedBy: liveMode ? "customer_otp_fast2sms_staging" : "customer_otp_sandbox", assertionIssuedAt: verified.issuedAt },
        actorId: `customer_otp:${verified.identitySource}`, reason: liveMode ? "Verified isolated-staging Fast2SMS OTP identity assertion exchange" : "Verified sandbox OTP identity assertion exchange",
      });
      const issued = await issuePlatformSession(db, {
        bindingId: String(binding?.id || ""), identitySource: verified.identitySource, principalType: verified.principalType,
        principalKey: verified.principalKey, subjectType: verified.subjectType, subjectId: verified.subjectId,
        ttlSeconds: 28_800, metadata: { cityId: verified.cityId ?? null },
      });
      return json(
        { data: { customerId, customerName, phone, expiresAt: issued.session.expiresAt } },
        200,
        { "set-cookie": platformSessionCookie(issued.token, issued.ttlSeconds), "cache-control": "no-store" },
      );
    }
    return json({ error: "Unsupported action" }, 400);
  } catch (error) {
    return failure(error);
  }
}
