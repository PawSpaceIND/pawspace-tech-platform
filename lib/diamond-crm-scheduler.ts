import { buildProbabilisticForecast } from "./crm-pipeline-forecast";
import { syncLeadOpportunityPipeline } from "./crm-pipeline-sync";
import { refreshLeadScores } from "./crm-lead-scoring-merge";
import { dispatchEmailOutbox } from "./crm-email-sync";
import { dispatchReportExportDeliveries, processReportExportJobs, runScheduledReportExports } from "./report-export-runtime";
import { runOutboundOrchestrationSweep } from "./outbound-sweep";
import { runOutboundAiDispatchSweep } from "./outbound-ai-dispatch";

type Db = D1Database;
type Row = Record<string, unknown>;
async function tableExists(db: Db, name: string) { return Boolean(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(name).first<Row>()); }

export async function runDiamondCrmScheduledSweep(db: Db, env: Record<string, unknown>, input: { asOf?: number; actorId?: string } = {}) {
  const asOf = input.asOf ?? Date.now(), actorId = input.actorId || "system:diamond-crm-scheduler";
  const pipeline = await syncLeadOpportunityPipeline(db, { actorId, limit: 500 });
  const scoring = await refreshLeadScores(db, 500);
  // A cursor window continually walks the full customer base. Each open lead in the current window is
  // re-scored with PR #515 before routing, so the 40k+ backlog does not depend on the newest-500 refresh.
  const outboundRouting = await runOutboundOrchestrationSweep(db, { actorId, asOf, batchSize: 50 } as never);
  // AI execution is separate and fail-closed: canonical voice governance decides whether a call may dial.
  const outboundAi = await runOutboundAiDispatchSweep(db, env, { actorId, asOf, limit: 20 });
  const minute = new Date(asOf).getUTCMinutes();
  const forecast = await buildProbabilisticForecast(db, { actorId, persist: minute < 5 });
  const schedules = await runScheduledReportExports(db, { actorId, asOf });
  const exports = await processReportExportJobs(db, { limit: 25 });
  const reportDelivery = await dispatchReportExportDeliveries(db, env, { limit: 50 });
  const emailDelivery = await dispatchEmailOutbox(db, env, { limit: 50, asOf });
  let legacyReportsPromoted = 0;
  if (await tableExists(db, "command_report_runs")) {
    const promoted = await db.prepare("UPDATE command_report_runs SET status='generated' WHERE status='uat_queued'").run();
    legacyReportsPromoted = Number(promoted.meta?.changes || 0);
  }
  return { pipeline, scoring, outboundRouting, outboundAi, forecast, schedules, exports, reportDelivery, emailDelivery, legacyReportsPromoted };
}
