import { authError, database, resolveActor, securityAudit } from "../../../../../lib/server-auth";
import { requestVoiceBridge } from "../../../../../lib/voice-bridge-governance";
import { readBoundedRequestText, VoiceFetchRefused } from "../../../../../lib/voice-safe-fetch";

const MAX_REQUEST_BYTES = 16 * 1024;
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });

function sameOriginWrite(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) throw new Response("Cross-origin masked-call request blocked", { status: 403 });
}

/**
 * Denied masked-call attempts must leave a trace, and until now none did.
 *
 * lib/api-gateway.ts maps this path to `return null` - correctly, because the customer and
 * service_provider roles share no permission (customer holds pricing.view + scheduling.book,
 * service_provider holds bookings.view + communications.call + ...), so no single gateway permission can
 * admit both parties this feature exists to connect. But authorizeApiRequest returns a `public` actor on
 * null, and auditApiResponse skips anything with a null permission or a public actor - so the gateway
 * records nothing here, by design.
 *
 * That left the route as the only place an attempt could be recorded, and it recorded only SUCCESS.
 * A provider walking booking ids looking for one with an open service window - the precise abuse a
 * number-masking feature has to resist - produced 403s and not one audit row.
 */
export async function POST(request: Request) {
  let actor: Awaited<ReturnType<typeof resolveActor>> | null = null;
  let db: Awaited<ReturnType<typeof database>> | null = null;
  let attemptedBookingId = "";
  try {
    sameOriginWrite(request);
    actor = await resolveActor(request);
    let raw: string;
    try { raw = await readBoundedRequestText(request, MAX_REQUEST_BYTES); }
    catch (error) { if (error instanceof VoiceFetchRefused) return json({ error: "Masked-call request is too large" }, 413); throw error; }
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw || "{}") as Record<string, unknown>; }
    catch { return json({ error: "Masked-call request must be valid JSON" }, 400); }
    attemptedBookingId = String(body.bookingId || "");
    db = await database();
    const { env } = await import("cloudflare:workers");
    const result = await requestVoiceBridge(db, env as unknown as Record<string, unknown>, actor, {
      bookingId: String(body.bookingId || ""),
      idempotencyKey: String(body.idempotencyKey || ""),
    });
    await securityAudit(db, actor, "communications.voice.bridge", "booking", result.bookingId, "completed", {
      sessionId: result.sessionId,
      initiatorType: result.initiatorType,
      status: result.status,
      replayed: result.replayed,
    });
    return json(result, result.replayed ? 200 : 201);
  } catch (error) {
    /* Best effort and deliberately swallowed: an audit write that throws must not convert a governed
     * 403 into a 500, and must not mask the original refusal. Nothing is recorded when resolveActor
     * itself refused - there is no identity to attribute the attempt to. */
    if (actor && db) {
      const status = error instanceof Response ? error.status : 500;
      try {
        await securityAudit(db, actor, "communications.voice.bridge", "booking", attemptedBookingId || null, status === 403 ? "denied" : "rejected", { status });
      } catch { /* audit is not allowed to change the response */ }
    }
    return authError(error, "Unable to establish masked service call");
  }
}
