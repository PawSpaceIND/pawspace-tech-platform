import { ensureTestCoinGrantTables, testCoinEffectiveBalanceSql, testCoinGrantRowsSql, testCoinSqlNow } from "./test-coin-grants";
import { governedJsonError } from "../governed-http-error";
import { coinSourceQuery, coinSources, type CoinSource } from "./test-coin-sources";
import { requireTestCoinPolicy, type TestCoinPolicy } from "./test-coin-policy";
import { paymentStageAmount } from "../payment-stage-amount";
import { testCoinWalletSummary } from "./test-coin-wallet-summary";
import { testCoinHistoryPage } from "./test-coin-history-page";
type Row = Record<string, unknown>;
const label = "TEST coins — no cash value";
const closed = "('cancelled','canceled','refunded','closed')";
export async function ensureTestCoinTables(db: D1Database) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS v2_test_coin_ledger (
      id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,source_kind TEXT NOT NULL,source_id TEXT NOT NULL,
      entry_type TEXT NOT NULL CHECK(entry_type IN ('earned','redeemed','earn_reversal','redemption_restore')),
      coins INTEGER NOT NULL CHECK(coins!=0),preview_discount REAL NOT NULL DEFAULT 0,
      policy_json TEXT NOT NULL,actor_id TEXT NOT NULL,created_at INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE)`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_v2_test_coins_customer ON v2_test_coin_ledger(customer_id,created_at)"),
  ]);
  await ensureTestCoinGrantTables(db);
}
/** V1's append-only SUM and unique booking keys, kept entirely outside the real ledger. */
export async function testCoinHistory(db: D1Database, customerId: string, policy: TestCoinPolicy, historyCursor?: string) {
  requireTestCoinPolicy(policy);
  await ensureTestCoinTables(db);
  const balance = await db.prepare(`SELECT ${testCoinEffectiveBalanceSql("?")} balance,
    (SELECT COALESCE(SUM(coins),0) FROM v2_test_coin_ledger WHERE customer_id=?)
      -(SELECT COALESCE(SUM(remaining),0) FROM (${testCoinGrantRowsSql}) WHERE customer_id=?) grantBalanceAdjustment`)
    .bind(customerId, customerId, customerId, customerId).first<Row>();
  const history = await testCoinHistoryPage(db, customerId, historyCursor);
  // Recover service labels from owner-scoped canonical sources; do not infer a service from an ID.
  for (const source of coinSources) {
    const ids = history.history.filter(entry => entry.source_kind === source).map(entry => String(entry.source_id));
    if (!ids.length) continue;
    const query = await coinSourceQuery(db, source);
    if (!query.available) continue;
    const labels = await db.prepare(`SELECT id,service_code FROM (${query.sql}) WHERE customer_id=? AND id IN (${ids.map(() => "?").join(",")})`).bind(customerId, ...ids).all<Row>();
    for (const entry of history.history) {
      const match = entry.source_kind === source && labels.results.find(row => row.id === entry.source_id);
      if (match) entry.serviceCode = match.service_code;
    }
  }
  const grants = await db.prepare(`SELECT * FROM (${testCoinGrantRowsSql}) WHERE customer_id=? ORDER BY expires_at,created_at,grant_id`).bind(customerId).all<Row>();
  const now = Date.now();
  const expiredCoins = grants.results.filter(g => g.expires_at != null && Number(g.expires_at) <= now).reduce((n, g) => n + Number(g.remaining), 0);
  const expiryPendingCoins = grants.results.filter(g => g.expires_at == null).reduce((n, g) => n + Number(g.remaining), 0);
  const value = Number(balance?.balance || 0);
  return { label, customerId, balance: value, grantBalanceAdjustment: Number(balance?.grantBalanceAdjustment || 0), spendableCoins: Math.max(0, value), reversalDebt: Math.max(0, -value),
    realMoneyValue: 0, policy, expiredCoins, expiryPendingCoins, grants: grants.results, expiryConfigurationRequired: policy.expirySeconds === null, ...history,
    walletSummary: await testCoinWalletSummary(db, customerId) };
}
/** Owner-scoped, set-based refresh: all verticals; no service scheduling or finance writes.
 * A refund/reopened service reverses the complete DEMO earn. Full refund/cancellation restores
 * DEMO redemption. Partial-refund earn reversal is conservative test behavior, not real policy.
 */
export async function syncTestCoins(db: D1Database, customerId: string, policy: TestCoinPolicy, actorId: string) {
  requireTestCoinPolicy(policy);
  await ensureTestCoinTables(db);
  const gaps: string[] = [];
  const results: Record<string, number> = {};
  for (const source of coinSources) {
    const query = await coinSourceQuery(db, source);
    if (!query.available) { gaps.push(`${source}: source tables unavailable`); continue; }
    const prefix = `test:${source}:`;
    const now = Date.now(), settings = JSON.stringify(policy);
    const writes = await db.batch([
      db.prepare(`WITH s AS (${query.sql}) INSERT OR IGNORE INTO v2_test_coin_ledger
        (id,customer_id,source_kind,source_id,entry_type,coins,policy_json,actor_id,created_at,idempotency_key)
        SELECT ?||'earn:'||id,customer_id,?,id,'earned',CAST(eligible_amount*?/100 AS INTEGER),?,?,?,?||'earn:'||id FROM s
        WHERE customer_id=? AND completed=1 AND paid=1 AND refunded=0 AND currency='INR' AND eligible_amount>0 AND CAST(eligible_amount*?/100 AS INTEGER)>0 AND ? IS NOT NULL`)
        .bind(prefix, source, policy.earnPercent, settings, actorId, now, prefix, customerId, policy.earnPercent, policy.expirySeconds),
      db.prepare(`WITH s AS (${query.sql}) INSERT OR IGNORE INTO v2_test_coin_grants (grant_id,expires_at,eligible_amount,earn_percent)
        SELECT l.id,l.created_at+CAST(json_extract(l.policy_json,'$.expirySeconds') AS INTEGER)*1000,s.eligible_amount,json_extract(l.policy_json,'$.earnPercent')
        FROM s JOIN v2_test_coin_ledger l ON l.source_kind=? AND l.source_id=s.id AND l.customer_id=s.customer_id AND l.entry_type='earned'
        WHERE s.customer_id=? AND json_extract(l.policy_json,'$.expirySeconds')>0`).bind(source, customerId),
      db.prepare(`WITH s AS (${query.sql}) INSERT OR IGNORE INTO v2_test_coin_ledger
        (id,customer_id,source_kind,source_id,entry_type,coins,policy_json,actor_id,created_at,idempotency_key)
        SELECT ?||'reverse:'||s.id,s.customer_id,?,s.id,'earn_reversal',-l.coins,l.policy_json,?,?,?||'reverse:'||s.id
        FROM s JOIN v2_test_coin_ledger l ON l.source_kind=? AND l.source_id=s.id AND l.entry_type='earned' AND l.customer_id=s.customer_id
        WHERE s.customer_id=? AND (s.completed=0 OR s.paid=0 OR s.refunded=1)`)
        .bind(prefix, source, actorId, now, prefix, source, customerId),
      db.prepare(`WITH s AS (${query.sql}) INSERT OR IGNORE INTO v2_test_coin_ledger
        (id,customer_id,source_kind,source_id,entry_type,coins,policy_json,actor_id,created_at,idempotency_key)
        SELECT ?||'restore:'||s.id,s.customer_id,?,s.id,'redemption_restore',-l.coins,l.policy_json,?,?,?||'restore:'||s.id
        FROM s JOIN v2_test_coin_ledger l ON l.source_kind=? AND l.source_id=s.id AND l.entry_type='redeemed' AND l.customer_id=s.customer_id
        WHERE s.customer_id=? AND (s.status IN ('cancelled','canceled') OR s.fully_refunded=1)`)
        .bind(prefix, source, actorId, now, prefix, source, customerId),
      db.prepare(`INSERT OR IGNORE INTO v2_test_coin_allocations (id,ledger_entry_id,grant_id,entry_type,coins)
      SELECT r.id||':'||a.grant_id,r.id,a.grant_id,'restore',-a.coins FROM v2_test_coin_ledger r
      JOIN v2_test_coin_ledger d ON d.customer_id=r.customer_id AND d.source_kind=r.source_kind AND d.source_id=r.source_id AND d.entry_type='redeemed'
      JOIN v2_test_coin_allocations a ON a.ledger_entry_id=d.id AND a.entry_type='spend'
      WHERE r.customer_id=? AND r.entry_type='redemption_restore'`).bind(customerId),
    ]);
    results[source] = writes.reduce((n, r) => n + Number(r.meta?.changes || 0), 0);
  }
  return { changes: results, gaps, ...(await testCoinHistory(db, customerId, policy)) };
}
export async function testCoinBookingPreview(db: D1Database, customerId: string, source: CoinSource, id: string, policy: TestCoinPolicy) {
  requireTestCoinPolicy(policy);
  await ensureTestCoinTables(db);
  const query = await coinSourceQuery(db, source);
  if (!query.available) throw governedJsonError({ error: "Service source unavailable" }, 409);
  const row = await db.prepare(`SELECT * FROM (${query.sql}) WHERE id=? AND customer_id=?`).bind(id, customerId).first<Row>();
  if (!row) throw governedJsonError({ error: "Your service booking was not found" }, 404);
  const entry = await db.prepare("SELECT coins,preview_discount FROM v2_test_coin_ledger WHERE source_kind=? AND source_id=? AND customer_id=? AND entry_type='redeemed'").bind(source, id, customerId).first<Row>();
  const restored = await db.prepare("SELECT id FROM v2_test_coin_ledger WHERE source_kind=? AND source_id=? AND customer_id=? AND entry_type='redemption_restore'").bind(source, id, customerId).first<Row>();
  // Reuse V1 staged payment calculation for canonical totals, including credits and split payments.
  const stage = source === "booking" ? await paymentStageAmount(db, id) : null;
  const payable = stage?.dueNow ?? Number(row.due_now || 0);
  const discount = restored ? 0 : Math.min(payable, Number(entry?.preview_discount || 0));
  return { label, source, id, serviceCode: String(row.service_code), status: String(row.status),
    bookingTotal: Number(row.total || 0), currency: String(row.currency), actualPayable: payable,
    simulatedDiscount: discount, simulatedPayable: Math.max(0, payable - discount),
    testCoinsRedeemed: restored ? 0 : -Number(entry?.coins || 0), paymentAmountUnchanged: true,
    redemptionRestored: Boolean(restored), completed: Boolean(row.completed), refunded: Boolean(row.refunded) };
}
export async function redeemTestCoins(db: D1Database, input: { customerId: string; source: CoinSource; id: string; coins: number; actorId: string }, policy: TestCoinPolicy) {
  requireTestCoinPolicy(policy);
  if (!Number.isSafeInteger(input.coins) || input.coins <= 0) throw governedJsonError({ error: "Enter a positive whole number of TEST coins" }, 400);
  await syncTestCoins(db, input.customerId, policy, input.actorId);
  const key = `test:${input.source}:redeem:${input.id}`;
  const prior = await db.prepare("SELECT coins FROM v2_test_coin_ledger WHERE idempotency_key=? AND customer_id=?").bind(key, input.customerId).first<Row>();
  if (prior) {
    if (-Number(prior.coins) !== input.coins) throw governedJsonError({ error: "TEST redemption already exists with different coins" }, 409);
    return { duplicatePrevented: true, preview: await testCoinBookingPreview(db, input.customerId, input.source, input.id, policy), ...(await testCoinHistory(db, input.customerId, policy)) };
  }
  const preview = await testCoinBookingPreview(db, input.customerId, input.source, input.id, policy);
  const value = Math.round(input.coins * policy.previewRupeesPerCoin * 100) / 100;
  if (preview.currency !== "INR" || preview.refunded || !Number.isFinite(value) || value <= 0 || value > preview.actualPayable)
    throw governedJsonError({ error: "TEST redemption exceeds the current payable or the service is closed" }, 409);
  const query = await coinSourceQuery(db, input.source);
  // V1 guarded debit pattern: live payable (including staged payments and real credits),
  // balance and owner/state are checked together in the atomic INSERT, never from the preview.
  const debitId = `test-debit:${crypto.randomUUID()}`;
  const grantPool = (clock: string) => `SELECT * FROM (${testCoinGrantRowsSql}) WHERE customer_id=? AND expires_at>${clock} AND remaining>0 AND NOT (source_kind=? AND source_id=?)`;
  const available = grantPool(testCoinSqlNow);
  const allocatedAtDecision = grantPool("(SELECT created_at FROM v2_test_coin_ledger WHERE id=?)");
  const results = await db.batch([db.prepare(`WITH s AS (${query.sql}) INSERT OR IGNORE INTO v2_test_coin_ledger
    (id,customer_id,source_kind,source_id,entry_type,coins,preview_discount,policy_json,actor_id,created_at,idempotency_key)
    SELECT ?,?,?,?,?,?,?,?,?,${testCoinSqlNow},? FROM s WHERE s.id=? AND s.customer_id=? AND s.refunded=0 AND s.status NOT IN ${closed} AND s.currency='INR' AND s.due_now>=?
    AND (${query.payableSchemaGuard || "1=1"})
    AND (${testCoinEffectiveBalanceSql("s.customer_id")})>=?
    AND (SELECT COALESCE(SUM(remaining),0) FROM (${available}))>=?`)
    .bind(debitId, input.customerId, input.source, input.id, "redeemed", -input.coins, value, JSON.stringify(policy), input.actorId, key, input.id, input.customerId, value, input.coins, input.customerId, input.source, input.id, input.coins),
    db.prepare(`WITH available AS (${allocatedAtDecision}), ordered AS (
      SELECT *,SUM(remaining) OVER (ORDER BY expires_at,created_at,grant_id ROWS UNBOUNDED PRECEDING) cumulative FROM available
    ) INSERT OR IGNORE INTO v2_test_coin_allocations (id,ledger_entry_id,grant_id,entry_type,coins)
      SELECT ?||':'||grant_id,?,grant_id,'spend',MIN(remaining,MAX(0,?-(cumulative-remaining))) FROM ordered
      WHERE ?>(cumulative-remaining) AND EXISTS (SELECT 1 FROM v2_test_coin_ledger WHERE id=?)`)
      .bind(input.customerId, debitId, input.source, input.id, debitId, debitId, input.coins, input.coins, debitId),
  ]);
  const result = results[0];
  if (!Number(result.meta?.changes || 0)) {
    const retry = await db.prepare("SELECT coins FROM v2_test_coin_ledger WHERE idempotency_key=? AND customer_id=?").bind(key, input.customerId).first<Row>();
    if (!retry || -Number(retry.coins) !== input.coins) throw governedJsonError({ error: "TEST balance or booking changed; refresh and try again" }, 409);
  }
  return { duplicatePrevented: !Number(result.meta?.changes || 0), preview: await testCoinBookingPreview(db, input.customerId, input.source, input.id, policy), ...(await testCoinHistory(db, input.customerId, policy)) };
}
