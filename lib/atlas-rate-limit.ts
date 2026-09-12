type AtlasRateLimitInput = {
  agentCode: string;
  toolCode: string;
  env?: Record<string, unknown>;
};

type Row = Record<string, unknown>;
const rateReady = new WeakSet<object>();

async function ensureAtlasRateLimitTable(db: D1Database) {
  if (rateReady.has(db as object)) return;
  await db.prepare("CREATE TABLE IF NOT EXISTS atlas_tool_rate_limits (bucket_key TEXT PRIMARY KEY,window_start INTEGER NOT NULL,request_count INTEGER NOT NULL,updated_at INTEGER NOT NULL)").run();
  rateReady.add(db as object);
}

function rateLimitValue(env: Record<string, unknown>, key: string, fallback: number) {
  const value = Math.trunc(Number(env[key]));
  return Number.isFinite(value) && value > 0 ? Math.min(value, 10000) : fallback;
}

export async function enforceAtlasToolRateLimit(db: D1Database, input: AtlasRateLimitInput) {
  await ensureAtlasRateLimitTable(db);
  const env = input.env || {};
  const now = Date.now();
  const windowMs = 60_000;
  const cutoff = now - windowMs;
  const buckets = [
    { key: `agent:${input.agentCode}`, limit: rateLimitValue(env, "ATLAS_AGENT_RATE_LIMIT_PER_MINUTE", 60) },
    { key: `tool:${input.agentCode}:${input.toolCode}`, limit: rateLimitValue(env, "ATLAS_TOOL_RATE_LIMIT_PER_MINUTE", 30) },
  ];
  for (const bucket of buckets) {
    await db.prepare("INSERT INTO atlas_tool_rate_limits(bucket_key,window_start,request_count,updated_at) VALUES (?,?,1,?) ON CONFLICT(bucket_key) DO UPDATE SET request_count=CASE WHEN atlas_tool_rate_limits.window_start<? THEN 1 ELSE atlas_tool_rate_limits.request_count+1 END,window_start=CASE WHEN atlas_tool_rate_limits.window_start<? THEN excluded.window_start ELSE atlas_tool_rate_limits.window_start END,updated_at=excluded.updated_at").bind(bucket.key, now, now, cutoff, cutoff).run();
    const row = await db.prepare("SELECT window_start,request_count FROM atlas_tool_rate_limits WHERE bucket_key=?").bind(bucket.key).first<Row>();
    if (Number(row?.request_count || 0) > bucket.limit) {
      const retry = Math.max(1, Math.ceil((Number(row?.window_start || now) + windowMs - now) / 1000));
      throw new Response("Atlas tool rate limit exceeded", { status: 429, headers: { "retry-after": String(retry) } });
    }
  }
}
