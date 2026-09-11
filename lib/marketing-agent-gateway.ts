import { listMarketingAdMetrics, mutateMarketingAdResource, type MarketingAdPlatform } from "./marketing-ad-connectors";
import { ensureGoalContextTables } from "./goal-context-engine";

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
    required: ["approvalId", "platform", "accountId", "fromResourceId", "toResourceId", "fromDailyMinor", "toDailyMinor", "shiftMinor", "reason"],
    properties: {
      approvalId: { type: "string", minLength: 1 },
      platform: { enum: ["google_ads", "meta_ads"] },
      accountId: { type: "string", minLength: 1 },
      fromResourceId: { type: "string", minLength: 1 },
      toResourceId: { type: "string", minLength: 1 },
      fromDailyMinor: { type: "integer", minimum: 1 },
      toDailyMinor: { type: "integer", minimum: 1 },
      shiftMinor: { type: "integer", minimum: 1 },
      reason: { type: "string", minLength: 10, maxLength: 1000 },
    },
  },
  "marketing.ads.keyword.mutate": {
    type: "object",
    additionalProperties: false,
    required: ["approvalId", "platform", "accountId", "campaignId", "adGroupId", "keyword", "operation", "currentDailyMinor", "reason"],
    properties: {
      approvalId: { type: "string", minLength: 1 },
      platform: { const: "google_ads" },
      accountId: { type: "string", minLength: 1 },
      campaignId: { type: "string", minLength: 1 },
      adGroupId: { type: "string", minLength: 1 },
      criterionId: { type: "string", minLength: 1 },
      keyword: { type: "string", minLength: 1, maxLength: 200 },
      operation: { enum: ["add_negative", "pause", "enable"] },
      matchType: { enum: ["EXACT", "PHRASE", "BROAD"], default: "EXACT" },
      currentDailyMinor: { type: "integer", minimum: 1 },
      reason: { type: "string", minLength: 10, maxLength: 1000 },
    },
  },
  "marketing.proposal.submit": {
    type: "object",
    additionalProperties: false,
    required: ["toolName", "platform", "why", "payload"],
    properties: {
      toolName: { enum: ["marketing.ads.budget.reallocate", "marketing.ads.keyword.mutate"] },
      platform: { enum: ["google_ads", "meta_ads"] },
      why: { type: "string", minLength: 20, maxLength: 4000 },
      payload: { type: "object" },
    },
  },
} as const;

const text = (v: unknown) => String(v ?? "").trim();
const int = (v: unknown) => Math.max(0, Math.trunc(Number(v) || 0));
const uid = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => [k, canonical(v)]));
  return value;
}
const stableJson = (value: unknown) => JSON.stringify(canonical(value));

export async function ensureMarketingAgentGatewayTables(db: Db) {
  await ensureGoalContextTables(db);
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS gce_marketing_budget_bindings (envelope_id TEXT PRIMARY KEY,platform TEXT NOT NULL,account_id TEXT NOT NULL,resource_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,FOREIGN KEY(envelope_id) REFERENCES gce_budget_envelopes(id) ON DELETE CASCADE)"),
    db.prepare("CREATE INDEX IF NOT EXISTS gce_marketing_budget_bindings_lookup_idx ON gce_marketing_budget_bindings(platform,account_id,resource_id)"),
    db.prepare("CREATE TABLE IF NOT EXISTS pending_approvals (id TEXT PRIMARY KEY,domain TEXT NOT NULL,tool_name TEXT NOT NULL,platform TEXT NOT NULL,why_text TEXT NOT NULL,payload_json TEXT NOT NULL,payload_hash TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',requested_by TEXT NOT NULL,requested_at INTEGER NOT NULL,approved_by TEXT,approved_at INTEGER,rejected_by TEXT,rejected_at INTEGER,decision_note TEXT,executed_at INTEGER,execution_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS pending_approvals_status_idx ON pending_approvals(domain,status,requested_at)"),
  ]);
}

export async function upsertMarketingBudgetEnvelope(db: Db, input: { id?: string; platform: MarketingAdPlatform; accountId: string; resourceId?: string; dailyLimitMinor: number; effectiveFrom?: number; effectiveTo?: number | null; founderActor: string }) {
  await ensureMarketingAgentGatewayTables(db);
  const now = Date.now();
  const id = text(input.id) || uid("GBE");
  const existing = await db.prepare("SELECT budget_type FROM gce_budget_envelopes WHERE id=?").bind(id).first<Row>();
  if (existing && text(existing.budget_type) !== "marketing_spend") throw new Response("Envelope id belongs to a non-marketing Goal Context budget", { status: 409 });
  const start = Number(input.effectiveFrom ?? now);
  const end = input.effectiveTo == null ? null : Number(input.effectiveTo);
  const limit = int(input.dailyLimitMinor);
  const founder = text(input.founderActor);
  await db.batch([
    db.prepare("INSERT INTO gce_budget_envelopes (id,goal_id,budget_type,currency,period_type,hard_limit_paise,soft_limit_paise,consumed_paise,starts_at,ends_at,status,approved_by,approved_at,created_by,created_at,updated_at) VALUES (?,NULL,'marketing_spend','INR','daily',?,NULL,0,?,?,'active',?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET budget_type='marketing_spend',currency='INR',period_type='daily',hard_limit_paise=excluded.hard_limit_paise,starts_at=excluded.starts_at,ends_at=excluded.ends_at,status='active',approved_by=excluded.approved_by,approved_at=excluded.approved_at,updated_at=excluded.updated_at")
      .bind(id, limit, start, end, founder, now, founder, now, now),
    db.prepare("INSERT INTO gce_marketing_budget_bindings (envelope_id,platform,account_id,resource_id,created_at,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(envelope_id) DO UPDATE SET platform=excluded.platform,account_id=excluded.account_id,resource_id=excluded.resource_id,updated_at=excluded.updated_at")
      .bind(id, input.platform, text(input.accountId), text(input.resourceId) || null, now, now),
  ]);
  return { id, platform: input.platform, accountId: text(input.accountId), resourceId: text(input.resourceId) || null, dailyLimitMinor: limit, approvedBy: founder };
}

export async function listMarketingBudgetEnvelopes(db: Db) {
  await ensureMarketingAgentGatewayTables(db);
  const rows = await db.prepare("SELECT e.id,b.platform,b.account_id,b.resource_id,e.hard_limit_paise AS daily_limit_minor,e.currency,e.status,e.starts_at AS effective_from,e.ends_at AS effective_to,e.approved_by,e.approved_at FROM gce_budget_envelopes e JOIN gce_marketing_budget_bindings b ON b.envelope_id=e.id WHERE e.budget_type='marketing_spend' AND e.status='active' ORDER BY b.platform,b.account_id,b.resource_id").all<Row>();
  return rows.results;
}

export async function submitMarketingProposal(db: Db, input: { toolName: "marketing.ads.budget.reallocate" | "marketing.ads.keyword.mutate"; platform: MarketingAdPlatform; why: string; payload: Record<string, unknown>; requestedBy: string }) {
  await ensureMarketingAgentGatewayTables(db);
  const id = uid("MAP");
  const now = Date.now();
  const payloadJson = stableJson(input.payload);
  const payloadHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payloadJson)).then(buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join(""));
  await db.prepare("INSERT INTO pending_approvals (id,domain,tool_name,platform,why_text,payload_json,payload_hash,status,requested_by,requested_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'pending',?,?,?,?)")
    .bind(id, "marketing", input.toolName, input.platform, text(input.why), payloadJson, payloadHash, text(input.requestedBy), now, now, now).run();
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

async function claimApproval(db: Db, approvalId: string) {
  const claim = await db.prepare("UPDATE pending_approvals SET status='executing',updated_at=? WHERE id=? AND status='approved' AND executed_at IS NULL").bind(Date.now(), approvalId).run();
  if (Number(claim.meta?.changes || 0) !== 1) throw new Response("Approval is already being executed or was consumed", { status: 409 });
}
async function finishApproval(db: Db, approvalId: string, executionId: string) {
  const now = Date.now();
  await db.prepare("UPDATE pending_approvals SET status='executed',executed_at=?,execution_id=?,updated_at=? WHERE id=? AND status='executing'").bind(now, executionId, now, approvalId).run();
}
async function failApprovalExecution(db: Db, approvalId: string, detail: string) {
  await db.prepare("UPDATE pending_approvals SET status='execution_failed',decision_note=COALESCE(decision_note,'') || ?,updated_at=? WHERE id=? AND status='executing'").bind(` | execution_failed:${detail.slice(0,180)}`, Date.now(), approvalId).run();
}

async function assertBudgetEnvelope(db: Db, input: { platform: MarketingAdPlatform; accountId: string; resourceId: string; proposedDailyMinor: number }) {
  await ensureMarketingAgentGatewayTables(db);
  const now = Date.now();
  const envelope = await db.prepare("SELECT e.*,b.platform,b.account_id,b.resource_id,e.hard_limit_paise AS daily_limit_minor FROM gce_budget_envelopes e JOIN gce_marketing_budget_bindings b ON b.envelope_id=e.id WHERE e.budget_type='marketing_spend' AND b.platform=? AND b.account_id=? AND e.status='active' AND e.approved_by IS NOT NULL AND e.approved_at IS NOT NULL AND (b.resource_id IS NULL OR b.resource_id=?) AND e.starts_at<=? AND (e.ends_at IS NULL OR e.ends_at>=?) ORDER BY CASE WHEN b.resource_id=? THEN 0 ELSE 1 END,e.hard_limit_paise ASC LIMIT 1")
    .bind(input.platform, input.accountId, input.resourceId, now, now, input.resourceId).first<Row>();
  if (!envelope) throw new Response("No active Founder-approved budget envelope", { status: 403 });
  if (int(input.proposedDailyMinor) > int(envelope.hard_limit_paise)) throw new Response("Proposed daily spend exceeds Founder-approved budget envelope", { status: 422 });
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
  if (payload.shiftMinor >= payload.fromDailyMinor) throw new Response("Budget shift must leave a positive source daily budget", { status: 422 });
  const nextFrom = payload.fromDailyMinor - payload.shiftMinor, nextTo = payload.toDailyMinor + payload.shiftMinor;
  await assertBudgetEnvelope(db, { platform: input.platform, accountId: input.accountId, resourceId: input.fromResourceId, proposedDailyMinor: nextFrom });
  await assertBudgetEnvelope(db, { platform: input.platform, accountId: input.accountId, resourceId: input.toResourceId, proposedDailyMinor: nextTo });
  await claimApproval(db, input.approvalId);
  try {
    const fromResult = await mutateMarketingAdResource(db, runtime, { platform: input.platform, mutationType: "budget", resourceId: input.fromResourceId, amountMinor: nextFrom, actor: input.actor, reason: input.reason, fetchImpl: input.fetchImpl });
    const result = await mutateMarketingAdResource(db, runtime, { platform: input.platform, mutationType: "budget", resourceId: input.toResourceId, amountMinor: nextTo, actor: input.actor, reason: input.reason, fetchImpl: input.fetchImpl });
    const executionId = text((result as Row).id) || uid("MAE");
    await finishApproval(db, input.approvalId, executionId);
    return { approvalId: input.approvalId, approvedBy: text(approval.approved_by), fromDailyMinor: nextFrom, toDailyMinor: nextTo, fromResult, result };
  } catch (error) {
    await failApprovalExecution(db, input.approvalId, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

export async function marketingKeywordMutate(db: Db, runtime: Runtime, input: { approvalId: string; platform: MarketingAdPlatform; accountId: string; campaignId: string; adGroupId: string; criterionId?: string; keyword: string; operation: "add_negative" | "pause" | "enable"; matchType?: "EXACT" | "PHRASE" | "BROAD"; currentDailyMinor: number; reason: string; actor: string; fetchImpl?: Fetcher }) {
  const payload = { platform: input.platform, accountId: input.accountId, campaignId: input.campaignId, adGroupId: input.adGroupId, criterionId: text(input.criterionId), keyword: text(input.keyword), operation: input.operation, matchType: input.matchType || "EXACT", currentDailyMinor: int(input.currentDailyMinor), reason: text(input.reason) };
  await assertApprovedPayload(db, input.approvalId, "marketing.ads.keyword.mutate", payload);
  await assertBudgetEnvelope(db, { platform: input.platform, accountId: input.accountId, resourceId: input.campaignId, proposedDailyMinor: payload.currentDailyMinor });
  if (input.platform !== "google_ads") throw new Response("Keyword mutation is only supported for Google Ads", { status: 422 });
  const customerId = text(runtime.GOOGLE_ADS_CUSTOMER_ID).replace(/[^0-9]/g, "");
  const developerToken = text(runtime.GOOGLE_ADS_DEVELOPER_TOKEN), accessToken = text(runtime.GOOGLE_ADS_OAUTH_ACCESS_TOKEN);
  const loginCustomerId = text(runtime.GOOGLE_ADS_LOGIN_CUSTOMER_ID).replace(/[^0-9]/g, "") || customerId;
  const version = /^v\d+(?:\.\d+)?$/.test(text(runtime.GOOGLE_ADS_API_VERSION)) ? text(runtime.GOOGLE_ADS_API_VERSION) : "v25";
  if (!customerId || !developerToken || !accessToken) throw new Error("Google Ads connector is not configured");
  if (!payload.keyword || !payload.adGroupId) throw new Response("Keyword and adGroupId are required", { status: 400 });
  if (payload.operation !== "add_negative" && !payload.criterionId) throw new Response("criterionId is required to pause or enable a keyword", { status: 400 });
  const headers: Record<string,string> = { "content-type": "application/json", authorization: `Bearer ${accessToken}`, "developer-token": developerToken };
  if (loginCustomerId) headers["login-customer-id"] = loginCustomerId;
  const resourceName = `customers/${customerId}/adGroupCriteria/${payload.adGroupId}~${payload.criterionId}`;
  const operation = payload.operation === "add_negative"
    ? { create: { adGroup: `customers/${customerId}/adGroups/${payload.adGroupId}`, negative: true, keyword: { text: payload.keyword, matchType: payload.matchType } } }
    : { update: { resourceName, status: payload.operation === "pause" ? "PAUSED" : "ENABLED" }, updateMask: "status" };
  await claimApproval(db, input.approvalId);
  try {
    const response = await (input.fetchImpl || fetch)(`https://googleads.googleapis.com/${version}/customers/${customerId}/adGroupCriteria:mutate`, { method: "POST", headers, body: JSON.stringify({ operations: [operation] }) });
    const raw = await response.text();
    if (!response.ok) throw new Error(`Google Ads keyword mutation failed (${response.status}): ${raw.slice(0,300)}`);
    let parsed: Record<string,unknown> = {}; try { parsed = raw ? JSON.parse(raw) : {}; } catch {}
    const executionId = text(response.headers.get("request-id")) || text(parsed.requestId) || uid("MAK");
    await finishApproval(db, input.approvalId, executionId);
    return { approvalId: input.approvalId, campaignId: input.campaignId, adGroupId: input.adGroupId, keyword: payload.keyword, operation: input.operation, status: "completed", externalMutation: true, providerRequestId: executionId };
  } catch (error) {
    await failApprovalExecution(db, input.approvalId, error instanceof Error ? error.message : String(error));
    throw error;
  }
}
