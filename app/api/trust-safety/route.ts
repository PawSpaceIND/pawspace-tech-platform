import { authError, database, requirePermission, resolveActor, securityAudit } from "../../../lib/server-auth";
import { BLOCKLIST_REASONS, clearCustomerGlobalBlock, ensureTrustSafetyTables, flagCustomerOnGlobalBlocklist, runTrustSafetySweep, type BlocklistReason } from "../../../lib/trust-safety-governance";

type Row = Record<string, unknown>;
type Body = { action?: "flag_customer" | "clear_customer" | "run_sweep"; customerId?: string; bookingId?: string; reasonCode?: BlocklistReason; note?: string; phone?: string };
const text = (value: unknown) => String(value ?? "").trim();
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
function sameOrigin(request: Request) { const origin = request.headers.get("origin"); if (origin && origin !== new URL(request.url).origin) throw new Response("Cross-origin Trust & Safety write blocked", { status: 403 }); }

async function resolveCustomerPhone(db: D1Database, input: { customerId?: string; bookingId?: string }) {
  let customerId = text(input.customerId);
  if (input.bookingId) {
    const booking = await db.prepare("SELECT customer_id FROM canonical_bookings WHERE id=?").bind(text(input.bookingId)).first<Row>();
    if (!booking) throw new Response("Booking not found", { status: 404 });
    if (customerId && customerId !== text(booking.customer_id)) throw new Response("Booking/customer mismatch", { status: 409 });
    customerId = text(booking.customer_id);
  }
  if (!customerId) throw new Response("Customer or booking is required", { status: 400 });
  const customer = await db.prepare("SELECT primary_phone FROM canonical_customers WHERE id=?").bind(customerId).first<Row>();
  if (!customer || !text(customer.primary_phone)) throw new Response("Customer contact record unavailable", { status: 409 });
  return { customerId, phone: text(customer.primary_phone) };
}

export async function GET(request: Request) {
  try {
    const actor = await resolveActor(request); requirePermission(actor, "customers.manage");
    const db = await database(); await ensureTrustSafetyTables(db);
    const url = new URL(request.url), providerId = text(url.searchParams.get("providerId"));
    const blocklist = await db.prepare("SELECT phone_e164,customer_id,reason_code,status,flagged_by_type,booking_id,created_at,updated_at FROM global_blocklist WHERE status='active' ORDER BY updated_at DESC LIMIT 250").all<Row>();
    const providerTrust = providerId
      ? await db.prepare("SELECT provider_id,trust_score,strike_count,status,suspended_until,updated_at FROM provider_trust_state WHERE provider_id=?").bind(providerId).all<Row>()
      : await db.prepare("SELECT provider_id,trust_score,strike_count,status,suspended_until,updated_at FROM provider_trust_state ORDER BY trust_score ASC,updated_at DESC LIMIT 250").all<Row>();
    return json({ data: { blocklist: blocklist.results.map(row => ({ ...row, phone_e164: `+••••••${text(row.phone_e164).replace(/\D/g, "").slice(-4)}` })), providerTrust: providerTrust.results } });
  } catch (error) { return authError(error, "Unable to load Trust & Safety state"); }
}

export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const actor = await resolveActor(request), body = await request.json() as Body, db = await database();
    if (body.action === "run_sweep") {
      requirePermission(actor, "settings.manage");
      const { env } = await import("cloudflare:workers");
      const result = await runTrustSafetySweep(db, env as unknown as Record<string, unknown>, {});
      await securityAudit(db, actor, "trust_safety.sweep", "trust_safety", null, "completed", result);
      return json({ data: result });
    }
    requirePermission(actor, "customers.manage");
    if (body.action === "flag_customer") {
      const reasonCode = text(body.reasonCode) as BlocklistReason;
      if (!BLOCKLIST_REASONS.includes(reasonCode)) return json({ error: "Supported reason is required" }, 400);
      const customer = await resolveCustomerPhone(db, { customerId: body.customerId, bookingId: body.bookingId });
      await flagCustomerOnGlobalBlocklist(db, { phone: customer.phone, customerId: customer.customerId, bookingId: text(body.bookingId) || null, reasonCode, actorId: actor.email, actorType: "staff", detail: { note: text(body.note).slice(0, 1000) } });
      await securityAudit(db, actor, "trust_safety.customer_block", "customer", customer.customerId, "completed", { reasonCode, bookingId: text(body.bookingId) || null });
      return json({ data: { blocked: true, customerId: customer.customerId, reasonCode } }, 201);
    }
    if (body.action === "clear_customer") {
      const customer = body.customerId || body.bookingId ? await resolveCustomerPhone(db, { customerId: body.customerId, bookingId: body.bookingId }) : { customerId: "", phone: text(body.phone) };
      if (!customer.phone) return json({ error: "Customer or E.164 phone is required" }, 400);
      const result = await clearCustomerGlobalBlock(db, { phone: customer.phone, actorId: actor.email });
      await securityAudit(db, actor, "trust_safety.customer_unblock", "customer", customer.customerId || null, "completed", {});
      return json({ data: result });
    }
    return json({ error: "Unsupported Trust & Safety action" }, 400);
  } catch (error) { return authError(error, "Unable to update Trust & Safety state"); }
}
