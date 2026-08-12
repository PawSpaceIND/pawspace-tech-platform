/**
 * Staff-first AI rollout gate. Layers on top of the existing fail-closed AI provider + kill-switches to
 * answer one more question: WHO is the AI allowed to talk to right now?
 *
 *   off         - AI answers nobody (default). Every message goes to a human.
 *   staff_only  - AI answers internal staff (assisted preview) but customers still get a human handoff.
 *   customers   - AI answers customers too (full rollout).
 *
 * This is the safe on-ramp: turn the AI on for your own team first, watch it in staging, and only widen
 * to customers when you're satisfied. It never overrides a stricter control - if the provider isn't
 * connected or a kill-switch is thrown, the AI stays off regardless of the rollout stage. Cold-DB safe.
 */

type Db = D1Database;
type Row = Record<string, unknown>;
export type RolloutStage = "off" | "staff_only" | "customers";
export type Audience = "staff" | "customer";
export const ROLLOUT_STAGES: RolloutStage[] = ["off", "staff_only", "customers"];
const text = (v: unknown) => String(v ?? "").trim();

export async function ensureAiAudienceRolloutTables(db: Db) {
  await db.prepare("CREATE TABLE IF NOT EXISTS ai_audience_rollout (id INTEGER PRIMARY KEY CHECK(id=1),stage TEXT NOT NULL DEFAULT 'off',reason TEXT,updated_by TEXT NOT NULL,updated_at INTEGER NOT NULL)").run();
}

/** Current rollout stage (defaults to 'off' when never configured). Cold-DB safe. */
export async function getAiRolloutStage(db: Db): Promise<RolloutStage> {
  await ensureAiAudienceRolloutTables(db).catch(() => {});
  const row = await db.prepare("SELECT stage FROM ai_audience_rollout WHERE id=1").first<Row>().catch(() => null);
  const stage = text(row?.stage) as RolloutStage;
  return ROLLOUT_STAGES.includes(stage) ? stage : "off";
}

/** Set the rollout stage (permission-gated at the route). Records who changed it and why. */
export async function setAiRolloutStage(db: Db, input: { stage: RolloutStage; reason?: string; actorEmail: string }) {
  await ensureAiAudienceRolloutTables(db);
  if (!ROLLOUT_STAGES.includes(input.stage)) throw new Error("Unsupported AI rollout stage (use off | staff_only | customers)");
  const now = Date.now();
  await db.prepare("INSERT INTO ai_audience_rollout (id,stage,reason,updated_by,updated_at) VALUES (1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET stage=excluded.stage,reason=excluded.reason,updated_by=excluded.updated_by,updated_at=excluded.updated_at").bind(input.stage, text(input.reason) || null, input.actorEmail, now).run();
  return { stage: input.stage, updatedBy: input.actorEmail, updatedAt: now };
}

/** Is the AI allowed to answer this audience at the current stage? Advisory gate - the caller still
 * respects the provider-connected + kill-switch checks separately. */
export async function resolveAiAudienceGate(db: Db, input: { audience: Audience }): Promise<{ allowed: boolean; stage: RolloutStage; reason: string }> {
  const stage = await getAiRolloutStage(db);
  const allowed = stage === "customers" || (stage === "staff_only" && input.audience === "staff");
  const reason = allowed ? `AI enabled for ${input.audience} at stage '${stage}'` : stage === "off" ? "AI rollout is off - all conversations go to a human" : `AI is in '${stage}' rollout - ${input.audience} conversations still go to a human`;
  return { allowed, stage, reason };
}

export async function aiRolloutSnapshot(db: Db) {
  await ensureAiAudienceRolloutTables(db);
  const row = await db.prepare("SELECT stage,reason,updated_by,updated_at FROM ai_audience_rollout WHERE id=1").first<Row>().catch(() => null);
  const stage = (ROLLOUT_STAGES.includes(text(row?.stage) as RolloutStage) ? text(row?.stage) : "off") as RolloutStage;
  return { stage, reason: row?.reason ? text(row.reason) : null, updatedBy: row?.updated_by ? text(row.updated_by) : null, updatedAt: row?.updated_at ? Number(row.updated_at) : null, stages: ROLLOUT_STAGES, staffEnabled: stage !== "off", customersEnabled: stage === "customers" };
}
