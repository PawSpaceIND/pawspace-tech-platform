import { authError, authorize, database, requirePermission, securityAudit } from "../../../lib/server-auth";
import { runOutboundOrchestrationSweep, outboundQueueStats } from "../../../lib/outbound-orchestrator";
import { claimAndDialNextHuman, currentEmployeePowerCall, dispositionEmployeePowerCall, releaseEmployeePowerDialler } from "../../../lib/employee-power-dialler";
import { runOutboundAiDispatchSweep } from "../../../lib/outbound-ai-dispatch";
import { POWER_DIALLER_DISPOSITIONS, type PowerDiallerDispositionCode } from "../../../lib/power-dialler-policy";

type Body = Record<string, unknown>;
const text = (value: unknown) => String(value ?? "").trim();
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
function sameOrigin(request: Request) { const origin = request.headers.get("origin"); if (origin && origin !== new URL(request.url).origin) throw new Response("Cross-origin outbound write blocked", { status: 403 }); }
async function runtimeEnv() { const { env } = await import("cloudflare:workers"); return env as unknown as Record<string, unknown>; }

export async function GET(request: Request) {
  try {
    const actor = await authorize(request, "customers.manage"); requirePermission(actor, "communications.call");
    const db = await database(), current = await currentEmployeePowerCall(db, actor.email), stats = await outboundQueueStats(db);
    return json({ data: { current, stats, oneActiveCallPerEmployee: true } });
  } catch (error) { return authError(error, "Unable to load outbound orchestrator"); }
}

export async function POST(request: Request) {
  try {
    sameOrigin(request); const actor = await authorize(request, "customers.manage"); requirePermission(actor, "communications.call");
    const body = await request.json() as Body, action = text(body.action), db = await database(), env = await runtimeEnv();
    if (action === "claim_and_dial") {
      const data = await claimAndDialNextHuman(db, env, { actorId: actor.email });
      await securityAudit(db, actor, "outbound.power_dial", "outbound_queue", "next", text((data as Record<string, unknown>).status) === "dialing" ? "completed" : "rejected", { status: (data as Record<string, unknown>).status });
      return json({ data }, text((data as Record<string, unknown>).status) === "dialing" || text((data as Record<string, unknown>).status) === "already_active" ? 201 : 200);
    }
    if (action === "disposition") {
      const disposition = text(body.disposition) as PowerDiallerDispositionCode; if (!(POWER_DIALLER_DISPOSITIONS as readonly string[]).includes(disposition)) return json({ error: "Unsupported disposition" }, 400);
      const queueId = text(body.queueId); if (!queueId) return json({ error: "queueId is required" }, 400);
      const data = await dispositionEmployeePowerCall(db, { actorId: actor.email, queueId, disposition, callbackAt: body.callbackAt == null ? null : Number(body.callbackAt) });
      await securityAudit(db, actor, "outbound.disposition", "outbound_queue", queueId, "completed", { disposition }); return json({ data });
    }
    if (action === "release") return json({ data: await releaseEmployeePowerDialler(db, { actorId: actor.email }) });
    if (action === "refresh_routing") { const data = await runOutboundOrchestrationSweep(db, { batchSize: Number(body.batchSize || 50) }); await securityAudit(db, actor, "outbound.routing.refresh", "outbound_orchestrator", "customer_cursor", "completed", data); return json({ data }); }
    if (action === "dispatch_ai") { const data = await runOutboundAiDispatchSweep(db, env, { actorId: actor.email, limit: Number(body.limit || 20) }); await securityAudit(db, actor, "outbound.ai.dispatch", "outbound_orchestrator", "ai_queue", "completed", { dispatched: data.dispatched, blocked: data.blocked, failed: data.failed }); return json({ data }); }
    return json({ error: `Unsupported outbound action: ${action}` }, 400);
  } catch (error) { return authError(error, "Unable to process outbound orchestrator action"); }
}
