import { authError, authorize, database } from "../../../lib/server-auth";
import { buildManagerDashboard } from "../../../lib/manager-dashboard";

export async function GET(request: Request) {
  try {
    const actor = await authorize(request, "people.view");
    const db = await database();
    const data = await buildManagerDashboard(db, { actorEmail: actor.email, permissions: actor.permissions });
    return Response.json({ data });
  } catch (error) {
    return authError(error, "Unable to load manager dashboard");
  }
}
