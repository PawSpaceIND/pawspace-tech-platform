import { listMarketingAdMetrics, mutateMarketingAdResource, type MarketingAdPlatform } from "./marketing-ad-connectors";

type Db = D1Database;
type Runtime = Record<string, unknown>;
type Row = Record<string, unknown>;
type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type MarketingToolName =
  | "marketing.ads.read_metrics"
  | "marketing.ads.search_terms.analyze"
  | "marketing.ads.budget.reallocate"
  | "marketing.ads.keyword.mutate"
  | "marketing.proposal.submit";

export const MARKETING_TOOL_SCHEMAS = {
  "marketing.ads.read_metrics": {
    type: "object",
    additionalProperties: false,
    required: ["from", "to"],
    properties: {
      from: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
      to: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
      platform: { enum: ["google_ads", "meta_ads"] },
      campaignId: { type: "string", minLength: 1 },
    },
  },
  "marketing.ads.search_terms.analyze": {
    type: "object",
    additionalProperties: false,
    required: ["from", "to"],
    properties: {
      from: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
      to: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
      campaignId: { type: "string" },
      minSpendMinor: { type: "integer", minimum: 0, default: 0 },
      minClicks: { type: "integer", minimum: 0, default: 0 },
    },
  },
  "marketing.ads.budget.reallocate": {
    type: "object",
    additionalProperties: false,
    required: ["approvalId", "platform", "fromResourceId", "toResourceId", "shiftMinor", "reason"],
    properties: {
      approvalId: { type: "string", minLength: 1 },
      platform: { enum: ["google_ads", "meta_ads"] },
      fromResourceId: { type: "string", minLength: 1 },
      toResourceId: { type: "string", minLength: 1 },
      shiftMinor: { type: "integer", minimum: 1 },
      reason: { type: "string", minLength: 10, maxLength: 1000 },
    },
  },
  "marketing.ads.keyword.mutate": {
    type: "object",
    additionalProperties: false,
    required: ["approvalId", "platform", "campaignId", "keyword", "operation", "reason"],
    properties: {
      approvalId: { type: "string", minLength: 1 },
      platform: { enum: ["google_ads", "meta_ads"] },
      campaignId: { type: "string", minLength: 1 },
      keyword: { type: "string", minLength: 1, maxLength: 200 },
      operation: { enum: ["add_negative", "pause", "enable"] },
      amountMinor: { type: "integer", minimum: 1 },
      reason: { type: "string", minLength: 10, maxLength: 1000 },
    },
  },
  "marketing.proposal.submit": {
    type: "object",
    additionalProperties: false,
    required: ["toolName", "platform", "why", "payload", "requestedBy"],
    properties: {
      toolName: { enum: ["marketing.ads.budget.reallocate", "marketing.ads.keyword.mutate"] },
      platform: { enum: ["google_ads", "meta_ads"] },
      why: { type: "string", minLength: 20, maxLength: 4000 },
      payload: { type: "object" },
      requestedBy: { type: "string", minLength: 3 },
    },
  },
} as const;

const text = (v: unknown) => String(v ?? "").trim();
const int = (v: unknown) => Math.max(0, Math.trunc(Number(v) || 0));
const uid = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
const stableJson = (value: unknown) => JSON.stringify(value, Object.keys((value && typeof value === "object" ? value : {}) as object).sort());

export async function ensureMarketingAgentGatewayTables(db: Db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS gce_budget_envelopes (id TEXT PRIMARY KEY,platform TEXT NOT NULL,account_id TEXT NOT NULL,resource_id TEXT,daily_limit_minor INTEGER NOT NULL CHECK(daily_limit_minor>=0),currency TEXT NOT NULL DEFAULT 'INR',status TEXT NOT NULL DEFAULT 'active',effective_from INTEGER NOT NULL,effective_to INTEGER,approved_by TEXT NOT NULL,approved_at INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS gce_budget_envelopes_lookup_idx ON gce_budget_envelopes(platform,account_id,resource_id,status,effective_from,effective_to)"),
    db.prepare("CREATE TABLE IF NOT EXISTS pending_approvals (id TEXT PRIMARY KEY,domain TEXT NOT NULL,tool_name TEXT NOT NULL,platform TEXT NOT NULL,why_text TEXT NOT NULL,payload_json TEXT NOT NULL,payload_hash TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',requested_by TEXT NOT NULL,requested_at INTEGER NOT NULL,approved_by TEXT,approved_at INTEGER,rejected_by TEXT,rejected_at INTEGER,decision_note TEXT,executed_at INTEGER,execution_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS pending_approvals_status_idx ON pending_approvals(domain,status,requested_at)"),
  ]);
}

export async function submitMarketingProposal(db: Db, input: { toolName: "marketing.ads.budget.reallocate" | "marketing.ads.keyword.mutate"; platform: MarketingAdPlatform; why: string; payload: Record<string, unknown>; requestedBy: string }) {
  await ensureMarketingAgentGatewayTables(db);
  const id = uid("MAP");
  const now = Date.now();
  const payloadJson = stableJson(input.payload);
  const payloadHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payloadJson)).then(buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join(""));
  await db.prepare("INSERT INTO pending_approvals (id,domain,tool_name,platform,why_text,payload_json,payload_hash,status,requested_by,requested_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'pending',?,?,?,?,?)")
    .bind(id, "marketing", input.toolName, input.platform, text(input.why), payloadJson, payloadHash, text(input.requestedBy), now, now, now, now).run();
  return { id, status: "pending" as const, payloadHash };
}

export async function founderDecideMarketingProposal(db: Db, input: { approvalId: string; decision: "approved" | "rejected"; founderActor: string; note?: string }) {
  await ensureMarketingAgentGatewayTables(db);
  const row = await db.prepare("SELECT * FROM pending_approvals WHERE id=? AND domain='marketing'").bind(input.approvalId).first<Row>();
  if (!row) throw new Response("Marketing approval not found", { status: 404 });
  if (text(row.status) !== "pending") throw new Response("Marketing approval is no longer pending", { status: 409 });
  if (text(row.requested_by).toLowerCase() === text(input.founderActor).toLowerCase()) throw new Response("Requester cannot approve their own marketing mutation", { status: 403 });
  const now = Date.now();
  if (input.decision === "approved") {
    await db.prepare("UPDATE pending_approvals SET status='approved',approved_by=?,approved_at=?,decision_note=?,updated_at=? WHERE id=? AND status='pending'")
      .bind(text(input.founderActor), now, text(input.note), now, input.approvalId).run();
  } else {
    await db.prepare("UPDATE pending_approvals SET status='rejected',rejected_by=?,rejected_at=?,decision_note=?,updated_at=? WHERE id=? AND status='pending'")
      .bind(text(input.founderActor), now, text(input.note), now, input.approvalId).run();
  }
  return { id: input.approvalId, status: input.decision };
}

async function assertApprovedPayload(db: Db, approvalId: string, expectedTool: string, payload: Record<string, unknown>) {
  const row = await db.prepare("SELECT * FROM pending_approvals WHERE id=? AND domain='marketing'").bind(approvalId).first<Row>();
  if (!row || text(row.status) !== "approved" || !text(row.approved_by) || !Number(row.approved_at)) throw new Response("Explicit Founder approval is required", { status: 403 });
  if (text(row.tool_name) !== expectedTool) throw new Response("Approval does not authorize this tool", { status: 403 });
  const payloadJson = stableJson(payload);
  const payloadHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payloadJson)).then(buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join(""));
  if (payloadHash !== text(row.payload_hash)) throw new Response("Approved payload does not match mutation payload", { status: 409 });
  if (row.executed_at) throw new Response("Approval has already been consumed", { status: 409 });
  return row;
}

async function assertBudgetEnvelope(db: Db, input: { platform: MarketingAdPlatform; accountId: string; resourceId: string; proposedDailyMinor: number }) {
  await ensureMarketingAgentGatewayTables(db);
  const now = Date.now();
  const envelope = await db.prepare("SELECT * FROM gce_budget_envelopes WHERE platform=? AND account_id=? AND status='active' AND (resource_id IS NULL OR resource_id=?) AND effective_from<=? AND (effective_to IS NULL OR effective_to>=?) ORDER BY CASE WHEN resource_id=? THEN 0 ELSE 1 END,daily_limit_minor ASC LIMIT 1")
    .bind(input.platform, input.accountId, input.resourceId, now, now, input.resourceId).first<Row>();
  if (!envelope) throw new Response("No active Founder-approved budget envelope", { status: 403 });
  if (int(input.proposedDailyMinor) > int(envelope.daily_limit_minor)) throw new Response("Proposed daily spend exceeds Founder-approved budget envelope", { status: 422 });
  return envelope;
}

export async function marketingAdsReadMetrics(db: Db, input: { from: string; to: string; platform?: MarketingAdPlatform; campaignId?: string }) {
  const rows = await listMarketingAdMetrics(db, { from: input.from, to: input.to, platform: input.platform, limit: 5000 });
  const filtered = input.campaignId ? rows.filter((row: Row) => text(row.campaign_id) === input.campaignId) : rows;
  const spend = filtered.reduce((s: number, r: Row) => s + int(r.spend_minor), 0);
  const conversions = filtered.reduce((s: number, r: Row) => s + Number(r.conversions || 0), 0);
  const revenue = filtered.reduce((s: number, r: Row) => s + int(r.conversion_value_minor), 0);
  const clicks = filtered.reduce((s: number, r: Row) => s + int(r.clicks), 0);
  return { rows: filtered, roas: spend > 0 ? revenue / spend : 0, cpaMinor: conversions > 0 ? Math.round(spend / conversions) : 0, cpcMinor: clicks > 0 ? Math.round(spend / clicks) : 0 };
}

export async function marketingSearchTermsAnalyze(db: Db, input: { from: string; to: string; campaignId?: string; minSpendMinor?: number; minClicks?: number }) {
  const rows = await listMarketingAdMetrics(db, { from: input.from, to: input.to, platform: "google_ads", limit: 5000 });
  return rows.filter((row: Row) => text(row.search_term) && (!input.campaignId || text(row.campaign_id) === input.campaignId) && int(row.spend_minor) >= int(input.minSpendMinor) && int(row.clicks) >= int(input.minClicks))
    .map((row: Row) => ({ searchTerm: text(row.search_term), campaignId: text(row.campaign_id), spendMinor: int(row.spend_minor), clicks: int(row.clicks), conversions: Number(row.conversions || 0), cpaMinor: int(row.cpa_minor), recommendNegative: int(row.spend_minor) > 0 && Number(row.conversions || 0) === 0 }));
}

export async function marketingBudgetReallocate(db: Db, runtime: Runtime, input: { approvalId: string; platform: MarketingAdPlatform; accountId: string; fromResourceId: string; toResourceId: string; fromDailyMinor: number; toDailyMinor: number; shiftMinor: number; reason: string; actor: string; fetchImpl?: Fetcher }) {
  const payload = { platform: input.platform, accountId: input.accountId, fromResourceId: input.fromResourceId, toResourceId: input.toResourceId, fromDailyMinor: int(input.fromDailyMinor), toDailyMinor: int(input.toDailyMinor), shiftMinor: int(input.shiftMinor), reason: text(input.reason) };
  const approval = await assertApprovedPayload(db, input.approvalId, "marketing.ads.budget.reallocate", payload);
  const nextFrom = Math.max(0, payload.fromDailyMinor - payload.shiftMinor), nextTo = payload.toDailyMinor + payload.shiftMinor;
  await assertBudgetEnvelope(db, { platform: input.platform, accountId: input.accountId, resourceId: input.toResourceId, proposedDailyMinor: nextTo });
  await mutateMarketingAdResource(db, runtime, { platform: input.platform, mutationType: "budget", resourceId: input.fromResourceId, amountMinor: nextFrom, actor: input.actor, reason: input.reason, fetchImpl: input.fetchImpl });
  const result = await mutateMarketingAdResource(db, runtime, { platform: input.platform, mutationType: "budget", resourceId: input.toResourceId, amountMinor: nextTo, actor: input.actor, reason: input.reason, fetchImpl: input.fetchImpl });
  const now = Date.now();
  await db.prepare("UPDATE pending_approvals SET status='executed',executed_at=?,execution_id=?,updated_at=? WHERE id=? AND status='approved'").bind(now, text((result as Row).id) || uid("MAE"), now, input.approvalId).run();
  return { approvalId: input.approvalId, approvedBy: text(approval.approved_by), fromDailyMinor: nextFrom, toDailyMinor: nextTo, result };
}

export async function marketingKeywordMutate(db: Db, runtime: Runtime, input: { approvalId: string; platform: MarketingAdPlatform; accountId: string; campaignId: string; keyword: string; operation: "add_negative" | "pause" | "enable"; amountMinor?: number; reason: string; actor: string; fetchImpl?: Fetcher }) {
  const payload = { platform: input.platform, accountId: input.accountId, campaignId: input.campaignId, keyword: text(input.keyword), operation: input.operation, amountMinor: int(input.amountMinor), reason: text(input.reason) };
  await assertApprovedPayload(db, input.approvalId, "marketing.ads.keyword.mutate", payload);
  if (input.amountMinor) await assertBudgetEnvelope(db, { platform: input.platform, accountId: input.accountId, resourceId: input.campaignId, proposedDailyMinor: int(input.amountMinor) });
  if (input.platform !== "google_ads") throw new Response("Keyword mutation is only supported for Google Ads", { status: 422 });
  const now = Date.now();
  await db.prepare("UPDATE pending_approvals SET status='executed',executed_at=?,execution_id=?,updated_at=? WHERE id=? AND status='approved'").bind(now, uid("MAK"), now, input.approvalId).run();
  return { approvalId: input.approvalId, campaignId: input.campaignId, keyword: input.keyword, operation: input.operation, providerMutationRequired: true };
}
