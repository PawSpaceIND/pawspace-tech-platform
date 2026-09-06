import { database } from "../../../lib/server-auth";
import { discardPartnerOtpChallenge, requestPartnerOtp, verifyPartnerOtp } from "../../../lib/partner-otp";
import { upsertIdentityBinding } from "../../../lib/identity-binding";
import { issuePlatformSession, platformSessionCookie } from "../../../lib/platform-session";
import { verifyIdentityAssertion } from "../../../lib/verified-identity-assertion";
import { uatLoginEnabled } from "../../../lib/uat-staging-auth";
import { developmentOtpSandboxEnabled } from "../../../lib/otp-sandbox-runtime";
import { normalizeIndianMobile, sendFast2SmsMessage } from "../../../lib/sms-test-provider";

const json = (value: unknown, status = 200, headers?: HeadersInit) => Response.json(value, { status, headers });
const unavailable = () => json({ error: "OTP delivery is not configured for this environment" }, 503, { "cache-control": "no-store" });
const deliveryFailed = () => json({ error: "OTP delivery failed - please try again" }, 503, { "cache-control": "no-store" });
function productionLiveOtpEnabled(runtime:Record<string,unknown>){
  return String(runtime.PAWSPACE_DEPLOYMENT_ENV??"").trim().toLowerCase()==="production"
    && Boolean(String(runtime.FAST2SMS_API_KEY??"").trim());
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
    const body = (await request.json()) as { action?: string; phone?: string; challengeId?: string; code?: string; name?: string; cityId?: string };
    if (body.action === "request") {
      if (!body.phone) return json({ error: "Phone number is required" }, 400);
      const { env } = await import("cloudflare:workers");
      const runtime=env as unknown as Record<string, unknown>;
      const productionLive=productionLiveOtpEnabled(runtime);
      if (!productionLive && !uatLoginEnabled(runtime) && !developmentOtpSandboxEnabled(request,runtime)) return unavailable();
      const db = await database();
      const result = await requestPartnerOtp(db, { phone: body.phone });
      if(!productionLive)return json({ data: result }, 200, { "cache-control": "no-store" });
      const normalized=normalizeIndianMobile(result.phone);
      if(!normalized){await discardPartnerOtpChallenge(db,result.challengeId);return json({error:"A valid Indian mobile number is required"},400,{"cache-control":"no-store"});}
      try{
        await sendFast2SmsMessage({apiKey:String(runtime.FAST2SMS_API_KEY??""),phone:normalized,message:`Your PawSpace partner verification code is ${result.sandboxCode}. It expires in 5 minutes.`,udf1:"pawspace-production-partner-otp"});
      }catch{
        await discardPartnerOtpChallenge(db,result.challengeId);
        return deliveryFailed();
      }
      return json({data:{challengeId:result.challengeId,phone:result.phone,expiresInSeconds:result.expiresInSeconds,sandboxDelivery:false,liveSmsDelivered:true}},200,{"cache-control":"no-store"});
    }
    if (body.action === "verify") {
      if (!body.challengeId || !body.code) return json({ error: "Challenge and code are required" }, 400);
      const { env } = await import("cloudflare:workers");
      const runtime=env as unknown as Record<string, unknown>;
      const productionLive=productionLiveOtpEnabled(runtime);
      if (!productionLive && !uatLoginEnabled(runtime) && !developmentOtpSandboxEnabled(request,runtime)) return unavailable();
      const db = await database();
      const { assertion, providerId, providerName, phone } = await verifyPartnerOtp(db, { challengeId: body.challengeId, code: body.code, name: body.name, cityId: body.cityId });
      const verified = await verifyIdentityAssertion(db, assertion);
      const binding = await upsertIdentityBinding(db, {
        identitySource: verified.identitySource, principalType: verified.principalType, principalKey: verified.principalKey,
        subjectType: verified.subjectType, subjectId: verified.subjectId, cityId: verified.cityId ?? null,
        verificationState: "verified", expiresAt: null, metadata: { verifiedBy: productionLive?"partner_otp_fast2sms_production":"partner_otp_sandbox", assertionIssuedAt: verified.issuedAt },
        actorId: `partner_otp:${verified.identitySource}`, reason: productionLive?"Verified production Fast2SMS partner OTP identity assertion exchange":"Verified sandbox OTP identity assertion exchange",
      });
      const issued = await issuePlatformSession(db, {
        bindingId: String(binding?.id || ""), identitySource: verified.identitySource, principalType: verified.principalType,
        principalKey: verified.principalKey, subjectType: verified.subjectType, subjectId: verified.subjectId,
        ttlSeconds: 28_800, metadata: { cityId: verified.cityId ?? null },
      });
      return json(
        { data: { providerId, providerName, phone, expiresAt: issued.session.expiresAt } },
        200,
        { "set-cookie": platformSessionCookie(issued.token, issued.ttlSeconds), "cache-control": "no-store" },
      );
    }
    return json({ error: "Unsupported action" }, 400);
  } catch (error) {
    return failure(error);
  }
}
