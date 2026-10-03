/** TEST-only grant lots and immutable spend/restoration allocations. No financial writes. */
export const testCoinSqlNow = "(CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER))";
export const testCoinGrantRowsSql = `SELECT l.id grant_id,l.customer_id,l.source_kind,l.source_id,l.created_at,g.expires_at,g.eligible_amount,g.earn_percent,
  MAX(0,l.coins-COALESCE((SELECT SUM(a.coins) FROM v2_test_coin_allocations a WHERE a.grant_id=l.id),0)
    +COALESCE((SELECT SUM(r.coins) FROM v2_test_coin_ledger r WHERE r.customer_id=l.customer_id AND r.source_kind=l.source_kind AND r.source_id=l.source_id AND r.entry_type='earn_reversal'),0)) remaining
  FROM v2_test_coin_ledger l LEFT JOIN v2_test_coin_grants g ON g.grant_id=l.id WHERE l.entry_type='earned'`;
export function testCoinEffectiveBalanceSql(customer: string) {
  return `(SELECT COALESCE(SUM(coins),0) FROM v2_test_coin_ledger WHERE customer_id=${customer})
    -(SELECT COALESCE(SUM(remaining),0) FROM (${testCoinGrantRowsSql}) WHERE customer_id=${customer} AND (expires_at IS NULL OR expires_at<=${testCoinSqlNow}))`;
}
export async function ensureTestCoinGrantTables(db: D1Database) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS v2_test_coin_grants (grant_id TEXT PRIMARY KEY,expires_at INTEGER NOT NULL,eligible_amount REAL NOT NULL,earn_percent REAL NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS v2_test_coin_allocations (id TEXT PRIMARY KEY,ledger_entry_id TEXT NOT NULL,grant_id TEXT NOT NULL,entry_type TEXT NOT NULL CHECK(entry_type IN ('spend','restore')),coins INTEGER NOT NULL,UNIQUE(ledger_entry_id,grant_id))"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_v2_test_coin_allocations_grant ON v2_test_coin_allocations(grant_id)"),
  ]);
}
