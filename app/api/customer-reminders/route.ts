import { authError, database, requirePermission, resolveActor, securityAudit } from "../../../lib/server-auth";
import { currentCadencePolicy, saveReminderCadencePolicy, runCustomerReminderSweep } from "../../../lib/customer-reminder-governance";

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
function sameOriginWrite(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) throw new Response("Cross-origin reminder policy write blocked", { status: 403 });
}

export async function GET(request: Request) {
  try {
    const actor = await resolveActor(request);
    requirePermission(actor, "settings.manage");
    const db = await database();
    const policy = await currentCadencePolicy(db);
    const recent = await db.prepare("SELECT * FROM reminder_governance_events ORDER BY created_at DESC LIMIT 100").all();
    return json({ data: { policy, recentEvents: recent.results, backgroundSchedulerConfigured: true, externalDelivery: false } });
  } catch (error) {
    return authError(error, "Unable to load reminder governance");
  }
}

export async function POST(request: Request) {
  try {
    sameOriginWrite(request);
    const actor = await resolveActor(request);
    requirePermission(actor, "settings.manage");
    const db = await database();
    const body = (await request.json()) as { action?: string; groomingRebookingDays?: number; subscriptionInactivityDays?: number; subscriptionRenewalDays?: number; reason?: string };
    if (body.action === "save_policy") {
      if (!body.reason) return json({ error: "A clear policy change reason is required" }, 400);
      const policy = await saveReminderCadencePolicy(db, {
        groomingRebookingDays: Number(body.groomingRebookingDays),
        subscriptionInactivityDays: Number(body.subscriptionInactivityDays),
        subscriptionRenewalDays: Number(body.subscriptionRenewalDays),
        reason: body.reason, actorId: actor.email,
      });
      await securityAudit(db, actor, "reminder.policy.save", "reminder_cadence_policy", "default", "completed", policy);
      return json({ data: policy });
    }
    if (body.action === "run_sweep_now") {
      const result = await runCustomerReminderSweep(db, { actorId: actor.email });
      await securityAudit(db, actor, "reminder.sweep.manual", "reminder_sweep", "manual", "completed", result);
      return json({ data: result });
    }
    return json({ error: "Unsupported reminder governance action" }, 400);
  } catch (error) {
    if (error instanceof Response) return json({ error: await error.text() }, error.status);
    return authError(error, "Unable to update reminder governance");
  }
}
