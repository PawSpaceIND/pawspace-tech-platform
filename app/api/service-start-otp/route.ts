import { authError, database, resolveActor } from "../../../lib/server-auth";
import { ServiceStartOtpUnavailableError } from "../../../lib/service-start-otp-policy";
import { ServiceStartOtpRefusal, issueServiceStartOtp, readServiceStartOtpStatus, verifyServiceStartOtp } from "../../../lib/service-start-otp";

/**
 * Service-start customer OTP (test / non-production only; see lib/service-start-otp-policy.ts).
 *
 *   POST {action:"issue",  bookingId}                       customer session: issues the one-time code
 *   POST {action:"verify", bookingId, code, idempotencyKey} provider session: redeems it, once
 *   GET  ?bookingId=                                        either party: state only, never the code
 *
 * The verify response is a consent artifact. It records that the customer authorised the assigned
 * provider to start this booking's service; it does not start the service, and no lifecycle route
 * reads it yet. That integration is a separate, owner-coordinated step.
 */

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });

function sameOriginWrite(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) throw new Response("Cross-origin write blocked", { status: 403 });
}

function failure(error: unknown) {
  // The module's own refusals explain themselves and never carry a code or secret; anything else goes
  // through the shared redacting boundary.
  if (error instanceof ServiceStartOtpRefusal || error instanceof ServiceStartOtpUnavailableError) return json({ error: error.message, code: error.code }, error.status);
  return authError(error, "Unable to process the service-start code");
}

type Body = { action?: string; bookingId?: string; code?: string; idempotencyKey?: string };

export async function POST(request: Request) {
  try {
    sameOriginWrite(request);
    const body = (await request.json()) as Body;
    const bookingId = String(body.bookingId ?? "").trim();
    if (!bookingId) return json({ error: "Booking ID is required" }, 400);
    const { env } = await import("cloudflare:workers");
    const runtime = env as unknown as Record<string, unknown>;
    const db = await database();
    const actor = await resolveActor(request);
    if (body.action === "issue") {
      const issued = await issueServiceStartOtp(db, { request, runtime, actor, bookingId });
      return json({ data: issued });
    }
    if (body.action === "verify") {
      const consent = await verifyServiceStartOtp(db, { request, runtime, actor, bookingId, code: String(body.code ?? ""), idempotencyKey: String(body.idempotencyKey ?? "") });
      return json({ data: consent });
    }
    return json({ error: "Unsupported action" }, 400);
  } catch (error) {
    return failure(error);
  }
}

export async function GET(request: Request) {
  try {
    const bookingId = String(new URL(request.url).searchParams.get("bookingId") ?? "").trim();
    if (!bookingId) return json({ error: "Booking ID is required" }, 400);
    const { env } = await import("cloudflare:workers");
    const runtime = env as unknown as Record<string, unknown>;
    const db = await database();
    const actor = await resolveActor(request);
    return json({ data: await readServiceStartOtpStatus(db, { request, runtime, actor, bookingId }) });
  } catch (error) {
    return failure(error);
  }
}
