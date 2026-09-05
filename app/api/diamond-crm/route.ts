import { authError, authorize, database } from "../../../lib/server-auth";
import { advanceOpportunityStage, buildProbabilisticForecast, ensureCrmPipelineTables, syncOpenLeadPipeline } from "../../../lib/crm-pipeline-forecast";
import { ensureLeadScoringMergeTables, executeCustomerMerge, refreshLeadScores, scoreLead } from "../../../lib/crm-lead-scoring-merge";
import { ensureCrmEmailTables, syncCalendarEvents } from "../../../lib/crm-email-sync";
import { dispatchReportExportDeliveries, ensureReportExportTables, processReportExportJobs, queueReportExport, runScheduledReportExports } from "../../../lib/report-export-runtime";
import { aiProviderConnection, verifyAiProvider } from "../../../lib/ai-provider-adapter";

type Row = Record<string, unknown>;
const text = (v: unknown) => String(v ?? "").trim();
const rows = <T = Row>(r: { results?: unknown[] }) => (r.results ?? []) as T[];

async function runtimeEnv() {
  try { const { env } = await import("cloudflare:workers"); return env as unknown as Record<string, unknown>; }
  catch { return {}; }
}

async function ensureAll(db: D1Database) {
  await Promise.all([ensureCrmPipelineTables(db), ensureLeadScoringMergeTables(db), ensureCrmEmailTables(db), ensureReportExportTables(db)]);
}

export async function GET(request: Request) {
  try {
    await authorize(request, "customers.view");
    const db = await database(); await ensureAll(db);
    const url = new URL(request.url), mode = url.searchParams.get("mode") || "overview";
    if (mode === "pipeline") {
      const items = rows(await db.prepare("SELECT o.*,s.total_score lead_score,s.grade lead_grade FROM crm_opportunities o LEFT JOIN lead_scores s ON s.lead_id=o.lead_id ORDER BY CASE o.stage WHEN 'committed' THEN 1 WHEN 'negotiation' THEN 2 WHEN 'proposal' THEN 3 WHEN 'discovery' THEN 4 WHEN 'qualified' THEN 5 ELSE 6 END,o.stage_probability DESC,o.updated_at DESC LIMIT 500").all<Row>());
      return Response.json({ items });
    }
    if (mode === "forecast") return Response.json({ forecast: await buildProbabilisticForecast(db, { actorId: "read:diamond-crm", persist: false }) });
    if (mode === "lead_score") {
      const leadId = text(url.searchParams.get("leadId")); if (!leadId) throw new Response("leadId is required", { status: 400 });
      const score = await db.prepare("SELECT * FROM lead_scores WHERE lead_id=?").bind(leadId).first<Row>(); return Response.json({ score });
    }
    if (mode === "export") {
      const jobId = text(url.searchParams.get("jobId")); if (!jobId) throw new Response("jobId is required", { status: 400 });
      const job = await db.prepare("SELECT id,report_type,format,status,requested_by,requested_at,started_at,completed_at,error,mime_type,file_name,row_count,content_base64 FROM report_export_jobs WHERE id=?").bind(jobId).first<Row>();
      if (!job) throw new Response("Export job not found", { status: 404 });
      return Response.json({ job });
    }
    if (mode === "ai_readiness") return Response.json({ ai: await aiProviderConnection() });
    const [pipeline, scoreSummary, exports, emailEvents, ai] = await Promise.all([
      db.prepare("SELECT stage,status,COUNT(*) count,COALESCE(SUM(amount),0) value,COALESCE(SUM(amount*stage_probability),0) weighted FROM crm_opportunities GROUP BY stage,status ORDER BY stage").all<Row>(),
      db.prepare("SELECT grade,COUNT(*) count,ROUND(AVG(total_score),1) average_score FROM lead_scores GROUP BY grade ORDER BY grade").all<Row>(),
      db.prepare("SELECT status,COUNT(*) count FROM report_export_jobs GROUP BY status").all<Row>(),
      db.prepare("SELECT event_type,COUNT(*) count FROM crm_email_events GROUP BY event_type").all<Row>(),
      aiProviderConnection(),
    ]);
    return Response.json({ pipeline: pipeline.results, leadScores: scoreSummary.results, exports: exports.results, emailEvents: emailEvents.results, ai });
  } catch (error) { return authError(error, "Unable to load Diamond CRM"); }
}

export async function POST(request: Request) {
  try {
    const actor = await authorize(request, "customers.manage");
    const db = await database(); await ensureAll(db);
    const body = await request.json() as Record<string, unknown>, action = text(body.action);
    if (action === "sync_pipeline") return Response.json(await syncOpenLeadPipeline(db, { actorId: actor.email, limit: Number(body.limit || 300) }));
    if (action === "advance_stage") return Response.json(await advanceOpportunityStage(db, {
      opportunityId: text(body.opportunityId), stage: text(body.stage) as never, actorId: actor.email, reason: text(body.reason),
      amount: body.amount == null ? undefined : Number(body.amount), wonBookingId: body.wonBookingId == null ? null : text(body.wonBookingId), lostReason: body.lostReason == null ? null : text(body.lostReason),
    }));
    if (action === "score_lead") return Response.json(await scoreLead(db, text(body.leadId)));
    if (action === "refresh_scores") return Response.json(await refreshLeadScores(db, Number(body.limit || 300)));
    if (action === "merge_customer") return Response.json(await executeCustomerMerge(db, { primaryCustomerId: text(body.primaryCustomerId), duplicateCustomerId: text(body.duplicateCustomerId), actorId: actor.email, reason: text(body.reason) }));
    if (action === "queue_export") return Response.json(await queueReportExport(db, { reportType: text(body.reportType), format: text(body.format) as "csv" | "pdf", filters: (body.filters || {}) as Record<string, unknown>, actorId: actor.email }), { status: 202 });
    if (action === "process_exports") return Response.json(await processReportExportJobs(db, { limit: Number(body.limit || 10) }));
    if (action === "run_scheduled_exports") {
      const queued = await runScheduledReportExports(db, { actorId: actor.email });
      const processed = await processReportExportJobs(db, { limit: 50 });
      const delivered = await dispatchReportExportDeliveries(db, await runtimeEnv(), { limit: 50 });
      return Response.json({ queued, processed, delivered });
    }
    if (action === "create_export_schedule") {
      const cadence = text(body.cadence); if (!["daily", "weekly", "monthly"].includes(cadence)) throw new Response("cadence must be daily, weekly, or monthly", { status: 400 });
      const format = text(body.format); if (!["csv", "pdf"].includes(format)) throw new Response("format must be csv or pdf", { status: 400 });
      const now = Date.now(), id = `EXPS-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
      await db.prepare("INSERT INTO report_export_schedules (id,report_type,format,filters_json,recipients_json,delivery_channels_json,cadence,next_run_at,active,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,1,?,?,?)")
        .bind(id, text(body.reportType), format, JSON.stringify(body.filters || {}), JSON.stringify(body.recipients || []), JSON.stringify(body.deliveryChannels || ["dashboard"]), cadence, Number(body.nextRunAt || now), actor.email, now, now).run();
      return Response.json({ id, status: "active" }, { status: 201 });
    }
    if (action === "calendar_sync") return Response.json(await syncCalendarEvents(db, { provider: text(body.provider) || "calendar_provider", events: Array.isArray(body.events) ? body.events as never[] : [] }));
    if (action === "verify_ai_provider") return Response.json({ ai: await verifyAiProvider() });
    throw new Response("Unsupported Diamond CRM action", { status: 400 });
  } catch (error) { return authError(error, "Unable to execute Diamond CRM action"); }
}
