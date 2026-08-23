import { authError, resolveActor, requireProviderOwnership, actorManagesProviders, database } from "../../../lib/server-auth";
import { setProviderAvailability } from "../../../lib/provider-capacity-governance";

export async function POST(request: Request) {
  try {
    const actor = await resolveActor(request);
    const db = await database();
    const body = (await request.json()) as { providerId?: string; available?: boolean; reason?: string };
    if (!body.providerId || typeof body.available !== "boolean" || !body.reason) {
      return Response.json({ error: "providerId, available and reason are required" }, { status: 400 });
    }
    await requireProviderOwnership(db, actor, body.providerId);
    // Ownership says whose record this is; authority says who may lift a restriction on it. A provider
    // passes the first and not the second, so the two are resolved separately and both are passed down.
    const result = await setProviderAvailability(db, {
      providerId: body.providerId, available: body.available, reason: body.reason, actorId: actor.email,
      actorIsStaff: actorManagesProviders(actor),
    });
    return Response.json({ data: result });
  } catch (error) {
    return authError(error, "Unable to update availability");
  }
}
