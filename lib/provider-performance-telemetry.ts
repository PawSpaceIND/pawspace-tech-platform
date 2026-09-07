type Db=D1Database;
type PerformanceInput={providerId:string;groupId?:string;bookingId?:string;eventType:string;impactScore:number;detail?:unknown;createdAt?:number;attemptNo?:number};

const clean=(value:string|undefined)=>String(value??"").trim();
const attempt=(value:number|undefined)=>Number.isFinite(value)?String(value):"";
const eventId=(input:PerformanceInput)=>`PPE:${clean(input.providerId)}:${clean(input.groupId)}:${clean(input.bookingId)}:${clean(input.eventType)}:${attempt(input.attemptNo)}`;

/** Ensure retry-safe provider telemetry. Existing duplicate historical rows are left untouched. */
export async function ensureProviderPerformanceTelemetry(db:Db){
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS provider_performance_events (id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,group_id TEXT,booking_id TEXT,event_type TEXT NOT NULL,impact_score INTEGER NOT NULL DEFAULT 0,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_provider_performance_lookup ON provider_performance_events(provider_id,event_type,created_at)"),
  ]);
}

/**
 * Returns a statement suitable for the SAME D1 batch as the lifecycle mutation it describes.
 * The deterministic primary key makes a retried lifecycle request idempotent without losing the
 * first recorded event. Assignment attempt is part of the key when supplied so later legitimate
 * attempts for the same booking/event type remain independently observable.
 */
export function providerPerformanceStatement(db:Db,input:PerformanceInput){
  return db.prepare("INSERT OR IGNORE INTO provider_performance_events (id,provider_id,group_id,booking_id,event_type,impact_score,detail_json,created_at) VALUES (?,?,?,?,?,?,?,?)")
    .bind(eventId(input),clean(input.providerId),clean(input.groupId)||null,clean(input.bookingId)||null,clean(input.eventType),input.impactScore,JSON.stringify(input.detail??{}),input.createdAt??Date.now());
}

export async function recordProviderPerformanceIdempotent(db:Db,input:PerformanceInput){
  await ensureProviderPerformanceTelemetry(db);
  await providerPerformanceStatement(db,input).run();
}
