type Db = D1Database;
type Row = Record<string, unknown>;

const schemaReady = new WeakMap<object, Promise<void>>();
const text = (value: unknown) => String(value ?? "").trim();

async function ensureWebhookInboxLeaseSchemaUncached(db: Db) {
  const info = await db.prepare("PRAGMA table_info(gateway_webhook_events)").all<Row>();
  if (!info.results.length) throw new Error("gateway_webhook_events must exist before webhook lease recovery is initialised");
  const columns = new Set(info.results.map((row) => text(row.name)));
  for (const [column, ddl] of [
    ["processing_claim_token", "ALTER TABLE gateway_webhook_events ADD COLUMN processing_claim_token TEXT"],
    ["processing_lease_expires_at", "ALTER TABLE gateway_webhook_events ADD COLUMN processing_lease_expires_at INTEGER"],
  ] as const) {
    if (columns.has(column)) continue;
    try {
      await db.prepare(ddl).run();
    } catch (error) {
      const refreshed = await db.prepare("PRAGMA table_info(gateway_webhook_events)").all<Row>();
      if (!refreshed.results.some((row) => text(row.name) === column)) throw error;
    }
  }
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_gateway_webhook_processing_lease ON gateway_webhook_events(processing_status,processing_lease_expires_at)").run();
}

export async function ensureWebhookInboxLeaseSchema(db: Db) {
  const key = db as unknown as object;
  const existing = schemaReady.get(key);
  if (existing) return existing;
  const pending = ensureWebhookInboxLeaseSchemaUncached(db).catch((error) => {
    schemaReady.delete(key);
    throw error;
  });
  schemaReady.set(key, pending);
  return pending;
}

export type WebhookInboxClaim = {
  claimed: boolean;
  claimToken: string | null;
  recovered: boolean;
  currentStatus: string;
  leaseExpiresAt: number | null;
};

/**
 * D1/SQLite recovery boundary for one immutable gateway webhook inbox row.
 *
 * There is no SELECT ... FOR UPDATE in D1. Ownership is therefore a compare-and-set on the inbox row:
 * a normal RECEIVED/DEFERRED/FAILED row, or a PROCESSING row whose lease expired, is moved to PROCESSING
 * and stamped with a unique claim token. The token is the fencing value used by the terminal update,
 * so a worker that wakes up after its lease was stolen cannot mark the newer worker's row complete.
 */
export async function claimWebhookInbox(db: Db, input: { inboxId: string; eventType: string; now?: number; leaseMs?: number }): Promise<WebhookInboxClaim> {
  await ensureWebhookInboxLeaseSchema(db);
  const now = input.now ?? Date.now();
  const leaseMs = Math.max(5_000, Math.min(input.leaseMs ?? 60_000, 120_000));
  const normalToken = `N:${crypto.randomUUID()}`;
  const recoveryToken = `R:${crypto.randomUUID()}`;
  const leaseExpiresAt = now + leaseMs;
  const updated = await db.prepare(`UPDATE gateway_webhook_events
    SET processing_status='PROCESSING',event_type=?,failure_reason=NULL,processed_at=NULL,
        processing_claim_token=CASE WHEN processing_status IN ('FAILED','PROCESSING') THEN ? ELSE ? END,
        processing_lease_expires_at=?
    WHERE id=? AND (
      processing_status IN ('RECEIVED','DEFERRED','FAILED')
      OR (processing_status='PROCESSING' AND (processing_lease_expires_at IS NULL OR processing_lease_expires_at<=?))
    )`)
    .bind(input.eventType, recoveryToken, normalToken, leaseExpiresAt, input.inboxId, now).run();

  const current = await db.prepare("SELECT processing_status,processing_claim_token,processing_lease_expires_at FROM gateway_webhook_events WHERE id=?").bind(input.inboxId).first<Row>();
  const token = text(current?.processing_claim_token);
  const ownsClaim = Number(updated.meta?.changes || 0) === 1 && (token === normalToken || token === recoveryToken);
  return {
    claimed: ownsClaim,
    claimToken: ownsClaim ? token : null,
    recovered: ownsClaim && token === recoveryToken,
    currentStatus: text(current?.processing_status),
    leaseExpiresAt: current?.processing_lease_expires_at == null ? null : Number(current.processing_lease_expires_at),
  };
}

export async function markWebhookInbox(db: Db, input: {
  inboxId: string;
  claimToken: string;
  status: "PROCESSED" | "DEFERRED" | "REJECTED" | "FAILED";
  eventType?: string;
  reason?: string;
  now?: number;
}) {
  await ensureWebhookInboxLeaseSchema(db);
  const now = input.now ?? Date.now();
  const terminal = input.status !== "DEFERRED";
  const result = await db.prepare(`UPDATE gateway_webhook_events
    SET processing_status=?,event_type=COALESCE(?,event_type),failure_reason=?,processed_at=?,
        processing_claim_token=NULL,processing_lease_expires_at=NULL
    WHERE id=? AND processing_status='PROCESSING' AND processing_claim_token=?`)
    .bind(input.status, input.eventType || null, input.reason || null, terminal ? now : null, input.inboxId, input.claimToken).run();
  return { marked: Number(result.meta?.changes || 0) === 1 };
}

/** Pre-processing validation rejection. This never steals an active PROCESSING claim. */
export async function rejectUnclaimedWebhookInbox(db: Db, input: { inboxId: string; eventType?: string; reason: string; now?: number }) {
  await ensureWebhookInboxLeaseSchema(db);
  const now = input.now ?? Date.now();
  const result = await db.prepare(`UPDATE gateway_webhook_events
    SET processing_status='REJECTED',event_type=COALESCE(?,event_type),failure_reason=?,processed_at=?,
        processing_claim_token=NULL,processing_lease_expires_at=NULL
    WHERE id=? AND processing_status IN ('RECEIVED','DEFERRED','FAILED','REJECTED')
      AND processing_claim_token IS NULL`)
    .bind(input.eventType || null, input.reason, now, input.inboxId).run();
  return { marked: Number(result.meta?.changes || 0) === 1 };
}
