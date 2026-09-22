import { ensureAiSalesGoalTables } from "../ai-sales-goal-orchestrator";
import { routeHumanEscalation, type HumanEscalationSignal } from "../executive/human-escalation-router";
import { buildAtlasBusinessSnapshot, recordAtlasProposal, type AtlasBusinessSnapshot } from "../intelligence/atlas-business-snapshot";

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
type ProposalCandidate={instruction:AtlasManagerInstruction;basisId:string};

export function aiExecutiveActive(env:Record<string,unknown>={}){return String(env.PAWSPACE_AI_EXECUTIVE_ACTIVE??"").trim().toLowerCase()==="true";}

export async function ensureAtlasSupervisorTables(db: Db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS atlas_manager_directives (id TEXT PRIMARY KEY,manager TEXT NOT NULL,action TEXT NOT NULL,city_id TEXT,zone_id TEXT,service_code TEXT,reason TEXT NOT NULL,payload_json TEXT NOT NULL DEFAULT '{}',status TEXT NOT NULL DEFAULT 'legacy_disabled',created_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_atlas_manager_directives_scope ON atlas_manager_directives(manager,status,city_id,zone_id,service_code,created_at)"),
    db.prepare("CREATE TABLE IF NOT EXISTS atlas_supervisor_proposal_claims (claim_key TEXT PRIMARY KEY,proposal_type TEXT NOT NULL,basis_id TEXT NOT NULL,proposal_id TEXT,created_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_atlas_supervisor_claim_basis ON atlas_supervisor_proposal_claims(proposal_type,basis_id,created_at)"),
  ]);
}

export function resolveCapacityConflict(input: { utilization: number; cityId: string; zoneId: string; serviceCode: string }): AtlasManagerInstruction[] {
  if (input.serviceCode !== "grooming" || input.utilization <= 0.90) return [];
  return [
    { manager: "sales", action: "halt_outbound_promotion", cityId: input.cityId, zoneId: input.zoneId, serviceCode: "grooming", reason: "grooming_capacity_above_90_percent", payload: { utilization: input.utilization } },
    { manager: "sales", action: "pivot_outbound_mix", cityId: input.cityId, zoneId: input.zoneId, serviceCode: "dog_training", reason: "grooming_capacity_above_90_percent", payload: { alternatives: ["dog_training", "boarding"], blockedService: "grooming" } },
  ];
}

async function proposeOnce(db:Db,snapshot:AtlasBusinessSnapshot,input:ProposalCandidate,asOf:number) {
  const proposalType=`ceo_${input.instruction.action}`,claimKey=`${proposalType}:${input.basisId}`;
  const claim=await db.prepare("INSERT OR IGNORE INTO atlas_supervisor_proposal_claims (claim_key,proposal_type,basis_id,created_at) VALUES (?,?,?,?)").bind(claimKey,proposalType,input.basisId,asOf).run();
  if(Number(claim.meta?.changes||0)!==1)return{duplicatePrevented:true,claimKey};
  try{
    const proposal=await recordAtlasProposal(db,{
      proposalType,
      summary:`${input.instruction.manager} proposal: ${input.instruction.reason}`,
      snapshot,
      basisId:input.basisId,
      riskClass:"medium",
      action:{
        manager:input.instruction.manager,
        action:input.instruction.action,
        cityId:input.instruction.cityId??null,
        zoneId:input.instruction.zoneId??null,
        serviceCode:input.instruction.serviceCode??null,
        reason:input.instruction.reason,
        payload:input.instruction.payload??{},
      },
      createdBy:"system:atlas-ceo-supervisor",
    });
    await db.prepare("UPDATE atlas_supervisor_proposal_claims SET proposal_id=? WHERE claim_key=?").bind(proposal.id,claimKey).run();
    return{...proposal,duplicatePrevented:false,claimKey};
  }catch(error){
    await db.prepare("DELETE FROM atlas_supervisor_proposal_claims WHERE claim_key=? AND proposal_id IS NULL").bind(claimKey).run().catch(()=>null);
    throw error;
  }
}

export async function runAtlasCeoSupervisor(db: Db, input: { asOf?: number; route?: AtlasWorkerRouter; env?:Record<string,unknown>; capacitySignals?: Array<{ utilization: number; cityId: string; zoneId: string; serviceCode: string }>; exceptionSignals?: HumanEscalationSignal[] }) {
  await ensureAiSalesGoalTables(db);
  await ensureAtlasSupervisorTables(db);
  const asOf = input.asOf ?? Date.now(),executiveActive=aiExecutiveActive(input.env);
  const escalations = [];
  for (const signal of input.exceptionSignals || []) { const routed = await routeHumanEscalation(db, signal); if (routed.escalated) escalations.push(routed); }

  const targets = await db.prepare("SELECT id,target_type,service_code,city_id,daily_goal,achieved_count,starts_at,ends_at,status FROM ai_sales_targets WHERE status IN ('approved','active') AND approved_by IS NOT NULL AND approved_at IS NOT NULL AND starts_at<=? AND ends_at>? ORDER BY ends_at").bind(asOf, asOf).all<Row>();
  const candidates:ProposalCandidate[]=[];
  if(executiveActive){
    for (const row of targets.results) {
      const goal = Math.max(1, Number(row.daily_goal || 1)), actual = Number(row.achieved_count || 0), elapsed = Math.max(0, Math.min(1, (asOf - Number(row.starts_at)) / Math.max(1, Number(row.ends_at) - Number(row.starts_at))));
      const expected = goal * elapsed, lagRatio = expected > 0 ? Math.max(0, (expected - actual) / expected) : 0;
      if (lagRatio > 0.25) candidates.push({basisId:text(row.id),instruction:{ manager: "sales", action: "recover_target_pacing", cityId: text(row.city_id) || null, serviceCode: text(row.service_code) || null, reason: "target_pacing_lag_above_25_percent", payload: { targetId: row.id, targetType: row.target_type, goal, actual, expected, lagRatio } }});
    }
    const capacityWindow=Math.floor(asOf/(15*60_000));
    for (const signal of input.capacitySignals || []) for (const instruction of resolveCapacityConflict(signal)) candidates.push({instruction,basisId:`capacity:${signal.cityId}:${signal.zoneId}:${signal.serviceCode}:${capacityWindow}`});
  }

  const proposals:unknown[]=[],proposalErrors:Array<{basisId:string;reason:string}>=[];
  if(candidates.length){
    let snapshot:AtlasBusinessSnapshot|null=null;
    try{snapshot=await buildAtlasBusinessSnapshot(db,{asOf})}catch{for(const candidate of candidates)proposalErrors.push({basisId:candidate.basisId,reason:"business_snapshot_unavailable"});}
    if(snapshot)for(const candidate of candidates){try{proposals.push(await proposeOnce(db,snapshot,candidate,asOf))}catch{proposalErrors.push({basisId:candidate.basisId,reason:"proposal_journal_failed"});}}
  }

  return { evaluatedTargets: targets.results.length, proposals, proposalErrors, directives:[], escalations, executiveActive, executiveDefault:false, proposalOnly:true, workerRouterCalled:false, lineLevelExecution:false, canonicalExecutionOnly:true };
}
