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
    const actor = await authorize(request, "marketing.manage");
    const body = await request.json() as Record<string, unknown>;
    const action = text(body.action);
    const db = await database();
    await ensureMarketingAgentGatewayTables(db);

    if (action === "marketing.ads.read_metrics") {
      return json({ data: await marketingAdsReadMetrics(db, { from: text(body.from), to: text(body.to), platform: body.platform as MarketingAdPlatform | undefined, campaignId: text(body.campaignId) || undefined }) });
    }
    if (action === "marketing.ads.search_terms.analyze") {
      return json({ data: await marketingSearchTermsAnalyze(db, { from: text(body.from), to: text(body.to), campaignId: text(body.campaignId) || undefined, minSpendMinor: Number(body.minSpendMinor || 0), minClicks: Number(body.minClicks || 0) }) });
    }
    if (action === "marketing.proposal.submit") {
      const toolName = text(body.toolName);
      if (!["marketing.ads.budget.reallocate", "marketing.ads.keyword.mutate"].includes(toolName)) return json({ error: "Only governed marketing mutation tools may be proposed" }, 400);
      if (!["google_ads", "meta_ads"].includes(text(body.platform)) || !text(body.why) || !body.payload || typeof body.payload !== "object") return json({ error: "platform, why and exact payload are required" }, 400);
      const data = await submitMarketingProposal(db, { toolName: toolName as "marketing.ads.budget.reallocate" | "marketing.ads.keyword.mutate", platform: body.platform as MarketingAdPlatform, why: text(body.why), payload: body.payload as Record<string, unknown>, requestedBy: actor.email });
      await securityAudit(db, actor, "marketing.proposal.submit", "pending_approval", data.id, "completed", { toolName, platform: body.platform, payloadHash: data.payloadHash, externalMutation: false, approvalRequired: true });
      return json({ data }, 201);
    }
    return json({ error: "Founder-only marketing mutations use /api/admin/marketing-agent/founder" }, 403);
  } catch (error) {
    if (error instanceof Response) return json({ error: await error.text() }, error.status);
    return authError(error, "Unable to execute Head of Marketing gateway action");
  }
}
