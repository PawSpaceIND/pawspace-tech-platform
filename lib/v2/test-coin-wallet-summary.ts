/** Lifetime aggregates use the complete owner-scoped TEST ledger, never the display-page limit. */
export async function testCoinWalletSummary(db: D1Database, customerId: string) {
  const totals = await db.prepare(`SELECT
    COALESCE(SUM(CASE WHEN entry_type='earned' THEN coins ELSE 0 END),0) lifetimeCoinsEarned,
    COALESCE(SUM(CASE WHEN entry_type='redeemed' THEN -coins ELSE 0 END),0) lifetimeCoinsRedeemed,
    COALESCE(SUM(CASE WHEN entry_type='earn_reversal' THEN -coins ELSE 0 END),0) lifetimeEarningsReversed,
    COALESCE(SUM(CASE WHEN entry_type='redemption_restore' THEN coins ELSE 0 END),0) lifetimeRedemptionsRestored,
    COALESCE(SUM(CASE WHEN entry_type='redeemed' AND NOT EXISTS (SELECT 1 FROM v2_test_coin_ledger r WHERE r.customer_id=v2_test_coin_ledger.customer_id AND r.source_kind=v2_test_coin_ledger.source_kind AND r.source_id=v2_test_coin_ledger.source_id AND r.entry_type='redemption_restore') THEN preview_discount ELSE 0 END),0) lifetimeNetSimulatedSavings
    FROM v2_test_coin_ledger WHERE customer_id=?`).bind(customerId).first<Record<string, number>>();
  return { ...totals, lifetimeActualRupeesSaved: 0, actualSavingsReason: "TEST redemptions never change financial payments", pendingEarnedCoins: 0,
    pendingEarningsReason: "Uncompleted or unpaid services are estimates, not ledger-earned balances" };
}
