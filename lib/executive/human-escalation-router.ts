type Db = D1Database;

export type HumanEscalationKind =
  | "safety_injury"
  | "financial_batch_threshold"
  | "prolonged_gateway_outage"
  | "provider_capacity_exhausted"
  | "ai_runtime_disabled";

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
    signal.kind === "provider_capacity_exhausted" ||
    signal.kind === "ai_runtime_disabled"
  );
}

function signalKey(signal:HumanEscalationSignal){
  return [
    signal.kind,
    signal.sourceAgent,
    signal.bookingId??"",
    signal.cityId??"",
    signal.zoneId??"",
    signal.summary.trim().toLowerCase(),
  ].join("|");
}

export async function ensureHumanEscalationTables(db: Db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS ai_human_escalations (id TEXT PRIMARY KEY,signal_key TEXT,kind TEXT NOT NULL,source_agent TEXT NOT NULL,summary TEXT NOT NULL,booking_id TEXT,city_id TEXT,zone_id TEXT,metadata_json TEXT NOT NULL DEFAULT '{}',status TEXT NOT NULL DEFAULT 'open',created_at INTEGER NOT NULL,resolved_at INTEGER,resolved_by TEXT)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_ai_human_escalations_open ON ai_human_escalations(status,created_at)"),
  ]);
  try{await db.prepare("ALTER TABLE ai_human_escalations ADD COLUMN signal_key TEXT").run()}catch(error){if(!/duplicate column|already exists/i.test(error instanceof Error?error.message:String(error)))throw error}
  await db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_human_escalations_open_signal ON ai_human_escalations(signal_key) WHERE status='open' AND signal_key IS NOT NULL").run();
}

export async function routeHumanEscalation(db: Db, signal: HumanEscalationSignal) {
  if (!requiresHumanEscalation(signal)) return { escalated: false as const };
  await ensureHumanEscalationTables(db);
  const id = `AIES-${crypto.randomUUID().slice(0, 12).toUpperCase()}`,key=signalKey(signal);
  const metadata = { ...(signal.metadata || {}), amountMinor: signal.amountMinor ?? null, outageMinutes: signal.outageMinutes ?? null };
  const inserted=await db.prepare("INSERT OR IGNORE INTO ai_human_escalations (id,signal_key,kind,source_agent,summary,booking_id,city_id,zone_id,metadata_json,status,created_at) VALUES (?,?,?,?,?,?,?,?,?, 'open',?)")
    .bind(id,key,signal.kind,signal.sourceAgent,signal.summary,signal.bookingId ?? null,signal.cityId ?? null,signal.zoneId ?? null,JSON.stringify(metadata),Date.now()).run();
  if(Number(inserted.meta?.changes||0)===0){
    const existing=await db.prepare("SELECT id FROM ai_human_escalations WHERE signal_key=? AND status='open' ORDER BY created_at DESC LIMIT 1").bind(key).first<Record<string,unknown>>();
    return{escalated:true as const,escalationId:String(existing?.id||""),executionHalted:true as const,duplicatePrevented:true as const};
  }
  return { escalated: true as const, escalationId: id, executionHalted: true as const,duplicatePrevented:false as const };
}
