import { authError, database, resolveActor } from "../../../../lib/server-auth";
import { runDpdpRetentionSweep } from "../../../../lib/dpdp-retention";

function allowed(actor: { roleCode: string; developmentPreview: boolean }) {
  return actor.developmentPreview || actor.roleCode === "founder" || actor.roleCode === "superuser";
}

export async function POST(request: Request) {
  try {
    const actor = await resolveActor(request);
    if (!allowed(actor)) return Response.json({ error: "Founder role required" }, { status: 403 });
    const result = await runDpdpRetentionSweep(await database(), { requestedBy: actor.email });
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return authError(error, "DPDP retention sweep failed");
  }
}
