import { authError, resolveActor, requireProviderOwnership, database } from "../../../lib/server-auth";
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
    const result = await setProviderAvailability(db, {
      providerId: body.providerId, available: body.available, reason: body.reason, actorId: actor.email,
    });
    return Response.json({ data: result });
  } catch (error) {
    return authError(error, "Unable to update availability");
  }
}
