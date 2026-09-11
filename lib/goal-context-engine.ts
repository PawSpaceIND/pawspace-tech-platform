export type GoalAutonomyMode="recommend"|"approval_required"|"execute_within_envelope";
type Row=Record<string,unknown>;
const text=(v:unknown)=>String(v??"").trim();

export async function ensureGoalContextTables(db:D1Database){
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS gce_goals (id TEXT PRIMARY KEY,title TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',goal_type TEXT NOT NULL,priority INTEGER NOT NULL DEFAULT 50,owner_type TEXT NOT NULL DEFAULT 'founder',owner_id TEXT,status TEXT NOT NULL DEFAULT 'draft',autonomy_mode TEXT NOT NULL DEFAULT 'recommend',service_code TEXT,city_id TEXT,zone_id TEXT,starts_at INTEGER NOT NULL,ends_at INTEGER,approved_by TEXT,approved_at INTEGER,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS gce_budget_envelopes (id TEXT PRIMARY KEY,goal_id TEXT,budget_type TEXT NOT NULL,service_code TEXT,city_id TEXT,zone_id TEXT,currency TEXT NOT NULL DEFAULT 'INR',period_type TEXT NOT NULL,hard_limit_paise INTEGER,soft_limit_paise INTEGER,consumed_paise INTEGER NOT NULL DEFAULT 0,max_discount_bps INTEGER,minimum_margin_bps INTEGER,max_single_action_paise INTEGER,starts_at INTEGER NOT NULL,ends_at INTEGER,status TEXT NOT NULL DEFAULT 'draft',approved_by TEXT,approved_at INTEGER,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS gce_constraints (id TEXT PRIMARY KEY,constraint_code TEXT NOT NULL UNIQUE,title TEXT NOT NULL,description TEXT NOT NULL,constraint_type TEXT NOT NULL,enforcement TEXT NOT NULL,service_code TEXT,city_id TEXT,zone_id TEXT,configuration_json TEXT NOT NULL DEFAULT '{}',effective_from INTEGER NOT NULL,effective_to INTEGER,status TEXT NOT NULL DEFAULT 'draft',approved_by TEXT,approved_at INTEGER,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  ]);
}

export async function activeGoalContext(db:D1Database,input:{goalId:string;asOf?:number}){
  await ensureGoalContextTables(db);const asOf=input.asOf??Date.now();
  const goal=await db.prepare("SELECT * FROM gce_goals WHERE id=? AND status='active' AND approved_by IS NOT NULL AND approved_at IS NOT NULL AND starts_at<=? AND (ends_at IS NULL OR ends_at>?)").bind(input.goalId,asOf,asOf).first<Row>();
  if(!goal)throw new Error("Active Founder-approved goal not found");
  const budgets=await db.prepare("SELECT * FROM gce_budget_envelopes WHERE (goal_id=? OR goal_id IS NULL) AND status='active' AND approved_by IS NOT NULL AND approved_at IS NOT NULL AND starts_at<=? AND (ends_at IS NULL OR ends_at>?)").bind(input.goalId,asOf,asOf).all<Row>();
  const constraints=await db.prepare("SELECT * FROM gce_constraints WHERE status='active' AND approved_by IS NOT NULL AND approved_at IS NOT NULL AND effective_from<=? AND (effective_to IS NULL OR effective_to>?)").bind(asOf,asOf).all<Row>();
  return{goal:{id:text(goal.id),title:text(goal.title),description:text(goal.description),goalType:text(goal.goal_type),priority:Number(goal.priority),autonomyMode:text(goal.autonomy_mode) as GoalAutonomyMode,serviceCode:text(goal.service_code)||null,cityId:text(goal.city_id)||null,zoneId:text(goal.zone_id)||null,startsAt:Number(goal.starts_at),endsAt:goal.ends_at==null?null:Number(goal.ends_at)},budgets:budgets.results,constraints:constraints.results,generatedAt:asOf};
}
