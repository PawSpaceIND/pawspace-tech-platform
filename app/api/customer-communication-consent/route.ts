import { authError, database, securityAudit, type AuthenticatedActor } from "../../../lib/server-auth";
import { resolvePlatformSession } from "../../../lib/platform-session";
import { recordCustomerChannelConsent, type ConsentChannel } from "../../../lib/communication-governance";

/**
 * Customer-owned central channel consent (communication_consent.<channel>_allowed).
 * The principal is the platform-session SUBJECT only: no staff header, preview host or caller-supplied customer id can act
 * for another customer. A body `customerId` that differs from the session subject is refused. Writes are audited with the
 * customer as actor. This route exists so synthetic fixtures and real customers use ONE governed writer; it never defaults a
 * missing row to allowed and never lifts a global opt-out.
 */
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store, private" } });
const CHANNELS = new Set<ConsentChannel>(["voice", "whatsapp", "sms", "email"]);
const SOURCES = new Set(["customer_app_settings", "customer_web_settings", "customer_app_feedback_call_request"]);
function sameOrigin(request: Request) { const origin = request.headers.get("origin"); if (origin && origin !== new URL(request.url).origin) throw new Response("Cross-origin consent write blocked", { status: 403 }); }
async function customerContext(request: Request) {
  const db = await database();
  const session = await resolvePlatformSession(db, request);
  if (!session || session.subjectType !== "customer" || !String(session.subjectId || "").trim()) throw new Response("A verified customer sign-in is required", { status: 401 });
  const customerId = String(session.subjectId);
  const actor: AuthenticatedActor = { email: session.auditId, name: `Customer ${customerId}`, roleCode: session.roleCode, permissions: session.permissions, developmentPreview: false, identitySource: session.identitySource, principalType: session.principalType, principalKey: session.principalKey, subjectType: "customer" };
  return { db, actor, customerId };
}
type Body = { customerId?: string; channel?: string; allowed?: unknown; source?: string };
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const { db, actor, customerId } = await customerContext(request);
    const body = await request.json() as Body;
    if (body.customerId && String(body.customerId) !== customerId) throw new Response("Customer ownership denied", { status: 403 });
    const channel = String(body.channel || "") as ConsentChannel;
    if (!CHANNELS.has(channel)) return json({ error: "Unsupported consent channel", code: "consent_channel_invalid" }, 400);
    if (typeof body.allowed !== "boolean") return json({ error: "Consent must be an explicit true or false", code: "consent_not_explicit" }, 400);
    const source = String(body.source || "customer_app_settings");
    if (!SOURCES.has(source)) return json({ error: "Unsupported consent source", code: "consent_source_invalid" }, 400);
    const result = await recordCustomerChannelConsent(db, { customerId, channel, allowed: body.allowed, source, updatedBy: `customer:${customerId}` });
    await securityAudit(db, actor, "communication_consent.channel.record", "customer", customerId, "completed", { channel, allowed: body.allowed, source, effectiveAllowed: result.effectiveAllowed });
    return json({ data: result }, 201);
  } catch (error) {
    if (error instanceof Response) return json({ error: await error.text() }, error.status);
    return authError(error, "Unable to record consent");
  }
}
