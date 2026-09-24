import { resolvePaymentStageAmount, type PaymentStageAmount } from './payment-stage-amount';
import { REDEEM_RUPEE_PER_POINT } from './booking-credit-application';
type Row = Record<string, unknown>;
const round = (n: number) => Math.round(Math.max(0, n) * 100) / 100;

/** Read only the listed bookings, in bounded batches. Missing optional ledgers mean never used;
 * an unavailable database or an incompatible schema is NOT a zero balance.
 */
async function optionalRows(db: D1Database, table: string, sql: string, ids: string[]): Promise<Row[]> {
  try { return (await db.prepare(sql).bind(...ids).all<Row>()).results; }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes(`no such table: ${table}`) || message.includes(`no such table: main.${table}`)) return [];
    throw error;
  }
}
export async function bookingPaymentBalances(db: D1Database, bookingIds: string[]): Promise<Map<string, PaymentStageAmount>> {
  const out = new Map<string, PaymentStageAmount>(), ids = [...new Set(bookingIds)];
  for (let offset = 0; offset < ids.length; offset += 80) {
    const chunk = ids.slice(offset, offset + 80), placeholders = chunk.map(() => '?').join(',');
    const read = (table: string, sql: string) => optionalRows(db, table, sql, chunk);
    const [payments, stays, taxis, reconciliations, wallets, points, rewards] = await Promise.all([
      db.prepare(`SELECT id,booking_id,amount,amount_due_now,currency,status FROM booking_payments WHERE booking_id IN (${placeholders})`).bind(...chunk).all<Row>().then(r => r.results),
      read('stay_payment_schedules', `SELECT booking_id,paid_now_amount,balance_amount,status FROM stay_payment_schedules WHERE booking_id IN (${placeholders})`),
      read('taxi_payment_schedules', `SELECT booking_id,booking_fee_amount paid_now_amount,balance_amount,status FROM taxi_payment_schedules WHERE booking_id IN (${placeholders})`),
      read('payment_reconciliation_records', `SELECT booking_id,captured_amount FROM payment_reconciliation_records WHERE booking_id IN (${placeholders})`),
      read('pawspace_wallet_ledger', `SELECT source_id booking_id,SUM(applied_value) total FROM pawspace_wallet_ledger WHERE entry_type='redeem' AND source_type='booking' AND source_id IN (${placeholders}) GROUP BY source_id`),
      read('paw_points_ledger', `SELECT booking_id,SUM(-points) points FROM paw_points_ledger WHERE entry_type='redeemed' AND booking_id IN (${placeholders}) GROUP BY booking_id`),
      read('review_reward_codes', `SELECT redeemed_booking_id booking_id,SUM(COALESCE(applied_amount,discount_amount)) total FROM review_reward_codes WHERE status='redeemed' AND discount_amount>0 AND redeemed_booking_id IN (${placeholders}) GROUP BY redeemed_booking_id`),
    ]);
    const keyed = (rows: Row[]) => new Map(rows.map(row => [String(row.booking_id), row]));
    const stayMap = keyed(stays), taxiMap = keyed(taxis), reconMap = keyed(reconciliations);
    const walletMap = keyed(wallets), pointsMap = keyed(points), rewardMap = keyed(rewards);
    for (const payment of payments) {
      const id = String(payment.booking_id), walletApplied = round(Number(walletMap.get(id)?.total || 0));
      const pawPointsApplied = round(Number(pointsMap.get(id)?.points || 0) * REDEEM_RUPEE_PER_POINT);
      const reviewRewardApplied = round(Number(rewardMap.get(id)?.total || 0));
      out.set(id, resolvePaymentStageAmount(payment, stayMap.get(id) ?? taxiMap.get(id) ?? null, {
        walletApplied, pawPointsApplied, totalApplied: round(walletApplied + pawPointsApplied + reviewRewardApplied),
      }, reconMap.get(id) ?? null));
    }
  }
  return out;
}
