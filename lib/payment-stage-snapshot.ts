import { REDEEM_RUPEE_PER_POINT } from './booking-credit-application';
type Row = Record<string, unknown>;
export type PaymentStageSnapshot = { payment: Row; schedule: Row | null; credits: { totalApplied: number; walletApplied: number; pawPointsApplied: number }; recon: Row | null };
const optionalTables = ['stay_payment_schedules', 'taxi_payment_schedules', 'payment_reconciliation_records', 'pawspace_wallet_ledger', 'paw_points_ledger', 'review_reward_codes'];
const money = (value: unknown) => Math.round(Math.max(0, Number(value || 0)) * 100) / 100;

/** All mutable financial inputs are read by ONE SELECT per bounded batch.
 * Schema discovery is separate; missing optional ledgers mean never used, but query/schema faults
 * propagate. A capture cannot split the payment, instalment, credit and reconciliation read.
 */
export async function readPaymentStageSnapshots(db: D1Database, bookingIds: string[]): Promise<Map<string, PaymentStageSnapshot>> {
  const ids = [...new Set(bookingIds)], result = new Map<string, PaymentStageSnapshot>();
  if (!ids.length) return result;
  const schema = await db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN (${optionalTables.map(() => '?').join(',')})`).bind(...optionalTables).all<Row>();
  const tables = new Set(schema.results.map(row => String(row.name)));
  const optional = (table: string, select: string) => tables.has(table) ? `(${select})` : 'NULL';
  const stay = optional('stay_payment_schedules', "SELECT json_object('paid_now_amount',s.paid_now_amount,'balance_amount',s.balance_amount,'status',s.status) FROM stay_payment_schedules s WHERE s.booking_id=p.booking_id LIMIT 1");
  const taxi = optional('taxi_payment_schedules', "SELECT json_object('paid_now_amount',t.booking_fee_amount,'balance_amount',t.balance_amount,'status',t.status) FROM taxi_payment_schedules t WHERE t.booking_id=p.booking_id LIMIT 1");
  const recon = optional('payment_reconciliation_records', "SELECT json_object('captured_amount',r.captured_amount) FROM payment_reconciliation_records r WHERE r.payment_id=p.id LIMIT 1");
  const wallet = optional('pawspace_wallet_ledger', "SELECT SUM(w.applied_value) FROM pawspace_wallet_ledger w WHERE w.source_id=p.booking_id AND w.entry_type='redeem' AND w.source_type='booking'");
  const points = optional('paw_points_ledger', "SELECT SUM(-n.points) FROM paw_points_ledger n WHERE n.booking_id=p.booking_id AND n.entry_type='redeemed'");
  const rewards = optional('review_reward_codes', "SELECT SUM(COALESCE(c.applied_amount,c.discount_amount)) FROM review_reward_codes c WHERE c.redeemed_booking_id=p.booking_id AND c.status='redeemed' AND c.discount_amount>0");
  for (let offset = 0; offset < ids.length; offset += 80) {
    const batch = ids.slice(offset, offset + 80);
    const rows = await db.prepare(`SELECT p.id,p.booking_id,p.amount,p.amount_due_now,p.currency,p.status,
      ${stay} _stay,${taxi} _taxi,${recon} _recon,${wallet} _wallet,${points} _points,${rewards} _rewards
      FROM booking_payments p WHERE p.booking_id IN (${batch.map(() => '?').join(',')})`).bind(...batch).all<Row>();
    for (const row of rows.results) {
      const parse = (value: unknown): Row | null => value == null ? null : JSON.parse(String(value)) as Row;
      const walletApplied = money(row._wallet), pawPointsApplied = money(Number(row._points || 0) * REDEEM_RUPEE_PER_POINT);
      result.set(String(row.booking_id), { payment: row, schedule: parse(row._stay) ?? parse(row._taxi), recon: parse(row._recon),
        credits: { walletApplied, pawPointsApplied, totalApplied: money(walletApplied + pawPointsApplied + money(row._rewards)) },
      });
    }
  }
  return result;
}
