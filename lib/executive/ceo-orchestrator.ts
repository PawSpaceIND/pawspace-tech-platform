import { ensureAiSalesGoalTables, runAiSalesGoalDispatcher } from "../ai-sales-goal-orchestrator";
import { ensureMarginPolicyTables } from "../finance-margin-validator";
import { ensureProviderCapacityTables } from "../provider-capacity-governance";
import { decideExecutiveAction } from "./decision-policy";

type Db=D1Database; type Row=Record<string,unknown>;
const uid=(p:string)=>`${p}-${crypto.randomUUID().slice(0,12).toUpperCase()}`;
const text=(v:unknown)=>String(v??"").trim(); const num=(v:unknown)=>Number(v||0);
export const EXECUTIVE_CRON="*/15 * * * *";

export async function ensureExecutiveTables(db:Db){
  await ensureAiSalesGoalTables(db); await ensureMarginPolicyTables(db); await ensureProviderCapacityTables(db);
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS executive_runtime_config (key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_by TEXT NOT NULL,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS executive_agent_actions (id TEXT PRIMARY KEY,run_id TEXT NOT NULL,target_id TEXT,agent_code TEXT NOT NULL,action_code TEXT NOT NULL,service_code TEXT NOT NULL DEFAULT '',city_id TEXT NOT NULL DEFAULT '',zone_id TEXT NOT NULL DEFAULT '',status TEXT NOT NULL,decision_json TEXT NOT NULL,evidence_json TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_executive_actions_target ON executive_agent_actions(target_id,created_at DESC)"),
    db.prepare("CREATE TABLE IF NOT EXISTS executive_sales_directives (target_id TEXT PRIMARY KEY,mode TEXT NOT NULL,pressure_multiplier REAL NOT NULL DEFAULT 1,reason TEXT NOT NULL,authorized_discount_bps INTEGER NOT NULL DEFAULT 0,authorized_upgrade_codes_json TEXT NOT NULL DEFAULT '[]',margin_validation_required INTEGER NOT NULL DEFAULT 1,expires_at INTEGER NOT NULL,run_id TEXT NOT NULL,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS executive_runs (id TEXT PRIMARY KEY,slot_key TEXT NOT NULL UNIQUE,started_at INTEGER NOT NULL,completed_at INTEGER,status TEXT NOT NULL,result_json TEXT NOT NULL DEFAULT '{}')"),
  ]);
}

export async function executiveActive(db:Db,runtime:Record<string,unknown>={}){
  await ensureExecutiveTables(db);
  const row=await db.prepare("SELECT value FROM executive_runtime_config WHERE key='PAWSPACE_AI_EXECUTIVE_ACTIVE'").first<Row>();
  const configured=row?text(row.value):text(runtime.PAWSPACE_AI_EXECUTIVE_ACTIVE||"false");
  return !["0","false","off","disabled"].includes(configured.toLowerCase());
}

async function capacitySnapshot(db:Db,target:Row,asOf:number){
  const service=text(target.service_code),city=text(target.city_id),date=new Date(asOf).toISOString().slice(0,10);
  const profiles=await db.prepare("SELECT capacity,max_daily_jobs,zones_json FROM provider_capacity_profiles WHERE live=1 AND status='active' AND services_json LIKE ? AND (?='' OR city_id=?) AND effective_from<=? AND (effective_to IS NULL OR effective_to>=?)").bind(`%\"${service}\"%`,city,city,date,date).all<Row>();
  let capacity=0; const zones=new Set<string>();
  for(const p of profiles.results){capacity+=Math.max(num(p.capacity),num(p.max_daily_jobs)); try{for(const z of JSON.parse(text(p.zones_json)||"[]"))zones.add(String(z));}catch{}}
  const bookings=await db.prepare("SELECT COUNT(*) n,COALESCE(SUM(total_amount),0) revenue FROM canonical_bookings WHERE service_code=? AND (?='' OR city_id=?) AND status NOT IN ('cancelled','draft') AND date(scheduled_start)=?").bind(service,city,city,date).first<Row>().catch(()=>({n:0,revenue:0}));
  const leads=await db.prepare("SELECT COUNT(*) n FROM lead_work_items WHERE service=? AND status NOT IN ('closed','merged') AND opt_out=0").bind(service).first<Row>().catch(()=>({n:0}));
  const used=num(bookings?.n),utilization=capacity>0?used/capacity:0;
  return {serviceCode:service,cityId:city,zones:[...zones],capacity,activeBookings:used,utilization,revenueRunRate:num(bookings?.revenue),openLeads:num(leads?.n)};
}

function pacing(target:Row,asOf:number){
  const start=num(target.starts_at),end=num(target.ends_at),goal=Math.max(1,num(target.daily_goal)),ach=num(target.achieved_count);
  const elapsed=Math.max(0,Math.min(1,(asOf-start)/Math.max(1,end-start))),expected=goal*elapsed;
  const lagFraction=expected>0?Math.max(0,(expected-ach)/expected):0;
  return {elapsed,expected,achieved:ach,goal,lagFraction};
}

async function record(db:Db,input:{runId:string;targetId:string;agent:string;action:string;service:string;city:string;status:string;decision:unknown;evidence:unknown;asOf:number}){
  await db.prepare("INSERT INTO executive_agent_actions (id,run_id,target_id,agent_code,action_code,service_code,city_id,status,decision_json,evidence_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(uid("EXACT"),input.runId,input.targetId,input.agent,input.action,input.service,input.city,input.status,JSON.stringify(input.decision),JSON.stringify(input.evidence),input.asOf,input.asOf).run();
}

export async function runExecutiveDecisionLoop(db:Db,runtime:Record<string,unknown>={},input:{asOf?:number}={}){
  await ensureExecutiveTables(db); const asOf=input.asOf??Date.now();
  if(!await executiveActive(db,runtime))return {status:"passive",evaluated:0,reason:"PAWSPACE_AI_EXECUTIVE_ACTIVE=false"};
  const slotKey=String(Math.floor(asOf/(15*60_000))),runId=uid("EXRUN");
  const claim=await db.prepare("INSERT OR IGNORE INTO executive_runs (id,slot_key,started_at,status) VALUES (?,?,?,'running')").bind(runId,slotKey,asOf).run();
  if(!num(claim.meta?.changes))return {status:"duplicate_slot",evaluated:0};
  const targets=await db.prepare("SELECT * FROM ai_sales_targets WHERE status IN ('approved','active') AND approved_by IS NOT NULL AND approved_at IS NOT NULL AND starts_at<=? AND ends_at>?").bind(asOf,asOf).all<Row>();
  const decisions:Row[]=[];
  for(const target of targets.results){
    const targetId=text(target.id),service=text(target.service_code),city=text(target.city_id),cap=await capacitySnapshot(db,target,asOf),pace=pacing(target,asOf);
    let approvedUpgrades:string[]=[];try{approvedUpgrades=JSON.parse(text(target.free_upgrade_codes_json)||"[]");}catch{approvedUpgrades=[];}
    const decision=decideExecutiveAction({capacityUtilization:cap.utilization,pacingLagFraction:pace.lagFraction,approvedDiscountBps:num(target.max_discount_bps),approvedUpgradeCodes:approvedUpgrades});
    const mode=decision.mode,multiplier=decision.pressureMultiplier,reason=decision.reason,discount=decision.discountBps,upgrades=decision.upgradeCodes;
    await db.prepare("INSERT INTO executive_sales_directives (target_id,mode,pressure_multiplier,reason,authorized_discount_bps,authorized_upgrade_codes_json,margin_validation_required,expires_at,run_id,updated_at) VALUES (?,?,?,?,?,?,1,?,?,?) ON CONFLICT(target_id) DO UPDATE SET mode=excluded.mode,pressure_multiplier=excluded.pressure_multiplier,reason=excluded.reason,authorized_discount_bps=excluded.authorized_discount_bps,authorized_upgrade_codes_json=excluded.authorized_upgrade_codes_json,margin_validation_required=1,expires_at=excluded.expires_at,run_id=excluded.run_id,updated_at=excluded.updated_at")
      .bind(targetId,mode,multiplier,reason,discount,JSON.stringify(upgrades),num(target.ends_at),runId,asOf).run();
    await record(db,{runId,targetId,agent:"sales",action:mode==="throttle"?"outbound_throttle":mode==="boost"?"approved_incentive_envelope":"maintain_pressure",service,city,status:"applied",decision:{mode,multiplier,discountBps:discount,upgrades,marginValidationRequired:true},evidence:{capacity:cap,pacing:pace},asOf});
    await record(db,{runId,targetId,agent:"scheduler",action:"capacity_feedback",service,city,status:"reported",decision:{utilization:cap.utilization,throttled:mode==="throttle"},evidence:{canonicalSource:"canonical_bookings+provider_capacity_profiles"},asOf});
    decisions.push({targetId,mode,multiplier,reason,capacityUtilization:cap.utilization,pacingLag:pace.lagFraction});
  }
  const sales=await runAiSalesGoalDispatcher(db,{asOf,slotMinutes:15});
  const result={status:"completed",evaluated:targets.results.length,decisions,sales};
  await db.prepare("UPDATE executive_runs SET completed_at=?,status='completed',result_json=? WHERE id=?").bind(asOf,JSON.stringify(result),runId).run();
  return result;
}

export async function executiveDirective(db:Db,targetId:string,asOf=Date.now()){
  await ensureExecutiveTables(db); return db.prepare("SELECT * FROM executive_sales_directives WHERE target_id=? AND expires_at>?").bind(targetId,asOf).first<Row>();
}
