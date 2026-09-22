import { authError, database, requirePermission, resolveActor } from "../../../lib/server-auth";
import { buildSubscriptionBusinessView } from "../../../lib/subscription-wallet";
import { ensureGroomingSubscriptionPlans } from "../../../lib/grooming-governance";

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });

export async function GET(request: Request) {
  try {
    const actor = await resolveActor(request);
    requirePermission(actor, "reports.view");
    const db = await database();
    // grooming_subscription_plans is owned by grooming-governance; on a database where that module
    // has never run, the view read a missing table and Control > Business 360 failed with 500.
    await ensureGroomingSubscriptionPlans(db);
    const data = await buildSubscriptionBusinessView(db);
    return json({ data, source: "customer_grooming_subscriptions" });
  } catch (error) {
    return authError(error, "Unable to load subscription business view");
  }
}
