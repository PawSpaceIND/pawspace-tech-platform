import { authError, authorize, database, securityAudit } from "../../../lib/server-auth";
import { resolvePlatformSession } from "../../../lib/platform-session";
import {
  createMeetGreetRequest,
  listMeetGreetEvents,
  listMeetGreetRequests,
  transitionMeetGreetRequest,
  type MeetGreetAction,
  type MeetGreetFormat,
  type MeetGreetStatus,
} from "../../../lib/meet-and-greet";

type Row = Record<string, unknown>;
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
const ACTIONS: MeetGreetAction[] = ["confirm", "complete", "cancel", "no_show"];
const STATUSES: MeetGreetStatus[] = ["requested", "confirmed", "completed", "cancelled", "no_show"];

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) throw new Response("Cross-origin meet-and-greet write blocked", { status: 403 });
}

/** Customer-facing, public: no auth required to request a meet & greet
 *  (mirrors /api/relocation-enquiry POST). Every input is coerced and re-validated
 *  server-side; the price is computed on the server, never trusted from the browser.
 *
 *  WHOSE request it is, is never taken from the browser. `customerId` is an internal identifier, and
 *  accepting a claimed one on an unauthenticated route let anybody file a request in a real customer's
 *  name — and, because only one open request may exist per customer+host, lock that customer out of
 *  ever requesting a meet & greet with that host until staff cancelled the impostor's. The route this
 *  one mirrors, /api/relocation-enquiry, asks for contact details and no internal id, which is why it
 *  never had the problem.
 *
 *  A signed-in customer requests as itself. An anonymous enquiry stays public and gets its own
 *  unattributed enquiry id, so the public path is unchanged and no identity can be claimed. */
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const db = await database();
    const body = (await request.json().catch(() => ({}))) as Row;

    const rawFormat = String(body.format ?? "").trim();
    if (rawFormat !== "phone" && rawFormat !== "house_visit") return json({ error: "format must be phone or house_visit" }, 400);
    const format = rawFormat as MeetGreetFormat;

    const claimedCustomerId = String(body.customerId ?? "").trim();
    const session = await resolvePlatformSession(db, request).catch(() => null);
    let customerId: string;
    if (session?.subjectType === "customer") {
      // A mismatch is refused rather than quietly rewritten, so an attempt to file under someone else
      // is visible in the response and the audit trail instead of being absorbed.
      if (claimedCustomerId && claimedCustomerId !== String(session.subjectId)) {
        return json({ error: "A meet & greet can only be requested for your own account" }, 403);
      }
      customerId = String(session.subjectId);
    } else {
      customerId = `MGENQ-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
    }

    try {
      const result = await createMeetGreetRequest(
        db,
        {
          customerId,
          hostProviderId: String(body.hostProviderId ?? "").trim(),
          format,
          preferredAt: Number(body.preferredAt),
          intendedStayStart: body.intendedStayStart == null ? undefined : String(body.intendedStayStart),
          intendedStayEnd: body.intendedStayEnd == null ? undefined : String(body.intendedStayEnd),
          intendedStayDays: body.intendedStayDays == null ? undefined : Number(body.intendedStayDays),
          notes: body.notes == null ? undefined : String(body.notes),
        },
        `customer:${customerId}`
      );
      return json({ data: result, productionReady: false }, 201);
    } catch (error) {
      if (error instanceof Error) return json({ error: error.message }, 400);
      throw error;
    }
  } catch (error) {
    return authError(error, "Unable to submit meet & greet request");
  }
}

/** Staff-facing directory. Gateway maps GET here to "bookings.manage". */
export async function GET(request: Request) {
  try {
    await authorize(request, "bookings.manage");
    const db = await database();
    const url = new URL(request.url);

    const requestId = String(url.searchParams.get("requestId") || "").trim();
    if (requestId) {
      const events = await listMeetGreetEvents(db, requestId);
      return json({ data: { events }, productionReady: false });
    }

    const rawStatus = String(url.searchParams.get("status") || "").trim();
    const requests = await listMeetGreetRequests(db, {
      customerId: String(url.searchParams.get("customerId") || "").trim() || undefined,
      hostProviderId: String(url.searchParams.get("hostProviderId") || "").trim() || undefined,
      status: (STATUSES as string[]).includes(rawStatus) ? (rawStatus as MeetGreetStatus) : undefined,
    });
    return json({ data: requests, productionReady: false });
  } catch (error) {
    return authError(error, "Unable to load meet & greet requests");
  }
}

/** Staff-facing lifecycle transitions: confirm / complete / cancel / no_show. */
export async function PATCH(request: Request) {
  try {
    const actor = await authorize(request, "bookings.manage");
    const db = await database();
    const body = (await request.json().catch(() => ({}))) as Row;

    const requestId = String(body.requestId ?? "").trim();
    const rawAction = String(body.action ?? "").trim();
    if (!requestId) return json({ error: "requestId is required" }, 400);
    if (!(ACTIONS as string[]).includes(rawAction)) return json({ error: "action must be confirm, complete, cancel or no_show" }, 400);

    try {
      const result = await transitionMeetGreetRequest(db, {
        requestId,
        action: rawAction as MeetGreetAction,
        actorId: actor.email,
        note: body.note == null ? undefined : String(body.note),
      });
      await securityAudit(db, actor, `meet_greet.${rawAction}`, "meet_greet_request", requestId, "completed", { status: result.status });
      return json({ data: result, productionReady: false });
    } catch (error) {
      if (error instanceof Error) return json({ error: error.message }, 409);
      throw error;
    }
  } catch (error) {
    return authError(error, "Unable to update meet & greet request");
  }
}
