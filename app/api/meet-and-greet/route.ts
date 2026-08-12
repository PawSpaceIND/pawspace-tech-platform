import {
  authError,
  requireCustomerOwnership,
  requirePermission,
  resolveActor,
  securityAudit,
} from "../../../lib/server-auth";
import {
  cancelMeetGreetRequest,
  completeMeetGreetRequest,
  confirmMeetGreetRequest,
  createMeetGreetRequest,
  ensureMeetGreetTables,
  getMeetGreetEvents,
  getMeetGreetRequest,
  listMeetGreetRequests,
  markMeetGreetNoShow,
  type MeetGreetRequest,
} from "../../../lib/meet-and-greet";

const json = (value: unknown, status = 200) => Response.json(value, { status });

async function database() {
  const { env } = await import("cloudflare:workers");
  return env.DB;
}

export async function GET(request: Request) {
  try {
    const actor = await resolveActor(request);
    requirePermission(actor, "bookings.manage");

    const db = await database();
    await ensureMeetGreetTables(db);

    const url = new URL(request.url);
    const requestId = url.searchParams.get("requestId");
    const customerId = url.searchParams.get("customerId");
    const hostId = url.searchParams.get("hostId");
    const status = url.searchParams.get("status") as any;
    const includeEvents = url.searchParams.get("events") === "true";

    if (requestId) {
      const mgr = await getMeetGreetRequest(db, requestId);
      if (!mgr) return json({ error: "Request not found" }, 404);

      if (includeEvents) {
        const events = await getMeetGreetEvents(db, requestId);
        return json({ data: { ...mgr, events } });
      }
      return json({ data: mgr });
    }

    const requests = await listMeetGreetRequests(db, {
      customerId: customerId || undefined,
      hostId: hostId || undefined,
      status: status || undefined,
    });

    return json({ data: requests });
  } catch (error) {
    return authError(error, "Unable to list meet-greet requests");
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const action = String(body.action || "");
    const actor = await resolveActor(request);
    const db = await database();

    if (action === "create") {
      requirePermission(actor, "scheduling.book");

      const input = body.input as {
        customerId?: string;
        hostId?: string;
        format?: string;
        preferredAt?: number;
        intendedStayDays?: number;
      };

      if (!input?.customerId || !input?.hostId) return json({ error: "Customer and host are required" }, 400);

      await requireCustomerOwnership(db, actor, input.customerId);

      const mgr = await createMeetGreetRequest(
        db,
        {
          customerId: input.customerId,
          hostId: input.hostId,
          format: input.format as "phone_call" | "house_visit",
          preferredAt: input.preferredAt || 0,
          intendedStayDays: input.intendedStayDays || 0,
        },
        actor.email
      );

      await securityAudit(
        db,
        actor,
        "meet_greet.create",
        "meet_greet",
        mgr.id,
        "completed",
        {
          customerId: input.customerId,
          hostId: input.hostId,
          format: mgr.format,
          price: mgr.price,
        }
      );

      return json({ data: mgr }, 201);
    }

    if (action === "confirm") {
      requirePermission(actor, "bookings.manage");

      const requestId = String(body.requestId || "");
      if (!requestId) return json({ error: "Request ID is required" }, 400);

      const mgr = await confirmMeetGreetRequest(db, requestId, actor.email);

      await securityAudit(db, actor, "meet_greet.confirm", "meet_greet", requestId, "completed", {});

      return json({ data: mgr });
    }

    if (action === "complete") {
      requirePermission(actor, "bookings.manage");

      const requestId = String(body.requestId || "");
      if (!requestId) return json({ error: "Request ID is required" }, 400);

      const mgr = await completeMeetGreetRequest(db, requestId, actor.email);

      await securityAudit(db, actor, "meet_greet.complete", "meet_greet", requestId, "completed", {});

      return json({ data: mgr });
    }

    if (action === "cancel") {
      requirePermission(actor, "bookings.manage");

      const requestId = String(body.requestId || "");
      const reason = body.reason ? String(body.reason) : undefined;

      if (!requestId) return json({ error: "Request ID is required" }, 400);

      const mgr = await cancelMeetGreetRequest(db, requestId, actor.email, reason);

      await securityAudit(db, actor, "meet_greet.cancel", "meet_greet", requestId, "completed", {
        reason: reason || null,
      });

      return json({ data: mgr });
    }

    if (action === "no_show") {
      requirePermission(actor, "bookings.manage");

      const requestId = String(body.requestId || "");
      if (!requestId) return json({ error: "Request ID is required" }, 400);

      const mgr = await markMeetGreetNoShow(db, requestId, actor.email);

      await securityAudit(db, actor, "meet_greet.no_show", "meet_greet", requestId, "completed", {});

      return json({ data: mgr });
    }

    return json({ error: "Unsupported meet-greet action" }, 400);
  } catch (error) {
    return authError(error, "Unable to update meet-greet request");
  }
}

export async function PATCH(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const requestId = String(body.requestId || "");
    const action = String(body.action || "");

    if (!requestId || !action) return json({ error: "Request ID and action are required" }, 400);

    const actor = await resolveActor(request);
    requirePermission(actor, "bookings.manage");

    const db = await database();

    if (action === "confirm") {
      const mgr = await confirmMeetGreetRequest(db, requestId, actor.email);
      await securityAudit(db, actor, "meet_greet.confirm", "meet_greet", requestId, "completed", {});
      return json({ data: mgr });
    }

    if (action === "complete") {
      const mgr = await completeMeetGreetRequest(db, requestId, actor.email);
      await securityAudit(db, actor, "meet_greet.complete", "meet_greet", requestId, "completed", {});
      return json({ data: mgr });
    }

    if (action === "cancel") {
      const reason = body.reason ? String(body.reason) : undefined;
      const mgr = await cancelMeetGreetRequest(db, requestId, actor.email, reason);
      await securityAudit(db, actor, "meet_greet.cancel", "meet_greet", requestId, "completed", {
        reason: reason || null,
      });
      return json({ data: mgr });
    }

    if (action === "no_show") {
      const mgr = await markMeetGreetNoShow(db, requestId, actor.email);
      await securityAudit(db, actor, "meet_greet.no_show", "meet_greet", requestId, "completed", {});
      return json({ data: mgr });
    }

    return json({ error: "Unsupported action" }, 400);
  } catch (error) {
    return authError(error, "Unable to update meet-greet request");
  }
}
