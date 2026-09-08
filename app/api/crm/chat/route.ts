import { authError, authorize, database, securityAudit } from "../../../../lib/server-auth";
import { maskName } from "../../../../lib/platform-security";
import { customerDataAccessResolver } from "../../../../lib/purpose-based-access";
import {
  ensureWhatsAppUatTables,
  queueWhatsAppUatOutbound,
  recordWhatsAppUatInbound,
  whatsappUatProviders,
  type WhatsAppUatProvider,
} from "../../../../lib/whatsapp-uat-adapter";
import {
  getWhatsAppConversationMode,
  setWhatsAppConversationMode,
  type WhatsAppConversationMode,
} from "../../../../lib/whatsapp-conversation-control";
import { getConversation, listConversationThreads } from "../../../../lib/conversation-governance";

type Row = Record<string, unknown>;

const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } });

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    throw new Response("Cross-origin CRM chat write blocked", { status: 403 });
  }
}

export async function GET(request: Request) {
  try {
    const actor = await authorize(request, "communications.manage");
    const db = await database();
    await ensureWhatsAppUatTables(db);

    const access = await customerDataAccessResolver(db);
    const convSubject = { email: actor.email, roleCode: actor.roleCode, permissions: actor.permissions };
    const url = new URL(request.url);
    const threadId = url.searchParams.get("threadId");

    if (threadId) {
      const data = await getConversation(db, threadId, "staff");
      if (!data) return json({ error: "Conversation not found" }, 404);

      const thread = data.thread as Row;
      const customerId = String(thread.customer_id || "");
      const session = await db
        .prepare("SELECT last_inbound_at, last_outbound_at FROM whatsapp_uat_sessions WHERE customer_id=?")
        .bind(customerId)
        .first<Row>()
        .catch(() => null);

      const lastInboundAt = Number(session?.last_inbound_at || 0);
      const isWithin24Hours = Boolean(lastInboundAt && Date.now() - lastInboundAt <= 24 * 60 * 60 * 1000);
      const routingMode = await getWhatsAppConversationMode(db, threadId).catch(() => ({ mode: "human_only" }));

      // Quick replies from whatsapp_quick_replies if available
      const quickReplies = await db
        .prepare("SELECT code, label, body FROM whatsapp_quick_replies WHERE active=1 ORDER BY label ASC")
        .all<Row>()
        .catch(() => ({ results: [] }));

      const threadView = access.view({
        actor: convSubject,
        purpose: "operations",
        subject: { customerId, name: String(thread.customer_name || ""), phone: null, email: null },
        assignment: { type: "booking", id: threadId, assignedTo: String(thread.assigned_to || ""), status: String(thread.status || "") },
      });

      return json({
        ok: true,
        data: {
          thread: {
            ...thread,
            customer_name: thread.customer_name ? maskName(String(thread.customer_name)) : "Customer",
            revealed: threadView.revealed,
          },
          messages: data.messages,
          participants: data.participants,
          session: {
            lastInboundAt,
            isWithin24Hours,
            sessionExpiresAt: lastInboundAt ? lastInboundAt + 24 * 60 * 60 * 1000 : null,
          },
          routingMode: routingMode.mode,
          quickReplies: quickReplies.results,
          sandboxLocks: {
            paymentEnv: "sandbox",
            forbidProduction: true,
            communicationEnv: "uat",
            externalDelivery: false,
          },
        },
      });
    }

    // List all WhatsApp threads
    const threads = await listConversationThreads(db, {
      actor,
      customerId: url.searchParams.get("customerId") || undefined,
      status: url.searchParams.get("status") || undefined,
      limit: Number(url.searchParams.get("limit") || 50),
    });

    const sessions = await db.prepare("SELECT customer_id, last_inbound_at FROM whatsapp_uat_sessions").all<Row>().catch(() => ({ results: [] as Row[] }));
    const sessionMap = new Map<string, number>(sessions.results.map((s: Row) => [String(s.customer_id), Number(s.last_inbound_at || 0)]));
    const now = Date.now();

    const enriched = (threads as Row[]).map((t) => {
      const cid = String(t.customer_id || "");
      const lastIn = Number(sessionMap.get(cid) || 0);
      return {
        ...t,
        customer_name: t.customer_name ? maskName(String(t.customer_name)) : "Customer",
        withinSession: Boolean(lastIn && now - lastIn <= 24 * 60 * 60 * 1000),
      };
    });

    return json({
      ok: true,
      data: {
        threads: enriched,
        total: enriched.length,
        sandboxLocks: {
          paymentEnv: "sandbox",
          forbidProduction: true,
          liveDelivery: false,
        },
      },
    });
  } catch (error) {
    return authError(error, "Unable to load CRM chat threads");
  }
}

interface ChatActionBody {
  action?: "send_message" | "simulate_inbound" | "set_mode";
  threadId?: string;
  customerId?: string;
  text?: string;
  templateKey?: string;
  language?: string;
  provider?: string;
  mode?: string;
  reason?: string;
}

export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const actor = await authorize(request, "communications.manage");
    const db = await database();
    await ensureWhatsAppUatTables(db);
    const body = (await request.json()) as ChatActionBody;

    if (!body.action) {
      return json({ error: "Missing chat action" }, 400);
    }

    if (body.action === "send_message") {
      if (!body.threadId || !body.customerId || !body.text) {
        return json({ error: "threadId, customerId, and message text are required" }, 400);
      }

      const provider: WhatsAppUatProvider = (
        body.provider && whatsappUatProviders.includes(body.provider as WhatsAppUatProvider)
          ? body.provider
          : "meta_whatsapp"
      ) as WhatsAppUatProvider;

      const idempotencyKey = `crm-chat-${body.threadId}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
      const result = await queueWhatsAppUatOutbound(db, {
        provider,
        threadId: body.threadId,
        customerId: body.customerId,
        text: body.text.trim(),
        templateKey: body.templateKey || null,
        language: body.language || "en",
        idempotencyKey,
        createdBy: actor.email,
      });

      await securityAudit(
        db,
        actor,
        "crm.chat.send_message",
        "conversation",
        body.threadId,
        result.queued ? "completed" : "blocked",
        {
          provider,
          messageId: result.messageId,
          queued: result.queued,
          reason: result.queued ? null : result.reason,
          externalDelivery: false,
        }
      );

      return json({ ok: true, data: result }, result.queued ? 201 : 400);
    }

    if (body.action === "simulate_inbound") {
      // Sandbox-only simulated inbound message from customer
      if (!body.text || (!body.customerId && !body.threadId)) {
        return json({ error: "Text and either customerId or threadId are required for simulated inbound" }, 400);
      }

      let customerId = body.customerId;
      if (!customerId && body.threadId) {
        const thread = await db.prepare("SELECT customer_id FROM communication_threads WHERE id=?").bind(body.threadId).first<Row>();
        customerId = thread ? String(thread.customer_id) : undefined;
      }

      if (!customerId) {
        return json({ error: "Customer not found for conversation thread" }, 404);
      }

      const eventId = `sim-meta-${Date.now()}-${crypto.randomUUID().slice(0, 6)}`;
      const provider: WhatsAppUatProvider = "meta_whatsapp";
      const result = await recordWhatsAppUatInbound(db, {
        provider,
        eventId,
        payloadHash: `sim-hash-${eventId}`,
        customerId,
        text: body.text.trim(),
        receivedAt: Date.now(),
        detail: {
          simulatedBy: actor.email,
          channel: "whatsapp",
          source: "crm_live_chat_console",
        },
      });

      await securityAudit(
        db,
        actor,
        "crm.chat.simulate_inbound",
        "conversation",
        result.threadId || body.threadId || "unknown",
        "completed",
        { eventId, messageId: result.messageId, customerId }
      );

      return json({ ok: true, data: result }, 201);
    }

    if (body.action === "set_mode") {
      if (!body.threadId || !body.mode) {
        return json({ error: "threadId and mode are required" }, 400);
      }

      const mode = body.mode as WhatsAppConversationMode;
      const reason = body.reason || `Operator ${actor.email} adjusted routing mode via CRM console`;
      await setWhatsAppConversationMode(db, {
        threadId: body.threadId,
        mode,
        actorEmail: actor.email,
        reason,
      });

      await securityAudit(
        db,
        actor,
        "crm.chat.set_mode",
        "conversation",
        body.threadId,
        "completed",
        { mode, reason }
      );

      return json({ ok: true, data: { threadId: body.threadId, mode } });
    }

    return json({ error: "Unsupported action" }, 400);
  } catch (error) {
    if (error instanceof Response) {
      return json({ error: await error.text() }, error.status);
    }
    return authError(error, "Unable to perform CRM chat action");
  }
}
