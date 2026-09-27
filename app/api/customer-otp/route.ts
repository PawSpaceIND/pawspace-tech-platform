import { authError, database } from "../../../lib/server-auth";
import { CustomerOtpUnavailableError, CustomerOtpVerificationError, exchangeCustomerOtp, startCustomerOtp } from "../../../lib/customer-otp-exchange";

const json = (value: unknown, status = 200, headers?: HeadersInit) => Response.json(value, { status, headers });
function sameOriginWrite(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) throw new Response("Cross-origin write blocked", { status: 403 });
}
function failure(error: unknown) {
  // The OTP exchange's own refusals explain themselves; anything else goes through the shared redacting boundary.
  if(error instanceof CustomerOtpVerificationError||error instanceof CustomerOtpUnavailableError)return json({error:error.message},error.status,{"cache-control":"no-store"});
  if(error instanceof Error&&/PAWSPACE_IDENTITY_ASSERTION_SECRET/.test(error.message))return json({ error: "OTP delivery is not configured for this environment" }, 503, { "cache-control": "no-store" });
  return authError(error, "Unable to process the verification code");
}

export async function POST(request: Request) {
  try {
    sameOriginWrite(request);
    const body = (await request.json()) as { action?: string; phone?: string; challengeId?: string; code?: string; name?: string; cityId?: string; installId?: string };
    if (body.action === "request") {
      if (!body.phone) return json({ error: "Phone number is required" }, 400);
      const { env } = await import("cloudflare:workers");
      const db = await database();
      const result = await startCustomerOtp(db, request, env as unknown as Record<string, unknown>, body.phone);
      return json({ data: result }, 200, { "cache-control": "no-store" });
    }
    if (body.action === "verify") {
      if (!body.challengeId || !body.code) return json({ error: "Challenge and code are required" }, 400);
      const { env } = await import("cloudflare:workers");
      const db = await database();
      const { customerId, customerName, phone, expiresAt, headers } = await exchangeCustomerOtp(db, request, env as unknown as Record<string, unknown>, { challengeId: body.challengeId, code: body.code, name: body.name, cityId: body.cityId, installId: body.installId });
      return json({ data: { customerId, customerName, phone, expiresAt } }, 200, headers);
    }
    return json({ error: "Unsupported action" }, 400);
  } catch (error) {
    return failure(error);
  }
}
