import { governedJsonError } from "./governed-http-error";
import { ensurePaymentReconciliationTables } from "./grooming-payment-reconciliation";
import { providerLifecycleGuard, type LifecycleContext, type LifecycleLease } from "./provider-lifecycle";

/** Existing Finance exceptions provide visibility and audited human acknowledgement, never money authority. */
export const GROOMING_COMPLETION_RECONCILIATION = "grooming_completion_pending_reconciliation";
export const groomingCompletionReconciliationId = (bookingId: string) => `GROOM-COMPLETION-${bookingId}`;
const pending = "status IN ('open','investigating')";
const attemptMatches = "id=? AND booking_id=? AND exception_type=? AND json_extract(detail_json,'$.attemptToken')=?";
const attemptBinds = (lease: LifecycleLease) => [groomingCompletionReconciliationId(lease.bookingId), lease.bookingId, GROOMING_COMPLETION_RECONCILIATION, lease.token];

/** Commit BEFORE finance. A crash leaves an honest 'posting unconfirmed' work item even without a catch. */
export async function prepareGroomingCompletionReconciliation(db: D1Database, lease: LifecycleLease, input: { paymentId: string | null; expectedAmount: number }) {
  await ensurePaymentReconciliationTables(db);
  const now = Date.now(), guard = providerLifecycleGuard(lease);
  const detail = JSON.stringify({
    phase: "awaiting_finance", postingConfirmed: false, priorAttemptUncertain: false, attemptToken: lease.token,
    journalGroup: `JRN-SERVICE-COMPLETION-${lease.bookingId}`, expected: input.expectedAmount,
    owner: "Finance / Operations", financialTreatment: "requires_separate_authorisation", attemptedAt: now,
  });
  const result = await db.prepare(`INSERT INTO payment_reconciliation_exceptions
    (id,booking_id,payment_id,event_id,exception_type,severity,status,detail_json,created_at)
    SELECT ?,?,?,NULL,?,'warning','open',?,? WHERE ${guard.guardSql}
      AND EXISTS(SELECT 1 FROM canonical_bookings WHERE id=? AND service_code='grooming' AND status='in_service' AND provider_id=?)
    ON CONFLICT(id) DO UPDATE SET payment_id=excluded.payment_id,
      status=CASE WHEN payment_reconciliation_exceptions.status='investigating' THEN 'investigating' ELSE 'open' END,
      detail_json=json_set(json_patch(payment_reconciliation_exceptions.detail_json,excluded.detail_json),
        '$.priorAttemptUncertain',json(CASE WHEN json_extract(payment_reconciliation_exceptions.detail_json,'$.priorAttemptUncertain')=1
          OR (payment_reconciliation_exceptions.status IN ('open','investigating')
            AND json_extract(payment_reconciliation_exceptions.detail_json,'$.attemptToken')<>json_extract(excluded.detail_json,'$.attemptToken')) THEN 'true' ELSE 'false' END),
        '$.postingConfirmed',json(CASE WHEN json_extract(payment_reconciliation_exceptions.detail_json,'$.postingConfirmed')=1 THEN 'true' ELSE 'false' END)),
      resolved_at=NULL,resolved_by=NULL
    WHERE payment_reconciliation_exceptions.booking_id=excluded.booking_id
      AND payment_reconciliation_exceptions.exception_type=excluded.exception_type
      AND (payment_reconciliation_exceptions.status IN ('open','investigating')
        OR (payment_reconciliation_exceptions.status='resolved' AND json_extract(payment_reconciliation_exceptions.detail_json,'$.phase')='not_posted'))
      AND json_extract(payment_reconciliation_exceptions.detail_json,'$.phase')<>'completed'`)
    .bind(groomingCompletionReconciliationId(lease.bookingId), lease.bookingId, input.paymentId,
      GROOMING_COMPLETION_RECONCILIATION, detail, now, ...guard.guardBinds, lease.bookingId, lease.providerId).run();
  const persisted = await db.prepare(`SELECT id FROM payment_reconciliation_exceptions WHERE ${attemptMatches} AND ${pending}`)
    .bind(...attemptBinds(lease)).first();
  if (Number(result.meta?.changes || 0) !== 1 || !persisted) throw governedJsonError({
    error: "Completion reconciliation could not be reserved. Refresh the job or ask Finance to review its completion attempt.",
    code: "completion_reconciliation_unavailable",
  }, 409);
}

/** Resolve in the SAME batch as the guarded lifecycle change; an assertion makes a missing/stale marker roll it all back. */
export function groomingCompletionReconciliationStatements(db: D1Database, ctx: LifecycleContext) {
  const now = Date.now(), { lease } = ctx, assertionId = `completion-reconciliation:${lease.token}`;
  const completed = `EXISTS(SELECT 1 FROM canonical_bookings WHERE id=? AND service_code='grooming' AND status='completed' AND provider_id=?)
    AND EXISTS(SELECT 1 FROM provider_work_orders WHERE booking_id=? AND status='completed' AND provider_id=?)`;
  const completedBinds = [lease.bookingId, lease.providerId, lease.bookingId, lease.providerId];
  return [
    db.prepare(`UPDATE payment_reconciliation_exceptions SET status='resolved',resolved_at=?,resolved_by=?,
      detail_json=json_set(detail_json,'$.phase','completed','$.postingConfirmed',json('true'),'$.completedAt',?)
      WHERE ${attemptMatches} AND ${pending} AND ${ctx.guardSql} AND ${completed}`)
      .bind(now, lease.actorId, now, ...attemptBinds(lease), ...ctx.guardBinds, ...completedBinds),
    db.prepare(`INSERT INTO provider_lifecycle_assertions(id,ok,created_at)
      SELECT ?,CASE WHEN ${ctx.guardSql} AND EXISTS(SELECT 1 FROM payment_reconciliation_exceptions
        WHERE ${attemptMatches} AND status='resolved' AND json_extract(detail_json,'$.phase')='completed') THEN 1 ELSE 0 END,?`)
      .bind(assertionId, ...ctx.guardBinds, ...attemptBinds(lease), now),
    db.prepare("DELETE FROM provider_lifecycle_assertions WHERE id=?").bind(assertionId),
  ];
}

/**
 * Only a returned/refused call can be proven not to have posted. Unknown/crashed calls stay open.
 * Check absence INSIDE the update, including absent-table guards, and hold the matching lifecycle lease.
 * A takeover cannot prove the older finance call stopped: its uncertainty prevents no-posting cleanup.
 * No journal, invoice, payout, refund, or service state is changed here. Human resolution is never overwritten.
 */
export async function recordGroomingCompletionFailure(db: D1Database, lease: LifecycleLease, stage: "finance" | "finalize") {
  const tables = new Set((await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all<{ name: string }>()).results.map(row => row.name));
  const sources = [
    { table: "finance_journal_entries", predicate: "source_type='service_completion' AND source_id=?" },
    { table: "provider_payout_computations", predicate: "booking_id=? AND finalized_at>0" },
    { table: "finance_invoices", predicate: "source_type='booking' AND source_id=?" },
  ];
  const facts = sources.map(({ table, predicate }) => tables.has(table)
    ? { sql: `NOT EXISTS(SELECT 1 FROM ${table} WHERE ${predicate})`, binds: [lease.bookingId] as unknown[] }
    : { sql: "NOT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?)", binds: [table] as unknown[] });
  const absent = facts.map(fact => fact.sql).join(" AND "), factBinds = facts.flatMap(fact => fact.binds);
  // A newly appearing table makes absence uncertain, but is not itself evidence that money posted.
  const posted = sources.filter(source => tables.has(source.table));
  const present = posted.map(({ table, predicate }) => `EXISTS(SELECT 1 FROM ${table} WHERE ${predicate})`).join(" OR ") || "0";
  const postedBinds = posted.map(() => lease.bookingId);
  const guard = providerLifecycleGuard(lease), now = Date.now();
  // If the financial call failed before posting, clear only this attempt, with transactional absence proof.
  if (stage === "finance") await db.prepare(`UPDATE payment_reconciliation_exceptions SET status='resolved',resolved_at=?,resolved_by=?,
      detail_json=json_set(detail_json,'$.phase','not_posted','$.postingConfirmed',json('false'),'$.failedStage',?,'$.checkedAt',?)
      WHERE ${attemptMatches} AND ${pending} AND ${guard.guardSql} AND (${absent})
        AND COALESCE(json_extract(detail_json,'$.priorAttemptUncertain'),0)=0`)
    .bind(now, lease.actorId, stage, now, ...attemptBinds(lease), ...guard.guardBinds, ...factBinds).run();
  // The pre-finance marker is already durable: this enrichment is not required for crash safety.
  await db.prepare(`UPDATE payment_reconciliation_exceptions SET
      detail_json=json_set(detail_json,'$.phase','review_required','$.failedStage',?,'$.checkedAt',?,
        '$.postingConfirmed',json(CASE WHEN (${present}) THEN 'true' ELSE 'false' END),
        '$.bookingStatus',(SELECT status FROM canonical_bookings WHERE id=?))
      WHERE ${attemptMatches} AND ${pending}
        AND NOT EXISTS(SELECT 1 FROM provider_lifecycle_events WHERE booking_id=? AND service_code='grooming' AND to_status='completed')`)
    .bind(stage, now, ...postedBinds, lease.bookingId, ...attemptBinds(lease), lease.bookingId).run();
}
