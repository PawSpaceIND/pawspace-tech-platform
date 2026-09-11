import { ensureAiSalesGoalTables } from "../ai-sales-goal-orchestrator";
import { routeHumanEscalation, type HumanEscalationSignal } from "../executive/human-escalation-router";

type Db = D1Database;
type Row = Record<string, unknown>;
const text = (value: unknown) => String(value ?? "").trim();

export type AtlasManagerInstruction = {
  manager: "ops" | "sales" | "marketing";
  action: string;
  cityId?: string | null;
  zoneId?: string | null;
  serviceCode?: string | null;
  reason: string;
  payload?: Record<string, unknown>;
};

export type AtlasWorkerRouter = (instruction: AtlasManagerInstruction) => Promise<unknown>;

export async function ensureAtlasSupervisorTables(db: Db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS atlas_manager_directives (id TEXT PRIMARY KEY,manager TEXT NOT NULL,action TEXT NOT NULL,city_id TEXT,zone_id TEXT,service_code TEXT,reason TEXT NOT NULL,payload_json TEXT NOT NULL DEFAULT '{}',status TEXT NOT NULL DEFAULT 'issued',created_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_atlas_manager_directives_scope ON atlas_manager_directives(manager,status,city_id,zone_id,service_code,created_at)"),
  ]);
}

async function issue(db: Db, instruction: AtlasManagerInstruction, route: AtlasWorkerRouter) {
  await ensureAtlasSupervisorTables(db);
  const id = `ATLAS-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
  await db.prepare("INSERT INTO atlas_manager_directives (id,manager,action,city_id,zone_id,service_code,reason,payload_json,status,created_at) VALUES (?,?,?,?,?,?,?,?, 'issued',?)")
    .bind(id, instruction.manager, instruction.action, instruction.cityId ?? null, instruction.zoneId ?? null, instruction.serviceCode ?? null, instruction.reason, JSON.stringify(instruction.payload || {}), Date.now()).run();
  const result = await route(instruction);
  return { directiveId: id, instruction, result };
}

export function resolveCapacityConflict(input: { utilization: number; cityId: string; zoneId: string; serviceCode: string }): AtlasManagerInstruction[] {
  if (input.serviceCode !== "grooming" || input.utilization <= 0.90) return [];
  return [
    { manager: "sales", action: "halt_outbound_promotion", cityId: input.cityId, zoneId: input.zoneId, serviceCode: "grooming", reason: "grooming_capacity_above_90_percent", payload: { utilization: input.utilization } },
    { manager: "sales", action: "pivot_outbound_mix", cityId: input.cityId, zoneId: input.zoneId, serviceCode: "dog_training", reason: "grooming_capacity_above_90_percent", payload: { alternatives: ["dog_training", "boarding"], blockedService: "grooming" } },
  ];
}

export async function runAtlasCeoSupervisor(db: Db, input: { asOf?: number; route: AtlasWorkerRouter; capacitySignals?: Array<{ utilization: number; cityId: string; zoneId: string; serviceCode: string }>; exceptionSignals?: HumanEscalationSignal[] }) {
  await ensureAiSalesGoalTables(db);
  await ensureAtlasSupervisorTables(db);
  const asOf = input.asOf ?? Date.now();
  const targets = await db.prepare("SELECT id,target_type,service_code,city_id,daily_goal,achieved_count,starts_at,ends_at,status FROM ai_sales_targets WHERE status IN ('approved','active') AND starts_at<=? AND ends_at>? ORDER BY ends_at").bind(asOf, asOf).all<Row>();
  const directives: unknown[] = [];
  for (const row of targets.results) {
    const goal = Math.max(1, Number(row.daily_goal || 1)), actual = Number(row.achieved_count || 0), elapsed = Math.max(0, Math.min(1, (asOf - Number(row.starts_at)) / Math.max(1, Number(row.ends_at) - Number(row.starts_at))));
    const expected = goal * elapsed, lagRatio = expected > 0 ? Math.max(0, (expected - actual) / expected) : 0;
    if (lagRatio > 0.25) directives.push(await issue(db, { manager: "sales", action: "recover_target_pacing", cityId: text(row.city_id) || null, serviceCode: text(row.service_code) || null, reason: "target_pacing_lag_above_25_percent", payload: { targetId: row.id, targetType: row.target_type, goal, actual, expected, lagRatio } }, input.route));
  }
  for (const signal of input.capacitySignals || []) for (const instruction of resolveCapacityConflict(signal)) directives.push(await issue(db, instruction, input.route));
  const escalations = [];
  for (const signal of input.exceptionSignals || []) { const routed = await routeHumanEscalation(db, signal); if (routed.escalated) escalations.push(routed); }
  return { evaluatedTargets: targets.results.length, directives, escalations, lineLevelExecution: false, canonicalExecutionOnly: true };
}
