import { authError, database, resolveActor, securityAudit } from "../../../../../lib/server-auth";
import { requestVoiceBridge } from "../../../../../lib/voice-bridge-governance";
import { readBoundedRequestText, VoiceFetchRefused } from "../../../../../lib/voice-safe-fetch";

const MAX_REQUEST_BYTES = 16 * 1024;
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });

function sameOriginWrite(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) throw new Response("Cross-origin masked-call request blocked", { status: 403 });
}

export async function POST(request: Request) {
  try {
    sameOriginWrite(request);
    const actor = await resolveActor(request);
    let raw: string;
    try { raw = await readBoundedRequestText(request, MAX_REQUEST_BYTES); }
    catch (error) { if (error instanceof VoiceFetchRefused) return json({ error: "Masked-call request is too large" }, 413); throw error; }
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw || "{}") as Record<string, unknown>; }
    catch { return json({ error: "Masked-call request must be valid JSON" }, 400); }
    const db = await database();
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
    return authError(error, "Unable to establish masked service call");
  }
}
