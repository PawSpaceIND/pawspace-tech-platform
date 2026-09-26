import { authError, authorize, database, requirePermission } from "../../../../lib/server-auth";
import { OPERATIONS_MANAGER_DOMAIN, requireManagerDomain, resolveManagerOrganizationalScope } from "../../../../lib/organizational-scope";
import { analyticsBookings, parseBookingSlice } from "../../../../lib/analytics-bookings";
export async function GET(request: Request) {
  try {
    const actor = await authorize(request, "reports.view");
    requirePermission(actor, "bookings.manage");
    const db = await database();
    const scope = await resolveManagerOrganizationalScope(db, actor);
    requireManagerDomain(scope, OPERATIONS_MANAGER_DOMAIN);
    let input;
    try { input = parseBookingSlice(new URL(request.url).searchParams); }
    catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Invalid filters." }, { status: 400 }); }
    return Response.json(await analyticsBookings(db, input, scope?.cityId), { headers: { "cache-control": "no-store" } });
  } catch (error) { return authError(error); }
}
