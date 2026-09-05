import { authError, database, requirePermission, requireProviderOwnership, resolveActor, securityAudit } from "../../../lib/server-auth";
import { BLOCKLIST_REASONS, flagCustomerOnGlobalBlocklist, type BlocklistReason } from "../../../lib/trust-safety-governance";

type Body = { providerId?: string; bookingId?: string; reasonCode?: BlocklistReason; note?: string };
type Row = Record<string, unknown>;
const text = (value: unknown) => String(value ?? "").trim();
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
function sameOrigin(request: Request) { const origin = request.headers.get("origin"); if (origin && origin !== new URL(request.url).origin) throw new Response("Cross-origin safety flag blocked", { status: 403 }); }

export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const actor = await resolveActor(request); requirePermission(actor, "communications.message");
    const body = await request.json() as Body, providerId = text(body.providerId), bookingId = text(body.bookingId), reasonCode = text(body.reasonCode) as BlocklistReason;
    if (!providerId || !bookingId || !BLOCKLIST_REASONS.includes(reasonCode)) return json({ error: "Provider, booking and a supported reason are required" }, 400);
    const db = await database(); await requireProviderOwnership(db, actor, providerId);
    const booking = await db.prepare("SELECT customer_id,provider_id FROM canonical_bookings WHERE id=?").bind(bookingId).first<Row>();
    if (!booking) return json({ error: "Booking not found" }, 404);
    let assigned = text(booking.provider_id);
    if (!assigned) assigned = text((await db.prepare("SELECT provider_id FROM provider_work_orders WHERE booking_id=? LIMIT 1").bind(bookingId).first<Row>().catch(() => null))?.provider_id);
    if (assigned !== providerId) return json({ error: "This booking is assigned to another provider" }, 403);
    const customerId = text(booking.customer_id), customer = await db.prepare("SELECT primary_phone FROM canonical_customers WHERE id=?").bind(customerId).first<Row>();
    if (!customer || !text(customer.primary_phone)) return json({ error: "Customer contact record unavailable" }, 409);
    const result = await flagCustomerOnGlobalBlocklist(db, { phone: text(customer.primary_phone), customerId, bookingId, reasonCode, actorId: actor.email, actorType: "provider", detail: { note: text(body.note).slice(0, 500), providerId } });
    await securityAudit(db, actor, "trust_safety.customer_flagged", "customer", customerId, "completed", { bookingId, providerId, reasonCode });
    return json({ data: { blocked: result.blocked, reasonCode: result.reasonCode, customerId, bookingId } }, 201);
  } catch (error) { return authError(error, "Unable to flag customer"); }
}
