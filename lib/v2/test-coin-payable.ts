import { REDEEM_RUPEE_PER_POINT } from "../booking-credit-application";
/** Read-only SQL counterpart of resolvePaymentStageAmount, so the TEST debit can check
 * the payment, schedule, reconciliation and real credits in its own atomic INSERT.
 * This is never used to create a gateway order or change any financial record.
 */
export function testCoinCanonicalPaymentSql(tables: Set<string>) {
  const optional = (table: string, sql: string) => tables.has(table) ? `(${sql})` : "NULL";
  // Match the existing JavaScript Math.round(value*100)/100 for nonnegative money,
  // including binary-fraction ties; SQLite ROUND(value,2) can round those differently.
  const round2 = (sql: string) => `(CAST((${sql})*100+0.5 AS INTEGER)/100.0)`;
  const money = (sql: string) => round2(`MAX(COALESCE(${sql},0),0)`);
  const stay = optional("stay_payment_schedules", "SELECT json_object('paid',paid_now_amount,'balance',balance_amount,'status',status) FROM stay_payment_schedules WHERE booking_id=p.booking_id LIMIT 1");
  const taxi = optional("taxi_payment_schedules", "SELECT json_object('paid',booking_fee_amount,'balance',balance_amount,'status',status) FROM taxi_payment_schedules WHERE booking_id=p.booking_id LIMIT 1");
  const recon = optional("payment_reconciliation_records", "SELECT captured_amount FROM payment_reconciliation_records WHERE payment_id=p.id LIMIT 1");
  const wallet = optional("pawspace_wallet_ledger", "SELECT SUM(applied_value) FROM pawspace_wallet_ledger WHERE source_id=p.booking_id AND entry_type='redeem' AND source_type='booking'");
  const points = optional("paw_points_ledger", `SELECT SUM(-points)*${REDEEM_RUPEE_PER_POINT} FROM paw_points_ledger WHERE booking_id=p.booking_id AND entry_type='redeemed'`);
  const rewards = optional("review_reward_codes", "SELECT SUM(COALESCE(applied_amount,discount_amount)) FROM review_reward_codes WHERE redeemed_booking_id=p.booking_id AND status='redeemed' AND discount_amount>0");
  return `WITH raw AS (
    SELECT p.*,COALESCE(${stay},${taxi}) schedule,${recon} captured,
      ${round2(`${money(wallet)}+${money(points)}+${money(rewards)}`)} credits
    FROM booking_payments p
  ), inputs AS (
    SELECT raw.*,${round2("amount")} total,MIN(${round2("amount_due_now")},${round2("amount")}) stored_due,
      ${money("json_extract(schedule,'$.paid')")} paid_now,
      ${money("json_extract(schedule,'$.balance')")} balance,
      CASE WHEN status IN ('captured','refunded','partially_refunded') THEN 1 ELSE 0 END first_captured
    FROM raw
  ), funded AS (
    SELECT inputs.*,${money("COALESCE(captured,paid_now)")} captured_cash,
      MIN(CASE WHEN paid_now!=0 THEN paid_now ELSE stored_due END,total) first_stage
    FROM inputs
  ), first_cash AS (
    SELECT funded.*,MIN(paid_now,captured_cash) cash_first FROM funded
  ), remaining AS (
    SELECT first_cash.*,
      ${money(`credits-MIN(credits,${money("paid_now-cash_first")})`)} credits_remaining,
      ${money("captured_cash-cash_first")} cash_balance
    FROM first_cash
  ) SELECT remaining.*,
    CASE WHEN schedule IS NULL THEN CASE WHEN first_captured=1 THEN 0 ELSE ${money("stored_due-credits")} END
      WHEN json_extract(schedule,'$.status')='paid' THEN 0
      WHEN first_captured=0 THEN ${money("first_stage-MIN(credits,first_stage)")}
      WHEN credits>0 AND captured IS NULL THEN NULL
      ELSE ${money("balance-credits_remaining-cash_balance")} END current_payable
    FROM remaining`;
}
