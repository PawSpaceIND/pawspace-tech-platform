import { authError, database, requirePermission, resolveActor } from "../../../lib/server-auth";
import { buildSubscriptionBusinessView } from "../../../lib/subscription-wallet";

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });

export async function GET(request: Request) {
  try {
    const actor = await resolveActor(request);
    requirePermission(actor, "reports.view");
    const db = await database();
    const data = await buildSubscriptionBusinessView(db);
    return json({ data, source: "customer_grooming_subscriptions" });
  } catch (error) {
    return authError(error, "Unable to load subscription business view");
  }
}
