import { authError, authorize, database, securityAudit } from "../../../../lib/server-auth";
import { DIALLER_DISPOSITIONS, DiallerPolicyError, ensureEmployeeDiallerTables, submitDiallerDisposition, type DiallerDisposition } from "../../../../lib/employee-power-dialler";

const text = (value: unknown) => String(value ?? "").trim();
const diallerError = (error: unknown) => error instanceof DiallerPolicyError
  ? Response.json({ error: error.message, code: error.code }, { status: error.status, headers: { "cache-control": "no-store" } })
  : authError(error, "Unable to save dialler disposition");

export async function POST(request: Request) {
  try {
    const actor = await authorize(request, "customers.manage");
    const db = await database(); await ensureEmployeeDiallerTables(db);
    const body = await request.json() as Record<string, unknown>;
    const disposition = text(body.disposition) as DiallerDisposition;
    if (!DIALLER_DISPOSITIONS.includes(disposition)) throw new DiallerPolicyError("invalid_disposition", "Unsupported disposition", 400);
    const result = await submitDiallerDisposition(db, {
      callId: text(body.callId),
      actorEmail: actor.email,
      disposition,
      callbackAt: body.callbackAt == null ? null : Number(body.callbackAt),
      note: body.note == null ? null : text(body.note),
    });
    await securityAudit(db, actor, "employee_dialler.disposition", "dialler_call", text(body.callId), "completed", { disposition, nextEligibleAt: result.nextEligibleAt });
    return Response.json(result);
  } catch (error) { return diallerError(error); }
}
