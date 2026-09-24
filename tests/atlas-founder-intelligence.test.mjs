import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
installWorkersHooks();
const { compileFinancialQuery } = await import("../lib/intelligence/financial-query-agent.ts");
import fs from "node:fs";

const query=fs.readFileSync("lib/intelligence/financial-query-agent.ts","utf8");
const data=fs.readFileSync("lib/intelligence/atlas-data.ts","utf8");
const ingest=fs.readFileSync("app/api/admin/tally-ingest/route.ts","utf8");
const chat=fs.readFileSync("app/api/admin/atlas-chat/route.ts","utf8");
const worker=fs.readFileSync("worker/index.ts","utf8");
const wrangler=fs.readFileSync("wrangler.toml","utf8");

test("Atlas financial memory is isolated from live finance ledgers",()=>{
 assert.match(data,/analytics_historical_financials/);
 assert.doesNotMatch(ingest,/INSERT INTO finance_|UPDATE finance_|DELETE FROM finance_/);
 assert.match(ingest,/liveLedgerMutation:false/);
});

test("Atlas text-to-SQL compiles only whitelisted SELECT analytics queries",()=>{
 const compiled=compileFinancialQuery({metrics:["revenue"],dimensions:["period_month"],filters:[],limit:25});assert.match(compiled.sql,/^SELECT/);assert.match(compiled.sql,/analytics_historical_financials/);
 assert.match(query,/Allowed table is analytics_historical_financials/);
 assert.match(query,/Never output SQL/);
 assert.match(query,/^export function compileFinancialQuery/m);
 assert.match(query,/INSERT\|UPDATE\|DELETE\|DROP\|ALTER\|CREATE\|ATTACH\|PRAGMA\|REPLACE\|VACUUM/);
 assert.match(query,/readOnly:true/);
});

test("Atlas routes require literal Founder RBAC instead of wildcard superuser",()=>{
 assert.match(data,/actor\.roleCode!=="founder"/);
 assert.match(ingest,/requireFounderRole/);
 assert.match(chat,/requireFounderRole/);
});

test("Tally ingestion is bounded, streamed for CSV, and writes 500-row governed batches",()=>{
 assert.match(ingest,/MAX_ROWS=100_000/);
 assert.match(ingest,/ROWS_PER_DB_BATCH=500/);
 assert.match(ingest,/csvRows\(request\.body\)/);
 assert.match(ingest,/MAX_XLSX_BYTES=25\*1024\*1024/);
});

test("Atlas campaign approval cannot bypass governed campaign approval/snapshot",()=>{
 assert.match(data,/activateCampaign/);
 assert.match(data,/action_status='approval_required'/);
 assert.match(chat,/action==="approve"/);
 assert.match(chat,/executeAtlasApprovedAction\(db,\{messageId,request,actor\}\)/);
 assert.match(chat,/Founder approval executed\./);
});

test("Atlas WebSocket and daily Cloudflare cron are wired",()=>{
 assert.match(worker,/handleAtlasWebSocket/);
 assert.match(worker,/runAtlasDailyAnalysis/);
 assert.match(worker,/controller\.cron==="15 2 \* \* \*"/);
 assert.match(wrangler,/"15 2 \* \* \*"/);
});

test("Atlas daily founder brief uses only the canonical business snapshot for mission truth",()=>{
 assert.match(data,/runAtlasDailyAnalysis/);
 assert.match(data,/buildAtlasBusinessSnapshot\(db,\{asOf\}\)/);
 assert.match(data,/expectedToDate=mission\.target\*elapsed/);
 assert.match(data,/pacingGapPercent=expectedToDate>0/);
 assert.match(data,/diagnostic only and is not achieved revenue/);
 assert.match(data,/atlasSnapshotHash\(snapshot\)/);
 assert.doesNotMatch(data,/liveMonthMetrics/);
 assert.doesNotMatch(data,/targetToDate/);
 assert.doesNotMatch(data,/used imported Tally revenue/);
 assert.doesNotMatch(data,/SUM\(total_amount\)/);
});


test("Atlas admin HTTP ask is snapshot-first and Tally memory is opt-in secondary context",()=>{
 assert.match(chat,/answerAtlasBusinessQuestion/);
 assert.match(chat,/includeTallyMemory===true/);
 assert.match(chat,/source:"tally_memory"/);
 assert.match(chat,/businessSnapshot:answer\.snapshot/);
 assert.match(chat,/narrativeAvailable:answer\.narrativeAvailable/);
 assert.match(chat,/atlas\.business\.query/);
 assert.doesNotMatch(chat,/I queried the isolated Tally analytics memory/);
});


test("Atlas daily founder analysis is canonical-snapshot-first and never defaults to Tally",()=>{
 assert.match(data,/const snapshot=await buildAtlasBusinessSnapshot/);
 assert.match(data,/tallyMemoryUsed:false/);
 assert.match(data,/diagnostic only and is not achieved revenue/);
 assert.match(data,/existing Founder approval path/);
 assert.doesNotMatch(data,/No target-to-date is configured, so I used imported Tally revenue/);
 assert.doesNotMatch(data,/targetToDate\(/);
 assert.doesNotMatch(data,/monthMetrics\(/);
});


test("Atlas campaign approval transitions one exact proposal journal row",()=>{
 assert.match(data,/proposal_id TEXT/);
 assert.match(data,/proposalId:proposal\?\.id\?\?null/);
 assert.match(data,/updateAtlasProposalStatus\(db,\{id:proposalId,from:"proposed",to:"approved"/);
 assert.match(data,/updateAtlasProposalStatus\(db,\{id:proposalId,from:"approved",to:"executed"/);
 assert.match(data,/Atlas proposal journal link is required/);
 assert.doesNotMatch(data,/proposalType:"campaign_activation",actionJson:action,from:"proposed"/);
});
