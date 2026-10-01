import {assertGroomingRevisionInstallation,groomingInstallationPredicate} from "./grooming-revision-installation";
/** Read/guard adapter over conversation/handoff tables plus the review-candidate durable revision. No DDL or enrollment.
 * Call only after canonical Grooming scope + actor authorization are resolved by the caller.
 * No production caller is wired yet. This is ownership-only, not the full effective mode gate. */
export type PersistedOwnershipLease = Readonly<{
  threadId: string; customerId: string; assignedTo: string; ownershipRevision: number;
  installationEpoch: number; installationIncarnation: string;
  owner: "ai" | "employee"; activeHandoffId: string | null;
}>;
type Row = Record<string, unknown>;
const revisionRead = `(SELECT revision FROM conversation_ownership_revisions r WHERE r.thread_id=t.id)`;

export async function readPersistedGroomingOwnershipLease(db: D1Database,
  input: { threadId: string; customerId: string; actor: "ai" | "employee"; employeeEmail?: string }
): Promise<PersistedOwnershipLease> {
  await assertGroomingRevisionInstallation(db);
  // One SQL snapshot. Do not swallow missing-table errors or silently create schema here.
  const row = await db.prepare(`SELECT t.id,t.customer_id,t.status,t.assigned_to,
    ${revisionRead} ownership_revision,
    (SELECT epoch FROM grooming_revision_installation_epoch WHERE id=1) installation_epoch,
    (SELECT incarnation FROM grooming_revision_installation_epoch WHERE id=1) installation_incarnation,h.id handoff_id,h.status handoff_status,h.taken_over_by
    FROM communication_threads t LEFT JOIN ai_handoffs h ON h.thread_id=t.id
    AND h.status IN ('queued','staff_active') WHERE t.id=?`).bind(input.threadId).first<Row>();
  if (!row || row.customer_id !== input.customerId) throw new Response("Conversation scope mismatch", { status: 403 });
  const ownershipRevision = Number(row.ownership_revision);
  if (!Number.isSafeInteger(ownershipRevision) || ownershipRevision < 1) {
    throw new Response("Durable ownership revision unavailable", { status: 409 });
  }
  const installationEpoch=Number(row.installation_epoch),installationIncarnation=String(row.installation_incarnation??"");
  if(!Number.isSafeInteger(installationEpoch)||installationEpoch<1||installationIncarnation.length<32)
    throw new Response("Installation authority unavailable",{status:409});
  const assignedTo = String(row.assigned_to ?? ""), activeHandoffId = row.handoff_id ? String(row.handoff_id) : null;
  if (row.status !== "open") throw new Response("Conversation is closed", { status: 409 });
  if (input.actor === "ai") {
    if (activeHandoffId || (assignedTo && assignedTo !== "ai-orchestrator")) {
      throw new Response("Conversation is owned by staff", { status: 409 });
    }
  } else if (!input.employeeEmail || assignedTo !== input.employeeEmail ||
      row.handoff_status !== "staff_active" || row.taken_over_by !== input.employeeEmail) {
    throw new Response("Employee must explicitly take over this conversation", { status: 409 });
  }
  return Object.freeze({ threadId: input.threadId, customerId: input.customerId, assignedTo,
    ownershipRevision, installationEpoch, installationIncarnation, owner: input.actor, activeHandoffId });
}

/** Prepend this assertion to the SAME D1 batch as canonical writes/outbox claim.
 * SQLite integer overflow intentionally aborts and rolls back the ENTIRE batch on a
 * lost lease. This does not wrap asynchronous route calls or external provider sends.
 * Canonical scope, role, consent, terms + full control-revision guards are still required.
 * Revision rows must never be reset/deleted; database triggers cover every ownership/status writer. */
export function persistedOwnershipBatchGuard(db: D1Database, lease: PersistedOwnershipLease): D1PreparedStatement {
  const ownerPredicate = lease.owner === "ai"
    ? `NOT EXISTS (SELECT 1 FROM ai_handoffs h WHERE h.thread_id=t.id AND h.status IN ('queued','staff_active'))`
    : `EXISTS (SELECT 1 FROM ai_handoffs h WHERE h.thread_id=t.id AND h.id=?
        AND h.status='staff_active' AND h.taken_over_by=?)`;
  const sql = `SELECT CASE WHEN EXISTS (SELECT 1 FROM communication_threads t
    WHERE t.id=? AND t.customer_id=? AND t.status='open' AND COALESCE(t.assigned_to,'')=?
    AND ${revisionRead}=? AND EXISTS(SELECT 1 FROM grooming_revision_installation_epoch WHERE id=1 AND epoch=? AND incarnation=?) AND ${ownerPredicate} AND (${groomingInstallationPredicate})) THEN 1 ELSE abs(-9223372036854775808) END AS ownership_guard`;
  const bindings: Array<string | number> = [lease.threadId, lease.customerId, lease.assignedTo, lease.ownershipRevision,lease.installationEpoch,lease.installationIncarnation];
  if (lease.owner === "employee") bindings.push(lease.activeHandoffId ?? "", lease.assignedTo);
  return db.prepare(sql).bind(...bindings);
}

/** Generation boundary only; callers must separately recheck existing effective AI controls.
 * Committing a tool/send still requires the atomic batch guard, never this preflight alone. */
export async function generateWithPersistedOwnershipLease<T>(db: D1Database,
  lease: PersistedOwnershipLease, generate: () => Promise<T>): Promise<T> {
  const recheck = async () => {
    const current = await readPersistedGroomingOwnershipLease(db, { threadId: lease.threadId,
      customerId: lease.customerId, actor: lease.owner, employeeEmail: lease.assignedTo });
    if (current.ownershipRevision !== lease.ownershipRevision || current.assignedTo !== lease.assignedTo ||
        current.activeHandoffId !== lease.activeHandoffId || current.installationEpoch!==lease.installationEpoch ||
        current.installationIncarnation!==lease.installationIncarnation) {
      throw new Response("Ownership changed; discard stale generation", { status: 409 });
    }
  };
  await recheck();
  const result = await generate();
  await recheck();
  return result;
}
