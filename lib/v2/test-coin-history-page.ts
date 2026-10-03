export async function testCoinHistoryPage(db: D1Database, customerId: string, cursor?: string) {
  const rows = await db.prepare(`SELECT id,source_kind,source_id,entry_type,coins,preview_discount,policy_json,created_at
    FROM v2_test_coin_ledger WHERE customer_id=? AND (? IS NULL OR (created_at,id) <
      (SELECT created_at,id FROM v2_test_coin_ledger WHERE id=? AND customer_id=?))
    ORDER BY created_at DESC,id DESC LIMIT 101`).bind(customerId, cursor ?? null, cursor ?? null, customerId).all<Record<string, unknown>>();
  return { history: rows.results.slice(0, 100), nextHistoryCursor: rows.results.length > 100 ? String(rows.results[99].id) : null };
}
