/**
 * Risk & anomaly detection over the money-moving flows (PawSpace Wallet + public-review rewards).
 *
 * This is the fraud/abuse guard for the value we hand out: store credit and review coupons. It scores
 * each customer on transparent, auditable signals computed from their OWN ledger/claim history and
 * raises a staff-reviewed risk_flag when the score crosses a threshold. It NEVER blocks money or
 * claws anything back on its own - consistent with the platform's AI/automation governance (flag +
 * human decision only; refunds/payments/payouts remain forbidden autonomous actions). Staff clear or
 * action each flag. Rules-based today (no external provider needed); an LLM rationale can be layered
 * on later via ai-provider-adapter without changing the detection or the review workflow.
 */

type Db = D1Database;
type Row = Record<string, unknown>;

const uid = (p: string) => `${p}-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
const DAY = 86_400_000;
const WINDOW_DAYS = 30;
const FAST_CYCLE_MS = 30 * 60 * 1000; // a credit followed by a redeem within 30 min looks like cycling
const empty = () => ({ results: [] as Row[] });
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const round2 = (n: number) => Math.round(n * 100) / 100;
const levelOf = (score: number) => (score >= 0.7 ? "high" : score >= 0.4 ? "medium" : "low");
const DOMAINS = ["review_rewards", "wallet"] as const;

export async function ensureRiskTables(db: Db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS risk_flags (id TEXT PRIMARY KEY,domain TEXT NOT NULL,subject_type TEXT NOT NULL,subject_id TEXT NOT NULL,customer_id TEXT,risk_level TEXT NOT NULL,score REAL NOT NULL,signals_json TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open',reviewed_by TEXT,review_note TEXT,reviewed_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(domain,subject_id))"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_risk_flags_status ON risk_flags(status,domain,updated_at)"),
  ]);
}

type Scored = { customerId: string; score: number; signals: Record<string, number> };

/** Score review-reward abuse per customer over the trailing window. */
async function scoreReviewRewards(db: Db, since: number): Promise<Scored[]> {
  // claims, and how many were on bookings the customer never actually 5-star reviewed through our flow
  const claims = await db.prepare("SELECT pc.customer_id cust,COUNT(*) claims,SUM(CASE WHEN sr.id IS NULL THEN 1 ELSE 0 END) claims_without_review FROM review_public_claims pc LEFT JOIN service_reviews sr ON sr.booking_id=pc.booking_id AND sr.customer_id=pc.customer_id AND sr.stars=5 WHERE pc.created_at>=? GROUP BY pc.customer_id").bind(since).all<Row>().catch(empty);
  const doubles = await db.prepare("SELECT customer_id cust,COUNT(*) double_orders FROM (SELECT customer_id,booking_id FROM review_public_claims WHERE created_at>=? GROUP BY customer_id,booking_id HAVING COUNT(*)>=2) GROUP BY customer_id").bind(since).all<Row>().catch(empty);
  const value = await db.prepare("SELECT customer_id cust,COALESCE(SUM(discount_amount),0) issued FROM review_reward_codes WHERE created_at>=? GROUP BY customer_id").bind(since).all<Row>().catch(empty);
  const dbl = new Map(doubles.results.map(r => [String(r.cust), Number(r.double_orders)]));
  const val = new Map(value.results.map(r => [String(r.cust), Number(r.issued)]));
  return claims.results.map(r => {
    const cust = String(r.cust), n = Number(r.claims), noReview = Number(r.claims_without_review), doubleOrders = dbl.get(cust) || 0, issued = val.get(cust) || 0;
    const score = clamp01(
      clamp01(noReview / 3) * 0.5 +      // claiming a reward without a real 5-star review is the strongest signal
      clamp01(n / 6) * 0.2 +             // sheer claim velocity
      clamp01(doubleOrders / 3) * 0.2 +  // systematically farming the both-platform Rs.400
      clamp01(issued / 2000) * 0.1       // outstanding reward value concentration
    );
    return { customerId: cust, score: round2(score), signals: { claims: n, claimsWithoutReview: noReview, doubleClaimOrders: doubleOrders, rewardValueIssued: round2(issued) } };
  });
}

/** Score wallet abuse per customer over the trailing window. */
async function scoreWallet(db: Db, since: number): Promise<Scored[]> {
  const agg = await db.prepare("SELECT customer_id cust,SUM(CASE WHEN entry_type='credit' THEN 1 ELSE 0 END) credits,SUM(CASE WHEN entry_type='credit' THEN amount ELSE 0 END) credit_amt,SUM(CASE WHEN entry_type='credit' AND source_type='goodwill' THEN amount ELSE 0 END) goodwill_amt,SUM(CASE WHEN entry_type='redeem' THEN 1 ELSE 0 END) redeems FROM pawspace_wallet_ledger WHERE created_at>=? GROUP BY customer_id").bind(since).all<Row>().catch(empty);
  const cycles = await db.prepare("SELECT r.customer_id cust,COUNT(*) fast_cycles FROM pawspace_wallet_ledger r WHERE r.entry_type='redeem' AND r.created_at>=? AND EXISTS (SELECT 1 FROM pawspace_wallet_ledger c WHERE c.customer_id=r.customer_id AND c.entry_type='credit' AND c.created_at<=r.created_at AND c.created_at>=r.created_at-?) GROUP BY r.customer_id").bind(since, FAST_CYCLE_MS).all<Row>().catch(empty);
  const fast = new Map(cycles.results.map(r => [String(r.cust), Number(r.fast_cycles)]));
  return agg.results.map(r => {
    const cust = String(r.cust), credits = Number(r.credits), creditAmt = Number(r.credit_amt), goodwill = Number(r.goodwill_amt), redeems = Number(r.redeems), fastCycles = fast.get(cust) || 0;
    const score = clamp01(
      clamp01(fastCycles / 3) * 0.5 +    // rapid credit->redeem cycling
      clamp01(goodwill / 2000) * 0.3 +   // discretionary goodwill concentration (abuse or a rogue granter)
      clamp01(redeems / 5) * 0.2         // redemption velocity
    );
    return { customerId: cust, score: round2(score), signals: { credits, creditAmount: round2(creditAmt), goodwillAmount: round2(goodwill), redeems, fastCycles } };
  });
}

async function upsertFlags(db: Db, domain: string, scored: Scored[]) {
  const existing = await db.prepare("SELECT subject_id,status,score FROM risk_flags WHERE domain=?").bind(domain).all<Row>().catch(empty);
  const prior = new Map(existing.results.map(r => [String(r.subject_id), { status: String(r.status), score: Number(r.score) }]));
  const now = Date.now();
  let openCount = 0;
  const stmts: unknown[] = [];
  for (const s of scored) {
    const was = prior.get(s.customerId);
    const level = levelOf(s.score);
    if (!was) {
      if (s.score < 0.4) continue; // only raise a flag once it is at least medium risk
      stmts.push(db.prepare("INSERT INTO risk_flags (id,domain,subject_type,subject_id,customer_id,risk_level,score,signals_json,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,'open',?,?)").bind(uid("RISK"), domain, "customer", s.customerId, s.customerId, level, s.score, JSON.stringify(s.signals), now, now));
      openCount++;
    } else {
      // refresh metrics on the existing flag; re-open a resolved one only if risk clearly worsened to high
      const reopen = (was.status === "cleared" || was.status === "actioned") && level === "high" && s.score > was.score + 0.1;
      const status = reopen ? "open" : was.status;
      stmts.push(db.prepare("UPDATE risk_flags SET risk_level=?,score=?,signals_json=?,status=?,updated_at=?" + (reopen ? ",reviewed_by=NULL,review_note=NULL,reviewed_at=NULL" : "") + " WHERE domain=? AND subject_id=?").bind(level, s.score, JSON.stringify(s.signals), status, now, domain, s.customerId));
      if (status === "open") openCount++;
    }
  }
  if (stmts.length) await db.batch(stmts as Parameters<typeof db.batch>[0]);
  return openCount;
}

/** Background sweep: rescore both money domains and refresh risk flags. Cold-DB safe. */
export async function runRiskAnomalySweep(db: Db, input: { asOf?: number } = {}) {
  await ensureRiskTables(db);
  const since = (input.asOf ?? Date.now()) - WINDOW_DAYS * DAY;
  const reviewOpen = await upsertFlags(db, "review_rewards", await scoreReviewRewards(db, since));
  const walletOpen = await upsertFlags(db, "wallet", await scoreWallet(db, since));
  return { sweep: "risk_anomaly", windowDays: WINDOW_DAYS, reviewRewardsFlagsOpen: reviewOpen, walletFlagsOpen: walletOpen };
}

export async function listRiskFlags(db: Db, input: { domain?: string; status?: string; limit?: number } = {}) {
  await ensureRiskTables(db);
  const clauses: string[] = ["1=1"], binds: unknown[] = [];
  if (input.domain && DOMAINS.includes(input.domain as typeof DOMAINS[number])) { clauses.push("domain=?"); binds.push(input.domain); }
  if (input.status) { clauses.push("status=?"); binds.push(input.status); }
  const limit = Math.max(1, Math.min(Number(input.limit) || 100, 200));
  const rows = await db.prepare(`SELECT id,domain,subject_type,subject_id,customer_id,risk_level,score,signals_json,status,reviewed_by,review_note,reviewed_at,created_at,updated_at FROM risk_flags WHERE ${clauses.join(" AND ")} ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END,score DESC,updated_at DESC LIMIT ${limit}`).bind(...binds).all<Row>();
  return rows.results.map((r: Row) => ({ id: String(r.id), domain: String(r.domain), subjectType: String(r.subject_type), subjectId: String(r.subject_id), customerId: r.customer_id ? String(r.customer_id) : null, riskLevel: String(r.risk_level), score: Number(r.score), signals: JSON.parse(String(r.signals_json || "{}")), status: String(r.status), reviewedBy: r.reviewed_by ? String(r.reviewed_by) : null, reviewNote: r.review_note ? String(r.review_note) : null, reviewedAt: r.reviewed_at ? Number(r.reviewed_at) : null, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at) }));
}

/** Staff decision on a flag: 'cleared' (false positive / acceptable) or 'actioned' (abuse handled elsewhere). */
export async function reviewRiskFlag(db: Db, input: { id: string; decision: "cleared" | "actioned"; note: string; actor: string }) {
  await ensureRiskTables(db);
  if (!["cleared", "actioned"].includes(input.decision)) throw new Error("Decision must be 'cleared' or 'actioned'");
  if (!String(input.note || "").trim() || input.note.trim().length < 5) throw new Error("A review note is required");
  const flag = await db.prepare("SELECT id,status FROM risk_flags WHERE id=?").bind(input.id).first<Row>();
  if (!flag) throw new Error("Risk flag not found");
  if (String(flag.status) !== "open") throw new Error("This risk flag has already been reviewed");
  await db.prepare("UPDATE risk_flags SET status=?,reviewed_by=?,review_note=?,reviewed_at=?,updated_at=? WHERE id=?").bind(input.decision, input.actor, input.note.trim(), Date.now(), Date.now(), input.id).run();
  return { id: input.id, status: input.decision, reviewedBy: input.actor };
}

export async function riskFlagsSummary(db: Db) {
  await ensureRiskTables(db);
  const rows = await db.prepare("SELECT domain,risk_level,COUNT(*) c FROM risk_flags WHERE status='open' GROUP BY domain,risk_level").all<Row>().catch(empty);
  const open = rows.results.reduce((s, r) => s + Number(r.c), 0);
  return { openFlags: open, byDomainLevel: rows.results.map((r: Row) => ({ domain: String(r.domain), riskLevel: String(r.risk_level), count: Number(r.c) })) };
}
