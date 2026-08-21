import { authError, database, requirePermission, resolveActor, securityAudit } from "../../../lib/server-auth";
import { lifecycleReminderDirectory, runLifecycleReminderEngine, saveLifecycleReminderRule } from "../../../lib/lifecycle-reminder-engine";

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });

function sameOriginWrite(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) throw new Response("Cross-origin lifecycle reminder write blocked", { status: 403 });
}

export async function GET(request: Request) {
  try {
    const actor = await resolveActor(request);
    requirePermission(actor, "settings.manage");
    const db = await database();
    return json({ data: await lifecycleReminderDirectory(db) });
  } catch (error) {
    return authError(error, "Unable to load lifecycle reminder engine");
  }
}

export async function POST(request: Request) {
  try {
    sameOriginWrite(request);
    const actor = await resolveActor(request);
    requirePermission(actor, "settings.manage");
    const db = await database();
    const body = (await request.json()) as {
      action?: string;
      id?: string;
      delayDays?: number | null;
      repeatDays?: number | null;
      templateKey?: string;
      active?: boolean;
      reason?: string;
    };

    if (body.action === "save_rule") {
      if (!body.id || !body.templateKey || !body.reason) return json({ error: "Rule, template and change reason are required" }, 400);
      const rule = await saveLifecycleReminderRule(db, {
        id: body.id,
        delayDays: body.delayDays == null ? null : Number(body.delayDays),
        repeatDays: body.repeatDays == null ? null : Number(body.repeatDays),
        templateKey: body.templateKey,
        active: Boolean(body.active),
        reason: body.reason,
        actorId: actor.email,
      });
      await securityAudit(db, actor, "lifecycle_reminder.rule.save", "lifecycle_reminder_rule", body.id, "completed", rule);
      return json({ data: rule });
    }

    if (body.action === "run_now") {
      const result = await runLifecycleReminderEngine(db, { actorId: actor.email });
      await securityAudit(db, actor, "lifecycle_reminder.sweep.manual", "lifecycle_reminder_engine", "manual", "completed", result);
      return json({ data: result });
    }

    return json({ error: "Unsupported lifecycle reminder action" }, 400);
  } catch (error) {
    if (error instanceof Response) return json({ error: await error.text() }, error.status);
    return authError(error, "Unable to update lifecycle reminder engine");
  }
}
