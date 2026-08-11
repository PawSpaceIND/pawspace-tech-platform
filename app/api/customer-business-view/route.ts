import { authError, database, requirePermission, resolveActor } from "../../../lib/server-auth";
import { buildCustomerBusinessView } from "../../../lib/customer-business-view";

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });

export async function GET(request: Request) {
  try {
    const actor = await resolveActor(request);
    requirePermission(actor, "customers.view");
    const db = await database();
    const url = new URL(request.url);
    const data = await buildCustomerBusinessView(db, url.searchParams.get("customerId") || undefined);
    return json({ data, source: "customer_360_plus_subscriptions" });
  } catch (error) {
    return authError(error, "Unable to load customer business view");
  }
}
