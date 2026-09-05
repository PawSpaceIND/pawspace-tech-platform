import { authError, authorize, database, securityAudit } from "../../../../lib/server-auth";
import { DiallerPolicyError, diallerReadiness, ensureEmployeeDiallerTables, getDiallerCall, startNextDiallerCall } from "../../../../lib/employee-power-dialler";

const text = (value: unknown) => String(value ?? "").trim();
const diallerError = (error: unknown, fallback: string) => error instanceof DiallerPolicyError
  ? Response.json({ error: error.message, code: error.code }, { status: error.status, headers: { "cache-control": "no-store" } })
  : authError(error, fallback);

async function runtimeEnv() {
  try { const { env } = await import("cloudflare:workers"); return env as unknown as Record<string, unknown>; }
  catch { return {}; }
}

export async function GET(request: Request) {
  try {
    await authorize(request, "customers.manage");
    const db = await database(); await ensureEmployeeDiallerTables(db);
    const url = new URL(request.url), callId = text(url.searchParams.get("callId"));
    if (callId) return Response.json(await getDiallerCall(db, callId));
    return Response.json({ readiness: diallerReadiness(await runtimeEnv()) });
  } catch (error) { return diallerError(error, "Unable to load employee dialler"); }
}

export async function POST(request: Request) {
  try {
    const actor = await authorize(request, "customers.manage");
    const db = await database(); await ensureEmployeeDiallerTables(db);
    const env = await runtimeEnv();
    try {
      const result = await startNextDiallerCall(db, env, { actorEmail: actor.email });
      await securityAudit(db, actor, "employee_dialler.call", "lead", result.call?.leadId || null, result.queueEmpty ? "completed" : "allowed", { queueEmpty: result.queueEmpty, callId: result.call?.id || null });
      return Response.json(result, { status: result.queueEmpty ? 200 : 201 });
    } catch (error) {
      await securityAudit(db, actor, "employee_dialler.call", "lead", null, "blocked", { reason: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  } catch (error) { return diallerError(error, "Unable to start employee dialler call"); }
}
