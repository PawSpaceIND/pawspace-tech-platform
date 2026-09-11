import { authError, authorize, database, resolveActor, securityAudit } from "../../../../lib/server-auth";
import { requireFounderRole } from "../../../../lib/intelligence/atlas-data";
import {
  MARKETING_TOOL_SCHEMAS,
  ensureMarketingAgentGatewayTables,
  founderDecideMarketingProposal,
  marketingAdsReadMetrics,
  marketingBudgetReallocate,
  marketingKeywordMutate,
  marketingSearchTermsAnalyze,
  submitMarketingProposal,
} from "../../../../lib/marketing-agent-gateway";
import type { MarketingAdPlatform } from "../../../../lib/marketing-ad-connectors";

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
const sameOrigin = (request: Request) => { const origin = request.headers.get("origin"); if (origin && origin !== new URL(request.url).origin) throw new Response("Cross-origin marketing agent write blocked", { status: 403 }); };
const text = (value: unknown) => String(value ?? "").trim();
async function runtime() { const { env } = await import("cloudflare:workers"); return env as unknown as Record<string, unknown>; }

export async function GET(request: Request) {
  try {
    await authorize(request, "marketing.view");
    const db = await database();
    await ensureMarketingAgentGatewayTables(db);
    const pending = await db.prepare("SELECT id,tool_name,platform,why_text,status,requested_by,requested_at,approved_by,approved_at,executed_at,execution_id FROM pending_approvals WHERE domain='marketing' ORDER BY requested_at DESC LIMIT 100").all();
    const envelopes = await db.prepare("SELECT id,platform,account_id,resource_id,daily_limit_minor,currency,status,effective_from,effective_to,approved_by,approved_at FROM gce_budget_envelopes WHERE status='active' ORDER BY platform,account_id,resource_id").all();
    return json({ data: { toolSchemas: MARKETING_TOOL_SCHEMAS, approvalMode: "approval_required", pendingApprovals: pending.results, budgetEnvelopes: envelopes.results, autonomousMutation: false } });
  } catch (error) { return authError(error, "Unable to load Head of Marketing gateway"); }
}

export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const body = await request.json() as Record<string, unknown>;
    const action = text(body.action);
    const db = await database();
    await ensureMarketingAgentGatewayTables(db);

    if (action === "marketing.ads.read_metrics") {
      await authorize(request, "marketing.view");
      return json({ data: await marketingAdsReadMetrics(db, { from: text(body.from), to: text(body.to), platform: body.platform as MarketingAdPlatform | undefined, campaignId: text(body.campaignId) || undefined }) });
    }
    if (action === "marketing.ads.search_terms.analyze") {
      await authorize(request, "marketing.view");
      return json({ data: await marketingSearchTermsAnalyze(db, { from: text(body.from), to: text(body.to), campaignId: text(body.campaignId) || undefined, minSpendMinor: Number(body.minSpendMinor || 0), minClicks: Number(body.minClicks || 0) }) });
    }
    if (action === "marketing.proposal.submit") {
      const actor = await authorize(request, "marketing.manage");
      const toolName = text(body.toolName);
      if (!["marketing.ads.budget.reallocate", "marketing.ads.keyword.mutate"].includes(toolName)) return json({ error: "Only governed marketing mutation tools may be proposed" }, 400);
      if (!["google_ads", "meta_ads"].includes(text(body.platform)) || !text(body.why) || !body.payload || typeof body.payload !== "object") return json({ error: "platform, why and exact payload are required" }, 400);
      const data = await submitMarketingProposal(db, { toolName: toolName as "marketing.ads.budget.reallocate" | "marketing.ads.keyword.mutate", platform: body.platform as MarketingAdPlatform, why: text(body.why), payload: body.payload as Record<string, unknown>, requestedBy: actor.email });
      await securityAudit(db, actor, "marketing.proposal.submit", "pending_approval", data.id, "completed", { toolName, platform: body.platform, payloadHash: data.payloadHash, externalMutation: false, approvalRequired: true });
      return json({ data }, 201);
    }

    const founder = requireFounderRole(await resolveActor(request));
    if (action === "marketing.proposal.decide") {
      const decision = text(body.decision);
      if (!body.approvalId || !["approved", "rejected"].includes(decision)) return json({ error: "approvalId and approved/rejected decision are required" }, 400);
      const data = await founderDecideMarketingProposal(db, { approvalId: text(body.approvalId), decision: decision as "approved" | "rejected", founderActor: founder.email, note: text(body.note) });
      await securityAudit(db, founder, `marketing.proposal.${decision}`, "pending_approval", text(body.approvalId), "completed", { explicitFounderApproval: decision === "approved" });
      return json({ data });
    }
    if (action === "marketing.budget_envelope.upsert") {
      const platform = text(body.platform), accountId = text(body.accountId), resourceId = text(body.resourceId), dailyLimitMinor = Math.trunc(Number(body.dailyLimitMinor));
      if (!['google_ads','meta_ads'].includes(platform) || !accountId || !Number.isFinite(dailyLimitMinor) || dailyLimitMinor < 0) return json({ error: "platform, accountId and non-negative dailyLimitMinor are required" }, 400);
      const now = Date.now(), id = text(body.id) || `GBE-${crypto.randomUUID().slice(0,12).toUpperCase()}`;
      await db.prepare("INSERT INTO gce_budget_envelopes (id,platform,account_id,resource_id,daily_limit_minor,currency,status,effective_from,effective_to,approved_by,approved_at,created_at,updated_at) VALUES (?,?,?,?,?,'INR','active',?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET platform=excluded.platform,account_id=excluded.account_id,resource_id=excluded.resource_id,daily_limit_minor=excluded.daily_limit_minor,status='active',effective_from=excluded.effective_from,effective_to=excluded.effective_to,approved_by=excluded.approved_by,approved_at=excluded.approved_at,updated_at=excluded.updated_at")
        .bind(id, platform, accountId, resourceId || null, dailyLimitMinor, Number(body.effectiveFrom || now), body.effectiveTo == null ? null : Number(body.effectiveTo), founder.email, now, now, now).run();
      await securityAudit(db, founder, "marketing.budget_envelope.upsert", "gce_budget_envelope", id, "completed", { platform, accountId, resourceId: resourceId || null, dailyLimitMinor });
      return json({ data: { id, platform, accountId, resourceId: resourceId || null, dailyLimitMinor, approvedBy: founder.email } });
    }
    if (action === "marketing.ads.budget.reallocate") {
      const data = await marketingBudgetReallocate(db, await runtime(), { approvalId: text(body.approvalId), platform: body.platform as MarketingAdPlatform, accountId: text(body.accountId), fromResourceId: text(body.fromResourceId), toResourceId: text(body.toResourceId), fromDailyMinor: Number(body.fromDailyMinor), toDailyMinor: Number(body.toDailyMinor), shiftMinor: Number(body.shiftMinor), reason: text(body.reason), actor: founder.email });
      await securityAudit(db, founder, "marketing.ads.budget.reallocate", String(body.platform), text(body.approvalId), "completed", { explicitFounderApproval: true, budgetEnvelopeValidated: true });
      return json({ data });
    }
    if (action === "marketing.ads.keyword.mutate") {
      const data = await marketingKeywordMutate(db, await runtime(), { approvalId: text(body.approvalId), platform: body.platform as MarketingAdPlatform, accountId: text(body.accountId), campaignId: text(body.campaignId), adGroupId: text(body.adGroupId), criterionId: text(body.criterionId) || undefined, keyword: text(body.keyword), operation: body.operation as "add_negative" | "pause" | "enable", matchType: body.matchType as "EXACT" | "PHRASE" | "BROAD" | undefined, currentDailyMinor: Number(body.currentDailyMinor), reason: text(body.reason), actor: founder.email });
      await securityAudit(db, founder, "marketing.ads.keyword.mutate", "google_ads", text(body.approvalId), "completed", { explicitFounderApproval: true, budgetEnvelopeValidated: true });
      return json({ data });
    }
    return json({ error: "Unsupported Head of Marketing action" }, 400);
  } catch (error) {
    if (error instanceof Response) return json({ error: await error.text() }, error.status);
    return authError(error, "Unable to execute Head of Marketing gateway action");
  }
}
