import { buildCustomer360 } from "./customer-360";

type Db = D1Database;
type Row = Record<string, unknown>;

export type CustomerBusinessRow = {
  customerId: string; name: string; pet: string; createdAt: number | null;
  segment: "Subscriber" | "Repeat" | "New" | "Dormant";
  lastServiceAt: string | null; daysSinceLastService: number | null;
  orders: number; revenue: number; margin: null;
  nextAction: string; risk: string;
};

/**
 * Real customer business-intelligence view built on top of the already-real Customer360Record -
 * every field here is derived from real bookings/subscriptions, none invented. Segment and risk are
 * simple, disclosed rules over real state (active subscription, real order count, real days since
 * last service, real subscription expiry proximity) - not an AI-generated recommendation, and never
 * claimed to be one. Margin stays honestly null: attributing real per-vertical cost (which only
 * exists for Boarding and Pet Sitting bookings) down to an individual customer whose bookings may
 * span multiple verticals would carry the same partial-coverage risk the vertical-level cost
 * guardrail exists to prevent, at a much finer grain - not attempted here.
 */
export async function buildCustomerBusinessView(db: Db, customerId?: string): Promise<CustomerBusinessRow[]> {
  const records = await buildCustomer360(db, customerId);
  if (!records.length) return [];
  const ids = records.map(r => r.customerId);
  const placeholders = ids.map(() => "?").join(",");
  let activeSubByCustomer = new Map<string, number>();
  let createdAtByCustomer = new Map<string, number>();
  try {
    const subs = await db.prepare(`SELECT customer_id,MIN(expires_at) nearest_expiry FROM customer_grooming_subscriptions WHERE customer_id IN (${placeholders}) AND status='active' GROUP BY customer_id`).bind(...ids).all<Row>();
    activeSubByCustomer = new Map(subs.results.map(row => [String(row.customer_id), Number(row.nearest_expiry)]));
  } catch { /* table may not exist yet in some environments */ }
  try {
    const created = await db.prepare(`SELECT id,created_at FROM canonical_customers WHERE id IN (${placeholders})`).bind(...ids).all<Row>();
    createdAtByCustomer = new Map(created.results.map(row => [String(row.id), Number(row.created_at)]));
  } catch { /* table may not exist yet in some environments */ }
  const now = Date.now(), day = 86_400_000;
  return records.map(r => {
    const orders = r.bookings.filter(b => !["cancelled", "draft"].includes(b.status)).length;
    const lastServiceMs = r.lastServiceAt ? new Date(r.lastServiceAt).getTime() : null;
    const daysSinceLastService = lastServiceMs != null && Number.isFinite(lastServiceMs) ? Math.floor((now - lastServiceMs) / day) : null;
    const nearestExpiry = activeSubByCustomer.get(r.customerId) ?? null;
    const isSubscriber = nearestExpiry != null;
    const segment: CustomerBusinessRow["segment"] = isSubscriber ? "Subscriber" : orders > 1 ? "Repeat" : daysSinceLastService != null && daysSinceLastService > 90 ? "Dormant" : "New";
    let risk = "Healthy", nextAction = "No action needed";
    if (isSubscriber && nearestExpiry! - now <= 7 * day) { risk = "Renewal due"; nextAction = "Renew subscription"; }
    else if (segment === "Dormant") { risk = "At risk"; nextAction = "Win-back call"; }
    else if (r.openTicketCount > 0) { risk = "Open ticket"; nextAction = "Resolve open ticket"; }
    else if (isSubscriber) { risk = "Healthy"; nextAction = "Book next session"; }
    return {
      customerId: r.customerId, name: r.name, pet: r.pets[0]?.name || (r.pets.length > 1 ? `${r.pets.length} pets` : "No pet on file"),
      createdAt: createdAtByCustomer.get(r.customerId) ?? null, segment, lastServiceAt: r.lastServiceAt, daysSinceLastService,
      orders, revenue: r.lifetimeValue, margin: null, nextAction, risk,
    };
  });
}
