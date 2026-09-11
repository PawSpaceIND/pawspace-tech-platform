type Db = D1Database;

export type HumanEscalationKind =
  | "safety_injury"
  | "financial_batch_threshold"
  | "prolonged_gateway_outage"
  | "provider_capacity_exhausted";

export type HumanEscalationSignal = {
  kind: HumanEscalationKind;
  summary: string;
  sourceAgent: string;
  bookingId?: string | null;
  cityId?: string | null;
  zoneId?: string | null;
  amountMinor?: number | null;
  outageMinutes?: number | null;
  metadata?: Record<string, unknown>;
};

export function requiresHumanEscalation(signal: HumanEscalationSignal) {
  return (
    signal.kind === "safety_injury" ||
    signal.kind === "financial_batch_threshold" ||
    signal.kind === "prolonged_gateway_outage" ||
    signal.kind === "provider_capacity_exhausted"
  );
}

export async function ensureHumanEscalationTables(db: Db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS ai_human_escalations (id TEXT PRIMARY KEY,kind TEXT NOT NULL,source_agent TEXT NOT NULL,summary TEXT NOT NULL,booking_id TEXT,city_id TEXT,zone_id TEXT,metadata_json TEXT NOT NULL DEFAULT '{}',status TEXT NOT NULL DEFAULT 'open',created_at INTEGER NOT NULL,resolved_at INTEGER,resolved_by TEXT)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_ai_human_escalations_open ON ai_human_escalations(status,created_at)"),
  ]);
}

export async function routeHumanEscalation(db: Db, signal: HumanEscalationSignal) {
  if (!requiresHumanEscalation(signal)) return { escalated: false as const };
  await ensureHumanEscalationTables(db);
  const id = `AIES-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
  const metadata = { ...(signal.metadata || {}), amountMinor: signal.amountMinor ?? null, outageMinutes: signal.outageMinutes ?? null };
  await db.prepare("INSERT INTO ai_human_escalations (id,kind,source_agent,summary,booking_id,city_id,zone_id,metadata_json,status,created_at) VALUES (?,?,?,?,?,?,?,?, 'open',?)")
    .bind(id, signal.kind, signal.sourceAgent, signal.summary, signal.bookingId ?? null, signal.cityId ?? null, signal.zoneId ?? null, JSON.stringify(metadata), Date.now()).run();
  return { escalated: true as const, escalationId: id, executionHalted: true as const };
}
