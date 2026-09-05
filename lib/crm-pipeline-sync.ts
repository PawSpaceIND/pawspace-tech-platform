import { ensureCrmPipelineTables, type OpportunityStage } from "./crm-pipeline-forecast";

type Db = D1Database;
type Row = Record<string, unknown>;
const text = (v: unknown) => String(v ?? "").trim();
const uid = (p: string) => `${p}-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
const rows = <T = Row>(r: { results?: unknown[] }) => (r.results ?? []) as T[];

const BASE: Record<OpportunityStage, number> = { new: .10, qualified: .20, discovery: .35, proposal: .55, negotiation: .70, committed: .90, won: 1, lost: 0 };
const ACTION: Record<OpportunityStage, [string, number]> = {
  new: ["Validate contact details and requirement", 10], qualified: ["Confirm budget, timing, service and decision criteria", 60],
  discovery: ["Complete requirement discovery and recommend the right service", 180], proposal: ["Send governed proposal and schedule follow-up", 240],
  negotiation: ["Resolve objections and confirm commercial terms", 120], committed: ["Collect payment and convert to a canonical booking", 60],
  won: ["Trigger booking handoff and customer onboarding", 0], lost: ["Capture structured loss reason and recycle when eligible", 0],
};

async function probability(db: Db, stage: OpportunityStage) {
  if (stage === "won" || stage === "lost") return BASE[stage];
  const history = await db.prepare("SELECT COUNT(DISTINCT h.opportunity_id) samples,SUM(CASE WHEN o.status='won' THEN 1 ELSE 0 END) wins FROM crm_opportunity_stage_history h JOIN crm_opportunities o ON o.id=h.opportunity_id WHERE h.to_stage=? AND o.status IN ('won','lost')").bind(stage).first<Row>();
  const samples = Number(history?.samples || 0), wins = Number(history?.wins || 0);
  return ((BASE[stage] * 10) + wins) / (10 + samples);
}

export async function createOpportunityFromLead(db: Db, input: { leadId: string; actorId: string; amount?: number; amountBasis?: string; source?: string }) {
  await ensureCrmPipelineTables(db);
  const lead = await db.prepare("SELECT id,customer_id,service,owner,converted_booking_id FROM lead_work_items WHERE id=?").bind(input.leadId).first<Row>();
  if (!lead) throw new Error("Lead not found");
  const prior = await db.prepare("SELECT * FROM crm_opportunities WHERE lead_id=?").bind(input.leadId).first<Row>();
  if (prior) return { opportunity: prior, created: false };
  const stage: OpportunityStage = text(lead.converted_booking_id) ? "won" : "new", now = Date.now(), amount = Math.max(0, Number(input.amount || 0));
  const stageProbability = await probability(db, stage), [action, delay] = ACTION[stage], nextActionAt = delay ? now + delay * 60_000 : null, id = uid("OPP");
  await db.batch([
    db.prepare("INSERT INTO crm_opportunities (id,lead_id,customer_id,service_code,owner,stage,status,amount,amount_basis,stage_probability,next_best_action,next_action_at,won_booking_id,source,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .bind(id, input.leadId, lead.customer_id, text(lead.service) || "unknown", text(lead.owner) || "Unassigned", stage, stage === "won" ? "won" : "open", amount, text(input.amountBasis) || (amount ? "operator_supplied" : "unpriced"), stageProbability, action, nextActionAt, lead.converted_booking_id || null, text(input.source) || "lead_work_items", input.actorId, now, now),
    db.prepare("INSERT INTO crm_opportunity_stage_history (id,opportunity_id,from_stage,to_stage,probability,amount,reason,actor_id,created_at) VALUES (?,?,NULL,?,?,?,?,?,?)")
      .bind(uid("OPH"), id, stage, stageProbability, amount, "Opportunity created from canonical lead", input.actorId, now),
    db.prepare("INSERT INTO crm_opportunity_actions (id,opportunity_id,action,due_at,status,actor_id,created_at) VALUES (?,?,?,?, 'open',?,?)")
      .bind(uid("OPA"), id, action, nextActionAt, input.actorId, now),
  ]);
  return { opportunity: await db.prepare("SELECT * FROM crm_opportunities WHERE id=?").bind(id).first<Row>(), created: true };
}

export async function syncLeadOpportunityPipeline(db: Db, input: { actorId?: string; limit?: number } = {}) {
  await ensureCrmPipelineTables(db);
  const limit = Math.max(1, Math.min(500, Math.floor(input.limit || 200)));
  const leads = rows(await db.prepare("SELECT l.id FROM lead_work_items l LEFT JOIN crm_opportunities o ON o.lead_id=l.id WHERE o.id IS NULL AND l.status NOT IN ('closed','merged') ORDER BY l.updated_at DESC LIMIT ?").bind(limit).all<Row>().catch(() => ({ results: [] })));
  for (const lead of leads) await createOpportunityFromLead(db, { leadId: text(lead.id), actorId: input.actorId || "system:pipeline-sync", source: "pipeline_sync" });
  return { processed: leads.length, skipped: false };
}
