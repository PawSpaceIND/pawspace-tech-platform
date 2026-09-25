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

/**
 * Deployment environments where opening the AI to CUSTOMERS is approved.
 *
 * Owner decision 2026-09-22: the customer rollout is UAT-only. `stage='customers'` is therefore not a
 * standing permission that travels with the row - it is one that only exists on a UAT deployment, so a
 * staging database restored, copied or promoted to production cannot carry a customer rollout across
 * with it, and neither can a stage set by someone who did not realise where they were pointing.
 *
 * It FAILS CLOSED. An environment that does not say what it is does not get to open the AI to
 * customers, exactly as an unset payment environment does not get to take money: the safe direction is
 * a human answering, which is what the customer gets. Staff are not affected - 'staff_only' means the
 * same thing on every deployment.
 */
export const CUSTOMER_AI_UAT_ENVIRONMENTS = ["local", "preview", "staging", "uat", "e2e"];

async function customerRolloutApprovedHere(): Promise<boolean> {
  try {
    const { env } = await import("cloudflare:workers");
    return CUSTOMER_AI_UAT_ENVIRONMENTS.includes(text((env as unknown as Row).PAWSPACE_DEPLOYMENT_ENV).toLowerCase());
  } catch { return false; }
}

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
export async function resolveAiAudienceGate(db: Db, input: { audience: Audience }): Promise<{ allowed: boolean; stage: RolloutStage; effectiveStage: RolloutStage; reason: string }> {
  const stage = await getAiRolloutStage(db);
  // `stage` stays the stage that is CONFIGURED and `effectiveStage` is the one that applies here, so a
  // deployment where the customer rollout does not apply reports both rather than quietly reading back
  // a stage nobody set.
  const uatOnly = stage === "customers" && !await customerRolloutApprovedHere();
  const effectiveStage: RolloutStage = uatOnly ? "staff_only" : stage;
  const allowed = effectiveStage === "customers" || (effectiveStage === "staff_only" && input.audience === "staff");
  const reason = allowed ? `AI enabled for ${input.audience} at stage '${effectiveStage}'`
    : uatOnly ? `The customer AI rollout is approved for UAT deployments only - ${input.audience} conversations go to a human here`
    : effectiveStage === "off" ? "AI rollout is off - all conversations go to a human"
    : `AI is in '${effectiveStage}' rollout - ${input.audience} conversations still go to a human`;
  return { allowed, stage, effectiveStage, reason };
}

export async function aiRolloutSnapshot(db: Db) {
  await ensureAiAudienceRolloutTables(db);
  const row = await db.prepare("SELECT stage,reason,updated_by,updated_at FROM ai_audience_rollout WHERE id=1").first<Row>().catch(() => null);
  const stage = (ROLLOUT_STAGES.includes(text(row?.stage) as RolloutStage) ? text(row?.stage) : "off") as RolloutStage;
  // customersEnabled answers "are customers getting AI answers right now", not "what does the row say".
  // Reporting the row alone would have told an operator on a deployment where the UAT-only rollout does
  // not apply that customers were being answered by the AI while every one of them reached a human.
  const customerRolloutApproved = await customerRolloutApprovedHere();
  return { stage, reason: row?.reason ? text(row.reason) : null, updatedBy: row?.updated_by ? text(row.updated_by) : null, updatedAt: row?.updated_at ? Number(row.updated_at) : null, stages: ROLLOUT_STAGES, staffEnabled: stage !== "off", customersEnabled: stage === "customers" && customerRolloutApproved, customerRolloutUatOnly: true, customerRolloutApprovedHere: customerRolloutApproved };
}
