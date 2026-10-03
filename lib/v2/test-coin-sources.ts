import { testCoinCanonicalPaymentSql } from "./test-coin-payable";
import { REDEEM_RUPEE_PER_POINT } from "../booking-credit-application";
/** Read-only adapters. Missing vertical tables mean unavailable; query errors propagate. */
export type CoinSource = "booking" | "food" | "relocation" | "funeral";
export const coinSources: CoinSource[] = ["booking", "food", "relocation", "funeral"];
type Row = Record<string, unknown>;
export type SourceQuery = { sql: string; available: boolean; payableSchemaGuard?: string };
export async function coinSourceQuery(db: D1Database, source: CoinSource): Promise<SourceQuery> {
  const schema = await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all<Row>();
  const tables = new Set(schema.results.map(r => String(r.name)));
  const has = (...names: string[]) => names.every(n => tables.has(n));
  const optional = (table: string, sql: string, fallback = "0") => tables.has(table) ? `(${sql})` : fallback;
  if (source === "booking") {
    if (!has("canonical_bookings", "booking_payments")) return { sql: "", available: false };
    const refund = optional("payment_reconciliation_records", "SELECT MAX(refunded_amount) FROM payment_reconciliation_records WHERE payment_id=p.id");
    const stay = optional("stay_payment_schedules", "SELECT COUNT(*) FROM stay_payment_schedules WHERE booking_id=b.id AND status!='paid' AND balance_amount>0");
    const taxi = optional("taxi_payment_schedules", "SELECT COUNT(*) FROM taxi_payment_schedules WHERE booking_id=b.id AND status!='paid' AND balance_amount>0");
    const captured = optional("payment_reconciliation_records", "SELECT MAX(captured_amount) FROM payment_reconciliation_records WHERE payment_id=p.id", "NULL");
    // Reuse actual V1 credit valuation only to establish paid-service evidence. These values
    // never determine TEST earnings or TEST conversion and are never written here.
    const wallet = optional("pawspace_wallet_ledger", "SELECT SUM(applied_value) FROM pawspace_wallet_ledger WHERE source_id=b.id AND entry_type='redeem' AND source_type='booking'");
    const points = optional("paw_points_ledger", `SELECT SUM(-points)*${REDEEM_RUPEE_PER_POINT} FROM paw_points_ledger WHERE booking_id=b.id AND entry_type='redeemed'`);
    const rewards = optional("review_reward_codes", "SELECT SUM(COALESCE(applied_amount,discount_amount)) FROM review_reward_codes WHERE redeemed_booking_id=b.id AND status='redeemed' AND discount_amount>0");
    const credits = `COALESCE(${wallet},0)+COALESCE(${points},0)+COALESCE(${rewards},0)`;
    // Reject a stale SQL projection if an optional financial table appeared after discovery.
    const financialTables = ["stay_payment_schedules", "taxi_payment_schedules", "payment_reconciliation_records", "pawspace_wallet_ledger", "paw_points_ledger", "review_reward_codes"];
    const payableSchemaGuard = financialTables.map(name => `(SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='${name}')=${tables.has(name) ? 1 : 0}`).join(" AND ");
    return { available: true, payableSchemaGuard, sql: `SELECT b.id,b.customer_id,b.service_code,b.status,b.total_amount total,p.amount eligible_amount,b.currency,
      p.current_payable due_now,p.status payment_status,
      CASE WHEN p.customer_id=b.customer_id AND p.status='captured' AND p.amount>0 AND ${stay}=0 AND ${taxi}=0
        AND ((${captured} IS NOT NULL AND ${captured}>0 AND ${captured}+${credits}>=p.amount) OR (${captured} IS NULL AND p.amount_due_now>0 AND (p.amount_due_now>=p.amount OR ${optional('stay_payment_schedules', "SELECT COUNT(*) FROM stay_payment_schedules WHERE booking_id=b.id AND status='paid'")}>0 OR ${optional('taxi_payment_schedules', "SELECT COUNT(*) FROM taxi_payment_schedules WHERE booking_id=b.id AND status='paid'")}>0)
        )) THEN 1 ELSE 0 END paid,
      CASE WHEN p.status IN ('refunded','partially_refunded') OR COALESCE(${refund},0)>0 THEN 1 ELSE 0 END refunded,
      CASE WHEN p.status='refunded' OR COALESCE(${refund},0)>=p.amount THEN 1 ELSE 0 END fully_refunded,
      CASE WHEN b.status='completed' THEN 1 ELSE 0 END completed
      FROM canonical_bookings b LEFT JOIN (${testCoinCanonicalPaymentSql(tables)}) p ON p.booking_id=b.id` };
  }
  if (source === "food") {
    if (!has("food_orders", "food_order_payment_events", "food_order_fulfilment")) return { sql: "", available: false };
    const refund = optional("food_refund_ledger", "SELECT SUM(amount) FROM food_refund_ledger WHERE order_id=b.id AND status='sandbox_recorded'");
    return { available: true, sql: `SELECT b.id,b.customer_id,'food' service_code,b.status,b.total_amount total,b.total_amount eligible_amount,b.currency,
      CASE WHEN p.status='due' THEN p.amount ELSE 0 END due_now,p.status payment_status,
      CASE WHEN p.status='sandbox_paid' AND p.amount>=b.total_amount AND p.amount>0 THEN 1 ELSE 0 END paid,
      CASE WHEN COALESCE(${refund},0)>0 THEN 1 ELSE 0 END refunded,
      CASE WHEN COALESCE(${refund},0)>=b.total_amount THEN 1 ELSE 0 END fully_refunded,
      CASE WHEN b.status='delivered' AND f.status='delivered' THEN 1 ELSE 0 END completed
      FROM food_orders b LEFT JOIN food_order_payment_events p ON p.order_id=b.id LEFT JOIN food_order_fulfilment f ON f.order_id=b.id` };
  }
  const table = source === "relocation" ? "relocation" : "funeral";
  if (!has(`${table}_cases`, `${table}_payments`)) return { sql: "", available: false };
  const refund = optional(`${table}_refunds`, `SELECT SUM(amount) FROM ${table}_refunds WHERE case_id=b.id AND status='completed'`);
  return { available: true, sql: `SELECT b.id,b.customer_id,'${table}' service_code,b.status,p.amount total,p.amount eligible_amount,'INR' currency,
    CASE WHEN p.status='paid' THEN 0 ELSE p.amount END due_now,p.status payment_status,
    CASE WHEN p.status='paid' AND p.amount>0 THEN 1 ELSE 0 END paid,
    CASE WHEN COALESCE(${refund},0)>0 THEN 1 ELSE 0 END refunded,
    CASE WHEN COALESCE(${refund},0)>=p.amount THEN 1 ELSE 0 END fully_refunded,
    CASE WHEN b.status='${source === "relocation" ? "delivered" : "closed"}' THEN 1 ELSE 0 END completed
    FROM ${table}_cases b LEFT JOIN ${table}_payments p ON p.case_id=b.id` };
}
export function validCoinSource(value: unknown): value is CoinSource {
  return coinSources.includes(value as CoinSource);
}
