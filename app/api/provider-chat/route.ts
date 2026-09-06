import { authError, database, requirePermission, requireProviderOwnership, resolveActor, securityAudit } from "../../../lib/server-auth";
import { recordProviderChatMessage } from "../../../lib/trust-safety-governance";

type Body = { providerId?: string; threadId?: string; message?: string; idempotencyKey?: string };
type Row = Record<string, unknown>;
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
const text = (value: unknown) => String(value ?? "").trim();
function sameOrigin(request: Request) { const origin = request.headers.get("origin"); if (origin && origin !== new URL(request.url).origin) throw new Response("Cross-origin provider chat blocked", { status: 403 }); }

export async function GET(request: Request) {
  try {
    const actor = await resolveActor(request); requirePermission(actor, "communications.message");
    const url = new URL(request.url), providerId = text(url.searchParams.get("providerId")), threadId = text(url.searchParams.get("threadId"));
    if (!providerId || !threadId) return json({ error: "Provider and thread are required" }, 400);
    const db = await database(); await requireProviderOwnership(db, actor, providerId);
    const thread = await db.prepare("SELECT customer_id,booking_id,status FROM communication_threads WHERE id=?").bind(threadId).first<Row>();
    if (!thread || text(thread.status) !== "open" || !text(thread.booking_id)) return json({ error: "Open booked conversation not found" }, 404);
    let assignment = await db.prepare("SELECT provider_id FROM provider_work_orders WHERE booking_id=? LIMIT 1").bind(text(thread.booking_id)).first<Row>().catch(() => null);
    if (!assignment) assignment = await db.prepare("SELECT provider_id FROM canonical_bookings WHERE id=? LIMIT 1").bind(text(thread.booking_id)).first<Row>().catch(() => null);
    if (!assignment || text(assignment.provider_id) !== providerId) return json({ error: "Provider is not assigned to this conversation" }, 403);
    const messages = await db.prepare("SELECT id,direction,channel,payload_json,status,created_at FROM communication_messages WHERE thread_id=? AND channel IN ('chat','whatsapp') ORDER BY created_at ASC LIMIT 250").bind(threadId).all<Row>();
    const data = messages.results.map(row => { let payload: Row = {}; try { payload = JSON.parse(text(row.payload_json) || "{}") as Row; } catch {} delete payload.customerPhone; delete payload.providerPhone; delete payload.providerIdentity; return { id: row.id, direction: row.direction, channel: row.channel, payload, status: row.status, createdAt: row.created_at }; });
    return json({ data: { threadId, bookingId: text(thread.booking_id), messages: data, contactMode: "masked_proxy_only" } });
  } catch (error) { return authError(error, "Unable to load provider chat"); }
}

export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const actor = await resolveActor(request); requirePermission(actor, "communications.message");
    const body = await request.json() as Body, providerId = text(body.providerId), threadId = text(body.threadId), message = text(body.message), idempotencyKey = text(body.idempotencyKey);
    if (!providerId || !threadId || !message || !idempotencyKey) return json({ error: "Provider, thread, message and idempotency key are required" }, 400);
    const db = await database(); await requireProviderOwnership(db, actor, providerId);
    const result = await recordProviderChatMessage(db, { providerId, threadId, actorId: actor.email, message, idempotencyKey });
    await securityAudit(db, actor, "trust_safety.provider_chat", "conversation", threadId, "completed", { providerId, messageId: result.messageId, redacted: result.redacted, detections: result.detections });
    return json({ data: result }, result.duplicatePrevented ? 200 : 201);
  } catch (error) { return authError(error, "Unable to send provider chat message"); }
}
