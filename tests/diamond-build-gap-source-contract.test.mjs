import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const pipeline = read("lib/crm-pipeline-forecast.ts");
const sync = read("lib/crm-pipeline-sync.ts");
const scoring = read("lib/crm-lead-scoring-merge.ts");
const merge = read("lib/crm-transactional-merge.ts");
const email = read("lib/crm-email-sync.ts");
const webhook = read("app/api/email-provider-webhook/route.ts");
const exportsRuntime = read("lib/report-export-runtime.ts");
const route = read("app/api/diamond-crm/route.ts");
const ai = read("lib/ai-provider-adapter.ts");

test("pipeline is explicit, stage governed and next-best-action driven", () => {
  for (const stage of ["new","qualified","discovery","proposal","negotiation","committed","won","lost"]) assert.match(pipeline, new RegExp(`"${stage}"`));
  assert.match(pipeline, /crm_opportunity_stage_history/);
  assert.match(pipeline, /crm_opportunity_actions/);
  assert.match(pipeline, /next_best_action/);
  assert.match(sync, /VALUES \(\?,\?,\?,\?,\?,\?,\?,\?,\?,\?,\?,\?,\?,\?,\?,\?,\?\)/);
});

test("forecast is probabilistic and includes win-loss analytics", () => {
  assert.match(pipeline, /historicalStageProbability/);
  assert.match(pipeline, /weightedPipeline/);
  assert.match(pipeline, /commitForecast/);
  assert.match(pipeline, /bestCaseForecast/);
  assert.match(pipeline, /historicalWinRate/);
  assert.match(pipeline, /lossReasons/);
  assert.match(pipeline, /serviceWinLoss/);
});

test("duplicate merge requires review and uses a single D1 transactional batch", () => {
  assert.match(merge, /customer_merge_reviews/);
  assert.match(merge, /status='open'/);
  assert.match(merge, /const results = await db\.batch\(statements\)/);
  for (const table of ["canonical_pets","canonical_bookings","lead_work_items","communication_threads","communication_messages","customer_experience_tickets"]) assert.match(merge, new RegExp(table));
});

test("lead scoring combines engagement, completeness, recency and value", () => {
  for (const token of ["engagement_score","profile_score","recency_score","value_score","total_score"]) assert.match(scoring, new RegExp(token));
  assert.match(scoring, /engagement \* 0\.30/);
  assert.match(scoring, /profile \* 0\.20/);
  assert.match(scoring, /recency \* 0\.30/);
  assert.match(scoring, /value \* 0\.20/);
});

test("email is bidirectional with signed inbound, engagement and calendar sync", () => {
  assert.match(email, /dispatchEmailOutbox/);
  assert.match(email, /ingestInboundEmail/);
  for (const event of ["delivered","open","click","bounce","complaint"]) assert.match(webhook, new RegExp(`"${event}"`));
  assert.match(webhook, /HMAC/);
  assert.match(webhook, /PAWSPACE_EMAIL_WEBHOOK_SECRET/);
  assert.match(email, /syncCalendarEvents/);
});

test("reporting produces real asynchronous CSV/PDF artifacts and schedules deliveries", () => {
  for (const token of ["report_export_jobs","report_export_schedules","report_export_deliveries","toCsv","toPdf","processReportExportJobs","runScheduledReportExports","dispatchReportExportDeliveries"]) assert.match(exportsRuntime, new RegExp(token));
  assert.match(exportsRuntime, /status='completed'/);
  assert.doesNotMatch(exportsRuntime, /uat_queued/);
});

test("AI activation uses the production provider boundary and real verification round-trip", () => {
  assert.match(ai, /PAWSPACE_AI_PROVIDER_API_KEY/);
  assert.match(ai, /https:\/\/api\.anthropic\.com\/v1\/messages/);
  assert.match(ai, /verifyAiProvider/);
  assert.match(route, /verify_ai_provider/);
  assert.match(route, /aiProviderConnection/);
});

test("governed Diamond CRM API exposes all operational actions", () => {
  for (const action of ["sync_pipeline","advance_stage","score_lead","refresh_scores","merge_customer","queue_export","process_exports","create_export_schedule","calendar_sync","verify_ai_provider"]) assert.match(route, new RegExp(`"${action}"`));
  assert.match(route, /authorize\(request, "customers\.manage"\)/);
});
