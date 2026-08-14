import { database } from "../../../lib/server-auth";
import { requestPartnerOtp, verifyPartnerOtp } from "../../../lib/partner-otp";
import { upsertIdentityBinding } from "../../../lib/identity-binding";
import { issuePlatformSession, platformSessionCookie } from "../../../lib/platform-session";
import { verifyIdentityAssertion } from "../../../lib/verified-identity-assertion";

const json = (value: unknown, status = 200, headers?: HeadersInit) => Response.json(value, { status, headers });
// D5: the freshly generated OTP is a shared secret and must NEVER appear in the API response by
// default — echoing it lets anyone request→read→verify and take over any phone's account. It is only
// disclosed when the UAT switch is explicitly on (fail-closed: unset/any-other value ⇒ no disclosure),
// matching the established PAWSPACE_UAT_LOGIN==="on" convention (see app/api/finance-control seedEnabled).
async function otpDisclosureEnabled() { const { env } = await import("cloudflare:workers"); return String((env as unknown as Record<string, unknown>).PAWSPACE_UAT_LOGIN || "") === "on"; }
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
    const db = await database();
    const body = (await request.json()) as { action?: string; phone?: string; challengeId?: string; code?: string; name?: string; cityId?: string };
    if (body.action === "request") {
      if (!body.phone) return json({ error: "Phone number is required" }, 400);
      const result = await requestPartnerOtp(db, { phone: body.phone });
      if (!(await otpDisclosureEnabled())) delete (result as { sandboxCode?: string }).sandboxCode;
      return json({ data: result });
    }
    if (body.action === "verify") {
      if (!body.challengeId || !body.code) return json({ error: "Challenge and code are required" }, 400);
      const { assertion, providerId, providerName, phone } = await verifyPartnerOtp(db, { challengeId: body.challengeId, code: body.code, name: body.name, cityId: body.cityId });
      const verified = await verifyIdentityAssertion(db, assertion);
      const binding = await upsertIdentityBinding(db, {
        identitySource: verified.identitySource, principalType: verified.principalType, principalKey: verified.principalKey,
        subjectType: verified.subjectType, subjectId: verified.subjectId, cityId: verified.cityId ?? null,
        verificationState: "verified", expiresAt: null, metadata: { verifiedBy: "partner_otp_sandbox", assertionIssuedAt: verified.issuedAt },
        actorId: `partner_otp:${verified.identitySource}`, reason: "Verified sandbox OTP identity assertion exchange",
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
