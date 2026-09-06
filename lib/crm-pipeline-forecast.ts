type Db = D1Database;
type Row = Record<string, unknown>;

export const OPPORTUNITY_STAGES = ["new","qualified","discovery","proposal","negotiation","committed","won","lost"] as const;
export type OpportunityStage = typeof OPPORTUNITY_STAGES[number];

const DEFAULT_PROBABILITY: Record<OpportunityStage, number> = {
  new: 0.10,
  qualified: 0.20,
  discovery: 0.35,
  proposal: 0.55,
  negotiation: 0.70,
  committed: 0.90,
  won: 1,
  lost: 0,
};
const STAGE_ORDER = new Map(OPPORTUNITY_STAGES.map((stage, index) => [stage, index]));
const text = (value: unknown) => String(value ?? "").trim();
const uid = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
const rows = <T = Row>(result: { results?: unknown[] }) => (result.results ?? []) as T[];
const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

async function tableExists(db: Db, table: string) {
  return Boolean(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(table).first<Row>());
}

export async function ensureCrmPipelineTables(db: Db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS crm_pipeline_stage_policies (stage TEXT PRIMARY KEY,display_order INTEGER NOT NULL,base_probability REAL NOT NULL,next_best_action TEXT NOT NULL,next_action_delay_minutes INTEGER NOT NULL,updated_by TEXT NOT NULL,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS crm_opportunities (id TEXT PRIMARY KEY,lead_id TEXT,customer_id TEXT NOT NULL,service_code TEXT NOT NULL,owner TEXT NOT NULL,stage TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open',amount REAL NOT NULL DEFAULT 0,amount_basis TEXT NOT NULL DEFAULT 'unpriced',stage_probability REAL NOT NULL,next_best_action TEXT NOT NULL,next_action_at INTEGER,won_booking_id TEXT,lost_reason TEXT,source TEXT NOT NULL,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(lead_id))"),
    db.prepare("CREATE INDEX IF NOT EXISTS crm_opportunities_stage_idx ON crm_opportunities(status,stage,owner,updated_at)"),
    db.prepare("CREATE TABLE IF NOT EXISTS crm_opportunity_stage_history (id TEXT PRIMARY KEY,opportunity_id TEXT NOT NULL,from_stage TEXT,to_stage TEXT NOT NULL,probability REAL NOT NULL,amount REAL NOT NULL,reason TEXT NOT NULL,actor_id TEXT NOT NULL,created_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS crm_opportunity_stage_history_idx ON crm_opportunity_stage_history(opportunity_id,created_at)"),
    db.prepare("CREATE TABLE IF NOT EXISTS crm_opportunity_actions (id TEXT PRIMARY KEY,opportunity_id TEXT NOT NULL,action TEXT NOT NULL,due_at INTEGER,status TEXT NOT NULL DEFAULT 'open',actor_id TEXT NOT NULL,created_at INTEGER NOT NULL,completed_at INTEGER)"),
    db.prepare("CREATE INDEX IF NOT EXISTS crm_opportunity_actions_due_idx ON crm_opportunity_actions(status,due_at)"),
    db.prepare("CREATE TABLE IF NOT EXISTS crm_forecast_snapshots (id TEXT PRIMARY KEY,period_start TEXT NOT NULL,period_end TEXT NOT NULL,unweighted_pipeline REAL NOT NULL,weighted_pipeline REAL NOT NULL,commit_forecast REAL NOT NULL,best_case_forecast REAL NOT NULL,historical_win_rate REAL NOT NULL,open_opportunities INTEGER NOT NULL,won_count INTEGER NOT NULL,lost_count INTEGER NOT NULL,analytics_json TEXT NOT NULL,generated_by TEXT NOT NULL,generated_at INTEGER NOT NULL)"),
  ]);
  const now = Date.now();
  const action: Record<OpportunityStage, [string, number]> = {
    new: ["Validate contact details and requirement", 10],
    qualified: ["Confirm budget, timing, service and decision criteria", 60],
    discovery: ["Complete requirement discovery and recommend the right service", 180],
    proposal: ["Send governed proposal and schedule follow-up", 240],
    negotiation: ["Resolve objections and confirm commercial terms", 120],
    committed: ["Collect payment and convert to a canonical booking", 60],
    won: ["Trigger booking handoff and customer onboarding", 0],
    lost: ["Capture structured loss reason and recycle when eligible", 0],
  };
  for (const stage of OPPORTUNITY_STAGES) {
    await db.prepare("INSERT OR IGNORE INTO crm_pipeline_stage_policies (stage,display_order,base_probability,next_best_action,next_action_delay_minutes,updated_by,updated_at) VALUES (?,?,?,?,?,'system:diamond-seed',?)")
      .bind(stage, STAGE_ORDER.get(stage) ?? 0, DEFAULT_PROBABILITY[stage], action[stage][0], action[stage][1], now).run();
  }
}

async function stagePolicy(db: Db, stage: OpportunityStage) {
  await ensureCrmPipelineTables(db);
  return db.prepare("SELECT * FROM crm_pipeline_stage_policies WHERE stage=?").bind(stage).first<Row>();
}

async function historicalStageProbability(db: Db, stage: OpportunityStage) {
  const prior = Number((await stagePolicy(db, stage))?.base_probability ?? DEFAULT_PROBABILITY[stage]);
  if (stage === "won" || stage === "lost") return prior;
  const history = await db.prepare("SELECT COUNT(DISTINCT h.opportunity_id) samples,SUM(CASE WHEN o.status='won' THEN 1 ELSE 0 END) wins FROM crm_opportunity_stage_history h JOIN crm_opportunities o ON o.id=h.opportunity_id WHERE h.to_stage=? AND o.status IN ('won','lost')")
    .bind(stage).first<Row>();
  const samples = Number(history?.samples ?? 0), wins = Number(history?.wins ?? 0);
  return clamp01(((prior * 10) + wins) / (10 + samples));
}

function asStage(value: unknown): OpportunityStage {
  const stage = text(value) as OpportunityStage;
  if (!OPPORTUNITY_STAGES.includes(stage)) throw new Error("Unsupported opportunity stage");
  return stage;
}

function nextStageAllowed(from: OpportunityStage, to: OpportunityStage) {
  if (from === to) return true;
  if (from === "won" || from === "lost") return false;
  if (to === "won" || to === "lost") return true;
  return (STAGE_ORDER.get(to) ?? -1) >= (STAGE_ORDER.get(from) ?? 99);
}

async function writeNextBestAction(db: Db, opportunityId: string, actorId: string, stage: OpportunityStage, now: number) {
  const policy = await stagePolicy(db, stage);
  const action = text(policy?.next_best_action) || "Review opportunity";
  const delay = Math.max(0, Number(policy?.next_action_delay_minutes ?? 0));
  const dueAt = delay ? now + delay * 60_000 : null;
  await db.prepare("UPDATE crm_opportunities SET next_best_action=?,next_action_at=?,updated_at=? WHERE id=?")
    .bind(action, dueAt, now, opportunityId).run();
  await db.prepare("UPDATE crm_opportunity_actions SET status='superseded',completed_at=? WHERE opportunity_id=? AND status='open'").bind(now, opportunityId).run();
  await db.prepare("INSERT INTO crm_opportunity_actions (id,opportunity_id,action,due_at,status,actor_id,created_at) VALUES (?,?,?,?, 'open',?,?)")
    .bind(uid("OPA"), opportunityId, action, dueAt, actorId, now).run();
  if (await tableExists(db, "crm_tasks")) {
    const opportunity = await db.prepare("SELECT customer_id,owner FROM crm_opportunities WHERE id=?").bind(opportunityId).first<Row>();
    await db.prepare("INSERT OR IGNORE INTO crm_tasks (id,contact_id,title,owner,due_at,priority,status,created_at) VALUES (?,?,?,?,?,'High','Open',?)")
      .bind(`OPP-TASK-${opportunityId}-${stage}`, opportunity?.customer_id, action, opportunity?.owner, dueAt, now).run().catch(() => undefined);
  }
  return { action, dueAt };
}

export async function upsertOpportunityFromLead(db: Db, input: { leadId: string; amount?: number; amountBasis?: string; actorId: string; source?: string }) {
  await ensureCrmPipelineTables(db);
  const lead = await db.prepare("SELECT id,customer_id,service,owner,status,stage,converted_booking_id FROM lead_work_items WHERE id=?").bind(input.leadId).first<Row>();
  if (!lead) throw new Error("Lead not found");
  const prior = await db.prepare("SELECT * FROM crm_opportunities WHERE lead_id=?").bind(input.leadId).first<Row>();
  if (prior) return { opportunity: prior, created: false };
  const now = Date.now();
  const stage: OpportunityStage = text(lead.converted_booking_id) ? "won" : "new";
  const amount = Math.max(0, Number(input.amount ?? 0));
  const probability = await historicalStageProbability(db, stage);
  const id = uid("OPP");
  await db.prepare("INSERT INTO crm_opportunities (id,lead_id,customer_id,service_code,owner,stage,status,amount,amount_basis,stage_probability,next_best_action,next_action_at,won_booking_id,source,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?, '',NULL,?,?,?,?,?)")
    .bind(id, input.leadId, lead.customer_id, text(lead.service) || "unknown", text(lead.owner) || "Unassigned", stage, stage === "won" ? "won" : "open", amount, text(input.amountBasis) || (amount > 0 ? "operator_supplied" : "unpriced"), probability, lead.converted_booking_id || null, text(input.source) || "lead_work_items", input.actorId, now, now).run();
  await db.prepare("INSERT INTO crm_opportunity_stage_history (id,opportunity_id,from_stage,to_stage,probability,amount,reason,actor_id,created_at) VALUES (?,?,NULL,?,?,?,?,?,?)")
    .bind(uid("OPH"), id, stage, probability, amount, "Opportunity created from canonical lead", input.actorId, now).run();
  await writeNextBestAction(db, id, input.actorId, stage, now);
  return { opportunity: await db.prepare("SELECT * FROM crm_opportunities WHERE id=?").bind(id).first<Row>(), created: true };
}

export async function syncOpenLeadPipeline(db: Db, input: { actorId?: string; limit?: number } = {}) {
  await ensureCrmPipelineTables(db);
  if (!(await tableExists(db, "lead_work_items"))) return { processed: 0, skipped: true };
  const limit = Math.max(1, Math.min(500, Math.floor(input.limit ?? 200)));
  const leads = rows(await db.prepare("SELECT l.id FROM lead_work_items l LEFT JOIN crm_opportunities o ON o.lead_id=l.id WHERE o.id IS NULL AND l.status NOT IN ('closed','merged') ORDER BY l.updated_at DESC LIMIT ?").bind(limit).all<Row>());
  let processed = 0;
  for (const lead of leads) {
    await upsertOpportunityFromLead(db, { leadId: text(lead.id), actorId: input.actorId || "system:pipeline-sync", source: "pipeline_sync" });
    processed++;
  }
  return { processed, skipped: false };
}

export async function advanceOpportunityStage(db: Db, input: { opportunityId: string; stage: OpportunityStage; actorId: string; reason: string; amount?: number; wonBookingId?: string | null; lostReason?: string | null; asOf?: number }) {
  await ensureCrmPipelineTables(db);
  if (text(input.reason).length < 4) throw new Error("A clear stage transition reason is required");
  const opportunity = await db.prepare("SELECT * FROM crm_opportunities WHERE id=?").bind(input.opportunityId).first<Row>();
  if (!opportunity) throw new Error("Opportunity not found");
  const from = asStage(opportunity.stage), to = asStage(input.stage);
  if (!nextStageAllowed(from, to)) throw new Error(`Invalid opportunity transition ${from} -> ${to}`);
  if (to === "lost" && text(input.lostReason).length < 4) throw new Error("A structured loss reason is required");
  if (to === "won" && !text(input.wonBookingId || opportunity.won_booking_id)) throw new Error("Won opportunities require a canonical booking id");
  const amount = input.amount == null ? Number(opportunity.amount ?? 0) : Math.max(0, Number(input.amount));
  const probability = await historicalStageProbability(db, to), now = input.asOf ?? Date.now();
  const status = to === "won" ? "won" : to === "lost" ? "lost" : "open";
  await db.prepare("UPDATE crm_opportunities SET stage=?,status=?,amount=?,stage_probability=?,won_booking_id=?,lost_reason=?,updated_at=? WHERE id=?")
    .bind(to, status, amount, probability, to === "won" ? text(input.wonBookingId || opportunity.won_booking_id) : opportunity.won_booking_id || null, to === "lost" ? text(input.lostReason) : null, now, input.opportunityId).run();
  await db.prepare("INSERT INTO crm_opportunity_stage_history (id,opportunity_id,from_stage,to_stage,probability,amount,reason,actor_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .bind(uid("OPH"), input.opportunityId, from, to, probability, amount, text(input.reason), input.actorId, now).run();
  const next = await writeNextBestAction(db, input.opportunityId, input.actorId, to, now);
  return { opportunity: await db.prepare("SELECT * FROM crm_opportunities WHERE id=?").bind(input.opportunityId).first<Row>(), nextBestAction: next };
}

export async function buildProbabilisticForecast(db: Db, input: { actorId: string; periodStart?: string; periodEnd?: string; persist?: boolean } ) {
  await ensureCrmPipelineTables(db);
  const open = rows(await db.prepare("SELECT * FROM crm_opportunities WHERE status='open' ORDER BY updated_at DESC").all<Row>());
  const closed = await db.prepare("SELECT COUNT(*) total,SUM(CASE WHEN status='won' THEN 1 ELSE 0 END) won,SUM(CASE WHEN status='lost' THEN 1 ELSE 0 END) lost FROM crm_opportunities WHERE status IN ('won','lost')").first<Row>();
  let weighted = 0, unweighted = 0, commit = 0, bestCase = 0;
  const stageAnalytics: Record<string, { count: number; amount: number; probability: number; weighted: number }> = {};
  for (const opportunity of open) {
    const stage = asStage(opportunity.stage);
    const probability = await historicalStageProbability(db, stage);
    const amount = Math.max(0, Number(opportunity.amount ?? 0));
    unweighted += amount;
    weighted += amount * probability;
    if ((STAGE_ORDER.get(stage) ?? 0) >= (STAGE_ORDER.get("committed") ?? 5)) commit += amount * probability;
    if ((STAGE_ORDER.get(stage) ?? 0) >= (STAGE_ORDER.get("negotiation") ?? 4)) bestCase += amount;
    const bucket = stageAnalytics[stage] ?? { count: 0, amount: 0, probability, weighted: 0 };
    bucket.count++; bucket.amount += amount; bucket.weighted += amount * probability; bucket.probability = probability; stageAnalytics[stage] = bucket;
    if (Math.abs(Number(opportunity.stage_probability ?? 0) - probability) > 0.0001) {
      await db.prepare("UPDATE crm_opportunities SET stage_probability=?,updated_at=? WHERE id=?").bind(probability, Date.now(), opportunity.id).run();
    }
  }
  const won = Number(closed?.won ?? 0), lost = Number(closed?.lost ?? 0), totalClosed = won + lost;
  const winRate = totalClosed ? won / totalClosed : 0;
  const lossRows = rows(await db.prepare("SELECT COALESCE(NULLIF(lost_reason,''),'unspecified') reason,COUNT(*) count,COALESCE(SUM(amount),0) value FROM crm_opportunities WHERE status='lost' GROUP BY COALESCE(NULLIF(lost_reason,''),'unspecified') ORDER BY count DESC,value DESC LIMIT 20").all<Row>());
  const serviceRows = rows(await db.prepare("SELECT service_code,COUNT(*) closed,SUM(CASE WHEN status='won' THEN 1 ELSE 0 END) won,COALESCE(SUM(CASE WHEN status='won' THEN amount ELSE 0 END),0) won_value FROM crm_opportunities WHERE status IN ('won','lost') GROUP BY service_code ORDER BY won_value DESC").all<Row>());
  const result = {
    periodStart: input.periodStart || new Date().toISOString().slice(0, 10),
    periodEnd: input.periodEnd || new Date().toISOString().slice(0, 10),
    openOpportunities: open.length,
    unweightedPipeline: Math.round(unweighted * 100) / 100,
    weightedPipeline: Math.round(weighted * 100) / 100,
    commitForecast: Math.round(commit * 100) / 100,
    bestCaseForecast: Math.round(bestCase * 100) / 100,
    historicalWinRate: Math.round(winRate * 10_000) / 10_000,
    wonCount: won,
    lostCount: lost,
    stageAnalytics,
    lossReasons: lossRows,
    serviceWinLoss: serviceRows,
  };
  if (input.persist !== false) {
    await db.prepare("INSERT INTO crm_forecast_snapshots (id,period_start,period_end,unweighted_pipeline,weighted_pipeline,commit_forecast,best_case_forecast,historical_win_rate,open_opportunities,won_count,lost_count,analytics_json,generated_by,generated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .bind(uid("FCST"), result.periodStart, result.periodEnd, result.unweightedPipeline, result.weightedPipeline, result.commitForecast, result.bestCaseForecast, result.historicalWinRate, result.openOpportunities, result.wonCount, result.lostCount, JSON.stringify({ stages: stageAnalytics, lossReasons: lossRows, serviceWinLoss: serviceRows }), input.actorId, Date.now()).run();
  }
  return result;
}
